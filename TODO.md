# TODO

Offene Punkte, Reihenfolge = Priorität. Erledigtes steht in der Roadmap in `DEVELOPMENT.md`.
Stand: 2026-09-26.

## 1. BYOM: Rest

Rahmen, „Modell prüfen“ und Hugging-Face-Metadaten sind erledigt (`DEVELOPMENT.md`, „Eigene Modelle prüfen“;
Vertrag in `server/README.md`). Offen:

- **Mit echtem Token testen:** 2–3 bekannte Detektor-Modelle über „Modell prüfen“ (Hub-Metadaten,
  Router-Antwortformen, KI-Label aus `id2label`). Bisher nur gemockt (`providers.test.mjs`,
  `model-check.test.mjs`).
- **Referenzset: aktuellere Generatoren.** Seit WP-11 HC3 + RAID-Wiki (114 Texte, kurz und lang). RAID
  hat im selben MIT-Split für „wiki“ auch GPT-4, ChatGPT und Cohere – bisher nicht aufgenommen, wäre
  eine kleine Erweiterung (`RAID_GENERATORS` in `training/build_reference_set.py`). Kurze Absätze
  kommen nur aus HC3 (RAID-Wiki liefert keine unter 120 Wörtern).
- **„Ausführliche Prüfung“ für eigene Modelle** (optional in den Einstellungen): „Modell prüfen“ nutzt
  jetzt 57 Mensch-Texte und schlägt mit genug kurzen Texten auch `shortRedFrom` vor – „keiner rot“
  heißt aber weiterhin nur Fehlalarme grob unter ~5 %. Für belastbare Schwellen einige hundert Absätze
  verschiedener Länge schicken (Methode `training/crossval_thresholds.py`). Dauert Minuten und kostet bei
  Cloud-Anbietern – nur auf Wunsch, mit Hinweis. Server können beides weiter über `/v1/info` angeben.
  Dazu UI: `reliableWords`/`shortRedFrom` sind für eigene Modelle nicht per Regler überschreibbar.
- **Später – eigenes ONNX im Browser:**
  - HF-Repo mit `onnx/` + Tokenizer.
  - Architektur aus fester Liste (BERT, RoBERTa, DeBERTa-v2, XLM-R, DistilBERT).
  - 2 Labels, Größenlimit.
  - Wäre ein weiterer Eintrag in `models.js`; „Modell prüfen“ ließe sich dafür wiederverwenden.

## 2. Fehlalarme reduzieren (Vertrauen)

Der größte Schaden ist Rot auf einem menschlichen Text.

Erledigt: Sprache pro Absatz, Stufe „unsicher“, strengere TMR-Schwellen, Wortwahl, Begrüßung (`DEVELOPMENT.md`,
„Weniger Fehlalarme“; Messung in `training/EVAL_RESULTS.md`, „Fehlalarme auf Wikipedia“). Offen:

- **Gruppierung auf Start- und Rubrikseiten prüfen:** Seit WP-10 werden auch Absätze mit 15–39 Wörtern
  gruppiert (`test/REAL_PAGES.md`: zu kurze Einheiten auf 32 Artikelseiten 95 % → 39 %, BBC jetzt
  abgedeckt). Gemessen wurden nur Artikelseiten. Risiko: Teaser-Raster und Linklisten als `<ul><li>`
  ohne Navigations-Semantik könnten zu Gruppen werden. Außerdem bleibt ein Artikel aus lauter
  isolierten kurzen Absätzen jetzt ganz unbewertet (früher wurde der Container bewertet).
- **fakespot im echten Browser prüfen:** Eingebunden als „Ausgewogen“ (`training/MODEL_SEARCH.md`,
  „ONNX-Abgleich und Einbindung“). Der Abgleich lief mit onnxruntime in Python; einzelne Texte weichen
  bis 0,52 ab, die Ampel an den Schwellen kaum (≤ 0,6 Prozentpunkte). Einmal in Chrome herunterladen und
  auf der Eval-Suite bzw. dem Harness gegen die Python-Scores vergleichen (WASM).
- **Weitere Kandidaten**, falls nötig: `ShantanuT01/gradient-ai-text-detector` (MIT, DeBERTa-v3-large,
  ONNX int4 408 MB, ungeprüft).
- **Spracherkennung in Firefox prüfen:** In Chromium auf echten Seiten sauber (`test/REAL_PAGES.md`:
  kein falsch übersprungener englischer Absatz, alle Absätze der 6 nicht-englischen Nachrichtenartikel
  übersprungen, fremdsprachige Zitate korrekt pro Absatz). Offen: Firefox (CLD2), sobald die Extension
  dort läuft (Punkt 4). Alternativen, falls nötig: `franc`/`franc-min`, `eld`, fastText `lid.176.ftz`,
  Chromes `LanguageDetector`.
