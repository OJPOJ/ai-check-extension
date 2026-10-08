# WP-02 · Score short paragraphs together (TODO item 2)

## Problem
Paragraphs below `reliableWords` (120 words) never turn red with TMR, and with desklib only from 0.98
(otherwise "uncertain"). On news sites that is the majority of paragraphs. More context reduces the errors
considerably (`training/EVAL_RESULTS.md`, sections "Text length" and "Confidence for short paragraphs").

## Goal
Score neighbouring short paragraphs of the same article/container as **one** text and assign the result
to all of them. If the group reaches `reliableWords` together, the normal traffic light applies.

## Notes
- First understand `extension/content.js`: candidate selection, batching (`BATCH_MAX_CHARS`), prioritisation,
  lazy scan, result registry, popover, feedback, language detection per paragraph (`lang-detect.js`),
  length buckets. Also `extension/bg/scoring.js` (cache/score store, keys).
- Choose sensible grouping rules and log them as `DECISION`, e.g.: same block container
  (common parent node/article), directly adjacent, same detected language, no heading/
  list in between, group up to the model's `maxChars` limit. Long paragraphs stay on their own.
- The word count for the traffic light is that of the group. Make it briefly visible in the popover/check
  result that the score covers several paragraphs.
- Caching: the score belongs to the group text; key/store such that nothing is assigned twice or
  wrongly. Feedback then refers to the group text.
- The right-click check of a selection stays unchanged.
- Make it configurable if it fits (config switch, default on), but do **not** change the options
  page (belongs to WP-03) – if needed, as a suggestion in the report.

## Allowed files
`extension/content.js`, `extension/content-popover.js`, `extension/content.css`, `extension/config.js`,
`extension/models.js`, `extension/bg/scoring.js`, `extension/bg/score-store.js`, `extension/background.js`,
`test/**`. Not: `manifest.json`, `options.*`, `popup.*`, `training/**`.

## Acceptance
- New unit/E2E tests for the grouping (extend the harness `test/harness.html`), incl. edge cases
  (heading in between, different language, long paragraph, group over `maxChars`).
- `npm test` completely green (in the worktree, setup see `orchestration/README.md`).
- Suggestion for a README paragraph ("Fewer false alarms") in the report.
