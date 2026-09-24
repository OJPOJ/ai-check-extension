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
3. Auf das Extension-Icon klicken → Schalter „Diese Seite automatisch scannen“ oder
   „Diese Seite jetzt scannen“. Backend/Schwellen unter „Einstellungen“ (Default: Lokal,
   `http://127.0.0.1:8787`, TMR).
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
