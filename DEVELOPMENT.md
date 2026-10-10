# AI Content Flag — Development

Technical documentation for contributors: build, tests, how it works in detail, architecture.
For installation and usage see [`README.md`](README.md).

Scores longer paragraphs of text on web pages with an AI-text classifier and marks them with a
traffic light (green / yellow / red) and AI score. By default the model runs **directly in the browser**
(WebAssembly, no server, texts do not leave the computer). Alternatives: local server
(`server/shim_server.py`), custom server/cloud or Hugging Face Inference API.

Status: **v0.5 (2026-09-25)**. Research background: `RESOURCES.md`, measurements: `training/EVAL_RESULTS.md`.

## Quick Start

```powershell
npm install        # transformers.js (for vendor) + Playwright (for tests)
npm run vendor     # transformers.js + ONNX Runtime WASM into extension/vendor/ (not in Git)
```

**Before every release** (Web Store, zip for others): `npm run build` – runs `vendor` and
`build:blocklist` (downloads the current blocklist, writes `extension/generated/blocklist.js`, needs
internet, ~30 s, including an 8 MB download from the NCUA). The generated list is checked into Git:
review the changes in the diff and commit them too; before a release additionally run the check for
accidentally blocked content sites (`RESOURCES.md`, "Maintenance").
The script aborts if a source is unreachable or delivers significantly fewer entries
than expected – then no half-empty list is shipped.

**Build the package:** `npm run package` → `dist/ai-content-flag-<version>.zip` (version from
`manifest.json`), ready to upload to the Web Store or to hand out. Contents: the files tracked in Git
under `extension/` plus `extension/vendor/` (runs `npm run vendor` first) –
local, uncommitted files are not included. The blocklist is *not* regenerated in the process
(warning if it is older than 30 days).

**Release:** `npm run build`, check the diff of the blocklist, raise `version` in
`extension/manifest.json`, commit, merge to `main`. The workflow `.github/workflows/release.yml`
runs the tests and `npm run package` on every push and pull request; on `main` it tags a version
that has no tag yet and creates the GitHub release with the zip. No zip is uploaded by hand. If
`extension/` changes on `main` without a new version, the run only shows a warning.
Icons: source `extension/icons/icon.svg`, PNGs (16/32/48/128, in Git) via `npm run build:icons`.
Store screenshots: `npm run screenshots` → `store/screenshots/` (harness with fake scores, UI demo only).
Text selection, grouping and language on real pages: `npm run measure:pages` (URL list in
`scripts/measure-pages.urls.txt`, fake backend, ~5–8 min.) → `test/REAL_PAGES.md`.
Store texts, justification of the permissions and open items for submission: `store/`.
The script (`scripts/package.mjs`) aborts on uncommitted changes under `extension/`
(`node scripts/package.mjs --allow-dirty` builds anyway, file name with `-dirty`), a missing
`vendor/` or if a file is missing that the manifest, HTML pages, imports or `models.js`
refer to. It warns about open Store items (icon, placeholder in the contact of `privacy.html`). The zip is
reproducible: timestamp = commit time, the same commit yields the same SHA-256.

In Chrome/Edge:

1. `chrome://extensions` → "Developer mode" on → "Load unpacked" → `extension/`.
2. The settings open → choose a model, "Download" (one time, from Hugging Face,
   no token): desklib (default) 1.7 GB, converted in the browser to ~475 MB; TMR 126 MB.
3. Extension icon → "Scan this site automatically" or "Scan page now".
4. Offline test page: for the extension "Allow access to file URLs", then open `test/harness.html`.

Optional – server backend (desklib or TMR via PyTorch), provider "Local":

```powershell
cd server
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py   # port 8787
```

## Tests

```powershell
npm run test:setup   # once: Chromium for Playwright
npm test             # unit and E2E tests (~2 min), runs `npm run vendor` first
$env:HEADED=1; npm test   # with a visible browser window
```

Unit tests (`test/unit/`, no browser, seconds):

