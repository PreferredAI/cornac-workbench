"""Choose four more starting shoppers for the static journeys; write journey-seeds.json.

Queries 145 and 210 stay first. The four new histories come from the held-out cohort:
8 to 20 purchases, enough valid DiffGRM codes, a real next purchase with a photo that
is not already in the history, and a different main category for each. One fills each
case of whether the real next purchase is on LETTER's starting list (one product per
code, closest to the history) and on SASRec's top five.
"""

from collections import Counter
import json
from pathlib import Path
import time

import numpy as np

from journeys import compact_paths, resolve
from prepare_media import read_meta, top_level
from sasrec_asset import load_sasrec_asset

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
UNIVERSE = ROOT / "runs/beauty-search-2026-09-14/matched_universe.json"
SOURCE = ROOT / "papers/ecir2027-replicability/artifact-bundle/data/beauty"
SASREC = ROOT / "runs/www2027-demo-sasrec-beauty-2026-10-25/asset/selected.pt"
OUTPUT = HERE / "journey-seeds.json"
OLD = "Deliberately selected resolver-disagreement case; not a representative shopper"
FIXED = [
    {"query_index": 145, "label": "Makeup & brushes, 16 purchases", "selection": OLD},
    {"query_index": 210, "label": "Mixed, 7 purchases", "selection": OLD},
]
# Every state needs five codes. 5% of the cohort has fewer than 20 valid DiffGRM
# codes, so this floor keeps a margin for the histories that follow a choice.
MIN_DIFFGRM_PATHS = 20
# The DiffGRM checkpoint does not reproduce the stored beams of these queries exactly
# (7337: the beam sets differ from beam 213 on), so prepare_journeys.py cannot qualify
# them (job 358935, 9 Nov 2026).
NOT_REPRODUCED = {7337}
# (target on LETTER's list, target on SASRec's list, selection sentence), in the
# order in which the slots are filled.
SLOTS = [
    (True, False, "LETTER lists the real next purchase and SASRec does not."),
    (False, True, "SASRec lists the real next purchase and LETTER does not."),
    (True, True, "Both lists include the real next purchase."),
    (False, False, "Neither list includes the real next purchase."),
]


def load_raw(name):
    with np.load(SOURCE / f"{name}-openai-2025/sid_catalog.npz") as data:
        addresses = data["address_sids"].tolist()
    groups = {}
    for item, address in enumerate(addresses):
        groups.setdefault(",".join(map(str, address)), []).append(item)
    with np.load(SOURCE / f"{name}-openai-2025/raw_predictions.npz") as data:
        raw = {key: data[key] for key in data.files}
    return groups, raw


def paths(raw, index):
    """Native order used by prepare_journeys.benchmark()."""
    start, stop = raw["prediction_offsets"][index : index + 2]
    valid = raw["prediction_catalog_validity"][start:stop]
    scores = raw["prediction_scores"][start:stop]
    order = np.argsort(-np.where(valid, scores, -1000.0), kind="stable")
    return [
        {
            "address": raw["predicted_address_sids"][start + i].tolist(),
            "score": float(scores[i]),
        }
        for i in order
    ]


def rank(items, target):
    return items.index(target) + 1 if target in items else None


def main_category(history, category):
    counts = Counter(category[item] for item in history)
    name, count = min(counts.items(), key=lambda row: (-row[1], row[0]))
    return name, count / len(history)


def main():
    started = time.time()
    universe = json.loads(UNIVERSE.read_text())
    queries = universe["test"]
    meta = read_meta(set(universe["items"]))
    category = [top_level(meta.get(asin, {})) for asin in universe["items"]]
    photo = [bool(meta.get(asin, {}).get("imUrl")) for asin in universe["items"]]
    diffgrm_groups, diffgrm = load_raw("diffgrm")
    letter_groups, letter = load_raw("letter")
    with np.load(SOURCE / "resolver-inputs.npz", allow_pickle=False) as data:
        features = np.asarray(data["features"], dtype="float64")
        popularity = np.bincount(data["train_items"], minlength=len(features))
    norms = np.linalg.norm(features, axis=1, keepdims=True)
    features = np.divide(features, norms, out=np.zeros_like(features), where=norms != 0)
    import torch

    torch.set_num_threads(2)
    sasrec, _ = load_sasrec_asset(SASREC)

    def describe(index):
        history, target = queries[index]["items"][:-1], queries[index]["items"][-1]
        # LETTER's starting list: one product per code, closest to the history
        # (BeautyModels.scores and .shelves in prepare_journeys.py).
        native = paths(letter, index)
        members = sorted(
            {
                item
                for path in compact_paths(native, letter_groups)[:5]
                for item in letter_groups[path["key"]]
            }
        )
        profile = features[history].sum(axis=0)
        norm = np.linalg.norm(profile)
        if norm:
            profile /= norm
        cosine = dict(zip(members, (features[members] @ profile).tolist()))
        cards = resolve(native, letter_groups, popularity, cosine, "one_cosine")
        ranking, _ = sasrec.rank(0, history_items=history)
        name, share = main_category(history, category)
        return {
            "query_index": index,
            "length": len(history),
            "category": name,
            "share": share,
            "diffgrm_codes": len(compact_paths(paths(diffgrm, index), diffgrm_groups)),
            "letter_rank": rank([card["item"] for card in cards], target),
            "sasrec_rank": rank(ranking[:5].tolist(), target),
        }

    candidates = []
    for index, query in enumerate(queries):
        history, target = query["items"][:-1], query["items"][-1]
        if not 8 <= len(history) <= 20 or target in history or not photo[target]:
            continue
        if index in NOT_REPRODUCED:
            continue
        codes = len(compact_paths(paths(diffgrm, index), diffgrm_groups))
        if codes >= MIN_DIFFGRM_PATHS:
            candidates.append(describe(index))
    print(f"{len(candidates)} candidates after the length, DiffGRM and target filters")

    fixed = [describe(seed["query_index"]) for seed in FIXED]
    taken = {row["category"] for row in fixed}
    used, chosen = set(), []
    for letter_has, sasrec_has, sentence in SLOTS:
        rows = [
            row
            for row in candidates
            if (row["letter_rank"] is not None) == letter_has
            and (row["sasrec_rank"] is not None) == sasrec_has
            and row["category"] not in used
        ]
        # Prefer a main category that the first two histories do not have.
        rows = [row for row in rows if row["category"] not in taken] or rows
        if not rows:
            raise SystemExit(f"No candidate for slot {sentence!r}")
        # The clearest story: the largest share of one category, then the
        # earliest query.
        row = min(rows, key=lambda row: (-row["share"], row["query_index"]))
        used.add(row["category"])
        name = row["category"][0] + row["category"][1:].lower()
        chosen.append(
            dict(row, label=f"{name}, {row['length']} purchases", selection=sentence)
        )

    seeds = FIXED + [
        {key: row[key] for key in ("query_index", "label", "selection")}
        for row in chosen
    ]
    OUTPUT.write_text(json.dumps(seeds, indent=2) + "\n")
    print("query  length  category              share  LETTER  SASRec  DiffGRM")
    for seed, row in zip(seeds, fixed + chosen):
        print(
            f"{row['query_index']:>5}  {row['length']:>6}  {row['category']:<20}"
            f"  {row['share']:>5.2f}  {row['letter_rank']!s:>6}"
            f"  {row['sasrec_rank']!s:>6}  {row['diffgrm_codes']:>7}  {seed['label']}"
        )
    print(f"wrote {OUTPUT.name} in {time.time() - started:.0f} s")


if __name__ == "__main__":
    main()
