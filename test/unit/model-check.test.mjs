// „Modell prüfen“ (extension/bg/model-check.js): Statistik auf dem Referenzset, Urteil und der ganze Ablauf
// gegen ein gemocktes Backend (eigener Server mit /v1/info, Hugging Face mit LABEL_0/LABEL_1).
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

globalThis.AIVSAI_BLOCKLIST = { domains: "" };
await import("../../extension/models.js");
await import("../../extension/config.js");
const { AUROC_MIN, AUROC_WARN, assess, auroc, checkModel, scanHint, suggestShortRedFrom, suggestThresholds } = await import(
  "../../extension/bg/model-check.js"
);
const { REFERENCE_SET } = await import("../../extension/bg/reference-set.js");

const realFetch = globalThis.fetch;
afterEach(() => (globalThis.fetch = realFetch));

// Label eines (ggf. auf maxChars gekürzten) Referenztexts
const aiOf = (t) => REFERENCE_SET.find((r) => r.text.startsWith(t)).ai;

// Synthetisches Set fürs Testen von assess() (unabhängig von der tatsächlichen Größe/Zusammensetzung
// des echten Referenzsets, die sich mit training/build_reference_set.py ändern kann): 20 Mensch + 20 KI
const SAMPLE_AI = [...Array(20).fill(false), ...Array(20).fill(true)];
// Scores fürs Sample-Set: KI-Texte `ai`, Mensch-Texte `human` (je als Funktion des Index in der Klasse)
const scoresFor = (human, ai) => {
  const n = { true: 0, false: 0 };
  return SAMPLE_AI.map((a) => (a ? ai : human)(n[a]++));
};

describe("Referenzset", () => {
  it("Mensch/KI balanciert, mehrere Domänen/Generatoren, kurze und lange Absätze getrennt (words < 120 / >= 120)", () => {
    const human = REFERENCE_SET.filter((r) => !r.ai);
    const ai = REFERENCE_SET.filter((r) => r.ai);
    assert.equal(human.length, ai.length, "Mensch/KI unbalanciert");
    assert.ok(REFERENCE_SET.length >= 100 && REFERENCE_SET.length <= 150, REFERENCE_SET.length);
    assert.ok(new Set(REFERENCE_SET.map((r) => r.domain)).size >= 6, "mind. sechs Domänen erwartet");
    assert.ok(new Set(ai.map((r) => r.generator)).size >= 2, "mind. zwei KI-Generatoren erwartet");
    for (const r of REFERENCE_SET) {
      assert.equal(typeof r.words, "number", r.text.slice(0, 40));
      assert.ok(r.words >= 40, r.words);
    }
    const short = REFERENCE_SET.filter((r) => r.words < 120);
    const long = REFERENCE_SET.filter((r) => r.words >= 120);
    assert.ok(short.length >= 20 && long.length >= 20, `kurz=${short.length} lang=${long.length}`);
    // HC3-Artefakt entfernt (Leerzeichen vor Satzzeichen), sonst wäre das Set per Abkürzung lösbar
    assert.ok(!REFERENCE_SET.some((r) => / [.,!?]/.test(r.text)));
  });
});

describe("Statistik", () => {
  it("auroc: 1 = perfekt getrennt, 0.5 = Gleichstand, 0 = vertauscht", () => {
    assert.equal(auroc([0.1, 0.2], [0.8, 0.9]), 1);
    assert.equal(auroc([0.5, 0.5], [0.5, 0.5]), 0.5);
    assert.equal(auroc([0.8, 0.9], [0.1, 0.2]), 0);
    assert.equal(auroc([0.1, 0.6], [0.5, 0.9]), 0.75);
  });

  it("suggestThresholds: rot knapp über dem höchsten Mensch-Text, gelb ab dem oberen Quartil", () => {
    // desklib auf dem Referenzset (training/build_reference_set.py --check)
    const desklib = [0, 0, 0, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.03, 0.06, 0.06, 0.07, 0.09, 0.22, 0.27, 0.3, 0.44, 0.48, 0.58];
    assert.deepEqual(suggestThresholds(desklib), { yellowFrom: 0.22, redFrom: 0.59 });
    // Grenzen der Regler, gelb immer unter rot
    assert.deepEqual(suggestThresholds([0.99, 0.995]), { yellowFrom: 0.98, redFrom: 0.99 });
    assert.deepEqual(suggestThresholds([0, 0]), { yellowFrom: 0.05, redFrom: 0.06 });
  });

  it("scanHint nach Latenz", () => {
    assert.match(scanHint(50), /automatische/);
    assert.match(scanHint(800), /Nur Absätze in der Nähe/);
    assert.match(scanHint(5000), /Nur auf Knopfdruck/);
  });
});

