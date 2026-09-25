// Brücke zum Offscreen-Dokument (offscreen.js): dort läuft das Modell, weil ein Service Worker
// weder Worker-Threads für die WASM-Runtime noch DOM-APIs hat.

let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["WORKERS"],
      justification: "KI-Textklassifikation lokal per WebAssembly (ONNX Runtime Web)"
    })
    .finally(() => (creating = null));
  await creating;
}

export async function callOffscreen(type, payload = {}) {
  await ensureOffscreen();
  const resp = await chrome.runtime.sendMessage({ target: "offscreen", type, ...payload });
  if (!resp?.ok) throw new Error(resp?.error || "Modell-Dokument antwortet nicht");
  return resp;
}
