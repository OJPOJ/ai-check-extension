// Wie viel Text ans Modell geht: bis 2000 Zeichen (≈ 512 Tokens), gekürzt am Satzende; Batches nach
// Textmenge; Rechtsklick und Badge bewerten denselben Ausschnitt wie der Auto-Scan.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend } from "./helpers.mjs";

const sentence = (i) => `Sentence number ${i} explains how the old mill by the river was rebuilt after the flood. `;
const long = (tag, n) => `${tag} ` + Array.from({ length: n }, (_, i) => sentence(i)).join("");
const page =
  `<html><body>` +
  // ~3000 Zeichen plus Icon-Font, der weder beim Auto-Scan noch beim Rechtsklick mitgehen darf
  `<p id="longp">${long("LONGP", 35)}<span aria-hidden="true">ICONTEXT</span></p>` +
  Array.from({ length: 4 }, (_, i) => `<p>${long(`MID${i}`, 20)}</p>`).join("") +
  `</body></html>`;

describe("Textlänge", () => {
  let backend, ext, tab;

  before(async () => {
    backend = await startBackend(() => 0.3);
    ext = await launchExtension({ pages: { "length.test": page }, viewport: { width: 900, height: 3000 } });
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["length.test"], lazyScan: false });
    tab = await ext.open("http://length.test/");
    await tab.waitForFunction(() => document.querySelectorAll("[data-aivsai-level]").length === 5, null, { timeout: 20_000 });
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("schickt lange Absätze bis 2000 Zeichen, gekürzt am Satzende, ohne Icon-Text", () => {
    const text = backend.texts.find((t) => t.startsWith("LONGP"));
    assert.ok(text.length <= 2000 && text.length > 1500, `Länge ${text.length}`);
    assert.match(text, /flood\.$/);
    assert.doesNotMatch(text, /ICONTEXT/);
  });

  it("begrenzt Batches auf 2500 Zeichen (ein einzelner langer Absatz darf allein gehen)", () => {
    for (const batch of backend.batches) {
      const chars = batch.reduce((n, t) => n + t.length, 0);
      assert.ok(batch.length === 1 || chars <= 2500, `Batch mit ${batch.length} Texten, ${chars} Zeichen`);
    }
  });

  it("bewertet beim Rechtsklick denselben Ausschnitt – kein neuer Modellaufruf", async () => {
    const requests = backend.requests;
    await tab.click("#longp", { button: "right", position: { x: 20, y: 20 } });
    await ext.sendToTab("length.test", { type: "CHECK_ELEMENT" });
    await tab.waitForFunction(() => /% KI/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.equal(backend.requests, requests, "gleicher Text → Treffer im Score-Cache");
    const popover = await tab.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent);
    assert.match(popover, /Bewertet wurden die ersten \d+ Zeichen \(bis zum Satzende\)/);
  });
});
