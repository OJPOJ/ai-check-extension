// "Check model" (extension/bg/model-check.js): statistics on the reference set, verdict and the whole flow
// against a mocked backend (custom server with /v1/info, Hugging Face with LABEL_0/LABEL_1).
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

// Label of a (possibly truncated to maxChars) reference text
const aiOf = (t) => REFERENCE_SET.find((r) => r.text.startsWith(t)).ai;

// Synthetic set for testing assess() (independent of the actual size/composition
// of the real reference set, which can change with training/build_reference_set.py): 20 human + 20 AI
const SAMPLE_AI = [...Array(20).fill(false), ...Array(20).fill(true)];
// Scores for the sample set: AI texts `ai`, human texts `human` (each as a function of the index within the class)
const scoresFor = (human, ai) => {
  const n = { true: 0, false: 0 };
  return SAMPLE_AI.map((a) => (a ? ai : human)(n[a]++));
};

describe("reference set", () => {
  it("human/AI balanced, several domains/generators, short and long paragraphs separated (words < 120 / >= 120)", () => {
    const human = REFERENCE_SET.filter((r) => !r.ai);
    const ai = REFERENCE_SET.filter((r) => r.ai);
    assert.equal(human.length, ai.length, "human/AI unbalanced");
    assert.ok(REFERENCE_SET.length >= 100 && REFERENCE_SET.length <= 150, REFERENCE_SET.length);
    assert.ok(new Set(REFERENCE_SET.map((r) => r.domain)).size >= 6, "at least six domains expected");
    assert.ok(new Set(ai.map((r) => r.generator)).size >= 2, "at least two AI generators expected");
    for (const r of REFERENCE_SET) {
      assert.equal(typeof r.words, "number", r.text.slice(0, 40));
      assert.ok(r.words >= 40, r.words);
    }
    const short = REFERENCE_SET.filter((r) => r.words < 120);
    const long = REFERENCE_SET.filter((r) => r.words >= 120);
    assert.ok(short.length >= 20 && long.length >= 20, `short=${short.length} long=${long.length}`);
    // HC3 artifact removed (space before punctuation), otherwise the set would be solvable by shortcut
    assert.ok(!REFERENCE_SET.some((r) => / [.,!?]/.test(r.text)));
  });
});

describe("statistics", () => {
  it("auroc: 1 = perfectly separated, 0.5 = tie, 0 = swapped", () => {
    assert.equal(auroc([0.1, 0.2], [0.8, 0.9]), 1);
    assert.equal(auroc([0.5, 0.5], [0.5, 0.5]), 0.5);
    assert.equal(auroc([0.8, 0.9], [0.1, 0.2]), 0);
    assert.equal(auroc([0.1, 0.6], [0.5, 0.9]), 0.75);
  });

  it("suggestThresholds: red just above the highest human text, yellow from the upper quartile", () => {
    // desklib on the reference set (training/build_reference_set.py --check)
    const desklib = [0, 0, 0, 0.01, 0.01, 0.02, 0.02, 0.02, 0.02, 0.03, 0.06, 0.06, 0.07, 0.09, 0.22, 0.27, 0.3, 0.44, 0.48, 0.58];
    assert.deepEqual(suggestThresholds(desklib), { yellowFrom: 0.22, redFrom: 0.59 });
    // slider limits, yellow always below red
    assert.deepEqual(suggestThresholds([0.99, 0.995]), { yellowFrom: 0.98, redFrom: 0.99 });
    assert.deepEqual(suggestThresholds([0, 0]), { yellowFrom: 0.05, redFrom: 0.06 });
  });

  it("scanHint by latency", () => {
    assert.match(scanHint(50), /automatic/);
    assert.match(scanHint(800), /Only paragraphs nearby/);
    assert.match(scanHint(5000), /Only on button press/);
  });
});

describe("assess", () => {
  const opts = { msPerText: 120 };
  const status = (r) => r.checks.map((c) => c.status);

  it("well-separated model passes, with traffic light and latency", () => {
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, opts);
    assert.equal(r.ok, true);
    assert.equal(r.auroc, 1);
    assert.deepEqual(status(r), ["ok", "ok", "ok", "info", "info"]);
    assert.deepEqual(r.thresholds, { yellowFrom: 0.35, redFrom: 0.49 });
    assert.match(r.checks[3].text, /from the scores.*20 of 20 AI texts, 0 of 20 human texts/);
    assert.match(r.checks[4].text, /~120 ms per text/);
  });

  it("the server's suggestion takes precedence", () => {
    const suggested = { yellowFrom: 0.4, redFrom: 0.8 };
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, suggestedThresholds: suggested });
    assert.equal(r.thresholds, suggested);
    assert.match(r.checks[3].text, /suggested by the server/);
  });

  it("shape: missing or invalid values -> rejected", () => {
    const r = assess(scoresFor(() => 0.1, (i) => (i < 3 ? null : 0.9)), SAMPLE_AI, opts);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].text, /^3 of 40 responses/);
  });

  it("direction: swapped labels -> rejected with a hint", () => {
    const r = assess(scoresFor(() => 0.9, () => 0.1), SAMPLE_AI, opts);
    assert.equal(r.ok, false);
    assert.deepEqual(status(r), ["ok", "fail"]);
    assert.match(r.checks[1].text, /P\(human\) instead of P\(AI\)/);
  });

  it(`separation: warning below ${AUROC_WARN}, rejected below ${AUROC_MIN}`, () => {
    // human 0..0.95, AI equally distributed, but slightly higher -> AUROC between the limits
    const weak = assess(scoresFor((i) => i / 20, (i) => (i + 5) / 20), SAMPLE_AI, opts);
    assert.ok(weak.auroc >= AUROC_MIN && weak.auroc < AUROC_WARN, String(weak.auroc));
    assert.equal(weak.ok, true);
    assert.equal(weak.checks[2].status, "warn");

    const coin = assess(scoresFor((i) => i / 20, (i) => (i + 1) / 20), SAMPLE_AI, opts);
    assert.ok(coin.auroc < AUROC_MIN, String(coin.auroc));
    assert.equal(coin.ok, false);
    assert.equal(coin.checks[2].status, "fail");
  });

  it("with `words`: enough short texts per class -> reliableWords set, own short-text message", () => {
    const words = SAMPLE_AI.map(() => 50); // all texts count as short (< 120 words)
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, words });
    assert.equal(r.reliableWords, 120);
    assert.match(r.checks.at(-1).text, /Short paragraphs \(< 120 words/);
  });

  it("with `words`: too few short AI texts -> reliableWords/shortRedFrom stay undetermined", () => {
    const words = SAMPLE_AI.map((_, i) => (i < 5 ? 50 : 200)); // only 5 short human texts, no short AI texts
    const r = assess(scoresFor((i) => i / 40, (i) => 0.6 + i / 100), SAMPLE_AI, { ...opts, words });
    assert.equal(r.reliableWords, undefined);
    assert.equal(r.shortRedFrom, undefined);
    assert.match(r.checks.at(-1).text, /Too few short reference texts/);
  });
});

