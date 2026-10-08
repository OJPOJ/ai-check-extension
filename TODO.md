# TODO

Open items, order = priority. Completed work is in the roadmap in `DEVELOPMENT.md`.
Status: 2026-09-26.

## 1. BYOM: remainder

Framework, "Check model" and Hugging Face metadata are done (`DEVELOPMENT.md`, "Check custom models";
contract in `server/README.md`). Open:

- **Test with a real token:** 2–3 known detector models via "Check model" (Hub metadata,
  router response shapes, AI label from `id2label`). So far only mocked (`providers.test.mjs`,
  `model-check.test.mjs`).
- **Reference set: more recent generators.** Since WP-11 HC3 + RAID wiki (114 texts, short and long). RAID
  also has GPT-4, ChatGPT and Cohere for "wiki" in the same MIT split – not included so far, would be
  a small extension (`RAID_GENERATORS` in `training/build_reference_set.py`). Short paragraphs
  come only from HC3 (RAID wiki delivers none under 120 words).
- **"Detailed check" for custom models** (optional in the settings): "Check model" now uses
  57 human texts and, with enough short texts, also suggests `shortRedFrom` – "none red"
  still only means false alarms roughly below ~5%, though. For reliable thresholds, send a few hundred paragraphs
  of various lengths (method `training/crossval_thresholds.py`). Takes minutes and costs money with
  cloud providers – only on request, with a notice. Servers can still specify both via `/v1/info`.
  Plus UI: `reliableWords`/`shortRedFrom` cannot be overridden by a slider for custom models.
- **Later – custom ONNX in the browser:**
  - HF repo with `onnx/` + tokenizer.
  - Architecture from a fixed list (BERT, RoBERTa, DeBERTa-v2, XLM-R, DistilBERT).
  - 2 labels, size limit.
  - Would be another entry in `models.js`; "Check model" could be reused for it.

## 2. Reduce false alarms (trust)

The biggest harm is red on a human text.

Done: language per paragraph, "uncertain" level, stricter TMR thresholds, wording, welcome (`DEVELOPMENT.md`,
"Fewer false alarms"; measurement in `training/EVAL_RESULTS.md`, "False alarms on Wikipedia"). Open:

- **Check grouping on home and section pages:** Since WP-10, paragraphs with 15–39 words are also
  grouped (`test/REAL_PAGES.md`: units that are too short on 32 article pages 95% → 39%, BBC now
  covered). Only article pages were measured. Risk: teaser grids and link lists as `<ul><li>`
  without navigation semantics could become groups. Also, an article made up entirely of
  isolated short paragraphs now stays completely unscored (previously the container was scored).
- **Check fakespot in a real browser:** Integrated as "Balanced" (`training/MODEL_SEARCH.md`,
  "ONNX comparison and integration"). The comparison ran with onnxruntime in Python; individual texts deviate
  by up to 0.52, the traffic light at the thresholds barely (≤ 0.6 percentage points). Download once in Chrome and
  compare against the Python scores on the eval suite or the harness (WASM).
- **Further candidates**, if needed: `ShantanuT01/gradient-ai-text-detector` (MIT, DeBERTa-v3-large,
  ONNX int4 408 MB, untested).
- **Check language detection in Firefox:** Clean in Chromium on real pages (`test/REAL_PAGES.md`:
  no wrongly skipped English paragraph, all paragraphs of the 6 non-English news articles
  skipped, foreign-language quotes correctly per paragraph). Open: Firefox (CLD2), once the extension runs
  there (item 4). Alternatives, if needed: `franc`/`franc-min`, `eld`, fastText `lid.176.ftz`,
  Chrome's `LanguageDetector`.
- **Make skipped paragraphs visible?** So far only as a count in the popup. If users think the
  page was not scanned: subtle marker or a notice the first time.

## 3. Eval suite: remainder

