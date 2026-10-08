# WP-06 · Model search between TMR and desklib

Task: TODO item 2 - a detector with desklib-like quality, but much less download/
compute time. Reference (`training/EVAL_RESULTS.md`, section "Broader eval suite" incl. "Correction",
1200 texts, 6 domains, 7 generators): TMR (126 MB, ~0.15 s/paragraph, AUROC 0.929, ~4.7% false alarms
as displayed) and desklib (1.7 GB download / ~475 MB in the browser, ~1.3-2.3 s/paragraph, AUROC 0.990,
~1.2% false alarms as displayed).

## Candidates (researched)

Criteria from the brief: open licence without a non-commercial clause, < 500 MB (ideally < 200 MB),
public without a gate, current training data, transformers.js-compatible architecture (checked:
RoBERTa, BERT and ModernBERT are present in the `@huggingface/transformers@4.3.0` pinned in this repo
- `package/src/models/{roberta,bert,modernbert}/`; Longformer is not).

| Repo | Licence | Architecture | Size (fp32 / ONNX) | ONNX available | Training data | Status |
|---|---|---|---|---|---|---|
| **fakespot-ai/roberta-base-ai-text-detection-v1** | Apache-2.0 | RoBERTa-base (125M) | 499 MB / **125 MB int8** | Yes ([MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx), Apache-2.0, `sha 0c809a8`, explicitly built for transformers.js) | Not disclosed in detail (refers to github.com/FakespotAILabs/ApolloDFT, technical report without a concrete list of sources) | **Measured, recommended** |
| MayZhou/e5-small-lora-ai-generated-detector | MIT | BERT/e5-small (33M) | 133 MB / no ONNX | No | RAID-train (80k human, 128k AI) + 10k Twitter+GPT-4o-mini paraphrases | Measured, **rejected** (poorly calibrated) |
| AICodexLab/answerdotai-ModernBERT-base-ai-detector | Apache-2.0 | ModernBERT-base (149M) | 598 MB / no ONNX | No | DAIGT V2 (Kaggle student essays + ChatGPT/Claude/DeepSeek, ~36k texts) | Measured, **rejected** (scores saturate near 1.0, generalises poorly) |
| ShantanuT01/gradient-ai-text-detector | MIT | DeBERTa-v3-large (~435M, like desklib) | 1.74 GB / 408 MB (int4 `model_q4.onnx` only, no int8) | Yes (int4) | DACTYL 2.0 + LLMTrace + MAGA-Bench (~1.1 million texts) | Not measured: size target clearly missed (almost as large as desklib, int4 in the browser also risky/little tested); model card claims AUROC 0.955 OOD vs. desklib 0.921 OOD - own value, not verified |
| yaful/MAGE | Apache-2.0 | Longformer | - | - | MAGE dataset | **Rejected**: Longformer is not supported by transformers.js; MAGE is also one of the three sources of our own eval suite (`training/EVAL_RESULTS.md`) - direct contamination |
| Hello-SimpleAI/chatgpt-detector-roberta | no licence given | RoBERTa-base | - | - | HC3 | **Rejected**: no licence in the model repo, HC3 is part of our eval suite (forum domain) - contamination |
| andreas122001/roberta-academic-detector, roberta-mixed-detector | OpenRAIL | RoBERTa-large | - | - | NicolaiSivesind/human-vs-machine | **Rejected**: OpenRAIL is a behavioural licence (usage restrictions), not MIT/Apache/CC-BY as required |
| raj-tomar001/LLM-DetectAIve_deberta-base | no licence/model card | DeBERTa-base | - | - | unknown | **Rejected**: no model card, no licence information |
| SuperAnnotate/ai-detector(-low-fpr) | "other" (unclear) | RoBERTa-large | 1.4 GB | No | Wikipedia + ELI5 | **Rejected**: licence unclear, too large, Wikipedia/ELI5 are part of our eval suite - contamination |

8 candidates researched, 3 actually measured (acceptance requires at least 2).

## Measurement method

