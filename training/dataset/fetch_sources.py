"""
Fetches the public training sources for our own detector model (issue #46/#47,
MODEL_CONCEPT.md, "Training data") and writes them in one common row format.

What is fetched, from which revision, and which sub-sources are left out is defined in
sources.json. This script only executes that file:

    1. Download the pinned revision of every file from the original Hugging Face repository
       (stays in the HF cache; RAID alone is 11.8 GB) and compare its SHA-256 with sources.json.
    2. Turn the original rows into the common format (see "row_format" in sources.json) and
       write them to data/sources/<source>/rows.jsonl. Texts are not changed, nothing is
       deduplicated or split here - that is the job of the aggregation step.
    3. Write data/sources/<source>/receipt.json: revision, checksums, row counts and the
       SHA-256 of rows.jsonl, and compare count and checksum with "expected" in sources.json.
       A fresh checkout therefore either reproduces the same rows or fails.

data/ is gitignored: no dataset text ends up in the repository.

Usage:
    .venv/Scripts/python.exe dataset/fetch_sources.py              # all sources
    .venv/Scripts/python.exe dataset/fetch_sources.py hc3 mage     # only these
    .venv/Scripts/python.exe dataset/fetch_sources.py --report     # print the receipts, fetch nothing
"""

import argparse
import csv
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"  # gitignored
MANIFEST = HERE / "sources.json"

# Length groups as in the extension: below MIN_WORDS (content.js) paragraphs are grouped or
# skipped, below reliableWords (120) the stricter threshold applies.
LENGTH_GROUPS = [(15, "<15"), (40, "15-39"), (120, "40-119")]
LONGEST_GROUP = ">=120"

WORD = re.compile(r"\w+")
GROUP_PREFIX_WORDS = 12


class SourceError(Exception):
    """The data does not match what sources.json describes."""


def load_manifest(path: Path = MANIFEST) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def length_group(text: str) -> str:
    n = len(text.split())
    for limit, name in LENGTH_GROUPS:
        if n < limit:
            return name
    return LONGEST_GROUP


def prefix_group(text: str, n_words: int = GROUP_PREFIX_WORDS) -> str:
    """Group key for datasets without document ids: hash of the first words, ignoring case and
    punctuation."""
    key = " ".join(WORD.findall(text.lower())[:n_words])
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


def sub_source_config(cfg: dict, sub: str) -> dict:
    """Unknown sub-sources are an error, not a default: a sub-source nobody looked at must not
    slip into the training data."""
    try:
        return cfg["sub_sources"][sub]
    except KeyError:
        raise SourceError(f"sub-source {sub!r} is not listed in sources.json") from None


def make_row(source: str, cfg: dict, *, row_id: str, sub: str, label: int, generator: str, group: str, text: str, meta: dict):
    """One row in the common format, or None if the sub-source is excluded."""
    sub_cfg = sub_source_config(cfg, sub)
    if not sub_cfg["use"]:
        return None
    if label == 0:
        generator = "human"
    else:
        meta = {**meta, "generator_raw": generator}
        generator = cfg.get("generators", {}).get(generator, generator)
    return {
        "id": f"{source}:{row_id}",
        "source": source,
        "sub_source": sub,
        "domain": sub_cfg["domain"],
        "label": label,
        "generator": generator,
        "group": f"{source}:{group}",
        "text": text,
        "meta": meta,
    }


# ---------------------------------------------------------------- HC3

def parse_hc3(cfg: dict, paths: dict):
    """One JSON object per question with lists of human and ChatGPT answers. All answers to one
    question form a group."""
    for name, path in paths.items():
        sub = name.removesuffix(".jsonl")
        with open(path, encoding="utf-8") as f:
            for i, line in enumerate(f):
                item = json.loads(line)
                for key, label, tag in (("human_answers", 0, "h"), ("chatgpt_answers", 1, "a")):
                    for j, text in enumerate(item[key]):
                        yield make_row("hc3", cfg, row_id=f"{sub}:{i}:{tag}{j}", sub=sub, label=label,
                                       generator="chatgpt", group=f"{sub}:{i}", text=text, meta={}), text


# ---------------------------------------------------------------- MAGE

MAGE_PROMPT_TYPES = ("continuation", "topical", "specified")


