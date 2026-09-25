const $ = (id) => document.getElementById(id);

// Domainlisten (Textarea, eine pro Zeile) - das Popup ändert sie auch, siehe storage.onChanged unten
const SITE_FIELDS = ["sites", "blockedSites", "unblockedSites"];
const CHECK_FIELDS = ["builtinBlocklist", "sensitiveHeuristic", "showGreen", "showBadge", "lazyScan", "feedbackButtons"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

// Felder aller Provider (auch der nicht gewählten - deren Werte bleiben beim Speichern erhalten)
const PROVIDER_FIELDS = Object.values(AIVSAI.PROVIDERS).flatMap((p) => p.fields);

const radioValue = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value;
const setRadio = (name, value) => {
  const el = document.querySelector(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
};

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}

function showStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = kind;
}

// --- Formular aus AIVSAI.PROVIDERS (config.js) und dem Modellkatalog (models.js) ---

function choiceCard(name, value, title, text) {
  return el(
    "label",
    { className: "choice" },
    el("input", { type: "radio", name, value }),
    el("div", {}, el("b", { textContent: title }), text ? el("span", { textContent: text }) : null)
  );
}

// Auswahl aus models.js, z.B. browserModel -> alle Modelle mit Abschnitt "browser"
function modelField(f) {
  const models = AIVSAI.catalog(f.catalog);
  const cards = models.map(([key, m]) => choiceCard(f.key, key, m.title, m[f.catalog].summary ?? m.summary));
  const hasInfo = models.some(([, m]) => m[f.catalog].info);
  return el(
    "div",
    { className: "field" },
    el("div", { className: "label", textContent: f.label }),
    el("div", { className: "choices" }, ...cards),
    hasInfo ? el("div", { className: "info", id: `${f.key}Info` }) : null
  );
}

function inputField(f) {
  const label = el("label", { htmlFor: f.key, textContent: f.label });
  if (f.note) label.append(" ", el("span", { className: "muted", textContent: `(${f.note})` }));
  const input = el("input", { type: f.type, id: f.key, placeholder: f.placeholder ?? "" });
  if (f.type === "password") input.autocomplete = "off";
  return el("div", { className: "field" }, label, input, f.hint ? el("div", { className: "hint", textContent: f.hint }) : null);
}

function buildProviderForms() {
  for (const [id, def] of Object.entries(AIVSAI.PROVIDERS)) {
    $("providerChoices").append(choiceCard("provider", id, def.title, def.description));
    const form = el("div", { className: "provider-fields" });
    form.dataset.provider = id;
    form.append(...def.fields.map((f) => (f.type === "model" ? modelField(f) : inputField(f))));
    const extra = $(`extra-${id}`);
    if (extra) form.append(extra.content.cloneNode(true));
    $("providerForms").append(form);
  }
}

// --- Lesen, Prüfen, Speichern ---

function parseSites(text) {
  const sites = text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, ""))
    .filter(Boolean);
  return [...new Set(sites)];
}

function readField(f) {
  const value = f.type === "model" ? radioValue(f.key) : $(f.key).value.trim();
  // leere optionale Felder fallen auf ihren Default zurück (z.B. die lokale Server-URL)
  return value || (f.required ? "" : f.default);
}

function readForm() {
  const cfg = {
    enabled: $("enabled").checked,
    scanMode: radioValue("scanMode"),
    provider: radioValue("provider"),
    yellowFrom: parseFloat($("yellowFrom").value),
    redFrom: parseFloat($("redFrom").value),
    scoreRetentionDays: parseInt($("scoreRetentionDays").value, 10)
  };
  const secrets = {};
  for (const f of PROVIDER_FIELDS) (f.secret ? secrets : cfg)[f.key] = readField(f);
  for (const f of SITE_FIELDS) cfg[f] = parseSites($(f).value);
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked;
  return { cfg, secrets };
}

// Aktuelle Formularwerte als Konfiguration (für Vorschau: Datenschutz-Hinweis, Presets)
function formConfig() {
  const { cfg, secrets } = readForm();
  return { ...secrets, ...cfg };
}

