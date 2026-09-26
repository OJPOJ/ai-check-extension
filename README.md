# AI Content Flag — Browser-Extension

Bewertet längere Textabsätze auf Webseiten mit einem KI-Text-Klassifikator und markiert sie als
Ampel (grün / gelb / rot) mit KI-Score. Das Modell läuft standardmäßig **direkt im Browser**
(WebAssembly, kein Server, Texte verlassen den Rechner nicht). Alternativ: lokaler Server
(`server/shim_server.py`), eigener Server/Cloud oder Hugging Face Inference API.

Stand: **v0.5 (2026-09-25)**. Recherche-Hintergrund: `RESOURCES.md`, Messwerte: `training/EVAL_RESULTS.md`.

## Quick Start

```powershell
npm install        # transformers.js (für vendor) + Playwright (für Tests)
npm run vendor     # transformers.js + ONNX-Runtime-WASM nach extension/vendor/ (nicht im Git)
```

**Vor jeder Auslieferung** (Web Store, Zip für andere): `npm run build` – macht `vendor` und
`build:blocklist` (lädt die aktuelle Sperrliste, schreibt `extension/generated/blocklist.js`, braucht
Internet, ~30 s, darunter ein 8-MB-Download von der NCUA). Die erzeugte Liste liegt im Git:
Änderungen im Diff gegenlesen und mit committen, vor einem Release zusätzlich die Prüfung auf
versehentlich gesperrte Content-Seiten (`RESOURCES.md`, „Pflege“).
Das Skript bricht ab, wenn eine Quelle nicht erreichbar ist oder deutlich weniger Einträge liefert
als erwartet – dann wird keine halb leere Liste ausgeliefert.

**Paket bauen:** `npm run package` → `dist/ai-content-flag-<version>.zip` (Version aus
`manifest.json`), fertig zum Hochladen in den Web Store oder zum Weitergeben. Inhalt: die im Git
erfassten Dateien unter `extension/` plus `extension/vendor/` (führt vorher `npm run vendor` aus) –
lokale, nicht committete Dateien kommen nicht hinein. Die Sperrliste wird dabei *nicht* neu erzeugt
(Warnung, wenn sie älter als 30 Tage ist). Ablauf für ein Release: `npm run build`, Diff der
Sperrliste prüfen, committen, `npm run package`.
Icons: Quelle `extension/icons/icon.svg`, PNGs (16/32/48/128, im Git) per `npm run build:icons`.
Store-Screenshots: `npm run screenshots` → `store/screenshots/` (Harness mit Fake-Scores, nur UI-Demo).
Textauswahl, Gruppierung und Sprache auf echten Seiten: `npm run measure:pages` (URL-Liste in
`scripts/measure-pages.urls.txt`, Fake-Backend, ~5–8 Min.) → `test/REAL_PAGES.md`.
Store-Texte, Begründung der Berechtigungen und offene Punkte fürs Einreichen: `store/`.
Das Skript (`scripts/package.mjs`) bricht ab bei nicht committeten Änderungen unter `extension/`
(`node scripts/package.mjs --allow-dirty` baut trotzdem, Dateiname mit `-dirty`), fehlendem
`vendor/` oder wenn eine Datei fehlt, auf die Manifest, HTML-Seiten, Imports oder `models.js`
verweisen. Es warnt bei offenen Store-Punkten (Icon, Kontakt in `privacy.html`). Das Zip ist
reproduzierbar: Zeitstempel = Commit-Zeit, gleicher Commit ergibt dieselbe SHA-256.

In Chrome/Edge:

1. `chrome://extensions` → „Entwicklermodus“ an → „Entpackte Erweiterung laden“ → `extension/`.
2. Die Einstellungen öffnen sich → Modell wählen, „Herunterladen“ (einmalig, von Hugging Face,
   kein Token): desklib (Standard) 1,7 GB, wird im Browser auf ~475 MB umgewandelt; TMR 126 MB.
3. Extension-Icon → „Diese Seite automatisch scannen“ oder „Diese Seite jetzt scannen“.
4. Offline-Testseite: bei der Extension „Auf Datei-URLs zulassen“, dann `test/harness.html` öffnen.

Optional – Server-Backend (desklib oder TMR per PyTorch), Provider „Lokal“:

```powershell
cd server
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py   # Port 8787
```

## Tests

```powershell
npm run test:setup   # einmalig: Chromium für Playwright
npm test             # Unit- und E2E-Tests (~2 min), führt vorher `npm run vendor` aus
$env:HEADED=1; npm test   # mit sichtbarem Browserfenster
```

Unit-Tests (`test/unit/`, ohne Browser, Sekunden):

