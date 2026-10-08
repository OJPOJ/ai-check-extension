# WP-06 · Find another model between TMR and desklib (TODO item 2)

## Goal
desklib is now the default: accurate (false alarms as displayed ~1%, AUROC 0.990 on the eval suite), but
a 1.7 GB download (converted to ~475 MB in the browser) and ~1.3–2.3 s per paragraph on CPU. TMR is fast
(126 MB, ~0.15 s), but ~5% false alarms (20% on how-tos). Wanted: a detector with
desklib-like quality and considerably less download/compute time that can be run in the browser.

## Scope
1. **Research** (Hugging Face, papers, leaderboards such as RAID): 5–10 candidates for English
   AI-text detection, sequence classification with an encoder (DeBERTa-v3-small/-base/-xsmall, ModernBERT,
   RoBERTa, DistilRoBERTa, ELECTRA …). Criteria: open licence (MIT/Apache/CC BY, no
   non-commercial clause), size (target < 500 MB, ideally < 200 MB), public without a gate, training data
   with current generators, ONNX available or convertible with an architecture compatible with transformers.js.
   Check beforehand which architectures transformers.js supports.
2. **Measure** the 2–4 most promising ones on the eval suite
   (`C:/_programme/DS/aivsai/training/data/eval_suite.jsonl`, 1200 texts) with the same methodology as
   `training/evaluate_suite.py` (extend it or analogous, e.g. `--backend hf:<repo>`): AUROC, false alarms and
   detection **as displayed** (rule 9 in `orchestration/README.md`: below 120 words red only with its own
   short threshold), per domain and generator, plus a 1% false-alarm threshold for ≥ 120 words.
   PyTorch on CPU is enough; a sample if necessary (stratified as for desklib).
3. **Latency** per paragraph (CPU, PyTorch; if ONNX is available also onnxruntime) and download size.
   Caution: WP-07 is running desklib on the same CPU in parallel. Only measure latency when no other
   Python process is computing (`tasklist | grep -i python`), and note that in the result.
4. **Result** in a new file `training/MODEL_SEARCH.md`: candidate table (repo, licence,
   size, architecture, ONNX yes/no, training data), measurement table compared with TMR and desklib
   (numbers from `EVAL_RESULTS.md`, section "Broader eval suite" incl. "Correction"), clear recommendation:
   which model as the third entry in `extension/models.js`, with which thresholds
   (`thresholds`, `reliableWords`, `shortRedFrom`), and what is needed for integration in the browser
   (ready-made ONNX like TMR or conversion like desklib, `desklib_build.js`).

## Allowed files
`training/**`, but **not** `training/EVAL_RESULTS.md` (belongs to WP-07 in this round) – own
results in `training/MODEL_SEARCH.md`. No extension files; the integration is a WP of its own.
Large downloads to `C:/_programme/DS/aivsai/training/data/` or into the HF cache, < ~5 GB in total.

## Acceptance
- At least 2 candidates actually measured, raw scores as JSONL under `training/data/` (gitignored).
- Recommendation with reasons; if no candidate is any good, say so clearly and why.
