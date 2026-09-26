# Store-Eintrag

Texte für das Store-Formular (Chrome Web Store / Edge Add-ons), Deutsch und Englisch. Zeichenzahlen
für die Kurzbeschreibung gelten für Chrome (Limit 132 Zeichen); Edge erlaubt mehr, dieselbe Kürzung
passt trotzdem.

## Name

AI Content Flag

## Kategorie

„Productivity“ (Chrome Web Store) bzw. „Produktivität“ (Edge Add-ons). Beide Stores ändern ihre
Kategorie-Taxonomien gelegentlich – beim Einreichen die aktuell verfügbaren Optionen prüfen; falls
„Productivity“ nicht (mehr) passt, ist „Tools“ die nächstbeste Wahl.

## Kurzbeschreibung (Deutsch, ≤132 Zeichen, 124 gezählt)

Markiert KI-verdächtige Textabsätze grün/gelb/rot – Score-Klassifikator, lokal im Browser oder per
Cloud-Dienst deiner Wahl.

## Short description (English, ≤132 characters, 124 counted)

Flags AI-suspicious paragraphs green/yellow/red with a score – runs locally in your browser or via
a cloud backend you pick.

## Ausführliche Beschreibung (Deutsch)

AI Content Flag bewertet längere Textabsätze auf Webseiten mit einem KI-Text-Klassifikator und
markiert sie als Ampel – grün (unauffällig), gelb (unklar) oder rot (auffällig, ähnelt KI-Text) –
zusammen mit einem Score von 0–100.

**Wie es läuft:** Standardmäßig läuft das Modell direkt im Browser per WebAssembly – Texte verlassen
den Rechner nicht. Wer möchte, kann stattdessen einen lokalen Server, einen eigenen Server/Cloud-Dienst
oder die Hugging Face Inference API verwenden; die Erweiterung zeigt dann deutlich, wohin Text
gesendet wird, bevor es passiert.

**Wann gescannt wird:** Nur auf Seiten, die du ausdrücklich freigibst (oder nur auf Knopfdruck) –
keine Texte werden ohne dein Zutun verschickt. Eine mitgelieferte Sperrliste (Online-Banking, Webmail,
Behördenportale) sowie eine Erkennung von Passwort-/Zahlungsfeldern verhindern das Scannen sensibler
Seiten zusätzlich, unabhängig von dieser Einstellung.

**Grenzen, ehrlich gesagt:**
- Die mitgelieferten Modelle sind ausschließlich auf **Englisch** trainiert. Absätze in anderen
  Sprachen werden erkannt und **nicht bewertet**, statt geraten zu werden.
- **Fehlalarme kommen vor** – auch menschlicher Text wird gelegentlich rot markiert, besonders
  kurzer, übersetzter oder stark redigierter Text (z.B. Lexikon-Artikel, Pressemitteilungen).
- Der Score ist ein **Hinweis, kein Beweis** und keine kalibrierte Wahrscheinlichkeit. Bitte
  niemandem allein aufgrund dieser Markierung KI-Nutzung unterstellen.
- Sehr kurze Absätze werden als „unsicher“ statt farbig markiert, weil das Modell dort zu oft irrt.

**Quelloffen:** Der Code steht unter der MIT-Lizenz. Details zu Lizenzen und Datenherkunft (u.a. eine
CC-BY-SA-4.0-Sperrliste und ein CC-BY-SA-4.0-Referenzset für „Modell prüfen“) sind über „Über /
Lizenzen“ in den Einstellungen der Erweiterung einsehbar.

## Detailed description (English)

AI Content Flag scores longer paragraphs on web pages with an AI-text classifier and flags them
green (unremarkable), yellow (unclear) or red (flagged, resembles AI-generated text), together with
a 0–100 score.

**How it runs:** By default the model runs directly in your browser via WebAssembly – text never
leaves your machine. If you prefer, you can instead use a local server, your own server/cloud service,
or the Hugging Face Inference API; the extension clearly shows where text would be sent before it is.

**When it scans:** Only on pages you explicitly allow (or only on demand, per click) – no text is
sent without your action. A built-in blocklist (online banking, webmail, government login portals)
and detection of password/payment fields additionally prevent scanning of sensitive pages, regardless
of this setting.

**Honest limits:**
- The bundled models are trained on **English only**. Paragraphs in other languages are detected and
  **not scored**, rather than guessed at.
- **False positives happen** – human-written text is occasionally flagged red too, especially short,
  translated, or heavily edited text (e.g. encyclopedia entries, press releases).
- The score is a **hint, not proof**, and not a calibrated probability. Please don't accuse anyone of
  using AI based solely on this flag.
- Very short paragraphs are marked "uncertain" instead of colored, because the model is unreliable
  there.

**Open source:** The code is MIT-licensed. License and data-provenance details (including a
CC BY-SA 4.0 blocklist and a CC BY-SA 4.0 reference set used for "check model") are available via
"About / Licenses" in the extension's settings.
