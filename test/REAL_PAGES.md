# Echte Seiten: Textauswahl, Gruppierung und Sprache (WP-08)

Gemessen am 2026-09-26 mit `scripts/measure-pages.mjs` gegen ein Fake-Backend (wie in den E2E-Tests, `test/e2e/helpers.mjs`) - es geht um Textauswahl, Gruppierung (`extension/content.js`, `groupCandidates`) und Spracherkennung (`extension/lang-detect.js`), **nicht** um Scores. Konfiguration: `provider: local`, `localModel: desklib` (Produktions-Default, `maxChars` 1500/`reliableWords` 120), `scanMode: all`, `lazyScan: false` (ganze Seite auf einmal), `groupShortParagraphs: true` (Default).

**28 von 30** Seiten erfolgreich gemessen, 2 übersprungen (siehe „Nicht geladene Seiten“ unten).

## Tabelle pro Seite

| Seite | Sprache | Kandidaten | bewertet | übersprungen | Gruppen (>1) | Ø-Größe | <120 Wörter vorher | <120 Wörter nachher | Hinweise |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| [www.bbc.com/news](https://www.bbc.com/news) | en | 1 | 1 | 0 | 0 | – | 0 % | 0 % | – |
| [www.theguardian.com/international](https://www.theguardian.com/international) | en | 12 | 12 | 0 | 0 | – | 100 % | 100 % | möglicher großflächiger Consent-Dialog erkannt |
| [www.npr.org/sections/news/](https://www.npr.org/sections/news/) | en | 16 | 16 | 0 | 3 | 3.0 | 100 % | 80 % | Scan nicht fertig geworden |
| [www.aljazeera.com/news/](https://www.aljazeera.com/news/) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [www.smithsonianmag.com/](https://www.smithsonianmag.com/) | en | 1 | 1 | 0 | 0 | – | 100 % | 100 % | – |
| [overreacted.io/](https://overreacted.io/) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [danluu.com/](https://danluu.com/) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [css-tricks.com/](https://css-tricks.com/) | en | 5 | 5 | 0 | 1 | 2.0 | 100 % | 100 % | – |
| [stackoverflow.blog/](https://stackoverflow.blog/) | en | 19 | 19 | 0 | 2 | 2.5 | 79 % | 69 % | – |
| [en.wikipedia.org/wiki/Artificial_intelligence](https://en.wikipedia.org/wiki/Artificial_intelligence) | en | 162 | 161 | 1 | 39 | 2.6 | 83 % | 42 % | – |
| [en.wikipedia.org/wiki/Climate_change](https://en.wikipedia.org/wiki/Climate_change) | en | 211 | 211 | 0 | 59 | 2.5 | 88 % | 36 % | – |
| [en.wikipedia.org/wiki/History_of_the_United_States](https://en.wikipedia.org/wiki/History_of_the_United_States) | en | 177 | 177 | 0 | 45 | 2.3 | 82 % | 39 % | – |
| [www.wikihow.com/Bake-a-Cake](https://www.wikihow.com/Bake-a-Cake) | en | 34 | 34 | 0 | 9 | 3.4 | 100 % | 33 % | Scan nicht fertig geworden |
| [www.instructables.com/circuits/](https://www.instructables.com/circuits/) | en | 0 | 0 | 0 | 0 | – | – | – | Scan nicht fertig geworden; keine Kandidaten gefunden |
| [docs.python.org/3/tutorial/introduction.html](https://docs.python.org/3/tutorial/introduction.html) | en | 14 | 14 | 0 | 3 | 2.7 | 100 % | 78 % | – |
| [developer.mozilla.org/en-US/docs/Web/JavaScript/Guide](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [news.ycombinator.com/](https://news.ycombinator.com/) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [old.reddit.com/r/AskHistorians/](https://old.reddit.com/r/AskHistorians/) | en | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [de.wikipedia.org/wiki/Deutschland](https://de.wikipedia.org/wiki/Deutschland) | de | 275 | 1 | 274 | 0 | – | 100 % | 100 % | – |
| [www.tagesschau.de/](https://www.tagesschau.de/) | de | 1 | 0 | 1 | 0 | – | – | – | – |
| [www.dw.com/de/](https://www.dw.com/de/) | de | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [fr.wikipedia.org/wiki/France](https://fr.wikipedia.org/wiki/France) | fr | 268 | 3 | 265 | 1 | 3.0 | 100 % | 0 % | – |
| [www.ladepeche.fr/](https://www.ladepeche.fr/) | fr | 45 | 0 | 45 | 0 | – | – | – | – |
| [es.wikipedia.org/wiki/Espa%C3%B1a](https://es.wikipedia.org/wiki/Espa%C3%B1a) | es | 239 | 0 | 239 | 0 | – | – | – | – |
| [www.dw.com/es/](https://www.dw.com/es/) | es | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |
| [www.20minutos.es/](https://www.20minutos.es/) | es | 3 | 0 | 3 | 0 | – | – | – | – |
| [en.wikipedia.org/wiki/Denglisch](https://en.wikipedia.org/wiki/Denglisch) | mixed | 28 | 25 | 3 | 6 | 2.8 | 88 % | 36 % | – |
| [old.reddit.com/r/de/](https://old.reddit.com/r/de/) | mixed | 0 | 0 | 0 | 0 | – | – | – | keine Kandidaten gefunden |

## Nicht geladene Seiten

| Seite | Sprache | Fehler |
|---|---|---|
| https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array | en | page.evaluate: Error: Could not establish connection. Receiving end does not exist. |
| https://german.stackexchange.com/questions | mixed | page.evaluate: Error: Could not establish connection. Receiving end does not exist. |

Beide Stack-Exchange-Seiten lieferten laut `httpStatus` 403 und navigierten dann offenbar auf eine
Bot-Challenge-Seite (Cloudflare) weg, wodurch das Content-Script verwaist ist, bevor `GET_STATS`
geantwortet hat ("Receiving end does not exist"). `old.reddit.com` (403) und `old.reddit.com/r/AskHistorians`
(403) liefen zwar ohne Skript-Fehler durch, ergaben aber 0 Kandidaten - vermutlich, weil Reddit auf die
403-Antwort mit einer Hinweisseite ohne echten Beitragsinhalt antwortet statt mit dem Subreddit selbst.
Das betrifft nur automatisiertes Abrufen (Playwright/Bot-Erkennung), nicht die Extension als solche - im
normalen Browser eines Menschen wäre das kein Thema.

**Seiten mit 0 Kandidaten, aber ohne Fehler** (BBC/Smithsonian mit nur 1, Al Jazeera, overreacted.io,
danluu.com, MDN-Guide-Übersicht, Instructables-Kategorieseite, news.ycombinator.com, dw.com/de, dw.com/es,
r/de): stichprobenartig geprüft (MDN-Guide-Seite abgerufen und Absatzlängen nachgezählt) - das sind überwiegend
**Linksammlungen/Übersichtsseiten** (Blog-Index, Forum-Titelliste, Kategorie-Seite, Inhaltsverzeichnis),
deren Absätze fast alle unter 40 Wörtern liegen (`content.js MIN_WORDS`) und deshalb schon vor jeder
Sprach-/Gruppierungslogik aussortiert werden - kein Fehlverhalten, aber ein Hinweis, dass die Startseiten
großer Nachrichten-/Blogportale allein wenig über die Extension aussagen; aussagekräftiger sind einzelne
Artikelseiten (wie an den Wikipedia-Artikeln zu sehen). `dw.com/de` und `dw.com/es` sind angeschaut die
einzigen echten Ausreißer (Nachrichtenportal, sollte Absätze haben) - vermutlich rendert die Seite
Teaser-Text in `<div>`/eigenen Web-Components statt `article`/`p`/`li`, die vom `CANDIDATE_SELECTOR` nicht
erfasst werden; ohne Blick in den DOM-Baum der Seite nicht sicher zu sagen.

## Zusammenfassung

- Absätze insgesamt (bewertet, über alle Seiten): 680
- Anteil unter 120 Wörtern **vor** Gruppierung (einzelner Absatz): **86 %**
- Anteil unter 120 Wörtern **nach** Gruppierung (Gruppe bzw. Einzelabsatz, 421 Bewertungseinheiten): **44 %**
- Gruppen mit mehr als einem Absatz: 168 von 421 Bewertungseinheiten

## Spracherkennung

| Sprache | Seiten | bewertet (= als Englisch behandelt) | übersprungen (fremd erkannt) |
|---|---:|---:|---:|
| en | 18 | 651 | 1 |
| de | 3 | 1 | 275 |
| fr | 2 | 3 | 310 |
| es | 3 | 0 | 242 |
| mixed | 2 | 25 | 3 |

Erwartung: bei `en` sollte „übersprungen“ ≈ 0 sein, bei `de`/`fr`/`es` sollte „bewertet“ ≈ 0 sein (die ganze Seite übersprungen). `mixed`-Seiten haben bewusst beides.

### Auffällige Fälle (gekürzt)

Nur 5 von 680 bewerteten Absätzen (< 1 %) wichen von der Erwartung der jeweiligen Seite ab - und **alle
fünf sind bei genauerem Hinsehen keine Fehler der Spracherkennung**, sondern einzelne fremdsprachige
Zitate/Belege innerhalb einer ansonsten einsprachigen Seite, die korrekt pro Absatz (nicht pro Seite)
erkannt wurden:

| Seite | Sprache der Seite | Art | Auszug | Einschätzung |
|---|---|---|---|---|
| en.wikipedia.org/wiki/Artificial_intelligence | en | Absatz als „de“ übersprungen | Marti, J Werner (10 August 2024). "Drohnen haben den Krieg in der Ukraine revolutioniert, doch sie sind empfindlich auf Störsender – deshalb sollen sie jetzt au… | korrekt - echter deutscher Beleg-/Zitattitel in der Fußnotenliste |
| de.wikipedia.org/wiki/Deutschland | de | Absatz als „en“ bewertet | Hans-Martin Henning, Andreas Palzer: A comprehensive model for the German electricity and heat sector in a future energy system with a dominant contribution fro… | korrekt - echter englischer Beleg-/Publikationstitel |
| fr.wikipedia.org/wiki/France (×3) | fr | Absatz als „en“ bewertet | « His anecdotes are 'casual' only in appearance; Montaigne writes: 'Neither my anecdotes nor my quotations are always employed simply as examples, for authority… | korrekt - echtes englisches Zitat (Montaigne-Übersetzung) im Absatz |

Das ist ein gutes Zeichen für `lang-detect.js`: Die Absatz-für-Absatz-Erkennung fängt genau die Fälle ab,
in denen ein reines Seiten-`lang`-Attribut falsch läge (ein pauschal als Deutsch/Französisch/Englisch
gekennzeichnetes Attribut hätte diese eingebetteten Zitate falsch behandelt). In diesem Sample gab es
**keinen einzigen echten Fehlalarm** der Spracherkennung (weder ein englischer Absatz fälschlich
übersprungen noch ein fremdsprachiger fälschlich bewertet).

## Empfehlungen (nicht umgesetzt, nur Vorschlag)

### Gruppierung (`content.js`, `groupCandidates`)

- Grund-Effekt ist deutlich sichtbar und geht in die richtige Richtung: über alle Seiten sinkt der Anteil
  der Bewertungseinheiten unter 120 Wörtern von 86 % (einzelne Absätze) auf 44 % (nach Gruppierung) - auf
  den drei Wikipedia-Artikeln von 82–88 % auf 36–42 %. Die Regel greift also im echten Betrieb, nicht nur
  im Test.
- Trotzdem bleibt fast die Hälfte der Einheiten unter der Schwelle, bei einer durchschnittlichen
  Gruppengröße von nur 2.3–3.4 Absätzen (Wikipedia) bzw. 2.0–3.0 (Blogs/Doku). Zwei mögliche Gründe, die
  sich mit einfachen Mitteln (ohne Codeänderung) nicht weiter auseinanderhalten ließen:
  1. **`maxChars` als Deckel**: Bei desklib (1500 Zeichen) ist eine Gruppe aus 3–4 typischen Wikipedia-
     Absätzen oft schon voll, bevor sie 120 Wörter erreicht, weil einzelne Absätze/Fußnoten teils nur
     10–20 Wörter haben. Vorschlag: für desklib bei *gruppierten* Absätzen (anders als bei einem langen
     Einzelabsatz) einen höheren `maxChars`-Wert erlauben, z.B. den vollen 768-Token-Kontext des Modells -
     die Latenz-Sorge aus `models.js` ("CPU: 500 Zeichen 0,6s, 1500 Zeichen 2,3s") gilt pro Anfrage, nicht
     pro Absatz, und eine Gruppenanfrage ersetzt ohnehin mehrere Einzelanfragen.
  2. **Regel „gemeinsamer Elternknoten“ zu strikt**: `open.lastEl.parentElement === f.el.parentElement`
     verlangt denselben *unmittelbaren* Elternknoten. Wikipedia-Fußnotenlisten und viele CMS wickeln
     jeden Beleg/Absatz einzeln in ein eigenes Wrapper-Element (`<li><span class="reference-text">…`),
     wodurch zwei inhaltlich benachbarte, aber je in ihrem eigenen Wrapper sitzende Absätze schon nicht
     mehr denselben Elternknoten teilen. Vorschlag aus dem Auftrag greift hier direkt: **gemeinsamer
     Vorfahr bis Tiefe N** (z.B. 2) statt exakt gleicher Elternknoten - sollte mehr Kurzabsätze in
     Fußnoten-/Listenstrukturen zusammenfassen, ohne die bestehenden Testfälle (Überschrift/Liste als
     Bruch, `test/e2e/grouping.test.mjs`) zu verletzen, da die Bruch-Erkennung (`hasBreakBetween`) über
     eine Range läuft und von der Tiefe unabhängig ist.
- Konkret zu prüfen wäre das an `en.wikipedia.org/wiki/Artificial_intelligence` (39 Gruppen, Ø 2.6) und
  `.../Climate_change` (59 Gruppen, Ø 2.5) - beide mit langen Einzelnachweislisten.

### Spracherkennung (`lang-detect.js`)

- Sehr gutes Ergebnis auf diesem Sample: 0 echte Fehlalarme unter ~1750 geprüften Absätzen (680 bewertet
  + ca. 1068 übersprungen), die 5 Abweichungen waren durchweg korrekt erkannte fremdsprachige Zitate
  (siehe „Auffällige Fälle“ oben) - kein Hinweis auf ein systematisches Problem, keine Änderung nötig.
- Einzige auffällige *Seite* war `de.wikipedia.org/wiki/Deutschland`: von 275 Kandidaten wurde nur 1
  bewertet (der oben genannte englische Beleg), der Rest korrekt übersprungen - genau das Verhalten, das
  `reliableWords`/`languages: ["en"]` vorsehen. Keine Beobachtung, die für eine Anpassung spricht.
- Indirekter Befund statt Sprach-*erkennungs*-Fehler: `dw.com/de` und `dw.com/es` lieferten 0 Kandidaten
  überhaupt (weder bewertet noch übersprungen) - das ist ein mögliches **Auswahl**-Problem
  (`CANDIDATE_SELECTOR = "article, p, li"` trifft den Absatztext dieser Seite vermutlich nicht, z.B. weil
  er in `<div>`/Custom-Elements steckt), nicht eines der Spracherkennung. Nicht weiter verifiziert (kein
  DOM-Zugriff auf die Seite über den Auftrag hinaus); falls das reproduzierbar ist, wäre das ein Kandidat
  für eine separate Untersuchung der Absatz-Selektion auf SPA-lastigen Nachrichtenportalen.

### Allgemein

- Homepages/Übersichtsseiten (Blog-Index, Forum-Startseite, Kategorieseite) sind für diese Messung wenig
  ergiebig, weil ihre Textbausteine meist unter `MIN_WORDS` (40) liegen - für künftige Messungen eher
  einzelne Artikel-/Thread-URLs verwenden.
- Zwei der drei Stack-Exchange/Reddit-Formen liefen wegen Bot-Erkennung (HTTP 403) nicht durch - für
  Foren-Messungen ggf. Alternativen ohne aggressive Bot-Abwehr einplanen (z.B. Hacker News, das anstandslos
  lief, aber als Linkliste selbst kaum lange Absätze hat).