# Backend-Vergleich: Laya (Zero-Shot) vs. TMR

Stand: 2026-09-23. 100 balancierte Beispiele (50 human / 50 KI) aus dem HC3-Holdout-Split
(`data/holdout.jsonl`, Domäne größtenteils `reddit_eli5` — informeller, umgangssprachlicher
Text). Reproduzierbar mit `evaluate_backends.py` (Sample in `eval_sample.jsonl`,
Rohdaten in `eval_scores_<backend>.jsonl`).

| Backend | Accuracy@0.5 | AUROC | Beste Schwelle | Accuracy@beste Schwelle |
|---|---|---|---|---|
| Laya (`english`, zero-shot) | 0.510 | **0.549** | 0.74 | 0.570 (kaum besser) |
| TMR (`Oxidane/tmr-ai-text-detector`) | 0.550 | **0.911** | 0.98 | **0.830** |

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
