"""
WP-07: Cross-validation of the traffic light thresholds (redFrom, shortRedFrom) on the broad eval suite
(data/eval_suite.jsonl + the raw scores from evaluate_suite.py/desklib_fill_suite.py).

Method (DECISION, see orchestration/LOG.md): repeated random half/half splits,
stratified by (domain, label), so that each half has the same domain/class mix as the
whole suite - the same method as already in EVAL_RESULTS.md "Confidence for short paragraphs" (200x
Wikipedia halves). Per repetition:
  1. Half A: choose the threshold such that ~1% of the HUMAN scores "as displayed" (rule 9 in
     orchestration/README.md - config.js level(): below reliableWords shortRedFrom applies instead of
     redFrom, without shortRedFrom it stays "unclear") lie above it (99th percentile).
  2. Half B (unseen): measure the actual false alarm/detection rate with this threshold.
Separately for the "long" group (>= reliableWords, governs redFrom) and the "short" group
(< reliableWords, governs shortRedFrom, only if the model has one).

Additionally: the same 200 test halves are also evaluated with the CURRENT values from models.js,
to get an error range (5th-95th percentile) of today's numbers (task: "confidence interval
of the current values").

Usage (from training/):
    .venv/Scripts/python.exe crossval_thresholds.py --backend tmr
    .venv/Scripts/python.exe crossval_thresholds.py --backend desklib
    .venv/Scripts/python.exe crossval_thresholds.py --backend both --reps 200

WP-09: --backend fakespot reads data/eval_scores_fakespot_suite.jsonl (ONNX scores, MedAliFarhat/
ai-text-detector-onnx - exactly the numbers the extension would actually see, see compare_onnx.py).
No "current" value (the model is new, not yet in models.js) - current_on_testhalves() is skipped
for it (CURRENT entry set to None).
"""
import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path

RELIABLE_WORDS = 120
TARGET_FA = 0.01

# Current traffic light starting values from extension/models.js (only read) - as in evaluate_suite.py
CURRENT = {
    "tmr": {"redFrom": 0.98, "shortRedFrom": None},
    "desklib": {"redFrom": 0.87, "shortRedFrom": 0.98},
    "fakespot": {"redFrom": None, "shortRedFrom": None},  # new model, no production threshold
}


def load_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def percentile(values, p):
    if not values:
        return float("nan")
    s = sorted(values)
    idx = p * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def share(scores, thresh):
    return sum(s >= thresh for s in scores) / len(scores) if scores else float("nan")


def stratified_half_split(rows, rnd):
    """Two halves of roughly equal size, each (domain,label) split as evenly as possible."""
    by_key = defaultdict(list)
    for r in rows:
        by_key[(r["domain"], r["label"])].append(r)
    a, b = [], []
    for key, items in by_key.items():
        items = items[:]
        rnd.shuffle(items)
        half = len(items) // 2
        a.extend(items[:half])
        b.extend(items[half:])
    return a, b


def select_threshold(train_human_scores, target_fa=TARGET_FA):
    return percentile(train_human_scores, 1 - target_fa)


def crossval(rows, reps, seed, bucket_name, in_bucket):
    """rows: all rows of the backend (with 'score'). in_bucket(r)->bool selects the word group.
    Returns a list of dicts, one per repetition: chosen threshold, FA/detection on half B."""
    sub = [r for r in rows if in_bucket(r)]
    n_human = sum(1 for r in sub if r["label"] == 0)
    n_ai = sum(1 for r in sub if r["label"] == 1)
    print(f"  Bucket {bucket_name}: n={len(sub)} (human={n_human}, AI={n_ai})")
    if n_human < 10 or n_ai < 10:
        print(f"    -> too little data for cross-validation, skipped")
        return []
    rnd = random.Random(seed)
    out = []
    for i in range(reps):
        a, b = stratified_half_split(sub, rnd)
        a_human = [r["score"] for r in a if r["label"] == 0]
        b_human = [r["score"] for r in b if r["label"] == 0]
        b_ai = [r["score"] for r in b if r["label"] == 1]
        if len(a_human) < 5 or len(b_human) < 5 or len(b_ai) < 5:
            continue
        t = select_threshold(a_human)
        out.append({
            "threshold": t,
            "fa_test": share(b_human, t),
            "det_test": share(b_ai, t),
        })
    return out