| File | Checks |
|---|---|
| `config.test.mjs` | traffic-light thresholds, blocklist (custom entries, bundled list, exceptions), `scanPolicy`, `modelKey` (incl. version from the model check), presets, `remoteTarget` |
| `providers.test.mjs` | backends with mocked `fetch`: server contract (incl. `lang`, value range), `/v1/info`, Bearer key, HTTP error messages, Hugging Face response shapes, Hub metadata (`pipeline_tag`, `id2label`) and label mapping, offscreen call |
| `settings.test.mjs` | Settings page: basic view fits one 1080p screen, advanced section folded, changes saved immediately, wrong threshold pair rejected, other backends only after "Use this backend", links into the advanced section |
| `model-check.test.mjs` | "Check model": reference set, AUROC, traffic-light suggestion, verdict (shape, direction, separation), flow against mocked server and Hugging Face (AI label via reference set) |
| `desklib-build.test.mjs` | desklib conversion on a mini `safetensors` file: copying, 8-bit quantization (rounding to even), chunk boundaries in the download, abort on a wrong file |
| `blocklist.test.mjs` | Generated blocklist: format, compact, size, spot checks (banking blocked, content sites not) |
| `length-buckets.test.mjs` | Length grouping before the model call |
| `zip.test.mjs` | Zip writer for `npm run package`: lossless, sorted, reproducible, readable by `tar`/`unzip` |

The E2E tests (`test/e2e/*.test.mjs`, Node test runner + Playwright) load the real extension in
Chromium and run it against a fake backend that speaks the contract of `shim_server.py`
and records every text sent (random port, a running `shim_server.py` does not interfere).

| File | Checks |
|---|---|
| `scan.test.mjs` | auto-scan, popup counter, icon badge, lazily added paragraphs, cache, thresholds, selection/right-click check, on/off, lazy scan, approval per page, blocklist (custom entries, bundled list, exceptions, password-field heuristic), backend status, settings |
| `extraction.test.mjs` | What goes to the model: 23 edge cases (navigation, cookie banner, hidden paragraphs, code, icon fonts, forms …), with and without lazy scan |
| `text-length.test.mjs` | Up to 2000 characters, cut at sentence end, batch budget 2500 characters, right-click = same excerpt as auto-scan |
| `feedback.test.mjs` | Feedback in the popover: click on the badge (also in links, without re-scoring), consent before the first save, undo, export without address, withdrawal, switching off |
| `score-store.test.mjs` | Persistent store: SW restart, mapping across pages, model switch, retention, "Do not store" |
| `model-check.test.mjs` | "Check model" in the settings: required before saving, swapped labels rejected, traffic light taken from the server, version in the model key, new URL invalidates the check |

Not covered: scoring with the real browser model (would need the model download) and the
Hugging Face provider with a real token (mocked only, see `providers.test.mjs`).

## Features

- **On/off and scan modes:** master switch (popup, `Alt+Shift+A`), badge "OFF" on the icon. Scanning
  happens "only on button press" (`Alt+Shift+S`), "on selected sites" (default, switch per
  domain in the popup) or "on all sites". Without approval the content script sends no
  text and does not observe the page.
- **Blocklist "never scan":** applies before every scan mode, "Scan page now" is also
  blocked there. The deliberate single check via selection/right-click remains allowed – the popover
  then points out the block and, for external backends, states where the text went. Three building blocks:
  - *Bundled list* (`builtinBlocklist`, ~14,100 domains: online banking worldwide with
    a focus on DE/AT/CH/UK/US incl. Sparkassen, Volksbanken and US credit unions, webmail,
    payment services, government portals with login) – generated by `scripts/build-blocklist.mjs` from
    UT1 blacklists, FDIC, NCUA, Wikidata and a hand-picked list. License of the list:
    CC BY-SA 4.0 (because of UT1). Sources, licenses, size and maintenance: `RESOURCES.md`.
  - *Custom entries* (`blockedSites`) and *exceptions* from the bundled list
    (`unblockedSites`) – in the settings or via "Never scan here" / "Remove from blocklist"
    in the popup.
  - *Heuristic* (`sensitiveHeuristic`): visible password, credit card or one-time code field
    (`autocomplete="cc-*"`, `one-time-code`) → page counts as blocked until it is reloaded.
    Also if the field only appears later (SPA) – then the markers are removed. Fields
    in dialogs do not count (login popups on news sites).

  Doubly secured: `content.js` decides, the service worker additionally rejects auto batches from pages
  of the lists (the heuristic is only known to the content script). The list exists as a single
  string `"\nd1\nd2\n…\n"` and is searched per host with all parent domains – no set with
  14,000 entries in every tab (233 KB per content script).
