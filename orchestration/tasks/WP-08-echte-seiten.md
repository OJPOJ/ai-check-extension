# WP-08 · Gruppierung und Spracherkennung auf echten Seiten messen (TODO Punkt 2)

## Ziel
Belastbare Zahlen, wie sich die Extension auf echten Seiten verhält – ohne Modell (Fake-Backend wie in
den E2E-Tests), es geht um Textauswahl, Gruppierung und Sprache, nicht um Scores.

## Umfang
1. **Messskript** `scripts/measure-pages.mjs` (Playwright, lädt die Extension wie `test/e2e/helpers.mjs`,
   Fake-Backend, Provider so konfigurieren, dass kein Download nötig ist). Pro URL: Seite laden, „Seite
   jetzt scannen“ auslösen (bzw. Scan-Modus „alle Seiten“), warten, dann aus dem DOM auslesen
   (`data-aivsai-*`-Hooks, siehe `content.js`): Anzahl Kandidaten, bewertet, übersprungen (Sprache),
   Gruppen und deren Größe, Anteil Absätze < 120 Wörter vor/nach Gruppierung, Wortzahl-Verteilung.
   Lazy-Scan beachten (ganz scrollen oder `lazyScan` aus). Ergebnis als JSON + Markdown-Tabelle.
2. **URL-Liste** `scripts/measure-pages.urls.txt`: ~30 öffentliche Seiten, gemischt: englische
   Nachrichten (BBC, Reuters, AP, Guardian …), Blogs/Medium, Wikipedia, Anleitungen (WikiHow,
   Instructables), Foren (Reddit old, Stack Exchange), Doku-Seiten; dazu 5–8 nicht-englische
   (deutsch/französisch/spanisch) und 2–3 gemischtsprachige. Nur öffentliche Seiten ohne Login, keine
   gesperrten (Sperrliste). Höflich: eine Seite nach der anderen, kein Crawling.
3. **Auswertung** in `test/REAL_PAGES.md`: Tabelle pro Seite
   und Zusammenfassung. Fragen: Wie oft greift die Gruppierung (Regel „gleiches Elternelement“)? Wie
   viele Absätze bleiben „unsicher kurz“? Wird Sprache richtig erkannt (englische Seiten ≈ 0 übersprungen,
   deutsche ≈ alle)? Falsch erkannte Absätze mit Beispiel (gekürzt) auflisten.
4. **Empfehlungen** (nur im Bericht und in `REAL_PAGES.md`, nicht umsetzen): z.B. Gruppierungsregel
   lockern (gemeinsamer Vorfahr bis Tiefe N?), Spracherkennung anpassen.

## Erlaubte Dateien
`scripts/measure-pages.mjs`, `scripts/measure-pages.urls.txt`, `test/REAL_PAGES.md`, `package.json`
(nur ein npm-Script `measure:pages` ergänzen). **Keine** Änderungen an `extension/**` – wenn ein
Test-Hook fehlt, im Log als FRAGE melden und ohne auskommen.

## Abnahme
- Skript läuft reproduzierbar (`npm run measure:pages`), Seiten, die nicht laden, werden übersprungen
  und vermerkt.
- `test/REAL_PAGES.md` mit echten Zahlen für ≥ 25 Seiten und konkreten Empfehlungen.
- `npm test` bleibt grün (nichts an der Extension geändert).
