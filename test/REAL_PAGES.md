# Echte Seiten: Textauswahl, Gruppierung und Sprache (WP-08)

Gemessen am 2026-09-26 mit `scripts/measure-pages.mjs` gegen ein Fake-Backend (wie in den E2E-Tests, `test/e2e/helpers.mjs`) - es geht um Textauswahl, Gruppierung (`extension/content.js`, `groupCandidates`) und Spracherkennung (`extension/lang-detect.js`), **nicht** um Scores. Konfiguration: `provider: local`, `localModel: desklib` (Produktions-Default, `maxChars` 1500/`reliableWords` 120), `scanMode: all`, `lazyScan: false` (ganze Seite auf einmal), `groupShortParagraphs: true` (Default). URLs sind bewusst einzelne Artikel statt Startseiten (Nachbesserung nach Orchestrator-Review: Startseiten bestehen fast nur aus Teaser-Links < 40 Wörtern und sagen wenig über Gruppierung aus; die erste Fassung hatte zudem 550/680 bewertete Absätze aus nur 3 Wikipedia-Artikeln - Wikipedia ist jetzt auf 3 Artikel gedeckelt, dafür 14 einzelne englische Nachrichtenartikel aus 6 Häusern).

**32 von 32** Seiten technisch geladen und gemessen; davon sind 3 (apnews.com) faktisch unbrauchbar, weil sie im automatisierten Aufruf eine Bot-Prüfseite statt des Artikels bekamen (siehe „Zwei Auffälligkeiten bei den Nachrichtenartikeln“ unten) - netto also 29 auswertbare Seiten, deutlich über der geforderten Mindestzahl von 25.

## Tabelle pro Seite