| Datei | Prüft |
|---|---|
| `config.test.mjs` | Ampel-Schwellen, Sperrliste (eigene Einträge, mitgelieferte Liste, Ausnahmen), `scanPolicy`, `modelKey` (inkl. Version aus der Modellprüfung), Presets, `remoteTarget` |
| `providers.test.mjs` | Backends mit gemocktem `fetch`: Server-Vertrag (inkl. `lang`, Wertebereich), `/v1/info`, Bearer-Key, HTTP-Fehlermeldungen, Hugging-Face-Antwortformen, Hub-Metadaten (`pipeline_tag`, `id2label`) und Label-Zuordnung, Offscreen-Aufruf |
| `model-check.test.mjs` | „Modell prüfen“: Referenzset, AUROC, Ampel-Vorschlag, Urteil (Form, Richtung, Trennschärfe), Ablauf gegen gemockten Server und Hugging Face (KI-Label per Referenzset) |
| `desklib-build.test.mjs` | desklib-Umwandlung an einer Mini-`safetensors`-Datei: Kopieren, 8-Bit-Quantisierung (Rundung zur geraden Zahl), Stückgrenzen im Download, Abbruch bei falscher Datei |
| `blocklist.test.mjs` | Erzeugte Sperrliste: Format, kompakt, Umfang, Stichproben (Banking gesperrt, Inhaltsseiten nicht) |
| `length-buckets.test.mjs` | Längen-Gruppierung vor dem Modellaufruf |
| `zip.test.mjs` | Zip-Schreiber für `npm run package`: verlustfrei, sortiert, reproduzierbar, von `tar`/`unzip` lesbar |

Die E2E-Tests (`test/e2e/*.test.mjs`, Node-Test-Runner + Playwright) laden die echte Extension in
Chromium und lassen sie gegen ein Fake-Backend laufen, das den Vertrag von `shim_server.py` spricht
und jeden gesendeten Text mitschreibt (zufälliger Port, ein laufender `shim_server.py` stört nicht).

| Datei | Prüft |
|---|---|
| `scan.test.mjs` | Auto-Scan, Popup-Zähler, Icon-Badge, nachgeladene Absätze, Cache, Schwellen, Auswahl-/Rechtsklick-Prüfung, An/Aus, Lazy-Scan, Freigabe pro Seite, Sperrliste (eigene Einträge, mitgelieferte Liste, Ausnahmen, Passwortfeld-Heuristik), Backend-Status, Einstellungen |
| `extraction.test.mjs` | Was ans Modell geht: 23 Grenzfälle (Navigation, Cookie-Banner, versteckte Absätze, Code, Icon-Fonts, Formulare …), mit und ohne Lazy-Scan |
| `text-length.test.mjs` | Bis 2000 Zeichen, gekürzt am Satzende, Batch-Budget 2500 Zeichen, Rechtsklick = gleicher Ausschnitt wie Auto-Scan |
| `feedback.test.mjs` | Feedback im Popover: Klick aufs Badge (auch in Links, ohne Neu-Bewertung), Einwilligung vor dem ersten Speichern, Rückgängig, Export ohne Adresse, Widerruf, Abschalten |
| `score-store.test.mjs` | Dauerhafter Speicher: SW-Neustart, Zuordnung über Seiten, Modellwechsel, Aufbewahrung, „Nicht speichern“ |
| `model-check.test.mjs` | „Modell prüfen“ in den Einstellungen: Pflicht vor dem Speichern, vertauschte Labels abgelehnt, Ampel vom Server übernommen, Version im Modellschlüssel, neue URL entwertet die Prüfung |

Nicht abgedeckt: Bewertung mit dem echten Browser-Modell (bräuchte den Modell-Download) und der
Hugging-Face-Provider mit echtem Token (nur gemockt, siehe `providers.test.mjs`).

## Funktionen

- **An/Aus und Scan-Modi:** Master-Schalter (Popup, `Alt+Shift+A`), Badge „AUS“ am Icon. Gescannt
  wird „nur auf Knopfdruck“ (`Alt+Shift+S`), „auf ausgewählten Seiten“ (Default, Schalter pro
  Domain im Popup) oder „auf allen Seiten“. Ohne Freigabe verschickt das Content-Script keinen
  Text und beobachtet die Seite nicht.
