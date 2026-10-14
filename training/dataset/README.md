# Dataset for our own model (issue #46)

From the original sources to the cleaned, split dataset. Concept and licence rules: [`../MODEL_CONCEPT.md`](../MODEL_CONCEPT.md). All commands run from `training/`.

| File | What |
|---|---|
| `sources.json` | the sources: origin, pinned revision, licence, what is used |
| `fetch_sources.py` | public datasets into the common row format |
| `collect_human.py`, `collected/` | our own collection of human texts and the ids it consists of |
| `dataset.json` | parameters of the dataset and the checksums it has to reproduce |
| `build_dataset.py`, `test_ids.txt` | cleaning, duplicates, split; the frozen test part |
| `check_shortcuts.py` | what gives the label away without reading |
| `generate.py`, `generation.json`, `generate_notebook.ipynb` | AI counterparts for the collected human texts (work package 10) |

## Training sources

Concept, licence rules and decisions: `MODEL_CONCEPT.md`. Every source is kept separately and can
be traced back:

- `sources.json` (in git) is the manifest: per source the original repository, pinned revision,
  file checksums and licence; per sub-source the domain, the human source, its terms and where
  they were read, whether it is used (`use`) and whether its texts may be passed on
  (`redistribute`). `assumed_cc` marks sub-sources without any licence statement, which we treat as
  Creative Commons (decision of 2026-10-11).
