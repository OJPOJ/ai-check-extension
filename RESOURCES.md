# Resources: Jev / Laya / AI-Content-Marker extension

Status: 2026-09-23. Research sources, no details guaranteed to be stable (everything is very new, as of Sept. 2026).

## Background

- **Jev** (TypeSafe AI, founder Diogo Almeida, formerly OpenAI/RLHF): proprietary "System-1" decision model.
  Not a token-by-token generator, but a single forward pass over `state + questions` -> `choice` / `score` / `noul` (calibrated probability).
  - TechCrunch article: https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/
  - Overview/benchmarks: https://www.largitdata.com/en/blog/jev-system-one-model-open-source-benchmark/
  - Community: https://www.jevai.org/ , awesome lists: https://github.com/AnotiaWang/awesome-jev , https://github.com/kraayenjon/awesome-jev

- **Laya** (ConvAI Innovations): open-source counterpart to Jev, Apache-2.0.
  - Repo: https://github.com/NandhaKishorM/laya
  - Hugging Face: https://huggingface.co/convaiinnovations/laya
  - Checkpoints: `laya` (ModernBERT-large, 421M, EN, 512 ctx), `laya-multilingual` (mmBERT-base, 322M, 100+ languages, 1024 ctx), `laya-typed-decisions` (fine-tuned example checkpoint, 0.766 acc. vs. 0.36 zero-shot)
  - Installation: `pip install laya`
  - **Important:** According to its own docs, the zero-shot accuracy of the base checkpoints is close to chance level. Recommendation of the maintainers: "treat Laya as a fast base to specialise, not as a zero-shot decision engine."
  - Fine-tuning: Kaggle notebook `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`, runs on free 2x T4 GPUs, RLCD/GRPO-style training, ~4-5h for ~30k questions/4 epochs. Docs: `docs/finetune_browser_agent.md` (example walkthrough for specialisation).

- **laya-serve**: local HTTP server, imitates Jev's wire format (`POST /v1/systemone`, `GET /v1/models`, `GET /healthz`).
  - Repos (several implementations): https://github.com/stiermid/laya-serve , https://github.com/ouijan/laya-serve , https://github.com/noahbclarkson/laya-server , https://github.com/exfly/laya-jev-compatible-server
  - Install: `pip install "laya-serve[inference]"`
  - Env vars: `LAYA_SERVE_BACKEND=laya`, `LAYA_SERVE_PRELOAD=true`, `LAYA_SERVE_SERVING_MODEL=laya-english`, `LAYA_SERVE_EXTRA_MODELS=...`
  - Request/response format identical to the real Jev API: `{state, questions}` -> `{model, answers, usage}`.
  - Error format: `{"error": {"message", "field"}}`, Jev status codes (401, 422, 429/529 Retry-After, 500).

## Architecture reference: TypeSafe AdBlock (MIT license)

Repo: https://github.com/realZachi/typesafe-adblock — almost 1:1 transferable pattern (DOM elements -> Jev noul query -> threshold -> visual effect), so far only for ad detection instead of AI-text detection.

- Manifest V3, content script + background service worker + popup.
- The content script collects candidates (heuristics: tags/classes/text label), builds compact JSON (tag, classes, text excerpt up to 220 characters, link hosts, form/size).
- One `POST /v1/systemone` call per batch (max. 30 candidates), one `noul` question per candidate, debounced 600ms.
- Response: probability per element.
- **Modes:** "Remove" or **"Highlight-only" (debug overlay with probability display)** — the latter is almost exactly the desired basic behavior for our case (only a glow border instead of removal).
- Popup: on/off, threshold slider (0.30–0.95, default 0.70), mode selection, animation toggle, rescan button (clear cache).
- Only hostname, title, candidate fields are transmitted — no full HTML, no server-side storage.
- Design principle in the repo: "Keep the split intact: rules and thresholds in code, only the semantic judgment goes to the model."
- Local test harness: `test/harness.html` + local relay server for offline tests.

## Datasets for fine-tuning (human vs. AI text)

- **HC3** (Human ChatGPT Comparison Corpus): ~27k question/answer pairs, human vs. ChatGPT, domains: Reddit, medicine, finance, law.
- **RAID**: largest/most comprehensive benchmark dataset, >10 million documents, 11 LLMs, 11 genres, 4 decoding strategies, 12 adversarial attacks (paraphrasing etc.) — HF: https://huggingface.co/datasets/liamdugan/raid
- Paper on RAID: https://arxiv.org/html/2405.07940v1

## Sources for the blocklist (as of 2026-09-25)

There is no official API for "sensitive sites". The list is therefore generated from several sources at build
time and shipped (`npm run build:blocklist`) – not queried at runtime, otherwise the
query would reveal browsing behavior.

### Built in