- **Sperrliste „nie scannen“:** gilt vor jedem Scan-Modus, auch „Seite jetzt scannen“ ist dort
  gesperrt. Erlaubt bleibt die bewusste Einzelprüfung per Auswahl/Rechtsklick – das Popover weist
  dann auf die Sperre hin und nennt bei externen Backends, wohin der Text ging. Drei Bausteine:
  - *Mitgelieferte Liste* (`builtinBlocklist`, ~14.100 Domains: Online-Banking weltweit mit
    Schwerpunkt DE/AT/CH/UK/US inkl. Sparkassen, Volksbanken und US-Credit-Unions, Webmail,
    Zahlungsdienste, Behördenportale mit Login) – erzeugt von `scripts/build-blocklist.mjs` aus
    UT1-Blacklists, FDIC, NCUA, Wikidata und einer handverlesenen Liste. Lizenz der Liste:
    CC BY-SA 4.0 (wegen UT1). Quellen, Lizenzen, Umfang und Pflege: `RESOURCES.md`.
  - *Eigene Einträge* (`blockedSites`) und *Ausnahmen* von der mitgelieferten Liste
    (`unblockedSites`) – in den Einstellungen oder per „Hier nie scannen“ / „Von der Sperrliste
    nehmen“ im Popup.
  - *Heuristik* (`sensitiveHeuristic`): sichtbares Passwort-, Kreditkarten- oder Einmalcode-Feld
    (`autocomplete="cc-*"`, `one-time-code`) → Seite gilt als gesperrt, bis sie neu geladen wird.
    Auch wenn das Feld erst später erscheint (SPA) – dann werden die Markierungen entfernt. Felder
    in Dialogen zählen nicht (Login-Popups auf News-Seiten).

  Doppelt abgesichert: `content.js` entscheidet, der Service Worker lehnt Auto-Batches von Seiten
  der Listen zusätzlich ab (die Heuristik kennt nur das Content-Script). Die Liste liegt als ein
  String `"\nd1\nd2\n…\n"` vor und wird pro Host mit allen Eltern-Domains durchsucht – kein Set mit
  14.000 Einträgen in jedem Tab (233 KB pro Content-Script).
- **Ampel:** zwei Schwellen (Gelb ab / Rot ab, Presets pro Modell), grün = geprüft und *nicht* als
  KI erkannt (abschaltbar), Badge „KI-Score 97“, auch ohne Farbwahrnehmung unterscheidbar
  (dünn / gestrichelt / kräftig). Popup mit Zählern pro Seite und Backend-Status; Icon-Badge mit
  Anzahl roter (sonst gelber) Absätze, „!“ bei Fehler.
- **Weniger Fehlalarme** (der größte Schaden ist Rot auf einem menschlichen Text; Messung:
  `training/EVAL_RESULTS.md`, „Fehlalarme auf Wikipedia“):
  - *Stufe „unsicher“ (grau):* Unter einer Mindestlänge pro Modell (`reliableWords` in `models.js`,
    derzeit überall 120 Wörter) wird ein hoher Score nicht gelb/rot, sondern
    „unsicher“ – Badge ohne Zahl, der Rohwert steht nur im Popover. Grün bleibt grün. Ausnahme
    `shortRedFrom`: desklib markiert kurze Absätze ab 0.98 doch rot – damit so selten fälschlich wie
    lange (bis v0.5 bei 0.87, jetzt 0.94), erkannt ~73 % der kurzen ChatGPT-Texte (`training/EVAL_RESULTS.md`,
    „Konfidenz für kurze Absätze“). TMR hat keine solche Schwelle (liegt fast nie über 0.99). Eigene Modelle können beides über
    `/v1/info` angeben (`server/README.md`), sonst gilt 120 Wörter und nie rot.
  - *Kurze Absätze zusammen:* Direkt benachbarte Absätze unter `reliableWords` mit demselben Elternelement,
    gleicher Sprache und ohne Überschrift/Liste/Tabelle dazwischen bewertet der Auto-Scan als einen Text
    (bis `maxChars`) und gibt allen dasselbe Ergebnis; für die Ampel zählt die Wortzahl der Gruppe
    (`groupCandidates` in `content.js`, abschaltbar in den Einstellungen). Popover und Tooltip nennen die
    Gruppe. Nachgeladene Absätze werden nur untereinander gruppiert, nicht mit schon bewerteten.
  - *Andere Sprachen:* Die mitgelieferten Modelle kennen nur Englisch (`languages`). Absätze in
    anderen Sprachen bewertet der Auto-Scan nicht (keine Markierung, Zahl im Popup); die Einzelprüfung
    fragt erst nach („Trotzdem prüfen“), das Ergebnis ist dann immer „unsicher“. Erkennung pro Absatz
    in `extension/lang-detect.js`: erst Funktionswörter (en/de/fr/es/it/nl/pt) und Schrift; ist das
    unklar, die eingebaute Erkennung des Browsers (`i18n.detectLanguage`: CLD3 in Chrome/Edge & Co.,
    CLD2 in Firefox, >100 Sprachen, kein Download); dann das `lang`-Attribut. Geprüft wird genau der
    Ausschnitt, den das Modell sähe, für jeden Absatz einzeln – auch nachgeladene. Eigene Modelle: Sprachen aus `GET /v1/info`, ohne Angabe wird alles bewertet.
  - *TMR-Schwellen 0.95 / 0.98* statt 0.6 / 0.9 (gespeicherte alte Standardwerte werden beim Update
    übernommen, eigene bleiben).
  - *desklib rot ab 0.94* statt 0.87: auf der Eval-Suite (1200 Texte) 1,2 % statt 1,8 % Fehlalarme bei
    91 % statt 92,5 % erkannt, kreuzvalidiert (`training/EVAL_RESULTS.md`, „Schwellen absichern“).
    Gespeicherte alte Standardwerte werden beim Update angepasst. TMR bleibt bei 0.98 (dort ~6 %
    Fehlalarme bei langen Texten; 0.985 würde die Erkennung von 85 % auf 65 % drücken).
  - *Wortwahl:* „Auffällig – ähnelt KI-Text“ / „Unklar“ / „Unauffällig“ statt „wahrscheinlich KI“,
    Score 0–100 statt Prozent, im Popover „Hinweis, kein Beweis … keine Wahrscheinlichkeit“ – die
    Scores sind nicht kalibriert.
  - *Begrüßung nach der Installation* (`welcome.html`): was die Farben bedeuten und was nicht, Grenzen,
    Download-Größen; vor dem 1,7-GB-Download von desklib fragen die Einstellungen nach.
