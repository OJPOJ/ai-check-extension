// Scoring with cache, connection test and status for the popup - independent of the concrete provider.
import "../config.js";
import { backendFor, describeError } from "./providers.js";
import * as store from "./score-store.js";

const CACHE_MAX = 5000;
const TEST_TEXT =
  "Maintaining a bicycle in good working condition requires regular attention to several " +
  "key components, including the tires, the chain and the brake pads.";

// In-memory cache: providerSignature + text -> probability. Only lasts while the service worker
// runs (~30 s without messages); below it sits the persistent store from score-store.js.
// The key is the text itself (max. 2000 characters), not the ID from the content script: its
// 32-bit hash is only unique enough within a single page.
const cache = new Map();
let lastStatus = null; // { ok, error?, at, provider }

// Keep the configuration in memory instead of reading it from storage twice per batch
let configPromise = null;

export function getConfig() {
  configPromise ||= Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]).then(([sync, local]) => ({ ...AIVSAI.DEFAULTS, ...sync, ...AIVSAI.SECRET_DEFAULTS, ...local }));
  return configPromise;
}

chrome.storage.onChanged.addListener((changes) => {
  configPromise = null;
  // Hits from memory never end up in the persistent store - if storing is switched on,
  // they have to go through the normal path once, otherwise they are missing there until the SW restarts
  if ("scoreRetentionDays" in changes) cache.clear();
});

// Everything a score depends on: provider settings plus model version (modelKey). Switching the
// model or a new version -> different signature -> old entries no longer match.
function providerSignature(cfg) {
  return [...AIVSAI.PROVIDER_KEYS.map((k) => cfg[k]), AIVSAI.modelKey(cfg)].join("\u0001");
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// The contract knows `lang` per request, not per text: mixed batches (rare - usually a page has
// one language) go out as one request per language. Result in the order of `items`.
async function scoreByLang(items, cfg) {
  const groups = Map.groupBy(items.map((it, i) => ({ it, i })), ({ it }) => it.lang || "");
  const result = new Array(items.length).fill(null);
  for (const [lang, group] of groups) {
    const scores = await backendFor(cfg).score(group.map(({ it }) => it.text), cfg, lang ? { lang } : {});
    group.forEach(({ i }, j) => (result[i] = scores[j]));
  }
  return result;
}

// Running scorings: cache key -> Promise<{p?: number, error?: string}>. If several tabs scan
// the same page (or a paragraph appears twice in a batch), each text goes to storage
// and backend only once; the other requests wait for that result.
const pending = new Map();

/**
 * @param {{id: string, text: string, lang?: string}[]} items  lang: detected language, if known
 * @returns {Promise<{ok: boolean, scores: Record<string, number>, model: string, error?: string}>}
 *   `model` (AIVSAI.modelKey) belongs to every score - for feedback, reports and calibration.
 */
export async function scoreBatch(items) {
  const cfg = await getConfig();
  const model = AIVSAI.modelKey(cfg);
  if (!cfg.enabled || !items?.length) return { ok: true, scores: {}, model };

  const sig = providerSignature(cfg);
  const scores = {};
  // 1. Memory, otherwise attach to a running scoring or register one ourselves -
  // without an await in between, so that no second request registers the same text in parallel
  const joined = [];
  const own = [];
  for (const it of items) {
    const key = `${sig}${it.text}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      scores[it.id] = hit;
      continue;
    }
    const running = pending.get(key);
    if (running) {
      joined.push({ it, running });
      continue;
    }
    let settle;
    pending.set(key, new Promise((resolve) => (settle = resolve)));
    own.push({ it, key, settle });
  }

  let error;
  if (own.length) {
    let result = { probs: [] };
    try {
      result = await lookup(own.map((o) => o.it), cfg, sig, model);
    } finally {
      own.forEach(({ it, key, settle }, i) => {
        const p = result.probs[i];
        if (typeof p === "number") scores[it.id] = p;
        pending.delete(key);
        settle(typeof p === "number" ? { p } : { error: result.error ?? "No score" });
      });
    }
    error = result.error;
  }
  for (const { it, running } of joined) {
    const r = await running;
    if (r.p !== undefined) scores[it.id] = r.p;
    else error ??= r.error;
  }
  return error ? { ok: false, error, scores, model } : { ok: true, scores, model };
}

// 2. persistent store, 3. model/backend. Result in the order of `items`; `error` only if the
// backend fails - hits from the store are still in `probs` then.
async function lookup(items, cfg, sig, model) {
  const probs = new Array(items.length);
  let missing = items.map((it, i) => ({ it, i }));

  // 2. persistent store (if switched on) - errors there must never prevent the scoring
  if (cfg.scoreRetentionDays > 0) {
    try {
      const keys = await Promise.all(missing.map(({ it }) => store.keyFor(sig, it.text)));
      const found = await store.getMany(keys, cfg.scoreRetentionDays);
      const rest = [];
      missing.forEach((m, j) => {
        const p = found.get(keys[j]);
        if (p === undefined) return rest.push({ ...m, key: keys[j] });
        probs[m.i] = p;
        cachePut(`${sig}${m.it.text}`, p);
      });
      missing = rest;
    } catch (err) {
      console.warn("Score store not readable", err);
    }
    if (!missing.length) return { probs };
  }

  // 3. Model/backend
  const provider = AIVSAI.providerLabel(cfg);
  try {
    const result = await scoreByLang(missing.map(({ it }) => it), cfg);
    const fresh = [];
    missing.forEach(({ it, i, key }, j) => {
      if (typeof result[j] !== "number") return;
      probs[i] = result[j];
      cachePut(`${sig}${it.text}`, result[j]);
      if (key) fresh.push({ k: key, p: result[j], m: model });
    });
    if (fresh.length) store.putMany(fresh).catch((err) => console.warn("Score store not writable", err));
    lastStatus = { ok: true, at: Date.now(), provider };
    return { probs };
  } catch (err) {
    const error = describeError(err, cfg);
    lastStatus = { ok: false, error, at: Date.now(), provider };
    return { probs, error };
  }
}

// Cleanup by retention period (0 = store nothing -> delete everything)
export async function pruneStore() {
  const { scoreRetentionDays } = await getConfig();
  await store.prune(scoreRetentionDays);
}

export async function storeInfo() {
  const { scoreRetentionDays } = await getConfig();
  return { ok: true, retentionDays: scoreRetentionDays, ...(await store.info()) };
}

export async function clearStore() {
  cache.clear();
  await store.clear();
  return storeInfo();
}

export async function testProvider() {
  const cfg = await getConfig();
  const provider = AIVSAI.providerLabel(cfg);
  const started = Date.now();
  try {
    const [score] = await backendFor(cfg).score([TEST_TEXT], cfg);
    return { ok: true, score, ms: Date.now() - started, provider };
  } catch (err) {
    return { ok: false, error: describeError(err, cfg), provider };
  }
}

// Light check for the popup: the backend's own check (browser model, /healthz), otherwise only the last
// known state (a real probe request would consume cost/quota with cloud providers).
export async function health() {
  const cfg = await getConfig();
  const provider = AIVSAI.providerLabel(cfg);
  const check = backendFor(cfg).health;
  if (check) {
    try {
      return { ...(await check(cfg)), provider };
    } catch (err) {
      return { ok: false, provider, error: String(err?.message || err) };
    }
  }
  if (lastStatus?.provider === provider) return lastStatus;
  return { ok: null, provider };
}
