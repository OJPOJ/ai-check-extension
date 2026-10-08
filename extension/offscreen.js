// Runs in the offscreen document (created by background.js): loads the classification models as
// ONNX via transformers.js and scores texts entirely in the browser. Model data comes once
// from Hugging Face (public, no token) and is stored afterwards in the extension's cache storage.
import {
  AutoTokenizer,
  AutoModelForSequenceClassification,
  DebertaV2Tokenizer,
  PreTrainedTokenizer,
  RobertaTokenizer,
  env
} from "./vendor/transformers.min.js";
import "./models.js";
import "./config.js";
import { buildWeights } from "./desklib_build.js";
import { lengthBuckets } from "./length-buckets.js";

const HF = "https://huggingface.co/";
const CACHE_NAME = "transformers-cache"; // mandated by transformers.js
const IDLE_CLOSE_MS = 10 * 60 * 1000; // free RAM when there is nothing to do for a longer time

// All models with a `browser` section from models.js. Models with `build` do not exist as a usable
// ONNX: download the original and convert it here (desklib_build.js), cache entries under `repo`.
const MODELS = Object.fromEntries(
  AIVSAI.catalog("browser").map(([key, { browser, maxTokens }]) => [
    key,
    { id: browser.repo, revision: browser.revision, marker: browser.marker, build: browser.build, maxTokens }
  ])
);

// Both off means "invalid configuration" to transformers.js - even if everything is in the cache.
// Local models therefore point to the extension folder: the cache is checked first, without
// a hit there is only a 404 instead of a network access.
env.allowLocalModels = true;
env.localModelPath = chrome.runtime.getURL("models/");
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/");
// Multiple threads only work with cross-origin isolation (COOP/COEP in the manifest). More than 8 bring
// hardly anything for desklib and would noticeably burden the computer while running along.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

let current = null; // { key, promise: Promise<{ tokenizer, model, aiIndex }> } - only one model in RAM at a time
let queue = Promise.resolve(); // do not run ONNX sessions in parallel
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
    // nobody is listening (settings closed) - does not matter
  });
}

const TOKENIZER_CLASSES = { RobertaTokenizer, DebertaV2Tokenizer };

// AutoTokenizer (transformers.js 4.3.0) always looks for tokenizer_config.json under revision "main",
// even if a revision is given - offline or without remote access it then does not find the files stored under the
// pinned revision. Hence build it from the cache ourselves.
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
    // loading had failed anyway
  }
}

async function load(key, { allowDownload = false, onProgress } = {}) {
  if (current?.key === key) return current.promise;
  await unload();
  const m = MODELS[key];
  // self-converted models never exist like that on Hugging Face - load from the cache only
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
    // on the first TMR download AutoTokenizer fetches the files (the lookup works online)
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
  if (!m) throw new Error(`Unknown model: ${key}`);
  if (!(await isDownloaded(m))) throw new Error("Model not downloaded yet – download it in the settings");
  const { tokenizer, model, aiIndex } = await load(key);
  const opts = { truncation: true, max_length: m.maxTokens };
  // first only count, then compute group by group - otherwise every text is padded to the longest
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
      scores.push(1 / (1 + Math.exp(-row[0]))); // desklib: one logit, sigmoid
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
  if (!resp.ok) throw new Error(`Download failed (HTTP ${resp.status}): ${url.replace(HF, "")}`);
  return resp;
}

// Models with `build` (desklib): tokenizer + original weights from Hugging Face, graph from the extension, convert weights
async function buildModel(key) {
  const m = MODELS[key];
  const { build } = m;
  const recipe = await (await fetchOk(chrome.runtime.getURL(build.recipe))).json();
  const src = `${HF}${build.source}/resolve/${m.revision}/`;
  await remove(key); // leftovers of an aborted attempt
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
  // last, because isDownloaded() checks exactly this entry
  await cache.put(cacheKey(m, m.marker), new Response(data, { headers: { "content-length": String(data.byteLength) } }));
}

async function download(key) {
  const m = MODELS[key];
  if (!m) throw new Error(`Unknown model: ${key}`);
  if (m.build) {
    await buildModel(key);
  } else {
    await unload();
    await load(key, { allowDownload: true, onProgress: (loaded, total) => reportProgress(key, loaded, total) });
  }
}

// The download continues in the background even if the settings are closed;
// progress and end arrive as MODEL_PROGRESS / MODEL_DONE.
function startDownload(key) {
  if (downloads.has(key)) return;
  downloads.set(key, { loaded: 0, total: 0 });
  download(key)
    .then(() => ({ ok: true }))
    .catch(async (err) => {
      await remove(key).catch(() => {}); // do not leave half models in the cache
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
  // Content script messages (SCORE_BATCH, STATS, …) go to all extension pages -
  // only answer the ones explicitly addressed to the offscreen document here.
  if (msg?.target !== "offscreen" || !HANDLERS[msg.type]) return false;
  touch();
  // do not queue status/download start behind running scorings
  const run = msg.type === "score" || msg.type === "delete" ? (queue = queue.then(() => HANDLERS[msg.type](msg))) : HANDLERS[msg.type](msg);
  queue = queue.catch(() => {});
  run
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }))
    .finally(touch);
  return true;
});

touch();
