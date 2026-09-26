// WP-08: misst Textauswahl, Gruppierung und Spracherkennung der Extension auf echten Seiten aus dem
// Internet - mit Fake-Backend wie in den E2E-Tests (test/e2e/helpers.mjs), es geht nicht um Scores
// (die sind mit dem Fake-Backend ohnehin nicht aussagekräftig), sondern um: wie viele Absätze findet
// der Auto-Scan, wie oft greift die Gruppierung kurzer Absätze (content.js, groupCandidates), und wird
// die Sprache pro Absatz richtig erkannt (lang-detect.js)?
//
// npm run measure:pages [-- --limit N] [-- --headed]
//
// Schreibt:
//   test/REAL_PAGES.md          - Tabelle + Zusammenfassung + Empfehlungen (committed)
//   scripts/measure-pages.out.json - Rohdaten aller Seiten (nicht committed, nur zur Nachprüfung)
import fs from "node:fs";
import path from "node:path";
import { launchExtension, ROOT, sleep, startBackend, until } from "../test/e2e/helpers.mjs";

const URLS_FILE = path.join(ROOT, "scripts", "measure-pages.urls.txt");
const OUT_JSON = path.join(ROOT, "scripts", "measure-pages.out.json");
const OUT_MD = path.join(ROOT, "test", "REAL_PAGES.md");

// reliableWords/maxChars des in dieser Messung verwendeten Modells (config.js/models.js, desklib) - hier
// fest verdrahtet, damit Node-seitige Auswertung und die Gruppierungs-Simulation (im Seitenkontext,
// siehe simulateGrouping) ohne den Extension-Kontext rechnen können.
const RELIABLE_WORDS = 120;
const MAX_CHARS = 1500;

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const PAGE_TIMEOUT_MS = 90_000; // harte Obergrenze pro Seite, falls sie hängen bleibt (Consent-Loop o.ä.)
const SCAN_WAIT_MS = 40_000; // wie lange auf "nichts mehr pending/deferred" gewartet wird, bevor als unvollständig vermerkt wird

const CATEGORY_LABEL = { news: "Nachrichtenartikel", blog: "Blog", howto: "Anleitung", doc: "Dokumentation", wiki: "Wikipedia" };

function parseUrls(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const [url, lang, category, ...rest] = line.split("\t");
      return { url: url.trim(), lang: (lang || "").trim(), category: (category || "").trim(), label: rest.join("\t").trim() };
    });
}

/**
 * Im Seitenkontext ausgeführt (page.evaluate): liest die data-aivsai-*-Hooks, die content.js an jedem
 * bewerteten/übersprungenen Absatz hinterlässt (siehe extension/content.js, style()/unstyle()), plus die
 * eigene (nicht gruppierte) Wortzahl jedes Absatzes für den Vorher/Nachher-Vergleich der Gruppierung.
 */
function readMarkedParagraphs() {
  const strip = (el) => {
    let text = el.innerText || "";
    el.querySelectorAll("[aria-hidden='true'], pre").forEach((part) => {
      const t = (part.innerText || "").trim();
      if (t) text = text.replace(t, " ");
    });
    return text.trim();
  };
  const wc = (t) => t.split(/\s+/).filter(Boolean).length;
  const excerpt = (t) => (t.length > 160 ? t.slice(0, 160) + "…" : t);

  return [...document.querySelectorAll("[data-aivsai-level], [data-aivsai-skipped]")].map((el) => {
    const text = strip(el);
    return {
      tag: el.tagName.toLowerCase(),
      level: el.dataset.aivsaiLevel || null,
      skipped: el.dataset.aivsaiSkipped || null,
      score: el.dataset.aivsaiScore !== undefined ? Number(el.dataset.aivsaiScore) : null,
      groupWords: el.dataset.aivsaiWords !== undefined ? Number(el.dataset.aivsaiWords) : null,
      grouped: el.dataset.aivsaiGrouped ? Number(el.dataset.aivsaiGrouped) : null,
      ownWords: wc(text),
      excerpt: excerpt(text)
    };
  });
}

