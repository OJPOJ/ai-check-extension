"""
Generates the reference set for "Check model" (extension/bg/reference-set.js): human and AI texts
from two redistributable sources, short (40..119 words) and long (from 120 words) paragraphs
bucketed separately - so that "Check model" can, if needed, propose its own short-text threshold
(reliableWords/shortRedFrom, like config.js RELIABLE_WORDS/models.js) from it.

License check (details: git history of orchestration/LOG.md, WP-11, DECISION entries; left out when in doubt):
  - HC3 (Hello-SimpleAI/HC3), CC BY-SA 4.0 - as before, five domains, generator ChatGPT (2023).
  - RAID (liamdugan/raid), MIT license - domain "wiki" (human texts from Wikipedia, CC BY-SA-
    compatible), generators llama-chat/mistral/mistral-chat/mpt/mpt-chat/gpt2 (open models,
    contained in the MIT-licensed train split). Only `attack == "none"` (unaltered text, no
    RAID adversarial variant such as "synonym"/"paraphrase") and `decoding == "greedy"`
    (deterministic, common default - "sampling" would be equally available, but without
    advantage for a fixed reference text generated once). In the train split for the
    wiki domain RAID also contains the occasional gpt4/gpt3/chatgpt/cohere/cohere-chat - deliberately NOT used, to
    stay within the framework (open models) set by the orchestrator; see report for details.
  Previously wrongly assumed as a source and now removed: the sub-source "wikipedia" from
  Jinyan1/COLING_2025_MGT_en - verified via the column "source" it comes from M4GT-Bench/M4
  (source == "m4gt"), not from MAGE as first assumed. M4GT-Bench/M4 have no license on GitHub
  ("license": null) - not redistributable, "left out when in doubt".
  Deliberately NOT used (other domains of Jinyan1/COLING_2025_MGT_en or RAID):
  - reviews (Yelp/IMDb): Yelp Open Dataset explicitly academic only, no redistribution to
    third parties; IMDb dataset without a clear redistribution license.
  - news (XSum/CNN/TLDR/DialogSum): press article text (BBC/CNN), XSum license on Hugging Face
    "unknown"; the Apache-2.0 tag on the CNN/DailyMail loading script does not cover the copyright status
    of the actual news texts. Likewise RAID domains "news"/"reviews"/"reddit"/"books"/
    "abstracts"/"recipes"/"poetry": human source texts there are press articles, Amazon/
    Goodreads reviews, Reddit posts, book excerpts, scientific abstracts, recipes and
    poems respectively, with their own rights that are unresolved or known to be restrictive - not used.
  - sci_abstract (arXiv/PeerRead/SciGen/PubMed): license per paper or publisher, arXiv's default
    license only allows arXiv itself to redistribute; cannot be checked at scale.
  - howto (WikiHow): content from wikihow.com is under CC BY-NC-SA 3.0 - NonCommercial does not fit
    a redistributed dataset.
  - forum parts outside HC3 (reddit, cmv, eli5): inconsistent/unresolved origin
    (among others Pushshift.io, whose legal status is itself disputed); unlike HC3, no
    redistribution license explicitly chosen by the authors' team found.

Extraction as in build_eval_suite.py (extract_excerpt, imported from there instead of duplicated):
whitespace/tokenisation artefacts normalised ("space before punctuation", known among others from
reddit_eli5 parts), cut at a sentence boundary to 40..400 words. Buckets by the
natural length of the result (no artificial cutting to a target length). For HC3 the
principle from the previous version is kept: human and AI answer each from the same question
(same topic - the model has to distinguish by style, not by content), and both in the same
length class (otherwise the text length itself would be a hint for the label). For RAID/wiki there is
no such topic pairing (dataset not structured that way) - a limitation, but lower risk
for a stylistically homogeneous domain (factual text) than for the personal HC3 answers.

RAID/train.csv is an 11.8 GB CSV (cannot be loaded as a whole via the HF `datasets` library
without downloading all domains/attacks). `pick_raid_wiki()` therefore streams the file directly
via HTTP and a CSV reader, discards everything before/after the "wiki" data block and aborts afterwards -
this still takes a few minutes and downloads several GB (the domains before "wiki" have to be
run through first). Network timeouts are possible, then simply run again.

Usage (from this folder):
    .venv/Scripts/python.exe build_reference_set.py
    .venv/Scripts/python.exe build_reference_set.py --check tmr desklib   # AUROC of the models on the new set
"""

import argparse
import csv
import io
import json
import random
from pathlib import Path

from build_eval_suite import extract_excerpt
from evaluate_length import auroc

OUT = Path(__file__).resolve().parent.parent / "extension" / "bg" / "reference-set.js"

RELIABLE_WORDS = 120  # like extension/models.js reliableWords / config.js RELIABLE_WORDS

HC3_DOMAINS = ["reddit_eli5", "finance", "medicine", "open_qa", "wiki_csai"]
HC3_PAIRS = {"short": 4, "long": 4}  # question pairs (human+AI) per domain and length class

