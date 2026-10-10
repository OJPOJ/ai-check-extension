// Download state of the browser models for extension pages (settings, setup page). Classic script like
// config.js. The download itself runs in the offscreen document (offscreen.js); here only the state machine
// and the messages (MODEL_STATUS / MODEL_DOWNLOAD / MODEL_CANCEL / MODEL_DELETE, events MODEL_PROGRESS / MODEL_DONE).
//
// Phase per model:
//   unknown      no answer from the offscreen document yet
//   idle         not downloaded
//   downloading  { loaded, total } (total 0 until the size is known)
//   ready        in the cache
//   failed       { error } - the half model is already cleared, start() simply tries again
//   cancelled    cancelled by the user
// failed/cancelled stay until the next start() or delete(), a status refresh does not wipe them.
globalThis.AIVSAI_DOWNLOAD = (() => {
  const phases = new Map(); // key -> { phase, loaded?, total?, error? }
  let threads = null;
  let statusError = null; // MODEL_STATUS itself failed
  let onChange = () => {};

  const get = (key) => phases.get(key) ?? { phase: "unknown" };
  const set = (key, value) => {
    phases.set(key, value);
    onChange();
  };
  const send = (type, model) => chrome.runtime.sendMessage({ type, model });

  function applyStatus(resp) {
    if (!resp?.ok) {
      statusError = resp?.error ?? "no response";
      return onChange();
    }
    statusError = null;
    threads = resp.threads;
    for (const [key, st] of Object.entries(resp.models)) {
      const old = get(key);
      if (st.downloading) phases.set(key, { phase: "downloading", loaded: st.downloading.loaded, total: st.downloading.total });
      else if (st.downloaded) phases.set(key, { phase: "ready" });
      else if (old.phase !== "failed" && old.phase !== "cancelled") phases.set(key, { phase: "idle" });
    }
    onChange();
  }

  // The end of a download comes as an event (the offscreen document keeps working while the page is closed)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "MODEL_PROGRESS") {
      if (get(msg.model).phase === "cancelled") return; // last events of the aborted download
      set(msg.model, { phase: "downloading", loaded: msg.loaded, total: msg.total });
    } else if (msg?.type === "MODEL_DONE") {
      if (msg.ok) set(msg.model, { phase: "ready" });
      else if (msg.cancelled) set(msg.model, { phase: "cancelled" });
      else set(msg.model, { phase: "failed", error: msg.error });
    }
  });

  return {
    /** Call once; `fn` runs after every state change. */
    onChange(fn) {
      onChange = fn;
    },
    state: get,
    /** Key of a model that is downloading right now, or null */
    active: () => [...phases].find(([, v]) => v.phase === "downloading")?.[0] ?? null,
    get threads() {
      return threads;
    },
    get error() {
      return statusError;
    },
    async refresh() {
      applyStatus(await send("MODEL_STATUS"));
    },
    async start(key) {
      set(key, { phase: "downloading", loaded: 0, total: 0 });
      const resp = await send("MODEL_DOWNLOAD", key);
      if (!resp?.ok) set(key, { phase: "failed", error: resp?.error ?? "no response" });
    },
    async cancel(key) {
      if (get(key).phase !== "downloading") return;
      set(key, { phase: "cancelled" }); // before the answer: stray progress events must not revive it
      await send("MODEL_CANCEL", key);
    },
    async remove(key) {
      phases.delete(key);
      applyStatus(await send("MODEL_DELETE", key));
    },
    formatBytes(bytes) {
      if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
      if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`;
      return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
    }
  };
})();
