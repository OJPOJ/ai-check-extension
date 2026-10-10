// Scanning a PDF in the viewer (issue #33): paragraphs from real pdf.js output go through the same pipeline as web
// pages (language, grouping, batches), against a fake local backend.
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, layoutLines, makeLayoutPdf, startBackend } from "./helpers.mjs";

const sentence = (n) => `Sentence ${n} describes how patient gardeners water their beds and care for the soil in spring.`;
const longPara = (tag) => `${tag} ` + Array.from({ length: 12 }, (_, i) => sentence(i)).join(" ");

// Page 1: heading, long paragraph (hyphenated word), page furniture; page 2: continuation, references
function samplePdf() {
  const heading = [{ text: "1 Introduction to Gardening", x: 72, y: 790, size: 18 }];
  const body = layoutLines(longPara("alpha"), { top: 760 });
  body[0].text += " exam-"; // hyphenated at the line end ...
  body[1].text = `ple ${body[1].text}`; // ... and continued on the next line
  const second = layoutLines(longPara("beta"), { top: 760 - body.length * 14 - 20 });
  const footer = [{ text: "1", x: 300, y: 30, size: 10 }];
  const page2 = [
    ...layoutLines(longPara("gamma"), { top: 760 }),
    { text: "References", x: 72, y: 300, size: 16 },
    ...layoutLines("Smith, J. (2020). A very long reference entry about plants and their soil. Journal of Plants, 3(2), 1-10, and more.", { top: 270 }),
    { text: "2", x: 300, y: 30, size: 10 }
  ];
  return makeLayoutPdf([[...heading, ...body, ...second, ...footer], page2]);
}

