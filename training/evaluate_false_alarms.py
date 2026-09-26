"""
Wie oft wird menschlicher Sachtext rot bzw. gelb markiert - und wie viel KI-Text erkennt die Ampel dann
noch? Grundlage für die Default-Schwellen und die Stufe „zu kurz / unsicher“ (TODO.md, Punkt 2).

Mensch: Absätze aus WikiText-2 (Wikipedia „Good“/„Featured“ Articles, vor 2016 veröffentlicht, also sicher
ohne LLM). Zum Vergleich menschliche HC3-Antworten (überwiegend Reddit ELI5). KI: ChatGPT-Antworten aus
HC3. Alle Texte wie im Auto-Scan auf maxChars gekürzt (TMR 2000, desklib 1500), aufgeteilt nach Wortzahl.

Einschränkungen: nur Englisch, nur ChatGPT 2023; beide Modelle kennen HC3 womöglich aus dem Training
(Erkennungsraten eher zu optimistisch). Die Fehlalarm-Raten auf Wikipedia hängen davon nicht ab.
Ergebnisse: EVAL_RESULTS.md, "Fehlalarme auf Wikipedia".

Nutzung (aus diesem Ordner):
    python evaluate_false_alarms.py tmr 300
    python evaluate_false_alarms.py desklib 60
    python evaluate_false_alarms.py desklib 150 --fine   # 20-Wort-Schritte unter 120 (Grenze „unsicher“)
"""
import argparse
import json
import random
import re

import evaluate_backends as eb
from prepare_dataset import iter_hc3_pairs

MAX_CHARS = {"tmr": 2000, "desklib": 1500}
# Wortzahl-Bereiche; 40 = Mindestlänge des Auto-Scans (content.js, MIN_WORDS)
BUCKETS = [(40, 79), (80, 119), (120, 149), (150, 10_000)]
FINE_BUCKETS = [(40, 59), (60, 79), (80, 99), (100, 119), (120, 149), (150, 10_000)]
RED = [0.87, 0.9, 0.95, 0.97, 0.98, 0.99]  # 0.87 = desklib-Preset
YELLOW = [0.5, 0.6, 0.8]


def words(text: str) -> int:
    return len(text.split())


def bucket_of(text: str):
    n = words(text)
    return next((b for b in BUCKETS if b[0] <= n <= b[1]), None)


def clip(text: str, max_chars: int) -> str:
    """Wie clipText() in content.js: am letzten Satzende, sonst am letzten Leerzeichen."""
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    m = re.match(r"^[\s\S]*[.!?…][\"'”’»)\]]?(?=\s)", cut)
    if m and len(m.group(0)) >= max_chars * 0.6:
        return m.group(0)
    space = cut.rfind(" ")
    return cut[:space] if space >= max_chars * 0.6 else cut


def untokenize(text: str) -> str:
    """WikiText ist tokenisiert ("in 1998 @,@ the" , "word , word") - zurück zu normalem Text."""
    text = re.sub(r" @(.)@ ", r"\1", text)
    text = re.sub(r"\s+([.,!?;:)\]'%])", r"\1", text)
    text = re.sub(r"([(\[$])\s+", r"\1", text)
    text = re.sub(r"\s+(n't|'s|'re|'ve|'ll|'d)\b", r"\1", text)
    text = re.sub(r'" (.*?) "', r'"\1"', text)
    return text.strip()


def wikipedia_paragraphs():
    from datasets import load_dataset

    ds = load_dataset("wikitext", "wikitext-2-raw-v1")
    for split in ("validation", "test"):
        for row in ds[split]:
            line = row["text"].strip()
            if line and not line.startswith("="):
                yield untokenize(line)


def sample_by_bucket(texts, per_bucket: int):
    by = {b: [] for b in BUCKETS}
    for t in texts:
        b = bucket_of(t)
        if b:
            by[b].append(t)
    return {b: random.sample(ts, min(per_bucket, len(ts))) for b, ts in by.items()}


def share(scores, thresh) -> str:
    return f"{100 * sum(s >= thresh for s in scores) / len(scores):5.1f}%"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("backend", choices=["tmr", "desklib"])
    ap.add_argument("per_bucket", type=int, help="Texte pro Quelle und Längenbereich")
    ap.add_argument("--fine", action="store_true", help="feinere Längenbereiche unter 120 Wörtern")
    ap.add_argument("--dump", help="Einzelwerte als JSONL (Quelle, Wörter, Zeichen, Score, Text) für eigene Auswertungen")
    args = ap.parse_args()
    if args.fine:
        BUCKETS[:] = FINE_BUCKETS
    random.seed(0)
    score = eb.score_tmr if args.backend == "tmr" else eb.score_desklib
    max_chars = MAX_CHARS[args.backend]

    hc3 = [(re.sub(r"\s+([.,!?;:)\]'])", r"\1", t).strip(), ai) for t, ai in iter_hc3_pairs()]
    sources = {
        "Wikipedia (Mensch)": sample_by_bucket(wikipedia_paragraphs(), args.per_bucket),
        "HC3 (Mensch)": sample_by_bucket((t for t, ai in hc3 if not ai), args.per_bucket),
        "HC3 ChatGPT (KI)": sample_by_bucket((t for t, ai in hc3 if ai), args.per_bucket),
    }

    print(f"\n{args.backend}: Anteil mit Score >= Schwelle (Mensch = Fehlalarm, KI = erkannt)")
    header = f"{'Quelle':20} {'Wörter':>9} {'n':>4} " + " ".join(f"{'>=' + str(t):>7}" for t in YELLOW + RED)
    print(header)
    rows = []
    for name, buckets in sources.items():
        for (lo, hi), texts in buckets.items():
            if not texts:
                continue
            clipped = [clip(t, max_chars) for t in texts]
            s = score(clipped)
            rows += [{"source": name, "words": words(t), "chars": len(t), "score": p, "text": t} for t, p in zip(clipped, s)]
            label = f"{lo}-{hi}" if hi < 10_000 else f"{lo}+"
            print(f"{name:20} {label:>9} {len(s):4d} " + " ".join(f"{share(s, t):>7}" for t in YELLOW + RED))

    if args.dump:
        with open(args.dump, "w", encoding="utf-8") as f:
            f.writelines(json.dumps(r) + "\n" for r in rows)


if __name__ == "__main__":
    main()
