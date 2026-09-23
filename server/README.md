# Lokaler Laya-Server (Jev-kompatibel)

Nutzt `ouijan/laya-serve` (Apache-2.0): https://github.com/ouijan/laya-serve
Bildet TypeSafes Jev-Wire-API lokal nach (`POST /v1/systemone`, `GET /healthz`).

Ausgewählt statt der Alternativen (`stiermid/laya-serve` u.a.) wegen besserer Doku
(CONTRIBUTING.md, AGENTS.md, Tests, CI) und Docker-Support — siehe `../RESOURCES.md`.
Alle Angaben unten stammen aus dem README des Repos (Stand Recherche 2026-09-23);
vor Produktivnutzung selbst gegenlesen, das Ökosystem ist wenige Tage alt.

## Start (Docker — empfohlener Weg, Docker ist auf dieser Maschine vorhanden)

```
.\run_server.ps1
```

Das Skript startet den Container, bindet ihn an `127.0.0.1:11500` (nicht öffentlich
erreichbar) und lädt den Basis-Checkpoint `laya-english`.

Manuell (falls das Skript nicht passt):

```powershell
docker run -d --name laya -p 127.0.0.1:11500:11500 `
  -e LAYA_MODELS=english `
  ghcr.io/ouijan/laya-serve
```

## Start (ohne Docker — Alternative)

Repo klonen und mit `uv` installieren (aus deren README):

```bash
git clone https://github.com/ouijan/laya-serve
cd laya-serve
uv venv --python 3.13
uv pip install -e .
LAYA_PORT=11500 laya-serve --cpu
```

`--gpu` statt `--cpu` falls eine CUDA-GPU vorhanden ist (schneller, für Fine-Tuning
später ohnehin nötig).

## Health-Check

```powershell
Invoke-RestMethod http://127.0.0.1:11500/healthz
```

## Beispiel-Request (Zero-Shot-Sanity-Check)

Noul-Frage: "Ist dieser Text KI-generiert?" — Erwartung laut Laya-Doku: Zero-Shot-Genauigkeit
nahe Zufall, siehe `../RESOURCES.md`. Dient hier nur dem technischen Funktionstest.

```powershell
$body = @{
  state     = "The quick brown fox jumps over the lazy dog while pondering the nature of existence."
  model     = "english"
  questions = @{
    ai_generated = @{
      type         = "noul"
      instructions = "Is this text primarily written by an AI/LLM rather than a human?"
    }
  }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri http://127.0.0.1:11500/v1/systemone -Method Post `
  -ContentType "application/json" -Body $body
```

**Verifiziert am 2026-09-23** (nicht nur aus der Doku übernommen): `model` muss exakt einer der
geladenen Checkpoint-Namen sein (bei diesem Server: `english`, `multilingual`, `typed-decisions` —
**nicht** `jev-latest`, wie es die echte TypeSafe-API akzeptieren würde). Response sah so aus:

```json
{"model":"laya-rl-agent","answers":{"ai_generated":{"type":"noul","noul":0.0001,"confidence":0.9999}},"usage":{"input_tokens":59,"output_tokens":0},"routing":{"model":"english","reason":"explicit model='english'"}}
```

**Wichtiger Befund:** Zero-Shot-Werte für "ist das KI-generiert" liegen faktisch ohne Trennschärfe
bei ~0.0–0.5, unabhängig vom Stil des Textes (getestet mit deutlich KI-typischem vs. menschlich-
umgangssprachlichem Text). Deckt sich exakt mit der Doku-Warnung in `../RESOURCES.md` — die
Pipeline funktioniert technisch, aber ohne Fine-Tuning (Phase D) ist die Erkennung nicht brauchbar.

Auch verifiziert: das Batch-Format aus `background.js` (ein `state.candidates`-Array + je eine
`noul`-Frage pro Index à la `candidates[i].text`) wird korrekt beantwortet — die Grundarchitektur
aus `typesafe-adblock` überträgt sich 1:1 auf diesen Server.

## Stoppen

```powershell
docker stop laya; docker rm laya
```
