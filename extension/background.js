importScripts("config.js");

const LOCAL_TIMEOUT_MS = 180_000; // großzügig: desklib auf langsamer CPU und beim ersten Laden des Modells
const REMOTE_TIMEOUT_MS = 30_000;
const CACHE_MAX = 5000;
const TEST_TEXT =
  "Maintaining a bicycle in good working condition requires regular attention to several " +
  "key components, including the tires, the chain and the brake pads.";

const BADGE_COLORS = { red: "#dc2626", yellow: "#a16207", green: "#16a34a", error: "#6b7280", off: "#6b7280" };

// providerSignature|textHash -> probability; überlebt Tab-Wechsel, nicht aber einen SW-Neustart
const cache = new Map();
let lastStatus = null; // { ok, error?, at, provider }

async function getConfig() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]);
  return { ...AIVSAI.DEFAULTS, ...sync, ...AIVSAI.SECRET_DEFAULTS, ...local };
}

// ---------------------------------------------------------------------------
// Provider: jeder bekommt eine Liste Texte und liefert pro Text eine
// KI-Wahrscheinlichkeit 0..1 (oder null, falls für diesen Text nichts kam).
// ---------------------------------------------------------------------------

const trimSlash = (url) => url.replace(/\/+$/, "");

async function httpError(resp) {
  let detail = "";
  try {
    const body = await resp.json();
    detail = body?.error?.message || body?.error || body?.detail || "";
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // Body ist kein JSON - Statuscode reicht
  }
  return new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
}

// Einheitlicher Vertrag für lokalen und eigenen Server:
//   POST {texts: [...], model?} -> {scores: [0..1, ...]}
async function postScoreContract(url, texts, model, apiKey, timeoutMs) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(model ? { model, texts } : { texts }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw await httpError(resp);
  const data = await resp.json();
  if (!Array.isArray(data.scores) || data.scores.length !== texts.length) {
    throw new Error("Antwort enthält kein passendes 'scores'-Array");
  }
  return data.scores.map((s) => (typeof s === "number" ? s : null));
}

const AI_LABEL = /^(ai|fake|machine|generated|ai[-_ ]generated|machine[-_ ]generated|chatgpt|gpt|llm|label_1)$/i;
const HUMAN_LABEL = /^(human|real|human[-_ ]written|label_0)$/i;

function probabilityFromLabels(labels, aiLabel) {
  const isAi = aiLabel ? (l) => l.toLowerCase() === aiLabel.toLowerCase() : (l) => AI_LABEL.test(l);
  const ai = labels.find((x) => isAi(String(x.label)));
  if (ai) return ai.score;
  // nur Top-1 zurückgekommen und das war die Mensch-Klasse
  const human = labels.find((x) => HUMAN_LABEL.test(String(x.label)));
  if (human && labels.length === 1) return 1 - human.score;
  return null;
}

async function scoreHuggingFace(texts, cfg) {
  if (!cfg.hfModel) throw new Error("Kein Hugging-Face-Modell konfiguriert");
  const headers = { "Content-Type": "application/json" };
  if (cfg.hfToken) headers.Authorization = `Bearer ${cfg.hfToken}`;
  const resp = await fetch(hfUrl(cfg), {
    method: "POST",
    headers,
    body: JSON.stringify({ inputs: texts }),
    signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS)
  });
  if (!resp.ok) throw await httpError(resp);
  let data = await resp.json();

  // Antwortformen normalisieren: [[{label,score},...], ...] pro Text,
  // bei einem Einzeltext teils [{label,score},...], bei Top-1 teils flach.
  if (!Array.isArray(data)) throw new Error("Unerwartete Antwort der Inference API");
  if (data.length && !Array.isArray(data[0])) {
    data = texts.length === 1 ? [data] : data.map((x) => [x]);
  }
  if (data.length !== texts.length) throw new Error("Anzahl Ergebnisse passt nicht zur Anzahl Texte");

  const scores = data.map((labels) => probabilityFromLabels(labels, cfg.hfAiLabel));
  if (scores.every((s) => s === null)) {
    const seen = data[0]?.map((x) => x.label).join(", ");
    throw new Error(`KI-Label nicht gefunden (Modell liefert: ${seen}) – in den Einstellungen setzen`);
  }
  return scores;
}

function hfUrl(cfg) {
  return `https://router.huggingface.co/hf-inference/models/${cfg.hfModel}`;
}

// ---------------------------------------------------------------------------
// Provider "browser": Modell läuft im Offscreen-Dokument (offscreen.js), weil ein
// Service Worker weder Worker-Threads für die WASM-Runtime noch DOM-APIs hat.
// ---------------------------------------------------------------------------

