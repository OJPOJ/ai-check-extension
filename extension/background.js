// Service Worker (ES-Modul): verdrahtet Browser-Events und Nachrichten mit den Bausteinen in bg/.
//   bg/providers.js        Backends (Browser-Modell, lokaler/eigener Server, Hugging Face)
//   bg/scoring.js          Konfiguration, Score-Cache, Verbindungstest, Status
//   bg/badge.js            Icon-Badge pro Tab
//   bg/offscreen-client.js Brücke zum Offscreen-Dokument mit dem Browser-Modell
import "./config.js";
import { updateBadge } from "./bg/badge.js";
import { callOffscreen } from "./bg/offscreen-client.js";
import { getConfig, health, scoreBatch, testProvider } from "./bg/scoring.js";

function sendToTab(tabId, msg, frameId = 0) {
  // kein Content-Script: chrome://-Seiten, Web Store, Tabs von vor der Installation
  chrome.tabs.sendMessage(tabId, msg, { frameId }, () => void chrome.runtime.lastError);
}

// Tabs, deren Scan am fehlenden Modell gescheitert ist, sollen nach dem Download neu scannen
async function notifyTabs(msg) {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id !== undefined) sendToTab(tab.id, msg);
  }
}

async function toggleEnabled() {
  const { enabled } = await getConfig();
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
  const { enabled } = await getConfig();
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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const item = MENU_ITEMS[info.menuItemId];
  if (item && tab?.id !== undefined) sendToTab(tab.id, { type: item.message }, info.frameId);
});

// ---------------------------------------------------------------------------
// Lebenszyklus, Einstellungen, Tastenkürzel
// ---------------------------------------------------------------------------

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

const COMMAND_MESSAGES = { "scan-page": "SCAN_NOW", "check-selection": "CHECK_SELECTION" };

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "toggle-enabled") {
    await toggleEnabled();
    return;
  }
  const message = COMMAND_MESSAGES[command];
  if (!message) return;
  if (command === "check-selection" && !(await getConfig()).enabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) sendToTab(tab.id, { type: message });
});

// ---------------------------------------------------------------------------
// Nachrichten von Content-Scripts, Popup, Einstellungen und Offscreen-Dokument
// ---------------------------------------------------------------------------

const OFFSCREEN_COMMANDS = { MODEL_STATUS: "status", MODEL_DOWNLOAD: "download", MODEL_DELETE: "delete" };

// Handler liefern eine Antwort (auch als Promise) oder undefined für "keine Antwort"
const HANDLERS = {
  SCORE_BATCH: (msg) => scoreBatch(msg.items),
  STATS: (msg, sender) => {
    if (sender.tab?.id !== undefined) updateBadge(sender.tab.id, msg.stats);
  },
  HEALTH: () => health(),
  TEST_PROVIDER: () => testProvider(),
  // Download startet nur; Ende kommt als MODEL_DONE vom Offscreen-Dokument
  MODEL_STATUS: (msg) => modelCommand(msg),
  MODEL_DOWNLOAD: (msg) => modelCommand(msg),
  MODEL_DELETE: (msg) => modelCommand(msg),
  MODEL_DONE: (msg) => {
    if (msg.ok) notifyTabs({ type: "MODEL_READY" });
  }
};

function modelCommand(msg) {
  return callOffscreen(OFFSCREEN_COMMANDS[msg.type], { model: msg.model }).catch((err) => ({
    ok: false,
    error: String(err?.message || err)
  }));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false;
  const result = handler(msg, sender);
  if (!(result instanceof Promise)) return false;
  result.then(sendResponse);
  return true; // async response
});
