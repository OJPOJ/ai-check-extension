# Eval suite (broader, TODO item 3)

Broader, reproducible eval set across several domains and current AI generators (not just
the original 100 HC3 examples) - basis for thresholds, the default-model decision,
later calibration (item 5) and the BYOM reference set (item 1). Results and recommendations:
`EVAL_RESULTS.md`, section "Broader eval suite".

```
# 1. Build the suite (downloads ~820 MB from Hugging Face once, then the HF cache; output gitignored)
.venv/Scripts/python.exe build_eval_suite.py --out data/eval_suite.jsonl --seed 42

# 2. Score: TMR always on the full suite, desklib only on a sample (slow, ~2.3 s/text on CPU)
.venv/Scripts/python.exe evaluate_suite.py --backend both --desklib-n 480 --suite data/eval_suite.jsonl
```

`build_eval_suite.py` pulls human and AI texts from `Jinyan1/COLING_2025_MGT_en` (aggregates MAGE,
M4GT-Bench and HC3) across six domains (news, wikipedia, forum, sci_abstract, reviews, howto) and,
where available per domain, seven current generators (gpt4, gpt4o, gpt-3.5-turbo, llama3-70b,
mixtral-8x7b, gemma2-9b-it, cohere) plus human. `evaluate_suite.py` prints AUROC/false alarm rate
overall, per domain, per generator and per length bucket, and suggests thresholds for ~1% false alarms;
raw scores end up in `data/eval_scores_<backend>_suite.jsonl` (gitignored).

# Fine-tuning (phase D - paused, dataset is ready)

**Status 2026-09-23: deferred.** The extension currently uses two already fully
trained backends (TMR "low", desklib "medium" - see `EVAL_RESULTS.md` and
`../extension/options.html`) that deliver usable results without any training of our own.
Laya fine-tuning remains prepared anyway: dataset ready, instructions below up to date.
**As soon as a fine-tuned Laya checkpoint exists, run it against `eval_sample.jsonl` again
and compare with TMR/desklib** (`evaluate_backends.py --backend laya`,
then adjust `model` in `server/shim_server.py`'s `LAYA_MODELS` or the checkpoint name).

Original goal: specialise the zero-shot baseline checkpoint (`laya-english`) on a
human-vs-AI text classification task, because according to its own docs Laya is close to
chance level zero-shot - confirmed by our own test:
AUROC 0.549 on 100 balanced examples, see `EVAL_RESULTS.md`.

## Status: `prepare_dataset.py` ✅ written, tested, verified with real data

```
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements.txt
.venv/Scripts/python.exe prepare_dataset.py --out-dir data
```

Result of the last run (2026-09-23): **142,868 examples** (89,878 human, 52,990 AI,
filter `MIN_WORDS=40`) → **128,581 train / 14,287 holdout** in `data/train.jsonl` and
`data/holdout.jsonl`. Schema per line (verified against what the Kaggle notebook
expects according to its own docs — `json.loads(row["state"])` etc.):

```json
{"state": "{\"candidates\": [{\"text\": \"...\"}]}",
 "questions": "{\"ai_generated\": {\"type\": \"noul\", \"instructions\": \"...\"}}",
 "gold": "{\"ai_generated\": {\"probabilities\": {\"true\": 0.95, \"false\": 0.05}}}"}
```

Soft labels (0.95/0.05 instead of hard 1.0/0.0), matching the notebook's RLCD/proper-scoring-rule
training.

### Known limitations of the dataset (please note before training)

- **Class imbalance** ~63% human / 37% AI (HC3 often has several
  human_answers per question, but only one chatgpt_answer). If needed, weight during training or
  downsample to balance.
- **Tokenisation artefacts in the `reddit_eli5` part**: human answers there have
  spaces before punctuation (`" . "`, `"1 )"`), an artefact of the original ELI5
  source. Risk: the model learns "space before period = human" as a shortcut
  instead of real style features — that would not work on real web pages (without this artefact).
  Not fixed, because a normalisation could itself distort the style signal — cross-check before the real training (e.g. break down the share of
  training errors by domain).
- **HC3 only, no RAID.** RAID (https://huggingface.co/datasets/liamdugan/raid, >8 million
  rows, adversarial paraphrases) should improve robustness against
  reworded AI text in the future, but is deliberately not implemented here: the
  exact field for "this is the human source text" was only read from the dataset
  card, not verified on real rows (see `../RESOURCES.md`,
  "Open questions"). Before building it in: `load_dataset("liamdugan/raid", split="train", streaming=True)`
  and look at a few rows manually.

## Open step: the actual training on Kaggle

I cannot run this from here — it needs a Kaggle account, a
browser session and running GPU quotas, all outside this environment.
The load cell is now **verified word for word** (via raw fetch of the
`.ipynb` JSON source, not just summarised), as of 2026-09-23:

**Important finding, just verified:** The reference cell loads
`LocalLLaMA/typed-decisions` and processes **only 1,200 cases** there (not ~30k, as
previously stated here without verification). Our dataset with 128,581 rows is therefore ~100×
larger than anything this notebook has ever seen — be sure to limit it for the first run (item 3 below), otherwise the Kaggle time limit (9–12h/session)
will very likely be blown.

1. Upload notebook `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb` from
   https://github.com/NandhaKishorM/laya to Kaggle (or fork it as a Kaggle
   notebook, if it is already published there).