`evaluate_backends.py` extended with a generic `score_hf(texts, model_id)` (detects sigmoid-
for-1-label vs. softmax-for-N-labels+id2label heuristic, as in the existing TMR scorer).
`evaluate_suite.py` now supports `--backend hf:<repo>`: runs exactly like the TMR path on the
full 1200 suite and prints the same tables (AUROC overall/per domain/per generator/per
length bucket, "as displayed" per rule 9). Since there is no production threshold for a new candidate,
`report()` derives it automatically from the 99th percentile of this measurement's own
human scores (separately for < 120 / ≥ 120 words, `reliableWords=120`) and uses
it for the "as displayed"/domain/generator tables - identical method to the existing
threshold recommendation at the end of the script, just moved up front. Raw scores under `training/data/` (gitignored):
`eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`,
`eval_scores_MayZhou_e5-small-lora-ai-generated-detector_suite.jsonl`,
`eval_scores_AICodexLab_answerdotai-ModernBERT-base-ai-detector_suite.jsonl`.

`benchmark_latency.py` extended with a generic `bench_hf(model_id)` (`--backend hf:<repo>`),
identical method to the existing TMR/desklib measurements (batch 1/8/25, 500-character text).
Latency was only measured when, according to `tasklist`, no other Python process was running (WP-07 was already
finished at that point, git history of `orchestration/LOG.md`, 19:08) - additionally checked before and after each measurement
via `tasklist`.

No new Python packages needed: RoBERTa, BERT and ModernBERT are covered by the already installed
`transformers==5.17.0`.

## Results

### Overall AUROC (1200 texts TMR/fakespot, 480 desklib sample - numbers from EVAL_RESULTS.md)

| Backend | n | Overall AUROC |
|---|---|---|
| TMR | 1200 | 0.929 |
| **fakespot-ai roberta-base** | **1200** | **0.964** |
| desklib | 480 | 0.990 |
| e5-small-lora (rejected) | 1200 | 0.878 |
| ModernBERT-base-detector (rejected) | 1200 | 0.879 |

### As displayed, recalibrated to ~1% false alarms (99th percentile of this suite, rule 9)

Fairly comparable, because all three backends are recalibrated with the same method on the same suite
(TMR/desklib values from EVAL_RESULTS.md, section "Threshold recommendation", not their
production thresholds):

| Backend | Bucket | Threshold | False alarms | AI detected |
|---|---|---|---|---|
| TMR | ≥ 120 words | 0.9853 | 1.1% | 61.9% |
| **fakespot** | **≥ 120 words** | **0.9988** | **1.1%** | **90.1%** |
| desklib | ≥ 120 words | 0.9254 | 1.1% | 97.4% |
| TMR | < 120 words | 0.9868 | 1.5% | 9.6% |
| **fakespot** | **< 120 words** | **0.9994** | **1.5%** | **36.0%** |
| desklib | < 120 words | 0.9566 | 1.8% | 79.6% |

At the same false alarm rate, fakespot is clearly between TMR and desklib - for long paragraphs with
90% detection much closer to desklib (97%) than to TMR (62%), for short paragraphs (< 120 words,
"uncertain" instead of red in the extension anyway, except with shortRedFrom) roughly in the middle.

### As displayed per domain (fakespot, own 99% threshold 0.9988; TMR/desklib for comparison at their
production threshold, from the "Correction" table in EVAL_RESULTS.md - not exactly the same
calibration method, but the only domain values available there)

| Domain | AUROC TMR / fakespot / desklib | FA red TMR / fakespot / desklib | AI red TMR / fakespot / desklib |
|---|---|---|---|
| forum | 0.962 / 0.996 / 1.000 | 2% / 1.0% / 0% | 81% / 94% / 100% |
| howto | 0.767 / 0.955 / 0.968 | 20% / 2.0% / 2.5% | 64% / 75% / 92.5% |
| news | 0.940 / 0.958 / 0.991 | 3% / 2.0% / 2.5% | 73% / 85% / 90% |
| reviews | 0.924 / 0.962 / 0.992 | 2% / 0% / 0% | **13% / 32% / 70%** |
| sci_abstract | 0.977 / 0.998 / 0.995 | 0% / 0% / 2.5% | 79% / 92% / 95% |
| wikipedia | 0.995 / 0.985 / 0.999 | 1% / 2.0% / 0% | 92% / 95% / 97.5% |

