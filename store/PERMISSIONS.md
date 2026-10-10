# Permissions – justification for the store form

Covers the fields that Chrome Web Store / Edge Add-ons require on submission: "Single Purpose",
justification per permission, data usage, remote code. Reference: `extension/manifest.json`.

## Single Purpose (Chrome requires a single, coherent description)

"Scans paragraphs on web pages the user opts in, with a locally-run or user-chosen AI-text
classifier, and flags them with a green/yellow/red score." All permissions serve exactly this
one purpose (read and mark text, remember the result, run the model, let the user decide
what/when to scan).

## Permissions (`permissions`)

- **`storage`** – stores settings (`chrome.storage.sync`), API credentials for optional
  backends (`chrome.storage.local`, never synced) as well as the score and feedback collection
  (IndexedDB, also local). No access to data of other extensions or websites.
- **`activeTab`** – gives the popup the host/URL of the currently active tab, in order to show the blocklist status
  and the page switch ("scan this page automatically") there. No permanent or
  background tab access.
- **`offscreen`** – the AI model running in the browser (WebAssembly, transformers.js) needs a
  DOM context with worker threads; service workers do not have that. The offscreen document loads and
  runs only the model, displays nothing and has no UI.
- **`contextMenus`** – adds the right-click entry "Check for AI" for selected text or paragraphs
  (single check independent of the automatic scan mode).
- **`alarms`** – triggers the daily cleanup of the score store (delete expired entries after
  the configured retention period), regardless of whether the extension is currently open.

## Host permissions (`host_permissions`)

- **`http://127.0.0.1/*`, `http://localhost/*`** – hard-coded for the optional local server
  (`server/shim_server.py`, provider "Local"), which provides PyTorch backends for the same models.
  No network access outside the own computer.

## Optional host permissions (`optional_host_permissions`)

- **`https://*/*`, `http://*/*`** – not granted on install, but only requested at runtime, specifically
  for **one** concrete address (`chrome.permissions.request`), when the user enters and saves or tests
  their own server or Hugging Face as a backend in the settings
  (`extension/options.js`, `requestOrigins`). Without this deliberate step the extension has no
  access to additional hosts.

## Content script (`content_scripts`, `matches: ["<all_urls>"]`)

Reads visible paragraph text (`innerText`, no HTML, no form input, no passwords) on
pages the user has approved for scanning, and marks scored paragraphs in color directly in the
document (CSS Custom Highlight API). `<all_urls>` is necessary because it is not known in advance which pages
the user will approve – `localhost`/`127.0.0.1` are excluded (the local server may run there).
Whether anything is scanned at all is decided at runtime by `scanPolicy` (`extension/config.js`): scan mode,
blocklist (bundled + custom entries), password/payment-field detection.

## PDF viewer (`viewer.html`)

Opens PDFs in an own page built from the bundled pdf.js components, only on explicit user action (popup
button, file picker, drag and drop). For a PDF behind a web address the page asks for host access to
exactly that origin via the existing `optional_host_permissions` (`chrome.permissions.request`, on a
click); `file://` needs the browser's "Allow access to file URLs" switch. No new permission, no
`webRequest`/`declarativeNetRequest`, no automatic redirect of PDFs. pdf.js and its data (character maps,
fonts, decoders) are part of the package; no remote code.

## `wasm-unsafe-eval` (Content Security Policy)

Required so that ONNX Runtime Web (part of transformers.js) may compile and run WebAssembly modules
– for the AI model running in the browser (provider "In the browser") – and for pdf.js' image decoders in the
PDF viewer. Affects only
extension pages/offscreen document, not visited websites.

## Data usage (Chrome form "Data usage")

- **Website content:** yes – visible text paragraphs of the pages the user approves, for scoring.
- **Processing:** by default **locally on the device** (model in the browser or local server).
  Only if the user explicitly enters their own server or the Hugging Face Inference API
  are text excerpts (up to 2000 characters per paragraph) sent to that self-chosen service – the
  settings show a notice for this before saving.
- **Not collected:** no usage statistics/analytics, no ads, no tracking, no sale
  or sharing of data with third parties other than the self-chosen backend.
- **Stored locally:** settings; a hash (no text) per scored paragraph with score,
  model, timestamp (adjustable retention, default 30 days); optionally, only after consent,
  a feedback collection with text (for training/testing purposes, export as JSONL, deletable at any time).
- **PDFs:** same processing as page text. Online backends are refused for PDFs unless the user switched on
  "Allow online backends for PDFs" in the settings; then the viewer asks for confirmation per document,
  naming the destination and the amount of text. No feedback collection for PDFs.
  Details: `extension/privacy.html`.

## Remote code explanation

**No**, the extension does not load any executable code remotely. The complete JavaScript/WASM code
(incl. transformers.js and ONNX Runtime Web) is contained in the package (`extension/vendor/`, built via
`npm run vendor` and shipped along). What is loaded from Hugging Face at runtime is
exclusively **model weights** (data, no program logic) – once, after an explicit click
on "Download" in the settings, with the download size shown beforehand. When using a
custom server/Hugging Face backend, text excerpts are sent for scoring; that too is
data exchange, not loading of code.
