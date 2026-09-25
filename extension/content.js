(() => {
  const MIN_WORDS = 40;
  const MAX_CHARS = 500;
  const BATCH_SIZE = 5;
  const DEBOUNCE_MS = 600;
  // lazyScan: nur Absätze bis zu so vielen Bildschirmhöhen über/unter dem sichtbaren
  // Bereich bewerten, der Rest folgt beim Scrollen
  const NEAR_SCREENS = 1.5;
  const CANDIDATE_SELECTOR = "article, p, li";
  const EXCLUDE_SELECTOR =
    "nav, header, footer, script, style, noscript, " +
    "[contenteditable], [contenteditable='true'], textarea, input, select, button, " +
    "[role='textbox']";
  const LEVEL_CLASSES = ["aivsai-green", "aivsai-yellow", "aivsai-red", "aivsai-badge"];
  // Manuelle Prüfung: kürzere Texte erlaubt und mehr Text als beim Auto-Scan
  // (die Modelle schneiden ohnehin bei 512 Tokens ab)
  const MANUAL_MIN_WORDS = 5;
  const MANUAL_MAX_CHARS = 2000;
  const HIGHLIGHT_STATES = ["pending", "green", "yellow", "red"];
  const host = location.hostname;

  let config = { ...AIVSAI.DEFAULTS };
  let manualScan = false; // "Diese Seite scannen" aus Popup/Tastenkürzel, gilt bis zum Neuladen
  let generation = 0; // erhöht bei jedem Neu-Scan, damit veraltete Antworten verworfen werden
  let lastError = null;
  const seen = new Map(); // textHash -> probability
  const pending = new Map(); // textHash -> { id, text, els }
  const inFlight = new Map(); // textHash -> { id, text, els }
  let batchesInFlight = 0;
  let debounceTimer = null;
  let mutationTimer = null;
  let statsTimer = null;
  const addedNodes = new Set();
  let pumpTimer = null;
  let contextTarget = null; // Element unter dem letzten Rechtsklick
  const manualRanges = new Map(); // Range -> probability (null = wird geprüft)
  let popover = null;
  let popoverToken = 0;

  // Meldet, wenn ein zurückgestellter Absatz in die Nähe des sichtbaren Bereichs kommt -
  // deckt Scrollen, Fenstergröße und aufgeklappte Inhalte ab, ohne Scroll-Listener.
  const nearObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) schedulePump();
    },
    { rootMargin: `${NEAR_SCREENS * 100}% 0px` }
  );

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
      // beim Ausschalten auch manuell geprüfte Stellen entfernen, die es ohne Auto-Scan geben kann
      if (wasActive || ("enabled" in changes && !config.enabled)) clearAll();
    } else if (!wasActive || AIVSAI.PROVIDER_KEYS.some((k) => k in changes)) {
      rescanAll();
    } else {
      restyleAll();
      if ("lazyScan" in changes) pump();
    }
    reportStats();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "SCAN_NOW") {
      manualScan = true;
      rescanAll();
      sendResponse(stats());
    } else if (msg?.type === "MODEL_READY") {
      if (isActive() && lastError) rescanAll();
    } else if (msg?.type === "GET_STATS") {
      sendResponse(stats());
    } else if (msg?.type === "CHECK_SELECTION") {
      checkSelection();
    } else if (msg?.type === "CHECK_ELEMENT") {
      checkElement();
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
      if (el.dataset.aivsaiHash === hash && isQueuedOrScored(el)) continue;
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

  function isQueuedOrScored(el) {
    return el.dataset.aivsaiScore || el.classList.contains("aivsai-pending") || el.classList.contains("aivsai-deferred");
  }

  function scanAndQueue(root) {
    if (!isActive()) return;
    collectCandidates(root);
    if (pending.size) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pump, DEBOUNCE_MS);
    }
    reportStats();
  }

  // Abstand zum sichtbaren Bereich in px (0 = sichtbar). Unsichtbare/abgehängte
  // Elemente kommen ganz nach hinten.
  function viewportDistance(entry) {
    let best = Infinity;
    for (const el of entry.els) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const d = r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0;
      best = Math.min(best, d);
    }
    return best;
  }

  // Priorität wird erst beim Absenden bestimmt, nicht beim Einreihen: so bekommt nach
  // einem Scroll automatisch der dann sichtbare Bereich den nächsten freien Slot.
  // Ohne Scrollen ergibt das einfach "von oben nach unten".
  function takeNextBatch() {
    const limit = config.lazyScan ? NEAR_SCREENS * innerHeight : Infinity;
    const ranked = [];
    for (const entry of pending.values()) {
      if (!entry.els.some((el) => el.isConnected)) {
        pending.delete(entry.id); // SPA hat den Absatz inzwischen entfernt
        continue;
      }
      const dist = viewportDistance(entry);
      const near = dist <= limit;
      for (const el of entry.els) {
        el.classList.toggle("aivsai-pending", near);
        el.classList.toggle("aivsai-deferred", !near);
        if (near) nearObserver.unobserve(el);
        else nearObserver.observe(el);
      }
      if (near) ranked.push({ entry, dist, top: entry.els[0].getBoundingClientRect().top });
    }
    ranked.sort((a, b) => a.dist - b.dist || a.top - b.top);
    const batch = ranked.slice(0, BATCH_SIZE).map((r) => r.entry);
    batch.forEach((b) => pending.delete(b.id));
    return batch;
  }

  // Batches nacheinander statt alle auf einmal - sonst rechnet der Server alles parallel
  // und die Priorisierung hätte keinen Effekt.
  function pump() {
    const maxInFlight = config.provider === "local" || config.provider === "browser" ? 1 : 2;
    while (batchesInFlight < maxInFlight && pending.size && isActive()) {
      const batch = takeNextBatch();
      if (!batch.length) break; // alles Übrige ist zurückgestellt, bis gescrollt wird
      sendBatch(batch);
    }
    reportStats();
  }

  function schedulePump() {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, 150);
  }

  function requestScores(items) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "SCORE_BATCH", items }, (resp) =>
          resolve(chrome.runtime.lastError ? null : resp)
        );
      } catch {
        // Extension wurde neu geladen - dieses Content-Script ist verwaist
        resolve(null);
      }
    });
  }

  function sendBatch(batch) {
    const gen = generation;
    batchesInFlight++;
    batch.forEach((b) => inFlight.set(b.id, b));
    requestScores(batch.map((b) => ({ id: b.id, text: b.text }))).then((resp) => handleBatchResult(batch, gen, resp));
  }

  function handleBatchResult(batch, gen, resp) {
    batchesInFlight--;
    batch.forEach((b) => inFlight.get(b.id) === b && inFlight.delete(b.id));
    pump();
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
    nearObserver.unobserve(el);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pending", "aivsai-deferred", "aivsai-pos");
    if (el.dataset.aivsaiTitle) el.removeAttribute("title");
    for (const key of ["aivsaiScore", "aivsaiLevel", "aivsaiLabel", "aivsaiTitle"]) delete el.dataset[key];
  }

  function restyleAll() {
    document.querySelectorAll("[data-aivsai-score]").forEach(style);
    for (const [range, p] of manualRanges) highlightRange(range, p);
  }

  function clearAll() {
    generation++;
    pending.clear();
    inFlight.clear(); // laufende Batches gehören zur alten Generation, ihr Ergebnis wird verworfen
    clearTimeout(debounceTimer);
    clearTimeout(pumpTimer);
    document.querySelectorAll("[data-aivsai-hash]").forEach((el) => {
      unstyle(el);
      delete el.dataset.aivsaiHash;
    });
    lastError = null;
    for (const range of manualRanges.keys()) highlightRange(range, undefined);
    manualRanges.clear();
    hidePopover();
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
    counts.deferred = document.querySelectorAll(".aivsai-deferred").length;
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

  // ---------------------------------------------------------------------------
  // Manuelle Prüfung per Rechtsklick/Tastenkürzel: markierter Text oder der Absatz unter
  // dem Mauszeiger - auch wenn die Seite nicht automatisch gescannt wird oder der Text
  // für den Auto-Scan zu kurz ist bzw. ausgeschlossen wurde.
  // ---------------------------------------------------------------------------

  document.addEventListener("contextmenu", (e) => (contextTarget = e.target), true);

  function checkSelection() {
    const sel = getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
    if (!text) {
      showPopover({}, ++popoverToken, { error: "Kein Text markiert." });
      return;
    }
    const range = sel.getRangeAt(0).cloneRange();
    sel.collapseToEnd(); // sonst verdeckt die Auswahlfarbe die Markierung
    checkManual(text, { range });
  }

  // Nächstes Block-Element mit genug Text, z.B. ein <div> ohne <p> oder ein kurzer Listeneintrag
  function blockFor(node) {
    for (let el = node instanceof Element ? node : node?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (getComputedStyle(el).display.startsWith("inline")) continue;
      if (wordCount(el.innerText || "") >= MANUAL_MIN_WORDS) return el;
    }
    return null;
  }

  function checkElement() {
    const target = contextTarget?.isConnected ? contextTarget : null;
    const el = blockFor(target);
    if (!el) {
      const words = wordCount(target?.innerText || target?.textContent || "");
      showPopover({ el: target }, ++popoverToken, { error: tooShort(words) });
      return;
    }
    // Hash wie beim Auto-Scan, damit der Absatz dort nicht noch einmal eingereiht wird
    const text = el.innerText.trim();
    const hash = hashText(text);
    pending.delete(hash);
    el.dataset.aivsaiHash = hash;
    checkManual(text, { el });
  }

  function tooShort(words) {
    return `Zu wenig Text (${words} ${words === 1 ? "Wort" : "Wörter"}) – mindestens ${MANUAL_MIN_WORDS} Wörter nötig.`;
  }

  async function checkManual(fullText, target) {
    const token = ++popoverToken;
    const words = wordCount(fullText);
    if (!config.enabled) {
      showPopover(target, token, { error: "Die Extension ist ausgeschaltet." });
      return;
    }
    if (words < MANUAL_MIN_WORDS) {
      showPopover(target, token, { error: tooShort(words) });
      return;
    }
    const text = fullText.slice(0, MANUAL_MAX_CHARS);
    const id = `m_${hashText(text)}`;
    const gen = generation;
    markManual(target, null);
    showPopover(target, token, { loading: true });

    const resp = await requestScores([{ id, text }]);
    if (gen !== generation) return;
    const p = resp?.scores?.[id];
    if (typeof p !== "number") {
      markManual(target, undefined);
      const error = resp?.error || (resp ? "Keine Bewertung erhalten." : "Extension nicht erreichbar – Seite neu laden.");
      showPopover(target, token, { error });
      return;
    }
    markManual(target, p);
    showPopover(target, token, { p, words, truncated: fullText.length > MANUAL_MAX_CHARS });
    reportStats();
  }

  // probability: Zahl = Ergebnis, null = wird geprüft, undefined = Markierung entfernen
  function markManual({ range, el }, probability) {
    if (range) {
      if (probability === undefined) manualRanges.delete(range);
      else manualRanges.set(range, probability);
      highlightRange(range, probability);
    }
    if (el) {
      if (probability === null) {
        unstyle(el);
        el.classList.add("aivsai-pending");
      } else if (probability === undefined) {
        el.classList.remove("aivsai-pending");
      } else {
        applyScore(el, probability);
      }
    }
  }

  // CSS Custom Highlight API: färbt beliebige Textbereiche, ohne das DOM der Seite anzufassen
  function highlightRange(range, probability) {
    if (!window.CSS?.highlights) return;
    for (const state of HIGHLIGHT_STATES) CSS.highlights.get(`aivsai-${state}`)?.delete(range);
    if (probability === undefined) return;
    const name = `aivsai-${probability === null ? "pending" : AIVSAI.level(probability, config)}`;
    if (!CSS.highlights.has(name)) CSS.highlights.set(name, new Highlight());
    CSS.highlights.get(name).add(range);
  }

  const POPOVER_CSS = `
    :host { all: initial; position: absolute; z-index: 2147483647; }
    .box {
      --bg: #fff; --fg: #1f2937; --muted: #6b7280; --border: rgba(0, 0, 0, 0.12); --error: #dc2626;
      box-sizing: border-box; width: 280px; max-width: calc(100vw - 16px); position: relative;
      padding: 10px 30px 10px 12px; border: 1px solid var(--border); border-radius: 10px;
      background: var(--bg); color: var(--fg); box-shadow: 0 6px 24px rgba(0, 0, 0, 0.18);
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .box { --bg: #1f2937; --fg: #f3f4f6; --muted: #9ca3af; --border: rgba(255, 255, 255, 0.15); --error: #f87171; }
    }
    .close {
      position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0;
      border: 0; border-radius: 6px; background: none; color: var(--muted);
      font: 16px/22px system-ui, sans-serif; cursor: pointer;
    }
    .close:hover { background: var(--border); color: var(--fg); }
    .head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .pill { padding: 0 7px; border-radius: 999px; color: #fff; font-size: 12px; line-height: 19px; white-space: nowrap; }
    .green { background: #15803d; }
    .yellow { background: #a16207; }
    .red { background: #dc2626; }
    .note { margin-top: 4px; color: var(--muted); font-size: 12px; }
    .error { color: var(--error); }
  `;

  function showPopover(target, token, state) {
    if (token !== popoverToken) return; // eine neuere Prüfung hat das Popover übernommen
    if (!popover) {
      popover = document.createElement("aivsai-popover");
      const shadow = popover.attachShadow({ mode: "open" });
      shadow.innerHTML =
        `<style>${POPOVER_CSS}</style>` +
        `<div class="box" role="status" aria-live="polite">` +
        `<button class="close" type="button" aria-label="Schließen" title="Schließen">×</button>` +
        `<div class="body"></div></div>`;
      shadow.querySelector(".close").addEventListener("click", hidePopover);
    }
    const div = (cls, text) => {
      const node = document.createElement(cls === "pill" ? "span" : "div");
      node.className = cls;
      node.textContent = text;
      return node;
    };
    const body = popover.shadowRoot.querySelector(".body");
    body.replaceChildren();

    if (state.loading) {
      body.append(div("head", "Wird auf KI geprüft…"), div("note", AIVSAI.providerLabel(config)));
    } else if (state.error) {
      body.append(div("error", state.error));
    } else {
      const level = AIVSAI.level(state.p, config);
      const pill = div("pill", `${Math.round(state.p * 100)} % KI`);
      pill.classList.add(level);
      const head = div("head", "");
      head.append(pill, AIVSAI.LEVEL_TEXT[level]);
      body.append(head);
      if (state.words < MIN_WORDS) {
        body.append(div("note", `Kurzer Text (${state.words} Wörter) – Ergebnis wenig verlässlich.`));
      }
      if (state.truncated) body.append(div("note", `Nur die ersten ${MANUAL_MAX_CHARS} Zeichen bewertet.`));
      body.append(div("note", `${AIVSAI.providerLabel(config)} · Schätzung, kann falsch liegen`));
    }

    if (!popover.isConnected) document.documentElement.append(popover);
    positionPopover(target);
  }

  // Unter den geprüften Text, aber immer im sichtbaren Bereich - lange Absätze ragen oft darüber hinaus
  function positionPopover({ range, el }) {
    const anchor = range || (el?.isConnected ? el : null);
    const rect = anchor?.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect ? rect.left : innerWidth, innerWidth - box.width - 8));
    const y = Math.max(8, Math.min(rect ? rect.bottom + 8 : 8, innerHeight - box.height - 8));
    popover.style.left = `${x + scrollX}px`;
    popover.style.top = `${y + scrollY}px`;
  }

  function hidePopover() {
    popoverToken++;
    popover?.remove();
  }

  document.addEventListener("keydown", (e) => e.key === "Escape" && popover?.isConnected && hidePopover(), true);
  document.addEventListener(
    "mousedown",
    (e) => popover?.isConnected && !e.composedPath().includes(popover) && hidePopover(),
    true
  );

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
