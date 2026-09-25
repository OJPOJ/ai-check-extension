"""
Erzeugt das Referenzset für „Modell prüfen“ (extension/bg/reference-set.js): je 20 menschliche und
20 KI-Texte (ChatGPT) aus HC3, gleichmäßig über die fünf HC3-Domänen verteilt, pro Frage je eine
menschliche und eine KI-Antwort (gleiches Thema -> das Modell muss am Stil unterscheiden, nicht am Inhalt).

Texte werden normalisiert (HC3/ELI5-Artefakt „Leerzeichen vor Satzzeichen“ entfernt, sonst wäre das
Referenzset per Abkürzung lösbar) und an einer Satzgrenze auf 400..1200 Zeichen gekürzt.
HC3 steht unter CC BY-SA 4.0 (THIRD_PARTY_NOTICES.md).

Nutzung (aus diesem Ordner):
    .venv/Scripts/python.exe build_reference_set.py
    .venv/Scripts/python.exe build_reference_set.py --check tmr desklib   # AUROC der Modelle auf dem Set
"""

import argparse
import json
import random
import re
from pathlib import Path

from evaluate_length import auroc, clean

OUT = Path(__file__).resolve().parent.parent / "extension" / "bg" / "reference-set.js"
DOMAINS = ["reddit_eli5", "finance", "medicine", "open_qa", "wiki_csai"]
PER_DOMAIN = 4
MIN_CHARS, MAX_CHARS = 400, 1200


def cut(text: str) -> str | None:
    text = re.sub(r"\s+", " ", clean(text, True))
    if len(text) < MIN_CHARS:
        return None
    if len(text) <= MAX_CHARS:
        return text
    # letzte Satzgrenze vor MAX_CHARS
    end = max(text.rfind(p, 0, MAX_CHARS) for p in (". ", "! ", "? "))
    return text[: end + 1] if end + 1 >= MIN_CHARS else None


def pick() -> list[tuple[str, bool, str]]:
    from datasets import load_dataset

    ds = load_dataset("Hello-SimpleAI/HC3", revision="refs/convert/parquet")
    split = ds["train"] if "train" in ds else next(iter(ds.values()))
    rng = random.Random(0)
    rows = []
    for domain in DOMAINS:
        candidates = []
        for r in split.filter(lambda r: r["source"] == domain):
            human = [t for t in map(cut, r.get("human_answers") or []) if t]
            ai = [t for t in map(cut, r.get("chatgpt_answers") or []) if t]
            if human and ai:
                candidates.append((human[0], ai[0]))
        for human, ai in rng.sample(candidates, PER_DOMAIN):
            rows += [(human, False, domain), (ai, True, domain)]
    return rows


def write(rows) -> None:
    items = ",\n".join(f"  {{ ai: {str(ai).lower()}, domain: {json.dumps(d)}, text: {json.dumps(t, ensure_ascii=False)} }}" for t, ai, d in rows)
    OUT.write_text(
        "// Referenzset für „Modell prüfen“ (bg/model-check.js): je 20 menschliche und 20 KI-Texte (ChatGPT, 2023)\n"
        "// aus HC3 (Hello-SimpleAI/HC3, CC BY-SA 4.0), Englisch, fünf Domänen. Erzeugt von\n"
        "// training/build_reference_set.py - nicht von Hand ändern.\n"
        f"export const REFERENCE_SET = [\n{items}\n];\n",
        encoding="utf-8",
        newline="\n",
    )


def check(rows, backends) -> None:
    import evaluate_backends as eb

    texts = [t for t, _, _ in rows]
    labels = [ai for _, ai, _ in rows]
    for name in backends:
        scores = (eb.score_tmr if name == "tmr" else eb.score_desklib)(texts)
        human = sorted(s for s, l in zip(scores, labels) if not l)
        ai = sorted(s for s, l in zip(scores, labels) if l)
        print(f"{name}: AUROC {auroc(labels, scores):.3f}, Mittel Mensch {sum(human) / len(human):.3f}, KI {sum(ai) / len(ai):.3f}")
        print("  Mensch:", " ".join(f"{s:.2f}" for s in human))
        print("  KI:    ", " ".join(f"{s:.2f}" for s in ai))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", nargs="*", choices=["tmr", "desklib"], default=[])
    args = ap.parse_args()
    rows = pick()
    write(rows)
    print(f"{len(rows)} Texte -> {OUT}")
    if args.check:
        check(rows, args.check)


if __name__ == "__main__":
    main()
