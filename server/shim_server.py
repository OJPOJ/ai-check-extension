"""
Lokaler Shim-Server: spricht dasselbe Wire-Format wie laya-serve
(POST /v1/systemone), routet aber je nach "model"-Feld zu verschiedenen
Backends:

  - "english" / "multilingual" / "typed-decisions"  -> Proxy zu laya-serve
    (siehe README.md, muss separat via run_server.ps1 laufen)
  - "tmr"                                            -> lokal geladenes
    Oxidane/tmr-ai-text-detector (RoBERTa-base, kein Training noetig)

Damit bleibt extension/background.js unveraendert - der Backend-Wechsel
passiert komplett ueber das "model"-Feld, das die Extension schon sendet
(Options-Dropdown -> config.model -> hier).

Start:
    uv venv .venv --python 3.12
    uv pip install --python .venv -r requirements_shim.txt
    .venv/Scripts/python.exe shim_server.py
"""

import re

import httpx
import torch
import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from transformers import AutoModelForSequenceClassification, AutoTokenizer

LAYA_UPSTREAM = "http://127.0.0.1:11500"
LAYA_MODELS = {"english", "multilingual", "typed-decisions"}
TMR_MODEL_ID = "Oxidane/tmr-ai-text-detector"
CANDIDATE_QID = re.compile(r"^c(\d+)$")

app = FastAPI()

_tmr_tokenizer = None
_tmr_model = None
_tmr_ai_index = None


def load_tmr():
    global _tmr_tokenizer, _tmr_model, _tmr_ai_index
    if _tmr_model is not None:
        return
    _tmr_tokenizer = AutoTokenizer.from_pretrained(TMR_MODEL_ID)
    _tmr_model = AutoModelForSequenceClassification.from_pretrained(TMR_MODEL_ID)
    _tmr_model.eval()
    ai_idx = [k for k, v in _tmr_model.config.id2label.items() if v.lower() in ("ai", "machine", "generated")]
    _tmr_ai_index = ai_idx[0] if ai_idx else 1


def score_tmr_texts(texts: list[str]) -> list[float]:
    load_tmr()
    with torch.no_grad():
        enc = _tmr_tokenizer(texts, return_tensors="pt", truncation=True, padding=True, max_length=512)
        logits = _tmr_model(**enc).logits
        probs = torch.softmax(logits, dim=-1)
        return probs[:, _tmr_ai_index].tolist()


def extract_candidate_texts(state, questions) -> dict[str, str]:
    """Bildet question-id -> Text ab, fuer state = {"candidates": [...]}, das
    Format, das extension/background.js verwendet, sowie das einfachere
    state = "text..." Format aus manuellen Einzel-Tests (siehe server/README.md)."""
    texts = {}
    if isinstance(state, dict) and isinstance(state.get("candidates"), list):
        candidates = state["candidates"]
        for qid in questions:
            m = CANDIDATE_QID.match(qid)
            if m:
                idx = int(m.group(1))
                if 0 <= idx < len(candidates):
                    texts[qid] = candidates[idx].get("text", "")
    elif isinstance(state, str):
        for qid in questions:
            texts[qid] = state
    return texts


@app.get("/healthz")
async def healthz():
    laya_up = False
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            r = await client.get(f"{LAYA_UPSTREAM}/healthz")
            laya_up = r.status_code == 200
    except Exception:
        laya_up = False
    return {"ok": True, "laya_upstream": laya_up, "tmr_loaded": _tmr_model is not None}


@app.post("/v1/systemone")
async def systemone(request: Request):
    body = await request.json()
    model = body.get("model", "")

    if model in LAYA_MODELS:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(f"{LAYA_UPSTREAM}/v1/systemone", json=body)
        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    if model == "tmr":
        state = body.get("state")
        questions = body.get("questions", {})
        qid_to_text = extract_candidate_texts(state, questions)
        if not qid_to_text:
            return JSONResponse(content={"error": {"message": "no candidate text found for tmr backend", "field": "state"}}, status_code=422)

        qids = list(qid_to_text.keys())
        scores = score_tmr_texts([qid_to_text[q] for q in qids])

        answers = {
            qid: {"type": "noul", "noul": round(score, 4)}
            for qid, score in zip(qids, scores)
        }
        return {
            "model": "tmr",
            "answers": answers,
            "usage": {"input_tokens": 0, "output_tokens": 0},
            "routing": {"model": "tmr", "reason": "explicit model='tmr'"},
        }

    return JSONResponse(
        content={"error": {"message": f"unknown model '{model}', expected one of {LAYA_MODELS | {'tmr'}}", "field": "model"}},
        status_code=422,
    )


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8787)
