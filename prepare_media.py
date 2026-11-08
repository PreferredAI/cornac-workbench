"""Download product photos and short names for the items in the static journeys.

Also count the top-level categories of every SID bucket that the journeys show.
"""

import argparse
import ast
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import html
import http.client
import io
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
JOURNEYS = HERE / "web/public/journeys"
META = ROOT / ".cache_data/amazon_review/meta_beauty_2014.json.gz"
BUNDLE = HERE / "workbench-assets/bundle.json.gz"
UNIVERSE = ROOT / "runs/beauty-search-2026-09-14/matched_universe.json"
RAW = HERE / "workbench-assets/images-raw"
SID_CATALOGS = ROOT / "papers/ecir2027-replicability/artifact-bundle/data/beauty"
HOST = "https://m.media-amazon.com/images/I/"
AGENT = "cornac-workbench-media/1.0"
MAX_SIDE = 320
VAGUE_LEAVES = frozenset({"Sports", "Face", "Women's", "Men's"})


def load(path):
    return json.loads(Path(path).read_text())


def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value, **options):
    text = json.dumps(value, ensure_ascii=False, allow_nan=False, **options)
    path.write_text(text + "\n")


def referenced_items(manifest):
    items = set()
    for pair in manifest["pairs"]:
        for path in (JOURNEYS / pair["id"] / "states").glob("*.json"):
            state = load(path)
            rows = state["traditional"] + sum(state["shelves"].values(), [])
            for bucket in state["buckets"]:
                rows += bucket["popularity"] + bucket["cosine"]
            items.update(state["history"])
            items.update(row["item"] for row in rows)
    return sorted(items)


def bucket_sizes(manifest):
    sizes = {}
    for pair in manifest["pairs"]:
        found = sizes.setdefault(pair["sid"], {})
        for path in (JOURNEYS / pair["id"] / "states").glob("*.json"):
            for bucket in load(path)["buckets"]:
                key = ",".join(map(str, bucket["address"]))
                found.setdefault(key, set()).add(bucket["size"])
    return sizes


def read_meta(asins):
    meta = {}
    with gzip.open(META, "rt") as stream:
        for line in stream:
            value = ast.literal_eval(line)
            if value.get("asin") in asins:
                meta[value["asin"]] = value
    return meta


def read_catalog():
    """All 12,068 items: web/public/journeys/catalog.json keeps only the shown ones."""
    with gzip.open(BUNDLE, "rt") as stream:
        return json.load(stream)["items"]


def read_targets(manifest):
    target = [query["items"][-1] for query in load(UNIVERSE)["test"]]
    assert target[145] == 2739 and target[210] == 2993
    seeds = [seed for pair in manifest["pairs"] for seed in pair["seeds"]]
    return {seed["id"]: target[seed["query_index"]] for seed in seeds}


def category_path(value):
    return max(value.get("categories") or [[]], key=len)


def top_level(value):
    path = category_path(value)
    return path[1] if len(path) > 1 else "Other"


def top_categories(names, limit=6):
    counts = Counter(names)
    other = counts.pop("Other", 0)
    ranked = sorted(counts.items(), key=lambda row: (-row[1], row[0]))
    if len(ranked) + bool(other) > limit:
        other += sum(count for _, count in ranked[limit - 1 :])
        ranked = ranked[: limit - 1]
    return [list(row) for row in ranked] + ([["Other", other]] if other else [])


def bucket_categories(sid, keys, categories):
    path = SID_CATALOGS / f"{sid.lower()}-openai-2025/sid_catalog.npz"
    with np.load(path, allow_pickle=False) as data:
        assert np.array_equal(data["item_indices"], np.arange(len(categories)))
        addresses = data["address_sids"].tolist()
    groups = {}
    for item, address in enumerate(addresses):
        groups.setdefault(",".join(map(str, address)), []).append(item)
    return {
        key: {
            "size": len(groups[key]),
            "categories": top_categories(categories[item] for item in groups[key]),
        }
        for key in sorted(keys, key=lambda text: tuple(map(int, text.split(","))))
    }


def short_name(brand, category, title):
    path = category[:-1] if category and category[-1] in VAGUE_LEAVES else category
    leaf = path[-1] if path and path[-1] != "Beauty" else ""
    text = f"{brand} {leaf.lower()}" if brand and leaf else " ".join(title.split()[:5])
    if len(text) > 40:
        text = text[:41].rsplit(" ", 1)[0][:40]
    return text.rstrip(" ,;:-&")


def candidates(url):
    if "/images/I/" not in url:
        return []
    name = url.split("/images/I/", 1)[1]
    stripped = re.sub(r"\._[A-Za-z0-9_,]+_(?=\.\w+$)", "", name)
    return list(dict.fromkeys([HOST + stripped, HOST + name]))


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": AGENT})
    for attempt in range(3):
        time.sleep(2 * attempt)
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            if error.code < 500:
                return None
        except (OSError, http.client.HTTPException):
            pass
    return None


