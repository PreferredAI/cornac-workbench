"""Bounded canonical BERT4Rec pilot on the frozen Beauty universe, no test use."""

import argparse
from collections import OrderedDict
import inspect
import json
from pathlib import Path
import signal
import time

from sasrec_asset import sha

HERE = Path(__file__).parent
ROOT = HERE.resolve().parents[1]
UNIVERSE = ROOT / "runs/beauty-search-2026-09-14/matched_universe.json"


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def load_bert_asset(path, device="cpu"):
    import torch
    from cornac.models import TransformerRec
    from cornac.models.transformer_rec.transformer_rec import TransformerRecModel

    asset = torch.load(path, map_location="cpu", weights_only=True)
    config = dict(asset["config"], device=device, trainable=False)
    if (config["backbone"], config["objective"], config["loss_at"]) != ("bert", "mlm", "all"):
        raise ValueError("Checkpoint is not canonical BERT4Rec")
    wrapper = TransformerRec(**config)
    wrapper.num_items = len(asset["item_ids"])
    wrapper.iid_map = OrderedDict((item, i) for i, item in enumerate(asset["item_ids"]))
    wrapper.pad_idx, wrapper.mask_idx = wrapper.total_items, wrapper.total_items + 1
    wrapper.model = TransformerRecModel(item_num=wrapper.total_items, backbone="bert",
        embedding_dim=wrapper.embedding_dim, maxlen=wrapper.max_len, n_layers=wrapper.num_blocks,
        n_heads=wrapper.num_heads, dropout=wrapper.dropout, device=device)
    wrapper.model.load_state_dict(asset["state_dict"], strict=True)
    wrapper.model.eval()
    wrapper.objective_ = wrapper._build_objective()
    wrapper.objective_.build(wrapper.model, device)
    return wrapper, asset


def make_method(universe):
    from cornac.eval_methods import NextItemEvaluation
    def records(split):
        return [(row["user_index"], row["session_index"], universe["items"][item], position)
                for row in universe[split] for position, item in enumerate(row["items"])]
    method = NextItemEvaluation.from_splits(train_data=records("train"), val_data=records("validation"),
        test_data=records("test"), fmt="USIT", exclude_unknowns=True, mode="last", seed=2025,
        global_iid_map=OrderedDict((item, i) for i, item in enumerate(universe["items"])),
        global_uid_map=OrderedDict((i, i) for i in range(len(universe["users"]))))
    for split, dataset in (("train", method.train_set), ("validation", method.val_set)):
        actual = []
        for [session], [indices], [items] in dataset.si_iter(batch_size=1, shuffle=False):
            actual.append(dict(user_index=int(dataset.uir_tuple[0][indices[0]]), session_index=int(session), items=list(map(int, items))))
        if actual != universe[split]:
            raise ValueError(f"Canonical {split} reconstruction changed")
    return method


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("--config", type=Path, default=ROOT / "papers/cornac-resource/configs/bert-mlm-reference-v1.json")
    args = parser.parse_args()
    if not 1 <= args.epochs <= 100 or not 60 <= args.seconds <= 7200:
        parser.error("Use 1–100 epochs and a 60–7200-second hard limit")
    import numpy as np
    import torch
    from cornac.eval_methods import NextItemEvaluation
    from cornac.models import TransformerRec
    import cornac.models.transformer_rec.recom_transformer_rec as implementation

    torch.set_num_threads(4)
    universe = json.loads(UNIVERSE.read_text())
    expected = "de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21"
    if sha(UNIVERSE) != expected:
        raise ValueError("Frozen universe changed")
    args.output.mkdir(parents=True, exist_ok=False)
    reference = json.loads(args.config.read_text())
    config = dict(reference["parameters"], name="BERT4Rec-canonical-MLM", n_epochs=args.epochs, val_eval_every=1)
    if (config["backbone"], config["objective"], config["loss_at"]) != ("bert", "mlm", "all"):
        raise ValueError("Only canonical BERT4Rec configurations are supported")
    model = TransformerRec(**config)
    config = {key: getattr(model, key) for key in inspect.signature(TransformerRec.__init__).parameters if key != "self"}
    write(args.output / "config.json", config)
    method = make_method(universe)
    source_paths = [Path(__file__).resolve(), ROOT / "cornac/models/transformer_rec/recom_transformer_rec.py",
                    ROOT / "cornac/models/transformer_rec/transformer_rec.py",
                    ROOT / "cornac/models/transformer_rec/objectives.py", ROOT / "cornac/models/seq_utils/objectives.py"]
    sources = {str(path.relative_to(ROOT)): sha(path) for path in source_paths if path.exists()}
    write(args.output / "provenance.json", {"universe_sha256": expected, "source_hashes": sources,
          "reference_sha256": sha(args.config),
          "torch": str(torch.__version__), "gpu": torch.cuda.get_device_name(), "hard_seconds": args.seconds,
          "test_used_for_selection": False,
          "purpose": "timed full-data pilot" if args.epochs <= 2 else "validation-selected capped grid candidate"})
    # Preserve exact source text alongside the receipt for this dirty checkout.
    for relative in sources:
        destination = args.output / "source" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / relative).read_bytes())
    started, best, calls = time.monotonic(), -float("inf"), 0
    original = implementation.val_score
    def save_selected(wrapper, train, validation, metric="ndcg", k=10):
        nonlocal best, calls
        score = original(wrapper, train, validation, metric=metric, k=k)
        calls += 1
        if score > best:
            best = float(score)
            temporary = args.output / "selected.tmp"
            torch.save({"state_dict": {name: value.detach().cpu() for name, value in wrapper.model.state_dict().items()},
                "config": config, "item_ids": universe["items"], "universe_sha256": expected,
                "selected_epoch": calls, "validation_ndcg10": best}, temporary)
            temporary.replace(args.output / "selected.pt")
        write(args.output / "progress.json", {"epoch": calls, "best_validation_ndcg10": best,
              "seconds": time.monotonic() - started})
        return score
    implementation.val_score = save_selected
    def deadline(signum, frame):
        raise TimeoutError("Bounded BERT4Rec pilot reached its hard limit")
    signal.signal(signal.SIGALRM, deadline)
    signal.alarm(args.seconds)
    status = "complete"
    try:
        model.fit(method.train_set, method.val_set)
    except TimeoutError:
        status = "budget_stop"
        if not (args.output / "selected.pt").exists():
            raise
    finally:
        signal.alarm(0)
        implementation.val_score = original
    selected, asset = load_bert_asset(args.output / "selected.pt", "cpu")
    repeated, _ = load_bert_asset(args.output / "selected.pt", "cpu")
    # Validation histories only: no held-out test query is used to select a fit.
    for query in universe["validation"][:2]:
        history = query["items"][:-1]
        rank, scores = selected.rank(0, history_items=history)
        restored, again = repeated.rank(0, history_items=history)
        np.testing.assert_array_equal(rank, restored)
        np.testing.assert_allclose(scores, again, atol=1e-7)
    write(args.output / "result.json", {"status": status, "fit_and_reload_seconds": time.monotonic() - started,
          "completed_epochs": calls, "selected_epoch": asset["selected_epoch"], "validation_ndcg10": best,
          "checkpoint_sha256": sha(args.output / "selected.pt"), "canonical_mlm": True,
          "cpu_weights_only_reload": True, "test_used_for_selection": False,
          "pilot": args.epochs <= 2, "gpu": torch.cuda.get_device_name()})


if __name__ == "__main__":
    main()