RAID_URL = "https://huggingface.co/datasets/liamdugan/raid/resolve/main/train.csv"
RAID_GENERATORS = ["llama-chat", "mistral", "mistral-chat", "mpt", "mpt-chat", "gpt2"]
RAID_DECODING = "greedy"  # deterministic, common default (rationale: head of this file)
# Only "long": the human RAID/wiki texts are (excerpts from) whole Wikipedia articles and
# therefore practically never below RELIABLE_WORDS after extract_excerpt - short paragraphs continue to come from
# HC3 alone (see above). Without short human texts here, a "short" target for the AI side would be unbalanced.
WIKI_PER_GEN = {"long": 3}  # texts per generator


def bucket(words: int) -> str:
    return "short" if words < RELIABLE_WORDS else "long"


def pick_hc3() -> list[dict]:
    from datasets import load_dataset

    ds = load_dataset("Hello-SimpleAI/HC3", revision="refs/convert/parquet")
    split = ds["train"] if "train" in ds else next(iter(ds.values()))
    rng = random.Random(0)
    rows = []
    for domain in HC3_DOMAINS:
        candidates = {"short": [], "long": []}
        for r in split.filter(lambda r: r["source"] == domain):
            human = next((t for t in map(extract_excerpt, r.get("human_answers") or []) if t), None)
            ai = next((t for t in map(extract_excerpt, r.get("chatgpt_answers") or []) if t), None)
            if not human or not ai:
                continue
            wh, wa = len(human.split()), len(ai.split())
            b = bucket(wh)
            if b == bucket(wa):  # same length class, otherwise the length gives away the label
                candidates[b].append((human, wh, ai, wa))
        for key, target in HC3_PAIRS.items():
            pool = candidates[key]
            n = min(target, len(pool))
            if n < target:
                print(f"WARNING: HC3 {domain}/{key}: only {n} of {target} pairs available")
            for human, wh, ai, wa in rng.sample(pool, n):
                rows.append({"ai": False, "domain": domain, "generator": "human", "words": wh, "text": human})
                rows.append({"ai": True, "domain": domain, "generator": "chatgpt-2023", "words": wa, "text": ai})
    return rows


def _raid_wiki_rows():
    """Streams RAID train.csv (11.8 GB, no other way to get at only the "wiki" domain)
    via HTTP and yields rows of the domain "wiki" as soon as they appear in the dataset (grouped by domain);
    aborts as soon as the domain changes again. Large text fields in this CSV
    (code domain) need a raised csv field limit."""
    import requests

    csv.field_size_limit(2**31 - 1)  # sys.maxsize overflows on Windows (32-bit C long)
    resp = requests.get(RAID_URL, stream=True, timeout=120)
    resp.raw.decode_content = True
    reader = csv.reader(io.TextIOWrapper(resp.raw, encoding="utf-8", newline=""))
    header = next(reader)
    idx = {name: i for i, name in enumerate(header)}
    seen_wiki = False
    for row in reader:
        if row[idx["domain"]] != "wiki":
            if seen_wiki:
                return
            continue
        seen_wiki = True
        yield row, idx


CAP = {"human": 20, **{g: 10 for g in RAID_GENERATORS}}  # candidates per bucket, only then select randomly
# (more than the target value, for a real random selection instead of "the first n found")
RAID_ROW_LIMIT = 300_000  # safety net in case a bucket/model occurs extremely rarely in the file


def _pool_full(pool: dict) -> bool:
    wanted = {"human", *RAID_GENERATORS}
    return all(len(pool.get(m, {}).get(k, [])) >= CAP[m] for m in wanted for k in ("short", "long"))


def pick_raid_wiki() -> list[dict]:
    wanted = {"human", *RAID_GENERATORS}
    pool: dict[str, dict[str, list]] = {}
    n = 0
    attempts = 3  # the connection to RAID/train.csv (11.8 GB) occasionally drops early - reconnecting
    # is enough (the same rows come again, `pool` is kept across attempts)
    for attempt in range(1, attempts + 1):
        try:
            for row, idx in _raid_wiki_rows():
                n += 1
                model = row[idx["model"]]
                if model not in wanted or row[idx["attack"]] != "none":
                    continue
                if model != "human" and row[idx["decoding"]] != RAID_DECODING:
                    continue
                ex = extract_excerpt(row[idx["generation"]])
                if ex is None:
                    continue
                w = len(ex.split())
                b = bucket(w)
                bucket_list = pool.setdefault(model, {"short": [], "long": []})[b]
                if len(bucket_list) < CAP[model]:  # afterwards enough candidates for this (model, bucket)
                    bucket_list.append((ex, w))
                if n % 20_000 == 0:
                    print(f"  ... {n} RAID wiki rows read (candidates so far: { {m: {k: len(v) for k, v in bs.items()} for m, bs in pool.items()} })")
                if n >= RAID_ROW_LIMIT or _pool_full(pool):
                    break
            break  # stream read to the end normally (or safety net/enough candidates) - no retry needed
        except Exception as err:
            print(f"WARNING: RAID stream aborted ({err}) - attempt {attempt}/{attempts}")
            if attempt == attempts or _pool_full(pool):
                break
    print(f'RAID: read {n} rows of the domain "wiki" (enough candidates found or safety net reached)')

    rng = random.Random(1)
    ai_rows = []
    achieved = {"short": 0, "long": 0}  # AI texts actually drawn per bucket - draw human texts below in
    # the same number, otherwise a human/AI imbalance arises
    for gen in RAID_GENERATORS:
        gen_pool = pool.get(gen, {"short": [], "long": []})
        for key, target in WIKI_PER_GEN.items():
            n = min(target, len(gen_pool[key]))
            if n < target:
                print(f"WARNING: raid wiki {gen}/{key}: only {n} of {target}")
            achieved[key] += n
            for text, w in rng.sample(gen_pool[key], n):
                ai_rows.append({"ai": True, "domain": "wikipedia", "generator": gen, "words": w, "text": text})

    human_pool = pool.get("human", {"short": [], "long": []})
    human_rows = []
    for key, target in achieved.items():  # as many human as AI texts per bucket
        n = min(target, len(human_pool[key]))
        if n < target:
            print(f"WARNING: raid wiki human/{key}: only {n} of {target}")
        for text, w in rng.sample(human_pool[key], n):
            human_rows.append({"ai": False, "domain": "wikipedia", "generator": "human", "words": w, "text": text})
    return human_rows + ai_rows


