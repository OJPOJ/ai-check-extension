const $ = (id) => document.getElementById(id);

// Werte aus training/EVAL_RESULTS.md (100er-Testsample, HC3-Holdout, CPU) -
// kleine Stichprobe, dient als Startpunkt, nicht als Garantie.
const LOCAL_MODEL_INFO = {
  tmr:
    "<b>TMR</b> (RoBERTa-base, 125M). ~62ms/Text, ~900MB RAM, 25er-Batch ~1,6s. " +
    "AUROC 0.91 im Test. Empfohlen fürs Mitlaufen im Hintergrund.",
  desklib:
    "<b>desklib</b> (DeBERTa-v3-large, 430M). ~4,9s/Text, ~4,65GB RAM, 25er-Batch ~2 Minuten. " +
    "AUROC 0.998 im Test. Deutlich genauer, aber langsam – eher für „Nur auf Knopfdruck“."
};

const BROWSER_MODEL_INFO = {
  tmr:
    "Einmaliger Download von Hugging Face (126 MB, öffentlich, kein Konto/Token nötig), danach offline " +
    "nutzbar – bewertet werden die Texte nur lokal. Englisch trainiert – deutsche Texte können falsch " +
    "eingestuft werden. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md.",
  desklib:
    "Lädt einmalig das Originalmodell von Hugging Face (1,7 GB, öffentlich, kein Konto/Token nötig) und " +
    "wandelt es direkt im Browser in eine kompakte 8-Bit-Version um (~475 MB auf der Platte, gleiche " +
    "Genauigkeit). Danach offline nutzbar. Englisch trainiert. MIT-Lizenz, Details in THIRD_PARTY_NOTICES.md."
};

const TEXT_FIELDS = ["localUrl", "customUrl", "customModel", "hfModel", "hfAiLabel"];
const SECRET_FIELDS = ["customApiKey", "hfToken"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

function showStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

function parseSites(text) {
  const sites = text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, ""))
    .filter(Boolean);
  return [...new Set(sites)];
}

function readForm() {
  const cfg = {
    enabled: $("enabled").checked,
    scanMode: radioValue("scanMode"),
    sites: parseSites($("sites").value),
    provider: radioValue("provider"),
    browserModel: radioValue("browserModel") || AIVSAI.DEFAULTS.browserModel,
    localModel: $("localModel").value,
    yellowFrom: parseFloat($("yellowFrom").value),
    redFrom: parseFloat($("redFrom").value),
    showGreen: $("showGreen").checked,
    showBadge: $("showBadge").checked,
    lazyScan: $("lazyScan").checked
  };
  for (const f of TEXT_FIELDS) cfg[f] = $(f).value.trim();
  cfg.localUrl ||= AIVSAI.DEFAULTS.localUrl;
  const secrets = {};
  for (const f of SECRET_FIELDS) secrets[f] = $(f).value.trim();
  return { cfg, secrets };
}

function endpointUrl(cfg) {
  if (cfg.provider === "browser") return null;
  if (cfg.provider === "custom") return cfg.customUrl;
  if (cfg.provider === "huggingface") return "https://router.huggingface.co/";
  return cfg.localUrl;
}

// Liefert die Origin, für die eine optionale Host-Berechtigung nötig ist (oder null).
function requiredOrigin(cfg) {
  const endpoint = endpointUrl(cfg);
  if (!endpoint) return null; // Browser-Modell: Download per CORS, keine Host-Berechtigung nötig
  const url = new URL(endpoint); // wirft bei ungültiger URL
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL muss mit http:// oder https:// beginnen");
  if (LOOPBACK_HOSTS.has(url.hostname)) return null; // im Manifest bereits erlaubt
  return `${url.protocol}//${url.hostname}/*`;
}

function validate(cfg) {
  if (cfg.provider === "custom" && !cfg.customUrl) return "Bitte eine Endpunkt-URL angeben.";
  if (cfg.provider === "huggingface" && !cfg.hfModel) return "Bitte eine Modell-ID angeben.";
  if (cfg.yellowFrom >= cfg.redFrom) return "„Gelb ab“ muss kleiner als „Rot ab“ sein.";
  return null;
}

