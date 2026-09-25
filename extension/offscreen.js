// Läuft im Offscreen-Dokument (von background.js erzeugt): lädt die Klassifikationsmodelle als
// ONNX per transformers.js und bewertet Texte komplett im Browser. Modelldaten kommen einmalig
// von Hugging Face (öffentlich, kein Token) und liegen danach im Cache-Storage der Extension.
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  DebertaV2Tokenizer,
  PreTrainedTokenizer,
  RobertaTokenizer,
  env
} from "./vendor/transformers.min.js";
import "./config.js";
import { buildWeights } from "./desklib_build.js";
import { lengthBuckets } from "./length-buckets.js";

const HF = "https://huggingface.co/";
const CACHE_NAME = "transformers-cache"; // von transformers.js vorgegeben
const IDLE_CLOSE_MS = 10 * 60 * 1000; // RAM freigeben, wenn länger nichts zu tun ist

const MODELS = {
  // fertige ONNX-Version von onnx-community, lädt transformers.js selbst herunter
  tmr: {
    id: "onnx-community/tmr-ai-text-detector-ONNX",
    revision: AIVSAI.BROWSER_MODELS.tmr.revision, // gepinnt in config.js
    marker: "onnx/model_quantized.onnx",
    maxTokens: AIVSAI.BROWSER_MODELS.tmr.maxTokens
  },
  // gibt es nicht als brauchbares ONNX: Original herunterladen und hier umwandeln (desklib_build.js).
  // Die Cache-Einträge liegen unter einer eigenen ID, die es auf Hugging Face nicht gibt.
  desklib: {
    id: "aivsai-local/desklib-ai-text-detector-v1.01",
    revision: AIVSAI.BROWSER_MODELS.desklib.revision,
    marker: "onnx/model_quantized.onnx_data",
    maxTokens: AIVSAI.BROWSER_MODELS.desklib.maxTokens, // wie server/shim_server.py
    build: {
      source: "desklib/ai-text-detector-v1.01",
      tokenizerFiles: ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json"],
      shipped: { "config.json": "models/desklib/config.json", "onnx/model_quantized.onnx": "models/desklib/model_quantized.onnx" },
      recipe: "models/desklib/recipe.json"
    }
  }
};

// Beides aus heißt für transformers.js "ungültige Konfiguration" - auch wenn alles im Cache liegt.
// Lokale Modelle zeigen daher auf den Extension-Ordner: der Cache wird zuerst geprüft, ohne
// Treffer gibt es dort nur ein 404 statt eines Netzwerkzugriffs.
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
// Mehrere Threads gehen nur mit Cross-Origin-Isolation (COOP/COEP im Manifest). Mehr als 8 bringen
// bei desklib kaum noch etwas und würden den Rechner beim Mitlaufen spürbar belasten.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

let current = null; // { key, promise: Promise<{ tokenizer, model, aiIndex }> } - immer nur ein Modell im RAM
let queue = Promise.resolve(); // ONNX-Sessions nicht parallel ausführen
let idleTimer = null;
const downloads = new Map(); // key -> { loaded, total }

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!downloads.size) self.close();
  }, IDLE_CLOSE_MS);
}

const cacheKey = (m, file) => `${HF}${m.id}/resolve/${m.revision}/${file}`;

async function cachedModelRequests(m) {
  const cache = await caches.open(CACHE_NAME);
  const keys = await cache.keys();
  return { cache, keys: keys.filter((r) => r.url.includes(`/${m.id}/`)) };
}

async function isDownloaded(m) {
  const cache = await caches.open(CACHE_NAME);
  return !!(await cache.match(cacheKey(m, m.marker)));
}

function reportProgress(key, loaded, total) {
  downloads.set(key, { loaded, total });
  chrome.runtime.sendMessage({ type: "MODEL_PROGRESS", model: key, loaded, total }).catch(() => {
    // niemand hört zu (Einstellungen geschlossen) - egal
  });
}

const TOKENIZER_CLASSES = { RobertaTokenizer, DebertaV2Tokenizer };