// Aus den Einzel-Absätzen (Dokumentreihenfolge, siehe readMarkedParagraphs) die Gruppen rekonstruieren:
// content.js setzt data-aivsai-grouped=N an allen N Absätzen einer Gruppe, und Gruppen sind im
// content.js-eigenen `found` immer zusammenhängend (groupCandidates bricht die Kette bei allem
// Dazwischenliegenden) - deshalb reicht ein Lauf über die (bereits gefilterten) bewerteten Absätze.
function reconstructGroups(scoredParagraphs) {
  const groups = [];
  for (let i = 0; i < scoredParagraphs.length; ) {
    const size = scoredParagraphs[i].grouped || 1;
    groups.push({ size, words: scoredParagraphs[i].groupWords, level: scoredParagraphs[i].level });
    i += size;
  }
  return groups;
}

/**
 * Im Seitenkontext ausgeführt (page.evaluate): spielt content.js' groupCandidates/hasBreakBetween mit
 * echten DOM-Daten der Seite nach, aber mit austauschbarer Eltern-Regel und `maxChars` - um die
 * Empfehlungen aus der ersten Runde (Vorfahr bis Tiefe N statt exakt gleicher Elternknoten, höheres
 * maxChars für Gruppen) an echten Seiten nachzuzählen statt zu vermuten. `actual` bildet die reale Regel
 * nach (exakt gleicher Elternknoten = Tiefe 1) - dient als Gegenprobe zu reconstructGroups().
 * Rückgabe je Variante: { groups, multi, short, itemsInMulti }.
 */
function simulateGrouping() {
  const RELIABLE = 120;
  const BASE_MAX_CHARS = 1500;
  const SEP = 2; // "\n\n".length
  const BREAK_SELECTOR = "h1, h2, h3, h4, h5, h6, ul, ol, table, hr";

  function hasBreakBetween(a, b) {
    try {
      const range = document.createRange();
      range.setStartAfter(a);
      range.setEndBefore(b);
      const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_ELEMENT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (range.intersectsNode(n) && n.matches(BREAK_SELECTOR)) return true;
      }
      return false;
    } catch {
      return true;
    }
  }

  // Tiefe des gemeinsamen Vorfahren von elA/elB, von jedem der beiden aus gezählt (0 = einer ist der
  // Vorfahre des anderen, 1 = gleicher Elternknoten, ...)
  function ancestorDepths(elA, elB) {
    const chain = [];
    for (let n = elA; n; n = n.parentElement) chain.push(n);
    let depthB = 0;
    for (let n = elB; n; n = n.parentElement, depthB++) {
      const idx = chain.indexOf(n);
      if (idx !== -1) return { depthA: idx, depthB };
    }
    return null;
  }

  const strip = (el) => {
    let text = el.innerText || "";
    el.querySelectorAll("[aria-hidden='true'], pre").forEach((part) => {
      const t = (part.innerText || "").trim();
      if (t) text = text.replace(t, " ");
    });
    return text.trim();
  };
  const wc = (t) => t.split(/\s+/).filter(Boolean).length;

  // found wie in content.js collectCandidates (Phase 1), aus den bereits bewerteten/übersprungenen
  // Absätzen rekonstruiert - Sprache: übersprungene Absätze kennen ihre erkannte fremde Sprache über den
  // Hook, bewertete waren per Definition mit der konfigurierten Sprache ("en") kompatibel.
  const found = [...document.querySelectorAll("[data-aivsai-level], [data-aivsai-skipped]")].map((el) => {
    const text = strip(el);
    const skippedLang = el.dataset.aivsaiSkipped || "";
    return { el, text, words: wc(text), lang: skippedLang || "en" };
  });

  function groupSim(parentOk, maxChars) {
    const groups = [];
    let open = null;
    for (const f of found) {
      const foreign = f.lang !== "en";
      const short = !foreign && f.words < RELIABLE;
      if (
        open &&
        short &&
        f.lang === open.lastEntry.lang &&
        parentOk(open.lastEntry, f) &&
        !hasBreakBetween(open.lastEntry.el, f.el) &&
        open.chars + SEP + f.text.length <= maxChars
      ) {
        open.items.push(f);
        open.chars += SEP + f.text.length;
        open.lastEntry = f;
        continue;
      }
      const items = [f];
      groups.push(items);
      open = short ? { items, chars: f.text.length, lastEntry: f } : null;
    }
    // nur reguläre (nicht fremdsprachige) Gruppen sind Bewertungseinheiten - wie im echten Scan
    return groups.filter((items) => items[0].lang === "en").map((items) => ({ size: items.length, words: items.reduce((n, it) => n + it.words, 0) }));
  }

  const exact = (a, b) => a.el.parentElement === b.el.parentElement;
  const depthRule = (N) => (a, b) => {
    const r = ancestorDepths(a.el, b.el);
    return !!r && r.depthA <= N && r.depthB <= N;
  };

  const variants = {
    actual: groupSim(exact, BASE_MAX_CHARS),
    depth2: groupSim(depthRule(2), BASE_MAX_CHARS),
    depth3: groupSim(depthRule(3), BASE_MAX_CHARS),
    maxChars2x: groupSim(exact, BASE_MAX_CHARS * 2),
    depth2_maxChars2x: groupSim(depthRule(2), BASE_MAX_CHARS * 2)
  };

  const stat = (groups) => ({
    groups: groups.length,
    multi: groups.filter((g) => g.size > 1).length,
    short: groups.filter((g) => g.words < RELIABLE).length,
    itemsInMulti: groups.filter((g) => g.size > 1).reduce((n, g) => n + g.size, 0)
  });

  return Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, stat(v)]));
}

