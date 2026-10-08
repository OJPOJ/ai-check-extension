# Backend comparison: Laya (zero-shot) vs. TMR vs. desklib

As of 2026-09-23. Accuracy: 100 balanced examples (50 human / 50 AI) from the
HC3 holdout split (`data/holdout.jsonl`, domain mostly `reddit_eli5` — informal,
colloquial text). Latency/memory: `benchmark_latency.py`, CPU (no GPU test),
batch sizes modelled on `extension/content.js` (BATCH_SIZE=25). Reproducible with
`evaluate_backends.py` (sample in `eval_sample.jsonl`, raw data in `eval_scores_<backend>.jsonl`).

| Backend | Accuracy@0.5 | AUROC | Accuracy@best threshold | ms/text (batch=25) | Batch=25 total | RAM loaded |
|---|---|---|---|---|---|---|
| Laya (`english`, zero-shot) | 0.510 | 0.549 | 0.570 (threshold 0.74) | ~2458ms | ~61s | ~2.1 GB (Docker) |
| **TMR** (RoBERTa-base, 125M) | 0.550 | **0.911** | **0.830** (threshold 0.98) | **~62ms** | **~1.6s** | **~900 MB** |
| **desklib** (DeBERTa-v3-large, 430M) | **0.960** | **0.998** | **0.990** (threshold 0.87) | ~4869ms | ~122s | ~4.65 GB |

## Performance trade-off (important for "runs along in the background")

**desklib is by far the most accurate (AUROC 0.998, only 1 error out of 100 at the optimal
threshold), but on CPU ~80× slower than TMR and needs ~5× more RAM.** A normal
page scan with 25 candidates (the batch size that `content.js` actually uses)
would take **around 2 minutes** with desklib and at times occupy **4.65 GB RAM** — that
is not compatible with the requirement "runs along in the background without noticeably
slowing down the machine". TMR handles the same batch in **~1.6 seconds** at **~900 MB**.

All numbers were measured CPU-only (no GPU tested on this machine) — with a CUDA GPU
all three backends would be considerably faster, but the ratio between them would stay similar.

**Bug/compatibility finding along the way:** desklib's own example code (model card, 2024)
crashes on loading with `transformers>=5` (`AttributeError: ... 'all_tied_weights_keys'`) —
fixed by an overridden property (empty dict), see `evaluate_backends.py` and
`../server/shim_server.py`. Concrete evidence that 2024 model code no longer runs
with current software without adaptation.

## Interpretation

- **Laya zero-shot has no usable signal.** AUROC 0.549 means: barely better than a
  coin flip, whichever threshold you choose. Matches the docs warning
  ("treat Laya as a fast base to specialise, not as a zero-shot decision engine") and the
  early manual test in `../server/README.md`. Without our own fine-tuning (phase D) Laya
  remains unusable for this task.

- **TMR separates well (AUROC 0.911), but was miscalibrated at threshold 0.5 for this
  text domain:** at 0.5 it wrongly marked 45 of 50 human Reddit-style texts as
  AI (overall score mean 0.893 — systematically too high for this domain).
  With a threshold optimised on this sample (0.98) the accuracy rises to 0.830
  (TP=41, FP=8, FN=9, TN=42) — clearly usable, though not perfect.

## Conclusion for the extension

- TMR is clearly superior to Laya zero-shot and should become the default backend.
- The default threshold in the extension must NOT be 0.5 — 0.90–0.95 is a more
  realistic starting point for informal/short text, but it will fit differently well per domain (article vs.
  forum post vs. product review). It should remain freely adjustable in the settings.
- 100 examples from one domain are a rough estimate, not a reliable calibration.
  Before feeling "done", a larger/more diverse eval run is worthwhile (more HC3 domains,
  possibly a RAID sample) — noted as a follow-up step, not part of this run.

## Text length: more context instead of chunks (2026-09-25)

Question: The auto-scan only sent the first 500 characters per paragraph. Is more text worth it, and do
chunks with overlap help? Same HC3 texts with ≥ 1500 characters, human/AI balanced, CPU (PyTorch).
Reproducible with `evaluate_length.py`.

TMR, n = 400, `--normalize` (spaces before punctuation from ELI5 removed, otherwise you partly
measure this artefact):

| Variant | AUROC | Acc@best threshold | Passes/text | s/text |
|---|---|---|---|---|
| A first 500 characters | 0.966 | 0.910 | 1 | 0.20 |
| **B first 1500 characters in one piece** | **0.999** | **0.993** | 1 | 0.43 |
| C 500-char chunks, 100 overlap, mean | 0.972 | 0.917 | 4 | 0.55 |
| D 500-char chunks without overlap, mean | 0.979 | 0.938 | 3 | 0.37 |

Without `--normalize` the same picture (A 0.940 → B 0.993). desklib (n = 80, without `--normalize`): A 0.994,
B/C/D 1.000 each – too easy on HC3 to tell the variants apart; compute time 0.58 → 2.3 s/text.

- One long pass clearly beats chunks: the model uses the context, the mean
  over pieces does not replace it. Overlap brings nothing.
- Consequence in `content.js`: auto-scan and manual check send up to 2000 characters (≈ 512 tokens,
  the model sees no more), cut at the end of a sentence; batches by amount of text (≤ 2500 characters).
