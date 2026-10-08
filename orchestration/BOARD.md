# Board

As of: 2026-10-08 (round 4). Status: `open` · `running` · `review` · `merged` · `blocked (user)`.

| WP | Topic | TODO ref | Branch | Status | Files (exclusive) |
|---|---|---|---|---|---|
| WP-01 | Broaden the eval suite | item 3 | `worktree-agent-a41cd225a4c09d22f` | merged (77c0c65) | `training/**` |
| WP-02 | Score short paragraphs together | item 2 | `worktree-agent-a94937e0b8c91a3fc` | merged (40c4e83) | `extension/content.js`, `extension/config.js`, `extension/models.js`, `test/**` |
| WP-03 | Store preparation | item 4 | `worktree-agent-a64ca70f4997d0b39` | merged (0403d72) | `extension/manifest.json`, `extension/icons/**`, `extension/options.*`, `extension/about.*`, `store/**`, `scripts/**` |
| WP-04 | "Check model" with a real HF token | item 1 | – | blocked (user) | needs token |
| WP-05 | Contact/legal notice in `privacy.html` | item 4 | – | blocked (user) | needs name/address |
| WP-06 | Another model between TMR and desklib | item 2 | `worktree-agent-afb11d9e3237c9af7` | merged (b7721a2) | `training/**` except `EVAL_RESULTS.md`; own `training/MODEL_SEARCH.md` |
| WP-07 | Securing the thresholds (desklib full, cross-validation, TMR/how-tos) | item 3/5 | `worktree-agent-a96c0e3a2ca3f7416` | merged (f3e9ecb) | `training/**` except `MODEL_SEARCH.md` |
| WP-08 | Measure grouping/language on real pages | item 2 | `worktree-agent-aa5dcd919e80a3d89` | merged (08afe69) | `scripts/measure-pages.*`, `test/REAL_PAGES.md`, `package.json` |
| WP-09 | Integrate fakespot (ONNX comparison, cross-validation) | item 2 | `worktree-agent-ad415fba0f70a8594` | merged (9c2969f) | `models.js`, `offscreen.js`, `THIRD_PARTY_NOTICES.md`, `training/**` (except `build_reference_set.py`), `test/unit/{config,providers}.test.mjs` |
| WP-10 | Very short paragraphs groupable | item 2 | `worktree-agent-af2c7b66db2f25df9` | merged (9c23ec6) | `content*.js/css`, `test/e2e/**` (except model-check), `test/harness.html`, `test/REAL_PAGES.md`, `scripts/measure-pages.*` |
| WP-11 | Broaden the BYOM reference set | item 1 | `worktree-agent-ad16f2c4ba4795d55` | merged (abd36fd) | `bg/reference-set.js`, `bg/model-check.js`, `about.html`, `training/build_reference_set.py`, `test/*/model-check.test.mjs` |
| WP-12 | Switch repo language to English only (issue #3) | – | see log | running | 12a `extension/**`, `test/**` · 12b docs, `store/**`, `server/**`, `scripts/**` · 12c `training/**` |

## Round 2 (completed)

desklib = default (3bc5c6f), desklib red from 0.94 (3306b60). WP-06, WP-07, WP-08 merged.

## Round 3 (completed)

fakespot as third model, very short paragraphs groupable, reference set HC3 + RAID wiki.

## Round 4 (running)

Repo language English only (issue #3): WP-12a/b/c, `orchestration/**` translated by the orchestrator.

## Candidates for round 5

- Compare fakespot in the real browser (WASM) against Python scores (TODO item 2)
- Measure grouping on home/section pages, catch teaser lists (TODO item 2)
- Add GPT-4/ChatGPT/Cohere from RAID to the reference set (TODO item 1)
- "Detailed check" and sliders for `reliableWords`/`shortRedFrom` (TODO item 1)
- Score calibration per model (TODO item 5)
