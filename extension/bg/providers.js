// Provider: jeder bekommt eine Liste Texte und liefert pro Text eine KI-Wahrscheinlichkeit 0..1
// (oder null, falls für diesen Text nichts kam). Neue Backends = neuer Eintrag in PROVIDERS.
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

async function postJson(url, body, { apiKey, timeoutMs }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!resp.ok) throw await httpError(resp);
  return resp.json();
}

// Einheitlicher Vertrag für lokalen und eigenen Server:
//   POST {texts: [...], model?} -> {scores: [0..1, ...]}
async function postScoreContract(url, texts, model, apiKey, timeoutMs) {
  const data = await postJson(url, model ? { model, texts } : { texts }, { apiKey, timeoutMs });
  if (!Array.isArray(data.scores) || data.scores.length !== texts.length) {
    throw new Error("Antwort enthält kein passendes 'scores'-Array");
  }
  return data.scores.map((s) => (typeof s === "number" ? s : null));
}

const AI_LABEL = /^(ai|fake|machine|generated|ai[-_ ]generated|machine[-_ ]generated|chatgpt|gpt|llm|label_1)$/i;
const HUMAN_LABEL = /^(human|real|human[-_ ]written|label_0)$/i;

function probabilityFromLabels(labels, aiLabel) {
  const isAi = aiLabel ? (l) => l.toLowerCase() === aiLabel.toLowerCase() : (l) => AI_LABEL.test(l);
  const ai = labels.find((x) => isAi(String(x.label)));
  if (ai) return ai.score;
  // nur Top-1 zurückgekommen und das war die Mensch-Klasse
  const human = labels.find((x) => HUMAN_LABEL.test(String(x.label)));
  if (human && labels.length === 1) return 1 - human.score;
  return null;
}

async function scoreHuggingFace(texts, cfg) {
  if (!cfg.hfModel) throw new Error("Kein Hugging-Face-Modell konfiguriert");
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

  const scores = data.map((labels) => probabilityFromLabels(labels, cfg.hfAiLabel));
  if (scores.every((s) => s === null)) {
    const seen = data[0]?.map((x) => x.label).join(", ");
    throw new Error(`KI-Label nicht gefunden (Modell liefert: ${seen}) – in den Einstellungen setzen`);
  }
  return scores;
}

export const PROVIDERS = {
  browser: {
    score: async (texts, cfg) => (await callOffscreen("score", { texts, model: cfg.browserModel })).scores
  },
  local: {
    score: (texts, cfg) =>
      postScoreContract(`${trimSlash(cfg.localUrl)}/v1/score`, texts, cfg.localModel, null, LOCAL_TIMEOUT_MS)
  },
  custom: {
    score: (texts, cfg) => {
      if (!cfg.customUrl) throw new Error("Keine Server-URL konfiguriert");
      return postScoreContract(cfg.customUrl, texts, cfg.customModel, cfg.customApiKey, REMOTE_TIMEOUT_MS);
    }
  },
  huggingface: { score: scoreHuggingFace }
};

export const providerFor = (cfg) => PROVIDERS[cfg.provider] || PROVIDERS.local;

export function describeError(err, cfg) {
  if (err?.name === "TimeoutError") return "Zeitüberschreitung beim Backend";
  // fetch() meldet DNS-/Verbindungsfehler und fehlende Host-Berechtigung nur als TypeError
  if (err instanceof TypeError) {
    return cfg.provider === "local"
      ? `Lokaler Server nicht erreichbar (${cfg.localUrl}) – läuft shim_server.py?`
      : "Backend nicht erreichbar (Netzwerk oder fehlende Berechtigung – in den Einstellungen speichern)";
  }
  return String(err?.message || err);
}