- **Traffic light:** two thresholds (Yellow from / Red from, presets per model), green = checked and *not* detected as
  AI (can be switched off), badge "AI score 97", distinguishable even without color perception
  (thin / dashed / heavy). Popup with counters per page and backend status (the "flagged"/"unclear" tiles cycle through
  those paragraphs: `GET_FLAGGED` returns only ids + levels in document order, `JUMP_TO` scrolls and
  highlights – no paragraph text leaves the page); icon badge with
  number of red (otherwise yellow) paragraphs, "!" on error.
- **Fewer false alarms** (the biggest harm is red on a human text; measurement:
  `training/EVAL_RESULTS.md`, "False alarms on Wikipedia"):
  - *"Unsure" level (gray):* Below a minimum length per model (`reliableWords` in `models.js`,
    currently 120 words everywhere) a high score does not become yellow/red, but
    "uncertain" – badge without number, the raw value is only in the popover. Green stays green. Exception
    `shortRedFrom`: desklib does mark short paragraphs red from 0.98 – so that it is as rarely wrong as
    with long ones (until v0.5 at 0.87, now 0.94), ~73% of the short ChatGPT texts detected (`training/EVAL_RESULTS.md`,
    "Confidence for short paragraphs"). TMR has no such threshold (it is almost never above 0.99). Custom models can specify both via
    `/v1/info` (`server/README.md`), otherwise 120 words applies and never red.
  - *Short paragraphs together:* Directly adjacent paragraphs under `reliableWords` with the same parent element,
    same language and without a heading/list/table in between are scored by the auto-scan as one text
    (up to `maxChars`) and all get the same result; for the traffic light the word count of the group counts
    (`groupCandidates` in `content.js`, can be switched off in the settings). Popover and tooltip name the
    group. Lazily added paragraphs are only grouped among themselves, not with already scored ones.
    Paragraphs with 15–39 words (below `MIN_WORDS`) are only scored as part of a group that has
    at least 40 words together, individually not at all (`GROUP_MIN_WORDS`; needed e.g. for BBC articles,
    `test/REAL_PAGES.md`).
  - *Other languages:* The bundled models only know English (`languages`). Paragraphs in
    other languages are not scored by the auto-scan (no marker, count in the popup); the single check
    asks first ("Check anyway"), the result is then always "uncertain". Detection per paragraph
    in `extension/lang-detect.js`: first function words (en/de/fr/es/it/nl/pt) and script; if that is
    unclear, the browser's built-in detection (`i18n.detectLanguage`: CLD3 in Chrome/Edge & co.,
    CLD2 in Firefox, >100 languages, no download); then the `lang` attribute. Exactly the
    excerpt the model would see is checked, for each paragraph individually – also lazily added ones. Custom models: languages from `GET /v1/info`, without it everything is scored.
  - *TMR thresholds 0.95 / 0.98* instead of 0.6 / 0.9 (stored old default values are taken over
    on update, custom ones stay).
  - *desklib red from 0.94* instead of 0.87: on the eval suite (1200 texts) 1.2% instead of 1.8% false alarms at
    91% instead of 92.5% detected, cross-validated (`training/EVAL_RESULTS.md`, "Securing the thresholds").
    Stored old default values are adjusted on update. TMR stays at 0.98 (there ~6%
    false alarms on long texts; 0.985 would push detection from 85% down to 65%).
  - *Wording:* "Flagged – resembles AI text" / "Unclear" / "Not flagged" instead of "probably AI",
    score 0–100 instead of percent, in the popover "A hint, not proof … not a probability" – the
    scores are not calibrated.
  - *Guided setup after installation* (`setup.html`, issue #8): 1. model cards (no preselection, one
    Hugging Face request only after the download click, progress + cancel, "Decide later" /
    "Use my own server"), 2. scan mode, 3. two bundled sample texts scored locally with the color legend and
    the "hint, not proof" note. Cancel closes the offscreen document (transformers.js cannot abort) and clears
    the leftovers; a failed download is restarted with the same button. Reachable from the settings and, as long
    as no model is downloaded, from the popup; updates never open it.
- **Visible area first:** batches of up to 5 paragraphs or 2500 characters, one after another (browser/local 1, remote 2 in parallel).
  The order is only determined when sending – after a scroll the priority jumps along.
- **Lazy scan (default on):** only paragraphs within 1.5 screen heights around the visible area, the
  rest via `IntersectionObserver` when it comes near.
