"""
Tests for collect_human.py: text extraction, the cutoff rule, the row format and the comparison
with the stored ids. No network: API answers are written here.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dataset"))

import collect_human as ch  # noqa: E402
import fetch_sources as fs  # noqa: E402

MANIFEST = fs.load_manifest()
COLLECTED = MANIFEST["collected"]
ROW_KEYS = set(MANIFEST["row_format"])

LONG = "This sentence is here to give the paragraph enough words to be kept by the filter. "


def words(n, word="word"):
    return " ".join([word] * n)


class ManifestTest(unittest.TestCase):
    def test_collected_sources(self):
        self.assertEqual(set(COLLECTED), set(ch.COLLECTORS))
        for name, cfg in COLLECTED.items():
            self.assertRegex(cfg["cutoff"], r"^2021-\d\d-\d\d$", name)  # before 2022
            self.assertNotIn(name, MANIFEST["sources"])
            for sub, sc in cfg["sub_sources"].items():
                where = f"{name}/{sub}"
                for key in ("domain", "human_source", "terms", "terms_source"):
                    self.assertTrue(sc[key], where)
                # own collection: only sources with a stated open licence
                self.assertFalse(sc["assumed_cc"], where)
                self.assertTrue(sc["redistribute"], where)
                self.assertRegex(sc["terms"], r"CC BY|CC0", where)

    def test_no_reddit_reviews_or_publishers(self):
        sites = json.dumps(COLLECTED).lower()
        for banned in ("reddit", "yelp", "imdb", "bbc", "wikihow"):
            self.assertNotIn(banned, sites)


class ExtractionTest(unittest.TestCase):
    def test_only_prose_paragraphs(self):
        html = """
        <div class="mw-parser-output">
          <div class="hatnote">For other uses, see Example.</div>
          <table class="infobox"><tr><td><p>Born 1900 in a town</p></td></tr></table>
          <p>The <b>first</b> paragraph<sup class="reference"><a href="#n1">[1]</a></sup> has a
             footnote mark&nbsp;and an entity &amp; a<br>line break.</p>
          <h2>Heading<span class="mw-editsection">[edit]</span></h2>
          <ul><li>A list item</li><li><p>A paragraph in a list</p></li></ul>
          <blockquote><p>Words somebody else said.</p></blockquote>
          <figure><img src="x.png"><figcaption>A caption</figcaption></figure>
          <p>Energy is <span class="mwe-math-element"><math>E=mc^2</math><img alt="E"></span> here.</p>
          <p>  </p>
          <pre>code()</pre>
          <p>Last paragraph, m<sup>2</sup> kept.</p>
        </div>"""
        paragraphs, skipped = ch.html_to_paragraphs(html)
        self.assertEqual(paragraphs, [
            "The first paragraph has a footnote mark and an entity & a line break.",
            "Energy is here.",
            "Last paragraph, m2 kept.",
        ])
        self.assertEqual(skipped["pre"], 1)

    def test_nested_skipped_elements_end_where_they_should(self):
        html = '<table><tr><td><table><tr><td>inner</td></tr></table><p>in table</p></td></tr></table><p>After the tables.</p>'
        self.assertEqual(ch.html_to_paragraphs(html)[0], ["After the tables."])

    def test_build_text(self):
        short, a, b = words(14), words(15, "a"), words(200, "b")
        self.assertEqual(ch.build_text([short, a, short, b], min_words=100), a + "\n\n" + b)
        self.assertIsNone(ch.build_text([short, a], min_words=100))        # too few words
        self.assertIsNone(ch.build_text([b], min_words=100, min_paragraphs=2))
        # long pages are cut at a paragraph boundary
        text = ch.build_text([words(900)] * 4, min_words=100)
        self.assertEqual(len(text.split("\n\n")), 2)
        # ... but one very long paragraph is not dropped
        self.assertEqual(len(ch.build_text([words(2500)], min_words=100).split()), 2500)


class CutoffTest(unittest.TestCase):
    def test_before_cutoff(self):
        self.assertTrue(ch.before_cutoff("2021-12-31T23:59:59Z", "2021-12-31"))
        self.assertTrue(ch.before_cutoff("2009-05-01T00:00:00Z", "2021-12-31"))
        self.assertFalse(ch.before_cutoff("2022-01-01T00:00:00Z", "2021-12-31"))

    def test_iso(self):
        self.assertEqual(ch.iso(1640995199), "2021-12-31T23:59:59Z")


class WikimediaTest(unittest.TestCase):
    def setUp(self):
        self.wiki = ch.Wikimedia(COLLECTED["wikimedia"])
        self.parsed = {"parse": {"title": "Cookbook/Bread", "pageid": 7,
                                 "text": f"<p>{LONG * 6}</p><p>{LONG * 6}</p>"}}

    def test_row(self):
        ref = {"rev": 123, "ts": "2020-03-04T05:06:07Z"}
        row = self.wiki.row("wikibooks", ref, self.parsed)
        self.assertEqual(row["row_id"], "wikibooks:123")
        self.assertEqual(row["group"], "wikibooks:Cookbook")  # chapters of a book stay together
        self.assertEqual(row["meta"]["url"], "https://en.wikibooks.org/w/index.php?oldid=123")
        self.assertEqual(row["meta"]["date"], ref["ts"])
        self.assertEqual(len(row["text"].split("\n\n")), 2)

    def test_too_little_prose_or_missing_revision(self):
        self.assertIsNone(self.wiki.row("wikibooks", {"rev": 1, "ts": "x"}, {"parse": {"title": "T", "text": "<p>Short.</p>"}}))
        self.assertIsNone(self.wiki.row("wikibooks", {"rev": 1, "ts": "x"}, {"error": {"code": "nosuchrevid"}}))

    def test_candidate_takes_the_revision_at_the_cutoff(self):
        calls = []

        def api(sub, **params):
            calls.append(params)
            if params["action"] == "query":
                return {"query": {"pages": [{"pageid": 7, "revisions": [
                    {"revid": 123, "timestamp": "2021-11-30T10:00:00Z", "size": 9000}]}]}}
            return self.parsed

        page = {"pageid": 7, "title": "Cookbook/Bread", "length": 9000}
        with mock.patch.object(self.wiki, "api", side_effect=api):
            ref, row = self.wiki.candidate("wikibooks", page)
            self.assertEqual(ref, {"rev": 123, "ts": "2021-11-30T10:00:00Z"})
            self.assertEqual((calls[0]["rvstart"], calls[0]["rvdir"]), ("2021-12-31T23:59:59Z", "older"))
            self.assertEqual(calls[1]["oldid"], 123)
            # skipped without asking for a revision: lists, disambiguation pages, stubs
            calls.clear()
            for skipped in ({**page, "title": "List of breads"}, {**page, "pageprops": {"disambiguation": ""}},
                            {**page, "length": 100}):
                self.assertIsNone(self.wiki.candidate("wikibooks", skipped))
            self.assertEqual(calls, [])

    def test_page_created_after_the_cutoff(self):
        with mock.patch.object(self.wiki, "api", return_value={"query": {"pages": [{"pageid": 7}]}}):
            self.assertIsNone(self.wiki.candidate("wikibooks", {"pageid": 7, "title": "New", "length": 9000}))


class StackExchangeTest(unittest.TestCase):
    def setUp(self):
        self.se = ch.StackExchange(COLLECTED["stackexchange"])
        self.item = {"answer_id": 5, "question_id": 2, "score": 7, "creation_date": 1420071028,
                     "content_license": "CC BY-SA 3.0", "owner": {"display_name": "Ann"},
                     "body": f"<p>{LONG * 4}</p><blockquote><p>{LONG * 4}</p></blockquote><ul><li>item</li></ul>"}

    def test_row(self):
        ref, row = self.se.row("cooking", self.item)
        self.assertEqual(ref, {"a": 5, "ts": "2015-01-01T00:10:28Z"})
        self.assertEqual((row["row_id"], row["group"]), ("cooking:5", "cooking:2"))
        self.assertEqual(row["text"], (LONG * 4).strip())  # the quote is not the author's text
        self.assertEqual(row["meta"], {"date": "2015-01-01T00:10:28Z", "licence": "CC BY-SA 3.0", "score": 7,
                                       "author": "Ann", "url": "https://cooking.stackexchange.com/a/5"})

    def test_edited_after_the_cutoff_is_left_out(self):
        self.assertIsNone(self.se.row("cooking", {**self.item, "last_edit_date": 1672531200}))  # 2023
        ref, _ = self.se.row("cooking", {**self.item, "last_edit_date": 1500000000})            # 2017
        self.assertEqual(ref["ts"][:4], "2017")
        self.assertIsNone(self.se.row("cooking", {**self.item, "creation_date": 1672531200}))

    def test_code_and_short_answers_are_left_out(self):
        self.assertIsNone(self.se.row("cooking", {**self.item, "body": self.item["body"] + "<pre>x = 1</pre>"}))
        self.assertIsNone(self.se.row("cooking", {**self.item, "body": "<p>Yes, that works.</p>"}))


ATOM_ENTRY = """<entry xmlns="http://www.w3.org/2005/Atom">
  <id>http://arxiv.org/abs/1801.07704v2</id>
  <updated>{updated}</updated><published>2018-01-23T00:00:00Z</published>
  <title>A  title
    over two lines</title>
  <summary>  {summary}
  </summary>
  <author><name>A. Author</name></author><author><name>B. Author</name></author>
