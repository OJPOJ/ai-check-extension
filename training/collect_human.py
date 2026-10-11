"""
Collects human texts with a verifiable state from before 2022 (issue #46/#49,
MODEL_CONCEPT.md, "Training data"). Only sources with an open licence; which ones, their
terms and their domains are defined under "collected" in sources.json.

    wikimedia      a page as it was at the cutoff: the last revision up to 2021-12-31. The
                   revision id is the proof of the state and the row id.
    stackexchange  answers created before the cutoff and not edited after it.
    arxiv          abstracts whose latest version is from before the cutoff.

Two steps, so that the collection can be repeated without passing texts on:

    discover  samples new items from the live APIs and appends their ids to
              collected/<source>.jsonl (gitignored: ids, dates and a hash of the text, no text).
    fetch     builds data/sources/<source>/rows.jsonl (gitignored) from exactly those ids, in
              the common row format of fetch_sources.py. Texts come from the local cache or are
              fetched again; items whose text changed or disappeared are listed.

Usage:
    .venv/Scripts/python.exe collect_human.py discover wikimedia --sub wikinews --n 500
    .venv/Scripts/python.exe collect_human.py discover stackexchange --n 5000
    .venv/Scripts/python.exe collect_human.py fetch                  # all collected sources
    .venv/Scripts/python.exe collect_human.py fetch arxiv --refetch  # ignore the cache
"""

import argparse
import hashlib
import json
import random
import re
import time
import xml.etree.ElementTree as ET
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path

import fetch_sources as fs

HERE = Path(__file__).resolve().parent
IDS_DIR = HERE / "collected"
USER_AGENT = "ai-check-extension-training/0.1 (https://github.com/OJPOJ/ai-check-extension)"

MIN_PARAGRAPH_WORDS = 15  # shorter paragraphs are datelines, captions, one-line remarks
MAX_TEXT_WORDS = 2000     # per text; excerpts are cut later, long pages should not dominate


# ---------------------------------------------------------------- text extraction

VOID_TAGS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"}
# Not prose a browser would show as a paragraph: tables, code, quotes of others, maths, media.
SKIP_TAGS = {"table", "style", "script", "pre", "blockquote", "figure", "math", "ol", "ul", "dl"}
# MediaWiki: footnote marks, edit links, notices, boxes, coordinates.
SKIP_CLASSES = {"reference", "mw-editsection", "noprint", "hatnote", "infobox", "navbox", "thumb", "metadata",
                "reflist", "toc", "sidebar", "geo", "mwe-math-element", "mw-cite-backlink", "shortdescription",
                "ambox", "mw-empty-elt", "noexcerpt"}