function validate(cfg, secrets) {
  const missing = AIVSAI.PROVIDERS[cfg.provider].fields.find((f) => f.required && !(f.secret ? secrets : cfg)[f.key]);
  if (missing) return `Bitte „${missing.label}“ angeben.`;
  if (cfg.yellowFrom >= cfg.redFrom) return "„Gelb ab“ muss kleiner als „Rot ab“ sein.";
  return null;
}

// Liefert die Origin, für die eine optionale Host-Berechtigung nötig ist (oder null).
function requiredOrigin(cfg) {
  const endpoint = AIVSAI.PROVIDERS[cfg.provider].endpoint(cfg);
  if (!endpoint) return null; // Browser-Modell: Download per CORS, keine Host-Berechtigung nötig
  const url = new URL(endpoint); // wirft bei ungültiger URL
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL muss mit http:// oder https:// beginnen");
  if (LOOPBACK_HOSTS.has(url.hostname)) return null; // im Manifest bereits erlaubt
  return `${url.protocol}//${url.hostname}/*`;
}

let dirty = false;

function setDirty(value) {
  dirty = value;
  if (value) showStatus("Ungespeicherte Änderungen", "dirty");
}

// Muss synchron im Klick-Handler starten, sonst verweigert Chrome den Berechtigungsdialog.
function saveFromClick() {
  const { cfg, secrets } = readForm();
  const invalid = validate(cfg, secrets);
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
    for (const f of SITE_FIELDS) $(f).value = cfg[f].join("\n");
    dirty = false;
    return true;
  });
}

// --- Anzeige ---

function renderProvider() {
  const cfg = formConfig();
  document.querySelectorAll(".provider-fields").forEach((form) => (form.hidden = form.dataset.provider !== cfg.provider));
  for (const f of PROVIDER_FIELDS) {
    if (f.type !== "model" || !$(`${f.key}Info`)) continue;
    $(`${f.key}Info`).textContent = AIVSAI.MODELS[radioValue(f.key)]?.[f.catalog].info || "";
  }
  const target = AIVSAI.remoteTarget(cfg);
  $("privacyWarn").hidden = !target;
  $("privacyTarget").textContent = target || "";
  $("privacyChars").textContent = AIVSAI.maxChars(cfg);
  renderPresetInfo();
}

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
  renderPresetInfo();
}

function renderPresetInfo() {
  const p = AIVSAI.presetFor(formConfig());
  const same = p.yellowFrom === parseFloat($("yellowFrom").value) && p.redFrom === parseFloat($("redFrom").value);
  $("presetInfo").textContent = same
    ? "entspricht der Empfehlung"
    : `Empfehlung: gelb ab ${Math.round(p.yellowFrom * 100)} %, rot ab ${Math.round(p.redFrom * 100)} %`;
}

function applyPreset() {
  const preset = AIVSAI.presetFor(formConfig());
  $("yellowFrom").value = preset.yellowFrom;
  $("redFrom").value = preset.redFrom;
  renderScale();
}

// --- Browser-Modell: Status, Download, Löschen ---

let modelState = null; // letzte Antwort von MODEL_STATUS: { models: { tmr: {...}, desklib: {...} }, threads }
const selectedModel = () => radioValue("browserModel") || AIVSAI.DEFAULTS.browserModel;

function formatMB(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2).replace(".", ",")} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function renderProgress(p) {
  $("modelProgress").hidden = false;
  if (!p?.total) {
    $("modelProgress").removeAttribute("value"); // unbestimmt, bis die erste Größe bekannt ist
    $("modelStatus").textContent = "Lade herunter…";
    return;
  }
  $("modelProgress").value = p.loaded / p.total;
  const verb = AIVSAI.MODELS[selectedModel()]?.browser.build ? "Lade und wandle um…" : "Lade herunter…";
  $("modelStatus").textContent = `${verb} ${formatMB(p.loaded)} von ${formatMB(p.total)}`;
}

