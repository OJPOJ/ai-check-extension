// Gruppierung kurzer Absätze (TODO.md Punkt 2, extension/content.js: groupCandidates). Benachbarte
// Absätze unter reliableWords im selben Container werden als ein Text bewertet; Überschrift, Liste,
// andere Sprache oder ein für sich schon langer Absatz brechen die Kette, eine Gruppe wächst nur bis
// maxChars (AIVSAI.maxChars, hier TMR = 2000 Zeichen).
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { launchExtension, startBackend } from "./helpers.mjs";

// 3 Wiederholungen = 40 Wörter, 219 Zeichen - deutlich unter reliableWords (120), aber >= 40 (Kandidat)
const WORD = "the small garden needs water and sunlight every single day to grow well ";
const short = (tag, reps = 3) => `${tag}: ${WORD.repeat(reps)}`;
// 9 Wiederholungen = 118 Wörter, 650 Zeichen - noch "kurz" (< 120), aber schon groß in Zeichen
const chunky = (tag) => short(tag, 9);
// 2 Wiederholungen = 27 Wörter - unter MIN_WORDS (40), aber >= GROUP_MIN_WORDS (15, WP-10): wird nur
// Kandidat, wenn die Gruppe mit Nachbarn zusammen auf MIN_WORDS kommt (siehe unten, "sehr kurze Absätze")
const tiny = (tag) => short(tag, 2);
// >= 40 Wörter (MIN_WORDS) - sonst wäre der Absatz gar kein Kandidat und würde die Kette beim
// Gruppieren nicht sichtbar unterbrechen (found enthielte ihn dann gar nicht erst)
const GERMAN =
  '<p id="l2" lang="de">Die Wärmeleitfähigkeit von Kupfer liegt bei etwa 401 W pro Meter Kelvin und damit ' +
  "deutlich über der von Aluminium, wie unsere Messreihen unter stabilen Laborbedingungen mit gereinigten " +
  "Proben und kalibrierten Sensoren über mehrere Wochen hinweg wiederholt gezeigt haben, wobei auch die " +
  "Temperatur des Raumes sorgfältig konstant gehalten wurde.</p>";

const page =
  "<html><body>" +
  // Fall 1: vier kurze Absätze im selben Artikel, direkt hintereinander -> eine Gruppe, zusammen >= 120 Wörter
  `<article id="grp-basic"><p id="b1">${short("B1")}</p><p id="b2">${short("B2")}</p>` +
  `<p id="b3">${short("B3")}</p><p id="b4">${short("B4")}</p></article>` +
  // Fall 2: Überschrift zwischen zwei kurzen Absätzen -> bricht die Gruppierung an dieser Stelle
  `<article id="grp-heading"><p id="h1">${short("H1")}</p><h2>Zwischenüberschrift</h2>` +
  `<p id="h2p">${short("H2P")}</p><p id="h3p">${short("H3P")}</p></article>` +
  // Fall 3: anderssprachiger Absatz dazwischen -> bricht die Gruppierung, wird selbst nicht bewertet
  `<article id="grp-lang"><p id="l1">${short("L1")}</p>${GERMAN}<p id="l3">${short("L3")}</p></article>` +
  // Fall 4: ein für sich schon langer (zuverlässiger) Absatz bleibt einzeln und bricht die Kette
  `<article id="grp-long"><p id="g1">${short("G1")}</p><p id="glong">${short("GLONG", 10)}</p>` +
  `<p id="g2">${short("G2")}</p></article>` +
  // Fall 5: vier kurze, aber zeichenreiche Absätze - die Gruppe darf maxChars (2000) nicht überschreiten
  `<article id="grp-maxchars"><p id="m1">${chunky("M1")}</p><p id="m2">${chunky("M2")}</p>` +
  `<p id="m3">${chunky("M3")}</p><p id="m4">${chunky("M4")}</p></article>` +
  // Fall 6 (WP-10): drei sehr kurze Absätze (je 27 < MIN_WORDS) im selben Artikel, zusammen 81 Wörter
  // (>= MIN_WORDS) -> werden als Gruppe zum Kandidaten; der Container selbst darf NICHT zusätzlich
  // bewertet werden (hasLongCandidateChild).
  `<article id="grp-short-basic"><p id="sa1">${tiny("SA1")}</p><p id="sa2">${tiny("SA2")}</p>` +
  `<p id="sa3">${tiny("SA3")}</p></article>` +
  // Fall 7 (WP-10): ein einzelner sehr kurzer Absatz ohne Nachbarn erreicht mit sich allein (27 Wörter)
  // MIN_WORDS nicht -> bleibt unbewertet, kein Kandidat (auch der Container nicht).
  `<article id="grp-short-lonely"><p id="sl1">${tiny("SL1")}</p></article>` +
  // Fall 8 (WP-10): Überschrift bricht die Gruppierung weiterhin auch unter MIN_WORDS - SH1 bleibt
  // dadurch isoliert und unbewertet, SH2+SH3 danach erreichen zusammen (54 Wörter) MIN_WORDS.
  `<article id="grp-short-heading"><p id="sh1">${tiny("SH1")}</p><h3>Zwischenüberschrift</h3>` +
  `<p id="sh2">${tiny("SH2")}</p><p id="sh3">${tiny("SH3")}</p></article>` +
  // Fall 9 (WP-10): Liste bricht die Gruppierung weiterhin auch unter MIN_WORDS - SI1 bleibt isoliert
  // und unbewertet, SI2+SI3 danach erreichen zusammen MIN_WORDS.
  `<article id="grp-short-list"><p id="si1">${tiny("SI1")}</p><ul><li>Menu</li></ul>` +
  `<p id="si2">${tiny("SI2")}</p><p id="si3">${tiny("SI3")}</p></article>` +
  "</body></html>";

