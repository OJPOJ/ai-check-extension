"""
Reads a feedback export of the extension (Settings -> Feedback -> Export, JSONL) and
writes from it

    <out>/feedback_eval.jsonl   {"text", "is_ai", "basis", "model", "p"} - test material from real browsing
    <out>/feedback_train.jsonl  Laya schema as in prepare_dataset.py (state/questions/gold)

and prints how often the respective model was wrong.

How certain a label is depends on WHERE the person knows it from (field `basis`). Humans recognise
AI text by style hardly better than by chance - "guess" (impression only) therefore goes neither
into training nor into the evaluation by default (--include-guess includes it, e.g. for comparison).

Recommended use: mainly as an eval set and for calibration (roadmap 3). For training
only as a small addition to generated data (see README.md, "Feedback as a data source") - individual
users deliver few, one-sided examples (mostly false alarms on their own favourite sites).

Usage:
    python import_feedback.py aivsai-feedback-2026-09-25.jsonl --out-dir data
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

from prepare_dataset import AI_GENERATED_INSTRUCTIONS

# Probability that the label is correct - becomes the soft training label
BASIS_CONFIDENCE = {
    "own": 0.95,  # written themselves or generated with AI themselves, author known
    "date": 0.90,  # published before 2023 - AI text was still rare then, but dates sometimes lie
    "marked": 0.90,  # labelled as AI
    "guess": 0.60,  # impression only
}


def to_laya_row(text: str, is_ai: bool, confidence: float) -> dict:
    p_true = round(confidence if is_ai else 1 - confidence, 4)
    return {
        "state": json.dumps({"candidates": [{"text": text}]}, ensure_ascii=False),
        "questions": json.dumps({"ai_generated": {"type": "noul", "instructions": AI_GENERATED_INSTRUCTIONS}}),
        "gold": json.dumps({"ai_generated": {"probabilities": {"true": p_true, "false": round(1 - p_true, 4)}}}),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("exports", nargs="+", type=Path, help="JSONL exports of the extension (several are merged)")
    ap.add_argument("--out-dir", type=Path, default=Path("data"))
    ap.add_argument("--include-guess", action="store_true", help="also use 'impression only'")
    args = ap.parse_args()

    # same text from several exports: the newest entry wins
    rows: dict[str, dict] = {}
    for path in args.exports:
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                if row["id"] not in rows or row["at"] > rows[row["id"]]["at"]:
                    rows[row["id"]] = row

    used = [r for r in rows.values() if args.include_guess or r["basis"] != "guess"]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    with open(args.out_dir / "feedback_eval.jsonl", "w", encoding="utf-8") as ev, open(
        args.out_dir / "feedback_train.jsonl", "w", encoding="utf-8"
    ) as tr:
        for r in used:
            is_ai = r["label"] == "ai"
            ev.write(json.dumps({"text": r["text"], "is_ai": is_ai, "basis": r["basis"], "model": r["model"], "p": r["p"]}, ensure_ascii=False) + "\n")
            tr.write(json.dumps(to_laya_row(r["text"], is_ai, BASIS_CONFIDENCE[r["basis"]]), ensure_ascii=False) + "\n")

    print(f"{len(rows)} entries, used {len(used)} ({len(rows) - len(used)} 'impression only' left out)")
    by_model: dict[str, list[dict]] = defaultdict(list)
    for r in used:
        if r["p"] is not None:
            by_model[r["model"]].append(r)
    for model, rs in sorted(by_model.items()):
        humans = [r for r in rs if r["label"] == "human"]
        ais = [r for r in rs if r["label"] == "ai"]
        fp = sum(r["p"] >= 0.5 for r in humans)
        fn = sum(r["p"] < 0.5 for r in ais)
        print(f"  {model}: {len(humans)} human ({fp} of them as AI >= 50%), {len(ais)} AI ({fn} of them < 50%)")
    print(f"-> {args.out_dir / 'feedback_eval.jsonl'}, {args.out_dir / 'feedback_train.jsonl'}")


if __name__ == "__main__":
    main()