- **Sichtbarer Bereich zuerst:** Batches bis 5 Absätze bzw. 2500 Zeichen, nacheinander (Browser/lokal 1, remote 2 parallel).
  Die Reihenfolge wird erst beim Absenden bestimmt – nach einem Scroll springt die Priorität mit.
- **Lazy-Scan (Default an):** nur Absätze bis 1,5 Bildschirmhöhen um den sichtbaren Bereich, der
  Rest per `IntersectionObserver`, wenn er in die Nähe kommt.
- **Einzelne Stellen prüfen:** Rechtsklick auf markierten Text bzw. auf einen Absatz (oder
  `Alt+Shift+C`), unabhängig vom Scan-Modus und auch für Text, den der Auto-Scan auslässt
  (ab 5 Wörtern, bis 2000 Zeichen). Markierung per CSS Custom Highlight API, Ergebnis im Popover.
- **Bewertungen merken (Default 30 Tage, einstellbar bis 1 Jahr oder „nicht speichern“):**
  bekannte Absätze werden sofort markiert, ohne neu zu rechnen – auch nach Browser-Neustart und
  auf anderen Seiten mit demselben Text.
- **Feedback (Stufe 1 – nur lokal):** Klick aufs Badge eines markierten Absatzes öffnet
  Details (ohne neu zu rechnen); dort und im Ergebnis der manuellen Prüfung: „Weißt du, woher der Text stammt?“ → Mensch/KI →
  *woher* man es weiß: selbst geschrieben bzw. Autor:in bekannt, vor 2023 veröffentlicht, als KI
  gekennzeichnet oder „nur mein Eindruck“. Vor dem ersten Speichern Einwilligung im Popover, danach
  „Rückgängig“. Eine gespeicherte Angabe zeigt das Popover beim nächsten Öffnen wieder an
  („Deine Angabe: … – Ändern / Entfernen“, auch nach Neuladen); Ändern ersetzt den Eintrag, Rückgängig
  stellt die vorige Angabe wieder her. Zuordnung über den SHA-256 des bewerteten Texts – ändert die
  Seite den Absatz, ist es ein neuer Eintrag. Markierter Text ist ein eigener Eintrag. Einstellungen → Feedback: Zähler, Export als JSONL, Löschen + Widerruf, Knöpfe
  abschaltbar. Auf gesperrten Seiten (Sperrliste, Passwort-/Zahlungsfeld) keine Feedback-Knöpfe. Weiterverarbeitung:
  `training/import_feedback.py`, Begründung und Grenzen: `training/README.md` („Feedback als Datenquelle“).
- **Backends** (`extension/bg/providers.js`): Im Browser (TMR oder desklib), Lokal
  (`shim_server.py`), Eigener Server (Vertrag in `server/README.md`: `POST {texts, model?, lang?} ->
  {scores}` mit P(KI) in 0..1, optional `GET /v1/info`, optional Bearer-Key), Hugging Face Inference
  API. Host-Berechtigungen für Remote-Backends werden erst beim Speichern bzw. Prüfen angefragt;
  Tokens nur in `storage.local`.
