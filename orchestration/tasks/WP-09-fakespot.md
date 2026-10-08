# WP-09 · Integrate fakespot as third model (TODO item 2)

## Starting point
`training/MODEL_SEARCH.md` (WP-06): `fakespot-ai/roberta-base-ai-text-detection-v1` (Apache-2.0,
RoBERTa-base, ~125 MB int8, ~45 ms/text). On the eval suite (PyTorch original) AUROC 0.964, ≥ 120 words
at ~1% false alarms 90% detected. For the browser ONNX there is `MedAliFarhat/ai-text-detector-onnx`
(Apache-2.0, int8, for transformers.js according to the card) – from a third party, **not** checked against the original.
The scores cluster near 1: false alarms ≥ 120 words 3.5% at 0.99, 0.9% at 0.999, 0.2% at 0.9995.

## Scope
1. **ONNX comparison** (`training/`, new script e.g. `compare_onnx.py`): run the third-party ONNX (pin the
   revision) with onnxruntime on the whole eval suite
   (`C:/_programme/DS/aivsai/training/data/eval_suite.jsonl`), same tokenisation/
   truncation as the extension (maxChars/maxTokens as for TMR: 2000 characters, 512 tokens – `content.js`
   `clipText`, `offscreen.js`). Comparison with the PyTorch raw scores
   (`training/data/eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`): correlation,
   max./mean deviation, and above all: does the traffic light change (FA/detection as displayed) at the
   candidate thresholds? Check that the ONNX really has the same weights/labels (`id2label`,
   which class is AI – `offscreen.js` looks for `ai|machine|generated`, otherwise index 1!).
   If the third-party ONNX deviates considerably or is doubtful: assess alternatives (own export via
   `optimum` + quantisation for comparison; hosting question in the report, do not upload yourself).
2. **Cross-validate thresholds** with the scores the extension would actually see (ONNX), method as in
   `training/crossval_thresholds.py` (WP-07): `redFrom` (≥ 120 words), `shortRedFrom` (< 120), plus
   a sensible `yellowFrom`. Check whether working on a logit basis would be more stable; the extension
   stores probabilities – only switch if it is clearly necessary, and then justify it as a DECISION
   (preferred: keep probabilities).
3. **Integrate** as the third entry in `extension/models.js` (key e.g. `fakespot`, title
   "Balanced – fakespot"), structured like `tmr` (ready-made ONNX, `repo`, pinned `revision`, `version`,
   `marker`, `download`, `info`, `summary`, `thresholds`, `reliableWords`, `shortRedFrom`, `languages`).
   Make sure `offscreen.js` loads model, tokenizer and AI label correctly (adjust minimally if needed).
   Server section (`server`) only if `server/shim_server.py` can come along without much effort – otherwise leave it out.
   No new default: desklib stays the default.
4. **Licence:** entry in `extension/THIRD_PARTY_NOTICES.md` (model + ONNX conversion).
5. **Tests:** unit tests for the new catalogue entry (`test/unit/config.test.mjs`,
   `test/unit/providers.test.mjs` as needed). A real browser test with download is not necessary, but
   check once manually/with Playwright that the model loads in the offscreen document and delivers plausible scores,
   if feasible (125 MB download ok).
6. **Documentation:** section in `training/MODEL_SEARCH.md` ("ONNX comparison and integration").

## Allowed files
`extension/models.js`, `extension/offscreen.js`, `extension/THIRD_PARTY_NOTICES.md`,
`server/shim_server.py` (optional), `training/**` except `training/build_reference_set.py`,
`test/unit/config.test.mjs`, `test/unit/providers.test.mjs`. Not: `content.js`, `config.js`,
`about.html`, `reference-set.js`.

## Acceptance
- ONNX comparison with numbers; integration only if the ONNX does not change the traffic light appreciably –
  otherwise leave out the integration and report clearly.
- Cross-validated thresholds with range, as displayed.
- `npm test` green.