describe("suggestShortRedFrom", () => {
  it("threshold just above the highest short human text, if it still detects enough AI texts", () => {
    assert.equal(suggestShortRedFrom([0.1, 0.2, 0.3], [0.5, 0.6, 0.9], 0.2), 0.31);
  });

  it("null if the threshold hardly detects short AI texts any more (< 30%)", () => {
    assert.equal(suggestShortRedFrom([0.1, 0.2, 0.8], [0.3, 0.4, 0.5], 0.2), null);
  });

  it("never looser than the long red threshold", () => {
    assert.equal(suggestShortRedFrom([0.01, 0.02], [0.9, 0.95], 0.8), 0.8);
  });
});

describe("checkModel", () => {
  const custom = { ...AIVSAI.DEFAULTS, provider: "custom", customUrl: "https://s.example/v1/score", customApiKey: "k" };

  // Fake server: /v1/info as given, /v1/score by label of the reference text
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

  it("custom server: info, warm-up, batches as in operation, English, result to store", async () => {
    const log = fakeServer({ info: { version: "v9", maxChars: 1000, suggestedThresholds: { yellowFrom: 0.3, redFrom: 0.7 } } });
    const r = await checkModel(custom);
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.equal(r.sig, AIVSAI.checkSignature(custom));
    // reliableWords/shortRedFrom: added locally from the reference set because the server specifies nothing itself
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
      assert.ok(b.texts.every((t) => t.length <= 1000)); // maxChars from /v1/info
    }
    // The result makes the version part of the model key
    assert.equal(AIVSAI.modelKey({ ...custom, modelChecks: { custom: r } }), "custom:https://s.example/v1/score@v9");
  });

  it("without /v1/info: note, traffic light from the scores", async () => {
    fakeServer({ info: null });
    const r = await checkModel(custom);
    assert.equal(r.ok, true);
    assert.deepEqual(r.info, { reliableWords: 120, shortRedFrom: 0.11 });
    assert.match(r.checks[0].text, /No \/v1\/info/);
    assert.deepEqual(r.thresholds, { yellowFrom: 0.1, redFrom: 0.11 });
  });

  it("model without English: warning", async () => {
    fakeServer({ info: { version: "1", languages: ["de"] } });
    const r = await checkModel(custom);
    assert.ok(r.checks.some((c) => c.status === "warn" && /no English/.test(c.text)));
  });

  it("P(human) instead of P(AI): rejected", async () => {
    fakeServer({ score: (ai) => (ai ? 0.2 : 0.8) });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.equal(r.thresholds, undefined);
  });

  it("logits instead of probabilities: rejected (shape)", async () => {
    fakeServer({ score: (ai) => (ai ? 3.2 : -2.1) });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.match(r.checks.at(-1).text, new RegExp(`^${REFERENCE_SET.length} of ${REFERENCE_SET.length} responses are missing`));
  });

  it("backend error: rejected with an understandable message", async () => {
    globalThis.fetch = async (url) =>
      String(url).includes("/info") ? Response.json({ version: "1" }) : Response.json({ detail: "broken" }, { status: 500 });
    const r = await checkModel(custom);
    assert.equal(r.ok, false);
    assert.equal(r.checks.at(-1).text, "HTTP 500: broken");

    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.match((await checkModel(custom)).checks[0].text, /unreachable/);
  });

  it("Hugging Face with LABEL_0/LABEL_1: AI label determined via reference set", async () => {
    const hf = { ...AIVSAI.DEFAULTS, provider: "huggingface", hfModel: "org/m", hfToken: "hf_x" };
    // LABEL_0 is the AI class here - contrary to the usual convention
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
    assert.ok(r.checks.some((c) => /"LABEL_0" determined from the reference set/.test(c.text)));
    assert.deepEqual(r.thresholds, { yellowFrom: 0.2, redFrom: 0.21 });
  });

  it("Hugging Face: no classifier -> rejected, without sending texts", async () => {
    const hf = { ...AIVSAI.DEFAULTS, provider: "huggingface", hfModel: "gpt2" };
    let posts = 0;
    globalThis.fetch = async (url, init) => {
      if (init?.method === "POST") posts++;
      return Response.json({ sha: "1", pipeline_tag: "text-generation" });
    };
    const r = await checkModel(hf);
    assert.equal(r.ok, false);
    assert.match(r.checks[0].text, /Not a text classification model/);
    assert.equal(posts, 0);
  });
});
