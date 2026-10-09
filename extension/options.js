const $ = (id) => document.getElementById(id);

// Domain lists (textarea, one per line) - the popup changes them too, see storage.onChanged below
const SITE_FIELDS = ["sites", "blockedSites", "unblockedSites"];
const CHECK_FIELDS = ["builtinBlocklist", "sensitiveHeuristic", "showGreen", "showBadge", "lazyScan", "groupShortParagraphs", "feedbackButtons"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

// Fields of all providers (also the unselected ones - their values are kept on saving)
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
    $("providerForms").append(form);
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

let dirty = false;

function setDirty(value) {
  dirty = value;
  if (value) showStatus("Unsaved changes", "dirty");
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
    for (const f of SITE_FIELDS) $(f).value = cfg[f].join("\n");
    dirty = false;
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
    setDirty(true);
    renderProvider();
    if (r.ok) {
      applyPreset(); // adopt the suggested traffic light
      showStatus("Model checked – passed. Save to use it.", "ok");
    } else {
      showStatus("Model failed the check.", "err");
    }
  });
}

// --- Display ---

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
  renderCheck();
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

// --- Browser model: status, download, delete ---

let modelState = null; // last response from MODEL_STATUS: { models: { tmr: {...}, desklib: {...} }, threads }
const selectedModel = () => radioValue("browserModel") || AIVSAI.DEFAULTS.browserModel;

function formatMB(bytes) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

function renderProgress(p) {
  $("modelProgress").hidden = false;
  if (!p?.total) {
    $("modelProgress").removeAttribute("value"); // indeterminate until the first size is known
    $("modelStatus").textContent = "Downloading…";
    return;
  }
  $("modelProgress").value = p.loaded / p.total;
  const verb = AIVSAI.MODELS[selectedModel()]?.browser.build ? "Downloading and converting…" : "Downloading…";
  $("modelStatus").textContent = `${verb} ${formatMB(p.loaded)} of ${formatMB(p.total)}`;
}

function renderModel() {
  const key = selectedModel();
  const st = modelState?.ok ? modelState.models?.[key] : null;
  $("modelDownload").textContent = `Download (${AIVSAI.MODELS[key].browser.download})`;
  $("modelDownload").hidden = !!(st && (st.downloaded || st.downloading));
  $("modelDelete").hidden = !st?.downloaded;
  $("modelProgress").hidden = true;
  if (!modelState) {
    $("modelStatus").textContent = "Checking…";
  } else if (!modelState.ok) {
    $("modelStatus").textContent = `Error: ${modelState.error ?? "no response"}`;
  } else if (st.downloading) {
    renderProgress(st.downloading);
  } else if (st.downloaded) {
    const threads = modelState.threads === 1 ? "1 thread" : `${modelState.threads} threads`;
    $("modelStatus").textContent = `Downloaded – ready (${threads}).`;
  } else {
    $("modelStatus").textContent = "Not downloaded yet.";
  }
}

async function refreshModel() {
  modelState = await chrome.runtime.sendMessage({ type: "MODEL_STATUS" });
  renderModel();
}

function bindModelButtons() {
  $("modelDownload").addEventListener("click", async () => {
    const { download, askBeforeDownload } = AIVSAI.MODELS[selectedModel()].browser;
    const question =
      `The model downloads ${download} once. On mobile internet or with a limited data allowance ` +
      "better use Wi-Fi. Download now?";
    if (askBeforeDownload && !confirm(question)) return;
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
    if (msg.ok) showStatus(dirty ? "Model downloaded – save now to use it." : "Model downloaded.", "ok");
    else showStatus(`Download failed: ${msg.error}`, "err");
  }
});

// --- Stored scores ---

async function refreshStore() {
  const r = await chrome.runtime.sendMessage({ type: "SCORE_STORE_INFO" });
  $("storeClear").disabled = !r?.count;
  if (!r?.ok) {
    $("storeStatus").textContent = `Error: ${r?.error ?? "no response"}`;
    return;
  }
  const n = r.count.toLocaleString("en-US");
  const size = r.count ? ` · approx. ${formatMB(r.bytes)}` : "";
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
      `${r.guess} just impression; model was wrong ${r.disagree}×) · approx. ${formatMB(r.bytes)} · ${consent}`
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
  refreshModel();
  refreshStore();
  renderBuiltinInfo();
  refreshFeedback();
  watchSections();
  bindEvents();
}

// Popup and keyboard shortcut change "enabled" and the domain lists while this page may be open -
// without reconciliation the next click on Save would write the old form state back.
chrome.storage.onChanged.addListener((changes, area) => {
  // Consent comes from the popover on a web page
  if (area === "local" && "feedbackConsentAt" in changes) refreshFeedback();
  if (area !== "sync") return;
  if ("enabled" in changes) $("enabled").checked = changes.enabled.newValue;
  for (const f of SITE_FIELDS) {
    if (f in changes) $(f).value = (changes[f].newValue ?? AIVSAI.DEFAULTS[f]).join("\n");
  }
});

function bindEvents() {
  // Main switch takes effect immediately, as in the popup
  $("enabled").addEventListener("change", () => chrome.storage.sync.set({ enabled: $("enabled").checked }));

  // Every other input waits for "Save"
  document.querySelector("main").addEventListener("input", () => setDirty(true));
  document.querySelector("main").addEventListener("change", (e) => {
    setDirty(true);
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
    showStatus("Saved.", "ok");
    setTimeout(refreshStore, 300); // "Do not store" deletes in the background
  });
}

init();
