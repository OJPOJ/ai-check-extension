# WP-10 · Sehr kurze Absätze gruppierbar machen (TODO Punkt 2)

## Ausgangslage
`test/REAL_PAGES.md` (WP-08): Die Gruppierung (`groupCandidates` in `extension/content.js`) hilft bei
Nachrichtenartikeln (zu kurze Bewertungseinheiten 61 % → 40 %). Engpass: `MIN_WORDS` = 40 filtert
Absätze **vor** der Gruppierung. Seiten mit sehr kurzen Absätzen (BBC: 7–38 Wörter) liefern dadurch keine
Einzelkandidaten, sondern höchstens den ganzen Artikel-Container (oder zufällig einen Absatz). Eine
gelockerte Vorfahr-Regel hilft nachweislich nicht.

## Ziel
Absätze ab einer niedrigeren Grenze (Vorschlag ~15 Wörter, begründet wählen) dürfen Kandidaten sein,
**wenn** sie mit Nachbarn gruppiert werden und die Gruppe mindestens `MIN_WORDS` erreicht. Einzeln
bleiben sie wie bisher unbewertet. Keine doppelten Markierungen: Container, deren Kinder jetzt
gruppiert werden, dürfen nicht zusätzlich als Ganzes bewertet werden (`hasLongCandidateChild` u.ä.).

## Hinweise
- `content.js` gründlich lesen: Phase 1 (`collectCandidates`), Container-Logik, `MIN_WORDS`-Stellen
  (u.a. eine, die Zeichen statt Wörter vergleicht – prüfen, ob das Absicht ist), `groupCandidates`,
  MutationObserver/Lazy-Scan, Popover/Tooltip (Gruppenhinweis), Statistik im Popup (Zähler).
- Spracherkennung auf sehr kurzem Text ist unsicherer: Sprache der Gruppe sinnvoll bestimmen
  (z.B. Gruppe erst nach gleicher Sprache bilden wie bisher, bei „unbekannt“ konservativ) – ENTSCHEIDUNG loggen.
- Bildunterschriften, Teaser, Navigations-/Linklisten dürfen nicht massenhaft zu Gruppen werden;
  bestehende Ausschlüsse (Rollen, Navigation, Dialoge, Code) müssen weiter greifen.
- Danach `npm run measure:pages` (siehe README, Fake-Backend, ~5–8 Min.) laufen lassen und den Vorher/
  Nachher-Vergleich je Seitentyp in `test/REAL_PAGES.md` ergänzen (neuer Abschnitt, bestehende Zahlen
  nicht überschreiben). Besonders: BBC-Artikel.

## Erlaubte Dateien
`extension/content.js`, `extension/content-popover.js`, `extension/content.css`, `test/e2e/**`,
`test/harness.html`, `test/REAL_PAGES.md`, `scripts/measure-pages.mjs`, `scripts/measure-pages.urls.txt`.
Nicht: `config.js`, `models.js`, `offscreen.js`, `test/unit/config.test.mjs`, `test/unit/providers.test.mjs`
(gehören WP-09), `test/unit/model-check.test.mjs`, `test/e2e/model-check.test.mjs` (WP-11).
Braucht es einen Config-Schalter, im Bericht vorschlagen statt `config.js` zu ändern.

## Abnahme
- E2E-Tests: sehr kurze Absätze gruppiert (Gruppe ≥ MIN_WORDS), einzelner sehr kurzer Absatz bleibt
  unbewertet, kein Doppel mit dem Container, Überschrift/Liste bricht weiterhin.
- `npm test` grün, Messung auf echten Seiten mit Vorher/Nachher.