- **Check single passages:** right-click on selected text or on a paragraph (or
  `Alt+Shift+C`), independent of the scan mode and also for text the auto-scan leaves out
  (from 5 words, up to 2000 characters). Marking via CSS Custom Highlight API, result in the popover.
- **Remember scores (default 30 days, adjustable up to 1 year or "Do not store"):**
  known paragraphs are marked immediately without recomputing – also after a browser restart and
  on other pages with the same text.
- **Feedback (stage 1 – local only):** clicking the badge of a marked paragraph opens
  details (without recomputing); there and in the result of the manual check: "Do you know where the text comes from?" → human/AI →
  *how* you know: wrote it myself or author known, published before 2023, labeled as AI
  or "just my impression". Before the first save, consent in the popover, afterwards
  "Undo". A stored answer is shown again by the popover the next time it opens
  ("Your answer: … – Change / Remove", also after reloading); Change replaces the entry, Undo
  restores the previous answer. Mapping via the SHA-256 of the scored text – if the
  page changes the paragraph, it is a new entry. Selected text is its own entry. Settings → Feedback: counter, export as JSONL, delete + withdrawal, buttons
  can be switched off. No feedback buttons on blocked pages (blocklist, password/payment field). Further processing:
  `training/import_feedback.py`, rationale and limits: `training/README.md` ("Feedback as a data source").
- **Backends** (`extension/bg/providers.js`): In the browser (TMR, fakespot or desklib), Local
  (`shim_server.py`), Custom server (contract in `server/README.md`: `POST {texts, model?, lang?} ->
  {scores}` with P(AI) in 0..1, optional `GET /v1/info`, optional Bearer key), Hugging Face Inference
  API. Host permissions for remote backends are only requested on "Use this backend" or checking;
  tokens only in `storage.local`.
- **Settings page** (`extension/options.html`/`options.js`, issue #9): *Basic* is always visible (browser model,
  scan mode and site list, delete stored scores), everything else sits in the folded `<details id="advanced">`
  (backends, thresholds, display, blocklist, retention, feedback). There is no Save button: every change is
  written after a short delay (`autosave`, only keys that differ from the stored state). Exception: other backends
  than "In the browser" (and their fields, secrets, "Check model" result) are written only by "Use this backend",
  which asks for the host permission in the click handler; until then the thresholds of that backend are not
  stored either. "Test connection" appears only for providers with an endpoint. Links such as
  `options.html#detection` unfold the advanced section. Developer notes (measurements, Laya, server contract) belong
  here and in `training/`/`server/`, not on the page.
- **Check custom models** (`extension/bg/model-check.js`): A custom model is a binary
  classifier, "Check model" in the settings tests it before use – required for
  "Custom server" and Hugging Face, optional for "Local". The reference set (114 texts, half
  human and half AI: HC3 with ChatGPT in five domains, plus Wikipedia from RAID with Llama-Chat, Mistral,
  MPT, GPT-2; 40 short and 74 long paragraphs; `extension/bg/reference-set.js`, generated by
  `training/build_reference_set.py`) goes to the model in batches as in operation. Checked: shape (count,
  0..1, before the timeout), direction (AI higher on average, otherwise label swapped), separation (AUROC:
  below 0.8 warning, below 0.6 rejected), plus traffic-light suggestion (from the server via `/v1/info`, otherwise from
  the scores: red just above the highest human text; with enough short texts also `reliableWords`/
  `shortRedFrom`) and latency with a recommendation for the scan mode. Caution: models trained on RAID or HC3
  (e.g. TMR on RAID) do too well on the set.
  Hugging Face: beforehand model info and `config.json` from the Hub – `pipeline_tag` must be
  `text-classification`, exactly 2 classes; the AI label comes from `id2label`, for
  `LABEL_0`/`LABEL_1` from the reference set. The version (`/v1/info` or commit on the Hub) goes into
  `modelKey`, text length and traffic-light starting values apply to the checked model. The result holds
  until the model or URL changes (token/API key do not count). Measurements on the reference set via the
  shim: TMR AUROC 0.99, ~0.5 s/text; desklib AUROC 0.99, ~2.4 s/text (old set). New set via
  `build_reference_set.py --check`: TMR 0.98 (short 0.93), desklib 0.997 (short 0.98).

### What is scored

