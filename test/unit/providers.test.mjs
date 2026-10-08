// Backends from extension/bg/providers.js with mocked fetch/chrome: contract, /v1/info, response shapes of the
// Hugging Face API, Hub metadata, label mapping and error messages. The E2E tests only cover "Local" against a
// fake backend; Hugging Face with a real token stays untested (DEVELOPMENT.md, "Tests").
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKENDS, backendFor, describeError, trimSlash } from "../../extension/bg/providers.js";

globalThis.AIVSAI_BLOCKLIST = { domains: "" };
await import("../../extension/models.js");
await import("../../extension/config.js");

const realFetch = globalThis.fetch;
let calls = [];

// Next responses of the backend; each is {status?, body} (body as an object -> JSON, as a string -> raw)
function mockFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: init?.body && JSON.parse(init.body) });
    const { status = 200, body } = responses.shift();
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
});

const local = { provider: "local", localUrl: "http://127.0.0.1:8787/", localModel: "tmr" };
const custom = { provider: "custom", customUrl: "https://s.example/score", customModel: "", customApiKey: "" };
const hf = { provider: "huggingface", hfModel: "org/detector", hfToken: "hf_x", hfAiLabel: "" };

describe("trimSlash / backendFor", () => {
  it("removes only trailing slashes", () => {
    assert.equal(trimSlash("http://h:1///"), "http://h:1");
    assert.equal(trimSlash("http://h/a/b"), "http://h/a/b");
  });

  it("falls back to Local for an unknown provider", () => {
    assert.equal(backendFor({ provider: "huggingface" }), BACKENDS.huggingface);
    assert.equal(backendFor({ provider: "gone" }), BACKENDS.local);
  });

  it("there is a backend for every provider from config.js and vice versa", () => {
    assert.deepEqual(Object.keys(BACKENDS).sort(), Object.keys(globalThis.AIVSAI.PROVIDERS).sort());
  });
});

describe("Local / Custom server (contract POST {texts, model?} -> {scores})", () => {
  it("Local: /v1/score, model in the body, no Authorization header", async () => {
    mockFetch({ body: { scores: [0.1, 0.9] } });
    assert.deepEqual(await BACKENDS.local.score(["a", "b"], local), [0.1, 0.9]);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/score");
    assert.deepEqual(calls[0].body, { model: "tmr", texts: ["a", "b"] });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, undefined);
  });

  it("Custom server: URL unchanged, bearer key, no model field without a model", async () => {
    mockFetch({ body: { scores: [0.5] } });
    await BACKENDS.custom.score(["a"], { ...custom, customApiKey: "secret" });
    assert.equal(calls[0].url, "https://s.example/score");
    assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
    assert.deepEqual(calls[0].body, { texts: ["a"] });
  });

  it("non-numbers and values outside 0..1 become null (paragraph stays unscored), the rest remains", async () => {
    mockFetch({ body: { scores: [0.2, null, "0.7", -0.1, 1.5, 0, 1] } });
    const texts = ["a", "b", "c", "d", "e", "f", "g"];
    assert.deepEqual(await BACKENDS.custom.score(texts, custom), [0.2, null, null, null, null, 0, 1]);
  });

  it("lang goes along when known", async () => {
    mockFetch({ body: { scores: [0.5] } }, { body: { scores: [0.5] } });
    await BACKENDS.local.score(["a"], local, { lang: "en" });
    await BACKENDS.custom.score(["a"], custom, { lang: "de" });
    assert.deepEqual(calls[0].body, { texts: ["a"], model: "tmr", lang: "en" });
    assert.deepEqual(calls[1].body, { texts: ["a"], lang: "de" });
  });

  it("rejects responses without a matching scores array", async () => {
    for (const body of [{ scores: [0.1] }, { score: [0.1, 0.2] }, { scores: "0.1,0.2" }]) {
      mockFetch({ body });
      await assert.rejects(BACKENDS.custom.score(["a", "b"], custom), /matching 'scores' array/);
    }
  });

  it("Custom server without a URL: error instead of a request", async () => {
    mockFetch();
    await assert.rejects(async () => BACKENDS.custom.score(["a"], { ...custom, customUrl: "" }), /No server URL/);
    assert.equal(calls.length, 0);
  });

  it("HTTP errors with detail from the body (FastAPI, OpenAI style, object, not JSON)", async () => {
    const cases = [
      [{ status: 422, body: { detail: "texts missing" } }, "HTTP 422: texts missing"],
      [{ status: 401, body: { error: { message: "bad key" } } }, "HTTP 401: bad key"],
      [{ status: 400, body: { error: "broken" } }, "HTTP 400: broken"],
      [{ status: 422, body: { detail: [{ loc: ["texts"] }] } }, 'HTTP 422: [{"loc":["texts"]}]'],
      [{ status: 502, body: "<html>Bad Gateway</html>" }, "HTTP 502"]
    ];
    for (const [resp, message] of cases) {
      mockFetch(resp);
      await assert.rejects(BACKENDS.local.score(["a"], local), { message });
    }
  });
});

