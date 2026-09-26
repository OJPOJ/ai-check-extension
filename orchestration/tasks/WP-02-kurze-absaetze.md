# WP-02 · Kurze Absätze zusammen bewerten (TODO Punkt 2)

## Problem
Absätze unter `reliableWords` (120 Wörter) werden bei TMR nie rot, bei desklib erst ab 0.98 (sonst
„unsicher“). Auf Nachrichtenseiten ist das der Großteil der Absätze. Mehr Kontext senkt die Fehler stark
(`training/EVAL_RESULTS.md`, Abschnitte „Textlänge“ und „Konfidenz für kurze Absätze“).

## Ziel
Benachbarte kurze Absätze desselben Artikels/Containers als **einen** Text bewerten und das Ergebnis
allen zuordnen. Erreicht die Gruppe zusammen `reliableWords`, gilt die normale Ampel.

## Hinweise
- Zuerst `extension/content.js` verstehen: Kandidatenauswahl, Batching (`BATCH_MAX_CHARS`), Priorisierung,
  Lazy-Scan, Ergebnis-Register, Popover, Feedback, Spracherkennung pro Absatz (`lang-detect.js`),
  Längen-Buckets. Außerdem `extension/bg/scoring.js` (Cache/Score-Store, Schlüssel).
- Gruppierungsregeln sinnvoll wählen und als `ENTSCHEIDUNG` loggen, z.B.: gleicher Block-Container
  (gemeinsamer Elternknoten/Artikel), direkt benachbart, gleiche erkannte Sprache, keine Überschrift/
  Liste dazwischen, Gruppe bis zur `maxChars`-Grenze des Modells. Lange Absätze bleiben einzeln.
- Die Wortzahl für die Ampel ist die der Gruppe. Im Popover/Prüfergebnis knapp sichtbar machen, dass die
  Bewertung mehrere Absätze umfasst.
- Caching: Der Score gehört zum Gruppentext; Schlüssel/Store so, dass nichts doppelt oder falsch
  zugeordnet wird. Feedback bezieht sich dann auf den Gruppentext.
- Rechtsklick-Prüfung einer Markierung bleibt unverändert.
- Konfigurierbar machen, falls es passt (Config-Schalter, Default an), aber die Optionsseite **nicht**
  ändern (gehört WP-03) – ggf. als Vorschlag im Bericht.

## Erlaubte Dateien
`extension/content.js`, `extension/content-popover.js`, `extension/content.css`, `extension/config.js`,
`extension/models.js`, `extension/bg/scoring.js`, `extension/bg/score-store.js`, `extension/background.js`,
`test/**`. Nicht: `manifest.json`, `options.*`, `popup.*`, `training/**`.

## Abnahme
- Neue Unit-/E2E-Tests für die Gruppierung (Harness `test/harness.html` erweitern), inkl. Randfällen
  (Überschrift dazwischen, andere Sprache, langer Absatz, Gruppe über `maxChars`).
- `npm test` komplett grün (im Worktree, Setup siehe `orchestration/README.md`).
- Vorschlag für einen README-Absatz („Weniger Fehlalarme“) im Bericht.