Candidates are `p`, `li` and `article` (the latter only without their own long paragraphs) with at least
40 words; what is sent is the *visible* text (`innerText`, no HTML, no script/style content),
for long paragraphs cut at the last sentence end – how far depends on the model (`AIVSAI.maxChars`):
TMR 2000 characters (= its context, 512 tokens), desklib 1500 (could do 768 tokens, but becomes strongly
disproportionately slower and is already very accurate with short text), unknown models 2000.
Measured, more context helps a lot (TMR: 500 → 1500 characters lowers the errors from ~9% to < 1%),
chunks with overlap on the other hand do nothing (`training/EVAL_RESULTS.md`, "Text length"). Before the
model call, batches are split by token length (`extension/length-buckets.js`, in the server
`length_buckets`), so that short paragraphs are not padded to the longest (desklib: 16.6 → 4.4 s
per batch, same scores). Auto-scan, badge and right-click score the same
excerpt – so the same score-store entry and the same feedback entry.

- **Never:** navigation and page frame (`nav`, `header`, `footer`, `role=navigation|banner|contentinfo|search`),
  dialogs (`dialog`, `role=dialog` – mostly cookie banners), code (`pre`), inputs (`textarea`,
  `input`, `contenteditable` …), `template`, non-rendered paragraphs (`display:none`, `hidden`,
  collapsed – they follow as soon as they become visible).
- **Skipped, still checkable via right-click:** paragraphs in languages the model does not know
  (`data-aivsai-skipped="de"` on the element, count in the popup).
- **Excluded from the text:** icon fonts and other `aria-hidden` parts, code blocks.
- **Deliberately scored anyway:** paragraphs under `aria-hidden` ancestors (many sites hide
  the entire content this way while a modal is open), `form` (ASP.NET wraps entire pages in a
  form), `aside`/`role=complementary`. Sample 2026-09-25 (43 pages: news DE/EN, tech blogs,
  docs, Wikipedia, recipes): 0 of 752 scored paragraphs were in an `aside` – the existing
  `aside` elements are ad/lazy-load slots without text or teaser lists that already fail at the
  40-word limit. Excluding them would gain nothing, but would lose sidebars and
  info boxes in the article. Re-evaluate if the feedback shows false alarms there.
- **Not reached:** Shadow DOM, iframes.

## Privacy and storage

Privacy policy: `extension/privacy.html` (linked in the settings). Before a
publication in the Web Store: additionally host the page publicly
(the store requires a URL).

- Providers "In the browser" and "Local": texts do not leave the computer. The only network access is
  the one-time model download from Hugging Face.
- Custom server / Hugging Face: up to 2000 characters per paragraph go to this
  service – the settings point this out. "Check model" only sends the bundled,
  public reference set (for Hugging Face additionally a query of the model info on huggingface.co).
- **Score store** (IndexedDB, `extension/bg/score-store.js`, not synced): per paragraph only
  a 128-bit hash (SHA-256 over model configuration + text), score, model and timestamp –
  **no text, no URL**. Measured ~235 bytes per entry (50,000 = 11.7 MB, 30 days of intensive
  browsing ≈ 10 MB). Cleanup daily (`chrome.alarms`), at browser start and immediately when the
  setting changes; upper limit 200,000 entries; "Delete all" in the settings.
- **Feedback collection** (IndexedDB `aivsai-feedback`, `extension/bg/feedback-store.js`): contains the
  **text** (up to 2000 characters) plus label, basis, score, model, `lang` of the page, timestamp –
  **no URL, no hostname**. Only after consent (`feedbackConsentAt` in `storage.local`, checked a second time by the
  service worker), never sent. Export and deletion only from extension pages
  (the service worker rejects both from content scripts). Withdrawal deletes all entries.
  One entry per text, upper limit 20,000. No automatic deletion period – the collection is deliberately
  built and should not disappear after 30 days.
- **Mapping:** The key contains provider settings and model version (`modelKey`, e.g.
  `browser:tmr@b9aa251-q8`). Model switch → score again, old entries remain for switching back;
  new model revision/quantization → change `version` in `config.js`, old scores no longer apply.
  For "Local"/"Custom server"/Hugging Face the version comes from "Check model" (`/v1/info` or
  commit on the Hub); an update on the server without a new check goes unnoticed.

## Models