describe("GET /v1/info (inspect for Local / Custom server)", () => {
  const info = {
    name: "Det",
    version: "v2",
    maxChars: 1200,
    languages: ["en"],
    suggestedThresholds: { yellowFrom: 0.4, redFrom: 0.8 },
    reliableWords: 80,
    shortRedFrom: 0.97
  };

  it("Local: next to /v1/score, with the model as a parameter", async () => {
    mockFetch({ body: info });
    assert.deepEqual(await BACKENDS.local.inspect(local), { info, notes: [] });
    assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/info?model=tmr");
    assert.equal(calls[0].init.method, undefined); // GET
  });

  it("Custom server: relative to the endpoint URL, bearer key", async () => {
    mockFetch({ body: info }, { body: info });
    await BACKENDS.custom.inspect({ ...custom, customUrl: "https://s.example/api/v1/score", customApiKey: "k", customModel: "a b" });
    assert.equal(calls[0].url, "https://s.example/api/v1/info?model=a%20b");
    assert.equal(calls[0].init.headers.Authorization, "Bearer k");
    await BACKENDS.custom.inspect(custom);
    assert.equal(calls[1].url, "https://s.example/info");
  });

  it("a missing endpoint is not an error, other HTTP errors are", async () => {
    for (const status of [404, 405, 501]) {
      mockFetch({ status, body: "" });
      const r = await BACKENDS.custom.inspect(custom);
      assert.deepEqual(r.info, {});
      assert.match(r.notes[0], /No \/v1\/info/);
    }
    mockFetch({ status: 401, body: { detail: "invalid or missing API key" } });
    await assert.rejects(BACKENDS.custom.inspect(custom), /HTTP 401/);
  });

  it("discards invalid fields with a note, version as text", async () => {
    mockFetch({
      body: {
        name: 3,
        version: 7,
        maxChars: 5,
        languages: "en",
        suggestedThresholds: { yellowFrom: 0.9, redFrom: 0.5 },
        reliableWords: 2.5,
        shortRedFrom: 1.2
      }
    });
    const r = await BACKENDS.custom.inspect(custom);
    assert.deepEqual(r.info, { version: "7" });
    assert.equal(r.notes.length, 6);

    mockFetch({ body: {} });
    assert.match((await BACKENDS.custom.inspect(custom)).notes[0], /no version/);
  });
});

