// „Modell prüfen“ (Einstellungen, Pflicht für eigene Modelle): Ein eigenes Modell ist ein binärer
// Klassifikator, also lässt sich vor dem Einsatz prüfen, ob es den Rahmen erfüllt. Dazu geht das
// Referenzset (reference-set.js, ~60 Mensch- und KI-Texte, kurze/lange Absätze getrennt) ans Backend:
//   Form         pro Text eine Zahl in 0..1, Antwort vor dem Timeout
//   Richtung     KI-Texte im Mittel höher als Mensch-Texte (sonst Label vertauscht)
//   Trennschärfe AUROC, unter AUROC_WARN Warnung, unter AUROC_MIN abgelehnt
//   Schwellen    Startwerte für die Ampel (Vorschlag des Servers oder aus den Scores)
//   Kurztext     eigene Rot-Schwelle unter RELIABLE_WORDS, wenn das Referenzset das hergibt (sonst nie rot)
//   Latenz       ms pro Text -> Empfehlung für den Scan-Modus
// Dazu, was das Backend selbst über das Modell sagt (inspect in providers.js: /v1/info bzw. Hub-Metadaten).
import "../config.js";
import { backendFor, describeError } from "./providers.js";
import { REFERENCE_SET } from "./reference-set.js";

export const AUROC_MIN = 0.6; // Laya zero-shot lag bei 0.549 (training/EVAL_RESULTS.md)
export const AUROC_WARN = 0.8;
const BATCH_CHARS = 2500; // wie die Batches aus content.js
const RELIABLE_WORDS = 120; // wie config.js RELIABLE_WORDS/extension/models.js - Referenzset trennt genau hier
const MIN_BUCKET = 15; // Mindestzahl Mensch/KI-Texte je Bucket, um daraus eine Kurztext-Schwelle abzuleiten

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pct = (p) => `${Math.round(p * 100)} %`;
const up2 = (x) => Math.ceil(x * 100 - 1e-9) / 100;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// Anteil der (KI, Mensch)-Paare, in denen der KI-Text höher liegt; Gleichstand zählt halb
export function auroc(human, ai) {
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a > h ? 1 : a === h ? 0.5 : 0;
  return wins / (ai.length * human.length);
}

// Ampel aus den Scores, vorsichtig: Rot knapp über dem höchsten Mensch-Text (auf dem Referenzset wird kein
// Mensch-Text rot - der größte Schaden ist Rot auf einem menschlichen Text), Gelb ab dem oberen Quartil
// der Mensch-Texte. Grenzen wie die Regler in options.html.
export function suggestThresholds(human) {
  const sorted = [...human].sort((a, b) => a - b);
  const redFrom = clamp(up2(sorted.at(-1) + 0.01), 0.06, 0.99);
  const q75 = sorted[Math.floor(0.75 * (sorted.length - 1))];
  return { yellowFrom: clamp(up2(q75), 0.05, Math.round((redFrom - 0.01) * 100) / 100), redFrom };
}

// Eigene Rot-Schwelle für kurze Absätze (< RELIABLE_WORDS), nach demselben Prinzip wie suggestThresholds
// (knapp über dem höchsten kurzen Mensch-Text), aber nie lockerer als die lange Schwelle. Nur sinnvoll, wenn
// sie noch einen nennenswerten Teil der kurzen KI-Texte erkennt (sonst wie TMR in models.js: nie rot, `null`).
export function suggestShortRedFrom(shortHuman, shortAi, longRedFrom) {
  const sorted = [...shortHuman].sort((a, b) => a - b);
  const candidate = clamp(up2(sorted.at(-1) + 0.01), longRedFrom, 0.99);
  const caught = shortAi.filter((s) => s >= candidate).length / shortAi.length;
  return caught >= 0.3 ? candidate : null;
}

