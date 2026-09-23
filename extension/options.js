const DEFAULTS = {
  enabled: true,
  threshold: 0.90,
  serverUrl: "http://127.0.0.1:8787",
  model: "tmr"
};

const els = {
  enabled: document.getElementById("enabled"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("thresholdValue"),
  serverUrl: document.getElementById("serverUrl"),
  model: document.getElementById("model"),
  rescan: document.getElementById("rescan"),
  status: document.getElementById("status")
};

function showStatus(text) {
  els.status.textContent = text;
  setTimeout(() => {
    if (els.status.textContent === text) els.status.textContent = "";
  }, 1500);
}

function save() {
  const config = {
    enabled: els.enabled.checked,
    threshold: parseFloat(els.threshold.value),
    serverUrl: els.serverUrl.value.trim() || DEFAULTS.serverUrl,
    model: els.model.value
  };
  chrome.storage.sync.set(config, () => showStatus("Gespeichert."));
}

chrome.storage.sync.get(DEFAULTS, (stored) => {
  els.enabled.checked = stored.enabled;
  els.threshold.value = stored.threshold;
  els.thresholdValue.textContent = stored.threshold.toFixed(2);
  els.serverUrl.value = stored.serverUrl;
  els.model.value = stored.model;
});

els.enabled.addEventListener("change", save);
els.serverUrl.addEventListener("change", save);
els.model.addEventListener("change", save);
els.threshold.addEventListener("input", () => {
  els.thresholdValue.textContent = parseFloat(els.threshold.value).toFixed(2);
});
els.threshold.addEventListener("change", save);

els.rescan.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "RESCAN" }, () => {
    // ignore chrome.runtime.lastError: tab may have no content script (e.g. chrome:// pages)
    void chrome.runtime.lastError;
    showStatus("Neu gescannt.");
  });
});
