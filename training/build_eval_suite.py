"""
Builds a broader, reproducible eval suite (TODO item 3 / WP-01) from the public
dataset Jinyan1/COLING_2025_MGT_en (Hugging Face). This dataset combines three research
benchmarks for human-vs-AI detection (column "source"): MAGE (Apache-2.0), M4GT-Bench
(EACL 2024, mbzuai-nlp/M4 - no explicit license file found in the repo, pure research
use) and HC3 (**CC BY-SA 4.0**, not Apache-2.0 - verified via the dataset card, see
git history of orchestration/LOG.md, WP-11; already used in this project for prepare_dataset.py).
For the compilation itself (Jinyan1/COLING_2025_MGT_en) no license is entered in the dataset card YAML
- see DECISION in the log. Used only for local evaluation, raw data
stays under training/data/ (gitignored), is not redistributed.

Domains (our category -> sub_source values of the dataset):
    news         xsum, cnn, tldr, dialogsum      (news/summaries)
    wikipedia    wikipedia, wiki_csai
    forum        reddit, cmv, reddit_eli5, eli5
    sci_abstract arxiv, sci_gen, peerread, pubmed (scientific abstracts)
    reviews      yelp, imdb
    howto        wikihow

Note on license/origin per sub_source (column "source", verified by cross-check, WP-11):
finance/medicine/open_qa/reddit_eli5/wiki_csai = hc3 (CC BY-SA 4.0); cmv/cnn/dialogsum/eli5/
hswag/imdb/pubmed/roct/sci_gen/tldr/wp/xsum/yelp = mage (Apache-2.0, but human
source texts partly with their own terms of use, e.g. Yelp/IMDb); arxiv/outfox/peerread/
reddit/wikihow/**wikipedia** = m4gt (**no license**, M4GT-Bench/M4 without a LICENSE file/field).
The sub_source "wikipedia" above does NOT come from MAGE but from M4GT - contrary to what the name
suggests. MAGE's own Wikipedia/SQuAD domain is called "squad" here (not included in DOMAINS above)
and only has older generators (gpt-3.5-turbo, otherwise text-davinci-00x/flan-t5/opt/
t0/bloom/GLM130B/gpt-j/gpt-neox - the category "older/smaller models" deliberately excluded in this
script). training/build_reference_set.py therefore uses neither "wikipedia"
nor "squad" from this dataset, but RAID (liamdugan/raid, MIT) for the Wikipedia domain.

Generators (column "model"): human and, where available for the domain,
gpt4, gpt4o, gpt-3.5-turbo, llama3-70b, mixtral-8x7b, gemma2-9b-it, cohere - the most current
publicly available generators in this dataset (see log: "news" and "reviews" only have
gpt-3.5-turbo as the AI generator in the dataset, no newer ones). Older/small models (davinci,
opt_*, flan_t5_*, t0_*, bloom*, gpt_j, gpt_neox, GLM130B, dolly*) deliberately left out - no longer
representative of today's AI text on the web.

Text -> paragraph (40-400 words, like extension/length-buckets.js / content.js MIN_WORDS):
Whitespace is merged into a single paragraph (real web page paragraphs no longer have
blank lines either when read out) and, if needed, cut at the nearest sentence end to 400 words
(like clip() in evaluate_false_alarms.py, just word-based instead of character-based).

Usage:
    .venv/Scripts/python.exe build_eval_suite.py                 # default sizes (see below)
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

# Generators in priority order (those missing per domain are skipped, see log)
GENERATORS = ["gpt4", "gpt4o", "gpt-3.5-turbo", "llama3-70b", "mixtral-8x7b", "gemma2-9b-it", "cohere"]

MIN_WORDS = 40
MAX_WORDS = 400

SENT_END = re.compile(r"[.!?…][\"'”’»)\]]?(?=\s|$)")

# Tokenisation artefact from reddit_eli5/wikihow parts of several source datasets ("wax .", "1 )") -
# same problem as documented in prepare_dataset.py and normalised in evaluate_false_alarms.py.
# Without normalisation a model could learn "space before punctuation" as a shortcut for "human",
# which does not hold on real web pages (without this artefact).
ARTIFACT_SPACE = re.compile(r"\s+([.,!?;:)\]'])")


def extract_excerpt(text: str, min_words=MIN_WORDS, max_words=MAX_WORDS):
    """One paragraph (40-400 words) from a possibly longer document. Whitespace/line breaks
    are merged into one paragraph (like a real web page paragraph), tokenisation
    artefacts removed, cut at the nearest sentence end if needed. None if the text stays
    entirely below min_words."""
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
    """Reads the complete dataset (train+dev, ~870k rows) once and groups
    text by (domain, generator). Only rows from the desired domains/generators end up in
    memory (not all 870k full texts)."""
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

    full.map(collect, batched=True, batch_size=20_000, desc="Filtering/grouping")
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
        # distribute evenly across available generators (remainder goes to the first ones)
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
    ap.add_argument("--per-domain-human", type=int, default=100, help="Human texts per domain")
    ap.add_argument("--per-domain-ai", type=int, default=100, help="AI texts per domain, distributed across available generators")
    args = ap.parse_args()

    print("Loading/filtering Jinyan1/COLING_2025_MGT_en (one-time download, then HF cache) ...")
    rows = load_rows()
    for k in sorted(rows):
        print(f"  available {k}: {len(rows[k])}")

    suite, stats, skipped_short = build_suite(rows, args.per_domain_human, args.per_domain_ai, args.seed)

    random.Random(args.seed).shuffle(suite)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        for row in suite:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    print(f"\nWritten: {len(suite)} texts -> {out_path}")
    print(f"Skipped (< {MIN_WORDS} words after cutting or source empty): {skipped_short}")
    print("\nTarget/actual per (domain, generator):")
    for k in sorted(stats):
        s = stats[k]
        flag = "  <-- target not reached" if s["got"] < s["target"] else ""
        print(f"  {k}: {s['got']}/{s['target']}{flag}")

    n_human = sum(1 for r in suite if r["label"] == 0)
    n_ai = sum(1 for r in suite if r["label"] == 1)
    print(f"\nTotal: {len(suite)} (human={n_human}, AI={n_ai})")


if __name__ == "__main__":
    main()