function renderModel() {
  const key = selectedModel();
  const st = modelState?.ok ? modelState.models?.[key] : null;
  $("modelDownload").textContent = `Herunterladen (${AIVSAI.MODELS[key].browser.download})`;
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

function bindModelButtons() {
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
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "MODEL_PROGRESS" && msg.model === selectedModel()) {
    $("modelDownload").hidden = true;
    renderProgress(msg);
  } else if (msg?.type === "MODEL_DONE") {
    refreshModel();
    if (msg.model !== selectedModel()) return;
    if (msg.ok) showStatus(dirty ? "Modell heruntergeladen – jetzt speichern, um es zu verwenden." : "Modell heruntergeladen.", "ok");
    else showStatus(`Download fehlgeschlagen: ${msg.error}`, "err");
  }
});

// --- Gespeicherte Bewertungen ---

async function refreshStore() {
  const r = await chrome.runtime.sendMessage({ type: "SCORE_STORE_INFO" });
  $("storeClear").disabled = !r?.count;
  if (!r?.ok) {
    $("storeStatus").textContent = `Fehler: ${r?.error ?? "keine Antwort"}`;
    return;
  }
  const n = r.count.toLocaleString("de-DE");
  const size = r.count ? ` · ca. ${formatMB(r.bytes)}` : "";
  $("storeStatus").textContent = `${n} ${r.count === 1 ? "Bewertung" : "Bewertungen"} gespeichert${size}`;
}

$("storeClear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SCORE_STORE_CLEAR" });
  refreshStore();
});

// --- Feedback-Sammlung ---

async function refreshFeedback() {
  const r = await chrome.runtime.sendMessage({ type: "FEEDBACK_INFO" });
  $("feedbackExport").disabled = !r?.count;
  $("feedbackClear").disabled = !r?.count && !r?.consentAt;
  if (!r?.ok) {
    $("feedbackStatus").textContent = `Fehler: ${r?.error ?? "keine Antwort"}`;
    return;
  }
  const consent = r.consentAt
    ? `Einwilligung vom ${new Date(r.consentAt).toLocaleDateString("de-DE")}`
    : "Keine Einwilligung erteilt";
  $("feedbackStatus").textContent = r.count
    ? `${r.count} ${r.count === 1 ? "Eintrag" : "Einträge"} (${r.human} Mensch, ${r.ai} KI; ` +
      `${r.guess} nur Eindruck; Modell lag ${r.disagree}× daneben) · ca. ${formatMB(r.bytes)} · ${consent}`
    : `Keine Einträge · ${consent}`;
}

