"""Qualify real Beauty checkpoints and export static journeys; never train models."""

import argparse
from collections import deque
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import time

import numpy as np

from journeys import STRATEGIES, compact_paths, history_id, metric_values, resolve, validate_graph
from sasrec_asset import load_sasrec_asset, sha
from workbench import load_bundle

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
STUDY = ROOT / "runs/beauty-search-2026-09-14"
SOURCE = ROOT / "papers/ecir2027-replicability/artifact-bundle/data/beauty"
# Per-pair provenance keys in writer order (BeautyModels.provenance).
PROVENANCE_KEYS = ("universe_sha256", "traditional_model", "traditional_checkpoint_sha256", "sid_model",
                   "sid_checkpoint_sha256", "raw_predictions_sha256", "raw_query_target_alignment",
                   "resolver_inputs_sha256", "exporter_sha256", "resolver_sha256", "torch_version", "seed", "contexts")
TRADITIONAL_ORDER = ("sasrec", "bert-mlm")
SID_ORDER = ("letter", "rpg", "diffgrm", "tiger")


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(",", ":"), ensure_ascii=False, allow_nan=False) + "\n")


def validate_raw_predictions(raw, universe, sid_table):
    """Require the complete ordered study cohort, rather than positional guessing."""
    queries = universe["test"]
    expected = {
        "query_index": np.arange(len(queries)),
        "user_index": [q["user_index"] for q in queries],
        "session_index": [q["session_index"] for q in queries],
        "target_item_index": [q["items"][-1] for q in queries],
        "target_address_sids": sid_table[[q["items"][-1] for q in queries]],
    }
    for key, values in expected.items():
        if not np.array_equal(raw[key], values):
            raise ValueError(f"Raw prediction {key} differs from the canonical cohort")
    offsets = raw["prediction_offsets"]
    if len(offsets) != len(queries) + 1 or offsets[0] != 0 or np.any(np.diff(offsets) < 0):
        raise ValueError("Invalid raw prediction offsets")
    if offsets[-1] != len(raw["predicted_address_sids"]):
        raise ValueError("Raw predictions are incomplete")


