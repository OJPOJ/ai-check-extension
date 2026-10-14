"""
Tests for model/train.py (work package 7 of issue #46). They train a tiny encoder with random
weights on made-up texts, on the CPU and without any download.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import json
import random
import sys
import tempfile
import unittest
import zlib
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "model"))

import staged  # noqa: E402
import train  # noqa: E402
from test_staged_model import VOCAB, encoder  # noqa: E402

CFG = train.load_config()
SETTINGS = {**train.DEFAULTS, "epochs": 2, "batch": 8, "lr": 2e-3, "head_lr": 5e-3, "max_tokens": 64, "seed": 1}
# The classes differ in their words only: something a few steps can learn.
WORDS = {0: "river stone walked quiet morning bread window garden letter harbour".split(),
         1: "moreover crucial landscape delve tapestry furthermore realm vital robust seamless".split()}
SHARED = "the a of and to in was it that with".split()


def rows(n, seed=0):
    rng = random.Random(seed)
    out = []
    for i in range(n):
        label = i % 3 != 0  # two AI texts per human one
        sentences = []
        for _ in range(rng.randint(2, 6)):
            words = [rng.choice(WORDS[label] if rng.random() < 0.5 else SHARED) for _ in range(rng.randint(8, 14))]
            sentences.append(" ".join(words).capitalize() + ".")
        text = " ".join(sentences)
        out.append({"id": f"t:{seed}:{i}", "label": int(label), "view": "main", "text": text, "scored": text})
    return out


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()]


def tokenise(texts):
    """Words to ids by hash, padded with 0 to the longest text."""
    ids = [[1] + [3 + zlib.crc32(w.encode()) % (VOCAB - 3) for w in t.lower().replace(".", "").split()][:62] for t in texts]
    width = max(map(len, ids))
    mask = torch.tensor([[1] * len(i) + [0] * (width - len(i)) for i in ids])
    return torch.tensor([i + [0] * (width - len(i)) for i in ids]), mask


def model(seed=0, **options):
    torch.manual_seed(seed)
    return staged.StagedClassifier(encoder("modernbert"), **(options or {"reduce_after": 2}))


class DataTest(unittest.TestCase):
    def test_an_epoch_has_every_text_once_and_is_the_same_on_every_call(self):
        data = rows(1000)
        settings = {**SETTINGS, "batch": 4}  # five stretches of 50 batches
        first = list(train.epoch_batches(data, 0, settings, CFG))
        self.assertEqual(first, list(train.epoch_batches(data, 0, settings, CFG)))
        self.assertEqual(len(first), 250)
        self.assertEqual(sum(len(b) for b in first), 1000)
        self.assertEqual(sum(label for b in first for label, _ in b), sum(r["label"] for r in data))
        self.assertNotEqual(first, list(train.epoch_batches(data, 1, settings, CFG)))

    def test_an_excerpt_is_a_piece_of_its_text_and_changes_with_the_epoch(self):
        data = rows(40)
        texts = {r["text"] for r in data}
        drawn = [[text for b in train.epoch_batches(data, epoch, SETTINGS, CFG) for _, text in b] for epoch in (0, 1)]
        for text in drawn[0]:
            self.assertTrue(any(text in whole for whole in texts))
        self.assertNotEqual(sorted(drawn[0]), sorted(drawn[1]))

    def test_an_interrupted_epoch_continues_with_the_batches_that_were_left(self):
        data = rows(1000)
        settings = {**SETTINGS, "batch": 4}
        whole = list(train.epoch_batches(data, 0, settings, CFG))
        for skip in (0, 1, 49, 50, 51, 120, 249, 250):
            self.assertEqual(list(train.epoch_batches(data, 0, settings, CFG, skip=skip)), whole[skip:], skip)

    def test_batches_hold_texts_of_similar_length(self):
        batches = list(train.epoch_batches(rows(400), 0, SETTINGS, CFG))
        spread = np.mean([max(len(t) for _, t in b) - min(len(t) for _, t in b) for b in batches])
        lengths = [len(t) for b in batches for _, t in b]
        self.assertLess(spread, (max(lengths) - min(lengths)) / 4)

    def test_both_classes_weigh_the_same_in_total(self):
        data = rows(90)
        weight = train.class_weights(data)
        ai = sum(r["label"] for r in data)
        self.assertAlmostEqual(weight[1] * ai, weight[0] * (len(data) - ai))
        self.assertAlmostEqual(weight[1] * ai + weight[0] * (len(data) - ai), len(data))

    def test_files_other_than_those_of_the_dataset_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "train.jsonl").write_text("{}\n", encoding="utf-8")
            with self.assertRaises(SystemExit):
                train.check_dataset(Path(tmp), CFG, splits=("train",))


class ModelTest(unittest.TestCase):
    def test_levers_of_the_candidates(self):
        self.assertEqual(train.levers("ettin-68m", 19), {"exits": [6, 13, 19], "reduce_after": 6, "ngram": None})
        self.assertEqual(train.levers("ettin-150m-tr-early", 22), {"exits": [7, 15, 22], "reduce_after": (1, 7), "ngram": None})
        ngram = train.levers("ettin-32m-ngram", 10)
        self.assertEqual((ngram["exits"], ngram["reduce_after"]), ([0, 3, 7, 10], 3))
        self.assertIsNotNone(ngram["ngram"])

    def test_loss_per_exit_is_the_weighted_cross_entropy(self):
        logits = torch.tensor([[0.0, 2.0], [0.0, -3.0]])
        losses = train.exit_losses(logits, torch.tensor([1, 0]), torch.tensor([1.0, 3.0]))
        expected = (torch.nn.functional.softplus(torch.tensor(-2.0)) + 3 * torch.nn.functional.softplus(torch.tensor(-3.0))) / 2
        self.assertAlmostEqual(losses[0].item(), 2 * np.log(2), places=5)
        self.assertAlmostEqual(losses[1].item(), expected.item(), places=5)

    def test_learning_rates_by_part_and_over_time(self):
        m = model(exits=[0, 2, 4, 6], reduce_after=2, ngram=(50, 8))
        optim = train.optimiser(m, SETTINGS)
        rate = {id(p): g["lr"] for g in optim.param_groups for p in g["params"]}
        decay = {id(p): g["weight_decay"] for g in optim.param_groups for p in g["params"]}
        self.assertEqual(len(rate), len(list(m.parameters())))
        self.assertEqual(rate[id(m.heads[0].out.weight)], SETTINGS["head_lr"])
        self.assertEqual(rate[id(m.ngram.table.weight)], SETTINGS["head_lr"])
        self.assertEqual(rate[id(m.backbone.model.embeddings.tok_embeddings.weight)], SETTINGS["lr"])
        self.assertEqual(decay[id(m.heads[0].out.bias)], 0.0)
        self.assertEqual(decay[id(m.heads[0].out.weight)], SETTINGS["weight_decay"])

        sched = train.schedule(optim, total=100, warmup=0.1)
        seen = []
        for _ in range(100):
            seen.append(max(sched.get_last_lr()))
            optim.step()
            sched.step()
        self.assertEqual(seen[0], 0.0)
        self.assertAlmostEqual(seen[10], SETTINGS["head_lr"])
        self.assertEqual(max(seen), seen[10])
        self.assertAlmostEqual(max(sched.get_last_lr()), 0.0)

    def test_the_ngram_table_adds_nothing_at_the_first_step(self):
        m = model(exits=[0, 2, 4, 6], reduce_after=2, ngram=(50, 8)).eval()
        ids, mask = tokenise([r["text"] for r in rows(4)])
        with torch.no_grad():
            self.assertGreater((m.embed(ids, mask) - m.backbone.embed(ids, mask)).abs().max().item(), 0.01)
            train.start_as_pretrained(m)
            self.assertEqual((m.embed(ids, mask) - m.backbone.embed(ids, mask)).abs().max().item(), 0.0)

    def test_half_precision_gives_finite_scores_and_gradients(self):
        for options in ({"reduce_after": 2}, {"reduce_after": (1, 2)}, {"exits": [0, 2, 4, 6], "reduce_after": 2, "ngram": (50, 8)}):
            with self.subTest(options):
                m = model(**options).train()
                ids, mask = tokenise([r["text"] for r in rows(6)])  # different lengths: padding is part of it
                with torch.autocast("cpu", dtype=torch.float16):
                    logits = m(ids, mask)
                train.exit_losses(logits, torch.ones(6, dtype=torch.long), torch.ones(6)).mean().backward()
                self.assertTrue(torch.isfinite(logits).all())
                self.assertTrue(all(torch.isfinite(p.grad).all() for p in m.parameters() if p.grad is not None))

    def test_an_epoch_is_judged_by_the_suite_first_and_by_the_trained_exits_only(self):
        validation = [{"auroc": 0.9, "detected": 0.5}, {"auroc": 0.8, "detected": 0.7}]
        suite = [{"auroc": 0.6, "detected": 0.1}, {"auroc": 0.7, "detected": 0.2}]
        np.testing.assert_allclose(train.selection(validation), [0.6, 0.85])
        np.testing.assert_allclose(train.selection(validation, suite), [0.65, 0.6])
        np.testing.assert_allclose(train.selection(validation, suite, exits=[1]), [0.7, 0.7])
        self.assertEqual(train.trained_exits({"loss": "all"}, 3), [0, 1, 2])
        self.assertEqual(train.trained_exits({"loss": "last"}, 3), [2])

    def test_quality_per_exit(self):
        labels = [1, 1, 0, 0]
        logits = np.array([[2.0, -1.0], [3.0, 0.5], [-1.0, 0.0], [-2.0, 1.0]])
        result = train.quality(labels, logits)
        self.assertEqual(result[0]["auroc"], 1.0)
        self.assertEqual(result[1]["auroc"], 0.25)
        # a group without human texts is compared with those it is given
        alone = train.quality([1, 1], logits[:2], humans=logits[2:])
        self.assertEqual([q["auroc"] for q in alone], [1.0, 0.25])
        self.assertTrue(np.isnan(train.quality([1, 1], logits[:2])[0]["auroc"]))


class RunTest(unittest.TestCase):
    def run_training(self, out, hours=None, log=lambda message: None):
        m = model()
        done = train.train(m, tokenise, rows(96), rows(60, seed=1), CFG, SETTINGS, Path(out), torch.device("cpu"), hours, log)
        return m, done

    def test_a_run_learns_and_writes_its_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            m, done = self.run_training(tmp)
            self.assertTrue(done)
            log = read_jsonl(Path(tmp) / "log.jsonl")
            epochs = [e for e in log if "validation" in e]
            self.assertEqual([e["step"] for e in epochs], [12, 24])
            self.assertGreater(epochs[-1]["validation"][-1]["auroc"], 0.95)
            self.assertEqual(len(epochs[-1]["validation"]), len(m.exits))
            best = torch.load(Path(tmp) / "model.pt", weights_only=False)
            self.assertEqual(best["selection"], max(e["selection"] for e in epochs))

    def test_an_interrupted_run_continues_to_the_same_weights(self):
        with tempfile.TemporaryDirectory() as whole, tempfile.TemporaryDirectory() as parts:
            expected, _ = self.run_training(whole)
            sessions = 0
            while True:
                sessions += 1
                got, done = self.run_training(parts, hours=1e-9)  # every session stops after its first step
                if done:
                    break
            self.assertGreater(sessions, 20)
            for (name, a), b in zip(expected.state_dict().items(), got.state_dict().values()):
                self.assertTrue(torch.allclose(a, b, atol=1e-6), name)
            self.assertEqual([e["step"] for e in read_jsonl(Path(parts) / "log.jsonl")], [e["step"] for e in read_jsonl(Path(whole) / "log.jsonl")])

    def test_the_suite_chooses_the_epoch_and_is_logged(self):
        with tempfile.TemporaryDirectory() as tmp:
            suite = [{**r, "view": "suite-dev"} for r in rows(40, seed=3)]
            train.train(model(), tokenise, rows(96), rows(60, seed=1), CFG, SETTINGS, Path(tmp), torch.device("cpu"), log=lambda m: None, suite_rows=suite)
            epochs = [e for e in read_jsonl(Path(tmp) / "log.jsonl") if "validation" in e]
            self.assertEqual([len(e["suite_dev"]) for e in epochs], [3, 3])
            self.assertEqual([e["selection"][0] for e in epochs], [float(np.mean([q["auroc"] for q in e["suite_dev"]])) for e in epochs])
            self.assertIn("suite_dev", torch.load(Path(tmp) / "model.pt", weights_only=False))

    def test_with_the_loss_of_the_last_exit_the_other_heads_stay_as_they_started(self):
        with tempfile.TemporaryDirectory() as tmp:
            m = model()
            start = {k: v.clone() for k, v in m.state_dict().items() if k.startswith("heads.")}
            train.train(m, tokenise, rows(96), rows(60, seed=1), CFG, {**SETTINGS, "loss": "last"}, Path(tmp), torch.device("cpu"), log=lambda m: None)
            last = f"heads.{len(m.exits) - 1}."
            for k, v in start.items():
                same = torch.equal(v, m.state_dict()[k])
                self.assertEqual(same, not k.startswith(last), k)

    def test_a_checkpoint_is_not_continued_with_other_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_training(tmp, hours=1e-9)
            with self.assertRaises(SystemExit) as stopped:
                train.train(model(), tokenise, rows(96), rows(60, seed=1), CFG, {**SETTINGS, "lr": 1e-4}, Path(tmp), torch.device("cpu"), log=lambda m: None)
            self.assertIn("lr", str(stopped.exception))

    def test_scores_of_all_exits_in_the_format_of_the_baselines(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "evaluation"))
        import evaluate_test_part

        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as data:
            m, _ = self.run_training(tmp)
            test = rows(60, seed=2)
            for r in test[:20]:
                if r["label"]:
                    r["view"] = "held_out_generator"
            for split, part in (("validation", rows(60, seed=1)), ("test", test)):
                with open(Path(data) / f"{split}.jsonl", "w", encoding="utf-8") as f:
                    for r in part:
                        f.write(json.dumps({**r, "excerpt": [0, len(r["text"])]}) + "\n")
            summary = train.score(m, tokenise, Path(data), Path(tmp), torch.device("cpu"), batch=16, log=lambda message: None)
            self.assertGreater(summary["test"]["main"]["exits"][-1]["auroc"], 0.95)
            # no human text is among the held-out generators: compared with those of `main`
            self.assertEqual(summary["test"]["held_out_generator"]["human"], 0)
            self.assertGreater(summary["test"]["held_out_generator"]["exits"][-1]["auroc"], 0.95)
            stored = read_jsonl(Path(tmp) / "scores" / "test.jsonl")
            self.assertEqual([s["id"] for s in stored], [r["id"] for r in test])
            self.assertEqual(len(stored[0]["exits"]), len(m.exits))
            self.assertEqual(stored[0]["logit"], stored[0]["exits"][-1])
            self.assertEqual(evaluate_test_part.read_scores(Path(tmp) / "scores" / "test.jsonl")[test[0]["id"]], stored[0]["logit"])


if __name__ == "__main__":
    unittest.main()
