# AI Content Flag — Browser-Extension

Bewertet längere Textabsätze auf Webseiten mit einem KI-Text-Klassifikator und markiert sie als
Ampel (grün / gelb / rot) mit Prozent-Badge. Das Modell läuft standardmäßig **direkt im Browser**
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
Internet, ~10 s). Die erzeugte Liste liegt im Git: Änderungen im Diff gegenlesen und mit committen.
Das Skript bricht ab, wenn eine Quelle nicht erreichbar ist oder deutlich weniger Einträge liefert
als erwartet – dann wird keine halb leere Liste ausgeliefert.

In Chrome/Edge:

1. `chrome://extensions` → „Entwicklermodus“ an → „Entpackte Erweiterung laden“ → `extension/`.
2. Die Einstellungen öffnen sich → Modell wählen, „Herunterladen“ (einmalig, von Hugging Face,
   kein Token): TMR 126 MB, desklib 1,7 GB (wird im Browser auf ~475 MB umgewandelt).
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
npm test             # alle E2E-Tests (~30 s), führt vorher `npm run vendor` aus
$env:HEADED=1; npm test   # mit sichtbarem Browserfenster
```

Die Tests (`test/e2e/*.test.mjs`, Node-Test-Runner + Playwright) laden die echte Extension in
Chromium und lassen sie gegen ein Fake-Backend laufen, das den Vertrag von `shim_server.py` spricht
und jeden gesendeten Text mitschreibt (zufälliger Port, ein laufender `shim_server.py` stört nicht).

| Datei | Prüft |
|---|---|
| `scan.test.mjs` | Auto-Scan, Popup-Zähler, Icon-Badge, nachgeladene Absätze, Cache, Schwellen, Auswahl-/Rechtsklick-Prüfung, An/Aus, Lazy-Scan, Freigabe pro Seite, Sperrliste (eigene Einträge, mitgelieferte Liste, Ausnahmen, Passwortfeld-Heuristik), Backend-Status, Einstellungen |
| `extraction.test.mjs` | Was ans Modell geht: 23 Grenzfälle (Navigation, Cookie-Banner, versteckte Absätze, Code, Icon-Fonts, Formulare …), mit und ohne Lazy-Scan |
| `score-store.test.mjs` | Dauerhafter Speicher: SW-Neustart, Zuordnung über Seiten, Modellwechsel, Aufbewahrung, „Nicht speichern“ |

Nicht abgedeckt: Bewertung mit dem echten Browser-Modell (bräuchte den Modell-Download) und der
Hugging-Face-Provider mit echtem Token.

## Funktionen

- **An/Aus und Scan-Modi:** Master-Schalter (Popup, `Alt+Shift+A`), Badge „AUS“ am Icon. Gescannt
  wird „nur auf Knopfdruck“ (`Alt+Shift+S`), „auf ausgewählten Seiten“ (Default, Schalter pro
  Domain im Popup) oder „auf allen Seiten“. Ohne Freigabe verschickt das Content-Script keinen
  Text und beobachtet die Seite nicht.
- **Sperrliste „nie scannen“:** gilt vor jedem Scan-Modus, auch „Seite jetzt scannen“ ist dort
  gesperrt. Erlaubt bleibt die bewusste Einzelprüfung per Auswahl/Rechtsklick – das Popover weist
  dann auf die Sperre hin und nennt bei externen Backends, wohin der Text ging. Drei Bausteine:
  - *Mitgelieferte Liste* (`builtinBlocklist`, ~10.400 Domains: Online-Banking weltweit mit
    Schwerpunkt DE/UK/US, Webmail, Zahlungsdienste, Behördenportale mit Login) – erzeugt von
    `scripts/build-blocklist.mjs` aus UT1-Blacklists, FDIC BankFind und einer handverlesenen Liste.
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
  10.000 Einträgen in jedem Tab (171 KB pro Content-Script).
- **Ampel:** zwei Schwellen (Gelb ab / Rot ab, Presets pro Modell), grün = geprüft und *nicht* als
  KI erkannt (abschaltbar), Prozent-Badge, auch ohne Farbwahrnehmung unterscheidbar
  (dünn / gestrichelt / kräftig). Popup mit Zählern pro Seite und Backend-Status; Icon-Badge mit
  Anzahl roter (sonst gelber) Absätze, „!“ bei Fehler.
- **Sichtbarer Bereich zuerst:** 5er-Batches, nacheinander (Browser/lokal 1, remote 2 parallel).
  Die Reihenfolge wird erst beim Absenden bestimmt – nach einem Scroll springt die Priorität mit.
- **Lazy-Scan (Default an):** nur Absätze bis 1,5 Bildschirmhöhen um den sichtbaren Bereich, der
  Rest per `IntersectionObserver`, wenn er in die Nähe kommt.
- **Einzelne Stellen prüfen:** Rechtsklick auf markierten Text bzw. auf einen Absatz (oder
  `Alt+Shift+C`), unabhängig vom Scan-Modus und auch für Text, den der Auto-Scan auslässt
  (ab 5 Wörtern, bis 2000 Zeichen). Markierung per CSS Custom Highlight API, Ergebnis im Popover.
- **Bewertungen merken (Default 30 Tage, einstellbar bis 1 Jahr oder „nicht speichern“):**
  bekannte Absätze werden sofort markiert, ohne neu zu rechnen – auch nach Browser-Neustart und
  auf anderen Seiten mit demselben Text.
- **Backends** (`extension/bg/providers.js`): Im Browser (TMR oder desklib), Lokal
  (`shim_server.py`), Eigener Server (Vertrag `POST {texts, model?} -> {scores}`, optional Bearer-Key),
  Hugging Face Inference API (Label-Mapping automatisch oder manuell). Host-Berechtigungen für
  Remote-Backends werden erst beim Speichern angefragt; Tokens nur in `storage.local`.

### Was bewertet wird

Kandidaten sind `p`, `li` und `article` (Letzteres nur ohne eigene lange Absätze) mit mindestens
40 Wörtern; gesendet werden die ersten 500 Zeichen des *sichtbaren* Texts (`innerText`, kein HTML,
kein Script/Style-Inhalt).

- **Nie:** Navigation und Seitenrahmen (`nav`, `header`, `footer`, `role=navigation|banner|contentinfo|search`),
  Dialoge (`dialog`, `role=dialog` – meist Cookie-Banner), Code (`pre`), Eingaben (`textarea`,
  `input`, `contenteditable` …), `template`, nicht gerenderte Absätze (`display:none`, `hidden`,
  zugeklappt – sie kommen nach, sobald sie sichtbar werden).
- **Aus dem Text herausgerechnet:** Icon-Fonts und andere `aria-hidden`-Teile, Code-Blöcke.
- **Bewusst trotzdem bewertet:** Absätze unter `aria-hidden`-Vorfahren (viele Seiten verstecken so
  den ganzen Inhalt, solange ein Modal offen ist), `form` (ASP.NET packt ganze Seiten in ein
  Formular), `aside`/`role=complementary`. Stichprobe 2026-09-25 (43 Seiten: News DE/EN, Tech-Blogs,
  Doku, Wikipedia, Rezepte): 0 von 752 bewerteten Absätzen lagen in einem `aside` – die vorhandenen
  `aside`-Elemente sind Werbe-/Nachlade-Slots ohne Text oder Teaser-Listen, die schon an der
  40-Wörter-Grenze scheitern. Ausschließen brächte nichts, würde aber Randnotizen und
  Info-Kästen im Artikel verlieren. Neu bewerten, falls das Feedback (Roadmap 2) Fehlalarme dort zeigt.
- **Nicht erreicht:** Shadow DOM, iframes.

## Datenschutz und Speicher

Datenschutzerklärung: `extension/privacy.html` (verlinkt in den Einstellungen). Vor einer
Veröffentlichung im Web Store: Kontakt eintragen und die Seite zusätzlich öffentlich hosten
(der Store verlangt eine URL).

- Provider „Im Browser“ und „Lokal“: Texte verlassen den Rechner nicht. Einziger Netzwerkzugriff ist
  der einmalige Modell-Download von Hugging Face.
- Eigener Server / Hugging Face: bis zu 500 Zeichen pro Absatz (manuell bis 2000) gehen an diesen
  Dienst – die Einstellungen weisen darauf hin.
- **Score-Speicher** (IndexedDB, `extension/bg/score-store.js`, nicht synchronisiert): pro Absatz nur
  ein 128-Bit-Hash (SHA-256 über Modell-Konfiguration + Text), Score, Modell und Zeitpunkt –
  **kein Text, keine URL**. Gemessen ~235 Byte pro Eintrag (50.000 = 11,7 MB, 30 Tage intensives
  Surfen ≈ 10 MB). Aufräumen täglich (`chrome.alarms`), beim Browserstart und sofort bei Änderung der
  Einstellung; Obergrenze 200.000 Einträge; „Alle löschen“ in den Einstellungen.
- **Zuordnung:** Der Schlüssel enthält Provider-Einstellungen und Modellversion (`modelKey`, z.B.
  `browser:tmr@b9aa251-q8`). Modellwechsel → neu bewerten, alte Einträge bleiben fürs Zurückwechseln;
  neue Modell-Revision/Quantisierung → `version` in `config.js` ändern, alte Scores gelten nicht mehr.
  Einschränkung: bei „Lokal“/„Eigener Server“ kennt die Extension die Modellversion des Servers nicht.

## Modelle

| Modell | Größe | im Browser (Ryzen 7 5800U, 8 Threads) | Genauigkeit (HC3, 100 Beispiele) | Wikipedia „Photosynthesis“ |
|---|---|---|---|---|
| **TMR** (RoBERTa-base) – *Schnell* | 126 MB | ~0,15 s/Absatz, Laden ~2 s | AUROC 0.908 (PyTorch 0.911) | 50/80 rot (Fehlalarme) |
| **desklib** (DeBERTa-v3-large) – *Genau* | 1,7 GB → 475 MB | ~1 s/Absatz, Laden ~4 s, Download+Umwandlung ~57 s | AUROC 0.998 | 3/80 rot |

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
  config.js             Defaults + gemeinsame Regeln für alle Teile:
                        scanPolicy/blockReason (darf gescannt werden?), modelKey (Modell + Version),
                        Modell-Metadaten/Revisionen, Presets, Ampel-Stufen
  background.js         Service Worker (ES-Modul): verdrahtet Events und Nachrichten mit bg/
  bg/providers.js       Backends
  bg/scoring.js         Konfig-Cache, Score-Cache (Arbeitsspeicher → IndexedDB → Modell), Test, Status
  bg/score-store.js     dauerhafter Score-Speicher mit Aufbewahrungsdauer
  bg/badge.js           Icon-Badge pro Tab
  bg/offscreen-client.js  Brücke zum Offscreen-Dokument
  offscreen.js          Modell per transformers.js/WASM (Service Worker hat keine Worker-Threads)
  desklib_build.js      desklib-Umwandlung beim Download
  content.js            Textauswahl, Warteschlange/Priorisierung, Markierung, Ergebnis-Register
                        (`results`: Element → Score, Text, Modell, Quelle – Basis für Feedback/Berichte)
  content-popover.js    Ergebnis-Popover der manuellen Prüfung (Shadow DOM)
  popup.*, options.*    Oberfläche; das Popup bekommt STATS gepusht statt zu pollen
  privacy.html          Datenschutzerklärung
  models/desklib/       Graph ohne Gewichte + Bauanleitung
  vendor/               per `npm run vendor` (nicht im Git)
  generated/            per `npm run build:blocklist` (im Git): blocklist.js = mitgelieferte Sperrliste
server/                 shim_server.py (TMR/desklib per PyTorch, optional Laya-Proxy), Port 8787
test/                   harness.html (Testseite), e2e/ (Playwright-Tests)
training/               Datensatz-Aufbereitung (HC3), Backend-Vergleich, Messergebnisse
scripts/                vendor.mjs, build-blocklist.mjs, build_desklib_skeleton.py
```

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
  (UT1 + FDIC + handverlesen), eigene Einträge, Ausnahmen, Passwortfeld-Heuristik;
  Datenschutzerklärung.

**Als Nächstes (Reihenfolge = Priorität)**

1. **Feedback „Falsch erkannt“** am Absatz/Popover → Trainingsdaten fürs eigene Fine-Tuning.
   Daten liegen im Ergebnis-Register (`results`); braucht eigenen Speicher *mit* Text → nur mit
   ausdrücklicher Einwilligung.
2. **Score-Kalibrierung pro Modell**, damit Schwellen modellübergreifend dasselbe bedeuten. In
   `bg/scoring.js` pro `modelKey` auf den Rohwert anwenden – gespeichert werden Rohwerte, eine neue
   Kalibrierung braucht also kein Neu-Bewerten.
3. **Deutsch/mehrsprachig:** Fine-Tuning eines mehrsprachigen Encoders (mDeBERTa-v3/XLM-R) ähnlich
   desklib; Content-Script schickt dann `lang` pro Absatz mit, der Provider wählt das Modell.
   Vorarbeit: Laya-Datensatz liegt fertig (`training/data/`, 142k Beispiele), Training offen
   (`training/README.md`).
4. **Berichte pro Seite exportieren/importieren** (URL, Absätze, Scores, Modell, Zeitpunkt) aus dem
   Ergebnis-Register; Ausbaustufe Konto/Sync/Teilen → Datenschutz/Einwilligung.
5. **Zurückgestellt:** Hugging-Face-Provider mit echtem Token testen (bisher nur gemockt).

**Technische Punkte aus der v0.5-Analyse**

- Batch-Größe pro Provider (neben `maxInFlight` in `config.js`): ein 5er-Batch desklib blockiert
  ~5 s, in der Zeit reagiert die Priorisierung nicht aufs Scrollen.
- Server-Backends: Modellversion vom Server abfragen (z.B. `/healthz`) und in den Schlüssel nehmen.
- Gleichzeitige Anfragen für denselben Absatz aus mehreren Tabs im Service Worker zusammenfassen.
- Sperrliste: UK-Banken sind in UT1 dünn (~60 `.uk`-Domains) – bei Bedarf FCA-Register als Quelle
  prüfen (Zugang und Lizenz noch nicht geklärt). Deutsche Genossenschaftsbanken/Sparkassen haben teils eigene Domains, die in
  keiner Liste stehen; die Passwortfeld-Heuristik fängt deren Login-Seiten ab.

## Stolpersteine (gelöst)

- transformers.js lädt nach Neustart des Offscreen-Dokuments nicht aus dem Cache (Tokenizer-Suche
  ignoriert die Revision; „local + remote aus“ gilt als ungültig) → Tokenizer wird selbst aus dem
  Cache gebaut (`offscreen.js`).
- desklibs Beispielcode crasht mit `transformers>=5` (`all_tied_weights_keys`) → Property-Fix in
  `server/shim_server.py` / `training/evaluate_backends.py`.
- `laya-serve` hat `/health`, nicht `/healthz`.