2. Upload `data/train.jsonl` + `data/holdout.jsonl` as a **private Kaggle dataset**
   (kaggle.com → "New Dataset" → drag in both files). The path is then available as
   `/kaggle/input/<your-dataset-slug>/train.jsonl` etc. — no HF token
   needed for this step.
3. In the 3rd code cell of the notebook (verified original content, loads tokenizer/
   config from `convaiinnovations/laya` and then `ds_train`) replace **only this one line**:

   ```python
   # Original:
   ds_train = load_dataset("LocalLLaMA/typed-decisions", "all", split="train")

   # Replacement — adjust the slug, the rest of the cell (build_training_item, tokenizer, ...) stays unchanged:
   ds = load_dataset(
       "json",
       data_files={
           "train": "/kaggle/input/<your-dataset-slug>/train.jsonl",
           "test": "/kaggle/input/<your-dataset-slug>/holdout.jsonl",
       },
   )
   ds_train = ds["train"].shuffle(seed=42).select(range(20000))  # first run limited, see above
   ```

   The schema fits the rest of the cell 1:1 (`json.loads(row["state"])`,
   `row["questions"]`, `row["gold"]` — exactly verified, no further adjustment to
   `build_training_item` needed, because our `noul` questions without a `criteria` field fall exactly
   into the `crit = q.get("criteria", {})` default).
4. Enable the 2× T4 GPU runtime, run the remaining cells (write the DDP training script,
   `torchrun --standalone --nproc_per_node=2 train_ddp.py`) unchanged.
   If the first 20k run goes through cleanly and within the time frame: increase gradually
   (e.g. 50k, then the rest) instead of going straight to the full 128k.
5. **Do not take over the later evaluation/upload cells in the notebook 1:1** (test set evaluation, push to
   `convaiinnovations/laya-typed-decisions`) — switch `NEW_REPO`
   there to your own HF repo, otherwise the checkpoint ends up in someone else's
   account. For the actual scoring our own pipeline is enough anyway
   (point below), it is already finished against `holdout.jsonl`/`eval_sample.jsonl`.
6. Push the checkpoint to your own Hugging Face repo (notebook cell 8, set `NEW_REPO`
   accordingly).

## Afterwards (phase E, see plan)

- Integrate the checkpoint into `laya-serve` (extend `LAYA_MODELS`, see
  `../server/README.md`), switch the extension option "Model" to the new name.
- Compare accuracy on `holdout.jsonl` against the zero-shot baseline
  (baseline: effectively no separation, see above).
- Reset the threshold in `extension/options.html` based on the real calibration.

## Feedback as a data source – and why generated data matters more

As of 2026-09-25. On request, the extension collects feedback locally ("Do you know where the text
comes from?", see `../DEVELOPMENT.md`). `import_feedback.py` turns the JSONL export into an eval set and
rows in the Laya schema (soft labels depending on the basis).

**Humans are poor judges of AI text – but good witnesses to the origin.** Studies
(summarised from memory, check the original before citing): laypeople are close to chance
at telling human text from LLM text (Clark et al. 2021, GPT-3: ~50%, hardly better with training;
Jakesch et al. 2023, PNAS: heuristics like "fluent = AI", "first person = human" are misleading).
Expert reviewers recognised ChatGPT abstracts only ~68% of the time and took ~14% of the real ones to be
generated (Gao et al. 2023). Exception: people who themselves write a lot with LLMs are, as a group,
very accurate (Russell et al. 2025) – but individually not error-free either. Conclusions:

- A judgement by style ("sounds like AI") is worthless as a label and partly harmful: it
  confirms exactly the prejudices (smooth, formal text = AI) that already cause the models' false alarms.
  That is why the extension asks for the *basis*, and `guess` stays out by default.
- Feedback is valuable when the origin is *known*: own text, known author, text from
  before 2023, labelled AI text. These are almost always **false alarms on human text** from
  exactly the domains the person browses – a generated dataset cannot provide that.
- Individual people deliver few, one-sided examples. So use it mainly as an **eval set** and for
  **calibration** (roadmap 3); in training only as a small, heavily weighted addition.

**Main source for training: paired, self-generated data from several LLMs**

1. Human texts with a secure origin: states from *before* the end of 2022 (Wikipedia dumps 2021,
   news archives, forum dumps, reviews), German and English, mixed by domain
   (news, blog, forum, docs, review, science).
2. For each text one or more AI counterparts on the *same topic* (otherwise the model learns the topic instead of
   the style): "write a paragraph about …", "continue", "reword", "write more human".
   Several current model families (Claude, GPT, Gemini, Llama, Mistral, Qwen …), different
   temperatures, lengths as in the browser (40 words to 2000 characters).
3. Add existing datasets: HC3 (ready), RAID (paraphrases, attacks), M4/M4GT,
   MAGE – older generators, but good against overfitting to individual models.
4. Evaluation **leave-one-generator-out**: hold one model family out entirely in the test. Only that way
   can you see whether the model also detects AI text that comes from a new LLM.
5. Repeat as soon as new LLM generations appear (version the dataset, bump `version` in
   `extension/config.js`).

Rough costs: 20,000 pairs × ~150 output tokens over 6 models is ~3 million output tokens –
via API in the low double-digit dollar range depending on the model, free locally with open models.
Legal: check the providers' terms of use (some forbid using outputs to train
competing models – a detector is not that, but read them anyway), licenses of the
human sources (CC-BY-SA → attribution/redistribution), for web texts § 44b UrhG (German copyright act; text and
data mining allowed, except with a machine-readable reservation of rights; delete copies when no longer
needed).
