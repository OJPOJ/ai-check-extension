"""
Work package 6 of issue #46: builds the candidate encoders from their published configuration with
random weights and exports them to ONNX, for the latency measurement in the browser
(`npm run measure:latency`). Latency depends on the architecture and the input length, not on the
values of the weights, so nothing has to be trained or downloaded except the configuration.

Per candidate (all in full precision and 8-bit):
    full            all layers, one graph: the model without early exit
    full-tr         the same with token reduction
    stage0..n       the layers up to each exit as their own graph (early exit)
    stage1-tr..     the stages after the token reduction (stage 0 is the same with and without)
The anchors (the architectures of TMR/fakespot and desklib) get `full` only. Our own variants of a
candidate (more token reduction, hashed n-gram embeddings; see below `CANDIDATES`) get `full` and
their stages, with their levers built in.

Usage (from training/):
    .venv/Scripts/python.exe model/export_candidates.py                      # all, into data/latency/
    .venv/Scripts/python.exe model/export_candidates.py --only ettin-32m     # one candidate
    .venv/Scripts/python.exe model/export_candidates.py --list
"""

import argparse
import json
import logging
import math
import sys
import warnings
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from staged import Full, Stage, StagedClassifier, default_exits  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "data" / "latency"

# Configurations at a pinned revision. `sibling`: a multilingual model of the same family (issue
# #46: the backbone must not rule out other languages); None where the candidate is multilingual
# itself. Licences as stated on the model card (2026-10-13).
CANDIDATES = {
    "ettin-17m": {"repo": "jhu-clsp/ettin-encoder-17m", "revision": "987607455c61e7a5bbc85f7758e0512ea6d0ae4c",
                  "licence": "MIT", "sibling": "jhu-clsp/mmBERT-small"},
    "ettin-32m": {"repo": "jhu-clsp/ettin-encoder-32m", "revision": "1b8ba06455dd44f80fc9c1ca9e22806157a57379",
                  "licence": "MIT", "sibling": "jhu-clsp/mmBERT-small"},
    "ettin-68m": {"repo": "jhu-clsp/ettin-encoder-68m", "revision": "ac19ae4bc51093b31c475665ac872a936d056cc2",
                  "licence": "MIT", "sibling": "jhu-clsp/mmBERT-small"},
    "ettin-150m": {"repo": "jhu-clsp/ettin-encoder-150m", "revision": "45d08642849e5c5701b162671ac811b7654bfd9f",
                   "licence": "MIT", "sibling": "jhu-clsp/mmBERT-base"},
    "mmbert-small": {"repo": "jhu-clsp/mmBERT-small", "revision": "abc32620dd4f6ab06f5fbe905dc25f310618e09f",
                     "licence": "MIT", "sibling": None},
    "minilm-l6-h384": {"repo": "nreimers/MiniLMv2-L6-H384-distilled-from-RoBERTa-Large",
                       "revision": "a61886e95cedc4cd2440f71cf9a55320ee1d8e06",
                       "licence": "none on the card (MiniLM itself: MIT)", "sibling": "nreimers/mMiniLMv2-L6-H384-distilled-from-XLMR-Large"},
    "minilm-l12-h384": {"repo": "microsoft/MiniLM-L12-H384-uncased", "revision": "44acabbec0ef496f6dbc93adadea57f376b7c0ec",
                        "licence": "MIT", "sibling": "microsoft/Multilingual-MiniLM-L12-H384"},
    "deberta-v3-xsmall": {"repo": "microsoft/deberta-v3-xsmall", "revision": "4b419818330868dff6a60ad3e6b1c730f8b8c0c6",
                          "licence": "MIT", "sibling": "microsoft/mdeberta-v3-base"},
    "deberta-v3-small": {"repo": "microsoft/deberta-v3-small", "revision": "a36c739020e01763fe789b4b85e2df55d6180012",
                         "licence": "MIT", "sibling": "microsoft/mdeberta-v3-base"},
    "deberta-v3-base": {"repo": "microsoft/deberta-v3-base", "revision": "8ccc9b6f36199bec6961081d44eb72fb3f7353f3",
                        "licence": "MIT", "sibling": "microsoft/mdeberta-v3-base"},
    # Shared layer weights (concept, lever 4): as many layers to compute as BERT-base, a fraction of the download
    "albert-base-v2": {"repo": "albert/albert-base-v2", "revision": "8e2f239c5f8a2c0f253781ca60135db913e5c80c",
                       "licence": "Apache-2.0", "sibling": "cservan/malbert-base-cased-128k"},
    # Anchors: the architectures the extension runs today, to read the new numbers against the known ones
    "roberta-base": {"repo": "FacebookAI/roberta-base", "revision": "e2da8e2f811d1448a5b465c236feacd80ffbac7b",
                     "licence": "MIT", "sibling": "FacebookAI/xlm-roberta-base", "anchor": "TMR, fakespot"},
    "deberta-v3-large": {"repo": "microsoft/deberta-v3-large", "revision": "64a8c8eab3e352a784c658aef62be1662607476f",
                         "licence": "MIT", "sibling": None, "anchor": "desklib"},
}