class ParagraphExtractor(HTMLParser):
    """Text of the <p> elements outside tables, lists, quotes and boxes."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.paragraphs = []
        self.skipped = Counter()
        self._skip_depth = 0
        self._buffer = None

    def handle_starttag(self, tag, attrs):
        if tag in VOID_TAGS:
            if tag == "br" and self._buffer is not None and not self._skip_depth:
                self._buffer.append(" ")
            return
        if self._skip_depth:
            self._skip_depth += 1
            return
        classes = set((dict(attrs).get("class") or "").split())
        if tag in SKIP_TAGS or classes & SKIP_CLASSES:
            self._skip_depth = 1
            self.skipped[tag] += 1
        elif tag == "p":
            self._close()
            self._buffer = []

    def handle_endtag(self, tag):
        if tag in VOID_TAGS:
            return
        if self._skip_depth:
            self._skip_depth -= 1
        elif tag == "p":
            self._close()

    def handle_data(self, data):
        if self._buffer is not None and not self._skip_depth:
            self._buffer.append(data)

    def _close(self):
        if self._buffer is not None:
            text = " ".join("".join(self._buffer).split())
            if text:
                self.paragraphs.append(text)
        self._buffer = None


def html_to_paragraphs(html: str):
    parser = ParagraphExtractor()
    parser.feed(html)
    parser.close()
    parser._close()
    return parser.paragraphs, parser.skipped


def build_text(paragraphs, min_words: int, min_paragraphs: int = 1):
    """Joins the paragraphs worth keeping, up to MAX_TEXT_WORDS. None if too little is left."""
    kept, words = [], 0
    for p in paragraphs:
        n = len(p.split())
        if n < MIN_PARAGRAPH_WORDS:
            continue
        if words + n > MAX_TEXT_WORDS and kept:
            break
        kept.append(p)
        words += n
    if words < min_words or len(kept) < min_paragraphs:
        return None
    return "\n\n".join(kept)


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def iso(timestamp) -> str:
    return datetime.fromtimestamp(int(timestamp), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def before_cutoff(iso_time: str, cutoff: str) -> bool:
    """cutoff is a date; the whole day counts."""
    return iso_time[:10] <= cutoff


# ---------------------------------------------------------------- HTTP

_session = None


def http_get(url: str, params: dict, *, pause: float = 0.0, tries: int = 5):
    global _session
    import requests

    if _session is None:
        _session = requests.Session()
        _session.headers["User-Agent"] = USER_AGENT
    for attempt in range(tries):
        try:
            r = _session.get(url, params=params, timeout=60)
            if r.status_code == 200:
                if pause:
                    time.sleep(pause)
                return r
            wait = float(r.headers.get("Retry-After", 5 * (attempt + 1)))
        except requests.RequestException:
            wait = 5 * (attempt + 1)
        time.sleep(wait)
    raise fs.SourceError(f"no answer from {url} after {tries} tries")


# ---------------------------------------------------------------- Wikimedia

TITLE_SKIP = re.compile(r"^(Lists? of |Index of |Outline of |Timeline of |Wikinews Shorts|News briefs|Crosswords/)|\(disambiguation\)")


class Wikimedia:
    """An item is {"rev": revision id, "ts": time of that revision}."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.cutoff = cfg["cutoff"]

    def api(self, sub, **params):
        site = self.cfg["sub_sources"][sub]["site"]
        return http_get(f"https://{site}/w/api.php", {"format": "json", "formatversion": 2, **params}).json()

    def row(self, sub, ref, parsed):
        """parsed is the answer of action=parse for the revision, or None."""
        if not parsed or "parse" not in parsed:
            return None
        sub_cfg = self.cfg["sub_sources"][sub]
        paragraphs, _ = html_to_paragraphs(parsed["parse"]["text"])
        text = build_text(paragraphs, sub_cfg["min_words"], min_paragraphs=2)
        if text is None:
            return None
        title = parsed["parse"]["title"]
        return {
            "row_id": f"{sub}:{ref['rev']}",
            # chapters of one wikibook stay together
            "group": f"{sub}:{title.split('/')[0]}",
            "text": text,
            "meta": {"title": title, "date": ref["ts"], "licence": sub_cfg["licence"],
                     "url": f"https://{sub_cfg['site']}/w/index.php?oldid={ref['rev']}"},
        }

    def parse(self, sub, rev):
        return self.api(sub, action="parse", oldid=rev, prop="text", disableeditsection=1, disabletoc=1)

    def candidate(self, sub, page):
        """Random page -> (ref, row) for its state at the cutoff, or None."""
        sub_cfg = self.cfg["sub_sources"][sub]
        if TITLE_SKIP.search(page["title"]) or "disambiguation" in page.get("pageprops", {}):
            return None
        if page.get("length", 0) < sub_cfg["min_bytes"]:
            return None
        answer = self.api(sub, action="query", pageids=page["pageid"], prop="revisions", rvlimit=1,
                          rvstart=self.cutoff + "T23:59:59Z", rvdir="older", rvprop="ids|timestamp|size")
        revisions = answer["query"]["pages"][0].get("revisions")
        if not revisions or revisions[0]["size"] < sub_cfg["min_bytes"]:
            return None  # created later, or only a stub at the time
        ref = {"rev": revisions[0]["revid"], "ts": revisions[0]["timestamp"]}
        row = self.row(sub, ref, self.parse(sub, ref["rev"]))
        return (ref, row) if row else None

    def discover(self, sub, n, seen):
        found = 0
        with ThreadPoolExecutor(max_workers=6) as pool:
            while found < n:
                answer = self.api(sub, action="query", generator="random", grnnamespace=0, grnlimit=50,
                                  grnfilterredir="nonredirects", prop="info|pageprops", ppprop="disambiguation")
                for result in pool.map(lambda page: self.candidate(sub, page), answer["query"]["pages"]):
                    if result and result[0]["rev"] not in seen and found < n:
                        seen.add(result[0]["rev"])
                        found += 1
                        yield result

    def refetch(self, sub, refs):
        with ThreadPoolExecutor(max_workers=6) as pool:
            yield from zip(refs, pool.map(lambda ref: self.row(sub, ref, self.parse(sub, ref["rev"])), refs))

    @staticmethod
    def key(ref):
        return ref["rev"]


