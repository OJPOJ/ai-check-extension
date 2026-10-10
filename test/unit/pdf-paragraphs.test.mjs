// Paragraph extraction from PDF text items (extension/pdf-paragraphs.js), with synthetic layouts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractParagraphs } from "../../extension/pdf-paragraphs.js";

const W = 600;
const H = 800;
const SIZE = 10;
const LEADING = 13;

// One snippet per line. lines: [text, { x, size, eol }]; y runs downward from `top`
function page(number, lines, { top = 700, x = 72 } = {}) {
  let y = top;
  const items = [];
  for (const spec of lines) {
    if (spec === null) {
      y -= LEADING * 1.2; // blank space between paragraphs
      continue;
    }
    const [str, o = {}] = typeof spec === "string" ? [spec] : spec;
    const size = o.size ?? SIZE;
    items.push({ str, x: o.x ?? x, y: o.y ?? y, w: str.length * size * 0.5, h: size, eol: true });
    y -= o.size ? o.size * 1.4 : LEADING;
  }
  return { number, width: W, height: H, items };
}

const prose = (n) => `Sentence number ${n} talks about gardening and soil and water.`;
const texts = (res, kind = "text") => res.paragraphs.filter((p) => p.kind === kind).map((p) => p.text);

describe("extractParagraphs", () => {
  it("splits paragraphs by vertical gap and joins the lines of one paragraph", () => {
    const res = extractParagraphs([
      page(1, [prose(1), prose(2), prose(3), null, prose(4), prose(5), prose(6)])
    ]);
    assert.equal(texts(res).length, 2);
    assert.equal(texts(res)[0], `${prose(1)} ${prose(2)} ${prose(3)}`);
  });

  it("splits at a modest extra space between paragraphs, measured against the document's line spacing", () => {
    // line spacing 13, paragraph spacing 19.5 (one half line of extra space) - no indent, no short last line
    const para = (top, n) =>
      [0, 1, 2].map((i) => ({ str: prose(n + i), x: 72, y: top - i * 13, w: 400, h: SIZE, eol: true }));
    const items = [...para(700, 1), ...para(700 - 2 * 13 - 19.5, 4), ...para(700 - 4 * 13 - 39, 7)];
    const res = extractParagraphs([{ number: 1, width: W, height: H, items }]);
    assert.equal(texts(res).length, 3);
  });

  it("keeps normal line spacing inside one paragraph, whatever the font size", () => {
    const items = [0, 1, 2, 3].map((i) => ({ str: prose(i), x: 72, y: 700 - i * 17, w: 400, h: 14, eol: true }));
    const res = extractParagraphs([{ number: 1, width: W, height: H, items }]);
    assert.equal(texts(res).length, 1);
  });

  it("reports the text-layer item positions of a paragraph", () => {
    const res = extractParagraphs([page(1, [prose(1), prose(2), null, prose(3)])]);
    assert.deepEqual(res.paragraphs[0].parts[0].items, [0, 1]);
    assert.deepEqual(res.paragraphs[1].parts[0].items, [2]);
  });

  it("joins a word hyphenated at the line end, but keeps hyphens before capitals", () => {
    const res = extractParagraphs([
      page(1, ["A very long exam-", "ple of a hyphenated word and the AI-", "Detector that follows it."])
    ]);
    assert.equal(texts(res)[0], "A very long example of a hyphenated word and the AI- Detector that follows it.");
  });

  it("starts a new paragraph at a first-line indent", () => {
    const res = extractParagraphs([
      page(1, [
        ["Indented first line of the first paragraph goes on", { x: 90 }],
        "and continues at the left margin until it ends here.",
        ["Indented first line of the second paragraph", { x: 90 }],
        "and also continues at the left margin of the page."
      ])
    ]);
    assert.equal(texts(res).length, 2);
  });

  it("marks larger text as heading and numbered short lines as heading, and does not mix them into prose", () => {
    const res = extractParagraphs([
      page(1, [
        ["Introduction to the topic", { size: 16 }],
        prose(1),
        prose(2),
        "2.1 Method",
        prose(3),
        prose(4)
      ])
    ]);
    assert.deepEqual(texts(res, "heading"), ["Introduction to the topic", "2.1 Method"]);
    assert.equal(texts(res).length, 2);
  });

  it("drops running headers, footers and page numbers", () => {
    const pages = [1, 2, 3].map((n) =>
      page(n, [
        ["Running title of the report", { y: 780 }],
        prose(n),
        prose(n + 10),
        [`${n}`, { y: 30 }]
      ])
    );
    const res = extractParagraphs(pages);
    assert.equal(res.paragraphs.length, 3);
    assert.ok(res.paragraphs.every((p) => !/Running title|^\d+$/.test(p.text)));
  });

  it("joins a paragraph that continues on the next page", () => {
    const res = extractParagraphs([
      page(1, [prose(1), "This sentence is cut at the end of the page and"]),
      page(2, ["continues here on the following page of the file.", null, prose(9)])
    ]);
    assert.equal(texts(res).length, 2);
    const first = res.paragraphs[0];
    assert.equal(first.page, 1);
    assert.equal(first.endPage, 2);
    assert.match(first.text, /cut at the end of the page and continues here/);
    assert.equal(first.parts.length, 2);
  });

  it("does not join across pages after a sentence end or before a capital letter", () => {
    const res = extractParagraphs([page(1, [prose(1)]), page(2, [prose(2)])]);
    assert.equal(texts(res).length, 2);
  });

  it("starts a new paragraph when the next line jumps up (second column)", () => {
    const left = [prose(1), prose(2)].map((t, i) => [t, { x: 72, y: 700 - i * LEADING }]);
    const right = [prose(3), prose(4)].map((t, i) => [t, { x: 330, y: 700 - i * LEADING }]);
    const res = extractParagraphs([page(1, [...left, ...right])]);
    assert.deepEqual(texts(res), [`${prose(1)} ${prose(2)}`, `${prose(3)} ${prose(4)}`]);
  });

  it("treats list items as their own paragraphs", () => {
    const res = extractParagraphs([page(1, ["• first point of the list", "• second point of the list"])]);
    assert.equal(res.paragraphs.length, 2);
  });

  it("does not score captions, tables and everything after a References heading", () => {
    const res = extractParagraphs([
      page(1, [
        prose(1),
        null,
        "Figure 3: A picture of the garden in spring",
        null,
        "12 45 78 90 12 45 78 90 33 44 55 66",
        null,
        ["References", { size: 14 }],
        "Smith, J. (2020). A paper about plants. Journal of Plants, 3(2), 1-10.",
        "Miller, K. (2019). Another paper about soil. Soil Journal, 1(1), 5-9."
      ])
    ]);
    assert.equal(texts(res).length, 1);
    assert.equal(texts(res, "caption").length, 1);
    assert.equal(texts(res, "table").length, 1);
    assert.ok(texts(res, "references").length >= 1);
  });

  it("resumes prose after an appendix heading", () => {
    const res = extractParagraphs([
      page(1, [["References", { size: 14 }], "Smith, J. (2020). A paper about plants. Journal of Plants.", null,
        ["Appendix A", { size: 14 }], prose(1), prose(2)])
    ]);
    assert.equal(texts(res).length, 1);
    assert.equal(texts(res, "references").length, 1);
  });

  it("reports pages without a text layer (scans)", () => {
    const res = extractParagraphs([page(1, [prose(1), prose(2)]), page(2, []), page(3, ["x"])]);
    assert.deepEqual(res.pages.withoutText, [2, 3]);
    assert.equal(res.pages.total, 3);
  });

  it("keeps stable ids in reading order and a bounding box per page part", () => {
    const res = extractParagraphs([page(1, [prose(1), null, prose(2)])]);
    assert.deepEqual(res.paragraphs.map((p) => p.id), ["p1", "p2"]);
    const [part] = res.paragraphs[0].parts;
    assert.ok(part.x1 > part.x0 && part.y1 > part.y0);
  });
});
