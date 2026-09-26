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

## Textlänge: mehr Kontext statt Chunks (2026-09-25)

Frage: Der Auto-Scan schickte nur die ersten 500 Zeichen pro Absatz. Lohnt mehr Text, und helfen
Chunks mit Überlappung? Gleiche HC3-Texte mit ≥ 1500 Zeichen, Mensch/KI balanciert, CPU (PyTorch).
Reproduzierbar mit `evaluate_length.py`.

TMR, n = 400, `--normalize` (Leerzeichen vor Satzzeichen aus ELI5 entfernt, sonst misst man
teils dieses Artefakt):

| Variante | AUROC | Acc@beste Schwelle | Durchläufe/Text | s/Text |
|---|---|---|---|---|
| A erste 500 Zeichen | 0.966 | 0.910 | 1 | 0.20 |
| **B erste 1500 Zeichen am Stück** | **0.999** | **0.993** | 1 | 0.43 |
| C 500er-Chunks, 100 Überlappung, Mittelwert | 0.972 | 0.917 | 4 | 0.55 |
| D 500er-Chunks ohne Überlappung, Mittelwert | 0.979 | 0.938 | 3 | 0.37 |

Ohne `--normalize` dasselbe Bild (A 0.940 → B 0.993). desklib (n = 80, ohne `--normalize`): A 0.994,
B/C/D je 1.000 – auf HC3 zu leicht, um die Varianten zu unterscheiden; Rechenzeit 0.58 → 2.3 s/Text.

- Ein langer Durchlauf schlägt Chunks deutlich: Das Modell nutzt den Zusammenhang, der Mittelwert
  über Stücke ersetzt ihn nicht. Überlappung bringt nichts.
- Konsequenz in `content.js`: Auto-Scan und manuelle Prüfung senden bis 2000 Zeichen (≈ 512 Tokens,
  mehr sieht das Modell nicht), gekürzt am Satzende; Batches nach Textmenge (≤ 2500 Zeichen).
- Chunking erst sinnvoll über 512 Tokens hinaus (ganze Artikel) oder um in gemischten Texten die
  KI-Stellen einzugrenzen.
- Einschränkungen: nur HC3/Englisch, nur lange Texte; beide Modelle kennen HC3 womöglich aus dem
  Training → absolute Werte zu optimistisch, der Vergleich der Varianten (gleiche Texte) hält.

## Auffüllen: Batches nach Länge aufteilen (2026-09-25)

Ein Batch wird auf den längsten Text aufgefüllt (bzw. in `evaluate_backends.py` bisher immer auf
768 Tokens). Typischer Scan-Batch: ein langer Absatz (654 Tokens) + vier kurze (~70 Tokens),
Server-Code (`shim_server.py`), CPU:

| Modell | alles zusammen aufgefüllt | nach Länge gruppiert | max. Score-Abweichung |
|---|---|---|---|
| desklib | 16,6 s | 4,4 s | 0 |
| TMR | 1,7 s | 0,6 s | 0 |

Scores identisch, weil Füll-Tokens ausmaskiert werden (desklib: Mean-Pooling mit Maske, TMR:
Attention-Maske). Umgesetzt in `extension/length-buckets.js` (Browser) und `length_buckets()` im
Server: sortieren, neue Gruppe sobald ein Text > 1,25 × kürzester + 16 Tokens. `evaluate_backends.py`
füllt nur noch auf den längsten Text im Batch auf.

Außerdem: Ein einzelner desklib-Text mit ~650 Tokens kostet auf der CPU ~4,5 s – deshalb schickt der
Auto-Scan desklib nur bis 1500 Zeichen (~350 Tokens), obwohl das Modell 768 Tokens könnte
(`extension/config.js`, `maxChars`).

## Fehlalarme auf Wikipedia (2026-09-25)

Frage: Wie oft wird menschlicher Sachtext rot? Anlass: TMR markierte Wikipedia „Photosynthesis“ 50/80 rot
(Schwellen 0.6/0.9). Mensch: Absätze aus WikiText-2 (Wikipedia „Good“/„Featured“ Articles, vor 2016,
also sicher ohne LLM), zum Vergleich menschliche HC3-Antworten; KI: ChatGPT-Antworten aus HC3. Texte wie
im Auto-Scan gekürzt (TMR 2000, desklib 1500 Zeichen), nach Wortzahl aufgeteilt. Reproduzierbar mit
`evaluate_false_alarms.py` (TMR n = 200, desklib n = 60 pro Zeile).

Anteil mit Score ≥ Schwelle – bei Mensch = Fehlalarm, bei KI = erkannt.

**TMR:**

| Quelle | Wörter | ≥ 0.6 | ≥ 0.9 | ≥ 0.95 | ≥ 0.97 | ≥ 0.98 | ≥ 0.99 |
|---|---|---|---|---|---|---|---|
| Wikipedia (Mensch) | 40–79 | 89.5 % | 74.5 % | 59.5 % | 38.5 % | 20.0 % | 0 % |
| Wikipedia (Mensch) | 80–119 | 66.0 % | 53.0 % | 43.0 % | 32.0 % | 15.5 % | 0 % |
| Wikipedia (Mensch) | 120–149 | 28.5 % | 19.0 % | 14.5 % | 8.0 % | 1.5 % | 0 % |
| Wikipedia (Mensch) | 150+ | 13.0 % | 8.5 % | 6.0 % | 2.5 % | 0.5 % | 0 % |
| HC3 (Mensch) | 40–79 | 80.5 % | 55.5 % | 38.5 % | 21.5 % | 9.5 % | 0 % |
| HC3 (Mensch) | 80–119 | 55.5 % | 40.5 % | 29.0 % | 19.5 % | 9.5 % | 0 % |
| HC3 (Mensch) | 120–149 | 25.5 % | 13.5 % | 5.5 % | 2.0 % | 0.5 % | 0 % |
| HC3 (Mensch) | 150+ | 39.0 % | 29.0 % | 18.5 % | 9.5 % | 2.5 % | 0 % |
| HC3 ChatGPT (KI) | 40–79 | 100 % | 100 % | 99.5 % | 97.5 % | 81.5 % | 0 % |
| HC3 ChatGPT (KI) | 80–119 | 99.5 % | 99.0 % | 98.5 % | 96.5 % | 86.5 % | 0 % |
| HC3 ChatGPT (KI) | 120–149 | 99.5 % | 98.0 % | 96.5 % | 95.0 % | 87.0 % | 0 % |
| HC3 ChatGPT (KI) | 150+ | 100 % | 100 % | 99.5 % | 98.5 % | 92.0 % | 0 % |