class BeautyModels:
    def __init__(self, sid_name="letter", traditional_name="sasrec", traditional_checkpoint=None, sid_checkpoint=None):
        import torch
        from research.sid_addressability.beauty_models import load_checkpoint

        torch.set_num_threads(2)
        self.torch = torch
        self.universe_path = STUDY / "matched_universe.json"
        self.universe = json.loads(self.universe_path.read_text())
        self.bundle = load_bundle()
        if sha(self.universe_path) != self.bundle["provenance"]["universe_sha256"]:
            raise ValueError("Qualified universe changed")
        self.traditional_name = traditional_name
        self.traditional_label = "SASRec" if traditional_name == "sasrec" else "BERT4Rec (MLM)"
        if traditional_name == "sasrec":
            self.sasrec_path = ROOT / "runs/www2027-demo-sasrec-beauty-2026-10-25/asset/selected.pt"
            if sha(self.sasrec_path) != self.bundle["baseline"]["checkpoint_sha256"]:
                raise ValueError("SASRec checkpoint changed")
            self.sasrec, asset = load_sasrec_asset(self.sasrec_path)
        else:
            from fit_bert_asset import load_bert_asset
            if traditional_checkpoint is None:
                raise ValueError("BERT4Rec requires --traditional-checkpoint from a qualified full fit")
            self.sasrec_path = traditional_checkpoint
            receipt = json.loads((traditional_checkpoint.parent / "result.json").read_text())
            if receipt.get("pilot") or receipt["status"] != "complete" or receipt.get("test_used_for_selection") or not receipt.get("cpu_weights_only_reload"):
                raise ValueError("A timed pilot is not a qualified BERT4Rec finalist")
            if sha(traditional_checkpoint) != receipt["checkpoint_sha256"]:
                raise ValueError("BERT4Rec checkpoint changed")
            self.sasrec, asset = load_bert_asset(traditional_checkpoint)
            if asset["universe_sha256"] != sha(self.universe_path):
                raise ValueError("BERT4Rec universe differs")
        self.sid_name = sid_name
        self.sid_label = {"letter": "LETTER", "rpg": "RPG", "diffgrm": "DiffGRM", "tiger": "TIGER"}[sid_name]
        if sid_name == "tiger":
            from fit_tiger_asset import load_tiger_asset
            if sid_checkpoint is None:
                raise ValueError("TIGER requires --sid-checkpoint from a qualified full fit")
            self.letter_path = sid_checkpoint
            receipt = json.loads((sid_checkpoint.parent / "result.json").read_text())
            if receipt.get("pilot") or receipt["status"] != "complete" or receipt["test_used_for_selection"]:
                raise ValueError("TIGER requires a completed validation-selected full fit")
            if sha(sid_checkpoint) != receipt["checkpoint_sha256"]:
                raise ValueError("TIGER checkpoint changed")
            self.letter, asset = load_tiger_asset(sid_checkpoint)
            if asset["universe_sha256"] != sha(self.universe_path):
                raise ValueError("TIGER universe differs")
        else:
            recipe, attempt = {"letter": ("01", "000"), "rpg": ("05", "000"), "diffgrm": ("05", "001")}[sid_name]
            directory = STUDY / f"fits/confirm-{sid_name}-openai-{recipe}-2025/attempt-{attempt}"
            receipt = json.loads((directory / "result.json").read_text())
            self.letter_path = directory / "checkpoint.pt"
            self.letter = load_checkpoint(self.letter_path, receipt["output_hashes"]["checkpoint.pt"])
        self.letter.device = "cpu"
        self.letter.device_ = "cpu"
        self.letter.model.to("cpu").eval()
        if list(self.letter.iid_map) != self.universe["items"] or asset["item_ids"] != self.universe["items"]:
            raise ValueError("Checkpoint catalog order differs")
        self.groups = {}
        for item, address in enumerate(self.letter.sid_table):
            self.groups.setdefault(",".join(map(str, address)), []).append(item)
        with np.load(SOURCE / f"{sid_name}-openai-2025/sid_catalog.npz", allow_pickle=False) as catalog:
            if not np.array_equal(catalog["address_sids"], self.letter.sid_table):
                raise ValueError("Checkpoint complete address catalog differs")
        self.raw_path = (ROOT / f"runs/www2027-demo-journeys/tiger-{sha(self.letter_path)[:16]}/raw_predictions.npz"
                         if sid_name == "tiger" else SOURCE / f"{sid_name}-openai-2025/raw_predictions.npz")
        self.raw = None
        if self.raw_path.exists():
            with np.load(self.raw_path, allow_pickle=False) as data:
                self.raw = {key: data[key] for key in data.files}
            validate_raw_predictions(self.raw, self.universe, self.letter.sid_table)
        with np.load(SOURCE / "resolver-inputs.npz", allow_pickle=False) as data:
            self.features = np.asarray(data["features"], dtype="float64")
            self.popularity = np.bincount(data["train_items"], minlength=len(self.features))
        norms = np.linalg.norm(self.features, axis=1, keepdims=True)
        self.features = np.divide(self.features, norms, out=np.zeros_like(self.features), where=norms != 0)
        self.sid_cache = {}
        self.provenance = {"universe_sha256": sha(self.universe_path),
                           "traditional_model": self.traditional_label,
                           "traditional_checkpoint_sha256": sha(self.sasrec_path),
                           "sid_model": self.sid_label, "sid_checkpoint_sha256": sha(self.letter_path),
                           "raw_predictions_sha256": sha(self.raw_path) if self.raw is not None else None,
                           "raw_query_target_alignment": self.raw is not None,
                           "resolver_inputs_sha256": sha(SOURCE / "resolver-inputs.npz"),
                           "exporter_sha256": sha(__file__), "resolver_sha256": sha(HERE / "journeys.py"),
                           "torch_version": str(torch.__version__), "seed": 2025,
                           "contexts": {self.traditional_label: self.sasrec.max_len, self.sid_label: self.letter.max_len}}

    def native(self, history):
        # LETTER encodes SID tokens; RPG encodes item IDs. Cache conservatively
        # on actual item histories for other architectures.
        key = (tuple(map(tuple, self.letter.sid_table[history[-self.letter.max_len:]]))
               if self.sid_name == "letter" else tuple(history[-self.letter.max_len:]))
        if key not in self.sid_cache:
            with self.torch.no_grad():
                pred = self.letter.predict_semantic_ids(history)
            order = np.argsort(-np.where(pred.catalog_validity, pred.scores, -1000.), kind="stable")
            self.sid_cache[key] = [{"address": pred.address_sids[i].tolist(), "score": float(pred.scores[i])} for i in order]
        return self.sid_cache[key]

    def qualify(self):
        receipts = []
        for query_id in (145, 210):
            row = next(q for q in self.bundle["queries"] if q["query_index"] == query_id)
            observed = self.native(row["history_item_indices"])
            if self.raw is None:
                # Newly trained TIGER has no old prediction oracle. Compare an
                # independent weights-only reload, rather than its cache.
                from fit_tiger_asset import load_tiger_asset
                restored, _ = load_tiger_asset(self.letter_path)
                pred = restored.predict_semantic_ids(row["history_item_indices"])
                order = np.argsort(-np.where(pred.catalog_validity, pred.scores, -1000.), kind="stable")
                expected = [{"address": pred.address_sids[i].tolist(), "score": float(pred.scores[i])} for i in order]
            else:
                start, stop = self.raw["prediction_offsets"][query_id:query_id + 2]
                order = np.argsort(-np.where(self.raw["prediction_catalog_validity"][start:stop],
                                            self.raw["prediction_scores"][start:stop], -1000.), kind="stable")
                expected = [{"address": self.raw["predicted_address_sids"][start+i].tolist(),
                             "score": float(self.raw["prediction_scores"][start+i])} for i in order]
            if [p["address"] for p in observed] != [p["address"] for p in expected]:
                raise ValueError(f"{self.sid_label} checkpoint does not reproduce qualified native paths")
            np.testing.assert_allclose([p["score"] for p in observed], [p["score"] for p in expected], atol=1e-5, rtol=1e-5)
            ranking, scores = self.sasrec.rank(0, history_items=row["history_item_indices"])
            if self.traditional_name == "sasrec" and ranking[:20].tolist() != row["sasrec"]["ranked_item_indices"][:20]:
                raise ValueError("SASRec checkpoint does not reproduce qualified ranking")
            if not np.isfinite(scores).all() or len(set(ranking[:20])) != 20:
                raise ValueError("Traditional model returned an invalid ranking")
            receipts.append({"query_index": query_id, "native_paths_reproduced": True,
                             "traditional_checkpoint_qualified": True,
                             "sasrec_top20_reproduced": self.traditional_name == "sasrec"})
        return receipts

    def scores(self, history, paths):
        candidates = sorted({item for path in compact_paths(paths, self.groups)[:5] for item in self.groups[path["key"]]})
        profile = self.features[history].sum(axis=0)
        norm = np.linalg.norm(profile)
        if norm:
            profile /= norm
        # This data has nonzero features; zero profiles use deterministic zero-score ties.
        return dict(zip(candidates, (self.features[candidates] @ profile).tolist()))

    def shelves(self, history, paths):
        cosine = self.scores(history, paths)
        shelves = {policy: resolve(paths, self.groups, self.popularity, cosine, policy) for policy in STRATEGIES}
        return shelves, cosine

    def state(self, history):
        paths = self.native(history)
        shelves, cosine = self.shelves(history, paths)
        ranking, scores = self.sasrec.rank(0, history_items=history)
        buckets = []
        for path in compact_paths(paths, self.groups)[:5]:
            members = self.groups[path["key"]]
            pop = sorted(members, key=lambda i: (-self.popularity[i], i))
            cos = sorted(members, key=lambda i: (-cosine[i], i))
            buckets.append({"address": path["address"], "score": path["score"], "size": len(members),
                            "popularity": [{"item": i, "score": int(self.popularity[i])} for i in pop[:12]],
                            "cosine": [{"item": i, "score": cosine[i]} for i in cos[:12]]})
        return {"history": history, "traditional": [{"item": int(i), "score": float(scores[i])} for i in ranking[:5]],
                "shelves": shelves, "buckets": buckets, "next": {}}


