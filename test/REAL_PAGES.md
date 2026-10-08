# Real pages: text selection, grouping and language (WP-08)

Measured on 2026-09-26 with `scripts/measure-pages.mjs` against a fake backend (as in the E2E tests, `test/e2e/helpers.mjs`) - it is about text selection, grouping (`extension/content.js`, `groupCandidates`) and language detection (`extension/lang-detect.js`), **not** about scores. Configuration: `provider: local`, `localModel: desklib` (production default, `maxChars` 1500/`reliableWords` 120), `scanMode: all`, `lazyScan: false` (whole page at once), `groupShortParagraphs: true` (default). URLs are deliberately single articles instead of home pages (rework after orchestrator review: home pages consist almost only of teaser links < 40 words and say little about grouping; the first version also had 550/680 scored paragraphs from just 3 Wikipedia articles - Wikipedia is now capped at 3 articles, plus 14 single English news articles from 6 publishers).

**32 of 32** pages technically loaded and measured; of these, 3 (apnews.com) are effectively unusable because in the automated request they received a bot check page instead of the article (see "Two notable points about the news articles" below) - so net 29 evaluable pages, well above the required minimum of 25.

## Table per page

| Page | Language | Category | Candidates | scored | skipped | Groups (>1) | Avg. size | <120 words before | <120 words after | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| [www.bbc.com/news/articles/c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | en | News article | 1 | 1 | 0 | 0 | – | 0% | 0% | whole article as 1 candidate (see below) |
| [www.bbc.com/news/articles/cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | en | News article | 1 | 1 | 0 | 0 | – | 0% | 0% | whole article as 1 candidate (see below) |
| [www.bbc.com/news/articles/cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | en | News article | 1 | 1 | 0 | 0 | – | 100% | 100% | only 1 paragraph reached 40 words, rest too short for a candidate (see below) |
| [www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk](https://www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk) | en | News article | 34 | 34 | 0 | 2 | 2.5 | 29% | 16% | – |
| [www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record](https://www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record) | en | News article | 2 | 2 | 0 | 1 | 2.0 | 100% | 100% | – |
| [www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo](https://www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo) | en | News article | 5 | 5 | 0 | 1 | 4.0 | 100% | 50% | – |
| [www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit](https://www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit) | en | News article | 5 | 5 | 0 | 1 | 4.0 | 100% | 50% | – |
| [www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities](https://www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities) | en | News article | 2 | 2 | 0 | 1 | 2.0 | 100% | 0% | – |
| [www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war](https://www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war) | en | News article | 3 | 3 | 0 | 1 | 2.0 | 100% | 100% | – |
| [apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93](https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93) | en | News article | 0 | 0 | 0 | 0 | – | – | – | Cloudflare bot check loaded instead of article (see below) |
| [apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28](https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28) | en | News article | 0 | 0 | 0 | 0 | – | – | – | Cloudflare bot check loaded instead of article (see below) |
| [apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597](https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597) | en | News article | 0 | 0 | 0 | 0 | – | – | – | Cloudflare bot check loaded instead of article (see below) |
| [www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news](https://www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news) | en | News article | 7 | 7 | 0 | 1 | 2.0 | 100% | 100% | – |
| [www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894](https://www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894) | en | News article | 6 | 6 | 0 | 2 | 2.0 | 100% | 100% | – |
| [danluu.com/wat/](https://danluu.com/wat/) | en | Blog | 45 | 45 | 0 | 9 | 2.1 | 67% | 31% | – |
| [overreacted.io/a-complete-guide-to-useeffect/](https://overreacted.io/a-complete-guide-to-useeffect/) | en | Blog | 68 | 68 | 0 | 20 | 2.9 | 100% | 52% | – |
| [css-tricks.com/complete-guide-css-grid-layout/](https://css-tricks.com/complete-guide-css-grid-layout/) | en | Blog | 9 | 9 | 0 | 1 | 2.0 | 100% | 88% | – |
| [jvns.ca/blog/2026/07/21/more-nice-django-things/](https://jvns.ca/blog/2026/07/21/more-nice-django-things/) | en | Blog | 17 | 17 | 0 | 5 | 2.8 | 100% | 63% | – |
| [www.wikihow.com/Bake-a-Cake](https://www.wikihow.com/Bake-a-Cake) | en | How-to | 34 | 34 | 0 | 9 | 3.4 | 100% | 33% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 2 deferred (numbers possibly incomplete) |
| [www.wikihow.com/Tie-a-Tie](https://www.wikihow.com/Tie-a-Tie) | en | How-to | 10 | 10 | 0 | 2 | 3.0 | 100% | 83% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 2 deferred (numbers possibly incomplete) |
| [www.wikihow.com/Change-a-Tire](https://www.wikihow.com/Change-a-Tire) | en | How-to | 23 | 23 | 0 | 4 | 2.8 | 91% | 69% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 3 deferred (numbers possibly incomplete) |
| [docs.python.org/3/tutorial/introduction.html](https://docs.python.org/3/tutorial/introduction.html) | en | Documentation | 14 | 14 | 0 | 3 | 2.7 | 100% | 78% | – |
| [developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures) | en | Documentation | 19 | 19 | 0 | 7 | 2.6 | 100% | 25% | – |
| [en.wikipedia.org/wiki/Climate_change](https://en.wikipedia.org/wiki/Climate_change) | en | Wikipedia | 211 | 211 | 0 | 60 | 2.5 | 88% | 34% | – |
| [de.wikipedia.org/wiki/Deutschland](https://de.wikipedia.org/wiki/Deutschland) | de | Wikipedia | 275 | 1 | 274 | 0 | – | 100% | 100% | – |
| [en.wikipedia.org/wiki/Denglisch](https://en.wikipedia.org/wiki/Denglisch) | mixed | Wikipedia | 28 | 25 | 3 | 6 | 2.8 | 88% | 36% | – |
| [www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html](https://www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html) | de | News article | 6 | 0 | 6 | 0 | – | – | – | – |
| [www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602](https://www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602) | de | News article | 16 | 0 | 16 | 0 | – | – | – | – |
| [www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons](https://www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons) | fr | News article | 6 | 0 | 6 | 0 | – | – | – | – |
| [www.dw.com/fr/pape-leon-visite-france-europe/a-79429249](https://www.dw.com/fr/pape-leon-visite-france-europe/a-79429249) | fr | News article | 11 | 0 | 11 | 0 | – | – | – | – |
| [www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643](https://www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643) | es | News article | 8 | 0 | 8 | 0 | – | – | – | – |
| [www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml](https://www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml) | es | News article | 16 | 0 | 16 | 0 | – | – | – | – |

### Two notable points about the news articles

**BBC (3 articles, 1 candidate instead of many short paragraphs).** Spot check in the raw HTML: BBC writes very
short paragraphs (7–38 words per `<p>`, see the `curl` excerpt below) - practically none reaches
`MIN_WORDS` (40, `content.js`) on its own. For two of the three articles `hasLongCandidateChild` then does not apply (no
child paragraph is long enough on its own), so the enclosing `<article>` itself becomes the *only*
candidate - with its entire text (416 and 842 words respectively) as one block. In the third article
only the one `<p>` with exactly 40 words becomes a candidate, all others stay below the threshold and do not appear
in the scan at all. In both cases `groupCandidates` is never used, because there are no multiple
short candidates next to each other that it could combine - the paragraphs are there, but below
the candidate threshold invisible to the whole pipeline (selection *and* grouping).

```
$ curl -s https://www.bbc.com/news/articles/c60m334grx9vo | grep -oE "<p[^>]*>.*?</p>" | head -5
# Word counts of the individual <p>: 37, 25, 21, 32, 31 … (none reaches 40)
```

**AP News (3 articles, 0 candidates).** At first this looked like a selection problem, but it is not: in the
raw HTML (`curl`) the article text sits normally in `<p>` tags (`RichTextStoryBody`, 38 paragraphs, the first
clearly over 40 words). In the real Playwright browser, however, apnews.com serves a
Cloudflare bot check page (`Nur einen Moment… Sicherheitsüberprüfung wird durchgeführt`, HTTP 200,
~300 characters of text) instead of the article - verified with a direct additional request via the same
`launchExtension` infrastructure. `httpStatus` alone (which the script only sets on `!resp.ok()` anyway)
does not detect this, since the status code is 200. Reddit and Stack Exchange were affected
similarly in the first version of this measurement (there with HTTP 403). This is an automation/bot-detection quirk of the
target site, not a statement about the extension in a human's normal browser - the three AP rows above
are therefore to be treated like "not loaded" for the evaluation, not like "page without long paragraphs".

## Pages not loaded

None - all pages in the list could be loaded.

## Summary

- Paragraphs in total (scored, across all pages): 543
- Share under 120 words **before** grouping (single paragraph): **87%**
- Share under 120 words **after** grouping (group or single paragraph, 320 scoring units): **43%**
- Groups with more than one paragraph: 136 of 320 scoring units

### Split by page type

| Category | Pages | Paragraphs before | <120 words before | Units after | <120 words after |
|---|---:|---:|---:|---:|---:|
| News article | 20 | 67 | 61% | 52 | 40% |
| Blog | 4 | 139 | 89% | 82 | 48% |
| How-to | 3 | 67 | 97% | 34 | 59% |
| Documentation | 2 | 33 | 100% | 17 | 53% |
| Wikipedia | 3 | 237 | 88% | 135 | 35% |

## Language detection

| Language | Pages | scored (= treated as English) | skipped (detected as foreign) |
|---|---:|---:|---:|
| en | 24 | 517 | 0 |
| de | 3 | 1 | 296 |
| mixed | 1 | 25 | 3 |
| fr | 2 | 0 | 17 |
| es | 2 | 0 | 24 |

Expectation: for `en`, "skipped" should be ≈ 0, for `de`/`fr`/`es`, "scored" should be ≈ 0 (the whole page skipped). `mixed` pages deliberately have both.

### Notable cases (truncated)

| Page | Language | Kind | Excerpt |
|---|---|---|---|
| https://de.wikipedia.org/wiki/Deutschland | de | de scored instead of skipped | Hans-Martin Henning, Andreas Palzer: A comprehensive model for the German electricity and heat sector in a future energy system with a dominant contribution fro… |

## Grouping rule: counted effect of a relaxation

Replays `groupCandidates` (content.js) with real page data, once with the actual rule (`actual` - exactly the same parent node, corresponds to depth 1) and with two variants: common ancestor up to depth 2/3 instead of exactly the same parent node (`depth2`/`depth3`), doubled `maxChars` (`maxChars2x`, 3000 instead of 1500 characters) and both combined. `actual` should reproduce the actually measured groups (table above) - serves as a cross-check of the simulation.

### All pages

| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |
|---|---:|---:|---:|---:|
| actual rule | 320 | 136 | 43% | 359 |
| ancestor up to depth 2 | 316 | 138 | 41% | 365 |
| ancestor up to depth 3 | 316 | 138 | 41% | 365 |
| maxChars ×2 | 279 | 113 | 41% | 377 |
| depth 2 + maxChars ×2 | 274 | 115 | 39% | 384 |

### News articles only (category "news")

| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |
|---|---:|---:|---:|---:|
| actual rule | 52 | 10 | 40% | 25 |
| ancestor up to depth 2 | 52 | 10 | 40% | 25 |
| ancestor up to depth 3 | 52 | 10 | 40% | 25 |
| maxChars ×2 | 51 | 10 | 39% | 26 |
| depth 2 + maxChars ×2 | 51 | 10 | 39% | 26 |

## Recommendations (not implemented, suggestion only)

### Grouping: depth-N idea from the first version refuted by counting

The original recommendation ("common ancestor up to depth N instead of exactly the same parent node") was based
on Wikipedia footnote lists. Recounted with real news articles (section "Grouping rule"
above, table "News articles only") it makes **no measurable difference**: depth 2 and depth 3
yield exactly the same 52 scoring units and 10 multi-groups as the actual rule - on
news pages, adjacent short paragraphs almost always already sit in the same immediate parent node
(normal `<p>` sequences, no nested wrappers as with Wikipedia citations). Doubled `maxChars`
also brings hardly anything on news articles (52 → 51 units). **Recommendation: do not implement
the depth-N change** - the effort is out of proportion to the benefit on the type of page the grouping
was originally intended for (TODO item 2). For Wikipedia-heavy evaluations (footnote lists) it could
still bring something (all pages: 320 → 316/316 units, 136 → 138 multi-groups), but that is an
edge case, not a core scenario.

### The real lever: candidate selection for very short paragraphs (BBC style)

The sample shows a clearer, previously undocumented effect: On pages with a very short
paragraph style (BBC: 7–38 words per `<p>`), practically every single paragraph falls below `MIN_WORDS` (40)
before `groupCandidates` even comes into play. Candidate selection then falls back either to the whole
`<article>` container (one candidate, several hundred words of mixed text) or captures only the one
paragraph that happens to just reach the 40-word threshold - the rest of the article stays invisible to the whole
pipeline. That is something different from the originally suspected grouping problem: It happens
*before* `groupCandidates`, in `MIN_WORDS`/`hasLongCandidateChild` (`content.js`, `collectCandidates`).
**Unimplemented suggestion, with reservations**: lower `MIN_WORDS` for the *grouping* path (e.g. to
~15–20 words, only if `groupShortParagraphs` is on and a neighboring paragraph is there to attach to), so that
such short-paragraph chains show up as candidates at all and can be grouped, instead of being lost in a
single large candidate. That is a bigger intervention than the depth-N idea (it changes what counts
as a candidate at all, not just what is grouped) and should be checked on more pages with this style
before being implemented - in this sample only BBC was clearly affected, Guardian/Al
Jazeera/PBS/DW with normal paragraph lengths (~40–70 words/`<p>`), on the other hand, grouped reliably (see
examples above: Guardian article 49+69 → one group with 118 words, Michigan CEO article 4 of 5 paragraphs
combined into 215 words).

### Language detection: still no need for change

With 6 single non-English news articles (instead of only Wikipedia) the picture from the
first version is confirmed: all six were skipped completely (100%), not a single paragraph was wrongly
scored. The only borderline case remains the already reported English citation title in `de.wikipedia.org/wiki/
Deutschland` - correctly detected, not an error. No change to `lang-detect.js` suggested.

### Miscellaneous

- **Scan completeness**: On the 3 WikiHow pages, after 40 s 2–3 paragraphs each remained marked as "deferred"
  (not "pending") - these are paragraphs present on the server side but currently not rendered in the browser
  (collapsed method sections or similar), not a slow response. The reported numbers for these
  three pages are therefore incomplete by a few paragraphs (see the Notes column); a human who expands the
  sections would get them scored afterwards (the MutationObserver covers that).
- **Misdetection as a bot**: apnews.com served a Cloudflare check page in this automated request
  instead of the article (see above) - for future measurements either plan alternatives
  or extend the script with a simple bot-page detection (e.g. check `document.title` against known
  Cloudflare/consent titles), so that such pages do not silently flow into the
  statistics as "0 candidates".
---

# WP-10: Making very short paragraphs groupable (re-measurement)

Changes `extension/content.js`: Paragraphs may now become candidates from 15 words (`GROUP_MIN_WORDS`, instead of the previous
`MIN_WORDS` = 40) - but only if they are combined with direct neighbors (`groupCandidates`) into a
group with at least `MIN_WORDS` (40) words together; a single paragraph in
this range without a suitable neighbor stays unscored as before. Containers (`hasLongCandidateChild`)
are accordingly less often additionally scored as a whole as soon as a child itself can become a (grouped) candidate -
that was previously (WP-08) the real bottleneck at BBC: practically no single `<p>` reached
40 words, so the whole `<article>` container became the only candidate.

Measured on 2026-09-26, exactly the same URL list and configuration as above (WP-08: `provider: local`,
`localModel: desklib`, `scanMode: all`, `lazyScan: false`, `groupShortParagraphs: true`) - directly
comparable. **32 of 32** pages measured, 0 failed (AP News again delivered only the
Cloudflare bot check page as in WP-08, see there - to be treated like "not loaded" for the evaluation).

## BBC: the actual target case (before/after)

| Page | Candidates before | scored before | Note before | Candidates after | scored after | Groups (>1) after | Avg. size after | <120 words after |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| [c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | 1 | 1 | whole article as 1 candidate (416 words) | 12 | 12 | 2 | 6.0 | 0% |
| [cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | 1 | 1 | whole article as 1 candidate (842 words) | 29 | 29 | 7 | 4.1 | 86% |
| [cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | 1 | 1 | only 1 paragraph happened to reach 40 words, rest invisible | 18 | 18 | 3 | 6.0 | 0% |

Before, the content of two articles disappeared completely into a single, opaque score
(416 and 842 words of mixed text with no way to narrow down a flagged passage); for the third,
almost the whole article was invisible to the pipeline. After, all three break up into 12-29 individually
addressable scoring units, most of them as groups of several paragraphs -
exactly the effect named as the "real lever" in `test/REAL_PAGES.md` (WP-08). `cjn5ddzekwnro`
nevertheless stays rather granular after grouping, with 86% under 120 words (many subheadings
break the chain, see `groupCandidates`/`hasBreakBetween`) - worse than one ideal large group,
but incomparably better than the previous whole-page scoring.
## Table per page

| Page | Language | Category | Candidates | scored | skipped | Groups (>1) | Avg. size | <120 words before | <120 words after | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| [www.bbc.com/news/articles/c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | en | News article | 12 | 12 | 0 | 2 | 6.0 | 100% | 0% | – |
| [www.bbc.com/news/articles/cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | en | News article | 29 | 29 | 0 | 7 | 4.1 | 100% | 86% | – |
| [www.bbc.com/news/articles/cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | en | News article | 18 | 18 | 0 | 3 | 6.0 | 100% | 0% | – |
| [www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk](https://www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk) | en | News article | 34 | 34 | 0 | 2 | 2.5 | 29% | 16% | – |
| [www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record](https://www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record) | en | News article | 20 | 20 | 0 | 4 | 5.0 | 100% | 50% | – |
| [www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo](https://www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo) | en | News article | 23 | 23 | 0 | 4 | 5.8 | 100% | 25% | – |
| [www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit](https://www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit) | en | News article | 12 | 12 | 0 | 3 | 4.0 | 100% | 33% | – |
| [www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities](https://www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities) | en | News article | 14 | 14 | 0 | 3 | 4.7 | 100% | 33% | – |
| [www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war](https://www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war) | en | News article | 17 | 17 | 0 | 4 | 4.3 | 100% | 50% | – |
| [apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93](https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93) | en | News article | 1 | 0 | 1 | 0 | – | – | – | – |
| [apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28](https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28) | en | News article | 1 | 0 | 1 | 0 | – | – | – | – |
| [apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597](https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597) | en | News article | 1 | 0 | 1 | 0 | – | – | – | – |
| [www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news](https://www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news) | en | News article | 32 | 32 | 0 | 9 | 3.6 | 100% | 78% | – |
| [www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894](https://www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894) | en | News article | 30 | 30 | 0 | 9 | 3.3 | 100% | 67% | – |
| [danluu.com/wat/](https://danluu.com/wat/) | en | Blog | 52 | 52 | 0 | 13 | 2.2 | 71% | 33% | – |
| [overreacted.io/a-complete-guide-to-useeffect/](https://overreacted.io/a-complete-guide-to-useeffect/) | en | Blog | 164 | 164 | 0 | 35 | 4.5 | 100% | 40% | – |
| [css-tricks.com/complete-guide-css-grid-layout/](https://css-tricks.com/complete-guide-css-grid-layout/) | en | Blog | 23 | 23 | 0 | 7 | 2.7 | 100% | 82% | – |
| [jvns.ca/blog/2026/07/21/more-nice-django-things/](https://jvns.ca/blog/2026/07/21/more-nice-django-things/) | en | Blog | 29 | 29 | 0 | 8 | 3.4 | 100% | 60% | – |
| [www.wikihow.com/Bake-a-Cake](https://www.wikihow.com/Bake-a-Cake) | en | How-to | 34 | 34 | 0 | 11 | 2.5 | 100% | 82% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 2 deferred (numbers possibly incomplete) |
| [www.wikihow.com/Tie-a-Tie](https://www.wikihow.com/Tie-a-Tie) | en | How-to | 32 | 32 | 0 | 8 | 3.8 | 100% | 70% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 2 deferred (numbers possibly incomplete) |
| [www.wikihow.com/Change-a-Tire](https://www.wikihow.com/Change-a-Tire) | en | How-to | 33 | 33 | 0 | 9 | 3.3 | 100% | 67% | Scan did not finish (still pending/deferred) (after 40000 ms) - at read time still 0 pending, 3 deferred (numbers possibly incomplete) |
| [docs.python.org/3/tutorial/introduction.html](https://docs.python.org/3/tutorial/introduction.html) | en | Documentation | 38 | 38 | 0 | 6 | 5.7 | 100% | 50% | – |
| [developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures) | en | Documentation | 45 | 45 | 0 | 11 | 4.0 | 100% | 33% | – |
| [en.wikipedia.org/wiki/Climate_change](https://en.wikipedia.org/wiki/Climate_change) | en | Wikipedia | 507 | 500 | 7 | 113 | 4.0 | 96% | 27% | – |
| [de.wikipedia.org/wiki/Deutschland](https://de.wikipedia.org/wiki/Deutschland) | de | Wikipedia | 500 | 2 | 498 | 1 | 2.0 | 100% | 100% | – |
| [en.wikipedia.org/wiki/Denglisch](https://en.wikipedia.org/wiki/Denglisch) | mixed | Wikipedia | 54 | 44 | 10 | 13 | 3.2 | 93% | 38% | – |
| [www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html](https://www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html) | de | News article | 16 | 0 | 16 | 0 | – | – | – | – |
| [www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602](https://www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602) | de | News article | 18 | 0 | 18 | 0 | – | – | – | – |
| [www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons](https://www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons) | fr | News article | 46 | 0 | 46 | 0 | – | – | – | – |
| [www.dw.com/fr/pape-leon-visite-france-europe/a-79429249](https://www.dw.com/fr/pape-leon-visite-france-europe/a-79429249) | fr | News article | 13 | 0 | 13 | 0 | – | – | – | – |
| [www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643](https://www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643) | es | News article | 18 | 0 | 18 | 0 | – | – | – | – |
| [www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml](https://www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml) | es | News article | 24 | 0 | 24 | 0 | – | – | – | – |

## Pages not loaded

None - all pages in the list could be loaded.

## Summary

- Paragraphs in total (scored, across all pages): 1237
- Share under 120 words **before** grouping (single paragraph): **95%**
- Share under 120 words **after** grouping (group or single paragraph, 410 scoring units): **39%**
- Groups with more than one paragraph: 285 of 410 scoring units

### Split by page type

| Category | Pages | Paragraphs before | <120 words before | Units after | <120 words after |
|---|---:|---:|---:|---:|---:|
| News article | 20 | 241 | 90% | 79 | 39% |
| Blog | 4 | 268 | 94% | 97 | 44% |
| How-to | 3 | 99 | 100% | 39 | 74% |
| Documentation | 2 | 83 | 100% | 22 | 41% |
| Wikipedia | 3 | 546 | 96% | 173 | 28% |

## Language detection

| Language | Pages | scored (= treated as English) | skipped (detected as foreign) |
|---|---:|---:|---:|
| en | 24 | 1191 | 10 |
| de | 3 | 2 | 532 |
| mixed | 1 | 44 | 10 |
| fr | 2 | 0 | 59 |
| es | 2 | 0 | 42 |

Expectation: for `en`, "skipped" should be ≈ 0, for `de`/`fr`/`es`, "scored" should be ≈ 0 (the whole page skipped). `mixed` pages deliberately have both.

### Notable cases (truncated)

| Page | Language | Kind | Excerpt |
|---|---|---|---|
| https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93 | en | English skipped (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28 | en | English skipped (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597 | en | English skipped (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (fr) | Duarte, C.M.; Delgado-Huertas, A.; et al. (17 January 2025). "Carbon burial in sediments below seaweed farms matches that of Blue Carbon habitats". Nature Clima… |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (fr) | Le Treut, H.; Somerville, R.; Cubasch, U.; Ding, Y.; et al. (2007). "Chapter 1: Historical Overview of Climate Change Science" (PDF). IPCC AR4 WG1 2007. pp. 93–… |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (fr) | Rogner, H.-H.; Zhou, D.; Bradley, R.; Crabbé, P.; et al. (2007). "Chapter 1: Introduction" (PDF). IPCC AR4 WG3 2007. pp. 95–116. |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (pt) | Larsen, J. N.; Anisimov, O. A.; Constable, A.; Hollowed, A. B.; et al. (2014). "Chapter 28: Polar Regions" (PDF). IPCC AR5 WG2 B 2014. pp. 1567–1612. |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (fr) | Jia, G.; Shevliakova, E.; Artaxo, P. E.; De Noblet-Ducoudré, N.; et al. (2019). "Chapter 2: Land-Climate Interactions" (PDF). IPCC SRCCL 2019. pp. 131–247. |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (pt) | Albrecht, Bruce A. (1989). "Aerosols, Cloud Microphysics, and Fractional Cloudiness". Science. 245 (4923): 1227–1239. Bibcode:1989Sci...245.1227A. doi:10.1126/s… |
| https://en.wikipedia.org/wiki/Climate_change | en | English skipped (it) | Kossin, J. P.; Hall, T.; Knutson, T.; Kunkel, K. E.; Trapp, R. J.; Walizer, D. E.; Wehner, M. F. (2017). "Chapter 9: Extreme Storms". In USGCRP2017. pp. 1–470. |
| https://de.wikipedia.org/wiki/Deutschland | de | de scored instead of skipped | Hans-Martin Henning, Andreas Palzer: A comprehensive model for the German electricity and heat sector in a future energy system with a dominant contribution fro… |
| https://de.wikipedia.org/wiki/Deutschland | de | de scored instead of skipped | Sebastian Strunz, The German energy transition as a regime shift. In: Ecological Economics 100 (2014), S. 150–158, hier S. 150, doi:10.1016/j.ecolecon.2014.01.0… |

## Grouping rule: counted effect of a relaxation

Replays `groupCandidates` (content.js) with real page data, once with the actual rule (`actual` - exactly the same parent node, corresponds to depth 1) and with two variants: common ancestor up to depth 2/3 instead of exactly the same parent node (`depth2`/`depth3`), doubled `maxChars` (`maxChars2x`, 3000 instead of 1500 characters) and both combined. `actual` should reproduce the actually measured groups (table above) - serves as a cross-check of the simulation.

### All pages

| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |
|---|---:|---:|---:|---:|
| actual rule | 410 | 285 | 39% | 1112 |
| ancestor up to depth 2 | 406 | 287 | 38% | 1118 |
| ancestor up to depth 3 | 406 | 287 | 38% | 1118 |
| maxChars ×2 | 342 | 228 | 39% | 1123 |
| depth 2 + maxChars ×2 | 337 | 229 | 38% | 1129 |

### News articles only (category "news")

| Variant | Scoring units | of which groups >1 | <120 words | Paragraphs in a group |
|---|---:|---:|---:|---:|
| actual rule | 79 | 50 | 39% | 212 |
| ancestor up to depth 2 | 79 | 50 | 39% | 212 |
| ancestor up to depth 3 | 79 | 50 | 39% | 212 |
| maxChars ×2 | 75 | 45 | 41% | 211 |
| depth 2 + maxChars ×2 | 75 | 45 | 41% | 211 |

## Assessment and risks (WP-10)

- **The depth-N question remains refuted.** `ancestor up to depth 2/3` with the new, far more numerous
  scoring units still yields practically the same picture as the actual rule (410 vs. 406 units,
  285 vs. 287 multi-groups) - the WP-08 recommendation not to implement this change stands unchanged.
- **Container downside (documented risk, see `hasLongCandidateChild` in `content.js`).** An
  isolated short paragraph (15-39 words) without a groupable neighbor now stays unscored, *and* its
  container is no longer scored as a whole as a substitute (previously the container would at least have delivered
  some score). In this sample this has visibly worsened the detection rate nowhere
  (see table: consistently more instead of fewer scored candidates per page) - on pages
  with predominantly very short, isolated paragraphs (caption galleries, bullet lists without
  running text) a drop to 0 candidates per container is conceivable, though, and not part of this measurement
  (all 32 URLs are article pages with running text).
- **Teaser/navigation risk only partially checked.** The average group size stays moderate across all pages
  (max. 6.0 for the two BBC articles, otherwise 2.0-5.8) - no sign of masses of combined
  link lists in this sample. The URL list, however, deliberately consists only of single article pages
  (WP-08 rework), **not** of home/section pages with many teaser links outside a
  `<nav>`/`role="navigation"` - exactly there the risk would be greatest, because `<li>` or `<p>` link texts
  are often 15-39 words long and need not be marked as navigation by anything. Not covered by this
  measurement; see the final report to the orchestrator for an assessment.
- **Language detection still unremarkable with very short groups.** Due to the lower threshold, considerably
  more, previously invisible short paragraphs became candidates (e.g. single foreign-language Wikipedia
  citations/footnotes under 40 words) - as a result "skipped" rose in all languages (among others `en`: 0 → 10,
  correctly detected single fr/it/pt citations within otherwise English articles; `de`: 296 → 532, because on
  `de.wikipedia.org/wiki/Deutschland` very short German paragraphs now also show up as candidates and are
  correctly skipped). Wrongly scored foreign-language paragraphs remain a rare
  exception with 2 of 534 `de` candidates (identical single case as in WP-08, an English-language citation title) -
  no new pattern, no change to `lang-detect.js` needed.
