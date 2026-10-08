# WP-08 · Measure grouping and language detection on real pages (TODO item 2)

## Goal
Robust numbers on how the extension behaves on real pages – without a model (fake backend as in
the E2E tests); this is about text selection, grouping and language, not about scores.

## Scope
1. **Measurement script** `scripts/measure-pages.mjs` (Playwright, loads the extension like `test/e2e/helpers.mjs`,
   fake backend, configure the provider so that no download is needed). Per URL: load the page, trigger "Scan
   page now" (or scan mode "all pages"), wait, then read from the DOM
   (`data-aivsai-*` hooks, see `content.js`): number of candidates, scored, skipped (language),
   groups and their size, share of paragraphs < 120 words before/after grouping, word-count distribution.
   Mind the lazy scan (scroll all the way or `lazyScan` off). Result as JSON + Markdown table.
2. **URL list** `scripts/measure-pages.urls.txt`: ~30 public pages, mixed: English
   news (BBC, Reuters, AP, Guardian …), blogs/Medium, Wikipedia, how-tos (WikiHow,
   Instructables), forums (Reddit old, Stack Exchange), documentation pages; plus 5–8 non-English ones
   (German/French/Spanish) and 2–3 mixed-language ones. Only public pages without login, no
   blocked ones (blocklist). Polite: one page after the other, no crawling.
3. **Evaluation** in `test/REAL_PAGES.md`: table per page
   and summary. Questions: how often does the grouping kick in (rule "same parent element")? How
   many paragraphs remain "uncertain, short"? Is the language detected correctly (English pages ≈ 0 skipped,
   German ones ≈ all)? List wrongly detected paragraphs with an example (shortened).
4. **Recommendations** (only in the report and in `REAL_PAGES.md`, do not implement): e.g. relax the grouping
   rule (common ancestor up to depth N?), adjust the language detection.

## Allowed files
`scripts/measure-pages.mjs`, `scripts/measure-pages.urls.txt`, `test/REAL_PAGES.md`, `package.json`
(only add an npm script `measure:pages`). **No** changes to `extension/**` – if a
test hook is missing, report it in the log as a QUESTION and do without.

## Acceptance
- Script runs reproducibly (`npm run measure:pages`); pages that do not load are skipped
  and noted.
- `test/REAL_PAGES.md` with real numbers for ≥ 25 pages and concrete recommendations.
- `npm test` stays green (nothing changed in the extension).
