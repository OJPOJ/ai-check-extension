"""
WP-07: Druckt dieselben Tabellen wie evaluate_suite.py (AUROC, Fehlalarme wie angezeigt, je Domaene/
Generator/Laengen-Bucket, Schwellen-Empfehlung), aber aus bereits vorhandenen Rohscores statt neu zu
rechnen - fuer den vollen desklib-Lauf (n=1200), der ueber mehrere Aufrufe (evaluate_suite.py fuer die
ersten 480, desklib_fill_suite.py fuer den Rest) entstanden ist.

Nutzung (aus training/):
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
