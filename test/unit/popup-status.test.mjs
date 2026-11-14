// Status line of the popup (extension/popup-status.js): what the popup offers and which sentence appears under the counters.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

globalThis.AIVSAI_BLOCKLIST = { domains: "\n" };
await import("../../extension/models.js");
await import("../../extension/config.js");
await import("../../extension/lang-detect.js");
await import("../../extension/popup-status.js");
const A = globalThis.AIVSAI;
const S = globalThis.AIVSAI_STATUS;
const cfg = (over = {}) => ({ ...A.DEFAULTS, ...A.SECRET_DEFAULTS, ...over });
// Stats as the content script reports them for a page that is scanned and has nothing to show yet
const stats = (over = {}) => ({
  red: 0, yellow: 0, green: 0, uncertain: 0, skipped: 0, pending: 0, deferred: 0,
  active: true, blocked: false, blockReason: null, manualScan: false, error: null, host: "page.example",
  ...over
});
// Controls exactly as popup.js computes them for a tab with this address
const controls = (config, { url = "http://page.example/", ...opts } = {}) => S.controls(S.page(url), config, opts);
// Status line as popup.js shows it: controls from the same address, settings and stats
const message = (st, config, opts = {}) => S.message(st, config, controls(config, { stats: st, ...opts }));

describe("popup controls", () => {
  it("reads host, http(s) and the .pdf address from the tab's URL", () => {
    assert.deepEqual(S.page("https://a.example/x"), { host: "a.example", supported: true, isPdf: false });
    assert.deepEqual(S.page("https://a.example/paper.PDF"), { host: "a.example", supported: true, isPdf: true });
    assert.deepEqual(S.page("chrome://extensions/"), { host: "extensions", supported: false, isPdf: false });
    assert.deepEqual(S.page(""), { host: "", supported: false, isPdf: false });
  });

  it("treats the Web Store as a page the extension cannot run on", () => {
    assert.equal(S.page("https://chromewebstore.google.com/detail/x").supported, false);
    assert.equal(S.page("https://chrome.google.com/webstore/detail/x").supported, false);
    assert.equal(S.page("https://chrome.google.com/other").supported, true);
  });

  it("offers the switch only where it can still turn scanning on", () => {
    assert.deepEqual(
      [controls(cfg()).showSwitch, controls(cfg()).canSwitch, controls(cfg()).canScan],
      [true, true, true]
    );
    const approved = controls(cfg({ sites: ["page.example"] }));
    assert.ok(approved.showSwitch && !approved.canSwitch && approved.canScan);
    const all = controls(cfg({ scanMode: "all" })); // switch shown checked and greyed out
    assert.ok(all.showSwitch && !all.canSwitch && all.canScan);
    const manual = controls(cfg({ scanMode: "manual" }));
    assert.ok(!manual.showSwitch && !manual.canSwitch && manual.canScan);
  });

  it("offers neither switch nor scan on blocked pages, PDFs and pages with a password field", () => {
    for (const c of [
      controls(cfg({ blockedSites: ["page.example"] })),
      controls(cfg(), { url: "http://page.example/a.pdf" }),
      controls(cfg(), { pdfByContentType: true }),
      controls(cfg(), { stats: stats({ active: false, blocked: true, blockReason: "sensitive" }) }),
      controls(cfg(), { url: "chrome://settings/" })
    ]) {
      assert.ok(!c.showSwitch && !c.canSwitch && !c.canScan, JSON.stringify(c));
    }
    assert.equal(controls(cfg({ blockedSites: ["page.example"] })).reason, "user");
    assert.equal(controls(cfg(), { stats: stats({ blockReason: "sensitive" }) }).sensitive, true);
  });

  it("offers no scan while the extension is switched off", () => {
    const off = controls(cfg({ enabled: false }));
    assert.ok(!off.canScan && !off.canSwitch);
  });
});

