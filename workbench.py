"""Portable SID-to-item diagnosis and deterministic replay (standard library only)."""

import argparse
import copy
import gzip
import hashlib
import json
import math
from pathlib import Path

POLICIES = ("popularity", "history_cosine")
CUTOFFS = (5, 10, 20)
DEFAULT_BUNDLE = Path(__file__).parent / "workbench-assets/bundle.json.gz"


def address_key(address):
    return ",".join(map(str, address))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def load_bundle(path=DEFAULT_BUNDLE):
    path = Path(path)
    with gzip.open(path, "rt") if path.suffix == ".gz" else path.open() as stream:
        bundle = json.load(stream)
    if bundle.get("schema_version") != 1:
        raise ValueError("Unsupported workbench bundle version")
    return bundle


def native_order(run, model):
    """Reconstruct the declared model ordering; member resolution is separate."""
    paths = run["raw_paths"]
    if model["ranking_contract"] == "letter_stable_score_v1":
        return sorted(range(len(paths)), key=lambda i: -(paths[i]["score"] if paths[i]["valid"] else -1000.0))
    if model["ranking_contract"] == "raw_slots_v1":
        return list(range(len(paths)))
    raise ValueError("Unsupported native ranking contract")


def member_scores(bundle, query, members, policy):
    """Score only supplied members; this function never reads a held-out target."""
    if policy == "popularity":
        return [bundle["items"][str(item)]["training_count"] for item in members]
    if policy == "history_cosine":
        return [query["history_cosine_scores"][item] for item in members]
    raise ValueError("Unsupported explicit resolver")


def select_member(bundle, query, members, policy):
    scores = member_scores(bundle, query, members, policy)
    if not members or not all(math.isfinite(score) for score in scores):
        raise ValueError("A resolver needs a nonempty group and finite scores")
    return min(zip(members, scores), key=lambda pair: (-pair[1], pair[0]))


def metric(rank, cutoff):
    hit = float(rank is not None and rank < cutoff)
    return {"hit": hit, "ndcg": hit / math.log2(rank + 2) if hit else 0.0}


def evaluate_run(bundle, query, model_id, policy, cutoff=10):
    if policy not in POLICIES or cutoff not in CUTOFFS:
        raise ValueError("Unsupported resolver or cutoff")
    model = bundle["models"][model_id]
    run = query["runs"][model_id]
    order = native_order(run, model)
    groups = model["groups"]
    target = query["target_item_index"]
    target_key = address_key(run["target_address"])
    if target not in groups[target_key]:
        raise ValueError("Target item/address identity does not match catalog")
    slots = []
    seen_addresses, seen_items, observed_addresses = set(), set(), set()
    sid_rank = item_rank = None
    expanded_before, cce_before = 0, None
    for rank, raw_index in enumerate(order):
        path = run["raw_paths"][raw_index]
        key = address_key(path["address"])
        members = groups.get(key, [])
        if path["valid"] != bool(members):
            raise ValueError("Declared prediction validity does not match catalog")
        duplicate = key in observed_addresses
        observed_addresses.add(key)
        if key == target_key and sid_rank is None:
            sid_rank, cce_before = rank, expanded_before
        winner = score = None
        if path["valid"] and not duplicate:
            winner, score = select_member(bundle, query, members, policy)
            if winner in seen_items:
                winner = None
            else:
                seen_items.add(winner)
            seen_addresses.add(key)
            expanded_before += len(members)
        else:
            expanded_before += 1
        if winner == target and item_rank is None:
            item_rank = rank
        slots.append({"rank": rank + 1, "raw_rank": raw_index + 1,
                      "address": path["address"], "model_score": path["score"],
                      "valid": path["valid"], "duplicate": duplicate,
                      "group_size": len(members), "selected_item_index": winner,
                      "selection_score": score, "target_address": key == target_key})
    size = len(groups[target_key])
    included = min(size, max(0, cutoff - cce_before)) if cce_before is not None else 0
    cce = {"hit": included / size,
           "ndcg": sum(1 / math.log2(cce_before + i + 2) for i in range(included)) / size if included else 0.0}
    return {"model_id": model_id, "resolver": policy, "cutoff": cutoff,
            "slots": slots, "metrics": {"sid": metric(sid_rank, cutoff), "cce": cce,
                                             "item": metric(item_rank, cutoff)},
            "target_sid_rank": None if sid_rank is None else sid_rank + 1,
            "target_item_rank": None if item_rank is None else item_rank + 1,
            "target_group_size": size,
            "diagnostics": {"target_sid_absent": sid_rank is None,
                            "sid_hit_item_miss": bool(sid_rank is not None and sid_rank < cutoff and (item_rank is None or item_rank >= cutoff)),
                            "invalid_slots": sum(not row["valid"] for row in slots),
                            "repeated_slots": sum(row["duplicate"] for row in slots),
                            "distinct_valid_addresses": len(seen_addresses)}}


