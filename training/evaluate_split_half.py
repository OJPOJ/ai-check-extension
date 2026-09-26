"""
Taugt die Stabilität innerhalb eines Absatzes als Konfidenz? Kurze Absätze (40..119 Wörter) mit hohem
Score werden an der Satzgrenze nahe der Mitte geteilt, beide Hälften einzeln bewertet. Idee: Bei echtem
KI-Text liegen beide Hälften hoch, bei einem Fehlalarm auf menschlichem Text eher nur eine.
Vergleich mit der längenabhängigen Rot-Schwelle bei gleicher Fehlalarmrate.
Ergebnisse: EVAL_RESULTS.md, "Konfidenz für kurze Absätze".

Eingabe: Dump von evaluate_false_alarms.py (--dump), Ausgabe: JSONL mit Score der Hälften.

Nutzung (aus diesem Ordner):
    .venv/Scripts/python.exe evaluate_false_alarms.py desklib 150 --fine --dump fa_desklib.jsonl
    .venv/Scripts/python.exe evaluate_split_half.py fa_desklib.jsonl halves_desklib.jsonl
"""

import argparse
import json
import re

import evaluate_backends as eb

MIN_SCORE = 0.87  # nur was heute gelb/rot bzw. „unsicher“ wäre
SHORT = (40, 119)


def split_half(text: str) -> tuple[str, str]:
    """Teilt an der Satzgrenze, die der Mitte am nächsten liegt; ohne Satzgrenze an der Wortmitte."""
    cuts = [m.end() for m in re.finditer(r"[.!?][\"')\]]?\s+", text)]
    mid = len(text) / 2
    if cuts:
        cut = min(cuts, key=lambda c: abs(c - mid))
        if 0.25 * len(text) < cut < 0.75 * len(text):
            return text[:cut].strip(), text[cut:].strip()
    words = text.split()
    return " ".join(words[: len(words) // 2]), " ".join(words[len(words) // 2 :])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump")
    ap.add_argument("out")
    args = ap.parse_args()

    rows = [json.loads(l) for l in open(args.dump, encoding="utf-8")]
    rows = [r for r in rows if SHORT[0] <= r["words"] <= SHORT[1] and r["score"] >= MIN_SCORE]
    halves = [split_half(r["text"]) for r in rows]
    scores = eb.score_desklib([h for pair in halves for h in pair])
    with open(args.out, "w", encoding="utf-8") as f:
        for i, r in enumerate(rows):
            f.write(json.dumps({**r, "a": scores[2 * i], "b": scores[2 * i + 1]}) + "\n")
    print(f"{len(rows)} Absätze -> {args.out}")


if __name__ == "__main__":
    main()
