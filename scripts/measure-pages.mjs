// WP-08: measures text selection, grouping and language detection of the extension on real pages from the
// internet - with a fake backend as in the E2E tests (test/e2e/helpers.mjs), it is not about scores
// (which are not meaningful with the fake backend anyway), but about: how many paragraphs does
// the auto-scan find, how often does the grouping of short paragraphs kick in (content.js, groupCandidates), and is
// the language detected correctly per paragraph (lang-detect.js)?
//
// npm run measure:pages [-- --limit N] [-- --headed]
//
// Writes:
//   test/REAL_PAGES.md          - table + summary + recommendations (committed)
//   scripts/measure-pages.out.json - raw data of all pages (not committed, only for verification)
import fs from "node:fs";
import path from "node:path";
import { launchExtension, ROOT, sleep, startBackend, until } from "../test/e2e/helpers.mjs";

const URLS_FILE = path.join(ROOT, "scripts", "measure-pages.urls.txt");
const OUT_JSON = path.join(ROOT, "scripts", "measure-pages.out.json");
const OUT_MD = path.join(ROOT, "test", "REAL_PAGES.md");

// reliableWords/maxChars of the model used in this measurement (config.js/models.js, desklib) - hard-wired
// here so that the Node-side evaluation and the grouping simulation (in the page context,
// see simulateGrouping) can compute without the extension context.
const RELIABLE_WORDS = 120;
const MAX_CHARS = 1500;

const args = process.argv.slice(2);
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const PAGE_TIMEOUT_MS = 90_000; // hard upper limit per page in case it hangs (consent loop or similar)
const SCAN_WAIT_MS = 40_000; // how long to wait for "nothing pending/deferred anymore" before noting it as incomplete

const CATEGORY_LABEL = { news: "News article", blog: "Blog", howto: "How-to", doc: "Documentation", wiki: "Wikipedia" };

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
 * Executed in the page context (page.evaluate): reads the data-aivsai-* hooks that content.js leaves on every
 * scored/skipped paragraph (see extension/content.js, style()/unstyle()), plus the
 * own (ungrouped) word count of each paragraph for the before/after comparison of the grouping.
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

// Reconstruct the groups from the individual paragraphs (document order, see readMarkedParagraphs):
// content.js sets data-aivsai-grouped=N on all N paragraphs of a group, and groups are always contiguous
// in content.js's own `found` (groupCandidates breaks the chain at anything in
// between) - so one pass over the (already filtered) scored paragraphs is enough.
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
 * Executed in the page context (page.evaluate): replays content.js' groupCandidates/hasBreakBetween with
 * real DOM data of the page, but with an exchangeable parent rule and `maxChars` - to recount the
 * recommendations from the first round (ancestor up to depth N instead of exactly the same parent node, higher
 * maxChars for groups) on real pages instead of guessing. `actual` replicates the real rule
 * (exactly the same parent node = depth 1) - serves as a cross-check for reconstructGroups().
 * Returns per variant: { groups, multi, short, itemsInMulti }.
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

  // Depth of the common ancestor of elA/elB, counted from each of the two (0 = one is the
  // ancestor of the other, 1 = same parent node, ...)
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

  // found as in content.js collectCandidates (phase 1), reconstructed from the already scored/skipped
  // paragraphs - language: skipped paragraphs know their detected foreign language via the
  // hook, scored ones were by definition compatible with the configured language ("en").
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
    // only regular (non-foreign-language) groups are scoring units - as in the real scan
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
        // Wait for lazily loaded content (SPA sections, consent scripts) and the debounce of content.js
        // (DEBOUNCE_MS 600ms) before polling.
        await sleep(2000);
        await until(() => page.evaluate(() => !document.querySelector(".aivsai-pending, .aivsai-deferred")), {
          timeout: SCAN_WAIT_MS,
          message: "Scan did not finish (still pending/deferred)"
        }).catch((e) => {
          result.incomplete = e.message;
        });
        await sleep(300);
      })(),
      sleep(PAGE_TIMEOUT_MS).then(() => {
        throw new Error(`Page timeout after ${PAGE_TIMEOUT_MS}ms`);
      })
    ]);

    // Bring the tab to the foreground (like helpers.mjs tabId), then query stats from the content script
    await page.bringToFront();
    const tabId = await ext.options.evaluate(
      async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0].id
    );
    result.stats = await ext.options.evaluate(
      ([id, msg]) => chrome.tabs.sendMessage(id, msg),
      [tabId, { type: "GET_STATS" }]
    );
    // If something was still open after SCAN_WAIT_MS: record whether and how much is missing from the measured numbers
    if (result.incomplete && result.stats) {
      result.incomplete = `${result.incomplete} - at read time still ${result.stats.pending} pending, ${result.stats.deferred} deferred (numbers possibly incomplete)`;
    }

    // Rough hint of a consent/cookie dialog covering the content (do not click it away,
    // only note it - see brief)
    result.cookieNote = await page.evaluate(() => {
      const dialog = document.querySelector(
        "[role='dialog'], [role='alertdialog'], #cmpwrapper, #sp_message_container, .cookie-banner, [id*='consent' i], [class*='consent' i], [id*='cookie' i]"
      );
      if (!dialog) return null;
      const r = dialog.getBoundingClientRect();
      return r.width * r.height > innerWidth * innerHeight * 0.25 ? "possible large-area consent dialog detected" : null;
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
      for (const p of skipped(r)) langWrong.push({ url: r.url, lang: r.lang, kind: "English skipped", detected: p.skipped, excerpt: p.excerpt });
    } else if (["de", "fr", "es"].includes(r.lang)) {
      for (const p of scored(r)) langWrong.push({ url: r.url, lang: r.lang, kind: `${r.lang} scored instead of skipped`, excerpt: p.excerpt });
    }
  }

  // Split by category (news/blog/howto/doc/wiki) so that Wikipedia does not dominate the total
  // (rework after orchestrator review: 550/680 paragraphs came from 3
  // Wikipedia articles in the first version).
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

  // Grouping simulation summed over all pages, additionally separately for category "news" only
  // (that was the specific criticism: the grouping targets news articles with many short
  // paragraphs, for which the first version had hardly any data).
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
  return x === null || Number.isNaN(x) ? "–" : `${Math.round(x * 100)}%`;
}

