// Check pasted text (issue #16): text from a PDF, mail client or document is pasted into the check window and
// scored like a manual check - without a site permission, clipped the same way, and nothing is stored.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, longText, startBackend, storedScores } from "./helpers.mjs";

describe("Check pasted text", () => {
  let backend, ext, id;

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension();
    // no site approved: the window needs no permission for any page
    await ext.configure({ provider: "local", localUrl: backend.url, sites: [] });
    id = new URL(ext.options.url()).host;
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  const openPaste = () => ext.open(`chrome-extension://${id}/selection-check.html?paste`);
  const storageSnapshot = () =>
    ext.options.evaluate(async () => ({
      local: await chrome.storage.local.get(null),
      session: await chrome.storage.session.get(null)
    }));

  it("opens from the popup", async () => {
    const popup = await ext.open(`chrome-extension://${id}/popup.html`);
    const opened = ext.ctx.waitForEvent("page", (p) => p.url().includes("selection-check.html?paste"));
    await popup.click("#openPaste");
    const page = await opened;
    await page.waitForSelector("#paste:not([hidden]) textarea");
    assert.match(await page.title(), /Check pasted text/);
    await page.close();
  });

  it("scores pasted text with the same verdict and stores nothing", async () => {
    const page = await openPaste();
    await page.waitForSelector("#paste:not([hidden])");
    assert.equal(await page.isHidden("#status"), true, "no 'Checking…' before anything was pasted");
    const storedBefore = (await storedScores(ext.options)).length;
    const storageBefore = await storageSnapshot();
    // line breaks as they come out of a PDF are collapsed like a selection on a page
    await page.fill("#pasteText", longText("paste1").replace(/ water /g, "\nwater\n"));
    assert.match(await page.textContent("#pasteCount"), /^\d+ words$/);
    await page.click("#pasteCheck");
    await page.waitForSelector("#result:not([hidden])");
    assert.match(await page.textContent("#pill"), /AI score \d+/);
    assert.match(await page.textContent("#notes"), /Hint, not proof/);
    assert.ok(backend.texts.includes(longText("paste1").trim()), "same text as a selection would send");
    assert.equal(await page.isVisible("#paste"), true, "field stays for the next text");
    assert.equal((await storedScores(ext.options)).length, storedBefore, "no score fingerprint stored");
    assert.deepEqual(await storageSnapshot(), storageBefore, "text is not stored");
    await page.close();
  });

  it("clips text over the model limit and says how much was scored", async () => {
    const page = await openPaste();
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about the garden in spring.`).join(" ");
    await page.fill("#pasteText", text);
    assert.match(await page.textContent("#pasteCount"), /only the first \d+ are scored/);
    await page.click("#pasteCheck");
    await page.waitForSelector("#result:not([hidden])");
    const sent = backend.texts.at(-1);
    assert.ok(sent.length <= 2000 && sent.endsWith("spring."), "clipped at a sentence end");
    const words = text.split(" ").length;
    const scored = sent.split(" ").length;
    assert.match(
      await page.textContent("#notes"),
      new RegExp(`The first ${sent.length} characters \\(${scored} of ${words} words\\)`)
    );
    await page.close();
  });

  it("explains empty and too short input without calling the backend", async () => {
    const page = await openPaste();
    const before = backend.requests;
    await page.click("#pasteCheck");
    await page.waitForSelector("#error:not([hidden])");
    assert.match(await page.textContent("#error"), /Paste some text/);
    await page.fill("#pasteText", "just three words");
    await page.click("#pasteCheck");
    await page.waitForFunction(() => /Too little text \(3 words\)/.test(document.querySelector("#error").textContent));
    assert.equal(backend.requests, before);
    await page.close();
  });

  it("raises no console errors", async () => {
    assert.deepEqual(ext.errors, []);
  });
});
