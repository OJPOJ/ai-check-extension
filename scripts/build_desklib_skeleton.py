"""Baut das desklib-"Skelett" für die Extension: den ONNX-Rechengraphen ohne Gewichte plus eine
Bauanleitung (recipe.json), nach der die Extension die Original-Gewichte (model.safetensors von
Hugging Face) beim Herunterladen selbst quantisiert. So verteilen wir keine desklib-Gewichte selbst.

Ergebnis in extension/models/desklib/:
  model_quantized.onnx  Graph; alle Gewichte liegen extern in "model_quantized.onnx_data"
  recipe.json           pro Original-Tensor: wie er umgerechnet wird und wohin (Offset) er kommt
  config.json           Modell-Config für transformers.js

Quantisierung (entspricht der Messung in README "Genaues Modell"):
  - MatMul-Gewichte: MatMulNBits, 8 Bit symmetrisch, Blockgröße 32 (nur Gewichte, Aktivierungen bleiben fp32).
    Das übliche dynamische int8 (auch der Aktivierungen) macht DeBERTa unbrauchbar (AUROC 0.998 -> 0.973).
  - Wort-Embeddings (128100 x 1024): zeilenweise int8 mit einer Skala pro Zeile.
  - Rest (Biases, LayerNorm, relative Positionen, Klassifikator): fp32 unverändert.

Aufruf (Python-Umgebung aus server/ plus onnx, onnxruntime, onnxscript):
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
    """share_att_key: der Export hängt Identity-Knoten vor geteilte Gewichte - dann überspringt der
    Quantisierer diese MatMuls. Identity auf Initializern daher auf den Initializer umbiegen."""
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
    """Gather(fp32-Tabelle) -> Gather(int8) * Gather(Skala); dequantisiert nur die benutzten Zeilen."""
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
    # Herkunft jedes fp32-Initializers bestimmen, solange die Werte noch unquantisiert vorliegen.
    origin = {}
    for init in m.graph.initializer:
        a = numpy_helper.to_array(init)
        if a.dtype != np.float32 or a.size < 2:
            continue
        if (k := by_digest.get(digest(a))) is not None:
            origin[init.name] = (k, False)
        elif a.ndim == 2 and (k := by_digest.get(digest(a.T))) is not None:
            origin[init.name] = (k, True)  # MatMul-Gewicht = transponiertes Linear-Gewicht

    q = MatMulNBitsQuantizer(m, bits=8, block_size=BLOCK, is_symmetric=True)
    q.process()
    m = q.model.model
    quantize_embedding(m, next(n for n, (k, _) in origin.items() if k == EMBED_KEY))

    # Rezept: jeder Original-Tensor erzeugt ein oder zwei externe Tensoren an festen Offsets.
    recipe = {}
    offset = 0

    def place(init, nbytes):
        nonlocal offset
        offset = (offset + 63) // 64 * 64  # ausrichten
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
            rows, cols = weights[key].shape  # Linear-Gewicht [N, K] -> MatMulNBits-Zeilen = N
            recipe[key] = {"kind": "nbits8", "rows": rows, "cols": cols,
                           "q": place(init, rows * cols), "scales": place(inits[name[:-3] + "_scales"], rows * cols // BLOCK * 4)}
        elif name.endswith("_q") and origin.get(name[:-2], ("",))[0] == EMBED_KEY:
            rows, cols = weights[EMBED_KEY].shape
            recipe[EMBED_KEY] = {"kind": "emb8", "rows": rows, "cols": cols,
                                 "q": place(init, rows * cols), "scales": place(inits[name[:-2] + "_scale"], rows * 4)}
        elif name in origin:
            key, transposed = origin[name]
            assert not transposed, f"{name}: transponierte Kopie nicht vorgesehen"
            recipe.setdefault(key, {"kind": "copy", "targets": []})["targets"].append(place(init, weights[key].nbytes))

    used = {n for n in origin} | {n + "_scales" for n in origin} | {n[:-3] for n in inits if n.endswith("_Q8")}
    left = [i for i in m.graph.initializer if i.data_location != TensorProto.EXTERNAL and len(i.raw_data) > 100_000]
    assert not left, f"Große Initializer ohne Rezept: {[i.name for i in left]}"

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
    print(f"Skelett {os.path.getsize(OUT / 'model_quantized.onnx') / 1e6:.1f} MB, "
          f"Daten {offset / 1e6:.1f} MB aus {len(recipe)} von {len(weights)} Original-Tensoren")
    missing = set(weights) - set(recipe)
    if missing:
        print("Nicht verwendet (erwartet: nur Pooler o. Ä.):", sorted(missing)[:10])


if __name__ == "__main__":
    main()