def parse_mage_src(src: str, known_subs) -> tuple[str, bool, str, str]:
    """Column "src" -> (sub_source, is_human, prompt_type, generator).

    train/valid/test:  cmv_human | cmv_machine_continuation_flan_t5_base
    out-of-domain set: cnn_human | cnn_gpt4 | cnn_human_para | cnn_gpt4_para
    """
    if src.endswith("_human"):
        return src.removesuffix("_human"), True, "", "human"
    if "_machine_" in src:
        sub, rest = src.split("_machine_", 1)
        prompt_type, _, generator = rest.partition("_")
        if prompt_type not in MAGE_PROMPT_TYPES or not generator:
            raise SourceError(f"MAGE: unexpected src {src!r}")
        return sub, False, prompt_type, generator
    parts = src.split("_")
    if parts[0] not in known_subs:
        raise SourceError(f"MAGE: unexpected src {src!r}")
    tail = parts[1:]
    if tail == ["gpt4"]:
        return parts[0], False, "", "gpt4"
    if tail == ["human", "para"]:
        return parts[0], False, "paraphrase_of_human", "gpt-3.5-trubo"
    if tail == ["gpt4", "para"]:
        return parts[0], False, "paraphrase", "gpt4"
    raise SourceError(f"MAGE: unexpected src {src!r}")


def parse_mage(cfg: dict, paths: dict):
    csv.field_size_limit(2**31 - 1)
    for name, path in paths.items():
        split = name.removesuffix(".csv")
        skip_human = split.endswith("_para")  # repeats the human rows of test_ood_set_gpt.csv
        # A paraphrase cannot be matched to its original, so the out-of-domain files are grouped
        # by sub-source as a whole.
        ood = split.startswith("test_ood")
        with open(path, encoding="utf-8-sig", newline="") as f:
            for i, item in enumerate(csv.DictReader(f)):
                sub, is_human, prompt_type, generator = parse_mage_src(item["src"], cfg["sub_sources"])
                # In the files 1 = human; a mismatch means the format changed.
                if (item["label"] == "1") != is_human:
                    raise SourceError(f"MAGE {name} row {i}: label {item['label']!r} contradicts src {item['src']!r}")
                if is_human and skip_human:
                    continue
                text = item["text"]
                meta = {"split": split}
                if prompt_type:
                    meta["prompt_type"] = prompt_type
                group = f"ood:{sub}" if ood else prefix_group(text)
                yield make_row("mage", cfg, row_id=f"{split}:{i}", sub=sub, label=0 if is_human else 1,
                               generator=generator, group=group, text=text, meta=meta), text


# ---------------------------------------------------------------- RAID

def parse_raid(cfg: dict, paths: dict):
    """source_id is the id of the human document a generation was prompted from (for human rows
    their own id): it is the group."""
    csv.field_size_limit(2**31 - 1)
    attacks = set(cfg["attacks"])
    for path in paths.values():
        with open(path, encoding="utf-8", newline="") as f:
            for item in csv.DictReader(f):
                sub_source_config(cfg, item["domain"])  # unknown domains stop the run, attacked or not
                if item["attack"] not in attacks:
                    continue
                is_human = item["model"] == "human"
                meta = {"attack": item["attack"]}
                if not is_human:
                    meta["decoding"] = item["decoding"]
                    meta["repetition_penalty"] = item["repetition_penalty"]
                text = item["generation"]
                yield make_row("raid", cfg, row_id=item["id"], sub=item["domain"], label=0 if is_human else 1,
                               generator=item["model"], group=item["source_id"], text=text, meta=meta), text


PARSERS = {"hc3": parse_hc3, "mage": parse_mage, "raid": parse_raid}


# ---------------------------------------------------------------- fetch and write

