const DEFAULTS = {
  enabled: true,
  threshold: 0.90,
  serverUrl: "http://127.0.0.1:8787",
  model: "tmr"
};

// Werte aus training/EVAL_RESULTS.md (100er-Testsample, HC3-Holdout, CPU) -
// kleine Stichprobe, dient als Startpunkt, nicht als Garantie.
const BACKEND_INFO = {
  tmr: {
    threshold: 0.90,
    html:
      "<b>Low — TMR</b> (RoBERTa-base, 125M). ~62ms/Text, ~900MB RAM, " +
      "25er-Batch ~1,6s. AUROC 0.91, Accuracy 0.83 bei Schwelle 0.98 im Test. " +
      "Empfohlen fürs normale Mitlaufen im Hintergrund."
  },
  desklib: {
    threshold: 0.87,
    html:
      "<b>Medium — desklib</b> (DeBERTa-v3-large, 430M). ~4,9s/Text, ~4,65GB RAM, " +
      "25er-Batch ~2 Minuten. AUROC 0.998, Accuracy 0.99 bei Schwelle 0.87 im Test. " +
      "Deutlich genauer, aber spürbar langsam/schwer — eher für gezielte Einzelprüfung " +
      "als für automatisches Scannen jeder Seite geeignet."
  }
};

const els = {
  enabled: document.getElementById("enabled"),
  threshold: document.getElementById("threshold"),
  thresholdValue: document.getElementById("thresholdValue"),
  serverUrl: document.getElementById("serverUrl"),
  model: document.getElementById("model"),
  backendInfo: document.getElementById("backendInfo"),
  rescan: document.getElementById("rescan"),
  status: document.getElementById("status")
};

function updateBackendInfo() {
  const info = BACKEND_INFO[els.model.value];
  els.backendInfo.innerHTML = info ? info.html : "";
}

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
  updateBackendInfo();
});

els.enabled.addEventListener("change", save);
els.serverUrl.addEventListener("change", save);
els.model.addEventListener("change", () => {
  updateBackendInfo();
  const info = BACKEND_INFO[els.model.value];
  if (info) {
    els.threshold.value = info.threshold;
    els.thresholdValue.textContent = info.threshold.toFixed(2);
  }
  save();
});
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
