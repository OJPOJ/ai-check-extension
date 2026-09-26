# Board

Stand: 2026-09-26 (Runde 2). Status: `offen` · `läuft` · `Review` · `gemerged` · `blockiert (Nutzer)`.

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

## Runde 2 (abgeschlossen)

desklib = Standard (3bc5c6f), desklib rot ab 0.94 (3306b60). WP-06, WP-07, WP-08 gemerged.

## Kandidaten für Runde 3

- fakespot einbinden: ONNX-Abgleich, Kreuzvalidierung, Eintrag in `models.js` (TODO Punkt 2)
- Kurze Absätze unter `MIN_WORDS` gruppierbar machen, danach `npm run measure:pages` (TODO Punkt 2)
- BYOM-Referenzset aus MAGE-/HC3-Anteilen verbreitern, „Ausführliche Prüfung“ (TODO Punkt 1)
- Score-Kalibrierung pro Modell (TODO Punkt 5)
