# WP-01 · Eval-Suite verbreitern (TODO Punkt 3)

## Ziel
Eine reproduzierbare, breitere Eval-Suite, auf die sich Schwellen, Default-Modell-Entscheidung,
Kalibrierung (Punkt 5) und das BYOM-Referenzset (Punkt 1) stützen können. Bisher: 100 HC3-Beispiele
(Reddit-ELI5 vs. ChatGPT 2023) plus Wikipedia-Fehlalarm-Messung (`training/EVAL_RESULTS.md`).

## Umfang
1. **Daten sammeln** (`training/build_eval_suite.py`): öffentlich verfügbare Datensätze, keine API-Keys.
   - Mensch, mehrere Domänen, vor 2023 veröffentlicht: z.B. News, Wikipedia, Foren, wissenschaftliche
     Abstracts, Rezensionen.
   - KI aus möglichst aktuellen Modellen (GPT-4-Klasse und neuer, Claude, Gemini, Llama, Mistral …),
     auch nachbearbeitet/paraphrasiert, falls verfügbar. Geeignete HF-Datensätze recherchieren
     (Kandidaten: RAID, MAGE, M4/M4GT, …) – Lizenzen prüfen und dokumentieren.
   - Englisch (die Extension bewertet nur Englisch). Absätze in realistischen Längen
     (ca. 40–400 Wörter), Längen-Buckets wie in `extension/length-buckets.js`.
   - Zielgröße: grob 1000–2000 Texte, balanciert nach Domäne × Quelle; fester Seed; Ausgabe als JSONL
     (`text, label, domain, generator, source, words`) nach
     `C:/_programme/DS/aivsai/training/data/eval_suite.jsonl` (gitignored).
     Downloads klein halten (Streaming/Teil-Splits), insgesamt < ~3 GB.
2. **Bewerten** (`training/evaluate_suite.py`, bestehende Skripte wiederverwenden, z.B.
   `evaluate_backends.py`, `evaluate_false_alarms.py`): TMR und desklib lokal (CPU). desklib ist langsam
   (~1–5 s/Text) – Teilmenge ok, im Hintergrund laufen lassen. Rohscores als JSONL speichern (gitignored).
3. **Auswerten:** pro Modell AUROC, Fehlalarmrate bei den aktuellen Schwellen (`extension/models.js`,
   `extension/config.js` lesen, nicht ändern), aufgeschlüsselt nach Domäne, Generator und Längen-Bucket.
   Außerdem: Welche Schwellen ergäben auf dieser Suite ~1 % Fehlalarme?
4. **Dokumentieren:** neuer Abschnitt in `training/EVAL_RESULTS.md` (Datum, Datenquellen + Lizenzen,
   Tabellen, Interpretation, Empfehlung zu Schwellen und Default-Modell). Kurz in `training/README.md`,
   wie man die Suite baut und laufen lässt.

## Erlaubte Dateien
`training/**` (neue Skripte, `EVAL_RESULTS.md`, `README.md`, `requirements.txt`). Keine Extension-Dateien.

## Abnahme
- Skripte laufen mit `C:/_programme/DS/aivsai/training/.venv/Scripts/python.exe` durch (fehlende Pakete
  in die venv installieren und in `requirements.txt` eintragen).
- Ergebnis-Abschnitt mit echten Zahlen. Falls desklib auf der ganzen Suite zu lange dauert: Teilmenge,
  im Bericht angeben.
- Bericht enthält konkrete Schwellen-Empfehlung pro Modell und ob desklib Default werden sollte.
