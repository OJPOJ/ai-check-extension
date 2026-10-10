// Annotated copy of a PDF (extension/pdf-annotate.js): highlights + notes with pdf-lib, original untouched.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as PDFLib from "pdf-lib";
import { annotatePdf } from "../../extension/pdf-annotate.js";

async function samplePdf(pages = 2) {
  const doc = await PDFLib.PDFDocument.create();
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]).drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 10 });
  return new Uint8Array(await doc.save());
}

const items = [
  { x: 72, y: 700, w: 200, h: 10 },
  { x: 275, y: 700, w: 100, h: 10 }, // same line
  { x: 72, y: 687, w: 150, h: 10 } // next line
];
const pages = [{ number: 1, items }, { number: 2, items }];
const part = (page) => ({ page, items: [0, 1, 2], x0: 72, y0: 687, x1: 375, y1: 710 });

const annotsOf = (doc, index) =>
  doc.getPage(index).node.Annots()?.asArray().map((r) => doc.context.lookup(r)) ?? [];
const subtype = (a) => a.get(PDFLib.PDFName.of("Subtype")).toString();

describe("annotatePdf", () => {
  it("adds one highlight per level color, a note only on flagged paragraphs, one quad per line", async () => {
    const original = await samplePdf();
    const marks = [
      { level: "red", note: "AI Content Flag: 91 %", parts: [part(1)] },
      { level: "green", note: "AI Content Flag: 3 %", parts: [part(2)] }
    ];
    const { bytes, annotations } = await annotatePdf(PDFLib, original, marks, pages);
    const doc = await PDFLib.PDFDocument.load(bytes);

    const p1 = annotsOf(doc, 0);
    assert.deepEqual(p1.map(subtype), ["/Highlight", "/Text"]);
    const quads = p1[0].get(PDFLib.PDFName.of("QuadPoints")).asArray();
    assert.equal(quads.length, 16, "two lines -> two quads of 8 numbers");
    assert.match(p1[1].get(PDFLib.PDFName.of("Contents")).decodeText(), /91 %/);

    const p2 = annotsOf(doc, 1);
    assert.deepEqual(p2.map(subtype), ["/Highlight"], "no note on a green paragraph");
    assert.equal(annotations, 3);
  });

  it("does not modify the original bytes and keeps the page content", async () => {
    const original = await samplePdf(1);
    const before = Buffer.from(original);
    await annotatePdf(PDFLib, original, [{ level: "yellow", note: "n", parts: [part(1)] }], pages);
    assert.ok(before.equals(Buffer.from(original)));
  });

  it("keeps existing annotations on a page", async () => {
    const src = await PDFLib.PDFDocument.load(await samplePdf(1));
    const page = src.getPage(0);
    const link = src.context.register(src.context.obj({ Type: "Annot", Subtype: "Link", Rect: [0, 0, 10, 10] }));
    page.node.set(PDFLib.PDFName.of("Annots"), src.context.obj([link]));
    const { bytes } = await annotatePdf(PDFLib, new Uint8Array(await src.save()), [
      { level: "red", note: "x", parts: [part(1)] }
    ], pages);
    const doc = await PDFLib.PDFDocument.load(bytes);
    assert.deepEqual(annotsOf(doc, 0).map(subtype), ["/Link", "/Highlight", "/Text"]);
  });

  it("falls back to the part's box without snippet geometry and skips unknown pages", async () => {
    const { bytes, annotations } = await annotatePdf(PDFLib, await samplePdf(1), [
      { level: "red", note: "x", parts: [{ page: 1, x0: 72, y0: 600, x1: 300, y1: 650 }, { page: 9, items: [] }] }
    ], []);
    assert.equal(annotations, 2);
    const doc = await PDFLib.PDFDocument.load(bytes);
    assert.equal(annotsOf(doc, 0)[0].get(PDFLib.PDFName.of("QuadPoints")).asArray().length, 8);
  });

  it("refuses an encrypted PDF instead of writing a broken copy", async () => {
    const encrypted = Buffer.from(
      "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n" +
        "trailer<</Root 1 0 R/Encrypt<</Filter/Standard>>>>\n%%EOF"
    );
    await assert.rejects(annotatePdf(PDFLib, new Uint8Array(encrypted), [], []), /encrypt/i);
  });
});
