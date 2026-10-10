// Guided setup page (issue #8): nothing downloaded or scanned before a click, cancelling works, steps can be skipped.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, until } from "./helpers.mjs";

describe("Setup page", () => {
  let ext, setup;

  before(async () => {
    ext = await launchExtension();
    const id = new URL(ext.options.url()).host;
    setup = await ext.open(`chrome-extension://${id}/setup.html`);
    await setup.waitForSelector("#hero button.primary");
  });

  after(async () => {
    await ext?.close();
  });

  it("preselects no model, marks one as recommended and starts no download", async () => {
    assert.equal(await setup.locator("#models .option").count(), 2, "the other two models");
    assert.equal(await setup.locator("#models .option[aria-pressed='true']").count(), 0);
    assert.equal(await setup.locator("#hero .badge", { hasText: "recommended" }).count(), 1);
    assert.match(await setup.textContent("#hero button.primary"), /desklib.*1\.7 GB/);
    assert.equal(await setup.locator("#downloadPanel").isHidden(), true);
    const st = await ext.send({ type: "MODEL_STATUS" });
    for (const m of Object.values(st.models)) assert.deepEqual([m.downloaded, m.downloading], [false, null]);
  });

  it("starts the download only on click and can cancel it", async () => {
    // requests of the offscreen document are not visible to Playwright - check the model state instead
    // The offscreen document is busy or being torn down while downloading/cancelling and may answer with an error
    // for a moment (CI) - polling treats that as "not yet" instead of failing
    const state = () => ext.send({ type: "MODEL_STATUS" });
    const tmr = async () => (await state()).models?.tmr;
    await setup.click(".others summary");
    await setup.locator("#models .option", { hasText: "TMR" }).click();
    let st = await state();
    assert.equal(st.models.tmr.downloading, null, "choosing a card must not start a download");
    await setup.click("#download");
    await until(async () => (await tmr())?.downloading, { message: "download did not start after the click" });
    await setup.waitForSelector("#cancel:not([hidden])");
    await setup.click("#cancel");
    await setup.waitForFunction(() => document.querySelector("#downloadStatus").textContent.includes("cancelled"));
    assert.equal(await setup.locator("#download").isVisible(), true, "download can be restarted");
    // the page shows "cancelled" at once, the offscreen document is torn down right after
    const done = await until(async () => {
      const m = await tmr();
      return m && m.downloading === null && m;
    }, { message: "download still running" });
    assert.equal(done.downloaded, false);
  });

  it("lets every step be skipped and offers the samples only with a model", async () => {
    await setup.click("#later");
    await setup.click("#modes .option >> nth=0");
    assert.equal((await ext.options.evaluate(() => chrome.storage.sync.get("scanMode"))).scanMode, "manual");
    await setup.click("#next2");
    assert.equal(await setup.locator("#sampleBlock").isHidden(), true);
    assert.match(await setup.textContent("#noSamples"), /Choose and download a model/);
    await setup.click("#next3");
    assert.equal(await setup.locator("section[data-step='4']").isVisible(), true, "quick start after the try-out");
    assert.match(await setup.textContent("#howScan"), /Scan page now/);
  });

  it("is linked from the settings", async () => {
    assert.equal(await ext.options.locator("a[href='setup.html']").count(), 1);
  });
});
