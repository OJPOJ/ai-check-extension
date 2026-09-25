"""
Lokaler Shim-Server: spricht dasselbe Wire-Format wie laya-serve
(POST /v1/systemone), routet aber je nach "model"-Feld zu verschiedenen
Backends:

  - "english" / "multilingual" / "typed-decisions"  -> Proxy zu laya-serve
    (siehe README.md, muss separat via run_server.ps1 laufen)
  - "tmr"                                            -> lokal geladenes
    Oxidane/tmr-ai-text-detector (RoBERTa-base, 125M, kein Training noetig)
  - "desklib"                                        -> lokal geladenes
    desklib/ai-text-detector-v1.01 (DeBERTa-v3-large, 430M, eigene Pooling-Klasse)

Zusaetzlich gibt es den schlanken Vertrag, den die Extension fuer die Provider
"Lokal" und "Eigener Server" verwendet (Details: README.md, "Vertrag"):

    POST /v1/score  {"texts": ["...", ...], "model": "tmr", "lang": "en"}  ->  {"scores": [0.93, ...]}
    GET  /v1/info?model=tmr  ->  {"name", "version", "maxChars", "languages", "suggestedThresholds"}

scores = P(KI) in [0,1] pro Text, gleiche Reihenfolge; "model" und "lang" optional.

Fuer Betrieb ausserhalb von localhost (z.B. Cloud-VM) per Env konfigurierbar:
    AIVSAI_HOST     (Default 127.0.0.1)
    AIVSAI_PORT     (Default 8787)
    AIVSAI_API_KEY  (optional; wenn gesetzt, muss /v1/score den Header
                     "Authorization: Bearer <key>" mitschicken)

Start:
    uv venv .venv --python 3.12
    uv pip install --python .venv -r requirements_shim.txt
    .venv/Scripts/python.exe shim_server.py
"""

import os
import re

import httpx
import torch
import torch.nn as nn
import uvicorn
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from transformers import AutoConfig, AutoModel, AutoModelForSequenceClassification, AutoTokenizer, PreTrainedModel

LAYA_UPSTREAM = "http://127.0.0.1:11500"
LAYA_MODELS = {"english", "multilingual", "typed-decisions"}
TMR_MODEL_ID = "Oxidane/tmr-ai-text-detector"
DESKLIB_MODEL_ID = "desklib/ai-text-detector-v1.01"
# Fest gepinnt, damit sich Scores nicht durch ein Upstream-Update unbemerkt aendern. Die Revision geht
# ueber /v1/info in den Modellschluessel der Extension ein - neue Revision = alte Scores ungueltig.
TMR_REVISION = "0ceddea903015ef99cbaa040a4d8a216aed9c683"
DESKLIB_REVISION = "5fdea974cd4287c61674951ec78803aa274e2fb7"
CANDIDATE_QID = re.compile(r"^c(\d+)$")
API_KEY = os.environ.get("AIVSAI_API_KEY") or None
MAX_TEXTS_PER_REQUEST = 64
MAX_CHARS_PER_TEXT = 4000

app = FastAPI()

_tmr_tokenizer = None
_tmr_model = None
_tmr_ai_index = None

_desklib_tokenizer = None
_desklib_model = None


def load_tmr():
    global _tmr_tokenizer, _tmr_model, _tmr_ai_index
    if _tmr_model is not None:
        return
    _tmr_tokenizer = AutoTokenizer.from_pretrained(TMR_MODEL_ID, revision=TMR_REVISION)
    _tmr_model = AutoModelForSequenceClassification.from_pretrained(TMR_MODEL_ID, revision=TMR_REVISION)
    _tmr_model.eval()
    ai_idx = [k for k, v in _tmr_model.config.id2label.items() if v.lower() in ("ai", "machine", "generated")]
    _tmr_ai_index = ai_idx[0] if ai_idx else 1


def length_buckets(lengths: list[int], ratio: float = 1.25, slack: int = 16) -> list[list[int]]:
    """Indizes nach Länge gruppieren (wie extension/length-buckets.js). Ein Batch wird auf den längsten
    Text aufgefüllt - ein langer mit vier kurzen kostete desklib 15,3 s statt 4,9 s getrennt, bei
    identischen Scores (training/EVAL_RESULTS.md, "Auffüllen")."""
    groups: list[list[int]] = []
    for i in sorted(range(len(lengths)), key=lambda i: lengths[i]):
        if groups and lengths[i] <= lengths[groups[-1][0]] * ratio + slack:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def score_bucketed(texts: list[str], tokenizer, max_length: int, run) -> list[float]:
    """run(enc) -> Scores für einen aufgefüllten Teil-Batch; Reihenfolge wie `texts`."""
    lengths = [len(ids) for ids in tokenizer(texts, truncation=True, max_length=max_length)["input_ids"]]
    scores = [0.0] * len(texts)
    with torch.no_grad():
        for group in length_buckets(lengths):
            enc = tokenizer([texts[i] for i in group], return_tensors="pt", truncation=True, padding=True, max_length=max_length)
            for i, p in zip(group, run(enc)):
                scores[i] = p
    return scores


def score_tmr_texts(texts: list[str]) -> list[float]:
    load_tmr()
    return score_bucketed(
        texts, _tmr_tokenizer, 512, lambda enc: torch.softmax(_tmr_model(**enc).logits, dim=-1)[:, _tmr_ai_index].tolist()
    )