/** Mitte des Prozent-Badges (::after, oben rechts am Absatz, siehe content.css) */
const badgeCenter = (tab, sel) =>
  tab.$eval(sel, (el) => {
    const r = el.getBoundingClientRect();
    const b = getComputedStyle(el, "::after");
    return { x: r.right + 6 - (parseFloat(b.width) + 12) / 2, y: r.top - 12 + parseFloat(b.height) / 2 };
  });

describe("Gruppierung kurzer Absätze", () => {
  let backend, ext, tab;

  before(async () => {
    backend = await startBackend(() => 0.5); // grün bei TMR (yellowFrom 0.95) - Fokus liegt auf Gruppierung, nicht Ampel
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

  it("bewertet vier kurze, direkt benachbarte Absätze im selben Artikel als eine Gruppe", async () => {
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
    assert.equal(new Set(recs.map((r) => r.score)).size, 1, "alle vier sollten denselben Score teilen");
    assert.ok(
      backend.texts.some((t) => ["B1:", "B2:", "B3:", "B4:"].every((tag) => t.includes(tag))),
      "kein Backend-Text enthält alle vier Absätze zusammen"
    );

    // Popover macht die Gruppierung sichtbar (Badge-Klick auf einen der vier Absätze)
    const { x, y } = await badgeCenter(tab, "#b1");
    await tab.mouse.click(x, y);
    await tab.waitForFunction(() => /Hinweis, kein Beweis/.test(document.querySelector("aivsai-popover")?.shadowRoot.textContent || ""));
    assert.match(await tab.evaluate(() => document.querySelector("aivsai-popover").shadowRoot.textContent), /4 benachbarte, kurze Absätze/);
    await tab.keyboard.press("Escape");
  });

  it("bricht die Gruppierung an einer Überschrift", async () => {
    const [h1, h2p, h3p] = await tab.$$eval(["#h1", "#h2p", "#h3p"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(h1.grouped, null, "h1 sollte allein bewertet werden");
    assert.equal(h2p.grouped, "2");
    assert.equal(h3p.grouped, "2");
    assert.equal(h2p.score, h3p.score);
    assert.ok(
      backend.texts.some((t) => t.includes("H2P:") && t.includes("H3P:")),
      "H2P und H3P sollten zusammen gesendet worden sein"
    );
    assert.ok(
      !backend.texts.some((t) => t.includes("H1:") && t.includes("H2P:")),
      "H1 hätte nicht mit H2P zusammengefasst werden dürfen"
    );
    assert.ok(!backend.texts.some((t) => t.includes("Zwischenüberschrift")), "Überschrift wurde mitgeschickt");
  });

  it("bricht die Gruppierung an einem anderssprachigen Absatz", async () => {
    const [l1, l3] = await tab.$$eval(["#l1", "#l3"].join(","), (els) => els.map((e) => e.dataset.aivsaiGrouped ?? null));
    assert.equal(l1, null, "l1 hätte nicht über den deutschen Absatz hinweg gruppiert werden dürfen");
    assert.equal(l3, null);
    assert.equal(await tab.$eval("#l2", (e) => e.dataset.aivsaiSkipped), "de");
    assert.ok(!backend.texts.some((t) => t.includes("Wärmeleitfähigkeit")), "deutscher Text ging ans Backend");
    assert.ok(
      !backend.texts.some((t) => t.includes("L1:") && t.includes("L3:")),
      "L1 und L3 hätten nicht zusammengefasst werden dürfen"
    );
  });

  it("bricht die Gruppierung an einem für sich schon langen Absatz", async () => {
    const [g1, glong, g2] = await tab.$$eval(["#g1", "#glong", "#g2"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, level: e.dataset.aivsaiLevel, words: Number(e.dataset.aivsaiWords) }))
    );
    assert.equal(g1.grouped, null);
    assert.equal(g2.grouped, null);
    assert.equal(glong.grouped, null);
    assert.ok(glong.words >= 120, "glong sollte für sich schon reliableWords erreichen");
    assert.notEqual(glong.level, "uncertain");
    assert.ok(
      !backend.texts.some((t) => t.includes("G1:") && t.includes("G2:")),
      "G1 und G2 hätten nicht über GLONG hinweg zusammengefasst werden dürfen"
    );
  });

  it("lässt eine Gruppe nicht über maxChars wachsen (Rest bildet eine neue Gruppe)", async () => {
    const recs = await tab.$$eval(["#m1", "#m2", "#m3", "#m4"].join(","), (els) =>
      els.map((e) => ({ grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    const [m1, m2, m3, m4] = recs;
    assert.deepEqual([m1.grouped, m2.grouped, m3.grouped], ["3", "3", "3"]);
    assert.equal(m4.grouped, null, "M4 hätte die 2000-Zeichen-Grenze gesprengt und sollte einzeln bleiben");
    assert.equal(m1.score, m2.score);
    assert.equal(m2.score, m3.score);

    const merged = backend.texts.find((t) => t.includes("M1:") && t.includes("M2:") && t.includes("M3:"));
    assert.ok(merged, "M1-M3 sollten zusammen gesendet worden sein");
    assert.ok(merged.length <= 2000, `Gruppentext ${merged.length} Zeichen über maxChars`);
    assert.ok(
      !backend.texts.some((t) => t.includes("M3:") && t.includes("M4:")),
      "M4 hätte nicht mit M1-M3 zusammengefasst werden dürfen"
    );
  });

  it("gruppiert sehr kurze Absätze (je unter MIN_WORDS) zu einer Gruppe ab MIN_WORDS (WP-10)", async () => {
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
    assert.equal(new Set(recs.map((r) => r.score)).size, 1, "alle drei sollten denselben Score teilen");
    assert.ok(
      backend.texts.some((t) => ["SA1:", "SA2:", "SA3:"].every((tag) => t.includes(tag))),
      "kein Backend-Text enthält alle drei Absätze zusammen"
    );
    // Container selbst darf NICHT zusätzlich als Ganzes bewertet werden (kein Doppel, hasLongCandidateChild)
    assert.equal(await tab.$eval("#grp-short-basic", (el) => el.dataset.aivsaiLevel ?? null), null);
  });

  it("lässt einen einzelnen sehr kurzen Absatz ohne Nachbarn unbewertet (WP-10)", async () => {
    const sl1 = await tab.$eval("#sl1", (el) => ({
      level: el.dataset.aivsaiLevel ?? null,
      pending: el.classList.contains("aivsai-pending"),
      badge: el.classList.contains("aivsai-badge")
    }));
    assert.deepEqual(sl1, { level: null, pending: false, badge: false });
    assert.ok(!backend.texts.some((t) => t.includes("SL1:")), "SL1 hätte nie ans Backend gehen dürfen");
    // auch der Container bleibt unbewertet (kein Ersatz-Kandidat für den vereinzelten Kurzabsatz)
    assert.equal(await tab.$eval("#grp-short-lonely", (el) => el.dataset.aivsaiLevel ?? null), null);
  });

  it("bricht die Gruppierung sehr kurzer Absätze weiterhin an einer Überschrift (WP-10)", async () => {
    const [sh1, sh2, sh3] = await tab.$$eval(["#sh1", "#sh2", "#sh3"].join(","), (els) =>
      els.map((e) => ({ level: e.dataset.aivsaiLevel ?? null, grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(sh1.level, null, "SH1 sollte isoliert unbewertet bleiben (27 Wörter allein < MIN_WORDS)");
    assert.equal(sh2.grouped, "2");
    assert.equal(sh3.grouped, "2");
    assert.equal(sh2.score, sh3.score);
    assert.ok(backend.texts.some((t) => t.includes("SH2:") && t.includes("SH3:")), "SH2 und SH3 hätten zusammen gesendet werden sollen");
    assert.ok(!backend.texts.some((t) => t.includes("SH1:")), "SH1 hätte nie ans Backend gehen dürfen");
  });

  it("bricht die Gruppierung sehr kurzer Absätze weiterhin an einer Liste (WP-10)", async () => {
    const [si1, si2, si3] = await tab.$$eval(["#si1", "#si2", "#si3"].join(","), (els) =>
      els.map((e) => ({ level: e.dataset.aivsaiLevel ?? null, grouped: e.dataset.aivsaiGrouped ?? null, score: e.dataset.aivsaiScore }))
    );
    assert.equal(si1.level, null, "SI1 sollte isoliert unbewertet bleiben (27 Wörter allein < MIN_WORDS)");
    assert.equal(si2.grouped, "2");
    assert.equal(si3.grouped, "2");
    assert.equal(si2.score, si3.score);
    assert.ok(backend.texts.some((t) => t.includes("SI2:") && t.includes("SI3:")), "SI2 und SI3 hätten zusammen gesendet werden sollen");
    assert.ok(!backend.texts.some((t) => t.includes("SI1:")), "SI1 hätte nie ans Backend gehen dürfen");
    assert.ok(!backend.texts.some((t) => t.includes("Menu")), "der Listeneintrag hätte nie ans Backend gehen dürfen");
  });

  it("hat keine Konsolenfehler", () => {
    assert.deepEqual(ext.errors, []);
  });
});