- **Die alten Startwerte 0.6/0.9 waren für Sachtext unbrauchbar:** drei Viertel der kurzen
  Wikipedia-Absätze rot, bei 80–119 Wörtern die Hälfte. TMR liegt fast immer hoch; die Trennung
  steckt im schmalen Band 0.97–0.99 (über 0.99 kommt es praktisch nie).
- **Länge entscheidet:** Selbst bei 0.98 sind 20 % bzw. 15,5 % der Wikipedia-Absätze unter 120 Wörtern
  rot, darüber 1,5 % bzw. 0,5 %.
- **Konsequenz (`extension/models.js`):** TMR gelb ab 0.95, rot ab 0.98; unter 120 Wörtern wird ein
  hoher Score „unsicher“ statt gelb/rot (`reliableWords`). Kosten: rot werden noch ~87–92 % der
  ChatGPT-Texte statt ~100 %.

**desklib** (n = 60 pro Zeile, entsprechend grob):

| Quelle | Wörter | ≥ 0.5 | ≥ 0.8 | ≥ 0.9 | ≥ 0.95 | ≥ 0.98 |
|---|---|---|---|---|---|---|
| Wikipedia (Mensch) | 40–79 | 35.0 % | 8.3 % | 1.7 % | 1.7 % | 1.7 % |
| Wikipedia (Mensch) | 80–119 | 28.3 % | 16.7 % | 13.3 % | 10.0 % | 6.7 % |
| Wikipedia (Mensch) | 120–149 | 13.3 % | 1.7 % | 0 % | 0 % | 0 % |
| Wikipedia (Mensch) | 150+ | 5.0 % | 1.7 % | 0 % | 0 % | 0 % |
| HC3 (Mensch) | 40–79 | 16.7 % | 6.7 % | 0 % | 0 % | 0 % |
| HC3 (Mensch) | 80–119 | 3.3 % | 0 % | 0 % | 0 % | 0 % |
| HC3 (Mensch) | 120–149 | 11.7 % | 6.7 % | 0 % | 0 % | 0 % |
| HC3 (Mensch) | 150+ | 5.0 % | 5.0 % | 1.7 % | 0 % | 0 % |
| HC3 ChatGPT (KI) | 40–79 | 98.3 % | 96.7 % | 96.7 % | 81.7 % | 68.3 % |
| HC3 ChatGPT (KI) | 80–119 | 100 % | 98.3 % | 96.7 % | 93.3 % | 83.3 % |
| HC3 ChatGPT (KI) | 120–149 | 98.3 % | 98.3 % | 98.3 % | 96.7 % | 95.0 % |
| HC3 ChatGPT (KI) | 150+ | 100 % | 100 % | 100 % | 100 % | 100 % |

- desklib trennt deutlich besser (bei Rot ab 0.87 werden fast alle KI-Texte erkannt), ist auf
  Wikipedia unter 120 Wörtern aber auch nicht sauber: 80–119 Wörter ~15 % über der Rot-Schwelle.
  (Mit n = 150 nachgemessen: ~6 % über 0.87, gleichmäßig für 40–119 Wörter – siehe „Konfidenz für
  kurze Absätze“.)
- **Konsequenz:** „unsicher“ unter 120 Wörtern für beide Modelle und als Standard für unbekannte;
  desklib-Schwellen bleiben 0.5 / 0.87.
- Einschränkungen: nur Englisch, KI nur ChatGPT 2023 (HC3, womöglich im Training der Modelle – die
  Erkennungsraten sind eher zu optimistisch; die Fehlalarm-Raten auf Wikipedia betrifft das nicht).

## Konfidenz für kurze Absätze – desklib (2026-09-26)

Frage: Muss desklib unter 120 Wörtern immer „unsicher“ sagen, oder lässt sich ein kurzer Absatz mit
genug Konfidenz doch rot markieren? Die Messung oben (n = 60) war dafür zu dünn und widersprüchlich
(40–79 Wörter sauberer als 80–119). Neu: n = 150 pro 20-Wort-Stufe, gleiche Quellen, reproduzierbar mit
`evaluate_false_alarms.py desklib 150 --fine --dump fa_desklib.jsonl`.

**Fehlalarme (Score ≥ 0.87 = heutige Rot-Schwelle) und Erkennung nach Länge:**

| Wörter | Wikipedia (Mensch) | HC3 (Mensch) | ChatGPT (KI) |
|---|---|---|---|
| 40–59 | 6.0 % | 3.3 % | 76.7 % |
| 60–79 | 6.7 % | 2.0 % | 92.0 % |
| 80–99 | 5.3 % | 0 % | 94.0 % |
| 100–119 | 6.7 % | 1.3 % | 98.7 % |
| 120–149 | 0.7 % | 1.3 % | 98.7 % |
| 150+ | 2.0 % | 2.0 % | 100 % |

- Unter 120 Wörtern gleichmäßig ~6 % Fehlalarme auf Wikipedia, ab 120 ~1,3 %. Die Grenze 120 ist
  also richtig, aber innerhalb der kurzen Absätze gibt es keinen Längen-Verlauf (der frühere
  Unterschied 40–79 vs. 80–119 war Zufall).
- Die Fehlalarme sind gewöhnliche enzyklopädische Prosa (Geschichte, Militär, Wetter, Biografien) –
  keine Listen, Tabellen oder Formeln. Es liegt am sachlichen Stil, nicht an Artefakten.

**Weg 1 – eigene Rot-Schwelle für kurze Absätze.** Alle 600 kurzen Texte je Quelle:

