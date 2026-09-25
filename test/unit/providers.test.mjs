// Backends aus extension/bg/providers.js mit gemocktem fetch/chrome: Vertrag, Antwortformen der
// Hugging-Face-API, Label-Zuordnung und Fehlermeldungen. Die E2E-Tests decken nur "Lokal" gegen ein
// Fake-Backend ab; Hugging Face mit echtem Token bleibt ungetestet (README, "Tests").
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { BACKENDS, backendFor, describeError, trimSlash } from "../../extension/bg/providers.js";

globalThis.AIVSAI_BLOCKLIST = { domains: "" };
await import("../../extension/models.js");
await import("../../extension/config.js");

const realFetch = globalThis.fetch;
let calls = [];

// Nächste Antworten des Backends; jede ist {status?, body} (body als Objekt -> JSON, als String -> roh)
function mockFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
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
  it("entfernt nur abschließende Schrägstriche", () => {
    assert.equal(trimSlash("http://h:1///"), "http://h:1");
    assert.equal(trimSlash("http://h/a/b"), "http://h/a/b");
  });

  it("fällt bei unbekanntem Provider auf Lokal zurück", () => {
    assert.equal(backendFor({ provider: "huggingface" }), BACKENDS.huggingface);
    assert.equal(backendFor({ provider: "weg" }), BACKENDS.local);
  });

  it("zu jedem Provider aus config.js gibt es ein Backend und umgekehrt", () => {
    assert.deepEqual(Object.keys(BACKENDS).sort(), Object.keys(globalThis.AIVSAI.PROVIDERS).sort());
  });
});

describe("Lokal / Eigener Server (Vertrag POST {texts, model?} -> {scores})", () => {
  it("Lokal: /v1/score, Modell im Body, kein Authorization-Header", async () => {
    mockFetch({ body: { scores: [0.1, 0.9] } });
    assert.deepEqual(await BACKENDS.local.score(["a", "b"], local), [0.1, 0.9]);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/score");
    assert.deepEqual(calls[0].body, { model: "tmr", texts: ["a", "b"] });
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers.Authorization, undefined);
  });

  it("Eigener Server: URL unverändert, Bearer-Key, ohne Modell kein model-Feld", async () => {
    mockFetch({ body: { scores: [0.5] } });
    await BACKENDS.custom.score(["a"], { ...custom, customApiKey: "geheim" });
    assert.equal(calls[0].url, "https://s.example/score");
    assert.equal(calls[0].init.headers.Authorization, "Bearer geheim");
    assert.deepEqual(calls[0].body, { texts: ["a"] });
  });

  it("Nicht-Zahlen werden null (Absatz bleibt unbewertet), der Rest bleibt", async () => {
    mockFetch({ body: { scores: [0.2, null, "0.7"] } });
    assert.deepEqual(await BACKENDS.custom.score(["a", "b", "c"], custom), [0.2, null, null]);
  });

  it("lehnt Antworten ohne passendes scores-Array ab", async () => {
    for (const body of [{ scores: [0.1] }, { score: [0.1, 0.2] }, { scores: "0.1,0.2" }]) {
      mockFetch({ body });
      await assert.rejects(BACKENDS.custom.score(["a", "b"], custom), /passendes 'scores'-Array/);
    }
  });

  it("Eigener Server ohne URL: Fehler statt Anfrage", async () => {
    mockFetch();
    await assert.rejects(async () => BACKENDS.custom.score(["a"], { ...custom, customUrl: "" }), /Keine Server-URL/);
    assert.equal(calls.length, 0);
  });

  it("HTTP-Fehler mit Detail aus dem Body (FastAPI, OpenAI-Stil, Objekt, kein JSON)", async () => {
    const cases = [
      [{ status: 422, body: { detail: "texts fehlt" } }, "HTTP 422: texts fehlt"],
      [{ status: 401, body: { error: { message: "bad key" } } }, "HTTP 401: bad key"],
      [{ status: 400, body: { error: "kaputt" } }, "HTTP 400: kaputt"],
      [{ status: 422, body: { detail: [{ loc: ["texts"] }] } }, 'HTTP 422: [{"loc":["texts"]}]'],
      [{ status: 502, body: "<html>Bad Gateway</html>" }, "HTTP 502"]
    ];
    for (const [resp, message] of cases) {
      mockFetch(resp);
      await assert.rejects(BACKENDS.local.score(["a"], local), { message });
    }
  });
});

