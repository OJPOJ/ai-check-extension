"""Builds the desklib "skeleton" for the extension: the ONNX compute graph without weights plus a
build recipe (recipe.json), according to which the extension quantizes the original weights (model.safetensors from
Hugging Face) itself during download. This way we do not distribute any desklib weights ourselves.

Result in extension/models/desklib/:
  model_quantized.onnx  graph; all weights are external in "model_quantized.onnx_data"
  recipe.json           per original tensor: how it is converted and where (offset) it goes
  config.json           model config for transformers.js

Quantization (corresponds to the measurement in README "Accurate model"):
  - MatMul weights: MatMulNBits, 8-bit symmetric, block size 32 (weights only, activations stay fp32).
    The usual dynamic int8 (of the activations too) makes DeBERTa unusable (AUROC 0.998 -> 0.973).
  - Word embeddings (128100 x 1024): row-wise int8 with one scale per row.
  - Rest (biases, LayerNorm, relative positions, classifier): fp32 unchanged.

Usage (Python environment from server/ plus onnx, onnxruntime, onnxscript):
    python scripts/build_desklib_skeleton.py
"""
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import onnx
import torch
from huggingface_hub import hf_hub_download, snapshot_download
from onnx import TensorProto, helper, numpy_helper
from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
from safetensors.numpy import load_file

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))
import shim_server  # noqa: E402

MODEL_ID = "desklib/ai-text-detector-v1.01"
REVISION = "5fdea974cd4287c61674951ec78803aa274e2fb7"
OUT = ROOT / "extension" / "models" / "desklib"
DATA_FILE = "model_quantized.onnx_data"
BLOCK = 32
EMBED_KEY = "model.embeddings.word_embeddings.weight"


def export_fp32(path):
    model = shim_server.DesklibAIDetectionModel.from_pretrained(MODEL_ID, revision=REVISION).eval()
    tok = shim_server.AutoTokenizer.from_pretrained(MODEL_ID, revision=REVISION)

    class Wrapper(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, input_ids, attention_mask):
            return self.m(input_ids=input_ids, attention_mask=attention_mask)

    enc = tok(["Hello world, this is a test.", "A second, slightly longer example sentence for tracing."],
              padding=True, return_tensors="pt")
    torch.onnx.export(
        Wrapper(model), (enc["input_ids"], enc["attention_mask"]), str(path),
        input_names=["input_ids", "attention_mask"], output_names=["logits"],
        dynamic_axes={"input_ids": {0: "batch", 1: "seq"}, "attention_mask": {0: "batch", 1: "seq"},
                      "logits": {0: "batch"}},
        opset_version=17, dynamo=False,
    )


def fold_identities(m):
    """share_att_key: the export puts Identity nodes in front of shared weights - then the
    quantizer skips these MatMuls. So redirect Identity on initializers to the initializer."""
    g = m.graph
    inits = {i.name for i in g.initializer}
    alias = {n.output[0]: n.input[0] for n in g.node if n.op_type == "Identity" and n.input[0] in inits}
    for n in g.node:
        for k, x in enumerate(n.input):
            if x in alias:
                n.input[k] = alias[x]
    for n in [n for n in g.node if n.op_type == "Identity" and n.output[0] in alias]:
        g.node.remove(n)


def quantize_embedding(m, name):
    """Gather(fp32 table) -> Gather(int8) * Gather(scale); dequantizes only the rows used."""
    g = m.graph
    init = next(i for i in g.initializer if i.name == name)
    rows, cols = init.dims
    g.initializer.remove(init)
    g.initializer.extend([
        helper.make_tensor(name + "_q", TensorProto.INT8, [rows, cols], np.zeros(rows * cols, np.int8).tobytes(), raw=True),
        helper.make_tensor(name + "_scale", TensorProto.FLOAT, [rows, 1], np.zeros(rows, np.float32).tobytes(), raw=True),
    ])
    node = next(n for n in g.node if n.op_type == "Gather" and n.input[0] == name)
    idx = list(g.node).index(node)
    ids, out = node.input[1], node.output[0]
    g.node.remove(node)
    for k, n in enumerate([
        helper.make_node("Gather", [name + "_q", ids], [out + "_q"], axis=0),
        helper.make_node("Cast", [out + "_q"], [out + "_f"], to=TensorProto.FLOAT),
        helper.make_node("Gather", [name + "_scale", ids], [out + "_s"], axis=0),
        helper.make_node("Mul", [out + "_f", out + "_s"], [out]),
    ]):
        g.node.insert(idx + k, n)