export function scanHint(msPerText) {
  if (msPerText < 300) return "schnell genug fürs automatische Scannen";
  if (msPerText < 2000) return "empfohlen: automatisch nur auf ausgewählten Seiten, mit „Nur Absätze in der Nähe“";
  return "empfohlen: „Nur auf Knopfdruck“";
}

/**
 * Bewertet die Antworten auf das Referenzset.
 * @param {(number|null)[]} scores  pro Referenztext
 * @param {boolean[]} isAi          Label pro Referenztext
 * @param {{msPerText: number, suggestedThresholds?: {yellowFrom: number, redFrom: number}, words?: number[]}} opts
 *   `words` (optional): tatsächliche Wortzahl je (ggf. gekürztem) Referenztext - wenn vorhanden, wird zusätzlich
 *   eine Kurztext-Schwelle vorgeschlagen (reliableWords/shortRedFrom).
 * @returns {{ok: boolean, checks: {status: "ok"|"warn"|"fail"|"info", text: string}[], auroc?: number,
 *   thresholds?: {yellowFrom: number, redFrom: number}, reliableWords?: number, shortRedFrom?: number|null}}
 */
export function assess(scores, isAi, { msPerText, suggestedThresholds, words }) {
  const checks = [];
  const add = (status, text) => checks.push({ status, text });
  const done = (extra = {}) => ({ ok: !checks.some((c) => c.status === "fail"), checks, ...extra });

  const invalid = scores.filter((s) => typeof s !== "number").length;
  if (invalid) {
    add("fail", `${invalid} von ${scores.length} Antworten fehlen oder liegen nicht in 0..1 – erwartet wird P(KI) pro Text.`);
    return done();
  }
  add("ok", `Form: ${scores.length} Scores in 0..1.`);

  const human = scores.filter((_, i) => !isAi[i]);
  const ai = scores.filter((_, i) => isAi[i]);
  const [meanHuman, meanAi] = [mean(human), mean(ai)];
  if (meanAi <= meanHuman) {
    add(
      "fail",
      `Richtung: KI-Texte im Mittel ${pct(meanAi)}, Mensch-Texte ${pct(meanHuman)} – liefert das Modell P(Mensch) ` +
        "statt P(KI)? (typisch: LABEL_0/LABEL_1 vertauscht)"
    );
    return done();
  }
  add("ok", `Richtung: KI-Texte im Mittel ${pct(meanAi)}, Mensch-Texte ${pct(meanHuman)}.`);

  const area = auroc(human, ai);
  const areaText = `Trennschärfe: AUROC ${area.toFixed(2)} auf ${scores.length} Referenztexten`;
  if (area < AUROC_MIN) add("fail", `${areaText} – zu gering (mindestens ${AUROC_MIN}), kaum besser als Raten.`);
  else if (area < AUROC_WARN) add("warn", `${areaText} – schwach, rechne mit vielen Fehlalarmen (gut: ab ${AUROC_WARN}).`);
  else add("ok", `${areaText}.`);

  const thresholds = suggestedThresholds ?? suggestThresholds(human);
  const redAi = ai.filter((s) => s >= thresholds.redFrom).length;
  const redHuman = human.filter((s) => s >= thresholds.redFrom).length;
  add(
    "info",
    `Ampel: gelb ab ${pct(thresholds.yellowFrom)}, rot ab ${pct(thresholds.redFrom)} ` +
      `(${suggestedThresholds ? "Vorschlag des Servers" : "aus den Scores"}). Auf dem Referenzset rot: ` +
      `${redAi} von ${ai.length} KI-Texten, ${redHuman} von ${human.length} Mensch-Texten.`
  );

  add("info", `Latenz: ~${Math.round(msPerText)} ms pro Text – ${scanHint(msPerText)}.`);

  // Kurztext-Schwelle: nur, wenn das Referenzset genug kurze Texte je Klasse hat (MIN_BUCKET) - sonst bleibt
  // reliableWords beim Standard (RELIABLE_WORDS) und shortRedFrom unbestimmt (config.js: dann nie rot).
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
          ? `Kurze Absätze (< ${RELIABLE_WORDS} Wörter, ${shortHuman.length} Mensch-/${shortAi.length} KI-Texte im Set): ` +
              "keine eigene Rot-Schwelle vorgeschlagen – zu wenig Trennschärfe, bleibt „unsicher“ statt rot."
          : `Kurze Absätze (< ${RELIABLE_WORDS} Wörter): eigene Rot-Schwelle ${pct(shortRedFrom)} vorgeschlagen ` +
              `(erkennt ${shortAi.filter((s) => s >= shortRedFrom).length} von ${shortAi.length} kurzen KI-Texten).`
      );
    } else {
      add(
        "info",
        `Zu wenige kurze Referenztexte (${shortHuman.length} Mensch-/${shortAi.length} KI-Texte) für eine eigene ` +
          `Kurztext-Schwelle – reliableWords bleibt beim Standard (${RELIABLE_WORDS}).`
      );
    }
  }

  return done({ auroc: area, meanHuman, meanAi, thresholds, reliableWords, shortRedFrom });
}