# ---------------------------------------------------------------- Stack Exchange

SE_API = "https://api.stackexchange.com/2.3"
SE_FIRST_YEAR = 2011


class StackExchange:
    """An item is {"a": answer id, "ts": creation time}. Without an API key the quota is 300
    requests per day; a request returns up to 100 answers."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.cutoff = cfg["cutoff"]
        self.quota = None

    def api(self, path, **params):
        if self.quota is not None and self.quota < 10:
            raise fs.SourceError("Stack Exchange quota for today is used up")
        data = http_get(f"{SE_API}/{path}", {"filter": "withbody", "pagesize": 100, **params}).json()
        self.quota = data.get("quota_remaining", self.quota)
        time.sleep(data.get("backoff", 0) + 0.2)
        return data.get("items", [])

    def row(self, sub, item):
        """Answer from the API -> (ref, row), or None if it does not qualify."""
        created = iso(item["creation_date"])
        edited = iso(item.get("last_edit_date", item["creation_date"]))
        if not before_cutoff(created, self.cutoff) or not before_cutoff(edited, self.cutoff):
            return None
        paragraphs, skipped = html_to_paragraphs(item["body"])
        if skipped["pre"]:
            return None  # answers built around code or console output
        text = build_text(paragraphs, self.cfg["min_words"])
        if text is None:
            return None
        site = self.cfg["sub_sources"][sub]["site"]
        ref = {"a": item["answer_id"], "ts": edited}
        return ref, {
            "row_id": f"{sub}:{item['answer_id']}",
            "group": f"{sub}:{item['question_id']}",
            "text": text,
            "meta": {"date": edited, "licence": item.get("content_license", ""), "score": item["score"],
                     "author": item.get("owner", {}).get("display_name", ""),
                     "url": f"https://{site}/a/{item['answer_id']}"},
        }

    def discover(self, sub, n, seen):
        """The best answers of random 60-day windows before the cutoff."""
        first = int(datetime(SE_FIRST_YEAR, 1, 1, tzinfo=timezone.utc).timestamp())
        last = int(datetime.fromisoformat(self.cutoff).replace(tzinfo=timezone.utc).timestamp())
        window = 60 * 86400
        found, empty = 0, 0
        while found < n and empty < 5:
            start = random.randrange(first, last - window)
            items = self.api("answers", site=sub, order="desc", sort="votes", min=self.cfg["min_score"],
                             fromdate=start, todate=start + window)
            before = found
            for item in items:
                result = self.row(sub, item)
                if result and item["answer_id"] not in seen and found < n:
                    seen.add(item["answer_id"])
                    found += 1
                    yield result
            empty = empty + 1 if found == before else 0

    def refetch(self, sub, refs):
        for i in range(0, len(refs), 100):
            chunk = refs[i:i + 100]
            items = {item["answer_id"]: item for item in
                     self.api("answers/" + ";".join(str(r["a"]) for r in chunk), site=sub)}
            for ref in chunk:
                result = self.row(sub, items[ref["a"]]) if ref["a"] in items else None
                yield ref, (result[1] if result else None)

    @staticmethod
    def key(ref):
        return ref["a"]


# ---------------------------------------------------------------- arXiv

ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_PAUSE = 3.1  # terms of use: one request every three seconds
ATOM = {"a": "http://www.w3.org/2005/Atom"}
ARXIV_FIRST_YEAR = 2008


class Arxiv:
    """An item is {"x": arXiv id with version, "ts": time of that version}. The API returns the
    latest version of a paper; it is taken only if that version is from before the cutoff."""

    def __init__(self, cfg):
        self.cfg = cfg
        self.cutoff = cfg["cutoff"]

    def entries(self, **params):
        feed = ET.fromstring(http_get(ARXIV_API, params, pause=ARXIV_PAUSE).content)
        return feed.findall("a:entry", ATOM)

    def row(self, sub, entry):
        updated = entry.findtext("a:updated", "", ATOM)
        if not updated or not before_cutoff(updated, self.cutoff):
            return None
        text = " ".join(entry.findtext("a:summary", "", ATOM).split())
        if len(text.split()) < self.cfg["min_words"]:
            return None
        arxiv_id = entry.findtext("a:id", "", ATOM).rsplit("/abs/", 1)[-1]
        ref = {"x": arxiv_id, "ts": updated}
        return ref, {
            "row_id": arxiv_id,
            "group": re.sub(r"v\d+$", "", arxiv_id),
            "text": text,
            "meta": {"title": " ".join(entry.findtext("a:title", "", ATOM).split()), "date": updated,
                     "licence": self.cfg["licence"], "url": f"https://arxiv.org/abs/{arxiv_id}",
                     "authors": [a.findtext("a:name", "", ATOM) for a in entry.findall("a:author", ATOM)][:5]},
        }

    def discover(self, sub, n, seen):
        """Sub-source = group of arXiv categories; random category, year and offset per request."""
        categories = self.cfg["sub_sources"][sub]["categories"]
        last_year = int(self.cutoff[:4])
        found, empty = 0, 0
        while found < n and empty < 8:
            cat, year = random.choice(categories), random.randint(ARXIV_FIRST_YEAR, last_year)
            query = f"cat:{cat} AND submittedDate:[{year}01010000 TO {year}12312359]"
            entries = self.entries(search_query=query, start=random.randrange(0, 400), max_results=50,
                                   sortBy="submittedDate", sortOrder="ascending")
            before = found
            for entry in entries:
                result = self.row(sub, entry)
                if result and result[0]["x"] not in seen and found < n:
                    seen.add(result[0]["x"])
                    found += 1
                    yield result
            empty = empty + 1 if found == before else 0

    def refetch(self, sub, refs):
        for i in range(0, len(refs), 50):
            chunk = refs[i:i + 50]
            rows = {}
            for entry in self.entries(id_list=",".join(r["x"] for r in chunk), max_results=len(chunk)):
                result = self.row(sub, entry)
                if result:
                    rows[result[0]["x"]] = result[1]
            for ref in chunk:
                yield ref, rows.get(ref["x"])

    @staticmethod
    def key(ref):
        return ref["x"]


COLLECTORS = {"wikimedia": Wikimedia, "stackexchange": StackExchange, "arxiv": Arxiv}


# ---------------------------------------------------------------- ids, cache, rows

def read_jsonl(path: Path):
    if not path.exists():
        return []
    with path.open(encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]


def append_jsonl(path: Path, items):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8", newline="\n") as f:
        for item in items:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")


def cache_key(sub, key) -> str:
    return f"{sub}:{key}"


def discover(source: str, cfg: dict, subs, n: int, data_dir: Path):
    collector = COLLECTORS[source](cfg)
    ids_path = IDS_DIR / f"{source}.jsonl"
    cache_path = data_dir / source / "cache.jsonl"
    known = read_jsonl(ids_path)
    for sub in subs:
        fs.sub_source_config(cfg, sub)
        seen = {collector.key(item["ref"]) for item in known if item["sub"] == sub}
        have = len(seen)
        print(f"{source}/{sub}: {have} known, looking for {n} more ...", flush=True)
        batch_ids, batch_cache = [], []

        def flush():
            append_jsonl(ids_path, batch_ids)
            append_jsonl(cache_path, batch_cache)
            batch_ids.clear()
            batch_cache.clear()

        try:
            for ref, row in collector.discover(sub, n, seen):
                batch_ids.append({"sub": sub, "ref": ref, "sha": text_hash(row["text"])})
                batch_cache.append({"key": cache_key(sub, collector.key(ref)), **row})
                if len(batch_ids) >= 50:
                    flush()
                    print(f"  {source}/{sub}: {len(seen) - have} new", flush=True)
        except fs.SourceError as e:
            print(f"  stopped: {e}")
        finally:
            flush()
        print(f"{source}/{sub}: {len(seen) - have} new, {len(seen)} in total")


def fetch(source: str, cfg: dict, data_dir: Path, refetch: bool) -> dict:
    """rows.jsonl from the stored ids. Returns the receipt."""
    collector = COLLECTORS[source](cfg)
    items = read_jsonl(IDS_DIR / f"{source}.jsonl")
    out_dir = data_dir / source
    cache_path = out_dir / "cache.jsonl"
    cache = {} if refetch else {c["key"]: c for c in read_jsonl(cache_path)}

    missing = {}
    for item in items:
        if cache_key(item["sub"], collector.key(item["ref"])) not in cache:
            missing.setdefault(item["sub"], []).append(item["ref"])
    for sub, refs in missing.items():
        print(f"{source}/{sub}: fetching {len(refs)} texts ...", flush=True)
        fetched = []
        for ref, row in collector.refetch(sub, refs):
            if row:
                entry = {"key": cache_key(sub, collector.key(ref)), **row}
                cache[entry["key"]] = entry
                fetched.append(entry)
        append_jsonl(cache_path, fetched)

    out_dir.mkdir(parents=True, exist_ok=True)
    counts, gone, changed = Counter(), [], []
    digest = hashlib.sha256()
    with (out_dir / "rows.jsonl").open("w", encoding="utf-8", newline="\n") as f:
        for item in items:
            key = cache_key(item["sub"], collector.key(item["ref"]))
            entry = cache.get(key)
            if entry is None:
                gone.append(key)
                continue
            if text_hash(entry["text"]) != item["sha"]:
                changed.append(key)
                continue
            row = fs.make_row(source, cfg, row_id=entry["row_id"], sub=item["sub"], label=0, generator="human",
                              group=entry["group"], text=entry["text"], meta=entry["meta"])
            if row is None:
                continue
            line = json.dumps(row, ensure_ascii=False) + "\n"
            f.write(line)
            digest.update(line.encode("utf-8"))
            counts[(row["sub_source"], row["domain"], fs.length_group(row["text"]), row["meta"]["date"][:4])] += 1
    receipt = {
        "source": source,
        "ids": len(items),
        "rows": sum(counts.values()),
        "rows_sha256": digest.hexdigest(),
        "gone": gone,
        "changed": changed,
        "counts": [{"sub_source": s, "domain": d, "length": lg, "year": y, "rows": n}
                   for (s, d, lg, y), n in sorted(counts.items())],
    }
    (out_dir / "receipt.json").write_text(json.dumps(receipt, indent=1) + "\n", encoding="utf-8")
    return receipt


def print_report(receipt: dict) -> None:
    def table(title, key):
        totals = Counter()
        for c in receipt["counts"]:
            totals[key(c)] += c["rows"]
        print(f"  {title}")
        for name in sorted(totals):
            print(f"    {name:<34}{totals[name]:>8}")

    print(f"\n== {receipt['source']} ==")
    print(f"  ids {receipt['ids']}, rows {receipt['rows']}, gone {len(receipt['gone'])}, changed {len(receipt['changed'])}")
    print(f"  rows.jsonl sha256 {receipt['rows_sha256']}")
    for label in ("gone", "changed"):
        if receipt[label]:
            print(f"  {label}: {', '.join(receipt[label][:10])}{' ...' if len(receipt[label]) > 10 else ''}")
    table("sub-source (domain)", lambda c: f"{c['sub_source']} ({c['domain']})")
    order = [name for _, name in fs.LENGTH_GROUPS] + [fs.LONGEST_GROUP]
    table("words", lambda c: f"{order.index(c['length'])} {c['length']}")
    table("year of the state", lambda c: c["year"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("command", choices=["discover", "fetch"])
    ap.add_argument("sources", nargs="*", help="keys under 'collected' in sources.json (fetch: default all)")
    ap.add_argument("--sub", action="append", help="discover: sub-source, repeatable (default: all of the source)")
    ap.add_argument("--n", type=int, default=100, help="discover: new texts per sub-source")
    ap.add_argument("--refetch", action="store_true", help="fetch: ignore the local cache")
    ap.add_argument("--data-dir", default=str(HERE / "data" / "sources"))
    args = ap.parse_args()

    collected = fs.load_manifest()["collected"]
    names = args.sources or list(collected)
    for name in names:
        if name not in collected:
            ap.error(f"unknown source {name!r}; known: {', '.join(collected)}")
    if args.command == "discover" and len(names) != 1:
        ap.error("discover takes exactly one source")

    data_dir = Path(args.data_dir)
    for name in names:
        cfg = collected[name]
        if args.command == "discover":
            subs = args.sub or [s for s, sc in cfg["sub_sources"].items() if sc["use"]]
            discover(name, cfg, subs, args.n, data_dir)
        else:
            print_report(fetch(name, cfg, data_dir, args.refetch))


if __name__ == "__main__":
    main()
