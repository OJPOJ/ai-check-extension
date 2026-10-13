"""
Baselines on the frozen test part of our own dataset (issue #46, work package 5): TMR, fakespot
and desklib score the excerpts of data/dataset/<version>/test.jsonl, before any training. The
model we train is compared with these numbers on identical texts (MODEL_CONCEPT.md, "Evaluation").

Every model gets a text the way the extension sends it: cut to its `maxChars` (content.js,
clipText) and truncated to its `maxTokens`. The models are the PyTorch originals at a pinned
revision, not the quantised ONNX files the browser runs.

Stored per text is the log-odds of "AI", not only the probability: fakespot's probabilities
round to 1.0 for a large share of the texts, and a threshold for 1% false alarms lies in
exactly that range.

Measured, per view of the test part and within `main` per length group, domain, source and
generator:
    AUROC      ranking quality, independent of a threshold
    FA         share of the human texts at or above the threshold (false alarms)
    detected   share of the AI texts at or above the threshold
    F1         of the class "AI" at that threshold; depends on the ratio of the classes in the group
The threshold is set per model and length group so that at most 1% of the human texts of `main`
reach it, and is then applied unchanged to every other group and view.

Usage (from training/):
    .venv/Scripts/python.exe evaluation/evaluate_test_part.py score                  # all models; continues an interrupted run
    .venv/Scripts/python.exe evaluation/evaluate_test_part.py score tmr --set suite  # the 1200-text suite as a second view
    .venv/Scripts/python.exe evaluation/evaluate_test_part.py report                 # tables, and baselines.json next to the scores
    .venv/Scripts/python.exe evaluation/evaluate_test_part.py report --run ettin-68m # the same with our own model next to them (comparison.json)

`--run` takes runs of model/train.py (data/runs/<name>/scores/test.jsonl, the score of the last
exit). Their texts were cut to 512 tokens by the run itself.
"""

import argparse
import json
import math
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

import evaluate_backends as eb
from compare_onnx import clip_text

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"  # gitignored
CONFIG = HERE.parent / "dataset" / "dataset.json"
SUITE = DATA / "eval_suite.jsonl"
RUNS = DATA / "runs"  # our own models: model/train.py

# maxChars, maxTokens and the thresholds in use are those of extension/models.js (only read here).
MODELS = {
    "tmr": {
        "repo": "Oxidane/tmr-ai-text-detector", "revision": "0ceddea903015ef99cbaa040a4d8a216aed9c683",
        "max_chars": 2000, "max_tokens": 512, "batch": 32,
        "shipped": {"redFrom": 0.98, "shortRedFrom": None, "reliableWords": 120},
    },
    "fakespot": {
        "repo": "fakespot-ai/roberta-base-ai-text-detection-v1", "revision": "f9cdb14d1f8b105f597d80fa7b56f20c6ea0e9db",
        "max_chars": 2000, "max_tokens": 512, "batch": 32,
        "shipped": {"redFrom": 0.999, "shortRedFrom": 0.9994, "reliableWords": 120},
    },
    "desklib": {
        "repo": "desklib/ai-text-detector-v1.01", "revision": "5fdea974cd4287c61674951ec78803aa274e2fb7",
        "max_chars": 1500, "max_tokens": 768, "batch": 16,
        "shipped": {"redFrom": 0.94, "shortRedFrom": 0.98, "reliableWords": 120},
    },
}

TARGET_FA = 0.01
AI_LABEL = re.compile(r"^(ai|machine|generated)$", re.I)  # as in offscreen.js


# --- rows ---------------------------------------------------------------------------------

def load_config() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


def length_groups(cfg: dict) -> list:
    """[(name, first word count, last word count)] as drawn for the excerpts (dataset.json)."""
    return [(f"{lo}-{hi}", lo, hi) for lo, hi, _ in cfg["excerpt"]["lengths"]]


def length_group(words: int, groups: list) -> str:
    """Texts outside the range of the excerpts (the suite has longer ones) count to the nearest group."""
    for name, _, hi in groups:
        if words <= hi:
            return name
    return groups[-1][0]


