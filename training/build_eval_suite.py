"""
Baut eine breitere, reproduzierbare Eval-Suite (TODO Punkt 3 / WP-01) aus dem öffentlichen
Datensatz Jinyan1/COLING_2025_MGT_en (Hugging Face). Dieser Datensatz fasst drei Forschungs-
Benchmarks fürs Human-vs-KI-Erkennen zusammen (Spalte "source"): MAGE (Apache-2.0), M4GT-Bench
(EACL 2024, mbzuai-nlp/M4 - keine explizite Lizenzdatei im Repo gefunden, reine Recherche-
Nutzung) und HC3 (Apache-2.0, wird in diesem Projekt bereits für prepare_dataset.py genutzt).
Für die eigene Zusammenstellung (Jinyan1/COLING_2025_MGT_en) selbst ist im Dataset-Karten-YAML
keine Lizenz eingetragen - siehe ENTSCHEIDUNG im Log. Nur zur lokalen Auswertung genutzt, Rohdaten
bleiben unter training/data/ (gitignored), werden nicht weiterverteilt.

Domänen (unsere Kategorie -> sub_source-Werte des Datensatzes):
    news         xsum, cnn, tldr, dialogsum      (Nachrichten/Zusammenfassungen)
    wikipedia    wikipedia, wiki_csai
    forum        reddit, cmv, reddit_eli5, eli5
    sci_abstract arxiv, sci_gen, peerread, pubmed (wissenschaftliche Abstracts)
    reviews      yelp, imdb
    howto        wikihow

Generatoren (Spalte "model"): human sowie, soweit für die Domäne vorhanden,
gpt4, gpt4o, gpt-3.5-turbo, llama3-70b, mixtral-8x7b, gemma2-9b-it, cohere - die aktuellsten
öffentlich verfügbaren Generatoren in diesem Datensatz (siehe Log: "news" und "reviews" haben im
Datensatz nur gpt-3.5-turbo als KI-Generator, keine neueren). Ältere/kleine Modelle (davinci,
opt_*, flan_t5_*, t0_*, bloom*, gpt_j, gpt_neox, GLM130B, dolly*) bewusst ausgelassen - nicht
mehr repräsentativ für heutigen KI-Text im Web.

Text -> Absatz (40-400 Wörter, wie extension/length-buckets.js / content.js MIN_WORDS):
Whitespace wird zu einem einzigen Absatz zusammengefasst (reale Webseiten-Absätze haben auch
keine Leerzeilen mehr, wenn man sie ausliest) und bei Bedarf am nächsten Satzende auf 400 Wörter
gekürzt (wie clip() in evaluate_false_alarms.py, nur wortbasiert statt zeichenbasiert).

Nutzung:
    .venv/Scripts/python.exe build_eval_suite.py                 # Standardgrößen (siehe unten)
    .venv/Scripts/python.exe build_eval_suite.py --out data/eval_suite.jsonl --seed 42
"""

import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path

DOMAINS = {
    "news": ["xsum", "cnn", "tldr", "dialogsum"],
    "wikipedia": ["wikipedia", "wiki_csai"],
    "forum": ["reddit", "cmv", "reddit_eli5", "eli5"],
    "sci_abstract": ["arxiv", "sci_gen", "peerread", "pubmed"],
    "reviews": ["yelp", "imdb"],
    "howto": ["wikihow"],
}
SUB2DOM = {s: d for d, subs in DOMAINS.items() for s in subs}

# Generatoren in Prioritätsreihenfolge (die je Domäne fehlenden werden übersprungen, siehe Log)
GENERATORS = ["gpt4", "gpt4o", "gpt-3.5-turbo", "llama3-70b", "mixtral-8x7b", "gemma2-9b-it", "cohere"]

MIN_WORDS = 40
MAX_WORDS = 400

SENT_END = re.compile(r"[.!?…][\"'”’»)\]]?(?=\s|$)")

# Tokenisierungs-Artefakt aus reddit_eli5/wikihow-Teilen mehrerer Quell-Datensätze ("wax .", "1 )") -
# gleiches Problem wie in prepare_dataset.py dokumentiert und in evaluate_false_alarms.py normalisiert.
# Ohne Normalisierung würde ein Modell "Leerzeichen vor Satzzeichen" als Shortcut für "menschlich" lernen
# können, was auf echten Webseiten (ohne dieses Artefakt) nicht zutrifft.
ARTIFACT_SPACE = re.compile(r"\s+([.,!?;:)\]'])")


