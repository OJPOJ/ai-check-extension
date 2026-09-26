# WP-06 · Modellsuche zwischen TMR und desklib

Auftrag: TODO Punkt 2 - ein Detektor mit desklib-ähnlicher Qualität, aber deutlich weniger Download/
Rechenzeit. Referenz (`training/EVAL_RESULTS.md`, Abschnitt "Breitere Eval-Suite" inkl. "Korrektur",
1200 Texte, 6 Domänen, 7 Generatoren): TMR (126 MB, ~0,15 s/Absatz, AUROC 0,929, ~4,7 % Fehlalarme
wie angezeigt) und desklib (1,7 GB Download / ~475 MB im Browser, ~1,3-2,3 s/Absatz, AUROC 0,990,
~1,2 % Fehlalarme wie angezeigt).

## Kandidaten (recherchiert)

Kriterien aus dem Brief: offene Lizenz ohne Nicht-kommerziell-Klausel, < 500 MB (ideal < 200 MB),
öffentlich ohne Gate, aktuelle Trainingsdaten, transformers.js-kompatible Architektur (geprüft:
RoBERTa, BERT und ModernBERT sind in der in diesem Repo gepinnten `@huggingface/transformers@4.3.0`
vorhanden - `package/src/models/{roberta,bert,modernbert}/`; Longformer nicht).

| Repo | Lizenz | Architektur | Größe (fp32 / ONNX) | ONNX vorhanden | Trainingsdaten | Status |
|---|---|---|---|---|---|---|
| **fakespot-ai/roberta-base-ai-text-detection-v1** | Apache-2.0 | RoBERTa-base (125M) | 499 MB / **125 MB int8** | Ja ([MedAliFarhat/ai-text-detector-onnx](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx), Apache-2.0, `sha 0c809a8`, explizit für transformers.js gebaut) | Nicht im Detail offengelegt (Verweis auf github.com/FakespotAILabs/ApolloDFT, technischer Report ohne konkrete Quellenliste) | **Gemessen, empfohlen** |
| MayZhou/e5-small-lora-ai-generated-detector | MIT | BERT/e5-small (33M) | 133 MB / kein ONNX | Nein | RAID-train (80k Mensch, 128k KI) + 10k Twitter+GPT-4o-mini-Paraphrasen | Gemessen, **verworfen** (schlecht kalibriert) |
| AICodexLab/answerdotai-ModernBERT-base-ai-detector | Apache-2.0 | ModernBERT-base (149M) | 598 MB / kein ONNX | Nein | DAIGT V2 (Kaggle-Schüleraufsätze + ChatGPT/Claude/DeepSeek, ~36k Texte) | Gemessen, **verworfen** (Scores saturieren nahe 1,0, generalisiert schlecht) |
| ShantanuT01/gradient-ai-text-detector | MIT | DeBERTa-v3-large (~435M, wie desklib) | 1,74 GB / 408 MB (nur int4 `model_q4.onnx`, kein int8) | Ja (int4) | DACTYL 2.0 + LLMTrace + MAGA-Bench (~1,1 Mio. Texte) | Nicht gemessen: Größenziel klar verfehlt (fast so groß wie desklib, int4 im Browser zudem riskant/wenig erprobt); Modellkarte behauptet AUROC 0,955 OOD vs. desklib 0,921 OOD - eigener, nicht nachgeprüfter Wert |
| yaful/MAGE | Apache-2.0 | Longformer | - | - | MAGE-Datensatz | **Verworfen**: Longformer wird von transformers.js nicht unterstützt; MAGE ist außerdem eine der drei Quellen unserer eigenen Eval-Suite (`training/EVAL_RESULTS.md`) - direkte Kontamination |
| Hello-SimpleAI/chatgpt-detector-roberta | keine Lizenz angegeben | RoBERTa-base | - | - | HC3 | **Verworfen**: keine Lizenz im Model-Repo, HC3 ist Teil unserer Eval-Suite (forum-Domäne) - Kontamination |
| andreas122001/roberta-academic-detector, roberta-mixed-detector | OpenRAIL | RoBERTa-large | - | - | NicolaiSivesind/human-vs-machine | **Verworfen**: OpenRAIL ist eine Verhaltens-Lizenz (Nutzungsauflagen), nicht MIT/Apache/CC-BY wie gefordert |
| raj-tomar001/LLM-DetectAIve_deberta-base | keine Lizenz/Model Card | DeBERTa-base | - | - | unbekannt | **Verworfen**: kein Model Card, keine Lizenzangabe |
| SuperAnnotate/ai-detector(-low-fpr) | "other" (unklar) | RoBERTa-large | 1,4 GB | Nein | Wikipedia + ELI5 | **Verworfen**: Lizenz unklar, zu groß, Wikipedia/ELI5 sind Teil unserer Eval-Suite - Kontamination |

