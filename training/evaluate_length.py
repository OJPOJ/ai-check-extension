"""
Lohnt sich mehr Text pro Bewertung - und helfen Chunks mit Überlappung? Gleiche HC3-Texte
(>= MIN_LEN Zeichen, Mensch/KI balanciert), vier Varianten:

    A  erste 500 Zeichen (bis 2026-09-25 Auto-Scan in content.js)
    B  erste 1500 Zeichen am Stück
    C  500er-Chunks mit 100 Zeichen Überlappung über die ersten 1500, Mittelwert
    D  500er-Chunks ohne Überlappung, Mittelwert

--normalize entfernt das HC3/ELI5-Artefakt (Leerzeichen vor Satzzeichen, nur in menschlichen
Texten), damit längere Texte nicht bloß mehr von dieser Abkürzung enthalten.
Ergebnisse: EVAL_RESULTS.md, "Textlänge".

Nutzung (aus diesem Ordner):
    .venv/Scripts/python.exe evaluate_length.py tmr 200 --normalize
    .venv/Scripts/python.exe evaluate_length.py desklib 40
"""

import argparse
import random
import re
import time

import evaluate_backends as eb
from prepare_dataset import iter_hc3_pairs

MIN_LEN = 1500


def clean(text: str, normalize: bool) -> str:
    if normalize:
        text = re.sub(r"\s+([.,!?;:)\]'])", r"\1", text)
        text = re.sub(r"([(\[])\s+", r"\1", text)
        text = re.sub(r"\s+n't", "n't", text)
    return text.strip()


def chunks(text: str, size=500, stride=500, limit=1500) -> list[str]:
    text = text[:limit]
    out = [text[i : i + size] for i in range(0, max(1, len(text) - size + stride), stride)]
    return [c for c in out if len(c) >= 200] or [text[:size]]


def auroc(labels, scores) -> float:
    pos = [s for s, l in zip(scores, labels) if l]
    neg = [s for s, l in zip(scores, labels) if not l]
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    return wins / (len(pos) * len(neg))


def best_accuracy(labels, scores) -> float:
    return max(sum((s >= t) == l for s, l in zip(scores, labels)) / len(labels) for t in set(scores))


def scorer(backend: str):
    return eb.score_tmr if backend == "tmr" else eb.score_desklib


VARIANTS = {
    "A 500 Zeichen": lambda t: [t[:500]],
    "B 1500 am Stück": lambda t: [t[:1500]],
    "C Chunks 500, Überlappung 100": lambda t: chunks(t, stride=400),
    "D Chunks 500 ohne Überlappung": lambda t: chunks(t, stride=500),
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("backend", choices=["tmr", "desklib"])
    ap.add_argument("per_class", type=int)
    ap.add_argument("--normalize", action="store_true")
    args = ap.parse_args()

    random.seed(0)
    rows = [(clean(t, args.normalize), ai) for t, ai in iter_hc3_pairs()]
    rows = [r for r in rows if len(r[0]) >= MIN_LEN]
    humans = [r for r in rows if not r[1]]
    ais = [r for r in rows if r[1]]
    sample = random.sample(humans, args.per_class) + random.sample(ais, args.per_class)
    texts = [t for t, _ in sample]
    labels = [ai for _, ai in sample]
    score = scorer(args.backend)

    print(f"\n{args.backend}, n={len(texts)}, Texte >= {MIN_LEN} Zeichen, normalize={args.normalize}")
    print(f"{'Variante':32} {'AUROC':>6} {'Acc*':>6} {'Pässe/Text':>10} {'s/Text':>7}")
    for name, make in VARIANTS.items():
        parts = [make(t) for t in texts]
        flat = [c for p in parts for c in p]
        start = time.time()
        s = score(flat)
        secs = (time.time() - start) / len(texts)
        agg, i = [], 0
        for p in parts:
            agg.append(sum(s[i : i + len(p)]) / len(p))
            i += len(p)
        print(f"{name:32} {auroc(labels, agg):6.3f} {best_accuracy(labels, agg):6.3f} {len(flat) / len(texts):10.1f} {secs:7.2f}")
    print("* Accuracy bei der besten Schwelle")


if __name__ == "__main__":
    main()
