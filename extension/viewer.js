// PDF viewer of the extension (pdf.js components from vendor/pdfjs, see scripts/vendor.mjs). Chrome's own PDF
// viewer is closed to extensions - this one shows the PDF as ordinary DOM (canvas + text layer), which is the
// basis for scoring and coloring paragraphs (issue #30).
//
// Where the PDF comes from:
//   - file picker or drag and drop: bytes stay in this tab, no network
//   - ?file=<url>: loaded again by the extension (cookies as in the browser). Needs host access for that origin
//     (asked for with a click, "optional_host_permissions") or, for file://, "Allow access to file URLs"
// Scanning (button "Scan PDF", never automatic): text is read page by page, split into paragraphs
// (pdf-paragraphs.js) and scored with the same pipeline as web pages - local providers only for now (issue #35).
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "./vendor/pdfjs/pdf_viewer.mjs";
import { extractParagraphs } from "./pdf-paragraphs.js";

const $ = (id) => document.getElementById(id);
const PDFJS = "vendor/pdfjs/";
const asset = (rel) => chrome.runtime.getURL(`${PDFJS}${rel}`);

pdfjsLib.GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");

const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus });
const viewer = new PDFViewer({
  container: $("viewerContainer"),
  viewer: $("viewer"),
  eventBus,
  linkService,
  textLayerMode: 1 // text layer: selectable text, and the DOM the markings will be attached to
});
linkService.setViewer(viewer);

let loadingTask = null;
let currentDoc = null;
let sourceHost = ""; // host the PDF was loaded from ("" for a chosen file) - the blocklist applies to it
let scanToken = 0; // a running scan ends when this changes (new document, stop, new scan)

function notice(title, text, actions = []) {
  $("noticeTitle").textContent = title;
  $("noticeText").textContent = text;
  $("noticeActions").replaceChildren(
    ...actions.map(({ label, primary, onClick }) => {
      const b = document.createElement("button");
      b.textContent = label;
      if (primary) b.className = "primary";
      b.addEventListener("click", onClick);
      return b;
    })
  );
  $("notice").hidden = false;
  $("viewerContainer").hidden = true;
}

function setControls(enabled) {
  for (const id of ["prev", "next", "zoomOut", "zoomIn", "zoom", "pageNumber", "scan"]) $(id).disabled = !enabled;
}

const pickFile = () => $("fileInput").click();
const chooseFile = { label: "Choose a file…", onClick: pickFile };

