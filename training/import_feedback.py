"""
Liest einen Feedback-Export der Extension (Einstellungen -> Feedback -> Exportieren, JSONL) und
schreibt daraus

    <out>/feedback_eval.jsonl   {"text", "is_ai", "basis", "model", "p"} - Testmaterial aus echtem Surfen
    <out>/feedback_train.jsonl  Laya-Schema wie prepare_dataset.py (state/questions/gold)

und gibt aus, wie oft das jeweilige Modell danebenlag.

Wie sicher ein Label ist, hängt davon ab, WOHER die Person es weiß (Feld `basis`). Menschen erkennen
KI-Text am Stil kaum besser als per Zufall - "guess" (nur Eindruck) geht deshalb standardmäßig weder
ins Training noch in die Auswertung ein (--include-guess nimmt es mit, z.B. zum Vergleich).

Empfohlene Verwendung: vor allem als Eval-Set und für die Kalibrierung (Roadmap 3). Fürs Training
nur als kleiner Zusatz zu generierten Daten (siehe README.md, "Feedback als Datenquelle") - einzelne
Nutzer:innen liefern wenige, einseitige Beispiele (meist Fehlalarme auf den eigenen Lieblingsseiten).

Nutzung:
    python import_feedback.py aivsai-feedback-2026-09-25.jsonl --out-dir data
"""

import argparse
import json
from collections import defaultdict
from pathlib import Path

from prepare_dataset import AI_GENERATED_INSTRUCTIONS

# Wahrscheinlichkeit, dass das Label stimmt - wird zum weichen Trainingslabel
BASIS_CONFIDENCE = {
    "own": 0.95,  # selbst geschrieben bzw. selbst mit KI erzeugt, Autor:in bekannt
    "date": 0.90,  # vor 2023 veröffentlicht - KI-Text war da noch selten, aber Datumsangaben lügen manchmal
    "marked": 0.90,  # als KI gekennzeichnet
    "guess": 0.60,  # nur Eindruck
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
    ap.add_argument("exports", nargs="+", type=Path, help="JSONL-Exporte der Extension (mehrere werden zusammengeführt)")
    ap.add_argument("--out-dir", type=Path, default=Path("data"))
    ap.add_argument("--include-guess", action="store_true", help="auch 'nur Eindruck' verwenden")
    args = ap.parse_args()

    # gleicher Text aus mehreren Exporten: der neueste Eintrag gewinnt
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

    print(f"{len(rows)} Einträge, verwendet {len(used)} ({len(rows) - len(used)} 'nur Eindruck' ausgelassen)")
    by_model: dict[str, list[dict]] = defaultdict(list)
    for r in used:
        if r["p"] is not None:
            by_model[r["model"]].append(r)
    for model, rs in sorted(by_model.items()):
        humans = [r for r in rs if r["label"] == "human"]
        ais = [r for r in rs if r["label"] == "ai"]
        fp = sum(r["p"] >= 0.5 for r in humans)
        fn = sum(r["p"] < 0.5 for r in ais)
        print(f"  {model}: {len(humans)} Mensch (davon {fp} als KI >= 50 %), {len(ais)} KI (davon {fn} < 50 %)")
    print(f"-> {args.out_dir / 'feedback_eval.jsonl'}, {args.out_dir / 'feedback_train.jsonl'}")


if __name__ == "__main__":
    main()
