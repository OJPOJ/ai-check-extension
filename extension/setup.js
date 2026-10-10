// Guided setup page (background.js opens it on first install; reachable from settings and popup).
// Rule: no network access and no scanning before an explicit click. This page only asks the offscreen
// document for the cache status (MODEL_STATUS); the download starts with the button.
// Texts: setup-content.js. Download state machine: model-download.js (shared with the settings).
const $ = (id) => document.getElementById(id);

const dl = AIVSAI_DOWNLOAD;
const CATALOG = Object.entries(AIVSAI.MODELS).filter(([, m]) => m.browser);
const RECOMMENDED = CATALOG.find(([, m]) => m.recommended)?.[0] ?? AIVSAI.DEFAULTS.browserModel;
const LAST_STEP = 4;

// All state of the page; render() derives everything else (download state lives in model-download.js)
const ui = {
  config: { ...AIVSAI.DEFAULTS },
  step: 1,
  selected: null, // model picked from the folded cards (nothing preselected)
  results: new Map(), // sample id -> { score, level }
  scoring: false,
  scoreError: null
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

// The model the download panel is about: the one downloading, else the one picked
const target = () => dl.active() ?? ui.selected;
// Is the model of the stored configuration downloaded (-> samples can be scored)?
const modelReady = () => ui.config.provider === "browser" && dl.state(ui.config.browserModel).phase === "ready";

// --- render --------------------------------------------------------------

function render() {
  document.querySelectorAll("section[data-step]").forEach((s) => (s.hidden = Number(s.dataset.step) !== ui.step));
  document.querySelectorAll("#steps li").forEach((li) => {
    const i = Number(li.dataset.step);
    li.classList.toggle("current", i === ui.step);
    li.classList.toggle("done", i < ui.step);
  });
  renderBackground();
  if (ui.step === 1) renderModelStep();
  if (ui.step === 2) renderModes();
  if (ui.step === 3) renderSamples();
  if (ui.step === 4) $("howScan").textContent = HOW_SCAN[ui.config.scanMode] ?? HOW_SCAN.manual;
}

// Download running while the user is on another step
function renderBackground() {
  const key = dl.active();
  $("bgStatus").hidden = !key || ui.step === 1;
  if (!key) return;
  const { loaded, total } = dl.state(key);
  const pct = total ? ` ${Math.round((loaded / total) * 100)}%` : "…";
  $("bgStatus").textContent = `Downloading ${AIVSAI.MODELS[key].name}${pct} – keeps running in the background.`;
}

// --- step 1: model -------------------------------------------------------

function facts(m) {
  const list = el("dl", { className: "facts" });
  const { download, setup } = m.browser;
  for (const [label, value] of [
    ["Download", download],
    ["On disk", setup.disk],
    ["Speed", setup.speed],
    ["False alarms", setup.falseAlarms]
  ]) {
    list.append(el("dt", {}, label), el("dd", {}, value));
  }
  return list;
}

function renderModelStep() {
  renderHero();
  const list = $("models");
  list.replaceChildren();
  for (const [key, m] of CATALOG) {
    if (key === RECOMMENDED) continue;
    const card = el(
      "button",
      { type: "button", className: "option", ariaPressed: String(ui.selected === key) },
      el("b", {}, m.title)
    );
    if (dl.state(key).phase === "ready") card.append(el("span", { className: "badge neutral" }, "downloaded"));
    card.append(facts(m));
    card.addEventListener("click", () => {
      if (dl.active()) return;
      ui.selected = key;
      render();
    });
    list.append(card);
  }
  renderPanel();
  $("continueNote").hidden = !dl.active();
  $("noModelNote").hidden = modelReady() || !!target();
}

// Main path: the recommended model with one button (size and source are right next to it)
function renderHero() {
  const m = AIVSAI.MODELS[RECOMMENDED];
  const hero = $("hero");
  hero.replaceChildren(
    el("div", {}, el("span", { className: "title" }, m.title), el("span", { className: "badge" }, "recommended")),
    el("p", { className: "why" }, m.browser.setup.pitch),
    facts(m)
  );
  if (dl.state(RECOMMENDED).phase === "ready") {
    hero.append(el("div", { className: "row" }, el("span", { className: "badge neutral" }, "downloaded – ready")));
    return;
  }
  const button = el(
    "button",
    { className: "primary", type: "button", disabled: !!dl.active() },
    `Download ${m.name} (${m.browser.download})`
  );
  button.addEventListener("click", () => startDownload(RECOMMENDED));
  hero.append(
    el("div", { className: "row" }, button),
    el(
      "p",
      { className: "small muted" },
      `One request to Hugging Face, no account, no page content sent. ${m.browser.setup.disk} on your disk. ` +
        "You can keep going while it downloads."
    )
  );
}

function panelStatus(key, st) {
  switch (st.phase) {
    case "downloading": {
      if (!st.total) return ["Starting…", ""];
      const verb = AIVSAI.MODELS[key].browser.build ? "Downloading and converting…" : "Downloading…";
      return [`${verb} ${dl.formatBytes(st.loaded)} of ${dl.formatBytes(st.total)}`, ""];
    }
    case "ready":
      return ["Downloaded – ready.", "ok"];
    case "failed":
      return [`Download failed: ${st.error} – you can try again.`, "err"];
    case "cancelled":
      return ["Download cancelled. You can start it again.", ""];
    default:
      return dl.error ? [`Error: ${dl.error}`, "err"] : ["", ""];
  }
}

function renderPanel() {
  const key = target();
  $("downloadPanel").hidden = !key;
  if (!key) return;
  const m = AIVSAI.MODELS[key];
  const st = dl.state(key);
  const downloading = st.phase === "downloading";
  $("downloadInfo").replaceChildren(
    el("b", {}, m.name),
    document.createTextNode(
      `: clicking "Download" makes one request to Hugging Face (${m.browser.download}, public, no account). ` +
        "No page content is sent. Afterwards the model works offline."
    )
  );
  $("download").hidden = downloading || st.phase === "ready";
  $("download").textContent = `Download (${m.browser.download})`;
  $("cancel").hidden = !downloading;
  const progress = $("progress");
  progress.hidden = !downloading;
  if (st.total) progress.value = st.loaded / st.total;
  else progress.removeAttribute("value"); // indeterminate until the first size is known
  const [text, kind] = panelStatus(key, st);
  const status = $("downloadStatus");
  status.textContent = text;
  status.className = `small ${kind || "muted"}`;
}

async function saveModelChoice(key) {
  const patch = { provider: "browser", browserModel: key };
  // adopt the starting values of the new model, unless the user has set own ones
  const old = AIVSAI.presetFor(ui.config);
  if (ui.config.yellowFrom === old.yellowFrom && ui.config.redFrom === old.redFrom) {
    Object.assign(patch, AIVSAI.MODELS[key].thresholds);
  }
  ui.config = { ...ui.config, ...patch };
  await chrome.storage.sync.set(patch);
}

async function startDownload(key) {
  ui.selected = key;
  await saveModelChoice(key);
  await dl.start(key); // fires render() on every state change
}

$("download").addEventListener("click", () => startDownload(ui.selected));
$("cancel").addEventListener("click", () => {
  const key = dl.active();
  if (key) dl.cancel(key);
});

// --- step 2: scan mode ---------------------------------------------------

function renderModes() {
  const list = $("modes");
  list.replaceChildren();
  for (const mode of SCAN_MODES) {
    const card = el(
      "button",
      { type: "button", className: "option", ariaPressed: String(ui.config.scanMode === mode.value) },
      el("b", {}, mode.title),
      el("div", { className: "small muted" }, mode.text)
    );
    card.addEventListener("click", async () => {
      ui.config.scanMode = mode.value;
      render();
      await chrome.storage.sync.set({ scanMode: mode.value });
    });
    list.append(card);
  }
}

// --- step 3: try it ------------------------------------------------------

function renderSamples() {
  const box = $("samples");
  box.replaceChildren();
  for (const s of SAMPLES) {
    const res = el("div", { className: "result" });
    const r = ui.results.get(s.id);
    if (r) {
      res.append(
        el("span", { className: `pill ${r.level}` }, r.level === "uncertain" ? "uncertain" : `AI score ${Math.round(r.score * 100)}`),
        el("span", { className: "small muted" }, ` ${AIVSAI.LEVEL_TEXT[r.level]}`)
      );
    }
    box.append(el("div", { className: "sample" }, el("b", {}, s.label), el("blockquote", {}, s.text), res));
  }
  const ready = modelReady();
  const waiting = !ready && !!dl.active();
  $("sampleBlock").hidden = !ready && !waiting;
  $("noSamples").hidden = ready || waiting;
  $("score").disabled = !ready || ui.scoring;
  $("scoreStatus").textContent = ui.scoring
    ? "Scoring on this computer…"
    : ui.scoreError
      ? `Error: ${ui.scoreError}`
      : waiting
        ? "The model is still downloading – you can score the samples when it is done."
        : "";
}

$("score").addEventListener("click", async () => {
  ui.scoring = true;
  ui.scoreError = null;
  render();
  const items = SAMPLES.map((s) => ({ id: s.id, text: s.text }));
  const resp = await chrome.runtime.sendMessage({ type: "SCORE_BATCH", items, manual: true });
  ui.scoring = false;
  if (!resp?.ok) {
    ui.scoreError = resp?.error ?? "no response";
  } else {
    for (const s of SAMPLES) {
      const score = resp.scores[s.id];
      if (typeof score !== "number") continue;
      ui.results.set(s.id, { score, level: AIVSAI.level(score, ui.config, s.text.split(/\s+/).length) });
    }
  }
  render();
});

// --- step 4: quick start -------------------------------------------------

// Users can rebind the shortcuts (chrome://extensions/shortcuts) - show the real ones
async function showShortcuts() {
  const commands = await chrome.commands.getAll();
  document.querySelectorAll("kbd[data-command]").forEach((kbd) => {
    const command = commands.find((c) => c.name === kbd.dataset.command);
    kbd.textContent = command?.shortcut || "not set";
  });
}

// --- navigation ----------------------------------------------------------

function go(step) {
  ui.step = Math.min(LAST_STEP, Math.max(1, step));
  render();
}

for (const [id, to] of Object.entries({ later: 2, next1: 2, back2: 1, next2: 3, back3: 2, next3: 4, back4: 3 })) {
  $(id).addEventListener("click", () => go(to));
}

$("finish").addEventListener("click", async () => {
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id !== undefined) chrome.tabs.remove(tab.id);
  else window.close();
});

// --- start ---------------------------------------------------------------

async function init() {
  ui.config = { ...AIVSAI.DEFAULTS, ...(await chrome.storage.sync.get(AIVSAI.DEFAULTS)) };
  dl.onChange(render);
  render();
  showShortcuts();
  await dl.refresh();
  ui.selected ||= dl.active();
  render();
}

init();
