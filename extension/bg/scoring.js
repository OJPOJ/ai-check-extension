// Bewertung mit Cache, Verbindungstest und Status fürs Popup - unabhängig vom konkreten Provider.
import "../config.js";
import { backendFor, describeError } from "./providers.js";
import * as store from "./score-store.js";

const CACHE_MAX = 5000;
const TEST_TEXT =
  "Maintaining a bicycle in good working condition requires regular attention to several " +
  "key components, including the tires, the chain and the brake pads.";

// Arbeitsspeicher-Cache: providerSignature + Text -> probability. Hält nur, solange der Service Worker
// läuft (~30 s ohne Nachrichten); darunter liegt der dauerhafte Speicher aus score-store.js.
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

chrome.storage.onChanged.addListener((changes) => {
  configPromise = null;
  // Treffer aus dem Arbeitsspeicher landen nie im dauerhaften Speicher - wird das Speichern eingeschaltet,
  // müssen sie einmal über den normalen Weg laufen, sonst fehlen sie dort bis zum SW-Neustart
  if ("scoreRetentionDays" in changes) cache.clear();
});

// Alles, wovon ein Score abhängt: Provider-Einstellungen plus Modellversion (modelKey). Wechsel des
// Modells oder eine neue Version -> andere Signatur -> alte Einträge passen nicht mehr.
function providerSignature(cfg) {
  return [...AIVSAI.PROVIDER_KEYS.map((k) => cfg[k]), AIVSAI.modelKey(cfg)].join("\u0001");
}

function cachePut(key, value) {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// Der Vertrag kennt `lang` pro Anfrage, nicht pro Text: gemischte Batches (selten - meist hat eine Seite
// eine Sprache) gehen als eine Anfrage pro Sprache raus. Ergebnis in der Reihenfolge von `items`.
async function scoreByLang(items, cfg) {
  const groups = Map.groupBy(items.map((it, i) => ({ it, i })), ({ it }) => it.lang || "");
  const result = new Array(items.length).fill(null);
  for (const [lang, group] of groups) {
    const scores = await backendFor(cfg).score(group.map(({ it }) => it.text), cfg, lang ? { lang } : {});
    group.forEach(({ i }, j) => (result[i] = scores[j]));
  }
  return result;
}

// Laufende Bewertungen: Cache-Schlüssel -> Promise<{p?: number, error?: string}>. Scannen mehrere Tabs
// dieselbe Seite (oder steht ein Absatz zweimal in einem Batch), geht jeder Text nur einmal an Speicher
// und Backend; die anderen Anfragen warten auf dieses Ergebnis.
const pending = new Map();

/**
 * @param {{id: string, text: string, lang?: string}[]} items  lang: erkannte Sprache, falls bekannt
 * @returns {Promise<{ok: boolean, scores: Record<string, number>, model: string, error?: string}>}
 *   `model` (AIVSAI.modelKey) gehört zu jedem Score - für Feedback, Berichte und Kalibrierung.
 */
export async function scoreBatch(items) {
  const cfg = await getConfig();
  const model = AIVSAI.modelKey(cfg);
  if (!cfg.enabled || !items?.length) return { ok: true, scores: {}, model };

  const sig = providerSignature(cfg);
  const scores = {};
  // 1. Arbeitsspeicher, sonst an eine laufende Bewertung anhängen oder selbst eine anmelden -
  // ohne await dazwischen, damit keine zweite Anfrage denselben Text parallel anmeldet
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
        settle(typeof p === "number" ? { p } : { error: result.error ?? "Keine Bewertung" });
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

// 2. dauerhafter Speicher, 3. Modell/Backend. Ergebnis in der Reihenfolge von `items`; `error` nur, wenn das
// Backend scheitert - Treffer aus dem Speicher sind dann trotzdem in `probs`.
async function lookup(items, cfg, sig, model) {
  const probs = new Array(items.length);
  let missing = items.map((it, i) => ({ it, i }));

  // 2. dauerhafter Speicher (falls eingeschaltet) - Fehler dort dürfen nie die Bewertung verhindern
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
      console.warn("Score-Speicher nicht lesbar", err);
    }
    if (!missing.length) return { probs };
  }

  // 3. Modell/Backend
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
    if (fresh.length) store.putMany(fresh).catch((err) => console.warn("Score-Speicher nicht beschreibbar", err));
    lastStatus = { ok: true, at: Date.now(), provider };
    return { probs };
  } catch (err) {
    const error = describeError(err, cfg);
    lastStatus = { ok: false, error, at: Date.now(), provider };
    return { probs, error };
  }
}

// Aufräumen nach Aufbewahrungsdauer (0 = nichts speichern -> alles löschen)
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

// Leichter Check fürs Popup: eigener Check des Backends (Browser-Modell, /healthz), sonst nur der letzte
// bekannte Stand (ein echter Probe-Request würde bei Cloud-Anbietern Kosten/Quota verbrauchen).
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
