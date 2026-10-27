// Status line of the popup (extension/popup-status.js): which sentence appears under the counters.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

globalThis.AIVSAI_BLOCKLIST = { domains: "\n" };
await import("../../extension/models.js");
await import("../../extension/config.js");
await import("../../extension/lang-detect.js");
await import("../../extension/popup-status.js");
const A = globalThis.AIVSAI;
const status = globalThis.AIVSAI_STATUS.message;
// Controls of a normal web page as popup.js computes them; tests override what differs
const page = { supported: true, pdf: false, canScan: true, canSwitch: true };
const message = (stats, config, controls = {}) => status(stats, config, { ...page, ...controls });
const cfg = (over = {}) => ({ ...A.DEFAULTS, ...A.SECRET_DEFAULTS, ...over });
// Stats as the content script reports them for a page that is scanned and has nothing to show yet
const stats = (over = {}) => ({
  red: 0, yellow: 0, green: 0, uncertain: 0, skipped: 0, pending: 0, deferred: 0,
  active: true, blocked: false, blockReason: null, manualScan: false, error: null, host: "page.example",
  ...over
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
    const text = message(stats({ active: false, blocked: true, blockReason: "list" }), cfg());
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
    const manual = message(stats({ active: false }), cfg({ scanMode: "manual" }), { canSwitch: false });
    assert.match(manual, /Automatic scanning is off.*Scan page now/);
    assert.doesNotMatch(manual, /Switch it on/);
  });

  it("points to no control the popup does not show (PDF)", () => {
    const pdf = { pdf: true, canScan: false, canSwitch: false };
    assert.equal(message(stats({ active: false }), cfg(), pdf), ""); // the PDF section says what to do
    assert.equal(message(null, cfg(), pdf), ""); // viewer not ready: reloading would not help
  });

  it("says so when the extension is switched off, also when the page does not answer", () => {
    assert.match(message(stats({ active: false }), cfg({ enabled: false })), /switched off/);
    assert.match(message(null, cfg({ enabled: false })), /switched off/);
  });

  it("explains pages the extension cannot scan, and a page that does not answer", () => {
    assert.equal(message(null, cfg(), { supported: false, canScan: false, canSwitch: false }), "Nothing can be scanned on this kind of page.");
    assert.match(message(null, cfg()), /Reload the page once/);
  });

  it("uses the content script's stats even where the popup cannot scan (file:// pages)", () => {
    const file = { supported: false, canScan: false, canSwitch: false };
    assert.equal(message(stats({ pending: 2 }), cfg(), file), "2 paragraph(s) being checked…");
    assert.equal(message(stats({ error: "boom" }), cfg(), file), "Error: boom");
  });

  it("keeps a generic fallback for an inactive page without a known reason", () => {
    const none = { canScan: false, canSwitch: false };
    assert.equal(message(stats({ active: false, green: 1 }), cfg({ scanMode: "all" }), none), "Not active on this page.");
  });

  it("points to the tiles when there is something flagged", () => {
    assert.match(message(stats({ red: 1 }), cfg()), /jump to the paragraphs/);
    assert.match(message(stats({ yellow: 1 }), cfg()), /jump to the paragraphs/);
  });
});
