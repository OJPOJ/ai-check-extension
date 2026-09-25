# TODO

Offene Punkte, Reihenfolge = Priorität. Erledigtes steht in der Roadmap im `README.md`.
Stand: 2026-09-25.

## 1. BYOM: Rest

Rahmen, „Modell prüfen“ und Hugging-Face-Metadaten sind erledigt (README, „Eigene Modelle prüfen“;
Vertrag in `server/README.md`). Offen:

- **Mit echtem Token testen:** 2–3 bekannte Detektor-Modelle über „Modell prüfen“ (Hub-Metadaten,
  Router-Antwortformen, KI-Label aus `id2label`). Bisher nur gemockt (`providers.test.mjs`,
  `model-check.test.mjs`).
- **Referenzset verbreitern**, sobald die Eval-Suite (Punkt 3) steht: bisher nur HC3 (ChatGPT 2023).
- **Später – eigenes ONNX im Browser:**
  - HF-Repo mit `onnx/` + Tokenizer.
  - Architektur aus fester Liste (BERT, RoBERTa, DeBERTa-v2, XLM-R, DistilBERT).
  - 2 Labels, Größenlimit.
  - Wäre ein weiterer Eintrag in `models.js`; „Modell prüfen“ ließe sich dafür wiederverwenden.

## 2. Fehlalarme reduzieren (Vertrauen)

Der größte Schaden ist Rot auf einem menschlichen Text.

Erledigt: Sprache pro Absatz, Stufe „unsicher“, strengere TMR-Schwellen, Wortwahl, Begrüßung (README,
„Weniger Fehlalarme“; Messung in `training/EVAL_RESULTS.md`, „Fehlalarme auf Wikipedia“). Offen:

- **Kurze Absätze zusammen bewerten:** Absätze unter 120 Wörtern sind jetzt grün oder „unsicher“ –
  auf typischen Nachrichtenseiten der Großteil. Idee: benachbarte kurze Absätze
  desselben Artikels als ein Text bewerten (mehr Kontext senkt die Fehler stark, siehe „Textlänge“)
  und das Ergebnis allen zuordnen.
- **Default-Modell:** desklib als Empfehlung statt TMR? Genauer, aber 1,7 GB Download und ~1,3 s pro
  Absatz. Entscheidung nach Punkt 3 (breitere Eval) und Rückmeldungen zur Geschwindigkeit.
- **Spracherkennung auf echten Seiten prüfen:** Funktionswörter (en/de/fr/es/it/nl/pt) zuerst, dann
  die Browser-Erkennung `i18n.detectLanguage` (CLD3 in Chromium, CLD2 in Firefox), dann `lang`-Attribut.
  CLD3 irrt bei ungewöhnlichem Text auch „verlässlich“ (wiederholter englischer Testtext →
  Luxemburgisch) – deshalb nur als Lückenfüller. Offen: Quote auf echten Seiten, gemischte Absätze,
  Firefox tatsächlich testen (Extension läuft dort noch nicht, siehe Punkt 4).
  Alternativen, falls die Browser-API nicht reicht: `franc`/`franc-min` (Trigramme, MIT, schwach bei
  kurzem Text), `eld` (n-Gramme, schnell, ~1 MB), fastText `lid.176.ftz` (917 KB, sehr genau, bräuchte
  WASM-Laufzeit), Chromes `LanguageDetector` (Built-in-AI-API, nur neuere Chrome-Versionen).
- **Übersprungene Absätze sichtbar machen?** Bisher nur als Zahl im Popup. Falls Nutzer denken, die
  Seite sei nicht gescannt: dezente Markierung oder Hinweis beim ersten Mal.

## 3. Eval-Suite verbreitern

Bisher 100 Beispiele aus HC3 (fast nur Reddit-ELI5 gegen ChatGPT 2023). Schwellen stützen sich nur
darauf.

- **KI-Texte aktueller LLMs:** GPT-5, Claude, Gemini, Llama; auch nachbearbeitet.
- **Menschliche Texte aus mehreren Domänen:** News, Wikipedia, Foren, Fachtext, vor 2023
  veröffentlicht.
- **Nutzen:** Grundlage für Kalibrierung (Punkt 5), Default-Schwellen (Punkt 2) und das
  BYOM-Referenzset (Punkt 1).

## 4. Veröffentlichung (Chrome Web Store / Edge Add-ons)