fakespot clearly improves TMR's weakest domain (howto: AUROC 0.767 → 0.955, detection 64% → 75% with
less than a tenth of the false alarms). `reviews` remains the most difficult domain for all three models
(short, informal Yelp/IMDb texts) - fakespot does improve on TMR noticeably here
(13% → 32%), but stays far behind desklib (70%).

### Detection per generator (fakespot, at the 0.9988 threshold)

| Generator | fakespot detected |
|---|---|
| gpt4 / gpt4o | 96.7% |
| llama3-70b | 91.1% |
| mixtral-8x7b | 89.3% |
| gemma2-9b-it | 85.7% |
| cohere | 71.4% |
| gpt-3.5-turbo | 68.8% |

Similar pattern to TMR (weaker on Cohere/older GPT-3.5), but at a higher level - no
generator below 68%, TMR dropped to 68% on gemma2-9b-it and was lower on average.

### Latency (CPU, PyTorch, `benchmark_latency.py`, 500-character text; measured without a parallel running
Python process, see above)

| Backend | Load time (cold) | Batch=1 | Batch=8 | Batch=25 | RSS after loading |
|---|---|---|---|---|---|
| TMR | 1.83 s | 80 ms/text | 45 ms/text | 44 ms/text | 917 MB |
| **fakespot roberta-base** | 1.78 s | 76 ms/text | 49 ms/text | 45 ms/text | 917 MB |
| desklib (from EVAL_RESULTS.md, same method) | - | ~1.3-2.3 s/text | - | - | ~800 MB |

fakespot is practically identical to TMR in load time, latency and RAM (both RoBERTa-base, 125M
parameters) - expected, as same architecture/size class. e5-small-lora and ModernBERT-base were
not measured separately for latency because of their weak accuracy (e5-small would be faster than
TMR, ModernBERT-base slower because of 22 instead of 12 layers - both irrelevant for the recommendation).

## Why e5-small-lora and ModernBERT-base were rejected

- **e5-small-lora**: AUROC 0.878 (worse than TMR). At the threshold calibrated to 1% false alarms
  (0.961) only **17-19%** of the AI texts are detected - the model is poorly calibrated on this suite
  (even a neutral example sentence like "The quick brown fox..." got a 92.6% AI score in the
  short test). RAID training (many open/older models) apparently generalises
  poorly to the more recent generators of this suite.
- **ModernBERT-base-detector**: AUROC 0.879. Scores saturate close to 1.0 (99% threshold rounds to
  1.0000), detection at 1% FA only **~31%**. Trained on a narrow dataset (Kaggle DAIGT,
  student essays) - generalises poorly to the 6 domains of this suite. ModernBERT as an
  architecture is technically promising (supported by transformers.js, efficient), but
  this specific checkpoint is not suitable for our use case; a ModernBERT-base retrained on broader data
  (e.g. RAID or MAGE-like) could be a candidate for a
  later round.

## Recommendation

**fakespot-ai/roberta-base-ai-text-detection-v1** as the third model entry in `extension/models.js`
(implementation is a work package of its own, only the basis here):

- **Browser integration**: ready-made ONNX from [`MedAliFarhat/ai-text-detector-onnx`](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx)
  (Apache-2.0, `sha 0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc`, explicitly built for transformers.js
  - `onnx/model_quantized.onnx`, 125 MB int8). Just like the TMR entry: pin `repo`/`revision`,
  `marker: "onnx/model_quantized.onnx"`, `download: "125 MB"`. **No** `desklib_build.js`-
  style conversion step needed - simplest of the three cases in the current catalogue.
