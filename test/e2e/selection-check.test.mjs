// Single check in an own window for text without a content script (selected text in the browser's PDF viewer,
// issue #31): same verdict as the popover on pages, nothing leaves the computer except to the chosen backend.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, startBackend } from "./helpers.mjs";

describe("Selection check window", () => {
  let backend, ext, id;

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({ pages: { "doc.test": "<html><body><p>Stub document of a PDF tab</p></body></html>" } });
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["doc.test"] });
    id = new URL(ext.options.url()).host;
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  // Same path as background.js openSelectionCheck: job in session storage, window reads and removes it
  async function openJob(job) {
    const key = crypto.randomUUID();
    await ext.options.evaluate(([k, j]) => chrome.storage.session.set({ [`selection:${k}`]: j }), [key, job]);
    const page = await ext.open(`chrome-extension://${id}/selection-check.html?job=${key}`);
    return { page, key };
  }

  it("scores a long selection and shows level, notes and excerpt", async () => {
    const text = longText("sel1");
    const { page, key } = await openJob({ text, url: "http://docs.example/paper.pdf" });
    await page.waitForSelector("#result:not([hidden])");
    assert.match(await page.getAttribute("#pill", "class"), /\b(green|yellow|red)\b/);
    assert.match(await page.textContent("#pill"), /AI score \d+/);
    assert.match(await page.textContent("#notes"), /Hint, not proof/);
    assert.ok(backend.texts.some((t) => t.startsWith("sel1 ")), "text went to the configured backend");
    const left = await ext.options.evaluate((k) => chrome.storage.session.get(`selection:${k}`), key);
    assert.deepEqual(left, {}, "job is removed after reading");
    await page.close();
  });

  it("reports too little text without calling the backend", async () => {
    const before = backend.requests;
    const { page } = await openJob({ text: "just three words" });
    await page.waitForSelector("#error:not([hidden])");
    assert.match(await page.textContent("#error"), /Too little text \(3 words\)/);
    assert.equal(backend.requests, before);
    await page.close();
  });

  it("offers 'Check anyway' for a language the model does not know", async () => {
    const german = "Das ist ein deutscher Text über die Pflege des Gartens im Frühling und die Bedeutung von Licht und Wasser für alle Pflanzen. ".repeat(3);
    const before = backend.requests;
    const { page } = await openJob({ text: german });
    await page.waitForSelector("#actions:not([hidden]) button");
    assert.match(await page.textContent("#title"), /Text in German/);
    assert.equal(backend.requests, before, "nothing is sent before the explicit click");
    await page.click("#actions button");
    await page.waitForFunction(() => /AI score|uncertain/.test(document.querySelector("#pill").textContent));
    assert.ok(backend.requests > before);
    await page.close();
  });

  it("shows the hint when there is no selection and survives a missing job", async () => {
    const a = await openJob({ error: "No text selected. Select text first." });
    await a.page.waitForSelector("#error:not([hidden])");
    assert.match(await a.page.textContent("#error"), /No text selected/);
    await a.page.close();
    const page = await ext.open(`chrome-extension://${id}/selection-check.html?job=gone`);
    await page.waitForSelector("#error:not([hidden])");
    assert.match(await page.textContent("#error"), /Nothing to check/);
    await page.close();
  });

  it("names the destination on a blocklisted site", async () => {
    const { page } = await openJob({ text: longText("sel2"), url: "https://www.chase.com/statement.pdf" });
    await page.waitForSelector("#result:not([hidden])");
    const notes = await page.textContent("#notes");
    assert.match(notes, /blocklist/);
    assert.match(notes, /checked because you explicitly requested it/);
    await page.close();
  });

  it("lets the content script hand over to the window when the selection lives elsewhere", async () => {
    // Top frame of a PDF tab: script is present, but getSelection() is empty (the text is inside the viewer)
    const page = await ext.open("http://doc.test/");
    await page.waitForSelector("p");
    const reply = (msg) => ext.sendToTab("doc.test", msg);
    assert.deepEqual(await reply({ type: "CHECK_SELECTION", selectionText: "text from the viewer" }), { fallback: true });
    assert.deepEqual(await reply({ type: "CHECK_ELEMENT" }), { fallback: true }, "no right-click target in this frame");
    // with a selection of its own the page handles it itself
    await page.evaluate(() => getSelection().selectAllChildren(document.querySelector("p")));
    assert.deepEqual(await reply({ type: "CHECK_SELECTION", selectionText: "Stub document of a PDF tab" }), { fallback: false });
    await page.close();
  });

  it("raises no console errors", async () => {
    assert.deepEqual(ext.errors, []);
  });
});
