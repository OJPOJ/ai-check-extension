# WP-06 · Weiteres Modell zwischen TMR und desklib finden (TODO Punkt 2)

## Ziel
desklib ist jetzt Standard: genau (Fehlalarme wie angezeigt ~1 %, AUROC 0.990 auf der Eval-Suite), aber
1,7 GB Download (im Browser auf ~475 MB umgewandelt) und ~1,3–2,3 s pro Absatz auf CPU. TMR ist schnell
(126 MB, ~0,15 s), aber ~5 % Fehlalarme (20 % auf Anleitungen). Gesucht: ein Detektor mit
desklib-ähnlicher Qualität und deutlich weniger Download/Rechenzeit, der sich im Browser betreiben lässt.

## Umfang
1. **Recherche** (Hugging Face, Papers, Leaderboards wie RAID): 5–10 Kandidaten für englische
   KI-Text-Erkennung, Sequenzklassifikation mit Encoder (DeBERTa-v3-small/-base/-xsmall, ModernBERT,
   RoBERTa, DistilRoBERTa, ELECTRA …). Kriterien: offene Lizenz (MIT/Apache/CC-BY, keine
   Nicht-kommerziell-Klausel), Größe (Ziel < 500 MB, ideal < 200 MB), öffentlich ohne Gate, Trainingsdaten
   mit aktuellen Generatoren, ONNX verfügbar oder mit transformers.js-kompatibler Architektur umwandelbar.
   Architekturen, die transformers.js unterstützt, vorher prüfen.
2. **Messen** der 2–4 vielversprechendsten auf der Eval-Suite
   (`C:/_programme/DS/aivsai/training/data/eval_suite.jsonl`, 1200 Texte) mit derselben Methodik wie
   `training/evaluate_suite.py` (erweitern oder analog, z.B. `--backend hf:<repo>`): AUROC, Fehlalarme und
   Erkennung **wie angezeigt** (Regel 9 in `orchestration/README.md`: unter 120 Wörtern nur mit eigener
   Kurz-Schwelle rot), je Domäne und Generator, dazu eine 1-%-Fehlalarm-Schwelle für ≥ 120 Wörter.
   PyTorch auf CPU genügt; ggf. Stichprobe (stratifiziert wie bei desklib).
3. **Latenz** pro Absatz (CPU, PyTorch; wenn ONNX vorhanden auch onnxruntime) und Downloadgröße.
   Achtung: Parallel läuft WP-07 mit desklib auf derselben CPU. Latenz erst messen, wenn kein anderer
   Python-Prozess rechnet (`tasklist | grep -i python`), und das im Ergebnis vermerken.
4. **Ergebnis** in einer neuen Datei `training/MODEL_SEARCH.md`: Kandidatentabelle (Repo, Lizenz,
   Größe, Architektur, ONNX ja/nein, Trainingsdaten), Messtabelle im Vergleich zu TMR und desklib
   (Zahlen aus `EVAL_RESULTS.md`, Abschnitt „Breitere Eval-Suite“ inkl. „Korrektur“), klare Empfehlung:
   welches Modell als dritter Eintrag in `extension/models.js`, mit welchen Schwellen
   (`thresholds`, `reliableWords`, `shortRedFrom`), und was für die Einbindung im Browser nötig ist
   (fertiges ONNX wie TMR oder Umwandlung wie desklib, `desklib_build.js`).

## Erlaubte Dateien
`training/**`, aber **nicht** `training/EVAL_RESULTS.md` (gehört in dieser Runde WP-07) – eigene
Ergebnisse in `training/MODEL_SEARCH.md`. Keine Extension-Dateien; die Einbindung ist ein eigenes WP.
Große Downloads nach `C:/_programme/DS/aivsai/training/data/` bzw. in den HF-Cache, insgesamt < ~5 GB.

## Abnahme
- Mindestens 2 Kandidaten echt gemessen, Rohscores als JSONL unter `training/data/` (gitignored).
- Empfehlung mit Begründung; wenn kein Kandidat taugt, das klar sagen und warum.
