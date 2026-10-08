// Grouping of short paragraphs (TODO.md item 2, extension/content.js: groupCandidates). Adjacent
// paragraphs below reliableWords in the same container are scored as one text; heading, list,
// another language or a paragraph that is already long on its own break the chain, a group only grows up to
// maxChars (AIVSAI.maxChars, here TMR = 2000 characters).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend } from "./helpers.mjs";

// 3 repetitions = 40 words, 219 characters - well below reliableWords (120), but >= 40 (candidate)
const WORD = "the small garden needs water and sunlight every single day to grow well ";
const short = (tag, reps = 3) => `${tag}: ${WORD.repeat(reps)}`;
// 9 repetitions = 118 words, 650 characters - still "short" (< 120), but already large in characters
const chunky = (tag) => short(tag, 9);
// 2 repetitions = 27 words - below MIN_WORDS (40), but >= GROUP_MIN_WORDS (15, WP-10): only becomes a
// candidate if the group together with neighbors reaches MIN_WORDS (see below, "very short paragraphs")
const tiny = (tag) => short(tag, 2);
// >= 40 words (MIN_WORDS) - otherwise the paragraph would not be a candidate at all and would not visibly break the chain
// when grouping (found would not even contain it then)
const GERMAN =
  '<p id="l2" lang="de">Die Wärmeleitfähigkeit von Kupfer liegt bei etwa 401 W pro Meter Kelvin und damit ' +
  "deutlich über der von Aluminium, wie unsere Messreihen unter stabilen Laborbedingungen mit gereinigten " +
  "Proben und kalibrierten Sensoren über mehrere Wochen hinweg wiederholt gezeigt haben, wobei auch die " +
  "Temperatur des Raumes sorgfältig konstant gehalten wurde.</p>";

const page =
  "<html><body>" +
  // Case 1: four short paragraphs in the same article, directly one after another -> one group, together >= 120 words
  `<article id="grp-basic"><p id="b1">${short("B1")}</p><p id="b2">${short("B2")}</p>` +
  `<p id="b3">${short("B3")}</p><p id="b4">${short("B4")}</p></article>` +
  // Case 2: heading between two short paragraphs -> breaks the grouping at this point
  `<article id="grp-heading"><p id="h1">${short("H1")}</p><h2>Subheading</h2>` +
  `<p id="h2p">${short("H2P")}</p><p id="h3p">${short("H3P")}</p></article>` +
  // Case 3: paragraph in another language in between -> breaks the grouping, is not scored itself
  `<article id="grp-lang"><p id="l1">${short("L1")}</p>${GERMAN}<p id="l3">${short("L3")}</p></article>` +
  // Case 4: a paragraph that is already long (reliable) on its own stays single and breaks the chain
  `<article id="grp-long"><p id="g1">${short("G1")}</p><p id="glong">${short("GLONG", 10)}</p>` +
  `<p id="g2">${short("G2")}</p></article>` +
  // Case 5: four short but character-rich paragraphs - the group must not exceed maxChars (2000)
  `<article id="grp-maxchars"><p id="m1">${chunky("M1")}</p><p id="m2">${chunky("M2")}</p>` +
  `<p id="m3">${chunky("M3")}</p><p id="m4">${chunky("M4")}</p></article>` +
  // Case 6 (WP-10): three very short paragraphs (27 each < MIN_WORDS) in the same article, together 81 words
  // (>= MIN_WORDS) -> become a candidate as a group; the container itself must NOT additionally
  // be scored (hasLongCandidateChild).
  `<article id="grp-short-basic"><p id="sa1">${tiny("SA1")}</p><p id="sa2">${tiny("SA2")}</p>` +
  `<p id="sa3">${tiny("SA3")}</p></article>` +
  // Case 7 (WP-10): a single very short paragraph without neighbors does not reach MIN_WORDS on its own (27 words)
  // -> stays unscored, no candidate (the container neither).
  `<article id="grp-short-lonely"><p id="sl1">${tiny("SL1")}</p></article>` +
  // Case 8 (WP-10): a heading still breaks the grouping below MIN_WORDS too - SH1 stays
  // isolated and unscored as a result, SH2+SH3 after it together (54 words) reach MIN_WORDS.
  `<article id="grp-short-heading"><p id="sh1">${tiny("SH1")}</p><h3>Subheading</h3>` +
  `<p id="sh2">${tiny("SH2")}</p><p id="sh3">${tiny("SH3")}</p></article>` +
  // Case 9 (WP-10): a list still breaks the grouping below MIN_WORDS too - SI1 stays isolated
  // and unscored, SI2+SI3 after it together reach MIN_WORDS.
  `<article id="grp-short-list"><p id="si1">${tiny("SI1")}</p><ul><li>Menu</li></ul>` +
  `<p id="si2">${tiny("SI2")}</p><p id="si3">${tiny("SI3")}</p></article>` +
  "</body></html>";

