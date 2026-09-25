# AI Content Flag — Browser-Extension

Bewertet längere Textabsätze auf Webseiten mit einem austauschbaren KI-Text-Klassifikator
und markiert sie als Ampel (grün / gelb / rot) mit Score-Badge. Backend wahlweise lokal
(Standard, kein Cloud-Call), eigener Server/Cloud oder Hugging Face Inference API.
Hintergrund/Architektur: `RESOURCES.md`.

## Produkt-Stand v0.2 (2026-09-24)

- **An/Aus + Scan-Modi:** Master-Schalter (Popup, `Alt+Shift+A`), Badge „AUS“ am Icon.
  Gescannt wird nur „auf Knopfdruck“ (`Alt+Shift+S`), „auf ausgewählten Seiten“ (Default,
  Schalter pro Domain im Popup) oder „auf allen Seiten“. Ohne Freigabe verschickt das
  Content-Script keinen Text.
- **Ampel statt Ja/Nein:** zwei Schwellen (Gelb ab / Rot ab), grün = geprüft und *nicht*
  als KI erkannt (abschaltbar), Prozent-Badge am Absatz, gepunkteter Rahmen während der
  Prüfung. Stufen auch ohne Farbwahrnehmung unterscheidbar (dünn / gestrichelt / kräftig).
- **Popup:** Zähler rot/gelb/grün für die aktuelle Seite, Backend-Status, Skala der
  Schwellen. Icon-Badge zeigt Anzahl roter (sonst gelber) Absätze pro Tab, „!“ bei Fehler.
- **Provider-Abstraktion** (`extension/background.js`, `PROVIDERS`): Lokal
  (`shim_server.py`), Eigener Server (Vertrag `POST {texts, model?} -> {scores}` mit
  optionalem Bearer-Key), Hugging Face Inference API (Label-Mapping automatisch oder
  manuell). Host-Berechtigungen für Remote-Backends werden erst beim Speichern angefragt;
  Tokens liegen in `storage.local` (nicht synchronisiert). Score-Cache pro Provider.
- **Sichtbarer Bereich zuerst:** 5er-Batches, nacheinander verschickt (lokal 1, remote 2
  gleichzeitig). Welche Absätze in den nächsten Batch kommen, wird erst beim Absenden
  entschieden: sichtbare zuerst, dann nach Abstand zum Viewport – ohne Scrollen also von
  oben nach unten, nach einem Scroll springt die Priorität zum neuen Bereich.
- **Lazy-Scan (Default an, abschaltbar):** bewertet nur Absätze bis 1,5 Bildschirmhöhen
  um den sichtbaren Bereich; der Rest wird per `IntersectionObserver` nachgeholt, sobald er
  in die Nähe kommt (Scrollen, Resize, aufgeklappte Inhalte). Spart Rechenzeit/Cloud-Kosten.
- E2E in Chromium (Playwright) gegen echten Shim-Server getestet: Scan-Modi, Toggle,
  dynamisch nachgeladene Absätze, toter Server (fail open), Options-„Verbindung testen“.

## Aktueller Stand (2026-09-23)

- ✅ **Extension (Manifest V3) fertig und manuell getestet:** Content-Script (DOM-Extraktion,
  Caching, MutationObserver), Background-Service-Worker, Options-UI. Eingabefelder/Kurztexte
  werden korrekt nie markiert, Glow (lila, pulsierend) funktioniert.
- ✅ **Zwei Erkennungs-Backends verglichen (Genauigkeit UND Performance),** 100 balancierte
  Beispiele aus HC3-Holdout, CPU-Latenz/RAM für 25er-Batches (= `content.js`-Batch-Größe),
  Details in `training/EVAL_RESULTS.md`:

  | Stufe | Backend | AUROC | Accuracy (beste Schwelle) | 25er-Batch | RAM |
  |---|---|---|---|---|---|
  | **Low** (Default) | TMR (RoBERTa-base, 125M) | 0.911 | 0.830 | ~1,6s | ~900MB |
  | **Medium** | desklib (DeBERTa-v3-large, 430M) | 0.998 | 0.990 | ~2 Min | ~4,65GB |

  Laya zero-shot wurde ebenfalls getestet (AUROC 0.549 — faktisch Münzwurf) und ist deshalb
  aktuell **nicht** in der UI wählbar, bleibt aber im Code vorbereitet — siehe
  "Offen / später" unten.