8 Kandidaten recherchiert, 3 echt gemessen (Abnahme verlangt mindestens 2).

## Messmethodik

`evaluate_backends.py` um eine generische `score_hf(texts, model_id)` erweitert (erkennt Sigmoid-
bei-1-Label vs. Softmax-bei-N-Labels+id2label-Heuristik, wie beim bestehenden TMR-Scorer).
`evaluate_suite.py` unterstützt jetzt `--backend hf:<repo>`: läuft exakt wie beim TMR-Pfad auf der
vollen 1200er-Suite und druckt dieselben Tabellen (AUROC gesamt/je Domäne/je Generator/je
Längen-Bucket, "wie angezeigt" nach Regel 9). Da es für einen neuen Kandidaten keine
Produktions-Schwelle gibt, leitet `report()` sie automatisch aus dem 99.-Perzentil der eigenen
Mensch-Scores dieser Messung ab (getrennt für < 120 / ≥ 120 Wörter, `reliableWords=120`) und nutzt
sie für die "wie angezeigt"/Domänen/Generator-Tabellen - identische Methode wie die bestehende
Schwellen-Empfehlung am Skriptende, nur vorgezogen. Rohscores unter `training/data/` (gitignored):
`eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`,
`eval_scores_MayZhou_e5-small-lora-ai-generated-detector_suite.jsonl`,
`eval_scores_AICodexLab_answerdotai-ModernBERT-base-ai-detector_suite.jsonl`.

`benchmark_latency.py` um eine generische `bench_hf(model_id)` erweitert (`--backend hf:<repo>`),
identische Methodik wie die bestehenden TMR/desklib-Messungen (Batch 1/8/25, 500-Zeichen-Text).
Latenz nur gemessen, als laut `tasklist` kein anderer Python-Prozess lief (WP-07 war zu diesem
Zeitpunkt bereits fertig, `orchestration/LOG.md` 19:08 Uhr) - zusätzlich vor und nach jeder Messung
per `tasklist` geprüft.

Keine neuen Python-Pakete nötig: RoBERTa, BERT und ModernBERT sind mit der bereits installierten
`transformers==5.17.0` abgedeckt.

## Ergebnisse

### AUROC gesamt (1200 Texte TMR/fakespot, 480 desklib-Stichprobe - Zahlen aus EVAL_RESULTS.md)

| Backend | n | AUROC gesamt |
|---|---|---|
| TMR | 1200 | 0,929 |
| **fakespot-ai roberta-base** | **1200** | **0,964** |
| desklib | 480 | 0,990 |
| e5-small-lora (verworfen) | 1200 | 0,878 |
| ModernBERT-base-detector (verworfen) | 1200 | 0,879 |

### Wie angezeigt, neu auf ~1 % Fehlalarme kalibriert (99.-Perzentil dieser Suite, Regel 9)

Fair vergleichbar, weil alle drei Backends mit derselben Methode auf derselben Suite neu kalibriert
sind (TMR/desklib-Werte aus EVAL_RESULTS.md, Abschnitt "Schwellen-Empfehlung", nicht deren
Produktions-Schwellen):

