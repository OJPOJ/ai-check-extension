"""
WP-07: Prints the same tables as evaluate_suite.py (AUROC, false alarms as displayed, per domain/
generator/length bucket, threshold recommendation), but from already existing raw scores instead of
recomputing - for the full desklib run (n=1200), which came about over several calls (evaluate_suite.py for the
first 480, desklib_fill_suite.py for the rest).

Usage (from training/):
    .venv/Scripts/python.exe report_from_scores.py --backend desklib
"""
import argparse
from pathlib import Path

import evaluate_suite as es


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", choices=["tmr", "desklib"], required=True)
    ap.add_argument("--data-dir", default="data")
    args = ap.parse_args()

    data_dir = Path(args.data_dir)
    scored = es.load_suite(data_dir / f"eval_scores_{args.backend}_suite.jsonl")
    es.report(args.backend, scored, data_dir)


if __name__ == "__main__":
    main()
