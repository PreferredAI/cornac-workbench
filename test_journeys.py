"""Resolution, shipped metric compatibility, and prepared-graph integrity checks."""

import copy
import json
from pathlib import Path
import unittest
import tempfile

from journeys import STRATEGIES, history_id, metric_values, resolve, validate_graph


class ResolutionTests(unittest.TestCase):
    def setUp(self):
        self.groups = {"1": [0, 1], "2": [2, 3], "3": [4]}
        self.paths = [{"address": [99], "score": 0}, {"address": [1], "score": -1},
                      {"address": [1], "score": -2}, {"address": [2], "score": -3},
                      {"address": [3], "score": -4}]
        self.pop = [9, 8, 2, 5, 1]
        self.cos = [.1, .9, .7, .2, .5]

    def test_representatives_and_expansion_preserve_sid_order(self):
        def items(policy):
            return [row["item"] for row in resolve(self.paths, self.groups, self.pop, self.cos, policy, k=3)]
        self.assertEqual(items("one_popularity"), [0, 3, 4])
        self.assertEqual(items("one_cosine"), [1, 2, 4])
        self.assertEqual(items("expand_popularity"), [0, 1, 3])
        self.assertEqual(items("expand_cosine"), [1, 0, 2])

    def test_large_bucket_fills_shelf_and_ties_use_item_index(self):
        rows = resolve(self.paths, self.groups, [0]*5, self.cos, "expand_popularity", k=2)
        self.assertEqual([row["item"] for row in rows], [0, 1])
        self.assertEqual([row["sid_rank"] for row in rows], [1, 1])

    def test_portable_sid_cce_agree_with_shipped_31_compaction(self):
        import numpy as np
        from cornac.eval_methods.next_item_evaluation import _semantic_metric_scores
        from cornac.metrics import NDCG, Recall
        for target, address in ((0, [1]), (2, [2]), (4, [3])):
            for cutoff in (1, 3, 5):
                values = metric_values(self.paths, self.groups, address, target, {}, cutoff)
                expected, distinct = _semantic_metric_scores(np.array([p["address"] for p in self.paths]),
                    tuple(address), {tuple(map(int, key.split(','))): len(members) for key, members in self.groups.items()},
                    [Recall(k=cutoff), NDCG(k=cutoff)])
                self.assertEqual(distinct, 3)
                observed = [values[view][metric] for view in ("sid", "cce") for metric in ("recall", "ndcg")]
                np.testing.assert_allclose(observed, expected, atol=1e-14)

    def test_no_target_or_future_events_are_needed_to_resolve(self):
        # Two history profiles resolve the same native paths differently.
        first = resolve(self.paths, self.groups, self.pop, self.cos, "one_cosine")
        second = resolve(self.paths, self.groups, self.pop, list(reversed(self.cos)), "one_cosine")
        self.assertNotEqual(first[0]["item"], second[0]["item"])


class PreparedGraphTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).parent / "web/public/journeys"
        cls.manifest = json.loads((cls.root / "manifest.json").read_text())
        cls.pair = cls.manifest["pairs"][0]
        cls.states = {path.stem: json.loads(path.read_text()) for path in (cls.root / cls.pair["id"] / "states").glob("*.json")}

    def test_every_prepared_card_advances_the_same_real_history(self):
        report = validate_graph(self.states, [seed["id"] for seed in self.pair["seeds"]])
        self.assertEqual(report["states"], self.pair["state_count"])
        self.assertGreater(report["transitions"], 100)

    def test_missing_and_forged_transitions_are_rejected(self):
        root = self.pair["seeds"][0]["id"]
        states = copy.deepcopy(self.states)
        states[root]["next"].pop(next(iter(states[root]["next"])))
        with self.assertRaisesRegex(ValueError, "no prepared transition"):
            validate_graph(states, [seed["id"] for seed in self.pair["seeds"]])
        states = copy.deepcopy(self.states)
        child = next(iter(states[root]["next"].values()))
        states[child]["history"][-1] = -1
        with self.assertRaisesRegex(ValueError, "shared history"):
            validate_graph(states, [seed["id"] for seed in self.pair["seeds"]])

    def test_benchmark_is_fixed_heldout_not_synthetic_path_metrics(self):
        benchmark = json.loads((self.root / "benchmark.json").read_text())
        self.assertEqual(benchmark["query_count"], 22363)
        self.assertIn("Cornac 3.1", benchmark["semantics"])
        for state in self.states.values():
            self.assertNotIn("target", state)
            self.assertNotIn("metrics", state)
            self.assertEqual(set(state["shelves"]), set(STRATEGIES))

    def test_each_model_pair_has_aligned_heldout_evidence_and_complete_paths(self):
        for pair in self.manifest["pairs"]:
            benchmark = json.loads((self.root / pair["benchmark"]).read_text())
            self.assertEqual(benchmark["provenance"], pair["provenance"])
            self.assertTrue(benchmark["provenance"]["raw_query_target_alignment"])
            self.assertEqual(len(benchmark["provenance"]["raw_predictions_sha256"]), 64)
            states = {path.stem: json.loads(path.read_text()) for path in (self.root / pair["id"] / "states").glob("*.json")}
            report = validate_graph(states, [seed["id"] for seed in pair["seeds"]])
            self.assertEqual(report["states"], pair["state_count"])
            self.assertEqual(pair["validation"], report)

    def test_all_eight_pairs_ship_in_display_order_with_bundle_totals(self):
        self.assertEqual([pair["id"] for pair in self.manifest["pairs"]],
                         ["sasrec-letter", "sasrec-rpg", "sasrec-diffgrm", "sasrec-tiger",
                          "bert-mlm-letter", "bert-mlm-rpg", "bert-mlm-diffgrm", "bert-mlm-tiger"])
        self.assertEqual(self.manifest["pending_models"], [])
        self.assertEqual(self.manifest["totals"], {"pairs": 8, "states": 3470, "transitions": 3454})

    def test_generic_per_pair_provenance_and_no_bundle_level_mixing(self):
        from prepare_journeys import PROVENANCE_KEYS
        for key in ("provenance", "qualification", "validation", "seconds"):
            self.assertNotIn(key, self.manifest)
        # Exporter hashes are not asserted equal: three exporter generations are legitimate.
        shared = {}
        for pair in self.manifest["pairs"]:
            provenance = pair["provenance"]
            self.assertEqual(tuple(provenance), PROVENANCE_KEYS)
            self.assertNotIn("sasrec_checkpoint_sha256", provenance)
            self.assertEqual(provenance["traditional_model"], pair["traditional"])
            self.assertEqual(provenance["sid_model"], pair["sid"])
            self.assertTrue(all(row["traditional_checkpoint_qualified"] for row in pair["qualification"]))
            self.assertIsInstance(pair["seconds"], float)
            self.assertGreater(pair["seconds"], 0)
            for model, key in ((pair["traditional"], "traditional_checkpoint_sha256"),
                               (pair["sid"], "sid_checkpoint_sha256"), (pair["sid"], "raw_predictions_sha256")):
                self.assertEqual(shared.setdefault((model, key), provenance[key]), provenance[key])
        self.assertEqual(len({pair["provenance"]["resolver_sha256"] for pair in self.manifest["pairs"]}), 1)

    def test_same_bucket_walkthrough_points_to_verified_selectable_alternatives(self):
        probe = self.pair["same_bucket_probe"]
        self.assertTrue(probe["native_addresses_equal"])
        root = self.states[probe["seed"]]
        for item in probe["items"]:
            self.assertIn(str(item), root["next"])
            self.assertTrue(any(card["item"] == item and card["address"] == probe["address"]
                                for cards in root["shelves"].values() for card in cards))


class RawAlignmentTests(unittest.TestCase):
    def test_misaligned_targets_or_query_order_are_rejected(self):
        import numpy as np
        from prepare_journeys import validate_raw_predictions
        universe = {"test": [{"user_index": 3, "session_index": 8, "items": [0, 1]},
                             {"user_index": 4, "session_index": 9, "items": [1, 0]}]}
        table = np.array([[10], [20]])
        raw = {"query_index": np.array([0, 1]), "user_index": np.array([3, 4]),
               "session_index": np.array([8, 9]), "target_item_index": np.array([1, 0]),
               "target_address_sids": np.array([[20], [10]]), "prediction_offsets": np.array([0, 1, 2]),
               "predicted_address_sids": np.array([[10], [20]])}
        validate_raw_predictions(raw, universe, table)
        for field in ("query_index", "target_item_index", "target_address_sids"):
            corrupted = {key: value.copy() for key, value in raw.items()}
            corrupted[field] = corrupted[field][::-1]
            with self.assertRaisesRegex(ValueError, field):
                validate_raw_predictions(corrupted, universe, table)


