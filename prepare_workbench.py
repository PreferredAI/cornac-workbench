"""Prepare portable diagnostic cases from qualified traces; never train a model."""

import ast
import gzip
import hashlib
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).parent
SOURCE = ROOT / "papers/ecir2027-replicability/artifact-bundle"
QUALIFIED = ROOT / "runs/www2027-demo-qualification-2026-10-26"
OUTPUT = HERE / "workbench-assets"


def load(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def arrays(path):
    with np.load(path, allow_pickle=False) as archive:
        return {key: archive[key] for key in archive.files}


def unit(values):
    values = np.asarray(values, dtype="float64")
    norms = np.linalg.norm(values, axis=1, keepdims=True)
    return np.divide(values, norms, out=np.zeros_like(values), where=norms != 0)


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def build_bundle():
    from workbench import address_key, canonical, compare

    qualified = load(QUALIFIED / "qualification.json")
    for name, receipt in qualified["source_files"].items():
        if sha(SOURCE / name) != receipt["sha256"]:
            raise ValueError(f"Qualified source changed: {name}")
    universe_path = ROOT / "runs/beauty-search-2026-09-14/matched_universe.json"
    if sha(universe_path) != qualified["universe_sha256"]:
        raise ValueError("Canonical query universe changed")
    universe = load(universe_path)
    selected = qualified["selected_query_indices"]
    resolver = arrays(SOURCE / "data/beauty/resolver-inputs.npz")
    features = unit(resolver["features"])
    profiles = np.zeros((int(resolver["num_users"]), features.shape[1]))
    order = np.argsort(resolver["train_users"], kind="stable")
    users, starts = np.unique(resolver["train_users"][order], return_index=True)
    for user, start, stop in zip(users, starts, np.r_[starts[1:], len(order)]):
        profiles[user] = features[resolver["train_items"][order[start:stop]]].sum(axis=0)
    profiles = unit(profiles)
    popularity = np.bincount(resolver["train_items"], minlength=len(universe["items"]))
    titles = {}
    with gzip.open(ROOT / ".cache_data/amazon_review/meta_beauty_2014.json.gz", "rt") as stream:
        for line in stream:
            value = ast.literal_eval(line)
            if value.get("asin") and value.get("title"):
                titles[value["asin"]] = value["title"]
    items = {str(i): {"item_index": i, "item_id": item, "title": titles.get(item, item),
                      "training_count": int(popularity[i])} for i, item in enumerate(universe["items"])}
    bundle = {"schema_version": 1,
              "scope": {"label": "18 selected walkthrough cases; not a representative model-quality benchmark",
                        "source_query_count": 22363, "selected_query_count": len(selected),
                        "selection_categories": qualified["selection_categories"],
                        "dataset": "Amazon Beauty 2014", "catalog_items": len(items),
                        "execution": "prepared model predictions; live resolver selection and metric reconstruction"},
              "resolver_contract": {"policies": ["popularity", "history_cosine"],
                                    "popularity": "training event count; no validation/test events",
                                    "history_cosine": "frozen raw ST5 item features; float64 L2 row normalization; L2-normalized sum of training item vectors including repeats; dot product",
                                    "score_scope": "within predicted complete-address group",
                                    "score_execution": "training-derived member scores frozen at preparation; selected policy applied at runtime",
                                    "ties": "smallest global item index", "zero_profile": "all cosine scores zero",
                                    "slots": "invalid and repeated addresses consume empty slots",
                                    "cce": "expected item credit after collision-group expansion; not a one-item resolver"},
              "items": items, "models": {}, "queries": [],
              "provenance": {"universe_sha256": qualified["universe_sha256"],
                             "source_files": qualified["source_files"],
                             "attribution": "Saved SID predictions and evaluation methods reused from the authors' ECIR work; browser/diagnostic system is separate work",
                             "redistribution": "local research-source assets; original data terms and public release review pending",
                             "preparer_sha256": sha(__file__), "engine_sha256": sha(HERE / "workbench.py"),
                             "qualifier_sha256": sha(QUALIFIED / "qualify.py")}}
    raw_models = {}
    for name in qualified["source_models"]:
        folder = SOURCE / "data/beauty" / name
        catalog = arrays(folder / "sid_catalog.npz")
        raw = arrays(folder / "raw_predictions.npz")
        groups = {}
        for item, address in zip(catalog["item_indices"], catalog["address_sids"]):
            groups.setdefault(address_key(address), []).append(int(item))
        config = load(SOURCE / "configs/confirmation" / f"{name}.json")
        is_letter = name.startswith("letter")
        params = config["model"]["params"] if is_letter else config["params"]
        context = {"max_items": params.get("max_len"), "status": "explicit confirmation configuration"}
        if not is_letter:
            # The historic source snapshot, not the mutable working-tree default.
            source = Path("/common/scratch/users/d/dinhhieudo/cornac/paper-r-beauty-deadline-tiger-openai-2026-10-12-v4/source/cornac/models/tiger/recom_tiger.py")
            study = load(SOURCE / "configs/tiger-openai-study.json")
            expected = study["source_hashes"]["cornac/models/tiger/recom_tiger.py"]
            if sha(source) != expected:
                raise ValueError("TIGER frozen source identity changed")
            tree = ast.parse(source.read_text())
            ctor = next(node for node in ast.walk(tree) if isinstance(node, ast.FunctionDef) and node.name == "__init__")
            defaults = dict(zip([arg.arg for arg in ctor.args.args][-len(ctor.args.defaults):], ctor.args.defaults))
            context = {"max_items": ast.literal_eval(defaults["max_len"]),
                       "status": "default verified in hash-matched historic source snapshot",
                       "source_sha256": expected}
        bundle["models"][name] = {"id": name, "label": "LETTER" if is_letter else "TIGER",
                                  "seed": 2025, "tokenization_features": "OpenAI",
                                  "resolver_features": "common raw ST5", "context": context,
                                  "ranking_contract": "letter_stable_score_v1" if is_letter else "raw_slots_v1",
                                  "ranking_description": "stable descending score; historical invalid-score sentinel -1000" if is_letter else "raw decoder slots unchanged",
                                  "decoder_budget": 20 if is_letter else 50,
                                  "checkpoint_selection_objective": str(raw["checkpoint_selection_objective"]),
                                  "recipe": config, "catalog_hash": str(catalog["stable_hash"]),
                                  "catalog_summary": qualified["source_models"][name], "groups": groups}
        raw_models[name] = raw
    baseline = load(QUALIFIED / "sasrec-slice.json")
    baseline_rows = {row["query_index"]: row for row in baseline["queries"]}
    bundle["baseline"] = {"id": "sasrec", "label": "SASRec", "context": {"max_items": 50, "status": "qualified portable checkpoint config"},
                          "recipe": load(HERE / "assets/sasrec-recipe.json"),
                          "checkpoint_sha256": baseline["checkpoint_sha256"], "candidate_universe": "full 12068-item catalog", "exported_top_k": 20}
    for index in selected:
        row = universe["test"][index]
        history = row["items"][:-1]
        baseline_row = baseline_rows[index]
        if (baseline_row["history_item_indices"], baseline_row["target_item_index"]) != (history, row["items"][-1]):
            raise ValueError("SASRec query identity differs")
        query = {"query_index": index, "user_index": row["user_index"], "session_index": row["session_index"],
                 "history_item_indices": history, "target_item_index": row["items"][-1],
                 "categories": [name for name, indices in qualified["selection_categories"].items() if index in indices],
                 "history_cosine_scores": (features @ profiles[row["user_index"]]).tolist(),
                 "sasrec": {"ranked_item_indices": baseline_row["ranked_item_indices"], "scores": baseline_row["scores"],
                             "effective_history_item_indices": history[-50:]}, "runs": {}}
        for name, raw in raw_models.items():
            start, stop = raw["prediction_offsets"][index:index + 2]
            query["runs"][name] = {"target_address": raw["target_address_sids"][index].tolist(),
                                   "recorded_history_start_position": int(raw["history_start_position"][index]),
                                   "recorded_history_end_position": int(raw["history_end_position"][index]),
                                   "effective_history_item_indices": history[-bundle["models"][name]["context"]["max_items"]:],
                                   "raw_paths": [{"address": address.tolist(), "score": float(score), "valid": bool(valid)}
                                                 for address, score, valid in zip(raw["predicted_address_sids"][start:stop], raw["prediction_scores"][start:stop], raw["prediction_catalog_validity"][start:stop])]}
        bundle["queries"].append(query)
    oracle = load(QUALIFIED / "selected-oracle-metrics.json")
    for name in bundle["models"]:
        for row, index in enumerate(selected):
            for column, cutoff in enumerate((5, 10, 20)):
                result = compare(bundle, index, name, cutoff)
                for policy in ("popularity", "history_cosine"):
                    values = result["policies"][policy]["metrics"]
                    for view, key in (("sid", "native_sid"), ("cce", "uniform_expected"), ("item", "popularity" if policy == "popularity" else "score")):
                        expected = oracle["models"][name][key][row]
                        np.testing.assert_allclose([values[view]["hit"], values[view]["ndcg"]], [expected[column], expected[column + 3]], rtol=0, atol=1e-12)
    OUTPUT.mkdir(exist_ok=True)
    payload = canonical(bundle).encode()
    with (OUTPUT / "bundle.json.gz").open("wb") as stream:
        with gzip.GzipFile(filename="", mode="wb", fileobj=stream, mtime=0) as compressed:
            compressed.write(payload)
    receipt = {"status": "passed", "schema_version": 1, "queries": len(selected), "models": list(bundle["models"]),
               "bundle_sha256": sha(OUTPUT / "bundle.json.gz"), "compressed_bytes": (OUTPUT / "bundle.json.gz").stat().st_size,
               "uncompressed_bytes": len(payload), "oracle_tolerance": 1e-12,
               "source_oracle": "qualified evaluator outputs; not runtime metric data", "runtime_dependencies": "Python standard library only",
               "contexts": {name: model["context"] for name, model in bundle["models"].items()},
               "sources": bundle["provenance"]}
    write(OUTPUT / "manifest.json", receipt)
    print(json.dumps({key: receipt[key] for key in ("status", "queries", "compressed_bytes", "uncompressed_bytes", "contexts")}), flush=True)



if __name__ == "__main__":
    build_bundle()
