# TODO

Offene Punkte, Reihenfolge = Priorität. Erledigtes steht in der Roadmap im `README.md`.
Stand: 2026-09-26.

## 1. BYOM: Rest

Rahmen, „Modell prüfen“ und Hugging-Face-Metadaten sind erledigt (README, „Eigene Modelle prüfen“;
Vertrag in `server/README.md`). Offen:

- **Mit echtem Token testen:** 2–3 bekannte Detektor-Modelle über „Modell prüfen“ (Hub-Metadaten,
  Router-Antwortformen, KI-Label aus `id2label`). Bisher nur gemockt (`providers.test.mjs`,
  `model-check.test.mjs`).
- **Referenzset verbreitern**, sobald die Eval-Suite (Punkt 3) steht: bisher nur HC3 (ChatGPT 2023).
- **„Ausführliche Prüfung“ für eigene Modelle** (nach Punkt 3, optional in den Einstellungen): Die
  Ampel-Schwellen aus „Modell prüfen“ stützen sich auf 20 Mensch-Texte – „keiner rot“ heißt nur
  Fehlalarme grob unter 5–15 %, und kurze Absätze deckt das Set gar nicht ab (70–200 Wörter). Stattdessen
  einige hundert Absätze verschiedener Länge (Wikipedia-Mensch + KI) schicken und daraus Rot-Schwelle,
  `reliableWords` und `shortRedFrom` ableiten, wie für desklib (`training/EVAL_RESULTS.md`, „Konfidenz
  für kurze Absätze“). Dauert Minuten und kostet bei Cloud-Anbietern – nur auf Wunsch, mit Hinweis.
  Bis dahin kann ein Server beides über `/v1/info` angeben; Hugging-Face-Modelle bekommen den Standard.
- **Später – eigenes ONNX im Browser:**
  - HF-Repo mit `onnx/` + Tokenizer.
  - Architektur aus fester Liste (BERT, RoBERTa, DeBERTa-v2, XLM-R, DistilBERT).
  - 2 Labels, Größenlimit.
  - Wäre ein weiterer Eintrag in `models.js`; „Modell prüfen“ ließe sich dafür wiederverwenden.

## 2. Fehlalarme reduzieren (Vertrauen)

Der größte Schaden ist Rot auf einem menschlichen Text.

Erledigt: Sprache pro Absatz, Stufe „unsicher“, strengere TMR-Schwellen, Wortwahl, Begrüßung (README,
„Weniger Fehlalarme“; Messung in `training/EVAL_RESULTS.md`, „Fehlalarme auf Wikipedia“). Offen:

- **Sehr kurze Absätze erreichen die Gruppierung nicht:** Gemessen auf 29 echten Seiten
  (`test/REAL_PAGES.md`): Die Gruppierung senkt den Anteil zu kurzer Bewertungseinheiten bei
  Nachrichtenartikeln von 61 % auf 40 %, bei Wikipedia von 88 % auf 35 %. Eine lockerere Regel
  (gemeinsamer Vorfahr statt Elternelement) ändert auf Nachrichtenartikeln nichts. Engpass ist
  `MIN_WORDS` = 40 in `content.js`: Seiten mit sehr kurzen Absätzen (BBC: 7–38 Wörter) liefern keine
  Einzelkandidaten, sondern höchstens den ganzen Artikel-Container. Idee: Absätze ab ~15 Wörtern als
  Kandidaten zulassen, wenn sie gruppiert werden und die Gruppe `MIN_WORDS` erreicht; einzeln bleiben
  sie aus. Danach `npm run measure:pages` erneut. Offen außerdem: gemischte Gruppen (ein KI-Absatz
  zwischen menschlichen), nachgeladene Absätze werden nicht mit schon bewerteten gruppiert.
- **Drittes Modell einbinden: fakespot** (`training/MODEL_SEARCH.md`): `fakespot-ai/roberta-base-ai-text-
  detection-v1`, Apache-2.0, RoBERTa-base wie TMR (125 MB, ~45 ms/Text). Auf der Eval-Suite AUROC 0,964
  (TMR 0,929, desklib 0,991); ≥ 120 Wörter bei ~1 % Fehlalarmen 90 % erkannt (TMR 62 %, desklib 97 %),
  Anleitungen AUROC 0,955 statt 0,767. Vor der Einbindung:
  - Fertiges ONNX eines Dritten (`MedAliFarhat/ai-text-detector-onnx`, int8, Revision pinnen) gegen das
    PyTorch-Original abgleichen – gemessen wurde nur das Original.
  - Schwellen kreuzvalidieren (`training/crossval_thresholds.py`). Die Scores ballen sich nahe 1:
    Fehlalarme ≥ 120 Wörter 3,5 % bei 0.99, 0,9 % bei 0.999, 0,2 % bei 0.9995. Ggf. Logit statt
    Wahrscheinlichkeit auswerten, damit die Schwelle nicht an der vierten Nachkommastelle hängt.
  - Dann als Eintrag „Ausgewogen“ in `models.js` wie TMR (fertiges ONNX, kein Umbau wie desklib).
  Weitere Kandidaten, falls fakespot nicht trägt: `ShantanuT01/gradient-ai-text-detector` (MIT,
  DeBERTa-v3-large, ONNX int4 408 MB, ungeprüft).
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