- **Eigene Modelle prüfen** (`extension/bg/model-check.js`): Ein eigenes Modell ist ein binärer
  Klassifikator, „Modell prüfen“ in den Einstellungen testet es vor dem Einsatz – Pflicht für
  „Eigener Server“ und Hugging Face, freiwillig für „Lokal“. Das Referenzset (je 20 menschliche und
  ChatGPT-Texte aus HC3, fünf Domänen, `extension/bg/reference-set.js`, erzeugt von
  `training/build_reference_set.py`) geht in Batches wie im Betrieb ans Modell. Geprüft: Form (Anzahl,
  0..1, vor dem Timeout), Richtung (KI im Mittel höher, sonst Label vertauscht), Trennschärfe (AUROC:
  unter 0.8 Warnung, unter 0.6 abgelehnt), dazu Ampel-Vorschlag (vom Server per `/v1/info`, sonst aus
  den Scores: rot knapp über dem höchsten Mensch-Text) und Latenz mit Empfehlung für den Scan-Modus.
  Hugging Face: vorher Modellinfo und `config.json` vom Hub – `pipeline_tag` muss
  `text-classification` sein, genau 2 Klassen; das KI-Label kommt aus `id2label`, bei
  `LABEL_0`/`LABEL_1` aus dem Referenzset. Die Version (`/v1/info` bzw. Commit auf dem Hub) geht in
  `modelKey` ein, Textlänge und Ampel-Startwerte gelten für das geprüfte Modell. Das Ergebnis gilt,
  bis sich Modell oder URL ändern (Token/API-Key zählen nicht). Messwerte auf dem Referenzset über den
  Shim: TMR AUROC 0.99, ~0,5 s/Text; desklib AUROC 0.99, ~2,4 s/Text.

### Was bewertet wird

Kandidaten sind `p`, `li` und `article` (Letzteres nur ohne eigene lange Absätze) mit mindestens
40 Wörtern; gesendet wird der *sichtbare* Text (`innerText`, kein HTML, kein Script/Style-Inhalt),
bei langen Absätzen gekürzt am letzten Satzende – wie weit, hängt vom Modell ab (`AIVSAI.maxChars`):
TMR 2000 Zeichen (= sein Kontext, 512 Tokens), desklib 1500 (könnte 768 Tokens, wird aber stark
überproportional langsamer und ist schon mit kurzem Text sehr genau), unbekannte Modelle 2000.
Gemessen bringt mehr Kontext viel (TMR: 500 → 1500 Zeichen senkt die Fehler von ~9 % auf < 1 %),
Chunks mit Überlappung dagegen nichts (`training/EVAL_RESULTS.md`, „Textlänge“). Vor dem
Modellaufruf werden Batches nach Tokenlänge aufgeteilt (`extension/length-buckets.js`, im Server
`length_buckets`), damit kurze Absätze nicht auf den längsten aufgefüllt werden (desklib: 16,6 → 4,4 s
pro Batch, gleiche Scores). Auto-Scan, Badge und Rechtsklick bewerten denselben
Ausschnitt – also gleicher Score-Speicher-Eintrag und gleicher Feedback-Eintrag.

- **Nie:** Navigation und Seitenrahmen (`nav`, `header`, `footer`, `role=navigation|banner|contentinfo|search`),
  Dialoge (`dialog`, `role=dialog` – meist Cookie-Banner), Code (`pre`), Eingaben (`textarea`,
  `input`, `contenteditable` …), `template`, nicht gerenderte Absätze (`display:none`, `hidden`,
  zugeklappt – sie kommen nach, sobald sie sichtbar werden).
- **Übersprungen, per Rechtsklick trotzdem prüfbar:** Absätze in Sprachen, die das Modell nicht kennt
  (`data-aivsai-skipped="de"` am Element, Zahl im Popup).
- **Aus dem Text herausgerechnet:** Icon-Fonts und andere `aria-hidden`-Teile, Code-Blöcke.
- **Bewusst trotzdem bewertet:** Absätze unter `aria-hidden`-Vorfahren (viele Seiten verstecken so
  den ganzen Inhalt, solange ein Modal offen ist), `form` (ASP.NET packt ganze Seiten in ein
  Formular), `aside`/`role=complementary`. Stichprobe 2026-09-25 (43 Seiten: News DE/EN, Tech-Blogs,
  Doku, Wikipedia, Rezepte): 0 von 752 bewerteten Absätzen lagen in einem `aside` – die vorhandenen
  `aside`-Elemente sind Werbe-/Nachlade-Slots ohne Text oder Teaser-Listen, die schon an der
  40-Wörter-Grenze scheitern. Ausschließen brächte nichts, würde aber Randnotizen und
  Info-Kästen im Artikel verlieren. Neu bewerten, falls das Feedback Fehlalarme dort zeigt.
