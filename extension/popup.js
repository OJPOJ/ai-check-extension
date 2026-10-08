const $ = (id) => document.getElementById(id);

let config = { ...AIVSAI.DEFAULTS };
let tab = null;
let host = "";

function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!tab?.id) return resolve(null);
    chrome.tabs.sendMessage(tab.id, msg, (resp) => {
      // no content script (chrome://, Web Store, PDF viewer, tab opened before installation)
      resolve(chrome.runtime.lastError ? null : resp);
    });
  });
}

function renderScale() {
  const y = config.yellowFrom * 100;
  const r = config.redFrom * 100;
  $("scale").innerHTML =
    `<div style="width:${y}%;background:var(--green)"></div>` +
    `<div style="width:${r - y}%;background:var(--yellow)"></div>` +
    `<div style="width:${100 - r}%;background:var(--red)"></div>`;
  $("scaleLabels").innerHTML =
    `<span style="left:${y}%">${Math.round(y)}</span><span style="left:${r}%">${Math.round(r)}</span>`;
}

function renderSite() {
  const supported = /^https?:$/.test(tab?.url ? new URL(tab.url).protocol : "");
  $("host").textContent = supported ? host : "This page";
  const reason = supported ? AIVSAI.blockReason(host, config) : null;
  $("siteSwitch").hidden = !supported || !!reason || config.scanMode === "manual";
  $("scanNow").disabled = !supported || !!reason;
  $("blockToggle").hidden = !supported;
  $("blockToggle").textContent = reason ? "Remove from blocklist" : "Never scan here (blocklist)";
  const siteAuto = $("siteAuto");

  if (!supported) {
    $("siteHint").textContent = "Cannot scan here";
  } else if (reason) {
    $("siteHint").textContent =
      reason === "builtin" ? "Bundled blocklist (bank/mail) – is never scanned" : "Blocklist – is never scanned";
  } else if (config.scanMode === "all") {
    siteAuto.checked = true;
    siteAuto.disabled = true;
    $("siteHint").textContent = "Automatic – all sites are scanned";
  } else if (config.scanMode === "sites") {
    siteAuto.disabled = false;
    siteAuto.checked = AIVSAI.siteMatches(host, config.sites);
    $("siteHint").textContent = siteAuto.checked ? "Is scanned automatically" : "Only on button press";
  } else {
    $("siteHint").textContent = "Only on button press";
  }
}

function renderStats(stats) {
  const set = (id, v) => ($(id).textContent = v ?? "–");
  if (!stats) {
    ["cRed", "cYellow", "cGreen", "cUncertain"].forEach((id) => set(id));
    $("pending").textContent = "";
    return;
  }
  set("cRed", stats.red);
  set("cYellow", stats.yellow);
  set("cGreen", stats.green);
  set("cUncertain", stats.uncertain);
  $("scanNow").textContent = stats.active ? "Rescan page" : "Scan page now";
  // Heuristic from the content script - the popup does not know it from the settings
  if (stats.blockReason === "sensitive") {
    $("siteHint").textContent = "Password/payment field detected – is not scanned";
    $("siteSwitch").hidden = true;
    $("scanNow").disabled = true;
  }

  if (stats.error) {
    $("pending").textContent = `Error: ${stats.error}`;
  } else if (stats.pending) {
    $("pending").textContent = `${stats.pending} paragraph(s) being checked…`;
  } else if (stats.deferred) {
    $("pending").textContent = `${stats.deferred} more paragraphs will be checked on scrolling.`;
  } else if (stats.skipped) {
    const langs = AIVSAI.languages(config);
    $("pending").textContent =
      `${stats.skipped} paragraph(s) in another language not scored` +
      (langs ? ` – the model only knows ${langs.map(AIVSAI_LANG.name).join(", ")}.` : ".");
  } else if (stats.active && !stats.red && !stats.yellow && !stats.green && !stats.uncertain) {
    $("pending").textContent = "No sufficiently long paragraphs of text found.";
  } else if (stats.blocked) {
    $("pending").textContent = "No automatic check – single passages via right-click.";
  } else if (!stats.active) {
    $("pending").textContent = "Not active on this page.";
  } else {
    $("pending").textContent = "";
  }
}

async function refreshStats() {
  renderStats(await sendToTab({ type: "GET_STATS" }));
}

async function refreshHealth() {
  $("backendName").textContent = AIVSAI.providerLabel(config);
  const h = await chrome.runtime.sendMessage({ type: "HEALTH" });
  const dot = $("backendDot");
  dot.className = `dot ${h?.ok === true ? "green" : h?.ok === false ? "red" : "gray"}`;
  $("backendStatus").textContent =
    h?.ok === true ? h.detail || "Reachable" : h?.ok === false ? h.error || "Error" : "Not used yet";
}

function render() {
  $("enabled").checked = config.enabled;
  document.body.classList.toggle("off", !config.enabled);
  renderSite();
  renderScale();
}

async function init() {
  config = { ...AIVSAI.DEFAULTS, ...(await chrome.storage.sync.get(AIVSAI.DEFAULTS)) };
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    host = new URL(tab.url).hostname;
  } catch {
    host = "";
  }
  render();
  refreshStats();
  refreshHealth();
}

// The content script reports every change itself (STATS goes to background and popup) - no polling
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "STATS" && tab?.id !== undefined && sender.tab?.id === tab.id) renderStats(msg.stats);
});

$("enabled").addEventListener("change", async (e) => {
  config.enabled = e.target.checked;
  await chrome.storage.sync.set({ enabled: config.enabled });
  render();
});

$("siteAuto").addEventListener("change", async (e) => {
  const others = config.sites.filter((s) => !AIVSAI.siteMatches(host, [s]));
  config.sites = e.target.checked ? [...others, host] : others;
  await chrome.storage.sync.set({ sites: config.sites });
  renderSite();
});

$("blockToggle").addEventListener("click", async () => {
  const notHost = (list) => list.filter((s) => !AIVSAI.siteMatches(host, [s]));
  if (AIVSAI.blockReason(host, config)) {
    // remove own entries; if the bundled list still applies, add an exception for this host
    config.blockedSites = notHost(config.blockedSites);
    if (AIVSAI.blockReason(host, config)) config.unblockedSites = [...config.unblockedSites, host];
  } else {
    config.unblockedSites = notHost(config.unblockedSites);
    if (!AIVSAI.blockReason(host, config)) config.blockedSites = [...config.blockedSites, host];
  }
  await chrome.storage.sync.set({ blockedSites: config.blockedSites, unblockedSites: config.unblockedSites });
  renderSite();
  refreshStats();
});

$("scanNow").addEventListener("click", async () => {
  const stats = await sendToTab({ type: "SCAN_NOW" });
  if (!stats) {
    $("pending").textContent = "Reload the page once, then try again.";
    return;
  }
  renderStats(stats);
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

init();
