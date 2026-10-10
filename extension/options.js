const $ = (id) => document.getElementById(id);

// Domain lists (textarea, one per line) - the popup changes them too, see storage.onChanged below
const SITE_FIELDS = ["sites", "blockedSites", "unblockedSites"];
const CHECK_FIELDS = ["builtinBlocklist", "sensitiveHeuristic", "showGreen", "showBadge", "lazyScan", "groupShortParagraphs", "feedbackButtons", "allowPdfExternal"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

// Fields of all providers (also the unselected ones - their values are kept on saving)
const PROVIDER_FIELDS = Object.values(AIVSAI.PROVIDERS).flatMap((p) => p.fields);

// Everything outside the browser model needs an explicit confirmation ("Use this backend"): it asks for host
// permissions (only possible in a click handler) and, for most providers, needs a passed "Check model" first.
// All other settings are saved as soon as they change.
const REMOTE_FIELDS = Object.entries(AIVSAI.PROVIDERS)
  .filter(([id]) => id !== "browser")
  .flatMap(([, p]) => p.fields);
const NOT_AUTOSAVED = new Set(["enabled", "modelChecks", ...REMOTE_FIELDS.map((f) => f.key)]);

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

// --- Form from AIVSAI.PROVIDERS (config.js) and the model catalog (models.js) ---

function choiceCard(name, value, title, text) {
  return el(
    "label",
    { className: "choice" },
    el("input", { type: "radio", name, value }),
    el("div", {}, el("b", { textContent: title }), text ? el("span", { textContent: text }) : null)
  );
}

// Selection from models.js, e.g. browserModel -> all models with a "browser" section
function modelField(f) {
  const models = AIVSAI.catalog(f.catalog);
  // compact cards (the settings page should fit one screen): size and speed, the rest is in the info below
  const brief = (m) => {
    const s = m[f.catalog].setup;
    return s ? `${s.speed} · ${s.disk} on disk` : (m[f.catalog].summary ?? m.summary);
  };
  const cards = models.map(([key, m]) => choiceCard(f.key, key, m.title, brief(m)));
  const hasInfo = models.some(([, m]) => m[f.catalog].info);
  return el(
    "div",
    { className: "field" },
    el("div", { className: "label", textContent: f.label }),
    el("div", { className: "choices compact", role: "radiogroup", ariaLabel: f.label }, ...cards),
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

// "Check model" (bg/model-check.js) for providers with `check`
function checkField(id, def) {
  const button = el("button", { textContent: "Check model", id: `check-${id}` });
  button.addEventListener("click", () => runCheck(id));
  const lead =
    "Sends 40 English reference texts (20 each from humans and from ChatGPT, from HC3) to the model and checks " +
    "response format, direction, separation and speed. Also suggests starting values for the traffic light.";
  return el(
    "div",
    { className: "field model-check" },
    el("div", { className: "label", textContent: def.check === "required" ? "Check model (required)" : "Check model" }),
    el("div", { className: "hint", textContent: lead }),
    el(
      "div",
      { className: "row", style: "margin-top:8px" },
      el("div", { className: "hint", id: `check-${id}-status`, style: "margin:0" }),
      button
    ),
    el("ul", { className: "checks", id: `check-${id}-list` })
  );
}

function buildProviderForms() {
  for (const [id, def] of Object.entries(AIVSAI.PROVIDERS)) {
    $("providerChoices").append(choiceCard("provider", id, def.title, def.description));
    const form = el("div", { className: "provider-fields" });
    form.dataset.provider = id;
    form.append(...def.fields.map((f) => (f.type === "model" ? modelField(f) : inputField(f))));
    const extra = $(`extra-${id}`);
    if (extra) form.append(extra.content.cloneNode(true));
    if (def.check) form.append(checkField(id, def));
    // The browser model is a basic setting, the other backends live under "Advanced"
    (id === "browser" ? $("browserForm") : $("providerForms")).append(form);
  }
}

// --- Reading, validating, saving ---

function parseSites(text) {
  const sites = text
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/:].*$/, "").replace(/^www\./, ""))
    .filter(Boolean);
  return [...new Set(sites)];
}