let creatingOffscreen = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creatingOffscreen ||= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "KI-Textklassifikation lokal per WebAssembly (ONNX Runtime Web)"
    })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function callOffscreen(type, payload = {}) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ target: "offscreen", type, ...payload });
  if (!resp?.ok) throw new Error(resp?.error || "Modell-Dokument antwortet nicht");
  return resp;
}

const PROVIDERS = {
  browser: {
    score: async (texts, cfg) => (await callOffscreen("score", { texts, model: cfg.browserModel })).scores
  },
  local: {
    score: (texts, cfg) =>
      postScoreContract(`${trimSlash(cfg.localUrl)}/v1/score`, texts, cfg.localModel, null, LOCAL_TIMEOUT_MS)
  },
  custom: {
    score: (texts, cfg) => {
      if (!cfg.customUrl) throw new Error("Keine Server-URL konfiguriert");
      return postScoreContract(cfg.customUrl, texts, cfg.customModel, cfg.customApiKey, REMOTE_TIMEOUT_MS);
    }
  },
  huggingface: { score: scoreHuggingFace }
};

function describeError(err, cfg) {
  if (err?.name === "TimeoutError") return "Zeitüberschreitung beim Backend";
  // fetch() meldet DNS-/Verbindungsfehler und fehlende Host-Berechtigung nur als TypeError
  if (err instanceof TypeError) {
    return cfg.provider === "local"
      ? `Lokaler Server nicht erreichbar (${cfg.localUrl}) – läuft shim_server.py?`
      : "Backend nicht erreichbar (Netzwerk oder fehlende Berechtigung – in den Einstellungen speichern)";
  }
  return String(err?.message || err);
}

function providerSignature(cfg) {
  return AIVSAI.PROVIDER_KEYS.map((k) => cfg[k]).join("\u0001");
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function scoreBatch(items) {
  const cfg = await getConfig();
  if (!cfg.enabled || !items?.length) return { ok: true, scores: {} };

  const provider = PROVIDERS[cfg.provider] || PROVIDERS.local;
  const sig = providerSignature(cfg);
  const scores = {};
  const missing = [];
  for (const it of items) {
    const hit = cache.get(`${sig}|${it.id}`);
    if (hit !== undefined) scores[it.id] = hit;
    else missing.push(it);
  }
  if (!missing.length) return { ok: true, scores };

  try {
    const result = await provider.score(missing.map((it) => it.text), cfg);
    missing.forEach((it, i) => {
      if (typeof result[i] !== "number") return;
      scores[it.id] = result[i];
      cachePut(`${sig}|${it.id}`, result[i]);
    });
    lastStatus = { ok: true, at: Date.now(), provider: AIVSAI.providerLabel(cfg) };
    return { ok: true, scores };
  } catch (err) {
    const error = describeError(err, cfg);
    lastStatus = { ok: false, error, at: Date.now(), provider: AIVSAI.providerLabel(cfg) };
    return { ok: false, error, scores };
  }
}

async function testProvider() {
  const cfg = await getConfig();
  const provider = PROVIDERS[cfg.provider] || PROVIDERS.local;
  const started = Date.now();
  try {
    const [score] = await provider.score([TEST_TEXT], cfg);
    return { ok: true, score, ms: Date.now() - started, provider: AIVSAI.providerLabel(cfg) };
  } catch (err) {
    return { ok: false, error: describeError(err, cfg), provider: AIVSAI.providerLabel(cfg) };
  }
}

// Leichter Check fürs Popup: lokal per /healthz, remote nur der letzte bekannte Stand
// (ein echter Probe-Request würde bei Cloud-Anbietern Kosten/Quota verbrauchen).
async function health() {
  const cfg = await getConfig();
  const provider = AIVSAI.providerLabel(cfg);
  if (cfg.provider === "browser") {
    try {
      const st = (await callOffscreen("status")).models[cfg.browserModel];
      if (st?.downloaded) return { ok: true, provider, detail: st.loaded ? "Modell geladen" : "Modell bereit" };
      if (st?.downloading) return { ok: false, provider, error: "Modell wird heruntergeladen…" };
      return { ok: false, provider, error: "Modell noch nicht heruntergeladen" };
    } catch (err) {
      return { ok: false, provider, error: String(err?.message || err) };
    }
  }
  if (cfg.provider === "local") {
    try {
      const resp = await fetch(`${trimSlash(cfg.localUrl)}/healthz`, { signal: AbortSignal.timeout(3000) });
      return resp.ok ? { ok: true, provider } : { ok: false, provider, error: `HTTP ${resp.status}` };
    } catch {
      return { ok: false, provider, error: "Lokaler Server nicht erreichbar" };
    }
  }
  if (lastStatus?.provider === provider) return lastStatus;
  return { ok: null, provider };
}

// ---------------------------------------------------------------------------
// Badge: Anzahl roter (sonst gelber) Absätze pro Tab, "AUS" wenn deaktiviert
// ---------------------------------------------------------------------------

async function updateBadge(tabId, stats) {
  const { enabled } = await chrome.storage.sync.get({ enabled: AIVSAI.DEFAULTS.enabled });
  let text = "";
  let color = BADGE_COLORS.off;
  if (!enabled) {
    text = "AUS";
  } else if (stats?.error) {
    text = "!";
    color = BADGE_COLORS.error;
  } else if (stats?.red) {
    text = String(stats.red);
    color = BADGE_COLORS.red;
  } else if (stats?.yellow) {
    text = String(stats.yellow);
    color = BADGE_COLORS.yellow;
  } else if (stats?.green) {
    text = "✓";
    color = BADGE_COLORS.green;
  }
  const target = tabId === undefined ? {} : { tabId };
  try {
    await chrome.action.setBadgeText({ ...target, text });
    await chrome.action.setBadgeBackgroundColor({ ...target, color });
  } catch {
    // Tab wurde inzwischen geschlossen
  }
}

// Tabs, deren Scan am fehlenden Modell gescheitert ist, sollen nach dem Download neu scannen
async function notifyTabs(msg) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) chrome.tabs.sendMessage(tab.id, msg, () => void chrome.runtime.lastError);
  }
}