// Muss synchron im Klick-Handler starten, sonst verweigert Chrome den Berechtigungsdialog.
function saveFromClick() {
  const { cfg, secrets } = readForm();
  const invalid = validate(cfg);
  if (invalid) {
    showStatus(invalid, "err");
    return Promise.resolve(false);
  }
  let origin;
  try {
    origin = requiredOrigin(cfg);
  } catch (err) {
    showStatus(`Ungültige URL: ${err.message}`, "err");
    return Promise.resolve(false);
  }
  const permission = origin ? chrome.permissions.request({ origins: [origin] }) : Promise.resolve(true);
  return permission.then(async (granted) => {
    if (!granted) {
      showStatus(`Zugriff auf ${origin.replace("/*", "")} nicht erlaubt – Backend nicht erreichbar.`, "err");
      return false;
    }
    await Promise.all([chrome.storage.sync.set(cfg), chrome.storage.local.set(secrets)]);
    $("sites").value = cfg.sites.join("\n");
    return true;
  });
}

function renderProvider() {
  const provider = radioValue("provider");
  document.querySelectorAll(".provider-fields").forEach((el) => (el.hidden = el.dataset.provider !== provider));
  $("localModelInfo").innerHTML = LOCAL_MODEL_INFO[$("localModel").value] || "";
  $("browserModelInfo").textContent = BROWSER_MODEL_INFO[radioValue("browserModel")] || "";

  let target = null;
  if (provider === "huggingface") target = "Hugging Face (router.huggingface.co)";
  if (provider === "custom") {
    try {
      target = new URL($("customUrl").value).host;
    } catch {
      target = "den eingetragenen Server";
    }
  }
  if (provider === "local") {
    try {
      const h = new URL($("localUrl").value || AIVSAI.DEFAULTS.localUrl).hostname;
      if (!LOOPBACK_HOSTS.has(h)) target = h;
    } catch {
      // ungültige URL wird beim Speichern gemeldet
    }
  }
  $("privacyWarn").hidden = !target;
  $("privacyTarget").textContent = target || "";
}

// --- Browser-Modell: Status, Download, Löschen ---

let modelState = null; // letzte Antwort von MODEL_STATUS: { models: { tmr: {...}, desklib: {...} }, threads }
const selectedModel = () => radioValue("browserModel") || AIVSAI.DEFAULTS.browserModel;

function formatMB(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2).replace(".", ",")} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}

function renderProgress(p) {
  $("modelProgress").hidden = false;
  if (!p?.total) {
    $("modelProgress").removeAttribute("value"); // unbestimmt, bis die erste Größe bekannt ist
    $("modelStatus").textContent = "Lade herunter…";
    return;
  }
  $("modelProgress").value = p.loaded / p.total;
  const verb = selectedModel() === "desklib" ? "Lade und wandle um…" : "Lade herunter…";
  $("modelStatus").textContent = `${verb} ${formatMB(p.loaded)} von ${formatMB(p.total)}`;
}

function renderModel() {
  const key = selectedModel();
  const st = modelState?.ok ? modelState.models?.[key] : null;
  $("modelDownload").textContent = `Herunterladen (${AIVSAI.BROWSER_MODELS[key].download})`;
  $("modelDownload").hidden = !!(st && (st.downloaded || st.downloading));
  $("modelDelete").hidden = !st?.downloaded;
  $("modelProgress").hidden = true;
  if (!modelState) {
    $("modelStatus").textContent = "Prüfe…";
  } else if (!modelState.ok) {
    $("modelStatus").textContent = `Fehler: ${modelState.error ?? "keine Antwort"}`;
  } else if (st.downloading) {
    renderProgress(st.downloading);
  } else if (st.downloaded) {
    const threads = modelState.threads === 1 ? "1 Thread" : `${modelState.threads} Threads`;
    $("modelStatus").textContent = `Heruntergeladen – bereit (${threads}).`;
  } else {
    $("modelStatus").textContent = "Noch nicht heruntergeladen.";
  }
}

async function refreshModel() {
  modelState = await chrome.runtime.sendMessage({ type: "MODEL_STATUS" });
  renderModel();
}

$("modelDownload").addEventListener("click", async () => {
  $("modelDownload").hidden = true;
  renderProgress(null);
  const st = await chrome.runtime.sendMessage({ type: "MODEL_DOWNLOAD", model: selectedModel() });
  if (!st?.ok) {
    modelState = st;
    renderModel();
  }
});

