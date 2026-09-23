# Backend-Vergleich: Laya (Zero-Shot) vs. TMR vs. desklib

Stand: 2026-09-23. Genauigkeit: 100 balancierte Beispiele (50 human / 50 KI) aus dem
HC3-Holdout-Split (`data/holdout.jsonl`, Domäne größtenteils `reddit_eli5` — informeller,
umgangssprachlicher Text). Latenz/Speicher: `benchmark_latency.py`, CPU (kein GPU-Test),
Batch-Größen an `extension/content.js` angelehnt (BATCH_SIZE=25). Reproduzierbar mit
`evaluate_backends.py` (Sample in `eval_sample.jsonl`, Rohdaten in `eval_scores_<backend>.jsonl`).

| Backend | Accuracy@0.5 | AUROC | Accuracy@beste Schwelle | ms/Text (Batch=25) | Batch=25 gesamt | RAM geladen |
|---|---|---|---|---|---|---|
| Laya (`english`, zero-shot) | 0.510 | 0.549 | 0.570 (Schwelle 0.74) | ~2458ms | ~61s | ~2.1 GB (Docker) |
| **TMR** (RoBERTa-base, 125M) | 0.550 | **0.911** | **0.830** (Schwelle 0.98) | **~62ms** | **~1.6s** | **~900 MB** |
| **desklib** (DeBERTa-v3-large, 430M) | **0.960** | **0.998** | **0.990** (Schwelle 0.87) | ~4869ms | ~122s | ~4.65 GB |

## Performance-Abwägung (wichtig für "läuft im Hintergrund mit")

**desklib ist mit Abstand am genauesten (AUROC 0.998, nur 1 Fehler von 100 bei optimaler
Schwelle), aber auf CPU ~80× langsamer als TMR und braucht ~5× mehr RAM.** Ein normaler
Seitenscan mit 25 Kandidaten (die Batch-Größe, die `content.js` tatsächlich verwendet)
würde mit desklib **rund 2 Minuten** dauern und zeitweise **4,65 GB RAM** belegen — das
verträgt sich nicht mit der Anforderung "läuft im Hintergrund mit, ohne den Rechner spürbar
zu bremsen". TMR schafft denselben Batch in **~1,6 Sekunden** bei **~900 MB**.

Alle Zahlen sind CPU-only gemessen (kein GPU auf dieser Maschine getestet) — mit CUDA-GPU
wären alle drei Backends deutlich schneller, das Verhältnis zueinander bliebe aber ähnlich.

**Bug/Kompatibilitäts-Fund unterwegs:** desklibs eigener Beispielcode (Model Card, 2024)
crasht beim Laden mit `transformers>=5` (`AttributeError: ... 'all_tied_weights_keys'`) —
gefixt durch eine überschriebene Property (leeres Dict), siehe `evaluate_backends.py` und
`../server/shim_server.py`. Ein konkreter Beleg dafür, dass 2024er-Modellcode ohne Anpassung
nicht mehr mit aktueller Software läuft.

## Interpretation

- **Laya zero-shot hat kein brauchbares Signal.** AUROC 0.549 heißt: kaum besser als
  Münzwurf, egal welche Schwelle man wählt. Deckt sich mit der Doku-Warnung
  ("treat Laya as a fast base to specialise, not as a zero-shot decision engine") und dem
  frühen manuellen Test in `../server/README.md`. Ohne eigenes Fine-Tuning (Phase D) bleibt
  Laya für diese Aufgabe unbrauchbar.

- **TMR trennt gut (AUROC 0.911), war aber bei Schwelle 0.5 falsch kalibriert für diese
  Textdomäne:** bei 0.5 hat es 45 von 50 menschlichen Reddit-Style-Texten fälschlich als
  KI markiert (Score-Mittelwert insgesamt 0.893 — systematisch zu hoch für diese Domäne).
  Mit einer auf dieses Sample optimierten Schwelle (0.98) steigt die Accuracy auf 0.830
  (TP=41, FP=8, FN=9, TN=42) — deutlich brauchbar, wenn auch nicht perfekt.

## Schlussfolgerung für die Extension

- TMR ist Laya-Zero-Shot klar überlegen und sollte das Default-Backend werden.
- Der Default-Schwellenwert in der Extension darf NICHT 0.5 sein — 0.90–0.95 ist ein
  realistischerer Startpunkt für informellen/kurzen Text, muss aber pro Domäne (Artikel vs.
  Forenpost vs. Produktbewertung) unterschiedlich gut passen. Sollte in den Optionen
  weiterhin frei einstellbar bleiben.
- 100 Beispiele aus einer Domäne sind eine grobe Schätzung, keine belastbare Kalibrierung.
  Vor einem "fertig"-Gefühl lohnt sich ein größerer/diverserer Eval-Lauf (mehr HC3-Domänen,
  ggf. RAID-Sample) — als Folgeschritt vorgemerkt, nicht Teil dieses Laufs.