def current_on_testhalves(rows, reps, seed, bucket_name, in_bucket, current_t):
    """The same kind of splits, but instead of a chosen threshold today's fixed threshold -
    yields the distribution of the FA/detection rate on (independent) test halves -> CI."""
    if current_t is None:
        return []
    sub = [r for r in rows if in_bucket(r)]
    if sum(1 for r in sub if r["label"] == 0) < 10:
        return []
    rnd = random.Random(seed + 1)  # different draw than crossval(), but same method
    out = []
    for i in range(reps):
        a, b = stratified_half_split(sub, rnd)
        b_human = [r["score"] for r in b if r["label"] == 0]
        b_ai = [r["score"] for r in b if r["label"] == 1]
        if len(b_human) < 5 or len(b_ai) < 5:
            continue
        out.append({"fa_test": share(b_human, current_t), "det_test": share(b_ai, current_t)})
    return out


def summarize(vals, key):
    xs = sorted(v[key] for v in vals if v[key] == v[key])  # drop NaN
    if not xs:
        return None
    return {
        "median": statistics.median(xs),
        "p5": percentile(xs, 0.05),
        "p95": percentile(xs, 0.95),
        "min": xs[0],
        "max": xs[-1],
        "n": len(xs),
    }


def fmt(s):
    if s is None:
        return "n/a"
    return f"median {s['median']:.4f} (5-95%: {s['p5']:.4f}-{s['p95']:.4f}, n={s['n']})"


def run_backend(backend, scores_path, reps, seed):
    rows = load_jsonl(scores_path)
    print(f"\n{'=' * 70}\n{backend.upper()}  (n={len(rows)})  {reps}x stratified half/half splits\n{'=' * 70}")

    buckets = [
        ("long (>=120 words, governs redFrom)", lambda r: r["words"] >= RELIABLE_WORDS),
        ("short (<120 words, governs shortRedFrom)", lambda r: r["words"] < RELIABLE_WORDS),
    ]
    cur = CURRENT[backend]
    current_vals = [cur["redFrom"], cur["shortRedFrom"]]

    results = {}
    for (label, pred), cur_t in zip(buckets, current_vals):
        print(f"\n-- {label} --")
        cv = crossval(rows, reps, seed, label, pred)
        if not cv:
            results[label] = None
            continue
        t_summary = summarize(cv, "threshold")
        fa_summary = summarize(cv, "fa_test")
        det_summary = summarize(cv, "det_test")
        print(f"  Cross-validated threshold (target {TARGET_FA*100:.0f}% FA on train half): {fmt(t_summary)}")
        print(f"  -> False alarms on (unseen) test half:                                 {fmt(fa_summary)}")
        print(f"  -> AI detected on test half:                                           {fmt(det_summary)}")

        if cur_t is not None:
            cv_cur = current_on_testhalves(rows, reps, seed, label, pred, cur_t)
            fa_cur = summarize(cv_cur, "fa_test")
            det_cur = summarize(cv_cur, "det_test")
            print(f"  Current threshold {cur_t}: false alarms on test halves (CI):                {fmt(fa_cur)}")
            print(f"  Current threshold {cur_t}: AI detected on test halves (CI):                {fmt(det_cur)}")
        else:
            fa_cur = det_cur = None
            print(f"  (no current value for this bucket - e.g. TMR without shortRedFrom)")

        results[label] = {
            "threshold": t_summary, "fa_test": fa_summary, "det_test": det_summary,
            "current_fa": fa_cur, "current_det": det_cur, "current_t": cur_t,
        }
    return results


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", choices=["tmr", "desklib", "both", "fakespot"], default="both")
    ap.add_argument("--reps", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--data-dir", default="data")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    backends = ["tmr", "desklib"] if args.backend == "both" else [args.backend]
    for b in backends:
        path = data_dir / f"eval_scores_{b}_suite.jsonl"
        run_backend(b, path, args.reps, args.seed)


if __name__ == "__main__":
    main()
