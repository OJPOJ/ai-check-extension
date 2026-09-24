(() => {
  const MIN_WORDS = 40;
  const MAX_CHARS = 500;
  const BATCH_SIZE = 25;
  const DEBOUNCE_MS = 600;
  const CANDIDATE_SELECTOR = "article, p, li";
  const EXCLUDE_SELECTOR =
    "nav, header, footer, script, style, noscript, " +
    "[contenteditable], [contenteditable='true'], textarea, input, select, button, " +
    "[role='textbox']";
  const LEVEL_CLASSES = ["aivsai-green", "aivsai-yellow", "aivsai-red", "aivsai-badge"];
  const host = location.hostname;

  let config = { ...AIVSAI.DEFAULTS };
  let manualScan = false; // "Diese Seite scannen" aus Popup/Tastenkürzel, gilt bis zum Neuladen
  let generation = 0; // erhöht bei jedem Neu-Scan, damit veraltete Antworten verworfen werden
  let lastError = null;
  const seen = new Map(); // textHash -> probability
  const pending = new Map(); // textHash -> { id, text, els }
  const inFlight = new Map(); // textHash -> { id, text, els }
  let debounceTimer = null;
  let mutationTimer = null;
  let statsTimer = null;
  const addedNodes = new Set();

  chrome.storage.sync.get(AIVSAI.DEFAULTS, (stored) => {
    config = { ...AIVSAI.DEFAULTS, ...stored };
    if (isActive()) scanAndQueue(document.body);
    reportStats();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const wasActive = isActive();
    for (const [key, change] of Object.entries(changes)) config[key] = change.newValue ?? AIVSAI.DEFAULTS[key];

    if (!isActive()) {
      if (wasActive) clearAll();
    } else if (!wasActive || AIVSAI.PROVIDER_KEYS.some((k) => k in changes)) {
      rescanAll();
    } else {
      restyleAll();
    }
    reportStats();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SCAN_NOW") {
      manualScan = true;
      rescanAll();
      sendResponse(stats());
    } else if (msg?.type === "GET_STATS") {
      sendResponse(stats());
    }
  });

  function isActive() {
    if (!config.enabled) return false;
    if (manualScan || config.scanMode === "all") return true;
    return config.scanMode === "sites" && AIVSAI.siteMatches(host, config.sites || []);
  }

  function hashText(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `${text.length}_${h}`;
  }

  function wordCount(text) {
    return text.split(/\s+/).filter(Boolean).length;
  }

  // Container (z.B. <article>) nur bewerten, wenn keiner seiner Kind-Kandidaten selbst
  // lang genug ist - sonst entstehen verschachtelte Doppel-Markierungen.
  function hasLongCandidateChild(el) {
    for (const child of el.querySelectorAll(CANDIDATE_SELECTOR)) {
      if (wordCount(child.textContent || "") >= MIN_WORDS) return true;
    }
    return false;
  }

  function candidatesIn(root) {
    const nodes = new Set();
    const ancestor = root.parentElement?.closest(CANDIDATE_SELECTOR);
    if (ancestor) nodes.add(ancestor); // Text innerhalb eines Absatzes hat sich geändert
    if (root.matches(CANDIDATE_SELECTOR)) nodes.add(root);
    root.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => nodes.add(el));
    return nodes;
  }

  function collectCandidates(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    for (const el of candidatesIn(root)) {
      if (el.closest(EXCLUDE_SELECTOR) || hasLongCandidateChild(el)) continue;
      const text = (el.innerText || "").trim();
      if (!text || wordCount(text) < MIN_WORDS) continue;

      const hash = hashText(text);
      if (el.dataset.aivsaiHash === hash && (el.dataset.aivsaiScore || el.classList.contains("aivsai-pending"))) continue;
      el.dataset.aivsaiHash = hash;
      unstyle(el); // Text hat sich geändert - alte Bewertung gilt nicht mehr

      if (seen.has(hash)) {
        applyScore(el, seen.get(hash));
        continue;
      }
      const entry = inFlight.get(hash) || pending.get(hash);
      if (entry) {
        entry.els.push(el);
      } else {
        pending.set(hash, { id: hash, text: text.slice(0, MAX_CHARS), els: [el] });
      }
      el.classList.add("aivsai-pending");
    }
  }

  function scanAndQueue(root) {
    if (!isActive()) return;
    collectCandidates(root);
    if (pending.size) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flushBatches, DEBOUNCE_MS);
    }
    reportStats();
  }

  function flushBatches() {
    const items = Array.from(pending.values());
    pending.clear();
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      sendBatch(items.slice(i, i + BATCH_SIZE));
    }
  }

  function sendBatch(batch) {
    const gen = generation;
    batch.forEach((b) => inFlight.set(b.id, b));
    try {
      chrome.runtime.sendMessage(
        { type: "SCORE_BATCH", items: batch.map((b) => ({ id: b.id, text: b.text })) },
        (resp) => handleBatchResult(batch, gen, chrome.runtime.lastError ? null : resp)
      );
    } catch {
      // Extension wurde neu geladen - dieses Content-Script ist verwaist
      handleBatchResult(batch, gen, null);
    }
  }

  function handleBatchResult(batch, gen, resp) {
    batch.forEach((b) => inFlight.delete(b.id));
    if (gen !== generation) return;
    // fail open: ein nicht erreichbares Backend blockiert nie die Seite, es wird nur nichts markiert
    lastError = resp ? resp.error || null : "Extension nicht erreichbar";
    for (const b of batch) {
      const p = resp?.scores?.[b.id];
      if (typeof p === "number") {
        seen.set(b.id, p);
        b.els.forEach((el) => applyScore(el, p));
      } else {
        b.els.forEach((el) => el.classList.remove("aivsai-pending"));
      }
    }
    reportStats();
  }

  function applyScore(el, probability) {
    el.classList.remove("aivsai-pending");
    el.dataset.aivsaiScore = String(probability);
    style(el);
  }

  function style(el) {
    const p = parseFloat(el.dataset.aivsaiScore);
    const level = AIVSAI.level(p, config);
    const pct = Math.round(p * 100);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pos");
    el.dataset.aivsaiLevel = level;

    const visible = level !== "green" || config.showGreen;
    if (visible) {
      el.classList.add(`aivsai-${level}`);
      if (config.showBadge) {
        el.dataset.aivsaiLabel = `${pct}% KI`;
        el.classList.add("aivsai-badge");
        // Badge wird per ::after absolut positioniert und braucht dafür einen Bezugsrahmen
        if (getComputedStyle(el).position === "static") el.classList.add("aivsai-pos");
      }
    }

    // bestehende title-Attribute der Seite nicht überschreiben
    if (visible && (!el.hasAttribute("title") || el.dataset.aivsaiTitle)) {
      el.title =
        `${AIVSAI.LEVEL_TEXT[level]} – ${pct}% KI-Wahrscheinlichkeit ` +
        `(${AIVSAI.providerLabel(config)}; Schätzung, kann falsch liegen)`;
      el.dataset.aivsaiTitle = "1";
    } else if (!visible && el.dataset.aivsaiTitle) {
      el.removeAttribute("title");
      delete el.dataset.aivsaiTitle;
    }
  }

  function unstyle(el) {
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pending", "aivsai-pos");
    if (el.dataset.aivsaiTitle) el.removeAttribute("title");
    for (const key of ["aivsaiScore", "aivsaiLevel", "aivsaiLabel", "aivsaiTitle"]) delete el.dataset[key];
  }

  function restyleAll() {
    document.querySelectorAll("[data-aivsai-score]").forEach(style);
  }

  function clearAll() {
    generation++;
    pending.clear();
    clearTimeout(debounceTimer);
    document.querySelectorAll("[data-aivsai-hash]").forEach((el) => {
      unstyle(el);
      delete el.dataset.aivsaiHash;
    });
    lastError = null;
  }

  function rescanAll() {
    clearAll();
    seen.clear();
    scanAndQueue(document.body);
  }

  function stats() {
    const counts = { red: 0, yellow: 0, green: 0, pending: 0 };
    document.querySelectorAll("[data-aivsai-level]").forEach((el) => counts[el.dataset.aivsaiLevel]++);
    counts.pending = document.querySelectorAll(".aivsai-pending").length;
    return { ...counts, active: isActive(), manualScan, error: lastError, host };
  }

  function reportStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: "STATS", stats: stats() }, () => void chrome.runtime.lastError);
      } catch {
        // verwaistes Content-Script nach Extension-Reload
      }
    }, 200);
  }

  // Nachgeladene Inhalte (Infinite Scroll, SPAs) - Knoten über die Debounce-Zeit sammeln,
  // damit keine Mutationen verloren gehen, wenn der Timer neu startet.
  const observer = new MutationObserver((mutations) => {
    if (!isActive()) return;
    for (const m of mutations) {
      m.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) addedNodes.add(node);
        else if (node.parentElement) addedNodes.add(node.parentElement);
      });
    }
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const nodes = Array.from(addedNodes).filter((n) => n.isConnected);
      addedNodes.clear();
      nodes.forEach(scanAndQueue);
    }, DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
