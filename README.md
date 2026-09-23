# AI Content Flag — Browser-Extension (Jev/Laya + TMR)

Markiert wahrscheinlich KI-generierte Textinhalte auf Webseiten mit einem dezenten,
glühenden Rahmen — komplett lokal, kein Cloud-Call. Hintergrund/Architektur: `RESOURCES.md`.

## Aktueller Stand (2026-09-23)

- ✅ **Extension (Manifest V3) fertig und manuell getestet:** Content-Script (DOM-Extraktion,
  Caching, MutationObserver), Background-Service-Worker, Options-UI. Eingabefelder/Kurztexte
  werden korrekt nie markiert, Glow (lila, pulsierend) funktioniert.
- ✅ **Backend-Vergleich mit echten Zahlen durchgeführt** (100 balancierte Beispiele aus
  HC3-Holdout, siehe `training/EVAL_RESULTS.md`):

  | Backend | Accuracy@0.5 | AUROC | Fazit |
  |---|---|---|---|
  | Laya zero-shot (`english`) | 0.510 | 0.549 | faktisch Münzwurf, unbrauchbar |
  | **TMR** (`Oxidane/tmr-ai-text-detector`) | 0.550 | **0.911** | trennt gut, brauchte höhere Schwelle (0.98 → Accuracy 0.830) |

  → **TMR ist jetzt das Default-Backend**, kein Fine-Tuning nötig. Laya-Fine-Tuning
  (Phase D, Datensatz liegt fertig in `training/data/`) ist damit nicht mehr der empfohlene
  Weg, bleibt aber nutzbar falls gewünscht — siehe `training/README.md`.
- ✅ **Backend-Umschalter gebaut:** `server/shim_server.py` spricht dasselbe
  `/v1/systemone`-Format wie `laya-serve`, routet aber je nach `model`-Feld zu TMR (lokal) oder
  zu Laya (Proxy). Extension-Code (`content.js`/`background.js`) musste dafür NICHT geändert
  werden — nur `options.html` hat jetzt ein Dropdown (TMR / Laya english / Laya multilingual).
- ⚠️ **Fehler in eigener Recherche gefunden & korrigiert:** `laya-serve`s echter Health-Endpoint
  heißt `/health`, nicht `/healthz` wie ursprünglich dokumentiert — per `/openapi.json`
  verifiziert, siehe `server/README.md`.

## Quick Start

```powershell
# 1) laya-serve (nur noetig fuer die Laya-Backends im Dropdown, TMR braucht das NICHT)
cd server
.\run_server.ps1

# 2) shim_server.py (das, womit die Extension tatsaechlich spricht)
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py
```

Dann in Chrome/Edge:

1. `chrome://extensions` öffnen, "Entwicklermodus" aktivieren.
2. "Entpackte Erweiterung laden" → Ordner `extension/` auswählen.
3. Auf das Extension-Icon klicken → Optionen (Server-URL sollte `http://127.0.0.1:8787` sein,
   Backend-Dropdown auf "TMR").
4. Für den Test-Harness: bei der Extension unter "Details" → "Auf Datei-URLs zulassen"
   aktivieren, dann `test/harness.html` öffnen.

## Ordnerstruktur

- `server/` — `shim_server.py` (Backend-Umschalter, Port 8787) + `laya-serve`-Docker-Setup
  (Port 11500, nur Upstream für Laya-Optionen) + README mit verifizierten Beispiel-Requests
- `extension/` — die Browser-Extension selbst (Manifest V3), manuell getestet
- `test/harness.html` — Offline-Testseite mit Beispieltexten
- `training/` — `prepare_dataset.py` (HC3 → Laya-Fine-Tuning-Format, fertig getestet),
  `evaluate_backends.py` (Accuracy/AUROC-Vergleich), `EVAL_RESULTS.md` (Messergebnisse)
- `RESOURCES.md` — alle Recherche-Ergebnisse zu Jev/Laya/Datensätzen/Referenzprojekt
