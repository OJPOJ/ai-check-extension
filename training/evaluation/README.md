# Evaluation of the models in use

Measurements on the detectors the extension ships or considered (TMR, desklib, fakespot, Laya): the eval suite, thresholds, false alarms, text length, latency and the ONNX comparison. Results: [`../EVAL_RESULTS.md`](../EVAL_RESULTS.md) and [`../MODEL_SEARCH.md`](../MODEL_SEARCH.md). All commands run from `training/`; scores go to `data/` (gitignored).

| Script | What |
|---|---|
| `build_eval_suite.py`, `evaluate_suite.py`, `report_from_scores.py`, `desklib_fill_suite.py` | the 1200-text suite: build, score, report |
| `crossval_thresholds.py` | thresholds for about 1% false alarms, cross-validated |
| `evaluate_backends.py`, `evaluate_false_alarms.py`, `evaluate_length.py`, `evaluate_split_half.py` | single questions on HC3 and Wikipedia; `evaluate_backends.py` also holds the model loaders the others use |
| `benchmark_latency.py`, `compare_onnx.py` | speed, and ONNX against the PyTorch original |
| `build_reference_set.py` | writes `extension/bg/reference-set.js` |

## Eval suite (broader, TODO item 3)

Broader, reproducible eval set across several domains and current AI generators (not just
the original 100 HC3 examples) - basis for thresholds, the default-model decision,
later calibration (item 5) and the BYOM reference set (item 1). Results and recommendations:
`EVAL_RESULTS.md`, section "Broader eval suite".

```
# 1. Build the suite (downloads ~820 MB from Hugging Face once, then the HF cache; output gitignored)
.venv/Scripts/python.exe evaluation/build_eval_suite.py --out data/eval_suite.jsonl --seed 42

# 2. Score: TMR always on the full suite, desklib only on a sample (slow, ~2.3 s/text on CPU)
.venv/Scripts/python.exe evaluation/evaluate_suite.py --backend both --desklib-n 480 --suite data/eval_suite.jsonl
```

`build_eval_suite.py` pulls human and AI texts from `Jinyan1/COLING_2025_MGT_en` (aggregates MAGE,
M4GT-Bench and HC3) across six domains (news, wikipedia, forum, sci_abstract, reviews, howto) and,
where available per domain, seven current generators (gpt4, gpt4o, gpt-3.5-turbo, llama3-70b,
mixtral-8x7b, gemma2-9b-it, cohere) plus human. `evaluate_suite.py` prints AUROC/false alarm rate
overall, per domain, per generator and per length bucket, and suggests thresholds for ~1% false alarms;
raw scores end up in `data/eval_scores_<backend>_suite.jsonl` (gitignored).
