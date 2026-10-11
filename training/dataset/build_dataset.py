"""
Builds the one dataset for our own detector model from the source rows (issue #46/#50,
MODEL_CONCEPT.md, "Training data"): cleaned, without duplicates, split by group, with a
frozen test part.

The parameters are in dataset.json, this script only executes that file. The source rows
(data/sources/<source>/rows.jsonl, see fetch_sources.py and collect_human.py) are read and
never changed; everything that changes a text happens here and is counted per step.

    1. Select: rows named under "drop" and the surplus of generations per document
       ("max_ai_per_group") are left out.
    2. Clean: repairs for single sources and platform boilerplate, then the same normalisation for every text
       (normalise() - the extension has to apply the same function before scoring), then the
       incomplete last sentence is cut. No step looks at the label.
    3. Duplicates: exact and near-duplicates within and across sources. Of a duplicate one
       text stays and the groups become one; every text that is also in the existing eval
       suite is removed.
    4. Split by group into train, validation and test, each group by its own hash. The
       held-out domain and the testbed groups go to test as a whole; the held-out generators
       exist in test only. Of two related texts on different sides one is dropped.
    5. Excerpt: every row gets one paragraph-length excerpt (character offsets into "text"),
       drawn the same way for both classes.
    6. Write data/dataset/<version>/{train,validation,test}.jsonl, test_ids.txt and
       report.json, and compare with "expected" in dataset.json and with the checked-in
       test manifest (test_ids.txt): a row that was test once must not become training data.

Usage:
    .venv/Scripts/python.exe dataset/build_dataset.py            # build and check against "expected"
    .venv/Scripts/python.exe dataset/build_dataset.py --accept   # after an intended change: pin the new result
    .venv/Scripts/python.exe dataset/build_dataset.py --report   # print the existing report
"""

import argparse
import hashlib
import html
import json
import random
import re
import shutil
import unicodedata
import zlib
from collections import Counter, defaultdict
from itertools import islice
from pathlib import Path

import numpy as np

from fetch_sources import length_group

HERE = Path(__file__).resolve().parent
DATA = HERE.parent / "data"  # gitignored
CONFIG = HERE / "dataset.json"
TEST_MANIFEST = HERE / "test_ids.txt"
SPLITS = ("train", "validation", "test")


class DatasetError(Exception):
    """The inputs or the result do not match what dataset.json describes."""


def load_config(path: Path = CONFIG) -> dict:
    with path.open(encoding="utf-8") as f:
        return json.load(f)


def seeded(seed, *parts) -> int:
    key = ":".join(str(p) for p in (seed, *parts)).encode("utf-8")
    return int.from_bytes(hashlib.blake2b(key, digest_size=8).digest(), "big")


# ---------- normalisation (the same for every text) ----------