| Backend | Bucket | Schwelle | Fehlalarme | KI erkannt |
|---|---|---|---|---|
| TMR | ≥ 120 Wörter | 0,9853 | 1,1 % | 61,9 % |
| **fakespot** | **≥ 120 Wörter** | **0,9988** | **1,1 %** | **90,1 %** |
| desklib | ≥ 120 Wörter | 0,9254 | 1,1 % | 97,4 % |
| TMR | < 120 Wörter | 0,9868 | 1,5 % | 9,6 % |
| **fakespot** | **< 120 Wörter** | **0,9994** | **1,5 %** | **36,0 %** |
| desklib | < 120 Wörter | 0,9566 | 1,8 % | 79,6 % |

fakespot liegt bei gleicher Fehlalarmrate klar zwischen TMR und desklib - bei langen Absätzen mit
90 % Erkennung deutlich näher an desklib (97 %) als an TMR (62 %), bei kurzen Absätzen (< 120 Wörter,
in der Extension ohnehin "unsicher" statt rot, außer mit shortRedFrom) etwa in der Mitte.

### Wie angezeigt je Domäne (fakespot, eigene 99%-Schwelle 0,9988; TMR/desklib zum Vergleich an ihrer
Produktions-Schwelle, aus der "Korrektur"-Tabelle in EVAL_RESULTS.md - nicht exakt dieselbe
Kalibrierungsmethode, aber die einzigen dort verfügbaren Domänen-Werte)

| Domäne | AUROC TMR / fakespot / desklib | FA rot TMR / fakespot / desklib | KI rot TMR / fakespot / desklib |
|---|---|---|---|
| forum | 0,962 / 0,996 / 1,000 | 2 % / 1,0 % / 0 % | 81 % / 94 % / 100 % |
| howto | 0,767 / 0,955 / 0,968 | 20 % / 2,0 % / 2,5 % | 64 % / 75 % / 92,5 % |
| news | 0,940 / 0,958 / 0,991 | 3 % / 2,0 % / 2,5 % | 73 % / 85 % / 90 % |
| reviews | 0,924 / 0,962 / 0,992 | 2 % / 0 % / 0 % | **13 % / 32 % / 70 %** |
| sci_abstract | 0,977 / 0,998 / 0,995 | 0 % / 0 % / 2,5 % | 79 % / 92 % / 95 % |
| wikipedia | 0,995 / 0,985 / 0,999 | 1 % / 2,0 % / 0 % | 92 % / 95 % / 97,5 % |

fakespot verbessert TMRs schwächste Domäne (howto: AUROC 0,767 → 0,955, Erkennung 64 % → 75 % bei
weniger als einem Zehntel der Fehlalarme) deutlich. `reviews` bleibt für alle drei Modelle die
schwierigste Domäne (kurze, informelle Yelp/IMDb-Texte) - fakespot verbessert TMR hier zwar spürbar
(13 % → 32 %), bleibt aber weit hinter desklib (70 %).

### Erkennung je Generator (fakespot, an der 0,9988-Schwelle)

| Generator | fakespot erkannt |
|---|---|
| gpt4 / gpt4o | 96,7 % |
| llama3-70b | 91,1 % |
| mixtral-8x7b | 89,3 % |
| gemma2-9b-it | 85,7 % |
| cohere | 71,4 % |
| gpt-3.5-turbo | 68,8 % |

Ähnliches Muster wie TMR (schwächer bei Cohere/älterem GPT-3.5), aber auf höherem Niveau - kein
Generator unter 68 %, TMR fiel bei gemma2-9b-it auf 68 % und lag im Schnitt niedriger.

### Latenz (CPU, PyTorch, `benchmark_latency.py`, 500-Zeichen-Text; gemessen ohne parallel laufenden
Python-Prozess, siehe oben)

