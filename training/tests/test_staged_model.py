"""
Tests for model/staged.py (early exit and token reduction on a Hugging Face encoder) and
model/latency_report.py. They use tiny encoders with random weights built here, no download.

    .venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import logging
import math
import sys
import tempfile
import unittest
import warnings
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "model"))

import latency_report  # noqa: E402
import staged  # noqa: E402

LAYERS, HIDDEN, VOCAB = 6, 32, 100


def encoder(family):
    from transformers import AlbertConfig, AutoModel, BertConfig, DebertaV2Config, ModernBertConfig, RobertaConfig

    common = {"vocab_size": VOCAB, "hidden_size": HIDDEN, "num_hidden_layers": LAYERS, "num_attention_heads": 4}
    config = {
        "bert": lambda: BertConfig(**common, intermediate_size=64),
        "roberta": lambda: RobertaConfig(**common, intermediate_size=64, max_position_embeddings=70, pad_token_id=1),
        # two groups of shared weights, three layers each
        "albert": lambda: AlbertConfig(**common, intermediate_size=64, embedding_size=16, num_hidden_groups=2),
        "deberta-v2": lambda: DebertaV2Config(
            **common, intermediate_size=64, relative_attention=True, position_buckets=16, norm_rel_ebd="layer_norm",
            share_att_key=True, pos_att_type=["p2c", "c2p"], position_biased_input=False, max_position_embeddings=64),
        # a window of 4 tokens to each side, so that 40 tokens are far more than one window
        "modernbert": lambda: ModernBertConfig(
            **common, intermediate_size=48, local_attention=8, global_attn_every_n_layers=3,
            pad_token_id=0, bos_token_id=1, eos_token_id=2, cls_token_id=1, sep_token_id=2),
    }[family]()
    torch.manual_seed(0)
    return AutoModel.from_config(config).eval()


def batch(tokens=40, padded_from=25, pad_id=0):
    g = torch.Generator().manual_seed(1)
    ids = torch.randint(3, VOCAB, (2, tokens), generator=g)
    mask = torch.ones(2, tokens, dtype=torch.long)
    mask[1, padded_from:] = 0
    ids[1, padded_from:] = pad_id
    return ids, mask


class BackboneTest(unittest.TestCase):
    def test_layers_called_one_by_one_give_what_the_encoder_gives(self):
        for family in staged.BACKBONES:
            with self.subTest(family):
                enc = encoder(family)
                model = staged.StagedClassifier(enc)
                ids, mask = batch(pad_id=1 if family == "roberta" else 0)
                with torch.no_grad():
                    expected = enc(input_ids=ids, attention_mask=mask).last_hidden_state
                    hidden, _ = model.run_layers(model.embed(ids, mask), mask, 0, LAYERS)
                    hidden = model.backbone.finish(hidden)
                self.assertLess(((expected - hidden) * mask.unsqueeze(-1)).abs().max().item(), 1e-5)

    def test_unknown_family_is_refused(self):
        from transformers import AutoModel, DistilBertConfig

        with self.assertRaises(ValueError):
            staged.backbone_for(AutoModel.from_config(DistilBertConfig(vocab_size=VOCAB, dim=32, n_layers=2, n_heads=4, hidden_dim=64)))


class StagesTest(unittest.TestCase):
    def chain(self, model, ids, mask):
        hidden, logits = ids, []
        for i in range(len(model.exits)):
            out = staged.Stage(model, i)(hidden, mask)
            if i < len(model.exits) - 1:
                logit, hidden, mask = out
            else:
                logit = out
            logits.append(logit)
        return torch.stack(logits, dim=-1)

    def test_stages_one_after_the_other_give_the_logits_of_the_whole_model(self):
        for family in staged.BACKBONES:
            for reduce_after in (None, 2, 3):
                with self.subTest(family=family, reduce_after=reduce_after):
                    model = staged.StagedClassifier(encoder(family), reduce_after=reduce_after).eval()
                    ids, mask = batch(pad_id=1 if family == "roberta" else 0)
                    with torch.no_grad():
                        whole = model(ids, mask)
                        self.assertLess((self.chain(model, ids, mask) - whole).abs().max().item(), 1e-5)
                        self.assertLess((staged.Full(model)(ids, mask) - whole[:, -1]).abs().max().item(), 1e-5)

    def test_default_exits_are_thirds_and_end_at_the_last_layer(self):
        self.assertEqual(staged.default_exits(6), [2, 4, 6])
        self.assertEqual(staged.default_exits(22), [7, 15, 22])
        self.assertEqual(staged.default_exits(7), [2, 5, 7])
        self.assertEqual(staged.default_exits(1), [1])

    def test_exits_and_reduction_are_checked(self):
        enc = encoder("bert")
        for exits in ([2, 4], [4, 2, 6], [0, 6], [2, 2, 6]):
            with self.assertRaises(ValueError):
                staged.StagedClassifier(enc, exits=exits)
        for reduce_after in (0, LAYERS):
            with self.assertRaises(ValueError):
                staged.StagedClassifier(enc, reduce_after=reduce_after)

    def test_padding_does_not_change_a_score(self):
        model = staged.StagedClassifier(encoder("modernbert"), reduce_after=2).eval()
        ids, mask = batch(tokens=40, padded_from=25)
        with torch.no_grad():
            padded = model(ids, mask)[1]
            alone = model(ids[1:, :25], mask[1:, :25])[0]
        self.assertLess((padded - alone).abs().max().item(), 1e-4)

    def test_token_reduction_halves_the_tokens_of_the_later_stages(self):
        model = staged.StagedClassifier(encoder("bert"), reduce_after=2).eval()
        ids, mask = batch(tokens=40)
        with torch.no_grad():
            _, hidden, mask1 = staged.Stage(model, 0)(ids, mask)
            _, hidden, mask2 = staged.Stage(model, 1)(hidden, mask1)
        self.assertEqual(mask1.shape[1], 40)
        self.assertEqual(hidden.shape[1], 21)
        self.assertEqual(mask2.shape[1], 21)


class PoolTokensTest(unittest.TestCase):
    def test_first_token_stays_and_neighbours_become_their_mean(self):
        hidden = torch.tensor([[[10.0], [1.0], [3.0], [5.0], [9.0]]])
        pooled, mask = staged.pool_tokens(hidden, torch.ones(1, 5, dtype=torch.long))
        self.assertEqual(pooled.squeeze(-1).tolist(), [[10.0, 2.0, 7.0]])
        self.assertEqual(mask.tolist(), [[1, 1, 1]])

    def test_last_token_without_a_partner_is_kept_as_it_is(self):
        hidden = torch.tensor([[[10.0], [1.0], [3.0], [5.0]]])
        pooled, mask = staged.pool_tokens(hidden, torch.ones(1, 4, dtype=torch.long))
        self.assertEqual(pooled.squeeze(-1).tolist(), [[10.0, 2.0, 5.0]])
        self.assertEqual(mask.tolist(), [[1, 1, 1]])

    def test_padding_does_not_enter_a_mean_and_stays_padding(self):
        hidden = torch.tensor([[[10.0], [1.0], [3.0], [5.0], [99.0], [99.0], [99.0]]])
        pooled, mask = staged.pool_tokens(hidden, torch.tensor([[1, 1, 1, 1, 0, 0, 0]]))
        self.assertEqual(pooled.squeeze(-1).tolist(), [[10.0, 2.0, 5.0, 0.0]])
        self.assertEqual(mask.tolist(), [[1, 1, 1, 0]])


class OnnxTest(unittest.TestCase):
    def test_exported_stage_with_token_reduction_gives_what_pytorch_gives(self):
        import export_candidates as ex

        model = staged.StagedClassifier(encoder("modernbert"), reduce_after=2).eval()
        stage = staged.Stage(model, 1)
        logging.disable(logging.WARNING)
        try:
            with tempfile.TemporaryDirectory() as tmp, warnings.catch_warnings():
                warnings.simplefilter("ignore")
                path = Path(tmp) / "stage1-tr.onnx"
                ex.export(stage, False, HIDDEN, VOCAB, path)
                self.assertLess(ex.parity(stage, False, HIDDEN, VOCAB, path), ex.PARITY_TOLERANCE)
                ex.quantise(path, Path(tmp) / "stage1-tr.q8.onnx")
                self.assertTrue(math.isfinite(ex.parity(stage, False, HIDDEN, VOCAB, Path(tmp) / "stage1-tr.q8.onnx")))
        finally:
            logging.disable(logging.NOTSET)


class LatencyReportTest(unittest.TestCase):
    def test_time_until_an_exit_is_the_sum_of_the_stages_before_it(self):
        self.assertEqual(latency_report.cumulative([10, 20, 30]), [10, 30, 60])

    def test_expected_time_weighs_the_exits_by_their_share(self):
        self.assertAlmostEqual(latency_report.expected([10, 20, 30], (0, 0, 1)), 60)
        self.assertAlmostEqual(latency_report.expected([10, 20, 30], (0.5, 0.2, 0.3)), 0.5 * 10 + 0.2 * 30 + 0.3 * 60)

    def test_shares_must_cover_all_paragraphs(self):
        with self.assertRaises(ValueError):
            latency_report.expected([10, 20, 30], (0.5, 0.2))
        with self.assertRaises(ValueError):
            latency_report.expected([10, 20, 30], (0.5, 0.2, 0.2))

    def test_fewer_exits_take_the_remaining_shares_at_the_last(self):
        self.assertEqual(latency_report.spread((0.5, 0.2, 0.3), 3), (0.5, 0.2, 0.3))
        self.assertEqual(latency_report.spread((0.5, 0.2, 0.3), 2), (0.5, 0.5))
        self.assertEqual(latency_report.spread((0.5, 0.2, 0.3), 1), (1.0,))

    def test_report_has_a_row_per_candidate_and_names_failures(self):
        files = {"fp32": {"path": "a/full.fp32.onnx", "bytes": 4_000_000}, "q8": {"path": "a/full.q8.onnx", "bytes": 1_000_000}}
        manifest = {"candidates": {"a": {
            "repo": "org/a", "licence": "MIT", "sibling": None, "layers": 6, "hidden": 32, "parameters": 2_000_000,
            "embedding_parameters": 1_000_000, "exits": [2, 4, 6], "reduce_after": 2, "graphs": {"full": {"files": files}}}}}
        stage = lambda *times: [{"ms": t} for t in times]  # noqa: E731
        results = {
            "environment": {"date": "2026-10-13", "browser": "Chromium 1", "onnxruntimeWeb": "1", "wasm": ["x.wasm"], "backend": "wasm",
                            "threads": 8, "cpu": "cpu", "logicalCores": 16, "lengths": [32, 128]},
            "candidates": {"a": {"q8": {
                "full": {"lengths": {"32": stage(10), "128": stage(40)}},
                "full-tr": {"lengths": {"32": stage(8), "128": stage(30)}},
                "stages": {"lengths": {"32": stage(4, 4, 4), "128": stage(14, 14, 14)}},
                "stages-tr": {"lengths": {"32": stage(4, 3, 3), "128": stage(14, 8, 8)}},
            }, "fp32": {"full": {"error": "out of memory"}}}},
        }
        text = latency_report.report(manifest, results, "q8")
        self.assertIn("| a | 10 | 40 |", text)
        self.assertIn("| a | 2 | 40 | 30 | 40 | 30 | 25% |", text)
        self.assertIn("14 / 28 / 42 | 40 | 14 / 22 / 30 | 30 | 20 | 18 |", text)
        self.assertIn("- a, fp32, full: out of memory", text)

        # a chain that failed leaves its columns empty and is named, the rest of the row stays
        results["candidates"]["a"]["q8"]["stages-tr"] = {"error": "out of memory"}
        del results["environment"]["threads"]
        text = latency_report.report(manifest, results, "q8")
        self.assertIn("14 / 28 / 42 | 40 | – | – | – | – |", text)
        self.assertIn("- a, q8, stages-tr: out of memory", text)


if __name__ == "__main__":
    unittest.main()
