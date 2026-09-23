# Ressourcen: Jev / Laya / AI-Content-Marker-Extension

Stand: 2026-09-23. Recherchequellen, keine garantiert stabilen Details (alles sehr neu, Stand Sept. 2026).

## Hintergrund

- **Jev** (TypeSafe AI, Gründer Diogo Almeida, ehem. OpenAI/RLHF): proprietäres "System-1"-Entscheidungsmodell.
  Kein Token-für-Token-Generator, sondern ein einzelner Forward-Pass über `state + questions` -> `choice` / `score` / `noul` (kalibrierte Wahrscheinlichkeit).
  - TechCrunch-Artikel: https://techcrunch.com/2026/09/18/a-new-kind-of-ai-model-from-a-chatgpt-inventor-is-thrilling-developers/
  - Übersicht/Benchmarks: https://www.largitdata.com/en/blog/jev-system-one-model-open-source-benchmark/
  - Community: https://www.jevai.org/ , Awesome-Listen: https://github.com/AnotiaWang/awesome-jev , https://github.com/kraayenjon/awesome-jev

- **Laya** (ConvAI Innovations): Open-Source-Pendant zu Jev, Apache-2.0.
  - Repo: https://github.com/NandhaKishorM/laya
  - Hugging Face: https://huggingface.co/convaiinnovations/laya
  - Checkpoints: `laya` (ModernBERT-large, 421M, EN, 512 ctx), `laya-multilingual` (mmBERT-base, 322M, 100+ Sprachen, 1024 ctx), `laya-typed-decisions` (fine-tuned Beispiel-Checkpoint, 0.766 Acc. vs. 0.36 Zero-Shot)
  - Installation: `pip install laya`
  - **Wichtig:** Zero-Shot-Genauigkeit der Basis-Checkpoints ist laut eigener Doku nahe Zufallsniveau. Empfehlung der Maintainer: "treat Laya as a fast base to specialise, not as a zero-shot decision engine."
  - Fine-Tuning: Kaggle-Notebook `notebooks/laya_finetune_typed_decisions_2xT4_kaggle.ipynb`, läuft auf kostenlosen 2x T4 GPUs, RLCD/GRPO-artiges Training, ~4-5h für ~30k Fragen/4 Epochen. Doku: `docs/finetune_browser_agent.md` (Beispiel-Walkthrough für Spezialisierung).

- **laya-serve**: lokaler HTTP-Server, bildet Jevs Wire-Format nach (`POST /v1/systemone`, `GET /v1/models`, `GET /healthz`).
  - Repos (mehrere Implementierungen): https://github.com/stiermid/laya-serve , https://github.com/ouijan/laya-serve , https://github.com/noahbclarkson/laya-server , https://github.com/exfly/laya-jev-compatible-server
  - Install: `pip install "laya-serve[inference]"`
  - Env-Vars: `LAYA_SERVE_BACKEND=laya`, `LAYA_SERVE_PRELOAD=true`, `LAYA_SERVE_SERVING_MODEL=laya-english`, `LAYA_SERVE_EXTRA_MODELS=...`
  - Request/Response-Format identisch zur echten Jev-API: `{state, questions}` -> `{model, answers, usage}`.
  - Fehlerformat: `{"error": {"message", "field"}}`, Jev-Statuscodes (401, 422, 429/529 Retry-After, 500).

## Architektur-Referenz: TypeSafe AdBlock (MIT-Lizenz)

Repo: https://github.com/realZachi/typesafe-adblock — fast 1:1 übertragbares Muster (DOM-Elemente -> Jev-Noul-Abfrage -> Schwellenwert -> visueller Effekt), nur bisher für Werbe-Erkennung statt KI-Text-Erkennung.

- Manifest V3, Content-Script + Background-Service-Worker + Popup.
- Content-Script sammelt Kandidaten (Heuristiken: Tags/Klassen/Text-Label), baut kompaktes JSON (Tag, Klassen, Text-Auszug bis 220 Zeichen, Link-Hosts, Form/Größe).
- Ein `POST /v1/systemone`-Call pro Batch (max. 30 Kandidaten), ein `noul`-Frage pro Kandidat, debounced 600ms.
- Response: Wahrscheinlichkeit pro Element.
- **Modi:** "Remove" oder **"Highlight-only" (Debug-Overlay mit Wahrscheinlichkeits-Anzeige)** — letzteres ist fast exakt das gewünschte Grundverhalten für unseren Fall (nur Glow-Rahmen statt Entfernen).
- Popup: On/Off, Schwellenwert-Slider (0.30–0.95, Default 0.70), Modus-Wahl, Animation-Toggle, Rescan-Button (Cache leeren).
- Übertragen wird nur Hostname, Titel, Kandidaten-Felder — kein volles HTML, kein Server-Speichern.
- Design-Prinzip im Repo: "Keep the split intact: rules and thresholds in code, only the semantic judgment goes to the model."
- Lokaler Test-Harness: `test/harness.html` + lokaler Relay-Server für Offline-Tests.

## Datensätze für Fine-Tuning (Human vs. AI-Text)

- **HC3** (Human ChatGPT Comparison Corpus): ~27k Frage/Antwort-Paare, Mensch vs. ChatGPT, Domänen: Reddit, Medizin, Finanzen, Recht.
- **RAID**: größter/umfassendster Benchmark-Datensatz, >10 Mio. Dokumente, 11 LLMs, 11 Genres, 4 Decoding-Strategien, 12 adversariale Angriffe (Paraphrasierung etc.) — HF: https://huggingface.co/datasets/liamdugan/raid
- Paper zu RAID: https://arxiv.org/html/2405.07940v1

## Offene Fragen / nicht verifiziert

- Exaktes Trainingsdaten-Schema für Laya-Fine-Tuning (Spaltennamen etc.) nicht öffentlich klar dokumentiert — muss beim Öffnen des Kaggle-Notebooks geprüft werden.
- Mehrere `laya-serve`-Implementierungen von unterschiedlichen Maintainern im Umlauf — welche aktuell am gepflegtesten ist, muss vor Festlegung geprüft werden (Sterne/Issues/letzter Commit).
- Alle Angaben aus Web-Recherche (Sept. 2026), nicht aus eigener Code-Inspektion — vor Produktivnutzung Original-READMEs/Code selbst gegenlesen.
