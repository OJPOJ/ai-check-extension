# Fine-Tuning (Phase D — pausiert, Datensatz liegt bereit)

**Status 2026-09-23: zurückgestellt.** Die Extension nutzt aktuell zwei bereits fertig
trainierte Backends (TMR "low", desklib "medium" — siehe `EVAL_RESULTS.md` und
`../extension/options.html`), die ohne eigenes Training brauchbare Ergebnisse liefern.
Laya-Fine-Tuning bleibt trotzdem vorbereitet: Datensatz fertig, Anleitung unten aktuell.
**Sobald ein fine-getunter Laya-Checkpoint existiert, noch mal gegen `eval_sample.jsonl`
laufen lassen und mit TMR/desklib vergleichen** (`evaluate_backends.py --backend laya`,
dann `model` in `server/shim_server.py`s `LAYA_MODELS` bzw. den Checkpoint-Namen anpassen).

Ursprüngliches Ziel: den Zero-Shot-Baseline-Checkpoint (`laya-english`) auf einer
Human-vs-KI-Text-Klassifikationsaufgabe spezialisieren, weil Laya laut eigener Doku
zero-shot nahe Zufallsniveau liegt — bestätigt durch unseren eigenen Test:
AUROC 0.549 auf 100 balancierten Beispielen, siehe `EVAL_RESULTS.md`.

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
Die Ladezelle ist inzwischen **wortwörtlich verifiziert** (per Raw-Fetch der
`.ipynb`-JSON-Quelle, nicht nur zusammengefasst), Stand 2026-09-23:

**Wichtiger, gerade erst verifizierter Fund:** Die Referenz-Zelle lädt
`LocalLLaMA/typed-decisions` und verarbeitet dort **nur 1.200 Fälle** (nicht ~30k, wie
hier vorher unverifiziert stand). Unser Datensatz mit 128.581 Zeilen ist also ~100×
größer als alles, was dieses Notebook je gesehen hat — für den ersten Lauf unbedingt
begrenzen (Punkt 3 unten), sonst sehr wahrscheinlich Kaggle-Zeitlimit (9–12h/Session)
gesprengt.

1. Notebook `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb` aus
   https://github.com/NandhaKishorM/laya auf Kaggle hochladen (oder als Kaggle-
   Notebook forken, falls dort schon veröffentlicht).
2. `data/train.jsonl` + `data/holdout.jsonl` als **privates Kaggle-Dataset** hochladen
   (kaggle.com → "New Dataset" → beide Dateien reinziehen). Danach steht der Pfad als
   `/kaggle/input/<dein-dataset-slug>/train.jsonl` etc. zur Verfügung — kein HF-Token
   nötig für diesen Schritt.
3. In der 3. Code-Zelle des Notebooks (verifizierter Originalinhalt, lädt Tokenizer/
   Config von `convaiinnovations/laya` und danach `ds_train`) **nur diese eine Zeile**
   ersetzen:

   ```python
   # Original:
   ds_train = load_dataset("LocalLLaMA/typed-decisions", "all", split="train")

   # Ersatz — Slug anpassen, Rest der Zelle (build_training_item, tokenizer, ...) bleibt unveraendert:
   ds = load_dataset(
       "json",
       data_files={
           "train": "/kaggle/input/<dein-dataset-slug>/train.jsonl",
           "test": "/kaggle/input/<dein-dataset-slug>/holdout.jsonl",
       },
   )
   ds_train = ds["train"].shuffle(seed=42).select(range(20000))  # erster Lauf begrenzt, s.o.
   ```

   Das Schema passt 1:1 zum Rest der Zelle (`json.loads(row["state"])`,
   `row["questions"]`, `row["gold"]` — exakt verifiziert, keine weitere Anpassung an
   `build_training_item` nötig, weil unsere `noul`-Fragen ohne `criteria`-Feld genau
   in den `crit = q.get("criteria", {})`-Default fallen).
4. 2× T4 GPU-Runtime aktivieren, restliche Zellen (DDP-Trainingsskript schreiben,
   `torchrun --standalone --nproc_per_node=2 train_ddp.py`) unverändert laufen lassen.
   Läuft der erste 20k-Lauf sauber und im Zeitrahmen durch: schrittweise erhöhen
   (z. B. 50k, dann Rest) statt direkt auf die vollen 128k zu gehen.
5. Die spätere Evaluations-/Upload-Zellen im Notebook (Testset-Auswertung, Push zu
   `convaiinnovations/laya-typed-decisions`) **nicht 1:1 übernehmen** — `NEW_REPO`
   dort auf ein eigenes HF-Repo umstellen, sonst landet der Checkpoint im fremden
   Account. Für die eigentliche Bewertung reicht ohnehin unsere eigene Pipeline
   (Punkt darunter), die ist gegen `holdout.jsonl`/`eval_sample.jsonl` bereits fertig.
6. Checkpoint auf ein eigenes Hugging-Face-Repo pushen (Notebook-Zelle 8, `NEW_REPO`
   entsprechend setzen).

## Danach (Phase E, siehe Plan)

- Checkpoint in `laya-serve` einbinden (`LAYA_MODELS` erweitern, siehe
  `../server/README.md`), Extension-Option "Modell" auf den neuen Namen umstellen.
- Genauigkeit auf `holdout.jsonl` gegen die Zero-Shot-Baseline vergleichen
  (Baseline: faktisch keine Trennschärfe, siehe oben).
- Schwellenwert in `extension/options.html` anhand der echten Kalibrierung neu setzen.