- **Thresholds** (derived from the 99th-percentile calibration of this suite, as originally for
  desklib - fine calibration/cross-validation is a WP-07 task):
  - `reliableWords: 120` (keep the convention)
  - `redFrom ≈ 0.999` (≥ 120 words: ~1.1% false alarms, ~90% detected)
  - `shortRedFrom ≈ 0.999` (< 120 words: ~1.5% false alarms, ~36% detected) - weak, but better than
    TMR's "never red" below reliableWords; alternatively leave it out entirely like TMR if 36% detection counts as too
    unreliable. Recommendation: set it, knowing that it falls clearly behind
    desklib.
  - `yellowFrom`: not calibrated in this measurement (no false alarm target defined for yellow) -
    provisionally e.g. 0.90 (analogous to TMR's yellow→red gap of ~0.03, more generous here because of the
    steep score distribution near 1.0), WP-07/a follow-up measurement should
    check this with real yellow FA numbers.
- **Role**: as a fast alternative to TMR (same latency/size class, ~125 MB, ~45-80 ms/text),
  but with noticeably better separation (AUROC 0.964 vs. 0.929) and clearly fewer false alarms
  at the same detection rate - especially on `howto`, where TMR has been weakest so far. Still stays
  clearly behind desklib (above all the `reviews` domain and short paragraphs) - does not replace desklib as
  the most accurate option, but improves the fast option.

## Limitations

- fakespot-ai does not document its training data in detail (only a reference to a GitHub repo without a
  concrete list of sources) - unlike TMR/desklib it is unclear whether/how much overlap with
  MAGE/M4GT/HC3 (our eval sources) exists. The AUROC numbers could therefore be optimistic,
  as already noted for the other models in EVAL_RESULTS.md.
- The model card recommends `clean_text` preprocessing (Markdown/whitespace normalisation) for
  better results; this measurement uses raw running text without this cleaning (just as TMR/desklib
  run here without special treatment) - the eval suite consists of already cleaned running text without
  Markdown, so the effect should be small, but has not been checked separately.
- The `reviews` domain remains weak (32% detected with fakespot) - anyone scanning heavily for Yelp/IMDb-like content
  should not expect a high detection rate here, regardless of the chosen backend.
- Thresholds are derived from the same sample they were evaluated on (no
  cross-validation as in WP-07 for TMR/desklib) - before adopting them in `extension/models.js`
  the same cross-validation that WP-07 performed for TMR/desklib is worthwhile.
- ShantanuT01/gradient-ai-text-detector was not measured (time budget, size target clearly missed),
  but itself claims a better OOD AUROC than desklib - if a later round wants to get even closer to
  desklib quality and 400+ MB is acceptable, this would be a candidate for a real measurement.
- As with the broader eval suite in general: no Claude/Gemini as a generator, source data partly from before
  2023, TMR/desklib/fakespot may have seen parts of the source datasets in their own training.

## ONNX comparison and integration (WP-09)

Follow-up to WP-06: Before fakespot lands as the third entry in `extension/models.js`, it must be checked
whether the ready-made third-party ONNX (`MedAliFarhat/ai-text-detector-onnx`, not built by the model creator
themselves) delivers the same weights/labels as the PyTorch original and whether the traffic light (rule 9,
`orchestration/README.md`) changes appreciably as a result.

### Label mapping checked

The `config.json` of original and ONNX are identical: `id2label = {"0": "Human", "1": "AI"}`,
`label2id = {"AI": 1, "Human": 0}` - no swapped classes. `offscreen.js` correctly finds index 1 with its
regex (`/^(ai|machine|generated)$/i`). `tokenizer_config.json` names
`tokenizer_class: "RobertaTokenizer"` - already supported in `offscreen.js` (`TOKENIZER_CLASSES`),
no change to `offscreen.js` needed (simplest of the three catalogue cases, as expected).

### Method (`training/compare_onnx.py`, new)

Loads both models (ONNX via `onnxruntime` + `transformers` tokenizer, PyTorch original via
`transformers`) and scores them on the same `eval_suite.jsonl` (1200 texts) with **identical
preprocessing**: `clip_text()` (Python re-implementation of `content.js` `clipText`, 2000 characters,
preferably cut at the end of a sentence - as for the TMR entry) followed by tokenizer truncation to 512 tokens
(`offscreen.js`, `maxTokens`). Important: The raw PyTorch scores produced in WP-06
(`eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`) were produced **without** `clipText`
(tokenizer truncation only) - 31% of the suite texts are longer than 2000 characters, so a direct
comparison against these old scores would also have measured the clipText effect. That is why
`compare_onnx.py` freshly recomputes the PyTorch reference with identical preprocessing, for a clean,
isolated ONNX-vs-PyTorch comparison.

