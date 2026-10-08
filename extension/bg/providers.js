// Backends: the request side of the providers from config.js (AIVSAI.PROVIDERS, which holds name, fields,
// privacy). New provider = entry there plus an entry under the same key in BACKENDS.
//
//   score(texts, cfg, {lang}?)  -> an AI probability 0..1 per text (or null if nothing valid came back for
//                      this text). `lang` = language of the texts, if known.
//   health(cfg)        optional, light check for the popup -> {ok, detail?, error?}. Without: last known
//                      state (a probe request would consume cost/quota with cloud providers)
//   inspect(cfg)       optional, for "Check model" (model-check.js): what the backend reveals about the model
//                      -> {info: {name?, version?, maxChars?, languages?, suggestedThresholds?, aiLabel?},
//                      labels?, notes: [...]}; throws if the model definitely does not meet the requirements
//   unreachable(cfg)   optional, text for network errors
import { callOffscreen } from "./offscreen-client.js";

const LOCAL_TIMEOUT_MS = 180_000; // generous: desklib on a slow CPU and on first loading of the model
const REMOTE_TIMEOUT_MS = 30_000;

export const trimSlash = (url) => url.replace(/\/+$/, "");

async function httpError(resp) {
  let detail = "";
  try {
    const body = await resp.json();
    detail = body?.error?.message || body?.error || body?.detail || "";
    if (typeof detail !== "string") detail = JSON.stringify(detail);
  } catch {
    // Body is not JSON - status code is enough
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

// Contract for local and custom server (server/README.md, "Contract"):
//   POST {texts: [...], model?, lang?} -> {scores: [P(AI) 0..1, ...]}
// Values outside 0..1 (e.g. logits) become null - the paragraph stays unscored instead of wrongly marked.
async function postScoreContract(url, texts, { model, lang, apiKey, timeoutMs }) {
  const body = { texts };
  if (model) body.model = model;
  if (lang) body.lang = lang;
  const data = await postJson(url, body, { apiKey, timeoutMs });
  if (!Array.isArray(data.scores) || data.scores.length !== texts.length) {
    throw new Error("Response does not contain a matching 'scores' array");
  }
  return data.scores.map((s) => (isProbability(s) ? s : null));
}

// Optional GET /v1/info next to the score endpoint: {name, version, maxChars, languages, suggestedThresholds,
// reliableWords, shortRedFrom} - the last two as in models.js (traffic light for short paragraphs).
// If the endpoint is missing, that is not an error; unusable fields are discarded with a note.
async function fetchServerInfo(url, apiKey) {
  let raw;
  try {
    raw = await getJson(url, { apiKey });
  } catch (err) {
    if (/^HTTP (404|405|501)\b/.test(err?.message)) return { info: {}, notes: ["No /v1/info – version unknown."] };
    throw err;
  }
  const info = {};
  const notes = [];
  const take = (key, ok) => {
    const value = raw?.[key];
    if (value === undefined || value === null) return;
    if (ok(value)) info[key] = value;
    else notes.push(`/v1/info: "${key}" invalid, ignored.`);
  };
  take("name", (v) => typeof v === "string");
  take("version", (v) => (typeof v === "string" && v !== "") || typeof v === "number");
  if (info.version !== undefined) info.version = String(info.version);
  take("maxChars", (v) => Number.isInteger(v) && v >= 100 && v <= 20000);
  take("languages", (v) => Array.isArray(v) && v.every((l) => typeof l === "string"));
  take("suggestedThresholds", (v) => isProbability(v?.yellowFrom) && isProbability(v?.redFrom) && v.yellowFrom < v.redFrom);
  take("reliableWords", (v) => Number.isInteger(v) && v >= 0 && v <= 1000);
  take("shortRedFrom", isProbability);
  if (!info.version) notes.push("Server gives no version – a model update there goes unnoticed.");
  return { info, notes };
}

const withModel = (url, model) => (model ? `${url}?model=${encodeURIComponent(model)}` : url);

const AI_LABEL = /^(ai|fake|machine|generated|ai[-_ ]generated|machine[-_ ]generated|chatgpt|gpt|llm|label_1)$/i;
const HUMAN_LABEL = /^(human|real|human[-_ ]written|label_0)$/i;

// With a known aiLabel (entered or from id2label via "Check model", exactly 2 classes there) the following applies:
// if only the other class came back (top-1), P(AI) is the complementary probability.
function probabilityFromLabels(labels, aiLabel) {
  const isAi = aiLabel ? (l) => l.toLowerCase() === aiLabel.toLowerCase() : (l) => AI_LABEL.test(l);
  const ai = labels.find((x) => isAi(String(x.label)));
  if (ai) return ai.score;
  if (labels.length !== 1) return null;
  // only top-1 came back and it was the human class
  if (aiLabel || HUMAN_LABEL.test(String(labels[0].label))) return 1 - labels[0].score;
  return null;
}

const HUB = "https://huggingface.co";

// Unambiguous by name: exactly one class looks like AI or exactly one looks like human.
// LABEL_0/LABEL_1 do not count - which one is the AI class is the author's convention.
function aiLabelByName(labels) {
  const named = (re) => labels.filter((l) => re.test(l) && !/^label_\d+$/i.test(l));
  if (named(AI_LABEL).length === 1) return named(AI_LABEL)[0];
  if (named(HUMAN_LABEL).length === 1) return labels.find((l) => l !== named(HUMAN_LABEL)[0]);
  return null;
}

// Requirements for Hugging Face models: text classification with exactly 2 classes. The AI label comes from id2label
// (config.json on the Hub); if the names reveal nothing (LABEL_0/LABEL_1), model-check.js determines it
// from `labels` using the reference set.
async function inspectHuggingFace(cfg) {
  if (!cfg.hfModel) throw new Error("No Hugging Face model configured");
  const apiKey = cfg.hfToken;
  let meta;
  try {
    meta = await getJson(`${HUB}/api/models/${cfg.hfModel}`, { apiKey });
  } catch (err) {
    if (/^HTTP (401|403|404)\b/.test(err?.message)) {
      throw new Error(`Model "${cfg.hfModel}" not found (or private/gated without a suitable token)`);
    }
    throw err;
  }
  if (meta.pipeline_tag !== "text-classification") {
    throw new Error(`Not a text classification model (pipeline_tag: ${meta.pipeline_tag ?? "missing"})`);
  }
  const config = await getJson(`${HUB}/${cfg.hfModel}/resolve/${meta.sha}/config.json`, { apiKey });
  const labels = Object.entries(config.id2label ?? {})
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, name]) => String(name));
  if (labels.length !== 2) {
    throw new Error(`Needs exactly 2 classes (human/AI), the model has ${labels.length || "none"}${labels.length ? `: ${labels.join(", ")}` : ""}`);
  }
  const info = { name: cfg.hfModel, version: meta.sha?.slice(0, 7) };
  const notes = [];
  if (cfg.hfAiLabel) {
    const match = labels.find((l) => l.toLowerCase() === cfg.hfAiLabel.toLowerCase());
    if (!match) throw new Error(`Label "${cfg.hfAiLabel}" does not exist (model has: ${labels.join(", ")})`);
    info.aiLabel = match;
    notes.push(`AI label "${match}" (entered).`);
  } else {
    const byName = aiLabelByName(labels);
    if (byName) {
      info.aiLabel = byName;
      notes.push(`AI label "${byName}" from id2label (${labels.join(", ")}).`);
    }
  }
  return { info, labels, notes };
}

