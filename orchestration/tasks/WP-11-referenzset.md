# WP-11 · BYOM-Referenzset verbreitern (TODO Punkt 1)

## Ausgangslage
„Modell prüfen“ (`extension/bg/model-check.js`) schickt ein Referenzset (`extension/bg/reference-set.js`,
erzeugt von `training/build_reference_set.py`) an ein eigenes Modell und leitet daraus AUROC,
Ampel-Schwellen und KI-Label ab. Bisher: 20 Mensch + 20 KI aus HC3 (ChatGPT 2023), 400–1200 Zeichen,
fünf HC3-Domänen. TODO Punkt 1: Schwellen stützen sich auf 20 Mensch-Texte, kurze Absätze fehlen ganz.

## Ziel
Ein breiteres, **weiterverteilbares** Referenzset: mehr Domänen, aktuellere Generatoren, auch kurze
Absätze – bei weiterhin vertretbarer Laufzeit/Kosten für Cloud-Backends (Größenordnung 100–150 Texte,
begründen).

## Umfang
1. **Lizenzen zuerst.** Das Set wird mit der Extension ausgeliefert. Quelle kann die Eval-Suite sein
   (`C:/_programme/DS/aivsai/training/data/eval_suite.jsonl`, aus `Jinyan1/COLING_2025_MGT_en`), aber:
   Die Zusammenstellung hat keine Lizenz, M4GT-Bench auch nicht. MAGE ist Apache-2.0, HC3 CC BY-SA 4.0 –
   die **menschlichen Ursprungstexte** haben aber eigene Lizenzen (z.B. Wikipedia CC BY-SA, Yelp-/IMDb-
   Datensätze mit eigenen Nutzungsbedingungen, XSum/CNN aus Nachrichtenartikeln, arXiv je Paper).
   Pro Teilquelle klären, ob Weiterverteilung erlaubt ist, und nur solche Teile nehmen. Ergebnis als
   Tabelle im Bericht und als Kommentar in `build_reference_set.py`. Im Zweifel weglassen.
2. **Set bauen** (`training/build_reference_set.py` erweitern): Mensch/KI balanciert, mehrere Domänen,
   KI von mehreren Generatoren (soweit lizenzrechtlich möglich), Längen gemischt inkl. kurzer Absätze
   (z.B. 40–119 Wörter und ≥ 120 Wörter getrennt, damit „Modell prüfen“ später `reliableWords`/
   `shortRedFrom` ableiten könnte). Felder im JS ggf. um `words`/`generator` ergänzen.
3. **Modellprüfung anpassen** (`extension/bg/model-check.js`): mit dem größeren Set sinnvoll umgehen
   (Batching wie bisher, Fortschritt/Laufzeit, Schwellen-Vorschlag). Wenn mit dem Set kurz/lang getrennt
   auswertbar ist: `reliableWords`/`shortRedFrom`-Vorschlag ergänzen – nur wenn das mit dem Set
   statistisch vertretbar ist, sonst im Bericht begründen, warum nicht.
   `training/build_reference_set.py --check tmr desklib` laufen lassen: AUROC/Schwellen der bekannten
   Modelle auf dem neuen Set als Plausibilitätscheck (sollten grob zur Eval-Suite passen).
4. **Lizenz-Hinweise:** `extension/about.html` anpassen, falls sich die Lizenz des Referenzsets ändert.
   Text für `extension/THIRD_PARTY_NOTICES.md` und den README-Abschnitt „Lizenz“ **nur im Bericht
   liefern** (die Dateien gehören WP-09 bzw. dem Orchestrator).

## Erlaubte Dateien
`extension/bg/reference-set.js`, `extension/bg/model-check.js`, `extension/about.html`,
`training/build_reference_set.py`, `test/unit/model-check.test.mjs`, `test/e2e/model-check.test.mjs`.
Nicht: `models.js`, `offscreen.js`, `content.js`, `config.js`, `options.*` (UI-Änderungen als Vorschlag
im Bericht), `THIRD_PARTY_NOTICES.md`.

## Abnahme
- Lizenztabelle pro Teilquelle, nur weiterverteilbare Texte im Set.
- Neues Set erzeugt, `--check` mit Zahlen für TMR und desklib.
- `npm test` grün.
