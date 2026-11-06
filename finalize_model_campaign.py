"""Select completed validation winners and prepare a private static candidate.

This never replaces the reviewed public journey assets or deploys a website.
"""

import argparse
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys

from journeys import validate_graph
from sasrec_asset import sha

HERE = Path(__file__).parent


def select_winner(entries, model):
    eligible, excluded = [], []
    for entry in entries:
        directory = Path(entry["output"])
        try:
            result = json.loads((directory / "result.json").read_text())
            config = json.loads((directory / "config.json").read_text())
            provenance = json.loads((directory / "provenance.json").read_text())
            if (result["status"] != "complete" or result.get("pilot")
                or result["test_used_for_selection"] or provenance["test_used_for_selection"]
                or not result["cpu_weights_only_reload"]
                or not math.isfinite(result["validation_ndcg10"])
                or sha(directory / "selected.pt") != result["checkpoint_sha256"]):
                raise ValueError("Incomplete, unqualified, or changed fit")
            completed = result["completed_epochs"] if model == "bert-mlm" else result["completed_validation_epoch"]
            if completed != config["n_epochs"]:
                raise ValueError("Requested fit did not complete all epochs")
            if model == "bert-mlm":
                expected = json.loads(Path(entry["config"]).read_text())["parameters"]
                if any(config[key] != expected[key] for key in ("learning_rate", "dropout", "n_epochs", "objective")):
                    raise ValueError("Candidate differs from frozen grid entry")
            elif any(config[key] != entry[key] for key in ("learning_rate", "dropout", "n_epochs", "val_sample")):
                raise ValueError("Candidate differs from frozen grid entry")
            eligible.append({"index": entry["index"], "checkpoint": str(directory / "selected.pt"),
                "checkpoint_sha256": result["checkpoint_sha256"], "validation_ndcg10": result["validation_ndcg10"],
                "selected_epoch": result["selected_epoch"], "validation_sample": config.get("val_sample", "all"),
                "selection": "validation NDCG@10; first maximum retained; test never used"})
        except (OSError, KeyError, ValueError) as error:
            excluded.append({"index": entry["index"], "reason": str(error)})
    if not eligible:
        raise ValueError(f"No completed qualified {model} candidate: {excluded}")
    return min(eligible, key=lambda row: (-row["validation_ndcg10"], row["index"])), excluded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    ledger = json.loads((args.campaign / "budget.json").read_text())
    bert, bert_excluded = select_winner(ledger["fits"], "bert-mlm")
    tiger, tiger_excluded = select_winner(ledger["tiger_fits"], "tiger")
    selection = {"bert-mlm": bert, "tiger": tiger,
                 "excluded": {"bert-mlm": bert_excluded, "tiger": tiger_excluded},
                 "test_used_for_selection": False}
    (args.campaign / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
    if args.output is None:
        print(json.dumps(selection))
        return
    # Start from the independently reviewed three-pair bundle. All subsequent
    # changes stay private until browser review and an explicit local promotion.
    if not args.output.exists():
        shutil.copytree(HERE / "web/public/journeys", args.output)
    commands = [("sasrec", "tiger"), *[("bert-mlm", sid) for sid in ("letter", "rpg", "diffgrm", "tiger")]]
    for traditional, sid in commands:
        command = [sys.executable, str(HERE / "prepare_journeys.py"), "--output", str(args.output),
                   "--traditional", traditional, "--sid", sid]
        if traditional == "bert-mlm":
            command += ["--traditional-checkpoint", bert["checkpoint"]]
        if sid == "tiger":
            command += ["--sid-checkpoint", tiger["checkpoint"]]
        subprocess.run(command, check=True)
    manifest = json.loads((args.output / "manifest.json").read_text())
    validations = {}
    for pair in manifest["pairs"]:
        states = {path.stem: json.loads(path.read_text()) for path in (args.output / pair["id"] / "states").glob("*.json")}
        validations[pair["id"]] = validate_graph(states, [seed["id"] for seed in pair["seeds"]])
        benchmark = json.loads((args.output / pair["benchmark"]).read_text())
        if benchmark["query_count"] != 22363 or benchmark["provenance"] != pair["provenance"]:
            raise ValueError("Candidate benchmark provenance/cohort differs")
    (args.campaign / "candidate-qualification.json").write_text(json.dumps({
        "status": "graph_and_metric_gates_passed_browser_review_pending", "selection": selection,
        "pairs": validations, "output": str(args.output), "public_assets_replaced": False}, indent=2) + "\n")


if __name__ == "__main__":
    main()