describe("Hugging Face", () => {
  it("Anfrage: Router-URL mit Modell, Token als Bearer, Texte als inputs", async () => {
    mockFetch({ body: [[{ label: "Fake", score: 0.8 }, { label: "Real", score: 0.2 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.8]);
    assert.equal(calls[0].url, "https://router.huggingface.co/hf-inference/models/org/detector");
    assert.equal(calls[0].init.headers.Authorization, "Bearer hf_x");
    assert.deepEqual(calls[0].body, { inputs: ["a"] });
  });

  it("Antwortformen: pro Text eine Liste, Einzeltext flach, Top-1 flach", async () => {
    mockFetch({ body: [[{ label: "AI", score: 0.9 }, { label: "Human", score: 0.1 }], [{ label: "Human", score: 0.7 }, { label: "AI", score: 0.3 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.9, 0.3]);

    mockFetch({ body: [{ label: "Human", score: 0.6 }, { label: "ChatGPT", score: 0.4 }] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.4]);

    mockFetch({ body: [{ label: "LABEL_1", score: 0.95 }, { label: "LABEL_0", score: 0.75 }] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.95, 0.25]);
  });

  it("automatische Label-Erkennung", async () => {
    const labels = [
      ["machine-generated", 0.7], ["AI_generated", 0.7], ["gpt", 0.7], ["LLM", 0.7], ["fake", 0.7]
    ];
    for (const [label, score] of labels) {
      mockFetch({ body: [[{ label, score }, { label: "human", score: 1 - score }]] });
      assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [score], label);
    }
    // Top-1 = Mensch -> Gegenwahrscheinlichkeit; ohne Top-1 lässt sich nichts ableiten
    mockFetch({ body: [[{ label: "human-written", score: 0.75 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], hf), [0.25]);
  });

  it("manuelles KI-Label (Groß-/Kleinschreibung egal) überstimmt die Automatik", async () => {
    mockFetch({ body: [[{ label: "Fake", score: 0.2 }, { label: "Synthetic", score: 0.8 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a"], { ...hf, hfAiLabel: "synthetic" }), [0.8]);
  });

  it("einzelne Texte ohne KI-Label werden null, alle ohne -> Fehler mit den gesehenen Labels", async () => {
    mockFetch({ body: [[{ label: "AI", score: 0.9 }], [{ label: "POSITIVE", score: 0.9 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], hf), [0.9, null]);

    mockFetch({ body: [[{ label: "POSITIVE", score: 0.9 }, { label: "NEGATIVE", score: 0.1 }]] });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), /Modell liefert: POSITIVE, NEGATIVE/);
  });

  it("Fehler: kein Modell, keine Liste, falsche Anzahl", async () => {
    mockFetch();
    await assert.rejects(BACKENDS.huggingface.score(["a"], { ...hf, hfModel: "" }), /Kein Hugging-Face-Modell/);
    assert.equal(calls.length, 0);

    mockFetch({ body: { error: "Model is loading" } });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), /Unerwartete Antwort/);

    mockFetch({ body: [[{ label: "AI", score: 0.9 }]] });
    await assert.rejects(BACKENDS.huggingface.score(["a", "b"], hf), /Anzahl Ergebnisse/);

    mockFetch({ status: 503, body: { error: "Model is loading" } });
    await assert.rejects(BACKENDS.huggingface.score(["a"], hf), { message: "HTTP 503: Model is loading" });
  });
});

describe("Im Browser", () => {
  it("fragt das Offscreen-Dokument (legt es bei Bedarf an) und reicht die Scores durch", async () => {
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

  it("Fehler aus dem Offscreen-Dokument kommen als Fehler an", async () => {
    globalThis.chrome = {
      offscreen: { hasDocument: async () => true },
      runtime: { sendMessage: async () => ({ ok: false, error: "Modell nicht heruntergeladen" }) }
    };
    await assert.rejects(BACKENDS.browser.score(["a"], { browserModel: "tmr" }), /Modell nicht heruntergeladen/);
    globalThis.chrome.runtime.sendMessage = async () => undefined;
    await assert.rejects(BACKENDS.browser.score(["a"], { browserModel: "tmr" }), /antwortet nicht/);
  });
});

describe("health", () => {
  it("Lokal: /healthz, Fehler als Text statt Ausnahme", async () => {
    mockFetch({ body: "ok" });
    globalThis.fetch = async (url) => (calls.push({ url }), new Response("ok"));
    assert.deepEqual(await BACKENDS.local.health(local), { ok: true });
    assert.equal(calls[0].url, "http://127.0.0.1:8787/healthz");
    globalThis.fetch = async () => new Response("", { status: 503 });
    assert.deepEqual(await BACKENDS.local.health(local), { ok: false, error: "HTTP 503" });
    globalThis.fetch = async () => {
      throw new TypeError("Failed to fetch");
    };
    assert.match((await BACKENDS.local.health(local)).error, /nicht erreichbar/);
  });

  it("Im Browser: Download-Status aus dem Offscreen-Dokument", async () => {
    const models = { tmr: { downloaded: true, loaded: false }, desklib: { downloaded: false, downloading: { loaded: 1 } } };
    globalThis.chrome = {
      offscreen: { hasDocument: async () => true },
      runtime: { sendMessage: async () => ({ ok: true, models }) }
    };
    assert.deepEqual(await BACKENDS.browser.health({ browserModel: "tmr" }), { ok: true, detail: "Modell bereit" });
    assert.match((await BACKENDS.browser.health({ browserModel: "desklib" })).error, /heruntergeladen…/);
  });

  it("Cloud-Backends haben keinen eigenen Check (kostet Quota)", () => {
    assert.equal(BACKENDS.custom.health, undefined);
    assert.equal(BACKENDS.huggingface.health, undefined);
  });
});

describe("describeError", () => {
  it("übersetzt Zeitüberschreitung und Netzwerkfehler, sonst die Meldung", () => {
    const timeout = Object.assign(new Error("x"), { name: "TimeoutError" });
    assert.equal(describeError(timeout, local), "Zeitüberschreitung beim Backend");
    assert.match(describeError(new TypeError("Failed to fetch"), local), /Lokaler Server nicht erreichbar \(http:\/\/127\.0\.0\.1:8787\/\)/);
    assert.match(describeError(new TypeError("Failed to fetch"), custom), /fehlende Berechtigung/);
    assert.equal(describeError(new Error("HTTP 500"), custom), "HTTP 500");
    assert.equal(describeError("roh", custom), "roh");
  });
});