| Rot ab (unter 120 Wörtern) | Wikipedia-Fehlalarme | HC3-Fehlalarme | KI erkannt |
|---|---|---|---|
| 0.87 | 6.2 % | 1.7 % | 90.3 % |
| 0.95 | 2.5 % | 0.5 % | 81.7 % |
| 0.97 | 1.7 % | 0.5 % | 77.0 % |
| **0.98** | **1.0 %** | **0 %** | **73.0 %** |
| 0.99 | 0.7 % | 0 % | 65.5 % |
| 0.995 | 0 % | 0 % | 56.8 % |

Zum Vergleich lange Absätze bei 0.87: 1.3 % Wikipedia-Fehlalarme, 99.3 % erkannt. Kreuzvalidiert (200×
halbe Wikipedia-Daten zum Festlegen, andere Hälfte zum Prüfen, Ziel 1.3 % wie lange Absätze): Schwelle im
Median 0.980 (5–95 %: 0.961–0.991), Fehlalarme auf der Prüfhälfte im Mittel 1.3 % (höchstens 4.3 %).
Erkennung nach Länge bei 0.98: 45 % (40–59 Wörter), 72 % (60–79), 83 % (80–99), 92 % (100–119).

**Weg 2 – Stabilität im Absatz.** Kurze Absätze mit Score ≥ 0.87 (589 Stück) an der Satzgrenze nahe
der Mitte geteilt, beide Hälften einzeln bewertet (`evaluate_split_half.py`). Bei Fehlalarmen liegen die
Hälften tatsächlich weiter auseinander (Median |a−b| 0.10 gegen 0.03 bei KI-Text), aber als Regel ist
das schlechter als Weg 1 bei gleicher Fehlalarmrate:

| Regel | Wikipedia-Fehlalarme | KI erkannt |
|---|---|---|
| Score ≥ 0.995 (Weg 1) | 0 % | 56.8 % |
| beide Hälften ≥ 0.95 | 0.2 % | 39.7 % |
| Score ≥ 0.99 (Weg 1) | 0.7 % | 65.5 % |
| beide Hälften ≥ 0.9 | 0.5 % | 55.7 % |
| Score ≥ 0.98 (Weg 1) | 1.0 % | 73.0 % |
| Score ≥ 0.97 und beide Hälften ≥ 0.8 | 1.2 % | 70.0 % |

Die Hälften sind nur 20–60 Wörter lang und damit selbst unzuverlässig; dazu kosten sie zwei zusätzliche
Modellaufrufe pro Absatz. Weg 2 lohnt sich nicht.

- **Vorschlag (noch nicht umgesetzt):** desklib unter 120 Wörtern rot ab 0.98 statt nie; 0.87–0.98
  bleibt „unsicher“. Ein kurzer Absatz wird dann nur so oft fälschlich rot wie ein langer (~1 %), und
  knapp drei Viertel der kurzen KI-Absätze werden wieder als KI markiert statt grau.
- **Nicht für TMR:** TMR liegt fast nie über 0.99, bei 0.98 sind unter 120 Wörtern noch 15–20 % der
  Wikipedia-Absätze rot (Tabelle oben). Dort bleibt „unsicher“ die richtige Antwort.
- Einschränkungen wie oben: nur Englisch, KI nur ChatGPT 2023 aus HC3 (Erkennungsraten eher zu
  optimistisch); 600 kurze Wikipedia-Absätze, 1 % = 6 Texte.

## Breitere Eval-Suite (2026-09-26, WP-01)

Frage: Die bisherigen Zahlen stammen fast vollständig aus HC3 (Reddit-ELI5 vs. ChatGPT 2023) plus
einer Wikipedia-Fehlalarm-Messung - eine Domäne, ein KI-Modell. Wie verhalten sich TMR und desklib
über mehrere Domänen und mehrere, aktuellere KI-Generatoren?