function readField(f) {
  const value = f.type === "model" ? radioValue(f.key) : $(f.key).value.trim();
  // empty optional fields fall back to their default (e.g. the local server URL)
  return value || (f.required ? "" : f.default);
}

function readForm() {
  const cfg = {
    enabled: $("enabled").checked,
    scanMode: radioValue("scanMode"),
    provider: radioValue("provider"),
    yellowFrom: parseFloat($("yellowFrom").value),
    redFrom: parseFloat($("redFrom").value),
    scoreRetentionDays: parseInt($("scoreRetentionDays").value, 10),
    modelChecks
  };
  const secrets = {};
  for (const f of PROVIDER_FIELDS) (f.secret ? secrets : cfg)[f.key] = readField(f);
  for (const f of SITE_FIELDS) cfg[f] = parseSites($(f).value);
  for (const f of CHECK_FIELDS) cfg[f] = $(f).checked;
  return { cfg, secrets };
}

// Current form values as a configuration (for preview: privacy note, presets)
function formConfig() {
  const { cfg, secrets } = readForm();
  return { ...secrets, ...cfg };
}

function missingField(cfg, secrets) {
  const missing = AIVSAI.PROVIDERS[cfg.provider].fields.find((f) => f.required && !(f.secret ? secrets : cfg)[f.key]);
  return missing ? `Please enter "${missing.label}".` : null;
}

function validate(cfg, secrets) {
  const missing = missingField(cfg, secrets);
  if (missing) return missing;
  if (AIVSAI.PROVIDERS[cfg.provider].check === "required" && !AIVSAI.modelCheck(cfg)) {
    return checkFor(cfg)
      ? "The model failed the check – not usable as is."
      : "Please run \"Check model\" first – required for custom models before saving.";
  }
  if (cfg.yellowFrom >= cfg.redFrom) return "\"Yellow from\" must be smaller than \"Red from\".";
  return null;
}

// Origins that need an optional host permission (endpoint and, if applicable, metadata source)
function requiredOrigins(cfg) {
  const def = AIVSAI.PROVIDERS[cfg.provider];
  const origins = [...(def.origins ?? [])];
  const endpoint = def.endpoint(cfg);
  if (!endpoint) return origins; // Browser model: download via CORS, no host permission needed
  const url = new URL(endpoint); // throws on an invalid URL
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL must start with http:// or https://");
  if (!LOOPBACK_HOSTS.has(url.hostname)) origins.push(`${url.protocol}//${url.hostname}/*`); // Loopback: in the manifest
  return origins;
}

// Asks (started synchronously in the click handler) for the host permissions; false with a message if not granted
function requestOrigins(cfg) {
  let origins;
  try {
    origins = requiredOrigins(cfg);
  } catch (err) {
    showStatus(`Invalid URL: ${err.message}`, "err");
    return Promise.resolve(false);
  }
  if (!origins.length) return Promise.resolve(true);
  return chrome.permissions.request({ origins }).then((granted) => {
    const hosts = origins.map((o) => o.replace("/*", "")).join(", ");
    if (!granted) showStatus(`Access to ${hosts} not allowed – backend unreachable.`, "err");
    return granted;
  });
}

// Last state known to be in storage (sync + secrets): autosave only writes what differs from it
let saved = {};

let statusTimer;
function showSaved() {
  showStatus("Saved.", "ok");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    if ($("status").textContent === "Saved.") showStatus("");
  }, 3000);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Is a backend other than the browser model selected whose form differs from what is stored?
function backendPending(cfg, secrets) {
  if (cfg.provider === "browser") return false;
  if (cfg.provider !== saved.provider) return true;
  const form = { ...secrets, ...cfg };
  return (
    AIVSAI.PROVIDERS[cfg.provider].fields.some((f) => !same(form[f.key], saved[f.key])) ||
    !same(modelChecks[cfg.provider], saved.modelChecks?.[cfg.provider])
  );
}

// Writes every changed basic/advanced setting right away. Backend settings wait for "Use this backend".
let autosaveChain = Promise.resolve();
function autosave() {
  autosaveChain = autosaveChain.then(autosaveNow).catch((err) => showStatus(`Saving failed: ${err.message}`, "err"));
}

