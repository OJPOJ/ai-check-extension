// scoreBatch aus extension/bg/scoring.js mit gemocktem chrome/fetch: gleichzeitige Anfragen für denselben Text
// (mehrere Tabs, doppelter Absatz im Batch) gehen nur einmal ans Backend. Dauerhafter Speicher ist aus.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

globalThis.AIVSAI_BLOCKLIST = { domains: "" };
globalThis.chrome = {
  storage: {
    sync: { get: async () => ({ provider: "local", localUrl: "http://127.0.0.1:8787", scoreRetentionDays: 0 }) },
    local: { get: async () => ({}) },
    onChanged: { addListener() {} }
  }
};
await import("../../extension/models.js");
await import("../../extension/config.js");
const { scoreBatch } = await import("../../extension/bg/scoring.js");

const realFetch = globalThis.fetch;
let requests = [];
let release;

// Backend antwortet erst nach release(): Score 0.5 pro Text, bei fail HTTP 500
function holdBackend({ fail = false } = {}) {
  requests = [];
  const gate = new Promise((resolve) => (release = resolve));
  globalThis.fetch = async (url, init) => {
    const { texts } = JSON.parse(init.body);
    requests.push(texts);
    await gate;
    if (fail) return new Response("kaputt", { status: 500 });
    return new Response(JSON.stringify({ scores: texts.map(() => 0.5) }), { status: 200 });
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// eindeutige Texte pro Test - der Arbeitsspeicher-Cache überlebt zwischen den Tests
let n = 0;
const text = (tag) => `${tag} ${++n} ${"lorem ipsum ".repeat(20)}`;

describe("scoreBatch: laufende Anfragen zusammenfassen", () => {
  it("schickt denselben Text aus zwei Tabs nur einmal ans Backend", async () => {
    holdBackend();
    const shared = text("shared");
    const onlyB = text("onlyB");
    const a = scoreBatch([{ id: "a1", text: shared }]);
    const b = scoreBatch([
      { id: "b1", text: shared },
      { id: "b2", text: onlyB }
    ]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    assert.deepEqual(await a, { ok: true, scores: { a1: 0.5 }, model: "local:tmr" });
    assert.deepEqual(await b, { ok: true, scores: { b1: 0.5, b2: 0.5 }, model: "local:tmr" });
    assert.deepEqual(requests, [[shared], [onlyB]]);
  });

  it("schickt einen doppelten Absatz im selben Batch nur einmal", async () => {
    holdBackend();
    const t = text("dup");
    const res = scoreBatch([
      { id: "x", text: t },
      { id: "y", text: t }
    ]);
    release();
    assert.deepEqual((await res).scores, { x: 0.5, y: 0.5 });
    assert.deepEqual(requests, [[t]]);
  });

  it("gibt den Fehler an wartende Anfragen weiter und versucht es danach neu", async () => {
    holdBackend({ fail: true });
    const t = text("fail");
    const a = scoreBatch([{ id: "a", text: t }]);
    const b = scoreBatch([{ id: "b", text: t }]);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.ok, false);
    assert.equal(rb.ok, false);
    assert.equal(rb.error, ra.error);
    assert.deepEqual(rb.scores, {});
    assert.equal(requests.length, 1);

    holdBackend();
    release();
    assert.deepEqual((await scoreBatch([{ id: "c", text: t }])).scores, { c: 0.5 });
    assert.equal(requests.length, 1);
  });

  it("nimmt fertige Ergebnisse aus dem Arbeitsspeicher", async () => {
    holdBackend();
    release();
    const t = text("cached");
    await scoreBatch([{ id: "1", text: t }]);
    await scoreBatch([{ id: "2", text: t }]);
    assert.equal(requests.length, 1);
  });
});
