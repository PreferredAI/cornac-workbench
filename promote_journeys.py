"""Promote the gated eight-pair candidate to web/public/journeys, or record its browser review.

finalize_model_campaign.py never replaces public assets; this explicit local step does.
Schema-1 provenance is migrated in place of re-exporting, so every state stays byte-identical.
"""

import argparse
from datetime import date, datetime, timezone
import json
from pathlib import Path
import shutil

from journeys import validate_graph
from prepare_journeys import (PROVENANCE_KEYS, build_manifest, migrate_legacy_provenance,
                              migrate_legacy_qualification, write)
from sasrec_asset import sha

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
EXPECTED = ("sasrec-letter", "sasrec-rpg", "sasrec-diffgrm", "sasrec-tiger",
            "bert-mlm-letter", "bert-mlm-rpg", "bert-mlm-diffgrm", "bert-mlm-tiger")
PENDING = "graph_and_metric_gates_passed_browser_review_pending"
PROMOTED = "promoted_public_assets_replaced_browser_review_pending"
PASSED = "browser_review_passed_public_assets_replaced"
# Export CPU seconds were never stored per pair. Schema-1 pairs: journeys.md (3 Nov 2026);
# the rest: "status": "passed" lines of logs/slurm/beauty-model-finalize-350880.out.
SECONDS = {"sasrec-letter": 172.5, "sasrec-rpg": 99.8, "sasrec-diffgrm": 341.9, "sasrec-tiger": 1611.3,
           "bert-mlm-letter": 1151.0, "bert-mlm-rpg": 107.8, "bert-mlm-diffgrm": 450.9, "bert-mlm-tiger": 105.1}


def relative(path):
    return str(Path(path).resolve().relative_to(ROOT))


def promote(args, ledger):
    if ledger["status"] != PENDING or ledger["public_assets_replaced"]:
        raise ValueError(f"Candidate is not awaiting promotion: {ledger['status']}")
    candidate = args.candidate
    original = json.loads((candidate / "manifest.json").read_text())
    files, migrated_pairs = {}, []
    for pair in original["pairs"]:
        if "sasrec_checkpoint_sha256" in pair["provenance"]:
            migrated_pairs.append(pair["id"])
        pair["provenance"] = migrate_legacy_provenance(pair["provenance"])
        pair["qualification"] = migrate_legacy_qualification(pair["qualification"])
        pair["seconds"] = SECONDS[pair["id"]]
    benchmarks = {}
    for name in [pair["benchmark"] for pair in original["pairs"]] + ["benchmark.json"]:
        saved = json.loads((candidate / name).read_text())
        benchmarks[name] = dict(saved, provenance=migrate_legacy_provenance(saved["provenance"]))
        if benchmarks[name] != saved:
            files[name] = benchmarks[name]
    manifest = build_manifest(original["pairs"], original["catalog_items"])
    files["manifest.json"] = manifest

    # Gates: nothing on disk changes unless every pair passes.
    selection = json.loads((args.campaign / "selection.json").read_text())
    if tuple(pair["id"] for pair in manifest["pairs"]) != EXPECTED or manifest["pending_models"]:
        raise ValueError("Candidate does not contain exactly the eight expected pairs")
    for pair in manifest["pairs"]:
        states = {path.stem: json.loads(path.read_text()) for path in (candidate / pair["id"] / "states").glob("*.json")}
        report = validate_graph(states, [seed["id"] for seed in pair["seeds"]])
        provenance, benchmark = pair["provenance"], benchmarks[pair["benchmark"]]
        if (report != pair["validation"] or report["states"] != pair["state_count"]
                or benchmark["query_count"] != 22363 or benchmark["provenance"] != provenance
                or tuple(provenance) != PROVENANCE_KEYS or provenance["traditional_model"] != pair["traditional"]
                or (pair["id"].startswith("bert-mlm-")
                    and provenance["traditional_checkpoint_sha256"] != selection["bert-mlm"]["checkpoint_sha256"])
                or (pair["id"].endswith("-tiger")
                    and provenance["sid_checkpoint_sha256"] != selection["tiger"]["checkpoint_sha256"])):
            raise ValueError(f"{pair['id']} failed a promotion gate")
    if benchmarks["benchmark.json"] != benchmarks["sasrec-letter/benchmark.json"]:
        raise ValueError("Top-level benchmark is not the default sasrec-letter benchmark")
    if args.backup.exists():
        raise ValueError(f"Backup already exists: {args.backup}")

    for name, value in files.items():
        write(candidate / name, value)
    args.backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(args.public, args.backup)
    shutil.copytree(candidate, args.public)
    ledger.update(status=PROMOTED, public_assets_replaced=True,
                  promoted_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                  backup=relative(args.backup), public_manifest_sha256=sha(args.public / "manifest.json"),
                  provenance_schema_migration={
                      "pairs": migrated_pairs, "files": sorted(files), "manifest_schema_version": 2,
                      "renamed": {"sasrec_checkpoint_sha256": "traditional_checkpoint_sha256"},
                      "inserted": {"traditional_model": "SASRec", "traditional_checkpoint_qualified": True},
                      "states_rewritten": False, "exporter_sha256_preserved": True})
    print(json.dumps({"status": PROMOTED, "totals": manifest["totals"], "migrated": migrated_pairs,
                      "backup": relative(args.backup)}), flush=True)


def record(args, ledger):
    receipt = json.loads(args.record_browser_review.read_text())
    if ledger["status"] not in (PROMOTED, PASSED) or not ledger["public_assets_replaced"]:
        raise ValueError(f"Public assets were not promoted: {ledger['status']}")
    if (not receipt["checks"] or any(check["status"] != "passed" for check in receipt["checks"])
            or receipt["consoleErrors"] or receipt["externalRequests"] or tuple(receipt["pairs"]) != EXPECTED
            or receipt["files"]["web/public/journeys/manifest.json"]["sha256"] != ledger["public_manifest_sha256"]
            or receipt["files"]["web/dist/journeys/manifest.json"]["sha256"] != ledger["public_manifest_sha256"]):
        raise ValueError("Browser review did not pass on the promoted assets")
    if "browser_review" in ledger:  # a re-review after a web change keeps the earlier record
        ledger.setdefault("previous_browser_reviews", []).append(ledger["browser_review"])
    ledger.update(status=PASSED, browser_review={
        "receipt": relative(args.record_browser_review), "sha256": sha(args.record_browser_review),
        "checks": len(receipt["checks"]), "date": receipt["date"]})
    print(json.dumps({"status": ledger["status"], **ledger["browser_review"]}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--candidate", type=Path, help="default: <campaign>/prepared-journeys")
    parser.add_argument("--public", type=Path, default=HERE / "web/public/journeys")
    parser.add_argument("--backup", type=Path,
                        default=ROOT / f"runs/www2027-demo-journeys/public-backup-{date.today().isoformat()}")
    parser.add_argument("--record-browser-review", type=Path, metavar="PATH")
    args = parser.parse_args()
    args.candidate = args.candidate or args.campaign / "prepared-journeys"
    path = args.campaign / "candidate-qualification.json"
    ledger = json.loads(path.read_text())
    (record if args.record_browser_review else promote)(args, ledger)
    path.write_text(json.dumps(ledger, indent=2) + "\n")


if __name__ == "__main__":
    main()
