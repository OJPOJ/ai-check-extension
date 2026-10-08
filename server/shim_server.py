"""
Local shim server: speaks the same wire format as laya-serve
(POST /v1/systemone), but routes to different backends depending on the
"model" field:

  - "english" / "multilingual" / "typed-decisions"  -> proxy to laya-serve
    (see README.md, must run separately via run_server.ps1)
  - "tmr"                                            -> locally loaded
    Oxidane/tmr-ai-text-detector (RoBERTa-base, 125M, no training needed)
  - "desklib"                                        -> locally loaded
    desklib/ai-text-detector-v1.01 (DeBERTa-v3-large, 430M, custom pooling class)
  - "fakespot"                                        -> locally loaded
    fakespot-ai/roberta-base-ai-text-detection-v1 (RoBERTa-base, 125M, built like TMR)

In addition there is the slim contract that the extension uses for the providers
"Local" and "Custom server" (details: README.md, "Contract"):

    POST /v1/score  {"texts": ["...", ...], "model": "tmr", "lang": "en"}  ->  {"scores": [0.93, ...]}
    GET  /v1/info?model=tmr  ->  {"name", "version", "maxChars", "languages", "suggestedThresholds"}

scores = P(AI) in [0,1] per text, same order; "model" and "lang" optional.

For operation outside localhost (e.g. cloud VM) configurable via env:
    AIVSAI_HOST     (default 127.0.0.1)
    AIVSAI_PORT     (default 8787)
    AIVSAI_API_KEY  (optional; if set, /v1/score must send the header
                     "Authorization: Bearer <key>")

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
FAKESPOT_MODEL_ID = "fakespot-ai/roberta-base-ai-text-detection-v1"
# Pinned, so scores do not change unnoticed through an upstream update. The revision goes
# via /v1/info into the extension's model key - new revision = old scores invalid.
TMR_REVISION = "0ceddea903015ef99cbaa040a4d8a216aed9c683"
DESKLIB_REVISION = "5fdea974cd4287c61674951ec78803aa274e2fb7"
FAKESPOT_REVISION = "f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db"
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

_fakespot_tokenizer = None
_fakespot_model = None
_fakespot_ai_index = None


def load_tmr():
    global _tmr_tokenizer, _tmr_model, _tmr_ai_index
    if _tmr_model is not None:
        return
    _tmr_tokenizer = AutoTokenizer.from_pretrained(TMR_MODEL_ID, revision=TMR_REVISION)
    _tmr_model = AutoModelForSequenceClassification.from_pretrained(TMR_MODEL_ID, revision=TMR_REVISION)
    _tmr_model.eval()
    ai_idx = [k for k, v in _tmr_model.config.id2label.items() if v.lower() in ("ai", "machine", "generated")]
    _tmr_ai_index = ai_idx[0] if ai_idx else 1


def load_fakespot():
    global _fakespot_tokenizer, _fakespot_model, _fakespot_ai_index
    if _fakespot_model is not None:
        return
    _fakespot_tokenizer = AutoTokenizer.from_pretrained(FAKESPOT_MODEL_ID, revision=FAKESPOT_REVISION)
    _fakespot_model = AutoModelForSequenceClassification.from_pretrained(FAKESPOT_MODEL_ID, revision=FAKESPOT_REVISION)
    _fakespot_model.eval()
    ai_idx = [k for k, v in _fakespot_model.config.id2label.items() if v.lower() in ("ai", "machine", "generated")]
    _fakespot_ai_index = ai_idx[0] if ai_idx else 1


def length_buckets(lengths: list[int], ratio: float = 1.25, slack: int = 16) -> list[list[int]]:
    """Group indices by length (like extension/length-buckets.js). A batch is padded to the longest
    text - one long text with four short ones cost desklib 15.3 s instead of 4.9 s separately, with
    identical scores (training/EVAL_RESULTS.md, "Padding")."""
    groups: list[list[int]] = []
    for i in sorted(range(len(lengths)), key=lambda i: lengths[i]):
        if groups and lengths[i] <= lengths[groups[-1][0]] * ratio + slack:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


def score_bucketed(texts: list[str], tokenizer, max_length: int, run) -> list[float]:
    """run(enc) -> scores for a padded sub-batch; same order as `texts`."""
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


def score_fakespot_texts(texts: list[str]) -> list[float]:
    load_fakespot()
    return score_bucketed(
        texts,
        _fakespot_tokenizer,
        512,
        lambda enc: torch.softmax(_fakespot_model(**enc).logits, dim=-1)[:, _fakespot_ai_index].tolist(),
    )


class DesklibAIDetectionModel(PreTrainedModel):
    """Custom architecture from the model card (mean pooling + sigmoid head),
    not AutoModelForSequenceClassification - hence a custom class is needed."""

    config_class = AutoConfig

    def __init__(self, config):
        super().__init__(config)
        self.model = AutoModel.from_config(config)
        self.classifier = nn.Linear(config.hidden_size, 1)
        self.init_weights()

    @property
    def all_tied_weights_keys(self):
        # Compatibility fix for transformers>=5, see training/evaluate_backends.py
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
    # Never pad to a fixed 768 tokens, only within groups of similar length: mean pooling masks out
    # padding tokens anyway, the scores stay the same, the compute time drops sharply.
    return score_bucketed(
        texts,
        _desklib_tokenizer,
        768,
        lambda enc: torch.sigmoid(_desklib_model(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"]))
        .squeeze(-1)
        .tolist(),
    )


LOCAL_SCORERS = {"tmr": score_tmr_texts, "desklib": score_desklib_texts, "fakespot": score_fakespot_texts}

# Response of /v1/info - text length and traffic light as in extension/models.js (rationale there)
MODEL_INFO = {
    "tmr": {
        "name": "TMR AI Text Detector",
        "version": TMR_REVISION[:7],
        "maxChars": 2000,
        "languages": ["en"],
        "suggestedThresholds": {"yellowFrom": 0.95, "redFrom": 0.98},
        "reliableWords": 120,
    },
    "desklib": {
        "name": "desklib AI Text Detector v1.01",
        "version": DESKLIB_REVISION[:7],
        "maxChars": 1500,
        "languages": ["en"],
        "suggestedThresholds": {"yellowFrom": 0.5, "redFrom": 0.87},
        "reliableWords": 120,
        "shortRedFrom": 0.98,
    },
    "fakespot": {
        "name": "fakespot roberta-base-ai-text-detection-v1",
        "version": FAKESPOT_REVISION[:7],
        "maxChars": 2000,
        "languages": ["en"],
        "suggestedThresholds": {"yellowFrom": 0.95, "redFrom": 0.999},
        "reliableWords": 120,
        "shortRedFrom": 0.9994,
    },
}


def extract_candidate_texts(state, questions) -> dict[str, str]:
    """Maps question-id -> text, for state = {"candidates": [...]}, the
    format used by extension/background.js, as well as the simpler
    state = "text..." format from manual single tests (see server/README.md)."""
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
        "fakespot_loaded": _fakespot_model is not None,
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
    lang: str | None = None  # language of the page, if known; TMR/desklib only handle English


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
    # sync def -> FastAPI runs this in the thread pool, inference does not block the event loop
    check_auth(authorization)
    check_model(req.model)
    texts = [t[:MAX_CHARS_PER_TEXT] for t in req.texts]
    scores = LOCAL_SCORERS[req.model](texts)
    return {"model": req.model, "scores": [round(s, 4) for s in scores]}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("AIVSAI_HOST", "127.0.0.1"), port=int(os.environ.get("AIVSAI_PORT", "8787")))
