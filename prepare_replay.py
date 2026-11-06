"""Qualify and extract a fixed real TIGER case-study slice, without model fitting."""

import ast
import gzip
import hashlib
import json
from pathlib import Path
import shutil

import numpy as np


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def main():
    from cornac.models.semantic_id import SemanticIDTrace
    from cornac.eval_methods.sid_evaluation import evaluate_semantic_id_trace
    from research.sid_addressability.manifests import load_catalog, load_trace

    root = Path(__file__).resolve().parents[2]
    source = root / "runs/paper-r-beauty-deadline-2026-10-12/heldout/tiger-st5-2025"
    universe_path = root / "runs/beauty-search-2026-09-14/matched_universe.json"
    universe_hash = "de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21"
    expected = {"raw_predictions.npz": "b77f81e44c5bfa5f5ccd56d4d6f386d9e973e9d3e05a60fb054e85c9a3650ccf",
                "sid_catalog.npz": "b65fcc417f8a303673bc6773b773f6373e0f1b7c2f08683dcade942ae61f58e7"}
    assert sha(universe_path) == universe_hash
    for name, value in expected.items():
        assert sha(source / name) == value, name
    universe = json.loads(universe_path.read_text())
    catalog = load_catalog(source / "sid_catalog.npz")
    trace, popularity = load_trace(source / "raw_predictions.npz", catalog)
    fit_root = Path("/common/scratch/users/d/dinhhieudo/cornac/paper-r-beauty-deadline-tiger-st5-2026-10-12-v4")
    assert json.loads((fit_root / "item-ids.json").read_text()) == universe["items"]
    assert len(trace.records) == len(universe["test"]) == 22363
    assert len(catalog.item_indices) == len(universe["items"]) == 12068
    np.testing.assert_array_equal(catalog.item_indices, np.arange(12068))
    # Verify every identity before selecting examples; no hit/miss-based selection.
    for row_index, (record, query) in enumerate(zip(trace.records, universe["test"])):
        assert (record.query_index, record.user_index, record.session_index,
                record.target_item_index, record.evaluation_position) == (
                    row_index, query["user_index"], query["session_index"],
                    query["items"][-1], len(query["items"]) - 1)
        assert record.history_end_position == record.evaluation_position
        assert 0 <= record.history_start_position <= record.history_end_position
        assert tuple(catalog.address_sids[record.target_item_index]) == record.target_address_sid
    selected = np.linspace(0, len(trace.records) - 1, 12, dtype=int).tolist()
    records = [trace.records[index] for index in selected]
    subset = SemanticIDTrace(trace.catalog_hash, records, trace.checkpoint_selection_objective,
                             {"purpose": "deterministic real case-study slice; not benchmark quality"})
    evaluated = evaluate_semantic_id_trace(catalog, subset, cutoffs=(5, 10, 20),
                                           resolution_policies=("first",), item_popularity=popularity)
    queries = []
    needed = set()
    for record in records:
        history = universe["test"][record.query_index]["items"][:-1]
        predictions = record.prediction
        resolved = []
        for address in predictions.address_sids:
            members = catalog.address_to_items.get(tuple(map(int, address)), ())
            resolved.append(list(map(int, members)))
        queries.append({
            "query_index": record.query_index, "user_index": record.user_index,
            "session_index": record.session_index, "evaluation_position": record.evaluation_position,
            "history_start_position": record.history_start_position,
            "history_end_position": record.history_end_position,
            "history_item_indices": history,
            "tiger_visible_history_item_indices": history[record.history_start_position:record.history_end_position],
            "target_item_index": record.target_item_index,
            "target_address_sid": list(record.target_address_sid),
            "target_tokenizer_sid": list(record.target_tokenizer_sid),
            "predicted_address_sids": predictions.address_sids.tolist(),
            "prediction_scores": predictions.scores.tolist(),
            "prediction_catalog_validity": predictions.catalog_validity.tolist(),
            "address_to_item_indices": resolved,
        })
        needed.update(history)
        needed.add(record.target_item_index)
        for members in resolved:
            needed.update(members)
    titles = {}
    needed_asins = {universe["items"][index] for index in needed}
    metadata = root / ".cache_data/amazon_review/meta_beauty_2014.json.gz"
    with gzip.open(metadata, "rt") as stream:
        for line in stream:
            value = ast.literal_eval(line)
            if value.get("asin") in needed_asins and value.get("title"):
                titles[value["asin"]] = value["title"]
    output = Path(__file__).parent / "assets"
    output.mkdir(exist_ok=True)
    shutil.copyfile(source / "sid_catalog.npz", output / "sid_catalog.npz")
    write(output / "item-ids.json", universe["items"])
    write(output / "item-popularity.json", popularity.tolist())
    write(output / "titles.json", titles)
    fit_study = json.loads((fit_root / "study.json").read_text())
    fit_result = json.loads((fit_root / "tiger-trial-0/result.json").read_text())
    write(output / "tiger-recipe.json", {
        "attribution": "Existing ECIR'27 under-review study artifact, reused as prepared demo replay",
        "recipe": fit_study["recipe"], "model_config_base": fit_study["model_configs"]["tiger"],
        "effective_seed": 2025, "effective_heldout_beams": 50,
        "selection": "fixed preset; sampled validation NDCG@10; no test selection",
        "checkpoint_sha256": fit_result["selected_sha256"],
        "catalog_reload_exact": fit_result["catalog_reload_exact"],
        "score_reload_close": fit_result["score_reload_close"],
        "fit_study_sha256": sha(fit_root / "study.json"),
        "fit_result_sha256": sha(fit_root / "tiger-trial-0/result.json"),
    })
    write(output / "tiger-replay.json", {
        "schema_version": 1, "mode": "prepared real-data replay",
        "purpose": "12 deterministic case studies, not aggregate recommendation evidence",
        "model": "TIGER-ST5 seed2025", "catalog_hash": catalog.stable_hash,
        "universe_sha256": universe_hash, "selection": "12 evenly spaced query indices, outcome independent",
        "query_indices": selected, "catalog_is_injective": len(catalog.address_to_items) == 12068,
        "resolution": "first; injective complete addresses have exactly one member",
        "raw_slots_preserved": True, "queries": queries,
    })
    # Keep the original implementation's JSON-compatible metrics, not a hand-rolled resolver.
    from research.sid_addressability.manifests import jsonable
    write(output / "tiger-metrics.json", jsonable({key: value for key, value in evaluated.items() if key != "diagnostics"}))
    write(output / "provenance.json", {
        "source_directory": str(source), "source_hashes": expected,
        "canonical_universe": str(universe_path), "universe_sha256": universe_hash,
        "all_query_identity_checks": 22363,
        "item_ids_sha256": sha(fit_root / "item-ids.json"),
        "metadata_sha256": sha(metadata), "metadata_fields_released": ["asin", "title"],
        "reviewer_ids_and_review_text_released": False,
        "license_status": "Research-source reuse; confirm original Amazon dataset terms and attribution before public distribution",
        "evaluation_implementation": "cornac.eval_methods.sid_evaluation.evaluate_semantic_id_trace",
        "evaluation_source_sha256": sha(root / "cornac/eval_methods/sid_evaluation.py"),
        "extractor_sha256": sha(__file__),
        "files": {path.name: {"bytes": path.stat().st_size, "sha256": sha(path)}
                  for path in output.iterdir() if path.is_file() and path.name != "provenance.json"},
    })
    print(json.dumps({"status": "PASS", "verified_queries": 22363, "selected_queries": len(queries),
                      "output_bytes": sum(path.stat().st_size for path in output.iterdir() if path.is_file())}))


if __name__ == "__main__":
    main()
