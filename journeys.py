"""Target-free shelf resolution and validation for static recommendation journeys."""

import hashlib
import json
import math

STRATEGIES = ("one_popularity", "one_cosine", "expand_popularity", "expand_cosine")


def history_id(history):
    return hashlib.sha256(json.dumps(list(history), separators=(",", ":")).encode()).hexdigest()[:20]


def compact_paths(paths, groups):
    """Cornac 3.1 semantics: remove invalid/repeated complete IDs before ranking."""
    seen, result = set(), []
    for path in paths:
        key = ",".join(map(str, path["address"]))
        if key in groups and key not in seen:
            seen.add(key)
            result.append({**path, "key": key})
    return result


def resolve(paths, groups, popularity, cosine, strategy, k=5):
    if strategy not in STRATEGIES:
        raise ValueError("Unknown journey strategy")
    scores = popularity if strategy.endswith("popularity") else cosine
    cards = []
    for sid_rank, path in enumerate(compact_paths(paths, groups)[:k], start=1):
        members = sorted(groups[path["key"]], key=lambda item: (-float(scores[item]), item))
        selected = members if strategy.startswith("expand_") else members[:1]
        for member_rank, item in enumerate(selected, start=1):
            cards.append({"item": int(item), "sid_rank": sid_rank, "address": path["address"],
                          "bucket_size": len(members), "member_rank": member_rank,
                          "resolver_score": float(scores[item])})
            if len(cards) == k:
                return cards
    return cards


def metric_values(paths, groups, target_address, target, shelves, k=5):
    """Portable single-target Recall/NDCG; checked against shipped 3.1 in tests."""
    paths = compact_paths(paths, groups)
    target_key = ",".join(map(str, target_address))
    sid_rank = next((i for i, row in enumerate(paths) if row["key"] == target_key), None)
    def item_metrics(items):
        rank = next((i for i, item in enumerate(items) if item == target), None)
        hit = float(rank is not None and rank < k)
        return {"recall": hit, "ndcg": hit / math.log2(rank + 2) if hit else 0.0}
    sid = item_metrics([target if row["key"] == target_key else -1 for row in paths])
    before = sum(len(groups[row["key"]]) for row in paths[:sid_rank]) if sid_rank is not None else 0
    size = len(groups[target_key])
    included = min(size, max(0, k - before)) if sid_rank is not None else 0
    cce = {"recall": included / size,
           "ndcg": sum(1 / math.log2(before + i + 2) for i in range(included)) / size}
    return {"sid": sid, "cce": cce,
            "item": {name: item_metrics([card["item"] for card in cards]) for name, cards in shelves.items()}}


def validate_graph(states, roots, max_choices=2):
    """Every visible choice must advance the exact shared history to a saved state."""
    visited = set()
    def visit(identifier, depth):
        node = states[identifier]
        if history_id(node["history"]) != identifier:
            raise ValueError("State identity differs from history")
        if len(node["traditional"]) != 5 or any(len(cards) != 5 for cards in node["shelves"].values()):
            raise ValueError("A journey needs five cards on every shelf")
        if set(node["shelves"]) != set(STRATEGIES):
            raise ValueError("Missing resolver shelf")
        selectable = {card["item"] for cards in [node["traditional"], *node["shelves"].values()] for card in cards}
        if depth == max_choices:
            if node["next"]:
                raise ValueError("Terminal screen has unexpected transitions")
        else:
            if set(map(int, node["next"])) != selectable:
                raise ValueError("A displayed recommendation has no prepared transition")
            for item in selectable:
                child = node["next"][str(item)]
                if states[child]["history"] != node["history"] + [item]:
                    raise ValueError("Transition changes the shared history")
                visit(child, depth + 1)
        visited.add(identifier)
    for root in roots:
        visit(root, 0)
    if visited != set(states):
        raise ValueError("Export contains unreachable states")
    return {"states": len(states), "transitions": sum(len(node["next"]) for node in states.values()),
            "roots": len(roots), "choices": max_choices}
