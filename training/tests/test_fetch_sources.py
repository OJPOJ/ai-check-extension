"""
Tests for fetch_sources.py and sources.json: row format, label convention, groups and the
agreed exclusions. They use small files written here, not the real datasets.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dataset"))

import fetch_sources as fs  # noqa: E402

MANIFEST = fs.load_manifest()
SOURCES = MANIFEST["sources"]
ROW_KEYS = set(MANIFEST["row_format"])


def write_csv(path, header, rows):
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        w.writerows(rows)


def rows_of(source, paths, cfg=None):
    return [row for row, _ in fs.PARSERS[source](cfg or SOURCES[source], paths) if row is not None]


class ManifestTest(unittest.TestCase):
    def test_every_source_is_pinned_and_has_a_parser(self):
        for name, cfg in SOURCES.items():
            self.assertIn(name, fs.PARSERS)
            self.assertRegex(cfg["revision"], r"^[0-9a-f]{40}$")
            self.assertTrue(cfg["licence"])
            for file, sha in cfg["files"].items():
                self.assertRegex(sha, r"^[0-9a-f]{64}$", f"{name}/{file}")

    def test_sub_sources_are_complete(self):
        for name, cfg in SOURCES.items():
            for sub, sc in cfg["sub_sources"].items():
                where = f"{name}/{sub}"
                self.assertIn("domain", sc, where)
                self.assertIsInstance(sc["use"], bool, where)
                self.assertIsInstance(sc["redistribute"], bool, where)
                for key in ("human_source", "terms", "terms_source"):
                    self.assertTrue(sc[key], where)
                self.assertIsInstance(sc["assumed_cc"], bool, where)
                if not sc["use"]:
                    self.assertTrue(sc["reason"], where)
                if sc["assumed_cc"]:
                    self.assertFalse(sc["redistribute"], where)

    def test_agreed_exclusions(self):
        # MODEL_CONCEPT.md, "Licences", rules agreed 2026-10-11
        # plus the sub-sources whose own terms are non-commercial (read at the source)
        for source, sub in [("hc3", "medicine"), ("hc3", "finance"), ("hc3", "open_qa"), ("mage", "yelp"),
                            ("mage", "hswag"), ("mage", "dialogsum"), ("raid", "news"), ("raid", "recipes"),
                            ("mage", "xsum")]:  # BBC, like raid/news
            self.assertFalse(SOURCES[source]["sub_sources"][sub]["use"], f"{source}/{sub}")
        for excluded in ("m4gt", "m4", "coling"):
            self.assertNotIn(excluded, SOURCES)
        # files of excluded HC3 parts are not even downloaded
        self.assertEqual(set(SOURCES["hc3"]["files"]), {"reddit_eli5.jsonl", "wiki_csai.jsonl"})
        self.assertEqual(set(SOURCES["raid"]["files"]), {"train.csv"})

    def test_same_human_source_is_treated_the_same(self):
        # ELI5 is in HC3 and in MAGE, IMDb in MAGE and in RAID
        for a, b in [(("hc3", "reddit_eli5"), ("mage", "eli5")), (("mage", "imdb"), ("raid", "reviews"))]:
            x, y = (SOURCES[s]["sub_sources"][sub] for s, sub in (a, b))
            for key in ("use", "assumed_cc", "redistribute"):
                self.assertEqual(x[key], y[key], f"{a} vs {b}: {key}")

    def test_expected_rows_are_pinned(self):
        for name, cfg in SOURCES.items():
            self.assertIsInstance(cfg["expected"]["rows"], int, name)
            self.assertRegex(cfg["expected"]["rows_sha256"], r"^[0-9a-f]{64}$", name)


class HelpersTest(unittest.TestCase):
    def test_length_group(self):
        for n, expected in [(1, "<15"), (14, "<15"), (15, "15-39"), (39, "15-39"), (40, "40-119"), (119, "40-119"), (120, ">=120")]:
            self.assertEqual(fs.length_group("w " * n), expected, n)

    def test_prefix_group_ignores_case_punctuation_and_the_rest(self):
        opening = "One two three four five six seven eight nine ten eleven twelve"
        a = fs.prefix_group(opening + " and then the human went on.")
        b = fs.prefix_group(opening.upper().replace(" ", ",  ") + " while the model continued differently")
        self.assertEqual(a, b)
        self.assertNotEqual(a, fs.prefix_group("Another " + opening))

    def test_unknown_sub_source_is_an_error(self):
        with self.assertRaises(fs.SourceError):
            fs.make_row("raid", SOURCES["raid"], row_id="x", sub="new_domain", label=1, generator="gpt4",
                        group="g", text="t", meta={})


class Hc3Test(unittest.TestCase):
    def test_rows(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "reddit_eli5.jsonl"
            path.write_text(
                json.dumps({"question": "q0", "human_answers": ["h a", "h b"], "chatgpt_answers": ["ai a"]}) + "\n"
                + json.dumps({"question": "q1", "human_answers": ["h c"], "chatgpt_answers": []}) + "\n",
                encoding="utf-8",
            )
            rows = rows_of("hc3", {"reddit_eli5.jsonl": path})
        self.assertEqual([r["id"] for r in rows],
                         ["hc3:reddit_eli5:0:h0", "hc3:reddit_eli5:0:h1", "hc3:reddit_eli5:0:a0", "hc3:reddit_eli5:1:h0"])
        self.assertEqual([r["label"] for r in rows], [0, 0, 1, 0])
        self.assertEqual([r["generator"] for r in rows], ["human", "human", "chatgpt-2022", "human"])
        # all answers to one question share a group
        self.assertEqual(len({r["group"] for r in rows[:3]}), 1)
        self.assertNotEqual(rows[0]["group"], rows[3]["group"])
        for r in rows:
            self.assertEqual(set(r), ROW_KEYS)
            self.assertEqual((r["source"], r["sub_source"], r["domain"]), ("hc3", "reddit_eli5", "forum"))

    def test_excluded_part_gives_no_rows(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "medicine.jsonl"
            path.write_text(json.dumps({"question": "q", "human_answers": ["h"], "chatgpt_answers": ["a"]}) + "\n", encoding="utf-8")
            self.assertEqual(rows_of("hc3", {"medicine.jsonl": path}), [])


class MageTest(unittest.TestCase):
    def test_src(self):
        subs = SOURCES["mage"]["sub_sources"]
        self.assertEqual(fs.parse_mage_src("sci_gen_human", subs), ("sci_gen", True, "", "human"))
        self.assertEqual(fs.parse_mage_src("cmv_machine_continuation_flan_t5_base", subs),
                         ("cmv", False, "continuation", "flan_t5_base"))
        self.assertEqual(fs.parse_mage_src("sci_gen_machine_topical_gpt-3.5-trubo", subs),
                         ("sci_gen", False, "topical", "gpt-3.5-trubo"))
        self.assertEqual(fs.parse_mage_src("cnn_gpt4", subs), ("cnn", False, "", "gpt4"))
        self.assertEqual(fs.parse_mage_src("cnn_human_para", subs)[:3], ("cnn", False, "paraphrase_of_human"))
        self.assertEqual(fs.parse_mage_src("cnn_gpt4_para", subs), ("cnn", False, "paraphrase", "gpt4"))
        for bad in ("cmv_machine_rewrite_gpt4", "cmv_machine_topical", "newdomain_gpt4", "cnn_claude"):
            with self.assertRaises(fs.SourceError, msg=bad):
                fs.parse_mage_src(bad, subs)

    def test_rows_label_is_inverted_and_yelp_left_out(self):
        opening = "one two three four five six seven eight nine ten eleven twelve"
        with tempfile.TemporaryDirectory() as d:
            train = Path(d) / "train.csv"
            write_csv(train, ["\ufefftext", "label", "src"], [
                [opening + " human ending", "1", "cmv_human"],
                [opening + " model ending", "0", "cmv_machine_continuation_gpt-3.5-trubo"],
                ["A text written on the topic only", "0", "cmv_machine_topical_7B"],
                ["A restaurant review", "1", "yelp_human"],
                ["A generated restaurant review", "0", "yelp_machine_continuation_t0_3b"],
            ])
            para = Path(d) / "test_ood_set_gpt_para.csv"
            write_csv(para, ["text", "label", "src"], [
                ["A news text", "1", "cnn_human"],
                ["A paraphrased news text", "0", "cnn_human_para"],
            ])
            rows = rows_of("mage", {"train.csv": train, "test_ood_set_gpt_para.csv": para})
        self.assertEqual([r["id"] for r in rows], ["mage:train:0", "mage:train:1", "mage:train:2", "mage:test_ood_set_gpt_para:1"])
        self.assertEqual([r["label"] for r in rows], [0, 1, 1, 1])
        self.assertEqual([r["generator"] for r in rows], ["human", "gpt-3.5-turbo", "llama-7b", "gpt-3.5-turbo"])
        self.assertNotIn("yelp", {r["sub_source"] for r in rows})
        # a continuation shares the group of the human text it continues
        self.assertEqual(rows[0]["group"], rows[1]["group"])
        self.assertNotEqual(rows[0]["group"], rows[2]["group"])
        self.assertEqual(rows[1]["meta"], {"split": "train", "prompt_type": "continuation", "generator_raw": "gpt-3.5-trubo"})
        for r in rows:
            self.assertEqual(set(r), ROW_KEYS)

    def test_out_of_domain_files_are_grouped_by_sub_source(self):
        with tempfile.TemporaryDirectory() as d:
            ood = Path(d) / "test_ood_set_gpt.csv"
            write_csv(ood, ["text", "label", "src"], [
                ["The council met on Monday to discuss the budget", "1", "cnn_human"],
                ["A generated article about the council", "0", "cnn_gpt4"],
                ["A film review", "1", "imdb_human"],
            ])
            para = Path(d) / "test_ood_set_gpt_para.csv"
            write_csv(para, ["text", "label", "src"], [
                ["On Monday, council members gathered to talk about the budget", "0", "cnn_human_para"],
            ])
            rows = rows_of("mage", {"test_ood_set_gpt.csv": ood, "test_ood_set_gpt_para.csv": para})
        groups = [r["group"] for r in rows]
        # original and paraphrase open differently, but must stay on one side of the split
        self.assertEqual(groups, ["mage:ood:cnn", "mage:ood:cnn", "mage:ood:imdb", "mage:ood:cnn"])

    def test_label_contradicting_src_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "train.csv"
            write_csv(path, ["text", "label", "src"], [["t", "0", "cmv_human"]])
            with self.assertRaises(fs.SourceError):
                rows_of("mage", {"train.csv": path})


RAID_HEADER = ["id", "adv_source_id", "source_id", "model", "decoding", "repetition_penalty", "attack", "domain",
               "title", "prompt", "generation"]


class RaidTest(unittest.TestCase):
    def write(self, d):
        path = Path(d) / "train.csv"
        write_csv(path, RAID_HEADER, [
            ["h1", "h1", "h1", "human", "", "", "none", "books", "T", "", "Human book summary"],
            ["g1", "g1", "h1", "chatgpt", "greedy", "no", "none", "books", "T", "p", "Generated book summary"],
            ["g2", "g1", "h1", "chatgpt", "greedy", "no", "homoglyph", "books", "T", "p", "Generated summary, attacked"],
            ["g3", "g3", "h2", "mpt-chat", "sampling", "yes", "none", "wiki", "T", "p", "Generated wiki text"],
        ])
        return {"train.csv": path}

    def test_rows(self):
        with tempfile.TemporaryDirectory() as d:
            rows = rows_of("raid", self.write(d))
        self.assertEqual([r["id"] for r in rows], ["raid:h1", "raid:g1", "raid:g3"])
        self.assertEqual([r["label"] for r in rows], [0, 1, 1])
        self.assertEqual([r["generator"] for r in rows], ["human", "gpt-3.5-turbo", "mpt-30b-chat"])
        self.assertEqual([r["domain"] for r in rows], ["books", "books", "wikipedia"])
        # a generation shares the group of the human document it was prompted from
        self.assertEqual(rows[0]["group"], rows[1]["group"])
        self.assertNotEqual(rows[0]["group"], rows[2]["group"])
        self.assertEqual(rows[0]["meta"], {"attack": "none"})
        self.assertEqual(rows[2]["meta"], {"attack": "none", "decoding": "sampling", "repetition_penalty": "yes",
                                           "generator_raw": "mpt-chat"})

    def test_unknown_domain_is_an_error_even_in_an_attacked_row(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "train.csv"
            write_csv(path, RAID_HEADER, [
                ["g9", "g1", "h1", "chatgpt", "greedy", "no", "homoglyph", "newdomain", "T", "p", "text"],
            ])
            with self.assertRaises(fs.SourceError):
                rows_of("raid", {"train.csv": path})

    def test_attacks_follow_the_manifest(self):
        cfg = {**SOURCES["raid"], "attacks": ["none", "homoglyph"]}
        with tempfile.TemporaryDirectory() as d:
            rows = rows_of("raid", self.write(d), cfg)
        self.assertEqual([r["id"] for r in rows], ["raid:h1", "raid:g1", "raid:g2", "raid:g3"])
        self.assertEqual(rows[2]["group"], rows[0]["group"])


class WriteRowsTest(unittest.TestCase):
    def test_same_input_gives_same_checksum_and_counts(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "reddit_eli5.jsonl"
            path.write_text(
                json.dumps({"question": "q", "human_answers": ["word " * 50, "   "], "chatgpt_answers": ["word " * 130]}) + "\n",
                encoding="utf-8",
            )
            paths = {"reddit_eli5.jsonl": path}
            first = fs.write_rows("hc3", SOURCES["hc3"], paths, Path(d) / "a")
            second = fs.write_rows("hc3", SOURCES["hc3"], paths, Path(d) / "b")
            written = [json.loads(line) for line in (Path(d) / "a" / "rows.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertEqual(first, second)
        self.assertEqual((first["rows"], first["empty_rows"], first["excluded_rows"]), (2, 1, 0))
        self.assertEqual([c["length"] for c in first["counts"]], [">=120", "40-119"])
        self.assertEqual(len(written), 2)
        self.assertEqual(written[0]["text"], "word " * 50)  # unchanged

    def test_rows_must_match_what_the_manifest_expects(self):
        receipt = {"rows": 2, "rows_sha256": "ab" * 32}
        fs.check_expected("hc3", {"expected": dict(receipt)}, receipt)
        for wrong in ({"rows": 3, "rows_sha256": "ab" * 32}, {"rows": 2, "rows_sha256": "cd" * 32}):
            with self.assertRaises(fs.SourceError):
                fs.check_expected("hc3", {"expected": wrong}, receipt)

    def test_excluded_rows_are_counted_not_written(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "train.csv"
            write_csv(path, ["text", "label", "src"], [["A review", "1", "yelp_human"], ["A post", "1", "cmv_human"]])
            receipt = fs.write_rows("mage", SOURCES["mage"], {"train.csv": path}, Path(d) / "out")
            text = (Path(d) / "out" / "rows.jsonl").read_text(encoding="utf-8")
        self.assertEqual((receipt["rows"], receipt["excluded_rows"]), (1, 1))
        self.assertNotIn("A review", text)


if __name__ == "__main__":
    unittest.main()