- **Nicht erreicht:** Shadow DOM, iframes.

## Datenschutz und Speicher

Datenschutzerklärung: `extension/privacy.html` (verlinkt in den Einstellungen). Vor einer
Veröffentlichung im Web Store: Kontakt eintragen und die Seite zusätzlich öffentlich hosten
(der Store verlangt eine URL).

- Provider „Im Browser“ und „Lokal“: Texte verlassen den Rechner nicht. Einziger Netzwerkzugriff ist
  der einmalige Modell-Download von Hugging Face.
- Eigener Server / Hugging Face: bis zu 2000 Zeichen pro Absatz gehen an diesen
  Dienst – die Einstellungen weisen darauf hin. „Modell prüfen“ schickt nur das mitgelieferte,
  öffentliche Referenzset (bei Hugging Face zusätzlich eine Abfrage der Modellinfo auf huggingface.co).
- **Score-Speicher** (IndexedDB, `extension/bg/score-store.js`, nicht synchronisiert): pro Absatz nur
  ein 128-Bit-Hash (SHA-256 über Modell-Konfiguration + Text), Score, Modell und Zeitpunkt –
  **kein Text, keine URL**. Gemessen ~235 Byte pro Eintrag (50.000 = 11,7 MB, 30 Tage intensives
  Surfen ≈ 10 MB). Aufräumen täglich (`chrome.alarms`), beim Browserstart und sofort bei Änderung der
  Einstellung; Obergrenze 200.000 Einträge; „Alle löschen“ in den Einstellungen.
- **Feedback-Sammlung** (IndexedDB `aivsai-feedback`, `extension/bg/feedback-store.js`): enthält den
  **Text** (bis 2000 Zeichen) plus Label, Grundlage, Score, Modell, `lang` der Seite, Zeitpunkt –
  **keine URL, kein Hostname**. Nur nach Einwilligung (`feedbackConsentAt` in `storage.local`, vom
  Service Worker ein zweites Mal geprüft), nie gesendet. Export und Löschen nur von Extension-Seiten
  aus (der Service Worker lehnt beides aus Content-Scripts ab). Widerruf löscht alle Einträge.
  Pro Text ein Eintrag, Obergrenze 20.000. Keine automatische Löschfrist – die Sammlung ist bewusst
  angelegt und soll nicht nach 30 Tagen verschwinden.
- **Zuordnung:** Der Schlüssel enthält Provider-Einstellungen und Modellversion (`modelKey`, z.B.
  `browser:tmr@b9aa251-q8`). Modellwechsel → neu bewerten, alte Einträge bleiben fürs Zurückwechseln;
  neue Modell-Revision/Quantisierung → `version` in `config.js` ändern, alte Scores gelten nicht mehr.
  Bei „Lokal“/„Eigener Server“/Hugging Face kommt die Version aus „Modell prüfen“ (`/v1/info` bzw.
  Commit auf dem Hub); ein Update auf dem Server ohne erneute Prüfung bleibt unbemerkt.

## Modelle

| Modell | Größe | im Browser (Ryzen 7 5800U, 8 Threads) | Genauigkeit (HC3, 100 Beispiele) | Wikipedia „Photosynthesis“ |
|---|---|---|---|---|
| **TMR** (RoBERTa-base) – *Schnell* | 126 MB | ~0,15 s/Absatz, Laden ~2 s | AUROC 0.908 (PyTorch 0.911) | 50/80 rot (Fehlalarme) |
| **desklib** (DeBERTa-v3-large) – *Genau*, Standard | 1,7 GB → 475 MB | ~1 s/Absatz, Laden ~4 s, Download+Umwandlung ~57 s | AUROC 0.998 | 3/80 rot |

Standard ist seit v0.6 desklib: Auf der breiteren Eval-Suite (6 Domänen, 7 Generatoren) zeigt es ~1 %
Fehlalarme statt ~5 % bei TMR (TMR: 20 % auf Anleitungen), AUROC 0.990 statt 0.929
(`training/EVAL_RESULTS.md`, „Breitere Eval-Suite“). Installationen von vor v0.6, die nie ein Modell
gewählt haben, behalten beim Update TMR samt Ampel-Werten (`pinLegacyModel` in `background.js`).

