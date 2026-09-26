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

// reliableWords des Standardmodells (config.js/models.js, desklib UND tmr: 120) - hier fest verdrahtet,
// damit das Skript ohne den Extension-Kontext rechnen kann (Auswertung läuft in Node, nicht im Browser).
const RELIABLE_WORDS = 120;

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const PAGE_TIMEOUT_MS = 60_000; // harte Obergrenze pro Seite, falls sie hängen bleibt (Consent-Loop o.ä.)

function parseUrls(text) {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const [url, lang, ...rest] = line.split("\t");
      return { url: url.trim(), lang: (lang || "").trim(), label: rest.join("\t").trim() };
    });
}

// Wortzahl wie extension/content.js (wordCount): auf Leerraum splitten
const words = (text) => text.split(/\s+/).filter(Boolean).length;

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
          timeout: 25_000,
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

  const langWrong = []; // { url, lang, kind: "skip-erwartet-en" | "score-erwartet-fremd", excerpt, detected? }
  for (const r of ok) {
    if (r.lang === "en") {
      for (const p of skipped(r)) langWrong.push({ url: r.url, lang: r.lang, kind: "englisch übersprungen", detected: p.skipped, excerpt: p.excerpt });
    } else if (["de", "fr", "es"].includes(r.lang)) {
      for (const p of scored(r)) langWrong.push({ url: r.url, lang: r.lang, kind: `${r.lang} bewertet statt übersprungen`, excerpt: p.excerpt });
    }
  }

  return {
    totalUrls: results.length,
    measured: ok.length,
    failed: results.length - ok.length,
    groupingRate: postTotal ? results.reduce((n, r) => n + (r.ok ? r.groups.filter((g) => g.size > 1).length : 0), 0) : 0,
    groupsTotal: postTotal,
    groupsMulti: ok.reduce((n, r) => n + r.groups.filter((g) => g.size > 1).length, 0),
    preShortShare: preTotal ? preShort / preTotal : null,
    postShortShare: postTotal ? postShort / postTotal : null,
    preTotal,
    postTotal,
    langWrong
  };
}

function fmtPct(x) {
  return x === null || Number.isNaN(x) ? "–" : `${Math.round(x * 100)} %`;
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
      "`groupShortParagraphs: true` (Default)."
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
    "| Seite | Sprache | Kandidaten | bewertet | übersprungen | Gruppen (>1) | Ø-Größe | <120 Wörter vorher | <120 Wörter nachher | Hinweise |"
  );
  lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const r of ok) {
    const scoredP = r.paragraphs.filter((p) => p.level);
    const skippedP = r.paragraphs.filter((p) => p.skipped);
    const multi = r.groups.filter((g) => g.size > 1);
    const avgSize = multi.length ? (multi.reduce((n, g) => n + g.size, 0) / multi.length).toFixed(1) : "–";
    const preShort = scoredP.length ? scoredP.filter((p) => p.ownWords < RELIABLE_WORDS).length / scoredP.length : null;
    const postShort = r.groups.length ? r.groups.filter((g) => g.words < RELIABLE_WORDS).length / r.groups.length : null;
    const notes = [];
    if (r.incomplete) notes.push("Scan nicht fertig geworden");
    if (r.cookieNote) notes.push(r.cookieNote);
    if (r.stats?.blocked) notes.push(`gesperrt (${r.stats.blockReason})`);
    if (r.stats?.error) notes.push(`Fehler: ${r.stats.error}`);
    if (!r.paragraphs.length) notes.push("keine Kandidaten gefunden");
    const name = r.url.replace(/^https?:\/\//, "");
    lines.push(
      `| [${name}](${r.url}) | ${r.lang} | ${r.paragraphs.length} | ${scoredP.length} | ${skippedP.length} | ` +
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

  lines.push("## Empfehlungen (nicht umgesetzt, nur Vorschlag)");
  lines.push("");
  lines.push(
    "Siehe Abschlussbericht des Agenten im Orchestrierungs-Log/an den Orchestrator - hier die Kurzfassung " +
      "auf Basis der obigen Zahlen:"
  );
  lines.push("");
  lines.push(
    "- **Gruppierung**: siehe Tabelle/Zusammenfassung oben für die tatsächliche Trefferquote auf echten " +
      "Seiten (Regel „gleicher Elternknoten, keine Überschrift/Liste dazwischen“, `content.js groupCandidates`)."
  );
  lines.push(
    "- **Spracherkennung**: siehe Abschnitt „Auffällige Fälle“ oben für konkrete Beispiele, an denen " +
      "`lang-detect.js` bzw. das `lang`-Attribut-Fallback daneben liegt."
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