# Our own variants of the backbones recommended for training, which keep the pretrained weights
# (`base`: the candidate they are read against). They get `full` and the stages only, with their
# levers built in.
#   tr2       tokens pooled 2:1 after the first and again after the second exit (a quarter in the last third)
#   tr-early  pooled after the first layer and again after the first exit
#   ngram     hashed n-gram embeddings added to the input (lever 3) and an exit on the embeddings,
#             before any layer; token reduction as in the base
NGRAM = (2**20, 64)  # rows and width of the n-gram table: 64 MB in 8-bit
for _base in ("ettin-32m", "ettin-68m", "ettin-150m"):
    for _suffix, _variant in (("tr2", {"reduce": "twice"}), ("tr-early", {"reduce": "early"}), ("ngram", {"ngram": True})):
        CANDIDATES[f"{_base}-{_suffix}"] = {**CANDIDATES[_base], "base": _base, **_variant}

PARITY_TOLERANCE = 1e-3  # ONNX against PyTorch, largest difference of a logit or hidden value


def levers(name, layers):
    """
    Exits, token reduction and n-gram table of a candidate with `layers` layers, as arguments of
    `StagedClassifier`: token reduction after the first exit, or what the variant says.
    """
    spec = CANDIDATES[name]
    exits = default_exits(layers)
    first, second = exits[:2]
    ngram = NGRAM if spec.get("ngram") else None
    reduce = {"twice": (first, second), "early": (1, first)}.get(spec.get("reduce"), first)
    return {"exits": [0, *exits] if ngram else exits, "reduce_after": reduce, "ngram": ngram}


def build(name, seed=0):
    """
    Encoder with random weights from the published configuration. A candidate comes without and with
    token reduction after the first exit; one of our own variants as one model (the second is None).
    """
    from transformers import AutoConfig, AutoModel

    spec = CANDIDATES[name]
    config = AutoConfig.from_pretrained(spec["repo"], revision=spec["revision"])
    torch.manual_seed(seed)
    encoder = AutoModel.from_config(config)
    plain = StagedClassifier(encoder).eval()
    if "base" in spec:
        return config, StagedClassifier(encoder, **levers(name, plain.backbone.num_layers)).eval(), None
    reduced = StagedClassifier(encoder, **levers(name, plain.backbone.num_layers)).eval()
    reduced.heads = plain.heads
    return config, plain, reduced


def graphs(plain, reduced, anchor=False):
    """(variant, module, first input is token ids?) for everything that is exported."""
    if anchor:
        return [("full", Full(plain), True)]
    stages = range(len(plain.exits))
    if reduced is None:
        return [("full", Full(plain), True)] + [(f"stage{i}", Stage(plain, i), i == 0) for i in stages]
    return (
        [("full", Full(plain), True), ("full-tr", Full(reduced), True)]
        + [(f"stage{i}", Stage(plain, i), i == 0) for i in stages]
        + [(f"stage{i}-tr", Stage(reduced, i), False) for i in stages if i > 0]
    )


