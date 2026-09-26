// Backends: die Anfrage-Seite der Provider aus config.js (AIVSAI.PROVIDERS, dort Name, Felder,
// Datenschutz). Neuer Provider = Eintrag dort plus Eintrag unter demselben Schlüssel in BACKENDS.
//
//   score(texts, cfg, {lang}?)  -> pro Text eine KI-Wahrscheinlichkeit 0..1 (oder null, falls für diesen Text
//                      nichts Gültiges kam). `lang` = Sprache der Texte, falls bekannt.
//   health(cfg)        optional, leichter Check fürs Popup -> {ok, detail?, error?}. Ohne: letzter bekannter
//                      Stand (ein Probe-Request würde bei Cloud-Anbietern Kosten/Quota verbrauchen)
//   inspect(cfg)       optional, für „Modell prüfen“ (model-check.js): was das Backend über das Modell verrät
//                      -> {info: {name?, version?, maxChars?, languages?, suggestedThresholds?, aiLabel?},
//                      labels?, notes: [...]}; wirft, wenn das Modell den Rahmen sicher nicht erfüllt
//   unreachable(cfg)   optional, Text für Netzwerkfehler
import { callOffscreen } from "./offscreen-client.js";

const LOCAL_TIMEOUT_MS = 180_000; // großzügig: desklib auf langsamer CPU und beim ersten Laden des Modells
const REMOTE_TIMEOUT_MS = 30_000;

export const trimSlash = (url) => url.replace(/\/+$/, "");

async function httpError(resp) {
  let detail = "";
  try {
    const body = await resp.json();
    detail = body?.error?.message || body?.error || body?.detail || "";
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // Body ist kein JSON - Statuscode reicht
  }
  return new Error(`HTTP ${resp.status}${detail ? `: ${detail}` : ""}`);
}

const bearer = (apiKey) => (apiKey ? { Authorization: `Bearer ${apiKey}` } : {});

async function postJson(url, body, { apiKey, timeoutMs }) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...bearer(apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw await httpError(resp);
  return resp.json();
}

async function getJson(url, { apiKey, timeoutMs = REMOTE_TIMEOUT_MS } = {}) {
  const resp = await fetch(url, { headers: bearer(apiKey), signal: AbortSignal.timeout(timeoutMs) });
  if (!resp.ok) throw await httpError(resp);
  return resp.json();
}

export const isProbability = (s) => typeof s === "number" && s >= 0 && s <= 1;

// Vertrag für lokalen und eigenen Server (server/README.md, „Vertrag“):
//   POST {texts: [...], model?, lang?} -> {scores: [P(KI) 0..1, ...]}
// Werte außerhalb 0..1 (z.B. Logits) werden null - der Absatz bleibt unbewertet statt falsch markiert.
async function postScoreContract(url, texts, { model, lang, apiKey, timeoutMs }) {
  const body = { texts };
  if (model) body.model = model;
  if (lang) body.lang = lang;
  const data = await postJson(url, body, { apiKey, timeoutMs });
  if (!Array.isArray(data.scores) || data.scores.length !== texts.length) {
    throw new Error("Antwort enthält kein passendes 'scores'-Array");
  }
  return data.scores.map((s) => (isProbability(s) ? s : null));
}

// Optionales GET /v1/info neben dem Score-Endpunkt: {name, version, maxChars, languages, suggestedThresholds,
// reliableWords, shortRedFrom} - die letzten beiden wie in models.js (Ampel für kurze Absätze).
// Fehlt der Endpunkt, ist das kein Fehler; unbrauchbare Felder werden mit Hinweis verworfen.
async function fetchServerInfo(url, apiKey) {
  let raw;
  try {
    raw = await getJson(url, { apiKey });
  } catch (err) {
    if (/^HTTP (404|405|501)\b/.test(err?.message)) return { info: {}, notes: ["Kein /v1/info – Version unbekannt."] };
    throw err;
  }
  const info = {};
  const notes = [];
  const take = (key, ok) => {
    const value = raw?.[key];
    if (value === undefined || value === null) return;
    if (ok(value)) info[key] = value;
    else notes.push(`/v1/info: „${key}“ ungültig, ignoriert.`);
  };
  take("name", (v) => typeof v === "string");
  take("version", (v) => (typeof v === "string" && v !== "") || typeof v === "number");
  if (info.version !== undefined) info.version = String(info.version);
  take("maxChars", (v) => Number.isInteger(v) && v >= 100 && v <= 20000);
  take("languages", (v) => Array.isArray(v) && v.every((l) => typeof l === "string"));
  take("suggestedThresholds", (v) => isProbability(v?.yellowFrom) && isProbability(v?.redFrom) && v.yellowFrom < v.redFrom);
  take("reliableWords", (v) => Number.isInteger(v) && v >= 0 && v <= 1000);
  take("shortRedFrom", isProbability);
  if (!info.version) notes.push("Server nennt keine Version – ein Modell-Update dort bleibt unbemerkt.");
  return { info, notes };
}