- Beide nur auf **Englisch** trainiert (deutscher Fachtext im Harness: 78 % → Fehlalarm).
- TMR: fertiges int8-ONNX von `onnx-community`, Revision gepinnt.
- desklib: Es gibt kein brauchbares ONNX. Die Extension lädt das Original (`model.safetensors`) und
  quantisiert es beim Herunterladen selbst (`extension/desklib_build.js`, als Stream, zeilenweise).
  Mitgeliefert wird nur der Rechengraph ohne Gewichte plus Bauanleitung (`extension/models/desklib/`,
  1,9 MB, erzeugt von `scripts/build_desklib_skeleton.py`). MatMul 8 Bit nur-Gewichte
  (MatMulNBits, Block 32) statt des üblichen dynamischen int8, das DeBERTa kaputtmacht
  (AUROC 0.998 → 0.973).
- Laya (zero-shot) getestet: AUROC 0.549, deshalb nicht wählbar. Server-Messungen (PyTorch, CPU):
  `training/EVAL_RESULTS.md`.
- Lizenzen (MIT bzw. transformers.js Apache-2.0): `extension/THIRD_PARTY_NOTICES.md`. HC3 ist
  CC-BY-SA-4.0 → bei eigenem Fine-Tuning beachten.

## Architektur

```
extension/
  models.js             Modellkatalog: Name, Kontext, Ampel-Presets, Mindestlänge für gelb/rot, Sprachen,
                        Browser-Download (Revision/Version), Server-Angaben – eine Stelle pro Modell
  config.js             Defaults + gemeinsame Regeln für alle Teile: Provider-Registry (PROVIDERS),
                        scanPolicy/blockReason (darf gescannt werden?), modelKey (Modell + Version),
                        Presets, Ampel-Stufen (inkl. „unsicher“)
  lang-detect.js        Spracherkennung pro Absatz (Funktionswörter, Schrift)
  background.js         Service Worker (ES-Modul): verdrahtet Events und Nachrichten mit bg/
  bg/providers.js       Backends (Anfrage, Health-Check, Modellinfo je Provider)
  bg/model-check.js     „Modell prüfen“: eigenes Modell gegen das Referenzset testen
  bg/reference-set.js   Referenzset (HC3, CC BY-SA 4.0), erzeugt von training/build_reference_set.py
  bg/scoring.js         Konfig-Cache, Score-Cache (Arbeitsspeicher → IndexedDB → Modell), Test, Status
  bg/score-store.js     dauerhafter Score-Speicher mit Aufbewahrungsdauer
  bg/feedback-store.js  Feedback-Sammlung (mit Text, nur nach Einwilligung, nur lokal)
  bg/badge.js           Icon-Badge pro Tab
  bg/offscreen-client.js  Brücke zum Offscreen-Dokument
  offscreen.js          Modell per transformers.js/WASM (Service Worker hat keine Worker-Threads)
  length-buckets.js     Batch nach Tokenlänge aufteilen (kein Auffüllen auf den längsten Text)
  desklib_build.js      desklib-Umwandlung beim Download
  content.js            Textauswahl, Warteschlange/Priorisierung, Markierung, Ergebnis-Register
                        (`results`: Element → Score, Text, Modell, Quelle – Basis für Feedback/Berichte)
  content-popover.js    Ergebnis-Popover der manuellen Prüfung (Shadow DOM)
  popup.*, options.*    Oberfläche; das Popup bekommt STATS gepusht statt zu pollen
  welcome.*             Begrüßung nach der Installation (Bedeutung der Farben, Grenzen, Download)
  privacy.html          Datenschutzerklärung
  models/desklib/       Graph ohne Gewichte + Bauanleitung
  vendor/               per `npm run vendor` (nicht im Git)
  generated/            per `npm run build:blocklist` (im Git): blocklist.js = mitgelieferte Sperrliste
server/                 shim_server.py (TMR/desklib per PyTorch, optional Laya-Proxy), Port 8787
test/                   harness.html (Testseite), e2e/ (Playwright-Tests)
training/               Datensatz-Aufbereitung (HC3), Backend-Vergleich, Messergebnisse
scripts/                vendor.mjs, build-blocklist.mjs, build_desklib_skeleton.py,
                        package.mjs + zip.mjs (Zip nach dist/)
```

### Neues Modell oder neuer Provider

- **Modell:** Eintrag in `extension/models.js`. Mit Abschnitt `browser` (ONNX-Repo, gepinnte
  `revision`, `version`, `marker`) erscheint es unter „Im Browser“, mit `server` unter „Lokaler
  Server“ (dann auch in `server/shim_server.py` anbieten). Textlänge (`maxChars`) und Ampel-Presets
  (`thresholds`) gelten automatisch für beide.
