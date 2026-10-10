// Guided setup page (background.js opens it on first install; reachable from settings and popup).
// Rule: no network access and no scanning before an explicit click. This page only asks the offscreen
// document for the cache status (MODEL_STATUS); the download starts with the button.
const $ = (id) => document.getElementById(id);

// Written for this page (no dataset, no third-party license). About 130 words each, so the "short text"
// rule does not apply. The second imitates typical chatbot style.
const SAMPLES = [
  {
    id: "human",
    label: "Sample A – written by a person",
    text:
      "Last Tuesday the bus broke down halfway to my sister's place, so I walked the rest, about forty minutes " +
      "along the canal in shoes that were definitely not made for it. Somewhere near the old brickworks a man was " +
      "fishing with what looked like a broom handle, and we ended up talking for a good quarter of an hour about " +
      "nothing in particular: his dog, the price of bait, why the swans never leave. I was late, obviously. My " +
      "sister had already started on the soup and pulled a face when I came in, blistered and grinning. Honestly, " +
      "I can't say it was a better day than if the bus had worked. But I remember it, and I couldn't tell you a " +
      "single thing about the Tuesday before, or the one after, or most of that whole autumn if I'm being straight."
  },
  {
    id: "ai",
    label: "Sample B – chatbot style",
    text:
      "Time management is an essential skill that can significantly improve both your personal and professional " +
      "life. By implementing a few simple strategies, you can enhance your productivity and achieve your goals more " +
      "effectively. First, it is important to prioritize your tasks based on urgency and importance. Second, " +
      "setting clear, measurable goals provides direction and motivation. Additionally, minimizing distractions, " +
      "such as social media notifications, allows you to maintain focus. Furthermore, taking regular breaks helps " +
      "prevent burnout and ensures sustained performance. In conclusion, effective time management is not about " +
      "doing more things; it is about doing the right things at the right time. By consistently applying these " +
      "principles, you can unlock your full potential and lead a more balanced, fulfilling life. Ultimately, the key " +
      "to success lies in consistency, discipline, and a willingness to adapt your approach as your needs evolve " +
      "over time, ensuring long-term growth and lasting satisfaction."
  }
];

const SCAN_MODES = [
  {
    value: "manual",
    title: "Only on button press",
    text: "Nothing is looked at until you press \"Scan page now\" in the popup or use the right-click menu. Most private."
  },
  {
    value: "sites",
    title: "Only on sites I choose",
    text: "Pages are scanned automatically only on sites you switch on yourself in the popup. Everywhere else, nothing happens."
  },
  {
    value: "all",
    title: "On all sites",
    text: "Every page you open is scanned automatically (except the blocklist). Paragraph text is still processed only by the " +
      "model you chose – with a browser model it stays on this computer."
  }
];

let config = { ...AIVSAI.DEFAULTS };
let modelState = null; // last MODEL_STATUS answer
let selected = null; // model key picked on this page (nothing preselected)
let step = 1;
let cancelling = false;

const RECOMMENDED = "desklib";
const browserModels = Object.entries(AIVSAI.MODELS).filter(([, m]) => m.browser);
const downloadingKey = () => browserModels.map(([k]) => k).find((k) => modelStatus(k)?.downloading);

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function formatMB(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const modelStatus = (key) => (modelState?.ok ? modelState.models?.[key] : null);
const inUse = () => config.provider === "browser" && modelStatus(config.browserModel)?.downloaded;

// --- steps ---------------------------------------------------------------

function showStep(n) {
  step = n;
  document.querySelectorAll("section[data-step]").forEach((s) => (s.hidden = Number(s.dataset.step) !== n));
  document.querySelectorAll("#steps li").forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle("current", i === n);
    li.classList.toggle("done", i < n);
  });
  if (n === 3) renderSamples();
  if (n === 4) renderHow();
  renderBg();
}

// Download running while the user is on another step
function renderBg() {
  const key = downloadingKey();
  const p = key && modelStatus(key).downloading;
  $("bgStatus").hidden = !key || step === 1;
  if (!key) return;
  const pct = p?.total ? ` ${Math.round((p.loaded / p.total) * 100)}%` : "…";
  $("bgStatus").textContent = `Downloading ${AIVSAI.MODELS[key].name}${pct} – keeps running in the background.`;
}

function renderHow() {
  $("howScan").textContent =
    config.scanMode === "all"
      ? "Open an article"
      : config.scanMode === "sites"
        ? "Open a site you want checked, click the icon and switch on \"Scan this site automatically\""
        : "Open an article, click the icon and press \"Scan page now\"";
}

// --- step 1: model -------------------------------------------------------