async function measurePage(ext, entry) {
  const page = await ext.ctx.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));

  const result = { ...entry, ok: false, error: null, consoleErrors, cookieNote: null };
  try {
    await Promise.race([
      (async () => {
        const resp = await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 40_000 });
        if (!resp || !resp.ok()) result.httpStatus = resp?.status() ?? null;
        await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
        // Nachladende Inhalte (SPA-Rubriken, Consent-Skripte) und den Debounce von content.js
        // (DEBOUNCE_MS 600ms) abwarten, bevor gepollt wird.
        await sleep(2000);
        await until(() => page.evaluate(() => !document.querySelector(".aivsai-pending, .aivsai-deferred")), {
          timeout: SCAN_WAIT_MS,
          message: "Scan wurde nicht fertig (noch pending/deferred)"
        }).catch((e) => {
          result.incomplete = e.message;
        });
        await sleep(300);
      })(),
      sleep(PAGE_TIMEOUT_MS).then(() => {
        throw new Error(`Seiten-Timeout nach ${PAGE_TIMEOUT_MS}ms`);
      })
    ]);

    // Tab in den Vordergrund (wie helpers.mjs tabId), dann Stats vom Content-Script abfragen
    await page.bringToFront();
    const tabId = await ext.options.evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id
    );
    result.stats = await ext.options.evaluate(
      ([id, msg]) => chrome.tabs.sendMessage(id, msg),
      [tabId, { type: "GET_STATS" }]
    );
    // Falls nach SCAN_WAIT_MS noch etwas offen war: festhalten, ob und wie viel den gemessenen Zahlen fehlt
    if (result.incomplete && result.stats) {
      result.incomplete = `${result.incomplete} - beim Auslesen noch ${result.stats.pending} pending, ${result.stats.deferred} deferred (Zahlen ggf. unvollständig)`;
    }

    // Groben Hinweis auf einen Consent-/Cookie-Dialog, der den Inhalt verdeckt (nicht wegklicken,
    // nur vermerken - siehe Auftrag)
    result.cookieNote = await page.evaluate(() => {
      const dialog = document.querySelector(
        "[role='dialog'], [role='alertdialog'], #cmpwrapper, #sp_message_container, .cookie-banner, [id*='consent' i], [class*='consent' i], [id*='cookie' i]"
      );
      if (!dialog) return null;
      const r = dialog.getBoundingClientRect();
      return r.width * r.height > innerWidth * innerHeight * 0.25 ? "möglicher großflächiger Consent-Dialog erkannt" : null;
    });

    result.paragraphs = await page.evaluate(readMarkedParagraphs);
    result.groups = reconstructGroups(result.paragraphs.filter((p) => p.level));
    result.groupingSim = await page.evaluate(simulateGrouping);
    result.ok = true;
  } catch (err) {
    result.error = String(err?.message || err);
  } finally {
    await page.close().catch(() => {});
  }
  return result;
}