def benchmark(models, output):
    """Same complete catalog and ordered held-out cohort for every displayed view."""
    if models.raw is None:
        offsets, addresses, scores = [0], [], []
        queries = models.universe["test"]
        for index, query in enumerate(queries):
            paths = models.native(query["items"][:-1])
            if any(",".join(map(str, path["address"])) not in models.groups for path in paths):
                raise ValueError("Constrained TIGER returned an out-of-catalog path")
            addresses.extend(path["address"] for path in paths)
            scores.extend(path["score"] for path in paths)
            offsets.append(len(addresses))
            if index % 2000 == 0:
                print(f"fresh native predictions {index}/{len(queries)}", flush=True)
        targets = np.array([q["items"][-1] for q in queries])
        models.raw = {"query_index": np.arange(len(queries)),
            "user_index": np.array([q["user_index"] for q in queries]),
            "session_index": np.array([q["session_index"] for q in queries]),
            "target_item_index": targets, "target_address_sids": models.letter.sid_table[targets],
            "prediction_offsets": np.array(offsets), "predicted_address_sids": np.array(addresses),
            "prediction_scores": np.array(scores), "prediction_catalog_validity": np.ones(len(scores), dtype="bool")}
        validate_raw_predictions(models.raw, models.universe, models.letter.sid_table)
        models.raw_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = models.raw_path.with_name("raw_predictions.tmp.npz")
        np.savez_compressed(temporary, **models.raw)
        temporary.replace(models.raw_path)
        models.provenance["raw_predictions_sha256"] = sha(models.raw_path)
        models.provenance["raw_query_target_alignment"] = True
    raw = models.raw
    totals = {"traditional": {"recall": 0., "ndcg": 0.}, "sid": {"recall": 0., "ndcg": 0.}, "cce": {"recall": 0., "ndcg": 0.},
              **{name: {"recall": 0., "ndcg": 0.} for name in STRATEGIES}}
    for index, query in enumerate(models.universe["test"]):
        start, stop = raw["prediction_offsets"][index:index + 2]
        order = np.argsort(-np.where(raw["prediction_catalog_validity"][start:stop], raw["prediction_scores"][start:stop], -1000.), kind="stable")
        paths = [{"address": raw["predicted_address_sids"][start+i].tolist(), "score": float(raw["prediction_scores"][start+i])} for i in order]
        history, target = query["items"][:-1], query["items"][-1]
        shelves, _ = models.shelves(history, paths)
        values = metric_values(paths, models.groups, raw["target_address_sids"][index], target, shelves)
        ranking, _ = models.sasrec.rank(0, history_items=history)
        hit = np.flatnonzero(ranking[:5] == target)
        values["traditional"] = {"recall": float(bool(len(hit))), "ndcg": float(1 / np.log2(hit[0] + 2)) if len(hit) else 0.}
        for name in totals:
            metric = values["item"][name] if name in STRATEGIES else values[name]
            for key in metric:
                totals[name][key] += metric[key]
        if index % 2000 == 0:
            print(f"benchmark {index}/{len(models.universe['test'])}", flush=True)
    count = len(models.universe["test"])
    result = {"cutoff": 5, "query_count": count, "excluded_queries": 0,
              "cohort": "All 22,363 held-out queries in the frozen Beauty study; full 12,068-item catalog (including train-unseen catalog items)",
              "protocol": "Per-user leave-last-out, last-item target; historical study protocol, not a global temporal split",
              "semantics": "Cornac 3.1 compact valid distinct complete SIDs; CCE uniform bucket expansion; item metrics use the selected shelf policy",
              "contexts": models.provenance["contexts"], "provenance": models.provenance,
              "metrics": {name: {key: value / count for key, value in values.items()} for name, values in totals.items()}}
    write(output, result)
    return result


