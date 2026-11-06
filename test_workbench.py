"""Behavioral checks for actual resolver selection, trace semantics and replay."""

from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from serve_workbench import handler_for
from workbench import (POLICIES, compare, evaluate_run, export_session, group_members,
                       load_bundle, member_scores, native_order, query_by_id,
                       query_summaries, replay_session, select_member)

HERE = Path(__file__).parent


def fixture():
    paths = [{"address": address, "score": 10.0 - i, "valid": valid} for i, (address, valid) in enumerate(
        [([0], True), ([0], True), ([-1], False), ([0], True), ([-2], False), ([1], True)])]
    return {"schema_version": 1, "scope": {"label": "synthetic edge fixture"},
            "resolver_contract": {}, "provenance": {},
            "items": {str(i): {"item_index": i, "training_count": score} for i, score in enumerate([10, 1, 4])},
            "models": {"fixture": {"ranking_contract": "raw_slots_v1", "groups": {"0": [0, 1], "1": [2]}}},
            "queries": [{"query_index": 0, "target_item_index": 2, "categories": [], "history_item_indices": [0],
                         "history_cosine_scores": [0.4, 0.9, 0.2],
                         "sasrec": {"ranked_item_indices": [2, 0, 1], "scores": [3, 2, 1]},
                         "runs": {"fixture": {"target_address": [1], "raw_paths": paths,
                                              "effective_history_item_indices": [0]}}}]}


class WorkbenchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_bundle()

    def test_real_oracles_all_queries_models_cutoffs(self):
        oracle = json.loads((HERE / "qualification/selected-oracle-metrics.json").read_text())
        for model in self.bundle["models"]:
            for row, index in enumerate(oracle["query_indices"]):
                for column, cutoff in enumerate((5, 10, 20)):
                    result = compare(self.bundle, index, model, cutoff)
                    for policy, view in (("popularity", "popularity"), ("history_cosine", "score")):
                        for metric_view, key in (("sid", "native_sid"), ("cce", "uniform_expected"), ("item", view)):
                            actual = result["policies"][policy]["metrics"][metric_view]
                            expected = oracle["models"][model][key][row]
                            self.assertAlmostEqual(actual["hit"], expected[column], delta=1e-12)
                            self.assertAlmostEqual(actual["ndcg"], expected[column + 3], delta=1e-12)

    def test_real_bidirectional_resolver_wins(self):
        for index, winner in ((210, "popularity"), (288, "popularity"), (145, "history_cosine"), (453, "history_cosine")):
            result = compare(self.bundle, index)
            self.assertEqual(result["policies"][winner]["metrics"]["item"]["hit"], 1)
            other = next(policy for policy in POLICIES if policy != winner)
            self.assertEqual(result["policies"][other]["metrics"]["item"]["hit"], 0)
            self.assertTrue(result["resolver_disagreement_ranks"])

    def test_injective_control_agrees(self):
        for query in self.bundle["queries"]:
            result = compare(self.bundle, query["query_index"], "tiger-openai-2025")
            for policy in result["policies"].values():
                self.assertEqual(policy["metrics"]["sid"], policy["metrics"]["item"])
                self.assertEqual(policy["metrics"]["sid"]["hit"], policy["metrics"]["cce"]["hit"])
                self.assertAlmostEqual(policy["metrics"]["sid"]["ndcg"], policy["metrics"]["cce"]["ndcg"], delta=1e-12)

    def test_invalid_repeated_paths_keep_empty_rank_slots(self):
        bundle = fixture()
        result = evaluate_run(bundle, bundle["queries"][0], "fixture", "popularity", 5)
        self.assertEqual([row["selected_item_index"] for row in result["slots"]], [0, None, None, None, None, 2])
        self.assertEqual(result["target_item_rank"], 6)
        self.assertEqual(result["metrics"]["item"]["hit"], 0)
        self.assertEqual(result["diagnostics"]["invalid_slots"], 2)
        self.assertEqual(result["diagnostics"]["repeated_slots"], 2)

    def test_letter_transform_preserves_raw_rank_and_stable_ties(self):
        run = {"raw_paths": [{"address": [0], "valid": True, "score": .5},
                             {"address": [-1], "valid": False, "score": 100},
                             {"address": [1], "valid": True, "score": .5}]}
        self.assertEqual(native_order(run, {"ranking_contract": "letter_stable_score_v1"}), [0, 2, 1])
        result = compare(self.bundle, 7)
        self.assertEqual(len(result["policies"]["popularity"]["slots"]), 20)
        self.assertEqual(sorted(row["raw_rank"] for row in result["policies"]["popularity"]["slots"]), list(range(1, 21)))

    def test_member_selection_scope_ties_and_no_target_influence(self):
        bundle = fixture(); query = bundle["queries"][0]
        self.assertEqual(select_member(bundle, query, [0, 1], "popularity")[0], 0)
        self.assertEqual(select_member(bundle, query, [0, 1], "history_cosine")[0], 1)
        self.assertEqual(select_member(bundle, query, [2], "popularity")[0], 2)
        query["history_cosine_scores"][0] = .9
        self.assertEqual(select_member(bundle, query, [1, 0], "history_cosine")[0], 0)
        before = member_scores(bundle, query, [0, 1], "history_cosine")
        query["target_item_index"] = 1
        query["runs"]["fixture"]["target_address"] = [0]
        self.assertEqual(member_scores(bundle, query, [0, 1], "history_cosine"), before)
        self.assertEqual(select_member(bundle, query, [0, 1], "history_cosine")[0], 0)

    def test_cce_is_not_uniform_single_member_credit(self):
        bundle = fixture(); query = bundle["queries"][0]
        query["target_item_index"] = 1; query["runs"]["fixture"]["target_address"] = [0]
        result = evaluate_run(bundle, query, "fixture", "popularity", 5)
        self.assertEqual(result["metrics"]["sid"]["hit"], 1)
        self.assertEqual(result["metrics"]["cce"]["hit"], 1)
        self.assertLess(result["metrics"]["cce"]["ndcg"], 1)
        self.assertEqual(result["metrics"]["item"]["hit"], 0)

    def test_group_pagination_and_within_group_evidence(self):
        query = query_by_id(self.bundle, 145)
        result = compare(self.bundle, 145)
        slot = next(row for row in result["policies"]["history_cosine"]["slots"] if row["group_size"] > 1)
        page = group_members(self.bundle, 145, "letter-openai-2025", slot["address"], "history_cosine", limit=1)
        self.assertEqual(len(page["members"]), 1)
        self.assertTrue(page["members"][0]["selected"])
        self.assertEqual(page["members"][0]["group_rank"], 1)
        self.assertEqual(page["selected_item_index"], slot["selected_item_index"])
        self.assertEqual(page["target_cosine_rank"], 1)
        self.assertGreater(page["target_popularity_rank"], 1)
        searched = group_members(self.bundle, 145, "letter-openai-2025", slot["address"], "history_cosine", limit=20, search="Fine Liner Brush")
        self.assertGreaterEqual(searched["filtered_total"], 1)
        self.assertTrue(any(m["is_target"] for m in searched["members"]))
        self.assertEqual(query["query_index"], 145)

    def test_join_errors_and_query_filters(self):
        bundle = fixture();bundle["queries"][0]["target_item_index"] = 1
        with self.assertRaisesRegex(ValueError, "identity"):
            compare(bundle, 0, "fixture")
        rows = query_summaries(self.bundle, category="neutral_evenly_spaced")
        self.assertEqual(len(rows), 12)
        self.assertTrue(query_summaries(self.bundle, category="resolver_disagreement"))
        for query in self.bundle["queries"]:
            self.assertEqual(len(query["sasrec"]["ranked_item_indices"]), 20)
            self.assertEqual(query["sasrec"]["effective_history_item_indices"], query["history_item_indices"][-50:])

    def test_independent_export_replay_without_site_packages(self):
        session = export_session(self.bundle, 145, "letter-openai-2025")
        self.assertEqual(replay_session(session), session["result"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "session.json"; path.write_text(json.dumps(session))
            result = subprocess.run([sys.executable, "-S", str(HERE / "workbench.py"), "--replay", str(path)], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["status"], "passed")
        session["selection"]["cutoff"] = 5
        with self.assertRaisesRegex(ValueError, "checksum"):
            replay_session(session)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(load_bundle(), HERE / "web/dist"))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True); cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown();cls.server.server_close();cls.thread.join()

    def get(self, path):
        with urlopen(self.url + path) as response:
            return json.load(response)

    def test_api_query_filter_group_export_replay(self):
        bootstrap = self.get("/api/bootstrap")
        self.assertEqual(bootstrap["models"]["tiger-openai-2025"]["context"]["max_items"], 20)
        self.assertEqual(bootstrap["baseline"]["context"]["max_items"], 50)
        self.assertEqual(len(self.get("/api/queries?category=neutral_evenly_spaced")["queries"]), 12)
        detail = self.get("/api/query?query=145")
        self.assertEqual(detail["policies"]["history_cosine"]["metrics"]["item"]["hit"], 1)
        self.assertEqual(detail["target_context"]["target_cosine_rank"], 1)
        self.assertEqual(detail["target_context"]["target_group_size"], 1643)
        slot = detail["policies"]["history_cosine"]["slots"][0]
        address = ",".join(map(str, slot["address"]))
        group_resp = self.get(f"/api/group?query=145&address={address}&resolver=history_cosine&limit=2")
        self.assertTrue(group_resp["members"])
        self.assertEqual(group_resp["target_member_rank"], 1)
        searched = self.get(f"/api/group?query=145&address={address}&resolver=popularity&limit=5&search=Brush")
        self.assertGreaterEqual(searched["filtered_total"], 1)
        with urlopen(self.url + "/") as html_resp:
            self.assertIn("Cornac", html_resp.read().decode())
        # Diagnostics are loaded as a separate chunk from the static journey entry.
        chunks = []
        for script in (HERE / "web/dist/assets").glob("*.js"):
            with urlopen(self.url + "/assets/" + script.name) as js_resp:
                chunks.append(js_resp.read().decode())
        js_code = "\n".join(chunks)
        for label in ("Guided scenarios", "Jump to target", "Cornac 3.0 Unified Python Experiment"):
            self.assertTrue(label in js_code, f"Missing diagnostic interface: {label}")
        session = self.get("/api/export?query=145")
        request = Request(self.url + "/api/replay", data=json.dumps(session).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            self.assertEqual(json.load(response)["status"], "passed")
        with self.assertRaises(HTTPError) as raised:
            self.get("/api/query?query=999999")
        self.assertEqual(raised.exception.code, 400)


if __name__ == "__main__":
    unittest.main(verbosity=2)
