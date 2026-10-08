// "Check model" (settings, required for custom models): a custom model is a binary
// classifier, so before use it can be checked whether it meets the requirements. For that the
// reference set (reference-set.js, ~60 human and AI texts, short/long paragraphs separated) goes to the backend:
//   Shape        one number in 0..1 per text, response before the timeout
//   Direction    AI texts higher on average than human texts (otherwise label swapped)
//   Separation   AUROC, warning below AUROC_WARN, rejected below AUROC_MIN
//   Thresholds   starting values for the traffic light (suggestion from the server or from the scores)
//   Short text   own red threshold below RELIABLE_WORDS if the reference set allows it (otherwise never red)
//   Latency      ms per text -> recommendation for the scan mode
// Plus what the backend itself says about the model (inspect in providers.js: /v1/info or Hub metadata).
import "../config.js";
import { backendFor, describeError } from "./providers.js";
import { REFERENCE_SET } from "./reference-set.js";

export const AUROC_MIN = 0.6; // Laya zero-shot was at 0.549 (training/EVAL_RESULTS.md)
export const AUROC_WARN = 0.8;
const BATCH_CHARS = 2500; // like the batches from content.js
const RELIABLE_WORDS = 120; // like config.js RELIABLE_WORDS/extension/models.js - the reference set splits exactly here
const MIN_BUCKET = 15; // Minimum number of human/AI texts per bucket to derive a short-text threshold from

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (p) => `${Math.round(p * 100)}%`;
const up2 = (x) => Math.ceil(x * 100 - 1e-9) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Share of (AI, human) pairs in which the AI text scores higher; a tie counts half
export function auroc(human, ai) {
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a > h ? 1 : a === h ? 0.5 : 0;
  return wins / (ai.length * human.length);
}

// Traffic light from the scores, cautious: red just above the highest human text (on the reference set no
// human text turns red - the worst harm is red on a human text), yellow from the upper quartile
// of the human texts. Limits like the sliders in options.html.
export function suggestThresholds(human) {
  const sorted = [...human].sort((a, b) => a - b);
  const redFrom = clamp(up2(sorted.at(-1) + 0.01), 0.06, 0.99);
  const q75 = sorted[Math.floor(0.75 * (sorted.length - 1))];
  return { yellowFrom: clamp(up2(q75), 0.05, Math.round((redFrom - 0.01) * 100) / 100), redFrom };
}

// Own red threshold for short paragraphs (< RELIABLE_WORDS), by the same principle as suggestThresholds
// (just above the highest short human text), but never looser than the long threshold. Only useful if
// it still detects a meaningful share of the short AI texts (otherwise like TMR in models.js: never red, `null`).
export function suggestShortRedFrom(shortHuman, shortAi, longRedFrom) {
  const sorted = [...shortHuman].sort((a, b) => a - b);
  const candidate = clamp(up2(sorted.at(-1) + 0.01), longRedFrom, 0.99);
  const caught = shortAi.filter((s) => s >= candidate).length / shortAi.length;
  return caught >= 0.3 ? candidate : null;
}

export function scanHint(msPerText) {
  if (msPerText < 300) return "fast enough for automatic scanning";
  if (msPerText < 2000) return "recommended: automatic only on selected sites, with \"Only paragraphs nearby\"";
  return "recommended: \"Only on button press\"";
}

/**
 * Evaluates the responses to the reference set.
 * @param {(number|null)[]} scores  per reference text
 * @param {boolean[]} isAi          label per reference text
 * @param {{msPerText: number, suggestedThresholds?: {yellowFrom: number, redFrom: number}, words?: number[]}} opts
 *   `words` (optional): actual word count per (possibly truncated) reference text - if present, a
 *   short-text threshold is suggested in addition (reliableWords/shortRedFrom).
 * @returns {{ok: boolean, checks: {status: "ok"|"warn"|"fail"|"info", text: string}[], auroc?: number,
 *   thresholds?: {yellowFrom: number, redFrom: number}, reliableWords?: number, shortRedFrom?: number|null}}
 */
