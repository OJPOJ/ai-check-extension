# Board

Stand: 2026-09-26 (Runde 3). Status: `offen` · `läuft` · `Review` · `gemerged` · `blockiert (Nutzer)`.

| WP | Thema | TODO-Bezug | Branch | Status | Dateien (exklusiv) |
|---|---|---|---|---|---|
| WP-01 | Eval-Suite verbreitern | Punkt 3 | `worktree-agent-a41cd225a4c09d22f` | gemerged (77c0c65) | `training/**` |
| WP-02 | Kurze Absätze zusammen bewerten | Punkt 2 | `worktree-agent-a94937e0b8c91a3fc` | gemerged (40c4e83) | `extension/content.js`, `extension/config.js`, `extension/models.js`, `test/**` |
| WP-03 | Store-Vorbereitung | Punkt 4 | `worktree-agent-a64ca70f4997d0b39` | gemerged (0403d72) | `extension/manifest.json`, `extension/icons/**`, `extension/options.*`, `extension/about.*`, `store/**`, `scripts/**` |
| WP-04 | „Modell prüfen“ mit echtem HF-Token | Punkt 1 | – | blockiert (Nutzer) | braucht Token |
| WP-05 | Kontakt/Impressum in `privacy.html` | Punkt 4 | – | blockiert (Nutzer) | braucht Name/Adresse |
| WP-06 | Weiteres Modell zwischen TMR und desklib | Punkt 2 | `worktree-agent-afb11d9e3237c9af7` | gemerged (b7721a2) | `training/**` außer `EVAL_RESULTS.md`; eigene `training/MODEL_SEARCH.md` |
| WP-07 | Schwellen absichern (desklib voll, Kreuzvalidierung, TMR/Anleitungen) | Punkt 3/5 | `worktree-agent-a96c0e3a2ca3f7416` | gemerged (f3e9ecb) | `training/**` außer `MODEL_SEARCH.md` |
| WP-08 | Gruppierung/Sprache auf echten Seiten messen | Punkt 2 | `worktree-agent-aa5dcd919e80a3d89` | gemerged (08afe69) | `scripts/measure-pages.*`, `test/REAL_PAGES.md`, `package.json` |
| WP-09 | fakespot einbinden (ONNX-Abgleich, Kreuzvalidierung) | Punkt 2 | `worktree-agent-ad415fba0f70a8594` | gemerged (9c2969f) | `models.js`, `offscreen.js`, `THIRD_PARTY_NOTICES.md`, `training/**` (außer `build_reference_set.py`), `test/unit/{config,providers}.test.mjs` |
| WP-10 | Sehr kurze Absätze gruppierbar | Punkt 2 | `worktree-agent-af2c7b66db2f25df9` | gemerged (9c23ec6) | `content*.js/css`, `test/e2e/**` (außer model-check), `test/harness.html`, `test/REAL_PAGES.md`, `scripts/measure-pages.*` |
| WP-11 | BYOM-Referenzset verbreitern | Punkt 1 | `worktree-agent-ad16f2c4ba4795d55` | gemerged (abd36fd) | `bg/reference-set.js`, `bg/model-check.js`, `about.html`, `training/build_reference_set.py`, `test/*/model-check.test.mjs` |

## Runde 2 (abgeschlossen)

desklib = Standard (3bc5c6f), desklib rot ab 0.94 (3306b60). WP-06, WP-07, WP-08 gemerged.

## Runde 3 (abgeschlossen)

fakespot als drittes Modell, sehr kurze Absätze gruppierbar, Referenzset HC3 + RAID-Wiki.

## Kandidaten für Runde 4

- fakespot im echten Browser (WASM) gegen Python-Scores abgleichen (TODO Punkt 2)
- Gruppierung auf Start-/Rubrikseiten messen, Teaser-Listen abfangen (TODO Punkt 2)
- Referenzset um GPT-4/ChatGPT/Cohere aus RAID ergänzen (TODO Punkt 1)
- „Ausführliche Prüfung“ und Regler für `reliableWords`/`shortRedFrom` (TODO Punkt 1)
- Score-Kalibrierung pro Modell (TODO Punkt 5)
