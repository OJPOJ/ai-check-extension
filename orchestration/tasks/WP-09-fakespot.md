# WP-09 · fakespot als drittes Modell einbinden (TODO Punkt 2)

## Ausgangslage
`training/MODEL_SEARCH.md` (WP-06): `fakespot-ai/roberta-base-ai-text-detection-v1` (Apache-2.0,
RoBERTa-base, ~125 MB int8, ~45 ms/Text). Auf der Eval-Suite (PyTorch-Original) AUROC 0,964, ≥ 120 Wörter
bei ~1 % Fehlalarmen 90 % erkannt. Fürs Browser-ONNX gibt es `MedAliFarhat/ai-text-detector-onnx`
(Apache-2.0, int8, laut Karte für transformers.js) – von einem Dritten, **nicht** gegen das Original geprüft.
Die Scores ballen sich nahe 1: Fehlalarme ≥ 120 Wörter 3,5 % bei 0.99, 0,9 % bei 0.999, 0,2 % bei 0.9995.

## Umfang
1. **ONNX-Abgleich** (`training/`, neues Skript z.B. `compare_onnx.py`): Das Dritt-ONNX (Revision
   pinnen) mit onnxruntime auf der ganzen Eval-Suite
   (`C:/_programme/DS/aivsai/training/data/eval_suite.jsonl`) laufen lassen, gleiche Tokenisierung/
   Kürzung wie die Extension (maxChars/maxTokens wie TMR: 2000 Zeichen, 512 Tokens – `content.js`
   `clipText`, `offscreen.js`). Vergleich zu den PyTorch-Rohscores
   (`training/data/eval_scores_fakespot-ai_roberta-base-ai-text-detection-v1_suite.jsonl`): Korrelation,
   max./mittlere Abweichung, und vor allem: ändert sich die Ampel (FA/Erkennung wie angezeigt) an den
   Kandidaten-Schwellen? Prüfen, dass das ONNX wirklich dieselben Gewichte/Labels hat (`id2label`,
   welche Klasse ist KI – `offscreen.js` sucht `ai|machine|generated`, sonst Index 1!).
   Wenn das Dritt-ONNX deutlich abweicht oder zweifelhaft ist: Alternativen bewerten (eigener Export per
   `optimum` + Quantisierung zum Vergleich; Hosting-Frage im Bericht, nicht selbst hochladen).
2. **Schwellen kreuzvalidieren** mit den Scores, die die Extension tatsächlich sähe (ONNX), Methode wie
   `training/crossval_thresholds.py` (WP-07): `redFrom` (≥ 120 Wörter), `shortRedFrom` (< 120), dazu
   ein sinnvolles `yellowFrom`. Prüfe, ob die Arbeit auf Logit-Basis stabiler wäre; die Extension
   speichert Wahrscheinlichkeiten – nur umstellen, wenn es klar nötig ist, und dann als ENTSCHEIDUNG
   begründen (bevorzugt: Wahrscheinlichkeiten behalten).
3. **Einbinden** als dritter Eintrag in `extension/models.js` (Schlüssel z.B. `fakespot`, Titel
   „Ausgewogen – fakespot“), aufgebaut wie `tmr` (fertiges ONNX, `repo`, gepinnte `revision`, `version`,
   `marker`, `download`, `info`, `summary`, `thresholds`, `reliableWords`, `shortRedFrom`, `languages`).
   Sicherstellen, dass `offscreen.js` Modell, Tokenizer und KI-Label korrekt lädt (ggf. minimal anpassen).
   Server-Abschnitt (`server`) nur, wenn `server/shim_server.py` ohne großen Aufwand mitkann – sonst weglassen.
   Kein neuer Standard: desklib bleibt Default.
4. **Lizenz:** Eintrag in `extension/THIRD_PARTY_NOTICES.md` (Modell + ONNX-Umwandlung).
5. **Tests:** Unit-Tests für den neuen Katalogeintrag (`test/unit/config.test.mjs`,
   `test/unit/providers.test.mjs` nach Bedarf). Ein echter Browser-Test mit Download ist nicht nötig, aber
   einmal manuell/Playwright prüfen, dass das Modell im Offscreen-Dokument lädt und plausible Scores liefert,
   wenn machbar (Download 125 MB ok).
6. **Dokumentation:** Abschnitt in `training/MODEL_SEARCH.md` („ONNX-Abgleich und Einbindung“).

## Erlaubte Dateien
`extension/models.js`, `extension/offscreen.js`, `extension/THIRD_PARTY_NOTICES.md`,
`server/shim_server.py` (optional), `training/**` außer `training/build_reference_set.py`,
`test/unit/config.test.mjs`, `test/unit/providers.test.mjs`. Nicht: `content.js`, `config.js`,
`about.html`, `reference-set.js`.

## Abnahme
- ONNX-Abgleich mit Zahlen; Einbindung nur, wenn das ONNX die Ampel nicht nennenswert verändert –
  sonst Einbindung weglassen und klar berichten.
- Kreuzvalidierte Schwellen mit Spanne, wie angezeigt.
- `npm test` grün.