### Result: ONNX vs. PyTorch (n=1200, same preprocessing)

| Metric | Value |
|---|---|
| AUROC ONNX | 0.9554 |
| AUROC PyTorch (with clipText) | 0.9598 |
| Pearson correlation of the scores | 0.9819 |
| Mean deviation \|ONNX − PyTorch\| | 0.0369 |
| Median deviation | 0.0017 |
| Max. deviation | 0.5198 (single case) |
| Deviation > 0.01 | 458/1200 texts (38.2%) |
| Deviation > 0.05 | 245/1200 texts (20.4%) |
| clipText effect only (PyTorch with vs. without, same model) | mean deviation 0.0247, max 0.9395 |

The int8 quantisation of the third-party ONNX measurably moves a noticeable share of the scores (AUROC 0.4
points lower, ~38% of the texts deviate by more than 0.01, individual outliers up to 0.52) - **but**
the scores of this model cluster near 1 anyway (see WP-06), and exactly where the
production threshold lies (~0.999), ONNX and PyTorch remain practically identical:

| Candidate threshold (redFrom, ≥120 words) | ONNX: FA / detected | PyTorch: FA / detected | Delta FA / detected |
|---|---|---|---|
| 0.9990 | 1.1% / 89.5% | 1.1% / 89.5% | 0.0 / 0.0 points |
| 0.9994 | 0.6% / 88.2% | 0.6% / 87.6% | 0.0 / 0.6 points |
| 0.9988 | 1.5% / 90.3% | 1.3% / 89.9% | 0.2 / 0.4 points |
| 0.9966 | 3.2% / 93.5% | 3.0% / 93.3% | 0.2 / 0.2 points |

**Assessment:** At every realistic candidate threshold the deviation in false alarms and
detection as displayed is at most 0.2 and 0.6 percentage points respectively - well within the
sampling uncertainty of this suite (cf. the cross-validation ranges below, which on their own already amount to
several percentage points). The traffic light does **not change
appreciably** through the ONNX conversion - **integration approved** (acceptance criterion met).

### Cross-validated thresholds (ONNX scores, method as in `crossval_thresholds.py`, WP-07)

`crossval_thresholds.py` extended with `--backend fakespot`, now reads `data/eval_scores_fakespot_suite.jsonl`
(the ONNX scores from `compare_onnx.py` - **exactly the numbers the extension would actually see**, as
required by the brief, not the PyTorch reference). 200 stratified half/half splits, target 1% FA:

| Bucket | Cross-validated threshold (median, 5th–95th percentile) | FA on test half (median, 5th–95th percentile) | AI detected (median, 5th–95th percentile) |
|---|---|---|---|
| ≥120 words (redFrom) | 0.9989 (0.9982–0.9995) | 1.29% (0–3.45%) | 89.5% (86.6–92.9%) |
| <120 words (shortRedFrom) | 0.9994 (0.9987–0.9995) | 1.45% (0–7.25%) | 34.4% (28.1–43.8%) |

No "current value" for comparison (the model is new) - unlike TMR/desklib in WP-07 there is
no column "current threshold on test halves" here.

**Chosen values for `extension/models.js`:** `redFrom = 0.999` (within the cross-validated range,
matches the one-off WP-06 estimate 0.9988), `shortRedFrom = 0.9994` (median of the
cross-validation). `yellowFrom = 0.95` not cross-validated (no false alarm target defined for yellow,
purely informative as with TMR/desklib) - at 0.95, 12.8% of the human scores are still "yellow or
higher", at 0.999 only 1.5%.

### Comparison table TMR / fakespot / desklib, as displayed (identical method + suite)

From the crossval medians of this WP and from `EVAL_RESULTS.md`, "Securing the thresholds" (WP-07,
same method, same suite):

