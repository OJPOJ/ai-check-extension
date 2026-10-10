// Annotated copy of a scanned PDF (issue #42): highlight annotations in the level colors plus a note with the score
// on flagged paragraphs. Works on the bytes of the original with pdf-lib (bundled, vendor/pdf-lib.esm.min.js); the
// original file is never touched, the result is a new byte array.
// Pure function, the library is passed in - tested in test/unit/pdf-annotate.test.mjs.
//
// Input  PDFLib   the pdf-lib module (PDFDocument, PDFName, PDFString, PDFNumber)
//        bytes    Uint8Array of the original PDF
//        marks    [{ level, note, parts: [{ page, items: [indices into pages[].items], x0, y0, x1, y1 }] }]
//        pages    [{ number, items: [{ x, y, w, h }] }] as given to extractParagraphs() (PDF units, y upward)
// Output Uint8Array of the copy

// rgb 0..1, same hues as the marking in the viewer
const COLORS = {
  green: [0.086, 0.639, 0.29],
  yellow: [0.918, 0.702, 0.031],
  red: [0.863, 0.149, 0.149],
  uncertain: [0.42, 0.447, 0.502]
};
const AUTHOR = "AI Content Flag";
const NOTE_LEVELS = new Set(["red", "yellow"]);

// One rectangle per visual line: snippets on the same baseline are merged
function lineRects(part, items) {
  const rects = [];
  for (const idx of part.items || []) {
    const it = items[idx];
    if (!it || !(it.w > 0) || !(it.h > 0)) continue;
    const r = { x0: it.x, x1: it.x + it.w, y0: it.y - it.h * 0.22, y1: it.y + it.h * 0.9 };
    const last = rects[rects.length - 1];
    if (last && Math.abs(last.base - it.y) <= it.h * 0.4) {
      last.x0 = Math.min(last.x0, r.x0);
      last.x1 = Math.max(last.x1, r.x1);
      last.y0 = Math.min(last.y0, r.y0);
      last.y1 = Math.max(last.y1, r.y1);
    } else {
      rects.push({ ...r, base: it.y });
    }
  }
  if (rects.length) return rects;
  // no snippet geometry: the box of the part as a whole
  return Number.isFinite(part.x0) ? [{ x0: part.x0, x1: part.x1, y0: part.y0 - 2, y1: part.y1 }] : [];
}

const pdfDate = (d) => {
  const p = (n) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
};

export async function annotatePdf(PDFLib, bytes, marks, pages, now = new Date()) {
  const { PDFDocument, PDFName, PDFString } = PDFLib;
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const ctx = doc.context;
  const docPages = doc.getPages();
  const itemsOf = new Map(pages.map((p) => [p.number, p.items]));
  const modified = PDFString.of(pdfDate(now));
  const perPage = new Map(); // page index -> [annotation refs]
  let count = 0;

  const addTo = (index, dict) => {
    const ref = ctx.register(ctx.obj(dict));
    if (!perPage.has(index)) perPage.set(index, []);
    perPage.get(index).push(ref);
    count++;
  };

  for (const mark of marks) {
    const color = COLORS[mark.level];
    if (!color) continue;
    let noted = false;
    for (const part of mark.parts) {
      const index = part.page - 1;
      if (!docPages[index]) continue;
      const rects = lineRects(part, itemsOf.get(part.page) || []);
      if (!rects.length) continue;
      const quads = rects.flatMap((r) => [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]);
      const bounds = [
        Math.min(...rects.map((r) => r.x0)),
        Math.min(...rects.map((r) => r.y0)),
        Math.max(...rects.map((r) => r.x1)),
        Math.max(...rects.map((r) => r.y1))
      ];
      addTo(index, {
        Type: "Annot",
        Subtype: "Highlight",
        Rect: bounds,
        QuadPoints: quads,
        C: color,
        CA: 0.35,
        F: 4, // print
        T: PDFString.of(AUTHOR),
        M: modified,
        ...(mark.note ? { Contents: PDFString.of(mark.note) } : {})
      });
      // note (sticky note icon) at the top left of the first part of a flagged paragraph
      if (!noted && mark.note && NOTE_LEVELS.has(mark.level)) {
        noted = true;
        const x = bounds[0];
        const y = bounds[3];
        addTo(index, {
          Type: "Annot",
          Subtype: "Text",
          Rect: [x - 20, y - 18, x - 2, y],
          Name: "Note",
          Open: false,
          C: color,
          F: 4 | 8 | 16, // print, no zoom, no rotate
          T: PDFString.of(AUTHOR),
          M: modified,
          Contents: PDFString.of(mark.note)
        });
      }
    }
  }

  for (const [index, refs] of perPage) {
    const page = docPages[index];
    const existing = page.node.lookup(PDFName.of("Annots"));
    if (existing && typeof existing.push === "function") for (const r of refs) existing.push(r);
    else page.node.set(PDFName.of("Annots"), ctx.obj(refs));
  }
  doc.setModificationDate(now);
  const out = await doc.save();
  return { bytes: out, annotations: count };
}