async function autosaveNow() {
  const { cfg, secrets } = readForm();
  const skip = new Set(NOT_AUTOSAVED);
  if (cfg.provider !== "browser") skip.add("provider");
  // the thresholds belong to the model of a backend that is not in use yet
  if (backendPending(cfg, secrets)) ["yellowFrom", "redFrom"].forEach((k) => skip.add(k));
  let invalid = null;
  if (cfg.yellowFrom >= cfg.redFrom) {
    invalid = '"Yellow from" must be smaller than "Red from" – not saved.';
    ["yellowFrom", "redFrom"].forEach((k) => skip.add(k));
  }
  const changes = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!skip.has(key) && !same(value, saved[key])) changes[key] = value;
  }
  if (Object.keys(changes).length) {
    await chrome.storage.sync.set(changes);
    Object.assign(saved, changes);
    if ("scoreRetentionDays" in changes) setTimeout(refreshStore, 300); // "Do not store" deletes in the background
    if (!invalid) showSaved();
  }
  if (invalid) showStatus(invalid, "err");
  else if ($("status").className === "err" && /must be smaller/.test($("status").textContent)) showStatus(""); // fixed
  renderProvider();
}

let autosaveTimer;
function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(autosave, 300);
}

// Must start synchronously in the click handler, otherwise Chrome refuses the permission dialog.
function saveFromClick() {
  const { cfg, secrets } = readForm();
  const invalid = validate(cfg, secrets);
  if (invalid) {
    showStatus(invalid, "err");
    return Promise.resolve(false);
  }
  return requestOrigins(cfg).then(async (granted) => {
    if (!granted) return false;
    await Promise.all([chrome.storage.sync.set(cfg), chrome.storage.local.set(secrets)]);
    Object.assign(saved, secrets, cfg);
    for (const f of SITE_FIELDS) $(f).value = cfg[f].join("\n");
    renderProvider();
    return true;
  });
}

// --- Check model ---

// Check results per provider: stored state, after a check the new one - it is stored with
// the form. The individual results (checks) only for display, not in storage (sync quota).
let modelChecks = {};
const checkDetails = {};

// Last check for the form values (including failed ones), otherwise null
function checkFor(cfg) {
  const check = modelChecks[cfg.provider];
  return check?.sig === AIVSAI.checkSignature(cfg) ? check : null;
}

function renderCheck() {
  const cfg = formConfig();
  const def = AIVSAI.PROVIDERS[cfg.provider];
  if (!def?.check || !$(`check-${cfg.provider}-status`)) return;
  const check = checkFor(cfg);
  const status = $(`check-${cfg.provider}-status`);
  if (!check) {
    status.textContent = def.check === "required" ? "Not checked yet – required before saving." : "Not checked yet.";
  } else if (!check.ok) {
    status.textContent = "Failed – see below.";
  } else {
    const version = check.info?.version ? `, version ${check.info.version}` : "";
    status.textContent =
      `Passed on ${new Date(check.at).toLocaleString("en-US")}: AUROC ${check.auroc.toFixed(2)}, ` +
      `~${Math.round(check.msPerText)} ms per text${version}.`;
  }
  status.style.color = check ? (check.ok ? "var(--green)" : "var(--red)") : "";
  const list = $(`check-${cfg.provider}-list`);
  const details = check && checkDetails[cfg.provider]?.sig === check.sig ? checkDetails[cfg.provider].checks : [];
  list.replaceChildren(...details.map((c) => el("li", { className: c.status, textContent: c.text })));
}

function runCheck(provider) {
  const { cfg, secrets } = readForm();
  const missing = missingField(cfg, secrets);
  if (missing) return showStatus(missing, "err");
  requestOrigins(cfg).then(async (granted) => {
    if (!granted) return;
    const button = $(`check-${provider}`);
    button.disabled = true;
    showStatus("Checking model… (40 reference texts, may download the model first)");
    const r = await chrome.runtime.sendMessage({ type: "CHECK_MODEL", cfg: { ...cfg, ...secrets } });
    button.disabled = false;
    if (!r?.sig) return showStatus(`Check failed: ${r?.error ?? "no response"}`, "err");
    const { checks, ...stored } = r;
    modelChecks = { ...modelChecks, [provider]: stored };
    checkDetails[provider] = { sig: r.sig, checks };
    renderProvider();
    if (r.ok) {
      applyPreset(); // adopt the suggested traffic light
      showStatus('Model checked – passed. Click "Use this backend" to use it.', "ok");
    } else {
      showStatus("Model failed the check.", "err");
    }
  });
}

