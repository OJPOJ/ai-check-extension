# AI Content Flag

**Browser-Extension, die Textabsätze auf Webseiten auf KI-Merkmale prüft – direkt in deinem
Browser, ohne dass deine Texte deinen Rechner verlassen.**

Längere Absätze werden mit einem KI-Text-Klassifikator bewertet und als Ampel markiert:

| Markierung | Bedeutung |
|---|---|
| 🟢 grün, dünner Rahmen | unauffällig – geprüft, nicht als KI erkannt |
| 🟡 gelb, gestrichelt | unklar |
| 🔴 rot, kräftiger Rahmen | auffällig – ähnelt KI-Text |
| ⚪ grau, „unsicher“ | zu kurz für ein verlässliches Urteil |

Dazu ein KI-Score von 0–100. Die Rahmen unterscheiden sich auch ohne Farbwahrnehmung.

![Markierte Absätze auf einer Beispielseite](store/screenshots/1-scan.png)

> [!IMPORTANT]
> **Ein Hinweis, kein Beweis.** Der Score ist keine Wahrscheinlichkeit. Auch von Menschen
> geschriebene Texte werden manchmal rot markiert – besonders kurze, übersetzte oder stark
> redigierte. Bitte unterstelle niemandem allein wegen dieser Markierung KI-Nutzung.

---

## 🔒 Datenschutz

Die Extension wurde von Anfang an so gebaut, dass du nichts preisgeben musst:

- **Läuft lokal.** Das Modell arbeitet standardmäßig direkt im Browser (WebAssembly). Gelesene
  Texte werden nirgendwohin geschickt. Die einzige Verbindung nach außen ist der **einmalige
  Download des Modells** von Hugging Face – dabei werden keine Seiteninhalte übertragen.
- **Kein Tracking.** Keine Nutzungsstatistik, keine Werbung, keine Analyse-Dienste, kein Konto,
  keine Weitergabe an Dritte.
- **Nur, wo du es erlaubst.** Standardmäßig wird nur auf Seiten gescannt, die du selbst
  freigibst. Ohne Freigabe liest die Extension dort keinen Text.
- **Sensible Seiten sind tabu.** Online-Banking, Webmail, Zahlungsdienste und Behördenportale
  (rund 14.000 Domains) werden nie automatisch gescannt. Die Liste ist fest eingebaut und wird
  nicht aus dem Netz nachgeladen – niemand erfährt, welche Seiten du besuchst. Zusätzlich
  pausiert die Extension auf jeder Seite mit Passwort-, Kreditkarten- oder Einmalcode-Feld (der
  Inhalt solcher Felder wird nie gelesen).
- **Nur das Nötigste wird gespeichert – und nur bei dir.** Bereits bewertete Absätze merkt sich
  die Extension als Fingerabdruck (Hash) mit Score – **ohne Text und ohne Adresse**, standardmäßig
  30 Tage, jederzeit löschbar oder ganz abschaltbar.
- **Feedback nur mit Einwilligung.** Wenn du angibst, woher ein Text stammt, wird das erst nach
  deiner ausdrücklichen Zustimmung gespeichert – lokal, ohne Adresse, und nie übertragen.
- **Ein Schalter für alles:** `Alt+Shift+A` stoppt jede Verarbeitung.
- **Quelloffen.** Jede Zeile Code ist hier im Repository nachprüfbar.

**Optional** kannst du statt des Browser-Modells einen eigenen Server, einen Cloud-Dienst oder
die Hugging Face Inference API nutzen. Nur dann gehen Absätze (bis 2000 Zeichen) an diesen
Dienst – die Einstellungen zeigen das deutlich an, bevor etwas gesendet wird.

Vollständige Datenschutzerklärung: [`extension/privacy.html`](extension/privacy.html) (auch in
den Einstellungen der Extension verlinkt).

---

## 📦 Installation

Die Extension wird nur hier über GitHub angeboten, nicht über den Chrome Web Store. Sie läuft in
**Chrome, Edge, Brave und anderen Chromium-Browsern**.