def load_rows(which: str, cfg: dict) -> list:
    """Rows to score, without what the report does not need. `scored` is the text a model is given
    before its own cut: the excerpt of a test row, the whole text of a suite row."""
    groups = length_groups(cfg)
    rows = []
    if which == "test":
        path = DATA / "dataset" / cfg["version"] / "test.jsonl"
        for line in open(path, encoding="utf-8"):
            r = json.loads(line)
            start, end = r["excerpt"]
            rows.append({k: r[k] for k in ("id", "source", "domain", "label", "generator", "view")} | {"scored": r["text"][start:end]})
    else:
        for i, line in enumerate(open(SUITE, encoding="utf-8")):
            r = json.loads(line)
            rows.append({"id": f"suite:{i}", "source": "suite", "domain": r["domain"], "label": r["label"],
                         "generator": r["generator"], "view": "suite", "scored": r["text"]})
    for r in rows:
        r["words"] = len(r["scored"].split())
        r["length"] = length_group(r["words"], groups)
    return rows


def scores_path(which: str, model: str, cfg: dict) -> Path:
    """The revision is part of the name: scores of another revision are never mixed in."""
    return DATA / "dataset" / cfg["version"] / "scores" / f"{which}-{model}-{MODELS[model]['revision'][:7]}.jsonl"


def read_scores(path: Path) -> dict:
    if not path.exists():
        return {}
    return {r["id"]: r["logit"] for r in map(json.loads, open(path, encoding="utf-8"))}


# --- scoring ------------------------------------------------------------------------------

def log_odds(logits, ai_index: int):
    """log(p(AI) / p(not AI)) from the output of a model with one logit or with one per class."""
    import torch

    logits = logits.double()
    if logits.shape[-1] == 1:
        return logits[:, 0]
    others = logits.clone()
    others[:, ai_index] = -math.inf
    return logits[:, ai_index] - torch.logsumexp(others, dim=-1)


def load_model(name: str):
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    m = MODELS[name]
    if name == "desklib":
        tok, model = eb.load_desklib(m["revision"])
        return tok, model, 0, lambda enc: model(input_ids=enc["input_ids"], attention_mask=enc["attention_mask"])
    tok = AutoTokenizer.from_pretrained(m["repo"], revision=m["revision"])
    model = AutoModelForSequenceClassification.from_pretrained(m["repo"], revision=m["revision"])
    model.eval()
    id2label = model.config.id2label
    ai_index = next((int(k) for k, v in id2label.items() if AI_LABEL.match(str(v))), 1)
    print(f"[{name}] id2label = {id2label}, AI index used = {ai_index}")
    return tok, model, ai_index, lambda enc: model(**enc).logits