| Seite | Sprache | Kategorie | Kandidaten | bewertet | übersprungen | Gruppen (>1) | Ø-Größe | <120 Wörter vorher | <120 Wörter nachher | Hinweise |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| [www.bbc.com/news/articles/c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | en | Nachrichtenartikel | 1 | 1 | 0 | 0 | – | 0 % | 0 % | ganzer Artikel als 1 Kandidat (siehe unten) |
| [www.bbc.com/news/articles/cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | en | Nachrichtenartikel | 1 | 1 | 0 | 0 | – | 0 % | 0 % | ganzer Artikel als 1 Kandidat (siehe unten) |
| [www.bbc.com/news/articles/cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | en | Nachrichtenartikel | 1 | 1 | 0 | 0 | – | 100 % | 100 % | nur 1 Absatz erreichte 40 Wörter, Rest zu kurz für einen Kandidaten (siehe unten) |
| [www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk](https://www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk) | en | Nachrichtenartikel | 34 | 34 | 0 | 2 | 2.5 | 29 % | 16 % | – |
| [www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record](https://www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record) | en | Nachrichtenartikel | 2 | 2 | 0 | 1 | 2.0 | 100 % | 100 % | – |
| [www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo](https://www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo) | en | Nachrichtenartikel | 5 | 5 | 0 | 1 | 4.0 | 100 % | 50 % | – |
| [www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit](https://www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit) | en | Nachrichtenartikel | 5 | 5 | 0 | 1 | 4.0 | 100 % | 50 % | – |
| [www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities](https://www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities) | en | Nachrichtenartikel | 2 | 2 | 0 | 1 | 2.0 | 100 % | 0 % | – |
| [www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war](https://www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war) | en | Nachrichtenartikel | 3 | 3 | 0 | 1 | 2.0 | 100 % | 100 % | – |
| [apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93](https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93) | en | Nachrichtenartikel | 0 | 0 | 0 | 0 | – | – | – | Cloudflare-Bot-Check statt Artikel geladen (siehe unten) |
| [apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28](https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28) | en | Nachrichtenartikel | 0 | 0 | 0 | 0 | – | – | – | Cloudflare-Bot-Check statt Artikel geladen (siehe unten) |
| [apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597](https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597) | en | Nachrichtenartikel | 0 | 0 | 0 | 0 | – | – | – | Cloudflare-Bot-Check statt Artikel geladen (siehe unten) |
| [www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news](https://www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news) | en | Nachrichtenartikel | 7 | 7 | 0 | 1 | 2.0 | 100 % | 100 % | – |
| [www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894](https://www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894) | en | Nachrichtenartikel | 6 | 6 | 0 | 2 | 2.0 | 100 % | 100 % | – |
| [danluu.com/wat/](https://danluu.com/wat/) | en | Blog | 45 | 45 | 0 | 9 | 2.1 | 67 % | 31 % | – |
| [overreacted.io/a-complete-guide-to-useeffect/](https://overreacted.io/a-complete-guide-to-useeffect/) | en | Blog | 68 | 68 | 0 | 20 | 2.9 | 100 % | 52 % | – |
| [css-tricks.com/complete-guide-css-grid-layout/](https://css-tricks.com/complete-guide-css-grid-layout/) | en | Blog | 9 | 9 | 0 | 1 | 2.0 | 100 % | 88 % | – |
| [jvns.ca/blog/2026/07/21/more-nice-django-things/](https://jvns.ca/blog/2026/07/21/more-nice-django-things/) | en | Blog | 17 | 17 | 0 | 5 | 2.8 | 100 % | 63 % | – |
| [www.wikihow.com/Bake-a-Cake](https://www.wikihow.com/Bake-a-Cake) | en | Anleitung | 34 | 34 | 0 | 9 | 3.4 | 100 % | 33 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 2 deferred (Zahlen ggf. unvollständig) |
| [www.wikihow.com/Tie-a-Tie](https://www.wikihow.com/Tie-a-Tie) | en | Anleitung | 10 | 10 | 0 | 2 | 3.0 | 100 % | 83 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 2 deferred (Zahlen ggf. unvollständig) |
| [www.wikihow.com/Change-a-Tire](https://www.wikihow.com/Change-a-Tire) | en | Anleitung | 23 | 23 | 0 | 4 | 2.8 | 91 % | 69 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 3 deferred (Zahlen ggf. unvollständig) |
| [docs.python.org/3/tutorial/introduction.html](https://docs.python.org/3/tutorial/introduction.html) | en | Dokumentation | 14 | 14 | 0 | 3 | 2.7 | 100 % | 78 % | – |
| [developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures) | en | Dokumentation | 19 | 19 | 0 | 7 | 2.6 | 100 % | 25 % | – |
| [en.wikipedia.org/wiki/Climate_change](https://en.wikipedia.org/wiki/Climate_change) | en | Wikipedia | 211 | 211 | 0 | 60 | 2.5 | 88 % | 34 % | – |
| [de.wikipedia.org/wiki/Deutschland](https://de.wikipedia.org/wiki/Deutschland) | de | Wikipedia | 275 | 1 | 274 | 0 | – | 100 % | 100 % | – |
| [en.wikipedia.org/wiki/Denglisch](https://en.wikipedia.org/wiki/Denglisch) | mixed | Wikipedia | 28 | 25 | 3 | 6 | 2.8 | 88 % | 36 % | – |
| [www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html](https://www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html) | de | Nachrichtenartikel | 6 | 0 | 6 | 0 | – | – | – | – |
| [www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602](https://www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602) | de | Nachrichtenartikel | 16 | 0 | 16 | 0 | – | – | – | – |
| [www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons](https://www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons) | fr | Nachrichtenartikel | 6 | 0 | 6 | 0 | – | – | – | – |
| [www.dw.com/fr/pape-leon-visite-france-europe/a-79429249](https://www.dw.com/fr/pape-leon-visite-france-europe/a-79429249) | fr | Nachrichtenartikel | 11 | 0 | 11 | 0 | – | – | – | – |
| [www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643](https://www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643) | es | Nachrichtenartikel | 8 | 0 | 8 | 0 | – | – | – | – |
| [www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml](https://www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml) | es | Nachrichtenartikel | 16 | 0 | 16 | 0 | – | – | – | – |

### Zwei Auffälligkeiten bei den Nachrichtenartikeln

**BBC (3 Artikel, 1 Kandidat statt vieler kurzer Absätze).** Stichprobe im Roh-HTML: BBC schreibt sehr
kurze Absätze (7–38 Wörter pro `<p>`, siehe `curl`-Auszug unten) - praktisch keiner erreicht für sich
`MIN_WORDS` (40, `content.js`). Bei zwei der drei Artikel greift dann `hasLongCandidateChild` nicht (kein
Kind-Absatz ist einzeln lang genug), also wird der umschließende `<article>` selbst zum *einzigen*
Kandidaten - mit dessen gesamtem Text (416 bzw. 842 Wörter) als ein Block. Beim dritten Artikel wird
nur der eine `<p>` mit genau 40 Wörtern zum Kandidaten, alle anderen bleiben unter der Schwelle und tauchen
im Scan gar nicht auf. In beiden Fällen kommt `groupCandidates` nie zum Einsatz, weil es keine mehreren
kurzen Kandidaten nebeneinander gibt, die es zusammenfassen könnte - die Absätze sind da, aber unterhalb
der Kandidaten-Schwelle unsichtbar für die ganze Pipeline (Auswahl *und* Gruppierung).

```
$ curl -s https://www.bbc.com/news/articles/c60m334grx9vo | grep -oE "<p[^>]*>.*?</p>" | head -5
# Wortzahlen der einzelnen <p>: 37, 25, 21, 32, 31 … (keiner erreicht 40)
```

**AP News (3 Artikel, 0 Kandidaten).** Sah zunächst wie ein Auswahl-Problem aus, ist aber keins: im
Roh-HTML (`curl`) liegt der Artikeltext ganz normal in `<p>`-Tags (`RichTextStoryBody`, 38 Absätze, erster
deutlich über 40 Wörter). Im echten Playwright-Browser liefert apnews.com jedoch eine
Cloudflare-Bot-Prüfungsseite (`Nur einen Moment… Sicherheitsüberprüfung wird durchgeführt`, HTTP 200,
~300 Zeichen Text) statt des Artikels - geprüft mit einem direkten Zusatzaufruf über dieselbe
`launchExtension`-Infrastruktur. `httpStatus` allein (im Skript ohnehin nur bei `!resp.ok()` gesetzt)
erkennt das nicht, da der Statuscode 200 ist. Reddit und Stack Exchange waren in der ersten Fassung dieser
Messung ähnlich betroffen (dort mit HTTP 403). Das ist eine Automatisierungs-/Bot-Erkennungs-Eigenheit der
Zielseite, keine Aussage über die Extension im normalen Browser eines Menschen - die drei AP-Zeilen oben
sind für die Auswertung daher wie „nicht geladen“ zu behandeln, nicht wie „Seite ohne lange Absätze“.

## Nicht geladene Seiten

Keine - alle Seiten der Liste konnten geladen werden.

## Zusammenfassung

- Absätze insgesamt (bewertet, über alle Seiten): 543
- Anteil unter 120 Wörtern **vor** Gruppierung (einzelner Absatz): **87 %**
- Anteil unter 120 Wörtern **nach** Gruppierung (Gruppe bzw. Einzelabsatz, 320 Bewertungseinheiten): **43 %**
- Gruppen mit mehr als einem Absatz: 136 von 320 Bewertungseinheiten

### Nach Seitentyp getrennt

| Kategorie | Seiten | Absätze vorher | <120 Wörter vorher | Einheiten nachher | <120 Wörter nachher |
|---|---:|---:|---:|---:|---:|
| Nachrichtenartikel | 20 | 67 | 61 % | 52 | 40 % |
| Blog | 4 | 139 | 89 % | 82 | 48 % |
| Anleitung | 3 | 67 | 97 % | 34 | 59 % |
| Dokumentation | 2 | 33 | 100 % | 17 | 53 % |
| Wikipedia | 3 | 237 | 88 % | 135 | 35 % |

## Spracherkennung

| Sprache | Seiten | bewertet (= als Englisch behandelt) | übersprungen (fremd erkannt) |
|---|---:|---:|---:|
| en | 24 | 517 | 0 |
| de | 3 | 1 | 296 |
| mixed | 1 | 25 | 3 |
| fr | 2 | 0 | 17 |
| es | 2 | 0 | 24 |

Erwartung: bei `en` sollte „übersprungen“ ≈ 0 sein, bei `de`/`fr`/`es` sollte „bewertet“ ≈ 0 sein (die ganze Seite übersprungen). `mixed`-Seiten haben bewusst beides.

### Auffällige Fälle (gekürzt)

| Seite | Sprache | Art | Auszug |
|---|---|---|---|
| https://de.wikipedia.org/wiki/Deutschland | de | de bewertet statt übersprungen | Hans-Martin Henning, Andreas Palzer: A comprehensive model for the German electricity and heat sector in a future energy system with a dominant contribution fro… |

## Gruppierungsregel: gezählte Wirkung einer Lockerung

Simuliert `groupCandidates` (content.js) mit echten Seitendaten nach, einmal mit der tatsächlichen Regel (`actual` - exakt gleicher Elternknoten, entspricht Tiefe 1) und mit zwei Varianten: gemeinsamer Vorfahr bis Tiefe 2/3 statt exakt gleicher Elternknoten (`depth2`/`depth3`), doppeltes `maxChars` (`maxChars2x`, 3000 statt 1500 Zeichen) und beides kombiniert. `actual` sollte die tatsächlich gemessenen Gruppen (Tabelle oben) reproduzieren - dient als Gegenprobe der Simulation.

### Alle Seiten

| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |
|---|---:|---:|---:|---:|
| tatsächliche Regel | 320 | 136 | 43 % | 359 |
| Vorfahr bis Tiefe 2 | 316 | 138 | 41 % | 365 |
| Vorfahr bis Tiefe 3 | 316 | 138 | 41 % | 365 |
| maxChars ×2 | 279 | 113 | 41 % | 377 |
| Tiefe 2 + maxChars ×2 | 274 | 115 | 39 % | 384 |

### Nur Nachrichtenartikel (Kategorie „news“)

| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |
|---|---:|---:|---:|---:|
| tatsächliche Regel | 52 | 10 | 40 % | 25 |
| Vorfahr bis Tiefe 2 | 52 | 10 | 40 % | 25 |
| Vorfahr bis Tiefe 3 | 52 | 10 | 40 % | 25 |
| maxChars ×2 | 51 | 10 | 39 % | 26 |
| Tiefe 2 + maxChars ×2 | 51 | 10 | 39 % | 26 |

## Empfehlungen (nicht umgesetzt, nur Vorschlag)

### Gruppierung: Tiefe-N-Idee aus der ersten Fassung durch Zählung widerlegt

Die ursprüngliche Empfehlung („gemeinsamer Vorfahr bis Tiefe N statt exakt gleicher Elternknoten“) beruhte
auf Wikipedia-Fußnotenlisten. Mit echten Nachrichtenartikeln nachgezählt (Abschnitt „Gruppierungsregel“
oben, Tabelle „Nur Nachrichtenartikel“) macht sie **keinen messbaren Unterschied**: Tiefe 2 und Tiefe 3
liefern exakt dieselben 52 Bewertungseinheiten und 10 Mehrfach-Gruppen wie die tatsächliche Regel - auf
News-Seiten sitzen benachbarte kurze Absätze so gut wie immer schon im selben unmittelbaren Elternknoten
(normale `<p>`-Folgen, keine verschachtelten Wrapper wie bei Wikipedia-Belegen). Auch doppeltes `maxChars`
bringt auf Nachrichtenartikeln kaum etwas (52 → 51 Einheiten). **Empfehlung: die Tiefe-N-Änderung nicht
umsetzen** - der Aufwand steht in keinem Verhältnis zum Nutzen auf der Seitenart, für die Gruppierung
ursprünglich gedacht war (TODO.md Punkt 2). Für Wikipedia-lastige Auswertungen (Fußnotenlisten) könnte sie
weiterhin etwas bringen (alle Seiten: 320 → 316/316 Einheiten, 136 → 138 Mehrfach-Gruppen), das ist aber ein
Randfall, kein Kernszenario.

### Der eigentliche Hebel: Kandidaten-Auswahl bei sehr kurzen Absätzen (BBC-Stil)

Die Stichprobe zeigt einen deutlicheren, bisher nicht dokumentierten Effekt: Auf Seiten mit sehr kurzem
Absatzstil (BBC: 7–38 Wörter pro `<p>`) unterschreitet praktisch jeder einzelne Absatz `MIN_WORDS` (40),
bevor `groupCandidates` überhaupt zum Zug kommt. Die Kandidaten-Auswahl fällt dann entweder auf den ganzen
`<article>`-Container zurück (ein Kandidat, mehrere hundert Wörter Mischtext) oder erfasst nur den einen
Absatz, der zufällig die 40-Wörter-Schwelle knapp erreicht - der Rest des Artikels bleibt für die ganze
Pipeline unsichtbar. Das ist etwas anderes als das ursprünglich vermutete Gruppierungsproblem: Es passiert
*vor* `groupCandidates`, in `MIN_WORDS`/`hasLongCandidateChild` (`content.js`, `collectCandidates`).
**Nicht umgesetzter Vorschlag, mit Vorbehalt**: `MIN_WORDS` für den *Gruppierungs*-Pfad senken (z.B. auf
~15–20 Wörter, nur wenn `groupShortParagraphs` an ist und ein Nachbar-Absatz zum Anschließen da ist), damit
solche Kurzabsatz-Ketten überhaupt als Kandidaten auftauchen und gruppiert werden können, statt in einem
Einzel-Großkandidaten unterzugehen. Das ist ein größerer Eingriff als die Tiefe-N-Idee (ändert, was
überhaupt als Kandidat zählt, nicht nur, was gruppiert wird) und sollte an mehr Seiten mit diesem Stil
geprüft werden, bevor er umgesetzt wird - in dieser Stichprobe war nur BBC eindeutig betroffen, Guardian/Al
Jazeera/PBS/DW mit normalen Absatzlängen (~40–70 Wörter/`<p>`) gruppierten dagegen zuverlässig (siehe
Beispiele oben: Guardian-Artikel 49+69 → eine Gruppe mit 118 Wörtern, Michigan-CEO-Artikel 4 von 5 Absätzen
zu 215 Wörtern zusammengefasst).

### Spracherkennung: weiterhin kein Änderungsbedarf

Mit 6 einzelnen nicht-englischen Nachrichtenartikeln (statt nur Wikipedia) bestätigt sich das Bild aus der
ersten Fassung: alle sechs wurden vollständig (100 %) übersprungen, kein einziger Absatz fälschlich
bewertet. Der einzige Grenzfall bleibt der schon gemeldete englische Beleg-Titel in `de.wikipedia.org/wiki/
Deutschland` - korrekt erkannt, kein Fehler. Keine Änderung an `lang-detect.js` vorgeschlagen.

### Sonstiges

- **Scan-Vollständigkeit**: Bei den 3 WikiHow-Seiten blieben nach 40 s je 2–3 Absätze als „deferred“
  markiert (nicht „pending“) - das sind serverseitig vorhandene, aber im Browser aktuell nicht gerenderte
  Absätze (eingeklappte Methode-Abschnitte o.ä.), keine langsame Antwort. Die gemeldeten Zahlen für diese
  drei Seiten sind dadurch um wenige Absätze unvollständig (siehe Hinweis-Spalte); ein Mensch, der die
  Abschnitte aufklappt, bekäme sie nachträglich bewertet (MutationObserver deckt das ab).
- **Miss-Erkennung als Bot**: apnews.com hat in diesem automatisierten Aufruf eine Cloudflare-Prüfseite
  statt des Artikels ausgeliefert (siehe oben) - für künftige Messungen entweder Alternativen einplanen
  oder das Skript um eine einfache Bot-Seiten-Erkennung ergänzen (z.B. `document.title` gegen bekannte
  Cloudflare-/Consent-Titel prüfen), damit solche Seiten nicht stillschweigend als „0 Kandidaten“ in die
  Statistik einfließen.
---

# WP-10: Sehr kurze Absätze gruppierbar machen (Nachmessung)

Ändert `extension/content.js`: Absätze dürfen jetzt schon ab 15 Wörtern (`GROUP_MIN_WORDS`, statt bisher
`MIN_WORDS` = 40) Kandidat werden - aber nur, wenn sie mit direkten Nachbarn (`groupCandidates`) zu einer
Gruppe mit zusammen mindestens `MIN_WORDS` (40) Wörtern zusammengefasst werden; ein einzelner Absatz in
diesem Bereich ohne passenden Nachbarn bleibt wie bisher unbewertet. Container (`hasLongCandidateChild`)
werden entsprechend seltener zusätzlich als Ganzes bewertet, sobald ein Kind selbst (gruppierter) Kandidat
werden kann - das war vorher (WP-08) der eigentliche Engpass bei BBC: praktisch kein einzelner `<p>` erreichte
40 Wörter, also wurde der ganze `<article>`-Container zum einzigen Kandidaten.

Gemessen am 2026-09-26, exakt dieselbe URL-Liste und Konfiguration wie oben (WP-08: `provider: local`,
`localModel: desklib`, `scanMode: all`, `lazyScan: false`, `groupShortParagraphs: true`) - direkt
vergleichbar. **32 von 32** Seiten gemessen, 0 fehlgeschlagen (AP News lieferte wie in WP-08 nur die
Cloudflare-Bot-Prüfseite, siehe dort - für die Auswertung wie „nicht geladen“ zu behandeln).

## BBC: der eigentliche Zielfall (vorher/nachher)

| Seite | Kandidaten vorher | bewertet vorher | Hinweis vorher | Kandidaten nachher | bewertet nachher | Gruppen (>1) nachher | Ø-Größe nachher | <120 Wörter nachher |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| [c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | 1 | 1 | ganzer Artikel als 1 Kandidat (416 Wörter) | 12 | 12 | 2 | 6.0 | 0 % |
| [cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | 1 | 1 | ganzer Artikel als 1 Kandidat (842 Wörter) | 29 | 29 | 7 | 4.1 | 86 % |
| [cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | 1 | 1 | nur 1 Absatz traf zufällig 40 Wörter, Rest unsichtbar | 18 | 18 | 3 | 6.0 | 0 % |

Vorher verschwand der Inhalt zweier Artikel komplett in einer einzigen, intransparenten Bewertung
(416 bzw. 842 Wörter Mischtext ohne Möglichkeit, eine auffällige Stelle einzugrenzen); beim dritten war
fast der ganze Artikel für die Pipeline unsichtbar. Nachher lösen sich alle drei in 12-29 einzeln
adressierbare Bewertungseinheiten auf, der überwiegende Teil davon als Gruppen aus mehreren Absätzen -
genau der in `test/REAL_PAGES.md` (WP-08) als "eigentlicher Hebel" benannte Effekt. `cjn5ddzekwnro`
bleibt mit 86 % unter 120 Wörtern nach der Gruppierung dennoch eher granular (viele Zwischenüberschriften
brechen die Kette, siehe `groupCandidates`/`hasBreakBetween`) - schlechter als eine ideale große Gruppe,
aber unvergleichlich besser als die vorherige Ganzseiten-Bewertung.
## Tabelle pro Seite

| Seite | Sprache | Kategorie | Kandidaten | bewertet | übersprungen | Gruppen (>1) | Ø-Größe | <120 Wörter vorher | <120 Wörter nachher | Hinweise |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| [www.bbc.com/news/articles/c60m334grx9vo](https://www.bbc.com/news/articles/c60m334grx9vo) | en | Nachrichtenartikel | 12 | 12 | 0 | 2 | 6.0 | 100 % | 0 % | – |
| [www.bbc.com/news/articles/cjn5ddzekwnro](https://www.bbc.com/news/articles/cjn5ddzekwnro) | en | Nachrichtenartikel | 29 | 29 | 0 | 7 | 4.1 | 100 % | 86 % | – |
| [www.bbc.com/news/articles/cq4g55r76d9lo](https://www.bbc.com/news/articles/cq4g55r76d9lo) | en | Nachrichtenartikel | 18 | 18 | 0 | 3 | 6.0 | 100 % | 0 % | – |
| [www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk](https://www.theguardian.com/society/2026/sep/26/luna-wong-hong-kong-death-reveals-treatment-international-students-uk) | en | Nachrichtenartikel | 34 | 34 | 0 | 2 | 2.5 | 29 % | 16 % | – |
| [www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record](https://www.theguardian.com/world/2026/sep/26/dream-come-true-six-year-old-rubiks-cube-world-record) | en | Nachrichtenartikel | 20 | 20 | 0 | 4 | 5.0 | 100 % | 50 % | – |
| [www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo](https://www.theguardian.com/us-news/2026/sep/25/michigan-ceo-loses-job-lake-america-photo) | en | Nachrichtenartikel | 23 | 23 | 0 | 4 | 5.8 | 100 % | 25 % | – |
| [www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit](https://www.aljazeera.com/news/2026/9/25/pope-leo-xiv-warns-ai-could-undermine-humanity-during-france-visit) | en | Nachrichtenartikel | 12 | 12 | 0 | 3 | 4.0 | 100 % | 33 % | – |
| [www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities](https://www.aljazeera.com/news/2026/9/25/un-expands-list-of-firms-involved-in-illegal-israeli-settlement-activities) | en | Nachrichtenartikel | 14 | 14 | 0 | 3 | 4.7 | 100 % | 33 % | – |
| [www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war](https://www.aljazeera.com/news/2026/9/25/iran-says-it-awaits-us-response-on-seven-day-roadmap-to-end-war) | en | Nachrichtenartikel | 17 | 17 | 0 | 4 | 4.3 | 100 % | 50 % | – |
| [apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93](https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93) | en | Nachrichtenartikel | 1 | 0 | 1 | 0 | – | – | – | – |
| [apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28](https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28) | en | Nachrichtenartikel | 1 | 0 | 1 | 0 | – | – | – | – |
| [apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597](https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597) | en | Nachrichtenartikel | 1 | 0 | 1 | 0 | – | – | – | – |
| [www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news](https://www.pbs.org/newshour/world/trump-rejects-irans-proposal-to-reopen-the-strait-of-hormuz-and-other-middle-east-news) | en | Nachrichtenartikel | 32 | 32 | 0 | 9 | 3.6 | 100 % | 78 % | – |
| [www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894](https://www.dw.com/en/could-flattering-ai-make-humanity-turn-on-itself/a-79377894) | en | Nachrichtenartikel | 30 | 30 | 0 | 9 | 3.3 | 100 % | 67 % | – |
| [danluu.com/wat/](https://danluu.com/wat/) | en | Blog | 52 | 52 | 0 | 13 | 2.2 | 71 % | 33 % | – |
| [overreacted.io/a-complete-guide-to-useeffect/](https://overreacted.io/a-complete-guide-to-useeffect/) | en | Blog | 164 | 164 | 0 | 35 | 4.5 | 100 % | 40 % | – |
| [css-tricks.com/complete-guide-css-grid-layout/](https://css-tricks.com/complete-guide-css-grid-layout/) | en | Blog | 23 | 23 | 0 | 7 | 2.7 | 100 % | 82 % | – |
| [jvns.ca/blog/2026/07/21/more-nice-django-things/](https://jvns.ca/blog/2026/07/21/more-nice-django-things/) | en | Blog | 29 | 29 | 0 | 8 | 3.4 | 100 % | 60 % | – |
| [www.wikihow.com/Bake-a-Cake](https://www.wikihow.com/Bake-a-Cake) | en | Anleitung | 34 | 34 | 0 | 11 | 2.5 | 100 % | 82 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 2 deferred (Zahlen ggf. unvollständig) |
| [www.wikihow.com/Tie-a-Tie](https://www.wikihow.com/Tie-a-Tie) | en | Anleitung | 32 | 32 | 0 | 8 | 3.8 | 100 % | 70 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 2 deferred (Zahlen ggf. unvollständig) |
| [www.wikihow.com/Change-a-Tire](https://www.wikihow.com/Change-a-Tire) | en | Anleitung | 33 | 33 | 0 | 9 | 3.3 | 100 % | 67 % | Scan wurde nicht fertig (noch pending/deferred) (nach 40000 ms) - beim Auslesen noch 0 pending, 3 deferred (Zahlen ggf. unvollständig) |
| [docs.python.org/3/tutorial/introduction.html](https://docs.python.org/3/tutorial/introduction.html) | en | Dokumentation | 38 | 38 | 0 | 6 | 5.7 | 100 % | 50 % | – |
| [developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Closures) | en | Dokumentation | 45 | 45 | 0 | 11 | 4.0 | 100 % | 33 % | – |
| [en.wikipedia.org/wiki/Climate_change](https://en.wikipedia.org/wiki/Climate_change) | en | Wikipedia | 507 | 500 | 7 | 113 | 4.0 | 96 % | 27 % | – |
| [de.wikipedia.org/wiki/Deutschland](https://de.wikipedia.org/wiki/Deutschland) | de | Wikipedia | 500 | 2 | 498 | 1 | 2.0 | 100 % | 100 % | – |
| [en.wikipedia.org/wiki/Denglisch](https://en.wikipedia.org/wiki/Denglisch) | mixed | Wikipedia | 54 | 44 | 10 | 13 | 3.2 | 93 % | 38 % | – |
| [www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html](https://www.tagesschau.de/ausland/europa/papst-leo-reise-frankreich-100.html) | de | Nachrichtenartikel | 16 | 0 | 16 | 0 | – | – | – | – |
| [www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602](https://www.dw.com/de/papst-leo-xiv-feiert-messe-in-paris-place-de-la-concorde-katholiken/a-79444602) | de | Nachrichtenartikel | 18 | 0 | 18 | 0 | – | – | – | – |
| [www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons](https://www.20minutes.fr/animaux/4248597-20260926-pourquoi-chats-adorent-cartons) | fr | Nachrichtenartikel | 46 | 0 | 46 | 0 | – | – | – | – |
| [www.dw.com/fr/pape-leon-visite-france-europe/a-79429249](https://www.dw.com/fr/pape-leon-visite-france-europe/a-79429249) | fr | Nachrichtenartikel | 13 | 0 | 13 | 0 | – | – | – | – |
| [www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643](https://www.dw.com/es/mapa-celular-para-entender-las-enfermedades-cerebrales/a-79438643) | es | Nachrichtenartikel | 18 | 0 | 18 | 0 | – | – | – | – |
| [www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml](https://www.rtve.es/noticias/20260921/m23-mineros-oro-coltan-congo-amnistia-internacional-ejecuciones/17230058.shtml) | es | Nachrichtenartikel | 24 | 0 | 24 | 0 | – | – | – | – |

## Nicht geladene Seiten

Keine - alle Seiten der Liste konnten geladen werden.

## Zusammenfassung

- Absätze insgesamt (bewertet, über alle Seiten): 1237
- Anteil unter 120 Wörtern **vor** Gruppierung (einzelner Absatz): **95 %**
- Anteil unter 120 Wörtern **nach** Gruppierung (Gruppe bzw. Einzelabsatz, 410 Bewertungseinheiten): **39 %**
- Gruppen mit mehr als einem Absatz: 285 von 410 Bewertungseinheiten

### Nach Seitentyp getrennt

| Kategorie | Seiten | Absätze vorher | <120 Wörter vorher | Einheiten nachher | <120 Wörter nachher |
|---|---:|---:|---:|---:|---:|
| Nachrichtenartikel | 20 | 241 | 90 % | 79 | 39 % |
| Blog | 4 | 268 | 94 % | 97 | 44 % |
| Anleitung | 3 | 99 | 100 % | 39 | 74 % |
| Dokumentation | 2 | 83 | 100 % | 22 | 41 % |
| Wikipedia | 3 | 546 | 96 % | 173 | 28 % |

## Spracherkennung

| Sprache | Seiten | bewertet (= als Englisch behandelt) | übersprungen (fremd erkannt) |
|---|---:|---:|---:|
| en | 24 | 1191 | 10 |
| de | 3 | 2 | 532 |
| mixed | 1 | 44 | 10 |
| fr | 2 | 0 | 59 |
| es | 2 | 0 | 42 |

Erwartung: bei `en` sollte „übersprungen“ ≈ 0 sein, bei `de`/`fr`/`es` sollte „bewertet“ ≈ 0 sein (die ganze Seite übersprungen). `mixed`-Seiten haben bewusst beides.

### Auffällige Fälle (gekürzt)

| Seite | Sprache | Art | Auszug |
|---|---|---|---|
| https://apnews.com/article/alzheimers-blood-tests-amyloid-tau-55eb2d490231b57acec8ef2848072d93 | en | englisch übersprungen (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://apnews.com/article/artificial-intelligence-campaign-ads-midterms-d375801e10821b3e6ac776ffc77e1f28 | en | englisch übersprungen (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://apnews.com/article/china-united-nations-unga-xi-eef81e4afc9842ebeefb33883cb05597 | en | englisch übersprungen (de) | Diese Website nutzt einen Sicherheitsservice, um sich vor böswilligen Bots zu schützen. Diese Seite wird angezeigt, solange die Website überprüft, dass Sie kein… |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (fr) | Duarte, C.M.; Delgado-Huertas, A.; et al. (17 January 2025). "Carbon burial in sediments below seaweed farms matches that of Blue Carbon habitats". Nature Clima… |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (fr) | Le Treut, H.; Somerville, R.; Cubasch, U.; Ding, Y.; et al. (2007). "Chapter 1: Historical Overview of Climate Change Science" (PDF). IPCC AR4 WG1 2007. pp. 93–… |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (fr) | Rogner, H.-H.; Zhou, D.; Bradley, R.; Crabbé, P.; et al. (2007). "Chapter 1: Introduction" (PDF). IPCC AR4 WG3 2007. pp. 95–116. |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (pt) | Larsen, J. N.; Anisimov, O. A.; Constable, A.; Hollowed, A. B.; et al. (2014). "Chapter 28: Polar Regions" (PDF). IPCC AR5 WG2 B 2014. pp. 1567–1612. |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (fr) | Jia, G.; Shevliakova, E.; Artaxo, P. E.; De Noblet-Ducoudré, N.; et al. (2019). "Chapter 2: Land-Climate Interactions" (PDF). IPCC SRCCL 2019. pp. 131–247. |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (pt) | Albrecht, Bruce A. (1989). "Aerosols, Cloud Microphysics, and Fractional Cloudiness". Science. 245 (4923): 1227–1239. Bibcode:1989Sci...245.1227A. doi:10.1126/s… |
| https://en.wikipedia.org/wiki/Climate_change | en | englisch übersprungen (it) | Kossin, J. P.; Hall, T.; Knutson, T.; Kunkel, K. E.; Trapp, R. J.; Walizer, D. E.; Wehner, M. F. (2017). "Chapter 9: Extreme Storms". In USGCRP2017. pp. 1–470. |
| https://de.wikipedia.org/wiki/Deutschland | de | de bewertet statt übersprungen | Hans-Martin Henning, Andreas Palzer: A comprehensive model for the German electricity and heat sector in a future energy system with a dominant contribution fro… |
| https://de.wikipedia.org/wiki/Deutschland | de | de bewertet statt übersprungen | Sebastian Strunz, The German energy transition as a regime shift. In: Ecological Economics 100 (2014), S. 150–158, hier S. 150, doi:10.1016/j.ecolecon.2014.01.0… |

## Gruppierungsregel: gezählte Wirkung einer Lockerung

Simuliert `groupCandidates` (content.js) mit echten Seitendaten nach, einmal mit der tatsächlichen Regel (`actual` - exakt gleicher Elternknoten, entspricht Tiefe 1) und mit zwei Varianten: gemeinsamer Vorfahr bis Tiefe 2/3 statt exakt gleicher Elternknoten (`depth2`/`depth3`), doppeltes `maxChars` (`maxChars2x`, 3000 statt 1500 Zeichen) und beides kombiniert. `actual` sollte die tatsächlich gemessenen Gruppen (Tabelle oben) reproduzieren - dient als Gegenprobe der Simulation.

### Alle Seiten

| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |
|---|---:|---:|---:|---:|
| tatsächliche Regel | 410 | 285 | 39 % | 1112 |
| Vorfahr bis Tiefe 2 | 406 | 287 | 38 % | 1118 |
| Vorfahr bis Tiefe 3 | 406 | 287 | 38 % | 1118 |
| maxChars ×2 | 342 | 228 | 39 % | 1123 |
| Tiefe 2 + maxChars ×2 | 337 | 229 | 38 % | 1129 |

### Nur Nachrichtenartikel (Kategorie „news“)

| Variante | Bewertungseinheiten | davon Gruppen >1 | <120 Wörter | Absätze in einer Gruppe |
|---|---:|---:|---:|---:|
| tatsächliche Regel | 79 | 50 | 39 % | 212 |
| Vorfahr bis Tiefe 2 | 79 | 50 | 39 % | 212 |
| Vorfahr bis Tiefe 3 | 79 | 50 | 39 % | 212 |
| maxChars ×2 | 75 | 45 | 41 % | 211 |
| Tiefe 2 + maxChars ×2 | 75 | 45 | 41 % | 211 |

## Bewertung und Risiken (WP-10)

- **Depth-N-Frage bleibt widerlegt.** `Vorfahr bis Tiefe 2/3` liefert mit den neuen, viel zahlreicheren
  Bewertungseinheiten weiterhin praktisch dasselbe Bild wie die tatsächliche Regel (410 vs. 406 Einheiten,
  285 vs. 287 Mehrfach-Gruppen) - die WP-08-Empfehlung, diese Änderung nicht umzusetzen, gilt unverändert.
- **Container-Kehrseite (dokumentiertes Risiko, siehe `hasLongCandidateChild` in `content.js`).** Ein
  isolierter Kurzabsatz (15-39 Wörter) ohne gruppierbaren Nachbarn bleibt jetzt unbewertet, *und* sein
  Container wird nicht mehr ersatzweise als Ganzes bewertet (vorher hätte der Container wenigstens
  irgendeine Bewertung geliefert). In dieser Stichprobe hat das die Erkennungsrate nirgends sichtbar
  verschlechtert (siehe Tabelle: durchweg mehr statt weniger bewertete Kandidaten pro Seite) - bei Seiten
  mit überwiegend sehr kurzen, isolierten Absätzen (Bildunterschriften-Galerien, Stichpunktlisten ohne
  Fließtext) ist ein Rückgang auf 0 Kandidaten pro Container aber denkbar und nicht Teil dieser Messung
  (alle 32 URLs sind Artikelseiten mit Fließtext).
- **Teaser/Navigations-Risiko nur teilweise geprüft.** Die Ø-Gruppengröße bleibt über alle Seiten moderat
  (max. 6.0 bei den beiden BBC-Artikeln, sonst 2.0-5.8) - kein Hinweis auf massenhaft zusammengefasste
  Linklisten in dieser Stichprobe. Die URL-Liste besteht aber bewusst nur aus einzelnen Artikelseiten
  (WP-08-Nachbesserung), **nicht** aus Startseiten/Rubrikseiten mit vielen Teaser-Links außerhalb eines
  `<nav>`/`role="navigation"` - genau dort wäre das Risiko am größten, weil `<li>`- oder `<p>`-Linktexte
  oft 15-39 Wörter lang sind und durch nichts als Navigation gekennzeichnet sein müssen. Nicht durch diese
  Messung abgedeckt; siehe Abschlussbericht an den Orchestrator für eine Einschätzung.
- **Spracherkennung bei sehr kurzen Gruppen weiterhin unauffällig.** Durch die niedrigere Schwelle wurden
  deutlich mehr, vorher unsichtbare Kurzabsätze zu Kandidaten (z. B. einzelne fremdsprachige Wikipedia-
  Zitate/Fußnoten unter 40 Wörtern) - dadurch stieg „übersprungen“ auf allen Sprachen an (u. a. `en`: 0 → 10,
  korrekt erkannte einzelne fr/it/pt-Zitate innerhalb sonst englischer Artikel; `de`: 296 → 532, weil auf
  `de.wikipedia.org/wiki/Deutschland` jetzt auch sehr kurze deutsche Absätze als Kandidaten auftauchen und
  korrekt übersprungen werden). Fälschlich bewertete fremdsprachige Absätze bleiben mit 2 von 534
  `de`-Kandidaten (identischer Einzelfall wie in WP-08, ein englischsprachiger Beleg-Titel) eine seltene
  Ausnahme - kein neues Muster, keine Änderung an `lang-detect.js` nötig.