def digest(arr):
    return hashlib.sha1(np.ascontiguousarray(arr, dtype=np.float32).tobytes()).hexdigest()


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    src = Path(snapshot_download(MODEL_ID, revision=REVISION))
    weights = load_file(str(src / "model.safetensors"))
    by_digest = {digest(v): k for k, v in weights.items()}

    with tempfile.TemporaryDirectory() as tmp:
        fp32_path = Path(tmp) / "model.onnx"
        export_fp32(fp32_path)
        m = onnx.load(str(fp32_path))

    fold_identities(m)
    # Determine the origin of each fp32 initializer while the values are still unquantized.
    origin = {}
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype != np.float32 or a.size < 2:
            continue
        if (k := by_digest.get(digest(a))) is not None:
            origin[init.name] = (k, False)
        elif a.ndim == 2 and (k := by_digest.get(digest(a.T))) is not None:
            origin[init.name] = (k, True)  # MatMul weight = transposed Linear weight

    q = MatMulNBitsQuantizer(m, bits=8, block_size=BLOCK, is_symmetric=True)
    q.process()
    m = q.model.model
    quantize_embedding(m, next(n for n, (k, _) in origin.items() if k == EMBED_KEY))

    # Recipe: each original tensor produces one or two external tensors at fixed offsets.
    recipe = {}
    offset = 0

    def place(init, nbytes):
        nonlocal offset
        offset = (offset + 63) // 64 * 64  # align
        init.ClearField("raw_data")
        init.data_location = TensorProto.EXTERNAL
        del init.external_data[:]
        for key, val in (("location", DATA_FILE), ("offset", str(offset)), ("length", str(nbytes))):
            init.external_data.add(key=key, value=val)
        start = offset
        offset += nbytes
        return start

    inits = {i.name: i for i in m.graph.initializer}
    for name, init in list(inits.items()):
        if name.endswith("_Q8") and name[:-3] in origin:
            key, transposed = origin[name[:-3]]
            assert transposed, name
            rows, cols = weights[key].shape  # Linear weight [N, K] -> MatMulNBits rows = N
            recipe[key] = {"kind": "nbits8", "rows": rows, "cols": cols,
                           "q": place(init, rows * cols), "scales": place(inits[name[:-3] + "_scales"], rows * cols // BLOCK * 4)}
        elif name.endswith("_q") and origin.get(name[:-2], ("",))[0] == EMBED_KEY:
            rows, cols = weights[EMBED_KEY].shape
            recipe[EMBED_KEY] = {"kind": "emb8", "rows": rows, "cols": cols,
                                 "q": place(init, rows * cols), "scales": place(inits[name[:-2] + "_scale"], rows * 4)}
        elif name in origin:
            key, transposed = origin[name]
            assert not transposed, f"{name}: transposed copy not provided for"
            recipe.setdefault(key, {"kind": "copy", "targets": []})["targets"].append(place(init, weights[key].nbytes))

    used = {n for n in origin} | {n + "_scales" for n in origin} | {n[:-3] for n in inits if n.endswith("_Q8")}
    left = [i for i in m.graph.initializer if i.data_location != TensorProto.EXTERNAL and len(i.raw_data) > 100_000]
    assert not left, f"Large initializers without a recipe:{[i.name for i in left]}"

    onnx.save(m, str(OUT / "model_quantized.onnx"))
    (OUT / "recipe.json").write_text(json.dumps({
        "source": {"model": MODEL_ID, "revision": REVISION, "file": "model.safetensors",
                   "size": os.path.getsize(src / "model.safetensors")},
        "dataFile": DATA_FILE, "dataSize": offset, "block": BLOCK, "tensors": recipe,
    }, indent=1))
    cfg = json.loads((src / "config.json").read_text())
    cfg.update({"architectures": ["DebertaV2ForSequenceClassification"], "id2label": {"0": "ai"}, "label2id": {"ai": 0},
                "transformers.js_config": {"use_external_data_format": {"model_quantized.onnx": 1}}})
    (OUT / "config.json").write_text(json.dumps(cfg, indent=2))
    print(f"Skeleton {os.path.getsize(OUT / 'model_quantized.onnx') / 1e6:.1f} MB, "
          f"data {offset / 1e6:.1f} MB from {len(recipe)} of {len(weights)} original tensors")
    missing = set(weights) - set(recipe)
    if missing:
        print("Not used (expected: only pooler or similar):", sorted(missing)[:10])


if __name__ == "__main__":
    main()