def download(asin, url):
    for candidate in candidates(url):
        path = RAW / f"{asin}{Path(candidate).suffix}"
        if path.exists():
            return path.read_bytes()
        data = fetch(candidate)
        if data:
            path.write_bytes(data)
            return data
    return None


def thumbnail(data, path):
    with Image.open(io.BytesIO(data)) as source:
        image = source.convert("RGBA")
    canvas = Image.new("RGB", image.size, "white")
    canvas.paste(image, mask=image)
    canvas.thumbnail((MAX_SIDE, MAX_SIDE), Image.Resampling.LANCZOS)
    canvas.save(path, "WEBP", quality=80, method=6)
    return canvas.size


def describe(index, item, value):
    category = category_path(value)
    brand = html.unescape(value.get("brand") or "").strip()
    if brand.lower() in ("", "generic", "unknown"):
        brand = None
    data = download(item["item_id"], value.get("imUrl", ""))
    image, (width, height) = None, (0, 0)
    if data:
        image = f"thumbs/{index}.webp"
        width, height = thumbnail(data, JOURNEYS / image)
    return {
        "image": image,
        "width": width,
        "height": height,
        "short": short_name(brand, category, html.unescape(item["title"])),
        "brand": brand,
        "category": category,
        "price": value.get("price"),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, help="process only the first N items")
    args = parser.parse_args()
    start = time.time()
    manifest = load(JOURNEYS / "manifest.json")
    catalog = read_catalog()
    targets = read_targets(manifest)
    indices = referenced_items(manifest)
    print(f"{len(indices)} referenced items")
    indices = indices[: args.limit]
    items = {index: catalog[str(index)] for index in indices}
    meta = read_meta({item["item_id"] for item in catalog.values()})
    RAW.mkdir(parents=True, exist_ok=True)
    (JOURNEYS / "thumbs").mkdir(exist_ok=True)
    values = [meta[item["item_id"]] for item in items.values()]
    with ThreadPoolExecutor(8) as pool:
        records = list(pool.map(describe, indices, items.values(), values))
    media = dict(zip(map(str, indices), records))
    categories = [
        top_level(meta.get(catalog[str(index)]["item_id"], {}))
        for index in range(len(catalog))
    ]
    sizes = bucket_sizes(manifest)
    buckets = {
        sid: bucket_categories(sid, keys, categories) for sid, keys in sizes.items()
    }
    mismatches = [
        (sid, key, sorted(seen), buckets[sid][key]["size"])
        for sid, found in sizes.items()
        for key, seen in found.items()
        if seen != {buckets[sid][key]["size"]}
    ]
    for row in mismatches:
        print("bucket size mismatch:", *row)
    assert not mismatches
    assert buckets["LETTER"]["195,184,83,0"]["size"] == 1643

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    source = {"meta_sha256": sha(META), "bundle_sha256": sha(BUNDLE)}
    write(
        JOURNEYS / "media.json",
        {
            "schema_version": 2,
            "generated_at": generated_at,
            "source": source,
            "thumb": {"max_side": MAX_SIDE, "format": "webp"},
            "items": media,
            "targets": targets,
            "buckets": buckets,
        },
        separators=(",", ":"),
    )
    shown = [record for record in records if record["image"]]
    missing = [
        {"item_index": index, "item_id": items[index]["item_id"]}
        for index, record in zip(indices, records)
        if not record["image"]
    ]
    receipt = {
        "generated_at": generated_at,
        "items": len(media),
        "with_image": len(shown),
        "missing": missing,
        "thumb_bytes": sum((JOURNEYS / r["image"]).stat().st_size for r in shown),
        "width_range": [min(r["width"] for r in shown), max(r["width"] for r in shown)],
        "height_range": [
            min(r["height"] for r in shown),
            max(r["height"] for r in shown),
        ],
        **source,
        "targets": targets,
        "buckets": {
            sid: {
                "addresses": len(rows),
                "largest": max(
                    (
                        {"address": key, "size": row["size"]}
                        for key, row in rows.items()
                    ),
                    key=lambda row: row["size"],
                ),
            }
            for sid, rows in buckets.items()
        },
    }
    write(HERE / "media-validation.json", receipt, indent=2)
    print(
        f"{receipt['items']} items, {receipt['with_image']} with image, "
        f"{receipt['thumb_bytes'] / 1e6:.1f} MB, {time.time() - start:.0f} s"
    )
    for row in missing:
        print("no image:", row["item_index"], row["item_id"])


if __name__ == "__main__":
    main()
