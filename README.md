# AI Content Flag — Browser-Extension

Markiert wahrscheinlich KI-generierte Textinhalte auf Webseiten mit einem dezenten,
glühenden Rahmen — komplett lokal, kein Cloud-Call. Hintergrund/Architektur: `RESOURCES.md`.

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

## Quick Start

```powershell
# nur der Shim-Server ist noetig (TMR/desklib laufen lokal darin, kein laya-serve noetig)
cd server
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py
```

Dann in Chrome/Edge:

1. `chrome://extensions` öffnen, "Entwicklermodus" aktivieren.
2. "Entpackte Erweiterung laden" → Ordner `extension/` auswählen.
3. Auf das Extension-Icon klicken → Optionen (Server-URL `http://127.0.0.1:8787`,
   Backend-Dropdown auf "Low — TMR").
4. Für den Test-Harness: bei der Extension unter "Details" → "Auf Datei-URLs zulassen"
   aktivieren, dann `test/harness.html` öffnen.

## Ordnerstruktur

- `server/` — `shim_server.py` (Backend-Umschalter, Port 8787, TMR+desklib lokal) +
  optionales `laya-serve`-Docker-Setup (Port 11500, aktuell ungenutzt) + README
- `extension/` — die Browser-Extension selbst (Manifest V3), manuell getestet
- `test/harness.html` — Offline-Testseite mit Beispieltexten
- `training/` — `prepare_dataset.py` (HC3 → Laya-Fine-Tuning-Format, fertig getestet),
  `evaluate_backends.py` + `benchmark_latency.py` (Genauigkeit/Performance-Vergleich),
  `EVAL_RESULTS.md` (Messergebnisse)
- `RESOURCES.md` — alle Recherche-Ergebnisse zu Jev/Laya/Datensätzen/Referenzprojekt
