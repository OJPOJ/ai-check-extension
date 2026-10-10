// PDF viewer of the extension (pdf.js components from vendor/pdfjs, see scripts/vendor.mjs). Chrome's own PDF
// viewer is closed to extensions - this one shows the PDF as ordinary DOM (canvas + text layer), which is the
// basis for scoring and coloring paragraphs (issue #30).
//
// Where the PDF comes from:
//   - file picker or drag and drop: bytes stay in this tab, no network
//   - ?file=<url>: loaded again by the extension (cookies as in the browser). Needs host access for that origin
//     (asked for with a click, "optional_host_permissions") or, for file://, "Allow access to file URLs"
// Nothing is scanned or sent anywhere from here.
import * as pdfjsLib from "./vendor/pdfjs/pdf.min.mjs";
import { EventBus, PDFLinkService, PDFViewer } from "./vendor/pdfjs/pdf_viewer.mjs";

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
  for (const id of ["prev", "next", "zoomOut", "zoomIn", "fit", "pageNumber"]) $(id).disabled = !enabled;
}

const pickFile = () => $("fileInput").click();
const chooseFile = { label: "Choose a file…", onClick: pickFile };

// source: { url } or { data: Uint8Array }; name only for the title
async function openPdf(source, name) {
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

eventBus.on("pagesinit", () => {
  viewer.currentScaleValue = "page-width";
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
$("fit").addEventListener("click", () => (viewer.currentScaleValue = "page-width"));
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

// --- Start -------------------------------------------------------------------------------------
const requested = new URLSearchParams(location.search).get("file");
if (requested) openUrl(requested);
else {
  notice("Open a PDF", "Choose a PDF file or drop it onto this window. Nothing leaves your computer.", [
    { ...chooseFile, primary: true }
  ]);
}
