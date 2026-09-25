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

## Quellen für die Sperrliste (Stand 2026-09-25)

Es gibt keine offizielle API „sensible Seiten“. Die Liste wird deshalb beim Build aus mehreren Quellen
erzeugt und ausgeliefert (`npm run build:blocklist`) – nicht zur Laufzeit abgefragt, sonst verriete die
Abfrage das Surfverhalten.

### Eingebaut

| Quelle | Inhalt | Lizenz | Einträge | davon neu* |
|---|---|---|---|---|
| [UT1-Blacklists](https://dsi.ut-capitole.fr/blacklists/index_en.php) `bank` | Online-Banking weltweit | CC BY-SA 4.0 | 6.645 | 6.579 |
| UT1-Blacklists `webmail` | Webmail weltweit | CC BY-SA 4.0 | 404 | 402 |
| [FDIC BankFind](https://api.fdic.gov/banks/docs/) | alle aktiven US-Banken (`WEBADDR`) | gemeinfrei (US-Bundesbehörde) | 4.146 | 3.290 |
| [NCUA Call Report Data](https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data) | alle US-Credit-Unions (`FS220D.txt`, Feld `Acct_891` = Website) | gemeinfrei (US-Bundesbehörde) | 3.834 | 2.907 |
| [Wikidata](https://query.wikidata.org/) | Banken in DE/AT/CH/UK/US mit offizieller Website (P856) | CC0 1.0 | 1.314 | 871 |
| handverlesen (`CURATED`) | Mail, Zahlungsdienste, Neobanken, Behördenportale mit Login | – | 87 | 41 |

\* nicht schon durch eine vorherige Quelle (oder deren Eltern-Domain) abgedeckt. Ergebnis:
**14.090 Domains**, 233 KB. Die Zahlen gibt das Skript bei jedem Lauf aus und schreibt sie in
`generated/blocklist.js` (`sources`).

**Lizenzfolge:** Weil UT1 unter CC BY-SA 4.0 steht, steht die erzeugte Gesamtliste ebenfalls unter
CC BY-SA 4.0 (Namensnennung in `THIRD_PARTY_NOTICES.md`, im Dateikopf und in den Einstellungen). Die
übrigen Quellen (gemeinfrei, CC0) verlangen nichts, werden aber trotzdem genannt. Die Extension selbst
bleibt davon unberührt – ShareAlike gilt nur für die Daten.

Details je Quelle:

- **UT1:** offizielles tar.gz (nicht der [GitHub-Spiegel](https://github.com/olbat/ut1-blacklists)),
  wird täglich gepflegt. Enthält viele Nicht-Banken (Händler, Airlines, Zentralbanken, Fachmedien,
  `purdue.edu` …) → Ausschlussliste `NEVER_BLOCK`, siehe „Pflege“. UT1 `financial` bewusst nicht: das
  sind überwiegend Börsen-/Finanz-*News*.
- **NCUA:** Quartals-Zip (~8 MB), erscheint ca. 2 Monate nach Quartalsende; das Skript nimmt das
  neueste vorhandene (probiert bis zu fünf Quartale zurück). 3.881 von 4.299 Credit Unions haben eine
  Website eingetragen.
- **Wikidata:** schließt Zentral-, Förder- und Abwicklungsbanken per Klasse aus (Lesetext, keine
  Kundenkonten) sowie aufgelöste Banken (P576). Übernommen werden nur Websites ohne Pfad bzw. mit
  reinem Sprachpfad (`/en/`) – Einträge wie `stadt.de/sparkasse`, `notar.at/…`, `web.archive.org/…`
  oder eine Bar-Website für eine historische Bankfiliale würden sonst ganze fremde Domains sperren.
  Bringt vor allem Sparkassen, Volks- und Raiffeisenbanken (DE hat mit 702 die meisten Treffer).
- **Nicht übernommen:** `web.de`, `gmx.net` usw. (Portale mit Nachrichten; nur deren Mail-Subdomains
  stehen in `CURATED`), Plattformen, die in FDIC/NCUA als Bank-Website stehen (`facebook.com`,
  `sites.google.com`, `wixsite.com`).

### Geprüft, nicht eingebaut

- **FCA Financial Services Register** (UK): API frei, aber mit Registrierung und API-Key
  ([Developer Portal](https://register.fca.org.uk/Developer/s/), 50 Anfragen/10 s) – für ein
  Build-Skript im Repo unpraktisch (Key müsste jeder Maintainer selbst beantragen). Nutzungsbedingungen
  für das Weitergeben der Daten noch nicht geprüft. UK-Abdeckung derzeit: UT1 (~60 `.uk`), Wikidata
  (71 Banken), handverlesene Großbanken.
- **BaFin-Unternehmensdatenbank** (DE): CSV-Export vorhanden, enthält aber **keine Websites** (nur Name,
  BAK-Nr., LEI, Adresse) – geprüft am 2026-09-25. Nur über Namensabgleich mit anderen Quellen nutzbar.
- **Chrome Topics API Override-Liste** (~50k Top-Hosts mit Kategorie): nur aus dem Chrome-Profil
  extrahierbar, Lizenz unklar.
- **Krankenkassen, Versicherer, Broker, Krypto-Börsen:** keine saubere offene Liste gefunden; die
  Seiten haben viel Lesetext, Login-Bereiche fängt die Passwortfeld-Heuristik ab.
- Nicht mehr gepflegt: Shalla-Liste (2020 eingestellt), DMOZ/Curlie-Dumps.

### Pflege

1. `npm run build:blocklist` – bricht ab, wenn eine Quelle fehlt oder weit unter der Mindestgröße
   liegt (`MIN_COUNT`).
2. Diff von `extension/generated/blocklist.js` durchsehen. Die Domains stehen sortiert in *einem*
   String, `git diff --word-diff-regex='[^\\n]+'` zeigt einzelne hinzugekommene/entfernte Domains.
3. Gelegentlich (z.B. vor einem Release) auf versehentlich gesperrte Content-Seiten prüfen:
   `node scripts/build-blocklist.mjs --dump <ordner>` schreibt die Domains je Quelle; mit der
   [Tranco-Liste](https://tranco-list.eu/) (Top 100.000) abgleichen und Nicht-Banken in
   `NEVER_BLOCK` eintragen. Stand der letzten Durchsicht: 2026-09-25 (311 UT1-Einträge in den Top
   100.000, davon ~65 ausgeschlossen). Tranco selbst wird nicht ausgeliefert.

Keine Liste ist vollständig → ergänzend die Heuristik auf der Seite (Passwort-/Kreditkartenfeld →
nicht automatisch scannen).

## Offene Fragen / nicht verifiziert

- Exaktes Trainingsdaten-Schema für Laya-Fine-Tuning (Spaltennamen etc.) nicht öffentlich klar dokumentiert — muss beim Öffnen des Kaggle-Notebooks geprüft werden.
- Mehrere `laya-serve`-Implementierungen von unterschiedlichen Maintainern im Umlauf — welche aktuell am gepflegtesten ist, muss vor Festlegung geprüft werden (Sterne/Issues/letzter Commit).
- Alle Angaben aus Web-Recherche (Sept. 2026), nicht aus eigener Code-Inspektion — vor Produktivnutzung Original-READMEs/Code selbst gegenlesen.
