// Ergebnis-Popover für manuelle Prüfungen. Reine Darstellung: content.js entscheidet, was drinsteht.
// Shadow DOM, damit das CSS der Seite nicht hineinwirkt und umgekehrt.
globalThis.AIVSAIPopover = (() => {
  const CSS = `
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

  let host = null;
  let token = 0;

  function create() {
    host = document.createElement("aivsai-popover");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML =
      `<style>${CSS}</style>` +
      `<div class="box" role="status" aria-live="polite">` +
      `<button class="close" type="button" aria-label="Schließen" title="Schließen">×</button>` +
      `<div class="body"></div></div>`;
    shadow.querySelector(".close").addEventListener("click", hide);
  }

  function node(tag, cls, text) {
    const el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // Jede neue Prüfung holt sich ein Token; Antworten älterer Prüfungen werden dann ignoriert.
  function claim() {
    return ++token;
  }

  /**
   * @param {{range?: Range, el?: Element}} anchor  darunter wird das Popover angezeigt
   * @param {number} t  Token aus claim()
   * @param {{title?: string, pill?: {text: string, level: string}, error?: string, notes?: string[]}} view
   */
  function show(anchor, t, view) {
    if (t !== token) return; // eine neuere Prüfung hat das Popover übernommen
    if (!host) create();
    const body = host.shadowRoot.querySelector(".body");
    body.replaceChildren();

    if (view.error) body.append(node("div", "error", view.error));
    if (view.title || view.pill) {
      const head = node("div", "head", "");
      if (view.pill) head.append(node("span", `pill ${view.pill.level}`, view.pill.text));
      if (view.title) head.append(view.title);
      body.append(head);
    }
    for (const note of view.notes || []) body.append(node("div", "note", note));

    if (!host.isConnected) document.documentElement.append(host);
    position(anchor);
  }

  // Unter den geprüften Text, aber immer im sichtbaren Bereich - lange Absätze ragen oft darüber hinaus
  function position({ range, el } = {}) {
    const target = range || (el?.isConnected ? el : null);
    const rect = target?.getBoundingClientRect();
    const box = host.getBoundingClientRect();
    const x = Math.max(8, Math.min(rect ? rect.left : innerWidth, innerWidth - box.width - 8));
    const y = Math.max(8, Math.min(rect ? rect.bottom + 8 : 8, innerHeight - box.height - 8));
    host.style.left = `${x + scrollX}px`;
    host.style.top = `${y + scrollY}px`;
  }

  function hide() {
    token++;
    host?.remove();
  }

  const isOpen = () => !!host?.isConnected;

  document.addEventListener("keydown", (e) => e.key === "Escape" && isOpen() && hide(), true);
  document.addEventListener("mousedown", (e) => isOpen() && !e.composedPath().includes(host) && hide(), true);

  return { claim, show, hide };
})();
