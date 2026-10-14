"""
Tests for dataset/generate.py (work package 10 of issue #46): prompts and the cleaning of what
the generators return. No model and no API is called.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "dataset"))

import build_dataset  # noqa: E402
import generate  # noqa: E402

CFG = generate.load_config()
DATASET = build_dataset.load_config()
TEXT = "The bridge was built in 1932. It carried trains for forty years. " * 20


def row(i, source="wikimedia", domain="wikipedia"):
    return {"id": f"{source}:x:{i}", "source": source, "sub_source": "x", "domain": domain, "label": 0,
            "group": f"{source}:x:{i}", "text": TEXT, "meta": {"title": f"Bridge {i}"}}


class PromptTest(unittest.TestCase):
    def test_a_prompt_depends_on_its_text_only(self):
        a = generate.make_prompt(row(1), CFG, DATASET, {})
        self.assertEqual(a, generate.make_prompt(row(1), CFG, DATASET, {}))
        self.assertEqual(a["group"], "wikimedia:x:1")
        self.assertIn(a["task"], CFG["tasks"])

    def test_held_out_generators_only_write_for_the_test_part(self):
        held = {g["name"] for g in CFG["generators"] if g.get("held_out")}
        prompts = [generate.make_prompt(row(i), CFG, DATASET, {}) for i in range(3000)]
        used = [p for p in prompts if p["generator"] in held]
        self.assertTrue(used)
        self.assertTrue(all(build_dataset.side_of(p["group"], DATASET) == "test" for p in used))

    def test_an_answer_without_its_question_gets_no_write_prompt(self):
        r = {**row(1, "stackexchange", "qa"), "group": "stackexchange:cooking:5", "meta": {}}
        tasks = {generate.make_prompt({**r, "id": f"stackexchange:cooking:{i}"}, CFG, DATASET, {})["task"] for i in range(200)}
        self.assertNotIn("write", tasks)
        with_title = generate.make_prompt(r, CFG, DATASET, {("cooking", 5): "Why salt pasta water?"})
        self.assertTrue(with_title["task"] != "write" or "Why salt pasta water?" in with_title["user"])

    def test_target_length_is_clipped_and_rounded(self):
        self.assertEqual(generate.target_words("word " * 5, CFG), CFG["words"][0])
        self.assertEqual(generate.target_words("word " * 1000, CFG), CFG["words"][1])
        self.assertEqual(generate.target_words("word " * 123, CFG), 120)


class CleanTest(unittest.TestCase):
    PROMPT = {"task": "write", "given": None}

    def test_what_an_assistant_puts_around_the_text_is_removed(self):
        text, reason = generate.clean_output(
            "Sure! Here is the article.\n\nThe Bridge\nThe bridge was built in 1932.\n\nLet me know if you want changes.", self.PROMPT)
        self.assertIsNone(reason)
        self.assertEqual(text, "The bridge was built in 1932.")

    def test_refusals_and_empty_answers_are_dropped(self):
        self.assertEqual(generate.clean_output("I'm sorry, but I can't help with that.", self.PROMPT)[1], "refusal")
        self.assertEqual(generate.clean_output("  ", self.PROMPT)[1], "empty")

    def test_a_continuation_that_repeats_the_opening_keeps_only_what_is_new(self):
        given = "The bridge was built in 1932."
        text, _ = generate.clean_output(given + " It carried trains.", {"task": "continue", "given": given})
        self.assertEqual(text, "It carried trains.")

    def test_a_first_sentence_is_not_taken_for_a_title(self):
        text, _ = generate.clean_output("It rained.\nThen it stopped.", self.PROMPT)
        self.assertEqual(text, "It rained.\nThen it stopped.")


if __name__ == "__main__":
    unittest.main()