Done: 1200 texts, 6 domains, 7 generators up to GPT-4o (`training/EVAL_RESULTS.md`, "Broader
eval suite"), desklib on all 1200 texts and cross-validated thresholds ("Securing the thresholds").
As displayed: TMR 4.7% false alarms (without WikiHow 1.6%), desklib 1.2% with `redFrom` 0.94. Open:

- **TMR on how-tos:** 20% of the human WikiHow texts turn red (all ≥ 120 words). Re-check on
  real how-to pages; options: `redFrom` ~0.985 (costs detection everywhere), or
  desklib as default (item 2).
- **Claude/Gemini/GPT-5 are missing:** no public labeled dataset found. Generating our own
  would need API keys (a few hundred paragraphs on the topics of the human texts).
- **Measure TMR on real how-to pages:** 20% false alarms on continuous WikiHow text; whether the
  extension sees the same on rendered pages (lists, subheadings, `MIN_WORDS`) is
  open (`training/EVAL_RESULTS.md`, "Securing the thresholds"). Less urgent with desklib as the default.
- **License:** M4GT-Bench without a license statement – use the suite only locally, do not ship it
  as a BYOM reference set (item 1); select MAGE/HC3 portions (Apache-2.0) for that instead.

## 4. Publication

For now distribution is only via GitHub releases (zip from `npm run package`, instructions in `README.md`),
not via Chrome Web Store / Edge Add-ons.

Done: icons, "About / licenses", store texts and justification of the permissions (`store/`), README
for users, contact in `privacy.html` (reference to GitHub issues –
the developers receive no data, so they are not controllers within the meaning of the GDPR).
Open (for a later store listing details in `store/CHECKLIST.md`):

- **Create the first GitHub release** with the zip (the README links to `releases/latest`).
- **Legal notice (Impressum):** deliberately none (hobby project without a donation link). If that changes or a
  cease-and-desist letter arrives: set up a legal notice with a c/o address.
- **Only for the store:** host the privacy policy publicly (e.g. GitHub Pages); the store
  requires a URL.
- **Redo screenshots with a real model** on a real page; the current ones come from the
  harness with fake scores. The promo tile is only a placeholder.
- **Developer accounts:** Chrome $5 one time, Edge free.
- **Firefox:** not for now. The offscreen API is missing there; "In the browser" would need a different
  solution.

## 5. Score calibration per model

- **Goal:** Thresholds mean the same across models.
- **Implementation:** In `bg/scoring.js` apply per `modelKey` to the raw value. Raw values
  are stored, so a new calibration does not require re-scoring.
- **Data basis:** Eval suite from item 3 (`training/evaluate_suite.py`, raw scores in
  `training/data/eval_scores_*_suite.jsonl`), cross-validated ranges via `training/crossval_thresholds.py`.

## 6. German/multilingual

- **Model:** Fine-tuning of a multilingual encoder (mDeBERTa-v3/XLM-R), similar to desklib.
- **Extension:** `lang` per paragraph is already detected and sent along to server backends; what is open
  is that the provider then chooses the model (instead of skipping other languages).
- **Groundwork:** Laya dataset is ready (`training/data/`, 142k examples), training open
  (`training/README.md`).

## 7. Export/import reports per page

- **Content:** URL, paragraphs, scores, model, timestamp – from the result register.
- **Expansion stage:** account/sync/sharing, needs privacy/consent.

## 8. Feedback stage 2 (only if needed)

Voluntary upload to a dedicated collection server. Needs:

- A controller/legal notice.
- Deletion path per submitter (pseudonym ID).
- Protection against deliberately wrong labels (data poisoning).
- Extended privacy policy.

More important for training are generated data from several LLMs (`training/README.md`, "Feedback as a data
source").

## Technical items (from the v0.5 analysis)

- **Batch budget per model** (next to `maxInFlight` in `config.js`): Batches are limited to 2500
  characters and split by length before the model. A long desklib paragraph still takes several
  seconds in the browser; during that time the prioritization does not react to scrolling.
- **Blocklist UK:**
  - Status: ~60 `.uk` domains from UT1, 71 banks from Wikidata, plus hand-picked large banks.
  - The FCA register would be complete (API with a free key, redistribution terms not yet
    checked).
- **Blocklist DE:** The BaFin export has no websites.
- Gaps in the blocklist are caught by the password-field heuristic.