/** Center of the percent badge (::after, top right of the paragraph, see content.css) */
const badgeCenter = (tab, sel) =>
  tab.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const b = getComputedStyle(el, "::after");
    return { x: r.right + 6 - (parseFloat(b.width) + 12) / 2, y: r.top - 12 + parseFloat(b.height) / 2 };
  });

describe("Grouping of short paragraphs", () => {
  let backend, ext, tab;

  before(async () => {
    backend = await startBackend(() => 0.5); // green for TMR (yellowFrom 0.95) - focus is on grouping, not the traffic light
    ext = await launchExtension({ pages: { "grouping.test": page }, viewport: { width: 900, height: 2000 } });
    await ext.configure({ provider: "local", localUrl: backend.url, sites: ["grouping.test"], lazyScan: false });
    tab = await ext.open("http://grouping.test/");
    await tab.waitForFunction(
      () => !document.querySelector(".aivsai-pending") && document.querySelectorAll("[data-aivsai-level], [data-aivsai-skipped]").length >= 24,
      null,
      { timeout: 20_000 }
    );
  });

  after(async () => {
    await ext?.close();
    await backend?.close();
  });

  it("scores four short, directly adjacent paragraphs in the same article as one group", async () => {
    const recs = await tab.$$eval(["#b1", "#b2", "#b3", "#b4"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped, words: e.dataset.aivsaiWords, score: e.dataset.aivsaiScore }))
    );
    assert.deepEqual(
      recs.map((r) => r.grouped),
      ["4", "4", "4", "4"]
    );
    assert.deepEqual(
      recs.map((r) => r.words),
      ["160", "160", "160", "160"]
    );
    assert.equal(new Set(recs.map((r) => r.score)).size, 1, "all four should share the same score");
    assert.ok(
      backend.texts.some((t) => ["B1:", "B2:", "B3:", "B4:"].every((tag) => t.includes(tag))),
      "no backend text contains all four paragraphs together"
    );

    // Popover makes the grouping visible (badge click on one of the four paragraphs)
    const { x, y } = await badgeCenter(tab, "#b1");
    await tab.mouse.click(x, y);
    await tab.waitForFunction(() => /Hint, not proof/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await tab.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /4 adjacent, short paragraphs/);
    await tab.keyboard.press("Escape");
  });

  it("breaks the grouping at a heading", async () => {
    const [h1, h2p, h3p] = await tab.$$eval(["#h1", "#h2p", "#h3p"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(h1.grouped, null, "h1 should be scored alone");
    assert.equal(h2p.grouped, "2");
    assert.equal(h3p.grouped, "2");
    assert.equal(h2p.score, h3p.score);
    assert.ok(
      backend.texts.some((t) => t.includes("H2P:") && t.includes("H3P:")),
      "H2P and H3P should have been sent together"
    );
    assert.ok(
      !backend.texts.some((t) => t.includes("H1:") && t.includes("H2P:")),
      "H1 should not have been grouped with H2P"
    );
    assert.ok(!backend.texts.some((t) => t.includes("Subheading")), "heading was sent along");
  });

  it("breaks the grouping at a paragraph in another language", async () => {
    const [l1, l3] = await tab.$$eval(["#l1", "#l3"].join(","), (els) => els.map((e) => e.dataset.aivsaiGrouped ?? null));
    assert.equal(l1, null, "l1 should not have been grouped across the German paragraph");
    assert.equal(l3, null);
    assert.equal(await tab.$eval("#l2", (e) => e.dataset.aivsaiSkipped), "de");
    assert.ok(!backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")), "German text went to the backend");
    assert.ok(
      !backend.texts.some((t) => t.includes("L1:") && t.includes("L3:")),
      "L1 and L3 should not have been grouped"
    );
  });

  it("breaks the grouping at a paragraph that is already long on its own", async () => {
    const [g1, glong, g2] = await tab.$$eval(["#g1", "#glong", "#g2"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, level: e.dataset.aivsaiLevel, words: Number(e.dataset.aivsaiWords) }))
    );
    assert.equal(g1.grouped, null);
    assert.equal(g2.grouped, null);
    assert.equal(glong.grouped, null);
    assert.ok(glong.words >= 120, "glong should reach reliableWords on its own");
    assert.notEqual(glong.level, "uncertain");
    assert.ok(
      !backend.texts.some((t) => t.includes("G1:") && t.includes("G2:")),
      "G1 and G2 should not have been grouped across GLONG"
    );
  });

  it("does not let a group grow beyond maxChars (the rest forms a new group)", async () => {
    const recs = await tab.$$eval(["#m1", "#m2", "#m3", "#m4"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    const [m1, m2, m3, m4] = recs;
    assert.deepEqual([m1.grouped, m2.grouped, m3.grouped], ["3", "3", "3"]);
    assert.equal(m4.grouped, null, "M4 would have broken the 2000-character limit and should stay single");
    assert.equal(m1.score, m2.score);
    assert.equal(m2.score, m3.score);

    const merged = backend.texts.find((t) => t.includes("M1:") && t.includes("M2:") && t.includes("M3:"));
    assert.ok(merged, "M1-M3 should have been sent together");
    assert.ok(merged.length <= 2000, `group text ${merged.length} characters over maxChars`);
    assert.ok(
      !backend.texts.some((t) => t.includes("M3:") && t.includes("M4:")),
      "M4 should not have been grouped with M1-M3"
    );
  });

  it("groups very short paragraphs (each under MIN_WORDS) into a group from MIN_WORDS (WP-10)", async () => {
    const recs = await tab.$$eval(["#sa1", "#sa2", "#sa3"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped, words: e.dataset.aivsaiWords, score: e.dataset.aivsaiScore }))
    );
    assert.deepEqual(
      recs.map((r) => r.grouped),
      ["3", "3", "3"]
    );
    assert.deepEqual(
      recs.map((r) => r.words),
      ["81", "81", "81"]
    );
    assert.equal(new Set(recs.map((r) => r.score)).size, 1, "all three should share the same score");
    assert.ok(
      backend.texts.some((t) => ["SA1:", "SA2:", "SA3:"].every((tag) => t.includes(tag))),
      "no backend text contains all three paragraphs together"
    );
    // The container itself must NOT additionally be scored as a whole (no duplicate, hasLongCandidateChild)
    assert.equal(await tab.$eval("#grp-short-basic", (el) => el.dataset.aivsaiLevel ?? null), null);
  });

  it("leaves a single very short paragraph without neighbors unscored (WP-10)", async () => {
    const sl1 = await tab.$eval("#sl1", (el) => ({
      level: el.dataset.aivsaiLevel ?? null,
      pending: el.classList.contains("aivsai-pending"),
      badge: el.classList.contains("aivsai-badge")
    }));
    assert.deepEqual(sl1, { level: null, pending: false, badge: false });
    assert.ok(!backend.texts.some((t) => t.includes("SL1:")), "SL1 should never have gone to the backend");
    // the container stays unscored too (no substitute candidate for the isolated short paragraph)
    assert.equal(await tab.$eval("#grp-short-lonely", (el) => el.dataset.aivsaiLevel ?? null), null);
  });

  it("still breaks the grouping of very short paragraphs at a heading (WP-10)", async () => {
    const [sh1, sh2, sh3] = await tab.$$eval(["#sh1", "#sh2", "#sh3"].join(","), (els) =>
      els.map((e) => ({ level: e.dataset.aivsaiLevel ?? null, grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(sh1.level, null, "SH1 should stay isolated and unscored (27 words alone < MIN_WORDS)");
    assert.equal(sh2.grouped, "2");
    assert.equal(sh3.grouped, "2");
    assert.equal(sh2.score, sh3.score);
    assert.ok(backend.texts.some((t) => t.includes("SH2:") && t.includes("SH3:")), "SH2 and SH3 should have been sent together");
    assert.ok(!backend.texts.some((t) => t.includes("SH1:")), "SH1 should never have gone to the backend");
  });

  it("still breaks the grouping of very short paragraphs at a list (WP-10)", async () => {
    const [si1, si2, si3] = await tab.$$eval(["#si1", "#si2", "#si3"].join(","), (els) =>
      els.map((e) => ({ level: e.dataset.aivsaiLevel ?? null, grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(si1.level, null, "SI1 should stay isolated and unscored (27 words alone < MIN_WORDS)");
    assert.equal(si2.grouped, "2");
    assert.equal(si3.grouped, "2");
    assert.equal(si2.score, si3.score);
    assert.ok(backend.texts.some((t) => t.includes("SI2:") && t.includes("SI3:")), "SI2 and SI3 should have been sent together");
    assert.ok(!backend.texts.some((t) => t.includes("SI1:")), "SI1 should never have gone to the backend");
    assert.ok(!backend.texts.some((t) => t.includes("Menu")), "the list item should never have gone to the backend");
  });

  it("has no console errors", () => {
    assert.deepEqual(ext.errors, []);
  });
});