function facts(m) {
  const dl = el("dl", { className: "facts" });
  for (const [label, value] of [
    ["Download", m.browser.download],
    ["On disk", m.browser.setup.disk],
    ["Speed", m.browser.setup.speed],
    ["False alarms", m.browser.setup.falseAlarms]
  ]) {
    dl.append(el("dt", {}, label), el("dd", {}, value));
  }
  return dl;
}

function renderModels() {
  renderHero();
  const list = $("models");
  list.replaceChildren();
  for (const [key, m] of browserModels) {
    if (key === RECOMMENDED) continue;
    const card = el(
      "button",
      { type: "button", className: "option", ariaPressed: String(selected === key) },
      el("b", {}, m.title)
    );
    if (modelStatus(key)?.downloaded) card.append(el("span", { className: "badge neutral" }, "downloaded"));
    card.append(facts(m));
    card.addEventListener("click", () => {
      if (cancelling || downloadingKey()) return;
      selected = key;
      setStatus("");
      renderModels();
    });
    list.append(card);
  }
  renderDownload();
}

// Main path: the recommended model with one button (size and source are right next to it)
function renderHero() {
  const m = AIVSAI.MODELS[RECOMMENDED];
  const st = modelStatus(RECOMMENDED);
  const hero = $("hero");
  hero.replaceChildren(
    el("div", {}, el("span", { className: "title" }, m.title), el("span", { className: "badge" }, "recommended")),
    el("p", { className: "why" }, "Fewest false alarms of the three, also on shorter paragraphs. Slower (~1 s per paragraph) – " +
      "works best when it scans what you are reading.")
  );
  hero.append(facts(m));
  if (st?.downloaded) {
    hero.append(el("div", { className: "row" }, el("span", { className: "badge neutral" }, "downloaded – ready")));
    return;
  }
  const busy = !!downloadingKey();
  const button = el("button", { className: "primary", type: "button", disabled: busy },
    `Download ${m.name} (${m.browser.download})`);
  button.addEventListener("click", () => startDownload(RECOMMENDED));
  hero.append(
    el("div", { className: "row" }, button),
    el("p", { className: "small muted" },
      "One request to Hugging Face, no account, no page content sent. Converted to ~475 MB on your disk. " +
        "You can keep going while it downloads.")
  );
}

function renderDownload() {
  const panel = $("downloadPanel");
  panel.hidden = !selected;
  $("noModelNote").hidden = !!inUse() || !!selected || !!downloadingKey();
  $("continueNote").hidden = !downloadingKey();
  if (!selected) return;
  const m = AIVSAI.MODELS[selected];
  const st = modelStatus(selected);
  const downloading = st?.downloading;
  $("downloadInfo").replaceChildren(
    el("b", {}, m.name),
    document.createTextNode(
      `: clicking "Download" makes one request to Hugging Face (${m.browser.download}, public, no account). ` +
        "No page content is sent. Afterwards the model works offline."
    )
  );
  $("download").hidden = !!(st?.downloaded || downloading);
  $("download").textContent = `Download (${m.browser.download})`;
  $("cancel").hidden = !downloading;
  $("progress").hidden = !downloading;
  if (downloading) {
    renderProgress(downloading);
  } else if (st?.downloaded) {
    setStatus("Downloaded – ready.", "ok");
  } else if (!$("downloadStatus").dataset.keep) {
    setStatus("");
  }
}

// keep: renderDownload() does not wipe the text (errors, "cancelled")
function setStatus(text, kind = "", keep = kind === "err") {
  const node = $("downloadStatus");
  node.textContent = text;
  node.className = `small ${kind || "muted"}`;
  node.dataset.keep = keep ? "1" : "";
}

function renderProgress(p) {
  $("progress").hidden = false;
  const m = AIVSAI.MODELS[selected];
  if (!p?.total) {
    $("progress").removeAttribute("value");
    setStatus("Starting…");
    return;
  }
  $("progress").value = p.loaded / p.total;
  const verb = m.browser.build ? "Downloading and converting…" : "Downloading…";
  setStatus(`${verb} ${formatMB(p.loaded)} of ${formatMB(p.total)}`);
}

async function refreshModels() {
  modelState = await chrome.runtime.sendMessage({ type: "MODEL_STATUS" });
  selected ||= downloadingKey() ?? null;
  renderModels();
  renderBg();
}

async function saveModelChoice(key) {
  config.provider = "browser";
  const patch = { provider: "browser", browserModel: key };
  // adopt the starting values of the new model, unless the user has set own ones
  const old = AIVSAI.presetFor(config);
  if (config.yellowFrom === old.yellowFrom && config.redFrom === old.redFrom) {
    Object.assign(patch, AIVSAI.MODELS[key].thresholds);
  }
  config = { ...config, ...patch, browserModel: key };
  await chrome.storage.sync.set(patch);
}

