// Läuft im Offscreen-Dokument (von background.js erzeugt): lädt TMR als ONNX-Modell per
// transformers.js und bewertet Texte komplett im Browser. Modellgewichte kommen einmalig
// von Hugging Face (öffentlich, kein Token) und liegen danach im Cache-Storage der Extension.
import { AutoTokenizer, AutoModelForSequenceClassification, env } from "./vendor/transformers.min.js";

const MODEL = {
  id: "onnx-community/tmr-ai-text-detector-ONNX",
  // fest gepinnt, damit sich Scores nicht durch ein Upstream-Update unbemerkt ändern
  revision: "b9aa251e5bcda7e429fcc936767d921435945b60",
  dtype: "q8",
  weightsFile: "onnx/model_quantized.onnx"
};
const CACHE_NAME = "transformers-cache";
const MAX_TOKENS = 512;
const IDLE_CLOSE_MS = 10 * 60 * 1000; // RAM (~300MB) freigeben, wenn länger nichts zu tun ist

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
// Mehrere Threads gehen nur mit Cross-Origin-Isolation (COOP/COEP im Manifest)
if (!self.crossOriginIsolated) env.backends.onnx.wasm.numThreads = 1;

let loading = null; // Promise<{ tokenizer, model, aiIndex }>
let queue = Promise.resolve(); // ONNX-Sessions nicht parallel ausführen
let idleTimer = null;
let downloading = false;

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!downloading) self.close();
  }, IDLE_CLOSE_MS);
}

async function cachedModelRequests() {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return { cache, keys: keys.filter((r) => r.url.includes(`/${MODEL.id}/`)) };
}

async function isDownloaded() {
  const { keys } = await cachedModelRequests();
  return keys.some((r) => r.url.includes(MODEL.revision) && r.url.endsWith(MODEL.weightsFile));
}

function reportProgress(files) {
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
  }
  chrome.runtime.sendMessage({ type: "MODEL_PROGRESS", loaded, total }).catch(() => {
    // niemand hört zu (Einstellungen geschlossen) - egal
  });
}

function load({ allowDownload }) {
  if (loading) return loading;
  env.allowRemoteModels = allowDownload;
  const files = new Map();
  const options = {
    revision: MODEL.revision,
    dtype: MODEL.dtype,
    progress_callback: (p) => {
      if (p.status !== "progress" || !p.total) return;
      files.set(p.file, { loaded: p.loaded, total: p.total });
      reportProgress(files);
    }
  };
  loading = (async () => {
    const tokenizer = await AutoTokenizer.from_pretrained(MODEL.id, options);
    const model = await AutoModelForSequenceClassification.from_pretrained(MODEL.id, options);
    const aiEntry = Object.entries(model.config.id2label).find(([, v]) => /^(ai|machine|generated)$/i.test(v));
    return { tokenizer, model, aiIndex: aiEntry ? Number(aiEntry[0]) : 1 };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

async function score(texts) {
  if (!(await isDownloaded())) throw new Error("Modell noch nicht heruntergeladen – in den Einstellungen herunterladen");
  const { tokenizer, model, aiIndex } = await load({ allowDownload: false });
  const enc = await tokenizer(texts, { padding: true, truncation: true, max_length: MAX_TOKENS });
  const { logits } = await model(enc);
  const [rows, classes] = logits.dims;
  const scores = [];
  for (let r = 0; r < rows; r++) {
    const row = Array.from(logits.data.slice(r * classes, (r + 1) * classes));
    const max = Math.max(...row);
    const exp = row.map((x) => Math.exp(x - max));
    scores.push(exp[aiIndex] / exp.reduce((a, b) => a + b, 0));
  }
  return scores;
}

async function download() {
  downloading = true;
  try {
    await load({ allowDownload: true });
  } finally {
    downloading = false;
  }
}

async function remove() {
  if (loading) {
    try {
      (await loading).model.dispose?.();
    } catch {
      // Laden war ohnehin fehlgeschlagen
    }
    loading = null;
  }
  const { cache, keys } = await cachedModelRequests();
  await Promise.all(keys.map((k) => cache.delete(k)));
}

async function status() {
  return {
    downloaded: await isDownloaded(),
    loaded: !!loading,
    threads: self.crossOriginIsolated ? env.backends.onnx.wasm.numThreads ?? "auto" : 1
  };
}

const HANDLERS = {
  score: (msg) => score(msg.texts).then((scores) => ({ scores })),
  status: () => status(),
  download: () => download().then(status),
  delete: () => remove().then(status)
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content-Script-Nachrichten (SCORE_BATCH, STATS, …) gehen an alle Extension-Seiten -
  // hier nur die explizit ans Offscreen-Dokument adressierten beantworten.
  if (msg?.target !== "offscreen" || !HANDLERS[msg.type]) return false;
  touch();
  const run = queue.then(() => HANDLERS[msg.type](msg));
  queue = run.catch(() => {});
  run
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    .finally(touch);
  return true;
});

touch();
