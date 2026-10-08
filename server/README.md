# Local inference server

**`shim_server.py`** (port `8787`) is the only endpoint the extension talks to.
Routes to one of three backends depending on the `model` field:

- **`tmr`** ("Low" in the extension) — `Oxidane/tmr-ai-text-detector`, RoBERTa-base 125M,
  loaded locally. Default backend.
- **`desklib`** ("Medium") — `desklib/ai-text-detector-v1.01`, DeBERTa-v3-large 430M,
  loaded locally. Considerably more accurate, but noticeably slow/heavy — see the performance figures
  below. Custom pooling architecture (not `AutoModelForSequenceClassification`), rebuilt in the shim
  including a compatibility fix for `transformers>=5`.
- **`english` / `multilingual`** (Laya, proxy to `laya-serve`, port `11500`) — **currently
  not selectable in the extension UI**, because zero-shot is unusable (see below).
  Code/routing stays prepared, for the day a fine-tuned Laya checkpoint
  exists (`../training/README.md`).

## Start (just this, TMR/desklib do not need `laya-serve`)

```powershell
cd server
uv venv .venv --python 3.12
uv pip install --python .venv -r requirements_shim.txt
.venv/Scripts/python.exe shim_server.py
```

Runs on `127.0.0.1:8787`. TMR/desklib load lazily on the first request with this
`model` value (TMR a few seconds, desklib longer + ~1.8GB download the very first time).

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
# {"ok": true, "laya_upstream": true/false, "tmr_loaded": ..., "desklib_loaded": ...}
Invoke-RestMethod "http://127.0.0.1:8787/v1/info?model=desklib"
# {"name": "desklib AI Text Detector v1.01", "version": "5fdea97", "maxChars": 1500, ...}
```

## Contract for custom models ("Local" and "Custom server")

A custom model is a binary classifier. Any server that fulfills this can be used in
the extension; `shim_server.py` is the reference implementation.

**`POST …/v1/score`** (this URL is entered in the extension)

```json
{"texts": ["…", "…"], "model": "tmr", "lang": "en"}
→ {"scores": [0.93, 0.12]}
```

- `texts`: 1..n texts, each up to `maxChars` characters (extension: batches of up to 2500 characters).
- `model`: optional, only if entered in the extension.
- `lang`: optional, language of the texts (ISO 639-1, e.g. `en`), if known. The extension sends the
  language detected per paragraph (`extension/lang-detect.js`); it splits mixed batches, one
  request per language. Paragraphs in languages the model does not know according to `languages` are not
  sent at all (except via "Check anyway").
- `scores`: per text **P(AI) in [0,1]**, same order and count. Values outside 0..1
  (e.g. logits) or non-numbers are left unscored by the extension.
- Optional `Authorization: Bearer <key>`. Errors as an HTTP status with `{"detail": "…"}` or
  `{"error": {"message": "…"}}` – the text appears in the extension.

**`GET …/v1/info?model=…`** (optional, next to the score endpoint: `…/v1/score` → `…/v1/info`)

```json
{"name": "desklib AI Text Detector v1.01", "version": "5fdea97", "maxChars": 1500, "languages": ["en"],
 "suggestedThresholds": {"yellowFrom": 0.5, "redFrom": 0.87}, "reliableWords": 120, "shortRedFrom": 0.98}
```

All fields optional. `version` goes into the extension's model key: if it changes
(new weights, different quantization), stored scores no longer apply. `maxChars` limits
the text per paragraph, `suggestedThresholds` are the starting values of the traffic light. `reliableWords`: below this
many words a high score becomes gray "uncertain" instead of yellow/red (default 120); `shortRedFrom`:
stricter red threshold from which short paragraphs also turn red (default: never). Both should be measured
– template: `training/evaluate_false_alarms.py` (false alarms on Wikipedia by length) and
`training/EVAL_RESULTS.md`, "Confidence for short paragraphs". Without the endpoint (404/405/501) everything
works, just without a version.

**"Check model"** in the settings (required for "Custom server") sends 40 English reference texts
before saving and checks response format, direction (AI higher than human), separation
(AUROC ≥ 0.6, warning below 0.8) and latency. Details: `../DEVELOPMENT.md`, "Check custom models".

`shim_server.py` pins the model revisions (`TMR_REVISION`, `DESKLIB_REVISION`) and reports them
as `version`.

## `/v1/score` — the endpoint the extension uses

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8787/v1/score -Method Post -ContentType "application/json" `
  -Body '{"model": "tmr", "texts": ["Maintaining a bicycle in good working condition requires regular attention."]}'
# {"model": "tmr", "scores": [0.98...]}
```

For operation as "Custom server / cloud" (extension provider `custom`):
`AIVSAI_HOST=0.0.0.0`, `AIVSAI_PORT`, `AIVSAI_API_KEY` (then
`Authorization: Bearer <key>` is required). Before a public deployment, still put
TLS/a reverse proxy in front.

## Laya wire format `/v1/systemone` (legacy, verified)

```powershell
$body = @{
  model     = "tmr"   # or "desklib"
  state     = @{ candidates = @(@{ text = "Maintaining a bicycle in good working condition requires regular attention." }) }
  questions = @{ c0 = @{ type = "noul"; instructions = "Is candidates[0].text primarily generated by an AI/LLM?" } }
} | ConvertTo-Json -Depth 6

Invoke-RestMethod -Uri http://127.0.0.1:8787/v1/systemone -Method Post -ContentType "application/json" -Body $body
```

## Verified findings (2026-09-23) — details/reproduction: `../training/EVAL_RESULTS.md`

Accuracy (100 balanced HC3 examples) AND performance (CPU, batch of 25 as used by
`extension/content.js`) considered together:

| Backend | AUROC | Accuracy (best threshold) | Batch of 25 | RAM |
|---|---|---|---|---|
| Laya zero-shot | 0.549 | 0.570 | ~61s | ~2.1GB |
| **TMR** | 0.911 | 0.830 (threshold 0.98) | ~1.6s | ~900MB |
| **desklib** | 0.998 | 0.990 (threshold 0.87) | ~2 min | ~4.65GB |

- Laya zero-shot: practically a coin flip, not fixable by any threshold — hence disabled in the
  extension until fine-tuned.
- desklib is the most accurate, but on CPU ~80× slower than TMR and ~5× more RAM — impractical for
  automatically scanning every page, intended more for targeted single checks.
- **Update 2026-09-25:** The ~2 min came largely from padding every text to 768
  tokens (`padding="max_length"` from the model card). Now padding is only to the longest text
  in the batch (mean pooling masks padding tokens anyway): identical scores
  (max. deviation 0.00005 on 292 texts), **~0.5 s instead of ~4.9 s per text** on the HC3 sample.
- Batch format (`state.candidates[]` + `noul` question per index) works identically for
  all three backends via the shim.

### Two bugs found along the way

- `laya-serve`'s real health endpoint is called **`/health`**, not `/healthz` as
  originally researched (verified via `GET /openapi.json`).
- desklib's 2024 example code from the model card crashes unpatched with `transformers>=5`
  (`AttributeError: ... 'all_tied_weights_keys'`) — fixed by an overridden
  property (empty dict), see `shim_server.py`.

## Optional: start `laya-serve` (only for Laya backends, currently unused)

```powershell
.\run_server.ps1
# or manually:
docker run -d --name laya -p 127.0.0.1:11500:11500 -e LAYA_MODELS=english ghcr.io/ouijan/laya-serve
```

## Stopping

```powershell
docker stop laya; docker rm laya    # if laya-serve was running
# shim_server.py: Ctrl+C in the running terminal
```
