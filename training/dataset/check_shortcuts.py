"""
Looks for shortcuts in the dataset built by build_dataset.py (issue #50): can texts be told
apart by their surface alone - length, whitespace, kinds of characters, how a text starts and
ends - without reading a single word?

A classifier on such features answers two questions, each once for excerpts of the unchanged
source texts and once for the cleaned excerpts of the dataset. Both excerpts are drawn the
same way, so the difference between the two columns is the cleaning, not the cutting.

    1. Human or AI, within one source and domain. What is left on the cleaned excerpts is
       what a detector could learn instead of the writing itself.
    2. Which source, within one domain and class. If a source can be recognised, and it has
       one class only (the collected human texts), then "this source" is a shortcut to the
       label.

Not every such feature is an artefact (a writer's punctuation is style, and sources differ in
subject), so the result is a list to read, not a pass or fail.

A third list names word sequences that are frequent in one class and (almost) absent in the
other. Stock phrases of a model belong there; text that a platform adds to a post does not
and should be removed in build_dataset.py (BOILERPLATE).

Usage:
    .venv/Scripts/python.exe dataset/check_shortcuts.py              # needs scikit-learn
    .venv/Scripts/python.exe dataset/check_shortcuts.py --per-cell 5000
"""

import argparse
import json
import random
import re
import zlib
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np

from build_dataset import DATA, SPLITS, excerpt, load_config, read_rows, seeded

PER_100_WORDS = {
    "newline": re.compile(r"\n"),
    "double_space": re.compile(r"  +"),
    "space_before_punct": re.compile(r"\w [,.!?](?: |$)"),
    "curly_quote": re.compile("[\u2018\u2019\u201c\u201d]"),
    "double_quote": re.compile('"'),
    "apostrophe": re.compile("'"),
    "long_dash": re.compile("[\u2013\u2014]"),
    "spaced_hyphen": re.compile(r" - "),
    "bracket": re.compile(r"[()\[\]]"),
    "html_tag": re.compile(r"</?[a-zA-Z][^>\n]{0,40}>"),
    "markdown": re.compile(r"\*\*|^#{1,4} |^[-*] ", re.M),
    "url": re.compile(r"https?://|www\."),
    "ellipsis": re.compile(r"\.\.\.|\u2026"),
    "comma": re.compile(","),
    "full_stop": re.compile(r"\."),
    "question_exclamation": re.compile(r"[?!]"),
    "colon_semicolon": re.compile(r"[:;]"),
    "digit": re.compile(r"\d"),
    "uppercase": re.compile(r"[A-Z]"),
    "non_ascii": re.compile(r"[^\x00-\x7f]"),
    "other_symbol": re.compile(r"[^\w\s.,;:!?'\"()\[\]-]"),
}
FLAGS = {
    "starts_uppercase": re.compile(r"^[A-Z]"),
    "starts_lowercase": re.compile(r"^[a-z]"),
    "starts_other": re.compile(r"^[^A-Za-z]"),
    "ends_sentence": re.compile(r"[.!?\u2026][\"')\]]*$"),
    "ends_letter": re.compile(r"[A-Za-z0-9]$"),
    "edge_whitespace": re.compile(r"^\s|\s$"),
}
FEATURES = ["words", "chars_per_word"] + list(PER_100_WORDS) + list(FLAGS)


def features(text: str) -> list:
    words = max(len(text.split()), 1)
    return ([words, len(text) / words]
            + [100 * len(rx.findall(text)) / words for rx in PER_100_WORDS.values()]
            + [1.0 if rx.search(text) else 0.0 for rx in FLAGS.values()])


MIN_ROWS = 200  # per cell; smaller ones say nothing
TESTBEDS = ()   # group prefixes from dataset.json, set in main()


def sample_rows(dataset_dir: Path, per_cell: int, seed: int) -> list:
    """Rows of the dataset, at most per_cell per source, domain and class, as dicts with id,
    group, source, domain, label and the cleaned excerpt."""
    by_cell = defaultdict(list)
    for split in SPLITS:
        with (dataset_dir / f"{split}.jsonl").open(encoding="utf-8") as f:
            for line in f:
                row = json.loads(line)
                start, end = row["excerpt"]
                by_cell[(row["source"], row["domain"], row["label"])].append(
                    {k: row[k] for k in ("id", "group", "source", "domain", "label")} | {"clean": row["text"][start:end]})
    rng = random.Random(seed)
    sample = []
    for cell in sorted(by_cell):
        items = by_cell[cell]
        if len(items) >= MIN_ROWS:
            rng.shuffle(items)
            sample += items[:per_cell]
    return sample


def add_raw_excerpts(sample: list, data_dir: Path, cfg: dict) -> None:
    """Adds "raw": an excerpt of the unchanged source text, drawn like the one of the dataset."""
    by_id = {row["id"]: row for row in sample}
    for source in sorted({row["source"] for row in sample}):
        for r in read_rows(data_dir, source):
            if r["id"] in by_id:
                start, end = excerpt(r["text"], random.Random(seeded(cfg["seed"], "excerpt", r["id"])), cfg)
                by_id[r["id"]]["raw"] = r["text"][start:end]


PHRASE_WORD = re.compile(r"[a-z0-9']+")


