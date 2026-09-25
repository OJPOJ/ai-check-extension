// Dauerhafter Score-Speicher: überlebt SW-Neustart, Aufbewahrungsdauer, "Nicht speichern",
// Zuordnung über Seiten hinweg und beim Modellwechsel.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, sleep, startBackend, storedScores, until } from "./helpers.mjs";

const DAY = 864e5;
const pageA = `<html><body><p>${longText("SHARED")}</p><p>${longText("ONLYA")}</p></body></html>`;
const pageB = `<html><body><p>${longText("SHARED")}</p></body></html>`;
const sentWith = (backend, tag) => backend.texts.filter((t) => t.includes(tag)).length;

describe("Score-Speicher", () => {
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

  it("ist per Default 30 Tage eingestellt und anfangs leer", async () => {
    assert.equal(await ext.options.inputValue("#scoreRetentionDays"), "30");
    assert.equal((await info()).count, 0);
  });

  it("speichert Bewertungen ohne Text und URL", async () => {
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

  it("liefert nach SW-Neustart aus dem Speicher, ohne Backend-Anfrage", async () => {
    const cdp = await ext.ctx.newCDPSession(page);
    await cdp.send("ServiceWorker.enable");
    await cdp.send("ServiceWorker.stopAllWorkers"); // Arbeitsspeicher-Cache ist damit weg
    await sleep(500);
    const before = backend.requests;
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length === 2);
    assert.equal(backend.requests, before);
  });

  it("ordnet denselben Absatz auf einer anderen Seite demselben Eintrag zu", async () => {
    const before = sentWith(backend, "SHARED");
    const other = await ext.open("http://b.test/");
    await other.waitForFunction(() => document.querySelector("[data-aivsai-level]"));
    assert.equal(sentWith(backend, "SHARED"), before);
    await other.close();
  });

  it("bewertet nach Modellwechsel neu und nimmt beim Zurückwechseln den Speicher", async () => {
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

  it("löscht beim Verkürzen der Aufbewahrung sofort, was zu alt ist", async () => {
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
    // Formular zeigt sonst den Stand vor configure() - "Speichern" schreibt das ganze Formular
    await ext.options.reload();
    await ext.options.selectOption("#scoreRetentionDays", "7");
    await ext.options.click("#save");
    const keys = () => storedScores(ext.options).then((rows) => rows.map((r) => r.k));
    await until(async () => !(await keys()).includes("old"), { message: "40 Tage alter Eintrag nicht gelöscht" });
    assert.ok((await keys()).includes("recent"));
  });

  it("zeigt Anzahl und Größe in den Einstellungen", async () => {
    await ext.options.reload();
    await ext.options.waitForFunction(() => /gespeichert/.test(document.querySelector("#storeStatus").textContent));
    assert.match(await ext.options.textContent("#storeStatus"), /^\d+ Bewertungen gespeichert · ca\. \d+ KB$/);
  });

  it("leert bei „Nicht speichern“ alles und schreibt nichts Neues", async () => {
    await ext.options.selectOption("#scoreRetentionDays", "0");
    await ext.options.click("#save");
    await until(async () => (await info()).count === 0, { message: "Speicher nicht geleert" });
    await page.evaluate(() => {
      const p = document.createElement("p");
      p.textContent = "Fresh paragraph that was never scored before ".repeat(8);
      document.body.append(p);
    });
    await until(() => backend.texts.some((t) => t.startsWith("Fresh")), { message: "neuer Absatz nicht bewertet" });
    await sleep(300);
    assert.equal((await info()).count, 0);
  });

  it("richtet das tägliche Aufräumen ein", async () => {
    const alarms = await ext.options.evaluate(() => chrome.alarms.getAll());
    assert.ok(alarms.some((a) => a.name === "prune-scores" && a.periodInMinutes === 1440));
  });

  it("hat keine Konsolenfehler", () => {
    assert.deepEqual(ext.errors, []);
  });
});