HTML_TAGS = ("a|b|blockquote|br|code|div|em|h[1-6]|i|li|ol|p|pre|ref|span|strong|sub|sup|table|td|th|tr|u|ul")
HTML_TAG = re.compile(rf"</?(?:{HTML_TAGS})(?:\s+\w+=[^<>]{{0,200}})?\s*/?>", re.I)
HTML_ENTITY = re.compile(r"&(?:[a-zA-Z]{2,8}|#\d{1,6}|#x[0-9a-fA-F]{1,5});")
MD_HEADING_OR_BULLET = re.compile(r"^[ \t]{0,3}(?:(?:#{1,6}|[-*+>])[ \t]+)+", re.M)
MD_BOLD = re.compile(r"\*\*(?=\S)(.+?)(?<=\S)\*\*")
INVISIBLE = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff\ufffd]")
QUOTES = str.maketrans({"\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'",
                        "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"'})
PTB_TOKENS = {"-LRB-": "(", "-RRB-": ")", "-LSB-": "[", "-RSB-": "]", "``": '"', "''": '"'}
PTB_TOKEN = re.compile("|".join(re.escape(t) for t in PTB_TOKENS))
SPACE_BEFORE_PUNCT = re.compile(r" ([,.!?;:])(?= |$)")
DETACHED_CLITIC = re.compile(r"(?<=\w) (n't|'(?:s|re|ve|ll|m|d))\b")
SPACE_IN_BRACKETS = re.compile(r"(?<=[(\[]) | (?=[)\]])")


def _html(text: str) -> str:
    return HTML_ENTITY.sub(lambda m: html.unescape(m.group()), HTML_TAG.sub(" ", text))


def _markdown(text: str) -> str:
    return MD_BOLD.sub(r"\1", MD_HEADING_OR_BULLET.sub("", text))


def _detokenise(text: str) -> str:
    text = PTB_TOKEN.sub(lambda m: PTB_TOKENS[m.group()], text)
    text = SPACE_IN_BRACKETS.sub("", text)
    return DETACHED_CLITIC.sub(r"\1", SPACE_BEFORE_PUNCT.sub(r"\1", text))


# Order matters: markup needs the line starts, detokenising needs single spaces.
NORMALISE_STEPS = [
    ("unicode_nfc", lambda t: unicodedata.normalize("NFC", t)),
    ("html", _html),
    ("markdown", _markdown),
    ("invisible", lambda t: INVISIBLE.sub("", t)),
    ("quotes", lambda t: t.translate(QUOTES)),
    ("whitespace", lambda t: " ".join(t.split())),
    ("detokenise", _detokenise),
]


def normalise(text: str) -> tuple[str, list]:
    """One paragraph of plain text, as a browser would hand it over: NFC, no markup, no invisible
    characters, straight quotes, single spaces instead of any whitespace, no tokeniser spacing.
    Line breaks, quote style and markup differ by dataset far more than by writer, so they are
    removed everywhere. Returns the text and the names of the steps that changed it."""
    changes = []
    for name, step in NORMALISE_STEPS:
        new = step(text)
        if new != text:
            changes.append(name)
            text = new
    return text, changes


# ---------- repairs ----------

TOKENISED = re.compile(r"\w (?:n't|'s|'re|'ve|'ll|'m|'d)\b|\w [,.](?= |$)|\( \w|\w \)")
# Text a platform adds to a post, not written by the author. Found with check_shortcuts.py
# ("word sequences of one class"); removed from every text, whatever its source or class.
BOILERPLATE = {
    # r/changemyview: at the end of a third of the human texts of MAGE "cmv"
    "moderator_footnote": re.compile(r"\s*Hello, users of \w* ?! This is a footnote from your moderators\..*?(?:Happy CMVing!|$)", re.S),
    # HC3 copied some answers together with the page around them
    "chatgpt_page": re.compile(r"[\s\u00b7\u200b]*(?:ChatGPT \w{3} \d{1,2} Version\. Free Research Preview.*"
                               r"|Regenerate response\s*$)", re.S),
}
# RAID's prompt for models without a chat format ("The following is the full text of the abstract
# for a research paper titled ... from arxiv.org:"), which such a model repeats in its output.
PROMPT_ECHO = re.compile(r"[\"'`]*The following is the full text of (?:the|an?) (?:.{0,400}? from \w+\.(?:org|com|net):|[^:]{0,300}:)")
DATELINE = re.compile(r"^(?:Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, [A-Z][a-z]+ \d{1,2}, \d{4}\s*")
MAGE_OPENING_WORDS = 30

SENTENCE_END = r"[.!?\u2026]+[\"')\]]*"
BOUNDARY = re.compile(SENTENCE_END + r"\s+(?=[\"'(\[]?[A-Z0-9])")
ENDS_COMPLETE = re.compile(SENTENCE_END + r"$")
LAST_END = re.compile(SENTENCE_END + r"(?=\s)")


def tokenisation_marks(text: str) -> int:
    """How often the text shows the spacing of a tokeniser ("do n't", "word ,", "( word )")."""
    return len(TOKENISED.findall(text))


def is_tokenised(text: str, rule: dict) -> bool:
    """Tokenised through and through: such text also has split hyphens, quotes and URLs and
    cannot be put back together reliably. Single slips are left to normalise()."""
    marks = tokenisation_marks(text)
    return marks >= rule["min_marks"] and 100 * marks >= rule["per_100_words"] * len(text.split())


def cut_shared_opening(text: str, human_words) -> tuple[str, str]:
    """A MAGE continuation starts with the opening of its human text (30 words). Splits it
    after as many words as the two share, or after 30 if the human text is not known."""
    words = text.split()
    k = 0
    while human_words and k < min(len(words), len(human_words)) and words[k] == human_words[k]:
        k += 1
    if k < 10:
        k = MAGE_OPENING_WORDS
    last = None
    for last in islice(re.finditer(r"\S+", text), k):
        pass
    return (text[:last.end()], text[last.end():]) if last else ("", text)


def after_first_sentence(text: str):
    """The text from its second sentence on, None if there is none."""
    m = BOUNDARY.search(text)
    return text[m.end():] if m else None


def trim_end(text: str, min_words: int) -> str:
    """Cuts an incomplete last sentence (generations stop at a token limit), unless that would
    take more than half of the text or leave fewer than min_words."""
    if ENDS_COMPLETE.search(text):
        return text
    end = None
    for end in LAST_END.finditer(text):
        pass
    if end is None:
        return text
    kept = text[:end.end()]
    n = len(kept.split())
    return kept if n >= min_words and 2 * n >= len(text.split()) else text


def clean(row: dict, cfg: dict, human_opening=None):
    """Returns (text, changes, None) or (None, changes, reason for dropping the row)."""
    text, changes = row["text"], []
    cut_start = False
    if (row["source"], row["sub_source"]) == ("wikimedia", "wikinews") and DATELINE.match(text):
        text = DATELINE.sub("", text)
        changes.append("dateline")
    for name, pattern in BOILERPLATE.items():
        if pattern.search(text):
            text = pattern.sub("", text)
            changes.append(name)
    echo = PROMPT_ECHO.search(text)
    if echo:  # what follows is a new start of the same task: keep the part before, if there is one
        before = text[:echo.start()].rstrip()
        text = before if len(before.split()) >= cfg["min_words"] else PROMPT_ECHO.sub(" ", text)
        changes.append("prompt_echo")
    if row["source"] == "mage" and row["meta"].get("prompt_type") == "continuation":
        opening, text = cut_shared_opening(text, human_opening)
        changes.append("shared_opening")
        cut_start = not ENDS_COMPLETE.search(opening)  # the model's part starts inside a sentence
    if is_tokenised(text, cfg["tokenised"]):
        return None, changes, "tokenised"
    text, steps = normalise(text)
    changes += steps
    if cut_start:
        text = after_first_sentence(text)
        if text is None:
            return None, changes, "no_sentence_after_opening"
    trimmed = trim_end(text, cfg["min_words"])
    if trimmed != text:
        text = trimmed
        changes.append("incomplete_end")
    if len(text.split()) < cfg["min_words"]:
        return None, changes, "short"
    return text, changes, None


# ---------- reading and selecting ----------

def read_rows(data_dir: Path, source: str):
    path = data_dir / "sources" / source / "rows.jsonl"
    if not path.exists():
        raise DatasetError(f"{path} is missing: run fetch_sources.py or collect_human.py first")
    with path.open(encoding="utf-8") as f:
        for line in f:
            yield json.loads(line)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def input_checksum(data_dir: Path, source: str) -> str:
    path = data_dir / "sources" / source / "rows.jsonl"
    if not path.exists():
        raise DatasetError(f"{path} is missing: run fetch_sources.py or collect_human.py first")
    return sha256_file(path)


def select_generations(generations, k: int, seed, always=()) -> set:
    """generations: (row id, group, generator) of the AI rows of one source. Per group k ids,
    in a seeded order and from different generators as long as there are any. Generators named
    in "always" are kept whole and do not count."""
    by_group = defaultdict(list)
    kept = set()
    for row_id, group, generator in generations:
        if generator in always:
            kept.add(row_id)
        else:
            by_group[group].append((seeded(seed, row_id), row_id, generator))
    for items in by_group.values():
        items.sort()
        chosen, used = [], set()
        for _, row_id, generator in items:
            if generator not in used and len(chosen) < k:
                chosen.append(row_id)
                used.add(generator)
        for _, row_id, _ in items:
            if len(chosen) < k and row_id not in chosen:
                chosen.append(row_id)
        kept.update(chosen)
    return kept


def is_dropped(row: dict, rules) -> bool:
    return any(all(row.get(k) == v for k, v in rule.items() if k != "reason") for rule in rules)


def load_clean(cfg: dict, data_dir: Path, stats: dict) -> list:
    """Steps 1 and 2. Returns the cleaned rows; stats gets the counts per step."""
    rows = []
    for source in cfg["sources"]:
        keep = None
        if source in cfg["max_ai_per_group"]:
            generations = [(r["id"], r["group"], r["generator"]) for r in read_rows(data_dir, source) if r["label"] == 1]
            keep = select_generations(generations, cfg["max_ai_per_group"][source], cfg["seed"],
                                      always=cfg["held_out"]["generators"])
        openings = {}
        if source == "mage":
            for r in read_rows(data_dir, source):
                if r["label"] == 0:
                    openings.setdefault(r["group"], r["text"].split()[:2 * MAGE_OPENING_WORDS])
        for row in read_rows(data_dir, source):
            key = (row["source"], row["sub_source"], row["label"])
            stats["read"][key] += 1
            if is_dropped(row, cfg["drop"]):
                stats["dropped"][("configured",) + key] += 1
                continue
            if keep is not None and row["label"] == 1 and row["id"] not in keep:
                stats["dropped"][("surplus_generation",) + key] += 1
                continue
            text, changes, reason = clean(row, cfg, openings.get(row["group"]))
            if reason:
                stats["dropped"][(reason,) + key] += 1
                continue
            for change in changes:
                stats["changed"][(change,) + key] += 1
            row["text"] = text
            row["changes"] = changes
            rows.append(row)
        print(f"  {source}: {sum(1 for r in rows if r['source'] == source)} rows after cleaning")
    return rows


# ---------- duplicates ----------

SHINGLE_WORD = re.compile(r"[a-z0-9]+")


def fingerprint(text: str, n: int):
    """(hash of all words, sorted hashes of all n-word sequences of the text)."""
    words = SHINGLE_WORD.findall(text.lower())
    hashes = set()
    for i in range(len(words) - n + 1):
        s = " ".join(words[i:i + n]).encode("utf-8")
        hashes.add((zlib.adler32(s) << 32) | zlib.crc32(s))
    return (hashlib.blake2b(" ".join(words).encode("utf-8"), digest_size=8).digest(),
            np.fromiter(sorted(hashes), dtype=np.uint64, count=len(hashes)))


def shared_shingles(shingles, max_rows: int, min_shared: int):
    """Pairs of texts with common shingles: arrays a < b and the number shared. A shingle that
    occurs in more than max_rows texts is a stock phrase, not a sign of a common origin, and
    is ignored; their number is returned."""
    n = len(shingles)
    empty = np.empty(0, np.int64)
    sizes = np.fromiter((len(s) for s in shingles), dtype=np.int64, count=n)
    if not sizes.sum():
        return empty, empty, empty, 0
    owner = np.repeat(np.arange(n, dtype=np.int64), sizes)
    hashes = np.concatenate(shingles)
    order = np.argsort(hashes, kind="stable")
    hashes, owner = hashes[order], owner[order]
    del order
    starts = np.flatnonzero(np.concatenate(([True], hashes[1:] != hashes[:-1])))
    lengths = np.diff(np.append(starts, len(hashes)))
    del hashes
    keys = []
    for length in range(2, max_rows + 1):
        s = starts[lengths == length]
        if not len(s):
            continue
        block = owner[s[:, None] + np.arange(length)]
        for i in range(length):
            for j in range(i + 1, length):
                keys.append(block[:, i] * n + block[:, j])
    stock = int((lengths > max_rows).sum())
    if not keys:
        return empty, empty, empty, stock
    pairs, shared = np.unique(np.concatenate(keys), return_counts=True)
    enough = shared >= min_shared
    pairs, shared = pairs[enough], shared[enough]
    return pairs // n, pairs % n, shared, stock


class Union:
    def __init__(self):
        self.parent = {}

    def find(self, x):
        root = x
        while self.parent.setdefault(root, root) != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.parent[max(a, b)] = min(a, b)


def remove_duplicates(rows: list, suite_texts: list, cfg: dict, stats: dict):
    """Step 3. Similarity of two texts = shared shingles / shingles of the shorter one, so an
    excerpt counts as a duplicate of the text it was cut from.

    Duplicates: one text stays and the groups become one. Related texts (less similar) keep
    their groups - merging those would chain unrelated texts into groups of hundreds - and are
    returned as pairs of row ids, for the split to keep them on one side."""
    p = cfg["duplicates"]
    texts = [r["text"] for r in rows] + suite_texts
    n_rows = len(rows)
    exact = defaultdict(list)
    shingles = []
    for i, text in enumerate(texts):
        key, hashes = fingerprint(text, p["shingle_words"])
        exact[key].append(i)
        shingles.append(hashes)
    sizes = np.fromiter((len(s) for s in shingles), dtype=np.int64, count=len(shingles))
    a, b, shared, stock = shared_shingles(shingles, p["max_rows_per_shingle"], p["min_shared"])
    del shingles
    similarity = shared / np.minimum(sizes[a], sizes[b]) if len(a) else np.empty(0)
    close = similarity >= p["related"]
    a, b, similarity = a[close].tolist(), b[close].tolist(), similarity[close].tolist()
    stats["duplicates"]["stock_shingles_ignored"] = stock

    same, groups = Union(), Union()
    for members in exact.values():
        for other in members[1:]:
            same.union(members[0], other)
    in_suite, suite_found, related = set(), set(), []
    for x, y, sim in zip(a, b, similarity):
        if y >= n_rows:  # the suite texts come last, so y is the suite text if one of them is
            if x < n_rows:
                in_suite.add(x)
                suite_found.add(y)
        elif sim >= p["duplicate"]:
            same.union(x, y)
        else:
            related.append((x, y))

    clusters = defaultdict(list)
    for i in range(len(texts)):
        clusters[same.find(i)].append(i)
    drop = {}
    for members in clusters.values():
        members_rows = [i for i in members if i < n_rows]
        if len(members_rows) < len(members):
            in_suite.update(members_rows)
            suite_found.update(i for i in members if i >= n_rows and members_rows)
            continue
        if len(members_rows) < 2:
            continue
        for i in members_rows[1:]:
            groups.union(rows[members_rows[0]]["group"], rows[i]["group"])
        if len({rows[i]["label"] for i in members_rows}) > 1:
            drop.update((i, "label_conflict") for i in members_rows)
        else:  # rows are in the order of "sources", the first one stays
            drop.update((i, "duplicate") for i in members_rows[1:])
    drop.update((i, "in_eval_suite") for i in in_suite)

    kept = []
    for i, row in enumerate(rows):
        if i in drop:
            stats["dropped"][(drop[i], row["source"], row["sub_source"], row["label"])] += 1
            continue
        group = groups.find(row["group"])
        if group != row["group"]:
            stats["duplicates"]["rows_in_merged_groups"] += 1
            row["meta"]["source_group"] = row["group"]
            row["group"] = group
        kept.append(row)
    stats["duplicates"]["suite_texts"] = len(suite_texts)
    stats["duplicates"]["suite_texts_found"] = len(suite_found)
    pairs = [(rows[x]["id"], rows[y]["id"]) for x, y in related if x not in drop and y not in drop]
    stats["duplicates"]["related_pairs"] = len(pairs)
    return kept, pairs


# ---------- split ----------

RANK = {"train": 0, "validation": 1, "test": 2}


def source_group(row: dict) -> str:
    return row["meta"].get("source_group", row["group"])


def view_of(row: dict, held: dict) -> str:
    if row["domain"] in held["domains"]:
        return "held_out_domain"
    if any(source_group(row).startswith(p) for p in held["group_prefixes"]):
        return "testbed"
    if row["generator"] in held["generators"]:
        return "held_out_generator"
    return "main"


def side_of(key: str, cfg: dict) -> str:
    """The side a group is drawn to: a fixed share of the hash range, not a rank among the
    groups, so it does not depend on which other groups exist."""
    u = seeded(cfg["seed"], "split", key) / 2 ** 64
    test, validation = cfg["split"]["test"], cfg["split"]["validation"]
    return "test" if u < test else "validation" if u < test + validation else "train"


def split_groups(rows: list, cfg: dict) -> dict:
    """group -> split. Every source group is drawn by its own hash; a group that was merged
    from several takes the side closest to test of any of them, as does a group with a row of
    the held-out domain or of a testbed. New data or a new merge can therefore move a group
    towards test, never out of it: the test part of one version stays test in the next."""
    held = cfg["held_out"]
    result = {}
    for row in rows:
        forced = view_of(row, held) in ("held_out_domain", "testbed")
        side = "test" if forced else side_of(source_group(row), cfg)
        if RANK[side] >= RANK[result.get(row["group"], "train")]:
            result[row["group"]] = side
    return result


def separate_related(rows: list, split_of: dict, related: list) -> dict:
    """row id -> reason, for the rows to drop so that no two related texts are on two sides:
    of such a pair the row further from test goes."""
    side = {r["id"]: split_of[r["group"]] for r in rows}
    drop = {}
    for x, y in related:
        if x in drop or y in drop or side[x] == side[y]:
            continue
        drop[x if RANK[side[x]] < RANK[side[y]] else y] = "related_to_other_split"
    return drop


# ---------- excerpt ----------

def sentence_spans(text: str) -> list:
    spans, start = [], 0
    for m in BOUNDARY.finditer(text):
        end = m.start() + len(m.group().rstrip())
        spans.append((start, end))
        start = m.end()
    if start < len(text):
        spans.append((start, len(text)))
    return spans


def excerpt(text: str, rng: random.Random, cfg: dict) -> tuple[int, int]:
    """Character offsets of an excerpt of whole sentences, as long as a paragraph in the
    browser: a length range is drawn first, then a start among the sentences from which the
    excerpt lands in that range (any start if none does). A text shorter than the drawn length
    is taken whole. Cut inside a sentence only where one sentence exceeds the limits."""
    p = cfg["excerpt"]
    lo, hi, _ = rng.choices(p["lengths"], weights=[w for _, _, w in p["lengths"]])[0]
    target = rng.randint(lo, hi)
    max_words = p["lengths"][-1][1]
    spans = sentence_spans(text)
    words = [len(text[s:e].split()) for s, e in spans]
    if sum(words) <= target:
        i, j = 0, len(spans)
    else:
        candidates = []
        for i in range(len(spans)):
            n, j = 0, i
            while j < len(spans) and n < target:
                n += words[j]
                j += 1
            if n < target:
                break
            if n > hi and n - words[j - 1] >= lo:  # the last sentence overshoots the range
                n, j = n - words[j - 1], j - 1
            candidates.append((i, j, lo <= n <= hi))
        i, j, _ = rng.choice([c for c in candidates if c[2]] or candidates)
    while (sum(words[i:j - 1]) >= cfg["min_words"]
           and (spans[j - 1][1] - spans[i][0] > p["max_chars"] or sum(words[i:j]) > max_words)):
        j -= 1
    start, end = spans[i][0], spans[j - 1][1]
    if sum(words[i:j]) > max_words:
        last = None
        for last in islice(re.finditer(r"\S+", text[start:end]), max_words):
            pass
        end = start + last.end()
    if end - start > p["max_chars"]:
        end = text.rfind(" ", start, start + p["max_chars"] + 1)
    return start, end


# ---------- build ----------

def table(counter: Counter, names) -> list:
    return [dict(zip(names, key)) | {"rows": n} for key, n in sorted(counter.items(), key=lambda kv: tuple(map(str, kv[0])))]


def build(cfg: dict, data_dir: Path, out_dir: Path) -> dict:
    stats = {"read": Counter(), "changed": Counter(), "dropped": Counter(), "duplicates": Counter()}
    print("hashing the inputs ...")
    inputs = {source: input_checksum(data_dir, source) for source in cfg["sources"]}
    suite_path = data_dir.parent / cfg["suite"]["path"]
    if not suite_path.exists():
        raise DatasetError(f"{suite_path} is missing: build it with build_eval_suite.py, its texts must stay out")
    inputs["eval_suite"] = sha256_file(suite_path)
    with suite_path.open(encoding="utf-8") as f:
        suite_texts = [normalise(json.loads(line)["text"])[0] for line in f]

    print("cleaning ...")
    rows = load_clean(cfg, data_dir, stats)
    print(f"looking for duplicates among {len(rows)} rows ...")
    rows, related = remove_duplicates(rows, suite_texts, cfg, stats)

    print("splitting ...")
    held = cfg["held_out"]
    split_of = split_groups(rows, cfg)
    drop = separate_related(rows, split_of, related)
    out_dir.mkdir(parents=True, exist_ok=True)
    by_split = {name: [] for name in SPLITS}
    counts, group_sizes = Counter(), Counter()
    for row in rows:
        split, view = split_of[row["group"]], view_of(row, held)
        key = (row["source"], row["sub_source"], row["label"])
        if split != "test" and view == "held_out_generator":
            drop[row["id"]] = "held_out_generator_outside_test"
        if row["id"] in drop:
            stats["dropped"][(drop[row["id"]],) + key] += 1
            continue
        start, end = excerpt(row["text"], random.Random(seeded(cfg["seed"], "excerpt", row["id"])), cfg)
        row = {k: row[k] for k in ("id", "source", "sub_source", "domain", "label", "generator", "group")} | {
            "split": split, "view": view, "text": row["text"], "excerpt": [start, end],
            "changes": row["changes"], "meta": row["meta"]}
        by_split[split].append(row)
        group_sizes[row["group"]] += 1
        counts[(split, view, row["source"], row["domain"], row["generator"], row["label"],
                length_group(row["text"][start:end]))] += 1

    report = {"version": cfg["version"], "inputs": inputs, "rows": {}, "sha256": {}}
    for split, items in by_split.items():
        items.sort(key=lambda r: r["id"])
        with (out_dir / f"{split}.jsonl").open("w", encoding="utf-8", newline="\n") as f:
            for row in items:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        report["rows"][split] = len(items)
        report["sha256"][split] = sha256_file(out_dir / f"{split}.jsonl")
    (out_dir / "test_ids.txt").write_text("".join(r["id"] + "\n" for r in by_split["test"]), encoding="utf-8", newline="\n")
    report["sha256"]["test_ids"] = sha256_file(out_dir / "test_ids.txt")

    groups = {split: {r["group"] for r in items} for split, items in by_split.items()}
    for x, y in (("train", "validation"), ("train", "test"), ("validation", "test")):
        if groups[x] & groups[y]:
            raise DatasetError(f"{len(groups[x] & groups[y])} groups are in {x} and in {y}")
    report["groups"] = {split: len(g) for split, g in groups.items()}
    testbeds = tuple(held["group_prefixes"])
    ordinary = Counter({g: n for g, n in group_sizes.items() if not g.startswith(testbeds)})
    report["largest_groups"] = ordinary.most_common(5)
    key3 = ("source", "sub_source", "label")
    report["read"] = table(stats["read"], key3)
    report["changed"] = table(stats["changed"], ("step",) + key3)
    report["dropped"] = table(stats["dropped"], ("reason",) + key3)
    report["duplicates"] = dict(stats["duplicates"])
    report["counts"] = table(counts, ("split", "view", "source", "domain", "generator", "label", "length"))
    (out_dir / "report.json").write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return report


def check_expected(cfg: dict, report: dict) -> None:
    actual = {k: report[k] for k in ("inputs", "rows", "sha256")}
    expected = cfg.get("expected")
    if expected != actual:
        what = ("nothing is pinned yet" if expected is None else "the source rows differ" if expected["inputs"] != actual["inputs"]
                else "same source rows, different result")
        raise DatasetError(f"dataset differs from dataset.json ({what}). If the change is intended, run with --accept. Got\n"
                           + json.dumps(actual, indent=2))


def check_frozen(manifest: Path, out_dir: Path) -> int:
    """No row of the checked-in test manifest may be in train or validation. Returns how many
    of its rows are no longer in the dataset at all (dropped by a changed rule)."""
    if not manifest.exists():
        return 0
    frozen = set(manifest.read_text(encoding="utf-8").split())
    now = set((out_dir / "test_ids.txt").read_text(encoding="utf-8").split())
    moved = []
    for split in ("train", "validation"):
        with (out_dir / f"{split}.jsonl").open(encoding="utf-8") as f:
            moved += [row_id for row_id in (json.loads(line)["id"] for line in f) if row_id in frozen]
    if moved:
        raise DatasetError(f"{len(moved)} rows of the frozen test part ({manifest.name}) are now in train or validation, "
                           f"e.g. {moved[:3]}")
    return len(frozen - now)


def accept(cfg_path: Path, manifest: Path, report: dict, out_dir: Path) -> None:
    """Pins this result: "expected" in dataset.json and the test manifest in git."""
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["expected"] = {k: report[k] for k in ("inputs", "rows", "sha256")}
    cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    shutil.copyfile(out_dir / "test_ids.txt", manifest)


def print_report(report: dict) -> None:
    def total(items, *keys, **where):
        out = Counter()
        for item in items:
            if all(item[k] == v for k, v in where.items()):
                out[tuple(item[k] for k in keys)] += item["rows"]
        return out

    label = {0: "human", 1: "ai"}
    print(f"\n== dataset {report['version']} ==")
    read = sum(i["rows"] for i in report["read"])
    print(f"source rows {read}, in the dataset {sum(report['rows'].values())}: "
          + ", ".join(f"{s} {report['rows'][s]} rows / {report['groups'][s]} groups" for s in SPLITS))
    print("\ndropped (reason: rows; by source/class):")
    by_reason = total(report["dropped"], "reason")
    for (reason,), n in by_reason.most_common():
        detail = total(report["dropped"], "source", "label", reason=reason)
        print(f"  {reason}: {n}  (" + ", ".join(f"{s}/{label[lab]} {v}" for (s, lab), v in sorted(detail.items())) + ")")
    print("\nchanged (step: rows; by source/class in % of the rows read):")
    read_by = total(report["read"], "source", "label")
    for (step,), n in total(report["changed"], "step").most_common():
        detail = total(report["changed"], "source", "label", step=step)
        print(f"  {step}: {n}  (" + ", ".join(f"{s}/{label[lab]} {100 * v / read_by[(s, lab)]:.0f}%" for (s, lab), v in sorted(detail.items())) + ")")
    print("\nduplicates:", report["duplicates"])
    print("largest groups outside the testbeds:", ", ".join(f"{g} {n}" for g, n in report["largest_groups"]))
    for split in SPLITS:
        print(f"\n{split}: rows by source, domain and class")
        cells = total(report["counts"], "source", "domain", "label", split=split)
        for source, domain in sorted({k[:2] for k in cells}):
            print(f"  {source:14} {domain:13} human {cells[(source, domain, 0)]:7}  ai {cells[(source, domain, 1)]:7}")
    print("\ntest: rows by view and class")
    for (view, lab), n in sorted(total(report["counts"], "view", "label", split="test").items()):
        print(f"  {view:20} {label[lab]:6} {n}")
    print("\nexcerpt length by class (all splits, %):")
    lengths = total(report["counts"], "label", "length")
    for lab in (0, 1):
        n = sum(v for (l, _), v in lengths.items() if l == lab)
        print(f"  {label[lab]:6} " + "  ".join(f"{g} {100 * lengths[(lab, g)] / n:.0f}" for g in ("<15", "15-39", "40-119", ">=120")))
    gens = total(report["counts"], "generator", "split")
    print("\ngenerators (train / validation / test):")
    for g in sorted({k[0] for k in gens}):
        print(f"  {g:22} {gens[(g, 'train')]:7} {gens[(g, 'validation')]:6} {gens[(g, 'test')]:6}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=str(DATA))
    ap.add_argument("--report", action="store_true", help="print the existing report, build nothing")
    ap.add_argument("--accept", action="store_true",
                    help='pin the result of this run: write "expected" to dataset.json and the test manifest')
    args = ap.parse_args()
    cfg = load_config()
    data_dir = Path(args.data_dir)
    out_dir = data_dir / "dataset" / cfg["version"]
    if args.report:
        print_report(json.loads((out_dir / "report.json").read_text(encoding="utf-8")))
        return
    # Built next to the existing version and moved there only after the checks, so that a run
    # that differs never replaces the frozen files.
    new_dir = out_dir.with_name(out_dir.name + ".new")
    if new_dir.exists():
        shutil.rmtree(new_dir)
    report = build(cfg, data_dir, new_dir)
    print_report(report)
    gone = check_frozen(TEST_MANIFEST, new_dir)
    if gone:
        print(f"\n{gone} rows of the frozen test part are no longer in the dataset")
    if args.accept:
        accept(CONFIG, TEST_MANIFEST, report, new_dir)
        print(f"\naccepted: dataset.json and {TEST_MANIFEST.name} updated")
    else:
        try:
            check_expected(cfg, report)
        except DatasetError:
            print(f"\nthe existing {out_dir.name} is untouched; this run is in {new_dir}")
            raise
    if out_dir.exists():
        shutil.rmtree(out_dir)
    new_dir.rename(out_dir)


if __name__ == "__main__":
    main()