- ✅ **Backend-Umschalter gebaut:** `server/shim_server.py` spricht ein einheitliches
  Wire-Format, routet aber je nach `model`-Feld zu TMR, desklib (beide lokal) oder Laya
  (Proxy zu `laya-serve`, aktuell ungenutzt). `extension/content.js`/`background.js` mussten
  dafür nicht geändert werden — nur `options.html` hat ein Low/Medium-Dropdown mit Info-Text
  und backend-spezifischem Default-Schwellenwert.
- ⚠️ Zwei handfeste Bugs unterwegs gefunden und gefixt: `laya-serve`s Health-Endpoint heißt
  `/health` nicht `/healthz` (eigene Recherche war falsch); desklibs 2024er Beispielcode
  crasht ungepatcht mit aktuellem `transformers` (`all_tied_weights_keys`-Property-Fix,
  siehe `training/evaluate_backends.py` bzw. `server/shim_server.py`).

## Offen / später

- **Laya-Fine-Tuning:** Datensatz liegt fertig (`training/data/`, 142k Beispiele aus HC3),
  Trainingsschritt selbst noch offen (Kaggle, siehe `training/README.md`). Sobald ein
  fine-getunter Checkpoint existiert: `evaluate_backends.py --backend laya` erneut gegen
  `training/eval_sample.jsonl` laufen lassen und mit TMR/desklib vergleichen — dann ggf.
  als dritte Stufe in `options.html` zurückbringen.

## Roadmap (Stand 2026-09-24, Reihenfolge = Priorität)

1. ✅ **Modell im Browser (v0.3):** Provider „Im Browser“ (Default) – TMR int8 aus
   `onnx-community/tmr-ai-text-detector-ONNX` (Revision gepinnt), per transformers.js im
   Offscreen-Dokument (`extension/offscreen.js`), einmaliger Download ohne Token in den
   Cache-Storage. Gemessen: AUROC 0.908 vs. 0.911 PyTorch, 3/100 Ampelwechsel, ~150 ms/Text
   (WASM, Multithreading via COOP/COEP), Laden ~2 s.
1b. ✅ **desklib im Browser (v0.4):** Modellauswahl unter „Im Browser“: *Schnell – TMR* oder
   *Genau – desklib*. Anlass: TMR markiert sachlichen menschlichen Text massiv als KI
   (englische Wikipedia, 96 Absätze aus 12 Artikeln: TMR 41 rot, desklib 9; im Browser auf
   „Photosynthesis“: TMR 50/80 rot, desklib 3/80). Es gibt kein brauchbares fertiges ONNX
   von desklib, und eigenes Hosting wollten wir vermeiden – deshalb **lädt die Extension
   das Original (`model.safetensors`, 1,74 GB, Revision gepinnt) und quantisiert es beim
   Herunterladen selbst** (`extension/desklib_build.js`, Stream, zeilenweise, ~475 MB
   Ergebnis im Cache). Mitgeliefert wird nur der Rechengraph ohne Gewichte plus
   Bauanleitung (`extension/models/desklib/`, 1,9 MB, erzeugt von
   `scripts/build_desklib_skeleton.py`).
   - Quantisierung: MatMul-Gewichte 8 Bit nur-Gewichte (MatMulNBits, Block 32),
     Embeddings int8 pro Zeile. Das übliche dynamische int8 macht DeBERTa kaputt
     (AUROC 0.998 → 0.973), 8 Bit nur-Gewichte nicht (AUROC 0.998, max. Abweichung 0,01).
   - Gemessen (Ryzen 7 5800U, 8 Threads): Download+Umwandlung ~57 s, Laden ~4 s,
     ~1 s pro Absatz (TMR ~0,15 s). Download läuft weiter, wenn die Einstellungen
     geschlossen werden.
   - Nebenbei gefixt (betraf auch TMR aus v0.3): nach Neustart des Offscreen-Dokuments
     (10 Min. Leerlauf, Browser-Neustart) konnte transformers.js das Modell nicht mehr aus
     dem Cache laden (Tokenizer-Suche ignoriert die Revision; „local + remote aus“ gilt
     als ungültige Konfiguration). Tokenizer wird jetzt selbst aus dem Cache gebaut.
   Lizenzen geprüft (alles MIT bzw. transformers.js Apache-2.0): `extension/THIRD_PARTY_NOTICES.md`.
   HC3 (unser Laya-Datensatz) ist CC-BY-SA-4.0 → bei eigenem Fine-Tuning beachten.