- **Rechtliches:**
  - Kontakt in `extension/privacy.html` eintragen (Zeile 88, Platzhalter).
  - Datenschutzerklärung öffentlich hosten (z.B. GitHub Pages); der Store verlangt eine URL.
  - Impressum.
- **Berechtigungen begründen:**
  - `<all_urls>` im Content-Script.
  - Optionale Host-Rechte `https://*/*`.
  - `wasm-unsafe-eval`.
  - Prüfen, ob `tabs` nötig ist oder `activeTab` reicht.
- **Store-Angaben:**
  - Datenverarbeitung: Website-Inhalte, lokal verarbeitet.
  - Remote Code: transformers.js ist mitgeliefert, nachgeladen werden nur Modellgewichte
    (Daten). Das ausdrücklich hinschreiben.
- **Icons:** Das Manifest hat keine `icons`. Der Store verlangt 128 px (dazu 16/32/48 für die
  Toolbar). `npm run package` warnt, solange sie fehlen.
- **Store-Screenshots und Werbegrafik:** 1280×800 bzw. 440×280.
- **Lizenzen:**
  - CC-BY-SA-Angabe der Sperrliste und Drittkomponenten auch in der Store-Beschreibung.
  - In der Extension über „Über“ erreichbar.
- **Store-Auftritt:**
  - Screenshots.
  - Beschreibung mit ehrlichen Grenzen (nur Englisch, Fehlalarme möglich).
  - Entwicklerkonto: Chrome 5 $ einmalig, Edge kostenlos.
- **Firefox:** erstmal nicht. Die Offscreen-API fehlt dort; „Im Browser“ bräuchte eine andere
  Lösung.

## 5. Score-Kalibrierung pro Modell

- **Ziel:** Schwellen bedeuten modellübergreifend dasselbe.
- **Umsetzung:** In `bg/scoring.js` pro `modelKey` auf den Rohwert anwenden. Gespeichert werden
  Rohwerte, eine neue Kalibrierung braucht also kein Neu-Bewerten.
- **Datenbasis:** Eval-Suite aus Punkt 3.

## 6. Deutsch/mehrsprachig

- **Modell:** Fine-Tuning eines mehrsprachigen Encoders (mDeBERTa-v3/XLM-R), ähnlich desklib.
- **Extension:** Content-Script schickt `lang` pro Absatz mit, der Provider wählt das Modell.
- **Vorarbeit:** Laya-Datensatz liegt fertig (`training/data/`, 142k Beispiele), Training offen
  (`training/README.md`).

## 7. Berichte pro Seite exportieren/importieren

- **Inhalt:** URL, Absätze, Scores, Modell, Zeitpunkt – aus dem Ergebnis-Register.
- **Ausbaustufe:** Konto/Sync/Teilen, braucht Datenschutz/Einwilligung.

## 8. Feedback Stufe 2 (nur bei Bedarf)

Freiwilliger Upload an einen eigenen Sammel-Server. Braucht:

- Verantwortlichen/Impressum.
- Löschweg pro Einsender (Pseudonym-ID).
- Schutz gegen absichtlich falsche Labels (Data Poisoning).
- Erweiterte Datenschutzerklärung.

Fürs Training wichtiger sind generierte Daten mehrerer LLMs (`training/README.md`, „Feedback als
Datenquelle“).

## Technische Punkte (aus der v0.5-Analyse)

- **Batch-Budget pro Modell** (neben `maxInFlight` in `config.js`): Batches sind auf 2500 Zeichen
  begrenzt und werden vor dem Modell nach Länge aufgeteilt. Ein langer desklib-Absatz braucht im
  Browser trotzdem mehrere Sekunden; in der Zeit reagiert die Priorisierung nicht aufs Scrollen.
- **Gleichzeitige Anfragen** für denselben Absatz aus mehreren Tabs im Service Worker
  zusammenfassen.
- **Sperrliste UK:**
  - Stand: ~60 `.uk`-Domains aus UT1, 71 Banken aus Wikidata, dazu handverlesene Großbanken.
  - Vollständig wäre das FCA-Register (API mit kostenlosem Key, Weitergabebedingungen noch nicht
    geprüft).
- **Sperrliste DE:** Der BaFin-Export hat keine Websites.
- Lücken der Sperrliste fängt die Passwortfeld-Heuristik ab.