describe("assess", () => {
  const opts = { msPerText: 120 };
  const status = (r) => r.checks.map((c) => c.status);

  it("gut getrenntes Modell besteht, mit Ampel und Latenz", () => {
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, opts);
    assert.equal(r.ok, true);
    assert.equal(r.auroc, 1);
    assert.deepEqual(status(r), ["ok", "ok", "ok", "info", "info"]);
    assert.deepEqual(r.thresholds, { yellowFrom: 0.35, redFrom: 0.49 });
    assert.match(r.checks[3].text, /aus den Scores.*20 von 20 KI-Texten, 0 von 20 Mensch-Texten/);
    assert.match(r.checks[4].text, /~120 ms pro Text/);
  });

  it("Vorschlag des Servers geht vor", () => {
    const suggested = { yellowFrom: 0.4, redFrom: 0.8 };
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, suggestedThresholds: suggested });
    assert.equal(r.thresholds, suggested);
    assert.match(r.checks[3].text, /Vorschlag des Servers/);
  });

  it("Form: fehlende oder ungültige Werte -> abgelehnt", () => {
    const r = assess(scoresFor(() => 0.1, (i) => (i < 3 ? null : 0.9)), SAMPLE_AI, opts);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].text, /^3 von 40 Antworten/);
  });

  it("Richtung: vertauschte Labels -> abgelehnt mit Hinweis", () => {
    const r = assess(scoresFor(() => 0.9, () => 0.1), SAMPLE_AI, opts);
    assert.equal(r.ok, false);
    assert.deepEqual(status(r), ["ok", "fail"]);
    assert.match(r.checks[1].text, /P\(Mensch\) statt P\(KI\)/);
  });

  it(`Trennschärfe: unter ${AUROC_WARN} Warnung, unter ${AUROC_MIN} abgelehnt`, () => {
    // Mensch 0..0.95, KI gleich verteilt, aber leicht höher -> AUROC zwischen den Grenzen
    const weak = assess(scoresFor((i) => i / 20, (i) => (i + 5) / 20), SAMPLE_AI, opts);
    assert.ok(weak.auroc >= AUROC_MIN && weak.auroc < AUROC_WARN, String(weak.auroc));
    assert.equal(weak.ok, true);
    assert.equal(weak.checks[2].status, "warn");

    const coin = assess(scoresFor((i) => i / 20, (i) => (i + 1) / 20), SAMPLE_AI, opts);
    assert.ok(coin.auroc < AUROC_MIN, String(coin.auroc));
    assert.equal(coin.ok, false);
    assert.equal(coin.checks[2].status, "fail");
  });

  it("mit `words`: genug kurze Texte je Klasse -> reliableWords gesetzt, eigene Kurztext-Meldung", () => {
    const words = SAMPLE_AI.map(() => 50); // alle Texte gelten als kurz (< 120 Wörter)
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, words });
    assert.equal(r.reliableWords, 120);
    assert.match(r.checks.at(-1).text, /Kurze Absätze \(< 120 Wörter/);
  });

  it("mit `words`: zu wenige kurze KI-Texte -> reliableWords/shortRedFrom bleiben unbestimmt", () => {
    const words = SAMPLE_AI.map((_, i) => (i < 5 ? 50 : 200)); // nur 5 kurze Mensch-Texte, keine kurzen KI-Texte
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, words });
    assert.equal(r.reliableWords, undefined);
    assert.equal(r.shortRedFrom, undefined);
    assert.match(r.checks.at(-1).text, /Zu wenige kurze Referenztexte/);
  });
});

describe("suggestShortRedFrom", () => {
  it("Schwelle knapp über dem höchsten kurzen Mensch-Text, wenn sie noch genug KI-Texte erkennt", () => {
    assert.equal(suggestShortRedFrom([0.1, 0.2, 0.3], [0.5, 0.6, 0.9], 0.2), 0.31);
  });

  it("null, wenn die Schwelle kaum noch kurze KI-Texte erkennt (< 30 %)", () => {
    assert.equal(suggestShortRedFrom([0.1, 0.2, 0.8], [0.3, 0.4, 0.5], 0.2), null);
  });

  it("nie lockerer als die lange Rot-Schwelle", () => {
    assert.equal(suggestShortRedFrom([0.01, 0.02], [0.9, 0.95], 0.8), 0.8);
  });
});

