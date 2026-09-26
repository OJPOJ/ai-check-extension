# Board

Stand: 2026-09-26 (Runde 2). Status: `offen` · `läuft` · `Review` · `gemerged` · `blockiert (Nutzer)`.

| WP | Thema | TODO-Bezug | Branch | Status | Dateien (exklusiv) |
|---|---|---|---|---|---|
| WP-01 | Eval-Suite verbreitern | Punkt 3 | `worktree-agent-a41cd225a4c09d22f` | gemerged (77c0c65) | `training/**` |
| WP-02 | Kurze Absätze zusammen bewerten | Punkt 2 | `worktree-agent-a94937e0b8c91a3fc` | gemerged (40c4e83) | `extension/content.js`, `extension/config.js`, `extension/models.js`, `test/**` |
| WP-03 | Store-Vorbereitung | Punkt 4 | `worktree-agent-a64ca70f4997d0b39` | gemerged (0403d72) | `extension/manifest.json`, `extension/icons/**`, `extension/options.*`, `extension/about.*`, `store/**`, `scripts/**` |
| WP-04 | „Modell prüfen“ mit echtem HF-Token | Punkt 1 | – | blockiert (Nutzer) | braucht Token |
| WP-05 | Kontakt/Impressum in `privacy.html` | Punkt 4 | – | blockiert (Nutzer) | braucht Name/Adresse |
| WP-06 | Weiteres Modell zwischen TMR und desklib | Punkt 2 | – | läuft | `training/**` außer `EVAL_RESULTS.md`; eigene `training/MODEL_SEARCH.md` |
| WP-07 | Schwellen absichern (desklib voll, Kreuzvalidierung, TMR/Anleitungen) | Punkt 3/5 | – | läuft | `training/**` außer `MODEL_SEARCH.md` |
| WP-08 | Gruppierung/Sprache auf echten Seiten messen | Punkt 2 | `worktree-agent-aa5dcd919e80a3d89` | gemerged (08afe69) | `scripts/measure-pages.*`, `test/REAL_PAGES.md`, `package.json` |

## Runde 2 (läuft)

Nach Nutzerentscheidung desklib = Standard (3bc5c6f). Offen danach: Schwellen aus WP-07 übernehmen,
Modell aus WP-06 einbinden, Empfehlungen aus WP-08 umsetzen.