function summarize(results) {
  const ok = results.filter((r) => r.ok);
  const scored = (r) => r.paragraphs.filter((p) => p.level);
  const skipped = (r) => r.paragraphs.filter((p) => p.skipped);

  let preShort = 0,
    preTotal = 0,
    postShort = 0,
    postTotal = 0;
  for (const r of ok) {
    for (const p of scored(r)) {
      preTotal++;
      if (p.ownWords < RELIABLE_WORDS) preShort++;
    }
    for (const g of r.groups) {
      postTotal++;
      if (g.words < RELIABLE_WORDS) postShort++;
    }
  }

  const langWrong = []; // { url, lang, kind, excerpt, detected? }
  for (const r of ok) {
    if (r.lang === "en") {
      for (const p of skipped(r)) langWrong.push({ url: r.url, lang: r.lang, kind: "englisch übersprungen", detected: p.skipped, excerpt: p.excerpt });
    } else if (["de", "fr", "es"].includes(r.lang)) {
      for (const p of scored(r)) langWrong.push({ url: r.url, lang: r.lang, kind: `${r.lang} bewertet statt übersprungen`, excerpt: p.excerpt });
    }
  }

  // Nach Kategorie (news/blog/howto/doc/wiki) getrennt, damit Wikipedia die Gesamtzahl nicht dominiert
  // (Nachbesserung nach Orchestrator-Review: 550/680 Absätze kamen in der ersten Fassung aus 3
  // Wikipedia-Artikeln).
  const byCategory = {};
  for (const r of ok) {
    const c = (byCategory[r.category] ??= { pages: 0, preTotal: 0, preShort: 0, postTotal: 0, postShort: 0 });
    c.pages++;
    for (const p of scored(r)) {
      c.preTotal++;
      if (p.ownWords < RELIABLE_WORDS) c.preShort++;
    }
    for (const g of r.groups) {
      c.postTotal++;
      if (g.words < RELIABLE_WORDS) c.postShort++;
    }
  }

  // Gruppierungs-Simulation über alle Seiten aufsummiert, zusätzlich separat nur für Kategorie "news"
  // (das war der konkrete Kritikpunkt: die Gruppierung zielt auf Nachrichtenartikel mit vielen kurzen
  // Absätzen, dafür gab es in der ersten Fassung kaum Daten).
  const sumSim = (rs) => {
    const out = {};
    for (const r of rs) {
      if (!r.groupingSim) continue;
      for (const [variant, s] of Object.entries(r.groupingSim)) {
        const o = (out[variant] ??= { groups: 0, multi: 0, short: 0, itemsInMulti: 0 });
        o.groups += s.groups;
        o.multi += s.multi;
        o.short += s.short;
        o.itemsInMulti += s.itemsInMulti;
      }
    }
    return out;
  };
  const groupingSimAll = sumSim(ok);
  const groupingSimNews = sumSim(ok.filter((r) => r.category === "news"));

  return {
    totalUrls: results.length,
    measured: ok.length,
    failed: results.length - ok.length,
    groupsTotal: postTotal,
    groupsMulti: ok.reduce((n, r) => n + r.groups.filter((g) => g.size > 1).length, 0),
    preShortShare: preTotal ? preShort / preTotal : null,
    postShortShare: postTotal ? postShort / postTotal : null,
    preTotal,
    postTotal,
    langWrong,
    byCategory,
    groupingSimAll,
    groupingSimNews
  };
}

