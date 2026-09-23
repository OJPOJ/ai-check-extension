# Fine-Tuning (Phase D — Datensatz fertig, Training noch offen)

Ziel: den Zero-Shot-Baseline-Checkpoint (`laya-english`) auf einer Human-vs-KI-Text-
Klassifikationsaufgabe spezialisieren, weil Laya laut eigener Doku zero-shot nahe
Zufallsniveau liegt (siehe `../RESOURCES.md`, dort auch der verifizierte Beleg dafür
in `../server/README.md`: KI- und menschlicher Testtext ergaben beide ~0.0–0.5 ohne
Trennschärfe).

## Stand: `prepare_dataset.py` ✅ geschrieben, getestet, mit echten Daten verifiziert

```
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements.txt
.venv/Scripts/python.exe prepare_dataset.py --out-dir data
```

Ergebnis beim letzten Lauf (2026-09-23): **142.868 Beispiele** (89.878 human, 52.990 KI,
Filter `MIN_WORDS=40`) → **128.581 train / 14.287 holdout** in `data/train.jsonl` und
`data/holdout.jsonl`. Schema pro Zeile (verifiziert gegen das, was das Kaggle-Notebook
laut eigener Doku erwartet — `json.loads(row["state"])` etc.):

```json
{"state": "{\"candidates\": [{\"text\": \"...\"}]}",
 "questions": "{\"ai_generated\": {\"type\": \"noul\", \"instructions\": \"...\"}}",
 "gold": "{\"ai_generated\": {\"probabilities\": {\"true\": 0.95, \"false\": 0.05}}}"}
```

Weiche Labels (0.95/0.05 statt hart 1.0/0.0), passend zum RLCD/proper-scoring-rule-
Training des Notebooks.

### Bekannte Einschränkungen des Datensatzes (bitte vor dem Training beachten)

- **Klassen-Ungleichgewicht** ~63% human / 37% KI (HC3 hat pro Frage oft mehrere
  human_answers, aber nur einen chatgpt_answer). Ggf. beim Training gewichten oder
  auf Balance downsamplen.
- **Tokenisierungs-Artefakte im `reddit_eli5`-Teil**: menschliche Antworten haben dort
  Leerzeichen vor Satzzeichen (`" . "`, `"1 )"`), ein Artefakt der Original-ELI5-
  Quelle. Risiko: das Modell lernt "Leerzeichen vor Punkt = menschlich" als Shortcut
  statt echter Stilmerkmale — das würde auf echten Webseiten (ohne dieses Artefakt)
  nicht greifen. Nicht behoben, weil eine Normalisierung selbst wieder Stilsignal
  verfälschen könnte — vor dem echten Training gegenprüfen (z.B. Anteil an
  Trainingsfehlern nach Domäne aufschlüsseln).
- **Nur HC3, kein RAID.** RAID (https://huggingface.co/datasets/liamdugan/raid, >8 Mio.
  Zeilen, adversariale Paraphrasierungen) sollte perspektivisch die Robustheit gegen
  umformulierten KI-Text verbessern, ist hier aber bewusst nicht implementiert: das
  exakte Feld für "das ist der menschliche Ausgangstext" wurde nur aus der Dataset-
  Card gelesen, nicht an echten Zeilen verifiziert (siehe `../RESOURCES.md`,
  "Offene Fragen"). Vor Einbau: `load_dataset("liamdugan/raid", split="train", streaming=True)`
  und ein paar Zeilen manuell ansehen.

## Offener Schritt: das eigentliche Training auf Kaggle

Das kann ich von hier aus nicht ausführen — es braucht einen Kaggle-Account, eine
Browser-Session und laufende GPU-Kontingente, alles außerhalb dieser Umgebung.
Konkrete Schritte für dich:

1. Notebook `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb` aus
   https://github.com/NandhaKishorM/laya auf Kaggle hochladen (oder als Kaggle-
   Notebook forken, falls dort schon veröffentlicht).
2. Die Zelle(n), die `LocalLLaMA/typed-decisions` von Hugging Face laden, durch
   unsere Daten ersetzen — entweder:
   - `data/train.jsonl` + `data/holdout.jsonl` als Kaggle-Dataset hochladen und lokal
     laden (`load_dataset("json", data_files={"train": "...", "test": "..."})`), oder
   - die beiden Dateien als eigenes Hugging-Face-Dataset-Repo pushen und den
     `load_dataset(...)`-Aufruf auf den eigenen Repo-Namen umstellen.
   Ich habe das Notebook nur als Zusammenfassung gesehen (nicht Zelle für Zelle), das
   musst du beim Öffnen gegenprüfen — meld dich mit dem, was du siehst, dann passen
   wir die Zelle gemeinsam an.
3. 2x T4 GPU-Runtime aktivieren, `torchrun --nproc_per_node=2` laut Notebook laufen
   lassen. Bei ~130k Trainingsbeispielen (vs. ~30k im Notebook-Referenzbeispiel für
   4–5h) realistisch mit mehr Zeit rechnen — ggf. für den ersten Lauf mit
   `--limit 30000` in `prepare_dataset.py` auf eine kleinere, näher am Referenzwert
   liegende Menge gehen.
4. Temperatur-Kalibrierung auf `holdout.jsonl` (nicht auf Trainingsdaten).
5. Checkpoint auf Hugging Face pushen.

## Danach (Phase E, siehe Plan)

- Checkpoint in `laya-serve` einbinden (`LAYA_MODELS` erweitern, siehe
  `../server/README.md`), Extension-Option "Modell" auf den neuen Namen umstellen.
- Genauigkeit auf `holdout.jsonl` gegen die Zero-Shot-Baseline vergleichen
  (Baseline: faktisch keine Trennschärfe, siehe oben).
- Schwellenwert in `extension/options.html` anhand der echten Kalibrierung neu setzen.
