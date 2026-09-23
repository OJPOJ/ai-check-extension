(() => {
  const MIN_WORDS = 40;
  const MAX_CHARS = 500;
  const BATCH_SIZE = 25;
  const DEBOUNCE_MS = 600;
  const EXCLUDE_SELECTOR =
    "nav, header, footer, script, style, noscript, " +
    "[contenteditable], [contenteditable='true'], textarea, input, select, button, " +
    "[role='textbox'], .aivsai-flag";

  let config = { enabled: true, threshold: 0.70, serverUrl: "http://127.0.0.1:11500" };
  const seen = new Map(); // textHash -> probability
  const pending = new Map(); // textHash -> { id, text, el }
  let debounceTimer = null;
  let mutationTimer = null;

  chrome.storage.sync.get(config, (stored) => {
    config = { ...config, ...stored };
    if (config.enabled) scanAndQueue(document.body);
  });

  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, change] of Object.entries(changes)) config[key] = change.newValue;
    if (config.enabled === false) {
      clearAllFlags();
    } else if ("threshold" in changes) {
      reapplyThreshold();
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "RESCAN") rescanAll();
  });

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `${text.length}_${h}`;
  }

  function isEligible(el) {
    return !el.closest(EXCLUDE_SELECTOR);
  }

  function collectCandidates(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const nodes = root.matches?.("article, p, li")
      ? [root, ...root.querySelectorAll("article, p, li")]
      : root.querySelectorAll("article, p, li");

    for (const el of nodes) {
      if (!isEligible(el)) continue;
      const text = (el.innerText || "").trim();
      if (!text) continue;
      const wordCount = text.split(/\s+/).filter(Boolean).length;
      if (wordCount < MIN_WORDS) continue;

      const hash = hashText(text);
      if (seen.has(hash)) {
        applyFlag(el, seen.get(hash));
        continue;
      }
      pending.set(hash, { id: hash, text: text.slice(0, MAX_CHARS), el });
    }
  }

  function scanAndQueue(root) {
    if (!config.enabled) return;
    collectCandidates(root);
    if (pending.size) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushBatches, DEBOUNCE_MS);
    }
  }

  function flushBatches() {
    const items = Array.from(pending.values());
    pending.clear();
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      sendBatch(items.slice(i, i + BATCH_SIZE));
    }
  }

  function sendBatch(batch) {
    chrome.runtime.sendMessage(
      { type: "SCORE_BATCH", items: batch.map((b) => ({ id: b.id, text: b.text })) },
      (resp) => {
        // fail open: dead/unreachable server just means nothing gets flagged this round
        if (chrome.runtime.lastError || !resp?.ok) return;
        for (const b of batch) {
          const p = resp.scores[b.id];
          if (typeof p !== "number") continue;
          seen.set(b.id, p);
          applyFlag(b.el, p);
        }
      }
    );
  }

  function applyFlag(el, probability) {
    if (probability < config.threshold) return;
    el.classList.add("aivsai-flag");
    const pct = Math.round(probability * 100);
    el.title = `Wahrscheinlich KI-generiert (Zero-Shot-Schätzung, kann falsch liegen) — ${pct}%`;
  }

  function reapplyThreshold() {
    // cached probabilities don't retain element references, so a full
    // rescan is the simplest correct way to re-derive who's above threshold
    rescanAll();
  }

  function clearAllFlags() {
    document.querySelectorAll(".aivsai-flag").forEach((el) => {
      el.classList.remove("aivsai-flag");
      el.removeAttribute("title");
    });
  }

  function rescanAll() {
    seen.clear();
    pending.clear();
    clearAllFlags();
    scanAndQueue(document.body);
  }

  const observer = new MutationObserver((mutations) => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      for (const m of mutations) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) scanAndQueue(node);
        });
      }
    }, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
