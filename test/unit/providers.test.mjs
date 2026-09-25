// Backends aus extension/bg/providers.js mit gemocktem fetch/chrome: Vertrag, /v1/info, Antwortformen der
// Hugging-Face-API, Hub-Metadaten, Label-Zuordnung und Fehlermeldungen. Die E2E-Tests decken nur "Lokal" gegen ein
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

  it("Nicht-Zahlen und Werte außerhalb 0..1 werden null (Absatz bleibt unbewertet), der Rest bleibt", async () => {
    mockFetch({ body: { scores: [0.2, null, "0.7", -0.1, 1.5, 0, 1] } });
    const texts = ["a", "b", "c", "d", "e", "f", "g"];
    assert.deepEqual(await BACKENDS.custom.score(texts, custom), [0.2, null, null, null, null, 0, 1]);
  });

  it("lang geht mit, wenn bekannt", async () => {
    mockFetch({ body: { scores: [0.5] } }, { body: { scores: [0.5] } });
    await BACKENDS.local.score(["a"], local, { lang: "en" });
    await BACKENDS.custom.score(["a"], custom, { lang: "de" });
    assert.deepEqual(calls[0].body, { texts: ["a"], model: "tmr", lang: "en" });
    assert.deepEqual(calls[1].body, { texts: ["a"], lang: "de" });
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

describe("GET /v1/info (inspect für Lokal / Eigener Server)", () => {
  const info = { name: "Det", version: "v2", maxChars: 1200, languages: ["en"], suggestedThresholds: { yellowFrom: 0.4, redFrom: 0.8 } };

  it("Lokal: neben /v1/score, mit Modell als Parameter", async () => {
    mockFetch({ body: info });
    assert.deepEqual(await BACKENDS.local.inspect(local), { info, notes: [] });
    assert.equal(calls[0].url, "http://127.0.0.1:8787/v1/info?model=tmr");
    assert.equal(calls[0].init.method, undefined); // GET
  });

  it("Eigener Server: relativ zur Endpunkt-URL, Bearer-Key", async () => {
    mockFetch({ body: info }, { body: info });
    await BACKENDS.custom.inspect({ ...custom, customUrl: "https://s.example/api/v1/score", customApiKey: "k", customModel: "a b" });
    assert.equal(calls[0].url, "https://s.example/api/v1/info?model=a%20b");
    assert.equal(calls[0].init.headers.Authorization, "Bearer k");
    await BACKENDS.custom.inspect(custom);
    assert.equal(calls[1].url, "https://s.example/info");
  });

  it("fehlender Endpunkt ist kein Fehler, andere HTTP-Fehler schon", async () => {
    for (const status of [404, 405, 501]) {
      mockFetch({ status, body: "" });
      const r = await BACKENDS.custom.inspect(custom);
      assert.deepEqual(r.info, {});
      assert.match(r.notes[0], /Kein \/v1\/info/);
    }
    mockFetch({ status: 401, body: { detail: "invalid or missing API key" } });
    await assert.rejects(BACKENDS.custom.inspect(custom), /HTTP 401/);
  });

  it("verwirft ungültige Felder mit Hinweis, Version als Text", async () => {
    mockFetch({
      body: { name: 3, version: 7, maxChars: 5, languages: "en", suggestedThresholds: { yellowFrom: 0.9, redFrom: 0.5 } }
    });
    const r = await BACKENDS.custom.inspect(custom);
    assert.deepEqual(r.info, { version: "7" });
    assert.equal(r.notes.length, 4);

    mockFetch({ body: {} });
    assert.match((await BACKENDS.custom.inspect(custom)).notes[0], /keine Version/);
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

describe("Hugging Face: Metadaten vom Hub (inspect)", () => {
  const meta = (over = {}) => ({ body: { sha: "0123456789abcdef", pipeline_tag: "text-classification", ...over } });
  const config = (id2label) => ({ body: { id2label } });

  it("liest Modellinfo und config.json derselben Revision, mit Token", async () => {
    mockFetch(meta(), config({ 0: "Human", 1: "AI" }));
    const r = await BACKENDS.huggingface.inspect(hf);
    assert.equal(calls[0].url, "https://huggingface.co/api/models/org/detector");
    assert.equal(calls[1].url, "https://huggingface.co/org/detector/resolve/0123456789abcdef/config.json");
    assert.equal(calls[1].init.headers.Authorization, "Bearer hf_x");
    assert.deepEqual(r.info, { name: "org/detector", version: "0123456", aiLabel: "AI" });
    assert.deepEqual(r.labels, ["Human", "AI"]);
  });

  it("KI-Label aus id2label: per KI-Name, per Mensch-Name, sonst offen", async () => {
    const cases = [
      [{ 0: "machine-generated", 1: "human" }, "machine-generated"],
      [{ 0: "Real", 1: "Synthetic" }, "Synthetic"], // nur die Mensch-Klasse ist erkennbar
      [{ 0: "LABEL_0", 1: "LABEL_1" }, undefined], // Konvention unbekannt -> model-check.js entscheidet
      [{ 1: "b", 0: "a" }, undefined]
    ];
    for (const [id2label, aiLabel] of cases) {
      mockFetch(meta(), config(id2label));
      assert.equal((await BACKENDS.huggingface.inspect(hf)).info.aiLabel, aiLabel, JSON.stringify(id2label));
    }
    mockFetch(meta(), config({ 1: "b", 0: "a" }));
    assert.deepEqual((await BACKENDS.huggingface.inspect(hf)).labels, ["a", "b"]);
  });

  it("eingetragenes Label muss es geben (Groß-/Kleinschreibung egal)", async () => {
    mockFetch(meta(), config({ 0: "LABEL_0", 1: "LABEL_1" }));
    assert.equal((await BACKENDS.huggingface.inspect({ ...hf, hfAiLabel: "label_0" })).info.aiLabel, "LABEL_0");
    mockFetch(meta(), config({ 0: "LABEL_0", 1: "LABEL_1" }));
    await assert.rejects(BACKENDS.huggingface.inspect({ ...hf, hfAiLabel: "AI" }), /„AI“ gibt es nicht/);
  });

  it("lehnt falschen Modelltyp, andere Klassenzahl und unbekannte Modelle ab", async () => {
    mockFetch(meta({ pipeline_tag: "text-generation" }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /pipeline_tag: text-generation/);
    mockFetch(meta({ pipeline_tag: undefined }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /pipeline_tag: fehlt/);
    mockFetch(meta(), config({ 0: "neg", 1: "neu", 2: "pos" }));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /genau 2 Klassen.*hat 3: neg, neu, pos/);
    mockFetch(meta(), config(undefined));
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /hat keine$/);
    mockFetch({ status: 401, body: { error: "Invalid credentials" } });
    await assert.rejects(BACKENDS.huggingface.inspect(hf), /nicht gefunden \(oder privat\/gated/);
  });

  it("Bewertung nutzt das KI-Label aus der bestandenen Prüfung, Top-1 der anderen Klasse -> Gegenwert", async () => {
    const sig = globalThis.AIVSAI.checkSignature(hf);
    const checked = { ...hf, modelChecks: { huggingface: { ok: true, sig, info: { aiLabel: "LABEL_0" } } } };
    mockFetch({ body: [[{ label: "LABEL_1", score: 0.9 }, { label: "LABEL_0", score: 0.1 }], [{ label: "LABEL_1", score: 0.75 }]] });
    assert.deepEqual(await BACKENDS.huggingface.score(["a", "b"], checked), [0.1, 0.25]);
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