def write(rows: list[dict]) -> None:
    def item(r):
        return (
            f'  {{ ai: {str(r["ai"]).lower()}, domain: {json.dumps(r["domain"])}, '
            f'generator: {json.dumps(r["generator"])}, words: {r["words"]}, text: {json.dumps(r["text"], ensure_ascii=False)} }}'
        )

    items = ",\n".join(item(r) for r in rows)
    n_human, n_ai = sum(1 for r in rows if not r["ai"]), sum(1 for r in rows if r["ai"])
    OUT.write_text(
        "// Reference set for \"Check model\" (bg/model-check.js): "
        f"{n_human} human and {n_ai} AI texts, English, short\n"
        "// (< 120 words) and long paragraphs bucketed separately (field `words`, see RELIABLE_WORDS in\n"
        "// model-check.js). Domains/generators: five from HC3 (Hello-SimpleAI/HC3, CC BY-SA 4.0, generator\n"
        "// ChatGPT 2023) plus \"wikipedia\" from RAID (liamdugan/raid, MIT license, domain \"wiki\"; human\n"
        "// texts are Wikipedia articles; generators llama-chat/mistral/mistral-chat/mpt/mpt-chat/gpt2).\n"
        "// License weighing per sub-source: comment at the top of training/build_reference_set.py.\n"
        "// Generated by training/build_reference_set.py - do not edit by hand.\n"
        f"export const REFERENCE_SET = [\n{items}\n];\n",
        encoding="utf-8",
        newline="\n",
    )


def check(rows: list[dict], backends: list[str]) -> None:
    import evaluate_backends as eb

    texts = [r["text"] for r in rows]
    labels = [r["ai"] for r in rows]
    for name in backends:
        scores = (eb.score_tmr if name == "tmr" else eb.score_desklib)(texts)
        human = sorted(s for s, l in zip(scores, labels) if not l)
        ai = sorted(s for s, l in zip(scores, labels) if l)
        print(f"\n{name}: AUROC overall {auroc(labels, scores):.3f} (n={len(rows)}), mean human {sum(human) / len(human):.3f}, AI {sum(ai) / len(ai):.3f}")

        for key, label in (("short", f"short (< {RELIABLE_WORDS} words)"), ("long", f"long (>= {RELIABLE_WORDS} words)")):
            idx = [i for i, r in enumerate(rows) if bucket(r["words"]) == key]
            if not idx:
                continue
            l2, s2 = [labels[i] for i in idx], [scores[i] for i in idx]
            print(f"  {label}: AUROC {auroc(l2, s2):.3f} (n={len(idx)})")

        for domain in sorted(set(r["domain"] for r in rows)):
            idx = [i for i, r in enumerate(rows) if r["domain"] == domain]
            l2, s2 = [labels[i] for i in idx], [scores[i] for i in idx]
            print(f"  {domain}: AUROC {auroc(l2, s2):.3f} (n={len(idx)})")

        print("  human:", " ".join(f"{s:.2f}" for s in human))
        print("  AI:    ", " ".join(f"{s:.2f}" for s in ai))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", nargs="*", choices=["tmr", "desklib"], default=[])
    args = ap.parse_args()
    rows = pick_hc3() + pick_raid_wiki()
    write(rows)
    n_human, n_ai = sum(1 for r in rows if not r["ai"]), sum(1 for r in rows if r["ai"])
    n_short, n_long = sum(1 for r in rows if bucket(r["words"]) == "short"), sum(1 for r in rows if bucket(r["words"]) == "long")
    print(f"{len(rows)} texts ({n_human} human/{n_ai} AI, {n_short} short/{n_long} long) -> {OUT}")
    if args.check:
        check(rows, args.check)


if __name__ == "__main__":
    main()
