"""Run one immutable capped Beauty grid entry; reuse only verified finished fits."""

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
    entry = next(row for row in ledger["fits"] if row["index"] == index)
    output = Path(entry["output"])
    if (output / "result.json").exists():
        result = json.loads((output / "result.json").read_text())
        config = json.loads((output / "config.json").read_text())
        expected = json.loads(Path(entry["config"]).read_text())["parameters"]
        if (result["status"] != "complete" or result.get("pilot") or result["test_used_for_selection"]
            or sha(output / "selected.pt") != result["checkpoint_sha256"]
            or any(config[key] != expected[key] for key in ("learning_rate", "dropout", "n_epochs", "objective"))):
            raise ValueError("Existing fit is not an identical verified completed candidate")
        print(f"Reusing verified candidate {index}")
        return
    if output.exists():
        raise ValueError("Partial fit exists; preserve it and diagnose before explicit retry")
    subprocess.run([sys.executable, str(Path(__file__).with_name("fit_bert_asset.py")),
        "--output", str(output), "--config", entry["config"], "--epochs", "80", "--seconds", "5700"], check=True)


if __name__ == "__main__":
    main()