def score(name: str, which: str, cfg: dict, limit=None) -> None:
    import torch

    m = MODELS[name]
    path = scores_path(which, name, cfg)
    path.parent.mkdir(parents=True, exist_ok=True)
    done = read_scores(path)
    todo = [r for r in load_rows(which, cfg) if r["id"] not in done]
    for r in todo:
        r["scored"] = clip_text(r["scored"], m["max_chars"])
    # longest first: batches of similar length need little padding, and the estimate of the
    # remaining time errs on the long side
    todo.sort(key=lambda r: -len(r["scored"]))
    if limit:
        todo = todo[:: max(1, len(todo) // limit)][:limit]
    print(f"[{name}] {which}: {len(done)} scored, {len(todo)} to do -> {path}")
    if not todo:
        return

    tok, model, ai_index, forward = load_model(name)
    total = sum(len(r["scored"]) for r in todo)
    seen, start, last = 0, time.time(), time.time()
    with open(path, "a", encoding="utf-8") as out, torch.inference_mode():
        for i in range(0, len(todo), m["batch"]):
            batch = todo[i : i + m["batch"]]
            enc = tok([r["scored"] for r in batch], return_tensors="pt", truncation=True, padding=True, max_length=m["max_tokens"])
            for r, value in zip(batch, log_odds(forward(enc), ai_index).tolist()):
                out.write(json.dumps({"id": r["id"], "logit": value}) + "\n")
            out.flush()
            seen += sum(len(r["scored"]) for r in batch)
            if time.time() - last > 60:
                last = time.time()
                elapsed = last - start
                print(f"[{name}] {i + len(batch)}/{len(todo)} texts, {elapsed / 60:.0f} min, about {elapsed * (total - seen) / seen / 60:.0f} min left", flush=True)
    print(f"[{name}] done: {len(todo)} texts in {(time.time() - start) / 60:.1f} min ({(time.time() - start) / len(todo) * 1000:.0f} ms per text)")


# --- measures -----------------------------------------------------------------------------

def auroc(labels, values) -> float:
    """Probability that an AI text is ranked above a human one; ties count half."""
    labels, values = np.asarray(labels), np.asarray(values, dtype=float)
    n_ai = int(labels.sum())
    n_human = len(labels) - n_ai
    if not n_ai or not n_human:
        return float("nan")
    _, inverse, counts = np.unique(values, return_inverse=True, return_counts=True)
    ranks = (np.cumsum(counts) - (counts - 1) / 2.0)[inverse]
    return float((ranks[labels == 1].sum() - n_ai * (n_ai + 1) / 2.0) / (n_ai * n_human))


def threshold_for(human_values, target: float = TARGET_FA) -> float:
    """Lowest threshold at which at most `target` of the human values are at or above it."""
    h = np.sort(np.asarray(human_values, dtype=float))
    allowed = int(target * len(h))
    if allowed == 0:
        return math.inf
    t = h[len(h) - allowed]
    if h[len(h) - allowed - 1] == t:  # more values tie at t than may be flagged
        t = np.nextafter(t, math.inf)
    return float(t)


def measures(rows: list, humans=None) -> dict:
    """Rows carry `logit` and `flag`. `humans` replaces the human rows of a group that has none
    (the held-out generators are compared with the human texts of `main`)."""
    ai = [r for r in rows if r["label"] == 1]
    own_humans = [r for r in rows if r["label"] == 0]
    human = own_humans or (humans or [])
    tp = sum(r["flag"] for r in ai)
    fp = sum(r["flag"] for r in human)
    out = {"human": len(own_humans), "ai": len(ai), "auroc": float("nan"), "fa": float("nan"), "detected": float("nan"), "f1": float("nan")}
    if own_humans:
        out["fa"] = fp / len(human)
    if ai:
        out["detected"] = tp / len(ai)
    if ai and human:
        out["auroc"] = auroc([1] * len(ai) + [0] * len(human), [r["logit"] for r in ai] + [r["logit"] for r in human])
        out["f1"] = 2 * tp / (2 * tp + fp + len(ai) - tp) if tp else 0.0
    return out


def sigmoid(x: float) -> float:
    return 1 / (1 + math.exp(-x)) if x > -700 else 0.0


def evaluate(rows: list, logits: dict, model: str, cfg: dict, thresholds=None) -> dict:
    """All tables of one model. Without `thresholds` they are set on the human rows of `main`."""
    rows = [{**r, "logit": logits[r["id"]]} for r in rows]
    groups = [name for name, _, _ in length_groups(cfg)]
    if thresholds is None:
        thresholds = {g: threshold_for([r["logit"] for r in rows if r["view"] == "main" and r["label"] == 0 and r["length"] == g]) for g in groups}
    for r in rows:
        r["flag"] = r["logit"] >= thresholds[r["length"]]

    def by(key, part, humans=None):
        keyed = defaultdict(list)
        for r in part:
            keyed[r[key]].append(r)
        return {k: measures(keyed[k], humans) for k in sorted(keyed, key=lambda k: (groups.index(k) if k in groups else 0, k))}

    views = defaultdict(list)
    for r in rows:
        views[r["view"]].append(r)
    main = views.get("main") or rows
    main_humans = [r for r in main if r["label"] == 0]
    out = {
        "thresholds": {g: {"logit": t, "score": sigmoid(t)} for g, t in thresholds.items()},
        "view": {v: measures(part, main_humans) for v, part in views.items()},
        "length": by("length", main),
        "domain": by("domain", main),
        "source": by("source", main),
        # per generator against all human texts of `main`: there is no human side per generator
        "generator": by("generator", [r for r in main if r["label"] == 1] + views.get("held_out_generator", []), main_humans),
    }
    if model not in MODELS:  # a run of our own: nothing is shipped yet
        return out
    # the traffic light as the extension shows it today: red from redFrom, short texts from shortRedFrom
    s = MODELS[model]["shipped"]
    shipped = []
    for r in main:
        red = s["redFrom"] if r["words"] >= s["reliableWords"] else s["shortRedFrom"]
        shipped.append({**r, "flag": red is not None and sigmoid(r["logit"]) >= red, "long": "long" if r["words"] >= s["reliableWords"] else "short"})
    out["shipped"] = {"all": measures(shipped)} | by("long", shipped)
    return out


# --- report -------------------------------------------------------------------------------

def fmt(value, kind: str) -> str:
    if isinstance(value, float) and math.isnan(value):
        return "–"
    return f"{value * 100:.1f}%" if kind in ("fa", "detected") else f"{value:.3f}"


def print_table(title: str, results: dict, section: str, columns=("f1", "auroc", "fa", "detected")) -> None:
    models = list(results)
    keys = list(results[models[0]][section])
    print(f"\n{title}\n")
    print("| | Human | AI | " + " | ".join(f"{m} {c}" for m in models for c in columns) + " |")
    print("|---|---|---|" + "---|" * (len(models) * len(columns)))
    for k in keys:
        first = results[models[0]][section][k]
        cells = [fmt(results[m][section][k][c], c) for m in models for c in columns]
        print(f"| {k} | {first['human']:,} | {first['ai']:,} | " + " | ".join(cells) + " |")


def report(models: list, cfg: dict, runs=()) -> None:
    rows = load_rows("test", cfg)
    results, suite_results, run_records = {}, {}, {}
    for name in models:
        logits = read_scores(scores_path("test", name, cfg))
        missing = sum(r["id"] not in logits for r in rows)
        if missing:
            sys.exit(f"{name}: {missing} of {len(rows)} test rows have no score yet - run 'score {name}' first")
        results[name] = evaluate(rows, logits, name, cfg)
    for name in runs:
        if name in MODELS:
            sys.exit(f"--run {name}: a run must not have the name of a baseline")
        logits = read_scores(RUNS / name / "scores" / "test.jsonl")
        missing = sum(r["id"] not in logits for r in rows)
        if missing:
            sys.exit(f"{name}: {missing} of {len(rows)} test rows have no score in {RUNS / name / 'scores' / 'test.jsonl'} (a run with --rows does not score all of them)")
        results[name] = evaluate(rows, logits, name, cfg)
        run_records[name] = json.loads((RUNS / name / "run.json").read_text(encoding="utf-8"))
    models = models + list(runs)
    for name in models:
        if name not in MODELS:  # the suite as a second view of our own model: work package 8
            continue
        suite_logits = read_scores(scores_path("suite", name, cfg))
        if suite_logits:
            thresholds = {g: t["logit"] for g, t in results[name]["thresholds"].items()}
            suite_results[name] = evaluate(load_rows("suite", cfg), suite_logits, name, cfg, thresholds)

    print(f"Test part of dataset {cfg['version']}: {len(rows):,} excerpts. Thresholds for at most {TARGET_FA:.0%} false alarms on the human texts of `main`:\n")
    print("| Words | " + " | ".join(models) + " |\n|---|" + "---|" * len(models))
    for g in results[models[0]]["thresholds"]:
        print(f"| {g} | " + " | ".join(f"{results[m]['thresholds'][g]['score']:.6f}" for m in models) + " |")
    print_table("Views of the test part", results, "view")
    print_table("`main` by length (words)", results, "length")
    print_table("`main` by domain", results, "domain")
    print_table("`main` by source", results, "source")
    print_table("By generator (`main` and the held-out generators; AUROC against all human texts of `main`)", results, "generator", ("detected", "auroc"))
    shipped = {m: r for m, r in results.items() if "shipped" in r}
    if shipped:
        print_table("`main` at the thresholds the extension uses today (short: below 120 words)", shipped, "shipped", ("fa", "detected"))
    if suite_results:
        print_table("1200-text suite, whole texts, thresholds as above", suite_results, "view")
        print_table("1200-text suite by domain", suite_results, "domain")

    # the baselines alone keep their file; a comparison with runs of our own gets another one
    out = DATA / "dataset" / cfg["version"] / ("comparison.json" if runs else "baselines.json")
    payload = {"dataset": cfg["version"], "target_false_alarms": TARGET_FA,
               "models": {m: {k: MODELS[m][k] for k in ("repo", "revision", "max_chars", "max_tokens")} for m in models if m in MODELS},
               "runs": run_records, "test": results, "suite": suite_results}
    out.write_text(json.dumps(payload, indent=1).replace("NaN", "null"), encoding="utf-8")
    print(f"\nAll numbers -> {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["score", "report"])
    ap.add_argument("models", nargs="*", choices=[*MODELS, []], help="default: all")
    ap.add_argument("--set", dest="which", choices=["test", "suite"], default="test", help="what to score")
    ap.add_argument("--run", nargs="+", default=[], metavar="NAME", help="report: runs of model/train.py to put next to the models")
    ap.add_argument("--limit", type=int, help="score only this many texts, spread over all lengths (to try a model out)")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")
    cfg = load_config()
    models = args.models or list(MODELS)
    if args.command == "score":
        for name in models:
            score(name, args.which, cfg, args.limit)
    else:
        report(models, cfg, args.run)


if __name__ == "__main__":
    main()
