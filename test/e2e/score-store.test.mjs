// Persistent score store: survives SW restart, retention period, "Do not store",
// mapping across sites and on model switch.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, sleep, startBackend, storedScores, until } from "./helpers.mjs";

const DAY = 864e5;
const pageA = `<html><body><p>${longText("SHARED")}</p><p>${longText("ONLYA")}</p></body></html>`;
const pageB = `<html><body><p>${longText("SHARED")}</p></body></html>`;
const sentWith = (backend, tag) => backend.texts.filter((t) => t.includes(tag)).length;

describe("Score store", () => {
  let backend, ext, page;
  const info = () => ext.send({ type: "SCORE_STORE_INFO" });

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({ pages: { "a.test": pageA, "b.test": pageB } });
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("is set to 30 days by default and initially empty", async () => {
    assert.equal(await ext.options.inputValue("#scoreRetentionDays"), "30");
    assert.equal((await info()).count, 0);
  });

  it("stores scores without text and URL", async () => {
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["a.test", "b.test"], lazyScan: false });
    page = await ext.open("http://a.test/");
    await until(async () => (await info()).count === 2);
    const rows = await storedScores(ext.options);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["at", "k", "m", "p"]);
      assert.match(row.k, /^[0-9a-f]{32}$/);
      assert.equal(row.m, "local:tmr");
    }
  });

  it("serves from the store after SW restart, without a backend request", async () => {
    const cdp = await ext.ctx.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers"); // in-memory cache is gone as a result
    await sleep(500);
    const before = backend.requests;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length === 2);
    assert.equal(backend.requests, before);
  });

  it("maps the same paragraph on another site to the same entry", async () => {
    const before = sentWith(backend, "SHARED");
    const other = await ext.open("http://b.test/");
    await other.waitForFunction(() => document.querySelector("[data-aivsai-level]"));
    assert.equal(sentWith(backend, "SHARED"), before);
    await other.close();
  });

  it("rescores after a model switch and uses the store when switching back", async () => {
    const start = sentWith(backend, "ONLYA");
    await ext.configure({ localModel: "desklib" });
    await until(() => sentWith(backend, "ONLYA") === start + 1);
    await page.waitForFunction(() => !document.querySelector(".aivsai-pending"));
    await ext.configure({ localModel: "tmr" });
    await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length === 2);
    await sleep(500);
    assert.equal(sentWith(backend, "ONLYA"), start + 1);
    const models = new Set((await storedScores(ext.options)).map((r) => r.m));
    assert.deepEqual([...models].sort(), ["local:desklib", "local:tmr"]);
  });

  it("deletes immediately what is too old when the retention is shortened", async () => {
    await ext.options.evaluate(
      (day) =>
        new Promise((resolve) => {
          indexedDB.open("aivsai").onsuccess = (e) => {
            const tx = e.target.result.transaction("scores", "readwrite");
            tx.objectStore("scores").put({ k: "old", p: 0.5, m: "local:tmr", at: Date.now() - 40 * day });
            tx.objectStore("scores").put({ k: "recent", p: 0.5, m: "local:tmr", at: Date.now() - 5 * day });
            tx.oncomplete = resolve;
          };
        }),
      DAY
    );
    // Otherwise the form shows the state before configure() - "Save" writes the whole form
    await ext.options.reload();
    await ext.options.selectOption("#scoreRetentionDays", "7");
    await ext.options.click("#save");
    const keys = () => storedScores(ext.options).then((rows) => rows.map((r) => r.k));
    await until(async () => !(await keys()).includes("old"), { message: "40-day-old entry not deleted" });
    assert.ok((await keys()).includes("recent"));
  });

  it("shows count and size in the settings", async () => {
    await ext.options.reload();
    await ext.options.waitForFunction(() => /stored/.test(document.querySelector("#storeStatus").textContent));
    assert.match(await ext.options.textContent("#storeStatus"), /^\d+ scores stored · approx\. \d+ KB$/);
  });

  it("empties everything on “Do not store” and writes nothing new", async () => {
    await ext.options.selectOption("#scoreRetentionDays", "0");
    await ext.options.click("#save");
    await until(async () => (await info()).count === 0, { message: "store not emptied" });
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.textContent = "Fresh paragraph that was never scored before ".repeat(8);
      document.body.append(p);
    });
    await until(() => backend.texts.some((t) => t.startsWith("Fresh")), { message: "new paragraph not scored" });
    await sleep(300);
    assert.equal((await info()).count, 0);
  });

  it("sets up the daily cleanup", async () => {
    const alarms = await ext.options.evaluate(() => chrome.alarms.getAll());
    assert.ok(alarms.some((a) => a.name === "prune-scores" && a.periodInMinutes === 1440));
  });

  it("has no console errors", () => {
    assert.deepEqual(ext.errors, []);
  });
});