- **Übersprungene Absätze sichtbar machen?** Bisher nur als Zahl im Popup. Falls Nutzer denken, die
  Seite sei nicht gescannt: dezente Markierung oder Hinweis beim ersten Mal.

## 3. Eval-Suite: Rest

Erledigt: 1200 Texte, 6 Domänen, 7 Generatoren bis GPT-4o (`training/EVAL_RESULTS.md`, „Breitere
Eval-Suite“), desklib auf allen 1200 Texten und kreuzvalidierte Schwellen („Schwellen absichern“).
Wie angezeigt: TMR 4,7 % Fehlalarme (ohne WikiHow 1,6 %), desklib 1,2 % mit `redFrom` 0.94. Offen:

- **TMR auf Anleitungen:** 20 % der menschlichen WikiHow-Texte werden rot (alle ≥ 120 Wörter). Auf
  echten Anleitungsseiten nachprüfen; Optionen: `redFrom` ~0.985 (kostet Erkennung überall), oder
  desklib als Default (Punkt 2).
- **Claude/Gemini/GPT-5 fehlen:** kein öffentlicher gelabelter Datensatz gefunden. Eigene Generierung
  bräuchte API-Keys (einige hundert Absätze zu den Themen der Mensch-Texte).
- **TMR auf echten Anleitungsseiten messen:** 20 % Fehlalarme auf WikiHow-Text am Stück; ob die
  Extension das auf gerenderten Seiten (Listen, Zwischenüberschriften, `MIN_WORDS`) genauso sieht, ist
  offen (`training/EVAL_RESULTS.md`, „Schwellen absichern“). Mit desklib als Standard weniger dringend.
- **Lizenz:** M4GT-Bench ohne Lizenzangabe – die Suite nur lokal nutzen, nicht als BYOM-Referenzset
  mitliefern (Punkt 1); dafür MAGE-/HC3-Anteile (Apache-2.0) auswählen.

## 4. Veröffentlichung (Chrome Web Store / Edge Add-ons)

Erledigt: Icons, „Über / Lizenzen“, Store-Texte und Begründung der Berechtigungen (`store/`).
Offen (Details und Reihenfolge in `store/CHECKLIST.md`):

- **Rechtliches (braucht Nutzerangaben):**
  - Kontakt in `extension/privacy.html` eintragen (Zeile 88, Platzhalter; `npm run package` warnt).
  - Datenschutzerklärung öffentlich hosten (z.B. GitHub Pages); der Store verlangt eine URL.
  - Impressum.
- **Screenshots mit echtem Modell** auf einer echten Seite neu machen; die aktuellen stammen aus dem
  Harness mit Fake-Scores. Werbekachel ist nur ein Platzhalter.
- **Entwicklerkonten:** Chrome 5 $ einmalig, Edge kostenlos.
- **Firefox:** erstmal nicht. Die Offscreen-API fehlt dort; „Im Browser“ bräuchte eine andere
  Lösung.

## 5. Score-Kalibrierung pro Modell

- **Ziel:** Schwellen bedeuten modellübergreifend dasselbe.
- **Umsetzung:** In `bg/scoring.js` pro `modelKey` auf den Rohwert anwenden. Gespeichert werden
  Rohwerte, eine neue Kalibrierung braucht also kein Neu-Bewerten.
- **Datenbasis:** Eval-Suite aus Punkt 3 (`training/evaluate_suite.py`, Rohscores in
  `training/data/eval_scores_*_suite.jsonl`), kreuzvalidierte Spannen per `training/crossval_thresholds.py`.

## 6. Deutsch/mehrsprachig

- **Modell:** Fine-Tuning eines mehrsprachigen Encoders (mDeBERTa-v3/XLM-R), ähnlich desklib.
- **Extension:** `lang` pro Absatz wird schon erkannt und an Server-Backends mitgeschickt; offen ist,
  dass der Provider danach das Modell wählt (statt andere Sprachen zu überspringen).
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
- **Sperrliste UK:**
  - Stand: ~60 `.uk`-Domains aus UT1, 71 Banken aus Wikidata, dazu handverlesene Großbanken.
  - Vollständig wäre das FCA-Register (API mit kostenlosem Key, Weitergabebedingungen noch nicht
    geprüft).
- **Sperrliste DE:** Der BaFin-Export hat keine Websites.
- Lücken der Sperrliste fängt die Passwortfeld-Heuristik ab.
