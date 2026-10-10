(() => {
  const Manual = AIVSAI_MANUAL;
  const MIN_WORDS = Manual.MIN_WORDS;
  // Lower bound for paragraphs that may become a candidate ONLY as part of a group (see groupCandidates,
  // Manual.groupRuns); the reasoning for 15 is in manual-check.js
  const GROUP_MIN_WORDS = Manual.GROUP_MIN_WORDS;
  // How much text per paragraph goes to the model is determined by the model (AIVSAI.maxChars: TMR 2000, desklib
  // 1500 characters): more context helps a lot (TMR: 500 instead of 1500 characters = ~9% instead of <1% errors), chunks
  // are worse than one piece (training/EVAL_RESULTS.md, "Text length"). Applies equally to auto-scan and manual
  // check, so that the same paragraph always yields the same text and thus the same score/feedback entry.
  // Batches by amount of text instead of just by count: costs about as much compute time as 5 × 500
  // characters did before - a batch of long paragraphs would otherwise block the prioritization while scrolling.
  const BATCH_MAX_ITEMS = Manual.BATCH_MAX_ITEMS;
  const BATCH_MAX_CHARS = Manual.BATCH_MAX_CHARS;
  const DEBOUNCE_MS = 600;
  // lazyScan: only score paragraphs up to this many screen heights above/below the visible
  // area, the rest follows on scrolling
  const NEAR_SCREENS = 1.5;
  const CANDIDATE_SELECTOR = "article, p, li";
  // Never score paragraphs within these areas: navigation/page frame (even without semantic
  // tags), dialogs (mostly cookie/consent banners - boilerplate text that is readily taken for AI), code, inputs.
  // Deliberately NOT: aria-hidden/inert (many sites hide the entire content with it while a
  // modal is open - then nothing would ever be scanned), form (ASP.NET wraps the whole page in a <form>).
  const EXCLUDE_SELECTOR =
    "nav, header, footer, script, style, noscript, template, pre, dialog, " +
    "[role='navigation'], [role='banner'], [role='contentinfo'], [role='search'], " +
    "[role='dialog'], [role='alertdialog'], " +
    "[contenteditable], [contenteditable='true'], textarea, input, select, button, " +
    "[role='textbox']";
  // Strip out within a paragraph: icon fonts ("chevron_right"), code blocks
  const STRIP_SELECTOR = "[aria-hidden='true'], pre";
  const LEVEL_CLASSES = ["aivsai-green", "aivsai-yellow", "aivsai-red", "aivsai-uncertain", "aivsai-badge"];
  const MANUAL_MIN_WORDS = Manual.MANUAL_MIN_WORDS;
  const HIGHLIGHT_STATES = ["pending", "green", "yellow", "red", "uncertain"];
  // Heuristic "sensitive site": visible password, payment or one-time-code field. Fields in dialogs
  // do not count - otherwise the login popup of a news site ends the scan of the article underneath.
  const SENSITIVE_SELECTOR =
    "input[type='password'], input[autocomplete^='cc-'], input[autocomplete='one-time-code']";
  const DIALOG_SELECTOR = "dialog, [role='dialog'], [role='alertdialog'], [aria-modal='true']";
  const BLOCK_MESSAGES = {
    list: "This site is on the blocklist",
    sensitive: "This site contains a password or payment field"
  };
  const host = location.hostname;
  const Popover = AIVSAIPopover;

  let config = { ...AIVSAI.DEFAULTS };
  let manualScan = false; // "Scan page now" from popup/keyboard shortcut, applies until reload
  let generation = 0; // incremented on every rescan, so that stale responses are discarded
  let lastError = null;
  let sensitive = false; // heuristic has triggered - applies until reload

  // Result registry - the one source for statistics, recoloring and later feedback/reports.
  //   results:      element -> { hash, text, truncated, words, p, model, source: "auto" | "manual", at, foreign? }
  //   manualRanges: Range   -> { text, truncated, words, p, model, at, foreign? } or null while the check is running
  //   skipped:      element -> language ("de", ...): not scored by the auto-scan, the model does not know it
  // words = word count of the whole text (-> level "uncertain"), foreign = language, if checked anyway
  const results = new Map();
  const manualRanges = new Map();
  const skipped = new Map();
  const seen = new Map(); // textHash -> { p, model }, so that identical paragraphs are scored only once

  // Queue: textHash -> { id, text, els, near }
  const pending = new Map();
  const inFlight = new Map();
  let batchesInFlight = 0;

  let debounceTimer = null;
  let mutationTimer = null;
  let statsTimer = null;
  let pumpTimer = null;
  const addedNodes = new Set();
  let contextTarget = null; // element under the last right-click
  const staticPosition = new WeakMap(); // element -> position: static? (getComputedStyle only once)

  // Live collections: counting without a document scan
  const pendingEls = document.getElementsByClassName("aivsai-pending");
  const deferredEls = document.getElementsByClassName("aivsai-deferred");

  // Reports when a deferred paragraph comes near the visible area -
  // covers scrolling, window size and expanded content, without a scroll listener.
  const nearObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) schedulePump();
    },
    { rootMargin: `${NEAR_SCREENS * 100}% 0px` }
  );

  // Lazy-loaded content (infinite scroll, SPAs) - collect nodes over the debounce time,
  // so that no mutations are lost when the timer restarts.
  // Only runs while the site is being scanned (see syncObserver).
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
      // e.g. an SPA that switches to the login page after loading: stop immediately
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
      // when switching off, also remove manually checked passages, which can exist without auto-scan
      if (wasActive || ("enabled" in changes && !config.enabled)) clearAll();
    } else if (!wasActive || AIVSAI.PROVIDER_KEYS.some((k) => k in changes) || "groupShortParagraphs" in changes) {
      rescanAll();
    } else {
      restyleAll();
      if ("lazyScan" in changes) pump();
    }
    reportStats();
  });

  const MESSAGE_HANDLERS = {
    SCAN_NOW: () => {
      // on sites without auto-scan no detection has run so far (no MutationObserver)
      detectSensitive(document.body);
      // The popup does not offer the button there at all - the keyboard shortcut remains
      if (policy() === "blocked") {
        Popover.show({}, Popover.claim(), {
          error: `${BLOCK_MESSAGES[blockReason()]} and is not scanned.`,
          notes: ["Single passages: select text or right-click a paragraph → \"Check for AI\"."]
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
    GET_FLAGGED: () => flaggedList(),
    JUMP_TO: ({ id }) => jumpTo(id),
    // Always answer: background.js treats "no answer" (no content script) and `fallback` as "show the result in
    // its own window" - the PDF viewer's top frame has this script, but the selection lives in the viewer.
    CHECK_SELECTION: ({ selectionText }) => {
      const sel = getSelection();
      if (selectionText && (!sel || sel.isCollapsed)) return { fallback: true };
      checkSelection();
      return { fallback: false };
    },
    CHECK_ELEMENT: () => {
      if (!contextTarget?.isConnected) return { fallback: true };
      checkElement();
      return { fallback: false };
    },
    // Text from outside this document (selection in the PDF viewer, delivered by the context menu): same popover as
    // for page text, shown over the viewer. No feedback collection - the text may come from a document.
    CHECK_TEXT: ({ text }) => {
      const clean = (text || "").replace(/\s+/g, " ").trim();
      if (!clean) {
        Popover.show({}, Popover.claim(), {
          error: "No text selected. Select text first, then right-click → \"Check selected text for AI\"."
        });
      } else {
        checkManual(clean, { noFeedback: true });
      }
      return { fallback: false };
    }
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    const handler = MESSAGE_HANDLERS[msg?.type];
    if (!handler) return;
    const result = handler(msg);
    if (result !== undefined) sendResponse(result);
  });

  // "list" (blocklist), "sensitive" (heuristic) or null
  function blockReason() {
    if (!config.enabled) return null;
    if (AIVSAI.blockReason(host, config)) return "list";
    return sensitive && config.sensitiveHeuristic ? "sensitive" : null;
  }

  function policy() {
    const p = AIVSAI.scanPolicy(host, config);
    return p !== "off" && blockReason() ? "blocked" : p;
  }

  // true if `root` contains a visible sensitive field (then `sensitive` stays set)
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

  // cyrb53: fast 53-bit hash - identifies paragraphs within the page (queue, duplicates).
  // The persistent store in the service worker uses SHA-256 over the text itself.
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

  // Visible text without icon fonts and code blocks. Read only - part of phase 1 in collectCandidates.
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

  const clipText = (text) => Manual.clipText(text, config);
  const wordCount = Manual.wordCount;

  // ---------------------------------------------------------------------------
  // Grouping of short paragraphs (TODO.md item 2): adjacent paragraphs below reliableWords in the same
  // block container are scored as one text and share the result - more context lowers the
  // error rate sharply (training/EVAL_RESULTS.md, "Text length"). A paragraph that is already reliable (long)
  // on its own stays single, a group only grows up to maxChars (model context).
  // ---------------------------------------------------------------------------

  const GROUP_SEPARATOR = Manual.GROUP_SEPARATOR;
  // Heading or list between two paragraphs -> no longer "directly adjacent"
  const GROUP_BREAK_SELECTOR = "h1, h2, h3, h4, h5, h6, ul, ol, table, hr";

  // true if there is a heading or list between `a` and `b` (in document order) - via
  // Range instead of sibling chaining, so that it works independent of the nesting depth.
  function hasBreakBetween(a, b) {
    try {
      const range = document.createRange();
      range.setStartAfter(a);
      range.setEndBefore(b);
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (range.intersectsNode(n) && n.matches(GROUP_BREAK_SELECTOR)) return true;
      }
      return false;
    } catch {
      return true; // e.g. node removed in the meantime - when in doubt, do not group
    }
  }

  // Combine found (phase 1 from collectCandidates, in document order) into groups. Each group
  // is an array of found entries; single (long, foreign-language or unattachable) paragraphs
  // form a group with only one entry - phase 2 then treats them as before.
  function groupCandidates(found, cfg) {
    // Structural condition on a page: common parent node (block container) and no heading/list between
    return Manual.groupRuns(
      found,
      cfg,
      (last, f) => last.el.parentElement === f.el.parentElement && !hasBreakBetween(last.el, f.el)
    );
  }

  // Only score a container (e.g. <article>) if none of its child candidates can itself become a candidate
  // - otherwise nested double markings arise. Threshold GROUP_MIN_WORDS instead of
  // MIN_WORDS: since WP-10 children below MIN_WORDS can also become their own (grouped) candidates,
  // the container must then not additionally submit its entire text (acceptance criterion "no duplicate
  // with the container"). Downside: an isolated short paragraph without a groupable neighbor also leaves the
  // container empty-handed, instead of scoring the whole container as a fallback - see report.
  function hasLongCandidateChild(el) {
    for (const child of el.querySelectorAll(CANDIDATE_SELECTOR)) {
      if (wordCount(child.textContent || "") >= GROUP_MIN_WORDS) return true;
    }
    return false;
  }

  function candidatesIn(root) {
    const nodes = new Set();
    const ancestor = root.parentElement?.closest(CANDIDATE_SELECTOR);
    if (ancestor) nodes.add(ancestor); // text within a paragraph has changed
    if (root.matches(CANDIDATE_SELECTOR)) nodes.add(root);
    root.querySelectorAll(CANDIDATE_SELECTOR).forEach((el) => nodes.add(el));
    return nodes;
  }

  function isQueuedOrScored(el) {
    return (
      results.has(el) || skipped.has(el) || el.classList.contains("aivsai-pending") || el.classList.contains("aivsai-deferred")
    );
  }

  // lang attribute around `el` ("de-AT" -> "de"), "" if none
  const attrLang = (el) => (el?.closest("[lang]")?.lang || "").toLowerCase().split("-")[0];

  // Language of `text` ("de", ...; "" = unclear). If it is unclear (mixed, none of the detected languages),
  // the lang attribute (`attr`) decides in the auto-scan. The attribute alone is not enough: often missing,
  // set to the template default "en" or does not apply to the individual paragraph. Manual check without
  // `attr`: detection only - there the text is often short and the page's attribute is not a good hint,
  // and the user explicitly asked. Goes along to the server as `lang` (contract in server/README.md).
  async function detectLang(text, attr = "") {
    return (await AIVSAI_LANG.detectAsync(text)) || attr;
  }

  const foreignOf = (lang) => Manual.foreignOf(lang, config);
  const langList = Manual.langList;

  // Paragraphs whose language is currently being detected: element -> hash (prevents double queueing if
  // another scan runs in the meantime)
  const detecting = new Map();

  async function collectCandidates(root) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
    const gen = generation;

    // Phase 1 read only. innerText needs current styles - if classes were changed between the
    // reads, the browser would have to recompute for every paragraph (layout thrashing).
    const found = [];
    for (const el of candidatesIn(root)) {
      // cheap prefilter without layout: GROUP_MIN_WORDS words need at least that many characters
      if ((el.textContent || "").length < GROUP_MIN_WORDS) continue;
      if (el.closest(EXCLUDE_SELECTOR) || hasLongCandidateChild(el)) continue;
      const text = readText(el);
      const words = text ? wordCount(text) : 0;
      // a candidate at all from GROUP_MIN_WORDS; below MIN_WORDS only if groupCandidates brings it to
      // MIN_WORDS with neighbors (groupOnly) - otherwise it stays unscored as before
      if (words < GROUP_MIN_WORDS) continue;
      const hash = hashText(text);
      if ((el.dataset.aivsaiHash === hash && isQueuedOrScored(el)) || detecting.get(el) === hash) continue;
      detecting.set(el, hash);
      found.push({ el, text, hash, words, attr: attrLang(el), groupOnly: words < MIN_WORDS });
    }
    if (!found.length) return;

    // Detect language - for each paragraph individually, namely exactly the excerpt the model would see
    // (clipText). Asynchronous, writes nothing; afterwards discarded if everything was reset in the meantime
    // or a newer scan took over the same paragraph with different text. Lazy-loaded or changed
    // paragraphs pass through here again via the MutationObserver.
    const langs = await Promise.all(found.map((f) => detectLang(clipText(f.text), f.attr)));
    if (gen !== generation) return;
    found.forEach((f, i) => (f.lang = langs[i]));

    // Phase 2 write only. Groups now pass through instead of single paragraphs (group size 1 = as before).
    for (const items of groupCandidates(found, config)) {
      // fresh: only paragraphs whose text has not changed again since phase 1 (parallel scan)
      const fresh = items.filter((it) => detecting.get(it.el) === it.hash);
      if (!fresh.length) continue;
      for (const it of fresh) {
        detecting.delete(it.el);
        it.el.dataset.aivsaiHash = it.hash; // own hash per element - detects later changes to it
        unstyle(it.el); // text has changed - old score no longer applies
      }

      const foreign = foreignOf(fresh[0].lang);
      if (foreign) {
        // Do not score: in a foreign language scores are noise and often too high (German technical text: 78).
        // No marking on the paragraph, the popup gives the number; it can still be checked via right-click.
        for (const it of fresh) {
          skipped.set(it.el, foreign);
          it.el.dataset.aivsaiSkipped = foreign;
        }
        continue;
      }

      // Group made up entirely of paragraphs under MIN_WORDS (groupOnly) that together do not reach MIN_WORDS -
      // e.g. a single very short paragraph without a suitable neighbor. Stays unscored, no candidate,
      // like a single too-short paragraph already was before WP-10 (acceptance criterion).
      const words = fresh.reduce((n, it) => n + it.words, 0);
      if (words < MIN_WORDS && fresh.every((it) => it.groupOnly)) continue;

      // Group text = shared cache/request key (for a single paragraph: its own hash/text,
      // unchanged from previous behavior); the group's word count decides the traffic light.
      const grouped = fresh.length > 1 ? fresh.length : undefined;
      const fullText = fresh.map((it) => it.text).join(GROUP_SEPARATOR);
      const hash = grouped ? hashText(fullText) : fresh[0].hash;
      const clipped = clipText(fullText);
      const truncated = clipped.length < fullText.length;
      const els = fresh.map((it) => it.el);

      const known = seen.get(hash);
      if (known) {
        for (const el of els) applyScore(el, { hash, text: clipped, truncated, words, grouped, ...known, source: "auto" });
        continue;
      }
      const entry = inFlight.get(hash) || pending.get(hash);
      if (entry) {
        entry.els.push(...els);
      } else {
        pending.set(hash, { id: hash, text: clipped, lang: fresh[0].lang, truncated, words, grouped, els, near: true });
      }
      els.forEach((el) => el.classList.add("aivsai-pending"));
    }
  }

  async function scanAndQueue(root) {
    if (!isActive()) return;
    await collectCandidates(root);
    if (pending.size && isActive()) {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(pump, DEBOUNCE_MS);
    }
    reportStats();
  }

  // Distance to the visible area in px (0 = visible) and position of the nearest element.
  // Invisible/detached elements go to the very back.
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

  // Priority is determined only on sending, not on queueing: so after
  // a scroll the then-visible area automatically gets the next free slot.
  // Without scrolling that simply yields "top to bottom".
  function takeNextBatch() {
    const limit = config.lazyScan ? NEAR_SCREENS * innerHeight : Infinity;

    // Phase 1 read: positions of all waiting paragraphs
    const ranked = [];
    for (const entry of pending.values()) {
      if (!entry.els.some((el) => el.isConnected)) {
        pending.delete(entry.id); // SPA has removed the paragraph in the meantime
        continue;
      }
      const { dist, top } = viewportDistance(entry);
      // not rendered (display:none, hidden, collapsed): never send, even without lazyScan -
      // if it becomes visible, the nearObserver reports in
      entry.near = dist !== Infinity && dist <= limit;
      if (entry.near) ranked.push({ entry, dist, top });
    }
    ranked.sort((a, b) => a.dist - b.dist || a.top - b.top);
    const batch = [];
    let chars = 0;
    for (const { entry } of ranked) {
      if (batch.length >= BATCH_MAX_ITEMS || (batch.length && chars + entry.text.length > BATCH_MAX_CHARS)) break;
      batch.push(entry);
      chars += entry.text.length;
    }
    batch.forEach((b) => pending.delete(b.id));

    // Phase 2 write: marking "being checked" or "on scrolling"
    pending.forEach(markQueued);
    batch.forEach(markQueued);
    return batch;
  }

  // Batches one after another instead of all at once - otherwise the server computes everything in parallel
  // and the prioritization would have no effect.
  function pump() {
    const maxInFlight = AIVSAI.maxInFlight(config);
    while (batchesInFlight < maxInFlight && pending.size && isActive()) {
      const batch = takeNextBatch();
      if (!batch.length) break; // everything else is deferred until scrolled
      sendBatch(batch);
    }
    reportStats();
  }

  function schedulePump() {
    clearTimeout(pumpTimer);
    pumpTimer = setTimeout(pump, 150);
  }

  // manual: explicitly requested single check - the service worker only allows these on blocklisted sites
  function requestScores(items, manual = false) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "SCORE_BATCH", items, manual }, (resp) =>
          resolve(chrome.runtime.lastError ? null : resp)
        );
      } catch {
        // Extension was reloaded - this content script is orphaned
        resolve(null);
      }
    });
  }

  function sendBatch(batch) {
    const gen = generation;
    batchesInFlight++;
    batch.forEach((b) => inFlight.set(b.id, b));
    requestScores(batch.map((b) => ({ id: b.id, text: b.text, lang: b.lang }))).then((resp) =>
      handleBatchResult(batch, gen, resp)
    );
  }

  function handleBatchResult(batch, gen, resp) {
    batchesInFlight--;
    batch.forEach((b) => inFlight.get(b.id) === b && inFlight.delete(b.id));
    pump();
    if (gen !== generation) return;
    // fail open: an unreachable backend never blocks the page, nothing is just marked
    lastError = resp ? resp.error || null : "Extension unreachable";
    for (const b of batch) {
      const p = resp?.scores?.[b.id];
      if (typeof p === "number") {
        const known = { p, model: resp.model };
        seen.set(b.id, known);
        const record = {
          hash: b.id,
          text: b.text,
          truncated: b.truncated,
          words: b.words,
          grouped: b.grouped,
          ...known,
          source: "auto"
        };
        b.els.forEach((el) => applyScore(el, record));
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

  const levelOf = (rec) => Manual.levelOf(rec, config);
  const levelTitle = Manual.levelTitle;
  const scoreText = Manual.scoreText;

  function style(el) {
    const rec = results.get(el);
    const { p } = rec;
    // read before all write accesses, otherwise getComputedStyle forces a recomputation
    if (config.showBadge && !staticPosition.has(el)) {
      staticPosition.set(el, getComputedStyle(el).position === "static");
    }
    const level = levelOf(rec);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pos");
    // only as a hook for tests/debugging - the code itself reads from `results`
    el.dataset.aivsaiScore = String(p);
    el.dataset.aivsaiLevel = level;
    el.dataset.aivsaiWords = String(rec.words); // word count that decided the traffic light (of the group, if applicable)
    if (rec.grouped) el.dataset.aivsaiGrouped = String(rec.grouped);
    else delete el.dataset.aivsaiGrouped;

    const visible = level !== "green" || config.showGreen;
    if (visible) {
      el.classList.add(`aivsai-${level}`);
      if (config.showBadge) {
        el.dataset.aivsaiLabel = level === "uncertain" ? "uncertain" : scoreText(p);
        el.classList.add("aivsai-badge");
        // The badge is absolutely positioned via ::after and needs a positioning context for that
        if (staticPosition.get(el)) el.classList.add("aivsai-pos");
      }
    }

    // do not overwrite existing title attributes of the page
    if (visible && (!el.hasAttribute("title") || el.dataset.aivsaiTitle)) {
      el.title =
        `${levelTitle(rec, level)} – ${scoreText(p)} of 100 ` +
        `(${AIVSAI.providerLabel(config)}; hint, not proof)` +
        (rec.grouped ? ` · score of ${rec.grouped} adjacent paragraphs together` : "") +
        (config.showBadge ? " · Click the badge: details and feedback" : "");
      el.dataset.aivsaiTitle = "1";
    } else if (!visible && el.dataset.aivsaiTitle) {
      el.removeAttribute("title");
      delete el.dataset.aivsaiTitle;
    }
  }

  function unstyle(el) {
    results.delete(el);
    skipped.delete(el);
    nearObserver.unobserve(el);
    el.classList.remove(...LEVEL_CLASSES, "aivsai-pending", "aivsai-deferred", "aivsai-pos", "aivsai-jump");
    if (el.dataset.aivsaiTitle) el.removeAttribute("title");
    for (const key of ["aivsaiScore", "aivsaiLevel", "aivsaiLabel", "aivsaiTitle", "aivsaiSkipped", "aivsaiWords", "aivsaiGrouped"]) {
      delete el.dataset[key];
    }
  }

  function restyleAll() {
    for (const el of results.keys()) {
      if (el.isConnected) style(el);
    }
    for (const [range, rec] of manualRanges) highlightRange(range, rec);
  }

  function clearAll() {
    generation++;
    pending.clear();
    inFlight.clear(); // running batches belong to the old generation, their result is discarded
    clearTimeout(debounceTimer);
    clearTimeout(pumpTimer);
    document.querySelectorAll("[data-aivsai-hash]").forEach((el) => {
      unstyle(el);
      delete el.dataset.aivsaiHash;
    });
    results.clear();
    detecting.clear();
    skipped.clear();
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
    const counts = { red: 0, yellow: 0, green: 0, uncertain: 0 };
    for (const [el, rec] of results) {
      // no longer count removed paragraphs (SPA, infinite scroll) and do not keep them in memory
      if (!el.isConnected) results.delete(el);
      else counts[levelOf(rec)]++;
    }
    for (const el of skipped.keys()) if (!el.isConnected) skipped.delete(el);
    return {
      ...counts,
      skipped: skipped.size, // other language, not scored
      pending: pendingEls.length,
      deferred: deferredEls.length,
      active: isActive(),
      blocked: policy() === "blocked",
      blockReason: blockReason(),
      manualScan,
      pdf: document.contentType === "application/pdf", // top frame of the browser's PDF viewer
      error: lastError,
      host
    };
  }

  // Flagged/unclear paragraphs for the popup tiles (click = next one), in document order. Only ids
  // and levels leave the page - no paragraph text.
  const listIds = new WeakMap();
  let nextListId = 1;

  function flaggedList() {
    const items = [];
    for (const [el, rec] of results) {
      const level = levelOf(rec);
      if (!el.isConnected || (level !== "red" && level !== "yellow")) continue;
      if (!listIds.has(el)) listIds.set(el, nextListId++);
      items.push({ id: listIds.get(el), el, level });
    }
    items.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return items.map(({ el, ...item }) => item);
  }

  function jumpTo(id) {
    for (const el of results.keys()) {
      if (listIds.get(el) !== id || !el.isConnected) continue;
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.remove("aivsai-jump");
      void el.offsetWidth; // restart the animation on repeated clicks
      el.classList.add("aivsai-jump");
      setTimeout(() => el.classList.remove("aivsai-jump"), 1800);
      return true;
    }
    return false;
  }

  // Goes to background (icon badge) and an open popup
  function reportStats() {
    clearTimeout(statsTimer);
    statsTimer = setTimeout(() => {
      try {
        chrome.runtime.sendMessage({ type: "STATS", stats: stats() }, () => void chrome.runtime.lastError);
      } catch {
        // orphaned content script after extension reload
      }
    }, 200);
  }

  // ---------------------------------------------------------------------------
  // Manual check via right-click/keyboard shortcut: selected text or the paragraph under
  // the mouse pointer - even if the site is not scanned automatically or the text
  // is too short for the auto-scan or was excluded.
  // ---------------------------------------------------------------------------

  document.addEventListener("contextmenu", (e) => (contextTarget = e.target), true);

  // Click on the percent badge: details and feedback for the already scored paragraph, without recomputing.
  // The badge is an ::after of the paragraph - clicks on it land on the paragraph itself, so the
  // position decides. Only clicks exactly on the badge are intercepted (otherwise e.g. links in the paragraph break).
  function badgeHit(e) {
    const el = e.target instanceof Element ? e.target.closest(".aivsai-badge") : null;
    if (!el || !results.has(el)) return null;
    const r = el.getBoundingClientRect();
    const b = getComputedStyle(el, "::after");
    // Position from content.css: top -12px, right -6px (relative to the paragraph's padding box)
    const right = r.right - parseFloat(getComputedStyle(el).borderRightWidth) + 6;
    const top = r.top + parseFloat(getComputedStyle(el).borderTopWidth) - 12;
    const width = parseFloat(b.width) + parseFloat(b.paddingLeft) + parseFloat(b.paddingRight);
    const height = parseFloat(b.height);
    const hit = e.clientX >= right - width - 1 && e.clientX <= right + 1 && e.clientY >= top - 1 && e.clientY <= top + height + 1;
    return hit ? el : null;
  }

  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button === 0 && badgeHit(e)) e.preventDefault(); // no text selection/focus of the page
    },
    true
  );

  window.addEventListener(
    "click",
    (e) => {
      const el = e.button === 0 && badgeHit(e);
      if (!el) return;
      e.preventDefault(); // paragraph inside a link: do not navigate
      e.stopPropagation();
      showDetails(el);
    },
    true
  );

  async function showDetails(el) {
    const rec = results.get(el);
    const token = Popover.claim();
    const view = resultView(rec);
    const scored = { text: rec.text, p: rec.p, model: rec.model, source: rec.source };
    await openWithFeedback({ target: { el }, token, view, scored });
  }

  function checkSelection() {
    const sel = getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString().replace(/\s+/g, " ").trim() : "";
    if (!text) {
      Popover.show({}, Popover.claim(), { error: "No text selected." });
      return;
    }
    const range = sel.getRangeAt(0).cloneRange();
    sel.collapseToEnd(); // otherwise the selection color covers the marking
    checkManual(text, { range });
  }

  // Nearest block element with enough text, e.g. a <div> without <p> or a short list item
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
    // Text and hash as in the auto-scan (without icon fonts/code): the same paragraph is not queued again
    // there, and score store and feedback entry match the scoring via badge
    const text = readText(el);
    const hash = hashText(text);
    pending.delete(hash);
    el.dataset.aivsaiHash = hash;
    checkManual(text, { el, hash });
  }

  const tooShort = Manual.tooShort;

  // force: check even in a language the model does not know (button "Check anyway")
  async function checkManual(fullText, target, force = false) {
    const token = Popover.claim();
    const words = wordCount(fullText);
    if (!config.enabled) {
      Popover.show(target, token, { error: "The extension is switched off." });
      return;
    }
    if (words < MANUAL_MIN_WORDS) {
      Popover.show(target, token, { error: tooShort(words) });
      return;
    }
    const lang = await detectLang(fullText);
    const foreign = foreignOf(lang);
    if (foreign && !force) {
      Popover.show(target, token, {
        pill: { text: "not checked", level: "uncertain" },
        title: `Text in ${AIVSAI_LANG.name(foreign)}`,
        notes: [
          `The model only knows ${langList(AIVSAI.languages(config))}. In other languages the scores are ` +
            "not meaningful and often too high – German technical text got e.g. 78 out of 100."
        ],
        buttons: [{ text: "Check anyway", onClick: () => checkManual(fullText, target, true) }]
      });
      return;
    }
    const text = clipText(fullText);
    const id = `m_${hashText(text)}`;
    const gen = generation;
    markManual(target, null);
    Popover.show(target, token, { title: "Checking for AI…", notes: [AIVSAI.providerLabel(config), ...blockedNotes()] });

    const resp = await requestScores([{ id, text, lang }], true);
    if (gen !== generation) return;
    const p = resp?.scores?.[id];
    if (typeof p !== "number") {
      markManual(target, undefined);
      const error = resp?.error || (resp ? "No score received." : "Extension unreachable – reload the page.");
      Popover.show(target, token, { error });
      return;
    }
    const truncated = text.length < fullText.length;
    const record = { text, truncated, words, p, model: resp.model, at: Date.now(), ...(foreign && { foreign }) };
    markManual(target, record);
    const view = resultView(record);
    const scored = { text, p, model: resp.model, source: target.range ? "selection" : "manual" };
    await openWithFeedback({ target, token, view, scored });
    reportStats();
  }

  const resultView = (rec) => Manual.resultView(rec, config, blockedNotes());

  // On blocked sites only the single check is allowed - then make transparent what happened
  function blockedNotes() {
    const reason = blockReason();
    if (!reason) return [];
    const target = AIVSAI.remoteTarget(config);
    return [
      `${BLOCK_MESSAGES[reason]} – checked because you explicitly requested it.`,
      ...(target ? [`The text was sent to ${target}.`] : [])
    ];
  }

  // ---------------------------------------------------------------------------
  // Feedback in the result popover: where does the text really come from? People recognize AI text by style
  // hardly better than by chance - so we additionally ask *how* they know, and mere
  // impressions are marked as such (they do not count as a reliable label in training).
  // Stored only after consent, local only (bg/feedback-store.js).
  // ---------------------------------------------------------------------------

  const FEEDBACK_CONSENT = "feedbackConsentAt";
  const FEEDBACK_LABELS = { human: "by a human", ai: "by an AI" };
  const FEEDBACK_BASES = {
    human: [
      ["own", "Written myself / author known"],
      ["date", "Published before 2023"],
      ["guess", "Just my impression"]
    ],
    ai: [
      ["own", "Generated myself with AI"],
      ["marked", "Labeled as AI text"],
      ["guess", "Just my impression"]
    ]
  };

  function sendMessage(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => resolve(chrome.runtime.lastError ? null : resp));
      } catch {
        resolve(null); // orphaned content script after extension reload
      }
    });
  }

  // Blocklist or password/payment field (mail, banking): do not collect texts there, not even locally
  const feedbackOffered = (fb) => config.feedbackButtons && !blockReason() && !fb?.target?.noFeedback;

  // fb: { target, token, view (result view), scored: { text, p, model, source },
  //       saved: previous answer for this text { id, label, basis, at } or null }
  async function openWithFeedback(fb) {
    fb.saved = null;
    if (feedbackOffered(fb)) {
      fb.saved = (await sendMessage({ type: "FEEDBACK_GET", text: fb.scored.text }))?.entry ?? null;
    }
    Popover.show(fb.target, fb.token, withFeedback(fb));
  }

  function basisText(label, basis) {
    return FEEDBACK_BASES[label].find(([b]) => b === basis)?.[1] ?? basis;
  }

  function withFeedback(fb) {
    if (!feedbackOffered(fb)) return fb.view;
    if (fb.saved) {
      const { label, basis, at } = fb.saved;
      return {
        ...fb.view,
        prompt:
          `Your answer: ${FEEDBACK_LABELS[label]} – ${basisText(label, basis)} ` +
          `(${new Date(at).toLocaleDateString("en-US")})`,
        buttons: [
          { text: "Change", onClick: () => askLabel(fb) },
          { text: "Remove", onClick: () => removeFeedback(fb) }
        ]
      };
    }
    return { ...fb.view, prompt: "Do you know where the text comes from?", buttons: labelButtons(fb) };
  }

  function labelButtons(fb) {
    return [
      { text: "By a human", onClick: () => askBasis(fb, "human") },
      { text: "By an AI", onClick: () => askBasis(fb, "ai") }
    ];
  }

  function askLabel(fb) {
    showFeedback(fb, {
      prompt: "Where does the text come from?",
      buttons: [...labelButtons(fb), { text: "Back", onClick: () => Popover.show(fb.target, fb.token, withFeedback(fb)) }]
    });
  }

  function showFeedback(fb, extra) {
    Popover.show(fb.target, fb.token, { ...fb.view, ...extra });
  }

  function askBasis(fb, label) {
    showFeedback(fb, {
      prompt: `Text ${FEEDBACK_LABELS[label]} – how do you know?`,
      buttons: [
        ...FEEDBACK_BASES[label].map(([basis, text]) => ({ text, onClick: () => saveFeedback(fb, label, basis) })),
        { text: "Back", onClick: () => (fb.saved ? askLabel(fb) : Popover.show(fb.target, fb.token, withFeedback(fb))) }
      ]
    });
  }

  async function saveFeedback(fb, label, basis) {
    const { [FEEDBACK_CONSENT]: consentAt } = await chrome.storage.local.get(FEEDBACK_CONSENT);
    if (!consentAt) return askConsent(fb, label, basis);
    const previous = fb.saved;
    const resp = await storeFeedback(fb, label, basis);
    if (!resp?.ok) {
      showFeedback(fb, { prompt: `Not saved: ${resp?.error || "Extension unreachable"}`, buttons: [] });
      return;
    }
    const notes = [
      ...fb.view.notes,
      `Stored only in this browser (${resp.count} ${resp.count === 1 ? "entry" : "entries"}). ` +
        "Export and delete: Settings → Feedback."
    ];
    if (basis === "guess") notes.push("Noted as an impression – does not count as a reliable label in training.");
    showFeedback(fb, {
      notes,
      prompt: `Thanks! Saved: ${FEEDBACK_LABELS[label]}.`,
      buttons: [{ text: "Undo", onClick: () => undoFeedback(fb, previous) }]
    });
  }

  // There is exactly one entry per text - saving replaces an earlier answer
  async function storeFeedback(fb, label, basis) {
    const entry = { ...fb.scored, label, basis, lang: document.documentElement.lang || "" };
    const resp = await sendMessage({ type: "FEEDBACK_SAVE", entry });
    if (resp?.ok) fb.saved = { id: resp.id, label, basis, at: Date.now() };
    return resp;
  }

  // Undo: restore the earlier answer or delete the new entry
  async function undoFeedback(fb, previous) {
    if (previous) {
      await storeFeedback(fb, previous.label, previous.basis);
      fb.saved = previous;
    } else {
      await removeFeedback(fb);
      return;
    }
    Popover.show(fb.target, fb.token, withFeedback(fb));
  }

  async function removeFeedback(fb) {
    if (fb.saved) await sendMessage({ type: "FEEDBACK_DELETE", id: fb.saved.id });
    fb.saved = null;
    Popover.show(fb.target, fb.token, withFeedback(fb));
  }

  function askConsent(fb, label, basis) {
    showFeedback(fb, {
      prompt: "Save feedback?",
      notes: [
        "What is stored: the checked text (up to 2000 characters), your answer, score, model and the language " +
          "of the page – no address. Only in this browser, nothing is sent.",
        "You can export the collection in the settings (e.g. for your own training) or at any time " +
          "delete it and withdraw consent."
      ],
      buttons: [
        {
          text: "Agree, save",
          primary: true,
          onClick: async () => {
            await chrome.storage.local.set({ [FEEDBACK_CONSENT]: Date.now() });
            saveFeedback(fb, label, basis);
          }
        },
        { text: "Cancel", onClick: () => Popover.show(fb.target, fb.token, withFeedback(fb)) }
      ]
    });
  }

  // record: result object, null = being checked, undefined = remove marking
  function markManual({ range, el, hash }, record) {
    if (range) {
      if (record === undefined) manualRanges.delete(range);
      else manualRanges.set(range, record);
      highlightRange(range, record);
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

  // CSS Custom Highlight API: colors arbitrary text ranges without touching the page's DOM.
  // record: result, null = being checked, undefined = remove marking
  function highlightRange(range, record) {
    if (!window.CSS?.highlights) return;
    for (const state of HIGHLIGHT_STATES) CSS.highlights.get(`aivsai-${state}`)?.delete(range);
    if (record === undefined) return;
    const name = `aivsai-${record === null ? "pending" : levelOf(record)}`;
    if (!CSS.highlights.has(name)) CSS.highlights.set(name, new Highlight());
    CSS.highlights.get(name).add(range);
  }
})();
