"""
Tests for evaluation/evaluate_test_part.py: threshold, measures and the tables built from them.
They use scores written here, no model and no real data.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "evaluation"))

import evaluate_test_part as ev  # noqa: E402

CFG = {"version": "v1", "excerpt": {"lengths": [[15, 39, 0.3], [40, 119, 0.4], [120, 330, 0.3]]}}


def row(i, label, logit, view="main", words=50, generator=None, domain="news", source="mage"):
    return {"id": f"r{i}", "label": label, "view": view, "words": words, "length": ev.length_group(words, ev.length_groups(CFG)),
            "generator": generator or ("gpt-4" if label else "human"), "domain": domain, "source": source, "logit": logit}


class ThresholdTest(unittest.TestCase):
    def test_at_most_the_target_share_of_human_values_reaches_it(self):
        human = list(range(1000))
        t = ev.threshold_for(human, 0.01)
        self.assertEqual(sum(v >= t for v in human), 10)

    def test_ties_at_the_threshold_are_not_flagged(self):
        human = [0.0] * 900 + [5.0] * 100  # 10% share one value: flagging it would be 10% false alarms
        t = ev.threshold_for(human, 0.01)
        self.assertGreater(t, 5.0)
        self.assertEqual(sum(v >= t for v in human), 0)

    def test_too_few_human_values_flag_nothing(self):
        self.assertEqual(ev.threshold_for(list(range(99)), 0.01), math.inf)


class MeasuresTest(unittest.TestCase):
    def test_auroc(self):
        self.assertEqual(ev.auroc([0, 0, 1, 1], [1, 2, 3, 4]), 1.0)
        self.assertEqual(ev.auroc([1, 1, 0, 0], [1, 2, 3, 4]), 0.0)
        self.assertEqual(ev.auroc([0, 1], [3, 3]), 0.5)
        self.assertEqual(ev.auroc([0, 1, 1], [2, 1, 3]), 0.5)
        self.assertTrue(math.isnan(ev.auroc([1, 1], [1, 2])))

    def test_f1_false_alarms_and_detection(self):
        rows = [dict(row(i, 1, 0), flag=i < 6) for i in range(8)] + [dict(row(10 + i, 0, 0), flag=i < 1) for i in range(4)]
        m = ev.measures(rows)
        self.assertEqual((m["human"], m["ai"]), (4, 8))
        self.assertAlmostEqual(m["detected"], 0.75)
        self.assertAlmostEqual(m["fa"], 0.25)
        self.assertAlmostEqual(m["f1"], 2 * 6 / (2 * 6 + 1 + 2))

    def test_group_without_human_rows_borrows_them_for_auroc_and_f1_only(self):
        ai = [dict(row(i, 1, 2.0), flag=True) for i in range(4)]
        humans = [dict(row(10 + i, 0, 1.0), flag=False) for i in range(4)]
        m = ev.measures(ai, humans)
        self.assertEqual(m["human"], 0)
        self.assertTrue(math.isnan(m["fa"]))
        self.assertEqual((m["auroc"], m["f1"], m["detected"]), (1.0, 1.0, 1.0))

    def test_log_odds_is_the_same_for_one_logit_and_for_two_classes(self):
        import torch

        self.assertAlmostEqual(ev.log_odds(torch.tensor([[1.5]]), 0).item(), 1.5)
        self.assertAlmostEqual(ev.log_odds(torch.tensor([[0.5, 2.0]]), 1).item(), 1.5)
        self.assertAlmostEqual(ev.log_odds(torch.tensor([[0.5, 2.0]]), 0).item(), -1.5)
        p = torch.softmax(torch.tensor([0.1, 0.7, -0.3]), -1)[1].item()
        self.assertAlmostEqual(ev.log_odds(torch.tensor([[0.1, 0.7, -0.3]]), 1).item(), math.log(p / (1 - p)), places=6)


class EvaluateTest(unittest.TestCase):
    def setUp(self):
        # per length group 200 human rows with logits 0..199 and 100 AI rows at 198.5: the threshold
        # for 1% is 198, so every AI row is detected and two human rows are false alarms
        self.rows, n = [], 0
        for words in (20, 60, 200):
            for i in range(200):
                self.rows.append(row(n := n + 1, 0, float(i), words=words))
            for i in range(100):
                self.rows.append(row(n := n + 1, 1, 198.5, words=words))
        self.rows.append(row(n := n + 1, 1, 500.0, view="held_out_generator", generator="cohere-command"))
        self.rows.append(row(n := n + 1, 1, 100.0, view="held_out_generator", generator="cohere-command"))
        self.logits = {r["id"]: r["logit"] for r in self.rows}

    def test_thresholds_come_from_main_per_length_group_and_apply_everywhere(self):
        out = ev.evaluate(self.rows, self.logits, "tmr", CFG)
        self.assertEqual({g: t["logit"] for g, t in out["thresholds"].items()}, {"15-39": 198.0, "40-119": 198.0, "120-330": 198.0})
        self.assertAlmostEqual(out["view"]["main"]["fa"], 0.01)
        self.assertEqual(out["view"]["main"]["detected"], 1.0)
        held = out["view"]["held_out_generator"]
        self.assertEqual((held["human"], held["ai"], held["detected"]), (0, 2, 0.5))
        self.assertEqual(out["generator"]["cohere-command"]["ai"], 2)
        self.assertEqual(set(out["length"]), {"15-39", "40-119", "120-330"})

    def test_given_thresholds_are_used_unchanged(self):
        thresholds = {"15-39": 1000.0, "40-119": 1000.0, "120-330": 1000.0}
        out = ev.evaluate(self.rows, self.logits, "tmr", CFG, thresholds)
        self.assertEqual(out["view"]["main"]["detected"], 0.0)
        self.assertEqual(out["view"]["main"]["f1"], 0.0)

    def test_shipped_thresholds_never_turn_short_texts_red_without_short_threshold(self):
        out = ev.evaluate(self.rows, self.logits, "tmr", CFG)  # TMR has no shortRedFrom
        self.assertEqual(out["shipped"]["short"]["detected"], 0.0)
        self.assertEqual(out["shipped"]["long"]["detected"], 1.0)

    def test_length_group_of_texts_outside_the_excerpt_range(self):
        groups = ev.length_groups(CFG)
        self.assertEqual([ev.length_group(w, groups) for w in (5, 39, 40, 330, 420)], ["15-39", "15-39", "40-119", "120-330", "120-330"])


if __name__ == "__main__":
    unittest.main()