class DesklibAIDetectionModel(PreTrainedModel):
    """Eigene Architektur aus dem Model Card (Mean-Pooling + Sigmoid-Kopf),
    kein AutoModelForSequenceClassification - deshalb eigene Klasse noetig."""

    config_class = AutoConfig

    def __init__(self, config):
        super().__init__(config)
        self.model = AutoModel.from_config(config)
        self.classifier = nn.Linear(config.hidden_size, 1)
        self.init_weights()

    @property
    def all_tied_weights_keys(self):
        # Kompatibilitaets-Fix fuer transformers>=5, siehe training/evaluate_backends.py
        return {}

    def forward(self, input_ids, attention_mask=None):
        outputs = self.model(input_ids, attention_mask=attention_mask)
        last_hidden_state = outputs[0]
        mask = attention_mask.unsqueeze(-1).expand(last_hidden_state.size()).float()
        summed = torch.sum(last_hidden_state * mask, dim=1)
        counted = torch.clamp(mask.sum(dim=1), min=1e-9)
        pooled = summed / counted
        return self.classifier(pooled)


def load_desklib():
    global _desklib_tokenizer, _desklib_model
    if _desklib_model is not None:
        return
    _desklib_tokenizer = AutoTokenizer.from_pretrained(DESKLIB_MODEL_ID, revision=DESKLIB_REVISION)
    _desklib_model = DesklibAIDetectionModel.from_pretrained(DESKLIB_MODEL_ID, revision=DESKLIB_REVISION)
    _desklib_model.eval()


def score_desklib_texts(texts: list[str]) -> list[float]:
    load_desklib()
    # Nie fest auf 768 Tokens auffüllen, nur innerhalb ähnlich langer Gruppen: Das Mean-Pooling maskiert
    # Füll-Tokens ohnehin aus, die Scores bleiben gleich, die Rechenzeit sinkt stark.
    return score_bucketed(
        texts,
        _desklib_tokenizer,
        768,
        lambda enc: torch.sigmoid(_desklib_model(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"]))
        .squeeze(-1)
        .tolist(),
    )


LOCAL_SCORERS = {"tmr": score_tmr_texts, "desklib": score_desklib_texts}

# Antwort von /v1/info - Textlaenge und Ampel wie in extension/models.js
MODEL_INFO = {
    "tmr": {
        "name": "TMR AI Text Detector",
        "version": TMR_REVISION[:7],
        "maxChars": 2000,
        "languages": ["en"],
        "suggestedThresholds": {"yellowFrom": 0.6, "redFrom": 0.9},
    },
    "desklib": {
        "name": "desklib AI Text Detector v1.01",
        "version": DESKLIB_REVISION[:7],
        "maxChars": 1500,
        "languages": ["en"],
        "suggestedThresholds": {"yellowFrom": 0.5, "redFrom": 0.87},
    },
}


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
            r = await client.get(f"{LAYA_UPSTREAM}/health")
            laya_up = r.status_code == 200
    except Exception:
        laya_up = False
    return {
        "ok": True,
        "laya_upstream": laya_up,
        "tmr_loaded": _tmr_model is not None,
        "desklib_loaded": _desklib_model is not None,
    }


@app.post("/v1/systemone")
async def systemone(request: Request):
    body = await request.json()
    model = body.get("model", "")

    if model in LAYA_MODELS:
        async with httpx.AsyncClient(timeout=90) as client:
            resp = await client.post(f"{LAYA_UPSTREAM}/v1/systemone", json=body)
        return JSONResponse(content=resp.json(), status_code=resp.status_code)

    if model in LOCAL_SCORERS:
        state = body.get("state")
        questions = body.get("questions", {})
        qid_to_text = extract_candidate_texts(state, questions)
        if not qid_to_text:
            return JSONResponse(content={"error": {"message": f"no candidate text found for {model} backend", "field": "state"}}, status_code=422)

        qids = list(qid_to_text.keys())
        scores = LOCAL_SCORERS[model]([qid_to_text[q] for q in qids])

        answers = {
            qid: {"type": "noul", "noul": round(score, 4)}
            for qid, score in zip(qids, scores)
        }
        return {
            "model": model,
            "answers": answers,
            "usage": {"input_tokens": 0, "output_tokens": 0},
            "routing": {"model": model, "reason": f"explicit model='{model}'"},
        }

    known = LAYA_MODELS | set(LOCAL_SCORERS)
    return JSONResponse(
        content={"error": {"message": f"unknown model '{model}', expected one of {known}", "field": "model"}},
        status_code=422,
    )


class ScoreRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=MAX_TEXTS_PER_REQUEST)
    model: str = "tmr"
    lang: str | None = None  # Sprache der Seite, falls bekannt; TMR/desklib koennen nur Englisch


def check_auth(authorization: str | None) -> None:
    if API_KEY and authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="invalid or missing API key")


def check_model(model: str) -> None:
    if model not in LOCAL_SCORERS:
        raise HTTPException(status_code=422, detail=f"unknown model '{model}', expected one of {sorted(LOCAL_SCORERS)}")


@app.get("/v1/info")
def info(model: str = "tmr", authorization: str | None = Header(default=None)):
    check_auth(authorization)
    check_model(model)
    return MODEL_INFO[model]


@app.post("/v1/score")
def score(req: ScoreRequest, authorization: str | None = Header(default=None)):
    # sync def -> FastAPI fuehrt das im Threadpool aus, Inferenz blockiert den Event-Loop nicht
    check_auth(authorization)
    check_model(req.model)
    texts = [t[:MAX_CHARS_PER_TEXT] for t in req.texts]
    scores = LOCAL_SCORERS[req.model](texts)
    return {"model": req.model, "scores": [round(s, 4) for s in scores]}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("AIVSAI_HOST", "127.0.0.1"), port=int(os.environ.get("AIVSAI_PORT", "8787")))
