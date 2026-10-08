# WP-01 · Broaden the eval suite (TODO item 3)

## Goal
A reproducible, broader eval suite that thresholds, the default-model decision,
calibration (item 5) and the BYOM reference set (item 1) can rely on. So far: 100 HC3 examples
(Reddit ELI5 vs. ChatGPT 2023) plus the Wikipedia false-alarm measurement (`training/EVAL_RESULTS.md`).

## Scope
1. **Collect data** (`training/build_eval_suite.py`): publicly available datasets, no API keys.
   - Human, several domains, published before 2023: e.g. news, Wikipedia, forums, scientific
     abstracts, reviews.
   - AI from models that are as recent as possible (GPT-4 class and newer, Claude, Gemini, Llama, Mistral …),
     also post-edited/paraphrased, if available. Research suitable HF datasets
     (candidates: RAID, MAGE, M4/M4GT, …) – check and document licences.
   - English (the extension only scores English). Paragraphs in realistic lengths
     (approx. 40–400 words), length buckets as in `extension/length-buckets.js`.
   - Target size: roughly 1000–2000 texts, balanced by domain × source; fixed seed; output as JSONL
     (`text, label, domain, generator, source, words`) to
     `C:/_programme/DS/aivsai/training/data/eval_suite.jsonl` (gitignored).
     Keep downloads small (streaming/partial splits), < ~3 GB in total.
2. **Score** (`training/evaluate_suite.py`, reuse existing scripts, e.g.
   `evaluate_backends.py`, `evaluate_false_alarms.py`): TMR and desklib locally (CPU). desklib is slow
   (~1–5 s/text) – a subset is ok, let it run in the background. Save raw scores as JSONL (gitignored).
3. **Evaluate:** per model AUROC, false-alarm rate at the current thresholds (read `extension/models.js`,
   `extension/config.js`, do not change them), broken down by domain, generator and length bucket.
   Also: which thresholds would yield ~1% false alarms on this suite?
4. **Document:** new section in `training/EVAL_RESULTS.md` (date, data sources + licences,
   tables, interpretation, recommendation on thresholds and default model). Briefly in `training/README.md`,
   how to build and run the suite.

## Allowed files
`training/**` (new scripts, `EVAL_RESULTS.md`, `README.md`, `requirements.txt`). No extension files.

## Acceptance
- Scripts run through with `C:/_programme/DS/aivsai/training/.venv/Scripts/python.exe` (install missing
  packages into the venv and add them to `requirements.txt`).
- Results section with real numbers. If desklib takes too long on the whole suite: a subset,
  stated in the report.
- Report contains a concrete threshold recommendation per model and whether desklib should become the default.