async function toggleEnabled() {
  const { enabled } = await chrome.storage.sync.get({ enabled: AIVSAI.DEFAULTS.enabled });
  await chrome.storage.sync.set({ enabled: !enabled });
}

// ---------------------------------------------------------------------------
// Kontextmenü: markierten Text bzw. Absatz unter dem Mauszeiger manuell prüfen -
// unabhängig vom Scan-Modus, solange die Extension eingeschaltet ist
// ---------------------------------------------------------------------------

const MENU_ITEMS = {
  "check-selection": { title: "Markierten Text auf KI prüfen", contexts: ["selection"], message: "CHECK_SELECTION" },
  "check-element": { title: "Diesen Absatz auf KI prüfen", contexts: ["page", "link"], message: "CHECK_ELEMENT" }
};

async function createMenus() {
  const { enabled } = await chrome.storage.sync.get({ enabled: AIVSAI.DEFAULTS.enabled });
  await chrome.contextMenus.removeAll();
  for (const [id, { title, contexts }] of Object.entries(MENU_ITEMS)) {
    chrome.contextMenus.create({ id, title, contexts, visible: enabled }, () => void chrome.runtime.lastError);
  }
}

function setMenusVisible(visible) {
  for (const id of Object.keys(MENU_ITEMS)) {
    chrome.contextMenus.update(id, { visible }, () => void chrome.runtime.lastError);
  }
}

function sendToTab(tabId, msg, frameId = 0) {
  // kein Content-Script: chrome://-Seiten, Web Store, Tabs von vor der Installation
  chrome.tabs.sendMessage(tabId, msg, { frameId }, () => void chrome.runtime.lastError);
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = MENU_ITEMS[info.menuItemId];
  if (item && tab?.id !== undefined) sendToTab(tab.id, { type: item.message }, info.frameId);
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  updateBadge();
  createMenus();
  // Erstinstallation: Einstellungen öffnen, damit das Modell heruntergeladen werden kann
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => updateBadge());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && "enabled" in changes) {
    updateBadge();
    setMenusVisible(changes.enabled.newValue ?? AIVSAI.DEFAULTS.enabled);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-enabled") {
    await toggleEnabled();
    return;
  }
  const message = { "scan-page": "SCAN_NOW", "check-selection": "CHECK_SELECTION" }[command];
  if (!message) return;
  if (command === "check-selection") {
    const { enabled } = await chrome.storage.sync.get({ enabled: AIVSAI.DEFAULTS.enabled });
    if (!enabled) return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) sendToTab(tab.id, { type: message });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg?.type) {
    case "SCORE_BATCH":
      scoreBatch(msg.items).then(sendResponse);
      return true; // async response
    case "STATS":
      if (sender.tab?.id !== undefined) updateBadge(sender.tab.id, msg.stats);
      return false;
    case "HEALTH":
      health().then(sendResponse);
      return true;
    case "TEST_PROVIDER":
      testProvider().then(sendResponse);
      return true;
    case "MODEL_STATUS":
    case "MODEL_DOWNLOAD":
    case "MODEL_DELETE": {
      // Download startet nur; Ende kommt als MODEL_DONE vom Offscreen-Dokument
      const type = { MODEL_STATUS: "status", MODEL_DOWNLOAD: "download", MODEL_DELETE: "delete" }[msg.type];
      callOffscreen(type, { model: msg.model })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    case "MODEL_DONE":
      if (msg.ok) notifyTabs({ type: "MODEL_READY" });
      return false;
    default:
      return false;
  }
});