def same_bucket_probe(models, states, seeds):
    """Verify an actual collision counterfactual without relying on the cache."""
    if models.sid_name != "letter":
        return None
    for seed in seeds:
        root = states[seed["id"]]
        by_address = {}
        for cards in root["shelves"].values():
            for card in cards:
                by_address.setdefault(tuple(card["address"]), set()).add(card["item"])
        for address, items in by_address.items():
            if len(items) < 2:
                continue
            first, second = sorted(items)[:2]
            histories = [root["history"] + [item] for item in (first, second)]
            with models.torch.no_grad():
                predictions = [models.letter.predict_semantic_ids(history) for history in histories]
            if not np.array_equal(predictions[0].address_sids, predictions[1].address_sids):
                raise ValueError("Same-SID LETTER histories unexpectedly encode differently")
            np.testing.assert_allclose(predictions[0].scores, predictions[1].scores, atol=1e-6, rtol=1e-6)
            children = [states[history_id(history)] for history in histories]
            return {"seed": seed["id"], "items": [first, second], "address": list(address),
                    "native_addresses_equal": True, "native_scores_equal_within": 1e-6,
                    "traditional_top5_equal": [c["item"] for c in children[0]["traditional"]] == [c["item"] for c in children[1]["traditional"]],
                    "cosine_top5_equal": [c["item"] for c in children[0]["shelves"]["one_cosine"]] == [c["item"] for c in children[1]["shelves"]["one_cosine"]]}
    raise ValueError("No selectable same-bucket alternative found for LETTER")