| Model | Size | in the browser (Ryzen 7 5800U, 8 threads) | Accuracy (HC3, 100 examples) | Wikipedia "Photosynthesis" |
|---|---|---|---|---|
| **TMR** (RoBERTa-base) – *Fast* | 126 MB | ~0.15 s/paragraph, load ~2 s | AUROC 0.908 (PyTorch 0.911) | 50/80 red (false alarms) |
| **fakespot** (RoBERTa-base) – *Balanced* | 125 MB | like TMR | AUROC 0.96 (eval suite, 1200 texts) | – |
| **desklib** (DeBERTa-v3-large) – *Accurate*, default | 1.7 GB → 475 MB | ~1 s/paragraph, load ~4 s, download+conversion ~57 s | AUROC 0.998 | 3/80 red |

The default since v0.6 is desklib: On the broader eval suite (6 domains, 7 generators) it shows ~1%
false alarms instead of ~5% for TMR (TMR: 20% on how-tos), AUROC 0.990 instead of 0.929
(`training/EVAL_RESULTS.md`, "Broader eval suite"). Installations from before v0.6 that never
chose a model keep TMR including traffic-light values on update (`pinLegacyModel` in `background.js`).

- Both trained on **English** only (German technical text in the harness: 78% → false alarm).
- TMR: ready-made int8 ONNX from `onnx-community`, revision pinned.
- desklib: There is no usable ONNX. The extension downloads the original (`model.safetensors`) and
  quantizes it itself during download (`extension/desklib_build.js`, as a stream, row by row).
  Only the compute graph without weights plus build recipe is shipped (`extension/models/desklib/`,
  1.9 MB, generated by `scripts/build_desklib_skeleton.py`). MatMul 8-bit weight-only
  (MatMulNBits, block 32) instead of the usual dynamic int8, which breaks DeBERTa
  (AUROC 0.998 → 0.973).
- Laya (zero-shot) tested: AUROC 0.549, therefore not selectable. Server measurements (PyTorch, CPU):
  `training/EVAL_RESULTS.md`.
- Licenses (MIT and transformers.js Apache-2.0): `extension/THIRD_PARTY_NOTICES.md`. HC3 is
  CC-BY-SA-4.0 → keep in mind for your own fine-tuning.

## Architecture

```
extension/
  models.js             Model catalog: name, context, traffic-light presets, minimum length for yellow/red, languages,
                        browser download (revision/version), server details – one place per model
  config.js             Defaults + shared rules for all parts: provider registry (PROVIDERS),
                        scanPolicy/blockReason (may it be scanned?), modelKey (model + version),
                        presets, traffic-light levels (incl. "uncertain")
  lang-detect.js        Language detection per paragraph (function words, script)
  background.js         Service worker (ES module): wires events and messages to bg/
  bg/providers.js       Backends (request, health check, model info per provider)
  bg/model-check.js     "Check model": test a custom model against the reference set
  bg/reference-set.js   Reference set (HC3 + RAID wiki, CC BY-SA 4.0), generated by training/build_reference_set.py
  bg/scoring.js         Config cache, score cache (memory → IndexedDB → model), test, status
  bg/score-store.js     persistent score store with retention period
  bg/feedback-store.js  Feedback collection (with text, only after consent, local only)
  bg/badge.js           Icon badge per tab
  bg/offscreen-client.js  Bridge to the offscreen document
  offscreen.js          Model via transformers.js/WASM (service worker has no worker threads)
  length-buckets.js     Split batch by token length (no padding to the longest text)
  desklib_build.js      desklib conversion during download
  content.js            Text selection, queue/prioritization, marking, result register
                        (`results`: element → score, text, model, source – basis for feedback/reports)
  content-popover.js    Result popover of the manual check (Shadow DOM)
  manual-check.js       Single check shared by content.js and selection-check.js: word limits, excerpt, result view
  selection-check.*     Last-resort result window for selected text when the tab has no content script at all
                        (issue #31). In the PDF viewer the top frame's popover is used (message CHECK_TEXT);
                        the text travels via session storage
  popup.*, options.*    UI; the popup gets STATS pushed instead of polling
  setup.*               Guided setup after installation (model choice, scan mode, try-out)
  privacy.html          Privacy policy
  models/desklib/       Graph without weights + build recipe
  vendor/               via `npm run vendor` (not in Git)
  generated/            via `npm run build:blocklist` (in Git): blocklist.js = bundled blocklist
server/                 shim_server.py (TMR/desklib via PyTorch, optional Laya proxy), port 8787
test/                   harness.html (test page), e2e/ (Playwright tests)
training/               Dataset preparation (HC3), backend comparison, measurement results
scripts/                vendor.mjs, build-blocklist.mjs, build_desklib_skeleton.py,
                        package.mjs + zip.mjs (zip into dist/)
```