$("feedbackExport").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "FEEDBACK_EXPORT" });
  if (!r?.ok) return showStatus(`Export fehlgeschlagen: ${r?.error ?? "keine Antwort"}`, "err");
  const jsonl = r.rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
  a.download = `aivsai-feedback-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$("feedbackClear").addEventListener("click", async () => {
  if (!confirm("Alle Feedback-Einträge löschen und die Einwilligung widerrufen?")) return;
  await chrome.runtime.sendMessage({ type: "FEEDBACK_CLEAR" });
  refreshFeedback();
});

function renderBuiltinInfo() {
  const list = globalThis.AIVSAI_BLOCKLIST;
  if (!list) {
    $("builtinInfo").textContent = "Liste fehlt – npm run build:blocklist ausführen.";
    return;
  }
  const date = new Date(list.generated).toLocaleDateString("de-DE");
  $("builtinInfo").textContent =
    `${list.count.toLocaleString("de-DE")} Domains, Stand ${date}. Quellen: UT1-Blacklists (Université Toulouse ` +
    `Capitole, CC BY-SA 4.0), FDIC und NCUA (US-Banken und Credit Unions), Wikidata (Banken DE/AT/CH/UK/US) ` +
    `und eine handverlesene Liste. Die Liste steht unter CC BY-SA 4.0.`;
}

// Navigation: aktuellen Abschnitt hervorheben
function watchSections() {
  const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.hash.slice(1), a]));
  const visible = new Set();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const e of entries) e.isIntersecting ? visible.add(e.target.id) : visible.delete(e.target.id);
      const first = [...links.keys()].find((id) => visible.has(id));
      links.forEach((a, id) => a.classList.toggle("active", id === first));
    },
    { rootMargin: "-64px 0px -40% 0px" }
  );
  document.querySelectorAll("main > section").forEach((s) => observer.observe(s));
}

async function init() {
  buildProviderForms();
  bindModelButtons();
  const [cfg, secrets] = await Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]);
  $("enabled").checked = cfg.enabled;
  setRadio("scanMode", cfg.scanMode);
  for (const f of SITE_FIELDS) $(f).value = cfg[f].join("\n");
  setRadio("provider", cfg.provider);
  for (const f of PROVIDER_FIELDS) {
    const value = (f.secret ? secrets : cfg)[f.key];
    if (f.type === "model") setRadio(f.key, value);
    else $(f.key).value = value;
  }
  $("yellowFrom").value = cfg.yellowFrom;
  $("redFrom").value = cfg.redFrom;
  for (const f of CHECK_FIELDS) $(f).checked = cfg[f];
  $("scoreRetentionDays").value = String(cfg.scoreRetentionDays);
  renderProvider();
  renderScanMode();
  renderScale();
  refreshModel();
  refreshStore();
  renderBuiltinInfo();
  refreshFeedback();
  watchSections();
  bindEvents();
}

// Popup und Tastenkürzel ändern "enabled" und die Domainlisten, während diese Seite offen sein kann -
// ohne Abgleich würde der nächste Klick auf Speichern den alten Formularstand zurückschreiben.
chrome.storage.onChanged.addListener((changes, area) => {
  // Einwilligung kommt aus dem Popover auf einer Webseite
  if (area === "local" && "feedbackConsentAt" in changes) refreshFeedback();
  if (area !== "sync") return;
  if ("enabled" in changes) $("enabled").checked = changes.enabled.newValue;
  for (const f of SITE_FIELDS) {
    if (f in changes) $(f).value = (changes[f].newValue ?? AIVSAI.DEFAULTS[f]).join("\n");
  }
});

function bindEvents() {
  // Hauptschalter wirkt sofort, wie im Popup
  $("enabled").addEventListener("change", () => chrome.storage.sync.set({ enabled: $("enabled").checked }));

  // Jede andere Eingabe wartet auf "Speichern"
  document.querySelector("main").addEventListener("input", () => setDirty(true));
  document.querySelector("main").addEventListener("change", (e) => {
    setDirty(true);
    const { name } = e.target;
    if (name === "provider") renderProvider();
    if (name === "scanMode") renderScanMode();
    // anderes Modell -> dessen Info, Download-Status und empfohlene Ampel
    if (e.target.type === "radio" && PROVIDER_FIELDS.some((f) => f.type === "model" && f.key === name)) {
      renderProvider();
      if (name === "browserModel") renderModel();
      applyPreset();
    }
  });
  ["customUrl", "localUrl"].forEach((id) => $(id).addEventListener("input", renderProvider));
  $("yellowFrom").addEventListener("input", renderScale);
  $("redFrom").addEventListener("input", renderScale);
  $("applyPreset").addEventListener("click", () => {
    applyPreset();
    setDirty(true);
  });

  $("save").addEventListener("click", save);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    }
  });

  $("test").addEventListener("click", () => {
    saveFromClick().then(async (ok) => {
      if (!ok) return;
      showStatus("Teste Verbindung… (lädt ggf. erst das Modell)");
      $("test").disabled = true;
      const r = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER" });
      $("test").disabled = false;
      if (r?.ok) {
        const score = typeof r.score === "number" ? `${Math.round(r.score * 100)}%` : "kein";
        showStatus(`OK – ${r.provider} antwortet in ${r.ms} ms (Beispieltext: ${score} KI-Score).`, "ok");
      } else {
        showStatus(`Fehler bei ${r?.provider ?? "Backend"}: ${r?.error ?? "keine Antwort"}`, "err");
      }
    });
  });
}

function save() {
  saveFromClick().then((ok) => {
    if (!ok) return;
    showStatus("Gespeichert.", "ok");
    setTimeout(refreshStore, 300); // "Nicht speichern" löscht im Hintergrund
  });
}

init();