async function startDownload(key) {
  selected = key;
  setStatus("");
  await saveModelChoice(key);
  renderModels();
  $("download").hidden = true;
  $("cancel").hidden = false;
  renderProgress(null);
  const st = await chrome.runtime.sendMessage({ type: "MODEL_DOWNLOAD", model: key });
  if (!st?.ok) {
    setStatus(`Download failed: ${st?.error ?? "no response"}`, "err");
    await refreshModels();
  } else {
    modelState = st;
    renderModels();
  }
}

$("download").addEventListener("click", () => startDownload(selected));

$("cancel").addEventListener("click", async () => {
  cancelling = true;
  $("cancel").hidden = true;
  setStatus("Cancelling…");
  modelState = await chrome.runtime.sendMessage({ type: "MODEL_CANCEL", model: selected });
  cancelling = false;
  renderModels();
  setStatus("Download cancelled. You can start it again.", "", true);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MODEL_PROGRESS" && msg.model === selected && !cancelling) {
    $("download").hidden = true;
    $("cancel").hidden = false;
    renderProgress(msg);
    modelState = { ...modelState, models: { ...modelState?.models, [msg.model]: { ...modelState?.models?.[msg.model], downloading: msg } } };
    renderBg();
  } else if (msg?.type === "MODEL_DONE") {
    refreshModels().then(() => {
      renderBg();
      if (step === 3) renderSamples();
      if (msg.model !== selected || msg.cancelled) return;
      if (msg.ok) setStatus("Downloaded – ready.", "ok");
      else setStatus(`Download failed: ${msg.error} – you can try again.`, "err");
      renderDownload();
    });
  }
});

$("later").addEventListener("click", () => showStep(2));
$("next1").addEventListener("click", () => showStep(2));

// --- step 2: scan mode ---------------------------------------------------

function renderModes() {
  const list = $("modes");
  list.replaceChildren();
  for (const mode of SCAN_MODES) {
    const card = el(
      "button",
      { type: "button", className: "option", ariaPressed: String(config.scanMode === mode.value) },
      el("b", {}, mode.title),
      el("div", { className: "small muted" }, mode.text)
    );
    card.addEventListener("click", async () => {
      config.scanMode = mode.value;
      await chrome.storage.sync.set({ scanMode: mode.value });
      renderModes();
    });
    list.append(card);
  }
}

$("back2").addEventListener("click", () => showStep(1));
$("next2").addEventListener("click", () => showStep(3));

// --- step 3: try it ------------------------------------------------------

const results = new Map(); // sample id -> { score, level }

function renderSamples() {
  const box = $("samples");
  box.replaceChildren();
  for (const s of SAMPLES) {
    const res = el("div", { className: "result" });
    const r = results.get(s.id);
    if (r) {
      res.append(
        el("span", { className: `pill ${r.level}` }, r.level === "uncertain" ? "uncertain" : `AI score ${Math.round(r.score * 100)}`),
        el("span", { className: "small muted" }, ` ${AIVSAI.LEVEL_TEXT?.[r.level] ?? ""}`)
      );
    }
    box.append(el("div", { className: "sample" }, el("b", {}, s.label), el("blockquote", {}, s.text), res));
  }
  const ready = !!inUse();
  const waiting = !ready && !!downloadingKey();
  $("sampleBlock").hidden = !ready && !waiting;
  $("noSamples").hidden = ready || waiting;
  $("score").disabled = !ready;
  if (waiting) $("scoreStatus").textContent = "The model is still downloading – you can score the samples when it is done.";
  else if (ready && $("scoreStatus").textContent.includes("still downloading")) $("scoreStatus").textContent = "";
}

$("score").addEventListener("click", async () => {
  $("score").disabled = true;
  $("scoreStatus").textContent = "Scoring on this computer…";
  const items = SAMPLES.map((s) => ({ id: s.id, text: s.text }));
  const resp = await chrome.runtime.sendMessage({ type: "SCORE_BATCH", items, manual: true });
  $("score").disabled = false;
  if (!resp?.ok) {
    $("scoreStatus").textContent = `Error: ${resp?.error ?? "no response"}`;
    return;
  }
  $("scoreStatus").textContent = "";
  for (const s of SAMPLES) {
    const score = resp.scores[s.id];
    if (typeof score !== "number") continue;
    const words = s.text.split(/\s+/).length;
    results.set(s.id, { score, level: AIVSAI.level(score, config, words) });
  }
  renderSamples();
});

$("back3").addEventListener("click", () => showStep(2));
$("next3").addEventListener("click", () => showStep(4));
$("back4").addEventListener("click", () => showStep(3));
$("finish").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
  else window.close();
});

// --- start ---------------------------------------------------------------

async function init() {
  config = { ...AIVSAI.DEFAULTS, ...(await chrome.storage.sync.get(AIVSAI.DEFAULTS)) };
  renderModes();
  showStep(1);
  await refreshModels();
}

init();
