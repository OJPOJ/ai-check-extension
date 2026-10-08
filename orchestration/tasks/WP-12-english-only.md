# WP-12 · Switch repo language to English only (issue #3)

Goal: no German left in the repository, except where German is data. Split into three sub-packages with
disjoint files (12a, 12b, 12c); the orchestrator translates `orchestration/**` itself.

| Sub-package | Files (exclusive) |
|---|---|
| WP-12a | `extension/**` (except `extension/generated/blocklist.js`), `test/**` (except `test/REAL_PAGES.md` and `test/unit/{zip,icons,blocklist}.test.mjs`) |
| WP-12b | `README.md`, `DEVELOPMENT.md`, `TODO.md`, `RESOURCES.md`, `package.json`, `store/**` (not the PNGs), `server/**`, `scripts/**`, `test/REAL_PAGES.md`, `test/unit/{zip,icons,blocklist}.test.mjs`, `extension/generated/blocklist.js` (header comments only) |
| WP-12c | `training/**` |

## What to translate

Everything a human reads: UI texts (HTML, strings in JS), code comments, JSDoc, error and log messages,
test names and assertions, Markdown docs, script output (including Markdown that scripts generate),
notebook cells, `manifest.json`/`package.json` descriptions, `lang="de"` attributes (-> `en`), locales
passed to `Intl.*`/`toLocaleString` (-> `en`/`en-US`).

## What stays German (data, not repo language)

- Stopword lists and anything else `lang-detect.js` needs to recognise German.
- Test fixtures whose point is to be German (or another foreign language), e.g. texts that the language
  detection must skip. Their surrounding comments and test names are translated.
- URLs, domain names, dataset contents, model names, quoted third-party licence texts.
- Identifiers, storage keys, message types, CSS classes, `data-*` attributes: already English, do not rename.
  If you do find a German identifier, rename it only if it is purely internal to your files.

## Rules

1. **Translate, do not rewrite.** Same structure, same line order, same numbers, same meaning, same level of
   terseness. No refactoring, no new comments, no dropped comments, no "improvements". A reviewer must be
   able to diff German against English line by line.
2. Typography: `„…“` -> `"…"` (in JS strings that are delimited by `"`, use `“…”` or switch quoting so the
   code stays valid), decimal commas in prose -> decimal points (`0,96` -> `0.96`, `1,5 %` -> `1.5%`),
   thousands separators `10.000` -> `10,000`. Keep ISO dates. Do not touch numbers inside code or data.
3. Only touch the files of your sub-package. If a string in another package must change with yours, do not
   edit it; list it in your final report.
4. Tests must stay green (`npm test`), where your package touches code or tests. Tests that assert UI
   strings are updated to the new English strings; never weaken an assertion to make it pass.
5. Check yourself at the end: `grep -nE '[äöüÄÖÜß„“]'` over your files, plus a grep for common German words
   (`und|der|die|das|nicht|für|ist|wird|mit|oder|wenn|auf|eine`). Every remaining hit must be data as
   defined above. List the remaining hits (file + reason) in the final report.
6. Do not write to `orchestration/LOG.md` this time (the orchestrator is translating it in parallel) -
   report decisions in the final report instead.
7. Finish: commit on your own branch with an English commit message, `Co-Authored-By: Claude Sonnet 5.5
   <noreply@anthropic.com>`; do not push, do not merge.

## Glossary (use exactly these, so the packages fit together)

| German | English |
|---|---|
| Ampel | traffic light |
| grün / gelb / rot | green / yellow / red |
| Auffällig – ähnelt KI-Text | Flagged – resembles AI text |
| Unklar | Unclear |
| Unauffällig | Not flagged |
| Zu kurz für eine Aussage | Too short to tell |
| KI / KI-Text / Mensch | AI / AI text / human |
| Absatz | paragraph |
| Fehlalarm | false alarm |
| Schwelle | threshold |
| Bewertung (eines Texts) | score (verb: to score) |
| Sperrliste | blocklist |
| Einstellungen | Settings |
| „Modell prüfen“ | "Check model" |
| Im Browser / Lokal / Eigener Server | In the browser / Local / Custom server |
| Seite jetzt scannen | Scan page now |
| Gruppierung (kurzer Absätze) | grouping (of short paragraphs) |
| wie angezeigt | as displayed |
| Trennschärfe | separation |
| Anleitungen (Domäne) | how-tos |
| Rezensionen | reviews |
| Arbeitspaket (WP) | work package (WP) |
| Auftraggeber / Orchestrator / Worker | client / orchestrator / worker |
| TODO Punkt 2 | TODO item 2 |
| Datenschutz / Datenschutzerklärung | privacy / privacy policy |
| Einwilligung | consent |

Section headings that other files cite (cite them with the new name):

| File | German | English |
|---|---|---|
| `training/EVAL_RESULTS.md` | Textlänge: mehr Kontext statt Chunks | Text length: more context instead of chunks |
| | Auffüllen: Batches nach Länge aufteilen | Padding: split batches by length |
| | Fehlalarme auf Wikipedia | False alarms on Wikipedia |
| | Konfidenz für kurze Absätze – desklib | Confidence for short paragraphs – desklib |
| | Breitere Eval-Suite | Broader eval suite |
| | Schwellen absichern: desklib auf n=1200, Kreuzvalidierung, TMR auf Anleitungen | Securing the thresholds: desklib at n=1200, cross-validation, TMR on how-tos |
| | Kreuzvalidierte Schwellen | Cross-validated thresholds |
| `training/MODEL_SEARCH.md` | ONNX-Abgleich und Einbindung (WP-09) | ONNX comparison and integration (WP-09) |
| `server/README.md` | Vertrag | Contract |
| `DEVELOPMENT.md` | Tests / Funktionen / Datenschutz und Speicher / Modelle / Architektur | Tests / Features / Privacy and storage / Models / Architecture |

Renamed task briefs (cite the new names): `WP-02-short-paragraphs.md`, `WP-06-model-search.md`,
`WP-07-thresholds.md`, `WP-08-real-pages.md`, `WP-10-very-short-paragraphs.md`, `WP-11-reference-set.md`.
Log types: `ENTSCHEIDUNG` -> `DECISION`, `FRAGE` -> `QUESTION`, `FERTIG` -> `DONE`.

## Acceptance

- Self-check from rule 5 is clean (only data left).
- `npm test` green (12a, 12b).
- Final report: branch, commit, a table of every changed **UI string** German -> English (12a), strings in
  other packages that need to follow, remaining German hits with reason, open points.
