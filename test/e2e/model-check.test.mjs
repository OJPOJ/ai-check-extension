// "Check model" in the real settings page: required before saving a custom server,
// display of the individual results, traffic light suggestion, version in the model key.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { REFERENCE_SET } from "../../extension/bg/reference-set.js";
import { launchExtension, startBackend } from "./helpers.mjs";

// Good detector for the reference set: AI texts high, human texts low; everything else not flagged
const aiOf = (t) => REFERENCE_SET.find((r) => r.text.startsWith(t))?.ai;
const good = (t) => ({ true: 0.92, false: 0.15, undefined: 0.3 })[aiOf(t)];

describe("Check model", () => {
  let backend, swapped, ext;
  const status = () => ext.options.textContent("#status");
  const waitStatus = (text) =>
    ext.options.waitForFunction((t) => document.querySelector("#status").textContent.includes(t), text, { timeout: 20_000 });

  before(async () => {
    backend = await startBackend(good, { info: { name: "Fake", version: "v7", suggestedThresholds: { yellowFrom: 0.4, redFrom: 0.8 } } });
    swapped = await startBackend((t) => 1 - good(t)); // returns P(human), without /v1/info
    ext = await launchExtension();
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
    await swapped?.close();
  });

  async function chooseCustom(url) {
    await ext.options.check('input[name="provider"][value="custom"]');
    await ext.options.fill("#customUrl", `${url}/v1/score`);
  }

  it("custom server: no saving without a passed check", async () => {
    await chooseCustom(backend.url);
    assert.match(await ext.options.textContent("#check-custom-status"), /required/);
    await ext.options.click("#save");
    assert.match(await status(), /Please run "Check model" first/);
    const saved = await ext.options.evaluate(() => chrome.storage.sync.get("provider"));
    assert.notEqual(saved.provider, "custom");
  });

  it("swapped labels: failed, saving stays blocked", async () => {
    await chooseCustom(swapped.url);
    await ext.options.click("#check-custom");
    await waitStatus("failed the check");
    const fails = await ext.options.$$eval("#check-custom-list li.fail", (els) => els.map((e) => e.textContent));
    assert.equal(fails.length, 1);
    assert.match(fails[0], /P\(human\) instead of P\(AI\)/);
    await ext.options.click("#save");
    assert.match(await status(), /failed the check/);
  });

  it("good server: passed, traffic light from the server, saving with version in the model key", async () => {
    await chooseCustom(backend.url);
    assert.match(await ext.options.textContent("#check-custom-status"), /Not checked yet/); // different URL
    const before = backend.requests;
    await ext.options.click("#check-custom");
    await waitStatus("checked – passed");
    assert.equal(backend.texts.filter((t) => aiOf(t) !== undefined).length, REFERENCE_SET.length + 1); // warm-up + reference set
    assert.ok(backend.requests - before > 2, "reference set in several batches");
    assert.match(await ext.options.textContent("#check-custom-status"), /Passed on .*AUROC 1\.00.*version v7/);
    const items = await ext.options.$$eval("#check-custom-list li", (els) => els.map((e) => [e.className, e.textContent]));
    assert.ok(items.some(([c, t]) => c === "ok" && /Separation: AUROC 1\.00/.test(t)));
    assert.ok(items.some(([c, t]) => c === "info" && /suggested by the server/.test(t)));
    assert.equal(await ext.options.inputValue("#yellowFrom"), "0.4");
    assert.equal(await ext.options.inputValue("#redFrom"), "0.8");

    await ext.options.click("#save");
    await waitStatus("Saved.");
    const model = await ext.options.evaluate(async () => {
      const cfg = await chrome.storage.sync.get(null);
      return { key: AIVSAI.modelKey(cfg), check: cfg.modelChecks.custom };
    });
    assert.equal(model.key, `custom:${backend.url}/v1/score@v7`);
    assert.equal(model.check.ok, true);
    assert.equal(model.check.checks, undefined); // individual results only for display, not in sync storage
  });

  it("a new URL invalidates the check", async () => {
    await ext.options.fill("#customUrl", `${backend.url}/different/v1/score`);
    assert.match(await ext.options.textContent("#check-custom-status"), /Not checked yet/);
    assert.equal(await ext.options.$$eval("#check-custom-list li", (els) => els.length), 0);
  });
});
