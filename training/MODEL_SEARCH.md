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
