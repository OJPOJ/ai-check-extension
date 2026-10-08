# Log

Format: `- YYYY-MM-DD HH:MM · <WP|ORCH|USER> · <TYPE> · text` – append only.
(Rounds 1–3, WP-01 to WP-11, were cleared on 2026-10-08; see the git history.)

- 2026-10-08 18:50 · ORCH · START · Round 4, WP-12 (issue #3, repo language English only): WP-12a (extension + tests), WP-12b (docs, store, server, scripts), WP-12c (training) assigned to Sonnet workers, each in its own worktree. Baseline npm test 230/230 green.
- 2026-10-08 18:50 · ORCH · DECISION · Scope of "English only": UI texts, comments, tests, docs, script output, store listing. German stays only where it is data (stopword lists and German fixtures for the language detection, URLs, dataset contents). Workers do not write to this log in this round; their decisions are in the final reports.
- 2026-10-08 18:56 · ORCH · INFO · WP-12c reviewed (digit sequences of all 19 files compared against the German originals, spot-read) and merged (60ca39b). Followed up: grey level "unsicher" is "uncertain" (not "unclear" = yellow), references to the cleared log now point at the git history.
- 2026-10-08 18:59 · ORCH · INFO · WP-12b reviewed and merged (2c6aaf7). Found by comparing digit sequences: the BBC before/after table (3 rows) plus the paragraph below it were missing in test/REAL_PAGES.md - restored. RESOURCES.md heading back to "Open questions / not verified". Structure counts (headings, table rows, list items) of all docs match the German originals; store/LISTING.md deliberately keeps only the English half.
