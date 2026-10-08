# WP-10 · Make very short paragraphs groupable (TODO item 2)

## Starting point
`test/REAL_PAGES.md` (WP-08): the grouping (`groupCandidates` in `extension/content.js`) helps with
news articles (scoring units that are too short 61% → 40%). Bottleneck: `MIN_WORDS` = 40 filters
paragraphs **before** the grouping. Pages with very short paragraphs (BBC: 7–38 words) therefore yield no
individual candidates, but at most the whole article container (or one paragraph by chance). A
relaxed ancestor rule demonstrably does not help.

## Goal
Paragraphs from a lower limit (suggestion ~15 words, choose with reasons) may be candidates
**if** they are grouped with neighbours and the group reaches at least `MIN_WORDS`. On their own
they stay unscored as before. No double markings: containers whose children are now
grouped must not be scored as a whole in addition (`hasLongCandidateChild` and the like).

## Notes
- Read `content.js` thoroughly: phase 1 (`collectCandidates`), container logic, `MIN_WORDS` places
  (among others one that compares characters instead of words – check whether that is intentional), `groupCandidates`,
  MutationObserver/lazy scan, popover/tooltip (group hint), statistics in the popup (counters).
- Language detection on very short text is less certain: determine the language of the group sensibly
  (e.g. form the group only after same language as before, conservative for "unknown") – log a DECISION.
- Captions, teasers, navigation/link lists must not turn into groups en masse;
  existing exclusions (roles, navigation, dialogs, code) must keep working.
- Afterwards run `npm run measure:pages` (see README, fake backend, ~5–8 min) and add the before/
  after comparison per page type to `test/REAL_PAGES.md` (new section, do not overwrite existing
  numbers). In particular: BBC articles.

## Allowed files
`extension/content.js`, `extension/content-popover.js`, `extension/content.css`, `test/e2e/**`,
`test/harness.html`, `test/REAL_PAGES.md`, `scripts/measure-pages.mjs`, `scripts/measure-pages.urls.txt`.
Not: `config.js`, `models.js`, `offscreen.js`, `test/unit/config.test.mjs`, `test/unit/providers.test.mjs`
(belong to WP-09), `test/unit/model-check.test.mjs`, `test/e2e/model-check.test.mjs` (WP-11).
If a config switch is needed, suggest it in the report instead of changing `config.js`.

## Acceptance
- E2E tests: very short paragraphs grouped (group ≥ MIN_WORDS), a single very short paragraph stays
  unscored, no duplicate with the container, heading/list still breaks the chain.
- `npm test` green, measurement on real pages with before/after.
