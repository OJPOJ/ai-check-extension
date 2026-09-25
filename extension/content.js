(() => {
  const MIN_WORDS = 40;
  const MAX_CHARS = 500;
  const BATCH_SIZE = 5;
  const DEBOUNCE_MS = 600;
  // lazyScan: nur Absätze bis zu so vielen Bildschirmhöhen über/unter dem sichtbaren
  // Bereich bewerten, der Rest folgt beim Scrollen
  const NEAR_SCREENS = 1.5;
  const CANDIDATE_SELECTOR = "article, p, li";
  // Absätze innerhalb dieser Bereiche nie bewerten: Navigation/Seitenrahmen (auch ohne semantische
  // Tags), Dialoge (meist Cookie-/Consent-Banner - Standardtext, der gern als KI gilt), Code, Eingaben.
  // Bewusst NICHT: aria-hidden/inert (viele Seiten verstecken damit den ganzen Inhalt, solange ein
  // Modal offen ist - dann würde nie gescannt), form (ASP.NET packt die ganze Seite in ein <form>).
  const EXCLUDE_SELECTOR =
    "nav, header, footer, script, style, noscript, template, pre, dialog, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], [role='search'], " +
    "[role='dialog'], [role='alertdialog'], " +
    "[contenteditable], [contenteditable='true'], textarea, input, select, button, " +
    "[role='textbox']";
  // Innerhalb eines Absatzes herausrechnen: Icon-Fonts ("chevron_right"), Code-Blöcke
  const STRIP_SELECTOR = "[aria-hidden='true'], pre";
  const LEVEL_CLASSES = ["aivsai-green", "aivsai-yellow", "aivsai-red", "aivsai-badge"];
  // Manuelle Prüfung: kürzere Texte erlaubt und mehr Text als beim Auto-Scan
  // (die Modelle schneiden ohnehin bei 512 Tokens ab)
  const MANUAL_MIN_WORDS = 5;
  const MANUAL_MAX_CHARS = 2000;
  const HIGHLIGHT_STATES = ["pending", "green", "yellow", "red"];
  // Heuristik "sensible Seite": sichtbares Passwort-, Zahlungs- oder Einmalcode-Feld. Felder in Dialogen
  // zählen nicht - sonst beendet das Login-Popup einer News-Seite den Scan des Artikels darunter.
  const SENSITIVE_SELECTOR =
    "input[type='password'], input[autocomplete^='cc-'], input[autocomplete='one-time-code']";
  const DIALOG_SELECTOR = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
  const BLOCK_MESSAGES = {
    list: "Diese Seite steht auf der Sperrliste",
    sensitive: "Diese Seite enthält ein Passwort- oder Zahlungsfeld"
  };
  const host = location.hostname;
  const Popover = AIVSAIPopover;

  let config = { ...AIVSAI.DEFAULTS };
  let manualScan = false; // "Diese Seite scannen" aus Popup/Tastenkürzel, gilt bis zum Neuladen
  let generation = 0; // erhöht bei jedem Neu-Scan, damit veraltete Antworten verworfen werden
  let lastError = null;
  let sensitive = false; // Heuristik hat angeschlagen - gilt bis zum Neuladen

  // Ergebnis-Register - die eine Quelle für Statistik, Neu-Einfärben und später Feedback/Berichte.
  //   results:      Element -> { hash, text, p, model, source: "auto" | "manual", at }
  //   manualRanges: Range   -> { text, p, model, at } bzw. null, solange die Prüfung läuft
  const results = new Map();
  const manualRanges = new Map();
  const seen = new Map(); // textHash -> { p, model }, damit gleiche Absätze nur einmal bewertet werden

  // Warteschlange: textHash -> { id, text, els, near }
  const pending = new Map();
  const inFlight = new Map();
  let batchesInFlight = 0;

  let debounceTimer = null;
  let mutationTimer = null;
  let statsTimer = null;
  let pumpTimer = null;
  const addedNodes = new Set();
  let contextTarget = null; // Element unter dem letzten Rechtsklick
  const staticPosition = new WeakMap(); // Element -> position: static? (getComputedStyle nur einmal)

  // Live-Collections: Zählen ohne Dokument-Scan
  const pendingEls = document.getElementsByClassName("aivsai-pending");
  const deferredEls = document.getElementsByClassName("aivsai-deferred");

  // Meldet, wenn ein zurückgestellter Absatz in die Nähe des sichtbaren Bereichs kommt -
  // deckt Scrollen, Fenstergröße und aufgeklappte Inhalte ab, ohne Scroll-Listener.
  const nearObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) schedulePump();
    },
    { rootMargin: `${NEAR_SCREENS * 100}% 0px` }
  );

  // Nachgeladene Inhalte (Infinite Scroll, SPAs) - Knoten über die Debounce-Zeit sammeln,
  // damit keine Mutationen verloren gehen, wenn der Timer neu startet.
  // Läuft nur, solange auf der Seite gescannt wird (siehe syncObserver).
  const mutationObserver = new MutationObserver((mutations) => {
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
      // z.B. SPA, die nach dem Laden auf die Login-Seite wechselt: sofort aufhören
      if (nodes.some(detectSensitive)) {
        clearAll();
        syncObserver();
        reportStats();
        return;
      }
      nodes.forEach(scanAndQueue);
    }, DEBOUNCE_MS);
  });

  chrome.storage.sync.get(AIVSAI.DEFAULTS, (stored) => {
    config = { ...AIVSAI.DEFAULTS, ...stored };
    detectSensitive(document.body);
    syncObserver();
    if (isActive()) scanAndQueue(document.body);
    reportStats();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const wasActive = isActive();
    for (const [key, change] of Object.entries(changes)) config[key] = change.newValue ?? AIVSAI.DEFAULTS[key];
    if ("sensitiveHeuristic" in changes) detectSensitive(document.body);
    syncObserver();

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

  const MESSAGE_HANDLERS = {
    SCAN_NOW: () => {
      // auf Seiten ohne Auto-Scan lief bisher keine Erkennung (kein MutationObserver)
      detectSensitive(document.body);
      // Popup bietet den Knopf dort gar nicht an - bleibt das Tastenkürzel
      if (policy() === "blocked") {
        Popover.show({}, Popover.claim(), {
          error: `${BLOCK_MESSAGES[blockReason()]} und wird nicht gescannt.`,
          notes: ["Einzelne Stellen: Text markieren oder Absatz rechtsklicken → „Auf KI prüfen“."]
        });
        return stats();
      }
      manualScan = true;
      syncObserver();
      rescanAll();
      return stats();
    },
    MODEL_READY: () => {
      if (isActive() && lastError) rescanAll();
    },
    GET_STATS: () => stats(),
    CHECK_SELECTION: () => checkSelection(),
    CHECK_ELEMENT: () => checkElement()
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = MESSAGE_HANDLERS[msg?.type];
    if (!handler) return;
    const result = handler(msg);
    if (result !== undefined) sendResponse(result);
  });

  // "list" (Sperrliste), "sensitive" (Heuristik) oder null
  function blockReason() {
    if (!config.enabled) return null;
    if (AIVSAI.blockReason(host, config)) return "list";
    return sensitive && config.sensitiveHeuristic ? "sensitive" : null;
  }

  function policy() {
    const p = AIVSAI.scanPolicy(host, config);
    return p !== "off" && blockReason() ? "blocked" : p;
  }

  // true, wenn in `root` ein sichtbares sensibles Feld steckt (dann bleibt `sensitive` gesetzt)
  function detectSensitive(root) {
    if (sensitive || !config.sensitiveHeuristic || root?.nodeType !== Node.ELEMENT_NODE) return false;
    const fields = root.matches(SENSITIVE_SELECTOR) ? [root] : root.querySelectorAll(SENSITIVE_SELECTOR);
    for (const field of fields) {
      if (!field.closest(DIALOG_SELECTOR) && field.checkVisibility()) return (sensitive = true);
    }
    return false;
  }

  function isActive() {
    const p = policy();
    return p === "auto" || (manualScan && p === "manual");
  }

  function syncObserver() {
    if (isActive()) {
      mutationObserver.observe(document.documentElement, { childList: true, subtree: true });
    } else {
      mutationObserver.disconnect();
      clearTimeout(mutationTimer);
      addedNodes.clear();
    }
  }

  // cyrb53: schneller 53-Bit-Hash - identifiziert Absätze innerhalb der Seite (Warteschlange, Duplikate).
  // Der dauerhafte Speicher im Service Worker nutzt SHA-256 über den Text selbst.
  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return `${text.length}_${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
  }

  // Sichtbarer Text ohne Icon-Fonts und Code-Blöcke. Nur lesen - Teil von Phase 1 in collectCandidates.
  function readText(el) {
    let text = el.innerText || "";
    if (el.querySelector(STRIP_SELECTOR)) {
      for (const part of el.querySelectorAll(STRIP_SELECTOR)) {
        const t = (part.innerText || "").trim();
        if (t) text = text.replace(t, " ");
      }
    }
    return text.trim();
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

  function isQueuedOrScored(el) {
    return results.has(el) || el.classList.contains("aivsai-pending") || el.classList.contains("aivsai-deferred");
  }

  function collectCandidates(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    // Phase 1 nur lesen. innerText braucht aktuelle Styles - würden zwischen den Lesezugriffen
    // Klassen geändert, müsste der Browser für jeden Absatz neu rechnen (Layout-Thrashing).
    const found = [];
    for (const el of candidatesIn(root)) {
      // billiger Vorfilter ohne Layout: 40 Wörter brauchen mindestens 40 Zeichen
      if ((el.textContent || "").length < MIN_WORDS) continue;
      if (el.closest(EXCLUDE_SELECTOR) || hasLongCandidateChild(el)) continue;
      const text = readText(el);
      if (!text || wordCount(text) < MIN_WORDS) continue;
      const hash = hashText(text);
      if (el.dataset.aivsaiHash === hash && isQueuedOrScored(el)) continue;
      found.push({ el, text, hash });
    }

    // Phase 2 nur schreiben
    for (const { el, text, hash } of found) {
      el.dataset.aivsaiHash = hash;
      unstyle(el); // Text hat sich geändert - alte Bewertung gilt nicht mehr

      const known = seen.get(hash);
      if (known) {
        applyScore(el, { hash, text: text.slice(0, MAX_CHARS), ...known, source: "auto" });
        continue;
      }
      const entry = inFlight.get(hash) || pending.get(hash);
      if (entry) {
        entry.els.push(el);
      } else {
        pending.set(hash, { id: hash, text: text.slice(0, MAX_CHARS), els: [el], near: true });
      }
      el.classList.add("aivsai-pending");
    }
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

  // Abstand zum sichtbaren Bereich in px (0 = sichtbar) und Position des nächsten Elements.
  // Unsichtbare/abgehängte Elemente kommen ganz nach hinten.
  function viewportDistance(entry) {
    let dist = Infinity;
    let top = Infinity;
    for (const el of entry.els) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const d = r.bottom < 0 ? -r.bottom : r.top > innerHeight ? r.top - innerHeight : 0;
      if (d < dist) {
        dist = d;
        top = r.top;
      }
    }
    return { dist, top };
  }

  function markQueued(entry) {
    for (const el of entry.els) {
      el.classList.toggle("aivsai-pending", entry.near);
      el.classList.toggle("aivsai-deferred", !entry.near);
      if (entry.near) nearObserver.unobserve(el);
      else nearObserver.observe(el);
    }
  }

  // Priorität wird erst beim Absenden bestimmt, nicht beim Einreihen: so bekommt nach
  // einem Scroll automatisch der dann sichtbare Bereich den nächsten freien Slot.
  // Ohne Scrollen ergibt das einfach "von oben nach unten".
  function takeNextBatch() {
    const limit = config.lazyScan ? NEAR_SCREENS * innerHeight : Infinity;

    // Phase 1 lesen: Positionen aller wartenden Absätze
    const ranked = [];
    for (const entry of pending.values()) {
      if (!entry.els.some((el) => el.isConnected)) {
        pending.delete(entry.id); // SPA hat den Absatz inzwischen entfernt
        continue;
      }
      const { dist, top } = viewportDistance(entry);
      // nicht gerendert (display:none, hidden, zugeklappt): nie senden, auch ohne lazyScan -
      // wird es sichtbar, meldet sich der nearObserver
      entry.near = dist !== Infinity && dist <= limit;
      if (entry.near) ranked.push({ entry, dist, top });
    }
    ranked.sort((a, b) => a.dist - b.dist || a.top - b.top);
    const batch = ranked.slice(0, BATCH_SIZE).map((r) => r.entry);
    batch.forEach((b) => pending.delete(b.id));

    // Phase 2 schreiben: Markierung "wird geprüft" bzw. "beim Scrollen"
    pending.forEach(markQueued);
    batch.forEach(markQueued);
    return batch;
  }

  // Batches nacheinander statt alle auf einmal - sonst rechnet der Server alles parallel
  // und die Priorisierung hätte keinen Effekt.
  function pump() {
    const maxInFlight = AIVSAI.maxInFlight(config);
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

  // manual: ausdrücklich angeforderte Einzelprüfung - der Service Worker lässt nur die auf Seiten der Sperrliste zu
  function requestScores(items, manual = false) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "SCORE_BATCH", items, manual }, (resp) =>
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
        const known = { p, model: resp.model };
        seen.set(b.id, known);
        b.els.forEach((el) => applyScore(el, { hash: b.id, text: b.text, ...known, source: "auto" }));
      } else {
        b.els.forEach((el) => el.classList.remove("aivsai-pending"));
      }
    }
    reportStats();
  }

  function applyScore(el, record) {
    results.set(el, { ...record, at: record.at ?? Date.now() });
    el.classList.remove("aivsai-pending");
    style(el);
  }

  function style(el) {
    const { p } = results.get(el);
    // vor allen Schreibzugriffen lesen, sonst erzwingt getComputedStyle eine Neuberechnung
    if (config.showBadge && !staticPosition.has(el)) {
      staticPosition.set(el, getComputedStyle(el).position === "static");
    }
    const level = AIVSAI.level(p, config);
    const pct = Math.round(p * 100);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pos");
    // nur als Hook für Tests/Debugging - der Code selbst liest aus `results`
    el.dataset.aivsaiScore = String(p);
    el.dataset.aivsaiLevel = level;

    const visible = level !== "green" || config.showGreen;
    if (visible) {
      el.classList.add(`aivsai-${level}`);
      if (config.showBadge) {
        el.dataset.aivsaiLabel = `${pct}% KI`;
        el.classList.add("aivsai-badge");
        // Badge wird per ::after absolut positioniert und braucht dafür einen Bezugsrahmen
        if (staticPosition.get(el)) el.classList.add("aivsai-pos");
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
    results.delete(el);
    nearObserver.unobserve(el);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pending", "aivsai-deferred", "aivsai-pos");
    if (el.dataset.aivsaiTitle) el.removeAttribute("title");
    for (const key of ["aivsaiScore", "aivsaiLevel", "aivsaiLabel", "aivsaiTitle"]) delete el.dataset[key];
  }

  function restyleAll() {
    for (const el of results.keys()) {
      if (el.isConnected) style(el);
    }
    for (const [range, rec] of manualRanges) highlightRange(range, rec ? rec.p : null);
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
    results.clear();
    lastError = null;
    for (const range of manualRanges.keys()) highlightRange(range, undefined);
    manualRanges.clear();
    Popover.hide();
  }

  function rescanAll() {
    clearAll();
    seen.clear();
    scanAndQueue(document.body);
  }

  function stats() {
    const counts = { red: 0, yellow: 0, green: 0 };
    for (const [el, rec] of results) {
      // entfernte Absätze (SPA, Infinite Scroll) nicht mehr zählen und nicht im Speicher halten
      if (!el.isConnected) results.delete(el);
      else counts[AIVSAI.level(rec.p, config)]++;
    }
    return {
      ...counts,
      pending: pendingEls.length,
      deferred: deferredEls.length,
      active: isActive(),
      blocked: policy() === "blocked",
      blockReason: blockReason(),
      manualScan,
      error: lastError,
      host
    };
  }

  // Geht an Background (Icon-Badge) und ein offenes Popup
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
      Popover.show({}, Popover.claim(), { error: "Kein Text markiert." });
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
      Popover.show({ el: target }, Popover.claim(), { error: tooShort(words) });
      return;
    }
    // Hash wie beim Auto-Scan, damit der Absatz dort nicht noch einmal eingereiht wird
    const text = el.innerText.trim();
    const hash = hashText(text);
    pending.delete(hash);
    el.dataset.aivsaiHash = hash;
    checkManual(text, { el, hash });
  }

  function tooShort(words) {
    return `Zu wenig Text (${words} ${words === 1 ? "Wort" : "Wörter"}) – mindestens ${MANUAL_MIN_WORDS} Wörter nötig.`;
  }

  async function checkManual(fullText, target) {
    const token = Popover.claim();
    const words = wordCount(fullText);
    if (!config.enabled) {
      Popover.show(target, token, { error: "Die Extension ist ausgeschaltet." });
      return;
    }
    if (words < MANUAL_MIN_WORDS) {
      Popover.show(target, token, { error: tooShort(words) });
      return;
    }
    const text = fullText.slice(0, MANUAL_MAX_CHARS);
    const id = `m_${hashText(text)}`;
    const gen = generation;
    markManual(target, null);
    Popover.show(target, token, { title: "Wird auf KI geprüft…", notes: [AIVSAI.providerLabel(config), ...blockedNotes()] });

    const resp = await requestScores([{ id, text }], true);
    if (gen !== generation) return;
    const p = resp?.scores?.[id];
    if (typeof p !== "number") {
      markManual(target, undefined);
      const error = resp?.error || (resp ? "Keine Bewertung erhalten." : "Extension nicht erreichbar – Seite neu laden.");
      Popover.show(target, token, { error });
      return;
    }
    markManual(target, { text, p, model: resp.model, at: Date.now() });
    Popover.show(target, token, resultView(p, words, fullText.length > MANUAL_MAX_CHARS));
    reportStats();
  }

  function resultView(p, words, truncated) {
    const level = AIVSAI.level(p, config);
    const notes = [];
    if (words < MIN_WORDS) notes.push(`Kurzer Text (${words} Wörter) – Ergebnis wenig verlässlich.`);
    if (truncated) notes.push(`Nur die ersten ${MANUAL_MAX_CHARS} Zeichen bewertet.`);
    notes.push(`${AIVSAI.providerLabel(config)} · Schätzung, kann falsch liegen`, ...blockedNotes());
    return { pill: { text: `${Math.round(p * 100)} % KI`, level }, title: AIVSAI.LEVEL_TEXT[level], notes };
  }

  // Auf gesperrten Seiten ist nur die Einzelprüfung erlaubt - dann transparent machen, was passiert ist
  function blockedNotes() {
    const reason = blockReason();
    if (!reason) return [];
    const target = AIVSAI.remoteTarget(config);
    return [
      `${BLOCK_MESSAGES[reason]} – geprüft, weil du es ausdrücklich angefordert hast.`,
      ...(target ? [`Der Text wurde an ${target} gesendet.`] : [])
    ];
  }

  // record: Ergebnis-Objekt, null = wird geprüft, undefined = Markierung entfernen
  function markManual({ range, el, hash }, record) {
    if (range) {
      if (record === undefined) manualRanges.delete(range);
      else manualRanges.set(range, record);
      highlightRange(range, record === undefined ? undefined : record ? record.p : null);
    }
    if (el) {
      if (record === null) {
        unstyle(el);
        el.classList.add("aivsai-pending");
      } else if (record === undefined) {
        el.classList.remove("aivsai-pending");
      } else {
        applyScore(el, { ...record, hash, source: "manual" });
      }
    }
  }

  // CSS Custom Highlight API: färbt beliebige Textbereiche, ohne das DOM der Seite anzufassen.
  // probability: Zahl = Ergebnis, null = wird geprüft, undefined = Markierung entfernen
  function highlightRange(range, probability) {
    if (!window.CSS?.highlights) return;
    for (const state of HIGHLIGHT_STATES) CSS.highlights.get(`aivsai-${state}`)?.delete(range);
    if (probability === undefined) return;
    const name = `aivsai-${probability === null ? "pending" : AIVSAI.level(probability, config)}`;
    if (!CSS.highlights.has(name)) CSS.highlights.set(name, new Highlight());
    CSS.highlights.get(name).add(range);
  }
})();