- Chunking only makes sense beyond 512 tokens (whole articles) or to narrow down the
  AI passages in mixed texts.
- Limitations: HC3/English only, long texts only; both models may know HC3 from
  training → absolute values too optimistic, the comparison of the variants (same texts) holds.

## Padding: split batches by length (2026-09-25)

A batch is padded to the longest text (and in `evaluate_backends.py` so far always to
768 tokens). Typical scan batch: one long paragraph (654 tokens) + four short ones (~70 tokens),
server code (`shim_server.py`), CPU:

| Model | everything padded together | grouped by length | max. score deviation |
|---|---|---|---|
| desklib | 16.6 s | 4.4 s | 0 |
| TMR | 1.7 s | 0.6 s | 0 |

Scores identical, because padding tokens are masked out (desklib: mean pooling with mask, TMR:
attention mask). Implemented in `extension/length-buckets.js` (browser) and `length_buckets()` in the
server: sort, new group as soon as a text > 1.25 × shortest + 16 tokens. `evaluate_backends.py`
now pads only to the longest text in the batch.

Also: a single desklib text with ~650 tokens costs ~4.5 s on the CPU – that is why the
auto-scan sends desklib only up to 1500 characters (~350 tokens), although the model could handle 768 tokens
(`extension/config.js`, `maxChars`).

## False alarms on Wikipedia (2026-09-25)

Question: How often does human factual text turn red? Occasion: TMR marked Wikipedia "Photosynthesis" 50/80 red
(thresholds 0.6/0.9). Human: paragraphs from WikiText-2 (Wikipedia "Good"/"Featured" Articles, before 2016,
hence certainly without LLMs), human HC3 answers for comparison; AI: ChatGPT answers from HC3. Texts cut as
in the auto-scan (TMR 2000, desklib 1500 characters), split by word count. Reproducible with
`evaluate_false_alarms.py` (TMR n = 200, desklib n = 60 per row).

Share with score ≥ threshold – for human = false alarm, for AI = detected.

**TMR:**

| Source | Words | ≥ 0.6 | ≥ 0.9 | ≥ 0.95 | ≥ 0.97 | ≥ 0.98 | ≥ 0.99 |
|---|---|---|---|---|---|---|---|
| Wikipedia (human) | 40–79 | 89.5% | 74.5% | 59.5% | 38.5% | 20.0% | 0% |
| Wikipedia (human) | 80–119 | 66.0% | 53.0% | 43.0% | 32.0% | 15.5% | 0% |
| Wikipedia (human) | 120–149 | 28.5% | 19.0% | 14.5% | 8.0% | 1.5% | 0% |
| Wikipedia (human) | 150+ | 13.0% | 8.5% | 6.0% | 2.5% | 0.5% | 0% |
| HC3 (human) | 40–79 | 80.5% | 55.5% | 38.5% | 21.5% | 9.5% | 0% |
| HC3 (human) | 80–119 | 55.5% | 40.5% | 29.0% | 19.5% | 9.5% | 0% |
| HC3 (human) | 120–149 | 25.5% | 13.5% | 5.5% | 2.0% | 0.5% | 0% |
| HC3 (human) | 150+ | 39.0% | 29.0% | 18.5% | 9.5% | 2.5% | 0% |
| HC3 ChatGPT (AI) | 40–79 | 100% | 100% | 99.5% | 97.5% | 81.5% | 0% |
| HC3 ChatGPT (AI) | 80–119 | 99.5% | 99.0% | 98.5% | 96.5% | 86.5% | 0% |
| HC3 ChatGPT (AI) | 120–149 | 99.5% | 98.0% | 96.5% | 95.0% | 87.0% | 0% |
| HC3 ChatGPT (AI) | 150+ | 100% | 100% | 99.5% | 98.5% | 92.0% | 0% |

- **The old starting values 0.6/0.9 were unusable for factual text:** three quarters of the short
  Wikipedia paragraphs red, at 80–119 words half. TMR is almost always high; the separation
  lies in the narrow band 0.97–0.99 (above 0.99 it practically never goes).
- **Length decides:** even at 0.98, 20% and 15.5% respectively of the Wikipedia paragraphs under 120 words are
  red, above that 1.5% and 0.5%.
- **Consequence (`extension/models.js`):** TMR yellow from 0.95, red from 0.98; under 120 words a
  high score becomes "unclear" instead of yellow/red (`reliableWords`). Cost: ~87–92% of the
  ChatGPT texts still turn red instead of ~100%.

**desklib** (n = 60 per row, correspondingly rough):