class CampaignSelectionTests(unittest.TestCase):
    def test_validation_winner_excludes_pilots_budget_stops_and_tampered_weights(self):
        from finalize_model_campaign import select_winner
        from sasrec_asset import sha
        with tempfile.TemporaryDirectory() as temporary:
            entries = []
            for index, (score, status, pilot) in enumerate(((.1, "complete", False),
                    (.9, "budget_stop", False), (.8, "complete", True), (.2, "complete", False))):
                directory = Path(temporary) / str(index)
                directory.mkdir()
                config = {"learning_rate": .001, "dropout": .2, "n_epochs": 80, "objective": "mlm"}
                config_path = directory / "grid.json"
                config_path.write_text(json.dumps({"parameters": config}))
                (directory / "config.json").write_text(json.dumps(config))
                (directory / "selected.pt").write_bytes(b"qualified weights")
                result = {"status": status, "pilot": pilot, "test_used_for_selection": False,
                    "cpu_weights_only_reload": True, "checkpoint_sha256": sha(directory / "selected.pt"),
                    "completed_epochs": 80, "selected_epoch": 20, "validation_ndcg10": score}
                (directory / "result.json").write_text(json.dumps(result))
                (directory / "provenance.json").write_text(json.dumps({"test_used_for_selection": False}))
                entries.append({"index": index, "output": str(directory), "config": str(config_path)})
            winner, excluded = select_winner(entries, "bert-mlm")
            self.assertEqual(winner["index"], 3)
            self.assertEqual(len(excluded), 2)
            (Path(entries[3]["output"]) / "selected.pt").write_bytes(b"changed weights")
            winner, excluded = select_winner(entries, "bert-mlm")
            self.assertEqual(winner["index"], 0)
            self.assertEqual(len(excluded), 3)

    def test_tiger_winner_requires_every_validation_epoch_and_frozen_grid_settings(self):
        from finalize_model_campaign import select_winner
        from sasrec_asset import sha
        with tempfile.TemporaryDirectory() as temporary:
            entries = []
            # Rejected fits score higher, so only the gate keeps them from winning.
            for index, (completed, dropout, sample) in enumerate(((100, .1, 2000), (95, .1, 2000),
                                                                   (100, .3, 2000), (100, .1, 256))):
                directory = Path(temporary) / f"tiger-{index}"
                directory.mkdir()
                (directory / "config.json").write_text(json.dumps(
                    {"learning_rate": .0003, "dropout": dropout, "n_epochs": 100, "val_sample": sample}))
                (directory / "selected.pt").write_bytes(b"qualified weights")
                result = {"status": "complete", "pilot": False, "test_used_for_selection": False,
                    "cpu_weights_only_reload": True, "checkpoint_sha256": sha(directory / "selected.pt"),
                    "completed_validation_epoch": completed, "selected_epoch": 80, "validation_ndcg10": .05 + index / 100}
                (directory / "result.json").write_text(json.dumps(result))
                (directory / "provenance.json").write_text(json.dumps({"test_used_for_selection": False}))
                entries.append({"index": index, "learning_rate": .0003, "dropout": .1, "n_epochs": 100,
                                "val_sample": 2000, "output": str(directory)})
            winner, excluded = select_winner(entries, "tiger")
            self.assertEqual((winner["index"], winner["validation_sample"]), (0, 2000))
            self.assertEqual([row["index"] for row in excluded], [1, 2, 3])
            self.assertEqual([row["reason"] for row in excluded], ["Requested fit did not complete all epochs",
                             "Candidate differs from frozen grid entry", "Candidate differs from frozen grid entry"])


class ProvenanceMigrationTests(unittest.TestCase):
    def test_legacy_sasrec_records_migrate_to_writer_order_idempotently(self):
        from prepare_journeys import PROVENANCE_KEYS, migrate_legacy_provenance, migrate_legacy_qualification
        legacy = {key: key for key in ("universe_sha256", "sasrec_checkpoint_sha256", "sid_model",
                  "sid_checkpoint_sha256", "raw_predictions_sha256", "raw_query_target_alignment",
                  "resolver_inputs_sha256", "exporter_sha256", "resolver_sha256", "torch_version", "seed", "contexts")}
        migrated = migrate_legacy_provenance(legacy)
        self.assertEqual(list(migrated), list(PROVENANCE_KEYS))
        self.assertEqual((migrated["traditional_model"], migrated["traditional_checkpoint_sha256"]),
                         ("SASRec", "sasrec_checkpoint_sha256"))
        self.assertEqual(list(migrate_legacy_provenance(migrated).items()), list(migrated.items()))
        receipts = migrate_legacy_qualification([{"query_index": 145, "native_paths_reproduced": True,
                                                  "sasrec_top20_reproduced": True}])
        self.assertEqual(list(receipts[0]), ["query_index", "native_paths_reproduced",
                                             "traditional_checkpoint_qualified", "sasrec_top20_reproduced"])
        self.assertEqual(migrate_legacy_qualification(receipts), receipts)


if __name__ == "__main__":
    unittest.main()