def sha256_file(path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def download(cfg: dict) -> dict:
    """Pinned files from the HF cache (downloaded on first use), checksums verified."""
    from huggingface_hub import hf_hub_download

    paths = {}
    for name, expected in cfg["files"].items():
        path = hf_hub_download(cfg["repo"], name, repo_type="dataset", revision=cfg["revision"])
        actual = sha256_file(path)
        if actual != expected:
            raise SourceError(f"{cfg['repo']}/{name}: SHA-256 is {actual}, sources.json says {expected}")
        paths[name] = path
    return paths


def write_rows(source: str, cfg: dict, paths: dict, out_dir: Path) -> dict:
    """Writes rows.jsonl and returns the receipt. Rows from excluded sub-sources and rows
    without text are counted, not written."""
    out_dir.mkdir(parents=True, exist_ok=True)
    counts = Counter()
    excluded = Counter()
    empty = 0
    ids = set()
    digest = hashlib.sha256()
    with (out_dir / "rows.jsonl").open("w", encoding="utf-8", newline="\n") as f:
        for row, text in PARSERS[source](cfg, paths):
            if row is None:
                excluded["total"] += 1
                continue
            if not text.strip():
                empty += 1
                continue
            if row["id"] in ids:
                raise SourceError(f"{source}: duplicate row id {row['id']}")
            ids.add(row["id"])
            line = json.dumps(row, ensure_ascii=False) + "\n"
            f.write(line)
            digest.update(line.encode("utf-8"))
            counts[(row["sub_source"], row["domain"], row["generator"], row["label"], length_group(text))] += 1
    return {
        "source": source,
        "repo": cfg["repo"],
        "revision": cfg["revision"],
        "files": cfg["files"],
        "rows": sum(counts.values()),
        "rows_sha256": digest.hexdigest(),
        "excluded_rows": excluded["total"],
        "empty_rows": empty,
        "counts": [
            {"sub_source": s, "domain": d, "generator": g, "label": lab, "length": lg, "rows": n}
            for (s, d, g, lab, lg), n in sorted(counts.items())
        ],
    }


def check_expected(source: str, cfg: dict, receipt: dict) -> None:
    """The rows must be the ones sources.json was last run with. After a deliberate change of
    sources.json or of a parser, copy the new values into "expected"."""
    actual = {"rows": receipt["rows"], "rows_sha256": receipt["rows_sha256"]}
    expected = cfg.get("expected")
    if expected is None:
        print(f"{source}: no \"expected\" in sources.json yet; add {json.dumps(actual)}")
    elif expected != actual:
        raise SourceError(f"{source}: rows differ from sources.json: got {json.dumps(actual)}, "
                          f"expected {json.dumps(expected)}")


def print_report(receipt: dict) -> None:
    def table(title, key):
        totals = Counter()
        for c in receipt["counts"]:
            totals[(key(c), c["label"])] += c["rows"]
        print(f"  {title:<24}{'human':>10}{'AI':>10}")
        for name in sorted({k for k, _ in totals}, key=str):
            print(f"    {str(name):<22}{totals[(name, 0)]:>10}{totals[(name, 1)]:>10}")

    print(f"\n== {receipt['source']} ({receipt['repo']} @ {receipt['revision'][:8]}) ==")
    print(f"  rows {receipt['rows']}, excluded {receipt['excluded_rows']}, empty {receipt['empty_rows']}")
    print(f"  rows.jsonl sha256 {receipt['rows_sha256']}")
    table("all", lambda c: "total")
    table("sub-source (domain)", lambda c: f"{c['sub_source']} ({c['domain']})")
    table("generator", lambda c: c["generator"])
    order = [name for _, name in LENGTH_GROUPS] + [LONGEST_GROUP]
    table("words", lambda c: f"{order.index(c['length'])} {c['length']}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="*", help="keys from sources.json (default: all)")
    ap.add_argument("--out-dir", default=str(DATA / "sources"))
    ap.add_argument("--report", action="store_true", help="print the existing receipts, fetch nothing")
    args = ap.parse_args()

    manifest = load_manifest()
    names = args.sources or list(manifest["sources"])
    for name in names:
        if name not in manifest["sources"]:
            ap.error(f"unknown source {name!r}; known: {', '.join(manifest['sources'])}")

    for name in names:
        out_dir = Path(args.out_dir) / name
        receipt_path = out_dir / "receipt.json"
        if args.report:
            if not receipt_path.exists():
                print(f"\n== {name}: not fetched yet ==")
                continue
            receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        else:
            cfg = manifest["sources"][name]
            print(f"{name}: fetching {cfg['repo']} @ {cfg['revision'][:8]} and verifying checksums ...")
            paths = download(cfg)
            print(f"{name}: writing rows ...")
            receipt = write_rows(name, cfg, paths, out_dir)
            receipt_path.write_text(json.dumps(receipt, indent=1) + "\n", encoding="utf-8")
        print_report(receipt)
        if not args.report:
            check_expected(name, manifest["sources"][name], receipt)


if __name__ == "__main__":
    main()