def extract_excerpt(text: str, min_words=MIN_WORDS, max_words=MAX_WORDS):
    """Ein Absatz (40-400 Wörter) aus einem ggf. längeren Dokument. Whitespace/Zeilenumbrüche
    werden zu einem Absatz zusammengefasst (wie ein realer Webseiten-Absatz), Tokenisierungs-
    Artefakte entfernt, bei Bedarf am nächsten Satzende gekürzt. None, wenn der Text auch
    komplett unter min_words bleibt."""
    text = " ".join(text.split())
    text = ARTIFACT_SPACE.sub(r"\1", text)
    words = text.split(" ")
    if len(words) < min_words:
        return None
    if len(words) <= max_words:
        return text
    truncated = " ".join(words[:max_words])
    tail = " ".join(words[max_words : max_words + 40])
    region = truncated + " " + tail
    best_end = None
    for m in SENT_END.finditer(region):
        n_words = len(region[: m.end()].split(" "))
        if min_words <= n_words <= max_words + 20:
            best_end = m.end()
    if best_end:
        return region[:best_end].strip()
    return truncated


def load_rows():
    """Liest den kompletten Datensatz (train+dev, ~870k Zeilen) einmalig ein und gruppiert
    Text nach (domain, generator). Nur Zeilen aus den gewünschten Domänen/Generatoren landen im
    Speicher (nicht alle 870k Volltexte)."""
    from datasets import concatenate_datasets, load_dataset

    ds = load_dataset("Jinyan1/COLING_2025_MGT_en")
    full = concatenate_datasets([ds["train"], ds["dev"]])

    wanted_models = {"human", *GENERATORS}
    rows = defaultdict(list)

    def collect(batch):
        for sub, model, text in zip(batch["sub_source"], batch["model"], batch["text"]):
            dom = SUB2DOM.get(sub)
            if dom is None or model not in wanted_models:
                continue
            rows[(dom, model)].append(text)

    full.map(collect, batched=True, batch_size=20_000, desc="Filtere/gruppiere")
    return rows


def build_suite(rows, per_domain_human: int, per_domain_ai: int, seed: int):
    rnd = random.Random(seed)
    out = []
    skipped_short = 0
    stats = defaultdict(lambda: {"target": 0, "got": 0})

    def take(domain, model, target):
        texts = rows.get((domain, model), [])
        idx = list(range(len(texts)))
        rnd.shuffle(idx)
        got = []
        nonlocal skipped_short
        for i in idx:
            if len(got) >= target:
                break
            ex = extract_excerpt(texts[i])
            if ex is None:
                skipped_short += 1
                continue
            got.append(ex)
        return got

    for domain in DOMAINS:
        human_texts = take(domain, "human", per_domain_human)
        stats[(domain, "human")]["target"] = per_domain_human
        stats[(domain, "human")]["got"] = len(human_texts)
        for t in human_texts:
            out.append({"text": t, "label": 0, "domain": domain, "generator": "human", "source": "coling2025mgt", "words": len(t.split())})

        available_gens = [g for g in GENERATORS if rows.get((domain, g))]
        if not available_gens:
            continue
        # gleichmäßig auf verfügbare Generatoren verteilen (Rest den ersten zugeschlagen)
        base = per_domain_ai // len(available_gens)
        extra = per_domain_ai - base * len(available_gens)
        for j, gen in enumerate(available_gens):
            target = base + (1 if j < extra else 0)
            texts = take(domain, gen, target)
            stats[(domain, gen)]["target"] = target
            stats[(domain, gen)]["got"] = len(texts)
            for t in texts:
                out.append({"text": t, "label": 1, "domain": domain, "generator": gen, "source": "coling2025mgt", "words": len(t.split())})

    return out, stats, skipped_short


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/eval_suite.jsonl")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--per-domain-human", type=int, default=100, help="Menschliche Texte je Domäne")
    ap.add_argument("--per-domain-ai", type=int, default=100, help="KI-Texte je Domäne, auf verfügbare Generatoren verteilt")
    args = ap.parse_args()

    print("Lade/filtere Jinyan1/COLING_2025_MGT_en (einmaliger Download, danach HF-Cache) ...")
    rows = load_rows()
    for k in sorted(rows):
        print(f"  verfügbar {k}: {len(rows[k])}")

    suite, stats, skipped_short = build_suite(rows, args.per_domain_human, args.per_domain_ai, args.seed)

    random.Random(args.seed).shuffle(suite)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for row in suite:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"\nGeschrieben: {len(suite)} Texte -> {out_path}")
    print(f"Übersprungen (nach Kürzung < {MIN_WORDS} Wörter oder Quelle leer): {skipped_short}")
    print("\nSoll/Ist je (Domäne, Generator):")
    for k in sorted(stats):
        s = stats[k]
        flag = "  <-- Ziel nicht erreicht" if s["got"] < s["target"] else ""
        print(f"  {k}: {s['got']}/{s['target']}{flag}")

    n_human = sum(1 for r in suite if r["label"] == 0)
    n_ai = sum(1 for r in suite if r["label"] == 1)
    print(f"\nGesamt: {len(suite)} (human={n_human}, KI={n_ai})")


if __name__ == "__main__":
    main()
