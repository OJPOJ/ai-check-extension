// Bewertung mit Cache, Verbindungstest und Status fürs Popup - unabhängig vom konkreten Provider.
import "../config.js";
import { callOffscreen } from "./offscreen-client.js";
import { describeError, providerFor, trimSlash } from "./providers.js";

const CACHE_MAX = 5000;
const TEST_TEXT =
  "Maintaining a bicycle in good working condition requires regular attention to several " +
  "key components, including the tires, the chain and the brake pads.";

// providerSignature + Text -> probability; überlebt Tab-Wechsel, nicht aber einen SW-Neustart.
// Schlüssel ist der Text selbst (max. 2000 Zeichen), nicht die ID vom Content-Script: dessen
// 32-Bit-Hash ist nur innerhalb einer Seite eindeutig genug.
const cache = new Map();
let lastStatus = null; // { ok, error?, at, provider }

// Konfiguration im Speicher halten statt pro Batch zweimal aus dem Storage zu lesen
let configPromise = null;

export function getConfig() {
  configPromise ||= Promise.all([
    chrome.storage.sync.get(AIVSAI.DEFAULTS),
    chrome.storage.local.get(AIVSAI.SECRET_DEFAULTS)
  ]).then(([sync, local]) => ({ ...AIVSAI.DEFAULTS, ...sync, ...AIVSAI.SECRET_DEFAULTS, ...local }));
  return configPromise;
}

chrome.storage.onChanged.addListener(() => (configPromise = null));

function providerSignature(cfg) {
  return AIVSAI.PROVIDER_KEYS.map((k) => cfg[k]).join("\u0001");
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

/**
 * @param {{id: string, text: string}[]} items
 * @returns {Promise<{ok: boolean, scores: Record<string, number>, model: string, error?: string}>}
 *   `model` (AIVSAI.modelKey) gehört zu jedem Score - für Feedback, Berichte und Kalibrierung.
 */
export async function scoreBatch(items) {
  const cfg = await getConfig();
  const model = AIVSAI.modelKey(cfg);
  if (!cfg.enabled || !items?.length) return { ok: true, scores: {}, model };

  const sig = providerSignature(cfg);
  const scores = {};
  const missing = [];
  for (const it of items) {
    const hit = cache.get(`${sig}\u0002${it.text}`);
    if (hit !== undefined) scores[it.id] = hit;
    else missing.push(it);
  }
  if (!missing.length) return { ok: true, scores, model };

  const provider = AIVSAI.providerLabel(cfg);
  try {
    const result = await providerFor(cfg).score(missing.map((it) => it.text), cfg);
    missing.forEach((it, i) => {
      if (typeof result[i] !== "number") return;
      scores[it.id] = result[i];
      cachePut(`${sig}\u0002${it.text}`, result[i]);
    });
    lastStatus = { ok: true, at: Date.now(), provider };
    return { ok: true, scores, model };
  } catch (err) {
    const error = describeError(err, cfg);
    lastStatus = { ok: false, error, at: Date.now(), provider };
    return { ok: false, error, scores, model };
  }
}

export async function testProvider() {
  const cfg = await getConfig();
  const provider = AIVSAI.providerLabel(cfg);
  const started = Date.now();
  try {
    const [score] = await providerFor(cfg).score([TEST_TEXT], cfg);
    return { ok: true, score, ms: Date.now() - started, provider };
  } catch (err) {
    return { ok: false, error: describeError(err, cfg), provider };
  }
}

// Leichter Check fürs Popup: lokal per /healthz, remote nur der letzte bekannte Stand
// (ein echter Probe-Request würde bei Cloud-Anbietern Kosten/Quota verbrauchen).
export async function health() {
  const cfg = await getConfig();
  const provider = AIVSAI.providerLabel(cfg);
  if (cfg.provider === "browser") {
    try {
      const st = (await callOffscreen("status")).models[cfg.browserModel];
      if (st?.downloaded) return { ok: true, provider, detail: st.loaded ? "Modell geladen" : "Modell bereit" };
      if (st?.downloading) return { ok: false, provider, error: "Modell wird heruntergeladen…" };
      return { ok: false, provider, error: "Modell noch nicht heruntergeladen" };
    } catch (err) {
      return { ok: false, provider, error: String(err?.message || err) };
    }
  }
  if (cfg.provider === "local") {
    try {
      const resp = await fetch(`${trimSlash(cfg.localUrl)}/healthz`, { signal: AbortSignal.timeout(3000) });
      return resp.ok ? { ok: true, provider } : { ok: false, provider, error: `HTTP ${resp.status}` };
    } catch {
      return { ok: false, provider, error: "Lokaler Server nicht erreichbar" };
    }
  }
  if (lastStatus?.provider === provider) return lastStatus;
  return { ok: null, provider };
}
