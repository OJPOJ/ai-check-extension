# AI Content Flag — Browser-Extension (Jev/Laya)

Markiert wahrscheinlich KI-generierte Textinhalte auf Webseiten mit einem dezenten,
glühenden Rahmen — komplett lokal, kein Cloud-Call. Hintergrund/Architektur: `RESOURCES.md`.
Ursprünglicher Plan: `training/README.md`, `server/README.md`.

## Aktueller Stand (2026-09-23)

- ✅ **Phase A abgeschlossen & verifiziert:** `laya-serve` (ouijan-Implementierung) läuft lokal
  in Docker auf `127.0.0.1:11500`, Health-Check und `/v1/systemone` funktionieren.
- ✅ **API-Vertrag verifiziert:** Batch-Format (`state.candidates[]` + je eine `noul`-Frage pro
  Index) wird korrekt beantwortet — Details in `server/README.md`.
- ⚠️ **Bug gefunden & gefixt:** `model` muss `"english"` heißen, nicht `"jev-latest"` wie beim
  `typesafe-adblock`-Vorbild — jetzt in `extension/options.html` konfigurierbar.
- ✅ **Phase B (Extension-Code) geschrieben und manuell von dir getestet:** Eingabefeld und
  Kurztext wurden korrekt nie markiert, Glow (lila, pulsierend) funktioniert wie geplant.
- ⚠️ **Zero-Shot-Erkennung ist wie erwartet unbrauchbar:** sowohl im direkten API-Test als
  auch im Browser-Test wurde praktisch alles markiert, unabhängig vom tatsächlichen Stil —
  erwartet (siehe `RESOURCES.md`), Grund für Phase D.
- 🔄 **Phase D läuft:** `training/prepare_dataset.py` steht, ist getestet und hat bereits den
  vollen Datensatz gebaut — **142.868 Beispiele** (89.878 human, 52.990 KI, aus HC3) →
  128.581 train / 14.287 holdout in `training/data/`, im vom Laya-Notebook erwarteten Schema.
  Bekannte Einschränkungen (Klassen-Ungleichgewicht, Tokenisierungs-Artefakte im
  reddit_eli5-Teil, kein RAID) stehen in `training/README.md`.
  **Offen:** das eigentliche Training auf Kaggle (2x T4 GPU) — das kann ich nicht von hier aus
  ausführen, siehe Anleitung in `training/README.md`.

## Quick Start

```powershell
cd server
.\run_server.ps1          # startet laya-serve, falls nicht schon gestartet
```

Dann in Chrome/Edge:

1. `chrome://extensions` öffnen, "Entwicklermodus" aktivieren.
2. "Entpackte Erweiterung laden" → Ordner `extension/` auswählen.
3. Auf das Extension-Icon klicken → Optionen öffnen sich (Server-URL/Modell sollten
   bereits `http://127.0.0.1:11500` / `english` sein).
4. Für den Test-Harness: bei der Extension unter "Details" → "Auf Datei-URLs zulassen"
   aktivieren (sonst funktioniert `test/harness.html` als `file://`-URL nicht).
5. `test/harness.html` im Browser öffnen und beobachten, ob Absätze einen Glow-Rahmen
   bekommen (Schwellenwert ggf. in den Optionen runterdrehen, um überhaupt einen Treffer
   zu sehen — die zero-shot-Werte sind aktuell sehr niedrig/undifferenziert).

## Ordnerstruktur

- `server/` — lokaler Laya-Server (Docker-Setup, README mit verifizierten Beispiel-Requests)
- `extension/` — die Browser-Extension selbst (Manifest V3), manuell getestet
- `test/harness.html` — Offline-Testseite mit Beispieltexten
- `training/` — Fine-Tuning: `prepare_dataset.py` (fertig, getestet) + `data/` (generiert,
  nicht eingecheckt) + Anleitung für den offenen Kaggle-Trainingsschritt
- `RESOURCES.md` — alle Recherche-Ergebnisse zu Jev/Laya/Datensätzen/Referenzprojekt