const withModel = (url, model) => (model ? `${url}?model=${encodeURIComponent(model)}` : url);

const AI_LABEL = /^(ai|fake|machine|generated|ai[-_ ]generated|machine[-_ ]generated|chatgpt|gpt|llm|label_1)$/i;
const HUMAN_LABEL = /^(human|real|human[-_ ]written|label_0)$/i;

// Mit bekanntem aiLabel (eingetragen oder aus id2label per „Modell prüfen“, dort genau 2 Klassen) gilt:
// kam nur die andere Klasse zurück (Top-1), ist P(KI) die Gegenwahrscheinlichkeit.
function probabilityFromLabels(labels, aiLabel) {
  const isAi = aiLabel ? (l) => l.toLowerCase() === aiLabel.toLowerCase() : (l) => AI_LABEL.test(l);
  const ai = labels.find((x) => isAi(String(x.label)));
  if (ai) return ai.score;
  if (labels.length !== 1) return null;
  // nur Top-1 zurückgekommen und das war die Mensch-Klasse
  if (aiLabel || HUMAN_LABEL.test(String(labels[0].label))) return 1 - labels[0].score;
  return null;
}

const HUB = "https://huggingface.co";

// Eindeutig per Name: genau eine Klasse sieht nach KI aus bzw. genau eine nach Mensch.
// LABEL_0/LABEL_1 zählen nicht - welche die KI-Klasse ist, ist Konvention des Autors.
function aiLabelByName(labels) {
  const named = (re) => labels.filter((l) => re.test(l) && !/^label_\d+$/i.test(l));
  if (named(AI_LABEL).length === 1) return named(AI_LABEL)[0];
  if (named(HUMAN_LABEL).length === 1) return labels.find((l) => l !== named(HUMAN_LABEL)[0]);
  return null;
}

// Rahmen für Hugging-Face-Modelle: Textklassifikation mit genau 2 Klassen. Das KI-Label kommt aus id2label
// (config.json auf dem Hub); verraten die Namen nichts (LABEL_0/LABEL_1), bestimmt es model-check.js
// anhand des Referenzsets aus `labels`.
async function inspectHuggingFace(cfg) {
  if (!cfg.hfModel) throw new Error("Kein Hugging-Face-Modell konfiguriert");
  const apiKey = cfg.hfToken;
  let meta;
  try {
    meta = await getJson(`${HUB}/api/models/${cfg.hfModel}`, { apiKey });
  } catch (err) {
    if (/^HTTP (401|403|404)\b/.test(err?.message)) {
      throw new Error(`Modell „${cfg.hfModel}“ nicht gefunden (oder privat/gated ohne passenden Token)`);
    }
    throw err;
  }
  if (meta.pipeline_tag !== "text-classification") {
    throw new Error(`Kein Textklassifikations-Modell (pipeline_tag: ${meta.pipeline_tag ?? "fehlt"})`);
  }
  const config = await getJson(`${HUB}/${cfg.hfModel}/resolve/${meta.sha}/config.json`, { apiKey });
  const labels = Object.entries(config.id2label ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, name]) => String(name));
  if (labels.length !== 2) {
    throw new Error(`Braucht genau 2 Klassen (Mensch/KI), das Modell hat ${labels.length || "keine"}${labels.length ? `: ${labels.join(", ")}` : ""}`);
  }
  const info = { name: cfg.hfModel, version: meta.sha?.slice(0, 7) };
  const notes = [];
  if (cfg.hfAiLabel) {
    const match = labels.find((l) => l.toLowerCase() === cfg.hfAiLabel.toLowerCase());
    if (!match) throw new Error(`Label „${cfg.hfAiLabel}“ gibt es nicht (Modell hat: ${labels.join(", ")})`);
    info.aiLabel = match;
    notes.push(`KI-Label „${match}“ (eingetragen).`);
  } else {
    const byName = aiLabelByName(labels);
    if (byName) {
      info.aiLabel = byName;
      notes.push(`KI-Label „${byName}“ aus id2label (${labels.join(", ")}).`);
    }
  }
  return { info, labels, notes };
}