2. **Sperrliste „nie scannen“** (Banking, Mail, …) + Datenschutzerklärung – Web-Store-Pflicht.
3. **Rechtsklick → „Auf KI prüfen“** für markierten Text (kurze Texte, Nicht-`<p>`-Inhalte).
4. **Feedback „Falsch erkannt“** am Absatz → Trainingsdaten fürs eigene Fine-Tuning.
5. **Score-Kalibrierung pro Modell**, damit Schwellen modellübergreifend dasselbe bedeuten.
6. **Deutsch/mehrsprachig:** TMR und desklib sind nur auf Englisch trainiert (deutscher
   Fachtext im Harness: 78 % → gelb, Fehlalarm). Eigenes Fine-Tuning eines
   mehrsprachigen Encoders (z.B. mDeBERTa-v3/XLM-R) ähnlich desklib.
7. **Zurückgestellt:** Hugging-Face-Provider mit echtem Token testen (bisher nur gemockt).

## Quick Start

```powershell
# einmalig: transformers.js + ONNX-Runtime-WASM nach extension/vendor/ kopieren (nicht im Git)
npm install
npm run vendor
```

Dann in Chrome/Edge:

1. `chrome://extensions` öffnen, "Entwicklermodus" aktivieren.
2. "Entpackte Erweiterung laden" → Ordner `extension/` auswählen. Die Einstellungen öffnen
   sich automatisch → Modell wählen und „Herunterladen“ klicken (einmalig, von Hugging Face,
   kein Token): TMR 126 MB, desklib 1,7 GB (wird im Browser auf ~475 MB umgewandelt).
3. Auf das Extension-Icon klicken → Schalter „Diese Seite automatisch scannen“ oder
   „Diese Seite jetzt scannen“.
4. Für den Test-Harness: bei der Extension unter "Details" → "Auf Datei-URLs zulassen"
   aktivieren, dann `test/harness.html` öffnen.

Optional – Server-Backends (desklib, oder TMR per PyTorch), Provider „Lokal“:

```powershell
cd server
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py
```

## Ordnerstruktur

- `server/` — `shim_server.py` (Backend-Umschalter, Port 8787, TMR+desklib lokal) +
  optionales `laya-serve`-Docker-Setup (Port 11500, aktuell ungenutzt) + README
- `extension/` — die Browser-Extension selbst (Manifest V3); `vendor/` wird per
  `npm run vendor` (`scripts/vendor.mjs`) erzeugt; `models/desklib/` = desklib-Graph ohne
  Gewichte + Bauanleitung (neu erzeugen mit `scripts/build_desklib_skeleton.py`, braucht die
  Python-Umgebung aus `server/` plus `onnx onnxruntime onnxscript`)
- `test/harness.html` — Offline-Testseite mit Beispieltexten
- `training/` — `prepare_dataset.py` (HC3 → Laya-Fine-Tuning-Format, fertig getestet),
  `evaluate_backends.py` + `benchmark_latency.py` (Genauigkeit/Performance-Vergleich),
  `EVAL_RESULTS.md` (Messergebnisse)
- `RESOURCES.md` — alle Recherche-Ergebnisse zu Jev/Laya/Datensätzen/Referenzprojekt
