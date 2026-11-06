"""One fixed-tokenizer TIGER candidate from the approved Beauty budget ledger."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from sasrec_asset import sha


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign", required=True, type=Path)
    args = parser.parse_args()
    ledger = json.loads((args.campaign / "budget.json").read_text())
    index = int(os.environ["SLURM_ARRAY_TASK_ID"])
    entry = next(row for row in ledger["tiger_fits"] if row["index"] == index)
    output = Path(entry["output"])
    if (output / "result.json").exists():
        result = json.loads((output / "result.json").read_text())
        config = json.loads((output / "config.json").read_text())
        if (result["status"] != "complete" or result.get("pilot") or result["test_used_for_selection"]
            or sha(output / "selected.pt") != result["checkpoint_sha256"]
            or any(config[key] != entry[key] for key in ("learning_rate", "dropout", "n_epochs", "val_sample"))):
            raise ValueError("Existing TIGER fit is not an identical verified completed candidate")
        return
    if output.exists():
        raise ValueError("Partial fit exists; preserve it and diagnose before explicit retry")
    subprocess.run([sys.executable, str(Path(__file__).with_name("fit_tiger_asset.py")),
        "--output", str(output), "--epochs", str(entry["n_epochs"]), "--seconds", "6900",
        "--learning-rate", str(entry["learning_rate"]), "--dropout", str(entry["dropout"]),
        "--val-sample", str(entry["val_sample"])], check=True)


if __name__ == "__main__":
    main()
