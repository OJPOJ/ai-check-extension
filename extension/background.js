// Service Worker (ES-Modul): verdrahtet Browser-Events und Nachrichten mit den Bausteinen in bg/.
//   bg/providers.js        Backends zu den Providern aus config.js (Browser-Modell, Server, Hugging Face)
//   bg/scoring.js          Konfiguration, Score-Cache, Verbindungstest, Status
//   bg/model-check.js      „Modell prüfen“: eigenes Modell gegen das Referenzset testen
//   bg/score-store.js      dauerhafter Score-Speicher (IndexedDB) mit Aufbewahrungsdauer
//   bg/feedback-store.js   Feedback-Sammlung mit Text (nur nach Einwilligung, nur lokal)
//   bg/badge.js            Icon-Badge pro Tab
//   bg/offscreen-client.js Brücke zum Offscreen-Dokument mit dem Browser-Modell
import "./generated/blocklist.js";
import "./models.js";
import "./config.js";
import { updateBadge } from "./bg/badge.js";
import * as feedback from "./bg/feedback-store.js";
import { checkModel } from "./bg/model-check.js";
import { callOffscreen } from "./bg/offscreen-client.js";
import { clearStore, getConfig, health, pruneStore, scoreBatch, storeInfo, testProvider } from "./bg/scoring.js";

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

// Abgelaufene Bewertungen einmal täglich löschen (und bei jedem Browserstart)
const PRUNE_ALARM = "prune-scores";

function schedulePrune() {
  chrome.alarms.create(PRUNE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) pruneStore().catch((err) => console.warn("Aufräumen fehlgeschlagen", err));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  updateBadge();
  createMenus();
  schedulePrune();
  // Erstinstallation: Einstellungen öffnen, damit das Modell heruntergeladen werden kann
  if (reason === "install") chrome.runtime.openOptionsPage();
});
chrome.runtime.onStartup.addListener(() => {
  updateBadge();
  schedulePrune();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  if ("enabled" in changes) {
    updateBadge();
    setMenusVisible(changes.enabled.newValue ?? AIVSAI.DEFAULTS.enabled);
  }
  // kürzere Aufbewahrung bzw. "nicht speichern" sofort umsetzen, nicht erst beim nächsten Alarm
  if ("scoreRetentionDays" in changes) pruneStore().catch((err) => console.warn("Aufräumen fehlgeschlagen", err));
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
  SCORE_BATCH: async (msg, sender) => {
    // Zweite Absicherung zur Sperrliste (die erste ist content.js): von dort nur Einzelprüfungen
    if (!msg.manual && (await isBlocked(sender))) {
      return { ok: false, scores: {}, error: "Seite steht auf der Sperrliste" };
    }
    return scoreBatch(msg.items);
  },
  STATS: (msg, sender) => {
    if (sender.tab?.id !== undefined) updateBadge(sender.tab.id, msg.stats);
  },
  HEALTH: () => health(),
  TEST_PROVIDER: () => testProvider(),
  // Einstellungen aus dem (noch nicht gespeicherten) Formular - nur von Extension-Seiten, enthält URLs und Tokens
  CHECK_MODEL: (msg, sender) => fromExtensionPage(sender) && withError(checkModel(msg.cfg)),
  SCORE_STORE_INFO: () => storeInfo().catch((err) => ({ ok: false, error: String(err?.message || err) })),
  SCORE_STORE_CLEAR: () => clearStore().catch((err) => ({ ok: false, error: String(err?.message || err) })),
  // Download startet nur; Ende kommt als MODEL_DONE vom Offscreen-Dokument
  MODEL_STATUS: (msg) => modelCommand(msg),
  MODEL_DOWNLOAD: (msg) => modelCommand(msg),
  MODEL_DELETE: (msg) => modelCommand(msg),
  MODEL_DONE: (msg) => {
    if (msg.ok) notifyTabs({ type: "MODEL_READY" });
  },
  FEEDBACK_SAVE: (msg) => withError(saveFeedback(msg.entry)),
  FEEDBACK_DELETE: (msg) => withError(feedback.remove(msg.id).then(feedbackInfo)),
  FEEDBACK_INFO: () => withError(feedbackInfo()),
  // Nur die Angabe zurück, nicht den Text - den kennt der Absender ja
  FEEDBACK_GET: (msg) =>
    withError(
      feedback.get(msg.text).then((row) => ({ ok: true, entry: row && { id: row.id, label: row.label, basis: row.basis, at: row.at } }))
    ),
  // Export und Widerruf nur aus den Einstellungen, nie aus einem Content-Script
  FEEDBACK_EXPORT: (msg, sender) =>
    fromExtensionPage(sender) && withError(feedback.all().then((rows) => ({ ok: true, rows }))),
  FEEDBACK_CLEAR: (msg, sender) =>
    fromExtensionPage(sender) &&
    withError(feedback.clear().then(() => chrome.storage.local.remove(FEEDBACK_CONSENT)).then(feedbackInfo))
};

async function isBlocked(sender) {
  let host;
  try {
    host = new URL(sender.url).hostname;
  } catch {
    return false; // Extension-Seiten
  }
  return AIVSAI.scanPolicy(host, await getConfig()) === "blocked";
}

const fromExtensionPage = (sender) => !!sender.url?.startsWith(chrome.runtime.getURL(""));

const withError = (promise) => promise.catch((err) => ({ ok: false, error: String(err?.message || err) }));

// Zweite Absicherung zur Einwilligungsabfrage im Content-Script
const FEEDBACK_CONSENT = "feedbackConsentAt";

async function saveFeedback(entry) {
  const { [FEEDBACK_CONSENT]: consentAt } = await chrome.storage.local.get(FEEDBACK_CONSENT);
  if (!consentAt) return { ok: false, error: "Keine Einwilligung zum Speichern" };
  const id = await feedback.put(entry);
  return { ...(await feedbackInfo()), id };
}

async function feedbackInfo() {
  const { [FEEDBACK_CONSENT]: consentAt = null } = await chrome.storage.local.get(FEEDBACK_CONSENT);
  return { ok: true, consentAt, ...(await feedback.info()) };
}

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