def query_by_id(bundle, query_index):
    return next(row for row in bundle["queries"] if row["query_index"] == int(query_index))


def compare(bundle, query_index, model_id="letter-openai-2025", cutoff=10):
    query = query_by_id(bundle, query_index)
    policies = {policy: evaluate_run(bundle, query, model_id, policy, cutoff) for policy in POLICIES}
    baseline = query["sasrec"]
    target = query["target_item_index"]
    rank = next((i for i, item in enumerate(baseline["ranked_item_indices"]) if item == target), None)
    baseline_result = {**baseline, "metrics": metric(rank, cutoff),
                       "target_item_rank": None if rank is None else rank + 1}
    for result in policies.values():
        selected = [row["selected_item_index"] for row in result["slots"][:cutoff] if row["selected_item_index"] is not None]
        result["sasrec_overlap_count"] = len(set(selected) & set(baseline["ranked_item_indices"][:cutoff]))
    different = [left["rank"] for left, right in zip(policies[POLICIES[0]]["slots"], policies[POLICIES[1]]["slots"])
                 if left["selected_item_index"] != right["selected_item_index"]]
    return {"query_index": query["query_index"], "model_id": model_id, "cutoff": cutoff,
            "categories": query["categories"], "history_item_indices": query["history_item_indices"],
            "effective_history_item_indices": query["runs"][model_id]["effective_history_item_indices"],
            "target_item_index": target, "policies": policies, "sasrec": baseline_result,
            "resolver_disagreement_ranks": different,
            "scope": bundle["scope"]["label"]}


def query_summaries(bundle, model_id="letter-openai-2025", cutoff=10, category="all"):
    rows = []
    for query in bundle["queries"]:
        result = compare(bundle, query["query_index"], model_id, cutoff)
        left, right = (result["policies"][policy] for policy in POLICIES)
        tags = list(query["categories"])
        for name, enabled in {"target_sid_absent": left["diagnostics"]["target_sid_absent"],
                              "sid_hit_item_miss": left["diagnostics"]["sid_hit_item_miss"] or right["diagnostics"]["sid_hit_item_miss"],
                              "resolver_disagreement": bool(result["resolver_disagreement_ranks"]),
                              "collided_target": left["target_group_size"] > 1,
                              "invalid_outputs": left["diagnostics"]["invalid_slots"] > 0,
                              "repeated_outputs": left["diagnostics"]["repeated_slots"] > 0}.items():
            if enabled and name not in tags:
                tags.append(name)
        if category != "all" and category not in tags:
            continue
        rows.append({"query_index": query["query_index"], "categories": tags,
                     "history_length": len(query["history_item_indices"]), "target_item_index": query["target_item_index"],
                     "target_group_size": left["target_group_size"],
                     "sid_hit": left["metrics"]["sid"]["hit"], "cce_hit": left["metrics"]["cce"]["hit"],
                     "popularity_hit": left["metrics"]["item"]["hit"],
                     "history_cosine_hit": right["metrics"]["item"]["hit"],
                     "sasrec_hit": result["sasrec"]["metrics"]["hit"],
                     "resolver_disagreement_count": len(result["resolver_disagreement_ranks"])})
    return rows