| Backend | Ladezeit (kalt) | Batch=1 | Batch=8 | Batch=25 | RSS nach Laden |
|---|---|---|---|---|---|
| TMR | 1,83 s | 80 ms/Text | 45 ms/Text | 44 ms/Text | 917 MB |
| **fakespot roberta-base** | 1,78 s | 76 ms/Text | 49 ms/Text | 45 ms/Text | 917 MB |
| desklib (aus EVAL_RESULTS.md, gleiche Methodik) | - | ~1,3-2,3 s/Text | - | - | ~800 MB |

fakespot ist in Ladezeit, Latenz und RAM praktisch identisch zu TMR (beide RoBERTa-base, 125M
Parameter) - erwartbar, da gleiche Architektur/Größenklasse. e5-small-lora und ModernBERT-base wurden
wegen der schwachen Genauigkeit nicht mehr separat auf Latenz gemessen (e5-small wäre schneller als
TMR, ModernBERT-base langsamer wegen 22 statt 12 Layern - beide für die Empfehlung irrelevant).

## Warum e5-small-lora und ModernBERT-base verworfen wurden

- **e5-small-lora**: AUROC 0,878 (schlechter als TMR). Bei der auf 1 % Fehlalarme kalibrierten
  Schwelle (0,961) werden nur noch **17-19 %** der KI-Texte erkannt - das Modell ist auf dieser Suite
  schlecht kalibriert (schon ein neutraler Beispielsatz wie "The quick brown fox..." bekam im
  Kurztest 92,6 % AI-Score). RAID-Training (viele offene/ältere Modelle) generalisiert offenbar
  schlecht auf die aktuelleren Generatoren dieser Suite.
- **ModernBERT-base-detector**: AUROC 0,879. Scores saturieren nah an 1,0 (99%-Schwelle rundet auf
  1,0000), Erkennung bei 1 % FA nur **~31 %**. Trainiert auf einem engen Datensatz (Kaggle-DAIGT,
  Schüleraufsätze) - generalisiert schlecht auf die 6 Domänen dieser Suite. ModernBERT als
  Architektur ist technisch vielversprechend (von transformers.js unterstützt, effizient), aber
  dieser konkrete Checkpoint ist für unseren Anwendungsfall nicht geeignet; ein auf breiteren Daten
  (z. B. RAID oder MAGE-ähnlich) nachtrainiertes ModernBERT-base könnte ein Kandidat für eine
  spätere Runde sein.

## Empfehlung

**fakespot-ai/roberta-base-ai-text-detection-v1** als dritter Modell-Eintrag in `extension/models.js`
(Umsetzung ist ein eigenes WP, hier nur die Grundlage):

