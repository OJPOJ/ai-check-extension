# Board

Stand: 2026-09-26. Status: `offen` · `läuft` · `Review` · `gemerged` · `blockiert (Nutzer)`.

| WP | Thema | TODO-Bezug | Branch | Status | Dateien (exklusiv) |
|---|---|---|---|---|---|
| WP-01 | Eval-Suite verbreitern | Punkt 3 | – | läuft | `training/**` |
| WP-02 | Kurze Absätze zusammen bewerten | Punkt 2 | – | läuft | `extension/content.js`, `extension/config.js`, `extension/models.js`, `test/**` |
| WP-03 | Store-Vorbereitung | Punkt 4 | – | läuft | `extension/manifest.json`, `extension/icons/**`, `extension/options.*`, `extension/about.*`, `store/**`, `scripts/**` |
| WP-04 | „Modell prüfen“ mit echtem HF-Token | Punkt 1 | – | blockiert (Nutzer) | braucht Token |
| WP-05 | Kontakt/Impressum in `privacy.html` | Punkt 4 | – | blockiert (Nutzer) | braucht Name/Adresse |

## Danach (abhängig von WP-01)

- Default-Modell TMR vs. desklib entscheiden (Punkt 2)
- Score-Kalibrierung pro Modell (Punkt 5)
- BYOM-Referenzset verbreitern, „Ausführliche Prüfung“ (Punkt 1)