def one_class_phrases(dataset_dir: Path, n_words: int = 5, min_rows: int = 150, share: float = 0.97, top: int = 20) -> list:
    """The most frequent n-word sequences of the train part that occur almost only in one class:
    (rows, share of AI rows, sequence, most frequent source). One sequence in eight is counted,
    picked by hash, which is enough to find text that repeats in hundreds of rows."""
    rows, ai, sources = Counter(), Counter(), defaultdict(Counter)
    with (dataset_dir / "train.jsonl").open(encoding="utf-8") as f:
        for line in f:
            row = json.loads(line)
            words = PHRASE_WORD.findall(row["text"].lower())
            for phrase in {" ".join(words[i:i + n_words]) for i in range(len(words) - n_words + 1)}:
                if zlib.crc32(phrase.encode("utf-8")) % 8 == 0:
                    rows[phrase] += 1
                    ai[phrase] += row["label"]
                    sources[phrase][f"{row['source']}/{row['sub_source']}"] += 1
    found = []
    for phrase, n in rows.most_common():
        if n < min_rows or len(found) == top:
            break
        if max(ai[phrase], n - ai[phrase]) >= share * n:
            found.append((n, round(ai[phrase] / n, 3), phrase, sources[phrase].most_common(1)[0][0]))
    return found


def auroc_cv(x, y, groups) -> float:
    from sklearn.ensemble import HistGradientBoostingClassifier
    from sklearn.metrics import roc_auc_score
    from sklearn.model_selection import GroupKFold

    scores = np.zeros(len(y))
    for train, test in GroupKFold(n_splits=3).split(x, y, groups):
        model = HistGradientBoostingClassifier(max_iter=150, random_state=0).fit(x[train], y[train])
        scores[test] = model.predict_proba(x[test])[:, 1]
    return float(roc_auc_score(y, scores))


def single_feature_auroc(x, y) -> list:
    from sklearn.metrics import roc_auc_score

    out = []
    for i, name in enumerate(FEATURES):
        a = roc_auc_score(y, x[:, i]) if len(set(x[:, i])) > 1 else 0.5
        out.append((max(a, 1 - a), name, "ai" if a > 0.5 else "human"))
    return sorted(out, reverse=True)


def compare(rows: list, y) -> dict:
    """AUROC for telling y apart, on the raw and on the cleaned excerpts of the same rows. A
    testbed is one group as a whole; here each of its rows counts on its own, otherwise all of
    them would sit in one fold."""
    groups = np.array([row["id"] if row["group"].startswith(TESTBEDS) else row["group"] for row in rows])
    raw = np.array([features(row["raw"]) for row in rows])
    clean = np.array([features(row["clean"]) for row in rows])
    no_length = [i for i, name in enumerate(FEATURES) if name != "words"]
    return {
        "rows": len(rows),
        "auroc_raw_excerpt": auroc_cv(raw, y, groups),
        "auroc_clean_excerpt": auroc_cv(clean, y, groups),
        "auroc_clean_excerpt_without_length": auroc_cv(clean[:, no_length], y, groups),
        "single_features_clean_excerpt": [(round(a, 3), n, side) for a, n, side in single_feature_auroc(clean, y)[:3]],
    }


def print_line(name: str, r: dict, sides=None) -> None:
    top = ", ".join(f"{n} {a:.2f}" + (f" ({side})" if sides is None else "") for a, n, side in r["single_features_clean_excerpt"])
    print(f"  {name:38} {r['rows']:6} {r['auroc_raw_excerpt']:12.3f} {r['auroc_clean_excerpt']:14.3f} "
          f"{r['auroc_clean_excerpt_without_length']:15.3f}  {top}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--per-cell", type=int, default=3000, help="rows per source, domain and class")
    args = ap.parse_args()
    cfg = load_config()
    global TESTBEDS
    TESTBEDS = tuple(cfg["held_out"]["group_prefixes"])
    data_dir = Path(args.data_dir)
    dataset_dir = data_dir / "dataset" / cfg["version"]
    sample = sample_rows(dataset_dir, args.per_cell, cfg["seed"])
    add_raw_excerpts(sample, data_dir, cfg)
    header = (f"  {'':38} {'rows':>6} {'raw excerpt':>12} {'clean excerpt':>14} {'without length':>15}"
              "  strongest single features, clean excerpt")
    label = {0: "human", 1: "ai"}
    result = {"human_or_ai": {}, "which_source": {}}

    print("1. Human or AI within one source and domain: AUROC on surface features only (0.5 = no hint)")
    print(header)
    cells = defaultdict(list)
    for row in sample:
        cells[(row["source"], row["domain"])].append(row)
    for (source, domain), rows in sorted(cells.items()):
        y = np.array([row["label"] for row in rows])
        if len(set(y)) == 2:
            result["human_or_ai"][f"{source}/{domain}"] = r = compare(rows, y)
            print_line(f"{source}/{domain}", r)

    print(f"\n2. Which source within one domain and class: AUROC of one source against the others of that domain")
    print(header)
    cells = defaultdict(list)
    for row in sample:
        cells[(row["domain"], row["label"])].append(row)
    for (domain, lab), rows in sorted(cells.items()):
        sources = sorted({row["source"] for row in rows})
        if len(sources) < 2:
            continue
        for source in sources[:1] if len(sources) == 2 else sources:
            y = np.array([int(row["source"] == source) for row in rows])
            others = sources[1] if len(sources) == 2 else "the others"
            name = f"{domain}/{label[lab]}: {source} or {others}"
            result["which_source"][name] = r = compare(rows, y)
            print_line(name, r, sides=False)

    phrases = one_class_phrases(dataset_dir)
    result["one_class_phrases"] = phrases
    print(f"\n3. Word sequences of one class (train part; rows, class, sequence, main source)")
    for n, share_ai, phrase, source in phrases:
        print(f"  {n:6}  {'ai' if share_ai > 0.5 else 'human':5}  {phrase!r}  {source}")
    (dataset_dir / "shortcuts.json").write_text(json.dumps(result, indent=1) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
