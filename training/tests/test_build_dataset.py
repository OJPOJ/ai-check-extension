"""
Tests for build_dataset.py and dataset.json: cleaning, duplicates, split and excerpts. They
use small texts written here, not the real sources.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import json
import random
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dataset"))

import build_dataset as bd  # noqa: E402
import fetch_sources as fs  # noqa: E402

CFG = bd.load_config()
def text_of(*numbers) -> str:
    """A text of six sentences per number; texts of different numbers share no word sequence."""
    out = []
    for n in numbers:
        rng = random.Random(n)
        for _ in range(6):
            words = [f"w{rng.randrange(5000)}" for _ in range(rng.randint(9, 14))]
            out.append(" ".join(words).capitalize() + ".")
    return " ".join(out)


def row(row_id, text, label=0, source="mage", sub="cmv", domain="forum", generator=None, group=None, meta=None):
    return {"id": f"{source}:{row_id}", "source": source, "sub_source": sub, "domain": domain, "label": label,
            "generator": generator or ("gpt-4" if label else "human"), "group": group or f"{source}:g{row_id}",
            "text": text, "meta": dict(meta or {}), "changes": []}


def new_stats():
    return {"read": Counter(), "changed": Counter(), "dropped": Counter(), "duplicates": Counter()}


class ConfigTest(unittest.TestCase):
    def test_sources_and_held_out_parts_exist_in_the_manifest(self):
        manifest = fs.load_manifest()
        known = manifest["sources"] | manifest["collected"]
        self.assertEqual(set(CFG["sources"]), set(known))
        domains = {s["domain"] for cfg in known.values() for s in cfg["sub_sources"].values() if s.get("use", True)}
        generators = {g for cfg in manifest["sources"].values() for g in cfg["generators"].values()}
        self.assertLessEqual(set(CFG["held_out"]["domains"]), domains)
        self.assertLessEqual(set(CFG["held_out"]["generators"]), generators)
        self.assertEqual(set(CFG["max_ai_per_group"]) - set(known), set())

    def test_excerpt_lengths_are_what_the_extension_scores(self):
        lengths = CFG["excerpt"]["lengths"]
        self.assertEqual(lengths[0][0], CFG["min_words"])
        self.assertAlmostEqual(sum(w for _, _, w in lengths), 1.0)


class NormaliseTest(unittest.TestCase):
    def test_whitespace_becomes_single_spaces(self):
        text, changes = bd.normalise("  One line.\r\n\r\nNext\tparagraph\u00a0here.\n")
        self.assertEqual(text, "One line. Next paragraph here.")
        self.assertEqual(changes, ["whitespace"])

    def test_markup_is_removed(self):
        self.assertEqual(bd.normalise("Great film.<br /><br />Loved it &amp; more.")[0], "Great film. Loved it & more.")
        self.assertEqual(bd.normalise("## Title\n\n- **First** point\n* second\n> quoted")[0],
                         "Title First point second quoted")
        self.assertEqual(bd.normalise("if a<b and c>d then")[0], "if a<b and c>d then")

    def test_quotes_and_invisible_characters(self):
        self.assertEqual(bd.normalise("\ufeff\u201cIt\u2019s fine,\u201d she said\u200b.")[0], '"It\'s fine," she said.')
        self.assertEqual(bd.normalise("a dash \u2014 stays")[0], "a dash \u2014 stays")

    def test_tokeniser_spacing_is_repaired(self):
        self.assertEqual(bd.normalise("I do n't know , it 's odd ( really ) .")[0], "I don't know, it's odd (really).")
        self.assertEqual(bd.normalise("wait ... what")[0], "wait ... what")

    def test_names_with_underscores_are_not_markup(self):
        self.assertEqual(bd.normalise("call __init__ and **kwargs** here")[0], "call __init__ and kwargs here")

    def test_repeated_markers_at_a_line_start(self):
        once = bd.normalise("* * Disclaimer: this\n# # Title\n> > quoted")[0]
        self.assertEqual(once, "Disclaimer: this Title quoted")
        self.assertEqual(bd.normalise(once), (once, []))

    def test_normalising_twice_changes_nothing(self):
        once = bd.normalise("  \u201cA\u201d<br>**b** , c\n\n# d ")[0]
        self.assertEqual(bd.normalise(once), (once, []))


class CleanTest(unittest.TestCase):
    def test_no_step_looks_at_the_label(self):
        raw = "A  first sentence , with\nartefacts. And a second one that makes it long enough to keep, I hope"
        human = bd.clean(row(1, raw, label=0), CFG)
        ai = bd.clean(row(1, raw, label=1), CFG)
        self.assertEqual(human, ai)

    def test_tokenised_text_is_dropped(self):
        tokenised = "I do n't know why , but it 's the best - selling book ( so far ) of the year , they say ."
        self.assertEqual(bd.clean(row(1, tokenised), CFG)[2], "tokenised")
        self.assertGreaterEqual(bd.tokenisation_marks(tokenised), 5)
        self.assertEqual(bd.tokenisation_marks(text_of(1)), 0)

    def test_single_slips_are_repaired_not_dropped(self):
        slips = text_of(1, 2).replace(".", " .", 2)
        self.assertEqual(bd.clean(row(1, slips), CFG), (text_of(1, 2), ["detokenise"], None))
        self.assertEqual(bd.clean(row(1, "A well - known case. " + text_of(1)), CFG)[2], None)

    def test_dateline_is_cut_for_wikinews_only(self):
        raw = "Tuesday, May 23, 2006 " + text_of(1)
        news = row(1, raw, source="wikimedia", sub="wikinews", domain="news")
        text, changes, reason = bd.clean(news, CFG)
        self.assertEqual((text, changes, reason), (text_of(1), ["dateline"], None))
        self.assertEqual(bd.clean(row(1, raw), CFG)[0], raw)

    def test_moderator_footnote_is_cut_in_both_classes(self):
        footnote = (" Hello, users of CMV! This is a footnote from your moderators. We'd just like to remind you of a "
                    "couple of things. Any questions or concerns? Feel free to [message us] . Happy CMVing!")
        for label in (0, 1):
            text, changes, _ = bd.clean(row(1, text_of(1) + footnote, label=label), CFG)
            self.assertEqual((text, changes), (text_of(1), ["moderator_footnote"]))

    def test_text_of_the_chatgpt_page_is_cut(self):
        page = ("\u200b\r\n\r\n\u00b7\u00b7\u00b7\r\nChatGPT Dec 15 Version. Free Research Preview. Our goal is to make AI "
                "systems more natural.\r\nNew chat\r\nWhat Is Absolute Zero?")
        text, changes, _ = bd.clean(row(1, text_of(1) + page, label=1), CFG)
        self.assertEqual((text, changes), (text_of(1), ["chatgpt_page"]))
        text, changes, _ = bd.clean(row(1, text_of(1) + "\n\n\nRegenerate response", label=1), CFG)
        self.assertEqual((text, changes), (text_of(1), ["chatgpt_page"]))

    def test_repeated_prompt_is_cut(self):
        echo = ' The following is the full text of the abstract for a research paper titled "X: a study" from arxiv.org: '
        text, changes, _ = bd.clean(row(1, text_of(1) + echo + text_of(2), label=1), CFG)
        self.assertEqual((text, changes), (text_of(1), ["prompt_echo"]))
        text, changes, _ = bd.clean(row(1, echo.strip() + " " + text_of(2), label=1), CFG)
        self.assertEqual((text, changes[0]), (text_of(2), "prompt_echo"))

    def test_continuation_loses_the_human_opening(self):
        human = text_of(1).split()
        opening = " ".join(human[:30])
        ai = row(2, opening + " rest of this sentence. " + text_of(7), label=1, meta={"prompt_type": "continuation"})
        text, changes, reason = bd.clean(ai, CFG, human)
        self.assertIsNone(reason)
        self.assertEqual(text, text_of(7))
        self.assertIn("shared_opening", changes)

    def test_continuation_after_a_complete_opening_is_kept_from_its_first_word(self):
        human = (" ".join(f"w{i}" for i in range(29)) + " end. More human text follows here.").split()
        ai = row(2, " ".join(human[:30]) + " " + text_of(7), label=1, meta={"prompt_type": "continuation"})
        self.assertEqual(bd.clean(ai, CFG, human)[0], text_of(7))

    def test_continuation_without_known_human_text_loses_30_words(self):
        ai = row(2, " ".join(f"w{i}" for i in range(30)) + " tail. " + text_of(7), label=1, meta={"prompt_type": "continuation"})
        self.assertEqual(bd.clean(ai, CFG)[0], text_of(7))

    def test_continuation_without_a_further_sentence_is_dropped(self):
        ai = row(2, " ".join(f"w{i}" for i in range(60)), label=1, meta={"prompt_type": "continuation"})
        self.assertEqual(bd.clean(ai, CFG)[2], "no_sentence_after_opening")

    def test_incomplete_last_sentence_is_cut(self):
        text, changes, _ = bd.clean(row(1, text_of(1) + " And then the generation stopped in the mid"), CFG)
        self.assertEqual(text, text_of(1))
        self.assertEqual(changes, ["incomplete_end"])

    def test_text_without_sentence_ends_is_kept(self):
        poem = " ".join(f"line{i}" for i in range(40))
        self.assertEqual(bd.clean(row(1, poem), CFG), (poem, [], None))

    def test_short_text_is_dropped(self):
        self.assertEqual(bd.clean(row(1, "Too short to be of any use."), CFG)[2], "short")

    def test_eli5_of_hc3_is_left_out_on_both_sides(self):
        for label in (0, 1):
            self.assertTrue(bd.is_dropped(row(1, "t", source="hc3", sub="reddit_eli5", label=label), CFG["drop"]))
        self.assertFalse(bd.is_dropped(row(1, "t", source="hc3", sub="wiki_csai"), CFG["drop"]))
        self.assertFalse(bd.is_dropped(row(1, "t", source="mage", sub="eli5"), CFG["drop"]))

    def test_configured_drop(self):
        rules = [{"source": "hc3", "sub_source": "reddit_eli5", "label": 0, "reason": "x"}]
        self.assertTrue(bd.is_dropped(row(1, "t", source="hc3", sub="reddit_eli5"), rules))
        self.assertFalse(bd.is_dropped(row(1, "t", source="hc3", sub="reddit_eli5", label=1), rules))


class SelectTest(unittest.TestCase):
    GENERATIONS = [(f"raid:{g}:{i}", f"raid:{g}", f"model{i % 6}") for g in range(20) for i in range(34)]

    def test_k_generations_per_group_from_different_generators(self):
        kept = bd.select_generations(self.GENERATIONS, 4, seed=1)
        by_group = Counter(i.rsplit(":", 1)[0] for i in kept)
        self.assertEqual(set(by_group.values()), {4})
        generator = {i: g for i, _, g in self.GENERATIONS}
        for group in by_group:
            self.assertEqual(len({generator[i] for i in kept if i.rsplit(":", 1)[0] == group}), 4)

    def test_selection_depends_on_the_seed_only(self):
        self.assertEqual(bd.select_generations(self.GENERATIONS, 4, 1), bd.select_generations(self.GENERATIONS[::-1], 4, 1))
        self.assertNotEqual(bd.select_generations(self.GENERATIONS, 4, 1), bd.select_generations(self.GENERATIONS, 4, 2))

    def test_held_out_generators_are_kept_whole(self):
        kept = bd.select_generations(self.GENERATIONS, 4, 1, always=["model0"])
        generator = {i: g for i, _, g in self.GENERATIONS}
        by_generator = Counter(generator[i] for i in kept)
        self.assertEqual(by_generator["model0"], sum(1 for g in generator.values() if g == "model0"))
        self.assertEqual(sum(by_generator.values()) - by_generator["model0"], 20 * 4)

    def test_small_groups_are_kept_whole(self):
        self.assertEqual(len(bd.select_generations([("a", "g", "m"), ("b", "g", "m")], 4, 1)), 2)


class DuplicateTest(unittest.TestCase):
    def run_rows(self, rows, suite=()):
        stats = new_stats()
        kept, related = bd.remove_duplicates(rows, list(suite), CFG, stats)
        return kept, related, stats

    def test_exact_duplicate_keeps_the_first_and_merges_groups(self):
        rows = [row(1, text_of(1, 2)), row(2, text_of(1, 2).upper(), source="hc3"), row(3, text_of(5, 6)),
                row(4, text_of(8), source="hc3", group="hc3:g2")]
        kept, _, stats = self.run_rows(rows)
        self.assertEqual([r["id"] for r in kept], ["mage:1", "mage:3", "hc3:4"])
        self.assertEqual(stats["dropped"][("duplicate", "hc3", "cmv", 0)], 1)
        self.assertEqual(kept[2]["group"], kept[0]["group"])  # the group of the dropped duplicate went along
        self.assertEqual(kept[0]["meta"]["source_group"], "mage:g1")

    def test_excerpt_is_a_duplicate_of_its_document(self):
        long = text_of(*range(1, 13))
        rows = [row(1, long), row(2, text_of(*range(4, 9)), source="raid"), row(3, text_of(*range(20, 30)))]
        kept, _, _ = self.run_rows(rows)
        self.assertEqual([r["id"] for r in kept], ["mage:1", "mage:3"])

    def test_short_duplicate_is_found(self):
        short = "One short remark of sixteen words that somebody posted twice, once here and once over there."
        rows = [row(1, short), row(2, short.replace("remark", "comment"), source="raid"), row(3, text_of(3))]
        kept, _, _ = self.run_rows(rows)
        self.assertEqual([r["id"] for r in kept], ["mage:1", "mage:3"])

    def test_same_text_with_both_labels_is_dropped(self):
        rows = [row(1, text_of(*range(1, 9))), row(2, text_of(*range(1, 9)), label=1), row(3, text_of(*range(20, 28)))]
        kept, _, stats = self.run_rows(rows)
        self.assertEqual([r["id"] for r in kept], ["mage:3"])
        self.assertEqual(sum(n for k, n in stats["dropped"].items() if k[0] == "label_conflict"), 2)

    def test_related_texts_keep_their_groups_and_are_reported_as_a_pair(self):
        a = text_of(*range(1, 11))
        b = text_of(*range(6, 16))  # half of it is in a
        rows = [row(1, a), row(2, b, source="raid"), row(3, text_of(*range(40, 50)))]
        kept, related, _ = self.run_rows(rows)
        self.assertEqual(len(kept), 3)
        self.assertEqual(len({r["group"] for r in kept}), 3)
        self.assertEqual(related, [("mage:1", "raid:2")])

    def test_related_texts_do_not_chain_groups(self):
        # a ~ b and b ~ c, but a and c have nothing in common
        rows = [row(1, text_of(*range(1, 11))), row(2, text_of(*range(6, 16))), row(3, text_of(*range(11, 21)))]
        kept, related, _ = self.run_rows(rows)
        self.assertEqual(len({r["group"] for r in kept}), 3)
        self.assertEqual(related, [("mage:1", "mage:2"), ("mage:2", "mage:3")])

    def test_texts_of_the_eval_suite_are_removed(self):
        rows = [row(1, text_of(*range(1, 13))), row(2, text_of(*range(20, 30))), row(3, text_of(70))]
        kept, _, stats = self.run_rows(rows, suite=[text_of(*range(3, 8)), text_of(*range(60, 65)), text_of(70)[:-1]])
        self.assertEqual([r["id"] for r in kept], ["mage:2"])
        self.assertEqual(stats["duplicates"]["suite_texts_found"], 2)

    def test_stock_phrases_do_not_relate_texts(self):
        phrase = " It is important to note that this is only one of many reasons."
        rows = [row(i, text_of(i) + phrase) for i in range(1, 31)]
        kept, related, stats = self.run_rows(rows)
        self.assertEqual((len(kept), related), (30, []))
        self.assertGreater(stats["duplicates"]["stock_shingles_ignored"], 0)

    def test_unrelated_texts_are_untouched(self):
        rows = [row(i, text_of(*range(10 * i, 10 * i + 8))) for i in range(1, 6)]
        kept, related, stats = self.run_rows(rows)
        self.assertEqual((len(kept), related), (5, []))
        self.assertFalse(stats["dropped"])
        self.assertEqual(len({r["group"] for r in kept}), 5)


class SplitTest(unittest.TestCase):
    def rows(self, n=3000):
        rows = [row(i, "t", label=i % 2, group=f"mage:g{i // 3}") for i in range(n)]
        rows += [row(10000 + i, "t", source="raid", sub="reviews", domain="reviews") for i in range(10)]
        rows += [row(20000 + i, "t", group="mage:ood:cnn", domain="news") for i in range(10)]
        return rows

    def test_shares_of_the_groups(self):
        split_of = bd.split_groups(self.rows(), CFG)
        sides = Counter(side for group, side in split_of.items() if group.startswith("mage:g"))
        self.assertAlmostEqual(sides["test"] / 1000, CFG["split"]["test"], delta=0.03)
        self.assertAlmostEqual(sides["validation"] / 1000, CFG["split"]["validation"], delta=0.03)

    def test_held_out_domain_and_testbeds_are_in_test_only(self):
        rows = self.rows()
        split_of = bd.split_groups(rows, CFG)
        for r in rows:
            if r["domain"] == "reviews" or r["group"].startswith("mage:ood:"):
                self.assertEqual(split_of[r["group"]], "test", r["id"])

    def test_split_is_the_same_in_any_order(self):
        rows = self.rows()
        self.assertEqual(bd.split_groups(rows, CFG), bd.split_groups(rows[::-1], CFG))

    def test_a_group_keeps_its_side_when_data_is_added(self):
        before = bd.split_groups(self.rows(3000), CFG)
        more = self.rows(6000) + [row(i, "t", source="arxiv", sub="cs") for i in range(500)]
        after = bd.split_groups(more, CFG)
        self.assertEqual({g: after[g] for g in before}, before)

    def test_a_merge_moves_a_group_towards_test_never_out_of_it(self):
        rows = self.rows()
        before = bd.split_groups(rows, CFG)
        test_group = next(g for g, side in before.items() if side == "test" and g.startswith("mage:g"))
        train_group = next(g for g, side in before.items() if side == "train")
        merged = min(test_group, train_group)
        for r in rows:
            if r["group"] in (test_group, train_group):
                r["meta"]["source_group"], r["group"] = r["group"], merged
        self.assertEqual(bd.split_groups(rows, CFG)[merged], "test")

    def test_of_two_related_texts_on_different_sides_the_one_further_from_test_goes(self):
        rows = [row(1, "t", group="a"), row(2, "t", group="b"), row(3, "t", group="c"), row(4, "t", group="c")]
        split_of = {"a": "train", "b": "test", "c": "validation"}
        drop = bd.separate_related(rows, split_of, [("mage:1", "mage:2"), ("mage:3", "mage:2"), ("mage:3", "mage:4")])
        self.assertEqual(drop, {"mage:1": "related_to_other_split", "mage:3": "related_to_other_split"})

    def test_views(self):
        held = CFG["held_out"]
        self.assertEqual(bd.view_of(row(1, "t", domain="reviews"), held), "held_out_domain")
        self.assertEqual(bd.view_of(row(1, "t", group="mage:ood:cnn"), held), "testbed")
        self.assertEqual(bd.view_of(row(1, "t", label=1, generator="cohere-command"), held), "held_out_generator")
        self.assertEqual(bd.view_of(row(1, "t"), held), "main")
        merged = row(1, "t", group="hc3:x", meta={"source_group": "mage:ood:cnn"})
        self.assertEqual(bd.view_of(merged, held), "testbed")


class ExcerptTest(unittest.TestCase):
    def test_excerpts_are_whole_sentences_within_the_limits(self):
        text = text_of(*range(1, 40))
        starts = {0} | {m.end() for m in bd.BOUNDARY.finditer(text)}
        lengths = Counter()
        for i in range(300):
            start, end = bd.excerpt(text, random.Random(i), CFG)
            piece = text[start:end]
            self.assertIn(start, starts)
            self.assertTrue(piece.endswith("."), piece[-30:])
            self.assertLessEqual(len(piece), CFG["excerpt"]["max_chars"])
            self.assertGreaterEqual(len(piece.split()), CFG["min_words"])
            lengths[fs.length_group(piece)] += 1
        self.assertEqual(set(lengths), {"15-39", "40-119", ">=120"})
        self.assertGreater(lengths["15-39"], 60)

    def test_no_excerpt_is_shorter_than_the_minimum(self):
        # a short sentence before one that is longer than every limit
        text = "Just six words in this one. " + " ".join(f"word{i}" for i in range(3000)) + ". " + text_of(1)
        for i in range(200):
            start, end = bd.excerpt(text, random.Random(i), CFG)
            self.assertGreaterEqual(len(text[start:end].split()), CFG["min_words"])
            self.assertLessEqual(end - start, CFG["excerpt"]["max_chars"])

    def test_short_text_is_taken_whole(self):
        text = "Only one short sentence that has exactly sixteen words in it, as far as I can count."
        self.assertEqual(bd.excerpt(text, random.Random(1), CFG), (0, len(text)))

    def test_one_endless_sentence_is_cut_at_a_word(self):
        text = " ".join(f"word{i}" for i in range(3000))
        for i in range(20):
            start, end = bd.excerpt(text, random.Random(i), CFG)
            self.assertLessEqual(end - start, CFG["excerpt"]["max_chars"])
            self.assertIn(text[end:end + 1], (" ", ""))

    def test_same_seed_same_excerpt(self):
        text = text_of(*range(1, 20))
        self.assertEqual(bd.excerpt(text, random.Random(7), CFG), bd.excerpt(text, random.Random(7), CFG))


class BuildTest(unittest.TestCase):
    def write_sources(self, data_dir: Path):
        n = 0
        for source in CFG["sources"]:
            d = data_dir / "sources" / source
            d.mkdir(parents=True)
            rows = []
            for i in range(60):
                n += 1
                group = f"{source}:g{i // 2}"
                rows.append(row(i, text_of(*range(100 * n, 100 * n + 4)) + "\n\nA last  paragraph.", label=i % 2, source=source,
                                sub="s", domain="forum", group=group,
                                generator="cohere-command" if i % 6 == 1 else None))
            for r in rows:
                del r["changes"]
            (d / "rows.jsonl").write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
        (data_dir / "eval_suite.jsonl").write_text(json.dumps({"text": text_of(100, 101, 102, 103)}) + "\n", encoding="utf-8")

    def test_build_writes_a_reproducible_dataset(self):
        with tempfile.TemporaryDirectory() as d:
            data_dir = Path(d) / "data"
            self.write_sources(data_dir)
            out_dir = data_dir / "dataset" / "x"
            first = bd.build(CFG, data_dir, out_dir)
            rows = {s: [json.loads(line) for line in (out_dir / f"{s}.jsonl").read_text(encoding="utf-8").splitlines()]
                    for s in bd.SPLITS}
            test_ids = (out_dir / "test_ids.txt").read_text(encoding="utf-8").split()
            second = bd.build(CFG, data_dir, data_dir / "dataset" / "y")
        self.assertEqual(first["sha256"], second["sha256"])
        self.assertEqual(first["duplicates"]["suite_texts_found"], 1)
        self.assertEqual(test_ids, [r["id"] for r in rows["test"]])
        groups = {s: {r["group"] for r in items} for s, items in rows.items()}
        self.assertFalse(groups["train"] & groups["test"] or groups["train"] & groups["validation"]
                         or groups["validation"] & groups["test"])
        self.assertTrue(all(rows[s] for s in bd.SPLITS))
        for split, items in rows.items():
            for r in items:
                self.assertEqual(r["split"], split)
                self.assertNotIn("\n", r["text"])
                self.assertIn("whitespace", r["changes"])
                start, end = r["excerpt"]
                self.assertGreaterEqual(len(r["text"][start:end].split()), CFG["min_words"])
                if r["generator"] == "cohere-command":
                    self.assertEqual((split, r["view"]), ("test", "held_out_generator"))

    def test_inputs_are_hashed_themselves(self):
        with tempfile.TemporaryDirectory() as d:
            data_dir = Path(d) / "data"
            self.write_sources(data_dir)
            before = bd.input_checksum(data_dir, "mage")
            with (data_dir / "sources" / "mage" / "rows.jsonl").open("a", encoding="utf-8") as f:
                f.write("\n")
            self.assertNotEqual(bd.input_checksum(data_dir, "mage"), before)

    def test_frozen_test_rows_must_not_become_training_data(self):
        with tempfile.TemporaryDirectory() as d:
            out_dir = Path(d)
            (out_dir / "train.jsonl").write_text('{"id": "a"}\n{"id": "b"}\n', encoding="utf-8")
            (out_dir / "validation.jsonl").write_text('{"id": "c"}\n', encoding="utf-8")
            (out_dir / "test_ids.txt").write_text("d\ne\n", encoding="utf-8")
            manifest = out_dir / "manifest.txt"
            self.assertEqual(bd.check_frozen(manifest, out_dir), 0)  # nothing frozen yet
            manifest.write_text("d\ne\nf\n", encoding="utf-8")
            self.assertEqual(bd.check_frozen(manifest, out_dir), 1)  # f is gone, that is allowed
            manifest.write_text("d\nb\n", encoding="utf-8")
            with self.assertRaises(bd.DatasetError):
                bd.check_frozen(manifest, out_dir)

    def test_result_must_match_what_the_config_expects(self):
        report = {"inputs": {"a": "1"}, "rows": {"train": 1}, "sha256": {"train": "ab"}}
        bd.check_expected({"expected": json.loads(json.dumps(report))}, report)
        for cfg in ({"expected": report | {"rows": {"train": 2}}}, {}):
            with self.assertRaises(bd.DatasetError):
                bd.check_expected(cfg, report)

    def test_missing_source_is_an_error(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(bd.DatasetError):
                bd.build(CFG, Path(d) / "data", Path(d) / "out")


if __name__ == "__main__":
    unittest.main()
