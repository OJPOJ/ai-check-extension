"""
WP-07: fill up desklib scores to the full eval suite (1200 texts). evaluate_suite.py
--backend desklib always only measures a fresh sample (--desklib-n); this script keeps using
the existing 480 scores (data/eval_scores_desklib_suite.jsonl, from the "Broader eval suite"
WP-01) and only scores the remaining ~720 texts anew (text itself as the key - the
suite has no ID of its own, texts are de facto unique in this suite).

Continuously writes progress to data/eval_scores_desklib_suite.jsonl.part (crash-safe)
and at the end the complete 1200 rows to data/eval_scores_desklib_suite.jsonl (same
order as eval_suite.jsonl).

Usage (from training/):
    .venv/Scripts/python.exe desklib_fill_suite.py --suite data/eval_suite.jsonl
"""
import argparse
import json
import time
from pathlib import Path

import evaluate_backends as eb


def load_jsonl(path):
    return [json.loads(l) for l in open(path, encoding="utf-8")]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--suite", default="data/eval_suite.jsonl")
    ap.add_argument("--scores", default="data/eval_scores_desklib_suite.jsonl")
    ap.add_argument("--batch-log", type=int, default=40, help="report progress every N texts")
    args = ap.parse_args()

    suite_path = Path(args.suite)
    scores_path = Path(args.scores)
    part_path = scores_path.with_suffix(scores_path.suffix + ".part")

    suite = load_jsonl(suite_path)
    existing = load_jsonl(scores_path) if scores_path.exists() else []
    done_texts = {r["text"] for r in existing}
    print(f"Suite: {len(suite)} texts, already scored: {len(existing)}")

    missing = [r for r in suite if r["text"] not in done_texts]
    print(f"Missing: {len(missing)} texts -> scoring now (desklib, CPU)")

    t0 = time.time()
    new_scored = []
    CHUNK = 8  # score_desklib batches with 8 itself, but we want to log/save in between
    for i in range(0, len(missing), CHUNK):
        chunk = missing[i : i + CHUNK]
        scores = eb.score_desklib([r["text"] for r in chunk])
        for r, s in zip(chunk, scores):
            new_scored.append({**r, "score": s})
        done_n = len(new_scored)
        if done_n % args.batch_log < CHUNK:
            elapsed = time.time() - t0
            rate = elapsed / done_n
            eta_min = rate * (len(missing) - done_n) / 60
            print(f"  {done_n}/{len(missing)}  ({elapsed:.0f}s, ~{rate:.2f}s/text, ETA {eta_min:.1f} min)", flush=True)
        # save continuously
        with part_path.open("w", encoding="utf-8") as f:
            for r in new_scored:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")

    all_scored = existing + new_scored
    by_text = {r["text"]: r for r in all_scored}
    full = [by_text[r["text"]] for r in suite if r["text"] in by_text]
    assert len(full) == len(suite), f"{len(full)} of {len(suite)} - is something still missing?"

    with scores_path.open("w", encoding="utf-8") as f:
        for r in full:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    part_path.unlink(missing_ok=True)
    print(f"\nDone: {len(full)} scores -> {scores_path} ({time.time() - t0:.0f}s for the {len(missing)} new ones)")


if __name__ == "__main__":
    main()
