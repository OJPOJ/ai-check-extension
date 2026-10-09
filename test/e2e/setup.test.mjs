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
    await setup.waitForSelector("#models .option");
  });

  after(async () => {
    await ext?.close();
  });

  it("preselects no model, marks one as recommended and starts no download", async () => {
    assert.equal(await setup.locator("#models .option").count(), 3);
    assert.equal(await setup.locator("#models .option[aria-pressed='true']").count(), 0);
    assert.equal(await setup.locator("#models .badge", { hasText: "recommended" }).count(), 1);
    assert.equal(await setup.locator("#downloadPanel").isHidden(), true);
    const st = await ext.send({ type: "MODEL_STATUS" });
    for (const m of Object.values(st.models)) assert.deepEqual([m.downloaded, m.downloading], [false, null]);
  });

  it("starts the download only on click and can cancel it", async () => {
    // requests of the offscreen document are not visible to Playwright - check the model state instead
    const state = () => ext.send({ type: "MODEL_STATUS" });
    await setup.locator("#models .option", { hasText: "TMR" }).click();
    let st = await state();
    assert.equal(st.models.tmr.downloading, null, "choosing a card must not start a download");
    await setup.click("#download");
    await until(async () => (await state()).models.tmr.downloading, { message: "download did not start after the click" });
    await setup.waitForSelector("#cancel:not([hidden])");
    await setup.click("#cancel");
    await setup.waitForFunction(() => document.querySelector("#downloadStatus").textContent.includes("cancelled"));
    assert.equal(await setup.locator("#download").isVisible(), true, "download can be restarted");
    st = await state();
    assert.equal(st.models.tmr.downloaded, false);
    assert.equal(st.models.tmr.downloading, null);
  });

  it("lets every step be skipped and offers the samples only with a model", async () => {
    await setup.click("#later");
    await setup.click("#modes .option >> nth=0");
    assert.equal((await ext.options.evaluate(() => chrome.storage.sync.get("scanMode"))).scanMode, "manual");
    await setup.click("#next2");
    assert.equal(await setup.locator("#score").isDisabled(), true);
    assert.match(await setup.textContent("#scoreStatus"), /No model yet/);
  });

  it("is linked from the settings", async () => {
    assert.equal(await ext.options.locator("a[href='setup.html']").count(), 1);
  });
});