describe("PDF scan", () => {
  let backend, ext, id;

  before(async () => {
    backend = await startBackend();
    ext = await launchExtension();
    await ext.configure({ provider: "local", localUrl: backend.url });
    id = new URL(ext.options.url()).host;
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  async function openPdf(buffer) {
    const page = await ext.open(`chrome-extension://${id}/viewer.html`);
    await page.setInputFiles("#fileInput", { name: "doc.pdf", mimeType: "application/pdf", buffer });
    await page.waitForFunction(() => !document.querySelector("#scan").disabled);
    return page;
  }

  it("scores the prose paragraphs, not headings, page numbers or references", async () => {
    const page = await openPdf(samplePdf());
    const before = backend.texts.length;
    await page.click("#scan");
    await page.waitForSelector("#hits li");
    const sent = backend.texts.slice(before);
    assert.ok(sent.length >= 2, `paragraphs sent: ${sent.length}`);
    assert.ok(sent.every((t) => !/Introduction to Gardening|References|Smith, J\./.test(t)), "headings/references stay out");
    assert.ok(sent.some((t) => t.startsWith("alpha ")), "first paragraph");
    assert.ok(sent.some((t) => t.includes("example") && !t.includes("exam-")), "hyphenated line break is joined");
    assert.ok(sent.every((t) => !/\b[12]\b$/.test(t.trim())), "page numbers are not part of the text");
    assert.match(await page.textContent("#scanCounts"), /flagged/);
    assert.match(await page.textContent("#scanStatus"), /text blocks checked/);
    assert.match(await page.textContent("#hits li:first-child .meta"), /^p\. 1/);
    await page.close();
  });

  it("jumps to the page of a result on click", async () => {
    const page = await openPdf(samplePdf());
    await page.click("#scan");
    await page.waitForSelector("#hits li");
    const items = await page.$$("#hits li button");
    await items[items.length - 1].click();
    await page.waitForFunction(() => document.querySelector("#pageNumber").value === "2");
    await page.close();
  });

  const markedCount = (page) =>
    page.evaluate(() =>
      Object.fromEntries(
        ["green", "yellow", "red", "uncertain"].map((l) => [l, CSS.highlights.get(`aivsai-${l}`)?.size ?? 0])
      )
    );
  const totalMarked = async (page) => Object.values(await markedCount(page)).reduce((a, b) => a + b, 0);

  it("marks the scored paragraphs in the text layer, also after zooming", async () => {
    const page = await openPdf(samplePdf());
    assert.equal(await totalMarked(page), 0, "nothing is marked before the scan");
    await page.click("#scan");
    await page.waitForSelector("#hits li");
    await page.waitForFunction(() => (CSS.highlights.get("aivsai-green")?.size ?? 0) + (CSS.highlights.get("aivsai-yellow")?.size ?? 0) + (CSS.highlights.get("aivsai-red")?.size ?? 0) + (CSS.highlights.get("aivsai-uncertain")?.size ?? 0) > 0);
    const first = await totalMarked(page);
    assert.ok(first >= 10, `many text-layer spans are marked (${first})`);
    // zooming rebuilds the text layers - the marking must come back
    await page.selectOption("#zoom", "1.5");
    await page.waitForFunction(() => document.querySelector("#zoom").value === "1.5");
    await page.waitForTimeout(600);
    assert.ok((await totalMarked(page)) >= 10, "marking is applied again after zooming");
    await page.close();
  });

  it("shows the result popover when marked text is clicked", async () => {
    const page = await openPdf(samplePdf());
    await page.click("#scan");
    await page.waitForSelector("#hits li");
    await page.waitForFunction(() => document.querySelectorAll(".textLayer span").length > 5);
    // a span of the first paragraph (not the heading)
    const target = page.locator(".textLayer span", { hasText: "alpha" }).first();
    await target.click();
    await page.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    await page.keyboard.press("Escape");
    assert.equal(await page.$("aivsai-popover"), null, "popover closes with Escape");
    await page.close();
  });

  it("scrolls to the place of a result and offers 'next flagged'", async () => {
    // page 1 full of text, the interesting paragraph low on page 2
    const filler = layoutLines(longPara("filler"), { top: 760 });
    const low = layoutLines(longPara("omega"), { top: 330 });
    const page = await openPdf(makeLayoutPdf([filler, [...layoutLines(longPara("gamma"), { top: 760 }), ...low]]));
    await page.click("#scan");
    await page.waitForSelector("#hits li");
    const items = await page.$$("#hits li button");
    await items[items.length - 1].click(); // the last paragraph: on page 2, low
    await page.waitForFunction(() => document.querySelector("#viewerContainer").scrollTop > 800);
    // the paragraph is inside the visible part of the container
    const inView = await page.evaluate(() => {
      const box = document.querySelector("#viewerContainer").getBoundingClientRect();
      const span = [...document.querySelectorAll(".textLayer span")].find((s) => s.textContent.startsWith("omega"));
      const r = span?.getBoundingClientRect();
      return !!r && r.top >= box.top - 2 && r.bottom <= box.bottom + 2;
    });
    assert.equal(inView, true, "the paragraph itself is on screen, not only its page");
    await page.close();
  });

  it("starts at a balanced zoom instead of the full window width", async () => {
    const page = await ext.open(`chrome-extension://${id}/viewer.html`);
    await page.setViewportSize({ width: 1800, height: 900 });
    await page.setInputFiles("#fileInput", { name: "doc.pdf", mimeType: "application/pdf", buffer: samplePdf() });
    await page.waitForSelector(".page canvas");
    const width = () => page.evaluate(() => document.querySelector(".page").getBoundingClientRect().width);
    assert.equal(await page.inputValue("#zoom"), "balanced");
    assert.ok((await width()) <= 595 * (96 / 72) * 1.1 + 6, `page is not wider than 110% (${await width()})`);
    await page.selectOption("#zoom", "page-width");
    await page.waitForFunction(() => document.querySelector(".page").getBoundingClientRect().width > 1000);
    await page.close();
  });

  it("refuses an external backend and sends nothing", async () => {
    await ext.configure({ provider: "custom", customUrl: "https://detector.example/v1/score" });
    const page = await openPdf(samplePdf());
    const before = backend.requests;
    await page.click("#scan");
    await page.waitForFunction(() => /not sent to/.test(document.querySelector("#scanStatus").textContent));
    assert.match(await page.textContent("#scanStatus"), /detector\.example/);
    assert.equal(backend.requests, before);
    assert.equal(await page.locator("#hits li").count(), 0);
    await page.close();
    await ext.configure({ provider: "local", localUrl: backend.url });
  });

  it("tells which pages have no text layer", async () => {
    const page = await openPdf(makeLayoutPdf([layoutLines(longPara("delta")), []]));
    await page.click("#scan");
    await page.waitForFunction(() => /no text layer/.test(document.querySelector("#scanNotes").textContent));
    assert.match(await page.textContent("#scanNotes"), /checked: 2/);
    await page.close();
  });

  it("reports when nothing long enough was found", async () => {
    const page = await openPdf(makeLayoutPdf([[{ text: "Only a few words here.", x: 72, y: 700 }]]));
    await page.click("#scan");
    await page.waitForFunction(() => /No paragraphs long enough/.test(document.querySelector("#scanStatus").textContent));
    await page.close();
  });

  it("raises no console errors", async () => {
    assert.deepEqual(ext.errors, []);
  });
});