// AutoTokenizer (transformers.js 4.3.0) sucht tokenizer_config.json immer unter Revision "main",
// auch wenn eine Revision angegeben ist - offline bzw. ohne Remote-Zugriff findet es die unter der
// gepinnten Revision gespeicherten Dateien dann nicht. Deshalb selbst aus dem Cache bauen.
async function tokenizerFromCache(m) {
  const cache = await caches.open(CACHE_NAME);
  const [json, config] = await Promise.all(
    ["tokenizer.json", "tokenizer_config.json"].map((f) => cache.match(cacheKey(m, f)))
  );
  if (!json || !config) return null;
  const cfg = await config.json();
  const cls = TOKENIZER_CLASSES[cfg.tokenizer_class?.replace(/Fast$/, "")] ?? PreTrainedTokenizer;
  return new cls(await json.json(), cfg);
}

async function unload() {
  if (!current) return;
  const { promise } = current;
  current = null;
  try {
    await (await promise).model.dispose?.();
  } catch {
    // Laden war ohnehin fehlgeschlagen
  }
}

async function load(key, { allowDownload = false, onProgress } = {}) {
  if (current?.key === key) return current.promise;
  await unload();
  const m = MODELS[key];
  // desklib steht nie so auf Hugging Face - nur aus dem Cache laden
  env.allowRemoteModels = allowDownload && !m.build;
  const files = new Map();
  const options = {
    revision: m.revision,
    dtype: "q8",
    progress_callback: (p) => {
      if (!onProgress || p.status !== "progress" || !p.total) return;
      files.set(p.file, p);
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      onProgress(loaded, total);
    }
  };
  const promise = (async () => {
    // beim ersten TMR-Download holt AutoTokenizer die Dateien (online klappt die Suche)
    const tokenizer = (await tokenizerFromCache(m)) ?? (await AutoTokenizer.from_pretrained(m.id, options));
    const model = await AutoModelForSequenceClassification.from_pretrained(m.id, options);
    const aiEntry = Object.entries(model.config.id2label).find(([, v]) => /^(ai|machine|generated)$/i.test(v));
    return { tokenizer, model, aiIndex: aiEntry ? Number(aiEntry[0]) : 1 };
  })();
  current = { key, promise };
  promise.catch(() => {
    if (current?.promise === promise) current = null;
  });
  return promise;
}

async function score(key, texts) {
  const m = MODELS[key];
  if (!m) throw new Error(`Unbekanntes Modell: ${key}`);
  if (!(await isDownloaded(m))) throw new Error("Modell noch nicht heruntergeladen – in den Einstellungen herunterladen");
  const { tokenizer, model, aiIndex } = await load(key);
  const opts = { truncation: true, max_length: m.maxTokens };
  // erst nur zählen, dann gruppenweise rechnen - sonst wird jeder Text auf den längsten aufgefüllt
  const { input_ids } = await tokenizer(texts, { ...opts, return_tensor: false });
  const scores = new Array(texts.length);
  for (const group of lengthBuckets(input_ids.map((ids) => ids.length))) {
    const enc = await tokenizer(group.map((i) => texts[i]), { ...opts, padding: true });
    const { logits } = await model(enc);
    toScores(logits, aiIndex).forEach((p, j) => (scores[group[j]] = p));
  }
  return scores;
}

function toScores(logits, aiIndex) {
  const [rows, classes] = logits.dims;
  const scores = [];
  for (let r = 0; r < rows; r++) {
    const row = Array.from(logits.data.slice(r * classes, (r + 1) * classes));
    if (classes === 1) {
      scores.push(1 / (1 + Math.exp(-row[0]))); // desklib: ein Logit, Sigmoid
      continue;
    }
    const max = Math.max(...row);
    const exp = row.map((x) => Math.exp(x - max));
    scores.push(exp[aiIndex] / exp.reduce((a, b) => a + b, 0));
  }
  return scores;
}