| Backend | Bucket | Cross-validated threshold (median) | FA on test half (median, 5th–95th perc.) | AI detected (median, 5th–95th perc.) |
|---|---|---|---|---|
| TMR | ≥120 w. (redFrom) | 0.9850 | 1.29% (0.43–3.45%) | 65.3% (55.2–75.3%) |
| **fakespot** | **≥120 w. (redFrom)** | **0.9989** | **1.29% (0–3.45%)** | **89.5% (86.6–92.9%)** |
| desklib | ≥120 w. (redFrom) | 0.9466 | 1.29% (0–3.45%) | 97.1% (95.4–98.7%) |
| TMR | <120 w. (shortRedFrom) | 0.9867 | 2.90% (0–5.87%) | 13.3% (4.7–23.4%) |
| **fakespot** | **<120 w. (shortRedFrom)** | **0.9994** | **1.45% (0–7.25%)** | **34.4% (28.1–43.8%)** |
| desklib | <120 w. (shortRedFrom) | 0.9758 | 1.45% (0–5.87%) | 78.1% (64.1–87.5%) |

Confirms WP-06: at an identical false alarm rate, fakespot is clearly between TMR and desklib, for
long paragraphs much closer to desklib (89.5% vs. 97.1%) than to TMR (65.3%); for short
paragraphs roughly in the middle (34.4% against TMR's 13.3% and desklib's 78.1%). With the fixed chosen
values (0.999 / 0.9994 instead of the crossval medians) fakespot "as displayed" overall is at ~1.2%
false alarms and 77.8% detected AI texts (all lengths together); per domain: forum 1.0%/93.0%,
howto 3.0%/73.0%, news 2.0%/85.0%, reviews 0%/31.0%, sci_abstract 0%/91.0%,
wikipedia 1.0%/94.0% (ONNX scores, chosen thresholds). `reviews` remains the weakest domain, as with all three
backends.

### Integration

fakespot as the third entry in `extension/models.js` (key `fakespot`, title "Balanced –
fakespot"): `repo: "MedAliFarhat/ai-text-detector-onnx"`, `revision` pinned to
`0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc` (according to the model card "built for transformers.js"),
`maxTokens: 512`/`maxChars: 2000` (like TMR, same architecture/size class), thresholds as above.
**No code in `offscreen.js` changed** - the existing generic catalogue/tokenizer/label logic
already covers fakespot completely (see label check above). `desklib` stays the default model,
`fakespot` is a third, additional choice.

**Server section:** `server/shim_server.py` extended with a `fakespot` backend (almost identical code to
`tmr`: `AutoModelForSequenceClassification` + softmax + `ai_index` heuristic, no special treatment
as with desklib's own pooling class needed) - little effort, so included. Revision there:
`f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db` (PyTorch original, last commit).

**Licence:** `extension/THIRD_PARTY_NOTICES.md` extended with the fakespot entry (Apache-2.0 for
original and third-party ONNX, base model RoBERTa-base MIT).

### Limitations (in addition to WP-06)

- The deviation between ONNX and PyTorch is partly considerable for mid-range scores (neither clearly human nor clearly AI)
  (median 0.002, but individual texts up to 0.52) - irrelevant for the traffic light, because there
  "uncertain"/"yellow" applies anyway instead of a hard decision, but relevant for anyone who compares the
  raw percentages in the popover uncritically.
- Cross-validated thresholds for the "short" bucket rely on only ~130 human scores per
  train half (as with TMR/desklib in WP-07) - the range (0–7.25% FA) is correspondingly wide, to be taken
  seriously.
- The ONNX comparison ran on CPU with `onnxruntime` (Python), not with `onnxruntime-web`/WASM as in the
  browser - a WASM-specific deviation (different kernel implementation) is theoretically possible,
  but according to the TMR/desklib experience in this repo has never been observed so far.
- Manual load test (`@huggingface/transformers` in Node, same options as `offscreen.js`:
  `dtype: "q8"`, pinned revision) confirms: tokenizer and model load from the real ONNX path,
  `id2label`/`aiIndex` are detected correctly, inference returns plausible probabilities in
  [0, 1]. The two test sentences for it were themselves formulated by a language model (this
  report) and therefore unsuitable as a "human" control - both accordingly came out high
  (0.997 and 0.9999). The 1200-text suite above is what is meaningful, not this smoke test.
