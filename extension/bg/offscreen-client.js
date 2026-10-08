// Bridge to the offscreen document (offscreen.js): the model runs there because a service worker
// has neither worker threads for the WASM runtime nor DOM APIs.

let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "AI text classification locally via WebAssembly (ONNX Runtime Web)"
    })
    .finally(() => (creating = null));
  await creating;
}

export async function callOffscreen(type, payload = {}) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ target: "offscreen", type, ...payload });
  if (!resp?.ok) throw new Error(resp?.error || "Model document does not respond");
  return resp;
}
