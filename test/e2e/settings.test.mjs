// Settings page (issue #9): basic view on one screen, advanced folded away, changes saved immediately,
// other backends only after an explicit confirmation, no stored setting lost.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend, until } from "./helpers.mjs";

describe("Settings page", () => {
  let ext, backend;
  // stored value or default (a setting that was never changed is not in storage)
  const stored = (...keys) =>
    ext.options.evaluate(
      async (k) => {
        const cfg = await chrome.storage.sync.get(AIVSAI.DEFAULTS);
        return Object.fromEntries(k.map((key) => [key, cfg[key]]));
      },
      keys
    );

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({ viewport: { width: 1920, height: 1080 } });
    // the setup page links to options.html#detection first, which unfolds the advanced section
    await ext.options.goto(ext.options.url().split("#")[0]);
    await ext.options.waitForFunction(() => document.querySelector("#modelStatus")?.textContent !== "Checking…");
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("shows the basic settings in one screen at 1080p, advanced settings folded", async () => {
    assert.equal(await ext.options.evaluate(() => document.getElementById("advanced").open), false);
    const { cardBottom, summaryBottom, inner } = await ext.options.evaluate(() => ({
      cardBottom: document.getElementById("data").getBoundingClientRect().bottom,
      summaryBottom: document.querySelector("#advanced > summary").getBoundingClientRect().bottom,
      inner: window.innerHeight
    }));
    assert.ok(cardBottom <= inner, `basic settings end at ${cardBottom}px, window is ${inner}px high`);
    assert.ok(summaryBottom <= inner, "the Advanced entry is visible without scrolling");
    for (const id of ["yellowFrom", "customUrl", "lazyScan", "blockedSites", "scoreRetentionDays"]) {
      assert.equal(await ext.options.locator(`#${id}`).isVisible(), false, `#${id} is advanced`);
    }
    for (const sel of ['input[name="browserModel"]', 'input[name="scanMode"]', "#storeClear"]) {
      assert.ok(await ext.options.locator(sel).first().isVisible(), `${sel} is basic`);
    }
    assert.equal(await ext.options.locator("#test").isVisible(), false, "no test button for the browser model");
    // no developer wording on the page
    const text = await ext.options.evaluate(() => document.body.textContent);
    assert.doesNotMatch(text, /EVAL_RESULTS|shim_server|Laya|import_feedback/);
  });

  it("saves changes immediately, without a Save button", async () => {
    assert.equal(await ext.options.locator("#save").isVisible(), false);
    await ext.options.check('input[name="scanMode"][value="manual"]');
    await until(async () => (await stored("scanMode")).scanMode === "manual", { message: "scan mode not saved" });
    await ext.openAdvanced();
    await ext.options.uncheck("#lazyScan");
    await ext.options.fill("#blockedSites", "intranet.example.com\nWWW.Corp.Example");
    await ext.options.selectOption("#scoreRetentionDays", "90");
    await until(async () => (await stored("lazyScan")).lazyScan === false, { message: "checkbox not saved" });
    await until(async () => (await stored("scoreRetentionDays")).scoreRetentionDays === 90);
    await until(async () => (await stored("blockedSites")).blockedSites.length === 2);
    assert.deepEqual((await stored("blockedSites")).blockedSites, ["intranet.example.com", "corp.example"]);
  });

  it("does not store a threshold pair that is the wrong way round", async () => {
    const before = await stored("yellowFrom", "redFrom");
    await ext.options.evaluate(() => {
      const y = document.getElementById("yellowFrom");
      y.value = "0.98";
      document.getElementById("redFrom").value = "0.6";
      y.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await ext.options.waitForFunction(() => /must be smaller/.test(document.getElementById("status").textContent));
    assert.deepEqual(await stored("yellowFrom", "redFrom"), before);
    // back to a valid pair (the form would block the next confirmation otherwise)
    await ext.options.evaluate(({ yellowFrom, redFrom }) => {
      document.getElementById("redFrom").value = redFrom;
      document.getElementById("yellowFrom").value = yellowFrom;
      document.getElementById("yellowFrom").dispatchEvent(new Event("input", { bubbles: true }));
    }, before);
    await ext.options.waitForFunction(() => !/must be smaller/.test(document.getElementById("status").textContent));
  });

  it("applies another backend only after confirmation and shows the test button for it", async () => {
    await ext.options.check('input[name="provider"][value="local"]');
    await ext.options.fill("#localUrl", backend.url);
    assert.ok(await ext.options.locator("#save").isVisible(), "confirm button appears");
    assert.ok(await ext.options.locator("#test").isVisible(), "test button for a server provider");
    await new Promise((r) => setTimeout(r, 600)); // longer than the autosave delay
    assert.equal((await stored("provider")).provider, "browser", "not applied without confirmation");

    await ext.options.click("#save");
    await ext.options.waitForFunction(() => document.getElementById("status").textContent === "Saved.");
    const cfg = await stored("provider", "localUrl", "scanMode", "lazyScan");
    assert.deepEqual(cfg, { provider: "local", localUrl: backend.url, scanMode: "manual", lazyScan: false });
    assert.equal(await ext.options.locator("#save").isVisible(), false);
  });

  it("opens the advanced section for links into it", async () => {
    const id = new URL(ext.options.url()).host;
    const page = await ext.open(`chrome-extension://${id}/options.html#detection`);
    await page.waitForFunction(() => document.getElementById("advanced").open);
    assert.ok(await page.locator("#providerChoices").isVisible());
    await page.close();
  });

  it("has no console errors", () => {
    assert.deepEqual(ext.errors, []);
  });
});
