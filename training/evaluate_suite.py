"""
Evaluates the broader eval suite (build_eval_suite.py, training/data/eval_suite.jsonl) for TMR and
desklib: AUROC overall/per domain/per generator/per length bucket, false alarm rate at the current
thresholds (extension/models.js - only read, not changed) and a threshold recommendation for
~1% false alarms. Does not update training/EVAL_RESULTS.md automatically (numbers taken over by hand,
as in the previous runs in this folder) - instead prints all tables to stdout and
writes raw scores to data/eval_scores_<backend>_suite.jsonl.

desklib is slow (CPU, ~2-3 s/text) - by default only a sample (--desklib-n, default
400, stratified by domain x human/AI). TMR always runs on the full suite.

WP-06: `--backend hf:<repo>` evaluates any HF sequence classification repo (candidate
between TMR and desklib) the same way - AUROC, as displayed (reliableWords/shortRedFrom), percentile
thresholds. Since there is no "current" production threshold for it, the 99th-percentile threshold
(separately for < 120 / >= 120 words) is automatically used as redFrom/shortRedFrom for the "as displayed"
section - this makes the sections below comparable, but it is derived from the same data
(no train/test split, see the EVAL_RESULTS.md "Correction" note on sampling uncertainty).
--candidate-n limits the sample for hf: candidates (default: full suite, stratified if
smaller).

Usage (from this folder):
    python evaluate_suite.py --backend tmr
    python evaluate_suite.py --backend desklib --desklib-n 400
    python evaluate_suite.py --backend both --desklib-n 400
    python evaluate_suite.py --backend hf:fakespot-ai/roberta-base-ai-text-detection-v1
"""
import argparse
import json
import random
from collections import defaultdict
from pathlib import Path

import evaluate_backends as eb

SUITE_PATH = Path("data/eval_suite.jsonl")  # overridable via --suite (the worktree has no data/ linked)

# Current traffic light starting values, only read from extension/models.js (state: see the comments there) -
# this script does not change the extension, it only measures against these values.
CURRENT = {
    "tmr": {"yellowFrom": 0.95, "redFrom": 0.98, "reliableWords": 120, "shortRedFrom": None},
    "desklib": {"yellowFrom": 0.5, "redFrom": 0.87, "reliableWords": 120, "shortRedFrom": 0.98},
}

BUCKETS = [(40, 79), (80, 119), (120, 149), (150, 10_000)]


def bucket_of(words):
    return next((b for b in BUCKETS if b[0] <= words <= b[1]), None)


def bucket_label(b):
    lo, hi = b
    return f"{lo}-{hi}" if hi < 10_000 else f"{lo}+"


