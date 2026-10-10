// Paragraphs from the text items of a PDF (issue #33). pdf.js delivers positioned text snippets, not paragraphs:
// this module rebuilds lines, drops page furniture (headers, footers, page numbers), splits and joins paragraphs
// and marks what must not be scored (headings, captions, tables, reference lists).
// Pure functions without DOM or pdf.js - tested with synthetic items (test/unit/pdf-paragraphs.test.mjs) and
// with generated PDFs (test/e2e/pdf-scan.test.mjs).
//
// Input  pages: [{ number, width, height, items: [{ str, x, y, w, h, eol }] }]
//        x, y = lower left of the snippet in PDF units (y grows upward), w = width, h = font height,
//        eol = pdf.js marked the end of a line after it.
// Output { paragraphs, pages: { total, withoutText: [page numbers] }, bodySize }
//        paragraph: { id, text, words, page, endPage, parts: [{ page, x0, y0, x1, y1 }], kind }
//        kind "text" is what gets scored; "heading", "caption", "table", "references" are kept as boundaries
//        (they interrupt grouping) but never scored.

const REFERENCE_HEADING = /^(references|bibliography|works cited|literature|literatur|literaturverzeichnis|quellenverzeichnis|quellen|bibliographie|r[ée]f[ée]rences|bibliograf[íi]a|riferimenti|bibliografia)\b/i;
const APPENDIX_HEADING = /^(appendix|appendices|anhang|anh[äa]nge|annex|annexe|anexo|allegato)\b/i;
const CAPTION = /^(figure|fig\.|table|tab\.|abbildung|abb\.|tabelle|diagram|grafik|chart)\s*\d+/i;
const BULLET = /^([•▪◦·●○■*–—-]|\(?\d{1,2}[.)]|\(?[a-z][.)])\s+\S/;
const NUMBERED_HEADING = /^\d+(\.\d+)*\.?\s+\p{L}/u;
const SENTENCE_END = /[.!?…:;"”’')\]]$/;

const MARGIN_BAND = 0.1; // top/bottom 10% of a page: header and footer area
const wordCount = (text) => text.split(/\s+/).filter(Boolean).length;

// --- Lines ------------------------------------------------------------------------------------

function buildLines(page) {
  const lines = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text.trim()) {
      cur.text = cur.text.replace(/\s+/g, " ").trim();
      cur.size = cur.sizeWeight ? cur.sizeSum / cur.sizeWeight : 10;
      lines.push(cur);
    }
    cur = null;
  };
  for (const it of page.items) {
    if (typeof it.str !== "string") continue;
    const size = it.h > 0 ? it.h : 10;
    const sameLine =
      cur && Math.abs(it.y - cur.y) <= Math.max(1.5, cur.size0 * 0.4) && it.x >= cur.x1 - cur.size0 * 0.3;
    if (!sameLine) {
      flush();
      cur = { page: page.number, text: "", x0: it.x, x1: it.x, y: it.y, size0: size, sizeSum: 0, sizeWeight: 0 };
    }
    const gap = it.x - cur.x1;
    // a visible gap between snippets without a space on either side is a word break
    if (cur.text && gap > size * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += " ";
    cur.text += it.str;
    cur.x1 = Math.max(cur.x1, it.x + (it.w || 0));
    cur.sizeSum += size * it.str.length;
    cur.sizeWeight += it.str.length;
    if (it.eol) flush();
  }
  flush();
  return lines;
}

// Weighted median of the line heights by text length = the size of the body text
function bodySizeOf(lines) {
  const sized = lines.map((l) => [l.size, l.text.length]).sort((a, b) => a[0] - b[0]);
  const total = sized.reduce((n, [, w]) => n + w, 0);
  let acc = 0;
  for (const [size, w] of sized) {
    acc += w;
    if (acc >= total / 2) return size;
  }
  return 10;
}

// --- Page furniture ---------------------------------------------------------------------------

const normalizeFurniture = (text) => text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
const isPageNumber = (text) => /^(page|seite|p\.|s\.)?\s*[-–—]?\s*\d{1,4}\s*([-–—]|\/\s*\d{1,4}|of\s+\d{1,4}|von\s+\d{1,4})?$/i.test(text);

function inMargin(line, page) {
  const band = page.height * MARGIN_BAND;
  return line.y < band || line.y > page.height - band;
}

