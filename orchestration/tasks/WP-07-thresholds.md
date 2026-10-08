# WP-07 · Securing the thresholds: desklib full, cross-validation, TMR on how-tos (TODO item 3/5)

## Starting point
`training/EVAL_RESULTS.md`, section "Broader eval suite" and the "Correction" in it: desklib measured on only
480 of 1200 texts; false alarms as displayed TMR 4.7%, desklib 1.2%; TMR marks 20% of the
human WikiHow texts red. desklib has been the default model since today (`extension/config.js`).

## Scope
1. **desklib on the whole suite** (`training/evaluate_suite.py --backend desklib --desklib-n 1200`
   or similar, ~46 min CPU, in the background). Reuse the existing 480 scores if possible (only
   score missing texts). Raw scores under `C:/_programme/DS/aivsai/training/data/`.
2. **Cross-validation of the thresholds** for TMR and desklib (new script, e.g.
   `training/crossval_thresholds.py`): repeated stratified splits (e.g. 5×2 or bootstrap),
   choose the threshold for ~1% false alarms **as displayed** (rule 9 in `orchestration/README.md`) on one
   part, check it on the other. For `redFrom` (≥ 120 words) and `shortRedFrom` (< 120 words).
   Result: threshold with range and the false-alarm/detection rate on the test parts, plus a
   confidence interval of the current values (TMR 0.98, desklib 0.87 / short 0.98).
3. **Understand TMR on how-tos:** what about the WikiHow texts triggers the high scores (lists,
   imperative, structure)? Important: how would the extension see these texts? On real WikiHow/how-to pages
   steps are often individual short paragraphs/lists – `content.js` scores lists differently and groups
   short paragraphs (README, "Short paragraphs together"). Check whether the eval excerpt (start of the document,
   in one piece) represents this realistically, and recommend: do nothing / threshold / domain heuristic.
4. **Document:** new section in `training/EVAL_RESULTS.md` (date, method, tables, concrete
   recommendation whether `extension/models.js` should be changed and to which values). Do not rewrite the existing
   desklib tables in the section "Broader eval suite"; replace/reference them in the new section
   with n=1200.

## Allowed files
`training/**` except `training/MODEL_SEARCH.md` (belongs to WP-06). No extension files – thresholds
are changed by the orchestrator after the review.
WP-06 measures latencies in parallel; note your desklib run in the log with START/END time.

## Acceptance
- desklib scores available for all 1200 texts.
- Cross-validated threshold recommendation per model with a statement of uncertainty.
- Clear statement on TMR/how-tos.