def load_suite(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def stratified_subsample(rows, n, seed):
    """n texts, distributed evenly over (domain, label) (human/AI equally strong per domain)."""
    by_key = defaultdict(list)
    for r in rows:
        by_key[(r["domain"], r["label"])].append(r)
    rnd = random.Random(seed)
    for v in by_key.values():
        rnd.shuffle(v)
    keys = sorted(by_key)
    per_key = max(1, n // len(keys))
    out = []
    for k in keys:
        out.extend(by_key[k][:per_key])
    rnd.shuffle(out)
    return out[:n]


def score_rows(rows, backend):
    texts = [r["text"] for r in rows]
    if backend == "tmr":
        scores = eb.score_tmr(texts)
    elif backend == "desklib":
        scores = eb.score_desklib(texts)
    elif backend.startswith("hf:"):
        scores = eb.score_hf(texts, backend[len("hf:") :])
    else:
        raise ValueError(f"unknown backend: {backend}")
    return [{**r, "score": s} for r, s in zip(rows, scores)]


def share(scores, thresh):
    # thresh=None (e.g. yellowFrom for WP-06 candidates without a production threshold) -> cannot be evaluated
    if not scores or thresh is None:
        return float("nan")
    return sum(s >= thresh for s in scores) / len(scores)


def percentile(values, p):
    """p in [0,1]. Simple linear interpolation, no extra dependency (numpy would be fine, but
    unnecessary for this order of magnitude)."""
    if not values:
        return float("nan")
    s = sorted(values)
    idx = p * (len(s) - 1)
    lo, hi = int(idx), min(int(idx) + 1, len(s) - 1)
    frac = idx - lo
    return s[lo] * (1 - frac) + s[hi] * frac


def report(backend, scored, out_dir: Path):
    labels = [r["label"] for r in scored]
    scores = [r["score"] for r in scored]
    a = eb.auroc(labels, scores)
    n_human = sum(1 for l in labels if l == 0)
    n_ai = sum(1 for l in labels if l == 1)
    print(f"\n{'=' * 70}\n{backend.upper()}  (n={len(scored)}, human={n_human}, AI={n_ai})\n{'=' * 70}")
    print(f"AUROC overall: {a:.4f}")

    human_scores = [r["score"] for r in scored if r["label"] == 0]
    ai_scores = [r["score"] for r in scored if r["label"] == 1]

    if backend in CURRENT:
        cur = CURRENT[backend]
    else:
        # WP-06 candidate without a production threshold: use the 99th percentile of the human scores (separated by
        # reliableWords=120) as redFrom/shortRedFrom, so that the sections below (as
        # displayed, per domain/generator/bucket) still compute against a realistic ~1% FA threshold
        # instead of an arbitrary default. Derived from the same data as the
        # percentile recommendation further below - no independent confirmation, see docstring.
        reliable_words = 120
        long_h = [r["score"] for r in scored if r["label"] == 0 and r["words"] >= reliable_words]
        short_h = [r["score"] for r in scored if r["label"] == 0 and r["words"] < reliable_words]
        cur = {
            "yellowFrom": None,
            "redFrom": percentile(long_h, 0.99) if long_h else percentile(human_scores, 0.99),
            "reliableWords": reliable_words,
            "shortRedFrom": percentile(short_h, 0.99) if short_h else None,
        }
        print(
            f"(No production value for {backend} - thresholds used from the 99th percentile of this "
            f"measurement: redFrom={cur['redFrom']:.4f} shortRedFrom={cur['shortRedFrom']})"
        )

    fa_yellow = share(human_scores, cur["yellowFrom"])
    fa_red = share(human_scores, cur["redFrom"])
    det_red = share(ai_scores, cur["redFrom"])
    print(
        f"Current thresholds yellowFrom={cur['yellowFrom']} redFrom={cur['redFrom']}: "
        f"False alarms (human) >=yellow {fa_yellow:.3f}, >=red {fa_red:.3f}; AI detected >=red {det_red:.3f}"
    )

    # Red as in the extension (config.js, levelOf): below reliableWords only from shortRedFrom, without
    # shortRedFrom never red ("uncertain"). This is the false alarm rate that users actually see.
    def shown_red(r):
        if r["words"] >= cur["reliableWords"]:
            return r["score"] >= cur["redFrom"]
        return cur["shortRedFrom"] is not None and r["score"] >= cur["shortRedFrom"]

    def rate(rs):
        return sum(map(shown_red, rs)) / len(rs) if rs else float("nan")

    print(
        f"As displayed (short paragraphs by shortRedFrom): false alarms red "
        f"{rate([r for r in scored if r['label'] == 0]):.3f}; AI red {rate([r for r in scored if r['label'] == 1]):.3f}"
    )

    print("\nAUROC per domain:")
    by_domain = defaultdict(list)
    for r in scored:
        by_domain[r["domain"]].append(r)
    for dom in sorted(by_domain):
        rs = by_domain[dom]
        a_d = eb.auroc([r["label"] for r in rs], [r["score"] for r in rs])
        fa_d = share([r["score"] for r in rs if r["label"] == 0], cur["redFrom"])
        det_d = share([r["score"] for r in rs if r["label"] == 1], cur["redFrom"])
        fa_shown = rate([r for r in rs if r["label"] == 0])
        det_shown = rate([r for r in rs if r["label"] == 1])
        print(
            f"  {dom:14} n={len(rs):4d}  AUROC={a_d:.3f}  FA@red={fa_d:.3f}  detected@red={det_d:.3f}  "
            f"as displayed: FA={fa_shown:.3f} detected={det_shown:.3f}"
        )

    print("\nDetection per generator (share >= redFrom, AI rows only):")
    by_gen = defaultdict(list)
    for r in scored:
        if r["label"] == 1:
            by_gen[r["generator"]].append(r["score"])
    for gen in sorted(by_gen):
        print(f"  {gen:16} n={len(by_gen[gen]):4d}  detected@red={share(by_gen[gen], cur['redFrom']):.3f}  mean={sum(by_gen[gen]) / len(by_gen[gen]):.3f}")

    print("\nFalse alarms per length bucket (human rows only):")
    by_bucket_human = defaultdict(list)
    by_bucket_ai = defaultdict(list)
    for r in scored:
        b = bucket_of(r["words"])
        if b is None:
            continue
        (by_bucket_human if r["label"] == 0 else by_bucket_ai)[b].append(r["score"])
    for b in BUCKETS:
        hs = by_bucket_human.get(b, [])
        ais = by_bucket_ai.get(b, [])
        if not hs and not ais:
            continue
        print(
            f"  {bucket_label(b):8} n_human={len(hs):4d} FA@yellow={share(hs, cur['yellowFrom']):.3f} "
            f"FA@red={share(hs, cur['redFrom']):.3f}  n_ai={len(ais):4d} detected@red={share(ais, cur['redFrom']):.3f}"
        )

    print("\nThreshold recommendation for ~1% false alarms on this suite (percentile of the human scores):")
    t_all = percentile(human_scores, 0.99)
    print(f"  overall (all lengths): threshold {t_all:.4f} -> FA {share(human_scores, t_all):.3f}, AI detected {share(ai_scores, t_all):.3f}")
    short_human = [r["score"] for r in scored if r["label"] == 0 and r["words"] < cur["reliableWords"]]
    long_human = [r["score"] for r in scored if r["label"] == 0 and r["words"] >= cur["reliableWords"]]
    short_ai = [r["score"] for r in scored if r["label"] == 1 and r["words"] < cur["reliableWords"]]
    long_ai = [r["score"] for r in scored if r["label"] == 1 and r["words"] >= cur["reliableWords"]]
    if short_human:
        t_short = percentile(short_human, 0.99)
        print(f"  < {cur['reliableWords']} words: threshold {t_short:.4f} -> FA {share(short_human, t_short):.3f}, AI detected {share(short_ai, t_short):.3f}")
    if long_human:
        t_long = percentile(long_human, 0.99)
        print(f"  >= {cur['reliableWords']} words: threshold {t_long:.4f} -> FA {share(long_human, t_long):.3f}, AI detected {share(long_ai, t_long):.3f}")

    backend_safe = backend.replace("hf:", "").replace("/", "_")
    out_path = out_dir / f"eval_scores_{backend_safe}_suite.jsonl"
    with out_path.open("w", encoding="utf-8") as f:
        for r in scored:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"\nRaw scores -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--backend", default="both", help="tmr | desklib | both | hf:<repo> (WP-06 candidate)")
    ap.add_argument("--desklib-n", type=int, default=400, help="sample size for desklib (slow)")
    ap.add_argument("--candidate-n", type=int, default=None, help="sample size for hf: candidates (default: full suite)")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--suite", default=str(SUITE_PATH), help="path to eval_suite.jsonl")
    args = ap.parse_args()
    if args.backend not in ("tmr", "desklib", "both") and not args.backend.startswith("hf:"):
        ap.error("--backend must be tmr, desklib, both or hf:<repo>")

    suite_path = Path(args.suite)
    out_dir = suite_path.parent

    rows = load_suite(suite_path)
    print(f"Eval suite: {len(rows)} texts from {suite_path}")

    if args.backend in ("tmr", "both"):
        scored = score_rows(rows, "tmr")
        report("tmr", scored, out_dir)

    if args.backend in ("desklib", "both"):
        sub = stratified_subsample(rows, args.desklib_n, args.seed)
        print(f"\ndesklib: sample {len(sub)}/{len(rows)} (stratified by domain x human/AI)")
        scored = score_rows(sub, "desklib")
        report("desklib", scored, out_dir)

    if args.backend.startswith("hf:"):
        if args.candidate_n and args.candidate_n < len(rows):
            sub = stratified_subsample(rows, args.candidate_n, args.seed)
            print(f"\n{args.backend}: sample {len(sub)}/{len(rows)} (stratified by domain x human/AI)")
        else:
            sub = rows
        scored = score_rows(sub, args.backend)
        report(args.backend, scored, out_dir)


if __name__ == "__main__":
    main()