def migrate_legacy_provenance(provenance):
    """Rename schema-1 SASRec-only keys to the generic writer order; new records pass through."""
    if "sasrec_checkpoint_sha256" not in provenance:
        return provenance
    migrated = {}
    for key, value in provenance.items():
        migrated["traditional_checkpoint_sha256" if key == "sasrec_checkpoint_sha256" else key] = value
        if key == "universe_sha256":
            migrated["traditional_model"] = "SASRec"
    return migrated


def migrate_legacy_qualification(qualification):
    """Schema-1 receipts passed the same traditional-checkpoint gate before it was recorded."""
    migrated = []
    for receipt in qualification:
        row = {}
        for key, value in receipt.items():
            row[key] = value
            if key == "native_paths_reproduced" and "traditional_checkpoint_qualified" not in receipt:
                row["traditional_checkpoint_qualified"] = True
        migrated.append(row)
    return migrated


def pair_rank(pair_id):
    traditional, sid = pair_id.rsplit("-", 1)
    return TRADITIONAL_ORDER.index(traditional), SID_ORDER.index(sid)


def build_manifest(pairs, catalog_items):
    """Schema 2: provenance, qualification, validation and seconds live only on their own pair."""
    pairs = sorted(pairs, key=lambda row: pair_rank(row["id"]))
    return {"schema_version": 2, "dataset": "Amazon Beauty 2014", "catalog_items": catalog_items,
            "execution": "Model outputs computed offline; your choices follow prepared recommendation paths",
            "max_choices": 2, "strategies": list(STRATEGIES),
            "pairs": pairs,
            "pending_models": [name for name in ["BERT4Rec (MLM)", "TIGER", "RPG", "DiffGRM"]
                               if name not in {label for row in pairs for label in (row["sid"], row["traditional"])}],
            "exporter_sha256": sha(__file__), "resolver_sha256": sha(HERE / "journeys.py"),
            "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "totals": {"pairs": len(pairs), "states": sum(row["validation"]["states"] for row in pairs),
                       "transitions": sum(row["validation"]["transitions"] for row in pairs)},
            "release_status": "Local research assets; public redistribution review pending"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    # Required: only promote_journeys.py replaces the reviewed web/public/journeys.
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--skip-benchmark", action="store_true")
    parser.add_argument("--sid", choices=("letter", "rpg", "diffgrm", "tiger"), default="letter")
    parser.add_argument("--sid-checkpoint", type=Path)
    parser.add_argument("--traditional", choices=("sasrec", "bert-mlm"), default="sasrec")
    parser.add_argument("--traditional-checkpoint", type=Path)
    args = parser.parse_args()
    started = time.monotonic()
    models = BeautyModels(args.sid, args.traditional, args.traditional_checkpoint, args.sid_checkpoint)
    qualification = models.qualify()
    pair = f"{args.traditional}-{args.sid}"
    roots, seeds, states = [], [], {}
    for query_id, label in ((145, "Explore a beauty routine"), (210, "Try a different direction")):
        row = next(q for q in models.bundle["queries"] if q["query_index"] == query_id)
        identifier = history_id(row["history_item_indices"])
        roots.append(identifier)
        seeds.append({"id": identifier, "query_index": query_id, "label": label,
                      "selection": "Deliberately selected resolver-disagreement case; not a representative shopper"})
    queue = deque((next(q for q in models.bundle["queries"] if q["query_index"] == seed["query_index"])["history_item_indices"], 0) for seed in seeds)
    while queue:
        history, depth = queue.popleft()
        identifier = history_id(history)
        if identifier in states:
            continue
        node = models.state(history)
        if depth < 2:
            choices = sorted({card["item"] for cards in [node["traditional"], *node["shelves"].values()] for card in cards})
            node["next"] = {str(item): history_id(history + [item]) for item in choices}
            queue.extend((history + [item], depth + 1) for item in choices)
        states[identifier] = node
        write(args.output / pair / "states" / f"{identifier}.json", node)
        if len(states) % 50 == 0:
            print(f"exported {len(states)} states; {len(queue)} queued", flush=True)
    validation = validate_graph(states, roots)
    benchmark_path = args.output / pair / "benchmark.json"
    if args.skip_benchmark:
        saved = json.loads(benchmark_path.read_text())
        # Exporter self-hashes legitimately differ across generations; everything else must match.
        saved_provenance = migrate_legacy_provenance(saved["provenance"])
        if ({key: value for key, value in saved_provenance.items() if key != "exporter_sha256"}
                != {key: value for key, value in models.provenance.items() if key != "exporter_sha256"}):
            raise ValueError("Saved benchmark provenance differs")
        saved["provenance"] = models.provenance
        write(benchmark_path, saved)
    else:
        benchmark(models, benchmark_path)
    write(args.output / "catalog.json", models.bundle["items"])
    manifest_path = args.output / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    pair_record = {"id": pair, "traditional": models.traditional_label, "sid": models.sid_label, "seeds": seeds,
                   "contexts": models.provenance["contexts"], "state_count": len(states),
                   "benchmark": f"{pair}/benchmark.json", "provenance": models.provenance,
                   "qualification": qualification, "validation": validation,
                   "same_bucket_probe": same_bucket_probe(models, states, seeds),
                   "seconds": time.monotonic() - started}
    pairs = [row for row in previous.get("pairs", []) if row["id"] != pair] + [pair_record]
    write(args.output / "manifest.json", build_manifest(pairs, len(models.bundle["items"])))
    if pair == "sasrec-letter":
        write(args.output / "benchmark.json", json.loads(benchmark_path.read_text()))
    print(json.dumps({"status": "passed", **validation, "seconds": pair_record["seconds"]}), flush=True)


if __name__ == "__main__":
    main()
