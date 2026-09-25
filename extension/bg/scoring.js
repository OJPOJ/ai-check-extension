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
  // 1. Arbeitsspeicher
  let missing = [];
  for (const it of items) {
    const hit = cache.get(`${sig}${it.text}`);
    if (hit !== undefined) scores[it.id] = hit;
    else missing.push(it);
  }
  if (!missing.length) return { ok: true, scores, model };

  // 2. dauerhafter Speicher (falls eingeschaltet) - Fehler dort dürfen nie die Bewertung verhindern
  const persist = cfg.scoreRetentionDays > 0;
  let keys = [];
  if (persist) {
    try {
      keys = await Promise.all(missing.map((it) => store.keyFor(sig, it.text)));
      const found = await store.getMany(keys, cfg.scoreRetentionDays);
      const rest = [];
      missing.forEach((it, i) => {
        const p = found.get(keys[i]);
        if (p === undefined) return rest.push({ it, key: keys[i] });
        scores[it.id] = p;
        cachePut(`${sig}${it.text}`, p);
      });
      missing = rest.map((r) => r.it);
      keys = rest.map((r) => r.key);
    } catch (err) {
      console.warn("Score-Speicher nicht lesbar", err);
      keys = [];
    }
    if (!missing.length) return { ok: true, scores, model };
  }

  // 3. Modell/Backend
  const provider = AIVSAI.providerLabel(cfg);
  try {
    const result = await scoreByLang(missing, cfg);
    const fresh = [];
    missing.forEach((it, i) => {
      if (typeof result[i] !== "number") return;
      scores[it.id] = result[i];
      cachePut(`${sig}${it.text}`, result[i]);
      if (keys[i]) fresh.push({ k: keys[i], p: result[i], m: model });
    });
    if (fresh.length) store.putMany(fresh).catch((err) => console.warn("Score-Speicher nicht beschreibbar", err));
    lastStatus = { ok: true, at: Date.now(), provider };
    return { ok: true, scores, model };
  } catch (err) {
    const error = describeError(err, cfg);
    lastStatus = { ok: false, error, at: Date.now(), provider };
    return { ok: false, error, scores, model };
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