// --- Display ---

function renderProvider() {
  const cfg = formConfig();
  // the browser model form is part of the basic settings and always visible
  document.querySelectorAll(".provider-fields").forEach((form) => {
    form.hidden = form.dataset.provider !== cfg.provider && form.dataset.provider !== "browser";
  });
  const storedProvider = AIVSAI.PROVIDERS[saved.provider];
  $("otherBackendNote").hidden = !storedProvider || saved.provider === "browser";
  if (storedProvider) {
    $("otherBackendNote").textContent =
      `Currently "${AIVSAI.providerLabel(saved)}" from the advanced settings is used. ` +
      'This model is used if you switch back to "In the browser".';
  }
  for (const f of PROVIDER_FIELDS) {
    if (f.type !== "model" || !$(`${f.key}Info`)) continue;
    $(`${f.key}Info`).textContent = AIVSAI.MODELS[radioValue(f.key)]?.[f.catalog].info || "";
  }
  const target = AIVSAI.remoteTarget(cfg);
  $("privacyWarn").hidden = !target;
  $("privacyTarget").textContent = target || "";
  $("privacyChars").textContent = AIVSAI.maxChars(cfg);
  renderPresetInfo();
  renderCheck();
  renderBackendActions(cfg);
}

// "Use this backend" only when something is waiting to be confirmed, "Test connection" only for servers
function renderBackendActions(cfg) {
  const remote = cfg.provider !== "browser";
  const secrets = Object.fromEntries(PROVIDER_FIELDS.filter((f) => f.secret).map((f) => [f.key, cfg[f.key]]));
  const pending = remote && backendPending(cfg, secrets);
  $("backendActions").hidden = !remote;
  $("test").hidden = !remote || AIVSAI.PROVIDERS[cfg.provider].endpoint(cfg) === null;
  $("save").hidden = !pending;
  $("pendingHint").textContent = pending ? "Not in use yet – confirm to apply these settings." : "";
}

function renderScanMode() {
  $("sitesField").hidden = radioValue("scanMode") !== "sites";
}

function renderScale() {
  const y = parseFloat($("yellowFrom").value);
  const r = parseFloat($("redFrom").value);
  $("yellowFromValue").textContent = String(Math.round(y * 100));
  $("redFromValue").textContent = String(Math.round(r * 100));
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
    ? "matches the recommendation"
    : `Recommendation: yellow from ${Math.round(p.yellowFrom * 100)}, red from ${Math.round(p.redFrom * 100)}`;
}

function applyPreset() {
  const preset = AIVSAI.presetFor(formConfig());
  $("yellowFrom").value = preset.yellowFrom;
  $("redFrom").value = preset.redFrom;
  renderScale();
}

// --- Browser model: status, download, delete (state machine in model-download.js) ---

const dl = AIVSAI_DOWNLOAD;
const selectedModel = () => radioValue("browserModel") || AIVSAI.DEFAULTS.browserModel;

function modelStatusText(key, st) {
  const { build } = AIVSAI.MODELS[key].browser;
  switch (st.phase) {
    case "unknown":
      return dl.error ? `Error: ${dl.error}` : "Checking…";
    case "downloading":
      if (!st.total) return "Downloading…";
      return `${build ? "Downloading and converting…" : "Downloading…"} ${dl.formatBytes(st.loaded)} of ${dl.formatBytes(st.total)}`;
    case "ready":
      return `Downloaded – ready (${dl.threads === 1 ? "1 thread" : `${dl.threads} threads`}).`;
    case "failed":
      return `Download failed: ${st.error}`;
    case "cancelled":
      return "Download cancelled.";
    default:
      return "Not downloaded yet.";
  }
}