- `fetch_sources.py` executes the manifest. The original files stay in the Hugging Face cache
  (RAID's `train.csv` alone is 11.8 GB) and are verified by SHA-256.
- `data/sources/<source>/rows.jsonl` (gitignored) holds the rows in one common format, texts
  unchanged; `receipt.json` next to it holds counts and the SHA-256 of `rows.jsonl`.
- `expected` in `sources.json` pins the row count and that SHA-256 per source. A run that gives
  something else fails, so a fresh checkout either reproduces the same rows or says so. After a
  deliberate change of the manifest or a parser, copy the new values from the error message.

```
.venv/Scripts/python.exe dataset/fetch_sources.py              # all sources (first run downloads ~12.4 GB)
.venv/Scripts/python.exe dataset/fetch_sources.py hc3 mage     # only these
.venv/Scripts/python.exe dataset/fetch_sources.py --report     # counts from the receipts
.venv/Scripts/python.exe -m unittest discover -s tests # row format and exclusions
```

One row:

```json
{"id": "raid:<uuid>", "source": "raid", "sub_source": "news", "domain": "news", "label": 1,
 "generator": "gpt-4", "group": "raid:<uuid of the human document>", "text": "...",
 "meta": {"attack": "none", "decoding": "greedy", "repetition_penalty": "no", "generator_raw": "gpt4"}}
```

`label` 1 is AI (MAGE's files have it the other way round; the script converts and checks it).
`group` ties together what must stay on one side of the train/test split: all answers to one HC3
question, all RAID generations for one human document, a MAGE continuation and the human text it
continues. A sub-source that is not listed in `sources.json` stops the script.

State of 2026-10-11, after checking generators and terms at the original sources:

| Source | Rows | Human | AI | Sub-sources | Generators | Left out |
|---|---|---|---|---|---|---|
| HC3 | 69,680 | 52,178 | 17,502 | 2 | 1 | `medicine`, `finance`, `open_qa` (not downloaded) |
| MAGE | 288,205 | 93,348 | 194,857 | 10 | 28 | `yelp`, `hswag`, `dialogsum`, `xsum` (147,639 rows) |
| RAID | 343,665 | 9,819 | 333,846 | 6 | 11 | `news`, `recipes` (124,320 rows), the 11 adversarial attacks, `test.csv`, `extra.csv` |

Left out because the source's own terms are non-commercial: MAGE `yelp` and `dialogsum`
(CC BY-NC-SA), MAGE `hswag` (wikiHow text; the HellaSwag repository was taken down on GitHub in
September 2026 after a notice by wikiHow), RAID `news` (BBC set "for non-commercial and research
purposes only") and RAID `recipes` (RecipeNLG agreement). MAGE `xsum` states no terms of its own
but consists of BBC articles and is left out like RAID `news`. Without a licence statement and
therefore treated as Creative Commons: HC3 `reddit_eli5`, MAGE `cmv`, `eli5`, `wp`, `roct`,
`sci_gen`, `tldr`, `imdb` and RAID `reviews`. MAGE `cnn` is used on the basis of the Apache-2.0
licence on its dataset card, although the articles are publisher copyright. HC3 `medicine` and
`finance` stay out.

To know before aggregating (details in the `notes` of `sources.json`):

- **RAID is 34:1 AI to human** (every human document has 34 generations) and has only
  9,819 human texts. The aggregation has to balance this.
- **MAGE continuations start with human text:** the model was given the first 30 words of the
  human text, and the row contains them. Short excerpts must not be cut from the start of these rows.
- **MAGE has no document ids:** the group is a hash of the first 12 words. That links 96% of the
  continuations to their human text; `topical` and `specified` generations cannot be linked. In
  the two out-of-domain files a paraphrase cannot be matched to its original, so each sub-source
  there is one group as a whole.
- **Groups do not reach across sources:** the same human texts may be in two datasets (ELI5 in
  HC3 and MAGE, IMDb reviews in MAGE and RAID). Whether they overlap is not measured yet; the
  aggregation has to find such duplicates and merge their groups.
- **HC3 `reddit_eli5`:** human answers have spaces before punctuation (see below).
- **Generator names** are normalised per source (`generators` in `sources.json`, original name in
  `meta.generator_raw`) and were checked against the papers. `text-davinci-002` is the same
  model in MAGE and RAID. `gpt-3.5-turbo` and `gpt-4` are the same family only: RAID used the
  `-0613` versions, MAGE names no version. HC3's ChatGPT has no stated version either and is kept
  apart as `chatgpt-2022`.

## Human texts we collect ourselves (issue #49)

Texts with a state from before 2022 that can be checked at the source, from openly licensed
sources only. They are listed under `collected` in `sources.json`:

| Source | What is taken | Proof of the state | Licence |
|---|---|---|---|
| `wikimedia` | Wikipedia, Wikinews (news), Wikibooks (how-to, textbooks), Wikivoyage (travel): random pages as they were on 2021-12-31 | revision id and its timestamp | CC BY-SA 4.0, Wikinews CC BY 4.0 |
| `stackexchange` | answers from 25 sites with prose, score 3 or more, created before 2022 and not edited since | creation and last edit date from the API | CC BY-SA, version per answer |
| `arxiv` | abstracts whose latest version is from before 2022 | versioned arXiv id and its date | CC0 1.0 (metadata) |

```
.venv/Scripts/python.exe dataset/collect_human.py discover wikimedia --sub wikinews --n 500   # sample new items
.venv/Scripts/python.exe dataset/collect_human.py fetch                                       # rows from the stored ids
```

`discover` asks the live APIs and appends to `dataset/collected/<source>.jsonl`: per item its id, the date
of its state and a hash of its text, no text. These files are in git and are the pin of the collection:
ids, dates and hashes are facts about the texts, not the texts, so no licence stands in the way.
Another checkout fetches the same items again with `fetch --refetch`. `fetch` builds `data/sources/<source>/rows.jsonl` from exactly these ids, in the same
row format as above (`label` 0, `generator` "human"); texts come from the local cache
(`cache.jsonl`, gitignored) or are fetched again. An item whose text no longer matches its hash
or that disappeared is left out and listed as `changed` or `gone`, so a second run either gives
the same rows or names the difference.

Per text `meta` keeps what a redistribution needs: `url` (for wiki pages the revision with its
history of authors), `date`, `licence`, and for answers the `author`.

What the text is: the `<p>` paragraphs of 15 words or more, outside tables, lists, quotes, code
and boxes, joined by blank lines, at most 2000 words per page. Stack Exchange answers with a code
block are skipped.

State of the first collection (2026-10-11), 23,914 texts:

| Source | Texts | Sub-sources |
|---|---|---|
| `wikimedia` | 6,024 | Wikinews 2,062 (news), Wikipedia 1,962, Wikibooks 1,000 (how-to), Wikivoyage 1,000 (travel) |
| `stackexchange` | 9,890 | 25 sites, about 400 each (qa) |
| `arxiv` | 8,000 | computer science, physics, mathematics and statistics, biology and economics, 2,000 each |

A sample of stored ids fetched again from the network gave the same texts (13 wiki pages, 100
answers, 50 abstracts).

Limits to know:

- Some Wikinews articles start with their dateline ("Tuesday, May 23, 2006 ...") in the first
  paragraph. Texts are stored as fetched; remove it when building the training file.
- A wiki revision is rendered by today's software. The prose is what was written then; a template
  that writes into a paragraph could change it later (reported as `changed`).
- The Stack Exchange API returns the current text. "Not edited since" rests on its edit date; an
  answer edited later drops out at the next fetch from the network.
- Stack Exchange allows 300 requests per day without a key, arXiv one request every three seconds.
- Project Gutenberg is not included yet: the catalogue service did not answer on 2026-10-11.

## The dataset: cleaned, without duplicates, split (issue #50)

`build_dataset.py` turns the source rows into the one dataset the model is trained and tested
on. Its parameters are in `dataset.json`; the source rows are read and never changed.

```
.venv/Scripts/python.exe dataset/build_dataset.py            # about 5 minutes; fails if the result differs from "expected"
.venv/Scripts/python.exe dataset/build_dataset.py --accept   # after an intended change: pin the new result
.venv/Scripts/python.exe dataset/build_dataset.py --report   # print the last report
.venv/Scripts/python.exe dataset/check_shortcuts.py          # what surface features still give away
```

Output (gitignored): `data/dataset/v1/{train,validation,test}.jsonl`, `test_ids.txt`,
`report.json`. A row has the fields of a source row plus `split`, `view`, `excerpt` (character
offsets into `text`: the paragraph-length piece to score) and `changes` (the cleaning steps that
changed this text). `group` is the group after merging; the original one is in
`meta.source_group`.

**Rules.** No cleaning step looks at the label, and every step is counted per source and class
in the report. What changes a text happens here, in one place.

**Cleaning.** In this order:

| Step | What | Rows changed |
|---|---|---|
| `moderator_footnote` | r/changemyview adds "Hello, users of CMV! This is a footnote from your moderators ..." to posts; it ended a third of the human `cmv` texts of MAGE | 3,149 |
| `chatgpt_page` | HC3 copied some answers together with the page around them ("ChatGPT Dec 15 Version. Free Research Preview ...", "Regenerate response") | 0 in v1 (the rows are in `reddit_eli5`, which is left out) |
| `prompt_echo` | models without a chat format repeat RAID's prompt ("The following is the full text of the abstract for a research paper titled ..."); the text is cut there | 498 |
| `dateline` | Wikinews: "Tuesday, May 23, 2006" before the first sentence | 63 |
| `shared_opening` | a MAGE continuation starts with the first 30 words of its human text; they are cut, and the text starts at the model's first whole sentence | 117,478 |
| `normalise()` | NFC, HTML tags and entities, Markdown markers, invisible characters, typographic quotes to straight ones, any whitespace to single spaces, tokeniser spacing ("do n't", "word ,") | 204,098 (whitespace) |
| `incomplete_end` | a last sentence without an end (generations stop at a token limit) is cut | 54,550 |

`normalise()` makes one paragraph of plain text out of every text. Line breaks, quote style and
markup differ by dataset far more than by writer: in RAID 65% of the AI forum texts had line
breaks and none of the human ones. **The extension has to apply the same function before
scoring** (work package 9), otherwise the model sees a form it was not trained on. Applying it
twice changes nothing (tested).

`shared_opening` only exists on the AI side, so the other side was checked: the cut removes the
start of the document from every continuation, while human texts keep theirs. What the model
sees is the excerpt, and that starts at the first word of the text in 51% of the human MAGE
rows and in 47% of the continuations (46% and 63% for the two other prompt types), so "starts
at the beginning" does not separate the classes.

**Rows left out.** Of 725,464 source rows 317,160 are in the dataset:

| Reason | Rows | |
|---|---|---|
| `surplus_generation` | 255,294 | RAID has 34 generations per human document; 4 are kept, from different generators (`max_ai_per_group`). The held-out generators are kept whole |
| `configured` | 67,996 | HC3 `reddit_eli5`, both sides: 88% of the human answers are tokenised through and through ("do n't", "( word )", "URL_0") and cannot be repaired reliably, and the ChatGPT answers alone would be 16,660 forum texts of one class. Human ELI5 answers without the artefact come from MAGE |
| `no_sentence_after_opening` | 39,242 | MAGE continuations in which the model wrote less than one sentence of its own (mostly the Flan-T5 models) |
| `held_out_generator_outside_test` | 31,511 | see "Split" |
| `short` | 9,487 | fewer than 15 words after cleaning |
| `label_conflict` | 2,680 | the same text with both labels (a model repeating its source) |
| `duplicate` | 892 | one text of each set of duplicates stays |
| `tokenised` | 718 | tokenised text in the other sources, same rule for every source and class |
| `related_to_other_split` | 300 | see "Duplicates" |
| `in_eval_suite` | 184 | texts of the 1200-text suite |

**Duplicates.** Two texts are compared by all their 5-word sequences, relative to the shorter
text, so an excerpt counts as a duplicate of its document. A sequence that occurs in more than
20 texts is a stock phrase and does not count.

- From 0.7 on they are duplicates: one stays (the source listed first in `dataset.json`) and
  their groups become one.
- From 0.3 on they are related: both stay in their groups, but if the split puts them on
  different sides, the one further from test is dropped. Merging groups at this level chained
  unrelated texts through stock phrases into groups of up to 1,578 rows; now the largest group
  outside the testbeds has 254 rows, and 8,560 rows are in groups of more than 40.
- Of the 1,200 suite texts 158 were found in the sources (the suite also draws on datasets we
  do not use, and on the HC3 answers left out above); every row related to one of them is
  removed.

**Split.** By group: 256,119 train, 14,767 validation, 46,274 test rows. Every source group is
drawn by its own hash (10% of the hash range test, 5% validation), not by its rank among the
groups, so a group keeps its side when data is added. A merged group takes the side closest
to test of any of its parts. No group is on two sides; the build fails otherwise. The test
part has four views (`view`):

| View | Rows (human / AI) | |
|---|---|---|
| `main` | 12,607 / 19,066 | same sources, domains and generators as training |
| `held_out_domain` | 1,134 / 8,123 | reviews (RAID `reviews`, MAGE `imdb`): no review is in training. 3,764 of the AI rows are from the held-out generators |
| `held_out_generator` | 0 / 3,788 | Cohere `command` and `command-chat` outside the reviews: in test only, their rows elsewhere are dropped. The human texts to compare with are those of `main` |
| `testbed` | 356 / 1,200 | MAGE's out-of-domain files (GPT-4 and paraphrases), grouped by sub-source |

**Frozen.** Three things in git pin the dataset:

- `expected` in `dataset.json`: row counts and SHA-256 of the three files and of the list of
  test ids, together with the SHA-256 of every input (`rows.jsonl` is hashed itself). A run
  that gives something else fails and leaves the existing files untouched (it is built next
  to them as `v1.new`).
- `test_ids.txt`: the ids of the test part. A later version may add rows to it and may lose
  rows that a new rule drops, but a row listed there must never be in train or validation;
  the build checks that.
- `collected/*.jsonl`: the ids of the collected human texts (2,421 of the test rows come from
  them), so the test part can be rebuilt on another machine.

A second run, and a run after moving the scripts, gave the same files.

**Excerpts.** Every row has one excerpt of whole sentences, as long as a paragraph in the
browser: 15 to 39 words (30% of the draws), 40 to 119 (40%) or 120 to 330 (30%), at most 2,000
characters, drawn the same way for both classes. Achieved: human 33 / 48 / 19%, AI 35 / 45 / 20%.
The test part is scored on these excerpts; training may draw new ones from `text` with
`excerpt()`.

**What surface features still give away** (`check_shortcuts.py`). A classifier that sees no
words, only length, whitespace, kinds of characters and how a text starts and ends (AUROC,
0.5 = no hint). Both columns are excerpts drawn the same way, once from the unchanged source
text and once from the cleaned one, so the difference is the cleaning.

1. Human or AI, within one source and domain:

| | Raw excerpt | Cleaned excerpt |
|---|---|---|
| RAID, six domains | 0.90 to 1.00 | 0.72 to 0.86 |
| MAGE, five domains | 0.69 to 0.82 | 0.71 to 0.84 |
| HC3 `wiki_csai` | 0.94 | 0.83 |

Cleaning removes most of what gave RAID away. On MAGE it changes little and the value rises by
about 0.02: MAGE was normalised by its authors already, and without the 30 human words at its
start a continuation is easier to recognise. What is left are rates of commas, capitals,
digits and word length, none of which carries more than 0.70 alone. These are closer to style
than to formatting, but the values are far from 0.5: a detector can reach 0.7 to 0.86 on this
data without reading. RAID `forum` and `poetry` are highest.

2. Which source, within one domain and class:

| Domain and class | Sources | Raw excerpt | Cleaned excerpt |
|---|---|---|---|
| forum, human | MAGE or RAID | 0.95 | 0.92 |
| news, human | MAGE or Wikinews | 0.97 | 0.91 |
| wikipedia, human | four sources, each against the others | 0.86 to 0.90 | 0.71 to 0.82 |
| sci_abstract, human | arXiv, MAGE, RAID | 0.82 to 1.00 | 0.62 to 0.70 |
| AI rows, four domains | MAGE, RAID, HC3 | 0.85 to 0.93 | 0.76 to 0.87 |

Sources stay recognisable after cleaning, partly because they differ in subject (the forum
texts of MAGE are arguments and explanations, those of RAID are posts). This matters where a
source has one class only: 23,719 rows come from the collected human texts, and Stack Exchange,
Wikibooks and Wikivoyage are whole domains without any AI text. There "this source" is a way
to the label "human". Only AI texts for these sources close that (work package 10); until
then results on them say little about detection.

3. Word sequences of one class found the moderator footnote and the prompt echo. What the
list shows now are stock phrases of models ("Once upon a time there") and about 300 texts of
`bloom-7b1` that count upwards ("[28] [29] [30] ..."), which are left in as model behaviour.

Open, to know before training:

- **RAID's attack variants** are not included (`attacks: ["none"]` in `sources.json`): most of
  them change characters or whitespace, which `normalise()` would partly undo.
- **Class ratio** is 1.5 AI to 1 human overall and differs by source (RAID 4 to 1 in train,
  MAGE 1.6 to 1); weighting is left to training.
- **Sentence ends** are found by a simple rule (punctuation followed by a capital), so
  abbreviations can end an excerpt early, in both classes alike.
- **Duplicates of at least 0.7** still merge groups transitively; that is where the groups of
  more than 40 rows come from (short, near-identical generations).

## AI texts for the collected sources (issue #46, work package 10)

Stack Exchange, Wikimedia and arXiv have human texts only in `v1`. `generate.py` gives every one
of these texts (23,914) one AI counterpart on its topic, from one generator of `generation.json`:

| Task | Share | Prompt |
|---|---|---|
| write | 0.5 | a text on the title of the human one (the question for Stack Exchange, fetched with `titles`) |
| continue | 0.25 | the first sentences of the human text are given; only the continuation is kept |
| rewrite | 0.25 | the human text in other words; a rewrite that stays too close is removed as a duplicate, the human text stays |

Target length is that of the human text (60 to 350 words); system prompt (none, "helpful
assistant", "write like a person") and temperature (0.7 or 1.0) are drawn per text. All of it
is drawn from a hash of the human text's id, so a prompt does not change when texts are added.
The AI text gets the group of its human text and therefore its side of the split.

Generators: open models in 4 bit on a Colab T4 (`generate_notebook.ipynb`: Qwen2.5-7B,
Llama-3.1-8B, Mistral-7B-v0.3) and cheap API models run locally (`claude-haiku-5-5`, GPT and
Gemini, keys in `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`). Phi-3.5-mini is held
out: it only writes for groups of the test part. Names and prices change; check them in
`generation.json` before a run.

```
.venv/Scripts/python.exe dataset/generate.py titles                       # Stack Exchange question titles
.venv/Scripts/python.exe dataset/generate.py prompts                      # data/generation/prompts.jsonl
.venv/Scripts/python.exe dataset/generate.py run claude-haiku-5-5 --limit 20   # look at a few, then without --limit
.venv/Scripts/python.exe dataset/generate.py ingest                       # data/sources/generated/rows.jsonl
```

`ingest` removes what an assistant puts around a text ("Sure! Here is ...", a title line,
"Let me know if ..."), and drops refusals, texts cut off by the length limit and texts below 40
words. For the dataset `v2`, `dataset.json` then gets `generated` as the last source (a human
text wins over its duplicate), `phi-3.5-mini-instruct` under `held_out.generators`, and the
version `v2`; the test part of `v1` stays test.
