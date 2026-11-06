"""Package finalized CPU predictions; never train or submit a job."""

import ast
import gzip
import json
from pathlib import Path

import numpy as np

from sasrec_asset import load_sasrec_asset, sha, write


def main():
    directory = Path(__file__).parent
    root = directory.resolve().parents[1]
    source = root / "runs/www2027-demo-sasrec-beauty-2026-10-25/asset"
    assets = directory / "assets"
    replay = json.loads((source / "predictions.json").read_text())
    tiger = json.loads((assets / "tiger-replay.json").read_text())
    final = json.loads((source / "cpu-finalization.json").read_text())
    progress = json.loads((source / "progress.json").read_text())
    _, model_asset = load_sasrec_asset(source / "selected.pt")
    items = json.loads((assets / "item-ids.json").read_text())
    assert model_asset["item_ids"] == items
    assert replay["universe_sha256"] == tiger["universe_sha256"]
    assert progress["completed_validation_epoch"] == 200
    for original, paired in zip(tiger["queries"], replay["queries"], strict=True):
        for key in ("query_index", "target_item_index", "history_item_indices"):
            assert original[key] == paired[key]
        assert np.isfinite(paired["scores"]).all()
        for key in ("user_index", "session_index", "evaluation_position"):
            paired[key] = original[key]
    write(assets / "sasrec-replay.json", replay)
    config = json.loads((source / "config.json").read_text())
    write(assets / "sasrec-recipe.json", config)
    per_query = {"recall": [], "ndcg": []}
    for query in replay["queries"]:
        ranked = query["ranked_item_indices"]
        rank = ranked.index(query["target_item_index"]) + 1 if query["target_item_index"] in ranked else float("inf")
        per_query["recall"].append([float(rank <= k) for k in (5, 10, 20)])
        per_query["ndcg"].append([float(1 / np.log2(rank + 1)) if rank <= k else 0.0 for k in (5, 10, 20)])
    write(assets / "sasrec-metrics.json", {"scope": "12 selected cases only, not aggregate quality",
          "cutoffs": [5, 10, 20], "definition": "single true item, full-catalog ranking; Recall=hit, NDCG=discounted hit",
          "per_query": per_query})
    wanted = {items[item] for query in replay["queries"] for item in query["ranked_item_indices"]}
    titles = {}
    metadata = root / ".cache_data/amazon_review/meta_beauty_2014.json.gz"
    with gzip.open(metadata, "rt") as stream:
        for line in stream:
            row = ast.literal_eval(line)
            if row.get("asin") in wanted and row.get("title"):
                titles[row["asin"]] = row["title"]
    write(assets / "sasrec-titles.json", titles)
    names = ("sasrec-replay.json", "sasrec-recipe.json", "sasrec-metrics.json", "sasrec-titles.json")
    write(assets / "sasrec-provenance.json", {
        "finalized": True, "purpose": "one fixed real Beauty demo fit; selected cases are not a benchmark comparison",
        "scheduler": {"job": 338147, "state": "FAILED", "elapsed": "00:43:28", "exit_code": "1:0",
                      "reason": "all 200 training epochs completed; submitted export loader failed; recovered with CPU-only finalizer"},
        "training_complete": True, "completed_validation_epoch": 200,
        "selected_epoch": final["selected_epoch"], "validation_ndcg10": final["validation_ndcg10"],
        "test_used_for_selection": False, "cpu_weights_only_reload": True,
        "checkpoint_sha256": final["checkpoint_sha256"],
        "external_checkpoint": str(source / "selected.pt"), "checkpoint_bytes": (source / "selected.pt").stat().st_size,
        "universe_sha256": replay["universe_sha256"], "catalog_order_exact": True, "paired_queries": 12,
        "source_config_sha256": sha(source / "config.json"), "cpu_finalizer_sha256": sha(directory / "sasrec_asset.py"),
        "files": {name: sha(assets / name) for name in names},
    })
    print(json.dumps({"paired_queries": len(replay["queries"]), "selected_epoch": final["selected_epoch"],
                      "checkpoint_bytes": (source / "selected.pt").stat().st_size}))


if __name__ == "__main__":
    main()
