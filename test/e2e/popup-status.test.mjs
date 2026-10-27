// Popup status line: a page without markers always says why (issue #12). The popup runs as an ordinary tab here;
// chrome.tabs.query is pointed at the test page, because the popup would otherwise only see its own tab.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import { launchExtension, startBackend, until } from "./helpers.mjs";

const para = (i) => `<p>Paragraph ${i} ` + "lorem ipsum dolor sit amet consectetur adipiscing elit sed do ".repeat(16) + "</p>";
const long = `<html><body>${Array.from({ length: 5 }, (_, i) => para(i)).join("\n")}</body></html>`;

describe("Popup status line", () => {
  let backend, ext, base;
  const open = [];

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension({
      pages: {
        "approved.test": long, // English only - another language would take the status line
        "plain.test": long,
        "blocked.test": long,
        "login.test": long.replace("<body>", '<body><form><input type="password"></form>'),
        "doc.test": long // served as HTML, but the popup sees an address ending in ".pdf"
      }
    });
    base = ext.options.url().split("/").slice(0, 3).join("/");
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["approved.test"], lazyScan: false });
    for (const host of ["approved.test", "plain.test", "blocked.test", "login.test", "doc.test"]) {
      open.push(await ext.open(`http://${host}/`));
    }
  });

  afterEach(() => ext.configure({ enabled: true, scanMode: "sites", blockedSites: [] }));

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  /**
   * Opens the popup as if `host` were the active tab (`url` = the address it reports, default the page itself).
   * Waits until the page's stats have arrived (counters filled) - or, without a host, until the status line is set.
   * Returns the status line, the site hint and whether the site switch and "Scan page now" are offered.
   */
  async function popup(host, url = `http://${host}/`) {
    const page = await ext.ctx.newPage();
    if (host) {
      const id = await ext.tabId(host);
      await page.addInitScript(([id, url]) => (chrome.tabs.query = async () => [{ id, url }]), [id, url]);
    }
    await page.goto(`${base}/popup.html`);
    const ready = host ? async () => (await page.textContent("#cRed")) !== "–" : () => page.textContent("#pending");
    await until(ready, { message: "popup did not get the page's stats" });
    const result = {
      status: await page.textContent("#pending"),
      hint: await page.textContent("#siteHint"),
      canSwitch: await page.isVisible("#siteSwitch"),
      canScan: await page.isEnabled("#scanNow")
    };
    await page.close();
    return result;
  }

  it("says nothing can be scanned on pages the extension cannot run on", async () => {
    const { status, hint } = await popup(null); // the popup tab itself is a chrome-extension:// page
    assert.equal(status, "Nothing can be scanned on this kind of page.");
    assert.equal(hint, "Cannot scan here");
  });

  it("points to the flagged paragraphs on an approved, scanned site", async () => {
    await until(async () => {
      const s = await ext.sendToTab("approved.test", { type: "GET_STATS" });
      return !s.pending && s.red + s.yellow > 0;
    }, { timeout: 20_000, message: "approved page was not scored" });
    assert.equal((await popup("approved.test")).status, "Click “flagged” or “unclear” to jump to the paragraphs.");
  });

  it("explains a site that is not approved and names the way to scan it", async () => {
    const { status, canSwitch, canScan } = await popup("plain.test");
    assert.match(status, /not approved for automatic scanning/);
    assert.match(status, /Scan page now/);
    assert.ok(canSwitch && canScan, "the line names controls the popup does not offer");
  });

  it("explains that automatic scanning is off in manual mode", async () => {
    await ext.configure({ scanMode: "manual" });
    const { status, canSwitch, canScan } = await popup("plain.test");
    assert.match(status, /Automatic scanning is off/);
    assert.ok(!canSwitch && canScan);
  });

  it("names no switch or button on a PDF, where the popup offers neither", async () => {
    const { status, canSwitch, canScan } = await popup("doc.test", "http://doc.test/paper.pdf");
    assert.ok(!canSwitch && !canScan);
    assert.equal(status, "");
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