1. **Herunterladen:** Unter [Releases](https://github.com/OJPOJ/ai-check-extension/releases/latest)
   die Datei `ai-content-flag-<version>.zip` herunterladen.
2. **Entpacken** in einen Ordner, den du behältst (z. B. `Dokumente\AI Content Flag`).
   Nicht löschen – der Browser lädt die Extension aus diesem Ordner.
3. **Erweiterungsseite öffnen:** `chrome://extensions` (Edge: `edge://extensions`) in die
   Adresszeile eingeben.
4. **Entwicklermodus** einschalten (Schalter oben rechts, in Edge links unten).
5. **„Entpackte Erweiterung laden“** klicken und den entpackten Ordner auswählen (den Ordner, in
   dem die Datei `manifest.json` liegt).
6. Optional: über das Puzzle-Symbol in der Symbolleiste die Extension **anheften**.

Danach öffnet sich eine Begrüßungsseite und die Einstellungen.

> [!NOTE]
> Weil die Extension nicht aus einem Store kommt, zeigt der Browser das Wort „Entwicklermodus“
> an und aktualisiert sie **nicht automatisch**. Das ist bei Installationen von GitHub normal.

### Modell herunterladen (einmalig)

In den Einstellungen ein Modell wählen und auf **„Herunterladen“** klicken. Es wird einmal von
Hugging Face geladen (kein Konto, kein Token nötig) und bleibt danach im Browser gespeichert.

| Modell | Download | Wofür |
|---|---|---|
| **Genau** (desklib) – Standard | 1,7 GB, im Browser auf ~475 MB verkleinert | beste Treffsicherheit, wenigste Fehlalarme, ~1 s pro Absatz |
| **Ausgewogen** (fakespot) | 125 MB | guter Kompromiss |
| **Schnell** (TMR) | 126 MB | sehr schnell, aber deutlich mehr Fehlalarme |

Tipp: Bei langsamer Verbindung oder wenig Speicherplatz mit „Ausgewogen“ beginnen.

### Aktualisieren

1. Neue Zip-Datei von den [Releases](https://github.com/OJPOJ/ai-check-extension/releases)
   herunterladen.
2. Den Inhalt des **bisherigen Ordners** durch den neuen ersetzen (gleicher Ordner!).
3. Unter `chrome://extensions` bei AI Content Flag auf den Neu-laden-Pfeil ↻ klicken.

Einstellungen, heruntergeladenes Modell und gespeicherte Bewertungen bleiben erhalten, solange
der Ordner derselbe bleibt. Wer die Extension entfernt und aus einem anderen Ordner neu lädt,
fängt von vorn an.

---

## 🚀 Benutzung

**Seite freigeben:** Auf einer Webseite das Extension-Symbol anklicken und den
Schalter „Diese Seite automatisch scannen“ einschalten. Ab dann wird die Seite beim Besuch geprüft. Alternativ einmalig
„Diese Seite jetzt scannen“.

**Einzelne Stelle prüfen:** Text markieren → Rechtsklick → „Markierten Text auf KI prüfen“
(oder `Alt+Shift+C`). Ohne Markierung: Rechtsklick auf einen Absatz → „Diesen Absatz auf KI
prüfen“. Das funktioniert überall, auch auf nicht freigegebenen Seiten.

**Details ansehen:** Auf das Score-Schild eines markierten Absatzes klicken.

**Tastenkürzel**

| Kürzel | Aktion |
|---|---|
| `Alt+Shift+A` | Extension an / aus |
| `Alt+Shift+S` | aktuelle Seite jetzt scannen |
| `Alt+Shift+C` | markierten Text prüfen |

Änderbar unter `chrome://extensions/shortcuts`.

**Scan-Modus** (in den Einstellungen): *nur auf Knopfdruck*, *auf ausgewählten Seiten*
(Standard) oder *auf allen Seiten*. Die Sperrliste für sensible Seiten gilt in jedem Modus;
eigene Einträge und Ausnahmen lassen sich in den Einstellungen oder per „Hier nie scannen“ im
Popup festlegen.

---

## ⚠️ Grenzen

- **Nur Englisch.** Die Modelle sind ausschließlich auf englischen Texten trainiert. Absätze in
  anderen Sprachen werden erkannt und bewusst **nicht bewertet** (die Anzahl steht im Popup).
  Per Rechtsklick lassen sie sich trotzdem prüfen, das Ergebnis ist dann immer „unsicher“.
- **Fehlalarme kommen vor.** Mit dem Standardmodell wurde in Tests etwa 1 von 100 menschlichen
  Absätzen fälschlich rot markiert, mit „Schnell“ deutlich mehr.
- **Kurze Texte** unter ca. 120 Wörtern werden meist als „unsicher“ statt farbig markiert, weil
  das Modell dort zu oft irrt.
- **Nicht erreicht** werden Inhalte in iframes und im Shadow DOM.
- Neuere oder gezielt umformulierte KI-Texte können unerkannt bleiben.

---

## ❓ Häufige Fragen

**Warum nicht im Chrome Web Store?**
Die Extension wird bewusst direkt als Open-Source-Projekt verteilt. Der Code, den du
installierst, ist genau der Code in diesem Repository.

**Ist der Entwicklermodus gefährlich?**
Er erlaubt nur, Extensions aus einem Ordner zu laden. Installiere auf diese Weise nur Extensions
aus Quellen, denen du vertraust – bei diesem Projekt kannst du den Quellcode selbst prüfen.

**Wie werde ich die Extension und alle Daten wieder los?**
Unter `chrome://extensions` auf „Entfernen“ klicken. Der Browser löscht dabei alle lokal
gespeicherten Daten der Extension, inklusive Modell. Danach kannst du den Ordner löschen.

**Kann ich ein eigenes Modell oder einen eigenen Server verwenden?**
Ja – siehe [`DEVELOPMENT.md`](DEVELOPMENT.md) und [`server/README.md`](server/README.md).

---

## ☕ Unterstützen

AI Content Flag ist und bleibt kostenlos, werbefrei und ohne Tracking. Wenn dir die Extension
nützt, freuen wir uns über einen Kaffee:

[![Auf Ko-fi unterstützen](https://img.shields.io/badge/Ko--fi-Kaffee%20spendieren-FF5E5B?logo=ko-fi&logoColor=white)](https://ko-fi.com/ojpoj)

Genauso hilfreich: Fehlalarme oder Probleme als [Issue](https://github.com/OJPOJ/ai-check-extension/issues)
melden.

---

## 🛠️ Für Entwickler

Build, Tests, Architektur und Messergebnisse: [`DEVELOPMENT.md`](DEVELOPMENT.md).
Offene Punkte: [`TODO.md`](TODO.md).

## Lizenz

Der Code steht unter der [MIT-Lizenz](LICENSE). Ausgenommen sind die mitgelieferte Sperrliste
(`extension/generated/blocklist.js`) und das Referenzset (`extension/bg/reference-set.js`), die
unter CC BY-SA 4.0 stehen. Quellen und Lizenzen aller Drittkomponenten:
[`extension/THIRD_PARTY_NOTICES.md`](extension/THIRD_PARTY_NOTICES.md).