function fmtPct(x) {
  return x === null || Number.isNaN(x) ? "–" : `${Math.round(x * 100)} %`;
}

function simVariantRow(label, s) {
  if (!s || !s.groups) return `| ${label} | 0 | 0 | – | 0 |`;
  return `| ${label} | ${s.groups} | ${s.multi} | ${fmtPct(s.short / s.groups)} | ${s.itemsInMulti} |`;
}

function toMarkdown(results, summary) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  lines.push("# Echte Seiten: Textauswahl, Gruppierung und Sprache (WP-08)");
  lines.push("");
  lines.push(
    `Gemessen am ${new Date().toISOString().slice(0, 10)} mit \`scripts/measure-pages.mjs\` gegen ein ` +
      "Fake-Backend (wie in den E2E-Tests, `test/e2e/helpers.mjs`) - es geht um Textauswahl, Gruppierung " +
      "(`extension/content.js`, `groupCandidates`) und Spracherkennung (`extension/lang-detect.js`), " +
      "**nicht** um Scores. Konfiguration: `provider: local`, `localModel: desklib` (Produktions-Default, " +
      "`maxChars` 1500/`reliableWords` 120), `scanMode: all`, `lazyScan: false` (ganze Seite auf einmal), " +
      "`groupShortParagraphs: true` (Default). URLs sind bewusst einzelne Artikel statt Startseiten " +
      "(Nachbesserung nach Orchestrator-Review: Startseiten bestehen fast nur aus Teaser-Links < 40 Wörtern " +
      "und sagen wenig über Gruppierung aus; die erste Fassung hatte zudem 550/680 bewertete Absätze aus nur " +
      "3 Wikipedia-Artikeln - Wikipedia ist jetzt auf 3 Artikel gedeckelt, dafür 14 einzelne englische " +
      "Nachrichtenartikel aus 6 Häusern)."
  );
  lines.push("");
  lines.push(
    `**${summary.measured} von ${summary.totalUrls}** Seiten erfolgreich gemessen, ${summary.failed} übersprungen ` +
      "(siehe „Nicht geladene Seiten“ unten)."
  );
  lines.push("");

  lines.push("## Tabelle pro Seite");
  lines.push("");
  lines.push(
    "| Seite | Sprache | Kategorie | Kandidaten | bewertet | übersprungen | Gruppen (>1) | Ø-Größe | <120 Wörter vorher | <120 Wörter nachher | Hinweise |"
  );
  lines.push("|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of ok) {
    const scoredP = r.paragraphs.filter((p) => p.level);
    const skippedP = r.paragraphs.filter((p) => p.skipped);
    const multi = r.groups.filter((g) => g.size > 1);
    const avgSize = multi.length ? (multi.reduce((n, g) => n + g.size, 0) / multi.length).toFixed(1) : "–";
    const preShort = scoredP.length ? scoredP.filter((p) => p.ownWords < RELIABLE_WORDS).length / scoredP.length : null;
    const postShort = r.groups.length ? r.groups.filter((g) => g.words < RELIABLE_WORDS).length / r.groups.length : null;
    const notes = [];
    if (r.incomplete) notes.push(r.incomplete);
    if (r.cookieNote) notes.push(r.cookieNote);
    if (r.stats?.blocked) notes.push(`gesperrt (${r.stats.blockReason})`);
    if (r.stats?.error) notes.push(`Fehler: ${r.stats.error}`);
    if (!r.paragraphs.length) notes.push("keine Kandidaten gefunden");
    const name = r.url.replace(/^https?:\/\//, "");
    lines.push(
      `| [${name}](${r.url}) | ${r.lang} | ${CATEGORY_LABEL[r.category] || r.category} | ${r.paragraphs.length} | ${scoredP.length} | ${skippedP.length} | ` +
        `${multi.length} | ${avgSize} | ${fmtPct(preShort)} | ${fmtPct(postShort)} | ${notes.join("; ") || "–"} |`
    );
  }
  lines.push("");

  lines.push("## Nicht geladene Seiten");
  lines.push("");
  if (!failed.length) {
    lines.push("Keine - alle Seiten der Liste konnten geladen werden.");
  } else {
    lines.push("| Seite | Sprache | Fehler |");
    lines.push("|---|---|---|");
    for (const r of failed) lines.push(`| ${r.url} | ${r.lang} | ${r.error} |`);
  }
  lines.push("");

  lines.push("## Zusammenfassung");
  lines.push("");
  lines.push(`- Absätze insgesamt (bewertet, über alle Seiten): ${summary.preTotal}`);
  lines.push(
    `- Anteil unter ${RELIABLE_WORDS} Wörtern **vor** Gruppierung (einzelner Absatz): **${fmtPct(summary.preShortShare)}**`
  );
  lines.push(
    `- Anteil unter ${RELIABLE_WORDS} Wörtern **nach** Gruppierung (Gruppe bzw. Einzelabsatz, ${summary.postTotal} ` +
      `Bewertungseinheiten): **${fmtPct(summary.postShortShare)}**`
  );
  lines.push(`- Gruppen mit mehr als einem Absatz: ${summary.groupsMulti} von ${summary.postTotal} Bewertungseinheiten`);
  lines.push("");

  lines.push("### Nach Seitentyp getrennt");
  lines.push("");
  lines.push("| Kategorie | Seiten | Absätze vorher | <120 Wörter vorher | Einheiten nachher | <120 Wörter nachher |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    lines.push(
      `| ${CATEGORY_LABEL[cat] || cat} | ${c.pages} | ${c.preTotal} | ${fmtPct(c.preTotal ? c.preShort / c.preTotal : null)} | ` +
        `${c.postTotal} | ${fmtPct(c.postTotal ? c.postShort / c.postTotal : null)} |`
    );
  }
  lines.push("");

  lines.push("## Spracherkennung");
  lines.push("");
  const byLang = {};
  for (const r of ok) {
    byLang[r.lang] ??= { pages: 0, scored: 0, skipped: 0 };
    byLang[r.lang].pages++;
    byLang[r.lang].scored += r.paragraphs.filter((p) => p.level).length;
    byLang[r.lang].skipped += r.paragraphs.filter((p) => p.skipped).length;
  }
  lines.push("| Sprache | Seiten | bewertet (= als Englisch behandelt) | übersprungen (fremd erkannt) |");
  lines.push("|---|---:|---:|---:|");
  for (const [lang, v] of Object.entries(byLang)) {
    lines.push(`| ${lang} | ${v.pages} | ${v.scored} | ${v.skipped} |`);
  }
  lines.push("");
  lines.push(
    "Erwartung: bei `en` sollte „übersprungen“ ≈ 0 sein, bei `de`/`fr`/`es` sollte „bewertet“ ≈ 0 sein " +
      "(die ganze Seite übersprungen). `mixed`-Seiten haben bewusst beides."
  );
  lines.push("");

  if (summary.langWrong.length) {
    lines.push("### Auffällige Fälle (gekürzt)");
    lines.push("");
    lines.push("| Seite | Sprache | Art | Auszug |");
    lines.push("|---|---|---|---|");
    for (const w of summary.langWrong.slice(0, 40)) {
      lines.push(`| ${w.url} | ${w.lang} | ${w.kind}${w.detected ? ` (${w.detected})` : ""} | ${w.excerpt.replace(/\|/g, "\\|")} |`);
    }
    if (summary.langWrong.length > 40) lines.push(`\n_… ${summary.langWrong.length - 40} weitere, siehe measure-pages.out.json_`);
    lines.push("");
  }

  lines.push("## Gruppierungsregel: gezählte Wirkung einer Lockerung");
  lines.push("");
  lines.push(
    "Simuliert `groupCandidates` (content.js) mit echten Seitendaten nach, einmal mit der tatsächlichen " +
      "Regel (`actual` - exakt gleicher Elternknoten, entspricht Tiefe 1) und mit zwei Varianten: " +
      "gemeinsamer Vorfahr bis Tiefe 2/3 statt exakt gleicher Elternknoten (`depth2`/`depth3`), doppeltes " +
      "`maxChars` (`maxChars2x`, 3000 statt 1500 Zeichen) und beides kombiniert. `actual` sollte die " +
      "tatsächlich gemessenen Gruppen (Tabelle oben) reproduzieren - dient als Gegenprobe der Simulation."
  );
  lines.push("");
  lines.push("### Alle Seiten");
  lines.push("");
  lines.push("| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [k, label] of [
    ["actual", "tatsächliche Regel"],
    ["depth2", "Vorfahr bis Tiefe 2"],
    ["depth3", "Vorfahr bis Tiefe 3"],
    ["maxChars2x", "maxChars ×2"],
    ["depth2_maxChars2x", "Tiefe 2 + maxChars ×2"]
  ]) {
    lines.push(simVariantRow(label, summary.groupingSimAll[k]));
  }
  lines.push("");
  lines.push("### Nur Nachrichtenartikel (Kategorie „news“)");
  lines.push("");
  lines.push("| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [k, label] of [
    ["actual", "tatsächliche Regel"],
    ["depth2", "Vorfahr bis Tiefe 2"],
    ["depth3", "Vorfahr bis Tiefe 3"],
    ["maxChars2x", "maxChars ×2"],
    ["depth2_maxChars2x", "Tiefe 2 + maxChars ×2"]
  ]) {
    lines.push(simVariantRow(label, summary.groupingSimNews[k]));
  }
  lines.push("");

  lines.push("## Empfehlungen (nicht umgesetzt, nur Vorschlag)");
  lines.push("");
  lines.push(
    "Siehe Abschnitt „Gruppierungsregel: gezählte Wirkung einer Lockerung“ oben sowie den Abschlussbericht " +
      "des Agenten an den Orchestrator für die Einordnung der Zahlen."
  );
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const entries = parseUrls(fs.readFileSync(URLS_FILE, "utf8")).slice(0, LIMIT);
  console.log(`${entries.length} Seiten in der Liste.`);

  const backend = await startBackend();
  const ext = await launchExtension({ pages: {}, viewport: { width: 1280, height: 1400 } });
  await ext.configure({
    provider: "local",
    localUrl: backend.url,
    localModel: "desklib",
    scanMode: "all",
    lazyScan: false,
    groupShortParagraphs: true
  });

  const results = [];
  try {
    for (const entry of entries) {
      process.stdout.write(`→ ${entry.url} … `);
      const r = await measurePage(ext, entry);
      results.push(r);
      console.log(
        r.ok
          ? `ok (${r.paragraphs.length} Kandidaten, ${r.paragraphs.filter((p) => p.level).length} bewertet, ` +
              `${r.paragraphs.filter((p) => p.skipped).length} übersprungen)`
          : `FEHLER: ${r.error}`
      );
    }
  } finally {
    await ext.close();
    await backend.close();
  }

  const summary = summarize(results);
  fs.writeFileSync(OUT_JSON, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));
  fs.writeFileSync(OUT_MD, toMarkdown(results, summary));

  console.log("");
  console.log(`Gemessen: ${summary.measured}/${summary.totalUrls}, fehlgeschlagen: ${summary.failed}`);
  console.log(`<120 Wörter vorher: ${fmtPct(summary.preShortShare)}, nachher: ${fmtPct(summary.postShortShare)}`);
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`Markdown: ${OUT_MD}`);

  if (summary.failed > entries.length - 25 && entries.length >= 25) {
    console.warn(`WARNUNG: weniger als 25 Seiten erfolgreich gemessen (${summary.measured}).`);
  }
}

await main();