describe("popup status line", () => {
  it("is empty when there is nothing to say", () => {
    assert.equal(message(stats({ green: 3 }), cfg()), "");
  });

  it("names errors first, then work in progress", () => {
    assert.equal(message(stats({ error: "boom", pending: 2 }), cfg()), "Error: boom");
    assert.equal(message(stats({ pending: 2, deferred: 5 }), cfg()), "2 paragraph(s) being checked…");
    assert.equal(message(stats({ deferred: 5 }), cfg()), "5 more paragraphs will be checked on scrolling.");
  });

  it("counts paragraphs in another language and names the languages the model knows", () => {
    assert.match(message(stats({ skipped: 2 }), cfg()), /^2 paragraph\(s\) in another language not scored – the model only knows /);
  });

  it("says when no paragraph was long enough", () => {
    assert.equal(message(stats(), cfg()), "No sufficiently long paragraphs of text found.");
  });

  it("explains why a page on the blocklist is not scanned and how to change that", () => {
    const text = message(stats({ active: false, blocked: true, blockReason: "list" }), cfg({ blockedSites: ["page.example"] }));
    assert.match(text, /on the blocklist/);
    assert.match(text, /Remove from blocklist/);
    assert.match(text, /right-click/);
  });

  it("explains that a password or payment field stops the scan", () => {
    const text = message(stats({ active: false, blocked: true, blockReason: "sensitive" }), cfg());
    assert.match(text, /Password or payment field/);
    assert.match(text, /right-click/);
  });

  it("tells the user how to get a result on a site that is not approved", () => {
    assert.match(message(stats({ active: false }), cfg()), /not approved for automatic scanning.*Switch it on above.*Scan page now/);
    // manual mode: the popup shows no switch, so the line does not mention one
    const manual = message(stats({ active: false }), cfg({ scanMode: "manual" }));
    assert.match(manual, /Automatic scanning is off.*Scan page now/);
    assert.doesNotMatch(manual, /Switch it on/);
  });

  it("names no switch that cannot change anything (all mode, already approved site)", () => {
    for (const config of [cfg({ scanMode: "all" }), cfg({ sites: ["page.example"] })]) {
      const text = message(stats({ active: false }), config);
      assert.doesNotMatch(text, /Switch it on|not approved/);
      assert.match(text, /Scan page now/);
    }
  });

  it("points to no control the popup does not show (PDF)", () => {
    const pdf = { url: "http://page.example/paper.pdf" };
    assert.equal(message(stats({ active: false }), cfg(), pdf), ""); // the PDF section says what to do
    assert.equal(message(null, cfg(), pdf), ""); // viewer not ready: reloading would not help
    // PDF by content type, content script active: no "no paragraphs" sentence either
    assert.equal(message(stats({ pdf: true }), cfg({ scanMode: "all" }), { pdfByContentType: true }), "");
  });

  it("says so when the extension is switched off, also when the page does not answer", () => {
    assert.match(message(stats({ active: false }), cfg({ enabled: false })), /switched off/);
    assert.match(message(null, cfg({ enabled: false })), /switched off/);
    assert.match(message(null, cfg({ enabled: false }), { url: "chrome://settings/" }), /switched off/);
  });

  it("explains pages the extension cannot scan, and a page that does not answer", () => {
    assert.equal(message(null, cfg(), { url: "chrome://settings/" }), "Nothing can be scanned on this kind of page.");
    assert.equal(message(null, cfg(), { url: "https://chromewebstore.google.com/" }), "Nothing can be scanned on this kind of page.");
    // reloading only helps a tab opened before the install, so the line says it conditionally
    assert.match(message(null, cfg()), /does not answer\. If it was open before the extension was installed.*reload it once/);
  });

  it("uses the content script's stats even where the popup cannot scan (file:// pages)", () => {
    const file = { url: "file:///C:/notes.html" };
    assert.equal(message(stats({ pending: 2 }), cfg(), file), "2 paragraph(s) being checked…");
    assert.equal(message(stats({ error: "boom" }), cfg(), file), "Error: boom");
  });

  it("keeps a generic fallback for an inactive page without a known reason", () => {
    assert.equal(message(stats({ active: false, green: 1 }), cfg(), { url: "file:///C:/notes.html" }), "Not active on this page.");
  });

  it("points to the tiles when there is something flagged", () => {
    assert.match(message(stats({ red: 1 }), cfg()), /jump to the paragraphs/);
    assert.match(message(stats({ yellow: 1 }), cfg()), /jump to the paragraphs/);
  });
});
