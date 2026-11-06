"""One fixed Beauty demo fit and a state-dict-only, CPU-loadable inference asset."""

import argparse
from collections import OrderedDict
import hashlib
import inspect
import json
from pathlib import Path
import signal
import time

def sha(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write(path, value):
    Path(path).write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def load_sasrec_asset(path, device="cpu"):
    """Load tensor/config data only; no arbitrary research checkpoint unpickling."""
    import torch
    from cornac.models import SASRec
    from cornac.models.sasrec.sasrec import SASRecModel

    asset = torch.load(path, map_location="cpu", weights_only=True)
    config = dict(asset["config"], device=device, trainable=False)
    wrapper = SASRec(**config)
    wrapper.num_items = len(asset["item_ids"])
    wrapper.pad_idx = wrapper.total_items
    wrapper.iid_map = OrderedDict((item, index) for index, item in enumerate(asset["item_ids"]))
    wrapper.model = SASRecModel(
        item_num=wrapper.total_items, embedding_dim=wrapper.embedding_dim,
        maxlen=wrapper.max_len, n_layers=wrapper.num_blocks, n_heads=wrapper.num_heads,
        use_pos_emb=wrapper.use_pos_emb, use_biases=wrapper.use_biases,
        dropout=wrapper.dropout, pad_idx=wrapper.pad_idx, device=device,
    )
    wrapper.model.load_state_dict(asset["state_dict"], strict=True)
    wrapper.model.eval()
    return wrapper, asset


def finalize(output):
    import torch

    torch.set_num_threads(1)
    restored, asset = load_sasrec_asset(output / "selected.pt", "cpu")
    replay = json.loads((Path(__file__).parent / "assets/tiger-replay.json").read_text())
    if asset["universe_sha256"] != replay["universe_sha256"]:
        raise ValueError("SASRec and TIGER canonical query universe differs")
    predictions = []
    for row in replay["queries"]:
        ranking, scores = restored.rank(0, history_items=row["history_item_indices"])
        predictions.append({"query_index": row["query_index"], "target_item_index": row["target_item_index"],
                            "history_item_indices": row["history_item_indices"],
                            "ranked_item_indices": ranking[:20].tolist(),
                            "scores": scores[ranking[:20]].tolist()})
    write(output / "predictions.json", {"purpose": "prepared real-data inference replay",
          "universe_sha256": asset["universe_sha256"], "queries": predictions})
    write(output / "cpu-finalization.json", {"checkpoint_sha256": sha(output / "selected.pt"),
          "selected_epoch": asset["selected_epoch"], "validation_ndcg10": asset["validation_ndcg10"],
          "cpu_weights_only_reload": True, "paired_queries": len(predictions),
          "test_used_for_selection": False})
    return asset, predictions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--finalize", action="store_true", help="CPU-only export from an existing selected checkpoint")
    args = parser.parse_args()
    if args.finalize:
        finalize(args.output)
        return
    import torch
    import cornac
    import cornac.models.sasrec.recom_sasrec as implementation
    from cornac.eval_methods import NextItemEvaluation
    from cornac.models import SASRec

    root = Path(__file__).resolve().parents[2]
    universe_path = root / "runs/beauty-search-2026-09-14/matched_universe.json"
    expected = "de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21"
    if sha(universe_path) != expected:
        raise ValueError("Frozen canonical Beauty universe changed")
    universe = json.loads(universe_path.read_text())
    args.output.mkdir(parents=True, exist_ok=False)
    config = dict(name="SASRec-Beauty-demo", embedding_dim=128, loss="bce",
                  batch_size=128, learning_rate=5e-4, n_sample=2048, n_epochs=200,
                  max_len=50, num_blocks=2, num_heads=2, dropout=0.2,
                  use_biases=False, device="cuda", model_selection="best",
                  val_eval_every=10, val_metric="ndcg", val_k=10,
                  seed=2025, verbose=True)
    model = SASRec(**config)
    config = {key: getattr(model, key) for key in inspect.signature(SASRec.__init__).parameters if key != "self"}
    write(args.output / "config.json", config)
    def records(split):
        return [(row["user_index"], row["session_index"], universe["items"][item], position)
                for row in universe[split] for position, item in enumerate(row["items"])]
    method = NextItemEvaluation.from_splits(
        train_data=records("train"), val_data=records("validation"), test_data=records("test"),
        fmt="USIT", exclude_unknowns=True, mode="last", seed=2025,
        global_iid_map=OrderedDict((item, i) for i, item in enumerate(universe["items"])),
        global_uid_map=OrderedDict((i, i) for i in range(len(universe["users"]))),
    )
    assert list(method.global_iid_map) == universe["items"]
    # Verify every resulting session after the public dataset constructor.
    for split, dataset in (("train", method.train_set), ("validation", method.val_set), ("test", method.test_set)):
        rows = []
        for [session], [indices], [items] in dataset.si_iter(batch_size=1, shuffle=False):
            rows.append(dict(user_index=int(dataset.uir_tuple[0][indices[0]]),
                             session_index=int(session), items=list(map(int, items))))
        if rows != universe[split]:
            raise ValueError(f"Canonical {split} reconstruction changed")
    torch.set_num_threads(8)
    write(args.output / "provenance.json", {
        "purpose": "single fixed demo asset fit; not a tuned benchmark comparison",
        "universe_sha256": expected, "universe": str(universe_path),
        "cornac": cornac.__version__, "torch": str(torch.__version__),
        "gpu": torch.cuda.get_device_name(), "hard_gpu_hours": 2,
        "source_hashes": {str(path.relative_to(root)): sha(path) for path in (
            Path(__file__).resolve(), root / "cornac/models/sasrec/recom_sasrec.py",
            root / "cornac/models/sasrec/sasrec.py", root / "cornac/models/seq_utils/losses.py")},
    })
    original = implementation.val_score
    best = -float("inf")
    calls = 0
    started = time.monotonic()
    # Local callback shim preserves core validation and periodically persists
    # best CPU tensors, so the scheduler timeout cannot discard all fit progress.
    def validation_checkpoint(wrapper, train, validation, metric="ndcg", k=10):
        nonlocal best, calls
        score = original(wrapper, train, validation, metric=metric, k=k)
        calls += 1
        if score > best:
            best = score
            temporary = args.output / "selected.tmp"
            torch.save({"state_dict": {name: value.detach().cpu() for name, value in wrapper.model.state_dict().items()},
                        "config": config, "item_ids": universe["items"],
                        "universe_sha256": expected, "selected_epoch": calls * config["val_eval_every"],
                        "validation_ndcg10": float(score)}, temporary)
            temporary.replace(args.output / "selected.pt")
        write(args.output / "progress.json", {"completed_validation_epoch": calls * config["val_eval_every"],
              "best_validation_ndcg10": float(best), "seconds": time.monotonic() - started})
        return score
    implementation.val_score = validation_checkpoint
    def deadline(signum, frame):
        raise TimeoutError("Demo fit stopped at 95 minutes to reserve export time")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(5700)
    status = "fit_completed"
    try:
        model.fit(method.train_set, method.val_set)
    except TimeoutError:
        status = "fit_budget_stop"
        if not (args.output / "selected.pt").exists():
            raise
    finally:
        signal.alarm(0)
        implementation.val_score = original
    asset, predictions = finalize(args.output)
    write(args.output / "result.json", {"status": status, "seconds": time.monotonic() - started,
          "checkpoint_sha256": sha(args.output / "selected.pt"),
          "selected_epoch": asset["selected_epoch"], "validation_ndcg10": asset["validation_ndcg10"],
          "cpu_weights_only_reload": True, "paired_queries": len(predictions),
          "test_used_for_selection": False})
    print(json.dumps({"status": status, "output": str(args.output)}), flush=True)


if __name__ == "__main__":
    main()
