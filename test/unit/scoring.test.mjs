// scoreBatch from extension/bg/scoring.js with mocked chrome/fetch: simultaneous requests for the same text
// (several tabs, duplicate paragraph in the batch) go to the backend only once. Persistent store is off.
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

// Backend responds only after release(): score 0.5 per text, HTTP 500 on fail
function holdBackend({ fail = false } = {}) {
  requests = [];
  const gate = new Promise((resolve) => (release = resolve));
  globalThis.fetch = async (url, init) => {
    const { texts } = JSON.parse(init.body);
    requests.push(texts);
    await gate;
    if (fail) return new Response("broken", { status: 500 });
    return new Response(JSON.stringify({ scores: texts.map(() => 0.5) }), { status: 200 });
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

// unique texts per test - the in-memory cache survives between tests
let n = 0;
const text = (tag) => `${tag} ${++n} ${"lorem ipsum ".repeat(20)}`;

describe("scoreBatch: merge running requests", () => {
  it("sends the same text from two tabs to the backend only once", async () => {
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

  it("sends a duplicate paragraph in the same batch only once", async () => {
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

  it("passes the error on to waiting requests and retries afterwards", async () => {
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

  it("takes finished results from memory", async () => {
    holdBackend();
    release();
    const t = text("cached");
    await scoreBatch([{ id: "1", text: t }]);
    await scoreBatch([{ id: "2", text: t }]);
    assert.equal(requests.length, 1);
  });
});
