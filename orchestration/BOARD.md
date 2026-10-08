# Board

As of: 2026-10-08. Status: `open` · `running` · `review` · `merged` · `blocked (user)`.
Completed WPs (WP-01 to WP-11) are in the git history; their results live in `training/EVAL_RESULTS.md`,
`training/MODEL_SEARCH.md` and `test/REAL_PAGES.md`.

| WP | Topic | TODO ref | Branch | Status | Files (exclusive) |
|---|---|---|---|---|---|
| WP-04 | "Check model" with a real HF token | item 1 | – | blocked (user) | needs token |
| WP-05 | Contact/legal notice in `privacy.html` | item 4 | – | blocked (user) | needs name/address |
| WP-12 | Switch repo language to English only (issue #3) | – | see log | running | 12a `extension/**`, `test/**` · 12b docs, `store/**`, `server/**`, `scripts/**` · 12c `training/**` |

## Candidates for the next round

- Compare fakespot in the real browser (WASM) against Python scores (TODO item 2)
- Measure grouping on home/section pages, catch teaser lists (TODO item 2)
- Add GPT-4/ChatGPT/Cohere from RAID to the reference set (TODO item 1)
- "Detailed check" and sliders for `reliableWords`/`shortRedFrom` (TODO item 1)
- Score calibration per model (TODO item 5)
