// Service worker (ES module): wires browser events and messages to the building blocks in bg/.
//   bg/providers.js        backends for the providers from config.js (browser model, server, Hugging Face)
//   bg/scoring.js          configuration, score cache, connection test, status
//   bg/model-check.js      "Check model": test a custom model against the reference set
//   bg/score-store.js      persistent score store (IndexedDB) with retention period
//   bg/feedback-store.js   feedback collection with text (only after consent, local only)
//   bg/badge.js            icon badge per tab
//   bg/offscreen-client.js bridge to the offscreen document with the browser model
import "./generated/blocklist.js";
import "./models.js";
import "./config.js";
import { updateBadge } from "./bg/badge.js";
import * as feedback from "./bg/feedback-store.js";
import { checkModel } from "./bg/model-check.js";
import { callOffscreen } from "./bg/offscreen-client.js";
import { clearStore, getConfig, health, pruneStore, scoreBatch, storeInfo, testProvider } from "./bg/scoring.js";

function sendToTab(tabId, msg, frameId = 0) {
  // no content script: chrome:// pages, Web Store, tabs from before the installation
  chrome.tabs.sendMessage(tabId, msg, { frameId }, () => void chrome.runtime.lastError);
}

// Tabs whose scan failed because of the missing model should rescan after the download
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
// Context menu: manually check selected text or the paragraph under the mouse pointer -
// independent of the scan mode as long as the extension is switched on
// ---------------------------------------------------------------------------

const MENU_ITEMS = {
  "check-selection": { title: "Check selected text for AI", contexts: ["selection"], message: "CHECK_SELECTION" },
  "check-element": { title: "Check this paragraph for AI", contexts: ["page", "link"], message: "CHECK_ELEMENT" }
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
// Lifecycle, settings, keyboard shortcuts
// ---------------------------------------------------------------------------

// Delete expired scores once a day (and on every browser start)
const PRUNE_ALARM = "prune-scores";

function schedulePrune() {
  chrome.alarms.create(PRUNE_ALARM, { delayInMinutes: 1, periodInMinutes: 24 * 60 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PRUNE_ALARM) pruneStore().catch((err) => console.warn("Cleanup failed", err));
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  updateBadge();
  createMenus();
  schedulePrune();
  // First install: welcome page (what the colors mean and what they do not, download size), from there on
  // to the settings, where the model is downloaded
  if (reason === "install") {
    // Record the model right away: pinLegacyModel recognizes installations from before v0.6 by it missing
    chrome.storage.sync.set({ browserModel: AIVSAI.DEFAULTS.browserModel });
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  }
  if (reason === "update") {
    pinLegacyModel()
      .then(migrateThresholds)
      .catch((err) => console.warn("Settings not adjusted", err));
  }
});

// Up to v0.5 TMR was the default model. Anyone who never chose a model keeps it along with the traffic light values -
// otherwise the update would leave desklib, which would first have to download 1.7 GB. Newer installations
// store browserModel already on install and stay untouched.
async function pinLegacyModel() {
  const stored = await chrome.storage.sync.get(["browserModel", "yellowFrom", "redFrom"]);
  if ("browserModel" in stored) return;
  const pin = { browserModel: "tmr" };
  if (!("yellowFrom" in stored) && !("redFrom" in stored)) Object.assign(pin, AIVSAI.MODELS.tmr.thresholds);
  await chrome.storage.sync.set(pin);
}

// Up to v0.5, 0.6/0.9 were the starting values for TMR - which made the majority of short human expository texts red
// (training/EVAL_RESULTS.md, "False alarms on Wikipedia"). Anyone who stored them but never changed them
// gets the new ones from models.js; custom values stay.
async function migrateThresholds() {
  const stored = await chrome.storage.sync.get(["yellowFrom", "redFrom"]);
  const preset = AIVSAI.presetFor(await getConfig());
  const tmr = AIVSAI.MODELS.tmr.thresholds;
  if (stored.yellowFrom === 0.6 && stored.redFrom === 0.9 && preset === tmr) {
    await chrome.storage.sync.set(tmr);
  }
  // desklib starting value up to v0.5: redFrom 0.87 (training/EVAL_RESULTS.md, "Securing the thresholds")
  const desklib = AIVSAI.MODELS.desklib.thresholds;
  if (stored.yellowFrom === 0.5 && stored.redFrom === 0.87 && preset === desklib) {
    await chrome.storage.sync.set(desklib);
  }
}
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
  // apply shorter retention or "do not store" immediately, not only at the next alarm
  if ("scoreRetentionDays" in changes) pruneStore().catch((err) => console.warn("Cleanup failed", err));
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
// Messages from content scripts, popup, settings and offscreen document
// ---------------------------------------------------------------------------

const OFFSCREEN_COMMANDS = { MODEL_STATUS: "status", MODEL_DOWNLOAD: "download", MODEL_DELETE: "delete" };

// Handlers return a response (also as a promise) or undefined for "no response"
const HANDLERS = {
  SCORE_BATCH: async (msg, sender) => {
    // Second safeguard for the blocklist (the first is content.js): only single checks come from there
    if (!msg.manual && (await isBlocked(sender))) {
      return { ok: false, scores: {}, error: "Site is on the blocklist" };
    }
    return scoreBatch(msg.items);
  },
  STATS: (msg, sender) => {
    if (sender.tab?.id !== undefined) updateBadge(sender.tab.id, msg.stats);
  },
  HEALTH: () => health(),
  TEST_PROVIDER: () => testProvider(),
  // Settings from the (not yet saved) form - only from extension pages, contains URLs and tokens
  CHECK_MODEL: (msg, sender) => fromExtensionPage(sender) && withError(checkModel(msg.cfg)),
  SCORE_STORE_INFO: () => storeInfo().catch((err) => ({ ok: false, error: String(err?.message || err) })),
  SCORE_STORE_CLEAR: () => clearStore().catch((err) => ({ ok: false, error: String(err?.message || err) })),
  // Download only starts; the end comes as MODEL_DONE from the offscreen document
  MODEL_STATUS: (msg) => modelCommand(msg),
  MODEL_DOWNLOAD: (msg) => modelCommand(msg),
  MODEL_DELETE: (msg) => modelCommand(msg),
  MODEL_DONE: (msg) => {
    if (msg.ok) notifyTabs({ type: "MODEL_READY" });
  },
  FEEDBACK_SAVE: (msg) => withError(saveFeedback(msg.entry)),
  FEEDBACK_DELETE: (msg) => withError(feedback.remove(msg.id).then(feedbackInfo)),
  FEEDBACK_INFO: () => withError(feedbackInfo()),
  // Return only the answer, not the text - the sender knows that anyway
  FEEDBACK_GET: (msg) =>
    withError(
      feedback.get(msg.text).then((row) => ({ ok: true, entry: row && { id: row.id, label: row.label, basis: row.basis, at: row.at } }))
    ),
  // Export and withdrawal only from the settings, never from a content script
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
    return false; // extension pages
  }
  return AIVSAI.scanPolicy(host, await getConfig()) === "blocked";
}

const fromExtensionPage = (sender) => !!sender.url?.startsWith(chrome.runtime.getURL(""));

const withError = (promise) => promise.catch((err) => ({ ok: false, error: String(err?.message || err) }));

// Second safeguard for the consent prompt in the content script
const FEEDBACK_CONSENT = "feedbackConsentAt";

async function saveFeedback(entry) {
  const { [FEEDBACK_CONSENT]: consentAt } = await chrome.storage.local.get(FEEDBACK_CONSENT);
  if (!consentAt) return { ok: false, error: "No consent to store" };
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
