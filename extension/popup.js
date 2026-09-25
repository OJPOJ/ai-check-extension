const $ = (id) => document.getElementById(id);

let config = { ...AIVSAI.DEFAULTS };
let tab = null;
let host = "";

function sendToTab(msg) {
  return new Promise((resolve) => {
    if (!tab?.id) return resolve(null);
    chrome.tabs.sendMessage(tab.id, msg, (resp) => {
      // kein Content-Script (chrome://, Web Store, PDF-Viewer, Tab vor Installation geöffnet)
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
    `<span style="left:${y}%">${Math.round(y)}%</span><span style="left:${r}%">${Math.round(r)}%</span>`;
}

function renderSite() {
  const supported = /^https?:$/.test(tab?.url ? new URL(tab.url).protocol : "");
  $("host").textContent = supported ? host : "Diese Seite";
  const reason = supported ? AIVSAI.blockReason(host, config) : null;
  $("siteSwitch").hidden = !supported || !!reason || config.scanMode === "manual";
  $("scanNow").disabled = !supported || !!reason;
  $("blockToggle").hidden = !supported;
  $("blockToggle").textContent = reason ? "Von der Sperrliste nehmen" : "Hier nie scannen (Sperrliste)";
  const siteAuto = $("siteAuto");

  if (!supported) {
    $("siteHint").textContent = "Hier kann nicht gescannt werden";
  } else if (reason) {
    $("siteHint").textContent =
      reason === "builtin" ? "Mitgelieferte Sperrliste (Bank/Mail) – wird nie gescannt" : "Sperrliste – wird nie gescannt";
  } else if (config.scanMode === "all") {
    siteAuto.checked = true;
    siteAuto.disabled = true;
    $("siteHint").textContent = "Automatisch – alle Seiten werden gescannt";
  } else if (config.scanMode === "sites") {
    siteAuto.disabled = false;
    siteAuto.checked = AIVSAI.siteMatches(host, config.sites);
    $("siteHint").textContent = siteAuto.checked ? "Wird automatisch gescannt" : "Nur auf Knopfdruck";
  } else {
    $("siteHint").textContent = "Nur auf Knopfdruck";
  }
}

function renderStats(stats) {
  const set = (id, v) => ($(id).textContent = v ?? "–");
  if (!stats) {
    ["cRed", "cYellow", "cGreen"].forEach((id) => set(id));
    $("pending").textContent = "";
    return;
  }
  set("cRed", stats.red);
  set("cYellow", stats.yellow);
  set("cGreen", stats.green);
  $("scanNow").textContent = stats.active ? "Seite neu scannen" : "Diese Seite jetzt scannen";
  // Heuristik aus dem Content-Script - kennt das Popup nicht aus den Einstellungen
  if (stats.blockReason === "sensitive") {
    $("siteHint").textContent = "Passwort-/Zahlungsfeld erkannt – wird nicht gescannt";
    $("siteSwitch").hidden = true;
    $("scanNow").disabled = true;
  }

  if (stats.error) {
    $("pending").textContent = `Fehler: ${stats.error}`;
  } else if (stats.pending) {
    $("pending").textContent = `${stats.pending} Absatz/Absätze werden geprüft…`;
  } else if (stats.deferred) {
    $("pending").textContent = `${stats.deferred} weitere Absätze werden beim Scrollen geprüft.`;
  } else if (stats.active && !stats.red && !stats.yellow && !stats.green) {
    $("pending").textContent = "Keine ausreichend langen Textabsätze gefunden.";
  } else if (stats.blocked) {
    $("pending").textContent = "Keine automatische Prüfung – einzelne Stellen per Rechtsklick.";
  } else if (!stats.active) {
    $("pending").textContent = "Auf dieser Seite nicht aktiv.";
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
    h?.ok === true ? h.detail || "Erreichbar" : h?.ok === false ? h.error || "Fehler" : "Noch nicht verwendet";
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

// Das Content-Script meldet jede Änderung selbst (STATS geht an Background und Popup) - kein Polling
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
    // eigene Einträge entfernen; greift dann noch die mitgelieferte Liste, Ausnahme für diesen Host
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
    $("pending").textContent = "Seite einmal neu laden, dann erneut versuchen.";
    return;
  }
  renderStats(stats);
});

$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

init();