function renderModel() {
  const key = selectedModel();
  const st = dl.state(key);
  $("modelDownload").textContent = `Download (${AIVSAI.MODELS[key].browser.download})`;
  $("modelDownload").hidden = st.phase === "downloading" || st.phase === "ready";
  $("modelDelete").hidden = st.phase !== "ready";
  $("modelProgress").hidden = st.phase !== "downloading";
  if (st.phase === "downloading") {
    if (st.total) $("modelProgress").value = st.loaded / st.total;
    else $("modelProgress").removeAttribute("value"); // indeterminate until the first size is known
  }
  $("modelStatus").textContent = modelStatusText(key, st);
}

// Report the end of a download in the status bar as well, once
const lastPhase = new Map();
function onModelChange() {
  renderModel();
  const key = selectedModel();
  const { phase } = dl.state(key);
  const before = lastPhase.get(key);
  lastPhase.set(key, phase);
  if (before !== "downloading") return;
  if (phase === "ready") showStatus("Model downloaded.", "ok");
  if (phase === "failed") showStatus(`Download failed: ${dl.state(key).error}`, "err");
}

function bindModelButtons() {
  dl.onChange(onModelChange);

  $("modelDownload").addEventListener("click", () => {
    const key = selectedModel();
    const { download, askBeforeDownload } = AIVSAI.MODELS[key].browser;
    const question =
      `The model downloads ${download} once. On mobile internet or with a limited data allowance ` +
      "better use Wi-Fi. Download now?";
    if (askBeforeDownload && !confirm(question)) return;
    dl.start(key);
  });

  $("modelDelete").addEventListener("click", () => dl.remove(selectedModel()));
}

// --- Stored scores ---

async function refreshStore() {
  const r = await chrome.runtime.sendMessage({ type: "SCORE_STORE_INFO" });
  $("storeClear").disabled = !r?.count;
  if (!r?.ok) {
    $("storeStatus").textContent = `Error: ${r?.error ?? "no response"}`;
    return;
  }
  const n = r.count.toLocaleString("en-US");
  const size = r.count ? ` · approx. ${dl.formatBytes(r.bytes)}` : "";
  $("storeStatus").textContent = `${n} ${r.count === 1 ? "score" : "scores"} stored${size}`;
}

$("storeClear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "SCORE_STORE_CLEAR" });
  refreshStore();
});

// --- Feedback collection ---

async function refreshFeedback() {
  const r = await chrome.runtime.sendMessage({ type: "FEEDBACK_INFO" });
  $("feedbackExport").disabled = !r?.count;
  $("feedbackClear").disabled = !r?.count && !r?.consentAt;
  if (!r?.ok) {
    $("feedbackStatus").textContent = `Error: ${r?.error ?? "no response"}`;
    return;
  }
  const consent = r.consentAt
    ? `Consent from ${new Date(r.consentAt).toLocaleDateString("en-US")}`
    : "No consent given";
  $("feedbackStatus").textContent = r.count
    ? `${r.count} ${r.count === 1 ? "entry" : "entries"} (${r.human} human, ${r.ai} AI; ` +
      `${r.guess} just impression; model was wrong ${r.disagree}×) · approx. ${dl.formatBytes(r.bytes)} · ${consent}`
    : `No entries · ${consent}`;
}