def example(module, takes_ids, hidden_size, vocab, batch, tokens, seed):
    """Inputs with padding in the last row, so that the mask is part of what is compared."""
    g = torch.Generator().manual_seed(seed)
    mask = torch.ones(batch, tokens, dtype=torch.long)
    if batch > 1:
        mask[-1, tokens * 2 // 3:] = 0
    first = torch.randint(5, vocab, (batch, tokens), generator=g) if takes_ids else torch.randn(batch, tokens, hidden_size, generator=g)
    return first, mask


def export(module, takes_ids, hidden_size, vocab, path):
    first, mask = example(module, takes_ids, hidden_size, vocab, batch=2, tokens=24, seed=1)
    outputs = ["logit"] if isinstance(module, Full) or module.last else ["logit", "hidden_out", "attention_mask_out"]
    batch, tokens = torch.export.Dim("batch"), torch.export.Dim("tokens")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        torch.onnx.export(
            module, (first, mask), str(path), dynamo=True, external_data=False, verbose=False,
            input_names=["input_ids" if takes_ids else "hidden", "attention_mask"], output_names=outputs,
            dynamic_shapes=({0: batch, 1: tokens}, {0: batch, 1: tokens}),
        )


def parity(module, takes_ids, hidden_size, vocab, path):
    """Largest difference between the ONNX graph and the PyTorch module, on a shape other than the exported one."""
    import onnxruntime

    first, mask = example(module, takes_ids, hidden_size, vocab, batch=3, tokens=57, seed=2)
    with torch.no_grad():
        expected = module(first, mask)
    expected = list(expected) if isinstance(expected, tuple) else [expected]
    session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    feeds = dict(zip([i.name for i in session.get_inputs()], [first.numpy(), mask.numpy()]))
    got = session.run(None, feeds)
    return max(float(np.abs(e.numpy() - g).max()) for e, g in zip(expected, got))


def quantise(src, dst):
    """8-bit weights the way the `q8` files of transformers.js are made (dynamic quantisation of MatMul weights)."""
    import onnx
    from onnxruntime.quantization import QuantType, quantize_dynamic

    # The exporter notes the shapes of intermediate values; some contradict what the quantiser
    # infers itself (it stops on that). They are not needed to run the graph.
    model = onnx.load(str(src))
    del model.graph.value_info[:]
    stripped = dst.with_suffix(".tmp.onnx")
    onnx.save(model, str(stripped))
    try:
        # signed weights, as in the files the extension runs (onnx-community/tmr-ai-text-detector-ONNX)
        quantize_dynamic(str(stripped), str(dst), weight_type=QuantType.QInt8, per_channel=False, reduce_range=False,
                         extra_options={"EnableSubgraph": True, "MatMulConstBOnly": True})
    finally:
        stripped.unlink()


def export_candidate(name, out):
    spec = CANDIDATES[name]
    config, plain, reduced = build(name)
    folder = out / name
    folder.mkdir(parents=True, exist_ok=True)
    encoder = plain.backbone.model
    embedding = sum(p.numel() for p in encoder.get_input_embeddings().parameters())
    ngram = sum(p.numel() for p in plain.ngram.parameters()) if plain.ngram else 0
    entry = {
        **spec,
        "family": config.model_type, "layers": plain.backbone.num_layers, "hidden": config.hidden_size,
        "intermediate": config.intermediate_size, "heads": config.num_attention_heads, "vocab": config.vocab_size,
        "parameters": sum(p.numel() for p in encoder.parameters()) + ngram, "embedding_parameters": embedding + ngram,
        "exits": plain.exits, "reduce_after": list((reduced or plain).reduce_after), "graphs": {},
    }
    for variant, module, takes_ids in graphs(plain, reduced, anchor="anchor" in spec):
        fp32, q8 = folder / f"{variant}.fp32.onnx", folder / f"{variant}.q8.onnx"
        export(module, takes_ids, config.hidden_size, config.vocab_size, fp32)
        diff = parity(module, takes_ids, config.hidden_size, config.vocab_size, fp32)
        if diff > PARITY_TOLERANCE:
            raise RuntimeError(f"{name}/{variant}: ONNX differs from PyTorch by {diff:.2g}")
        quantise(fp32, q8)
        # 8-bit weights change the values, so there is no tolerance to hold; the graph must run and give numbers
        diff_q8 = parity(module, takes_ids, config.hidden_size, config.vocab_size, q8)
        if not math.isfinite(diff_q8):
            raise RuntimeError(f"{name}/{variant}: the 8-bit graph does not give finite values")
        entry["graphs"][variant] = {
            "input": "input_ids" if takes_ids else "hidden", "parity": diff, "difference_q8": diff_q8,
            "files": {p.name.split(".")[1]: {"path": f"{name}/{p.name}", "bytes": p.stat().st_size} for p in (fp32, q8)},
        }
        # Large models get their weights in a second file; the browser measurement takes single files only
        weights = fp32.with_name(fp32.name + ".data")
        if weights.exists():
            entry["graphs"][variant]["files"]["fp32"].update(bytes=fp32.stat().st_size + weights.stat().st_size, external=True)
        sizes = entry["graphs"][variant]["files"]
        print(f"  {variant:<10} fp32 {sizes['fp32']['bytes'] / 1e6:7.1f} MB   q8 {sizes['q8']['bytes'] / 1e6:7.1f} MB   parity {diff:.1e}", flush=True)
    return entry


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--only", nargs="+", choices=sorted(CANDIDATES), help="export these candidates only")
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument("--list", action="store_true", help="print the candidates and stop")
    args = ap.parse_args()
    if args.list:
        for name, spec in CANDIDATES.items():
            note = f"  (anchor: {spec['anchor']})" if "anchor" in spec else f"  (variant of {spec['base']})" if "base" in spec else ""
            print(f"{name:<20} {spec['repo']}@{spec['revision'][:7]}{note}")
        return
    logging.disable(logging.WARNING)  # the exporter and the quantiser report every node
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"candidates": {}}
    manifest["versions"] = {"torch": torch.__version__, "transformers": __import__("transformers").__version__,
                            "onnx": __import__("onnx").__version__, "onnxruntime": __import__("onnxruntime").__version__}
    for name in args.only or CANDIDATES:
        print(name, flush=True)
        manifest["candidates"][name] = export_candidate(name, args.out)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"-> {manifest_path}")


if __name__ == "__main__":
    main()