// Referenztexte in Batches wie im Betrieb (content.js schickt bis BATCH_CHARS Zeichen pro Anfrage)
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
 * Prüft das Modell der (ggf. noch nicht gespeicherten) Einstellungen `cfg`.
 * @returns Ergebnis für AIVSAI.DEFAULTS.modelChecks plus `checks` zur Anzeige
 */
export async function checkModel(cfg, set = REFERENCE_SET) {
  const backend = backendFor(cfg);
  const result = (extra) => ({ sig: AIVSAI.checkSignature(cfg), at: Date.now(), ...extra });
  const failed = (err, prior = []) =>
    result({ ok: false, checks: [...prior, { status: "fail", text: describeError(err, cfg) }] });

  // 1. Was das Backend über das Modell verrät (Version, Textlänge, Labels, ...)
  let inspected = { info: {}, notes: [] };
  try {
    if (backend.inspect) inspected = await backend.inspect(cfg);
  } catch (err) {
    return failed(err);
  }
  const info = { ...inspected.info };
  const notes = inspected.notes.map((text) => ({ status: "info", text }));
  if (info.languages && !info.languages.some((l) => /^en\b/i.test(l))) {
    notes.push({ status: "warn", text: `Modell nennt kein Englisch (${info.languages.join(", ")}) – das Referenzset ist englisch.` });
  }
  // Zwei Klassen, KI-Label offen (LABEL_0/LABEL_1): erst die zweite annehmen, unten per Richtung entscheiden
  const open = inspected.labels && !info.aiLabel;
  if (open) info.aiLabel = inspected.labels[1];

  // 2. Referenzset bewerten - mit den Angaben aus Schritt 1, als wäre die Prüfung schon gespeichert
  const probe = { ...cfg, modelChecks: { ...cfg.modelChecks, [cfg.provider]: result({ ok: true, info }) } };
  const texts = set.map((r) => r.text.slice(0, AIVSAI.maxChars(probe)));
  let scores = [];
  let ms = 0;
  try {
    // Aufwärmen: lädt ggf. erst das Modell, zählt nicht zur Latenz
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
    notes.push({ status: "info", text: `KI-Label „${info.aiLabel}“ anhand des Referenzsets bestimmt (${inspected.labels.join(", ")}).` });
  }

  const msPerText = ms / texts.length;
  // Tatsächliche Wortzahl der (ggf. auf maxChars gekürzten) Texte - kann unter dem im Set hinterlegten
  // `words` liegen, wenn das Backend eine kleine maxChars angibt
  const words = texts.map((t) => (t.match(/\S+/g) || []).length);
  const verdict = assess(scores, isAi, { msPerText, suggestedThresholds: info.suggestedThresholds, words });
  delete info.suggestedThresholds; // steckt jetzt in thresholds
  // reliableWords/shortRedFrom: nur ergänzen, wenn das Backend selbst nichts angibt (providers.js, /v1/info)
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
