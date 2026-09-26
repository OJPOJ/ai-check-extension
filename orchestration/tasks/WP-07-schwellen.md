# WP-07 · Schwellen absichern: desklib voll, Kreuzvalidierung, TMR auf Anleitungen (TODO Punkt 3/5)

## Ausgangslage
`training/EVAL_RESULTS.md`, Abschnitt „Breitere Eval-Suite“ und die „Korrektur“ darin: desklib nur auf
480 von 1200 Texten gemessen; Fehlalarme wie angezeigt TMR 4,7 %, desklib 1,2 %; TMR markiert 20 % der
menschlichen WikiHow-Texte rot. desklib ist seit heute Standardmodell (`extension/config.js`).

## Umfang
1. **desklib auf der ganzen Suite** (`training/evaluate_suite.py --backend desklib --desklib-n 1200`
   o.ä., ~46 Min. CPU, im Hintergrund). Die vorhandenen 480 Scores wiederverwenden, wenn möglich (nur
   fehlende Texte bewerten). Rohscores unter `C:/_programme/DS/aivsai/training/data/`.
2. **Kreuzvalidierung der Schwellen** für TMR und desklib (neues Skript, z.B.
   `training/crossval_thresholds.py`): wiederholte stratifizierte Splits (z.B. 5×2 oder Bootstrap),
   Schwelle für ~1 % Fehlalarme **wie angezeigt** (Regel 9 in `orchestration/README.md`) auf dem einen
   Teil wählen, auf dem anderen prüfen. Für `redFrom` (≥ 120 Wörter) und `shortRedFrom` (< 120 Wörter).
   Ergebnis: Schwelle mit Spanne und die Fehlalarm-/Erkennungsrate auf den Test-Teilen, plus
   Konfidenzintervall der aktuellen Werte (TMR 0.98, desklib 0.87 / short 0.98).
3. **TMR auf Anleitungen verstehen:** Was an den WikiHow-Texten löst die hohen Scores aus (Listen,
   Imperativ, Aufbau)? Wichtig: Wie sähe die Extension diese Texte? Auf echten WikiHow-/Anleitungsseiten
   sind Schritte oft einzelne kurze Absätze/Listen – `content.js` bewertet Listen anders und gruppiert
   kurze Absätze (README, „Kurze Absätze zusammen“). Prüfe, ob der Eval-Ausschnitt (Anfang des Dokuments,
   am Stück) das realistisch abbildet, und empfiehl: nichts tun / Schwelle / Domänen-Heuristik.
4. **Dokumentieren:** neuer Abschnitt in `training/EVAL_RESULTS.md` (Datum, Methode, Tabellen, konkrete
   Empfehlung, ob `extension/models.js` geändert werden sollte und auf welche Werte). Die bestehenden
   desklib-Tabellen im Abschnitt „Breitere Eval-Suite“ nicht umschreiben, sondern im neuen Abschnitt
   mit n=1200 ersetzen/verweisen.

## Erlaubte Dateien
`training/**` außer `training/MODEL_SEARCH.md` (gehört WP-06). Keine Extension-Dateien – Schwellen
ändert der Orchestrator nach dem Review.
Parallel misst WP-06 Latenzen; deinen desklib-Lauf im Log mit START/ENDE-Zeit vermerken.

## Abnahme
- desklib-Scores für alle 1200 Texte vorhanden.
- Kreuzvalidierte Schwellen-Empfehlung pro Modell mit Unsicherheitsangabe.
- Klare Aussage zu TMR/Anleitungen.