| Source | Words | ≥ 0.5 | ≥ 0.8 | ≥ 0.9 | ≥ 0.95 | ≥ 0.98 |
|---|---|---|---|---|---|---|
| Wikipedia (human) | 40–79 | 35.0% | 8.3% | 1.7% | 1.7% | 1.7% |
| Wikipedia (human) | 80–119 | 28.3% | 16.7% | 13.3% | 10.0% | 6.7% |
| Wikipedia (human) | 120–149 | 13.3% | 1.7% | 0% | 0% | 0% |
| Wikipedia (human) | 150+ | 5.0% | 1.7% | 0% | 0% | 0% |
| HC3 (human) | 40–79 | 16.7% | 6.7% | 0% | 0% | 0% |
| HC3 (human) | 80–119 | 3.3% | 0% | 0% | 0% | 0% |
| HC3 (human) | 120–149 | 11.7% | 6.7% | 0% | 0% | 0% |
| HC3 (human) | 150+ | 5.0% | 5.0% | 1.7% | 0% | 0% |
| HC3 ChatGPT (AI) | 40–79 | 98.3% | 96.7% | 96.7% | 81.7% | 68.3% |
| HC3 ChatGPT (AI) | 80–119 | 100% | 98.3% | 96.7% | 93.3% | 83.3% |
| HC3 ChatGPT (AI) | 120–149 | 98.3% | 98.3% | 98.3% | 96.7% | 95.0% |
| HC3 ChatGPT (AI) | 150+ | 100% | 100% | 100% | 100% | 100% |