</entry>"""


class ArxivTest(unittest.TestCase):
    def setUp(self):
        self.arxiv = ch.Arxiv(COLLECTED["arxiv"])

    def entry(self, updated="2018-01-25T10:45:08Z", summary=None):
        return ET.fromstring(ATOM_ENTRY.format(updated=updated, summary=summary or words(90).replace(" ", "\n  ", 3)))

    def test_row(self):
        ref, row = self.arxiv.row("cs", self.entry())
        self.assertEqual(ref, {"x": "1801.07704v2", "ts": "2018-01-25T10:45:08Z"})
        self.assertEqual((row["row_id"], row["group"]), ("1801.07704v2", "1801.07704"))
        self.assertEqual(row["text"], words(90))
        self.assertEqual(row["meta"]["title"], "A title over two lines")
        self.assertEqual(row["meta"]["authors"], ["A. Author", "B. Author"])
        self.assertEqual(row["meta"]["url"], "https://arxiv.org/abs/1801.07704v2")

    def test_version_after_the_cutoff_or_short_abstract(self):
        self.assertIsNone(self.arxiv.row("cs", self.entry(updated="2023-02-01T00:00:00Z")))
        self.assertIsNone(self.arxiv.row("cs", self.entry(summary=words(20))))


class FetchTest(unittest.TestCase):
    """fetch builds the rows from the stored ids and names what no longer matches."""

    def run_fetch(self, ids, cache, refetched=()):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            ch.append_jsonl(d / "ids" / "arxiv.jsonl", ids)
            ch.append_jsonl(d / "data" / "arxiv" / "cache.jsonl", cache)
            with mock.patch.object(ch, "IDS_DIR", d / "ids"), \
                 mock.patch.object(ch.Arxiv, "refetch", return_value=iter(refetched)) as refetch:
                receipt = ch.fetch("arxiv", COLLECTED["arxiv"], d / "data", refetch=False)
            rows = ch.read_jsonl(d / "data" / "arxiv" / "rows.jsonl")
        return receipt, rows, refetch

    def entry(self, arxiv_id, text):
        return {"key": f"cs:{arxiv_id}", "row_id": arxiv_id, "group": arxiv_id[:-2], "text": text,
                "meta": {"title": "T", "date": "2019-05-01T00:00:00Z", "licence": "CC0 1.0", "url": "u", "authors": []}}

    def test_rows_changed_and_gone(self):
        a, b, c = words(100, "a"), words(100, "b"), words(100, "c")
        ids = [{"sub": "cs", "ref": {"x": name, "ts": "2019-05-01T00:00:00Z"}, "sha": ch.text_hash(text)}
               for name, text in (("1.1v1", a), ("2.2v1", b), ("3.3v1", c), ("4.4v1", c))]
        cache = [self.entry("1.1v1", a), self.entry("2.2v1", b + " edited")]
        refetched = [(ids[2]["ref"], self.entry("3.3v1", c)), (ids[3]["ref"], None)]
        receipt, rows, refetch = self.run_fetch(ids, cache, refetched)

        self.assertEqual(refetch.call_args[0][1], [ids[2]["ref"], ids[3]["ref"]])  # only what the cache lacks
        self.assertEqual([r["id"] for r in rows], ["arxiv:1.1v1", "arxiv:3.3v1"])
        self.assertEqual((receipt["ids"], receipt["rows"]), (4, 2))
        self.assertEqual((receipt["changed"], receipt["gone"]), (["cs:2.2v1"], ["cs:4.4v1"]))
        for r in rows:
            self.assertEqual(set(r), ROW_KEYS)
            self.assertEqual((r["source"], r["sub_source"], r["domain"], r["label"], r["generator"]),
                             ("arxiv", "cs", "sci_abstract", 0, "human"))
            self.assertEqual(r["group"], "arxiv:" + r["id"].split(":")[1][:-2])

    def test_same_ids_give_the_same_checksum(self):
        a = words(100, "a")
        ids = [{"sub": "cs", "ref": {"x": "1.1v1", "ts": "2019-05-01T00:00:00Z"}, "sha": ch.text_hash(a)}]
        first, _, _ = self.run_fetch(ids, [self.entry("1.1v1", a)])
        second, _, _ = self.run_fetch(ids, [self.entry("1.1v1", a)])
        self.assertEqual(first["rows_sha256"], second["rows_sha256"])


if __name__ == "__main__":
    unittest.main()
