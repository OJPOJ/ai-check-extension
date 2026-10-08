# Orchestration

Parallel work by several agents on this repo. An orchestrator (Opus) plans, distributes, reviews and
merges; worker agents (Sonnet) each handle one work package (WP) in their own git worktree.

## Roles

| Role | Who | Tasks |
|---|---|---|
| Client | user | priorities, decisions, approvals (push, publication, credentials) |
| Orchestrator | Claude Opus | cut WPs, write briefs, start agents, review results, merge, maintain `TODO.md`/`README.md` |
| Worker | Claude Sonnet | implement exactly one WP, test, commit on its own branch, report |

## Files

- `BOARD.md` – overview of all WPs with status. Maintained by the orchestrator only.
- `LOG.md` – shared communication log, append-only.
- `tasks/WP-xx-*.md` – brief per work package: goal, scope, allowed files, acceptance criteria.

## Rules for workers

1. **Change only the files allowed in the brief.** If more is needed, report it in the log with
   `BLOCKER`/`QUESTION` and look for a solution without the file, or keep the change minimal and justify it.
2. **Do not change `TODO.md`, `README.md` (roadmap) and `orchestration/*`** – except for appending to
   `LOG.md`. Suggestions for TODO/README belong in the final report.
3. **Log via the absolute path** `C:\_programme\DS\aivsai\orchestration\LOG.md` (it lives in the main
   checkout, not in the worktree). Append only, never rewrite, e.g.:
   `printf '%s\n' "- 2026-09-26 14:05 · WP-02 · INFO · grouping in content.js is in place, tests running" >> /c/_programme/DS/aivsai/orchestration/LOG.md`
4. **Log types:** `START`, `INFO` (interim status), `DECISION` (design choice with reason), `QUESTION`
   (to orchestrator/user), `BLOCKER`, `DONE` (with branch, commit, test result).
   One line per entry, terse. At least START, one DECISION per non-trivial choice, DONE.
5. **Worktree setup:** `node_modules/`, `extension/vendor/` and `training/.venv/` are gitignored and missing
   in the worktree. Node: in the worktree root `cmd //c mklink //J node_modules C:\_programme\DS\aivsai\node_modules`
   (after that `npm test` creates the vendor folder itself via `pretest`). Python:
   `C:/_programme/DS/aivsai/training/.venv/Scripts/python.exe`. Large downloads/data go to
   `C:/_programme/DS/aivsai/training/data/` (gitignored, shared) instead of into the worktree.
6. **Tests:** whoever changes extension code runs `npm test`; all tests must be green.
7. **Finish:** commit on your own branch (English commit message in the style of the repo, with
   `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`), do not push, do not merge.
   Then `DONE` in the log and, as the answer, a report: branch, commits, what/why, tests,
   open points, suggestions for `TODO.md`/`README.md`.
8. Code and comments in the style of their surroundings (English, terse). Do not commit secrets/tokens.
9. **Measure as in the product:** always state false-alarm/detection rates with the extension's
   traffic-light logic as well (`reliableWords`, `shortRedFrom`, grouping), not only on raw scores – otherwise
   you get numbers that users never see like that (WP-01: 34% instead of 3% on news).

## Procedure for the orchestrator

1. Create the WP in `BOARD.md`, write the brief in `tasks/`, start the agent in the worktree, `START` in the log.
2. After the report comes back: review the diff, run the tests in the main checkout after the merge, merge
   (`--no-ff`), update board/TODO/README, result into the log.
3. Avoid conflicts between WPs by making sure the allowed files do not overlap.