async function scoreHuggingFace(texts, cfg) {
  if (!cfg.hfModel) throw new Error("No Hugging Face model configured");
  const aiLabel = cfg.hfAiLabel || globalThis.AIVSAI?.modelCheck(cfg)?.info?.aiLabel;
  let data = await postJson(
    `https://router.huggingface.co/hf-inference/models/${cfg.hfModel}`,
    { inputs: texts },
    { apiKey: cfg.hfToken, timeoutMs: REMOTE_TIMEOUT_MS }
  );

  // Normalize response shapes: [[{label,score},...], ...] per text,
  // for a single text sometimes [{label,score},...], for top-1 sometimes flat.
  if (!Array.isArray(data)) throw new Error("Unexpected response from the Inference API");
  if (data.length && !Array.isArray(data[0])) {
    data = texts.length === 1 ? [data] : data.map((x) => [x]);
  }
  if (data.length !== texts.length) throw new Error("Number of results does not match the number of texts");

  const scores = data.map((labels) => probabilityFromLabels(labels, aiLabel));
  if (scores.every((s) => s === null)) {
    const seen = data[0]?.map((x) => x.label).join(", ");
    throw new Error(`AI label not found (model returns: ${seen}) – set it in the settings`);
  }
  return scores;
}

async function browserHealth(cfg) {
  const st = (await callOffscreen("status")).models[cfg.browserModel];
  if (st?.downloaded) return { ok: true, detail: st.loaded ? "Model loaded" : "Model ready" };
  if (st?.downloading) return { ok: false, error: "Model is being downloaded…" };
  return { ok: false, error: "Model not downloaded yet" };
}

async function localHealth(cfg) {
  try {
    const resp = await fetch(`${trimSlash(cfg.localUrl)}/healthz`, { signal: AbortSignal.timeout(3000) });
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
  } catch {
    return { ok: false, error: "Local server unreachable" };
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
    unreachable: (cfg) => `Local server unreachable (${cfg.localUrl}) – is shim_server.py running?`
  },
  custom: {
    score: (texts, cfg, { lang } = {}) => {
      if (!cfg.customUrl) throw new Error("No server URL configured");
      return postScoreContract(cfg.customUrl, texts, {
        model: cfg.customModel,
        lang,
        apiKey: cfg.customApiKey,
        timeoutMs: REMOTE_TIMEOUT_MS
      });
    },
    // /v1/info sits next to the score endpoint: https://h/v1/score -> https://h/v1/info
    inspect: (cfg) => {
      if (!cfg.customUrl) throw new Error("No server URL configured");
      return fetchServerInfo(withModel(new URL("info", cfg.customUrl).href, cfg.customModel), cfg.customApiKey);
    }
  },
  huggingface: { score: scoreHuggingFace, inspect: inspectHuggingFace }
};

export const backendFor = (cfg) => BACKENDS[cfg.provider] || BACKENDS.local;

export function describeError(err, cfg) {
  if (err?.name === "TimeoutError") return "Backend timed out";
  // fetch() reports DNS/connection errors and a missing host permission only as TypeError
  if (err instanceof TypeError) {
    const unreachable = BACKENDS[cfg.provider]?.unreachable;
    return unreachable
      ? unreachable(cfg)
      : "Backend unreachable (network or missing permission – save in the settings)";
  }
  return String(err?.message || err);
}
