# Our own model

The detector model of issue #46: a pretrained encoder with early exit and token reduction
(concept: [`../MODEL_CONCEPT.md`](../MODEL_CONCEPT.md), "Architecture"). So far the model
definition and the latency measurement of the candidates (work package 6); no weights are trained
yet. All commands run from `training/`; everything built goes to `data/latency/` (gitignored).

| File | What |
|---|---|
| `staged.py` | the model: a Hugging Face encoder whose layers are called one by one, with a classifier head after some of them (`exits`) and 2:1 pooling of neighbouring tokens from one layer on (`reduce_after`). `StagedClassifier` returns the scores of all exits (training); `Stage` is the part between two exits (one ONNX graph each, the browser stops after a confident one); `Full` is the model without early exit |
| `export_candidates.py` | builds every candidate from its published configuration with random weights and exports it to ONNX, in full precision (checked against PyTorch) and 8-bit (run once, its difference recorded) |
| `latency_report.py` | the tables in `EVAL_RESULTS.md` from the browser measurement |

Adapters exist for the BERT/RoBERTa format (MiniLM), ALBERT, DeBERTa-v2/v3 and ModernBERT (Ettin, mmBERT).
A further family needs one class in `staged.py` (`BACKBONES`) and a line in the test that compares
the layers called one by one with the encoder's own forward pass.

## Latency of the candidates (issue #46, work package 6)

Latency depends on the architecture and the number of tokens, not on the values of the weights. The
candidates are therefore measured with random weights, before any GPU time is spent on them.
Results: `EVAL_RESULTS.md`, section "Latency of candidate encoders in the browser".

```
.venv/Scripts/python.exe model/export_candidates.py     # about 35 minutes and 17 GB; --only <name> for one, --list for the names
cd .. && npm run measure:latency                       # Chromium, WASM, threads as in the extension; about 50 minutes
cd training && .venv/Scripts/python.exe model/latency_report.py
```

`export_candidates.py` only downloads the configuration of each candidate (pinned revision in
`CANDIDATES`). Per candidate it writes `full` (all layers in one graph), `full-tr` (the same with
token reduction), one graph per stage (`stage0`, `stage1`, …) and the stages after the token
reduction (`stage1-tr`, …), plus `manifest.json` with size, parameters and the largest difference
to PyTorch. The two anchors (RoBERTa-base as in TMR and fakespot, DeBERTa-v3-large as in desklib)
get `full` only.

`npm run measure:latency` (`scripts/measure-latency.mjs`) loads the graphs with the ONNX Runtime
Web that `@huggingface/transformers` pins, in a cross-origin isolated page so that threads work as
in `extension/offscreen.js`, and writes `data/latency/results.json`: per graph and number of tokens
(32 to 512) the median of 7 to 25 runs of one text. Everything is measured in two passes (`--passes`),
each chain in a new page, and the faster pass is kept: now and then a whole page runs at about half
speed, which the median inside that page does not show. Stages are called one after the other, each
with the output of the one before. It also downloads the real TMR file of the extension (126 MB)
and measures it next to the random RoBERTa-base, as a check that random weights are a valid
stand-in. Options: `--only a,b`, `--precision q8`, `--lengths 32,128`, `--threads 4`, `--passes 3`, `--no-real`,
`--backend webgpu` (for issue #19). A run with `--only` or `--precision` replaces only that part of
`results.json`; it stops if the rest of the file was measured under another environment (machine,
browser, library, backend, threads, lengths), because the file states one environment for all. Close other programs before a run; the numbers are medians, but
a busy machine still shifts them.