export function assess(scores, isAi, { msPerText, suggestedThresholds, words }) {
  const checks = [];
  const add = (status, text) => checks.push({ status, text });
  const done = (extra = {}) => ({ ok: !checks.some((c) => c.status === "fail"), checks, ...extra });

  const invalid = scores.filter((s) => typeof s !== "number").length;
  if (invalid) {
    add("fail", `${invalid} of ${scores.length} responses are missing or not in 0..1 – expected is P(AI) per text.`);
    return done();
  }
  add("ok", `Shape: ${scores.length} scores in 0..1.`);

  const human = scores.filter((_, i) => !isAi[i]);
  const ai = scores.filter((_, i) => isAi[i]);
  const [meanHuman, meanAi] = [mean(human), mean(ai)];
  if (meanAi <= meanHuman) {
    add(
      "fail",
      `Direction: AI texts ${pct(meanAi)} on average, human texts ${pct(meanHuman)} – does the model return P(human) ` +
        "instead of P(AI)? (typical: LABEL_0/LABEL_1 swapped)"
    );
    return done();
  }
  add("ok", `Direction: AI texts ${pct(meanAi)} on average, human texts ${pct(meanHuman)}.`);

  const area = auroc(human, ai);
  const areaText = `Separation: AUROC ${area.toFixed(2)} on ${scores.length} reference texts`;
  if (area < AUROC_MIN) add("fail", `${areaText} – too low (at least ${AUROC_MIN}), barely better than guessing.`);
  else if (area < AUROC_WARN) add("warn", `${areaText} – weak, expect many false alarms (good: from ${AUROC_WARN}).`);
  else add("ok", `${areaText}.`);

  const thresholds = suggestedThresholds ?? suggestThresholds(human);
  const redAi = ai.filter((s) => s >= thresholds.redFrom).length;
  const redHuman = human.filter((s) => s >= thresholds.redFrom).length;
  add(
    "info",
    `Traffic light: yellow from ${pct(thresholds.yellowFrom)}, red from ${pct(thresholds.redFrom)} ` +
      `(${suggestedThresholds ? "suggested by the server" : "from the scores"}). Red on the reference set: ` +
      `${redAi} of ${ai.length} AI texts, ${redHuman} of ${human.length} human texts.`
  );

  add("info", `Latency: ~${Math.round(msPerText)} ms per text – ${scanHint(msPerText)}.`);

  // Short-text threshold: only if the reference set has enough short texts per class (MIN_BUCKET) - otherwise
  // reliableWords stays at the default (RELIABLE_WORDS) and shortRedFrom undetermined (config.js: then never red).
  let reliableWords, shortRedFrom;
  if (words) {
    const short = (ai) => scores.filter((s, i) => isAi[i] === ai && words[i] < RELIABLE_WORDS);
    const [shortHuman, shortAi] = [short(false), short(true)];
    if (shortHuman.length >= MIN_BUCKET && shortAi.length >= MIN_BUCKET) {
      reliableWords = RELIABLE_WORDS;
      shortRedFrom = suggestShortRedFrom(shortHuman, shortAi, thresholds.redFrom);
      add(
        "info",
        shortRedFrom === null
          ? `Short paragraphs (< ${RELIABLE_WORDS} words, ${shortHuman.length} human/${shortAi.length} AI texts in the set): ` +
              "no own red threshold suggested – too little separation, stays \"uncertain\" instead of red."
          : `Short paragraphs (< ${RELIABLE_WORDS} words): own red threshold ${pct(shortRedFrom)} suggested ` +
              `(detects ${shortAi.filter((s) => s >= shortRedFrom).length} of ${shortAi.length} short AI texts).`
      );
    } else {
      add(
        "info",
        `Too few short reference texts (${shortHuman.length} human/${shortAi.length} AI texts) for an own ` +
          `short-text threshold – reliableWords stays at the default (${RELIABLE_WORDS}).`
      );
    }
  }

  return done({ auroc: area, meanHuman, meanAi, thresholds, reliableWords, shortRedFrom });
}

