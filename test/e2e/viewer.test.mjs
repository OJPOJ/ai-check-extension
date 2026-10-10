// PDF viewer of the extension (issue #32): pdf.js bundled, file picker, address with permission, no auto-redirect.
import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";
import { launchExtension, makePdf } from "./helpers.mjs";

const LINES = ["First line of the viewer test", "Second line with more words"];

describe("PDF viewer", () => {
  let ext, id, server, base;

  before(async () => {
    const pdf = makePdf(LINES);
    server = http.createServer((req, res) => {
      res.setHeader("content-type", "application/pdf");
      res.end(pdf);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${server.address().port}`;
    ext = await launchExtension({ pages: { "docs.test": "<html><body>x</body></html>" } });
    await ext.ctx.route("http://pdftab.test/**", (r) => r.fulfill({ contentType: "application/pdf", body: makePdf(LINES) }));
    id = new URL(ext.options.url()).host;
    // chrome-extension pages are not intercepted by ctx.route - nothing else to prepare
  });

  after(async () => {
    await ext?.close();
    await new Promise((r) => server?.close(r));
  });

  const open = (query = "") => ext.open(`chrome-extension://${id}/viewer.html${query}`);
  const textOf = (page) => page.$$eval(".textLayer span", (els) => els.map((e) => e.textContent).join(" "));

  it("asks for a file and shows no document at first", async () => {
    const page = await open();
    await page.waitForSelector("#notice:not([hidden])");
    assert.match(await page.textContent("#noticeTitle"), /Open a PDF/);
    assert.equal(await page.locator("#prev").isDisabled(), true);
    await page.close();
  });

  it("renders a chosen file with canvas and selectable text layer", async () => {
    const page = await open();
    await page.setInputFiles("#fileInput", { name: "paper.pdf", mimeType: "application/pdf", buffer: makePdf(LINES) });
    await page.waitForSelector(".page canvas");
    await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length >= 2);
    assert.match(await textOf(page), /First line of the viewer test/);
    assert.equal(await page.textContent("#title"), "paper.pdf");
    assert.match(await page.textContent("#pageCount"), /\/ 1/);
    assert.equal(await page.locator("#next").isDisabled(), false);
    await page.close();
  });

  it("loads a PDF by address when the origin is permitted (127.0.0.1 is built in)", async () => {
    const page = await open(`?file=${encodeURIComponent(`${base}/paper.pdf`)}`);
    await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length >= 2);
    assert.match(await textOf(page), /Second line with more words/);
    await page.close();
  });

  it("asks before loading from an origin without access, and does not load it", async () => {
    let requested = false;
    await ext.ctx.route("http://docs.test/doc.pdf", (r) => {
      requested = true;
      return r.fulfill({ contentType: "application/pdf", body: makePdf(LINES) });
    });
    const page = await open(`?file=${encodeURIComponent("http://docs.test/doc.pdf")}`);
    await page.waitForSelector("#notice:not([hidden])");
    assert.match(await page.textContent("#noticeTitle"), /Allow access to docs\.test/);
    assert.equal(await page.locator("#noticeActions button").count(), 2, "allow / choose a file");
    assert.equal(requested, false, "nothing was fetched before the click");
    await page.close();
  });

  it("handles file:// addresses with a notice instead of a blank page", async () => {
    // Whether file access is switched on depends on how the browser started (switched on here): either the
    // explanation or the error of a missing file - never an empty window
    const page = await open(`?file=${encodeURIComponent("file:///C:/docs/does-not-exist.pdf")}`);
    await page.waitForSelector("#notice:not([hidden])");
    assert.match(await page.textContent("#noticeTitle"), /local files is switched off|cannot be opened/);
    await page.close();
    // the browser logs the missing file itself - expected here
    ext.errors.splice(0, ext.errors.length, ...ext.errors.filter((e) => !/ERR_FILE_NOT_FOUND/.test(e)));
  });

  it("lets the content script tell the popup that a tab is a PDF, whatever its address", async () => {
    const page = await ext.open("http://pdftab.test/download?id=7");
    await page.waitForTimeout(1500);
    const stats = await ext.sendToTab("pdftab.test", { type: "GET_STATS" });
    assert.equal(stats.pdf, true);
    const html = await ext.open("http://docs.test/");
    assert.equal((await ext.sendToTab("docs.test", { type: "GET_STATS" })).pdf, false);
    await page.close();
    await html.close();
  });

  it("reports an invalid file instead of showing a blank page", async () => {
    const page = await open();
    await page.setInputFiles("#fileInput", { name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("not a pdf") });
    await page.waitForSelector("#notice:not([hidden])");
    assert.match(await page.textContent("#noticeTitle"), /cannot be opened/);
    await page.close();
  });

  it("raises no console errors", async () => {
    assert.deepEqual(ext.errors, []);
  });
});