function simVariantRow(label, s) {
  if (!s || !s.groups) return `| ${label} | 0 | 0 | – | 0 |`;
  return `| ${label} | ${s.groups} | ${s.multi} | ${fmtPct(s.short / s.groups)} | ${s.itemsInMulti} |`;
}

function toMarkdown(results, summary) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const lines = [];
  lines.push("# Real pages: text selection, grouping and language (WP-08)");
  lines.push("");
  lines.push(
    `Measured on ${new Date().toISOString().slice(0, 10)} with \`scripts/measure-pages.mjs\` against a ` +
      "fake backend (as in the E2E tests, `test/e2e/helpers.mjs`) - it is about text selection, grouping " +
      "(`extension/content.js`, `groupCandidates`) and language detection (`extension/lang-detect.js`), " +
      "**not** about scores. Configuration: `provider: local`, `localModel: desklib` (production default, " +
      "`maxChars` 1500/`reliableWords` 120), `scanMode: all`, `lazyScan: false` (whole page at once), " +
      "`groupShortParagraphs: true` (default). URLs are deliberately single articles instead of home pages " +
      "(rework after orchestrator review: home pages consist almost only of teaser links < 40 words " +
      "and say little about grouping; the first version also had 550/680 scored paragraphs from just " +
      "3 Wikipedia articles - Wikipedia is now capped at 3 articles, plus 14 single English " +
      "news articles from 6 publishers)."
  );
  lines.push("");
  lines.push(
    `**${summary.measured} of ${summary.totalUrls}** pages measured successfully, ${summary.failed} skipped ` +
      "(see \"Pages not loaded\" below)."
  );
  lines.push("");

  lines.push("## Table per page");
  lines.push("");
  lines.push(
    "| Page | Language | Category | Candidates | scored | skipped | Groups (>1) | Avg. size | <120 words before | <120 words after | Notes |"
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
    if (r.stats?.blocked) notes.push(`blocked (${r.stats.blockReason})`);
    if (r.stats?.error) notes.push(`Error: ${r.stats.error}`);
    if (!r.paragraphs.length) notes.push("no candidates found");
    const name = r.url.replace(/^https?:\/\//, "");
    lines.push(
      `| [${name}](${r.url}) | ${r.lang} | ${CATEGORY_LABEL[r.category] || r.category} | ${r.paragraphs.length} | ${scoredP.length} | ${skippedP.length} | ` +
        `${multi.length} | ${avgSize} | ${fmtPct(preShort)} | ${fmtPct(postShort)} | ${notes.join("; ") || "–"} |`
    );
  }
  lines.push("");

  lines.push("## Pages not loaded");
  lines.push("");
  if (!failed.length) {
    lines.push("None - all pages in the list could be loaded.");
  } else {
    lines.push("| Page | Language | Error |");
    lines.push("|---|---|---|");
    for (const r of failed) lines.push(`| ${r.url} | ${r.lang} | ${r.error} |`);
  }
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(`- Paragraphs in total (scored, across all pages): ${summary.preTotal}`);
  lines.push(
    `- Share under ${RELIABLE_WORDS} words **before** grouping (single paragraph): **${fmtPct(summary.preShortShare)}**`
  );
  lines.push(
    `- Share under ${RELIABLE_WORDS} words **after** grouping (group or single paragraph, ${summary.postTotal} ` +
      `scoring units): **${fmtPct(summary.postShortShare)}**`
  );
  lines.push(`- Groups with more than one paragraph: ${summary.groupsMulti} of ${summary.postTotal} scoring units`);
  lines.push("");

  lines.push("### Split by page type");
  lines.push("");
  lines.push("| Category | Pages | Paragraphs before | <120 words before | Units after | <120 words after |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const [cat, c] of Object.entries(summary.byCategory)) {
    lines.push(
      `| ${CATEGORY_LABEL[cat] || cat} | ${c.pages} | ${c.preTotal} | ${fmtPct(c.preTotal ? c.preShort / c.preTotal : null)} | ` +
        `${c.postTotal} | ${fmtPct(c.postTotal ? c.postShort / c.postTotal : null)} |`
    );
  }
  lines.push("");

  lines.push("## Language detection");
  lines.push("");
  const byLang = {};
  for (const r of ok) {
    byLang[r.lang] ??= { pages: 0, scored: 0, skipped: 0 };
    byLang[r.lang].pages++;
    byLang[r.lang].scored += r.paragraphs.filter((p) => p.level).length;
    byLang[r.lang].skipped += r.paragraphs.filter((p) => p.skipped).length;
  }
  lines.push("| Language | Pages | scored (= treated as English) | skipped (detected as foreign) |");
  lines.push("|---|---:|---:|---:|");
  for (const [lang, v] of Object.entries(byLang)) {
    lines.push(`| ${lang} | ${v.pages} | ${v.scored} | ${v.skipped} |`);
  }
  lines.push("");
  lines.push(
    "Expectation: for `en`, \"skipped\" should be ≈ 0, for `de`/`fr`/`es`, \"scored\" should be ≈ 0 " +
      "(the whole page skipped). `mixed` pages deliberately have both."
  );
  lines.push("");

  if (summary.langWrong.length) {
    lines.push("### Notable cases (truncated)");
    lines.push("");
    lines.push("| Page | Language | Kind | Excerpt |");
    lines.push("|---|---|---|---|");
    for (const w of summary.langWrong.slice(0, 40)) {
      lines.push(`| ${w.url} | ${w.lang} | ${w.kind}${w.detected ? ` (${w.detected})` : ""} | ${w.excerpt.replace(/\|/g, "\\|")} |`);
    }
    if (summary.langWrong.length > 40) lines.push(`\n_… ${summary.langWrong.length - 40} more, see measure-pages.out.json_`);
    lines.push("");
  }

  lines.push("## Grouping rule: counted effect of a relaxation");
  lines.push("");
  lines.push(
    "Replays `groupCandidates` (content.js) with real page data, once with the actual " +
      "rule (`actual` - exactly the same parent node, corresponds to depth 1) and with two variants: " +
      "common ancestor up to depth 2/3 instead of exactly the same parent node (`depth2`/`depth3`), doubled " +
      "`maxChars` (`maxChars2x`, 3000 instead of 1500 characters) and both combined. `actual` should " +
      "reproduce the actually measured groups (table above) - serves as a cross-check of the simulation."
  );
  lines.push("");
  lines.push("### All pages");
  lines.push("");
  lines.push("| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [k, label] of [
    ["actual", "actual rule"],
    ["depth2", "ancestor up to depth 2"],
    ["depth3", "ancestor up to depth 3"],
    ["maxChars2x", "maxChars ×2"],
    ["depth2_maxChars2x", "depth 2 + maxChars ×2"]
  ]) {
    lines.push(simVariantRow(label, summary.groupingSimAll[k]));
  }
  lines.push("");
  lines.push("### News articles only (category \"news\")");
  lines.push("");
  lines.push("| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const [k, label] of [
    ["actual", "actual rule"],
    ["depth2", "ancestor up to depth 2"],
    ["depth3", "ancestor up to depth 3"],
    ["maxChars2x", "maxChars ×2"],
    ["depth2_maxChars2x", "depth 2 + maxChars ×2"]
  ]) {
    lines.push(simVariantRow(label, summary.groupingSimNews[k]));
  }
  lines.push("");

  lines.push("## Recommendations (not implemented, suggestion only)");
  lines.push("");
  lines.push(
    "See section \"Grouping rule: counted effect of a relaxation\" above as well as the agent's final report " +
      "to the orchestrator for putting the numbers into context."
  );
  lines.push("");

  return lines.join("\n");
}

async function main() {
  const entries = parseUrls(fs.readFileSync(URLS_FILE, "utf8")).slice(0, LIMIT);
  console.log(`${entries.length} pages in the list.`);

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
          ? `ok (${r.paragraphs.length} candidates, ${r.paragraphs.filter((p) => p.level).length} scored, ` +
              `${r.paragraphs.filter((p) => p.skipped).length} skipped)`
          : `ERROR: ${r.error}`
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
  console.log(`Measured: ${summary.measured}/${summary.totalUrls}, failed: ${summary.failed}`);
  console.log(`<120 words before: ${fmtPct(summary.preShortShare)}, after: ${fmtPct(summary.postShortShare)}`);
  console.log(`JSON: ${OUT_JSON}`);
  console.log(`Markdown: ${OUT_MD}`);

  if (summary.failed > entries.length - 25 && entries.length >= 25) {
    console.warn(`WARNING: fewer than 25 pages measured successfully (${summary.measured}).`);
  }
}

await main();