$("feedbackExport").addEventListener("click", async () => {
  const r = await chrome.runtime.sendMessage({ type: "FEEDBACK_EXPORT" });
  if (!r?.ok) return showStatus(`Export failed: ${r?.error ?? "no response"}`, "err");
  const jsonl = r.rows.map((row) => `${JSON.stringify(row)}\n`).join("");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([jsonl], { type: "application/x-ndjson" }));
  a.download = `aivsai-feedback-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
});

$("feedbackClear").addEventListener("click", async () => {
  if (!confirm("Delete all feedback entries and withdraw consent?")) return;
  await chrome.runtime.sendMessage({ type: "FEEDBACK_CLEAR" });
  refreshFeedback();
});

function renderBuiltinInfo() {
  const list = globalThis.AIVSAI_BLOCKLIST;
  if (!list) {
    $("builtinInfo").textContent = "List missing – run npm run build:blocklist.";
    return;
  }
  const date = new Date(list.generated).toLocaleDateString("en-US");
  $("builtinInfo").textContent =
    `${list.count.toLocaleString("en-US")} domains, as of ${date}. Sources: UT1 blacklists (Université Toulouse ` +
    `Capitole, CC BY-SA 4.0), FDIC and NCUA (US banks and credit unions), Wikidata (banks DE/AT/CH/UK/US) ` +
    `and a hand-picked list. The list is licensed under CC BY-SA 4.0.`;
}

// Navigation: highlight the current section
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
  saved = { ...cfg, ...secrets };
  $("enabled").checked = cfg.enabled;
  $("reportProblem").href = AIVSAI.reportUrl(cfg, {
    version: chrome.runtime.getManifest().version,
    browser: navigator.userAgent
  });
  modelChecks = cfg.modelChecks;
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
  dl.refresh();
  refreshStore();
  renderBuiltinInfo();
  refreshFeedback();
  watchSections();
  revealHash();
  bindEvents();
}

// Links like options.html#detection point into the folded "Advanced" section: open it first
function revealHash() {
  const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  const details = target?.closest("details");
  if (!details) return;
  details.open = true;
  target.scrollIntoView();
}
window.addEventListener("hashchange", revealHash);

// Popup and keyboard shortcut change "enabled" and the domain lists while this page may be open -
// without reconciliation the next click on Save would write the old form state back.
chrome.storage.onChanged.addListener((changes, area) => {
  // Consent comes from the popover on a web page
  if (area === "local" && "feedbackConsentAt" in changes) refreshFeedback();
  for (const [key, { newValue }] of Object.entries(changes)) saved[key] = newValue;
  if (area !== "sync") return;
  if ("enabled" in changes) $("enabled").checked = changes.enabled.newValue;
  for (const f of SITE_FIELDS) {
    if (!(f in changes)) continue;
    const list = changes[f].newValue ?? AIVSAI.DEFAULTS[f];
    // our own autosave comes back here: do not rewrite what is being typed
    if (!same(parseSites($(f).value), list)) $(f).value = list.join("\n");
  }
});

function bindEvents() {
  // Main switch takes effect immediately, as in the popup
  $("enabled").addEventListener("change", () => chrome.storage.sync.set({ enabled: $("enabled").checked }));

  // Everything else is saved as it changes (backend settings: "Use this backend")
  const main = document.querySelector("main");
  main.addEventListener("input", scheduleAutosave);
  // domain lists: tidy up (trim, lowercase, no duplicates) once the field is left
  main.addEventListener("focusout", (e) => {
    if (SITE_FIELDS.includes(e.target.id)) e.target.value = parseSites(e.target.value).join("\n");
  });
  main.addEventListener("change", (e) => {
    scheduleAutosave();
    const { name } = e.target;
    if (name === "provider") renderProvider();
    if (name === "scanMode") renderScanMode();
    // different model -> its info, download status and recommended traffic light
    if (e.target.type === "radio" && PROVIDER_FIELDS.some((f) => f.type === "model" && f.key === name)) {
      renderProvider();
      if (name === "browserModel") renderModel();
      applyPreset();
    }
  });
  // URL, model ID etc.: privacy note and whether the last check still matches the values
  $("providerForms").addEventListener("input", renderProvider);
  $("yellowFrom").addEventListener("input", renderScale);
  $("redFrom").addEventListener("input", renderScale);
  $("applyPreset").addEventListener("click", () => {
    applyPreset();
    scheduleAutosave();
  });

  $("save").addEventListener("click", save);
  // nothing to save by hand any more, but do not open the browser's "save page" dialog
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      autosave();
    }
  });

  $("test").addEventListener("click", () => {
    saveFromClick().then(async (ok) => {
      if (!ok) return;
      showStatus("Testing connection… (may download the model first)");
      $("test").disabled = true;
      const r = await chrome.runtime.sendMessage({ type: "TEST_PROVIDER" });
      $("test").disabled = false;
      if (r?.ok) {
        const score = typeof r.score === "number" ? `${Math.round(r.score * 100)}%` : "no";
        showStatus(`OK – ${r.provider} responds in ${r.ms} ms (sample text: ${score} AI score).`, "ok");
      } else {
        showStatus(`Error at ${r?.provider ?? "backend"}: ${r?.error ?? "no response"}`, "err");
      }
    });
  });
}

function save() {
  saveFromClick().then((ok) => {
    if (!ok) return;
    showSaved();
    setTimeout(refreshStore, 300); // "Do not store" deletes in the background
  });
}

init();