def group_members(bundle, query_index, model_id, address, policy="popularity", offset=0, limit=50, search=""):
    if offset < 0 or not 1 <= limit <= 200:
        raise ValueError("Invalid group page")
    query = query_by_id(bundle, query_index)
    members = bundle["models"][model_id]["groups"][address_key(address)]
    winner, _ = select_member(bundle, query, members, policy)
    pop_winner, _ = select_member(bundle, query, members, "popularity")
    cos_winner, _ = select_member(bundle, query, members, "history_cosine")
    scores = member_scores(bundle, query, members, policy)
    pop_scores = member_scores(bundle, query, members, "popularity")
    cos_scores = member_scores(bundle, query, members, "history_cosine")
    pop_by_item = dict(zip(members, pop_scores))
    cos_by_item = dict(zip(members, cos_scores))
    pop_ordered = sorted(zip(members, pop_scores), key=lambda pair: (-pair[1], pair[0]))
    cos_ordered = sorted(zip(members, cos_scores), key=lambda pair: (-pair[1], pair[0]))
    pop_rank_by_item = {item: idx + 1 for idx, (item, _) in enumerate(pop_ordered)}
    cos_rank_by_item = {item: idx + 1 for idx, (item, _) in enumerate(cos_ordered)}
    ordered = sorted(zip(members, scores), key=lambda pair: (-pair[1], pair[0]))
    target = query["target_item_index"]
    target_rank = next((idx + 1 for idx, (item, _) in enumerate(ordered) if item == target), None)
    needle = (search or "").strip().lower()
    ranked_entries = [
        (idx + 1, item, score)
        for idx, (item, score) in enumerate(ordered)
        if not needle
        or needle in bundle["items"][str(item)].get("title", "").lower()
        or needle in str(bundle["items"][str(item)].get("item_id", "")).lower()
    ]
    return {"address": address, "total": len(members), "filtered_total": len(ranked_entries),
            "offset": offset, "limit": limit,
            "selected_item_index": winner,
            "popularity_winner_index": pop_winner,
            "cosine_winner_index": cos_winner,
            "target_member_rank": target_rank,
            "target_popularity_rank": pop_rank_by_item.get(target),
            "target_cosine_rank": cos_rank_by_item.get(target),
            "max_popularity": max(pop_scores) if pop_scores else 0,
            "max_cosine": max(cos_scores) if cos_scores else 0.0,
            "min_cosine": min(cos_scores) if cos_scores else 0.0,
            "members": [{**bundle["items"][str(item)], "item_index": item, "group_rank": group_rank,
                          "resolver_score": score, "popularity_score": pop_by_item[item],
                          "cosine_score": cos_by_item[item],
                          "popularity_rank": pop_rank_by_item[item],
                          "cosine_rank": cos_rank_by_item[item],
                          "selected": item == winner,
                          "selected_by_popularity": item == pop_winner,
                          "selected_by_cosine": item == cos_winner,
                          "is_target": item == target}
                         for group_rank, item, score in ranked_entries[offset:offset + limit]]}


def export_session(bundle, query_index, model_id, cutoff=10):
    query = query_by_id(bundle, query_index)
    portable = {key: copy.deepcopy(bundle[key]) for key in ("schema_version", "scope", "resolver_contract", "items", "provenance", "baseline")}
    portable["models"] = {model_id: copy.deepcopy(bundle["models"][model_id])}
    portable["queries"] = [copy.deepcopy(query)]
    portable["queries"][0]["runs"] = {model_id: copy.deepcopy(query["runs"][model_id])}
    payload = {"schema_version": 1, "selection": {"query_index": int(query_index), "model_id": model_id, "cutoff": cutoff},
               "bundle": portable, "result": compare(portable, query_index, model_id, cutoff)}
    payload["payload_sha256"] = hashlib.sha256(canonical(payload).encode()).hexdigest()
    return payload


def replay_session(payload):
    content = {key: value for key, value in payload.items() if key != "payload_sha256"}
    if hashlib.sha256(canonical(content).encode()).hexdigest() != payload["payload_sha256"]:
        raise ValueError("Session checksum mismatch")
    result = compare(payload["bundle"], **payload["selection"])
    if canonical(result) != canonical(payload["result"]):
        raise ValueError("Reconstructed session differs from exported result")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay", type=Path)
    args = parser.parse_args()
    if args.replay:
        result = replay_session(json.loads(args.replay.read_text()))
        print(json.dumps({"status": "passed", "query_index": result["query_index"], "model_id": result["model_id"]}))
    else:
        print(json.dumps(query_summaries(load_bundle()), indent=2))


if __name__ == "__main__":
    main()