- desklib separates much better (with red from 0.87 almost all AI texts are detected), but is
  not clean on Wikipedia under 120 words either: 80–119 words ~15% above the red threshold.
  (Re-measured with n = 150: ~6% above 0.87, evenly for 40–119 words – see "Confidence for
  short paragraphs".)
- **Consequence:** "unclear" under 120 words for both models and as the default for unknown ones;
  desklib thresholds stay 0.5 / 0.87.
- Limitations: English only, AI only ChatGPT 2023 (HC3, possibly in the models' training – the
  detection rates are rather too optimistic; this does not affect the false alarm rates on Wikipedia).

## Confidence for short paragraphs – desklib (2026-09-26)

Question: Does desklib always have to say "unclear" under 120 words, or can a short paragraph with
enough confidence still be marked red? The measurement above (n = 60) was too thin and contradictory for this
(40–79 words cleaner than 80–119). New: n = 150 per 20-word step, same sources, reproducible with
`evaluate_false_alarms.py desklib 150 --fine --dump fa_desklib.jsonl`.

**False alarms (score ≥ 0.87 = today's red threshold) and detection by length:**

| Words | Wikipedia (human) | HC3 (human) | ChatGPT (AI) |
|---|---|---|---|
| 40–59 | 6.0% | 3.3% | 76.7% |
| 60–79 | 6.7% | 2.0% | 92.0% |
| 80–99 | 5.3% | 0% | 94.0% |
| 100–119 | 6.7% | 1.3% | 98.7% |
| 120–149 | 0.7% | 1.3% | 98.7% |
| 150+ | 2.0% | 2.0% | 100% |

- Under 120 words evenly ~6% false alarms on Wikipedia, from 120 on ~1.3%. The 120 boundary is
  therefore right, but within the short paragraphs there is no trend with length (the earlier
  difference 40–79 vs. 80–119 was chance).
- The false alarms are ordinary encyclopaedic prose (history, military, weather, biographies) –
  no lists, tables or formulas. It is the factual style, not artefacts.

**Path 1 – own red threshold for short paragraphs.** All 600 short texts per source:

| Red from (under 120 words) | Wikipedia false alarms | HC3 false alarms | AI detected |
|---|---|---|---|
| 0.87 | 6.2% | 1.7% | 90.3% |
| 0.95 | 2.5% | 0.5% | 81.7% |
| 0.97 | 1.7% | 0.5% | 77.0% |
| **0.98** | **1.0%** | **0%** | **73.0%** |
| 0.99 | 0.7% | 0% | 65.5% |
| 0.995 | 0% | 0% | 56.8% |

For comparison long paragraphs at 0.87: 1.3% Wikipedia false alarms, 99.3% detected. Cross-validated (200×
half of the Wikipedia data to set it, the other half to check, target 1.3% like long paragraphs): threshold
median 0.980 (5–95%: 0.961–0.991), false alarms on the check half on average 1.3% (at most 4.3%).
Detection by length at 0.98: 45% (40–59 words), 72% (60–79), 83% (80–99), 92% (100–119).

**Path 2 – stability within the paragraph.** Short paragraphs with score ≥ 0.87 (589 of them) split at the sentence boundary near
the middle, both halves scored individually (`evaluate_split_half.py`). For false alarms the
halves are indeed further apart (median |a−b| 0.10 versus 0.03 for AI text), but as a rule this
is worse than path 1 at the same false alarm rate:

| Rule | Wikipedia false alarms | AI detected |
|---|---|---|
| Score ≥ 0.995 (path 1) | 0% | 56.8% |
| both halves ≥ 0.95 | 0.2% | 39.7% |
| Score ≥ 0.99 (path 1) | 0.7% | 65.5% |
| both halves ≥ 0.9 | 0.5% | 55.7% |
| Score ≥ 0.98 (path 1) | 1.0% | 73.0% |
| Score ≥ 0.97 and both halves ≥ 0.8 | 1.2% | 70.0% |

The halves are only 20–60 words long and thus unreliable themselves; in addition they cost two extra
model calls per paragraph. Path 2 is not worth it.

- **Proposal (not yet implemented):** desklib under 120 words red from 0.98 instead of never; 0.87–0.98
  stays "unclear". A short paragraph then turns falsely red only as often as a long one (~1%), and
  almost three quarters of the short AI paragraphs are marked as AI again instead of grey.
- **Not for TMR:** TMR is almost never above 0.99, at 0.98 under 120 words 15–20% of the
  Wikipedia paragraphs are still red (table above). There "unclear" remains the right answer.
- Limitations as above: English only, AI only ChatGPT 2023 from HC3 (detection rates rather too
  optimistic); 600 short Wikipedia paragraphs, 1% = 6 texts.

## Broader eval suite (2026-09-26, WP-01)

Question: The numbers so far come almost entirely from HC3 (Reddit-ELI5 vs. ChatGPT 2023) plus
one Wikipedia false alarm measurement - one domain, one AI model. How do TMR and desklib behave
across several domains and several, more recent AI generators?

**Data source:** [`Jinyan1/COLING_2025_MGT_en`](https://huggingface.co/datasets/Jinyan1/COLING_2025_MGT_en)
(Hugging Face), a compilation of three human-vs-AI detection research datasets:
MAGE ([`yaful/MAGE`](https://huggingface.co/datasets/yaful/MAGE), Apache-2.0), M4GT-Bench
(mbzuai-nlp/M4, EACL 2024 - no LICENSE file found in the GitHub repo, pure research/eval
use) and HC3 (Apache-2.0, already used in `prepare_dataset.py`). For the compilation
itself no licence is entered in the dataset card YAML; used only for local evaluation,
raw data stays under `data/` (gitignored), no redistribution. **RAID** (`liamdugan/raid`,
MIT licence) was examined but rejected: the `train`/`extra` splits there contain only open models
(Llama-Chat, Mistral, MPT, GPT-2) - the GPT-4/ChatGPT/Cohere generations listed in the dataset
apparently exist only in the unlabeled `test` split (leaderboard), so they are not publicly
usable with labels.

**Composition** (`build_eval_suite.py`, seed 42, reproducible): six domains, human
texts from before 2023 (the source datasets/tasks themselves are all older, XSum/CNN/Wikipedia/Reddit/
arXiv/Yelp/IMDb/WikiHow), AI text from the most recent generators available in this dataset:

| Domain (our category) | Sub-sources | Available generators |
|---|---|---|
| news | xsum, cnn, tldr, dialogsum | gpt-3.5-turbo (only one available) |
| wikipedia | wikipedia, wiki_csai | gpt4, gpt4o, gpt-3.5-turbo, llama3-70b, mixtral-8x7b, gemma2-9b-it, cohere |
| forum | reddit, cmv, reddit_eli5, eli5 | see above (all 7) |
| sci_abstract | arxiv, sci_gen, peerread, pubmed | see above (all 7) |
| reviews | yelp, imdb | gpt-3.5-turbo (only one available) |
| howto | wikihow | see above (all 7) |

Per domain 100 human + 100 AI texts (split across the available generators) = **1200
texts in total, 600/600 balanced**. Paragraphs 40–400 words (like `content.js` MIN_WORDS and
`extension/length-buckets.js`), cut at the end of a sentence; tokenisation artefact "space before
punctuation" (known from `reddit_eli5`/HC3, see above) normalised. Older/small generators in the
source dataset (davinci, opt_\*, flan_t5_\*, t0_\*, bloom\*, gpt_j, gpt_neox, GLM130B, dolly\*)
deliberately left out - no longer representative of today's AI text on the web. **No Claude/Gemini
available:** no public dataset with labelled Claude/Gemini generations found (this
extension has no API keys for generating its own) - a limitation, not a workaround.

**Scoring** (`evaluate_suite.py`): TMR on all 1200 texts, desklib on a stratified
sample of 480 (domain × human/AI evenly distributed) - desklib needs ~2.3 s/text on this CPU
(measured, the `benchmark_latency.py` order of magnitude is confirmed), 1200 texts would have cost ~46 minutes,
the sample ~18.5 minutes. Raw scores: `data/eval_scores_tmr_suite.jsonl` /
`data/eval_scores_desklib_suite.jsonl` (gitignored).

### Result: AUROC and false alarms at the current thresholds

Current thresholds from `extension/models.js` (only read, not changed): TMR yellowFrom 0.95 /
redFrom 0.98; desklib yellowFrom 0.5 / redFrom 0.87 (short paragraphs < 120 words: `shortRedFrom` 0.98
and none at all for TMR → there always "unclear" instead of red).

| Backend | n | Overall AUROC | False alarms (human) ≥ redFrom | AI detected ≥ redFrom |
|---|---|---|---|---|
| TMR | 1200 | 0.929 | 12.0% | 83.5% |
| desklib | 480 | 0.990 | 2.5% | 95.4% |

**Per domain:**

| Domain | TMR AUROC | TMR FA@red | TMR detected | desklib AUROC | desklib FA@red | desklib detected |
|---|---|---|---|---|---|---|
| forum | 0.962 | 6.0% | 86.0% | 1.000 | 0% | 100% |
| howto | **0.767** | 20.0% | 64.0% | 0.968 | 2.5% | 92.5% |
| news | 0.940 | **34.0%** | 99.0% | 0.991 | **10.0%** | 95.0% |
| reviews | 0.924 | 10.0% | 74.0% | 0.992 | 0% | 90.0% |
| sci_abstract | 0.977 | 1.0% | 86.0% | 0.995 | 2.5% | 97.5% |
| wikipedia | 0.995 | 1.0% | 92.0% | 0.999 | 0% | 97.5% |

TMR is clearly weaker on `howto` (how-tos, often list-like) (AUROC 0.767) than on the
domains measured so far. Both models have the highest false alarm rate on `news` - human
news texts/summaries (XSum/CNN) apparently resemble AI summaries stylistically
(smooth, neutral, short). For desklib this is only a rough estimate with n=80 per domain, though (10% FA
= 8 texts).

**Per generator** (share of AI texts detected ≥ redFrom):

| Generator | TMR (n≈56–256) | desklib (n≈19–102) |
|---|---|---|
| gpt4 | 86.7% | 100% |
| gpt4o | 88.3% | 100% |
| gpt-3.5-turbo | 87.1% | 94.1% |
| llama3-70b | 85.7% | 96.4% |
| mixtral-8x7b | 83.9% | 89.5% |
| cohere | 71.4% | 95.5% |
| gemma2-9b-it | **67.9%** | 94.7% |

TMR detects the GPT family and Llama most reliably, and is noticeably weaker on Cohere and especially Gemma2
(68–71% instead of 84–88%). desklib stays between 90–100% across all seven generators -
no generator on which it noticeably falters.

**Per length bucket** (human rows only for false alarms, AI rows only for "detected"):

| Words | TMR FA@yellow | TMR FA@red | TMR detected | desklib FA@yellow | desklib FA@red | desklib detected |
|---|---|---|---|---|---|---|
| 40–79 | 56.7% | 33.3% | 70.7% | 21.7% | 4.3% | 75.0% |
| 80–119 | 51.9% | 31.2% | 86.6% | 25.0% | 6.2% | 96.0% |
| 120–149 | 12.8% | 2.6% | 82.6% | 23.1% | 7.7% | 100% |
| 150+ | 19.1% | 6.4% | 84.7% | 7.6% | 1.2% | 97.8% |

Confirms the existing `reliableWords=120` boundary: under 120 words both models are unreliable
for "red" (TMR 31–33% FA, desklib 4–6% FA) - which is exactly why the extension shows "unclear" there
instead of yellow/red (except desklib with `shortRedFrom`). The 150+ numbers are somewhat higher than the earlier
Wikipedia-only measurement (TMR 1.3% → 6.4%, desklib ~1.3% → 1.2%, rather the same here), because now
`news`/`howto`/`forum` are included too, not just Wikipedia/HC3.

### Correction: false alarms the way the extension displays them

The "FA@red" columns above count every human text from `redFrom`, including short ones. But the extension does not colour texts
under `reliableWords` (120 words) by `redFrom`: TMR never red, desklib only from
`shortRedFrom` 0.98. With this rule (`evaluate_suite.py`, line "as displayed"; for the short
paragraphs without grouping from WP-02):

| Domain | TMR FA red | TMR AI red | desklib FA red | desklib AI red |
|---|---|---|---|---|
| forum | 2% | 81% | 0% | 100% |
| howto | **20%** | 64% | 2.5% | 92.5% |
| news | 3% | 73% | 2.5% | 90% |
| reviews | 2% | 13% | 0% | 70% |
| sci_abstract | 0% | 79% | 2.5% | 95% |
| wikipedia | 1% | 92% | 0% | 97.5% |
| **overall** | **4.7%** | 67% | **1.2%** | 91% |

This shifts the picture:

- **The high news false alarms (TMR 34%, desklib 10%) affect almost only short texts**, which stay
  "unclear" anyway (48 of 100 human news texts have under 120 words). As displayed: 3% and 2.5% respectively.
- **The real problem is TMR on `howto` (WikiHow):** all texts ≥ 120 words, 20% of the
  human ones turn red. Without `howto` TMR would be at ~1.6%.
- **desklib is already at ~1% with the current thresholds** (3 of 240). Raising `redFrom`
  to 0.92–0.95 (below) is therefore not necessary; the measurement yields too few cases for it.
- The percentile thresholds below refer to the raw scores of all lengths and are to be read
  accordingly: for TMR, `redFrom` would have to rise to ~0.985 for ~1% on long texts, almost only because of
  `howto`.

### Threshold recommendation for ~1% false alarms on this suite

Percentile method (99th percentile of this suite's human scores), separated by `reliableWords`:

| Backend | Bucket | Threshold for ~1% FA | actual FA | AI detected at that | current threshold |
|---|---|---|---|---|---|
| TMR | all | 0.9865 | 1.0% | 36.3% | redFrom 0.98 |
| TMR | < 120 words | 0.9868 | 1.5% | 9.6% | (always "unclear") |
| TMR | ≥ 120 words | 0.9853 | 1.1% | 61.9% | redFrom 0.98 |
| desklib | all | 0.9463 | 1.3% | 93.8% | redFrom 0.87 |
| desklib | < 120 words | 0.9566 | 1.8% | 79.6% | shortRedFrom 0.98 (73% detected, see above) |
| desklib | ≥ 120 words | 0.9254 | 1.1% | 97.4% | redFrom 0.87 (2.5% FA) |

**Concrete threshold recommendation:**

- **TMR:** The current value (redFrom 0.98) is at ~12% false alarms on this broader suite,
  not ~1% - the earlier calibration was tailored to Wikipedia/HC3, but does not hold on `news`/
  `howto`. For a real ~1% target across all domains it would need **redFrom ≈ 0.985–0.987**,
  which pushes detection on long texts from ~85% down to ~62% and on short texts (unclear
  anyway) detects almost nothing any more (9.6%). TMR thus remains a model with a narrow usable
  band between false alarms and detection - the existing recommendation "TMR for background scanning,
  but with caution on news/how-tos" is confirmed by this rather than refuted.
- **desklib:** The current value (redFrom 0.87) is at ~2.5% FA - already close to the target, but
  `news` drives that up to 10%. **redFrom ≈ 0.92–0.95** would reach ~1% FA across all domains,
  with only minimal loss of detection (95.4% → 93.8–97.4%, since desklib loses hardly any separation
  in this range) - a favourable trade that item 5 (calibration) should pick up.
  For short paragraphs (< 120 words) this suite suggests **shortRedFrom ≈ 0.955–0.96** instead of the
  current 0.98 - similar false alarm rate (1.8% vs. ~1% in the old Wikipedia-only measurement),
  but noticeably more short AI texts detected (79.6% instead of 73%). Before a change to
  `extension/models.js` a cross-validation (train/test split of this suite) is worthwhile - as with the short-paragraph finding above -
  because 480 texts (the false alarm bucket partly only ~20–30 texts) do not yet
  give a very tight error range.

### Default model recommendation

**desklib remains the clearly better choice where latency allows.** On this broader, harder
suite (6 domains, 7 current generators incl. GPT-4o, Llama-3-70B, Mixtral, Gemma-2, Cohere)
the AUROC gap (0.990 vs. 0.929) holds and even grows: TMR loses a lot of separation on `howto`
(0.767) and detection on Cohere/Gemma2 (68–71%), while desklib stays between 0.968–1.000 AUROC and 90–100%
detection across all domains and generators. The existing
division of roles in the extension (TMR for automatic background scanning because of speed, desklib
for "only on button press"/more accurate checking) remains sensible - TMR rather as a coarse first filter,
with the knowledge that it is weaker on news/how-tos and newer non-OpenAI models (Gemma,
Cohere).

### Limitations

- No Claude/Gemini available as a generator (no public labelled dataset found,
  no own API keys) - the detection rates say nothing about these two model families.
- M4GT-Bench licence unresolved (see above) - data stays local, no redistribution.
- desklib measured on only 480/1200 texts (time budget); domain values there on n=80 per domain,
  generator values on n=19–102 - in particular the 10% FA on `news` (8/80) and the
  short-paragraph numbers (n=13–32) have noticeable sampling uncertainty.
- Human texts are the original documents of the source datasets (before 2023), but partly themselves
  already algorithmically preprocessed (e.g. XSum/CNN are summarisation datasets) - "human"
  here means "written by humans", not necessarily "unedited raw text of a real web page".
- Paragraphs were taken from the start of possibly longer documents (first matching excerpt),
  not randomly from the middle - for very long documents (e.g. `howto`, median 500+ words)
  the rest of the document could yield different values.
- As always with these benchmarks: TMR/desklib may have seen parts of these source datasets (MAGE/M4GT/HC3
  were all published before 2025) in their own training - absolute detection rates
  rather too optimistic, the domain/generator *comparison* (same texts, same model) remains
  meaningful.

## Securing the thresholds: desklib at n=1200, cross-validation, TMR on how-tos (2026-09-26, WP-07)

Follow-up to "Broader eval suite": desklib was only measured there on a sample of 480/1200 texts,
the threshold recommendation (redFrom 0.92–0.95 desklib, 0.985–0.987 TMR) was based on a
single split without an error range. Here: desklib on all 1200 texts (the missing 720 computed afterwards,
existing 480 scores reused - `training/desklib_fill_suite.py`, CPU, 2866 s = 47.8 min for
the 720 new ones), plus a cross-validation of the thresholds (`training/crossval_thresholds.py`) and an
assessment of the WikiHow finding against the extension's actual candidate/grouping logic
(`content.js`).

### desklib on all 1200 texts

Raw scores: `data/eval_scores_desklib_suite.jsonl` (1200 rows, gitignored). Replaces the 480 numbers
in the section "Broader eval suite" above (left unchanged there, see there for the method).

| Run | n | Overall AUROC | FA as displayed | AI red as displayed |
|---|---|---|---|---|
| desklib (n=480, WP-01) | 480 | 0.990 | 1.2% | 91% |
| **desklib (n=1200, WP-07)** | **1200** | **0.991** | **1.8%** | **92.5%** |

Per domain (as displayed - short paragraphs by `shortRedFrom`):

| Domain | AUROC | FA red | AI red |
|---|---|---|---|
| forum | 0.999 | 3.0% | 98.0% |
| howto | 0.975 | 2.0% | 96.0% |
| news | 0.992 | 3.0% | 93.0% |
| reviews | 0.993 | 0% | 74.0% |
| sci_abstract | 0.998 | 2.0% | 97.0% |
| wikipedia | 0.996 | 1.0% | 97.0% |
| **overall** | **0.991** | **1.8%** | **92.5%** |

Per generator (share of AI texts detected ≥ redFrom):

| Generator | n | detected@red |
|---|---|---|
| cohere | 56 | 94.6% |
| gemma2-9b-it | 56 | 98.2% |
| gpt-3.5-turbo | 256 | 95.7% |
| gpt4 | 60 | 98.3% |
| gpt4o | 60 | 100% |
| llama3-70b | 56 | 98.2% |
| mixtral-8x7b | 56 | 94.6% |

Per length bucket (raw FA@red at 0.87, **without** the `shortRedFrom` logic - shows why it remains necessary):

| Words | n human | FA@red (raw) | n AI | detected@red |
|---|---|---|---|---|
| 40–79 | 60 | 13.3% | 58 | 81.0% |
| 80–119 | 77 | 9.1% | 67 | 98.5% |
| 120–149 | 39 | 5.1% | 23 | 95.7% |
| 150+ | 424 | 1.9% | 452 | 98.5% |

- With the full sample the "as displayed" false alarm rate rises from 1.2% (n=480) to 1.8%
  (n=1200) - the smaller sample was optimistic (among other things `forum` had 0% false alarms there, now
  3.0% at n=200 instead of n=80). AUROC stays practically the same (0.990 → 0.991).
- The raw FA@red column per length bucket again clearly confirms on the full sample considerably more
  false alarms under 120 words (13.3% / 9.1%) than above (1.9%) - `reliableWords=120` and
  `shortRedFrom` remain right.

### Cross-validated thresholds

Method (orchestration/LOG.md, DECISION): 200 repetitions, per repetition a random
half/half split (stratified by domain × label). On half A: threshold as the 99th percentile of the
human scores (target ~1% false alarms). On half B (unseen): actual false alarm/detection rate.
Separately for the group ≥120 words (governs `redFrom`) and <120 words (governs `shortRedFrom`, where
present) - this is exactly the split that `config.js` `level()` actually uses (rule 9 in
orchestration/README.md). Reproducible with `training/crossval_thresholds.py --backend both`.

| Backend | Bucket | Cross-validated threshold (median, 5th–95th perc.) | FA on test half (median, 5th–95th perc.) | AI detected (median, 5th–95th perc.) |
|---|---|---|---|---|
| TMR | ≥120 w. (redFrom) | 0.9850 (0.9835–0.9858) | 1.29% (0.43–3.45%) | 65.3% (55.2–75.3%) |
| TMR | <120 w. (shortRedFrom) | 0.9867 (0.9865–0.9868) | 2.90% (0–5.87%) | 13.3% (4.7–23.4%) |
| desklib | ≥120 w. (redFrom) | 0.9466 (0.8522–0.9578) | 1.29% (0–3.45%) | 97.1% (95.4–98.7%) |
| desklib | <120 w. (shortRedFrom) | 0.9758 (0.9583–0.9843) | 1.45% (0–5.87%) | 78.1% (64.1–87.5%) |

For comparison the **current** values, measured on the same test halves (confidence interval of
today's numbers on this suite):

| Backend | Bucket | Current value | FA on test halves (median, 5th–95th perc.) | AI detected (median, 5th–95th perc.) |
|---|---|---|---|---|
| TMR | ≥120 w. (redFrom) | 0.98 | 6.03% (4.72–7.76%) | 84.5% (81.6–87.0%) |
| TMR | <120 w. | (always "unclear") | – | – |
| desklib | ≥120 w. (redFrom) | 0.87 | 2.16% (0.86–3.02%) | 98.3% (97.5–99.6%) |
| desklib | <120 w. (shortRedFrom) | 0.98 | 1.45% (0–1.45%) | 70.3% (65.6–76.6%) |

- **TMR `redFrom` 0.98 is clearly above the 1% target** (median 6.0% false alarms on independent
  test halves, never below 4.7%) - confirms the one-off estimate above (0.985–0.987) with a narrow,
  stable cross-validated threshold (0.9835–0.9858). Price: detection falls from 84.5% to 65.3%.
- **desklib `redFrom` 0.87 is closer to the target, but on average at a good 2%**, with a noticeable range (up to
  3.0% depending on the split). The cross-validated threshold (median 0.9466) confirms the earlier recommendation
  (0.92–0.95) in order of magnitude, but has a wide range (0.85–0.96) - with ~230 human scores
  per train half the 1% percentile estimate (≈ 2nd–3rd value from the top) is inherently noisy.
  The trade remains favourable anyway: FA drops to ~1.3%, detection stays at 97.1% (hardly lower
  than today).
- **desklib `shortRedFrom` 0.98 is somewhat too strict on the broader suite**: cross-validated the
  threshold is 0.9758 (0.9583–0.9843, overlaps with 0.98), at a similar false alarm rate but clearly
  more short AI texts detected (78% instead of 70%).
- **For TMR under 120 words it is confirmed: do not introduce a `shortRedFrom`.** Even at the threshold optimised for 1%
  false alarms (0.9867) only 13% of the short AI texts are detected (range 5–23%) -
  not useful enough to replace "unclear".

### TMR on how-tos: what the eval excerpt shows - and whether the extension would see the same on real pages

Finding (unchanged since "Broader eval suite"): TMR AUROC on `howto` only 0.767, 20% of the 200
human WikiHow excerpts end up red "as displayed" - and **all** of them at ≥120 words
(176–420 words, median 397, double-checked), so the short-paragraph exception (no `shortRedFrom` for TMR) never
applies here.

What does the eval excerpt structurally measure? `build_eval_suite.py` takes up to 400 words from the
start of the document, **in one piece**: line breaks/paragraph boundaries are merged into a single
running text before cutting (`" ".join(text.split())`) - in the source dataset the WikiHow step,
heading and list boundaries are already lost. The excerpt is therefore a single long,
continuous paragraph.

How would the extension see the same text? Relevant places in `content.js`:
- `CANDIDATE_SELECTOR = "article, p, li"` - individual list items (`<li>`, as usual for WikiHow steps)
  are candidates of their own.
- The 40-word minimum filter (`MIN_WORDS`) acts **before** grouping, per candidate individually
  (`collectCandidates`): a single step under 40 words never becomes a candidate and is never
  scored - not even grouped.
- `groupCandidates` only merges adjacent candidates **under `reliableWords` (120 words)**,
  and only if they have the same parent node and **no** heading/list/table
  (`GROUP_BREAK_SELECTOR = "h1..h6, ul, ol, table, hr"`) lies in between.

From this, two opposing effects that the pure raw-text eval does not capture:
1. **Mitigating:** Short steps, individually under 40 words (terse WikiHow style: "Do X. Reason:
   Y.") are never scanned individually or grouped - they do not show up in the extension as a candidate at all.
   The eval excerpt (up to 400 words in one piece) however includes exactly such steps, because it
   merges everything - so it also tests text that the extension never really sees.
2. **Not mitigating:** If individual steps are themselves already 40–119 words long (also common,
   especially for explanatory how-tos) and sit as `<li>` in the same `<ol>` without an intermediate heading,
   `groupCandidates` groups them into a continuous text up to `maxChars` (2000 characters for
   TMR) - structurally close to what the eval excerpt measures. If WikiHow guides instead separate their steps
   with "Method"/"Part" intermediate headings (common for how-tos with several
   approaches), the grouping breaks at every heading - the step groups stay smaller,
   rather under 120 words and thus "unclear" instead of red.

Fetching a real WikiHow page as a cross-check was not possible in this environment (wikihow.com
is blocked by the available fetch tool); the assessment rests on the traced
`content.js` code plus the known WikiHow layout pattern (steps mostly as list items, often with
"Method"/"Part" headings for several approaches), not on a rendered page.

**Recommendation: change nothing about a blanket threshold, do not introduce a domain heuristic.**
Reasoning:
- A general raise of `redFrom` to ~0.985 (see cross-validation) would push TMR detection
  everywhere from ~85% to ~65%, just to solve a problem that on real pages is already partly cushioned by
  grouping/the 40-word filter.
- A WikiHow-specific threshold would need reliable domain detection, which does not exist in `content.js`
  (and which would be easy to get wrong).
- The actual exposure on real how-to pages cannot be quantified seriously with a pure raw-text eval
  - that would need a test of `content.js`/`groupCandidates` against rendered
  WikiHow pages (proposal for TODO.md, see below).
- The existing assessment ("TMR for background scanning, but with caution on how-tos/
  news; desklib as the more accurate default model") thus remains correct - desklib shows on `howto`
  with 2.0% FA "as displayed" a much smaller problem anyway (AUROC 0.975 instead of 0.767).

### Recommendation for `extension/models.js`

| Value | Current | Cross-validated proposal | Change? |
|---|---|---|---|
| desklib `redFrom` | 0.87 | ~0.93–0.95 (median 0.9466, range 0.85–0.96) | **Yes** - lowers FA from ~2.2% to ~1.3%, detection stays at ~97% |
| desklib `shortRedFrom` | 0.98 | ~0.97–0.98 (median 0.9758, overlaps with 0.98) | Optional, small effect - detection 78% instead of 70% at a similar FA |
| TMR `redFrom` | 0.98 | 0.985 (0.9835–0.9858, very narrow) | **Only with reservations** - lowers FA from ~6% to ~1.3%, but costs ~19 points of detection (84.5% → 65.3%); alternative: leave the value, knowingly accept the weakness (howto/news), because desklib is the more accurate default model anyway |
| TMR `shortRedFrom` | none | do not introduce | **No** - even at the optimum only ~13% detection |

A final decision is made by the orchestrator after review (scope of this WP: no extension files
changed).

### Limitations

- Cross-validated thresholds for the "long" buckets rely on ~230–470 human scores per
  train half, for "short" on ~65–70 - the 1% percentile estimate is naturally noisy with so few cases
  (visible in the range, especially desklib long: 0.85–0.96). The ranges are to be taken seriously,
  not a formality.
- The WikiHow structure analysis is code reading + domain knowledge, not a measurement on real pages (fetch
  of wikihow.com blocked in this environment). It shows a plausible range, not a value.
- As in "Broader eval suite": no Claude/Gemini as a generator, M4GT licence unresolved (data stays
  local), human texts partly already editorially/algorithmically preprocessed (XSum/CNN), models
  may have seen parts of the source datasets in training.
- desklib now fully on 1200 texts (720 new + 480 from WP-01, text itself as the key when
  merging - no duplicates expected in this suite, but not checked separately).
