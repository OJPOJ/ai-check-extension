# Board

Stand: 2026-09-26. Status: `offen` · `läuft` · `Review` · `gemerged` · `blockiert (Nutzer)`.

| WP | Thema | TODO-Bezug | Branch | Status | Dateien (exklusiv) |
|---|---|---|---|---|---|
| WP-01 | Eval-Suite verbreitern | Punkt 3 | `worktree-agent-a41cd225a4c09d22f` | gemerged (77c0c65) | `training/**` |
| WP-02 | Kurze Absätze zusammen bewerten | Punkt 2 | `worktree-agent-a94937e0b8c91a3fc` | gemerged (40c4e83) | `extension/content.js`, `extension/config.js`, `extension/models.js`, `test/**` |
| WP-03 | Store-Vorbereitung | Punkt 4 | `worktree-agent-a64ca70f4997d0b39` | gemerged (0403d72) | `extension/manifest.json`, `extension/icons/**`, `extension/options.*`, `extension/about.*`, `store/**`, `scripts/**` |
| WP-04 | „Modell prüfen“ mit echtem HF-Token | Punkt 1 | – | blockiert (Nutzer) | braucht Token |
| WP-05 | Kontakt/Impressum in `privacy.html` | Punkt 4 | – | blockiert (Nutzer) | braucht Name/Adresse |

## Kandidaten für die nächste Runde

- Default-Modell TMR vs. desklib entscheiden (Punkt 2) – Entscheidung Nutzer, Daten liegen vor
- TMR auf Anleitungsseiten (20 % Fehlalarme WikiHow) untersuchen/abfangen (Punkt 3)
- desklib auf der ganzen Suite + Kreuzvalidierung, dann Kalibrierung (Punkt 3/5)
- BYOM-Referenzset aus MAGE-/HC3-Anteilen verbreitern, „Ausführliche Prüfung“ (Punkt 1)
- Gruppierung und Spracherkennung auf echten Seiten messen (Punkt 2)