**Datenquelle:** [`Jinyan1/COLING_2025_MGT_en`](https://huggingface.co/datasets/Jinyan1/COLING_2025_MGT_en)
(Hugging Face), eine Zusammenstellung aus drei Human-vs-KI-Detection-Forschungsdatensätzen:
MAGE ([`yaful/MAGE`](https://huggingface.co/datasets/yaful/MAGE), Apache-2.0), M4GT-Bench
(mbzuai-nlp/M4, EACL 2024 - im GitHub-Repo keine LICENSE-Datei gefunden, reine Recherche-/Eval-
Nutzung) und HC3 (Apache-2.0, bereits in `prepare_dataset.py` genutzt). Für die Zusammenstellung
selbst ist im Dataset-Karten-YAML keine Lizenz eingetragen; genutzt nur zur lokalen Auswertung,
Rohdaten bleiben unter `data/` (gitignored), keine Weiterverteilung. **RAID** (`liamdugan/raid`,
MIT-Lizenz) wurde geprüft, aber verworfen: `train`/`extra`-Split enthalten dort nur offene Modelle
(Llama-Chat, Mistral, MPT, GPT-2) - die im Datensatz gelisteten GPT-4/ChatGPT/Cohere-Generationen
liegen offenbar nur im unlabeled `test`-Split (Leaderboard), sind also öffentlich nicht mit Label
nutzbar.

**Zusammenstellung** (`build_eval_suite.py`, Seed 42, reproduzierbar): sechs Domänen, menschliche
Texte vor 2023 (die Quell-Datensätze/-Aufgaben selbst sind alle älter, XSum/CNN/Wikipedia/Reddit/
arXiv/Yelp/IMDb/WikiHow), KI-Text von den aktuellsten in diesem Datensatz verfügbaren Generatoren:

| Domäne (unsere Kategorie) | Sub-Quellen | Verfügbare Generatoren |
|---|---|---|
| news | xsum, cnn, tldr, dialogsum | gpt-3.5-turbo (einziger verfügbar) |
| wikipedia | wikipedia, wiki_csai | gpt4, gpt4o, gpt-3.5-turbo, llama3-70b, mixtral-8x7b, gemma2-9b-it, cohere |
| forum | reddit, cmv, reddit_eli5, eli5 | s.o. (alle 7) |
| sci_abstract | arxiv, sci_gen, peerread, pubmed | s.o. (alle 7) |
| reviews | yelp, imdb | gpt-3.5-turbo (einziger verfügbar) |
| howto | wikihow | s.o. (alle 7) |

Je Domäne 100 menschliche + 100 KI-Texte (auf die verfügbaren Generatoren aufgeteilt) = **1200
Texte gesamt, 600/600 balanciert**. Absätze 40–400 Wörter (wie `content.js` MIN_WORDS bzw.
`extension/length-buckets.js`), am Satzende gekürzt; Tokenisierungs-Artefakt „Leerzeichen vor
Satzzeichen" (bekannt aus `reddit_eli5`/HC3, s.o.) normalisiert. Ältere/kleine Generatoren im
Quell-Datensatz (davinci, opt_\*, flan_t5_\*, t0_\*, bloom\*, gpt_j, gpt_neox, GLM130B, dolly\*)
bewusst ausgelassen - nicht mehr repräsentativ für heutigen KI-Text im Web. **Kein Claude/Gemini
verfügbar:** kein öffentlicher Datensatz mit gelabelten Claude-/Gemini-Generationen gefunden (diese
Extension hat keine API-Keys für eigene Generierung) - Einschränkung, keine Umgehung.

**Bewertung** (`evaluate_suite.py`): TMR auf allen 1200 Texten, desklib auf einer stratifizierten
Stichprobe von 480 (Domäne × Mensch/KI gleich verteilt) - desklib braucht auf dieser CPU ~2,3 s/Text
(gemessen, `benchmark_latency.py`-Größenordnung bestätigt sich), 1200 Texte hätten ~46 Minuten
gekostet, die Stichprobe ~18,5 Minuten. Rohscores: `data/eval_scores_tmr_suite.jsonl` /
`data/eval_scores_desklib_suite.jsonl` (gitignored).

### Ergebnis: AUROC und Fehlalarme an den aktuellen Schwellen

Aktuelle Schwellen aus `extension/models.js` (nur gelesen, nicht verändert): TMR yellowFrom 0.95 /
redFrom 0.98; desklib yellowFrom 0.5 / redFrom 0.87 (kurze Absätze < 120 Wörter: `shortRedFrom` 0.98
bzw. gar keins bei TMR → dort immer „unsicher“ statt rot).

| Backend | n | AUROC gesamt | Fehlalarme (Mensch) ≥ redFrom | KI erkannt ≥ redFrom |
|---|---|---|---|---|
| TMR | 1200 | 0.929 | 12.0 % | 83.5 % |
| desklib | 480 | 0.990 | 2.5 % | 95.4 % |

**Je Domäne:**

| Domäne | TMR AUROC | TMR FA@red | TMR erkannt | desklib AUROC | desklib FA@red | desklib erkannt |
|---|---|---|---|---|---|---|
| forum | 0.962 | 6.0 % | 86.0 % | 1.000 | 0 % | 100 % |
| howto | **0.767** | 20.0 % | 64.0 % | 0.968 | 2.5 % | 92.5 % |
| news | 0.940 | **34.0 %** | 99.0 % | 0.991 | **10.0 %** | 95.0 % |
| reviews | 0.924 | 10.0 % | 74.0 % | 0.992 | 0 % | 90.0 % |
| sci_abstract | 0.977 | 1.0 % | 86.0 % | 0.995 | 2.5 % | 97.5 % |
| wikipedia | 0.995 | 1.0 % | 92.0 % | 0.999 | 0 % | 97.5 % |

TMR ist auf `howto` (Anleitungen, oft listenartig) deutlich schwächer (AUROC 0.767) als auf den
bisher gemessenen Domänen. Beide Modelle haben auf `news` die höchste Fehlalarmrate - menschliche
Nachrichtentexte/-zusammenfassungen (XSum/CNN) ähneln stilistisch offenbar KI-Zusammenfassungen
(glatt, neutral, kurz). Bei desklib ist das mit n=80 je Domäne aber eine grobe Schätzung (10 % FA
= 8 Texte).

**Je Generator** (Anteil KI-Texte ≥ redFrom erkannt):

| Generator | TMR (n≈56–256) | desklib (n≈19–102) |
|---|---|---|
| gpt4 | 86.7 % | 100 % |
| gpt4o | 88.3 % | 100 % |
| gpt-3.5-turbo | 87.1 % | 94.1 % |
| llama3-70b | 85.7 % | 96.4 % |
| mixtral-8x7b | 83.9 % | 89.5 % |
| cohere | 71.4 % | 95.5 % |
| gemma2-9b-it | **67.9 %** | 94.7 % |

TMR erkennt GPT-Familie und Llama am zuverlässigsten, ist bei Cohere und besonders Gemma2 spürbar
schwächer (68–71 % statt 84–88 %). desklib bleibt über alle sieben Generatoren zwischen 90–100 % -
kein Generator, an dem es deutlich schwächelt.

**Je Längen-Bucket** (nur Mensch-Zeilen für Fehlalarme, nur KI-Zeilen für „erkannt"):

| Wörter | TMR FA@yellow | TMR FA@red | TMR erkannt | desklib FA@yellow | desklib FA@red | desklib erkannt |
|---|---|---|---|---|---|---|
| 40–79 | 56.7 % | 33.3 % | 70.7 % | 21.7 % | 4.3 % | 75.0 % |
| 80–119 | 51.9 % | 31.2 % | 86.6 % | 25.0 % | 6.2 % | 96.0 % |
| 120–149 | 12.8 % | 2.6 % | 82.6 % | 23.1 % | 7.7 % | 100 % |
| 150+ | 19.1 % | 6.4 % | 84.7 % | 7.6 % | 1.2 % | 97.8 % |

Bestätigt die bisherige `reliableWords=120`-Grenze: unter 120 Wörtern sind beide Modelle bei „rot"
unzuverlässig (TMR 31–33 % FA, desklib 4–6 % FA) - genau deshalb zeigt die Extension dort „unsicher“
statt gelb/rot (außer desklib mit `shortRedFrom`). Die 150+-Zahlen liegen etwas höher als die frühere
Wikipedia-only-Messung (TMR 1,3 % → 6,4 %, desklib ~1,3 % → 1,2 %, hier eher gleich), weil jetzt auch
`news`/`howto`/`forum` einfließen, nicht nur Wikipedia/HC3.

### Korrektur: Fehlalarme so, wie die Extension sie anzeigt

Die Spalten „FA@red“ oben zählen jeden Mensch-Text ab `redFrom`, auch kurze. Die Extension färbt Texte
unter `reliableWords` (120 Wörter) aber nicht nach `redFrom`: TMR nie rot, desklib erst ab
`shortRedFrom` 0.98. Mit dieser Regel (`evaluate_suite.py`, Zeile „wie angezeigt“; bei den kurzen
Absätzen ohne Gruppierung aus WP-02):

| Domäne | TMR FA rot | TMR KI rot | desklib FA rot | desklib KI rot |
|---|---|---|---|---|
| forum | 2 % | 81 % | 0 % | 100 % |
| howto | **20 %** | 64 % | 2,5 % | 92,5 % |
| news | 3 % | 73 % | 2,5 % | 90 % |
| reviews | 2 % | 13 % | 0 % | 70 % |
| sci_abstract | 0 % | 79 % | 2,5 % | 95 % |
| wikipedia | 1 % | 92 % | 0 % | 97,5 % |
| **gesamt** | **4,7 %** | 67 % | **1,2 %** | 91 % |

Damit verschiebt sich das Bild:

- **Die hohen News-Fehlalarme (TMR 34 %, desklib 10 %) betreffen fast nur kurze Texte**, die ohnehin
  „unsicher“ bleiben (48 von 100 menschlichen News-Texten haben unter 120 Wörter). Angezeigt: 3 % bzw. 2,5 %.
- **Das eigentliche Problem ist TMR auf `howto` (WikiHow):** alle Texte ≥ 120 Wörter, 20 % der
  menschlichen werden rot. Ohne `howto` läge TMR bei ~1,6 %.
- **desklib liegt mit den aktuellen Schwellen schon bei ~1 %** (3 von 240). Eine Anhebung von `redFrom`
  auf 0.92–0.95 (unten) ist damit nicht nötig; die Messung gibt dafür zu wenige Fälle her.
- Die Perzentil-Schwellen unten beziehen sich auf die Rohscores aller Längen und sind entsprechend
  zu lesen: Für TMR müsste `redFrom` für ~1 % bei langen Texten auf ~0.985 steigen, fast nur wegen
  `howto`.

### Schwellen-Empfehlung für ~1 % Fehlalarme auf dieser Suite

Perzentil-Methode (99. Perzentil der Mensch-Scores dieser Suite), getrennt nach `reliableWords`:

| Backend | Bucket | Schwelle für ~1 % FA | tatsächliche FA | KI erkannt dabei | aktuelle Schwelle |
|---|---|---|---|---|---|
| TMR | alle | 0.9865 | 1.0 % | 36.3 % | redFrom 0.98 |
| TMR | < 120 Wörter | 0.9868 | 1.5 % | 9.6 % | (immer „unsicher“) |
| TMR | ≥ 120 Wörter | 0.9853 | 1.1 % | 61.9 % | redFrom 0.98 |
| desklib | alle | 0.9463 | 1.3 % | 93.8 % | redFrom 0.87 |
| desklib | < 120 Wörter | 0.9566 | 1.8 % | 79.6 % | shortRedFrom 0.98 (73 % erkannt, siehe oben) |
| desklib | ≥ 120 Wörter | 0.9254 | 1.1 % | 97.4 % | redFrom 0.87 (2,5 % FA) |

**Konkrete Schwellen-Empfehlung:**

- **TMR:** Der aktuelle Wert (redFrom 0.98) liegt auf dieser breiteren Suite bei ~12 % Fehlalarmen,
  nicht ~1 % - die frühere Kalibrierung war auf Wikipedia/HC3 zugeschnitten, hält aber auf `news`/
  `howto` nicht. Für ein echtes ~1 %-Ziel über alle Domänen bräuchte es **redFrom ≈ 0.985–0.987**,
  was die Erkennung bei langen Texten von ~85 % auf ~62 % drückt und bei kurzen Texten (ohnehin
  „unsicher“) fast nichts mehr erkennt (9,6 %). TMR bleibt also ein Modell mit schmalem nutzbarem
  Band zwischen Fehlalarmen und Erkennung - die bestehende Empfehlung „TMR fürs Hintergrund-Scannen,
  aber mit Vorsicht bei Nachrichten/Anleitungen“ wird hierdurch bestätigt statt widerlegt.
- **desklib:** Der aktuelle Wert (redFrom 0.87) liegt bei ~2,5 % FA - schon nah am Ziel, aber
  `news` treibt das auf 10 % hoch. **redFrom ≈ 0.92–0.95** würde über alle Domänen ~1 % FA
  erreichen, bei nur minimalem Erkennungsverlust (95,4 % → 93,8–97,4 %, da desklib in diesem Bereich
  kaum Trennschärfe verliert) - ein günstiger Tausch, den Punkt 5 (Kalibrierung) aufgreifen sollte.
  Für kurze Absätze (< 120 Wörter) legt diese Suite **shortRedFrom ≈ 0.955–0.96** nahe statt der
  aktuellen 0.98 - ähnliche Fehlalarmrate (1,8 % vs. ~1 % auf der alten Wikipedia-only-Messung),
  aber spürbar mehr erkannte kurze KI-Texte (79,6 % statt 73 %). Vor einer Änderung an
  `extension/models.js` lohnt sich - wie schon beim Kurz-Absatz-Fund oben - eine Kreuzvalidierung
  (train/test-Split dieser Suite), weil 480 Texte (Fehlalarm-Bucket teils nur ~20–30 Texte) noch
  keine sehr enge Fehlerspanne geben.

### Empfehlung Default-Modell

**desklib bleibt die klar bessere Wahl, wo Latenz es zulässt.** Auf dieser breiteren, härteren
Suite (6 Domänen, 7 aktuelle Generatoren inkl. GPT-4o, Llama-3-70B, Mixtral, Gemma-2, Cohere) hält
der AUROC-Abstand (0.990 vs. 0.929) und wächst sogar: TMR verliert bei `howto` deutlich an
Trennschärfe (0.767) und bei Cohere/Gemma2 an Erkennung (68–71 %), während desklib über alle
Domänen und Generatoren zwischen 0.968–1.000 AUROC bzw. 90–100 % Erkennung bleibt. Die bestehende
Rollenverteilung in der Extension (TMR fürs automatische Hintergrund-Scannen wegen Tempo, desklib
für „Nur auf Knopfdruck“/genauere Prüfung) bleibt sinnvoll - TMR eher als grober erster Filter,
mit dem Wissen, dass es bei Nachrichten/Anleitungen und neueren Nicht-OpenAI-Modellen (Gemma,
Cohere) schwächer ist.

### Einschränkungen

- Kein Claude/Gemini als Generator verfügbar (kein öffentlicher gelabelter Datensatz gefunden,
  keine eigenen API-Keys) - die Erkennungsraten sagen nichts über diese beiden Modellfamilien.
- M4GT-Bench-Lizenz ungeklärt (siehe oben) - Daten bleiben lokal, keine Weiterverteilung.
- desklib nur auf 480/1200 Texten gemessen (Zeitbudget); Domänen-Werte dort auf n=80 je Domäne,
  Generator-Werte auf n=19–102 - insbesondere die 10 %-FA bei `news` (8/80) und die
  Kurz-Absatz-Zahlen (n=13–32) haben spürbare Stichproben-Unsicherheit.
- Menschliche Texte sind die Originaldokumente der Quell-Datensätze (vor 2023), aber teils selbst
  schon algorithmisch vorverarbeitet (z. B. XSum/CNN sind Zusammenfassungs-Datensätze) - „menschlich“
  heißt hier „von Menschen verfasst“, nicht zwingend „unbearbeiteter Rohtext einer echten Webseite“.
- Absätze wurden aus ggf. längeren Dokumenten am Anfang entnommen (erster passender Ausschnitt),
  nicht zufällig aus der Mitte - bei sehr langen Dokumenten (z. B. `howto`, Median 500+ Wörter)
  könnte der Rest des Dokuments andere Werte liefern.
- Wie immer bei diesen Benchmarks: TMR/desklib könnten Teile dieser Quell-Datensätze (MAGE/M4GT/HC3
  sind alle vor 2025 veröffentlicht) im eigenen Training gesehen haben - absolute Erkennungsraten
  eher zu optimistisch, der Domänen-/Generator-*Vergleich* (gleiche Texte, gleiches Modell) bleibt
  aussagekräftig.

## Schwellen absichern: desklib auf n=1200, Kreuzvalidierung, TMR auf Anleitungen (2026-09-26, WP-07)

Anschluss an "Breitere Eval-Suite": desklib war dort nur auf einer Stichprobe von 480/1200 Texten
gemessen, die Schwellen-Empfehlung (redFrom 0,92–0,95 desklib, 0,985–0,987 TMR) beruhte auf einem
einzigen Split ohne Fehlerspanne. Hier: desklib auf allen 1200 Texten (die fehlenden 720 nachgerechnet,
vorhandene 480 Scores wiederverwendet - `training/desklib_fill_suite.py`, CPU, 2866 s = 47,8 Min für
die 720 neuen), dazu eine Kreuzvalidierung der Schwellen (`training/crossval_thresholds.py`) und eine
Einordnung des WikiHow-Befunds gegen die tatsächliche Kandidaten-/Gruppierungslogik der Extension
(`content.js`).

### desklib auf allen 1200 Texten

Rohscores: `data/eval_scores_desklib_suite.jsonl` (1200 Zeilen, gitignored). Ersetzt die 480er-Zahlen
im Abschnitt "Breitere Eval-Suite" oben (dort unverändert stehengelassen, siehe dort für Methode).

| Lauf | n | AUROC gesamt | FA wie angezeigt | KI rot wie angezeigt |
|---|---|---|---|---|
| desklib (n=480, WP-01) | 480 | 0,990 | 1,2 % | 91 % |
| **desklib (n=1200, WP-07)** | **1200** | **0,991** | **1,8 %** | **92,5 %** |

Je Domäne (wie angezeigt - kurze Absätze nach `shortRedFrom`):

| Domäne | AUROC | FA rot | KI rot |
|---|---|---|---|
| forum | 0,999 | 3,0 % | 98,0 % |
| howto | 0,975 | 2,0 % | 96,0 % |
| news | 0,992 | 3,0 % | 93,0 % |
| reviews | 0,993 | 0 % | 74,0 % |
| sci_abstract | 0,998 | 2,0 % | 97,0 % |
| wikipedia | 0,996 | 1,0 % | 97,0 % |
| **gesamt** | **0,991** | **1,8 %** | **92,5 %** |

Je Generator (Anteil KI-Texte ≥ redFrom erkannt):

| Generator | n | erkannt@red |
|---|---|---|
| cohere | 56 | 94,6 % |
| gemma2-9b-it | 56 | 98,2 % |
| gpt-3.5-turbo | 256 | 95,7 % |
| gpt4 | 60 | 98,3 % |
| gpt4o | 60 | 100 % |
| llama3-70b | 56 | 98,2 % |
| mixtral-8x7b | 56 | 94,6 % |

Je Längen-Bucket (rohe FA@red bei 0,87, **ohne** `shortRedFrom`-Logik - zeigt, warum sie nötig bleibt):

| Wörter | n Mensch | FA@red (roh) | n KI | erkannt@red |
|---|---|---|---|---|
| 40–79 | 60 | 13,3 % | 58 | 81,0 % |
| 80–119 | 77 | 9,1 % | 67 | 98,5 % |
| 120–149 | 39 | 5,1 % | 23 | 95,7 % |
| 150+ | 424 | 1,9 % | 452 | 98,5 % |

- Mit der vollen Stichprobe steigt die "wie angezeigt"-Fehlalarmrate von 1,2 % (n=480) auf 1,8 %
  (n=1200) - die kleinere Stichprobe war optimistisch (u.a. `forum` hatte dort 0 % Fehlalarme, jetzt
  3,0 % bei n=200 statt n=80). AUROC bleibt praktisch gleich (0,990 → 0,991).
- Die rohe FA@red-Spalte je Längen-Bucket bestätigt auf der vollen Stichprobe erneut deutlich mehr
  Fehlalarme unter 120 Wörtern (13,3 % / 9,1 %) als darüber (1,9 %) - `reliableWords=120` und
  `shortRedFrom` bleiben richtig.

### Kreuzvalidierte Schwellen

Methode (orchestration/LOG.md, ENTSCHEIDUNG): 200 Wiederholungen, pro Wiederholung ein zufälliger
Hälfte/Hälfte-Split (stratifiziert nach Domäne × Label). Auf Hälfte A: Schwelle als 99. Perzentil der
Mensch-Scores (Ziel ~1 % Fehlalarme). Auf Hälfte B (ungesehen): tatsächliche Fehlalarm-/Erkennungsrate.
Getrennt für die Gruppe ≥120 Wörter (regelt `redFrom`) und <120 Wörter (regelt `shortRedFrom`, wo
vorhanden) - das ist genau die Aufteilung, die `config.js` `level()` tatsächlich verwendet (Regel 9 im
orchestration/README.md). Reproduzierbar mit `training/crossval_thresholds.py --backend both`.

| Backend | Bucket | Kreuzvalidierte Schwelle (Median, 5.–95. Perz.) | FA auf Testhälfte (Median, 5.–95. Perz.) | KI erkannt (Median, 5.–95. Perz.) |
|---|---|---|---|---|
| TMR | ≥120 W. (redFrom) | 0,9850 (0,9835–0,9858) | 1,29 % (0,43–3,45 %) | 65,3 % (55,2–75,3 %) |
| TMR | <120 W. (shortRedFrom) | 0,9867 (0,9865–0,9868) | 2,90 % (0–5,87 %) | 13,3 % (4,7–23,4 %) |
| desklib | ≥120 W. (redFrom) | 0,9466 (0,8522–0,9578) | 1,29 % (0–3,45 %) | 97,1 % (95,4–98,7 %) |
| desklib | <120 W. (shortRedFrom) | 0,9758 (0,9583–0,9843) | 1,45 % (0–5,87 %) | 78,1 % (64,1–87,5 %) |

Zum Vergleich die **aktuellen** Werte, auf denselben Testhälften gemessen (Konfidenzintervall der
heutigen Zahlen auf dieser Suite):

| Backend | Bucket | Aktueller Wert | FA auf Testhälften (Median, 5.–95. Perz.) | KI erkannt (Median, 5.–95. Perz.) |
|---|---|---|---|---|
| TMR | ≥120 W. (redFrom) | 0,98 | 6,03 % (4,72–7,76 %) | 84,5 % (81,6–87,0 %) |
| TMR | <120 W. | (immer "unsicher") | – | – |
| desklib | ≥120 W. (redFrom) | 0,87 | 2,16 % (0,86–3,02 %) | 98,3 % (97,5–99,6 %) |
| desklib | <120 W. (shortRedFrom) | 0,98 | 1,45 % (0–1,45 %) | 70,3 % (65,6–76,6 %) |

- **TMR `redFrom` 0,98 liegt klar über dem 1-%-Ziel** (Median 6,0 % Fehlalarme auf unabhängigen
  Testhälften, nie unter 4,7 %) - bestätigt die einmalige Schätzung oben (0,985–0,987) mit einer engen,
  stabilen kreuzvalidierten Schwelle (0,9835–0,9858). Preis: Erkennung fällt von 84,5 % auf 65,3 %.
- **desklib `redFrom` 0,87 liegt näher am Ziel, aber im Mittel bei gut 2 %**, mit spürbarer Spanne (bis
  3,0 % je nach Split). Die kreuzvalidierte Schwelle (Median 0,9466) bestätigt die frühere Empfehlung
  (0,92–0,95) der Größenordnung nach, hat aber eine breite Spanne (0,85–0,96) - bei ~230 Mensch-Scores
  pro Trainhälfte ist die 1-%-Perzentil-Schätzung (≈2.–3. kleinster Wert von "oben") inhärent unruhig.
  Der Tausch bleibt trotzdem günstig: FA sinkt auf ~1,3 %, Erkennung bleibt bei 97,1 % (kaum niedriger
  als heute).
- **desklib `shortRedFrom` 0,98 ist auf der breiteren Suite eher etwas zu streng**: kreuzvalidiert liegt
  die Schwelle bei 0,9758 (0,9583–0,9843, überlappt mit 0,98), bei ähnlicher Fehlalarmrate aber deutlich
  mehr erkannten kurzen KI-Texten (78 % statt 70 %).
- **Für TMR unter 120 Wörtern bestätigt sich: kein `shortRedFrom` einführen.** Selbst bei der auf 1 %
  Fehlalarme optimierten Schwelle (0,9867) werden nur 13 % der kurzen KI-Texte erkannt (Spanne 5–23 %) -
  nicht nützlich genug, um "unsicher" zu ersetzen.

### TMR auf Anleitungen: was der Eval-Ausschnitt zeigt - und ob die Extension das auf echten Seiten auch so sähe

Befund (unverändert seit "Breitere Eval-Suite"): TMR-AUROC auf `howto` nur 0,767, 20 % der 200
menschlichen WikiHow-Ausschnitte landen "wie angezeigt" auf Rot - und zwar **alle** bei ≥120 Wörtern
(176–420 Wörter, Median 397, nachgeprüft), die Kurz-Absatz-Ausnahme (kein `shortRedFrom` für TMR) greift
hier also nie.

Was misst der Eval-Ausschnitt strukturell? `build_eval_suite.py` nimmt bis zu 400 Wörter vom
Dokumentanfang, **am Stück**: Zeilenumbrüche/Absatzgrenzen werden vor dem Kürzen zu einem einzigen
Fließtext zusammengefasst (`" ".join(text.split())`) - im Quelldatensatz sind WikiHow-Schritt-,
Überschriften- und Listengrenzen bereits verloren. Der Ausschnitt ist also ein einziger langer,
zusammenhängender Absatz.

Wie sähe die Extension denselben Text? Relevante Stellen in `content.js`:
- `CANDIDATE_SELECTOR = "article, p, li"` - einzelne Listenpunkte (`<li>`, wie bei WikiHow-Schritten
  üblich) sind eigene Kandidaten.
- Der 40-Wörter-Mindestfilter (`MIN_WORDS`) wirkt **vor** der Gruppierung, pro Kandidat einzeln
  (`collectCandidates`): ein einzelner Schritt unter 40 Wörtern wird nie zum Kandidaten und nie
  bewertet - auch nicht gruppiert.
- `groupCandidates` fasst nur benachbarte Kandidaten **unter `reliableWords` (120 Wörter)** zusammen,
  und nur, wenn sie denselben Elternknoten haben und **keine** Überschrift/Liste/Tabelle
  (`GROUP_BREAK_SELECTOR = "h1..h6, ul, ol, table, hr"`) dazwischenliegt.

Daraus zwei gegenläufige Effekte, die der reine Rohtext-Eval nicht abbildet:
1. **Entlastend:** Kurze, einzeln unter 40 Wörter liegende Schritte (knapper WikiHow-Stil: "Tu X. Grund:
   Y.") werden nie einzeln gescannt oder gruppiert - sie tauchen in der Extension gar nicht als Kandidat
   auf. Der Eval-Ausschnitt (bis 400 Wörter am Stück) enthält aber genau solche Schritte mit, weil er
   alles zusammenfasst - er testet damit auch Text, den die Extension real nie sieht.
2. **Nicht entlastend:** Sind einzelne Schritte selbst schon 40–119 Wörter lang (ebenfalls verbreitet,
   v.a. bei erklärenden Anleitungen) und stehen als `<li>` in derselben `<ol>` ohne Zwischenüberschrift,
   gruppiert `groupCandidates` sie zu einem zusammenhängenden Text bis `maxChars` (2000 Zeichen bei
   TMR) - strukturell nahe an dem, was der Eval-Ausschnitt misst. Trennen WikiHow-Guides ihre Schritte
   dagegen mit "Method"/"Part"-Zwischenüberschriften (verbreitet bei Anleitungen mit mehreren
   Vorgehensweisen), bricht die Gruppierung an jeder Überschrift - die Schritt-Gruppen bleiben kleiner,
   eher unter 120 Wörtern und damit "unsicher" statt Rot.

Ein Abruf einer echten WikiHow-Seite zur Gegenprobe war in dieser Umgebung nicht möglich (wikihow.com
wird vom verfügbaren Fetch-Werkzeug blockiert); die Einschätzung stützt sich auf den nachvollzogenen
`content.js`-Code plus bekanntes WikiHow-Aufbaumuster (Schritte meist als Listenelemente, häufig mit
"Method"/"Part"-Überschriften bei mehreren Vorgehensweisen), nicht auf eine gerenderte Seite.

**Empfehlung: nichts an einer pauschalen Schwelle ändern, keine Domänen-Heuristik einführen.**
Begründung:
- Ein generelles Anheben von `redFrom` auf ~0,985 (siehe Kreuzvalidierung) würde die TMR-Erkennung
  überall von ~85 % auf ~65 % drücken, nur um ein Problem zu lösen, das auf echten Seiten durch
  Gruppierung/40-Wörter-Filter bereits teilweise abgefedert wird.
- Eine WikiHow-spezifische Schwelle bräuchte eine zuverlässige Domänenerkennung, die es in `content.js`
  nicht gibt (und die leicht falsch zu erkennen wäre).
- Die tatsächliche Exposition auf echten Anleitungsseiten lässt sich mit reinem Rohtext-Eval nicht
  seriös beziffern - das bräuchte einen Test von `content.js`/`groupCandidates` gegen gerenderte
  WikiHow-Seiten (Vorschlag für TODO.md, siehe unten).
- Die bestehende Einordnung ("TMR fürs Hintergrund-Scannen, aber mit Vorsicht bei Anleitungen/
  Nachrichten; desklib als genaueres Default-Modell") bleibt damit richtig - desklib zeigt auf `howto`
  mit 2,0 % FA "wie angezeigt" ohnehin ein deutlich kleineres Problem (AUROC 0,975 statt 0,767).

### Empfehlung für `extension/models.js`

| Wert | Aktuell | Kreuzvalidierter Vorschlag | Ändern? |
|---|---|---|---|
| desklib `redFrom` | 0,87 | ~0,93–0,95 (Median 0,9466, Spanne 0,85–0,96) | **Ja** - senkt FA von ~2,2 % auf ~1,3 %, Erkennung bleibt bei ~97 % |
| desklib `shortRedFrom` | 0,98 | ~0,97–0,98 (Median 0,9758, überlappt mit 0,98) | Optional, kleiner Effekt - Erkennung 78 % statt 70 % bei ähnlicher FA |
| TMR `redFrom` | 0,98 | 0,985 (0,9835–0,9858, sehr eng) | **Nur mit Vorbehalt** - senkt FA von ~6 % auf ~1,3 %, kostet aber ~19 Punkte Erkennung (84,5 % → 65,3 %); Alternative: Wert lassen, Schwäche (howto/News) bewusst in Kauf nehmen, weil desklib ohnehin das genauere Default-Modell ist |
| TMR `shortRedFrom` | keins | keins einführen | **Nein** - selbst optimal nur ~13 % Erkennung |

Eine finale Entscheidung trifft der Orchestrator nach Review (Umfang dieses WP: keine Extension-Dateien
geändert).

### Einschränkungen

- Kreuzvalidierte Schwellen für die "lang"-Buckets stützen sich auf ~230–470 Mensch-Scores pro
  Trainhälfte, für "kurz" auf ~65–70 - die 1-%-Perzentil-Schätzung ist bei so wenigen Fällen naturgemäß
  unruhig (sichtbar an der Spanne, v.a. desklib lang: 0,85–0,96). Die Spannen sind ernst zu nehmen,
  keine Formsache.
- Die WikiHow-Strukturanalyse ist Code-Lektüre + Domänenwissen, keine Messung an echten Seiten (Fetch
  von wikihow.com in dieser Umgebung blockiert). Sie zeigt eine plausible Bandbreite, keinen Wert.
- Wie in "Breitere Eval-Suite": kein Claude/Gemini als Generator, M4GT-Lizenz ungeklärt (Daten bleiben
  lokal), menschliche Texte teils schon redaktionell/algorithmisch vorverarbeitet (XSum/CNN), Modelle
  könnten Teile der Quell-Datensätze im Training gesehen haben.
- desklib jetzt vollständig auf 1200 Texten (720 neu + 480 aus WP-01, Text selbst als Schlüssel beim
  Zusammenführen - in dieser Suite keine Duplikate erwartet, aber nicht separat geprüft).
