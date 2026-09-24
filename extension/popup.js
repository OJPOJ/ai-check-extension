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
  $("siteSwitch").hidden = !supported || config.scanMode === "manual";
  $("scanNow").disabled = !supported;
  const siteAuto = $("siteAuto");

  if (!supported) {
    $("siteHint").textContent = "Hier kann nicht gescannt werden";
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

  if (stats.error) {
    $("pending").textContent = `Fehler: ${stats.error}`;
  } else if (stats.pending) {
    $("pending").textContent = `${stats.pending} Absatz/Absätze werden geprüft…`;
  } else if (stats.deferred) {
    $("pending").textContent = `${stats.deferred} weitere Absätze werden beim Scrollen geprüft.`;
  } else if (stats.active && !stats.red && !stats.yellow && !stats.green) {
    $("pending").textContent = "Keine ausreichend langen Textabsätze gefunden.";
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
  setInterval(refreshStats, 1000);
}

$("enabled").addEventListener("change", async (e) => {
  config.enabled = e.target.checked;
  await chrome.storage.sync.set({ enabled: config.enabled });
  render();
  setTimeout(refreshStats, 300);
});

$("siteAuto").addEventListener("change", async (e) => {
  const others = config.sites.filter((s) => !AIVSAI.siteMatches(host, [s]));
  config.sites = e.target.checked ? [...others, host] : others;
  await chrome.storage.sync.set({ sites: config.sites });
  renderSite();
  setTimeout(refreshStats, 300);
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