- **Provider:** Beschreibung in `AIVSAI.PROVIDERS` (`extension/config.js`: Name, Felder, Endpunkt,
  Modellkennung) plus Anfrage unter demselben Schlüssel in `BACKENDS` (`extension/bg/providers.js`).
  Einstellungsformular, Defaults, Secrets (`secret: true` → `storage.local`), Cache-Signatur und
  Datenschutz-Hinweis leiten sich daraus ab. Die Unit-Tests prüfen, dass beide Seiten zusammenpassen.
  Mit `check` bekommt der Provider „Modell prüfen“; was das Backend über das Modell weiß (Version,
  Textlänge, Labels), liefert es über `inspect` in `BACKENDS`.

Performance-Grundsätze im Content-Script: Beim Einsammeln und Priorisieren erst alles lesen, dann
schreiben (kein Layout-Thrashing); `MutationObserver` nur auf Seiten, die gescannt werden;
Statistik aus dem Register statt Dokument-Scans.

## Roadmap

**Erledigt**

- v0.2 (2026-09-24): Scan-Modi, Ampel, Popup, Provider-Abstraktion, Priorisierung, Lazy-Scan,
  Rechtsklick-Prüfung.
- v0.3: TMR im Browser (Offscreen-Dokument, WASM, Multithreading via COOP/COEP).
- v0.4: desklib im Browser mit Umwandlung beim Download.
- v0.5 (2026-09-25): Umbau für die geplanten Features (`scanPolicy`, `modelKey`, Ergebnis-Register,
  modularer Service Worker), Performance im Content-Script, dauerhafter Score-Speicher mit
  Aufbewahrungsdauer, Modellversion im Schlüssel, genauere Textauswahl (Navigation per Rolle,
  Dialoge, Code, Icon-Fonts, unsichtbare Absätze), E2E-Tests im Repo (`npm test`).
- Sperrliste „nie scannen“ (`scanPolicy` → `"blocked"`): mitgelieferte Liste per Build-Skript
  (UT1 + FDIC + NCUA + Wikidata + handverlesen), eigene Einträge, Ausnahmen, Passwortfeld-Heuristik;
  Datenschutzerklärung.
- Feedback Stufe 1: „Weißt du, woher der Text stammt?“ im Prüfergebnis, nur lokal, mit Einwilligung,
  JSONL-Export, `training/import_feedback.py`.
- BYOM-Rahmen: Vertrag mit `lang` und `GET /v1/info` (Shim mit gepinnten Revisionen), „Modell prüfen“
  gegen ein Referenzset, Hugging-Face-Metadaten statt Raten, Version im Modellschlüssel.

- Weniger Fehlalarme: andere Sprachen nicht bewerten (Erkennung pro Absatz), Stufe „unsicher“ für kurze
  Texte, TMR-Schwellen 0.95/0.98 nach Messung auf Wikipedia, „KI-Score“ statt Prozent, Begrüßungsseite.
- Gleichzeitige Anfragen für denselben Absatz (mehrere Tabs, doppelter Absatz im Batch) gehen nur einmal
  an Speicher und Backend.
- Berechtigung `tabs` durch `activeTab` ersetzt: gebraucht wird nur die URL des aktiven Tabs im Popup.
- Kurze Absätze zusammen bewerten (benachbarte Absätze unter `reliableWords` als ein Text).
- Breitere Eval-Suite: 1200 Texte, 6 Domänen, 7 Generatoren bis GPT-4o (`training/evaluate_suite.py`).
- desklib als Standardmodell (bestehende Installationen ohne Modellwahl behalten TMR).
- desklib rot ab 0.94 (kreuzvalidiert auf 1200 Texten); Modellsuche: fakespot als drittes Modell
  gefunden (`training/MODEL_SEARCH.md`), Einbindung offen; `npm run measure:pages` für echte Seiten.
- Store-Vorbereitung: Icons, Seite „Über / Lizenzen“ (`about.html`), Store-Texte und Begründung der
  Berechtigungen (`store/`), Screenshot-Skript.

**Offen:** siehe `TODO.md`.

## Lizenz

Der Code steht unter der MIT-Lizenz (`LICENSE`). Ausgenommen sind die mitgelieferte Sperrliste
`extension/generated/blocklist.js` und das Referenzset `extension/bg/reference-set.js` (Texte aus HC3),
die unter CC BY-SA 4.0 stehen. Quellen und Lizenzen aller
Drittkomponenten: `extension/THIRD_PARTY_NOTICES.md`.
