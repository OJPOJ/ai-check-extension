# Our own model

The detector model of issue #46: a pretrained encoder with early exit and token reduction
(concept: [`../MODEL_CONCEPT.md`](../MODEL_CONCEPT.md), "Architecture"). So far the model
definition, the latency measurement of the candidates (work package 6) and the training script
(work package 7); no trained weights exist yet. All commands run from `training/`; everything
built goes to `data/latency/` and `data/runs/` (gitignored).

| File | What |
|---|---|
| `staged.py` | the model: a Hugging Face encoder whose layers are called one by one, with a classifier head after some of them (`exits`; 0 is a head on the embeddings), 2:1 pooling of neighbouring tokens from one layer on (`reduce_after`, also several times) and optionally hashed n-gram embeddings added to the input (`ngram`). `StagedClassifier` returns the scores of all exits (training); `Stage` is the part between two exits (one ONNX graph each, the browser stops after a confident one); `Full` is the model without early exit |
| `export_candidates.py` | builds every candidate from its published configuration with random weights and exports it to ONNX, in full precision (checked against PyTorch) and 8-bit (run once, its difference recorded) |
| `latency_report.py` | the tables in `EVAL_RESULTS.md` from the browser measurement |
| `train.py` | trains a candidate on our dataset, with its exits and token reduction from the first step, and scores validation and test with all exits |
| `train_notebook.ipynb` | runs `train.py` in a GPU session on Kaggle or Colab |

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

Our own variants of the three Ettin sizes keep the pretrained layers and change what is around
them (`-tr2`: tokens pooled after the first and the second exit; `-tr-early`: after the first layer
and the first exit; `-ngram`: hashed n-gram embeddings and an exit before the first layer). They
are candidates of their own in `CANDIDATES` (`base` names the one they are built from) and get
`full` and their stages, with their levers built in.

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

## Training (issue #46, work package 7)

`train.py` fine-tunes a candidate of `CANDIDATES` (`export_candidates.py`) from its published
weights at the pinned revision. Exits, token reduction and n-gram table are those of
`levers()`, the same function the latency export uses, so the model that is trained is the one
that was measured.

```
.venv/Scripts/python.exe model/train.py --list
.venv/Scripts/python.exe model/train.py ettin-32m --rows 400 --epochs 1 --out data/runs/try   # does it run at all: about a minute on a CPU
.venv/Scripts/python.exe model/train.py ettin-68m --hours 11     # a run into data/runs/ettin-68m/; needs a GPU
.venv/Scripts/python.exe model/train.py ettin-68m --score        # score validation and test again
.venv/Scripts/python.exe evaluation/evaluate_test_part.py report --run ettin-68m ettin-32m   # next to the baselines
```

There is no usable GPU locally. A real run goes through `train_notebook.ipynb` on Colab (or
Kaggle): it clones the repository at a commit, reads the dataset from a copy of
`data/dataset/v1/` on your own Google Drive (575 MB; unshared, since not every source may be
redistributed, and deleted when the training is done) and writes the run to the Drive, so that
running the notebook again continues it. The script refuses files whose SHA-256 is not the one in `dataset/dataset.json`.

What a run does:

- **Texts.** Per text and epoch a new excerpt of whole sentences (`excerpt()` of
  `build_dataset.py`: 15 to 330 words, at most 2,000 characters), cut to 512 tokens. Texts are
  shuffled and every stretch of 50 batches is sorted by length before it is cut into batches.
  Order and excerpts depend on the seed and the epoch only.
- **Loss.** Binary cross-entropy of every exit head, mean over the exits (`--loss last`: the
  last exit only, the other heads stay frozen; separates whether the shared loss keeps the
  encoder shallow). A text is weighted by its class so that human and AI texts weigh the same
  in total (the dataset has 1.5 AI texts per human one). Sources are not weighted.
- **Optimiser.** AdamW, 2 epochs (the third of the first run gained 0.1 points of AUROC on
  validation, and its training loss dropped at every start of an epoch), batches of 32, learning rate 5e-5 for the encoder and 1e-3 for
  what starts random (exit heads, n-gram table), linear warm-up over 6% of the steps and linear
  decay, half precision on a GPU. The n-gram table adds nothing at the first step, so the
  encoder starts from what it was pretrained on. All of these are options (`--help`); the
  defaults are a starting point, not a tuned result.
- **Validation.** After every epoch on the stored excerpts of the validation part and on the
  dev half of the 1200-text suite (`--suite`, default `data/eval_suite.jsonl`; whole texts,
  `normalise()`, 2,000 characters): AUROC and the share of AI texts found at 1% false alarms,
  per exit. The validation part has only texts of the sources we train on, so the epoch with
  the highest AUROC on `suite-dev` is kept (mean over the trained exits; the share found on
  validation decides a tie). Without the suite (`--no-suite`) the share found on validation
  decides. The test part and the test half of the suite are scored once at the end and choose
  nothing; `evaluate_test_part.py report` shows the test half only with `--suite-test`.
- **Interruption.** `checkpoint.pt` is written every 30 minutes, at the end of an epoch and
  when `--hours` are over. The same command continues from it with the same order of texts,
  excerpts and learning rates (in the tests an interrupted run ends at the same weights), and
  refuses to continue with other settings. `--resume-from` takes the folder of an earlier
  session where the output folder starts empty (Kaggle).

Files of a run (`data/runs/<name>/`):

| File | What |
|---|---|
| `run.json` | candidate, revision, levers, settings, checksums of the dataset files, commit, library versions, GPU, the epoch that was kept |
| `log.jsonl` | every 100 steps the loss per exit and the learning rate; per epoch the validation numbers |
| `model.pt` | weights of the best epoch (`StagedClassifier.state_dict()`) |
| `checkpoint.pt` | everything to continue; not needed once the run is done |
| `scores/{validation,test,suite}.jsonl` | per id the log-odds of all exits (`exits`) and of the last one (`logit`, the field the baselines have) |
| `scores/summary.json` | AUROC and share found at 1% false alarms per exit, per split and view, and for `suite-dev` |

`evaluate_test_part.py report --run <name>` puts the last exit of a run next to TMR, fakespot
and desklib on identical texts, with thresholds set the same way, and writes `comparison.json`
next to `baselines.json`. Thresholds per exit, calibration and the expected latency with the
real shares per exit are work package 8.

Limits to know: the share "found at 1% false alarms" in `log.jsonl` and `summary.json` uses a
threshold set on the same texts and one threshold for all lengths, so it compares epochs and
exits and is not a result; results are the tables of `evaluate_test_part.py`. Dropout and the
GPU make a continued run on a GPU close to, not bit-identical with, an uninterrupted one.