$("modelDelete").addEventListener("click", async () => {
  modelState = await chrome.runtime.sendMessage({ type: "MODEL_DELETE", model: selectedModel() });
  renderModel();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MODEL_PROGRESS" && msg.model === selectedModel()) {
    $("modelDownload").hidden = true;
    renderProgress(msg);
  } else if (msg?.type === "MODEL_DONE") {
    refreshModel();
    if (msg.model !== selectedModel()) return;
    if (msg.ok) showStatus("Modell heruntergeladen. Speichern nicht vergessen, falls neu gewählt.", "ok");
    else showStatus(`Download fehlgeschlagen: ${msg.error}`, "err");
  }
});

function renderScanMode() {
  $("sitesField").hidden = radioValue("scanMode") !== "sites";
}

function renderScale() {
  const y = parseFloat($("yellowFrom").value);
  const r = parseFloat($("redFrom").value);
  $("yellowFromValue").textContent = `${Math.round(y * 100)}%`;
  $("redFromValue").textContent = `${Math.round(r * 100)}%`;
  $("scale").innerHTML =
    `<div style="width:${y * 100}%;background:var(--green)"></div>` +
    `<div style="width:${Math.max(0, r - y) * 100}%;background:var(--yellow)"></div>` +
    `<div style="width:${(1 - Math.max(r, y)) * 100}%;background:var(--red)"></div>`;
}

function applyPreset() {
  const provider = radioValue("provider");
  const preset =
    provider === "local"
      ? AIVSAI.PRESETS[$("localModel").value]
      : provider === "browser"
        ? AIVSAI.PRESETS[selectedModel()]
        : AIVSAI.PRESETS.generic;
  $("yellowFrom").value = preset.yellowFrom;
  $("redFrom").value = preset.redFrom;
  renderScale();
}

async function init() {
  const [cfg, secrets] = await Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]);
  $("enabled").checked = cfg.enabled;
  setRadio("scanMode", cfg.scanMode);
  $("sites").value = cfg.sites.join("\n");
  setRadio("provider", cfg.provider);
  setRadio("browserModel", cfg.browserModel);
  $("localModel").value = cfg.localModel;
  for (const f of TEXT_FIELDS) $(f).value = cfg[f];
  for (const f of SECRET_FIELDS) $(f).value = secrets[f];
  $("yellowFrom").value = cfg.yellowFrom;
  $("redFrom").value = cfg.redFrom;
  $("showGreen").checked = cfg.showGreen;
  $("showBadge").checked = cfg.showBadge;
  $("lazyScan").checked = cfg.lazyScan;
  renderProvider();
  renderScanMode();
  renderScale();
  refreshModel();
}

// Popup und Tastenkürzel ändern "enabled"/"sites", während diese Seite offen sein kann -
// ohne Abgleich würde der nächste Klick auf Speichern den alten Formularstand zurückschreiben.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if ("enabled" in changes) $("enabled").checked = changes.enabled.newValue;
  if ("sites" in changes) $("sites").value = (changes.sites.newValue || []).join("\n");
});

document.querySelectorAll('input[name="provider"]').forEach((el) => el.addEventListener("change", renderProvider));
document.querySelectorAll('input[name="browserModel"]').forEach((el) =>
  el.addEventListener("change", () => {
    renderProvider();
    renderModel();
    applyPreset();
  })
);
document.querySelectorAll('input[name="scanMode"]').forEach((el) => el.addEventListener("change", renderScanMode));
["customUrl", "localUrl"].forEach((id) => $(id).addEventListener("input", renderProvider));
$("localModel").addEventListener("change", () => {
  renderProvider();
  applyPreset();
});
$("yellowFrom").addEventListener("input", renderScale);
$("redFrom").addEventListener("input", renderScale);
$("applyPreset").addEventListener("click", applyPreset);

$("save").addEventListener("click", () => {
  saveFromClick().then((ok) => ok && showStatus("Gespeichert.", "ok"));
});

$("test").addEventListener("click", () => {
  saveFromClick().then(async (ok) => {
    if (!ok) return;
    showStatus("Teste Verbindung… (lädt ggf. erst das Modell)");
    $("test").disabled = true;
    const r = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER" });
    $("test").disabled = false;
    if (r?.ok) {
      showStatus(`OK – ${r.provider} antwortet in ${r.ms} ms (Beispieltext: ${typeof r.score === "number" ? Math.round(r.score * 100) + "%" : "kein"} KI-Score).`, "ok");
    } else {
      showStatus(`Fehler bei ${r?.provider ?? "Backend"}: ${r?.error ?? "keine Antwort"}`, "err");
    }
  });
});

init();
