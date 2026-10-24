// Popup status line: a page without markers always says why (issue #12). The popup runs as an ordinary tab here;
// chrome.tabs.query is pointed at the test page, because the popup would otherwise only see its own tab.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { ROOT, launchExtension, until } from "./helpers.mjs";

const harness = fs.readFileSync(path.join(ROOT, "test", "harness.html"), "utf8");
const para = (i) => `<p>Paragraph ${i} ` + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(16) + "</p>";
const long = `<html><body>${Array.from({ length: 5 }, (_, i) => para(i)).join("\n")}</body></html>`;

describe("Popup status line", () => {
  let ext, base;
  const open = [];

  before(async () => {
    ext = await launchExtension({
      pages: {
        "approved.test": harness,
        "plain.test": long,
        "blocked.test": long,
        "login.test": long.replace("<body>", '<body><form><input type="password"></form>')
      }
    });
    base = ext.options.url().split("/").slice(0, 3).join("/");
    await ext.configure({ sites: ["approved.test"], lazyScan: false });
    for (const host of ["plain.test", "blocked.test", "login.test"]) open.push(await ext.open(`http://${host}/`));
  });

  afterEach(() => ext.configure({ enabled: true, scanMode: "sites", blockedSites: [] }));

  after(() => ext.close());

  /** Opens the popup as if `host` were the active tab; returns the text of the status line and the site hint. */
  async function popup(host) {
    const page = await ext.ctx.newPage();
    if (host) {
      const id = await ext.tabId(host);
      await page.addInitScript(([id, url]) => (chrome.tabs.query = async () => [{ id, url }]), [id, `http://${host}/`]);
    }
    await page.goto(`${base}/popup.html`);
    await until(() => page.textContent("#pending"), { message: "status line stayed empty" });
    const result = { status: await page.textContent("#pending"), hint: await page.textContent("#siteHint") };
    await page.close();
    return result;
  }

  it("says nothing can be scanned on pages the extension cannot run on", async () => {
    const { status, hint } = await popup(null); // the popup tab itself is a chrome-extension:// page
    assert.equal(status, "Nothing can be scanned on this kind of page.");
    assert.equal(hint, "Cannot scan here");
  });

  it("explains a site that is not approved and names the way to scan it", async () => {
    const { status } = await popup("plain.test");
    assert.match(status, /not approved for automatic scanning/);
    assert.match(status, /Scan page now/);
  });

  it("explains that automatic scanning is off in manual mode", async () => {
    await ext.configure({ scanMode: "manual" });
    assert.match((await popup("plain.test")).status, /Automatic scanning is off/);
  });

  it("explains a site on the blocklist and points to the way out", async () => {
    await ext.configure({ blockedSites: ["blocked.test"] });
    const { status } = await popup("blocked.test");
    assert.match(status, /on the blocklist/);
    assert.match(status, /Remove from blocklist/);
  });

  it("explains that a password field stops the scan", async () => {
    await ext.configure({ scanMode: "all" });
    await until(async () => (await ext.sendToTab("login.test", { type: "GET_STATS" })).blockReason === "sensitive", {
      message: "password field not detected"
    });
    assert.match((await popup("login.test")).status, /Password or payment field/);
  });

  it("says when the extension is switched off", async () => {
    await ext.configure({ enabled: false });
    assert.match((await popup("plain.test")).status, /switched off/);
  });
});