// source: { url } or { data: Uint8Array }; name only for the title
async function openPdf(source, name) {
  scanToken++;
  clearMarks();
  currentDoc = null;
  $("results").hidden = true;
  await loadingTask?.destroy();
  $("notice").hidden = true;
  $("viewerContainer").hidden = false;
  setControls(false);
  $("title").textContent = name || "PDF";
  document.title = `${name || "PDF"} – AI Content Flag`;

  loadingTask = pdfjsLib.getDocument({
    ...source,
    cMapUrl: asset("cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: asset("standard_fonts/"),
    wasmUrl: asset("wasm/"),
    iccUrl: asset("iccs/"),
    isEvalSupported: false, // no code generation from PDF content
    withCredentials: true // like the browser: cookies for the origin the PDF comes from
  });
  loadingTask.onPassword = (update, reason) => {
    const again = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    const password = window.prompt(
      again ? "Wrong password. Password for this PDF:" : "This PDF is password protected. Password:"
    );
    if (password === null) notice("Password required", "The PDF was not opened.", [chooseFile]);
    else update(password);
  };
  try {
    const doc = await loadingTask.promise;
    currentDoc = doc;
    viewer.setDocument(doc);
    linkService.setDocument(doc, null);
    $("pageCount").textContent = `/ ${doc.numPages}`;
    $("pageNumber").max = String(doc.numPages);
    setControls(true);
  } catch (err) {
    if (err?.name === "PasswordException") return;
    notice("This PDF cannot be opened", String(err?.message || err), [chooseFile]);
  }
}

// Default zoom: as wide as the window allows, but not wider than 110% - "fit width" alone makes pages on wide
// windows so large that only a small part of a page is readable at once
const BALANCED_MAX = 1.1;
let applying = false; // zoom set by the select itself: the select already shows it
function applyZoom(value) {
  applying = true;
  try {
    if (value === "balanced") {
      viewer.currentScaleValue = "page-width";
      if (viewer.currentScale > BALANCED_MAX) viewer.currentScale = BALANCED_MAX;
    } else {
      viewer.currentScaleValue = value;
    }
  } finally {
    applying = false;
  }
}
eventBus.on("pagesinit", () => applyZoom($("zoom").value));
// Zoom changed by +/- or Ctrl+wheel: show the real value in the select, as a preset if it matches
eventBus.on("scalechanging", ({ scale }) => {
  if (applying) return;
  const select = $("zoom");
  const preset = [...select.options].find((o) => /^[\d.]+$/.test(o.value) && Math.abs(Number(o.value) - scale) < 0.005);
  if (preset) {
    select.value = preset.value;
    return;
  }
  const custom = select.querySelector('option[value="custom"]');
  custom.textContent = `${Math.round(scale * 100)}%`;
  custom.hidden = false;
  select.value = "custom";
});
eventBus.on("pagechanging", ({ pageNumber }) => {
  $("pageNumber").value = String(pageNumber);
});

async function openFile(file) {
  if (!file) return;
  await openPdf({ data: new Uint8Array(await file.arrayBuffer()) }, file.name);
}

async function openUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return notice("Not a valid address", raw, [chooseFile]);
  }
  const name = decodeURIComponent(url.pathname.split("/").pop() || url.hostname);
  sourceHost = /^https?:$/.test(url.protocol) ? url.hostname : "";

  if (url.protocol === "file:") {
    if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
      return notice(
        "Access to local files is switched off",
        'To open a PDF from your computer by its address, switch on "Allow access to file URLs" for this extension ' +
          "on the extensions page (chrome://extensions). Without it you can still choose the file here.",
        [chooseFile]
      );
    }
    return openPdf({ url: url.href }, name);
  }
  if (!/^https?:$/.test(url.protocol)) return notice("Not a web address", url.protocol, [chooseFile]);

  const origins = [`${url.origin}/*`];
  if (!(await chrome.permissions.contains({ origins }))) {
    return notice(
      `Allow access to ${url.host}?`,
      "The extension has to load this PDF again from its web address to show it here. It is only read on this " +
        "computer. You can revoke the access on the extensions page. Alternatively, choose the downloaded file.",
      [
        {
          label: `Allow ${url.host}`,
          primary: true,
          onClick: async () => {
            if (await chrome.permissions.request({ origins })) openPdf({ url: url.href }, name);
          }
        },
        chooseFile
      ]
    );
  }
  return openPdf({ url: url.href }, name);
}

// --- Toolbar, file picker, drag and drop -------------------------------------------------------
$("open").addEventListener("click", pickFile);
$("fileInput").addEventListener("change", (e) => {
  openFile(e.target.files[0]);
  e.target.value = "";
});
$("prev").addEventListener("click", () => viewer.previousPage());
$("next").addEventListener("click", () => viewer.nextPage());
$("zoomIn").addEventListener("click", () => (viewer.currentScale = Math.min(viewer.currentScale * 1.25, 5)));
$("zoomOut").addEventListener("click", () => (viewer.currentScale = Math.max(viewer.currentScale / 1.25, 0.25)));
$("zoom").addEventListener("change", (e) => e.target.value !== "custom" && applyZoom(e.target.value));
$("pageNumber").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  if (n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
  else e.target.value = String(viewer.currentPageNumber);
});

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files");
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropHint").hidden = false;
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) $("dropHint").hidden = true;
});
document.addEventListener("dragover", (e) => hasFiles(e) && e.preventDefault());
document.addEventListener("drop", (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropHint").hidden = true;
  const file = [...e.dataTransfer.files].find((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (file) openFile(file);
  else notice("Not a PDF", "Drop a file with the ending .pdf.", [chooseFile]);
});

// --- Scan --------------------------------------------------------------------------------------
const M = AIVSAI_MANUAL;
const EXCERPT_CHARS = 120;

async function loadConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]);
  return { ...AIVSAI.DEFAULTS, ...sync, ...AIVSAI.SECRET_DEFAULTS, ...local };
}

function requestScores(items) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SCORE_BATCH", items, manual: false }, (resp) =>
      resolve(chrome.runtime.lastError ? null : resp)
    );
  });
}

// Pages -> items for pdf-paragraphs.js (positions in PDF units, y upward)
async function readPages(doc, token, onProgress) {
  const pages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (token !== scanToken) return null;
    onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items
      .filter((it) => typeof it.str === "string")
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        w: it.width,
        h: it.height || Math.hypot(it.transform[2], it.transform[3]),
        eol: !!it.hasEOL
      }));
    pages.push({ number: n, width, height, items });
    page.cleanup();
  }
  return pages;
}