async function fetchOk(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download fehlgeschlagen (HTTP ${resp.status}): ${url.replace(HF, "")}`);
  return resp;
}

// desklib: Tokenizer + Original-Gewichte von Hugging Face, Graph aus der Extension, Gewichte umwandeln
async function buildModel(key) {
  const m = MODELS[key];
  const { build } = m;
  const recipe = await (await fetchOk(chrome.runtime.getURL(build.recipe))).json();
  const src = `${HF}${build.source}/resolve/${m.revision}/`;
  await remove(key); // Reste eines abgebrochenen Versuchs
  const cache = await caches.open(CACHE_NAME);
  for (const file of build.tokenizerFiles) await cache.put(cacheKey(m, file), await fetchOk(src + file));
  for (const [file, path] of Object.entries(build.shipped)) {
    await cache.put(cacheKey(m, file), await fetchOk(chrome.runtime.getURL(path)));
  }
  const resp = await fetchOk(src + recipe.source.file);
  const total = Number(resp.headers.get("content-length")) || recipe.source.size;
  let lastReport = 0;
  const data = await buildWeights(resp.body, recipe, (loaded) => {
    if (loaded - lastReport > 4e6 || loaded === total) {
      lastReport = loaded;
      reportProgress(key, loaded, total);
    }
  });
  // zuletzt, weil isDownloaded() genau diesen Eintrag prüft
  await cache.put(cacheKey(m, m.marker), new Response(data, { headers: { "content-length": String(data.byteLength) } }));
}

async function download(key) {
  const m = MODELS[key];
  if (!m) throw new Error(`Unbekanntes Modell: ${key}`);
  if (m.build) {
    await buildModel(key);
  } else {
    await unload();
    await load(key, { allowDownload: true, onProgress: (loaded, total) => reportProgress(key, loaded, total) });
  }
}

// Download läuft im Hintergrund weiter, auch wenn die Einstellungen geschlossen werden;
// Fortschritt und Ende kommen als MODEL_PROGRESS / MODEL_DONE.
function startDownload(key) {
  if (downloads.has(key)) return;
  downloads.set(key, { loaded: 0, total: 0 });
  download(key)
    .then(() => ({ ok: true }))
    .catch(async (err) => {
      await remove(key).catch(() => {}); // keine halben Modelle im Cache lassen
      return { ok: false, error: String(err?.message || err) };
    })
    .then((result) => {
      downloads.delete(key);
      touch();
      chrome.runtime.sendMessage({ type: "MODEL_DONE", model: key, ...result }).catch(() => {});
    });
}

async function remove(key) {
  const m = MODELS[key];
  if (current?.key === key) await unload();
  const { cache, keys } = await cachedModelRequests(m);
  await Promise.all(keys.map((k) => cache.delete(k)));
}

async function status() {
  const models = {};
  for (const [key, m] of Object.entries(MODELS)) {
    models[key] = {
      downloaded: await isDownloaded(m),
      loaded: current?.key === key,
      downloading: downloads.get(key) ?? null
    };
  }
  return { models, threads: env.backends.onnx.wasm.numThreads };
}

const HANDLERS = {
  score: (msg) => score(msg.model, msg.texts).then((scores) => ({ scores })),
  status: () => status(),
  download: (msg) => {
    startDownload(msg.model);
    return status();
  },
  delete: (msg) => remove(msg.model).then(status)
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // Content-Script-Nachrichten (SCORE_BATCH, STATS, …) gehen an alle Extension-Seiten -
  // hier nur die explizit ans Offscreen-Dokument adressierten beantworten.
  if (msg?.target !== "offscreen" || !HANDLERS[msg.type]) return false;
  touch();
  // Status/Download-Start nicht hinter laufende Bewertungen einreihen
  const run = msg.type === "score" || msg.type === "delete" ? (queue = queue.then(() => HANDLERS[msg.type](msg))) : HANDLERS[msg.type](msg);
  queue = queue.catch(() => {});
  run
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    .finally(touch);
  return true;
});

touch();
