// Own result window for a single check of text that has no content script to show a popover: selected text in
// the browser's PDF viewer (background.js, openSelectionCheck), or text the user pastes (popup, "Check pasted
// text…", issue #16: PDF, mail client, document). Same verdict as the popover on pages (manual-check.js).
// Deliberately no feedback collection here - the text may come from a document - so nothing is stored.
const $ = (id) => document.getElementById(id);
function show(part) {
  for (const id of ["paste", "status", "error", "result", "actions", "excerpt"]) {
    if (id in part) $(id).hidden = !part[id];
  }
}

function showError(message) {
  $("error").textContent = message;
  show({ status: false, error: true, result: false });
}

function showExcerpt(text) {
  $("excerpt").textContent = text.length > 400 ? `${text.slice(0, 400)}…` : text;
  show({ excerpt: true });
}

// Same transparency as on pages: single checks are allowed on blocked sites, but say so and name the destination
function blockedNotes(url, cfg) {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  const reason = host ? AIVSAI.blockReason(host, cfg) : null;
  if (!reason) return [];
  const target = AIVSAI.remoteTarget(cfg);
  return [
    "This site is on the blocklist – checked because you explicitly requested it.",
    ...(target ? [`The text was sent to ${target}.`] : [])
  ];
}

async function loadConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]);
  return { ...AIVSAI.DEFAULTS, ...sync, ...AIVSAI.SECRET_DEFAULTS, ...local };
}

// persist: false for pasted text - no score fingerprint in the store (see bg/scoring.js)
function requestScore(item, persist) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "SCORE_BATCH", items: [item], manual: true, persist }, (resp) =>
      resolve(chrome.runtime.lastError ? null : resp)
    );
  });
}

async function check(fullText, url, cfg, force = false, persist = true) {
  const M = AIVSAI_MANUAL;
  show({ status: true, error: false, result: false, actions: false, excerpt: false });
  $("status").textContent = "Checking for AI…";
  const words = M.wordCount(fullText);
  if (!cfg.enabled) return showError("The extension is switched off.");
  if (words < M.MANUAL_MIN_WORDS) return showError(M.tooShort(words));

  const lang = await AIVSAI_LANG.detectAsync(fullText);
  const foreign = M.foreignOf(lang, cfg);
  if (foreign && !force) {
    $("pill").textContent = "not checked";
    $("pill").className = "pill";
    $("title").textContent = `Text in ${AIVSAI_LANG.name(foreign)}`;
    $("notes").replaceChildren(
      li(
        `The model only knows ${M.langList(AIVSAI.languages(cfg))}. In other languages the scores are ` +
          "not meaningful and often too high."
      )
    );
    const button = document.createElement("button");
    button.textContent = "Check anyway";
    button.addEventListener("click", () => check(fullText, url, cfg, true, persist));
    $("actions").replaceChildren(button);
    show({ status: false, result: true, actions: true });
    return;
  }

  const text = M.clipText(fullText, cfg);
  const id = "single_check";
  const resp = await requestScore({ id, text, lang }, persist);
  const p = resp?.scores?.[id];
  if (typeof p !== "number") {
    return showError(resp?.error || (resp ? "No score received." : "Extension unreachable – reload the extension."));
  }
  const truncated = text.length < fullText.length;
  const rec = {
    text,
    truncated,
    words,
    ...(truncated && { scoredWords: M.wordCount(text) }),
    p,
    model: resp.model,
    ...(foreign && { foreign })
  };
  const view = M.resultView(rec, cfg, blockedNotes(url, cfg));
  $("pill").textContent = view.pill.text;
  $("pill").className = `pill ${view.pill.level}`;
  $("title").textContent = view.title;
  $("notes").replaceChildren(...view.notes.map(li));
  show({ status: false, error: false, result: true, actions: false });
  showExcerpt(text);
}

function li(text) {
  const el = document.createElement("li");
  el.textContent = text;
  return el;
}

$("close").addEventListener("click", () => window.close());
document.addEventListener("keydown", (e) => e.key === "Escape" && window.close());

// Pasted text: same cleanup as a selection on a page (content.js), so the same text gets the same excerpt and score
const cleanText = (text) => text.replace(/\s+/g, " ").trim();

// Live hint under the text field: word count and whether the model will see all of it
function renderPasteCount(cfg) {
  const text = cleanText($("pasteText").value);
  const words = AIVSAI_MANUAL.wordCount(text);
  const clipped = AIVSAI_MANUAL.clipText(text, cfg);
  $("pasteCount").textContent = !words
    ? ""
    : clipped.length < text.length
      ? `${words} words – only the first ${AIVSAI_MANUAL.wordCount(clipped)} are scored (model limit).`
      : `${words} ${words === 1 ? "word" : "words"}`;
}

async function pasteMode() {
  document.title = "AI Content Flag – Check pasted text";
  let cfg = await loadConfig();
  show({ paste: true, status: false });
  $("pasteText").focus();
  $("pasteText").addEventListener("input", () => renderPasteCount(cfg));
  $("paste").addEventListener("submit", async (e) => {
    e.preventDefault();
    cfg = await loadConfig(); // settings may have changed while the window was open
    renderPasteCount(cfg);
    const text = cleanText($("pasteText").value);
    if (!text) return showError("Paste some text into the field first.");
    $("pasteCheck").disabled = true;
    try {
      await check(text, "", cfg, false, false);
    } finally {
      $("pasteCheck").disabled = false;
    }
  });
}

async function main() {
  if (new URLSearchParams(location.search).has("paste")) return pasteMode();
  const jobId = new URLSearchParams(location.search).get("job");
  const key = `selection:${jobId}`;
  const { [key]: job } = await chrome.storage.session.get(key);
  await chrome.storage.session.remove(key); // the text lives only in memory and only until this window has read it
  if (!job) return showError("Nothing to check – select text and use \"Check selected text for AI\" again.");
  if (job.error) return showError(job.error);
  await check(job.text, job.url || "", await loadConfig());
}

main().catch((err) => showError(String(err?.message || err)));
