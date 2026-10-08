"""
Is more text per score worthwhile - and do chunks with overlap help? Same HC3 texts
(>= MIN_LEN characters, human/AI balanced), four variants:

    A  first 500 characters (auto-scan in content.js until 2026-09-25)
    B  first 1500 characters in one piece
    C  500-char chunks with 100 characters overlap over the first 1500, mean
    D  500-char chunks without overlap, mean

--normalize removes the HC3/ELI5 artefact (space before punctuation, only in human
texts), so that longer texts do not merely contain more of this shortcut.
Results: EVAL_RESULTS.md, "Text length".

Usage (from this folder):
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
    "A 500 characters": lambda t: [t[:500]],
    "B 1500 in one piece": lambda t: [t[:1500]],
    "C chunks 500, overlap 100": lambda t: chunks(t, stride=400),
    "D chunks 500 without overlap": lambda t: chunks(t, stride=500),
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

    print(f"\n{args.backend}, n={len(texts)}, texts >= {MIN_LEN} characters, normalize={args.normalize}")
    print(f"{'Variant':32} {'AUROC':>6} {'Acc*':>6} {'Passes/text':>11} {'s/text':>7}")
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
        print(f"{name:32} {auroc(labels, agg):6.3f} {best_accuracy(labels, agg):6.3f} {len(flat) / len(texts):11.1f} {secs:7.2f}")
    print("* Accuracy at the best threshold")


if __name__ == "__main__":
    main()
