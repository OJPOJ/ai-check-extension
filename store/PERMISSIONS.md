# Berechtigungen – Begründung fürs Store-Formular

Deckt die Felder ab, die Chrome Web Store / Edge Add-ons beim Einreichen verlangen: „Single Purpose“,
Begründung je Berechtigung, Datennutzung, Remote-Code. Bezug: `extension/manifest.json`.

## Single Purpose (Chrome verlangt eine einzige, zusammenhängende Beschreibung)

„Scans paragraphs on web pages the user opts in, with a locally-run or user-chosen AI-text
classifier, and flags them with a green/yellow/red score.“ Alle Berechtigungen dienen genau diesem
einen Zweck (Text lesen und markieren, Ergebnis merken, Modell laufen lassen, Nutzer entscheiden
lassen, was/wann gescannt wird).

## Berechtigungen (`permissions`)

- **`storage`** – speichert Einstellungen (`chrome.storage.sync`), API-Zugangsdaten für optionale
  Backends (`chrome.storage.local`, nie synchronisiert) sowie die Bewertungs- und Feedback-Sammlung
  (IndexedDB, ebenfalls lokal). Kein Zugriff auf Daten anderer Erweiterungen oder Websites.
- **`activeTab`** – liefert dem Popup Host/URL des gerade aktiven Tabs, um dort den Sperrlisten-Status
  und den Seiten-Schalter („diese Seite automatisch scannen“) anzuzeigen. Kein dauerhafter oder
  hintergründiger Tab-Zugriff.
- **`offscreen`** – das im Browser laufende KI-Modell (WebAssembly, transformers.js) braucht einen
  DOM-Kontext mit Worker-Threads; Service Worker haben das nicht. Das Offscreen-Dokument lädt und
  betreibt ausschließlich das Modell, zeigt nichts an und hat kein UI.
- **`contextMenus`** – fügt den Rechtsklick-Eintrag „Auf KI prüfen“ für markierten Text bzw. Absätze
  hinzu (Einzelprüfung unabhängig vom automatischen Scan-Modus).
- **`alarms`** – stößt das tägliche Aufräumen des Bewertungs-Speichers an (abgelaufene Einträge nach
  der eingestellten Aufbewahrungsdauer löschen), unabhängig davon, ob die Erweiterung gerade offen ist.

## Host-Berechtigungen (`host_permissions`)

- **`http://127.0.0.1/*`, `http://localhost/*`** – fest eingetragen für den optionalen lokalen Server
  (`server/shim_server.py`, Provider „Lokal“), der PyTorch-Backends für dieselben Modelle bereitstellt.
  Ohne Netzwerkzugriff außerhalb des eigenen Rechners.

## Optionale Host-Berechtigungen (`optional_host_permissions`)

- **`https://*/*`, `http://*/*`** – nicht beim Installieren gewährt, sondern erst zur Laufzeit gezielt
  für **eine** konkrete Adresse angefragt (`chrome.permissions.request`), wenn der Nutzer in den
  Einstellungen einen eigenen Server oder Hugging Face als Backend einträgt und speichert bzw. testet
  (`extension/options.js`, `requestOrigins`). Ohne diesen bewussten Schritt hat die Erweiterung keinen
  Zugriff auf zusätzliche Hosts.

## Content-Script (`content_scripts`, `matches: ["<all_urls>"]`)

Liest sichtbaren Absatztext (`innerText`, kein HTML, keine Formulareingaben, keine Passwörter) auf
Seiten, die der Nutzer zum Scannen freigegeben hat, und markiert bewertete Absätze farbig direkt im
Dokument (CSS Custom Highlight API). `<all_urls>` ist nötig, weil vorab nicht feststeht, welche Seiten
der Nutzer freigibt – ausgeschlossen sind `localhost`/`127.0.0.1` (dort läuft ggf. der lokale Server).
Ob überhaupt gescannt wird, entscheidet zur Laufzeit `scanPolicy` (`extension/config.js`): Scan-Modus,
Sperrliste (mitgeliefert + eigene Einträge), Passwort-/Zahlungsfeld-Erkennung.

## `wasm-unsafe-eval` (Content Security Policy)

Nötig, damit ONNX Runtime Web (Teil von transformers.js) WebAssembly-Module kompilieren und ausführen
darf – für das im Browser laufende KI-Modell (Provider „Im Browser“). Betrifft nur
Erweiterungsseiten/Offscreen-Dokument, nicht besuchte Webseiten.

## Datennutzung (Chrome-Formular „Data usage“)

- **Website-Inhalte:** ja – sichtbare Textabsätze der Seiten, die der Nutzer freigibt, zur Bewertung.
- **Verarbeitung:** standardmäßig **lokal auf dem Gerät** (Modell im Browser oder lokaler Server).
  Nur wenn der Nutzer ausdrücklich einen eigenen Server oder die Hugging Face Inference API einträgt,
  gehen Textausschnitte (bis 2000 Zeichen pro Absatz) an diesen selbst gewählten Dienst – die
  Einstellungen zeigen dafür einen Hinweis, bevor gespeichert wird.
- **Nicht erhoben:** keine Nutzungsstatistiken/Analytics, keine Werbung, kein Tracking, kein Verkauf
  oder Weitergabe von Daten an Dritte außer dem selbst gewählten Backend.
- **Gespeichert wird lokal:** Einstellungen; ein Hash (kein Text) je bewertetem Absatz mit Score,
  Modell, Zeitpunkt (einstellbare Aufbewahrung, Default 30 Tage); optional, nur nach Einwilligung,
  eine Feedback-Sammlung mit Text (für Trainings-/Testzwecke, Export als JSONL, jederzeit löschbar).
  Details: `extension/privacy.html`.

## Remote-Code-Erklärung

**Nein**, die Erweiterung lädt keinen ausführbaren Code nach. Der komplette JavaScript-/WASM-Code
(inkl. transformers.js und ONNX Runtime Web) ist im Paket enthalten (`extension/vendor/`, per
`npm run vendor` gebaut und mitausgeliefert). Zur Laufzeit von Hugging Face nachgeladen werden
ausschließlich **Modellgewichte** (Daten, keine Programmlogik) – einmalig, nach ausdrücklichem Klick
auf „Herunterladen“ in den Einstellungen, mit Anzeige der Downloadgröße vorher. Bei Nutzung eines
eigenen Servers/Hugging-Face-Backends werden Textausschnitte zur Bewertung gesendet; auch das ist
Datenaustausch, kein Nachladen von Code.