describe("Hugging Face", () => {
  it("Request: router URL with model, token as bearer, texts as inputs", async () => {
    mockFetch({ body: [[{ label: "Fake", score: 0.8 }, { label: "Real", score: 0.2 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.8]);
    assert.equal(calls[0].url, "https://router.huggingface.co/hf-inference/models/org/detector");
    assert.equal(calls[0].init.headers.Authorization, "Bearer hf_x");
    assert.deepEqual(calls[0].body, { inputs: ["a"] });
  });

  it("Response shapes: a list per text, single text flat, top-1 flat", async () => {
    mockFetch({ body: [[{ label: "AI", score: 0.9 }, { label: "Human", score: 0.1 }], [{ label: "Human", score: 0.7 }, { label: "AI", score: 0.3 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.9, 0.3]);

    mockFetch({ body: [{ label: "Human", score: 0.6 }, { label: "ChatGPT", score: 0.4 }] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.4]);

    mockFetch({ body: [{ label: "LABEL_1", score: 0.95 }, { label: "LABEL_0", score: 0.75 }] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.95, 0.25]);
  });

  it("automatic label detection", async () => {
    const labels = [
      ["machine-generated", 0.7], ["AI_generated", 0.7], ["gpt", 0.7], ["LLM", 0.7], ["fake", 0.7]
    ];
    for (const [label, score] of labels) {
      mockFetch({ body: [[{ label, score }, { label: "human", score: 1 - score }]] });
      assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [score], label);
    }
    // top-1 = human -> complementary probability; without top-1 nothing can be derived
    mockFetch({ body: [[{ label: "human-written", score: 0.75 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.25]);
  });

  it("manual AI label (case-insensitive) overrides the automatic detection", async () => {
    mockFetch({ body: [[{ label: "Fake", score: 0.2 }, { label: "Synthetic", score: 0.8 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], { ...hf, hfAiLabel: "synthetic" }), [0.8]);
  });

  it("single texts without an AI label become null, all without -> error with the labels seen", async () => {
    mockFetch({ body: [[{ label: "AI", score: 0.9 }], [{ label: "POSITIVE", score: 0.9 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.9, null]);

    mockFetch({ body: [[{ label: "POSITIVE", score: 0.9 }, { label: "NEGATIVE", score: 0.1 }]] });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), /model returns: POSITIVE, NEGATIVE/);
  });

  it("Errors: no model, no list, wrong count", async () => {
    mockFetch();
    await assert.rejects(BACKENDS.huggingface.score(["a"], { ...hf, hfModel: "" }), /No Hugging Face model/);
    assert.equal(calls.length, 0);

    mockFetch({ body: { error: "Model is loading" } });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), /Unexpected response/);

    mockFetch({ body: [[{ label: "AI", score: 0.9 }]] });
    await assert.rejects(BACKENDS.huggingface.score(["a", "b"], hf), /Number of results/);

    mockFetch({ status: 503, body: { error: "Model is loading" } });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), { message: "HTTP 503: Model is loading" });
  });
});

describe("Hugging Face: metadata from the Hub (inspect)", () => {
  const meta = (over = {}) => ({ body: { sha: "0123456789abcdef", pipeline_tag: "text-classification", ...over } });
  const config = (id2label) => ({ body: { id2label } });

  it("reads model info and config.json of the same revision, with token", async () => {
    mockFetch(meta(), config({ 0: "Human", 1: "AI" }));
    const r = await BACKENDS.huggingface.inspect(hf);
    assert.equal(calls[0].url, "https://huggingface.co/api/models/org/detector");
    assert.equal(calls[1].url, "https://huggingface.co/org/detector/resolve/0123456789abcdef/config.json");
    assert.equal(calls[1].init.headers.Authorization, "Bearer hf_x");
    assert.deepEqual(r.info, { name: "org/detector", version: "0123456", aiLabel: "AI" });
    assert.deepEqual(r.labels, ["Human", "AI"]);
  });

  it("AI label from id2label: by AI name, by human name, otherwise open", async () => {
    const cases = [
      [{ 0: "machine-generated", 1: "human" }, "machine-generated"],
      [{ 0: "Real", 1: "Synthetic" }, "Synthetic"], // only the human class is recognizable
      [{ 0: "LABEL_0", 1: "LABEL_1" }, undefined], // convention unknown -> model-check.js decides
      [{ 1: "b", 0: "a" }, undefined]
    ];
    for (const [id2label, aiLabel] of cases) {
      mockFetch(meta(), config(id2label));
      assert.equal((await BACKENDS.huggingface.inspect(hf)).info.aiLabel, aiLabel, JSON.stringify(id2label));
    }
    mockFetch(meta(), config({ 1: "b", 0: "a" }));
    assert.deepEqual((await BACKENDS.huggingface.inspect(hf)).labels, ["a", "b"]);
  });

  it("an entered label must exist (case-insensitive)", async () => {
    mockFetch(meta(), config({ 0: "LABEL_0", 1: "LABEL_1" }));
    assert.equal((await BACKENDS.huggingface.inspect({ ...hf, hfAiLabel: "label_0" })).info.aiLabel, "LABEL_0");
    mockFetch(meta(), config({ 0: "LABEL_0", 1: "LABEL_1" }));
    await assert.rejects(BACKENDS.huggingface.inspect({ ...hf, hfAiLabel: "AI" }), /"AI" does not exist/);
  });

  it("rejects wrong model type, different class count and unknown models", async () => {
    mockFetch(meta({ pipeline_tag: "text-generation" }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /pipeline_tag: text-generation/);
    mockFetch(meta({ pipeline_tag: undefined }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /pipeline_tag: missing/);
    mockFetch(meta(), config({ 0: "neg", 1: "neutral", 2: "pos" }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /exactly 2 classes.*has 3: neg, neutral, pos/);
    mockFetch(meta(), config(undefined));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /has none$/);
    mockFetch({ status: 401, body: { error: "Invalid credentials" } });
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /not found \(or private\/gated/);
  });

  it("scoring uses the AI label from the passed check, top-1 of the other class -> complement", async () => {
    const sig = globalThis.AIVSAI.checkSignature(hf);
    const checked = { ...hf, modelChecks: { huggingface: { ok: true, sig, info: { aiLabel: "LABEL_0" } } } };
    mockFetch({ body: [[{ label: "LABEL_1", score: 0.9 }, { label: "LABEL_0", score: 0.1 }], [{ label: "LABEL_1", score: 0.75 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], checked), [0.1, 0.25]);
  });
});

describe("In the browser", () => {
  it("asks the offscreen document (creates it if needed) and passes the scores through", async () => {
    const sent = [];
    let created = 0;
    globalThis.chrome = {
      offscreen: { hasDocument: async () => created > 0, createDocument: async () => void created++ },
      runtime: { sendMessage: async (msg) => (sent.push(msg), { ok: true, scores: [0.3] }) }
    };
    assert.deepEqual(await BACKENDS.browser.score(["a"], { provider: "browser", browserModel: "desklib" }), [0.3]);
    assert.equal(created, 1);
    assert.deepEqual(sent, [{ target: "offscreen", type: "score", texts: ["a"], model: "desklib" }]);
  });

  it("errors from the offscreen document arrive as errors", async () => {
    globalThis.chrome = {
      offscreen: { hasDocument: async () => true },
      runtime: { sendMessage: async () => ({ ok: false, error: "Model not downloaded" }) }
    };
    await assert.rejects(BACKENDS.browser.score(["a"], { browserModel: "tmr" }), /Model not downloaded/);
    globalThis.chrome.runtime.sendMessage = async () => undefined;
    await assert.rejects(BACKENDS.browser.score(["a"], { browserModel: "tmr" }), /does not respond/);
  });
});

describe("health", () => {
  it("Local: /healthz, errors as text instead of an exception", async () => {
    mockFetch({ body: "ok" });
    globalThis.fetch = async (url) => (calls.push({ url }), new Response("ok"));
    assert.deepEqual(await BACKENDS.local.health(local), { ok: true });
    assert.equal(calls[0].url, "http://127.0.0.1:8787/healthz");
    globalThis.fetch = async () => new Response("", { status: 503 });
    assert.deepEqual(await BACKENDS.local.health(local), { ok: false, error: "HTTP 503" });
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.match((await BACKENDS.local.health(local)).error, /unreachable/);
  });

  it("In the browser: download status from the offscreen document", async () => {
    const models = { tmr: { downloaded: true, loaded: false }, desklib: { downloaded: false, downloading: { loaded: 1 } } };
    globalThis.chrome = {
      offscreen: { hasDocument: async () => true },
      runtime: { sendMessage: async () => ({ ok: true, models }) }
    };
    assert.deepEqual(await BACKENDS.browser.health({ browserModel: "tmr" }), { ok: true, detail: "Model ready" });
    assert.match((await BACKENDS.browser.health({ browserModel: "desklib" })).error, /downloaded…/);
  });

  it("cloud backends have no check of their own (costs quota)", () => {
    assert.equal(BACKENDS.custom.health, undefined);
    assert.equal(BACKENDS.huggingface.health, undefined);
  });
});

describe("describeError", () => {
  it("translates timeout and network errors, otherwise the message", () => {
    const timeout = Object.assign(new Error("x"), { name: "TimeoutError" });
    assert.equal(describeError(timeout, local), "Backend timed out");
    assert.match(describeError(new TypeError("Failed to fetch"), local), /Local server unreachable \(http:\/\/127\.0\.0\.1:8787\/\)/);
    assert.match(describeError(new TypeError("Failed to fetch"), custom), /missing permission/);
    assert.equal(describeError(new Error("HTTP 500"), custom), "HTTP 500");
    assert.equal(describeError("raw", custom), "raw");
  });
});