// Batches as for web pages: by number and amount of text, so that one request does not block the queue
function batchesOf(entries) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const e of entries) {
    if (cur.length >= M.BATCH_MAX_ITEMS || (cur.length && chars + e.text.length > M.BATCH_MAX_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(e);
    chars += e.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

const setScanStatus = (text) => ($("scanStatus").textContent = text);

function resetResults() {
  clearMarks();
  $("results").hidden = false;
  $("hits").replaceChildren();
  $("scanCounts").replaceChildren();
  $("scanNotes").textContent = "";
  $("onlyFlaggedLabel").hidden = true;
}

function endScan(token, message) {
  if (token !== scanToken) return;
  if (message) {
    resetResults();
    setScanStatus(message);
  }
  $("stop").hidden = true;
  $("scan").disabled = !currentDoc;
}

async function scanDocument() {
  if (!currentDoc) return;
  const token = ++scanToken;
  const cfg = await loadConfig();
  $("scan").disabled = true;

  // Whole documents only stay on this computer for now (issue #35: confirmation per document for external backends)
  if (!cfg.enabled) return endScan(token, "The extension is switched off.");
  const target = AIVSAI.remoteTarget(cfg);
  if (target) {
    return endScan(
      token,
      `PDFs are not sent to ${target}. Choose "In the browser" or "Local" in the settings to check PDFs – ` +
        "external backends for PDFs need a separate confirmation that is not available yet."
    );
  }
  if (sourceHost && AIVSAI.scanPolicy(sourceHost, cfg) === "blocked") {
    return endScan(token, `${sourceHost} is on the blocklist – its documents are not scanned.`);
  }

  resetResults();
  $("stop").hidden = false;

  const pages = await readPages(currentDoc, token, (n, total) => setScanStatus(`Reading page ${n} of ${total}…`));
  if (!pages) return;
  const extracted = extractParagraphs(pages);

  // Candidates as on web pages: at least GROUP_MIN_WORDS words, shorter ones only as part of a group.
  // `breaks`: number of non-prose blocks (heading, caption, table, references) before it - paragraphs with the
  // same number have nothing between them.
  const found = [];
  let breaks = 0;
  for (const p of extracted.paragraphs) {
    if (p.kind !== "text") breaks++;
    else if (p.words >= M.GROUP_MIN_WORDS) {
      found.push({ para: p, text: p.text, words: p.words, groupOnly: p.words < M.MIN_WORDS, breaks });
    }
  }
  setScanStatus("Detecting language…");
  const langs = await Promise.all(found.map((f) => AIVSAI_LANG.detectAsync(M.clipText(f.text, cfg))));
  if (token !== scanToken) return;
  found.forEach((f, i) => (f.lang = langs[i] || ""));

  const groups = M.groupRuns(found, cfg, (last, next) => last.breaks === next.breaks);
  const scorable = [];
  const skipped = { foreign: 0, tooShort: 0 };
  for (const items of groups) {
    const words = items.reduce((n, it) => n + it.words, 0);
    if (M.foreignOf(items[0].lang, cfg)) {
      skipped.foreign += items.length;
      continue;
    }
    // a group of short paragraphs that together stays below MIN_WORDS: unscored, as on web pages
    if (words < M.MIN_WORDS && items.every((it) => it.groupOnly)) {
      skipped.tooShort += items.length;
      continue;
    }
    const fullText = items.map((it) => it.text).join(M.GROUP_SEPARATOR);
    const text = M.clipText(fullText, cfg);
    scorable.push({
      id: `g${scorable.length}`,
      items,
      words,
      text,
      truncated: text.length < fullText.length,
      lang: items[0].lang
    });
  }

  const results = [];
  let done = 0;
  for (const batch of batchesOf(scorable)) {
    setScanStatus(`Checking text block ${done + 1}–${done + batch.length} of ${scorable.length}…`);
    const resp = await requestScores(batch.map(({ id, text, lang }) => ({ id, text, lang })));
    if (token !== scanToken) return;
    for (const g of batch) {
      const p = resp?.scores?.[g.id];
      if (typeof p === "number") results.push({ ...g, p, level: M.levelOf({ p, words: g.words, foreign: "" }, cfg) });
    }
    if (resp?.error && !results.length) return endScan(token, resp.error);
    done += batch.length;
  }
  setMarks(results, cfg, pages);
  renderResults(results, { cfg, scorable, skipped, extracted });
  updateNextFlagged();
  endScan(token);
}

function renderResults(results, { cfg, scorable, skipped, extracted }) {
  const chip = (level, label) => {
    const el = document.createElement("span");
    el.className = `chip ${level}`;
    el.textContent = `${results.filter((r) => r.level === level).length} ${label}`;
    return el;
  };
  $("scanCounts").replaceChildren(
    chip("red", "flagged"),
    chip("yellow", "unclear"),
    chip("green", "not flagged"),
    chip("uncertain", "uncertain")
  );
  setScanStatus(
    scorable.length
      ? `${results.length} of ${scorable.length} text blocks checked.`
      : "No paragraphs long enough to check were found."
  );

  const notes = [];
  const blank = extracted.pages.withoutText;
  if (blank.length) {
    notes.push(
      `${blank.length} ${blank.length === 1 ? "page has" : "pages have"} no text layer (scanned?) and could not be ` +
        `checked: ${blank.slice(0, 12).join(", ")}${blank.length > 12 ? ", …" : ""}.`
    );
  }
  if (skipped.foreign) notes.push(`${skipped.foreign} paragraphs in a language the model does not know were skipped.`);
  if (skipped.tooShort) notes.push(`${skipped.tooShort} very short paragraphs were not checked.`);
  notes.push("Headings, captions, tables and reference lists are not checked.");
  notes.push("Hint, not proof: the AI score shows how much a text resembles what the model learned as AI text.");
  notes.push(AIVSAI.providerLabel(cfg));
  $("scanNotes").textContent = notes.join(" ");

  const list = () => {
    const only = $("onlyFlagged").checked;
    $("hits").replaceChildren(
      ...results
        .filter((r) => !only || r.level === "red" || r.level === "yellow")
        .map((r) => {
          const page = r.items[0].para.page;
          const meta = document.createElement("span");
          meta.className = `meta ${r.level}`;
          meta.textContent = `p. ${page} · ${r.level === "uncertain" ? "uncertain" : M.scoreText(r.p)}`;
          const ex = document.createElement("span");
          ex.className = "excerpt";
          ex.textContent = r.text.length > EXCERPT_CHARS ? `${r.text.slice(0, EXCERPT_CHARS)}…` : r.text;
          const button = document.createElement("button");
          button.append(meta, ex);
          button.addEventListener("click", () => jumpTo(r));
          const li = document.createElement("li");
          li.append(button);
          return li;
        })
    );
  };
  $("onlyFlaggedLabel").hidden = !results.length;
  $("onlyFlagged").onchange = list;
  list();
}

$("scan").addEventListener("click", scanDocument);
$("stop").addEventListener("click", () => {
  scanToken++;
  setScanStatus("Stopped.");
  $("stop").hidden = true;
  $("scan").disabled = !currentDoc;
});

// --- Marking in the document -------------------------------------------------------------------
// The text layer is ordinary DOM: every pdf.js text item has a span, in the order of getTextContent().
// pdf-paragraphs.js reports which items make up a paragraph (parts[].items), so a result is marked by putting
// a Range over those spans into the CSS Custom Highlight API (no change to the DOM, same colors as on pages).
// Text layers are built lazily and again after zooming - marking is (re)applied on every `textlayerrendered`.
const FOCUS_MS = 2200;
const marks = { results: [], cfg: null, itemCounts: {}, spanIndex: {} };
const highlightSets = Object.fromEntries(["green", "yellow", "red", "uncertain", "focus"].map((l) => [l, new Highlight()]));
if (window.CSS?.highlights) for (const [l, set] of Object.entries(highlightSets)) CSS.highlights.set(`aivsai-${l}`, set);
const pageRanges = new Map(); // page number -> [{ range, set }]
const spanOwner = new WeakMap(); // text-layer span -> result (for the click popover)
let focus = null; // { result, timer }
let flaggedIndex = -1;

const textLayerOf = (n) => viewer.getPageView(n - 1)?.div?.querySelector(".textLayer");

function clearPageMarks(n) {
  for (const { range, set } of pageRanges.get(n) || []) set.delete(range);
  pageRanges.delete(n);
}

function markPage(n) {
  clearPageMarks(n);
  const layer = textLayerOf(n);
  if (!layer || !marks.results.length) return;
  const spans = [...layer.querySelectorAll("span:not(.markedContent)")];
  // The layer must be the one the paragraphs were extracted from - otherwise better no marking than a wrong one
  if (marks.itemCounts[n] !== spans.length) return;
  const entries = [];
  const add = (set, range) => {
    set.add(range);
    entries.push({ range, set });
  };
  for (const r of marks.results) {
    const visible = r.level !== "green" || marks.cfg.showGreen;
    for (const it of r.items) {
      for (const part of it.para.parts) {
        if (part.page !== n) continue;
        for (const idx of part.items) {
          const span = spans[marks.spanIndex[n]?.[idx]];
          if (!span) continue;
          spanOwner.set(span, r);
          const range = document.createRange();
          range.selectNodeContents(span);
          if (visible) add(highlightSets[r.level], range);
          if (focus?.result === r) add(highlightSets.focus, range.cloneRange());
        }
      }
    }
  }
  pageRanges.set(n, entries);
}

function markRenderedPages() {
  for (let n = 1; n <= (currentDoc?.numPages || 0); n++) markPage(n);
}

function clearMarks() {
  for (const n of [...pageRanges.keys()]) clearPageMarks(n);
  for (const set of Object.values(highlightSets)) set.clear();
  clearTimeout(focus?.timer);
  focus = null;
  flaggedIndex = -1;
  Object.assign(marks, { results: [], cfg: null, itemCounts: {}, spanIndex: {} });
  $("nextFlagged").hidden = true;
}

function setMarks(results, cfg, pages) {
  clearMarks();
  // pdf.js reports empty items (line ends) for which the text layer has no span: item position -> span position
  const spanIndex = {};
  const itemCounts = {};
  for (const p of pages) {
    let spans = 0;
    spanIndex[p.number] = p.items.map((it) => (it.str === "" ? -1 : spans++));
    itemCounts[p.number] = spans;
  }
  Object.assign(marks, { results, cfg, itemCounts, spanIndex });
  markRenderedPages();
}

eventBus.on("textlayerrendered", ({ pageNumber }) => markPage(pageNumber));

// Scroll to the place of a result (not only to its page) and flash it
function jumpTo(r) {
  const part = r.items[0].para.parts[0];
  clearTimeout(focus?.timer);
  highlightSets.focus.clear();
  focus = {
    result: r,
    timer: setTimeout(() => {
      highlightSets.focus.clear();
      focus = null;
    }, FOCUS_MS)
  };
  // XYZ destination: left edge, a little above the paragraph so that its context is visible
  viewer.scrollPageIntoView({ pageNumber: part.page, destArray: [null, { name: "XYZ" }, 0, part.y1 + 40, null] });
  for (const p of new Set(r.items.flatMap((it) => it.para.parts.map((x) => x.page)))) markPage(p);
}

// Click on marked text: the same result view as on web pages, anchored at the clicked line
function showResult(r, anchor) {
  const rec = {
    text: r.text,
    words: r.words,
    p: r.p,
    truncated: r.truncated,
    grouped: r.items.length > 1 ? r.items.length : undefined
  };
  AIVSAIPopover.show({ el: anchor }, AIVSAIPopover.claim(), M.resultView(rec, marks.cfg));
}

$("viewerContainer").addEventListener("click", (e) => {
  const span = e.target.closest?.("span");
  const r = span && spanOwner.get(span);
  if (!r || !getSelection().isCollapsed) return; // not on marked text, or the user is selecting text
  showResult(r, span);
});

function updateNextFlagged() {
  const flagged = marks.results.filter((r) => r.level === "red" || r.level === "yellow");
  $("nextFlagged").hidden = !flagged.length;
  $("nextFlagged").textContent =
    flaggedIndex >= 0 ? `Next flagged (${flaggedIndex + 1} / ${flagged.length})` : `Next flagged (${flagged.length})`;
  return flagged;
}

$("nextFlagged").addEventListener("click", () => {
  const flagged = updateNextFlagged();
  if (!flagged.length) return;
  flaggedIndex = (flaggedIndex + 1) % flagged.length;
  jumpTo(flagged[flaggedIndex]);
  updateNextFlagged();
});

// --- Start -------------------------------------------------------------------------------------
const requested = new URLSearchParams(location.search).get("file");
if (requested) openUrl(requested);
else {
  notice("Open a PDF", "Choose a PDF file or drop it onto this window. Nothing leaves your computer.", [
    { ...chooseFile, primary: true }
  ]);
}