### New model or new provider

- **Model:** Entry in `extension/models.js`. With a `browser` section (ONNX repo, pinned
  `revision`, `version`, `marker`) it appears under "In the browser", with `server` under "Local
  server" (then also offer it in `server/shim_server.py`). Text length (`maxChars`) and traffic-light presets
  (`thresholds`) apply automatically to both.
- **Provider:** Description in `AIVSAI.PROVIDERS` (`extension/config.js`: name, fields, endpoint,
  model identifier) plus request under the same key in `BACKENDS` (`extension/bg/providers.js`).
  Settings form, defaults, secrets (`secret: true` → `storage.local`), cache signature and
  privacy notice are derived from it. The unit tests check that both sides fit together.
  With `check` the provider gets "Check model"; what the backend knows about the model (version,
  text length, labels) it delivers via `inspect` in `BACKENDS`.

Performance principles in the content script: when collecting and prioritizing, first read everything, then
write (no layout thrashing); `MutationObserver` only on pages that are scanned;
statistics from the register instead of document scans.

## Roadmap

**Done**

- v0.2 (2026-09-24): scan modes, traffic light, popup, provider abstraction, prioritization, lazy scan,
  right-click check.
- v0.3: TMR in the browser (offscreen document, WASM, multithreading via COOP/COEP).
- v0.4: desklib in the browser with conversion during download.
- v0.5 (2026-09-25): restructuring for the planned features (`scanPolicy`, `modelKey`, result register,
  modular service worker), performance in the content script, persistent score store with
  retention period, model version in the key, more precise text selection (navigation by role,
  dialogs, code, icon fonts, invisible paragraphs), E2E tests in the repo (`npm test`).
- Blocklist "never scan" (`scanPolicy` → `"blocked"`): bundled list via build script
  (UT1 + FDIC + NCUA + Wikidata + hand-picked), custom entries, exceptions, password-field heuristic;
  privacy policy.
- Feedback stage 1: "Do you know where the text comes from?" in the check result, local only, with consent,
  JSONL export, `training/import_feedback.py`.
- BYOM framework: contract with `lang` and `GET /v1/info` (shim with pinned revisions), "Check model"
  against a reference set, Hugging Face metadata instead of guessing, version in the model key.

- Fewer false alarms: do not score other languages (detection per paragraph), "uncertain" level for short
  texts, TMR thresholds 0.95/0.98 after measurement on Wikipedia, "AI score" instead of percent, welcome page.
- Concurrent requests for the same paragraph (multiple tabs, duplicate paragraph in a batch) go to
  store and backend only once.
- Permission `tabs` replaced by `activeTab`: all that is needed is the URL of the active tab in the popup.
- Score short paragraphs together (adjacent paragraphs under `reliableWords` as one text).
- Broader eval suite: 1200 texts, 6 domains, 7 generators up to GPT-4o (`training/evaluate_suite.py`).
- desklib as default model (existing installations without a model choice keep TMR).
- desklib red from 0.94 (cross-validated on 1200 texts); model search: fakespot found as a third
  model (`training/MODEL_SEARCH.md`); `npm run measure:pages` for real pages.
- fakespot as third model "Balanced" (ONNX checked against the original, thresholds cross-validated).
- Very short paragraphs (15–39 words) are scored in groups (BBC articles now covered).
- Reference set for "Check model" broadened (114 texts, HC3 + RAID wiki, short paragraphs), license checked per
  sub-source.
- Store preparation: icons, "About / licenses" page (`about.html`), store texts and justification of the
  permissions (`store/`), screenshot script.

**Open:** see `TODO.md`.

## License

The code is under the MIT license (`LICENSE`). Excluded are the bundled blocklist
`extension/generated/blocklist.js` and the reference set `extension/bg/reference-set.js` (texts from HC3 and RAID),
which are under CC BY-SA 4.0. Sources and licenses of all
third-party components: `extension/THIRD_PARTY_NOTICES.md`.
