// How much text goes to the model: up to 2000 characters (≈ 512 tokens), truncated at the sentence end; batches by
// amount of text; right-click and badge score the same excerpt as the auto-scan.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend } from "./helpers.mjs";

const sentence = (i) => `Sentence number ${i} explains how the old mill by the river was rebuilt after the flood. `;
const long = (tag, n) => `${tag} ` + Array.from({ length: n }, (_, i) => sentence(i)).join("");
const page =
  `<html><body>` +
  // ~3000 characters plus icon font, which must go along neither with the auto-scan nor with the right-click
  `<p id="longp">${long("LONGP", 35)}<span aria-hidden="true">ICONTEXT</span></p>` +
  Array.from({ length: 4 }, (_, i) => `<p>${long(`MID${i}`, 20)}</p>`).join("") +
  `</body></html>`;

describe("Text length", () => {
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

  it("sends long paragraphs up to 2000 characters, truncated at the sentence end, without icon text", () => {
    const text = backend.texts.find((t) => t.startsWith("LONGP"));
    assert.ok(text.length <= 2000 && text.length > 1500, `length ${text.length}`);
    assert.match(text, /flood\.$/);
    assert.doesNotMatch(text, /ICONTEXT/);
  });

  it("limits batches to 2500 characters (a single long paragraph may go alone)", () => {
    for (const batch of backend.batches) {
      const chars = batch.reduce((n, t) => n + t.length, 0);
      assert.ok(batch.length === 1 || chars <= 2500, `batch with ${batch.length} texts, ${chars} characters`);
    }
  });

  it("scores the same excerpt on right-click – no new model call", async () => {
    const requests = backend.requests;
    await tab.click("#longp", { button: "right", position: { x: 20, y: 20 } });
    await ext.sendToTab("length.test", { type: "CHECK_ELEMENT" });
    await tab.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.equal(backend.requests, requests, "same text → hit in the score cache");
    const popover = await tab.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent);
    assert.match(popover, /The first \d+ characters \(up to the sentence end\) were scored/);
  });
});