// Reference texts in batches as in operation (content.js sends up to BATCH_CHARS characters per request)
function batches(texts) {
  const out = [];
  for (const t of texts) {
    const last = out.at(-1);
    if (last && last.reduce((n, x) => n + x.length, 0) + t.length <= BATCH_CHARS) last.push(t);
    else out.push([t]);
  }
  return out;
}

/**
 * Checks the model of the (possibly not yet saved) settings `cfg`.
 * @returns result for AIVSAI.DEFAULTS.modelChecks plus `checks` for display
 */
export async function checkModel(cfg, set = REFERENCE_SET) {
  const backend = backendFor(cfg);
  const result = (extra) => ({ sig: AIVSAI.checkSignature(cfg), at: Date.now(), ...extra });
  const failed = (err, prior = []) =>
    result({ ok: false, checks: [...prior, { status: "fail", text: describeError(err, cfg) }] });

  // 1. What the backend reveals about the model (version, text length, labels, ...)
  let inspected = { info: {}, notes: [] };
  try {
    if (backend.inspect) inspected = await backend.inspect(cfg);
  } catch (err) {
    return failed(err);
  }
  const info = { ...inspected.info };
  const notes = inspected.notes.map((text) => ({ status: "info", text }));
  if (info.languages && !info.languages.some((l) => /^en\b/i.test(l))) {
    notes.push({ status: "warn", text: `Model lists no English (${info.languages.join(", ")}) – the reference set is English.` });
  }
  // Two classes, AI label open (LABEL_0/LABEL_1): assume the second first, decide below by direction
  const open = inspected.labels && !info.aiLabel;
  if (open) info.aiLabel = inspected.labels[1];

  // 2. Score the reference set - with the information from step 1, as if the check were already saved
  const probe = { ...cfg, modelChecks: { ...cfg.modelChecks, [cfg.provider]: result({ ok: true, info }) } };
  const texts = set.map((r) => r.text.slice(0, AIVSAI.maxChars(probe)));
  let scores = [];
  let ms = 0;
  try {
    // Warm-up: may load the model first, does not count towards latency
    await backend.score(texts.slice(0, 1), probe, { lang: "en" });
    for (const batch of batches(texts)) {
      const started = performance.now();
      scores.push(...(await backend.score(batch, probe, { lang: "en" })));
      ms += performance.now() - started;
    }
  } catch (err) {
    return failed(err, notes);
  }

  const isAi = set.map((r) => r.ai);
  if (open) {
    const [human, ai] = [false, true].map((l) => scores.filter((s, i) => isAi[i] === l && typeof s === "number"));
    if (human.length && ai.length && mean(ai) < mean(human)) {
      info.aiLabel = inspected.labels[0];
      scores = scores.map((s) => (typeof s === "number" ? 1 - s : s));
    }
    notes.push({ status: "info", text: `AI label "${info.aiLabel}" determined from the reference set (${inspected.labels.join(", ")}).` });
  }

  const msPerText = ms / texts.length;
  // Actual word count of the (possibly truncated to maxChars) texts - can be below the `words`
  // stored in the set if the backend specifies a small maxChars
  const words = texts.map((t) => (t.match(/\S+/g) || []).length);
  const verdict = assess(scores, isAi, { msPerText, suggestedThresholds: info.suggestedThresholds, words });
  delete info.suggestedThresholds; // now contained in thresholds
  // reliableWords/shortRedFrom: only add if the backend specifies nothing itself (providers.js, /v1/info)
  if (info.reliableWords === undefined && verdict.reliableWords !== undefined) info.reliableWords = verdict.reliableWords;
  if (info.shortRedFrom === undefined && typeof verdict.shortRedFrom === "number") info.shortRedFrom = verdict.shortRedFrom;
  return result({
    ok: verdict.ok,
    info,
    thresholds: verdict.thresholds,
    auroc: verdict.auroc,
    msPerText,
    checks: [...notes, ...verdict.checks]
  });
}