// Lines in the margin bands that repeat on many pages (running title, author, date) or are only a page number
function furnitureKeys(pages, linesByPage) {
  const counts = new Map();
  pages.forEach((page, i) => {
    const seen = new Set();
    for (const line of linesByPage[i]) {
      if (!inMargin(line, page)) continue;
      const key = normalizeFurniture(line.text);
      if (key && !seen.has(key)) {
        seen.add(key);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
  });
  const need = Math.max(2, Math.ceil(pages.length * 0.4));
  return new Set([...counts].filter(([, n]) => n >= need).map(([key]) => key));
}

// --- Paragraphs -------------------------------------------------------------------------------

function paragraphsOfPage(page, lines, body) {
  const paras = [];
  let cur = null;
  let colRight = 0; // right edge of the column so far
  const close = () => {
    if (cur) paras.push(cur);
    cur = null;
  };
  for (const line of lines) {
    let split = !cur;
    if (cur) {
      const prev = cur.lines[cur.lines.length - 1];
      const leading = prev.y - line.y; // > 0: next line lies below
      split =
        Math.abs(line.size - prev.size) > body * 0.12 || // size change: heading or caption
        leading < -prev.size * 0.5 || // jumps up: next column
        leading > Math.max(line.size, prev.size) * 1.75 || // larger gap: next paragraph
        line.x0 > cur.leftEdge + Math.max(line.size, prev.size) * 0.8 || // first-line indent
        (prev.x1 < colRight - body * 3 && SENTENCE_END.test(prev.text)) || // short last line of a paragraph
        BULLET.test(line.text) ||
        (isHeadingLine(line.text) && SENTENCE_END.test(prev.text)) || // "2.1 Method" right after a sentence
        (cur.lines.length === 1 && isHeadingLine(prev.text)); // text right after a one-line heading
    }
    if (split) {
      if (cur && leadingJump(cur, line)) colRight = 0;
      close();
      cur = { lines: [], leftEdge: line.x0 };
    }
    cur.lines.push(line);
    cur.leftEdge = Math.min(cur.leftEdge, line.x0);
    colRight = Math.max(colRight, line.x1);
  }
  close();
  return paras;
}

// Short numbered line without sentence punctuation ("2.1 Method"), or a short line in capitals
function isHeadingLine(text) {
  if (wordCount(text) > 8 || /[.!?:,;]$/.test(text)) return false;
  return NUMBERED_HEADING.test(text) || (/\p{L}/u.test(text) && text === text.toUpperCase());
}

// A new column starts when the next line lies clearly above the previous one
function leadingJump(cur, line) {
  const prev = cur.lines[cur.lines.length - 1];
  return line.y > prev.y + prev.size * 0.5;
}

// Join the lines of a paragraph: "exam-" + "ple" -> "example" (only before a lowercase letter, otherwise the hyphen
// belongs to the word, e.g. "AI-" + "Detector")
function joinLines(lines) {
  let text = "";
  for (const { text: t } of lines) {
    if (!text) text = t;
    else if (/\p{L}-$/u.test(text) && /^\p{Ll}/u.test(t)) text = text.slice(0, -1) + t;
    else text += ` ${t}`;
  }
  return text;
}

function partsOf(lines) {
  const byPage = new Map();
  for (const l of lines) {
    const p = byPage.get(l.page) || { page: l.page, x0: l.x0, y0: l.y, x1: l.x1, y1: l.y + l.size };
    p.x0 = Math.min(p.x0, l.x0);
    p.y0 = Math.min(p.y0, l.y);
    p.x1 = Math.max(p.x1, l.x1);
    p.y1 = Math.max(p.y1, l.y + l.size);
    byPage.set(l.page, p);
  }
  return [...byPage.values()];
}

function classify(para, body) {
  const text = para.text;
  const words = wordCount(text);
  const lines = para.lines;
  const size = lines.reduce((n, l) => n + l.size * l.text.length, 0) / lines.reduce((n, l) => n + l.text.length, 0);
  const single = lines.length === 1;
  if (CAPTION.test(text) && words <= 60) return "caption";
  if (size >= body * 1.12 && lines.length <= 3 && words <= 25) return "heading";
  if (single && isHeadingLine(text)) return "heading";
  const letters = (text.match(/\p{L}/gu) || []).length;
  const nonSpace = text.replace(/\s/g, "").length || 1;
  if (letters / nonSpace < 0.65) return "table"; // numbers, formulas, table rows
  if (/^\[\d+\]/.test(text)) return "references";
  return "text";
}

/**
 * @param {{ number: number, width: number, height: number, items: object[] }[]} pages
 */
export function extractParagraphs(pages) {
  const linesByPage = pages.map(buildLines);
  const withoutText = pages
    .filter((_, i) => linesByPage[i].reduce((n, l) => n + l.text.length, 0) < 20)
    .map((p) => p.number);
  const furniture = furnitureKeys(pages, linesByPage);

  // Page furniture out, then the size of the body text from what is left
  const kept = pages.map((page, i) =>
    linesByPage[i].filter(
      (l) => !(inMargin(l, page) && (furniture.has(normalizeFurniture(l.text)) || isPageNumber(l.text)))
    )
  );
  const body = bodySizeOf(kept.flat());

  const all = [];
  pages.forEach((page, i) => {
    for (const para of paragraphsOfPage(page, kept[i], body)) {
      const text = joinLines(para.lines);
      all.push({
        text,
        words: wordCount(text),
        page: page.number,
        endPage: page.number,
        parts: partsOf(para.lines),
        kind: classify({ text, lines: para.lines }, body),
        lastLine: para.lines[para.lines.length - 1]
      });
    }
  });

  // A paragraph that continues on the next page: no sentence end and the next one starts in lowercase
  const merged = [];
  for (const p of all) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.kind === "text" &&
      p.kind === "text" &&
      p.page === prev.endPage + 1 &&
      (!SENTENCE_END.test(prev.text) || /\p{L}-$/u.test(prev.text)) &&
      /^\p{Ll}/u.test(p.text)
    ) {
      prev.text = joinLines([{ text: prev.text }, { text: p.text }]);
      prev.words = wordCount(prev.text);
      prev.endPage = p.endPage;
      prev.parts.push(...p.parts);
      continue;
    }
    merged.push(p);
  }

  // Everything after a "References" heading until an appendix is a list of sources, not prose
  let inReferences = false;
  merged.forEach((p, i) => {
    if (p.kind === "heading") {
      const title = p.text.replace(/^\d+(\.\d+)*\.?\s*/, "");
      if (REFERENCE_HEADING.test(title)) inReferences = true;
      else if (APPENDIX_HEADING.test(title)) inReferences = false;
    } else if (inReferences && p.kind !== "caption") {
      p.kind = "references";
    }
    p.id = `p${i + 1}`;
    delete p.lastLine;
  });

  return { paragraphs: merged, pages: { total: pages.length, withoutText }, bodySize: body };
}