| Source | Content | License | Entries | of which new* |
|---|---|---|---|---|
| [UT1 blacklists](https://dsi.ut-capitole.fr/blacklists/index_en.php) `bank` | online banking worldwide | CC BY-SA 4.0 | 6,645 | 6,579 |
| UT1 blacklists `webmail` | webmail worldwide | CC BY-SA 4.0 | 404 | 402 |
| [FDIC BankFind](https://api.fdic.gov/banks/docs/) | all active US banks (`WEBADDR`) | public domain (US federal agency) | 4,146 | 3,290 |
| [NCUA Call Report Data](https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data) | all US credit unions (`FS220D.txt`, field `Acct_891` = website) | public domain (US federal agency) | 3,834 | 2,907 |
| [Wikidata](https://query.wikidata.org/) | banks in DE/AT/CH/UK/US with an official website (P856) | CC0 1.0 | 1,314 | 871 |
| hand-picked (`CURATED`) | mail, payment services, neobanks, government portals with login | – | 87 | 41 |

\* not already covered by a previous source (or its parent domain). Result:
**14,090 domains**, 233 KB. The script prints the numbers on every run and writes them to
`generated/blocklist.js` (`sources`).

**License consequence:** Because UT1 is under CC BY-SA 4.0, the generated overall list is also under
CC BY-SA 4.0 (attribution in `THIRD_PARTY_NOTICES.md`, in the file header and in the settings). The
other sources (public domain, CC0) require nothing, but are named anyway. The extension itself
remains unaffected – ShareAlike applies only to the data.

Details per source:

- **UT1:** official tar.gz (not the [GitHub mirror](https://github.com/olbat/ut1-blacklists)),
  maintained daily. Contains many non-banks (retailers, airlines, central banks, trade media,
  `purdue.edu` …) → exclusion list `NEVER_BLOCK`, see "Maintenance". UT1 `financial` deliberately not: those
  are mostly stock-market/finance *news*.
- **NCUA:** quarterly zip (~8 MB), appears about 2 months after quarter end; the script takes the
  newest one available (tries up to five quarters back). 3,881 of 4,299 credit unions have a
  website entered.
- **Wikidata:** excludes central, development and resolution banks by class (reading text, no
  customer accounts) as well as dissolved banks (P576). Only websites without a path or with a
  pure language path (`/en/`) are taken over – entries like `stadt.de/sparkasse`, `notar.at/…`, `web.archive.org/…`
  or a bar website for a historic bank branch would otherwise block entire foreign domains.
  Mainly brings Sparkassen, Volks- and Raiffeisenbanken (DE has the most hits with 702).
- **Not taken over:** `web.de`, `gmx.net` etc. (portals with news; only their mail subdomains
  are in `CURATED`), platforms listed in FDIC/NCUA as a bank website (`facebook.com`,
  `sites.google.com`, `wixsite.com`).

### Checked, not built in

- **FCA Financial Services Register** (UK): API free, but with registration and API key
  ([Developer Portal](https://register.fca.org.uk/Developer/s/), 50 requests/10 s) – impractical for a
  build script in the repo (every maintainer would have to apply for a key themselves). Terms of use
  for redistributing the data not yet checked. UK coverage currently: UT1 (~60 `.uk`), Wikidata
  (71 banks), hand-picked large banks.
- **BaFin company database** (DE): CSV export available, but contains **no websites** (only name,
  BAK no., LEI, address) – checked on 2026-09-25. Usable only via name matching with other sources.
- **Chrome Topics API override list** (~50k top hosts with category): extractable only from the Chrome profile,
  license unclear.
- **Health insurers, insurance companies, brokers, crypto exchanges:** no clean open list found; the
  sites have a lot of reading text, login areas are caught by the password-field heuristic.
- No longer maintained: Shalla list (discontinued 2020), DMOZ/Curlie dumps.

### Maintenance

1. `npm run build:blocklist` – aborts if a source is missing or far below the minimum size
   (`MIN_COUNT`).
2. Review the diff of `extension/generated/blocklist.js`. The domains are sorted in *one*
   string, `git diff --word-diff-regex='[^\\n]+'` shows individual added/removed domains.
3. Occasionally (e.g. before a release) check for accidentally blocked content sites:
   `node scripts/build-blocklist.mjs --dump <folder>` writes the domains per source; compare with the
   [Tranco list](https://tranco-list.eu/) (top 100,000) and enter non-banks in
   `NEVER_BLOCK`. Status of the last review: 2026-09-25 (311 UT1 entries in the top
   100,000, of which ~65 excluded). Tranco itself is not shipped.

No list is complete → complemented by the heuristic on the page (password/credit card field →
do not scan automatically).

## Open questions

- Exact training data schema for Laya fine-tuning (column names etc.) not clearly documented publicly — must be checked when opening the Kaggle notebook.
- Several `laya-serve` implementations from different maintainers are in circulation — which one is currently best maintained must be checked before deciding (stars/issues/last commit).
- All information from web research (Sept. 2026), not from own code inspection — read the original READMEs/code yourself before production use.