- **Browser-Einbindung**: fertiges ONNX von [`MedAliFarhat/ai-text-detector-onnx`](https://huggingface.co/MedAliFarhat/ai-text-detector-onnx)
  (Apache-2.0, `sha 0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc`, ausdrücklich für transformers.js
  gebaut - `onnx/model_quantized.onnx`, 125 MB int8). Genau wie beim TMR-Eintrag: `repo`/`revision`
  pinnen, `marker: "onnx/model_quantized.onnx"`, `download: "125 MB"`. **Kein** `desklib_build.js`-
  artiger Umwandlungsschritt nötig - einfachster der drei Fälle im aktuellen Katalog.
- **Schwellen** (abgeleitet aus der 99%-Perzentil-Kalibrierung dieser Suite, wie ursprünglich bei
  desklib - Feinkalibrierung/Kreuzvalidierung ist WP-07-Aufgabe):
  - `reliableWords: 120` (Konvention beibehalten)
  - `redFrom ≈ 0,999` (≥ 120 Wörter: ~1,1 % Fehlalarme, ~90 % erkannt)
  - `shortRedFrom ≈ 0,999` (< 120 Wörter: ~1,5 % Fehlalarme, ~36 % erkannt) - schwach, aber besser als
    TMRs "nie rot" unter reliableWords; alternativ wie TMR ganz weglassen, wenn 36 % Erkennung als zu
    unzuverlässig gilt. Empfehlung: setzen, mit dem Wissen, dass es deutlich hinter desklib
    zurückbleibt.
  - `yellowFrom`: in dieser Messung nicht kalibriert (kein Fehlalarm-Ziel für Gelb definiert) -
    vorläufig z. B. 0,90 (analog TMRs Abstand yellow→red von ~0,03, hier großzügiger wegen der
    steilen Score-Verteilung nahe 1,0), WP-07/Folgemessung sollte das mit echten Gelb-FA-Zahlen
    prüfen.
- **Rolle**: als schnelle Alternative zu TMR (gleiche Latenz-/Größenklasse, ~125 MB, ~45-80 ms/Text),
  aber mit spürbar besserer Trennschärfe (AUROC 0,964 vs. 0,929) und deutlich weniger falschen Alarmen
  bei gleicher Erkennungsrate - besonders auf `howto`, wo TMR bisher am schwächsten ist. Bleibt aber
  klar hinter desklib zurück (v. a. `reviews`-Domäne und kurze Absätze) - ersetzt desklib als
  genaueste Option nicht, sondern verbessert die schnelle Option.

## Einschränkungen

- fakespot-ai dokumentiert seine Trainingsdaten nicht im Detail (nur Verweis auf ein GitHub-Repo ohne
  konkrete Quellenliste) - anders als bei TMR/desklib ist unklar, ob/wie stark Overlap mit
  MAGE/M4GT/HC3 (unseren Eval-Quellen) besteht. Die AUROC-Zahlen könnten dadurch optimistisch sein,
  wie bei den anderen Modellen bereits in EVAL_RESULTS.md vermerkt.
- Die Modellkarte empfiehlt eine `clean_text`-Vorverarbeitung (Markdown/Whitespace-Normalisierung) für
  bessere Ergebnisse; diese Messung nutzt rohen Fließtext ohne diese Bereinigung (wie auch TMR/desklib
  hier ohne Sonderbehandlung laufen) - die Eval-Suite besteht aus bereits bereinigtem Fließtext ohne
  Markdown, der Effekt dürfte daher klein sein, ist aber nicht separat geprüft.
- `reviews`-Domäne bleibt schwach (32 % erkannt bei fakespot) - wer stark auf Yelp/IMDb-artige Inhalte
  scannt, sollte hier keine hohe Erkennungsrate erwarten, unabhängig vom gewählten Backend.
- Schwellen sind aus derselben Stichprobe abgeleitet, mit der sie bewertet wurden (keine
  Kreuzvalidierung wie bei WP-07 für TMR/desklib) - vor einer Übernahme in `extension/models.js`
  lohnt sich dieselbe Kreuzvalidierung, die WP-07 für TMR/desklib durchgeführt hat.
- ShantanuT01/gradient-ai-text-detector wurde nicht gemessen (Zeitbudget, Größenziel klar verfehlt),
  behauptet aber selbst eine bessere OOD-AUROC als desklib - falls eine spätere Runde noch näher an
  desklib-Qualität will und 400+ MB akzeptabel sind, wäre das ein Kandidat für eine echte Messung.
- Wie bei der breiteren Eval-Suite generell: kein Claude/Gemini als Generator, Quelldaten teils vor
  2023, TMR/desklib/fakespot könnten Teile der Quell-Datensätze im eigenen Training gesehen haben.

## ONNX-Abgleich und Einbindung (WP-09)

Anschluss an WP-06: Bevor fakespot als dritter Eintrag in `extension/models.js` landet, muss geprüft
werden, ob das fertige Dritt-ONNX (`MedAliFarhat/ai-text-detector-onnx`, nicht vom Modell-Ersteller
selbst gebaut) dieselben Gewichte/Labels wie das PyTorch-Original liefert und ob die Ampel (Regel 9,
`orchestration/README.md`) sich dadurch nennenswert ändert.

### Label-Zuordnung geprüft

`config.json` von Original und ONNX sind identisch: `id2label = {"0": "Human", "1": "AI"}`,
`label2id = {"AI": 1, "Human": 0}` - keine vertauschten Klassen. `offscreen.js` findet mit seiner
Regex (`/^(ai|machine|generated)$/i`) korrekt Index 1. `tokenizer_config.json` nennt
`tokenizer_class: "RobertaTokenizer"` - bereits in `offscreen.js` (`TOKENIZER_CLASSES`) unterstützt,
keine Änderung an `offscreen.js` nötig (einfachster der drei Katalog-Fälle, wie erwartet).

### Methodik (`training/compare_onnx.py`, neu)

Lädt beide Modelle (ONNX per `onnxruntime` + `transformers`-Tokenizer, PyTorch-Original per
`transformers`) und wertet sie auf derselben `eval_suite.jsonl` (1200 Texte) mit **identischer
Vorverarbeitung** aus: `clip_text()` (Python-Nachbau von `content.js` `clipText`, 2000 Zeichen,
bevorzugt am Satzende gekürzt - wie beim TMR-Eintrag) gefolgt von Tokenizer-Truncation auf 512 Tokens
(`offscreen.js`, `maxTokens`). Wichtig: Die in WP-06 erzeugten PyTorch-Rohscores
(`eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`) wurden **ohne** `clipText`
erzeugt (nur Tokenizer-Truncation) - 31 % der Suite-Texte sind länger als 2000 Zeichen, ein direkter
Vergleich gegen diese alten Scores hätte also auch den clipText-Effekt mitgemessen. Deshalb rechnet
`compare_onnx.py` die PyTorch-Referenz mit identischer Vorverarbeitung frisch mit, für einen sauberen,
isolierten ONNX-vs-PyTorch-Vergleich.

### Ergebnis: ONNX vs. PyTorch (n=1200, gleiche Vorverarbeitung)

| Metrik | Wert |
|---|---|
| AUROC ONNX | 0,9554 |
| AUROC PyTorch (mit clipText) | 0,9598 |
| Pearson-Korrelation der Scores | 0,9819 |
| Mittlere Abweichung \|ONNX − PyTorch\| | 0,0369 |
| Median Abweichung | 0,0017 |
| Max. Abweichung | 0,5198 (Einzelfall) |
| Abweichung > 0,01 | 458/1200 Texte (38,2 %) |
| Abweichung > 0,05 | 245/1200 Texte (20,4 %) |
| Nur clipText-Effekt (PyTorch mit vs. ohne, gleiches Modell) | mittlere Abweichung 0,0247, max 0,9395 |

Die int8-Quantisierung des Dritt-ONNX bewegt einen spürbaren Teil der Scores messbar (AUROC 0,4
Punkte niedriger, ~38 % der Texte weichen um mehr als 0,01 ab, einzelne Ausreißer bis 0,52) - **aber**
die Scores dieses Modells ballen sich ohnehin nahe 1 (siehe WP-06), und genau dort, wo die
Produktions-Schwelle liegt (~0,999), bleiben ONNX und PyTorch praktisch deckungsgleich:

| Kandidaten-Schwelle (redFrom, ≥120 Wörter) | ONNX: FA / erkannt | PyTorch: FA / erkannt | Delta FA / erkannt |
|---|---|---|---|
| 0,9990 | 1,1 % / 89,5 % | 1,1 % / 89,5 % | 0,0 / 0,0 Punkte |
| 0,9994 | 0,6 % / 88,2 % | 0,6 % / 87,6 % | 0,0 / 0,6 Punkte |
| 0,9988 | 1,5 % / 90,3 % | 1,3 % / 89,9 % | 0,2 / 0,4 Punkte |
| 0,9966 | 3,2 % / 93,5 % | 3,0 % / 93,3 % | 0,2 / 0,2 Punkte |

**Einordnung:** An jeder realistischen Kandidaten-Schwelle liegt die Abweichung bei Fehlalarmen und
Erkennung wie angezeigt bei höchstens 0,2 bzw. 0,6 Prozentpunkten - deutlich innerhalb der
Stichproben-Unsicherheit dieser Suite (vgl. Kreuzvalidierungs-Spannen unten, die für sich genommen
schon mehrere Prozentpunkte betragen). Die Ampel ändert sich durch die ONNX-Umwandlung **nicht
nennenswert** - **Einbindung freigegeben** (Abnahmekriterium erfüllt).

### Kreuzvalidierte Schwellen (ONNX-Scores, Methode wie `crossval_thresholds.py`, WP-07)

`crossval_thresholds.py` um `--backend fakespot` erweitert, liest jetzt `data/eval_scores_fakespot_suite.jsonl`
(die ONNX-Scores aus `compare_onnx.py` - **genau die Zahlen, die die Extension tatsächlich sähe**, wie
vom Brief gefordert, nicht die PyTorch-Referenz). 200 stratifizierte Hälfte/Hälfte-Splits, Ziel 1 % FA:

| Bucket | Kreuzvalidierte Schwelle (Median, 5.–95. Perzentil) | FA auf Testhälfte (Median, 5.–95. Perzentil) | KI erkannt (Median, 5.–95. Perzentil) |
|---|---|---|---|
| ≥120 Wörter (redFrom) | 0,9989 (0,9982–0,9995) | 1,29 % (0–3,45 %) | 89,5 % (86,6–92,9 %) |
| <120 Wörter (shortRedFrom) | 0,9994 (0,9987–0,9995) | 1,45 % (0–7,25 %) | 34,4 % (28,1–43,8 %) |

Kein "aktueller Wert" zum Vergleich (Modell ist neu) - anders als bei TMR/desklib in WP-07 gibt es hier
keine Spalte "aktuelle Schwelle auf Testhälften".

**Gewählte Werte für `extension/models.js`:** `redFrom = 0,999` (innerhalb der kreuzvalidierten Spanne,
deckt sich mit der einmaligen WP-06-Schätzung 0,9988), `shortRedFrom = 0,9994` (Median der
Kreuzvalidierung). `yellowFrom = 0,95` nicht kreuzvalidiert (kein Fehlalarm-Ziel für Gelb definiert,
wie bei TMR/desklib rein informativ) - bei 0,95 sind noch 12,8 % der menschlichen Scores "gelb oder
höher", bei 0,999 nur noch 1,5 %.

### Vergleichstabelle TMR / fakespot / desklib, wie angezeigt (identische Methode + Suite)

Aus den crossval-Medianen dieses WP und aus `EVAL_RESULTS.md`, "Schwellen absichern" (WP-07,
gleiche Methode, gleiche Suite):

| Backend | Bucket | Kreuzvalidierte Schwelle (Median) | FA auf Testhälfte (Median, 5.–95. Perz.) | KI erkannt (Median, 5.–95. Perz.) |
|---|---|---|---|---|
| TMR | ≥120 W. (redFrom) | 0,9850 | 1,29 % (0,43–3,45 %) | 65,3 % (55,2–75,3 %) |
| **fakespot** | **≥120 W. (redFrom)** | **0,9989** | **1,29 % (0–3,45 %)** | **89,5 % (86,6–92,9 %)** |
| desklib | ≥120 W. (redFrom) | 0,9466 | 1,29 % (0–3,45 %) | 97,1 % (95,4–98,7 %) |
| TMR | <120 W. (shortRedFrom) | 0,9867 | 2,90 % (0–5,87 %) | 13,3 % (4,7–23,4 %) |
| **fakespot** | **<120 W. (shortRedFrom)** | **0,9994** | **1,45 % (0–7,25 %)** | **34,4 % (28,1–43,8 %)** |
| desklib | <120 W. (shortRedFrom) | 0,9758 | 1,45 % (0–5,87 %) | 78,1 % (64,1–87,5 %) |

Bestätigt WP-06: fakespot liegt bei identischer Fehlalarmrate klar zwischen TMR und desklib, bei
langen Absätzen deutlich näher an desklib (89,5 % vs. 97,1 %) als an TMR (65,3 %); bei kurzen
Absätzen etwa in der Mitte (34,4 % gegen TMRs 13,3 % und desklibs 78,1 %). Mit den fest gewählten
Werten (0,999 / 0,9994 statt der Crossval-Mediane) liegt fakespot "wie angezeigt" gesamt bei ~1,2 %
Fehlalarmen und 77,8 % erkannten KI-Texten (alle Längen zusammen); je Domäne: forum 1,0 %/93,0 %,
howto 3,0 %/73,0 %, news 2,0 %/85,0 %, reviews 0 %/31,0 %, sci_abstract 0 %/91,0 %,
wikipedia 1,0 %/94,0 % (ONNX-Scores, gewählte Schwellen). `reviews` bleibt wie bei allen drei
Backends die schwächste Domäne.

### Einbindung

fakespot als dritter Eintrag in `extension/models.js` (Schlüssel `fakespot`, Titel „Ausgewogen –
fakespot"): `repo: "MedAliFarhat/ai-text-detector-onnx"`, `revision` gepinnt auf
`0c809a8de6e600ec2fd0fcdeb595a5461d93e8dc` (laut Modellkarte "für transformers.js gebaut"),
`maxTokens: 512`/`maxChars: 2000` (wie TMR, gleiche Architektur/Größenklasse), Schwellen wie oben.
**Kein Code in `offscreen.js` geändert** - die vorhandene generische Katalog-/Tokenizer-/Label-Logik
deckt fakespot bereits vollständig ab (siehe Label-Prüfung oben). `desklib` bleibt Default-Modell,
`fakespot` ist eine dritte, zusätzliche Wahl.

**Server-Abschnitt:** `server/shim_server.py` um `fakespot`-Backend ergänzt (fast identischer Code zu
`tmr`: `AutoModelForSequenceClassification` + Softmax + `ai_index`-Heuristik, keine Sonderbehandlung
wie bei desklibs eigener Pooling-Klasse nötig) - geringer Aufwand, deshalb mitgenommen. Revision dort:
`f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db` (PyTorch-Original, letzter Commit).

**Lizenz:** `extension/THIRD_PARTY_NOTICES.md` um den fakespot-Eintrag ergänzt (Apache-2.0 für
Original und Dritt-ONNX, Basismodell RoBERTa-base MIT).

### Einschränkungen (zusätzlich zu WP-06)

- Die Abweichung zwischen ONNX und PyTorch ist bei mittleren Scores (weder klar Mensch noch klar KI)
  teils erheblich (Median 0,002, aber einzelne Texte bis 0,52) - für die Ampel unerheblich, weil dort
  ohnehin "unsicher"/"gelb" gilt statt einer harten Entscheidung, aber relevant für jeden, der die
  rohen Prozentzahlen im Popover unreflektiert vergleicht.
- Kreuzvalidierte Schwellen für den "kurz"-Bucket stützen sich auf nur ~130 Mensch-Scores pro
  Trainhälfte (wie bei TMR/desklib in WP-07) - die Spanne (0–7,25 % FA) ist entsprechend breit, ernst
  zu nehmen.
- ONNX-Abgleich lief auf CPU mit `onnxruntime` (Python), nicht mit `onnxruntime-web`/WASM wie im
  Browser - eine WASM-spezifische Abweichung (andere Kernel-Implementierung) ist theoretisch möglich,
  aber laut den TMR/desklib-Erfahrungen in diesem Repo bisher nie beobachtet worden.
- Manueller Lade-Test (`@huggingface/transformers` in Node, gleiche Optionen wie `offscreen.js`:
  `dtype: "q8"`, gepinnte Revision) bestätigt: Tokenizer und Modell laden aus dem realen ONNX-Pfad,
  `id2label`/`aiIndex` werden korrekt erkannt, Inferenz liefert plausible Wahrscheinlichkeiten in
  [0,1]. Die beiden Testsätze dafür waren allerdings selbst von einem Sprachmodell formuliert (dieser
  Bericht) und daher ungeeignet als "menschliche" Gegenprobe - beide kamen entsprechend hoch heraus
  (0,997 und 0,9999). Aussagekräftig ist die 1200-Text-Suite oben, nicht dieser Rauchtest.