describe("checkModel", () => {
  const custom = { ...AIVSAI.DEFAULTS, provider: "custom", customUrl: "https://s.example/v1/score", customApiKey: "k" };

  // Fake-Server: /v1/info wie angegeben, /v1/score nach Label des Referenztexts
  function fakeServer({ info = { version: "v9" }, score = (ai) => (ai ? 0.9 : 0.1) } = {}) {
    const log = { info: [], batches: [] };
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("/info")) {
        log.info.push({ url, auth: init.headers.Authorization });
        return info ? Response.json(info) : new Response("", { status: 404 });
      }
      const body = JSON.parse(init.body);
      log.batches.push(body);
      return Response.json({ scores: body.texts.map((t) => score(aiOf(t))) });
    };
    return log;
  }

  it("eigener Server: Info, Aufwärmen, Batches wie im Betrieb, Englisch, Ergebnis zum Speichern", async () => {
    const log = fakeServer({ info: { version: "v9", maxChars: 1000, suggestedThresholds: { yellowFrom: 0.3, redFrom: 0.7 } } });
    const r = await checkModel(custom);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.equal(r.sig, AIVSAI.checkSignature(custom));
    // reliableWords/shortRedFrom: lokal aus dem Referenzset ergänzt, weil der Server selbst nichts angibt
    assert.deepEqual(r.info, { version: "v9", maxChars: 1000, reliableWords: 120, shortRedFrom: 0.7 });
    assert.deepEqual(r.thresholds, { yellowFrom: 0.3, redFrom: 0.7 });
    assert.equal(r.auroc, 1);
    assert.equal(typeof r.msPerText, "number");
    assert.deepEqual(log.info, [{ url: "https://s.example/v1/info", auth: "Bearer k" }]);

    const [warmup, ...batches] = log.batches;
    assert.equal(warmup.texts.length, 1);
    assert.equal(batches.flatMap((b) => b.texts).length, REFERENCE_SET.length);
    for (const b of log.batches) {
      assert.equal(b.lang, "en");
      assert.ok(b.texts.join("").length <= 2500);
      assert.ok(b.texts.every((t) => t.length <= 1000)); // maxChars aus /v1/info
    }
    // Das Ergebnis macht die Version zum Teil des Modellschlüssels
    assert.equal(AIVSAI.modelKey({ ...custom, modelChecks: { custom: r } }), "custom:https://s.example/v1/score@v9");
  });

  it("ohne /v1/info: Hinweis, Ampel aus den Scores", async () => {
    fakeServer({ info: null });
    const r = await checkModel(custom);
    assert.equal(r.ok, true);
    assert.deepEqual(r.info, { reliableWords: 120, shortRedFrom: 0.11 });
    assert.match(r.checks[0].text, /Kein \/v1\/info/);
    assert.deepEqual(r.thresholds, { yellowFrom: 0.1, redFrom: 0.11 });
  });

  it("Modell ohne Englisch: Warnung", async () => {
    fakeServer({ info: { version: "1", languages: ["de"] } });
    const r = await checkModel(custom);
    assert.ok(r.checks.some((c) => c.status === "warn" && /kein Englisch/.test(c.text)));
  });

  it("P(Mensch) statt P(KI): abgelehnt", async () => {
    fakeServer({ score: (ai) => (ai ? 0.2 : 0.8) });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.equal(r.thresholds, undefined);
  });

  it("Logits statt Wahrscheinlichkeiten: abgelehnt (Form)", async () => {
    fakeServer({ score: (ai) => (ai ? 3.2 : -2.1) });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.match(r.checks.at(-1).text, new RegExp(`^${REFERENCE_SET.length} von ${REFERENCE_SET.length} Antworten fehlen`));
  });

  it("Backend-Fehler: abgelehnt mit verständlicher Meldung", async () => {
    globalThis.fetch = async (url) =>
      String(url).includes("/info") ? Response.json({ version: "1" }) : Response.json({ detail: "kaputt" }, { status: 500 });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.equal(r.checks.at(-1).text, "HTTP 500: kaputt");

    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.match((await checkModel(custom)).checks[0].text, /nicht erreichbar/);
  });

  it("Hugging Face mit LABEL_0/LABEL_1: KI-Label per Referenzset bestimmt", async () => {
    const hf = { ...AIVSAI.DEFAULTS, provider: "huggingface", hfModel: "org/m", hfToken: "hf_x" };
    // LABEL_0 ist hier die KI-Klasse - entgegen der üblichen Konvention
    globalThis.fetch = async (url, init) => {
      if (url.endsWith("/api/models/org/m")) return Response.json({ sha: "abcdef0123", pipeline_tag: "text-classification" });
      if (url.endsWith("/config.json")) return Response.json({ id2label: { 0: "LABEL_0", 1: "LABEL_1" } });
      const { inputs } = JSON.parse(init.body);
      return Response.json(
        inputs.map((t) => {
          const p = aiOf(t) ? 0.85 : 0.2;
          return [{ label: "LABEL_0", score: p }, { label: "LABEL_1", score: 1 - p }];
        })
      );
    };
    const r = await checkModel(hf);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.info, { name: "org/m", version: "abcdef0", aiLabel: "LABEL_0", reliableWords: 120, shortRedFrom: 0.21 });
    assert.ok(r.checks.some((c) => /„LABEL_0“ anhand des Referenzsets/.test(c.text)));
    assert.deepEqual(r.thresholds, { yellowFrom: 0.2, redFrom: 0.21 });
  });

  it("Hugging Face: kein Klassifikator -> abgelehnt, ohne Texte zu schicken", async () => {
    const hf = { ...AIVSAI.DEFAULTS, provider: "huggingface", hfModel: "gpt2" };
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ sha: "1", pipeline_tag: "text-generation" });
    };
    const r = await checkModel(hf);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].text, /Kein Textklassifikations-Modell/);
    assert.equal(posts, 0);
  });
});