async function scoreHuggingFace(texts, cfg) {
  if (!cfg.hfModel) throw new Error("Kein Hugging-Face-Modell konfiguriert");
  const aiLabel = cfg.hfAiLabel || globalThis.AIVSAI?.modelCheck(cfg)?.info?.aiLabel;
  let data = await postJson(
    `https://router.huggingface.co/hf-inference/models/${cfg.hfModel}`,
    { inputs: texts },
    { apiKey: cfg.hfToken, timeoutMs: REMOTE_TIMEOUT_MS }
  );

  // Antwortformen normalisieren: [[{label,score},...], ...] pro Text,
  // bei einem Einzeltext teils [{label,score},...], bei Top-1 teils flach.
  if (!Array.isArray(data)) throw new Error("Unerwartete Antwort der Inference API");
  if (data.length && !Array.isArray(data[0])) {
    data = texts.length === 1 ? [data] : data.map((x) => [x]);
  }
  if (data.length !== texts.length) throw new Error("Anzahl Ergebnisse passt nicht zur Anzahl Texte");

  const scores = data.map((labels) => probabilityFromLabels(labels, aiLabel));
  if (scores.every((s) => s === null)) {
    const seen = data[0]?.map((x) => x.label).join(", ");
    throw new Error(`KI-Label nicht gefunden (Modell liefert: ${seen}) – in den Einstellungen setzen`);
  }
  return scores;
}

async function browserHealth(cfg) {
  const st = (await callOffscreen("status")).models[cfg.browserModel];
  if (st?.downloaded) return { ok: true, detail: st.loaded ? "Modell geladen" : "Modell bereit" };
  if (st?.downloading) return { ok: false, error: "Modell wird heruntergeladen…" };
  return { ok: false, error: "Modell noch nicht heruntergeladen" };
}

async function localHealth(cfg) {
  try {
    const resp = await fetch(`${trimSlash(cfg.localUrl)}/healthz`, { signal: AbortSignal.timeout(3000) });
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
  } catch {
    return { ok: false, error: "Lokaler Server nicht erreichbar" };
  }
}

export const BACKENDS = {
  browser: {
    score: async (texts, cfg) => (await callOffscreen("score", { texts, model: cfg.browserModel })).scores,
    health: browserHealth
  },
  local: {
    score: (texts, cfg, { lang } = {}) =>
      postScoreContract(`${trimSlash(cfg.localUrl)}/v1/score`, texts, {
        model: cfg.localModel,
        lang,
        timeoutMs: LOCAL_TIMEOUT_MS
      }),
    inspect: (cfg) => fetchServerInfo(withModel(`${trimSlash(cfg.localUrl)}/v1/info`, cfg.localModel)),
    health: localHealth,
    unreachable: (cfg) => `Lokaler Server nicht erreichbar (${cfg.localUrl}) – läuft shim_server.py?`
  },
  custom: {
    score: (texts, cfg, { lang } = {}) => {
      if (!cfg.customUrl) throw new Error("Keine Server-URL konfiguriert");
      return postScoreContract(cfg.customUrl, texts, {
        model: cfg.customModel,
        lang,
        apiKey: cfg.customApiKey,
        timeoutMs: REMOTE_TIMEOUT_MS
      });
    },
    // /v1/info liegt neben dem Score-Endpunkt: https://h/v1/score -> https://h/v1/info
    inspect: (cfg) => {
      if (!cfg.customUrl) throw new Error("Keine Server-URL konfiguriert");
      return fetchServerInfo(withModel(new URL("info", cfg.customUrl).href, cfg.customModel), cfg.customApiKey);
    }
  },
  huggingface: { score: scoreHuggingFace, inspect: inspectHuggingFace }
};

export const backendFor = (cfg) => BACKENDS[cfg.provider] || BACKENDS.local;

export function describeError(err, cfg) {
  if (err?.name === "TimeoutError") return "Zeitüberschreitung beim Backend";
  // fetch() meldet DNS-/Verbindungsfehler und fehlende Host-Berechtigung nur als TypeError
  if (err instanceof TypeError) {
    const unreachable = BACKENDS[cfg.provider]?.unreachable;
    return unreachable
      ? unreachable(cfg)
      : "Backend nicht erreichbar (Netzwerk oder fehlende Berechtigung – in den Einstellungen speichern)";
  }
  return String(err?.message || err);
}
