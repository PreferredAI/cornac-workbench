"""Train a bounded Beauty TIGER candidate with the frozen injective tokenizer."""

import argparse
from collections import OrderedDict
import json
from pathlib import Path
import signal
import time

from fit_bert_asset import ROOT, UNIVERSE, make_method, write
from sasrec_asset import sha

CATALOG = ROOT / "papers/ecir2027-replicability/artifact-bundle/data/beauty/tiger-openai-2025/sid_catalog.npz"


def load_tiger_asset(path, device="cpu"):
    import numpy as np
    import torch
    from cornac.models import TIGER
    from cornac.models.tiger.tiger import TIGERSeq2Seq

    asset = torch.load(path, map_location="cpu", weights_only=True)
    model = TIGER(**dict(asset["config"], device=device, trainable=False))
    model.num_items = len(asset["item_ids"])
    model.iid_map = OrderedDict((item, i) for i, item in enumerate(asset["item_ids"]))
    model.device_ = device
    model._build_semantic_ids(asset["tokenizer_sids"].numpy())
    model.model = TIGERSeq2Seq(**{key: getattr(model, key) for key in
        ("level_sizes", "d_model", "d_ff", "num_heads", "d_kv", "num_enc_layers", "num_dec_layers", "dropout")}).to(device)
    model.model.load_state_dict(asset["state_dict"], strict=True)
    model.model.eval()
    model.pad_idx = model.total_items
    model.enc_token_table = np.zeros((model.total_items + 1, len(model.level_sizes)), dtype="int64")
    model.enc_token_table[:model.total_items] = model.sid_table + model.model.offsets.cpu().numpy()
    return model, asset


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=2)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("--learning-rate", type=float, default=.001)
    parser.add_argument("--dropout", type=float, default=.1)
    parser.add_argument("--val-sample", type=int, default=256)
    args = parser.parse_args()
    if not 1 <= args.epochs <= 200 or not 60 <= args.seconds <= 10800 or args.val_sample < 1:
        parser.error("Use bounded epochs, validation sample, and a <=3-hour limit")
    import numpy as np
    import torch
    from cornac.models import TIGER

    torch.set_num_threads(4)
    universe = json.loads(UNIVERSE.read_text())
    expected = "de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21"
    if sha(UNIVERSE) != expected:
        raise ValueError("Frozen Beauty universe changed")
    with np.load(CATALOG, allow_pickle=False) as data:
        codes, addresses = data["tokenizer_sids"].copy(), data["address_sids"].copy()
    if len(codes) != len(universe["items"]) or len(set(map(tuple, addresses))) != len(addresses):
        raise ValueError("Frozen TIGER catalog is not aligned and injective")
    args.output.mkdir(parents=True, exist_ok=False)
    config = dict(name="TIGER-Beauty-frozen-OpenAI", d_model=128, d_ff=1024, num_heads=6, d_kv=64,
        num_enc_layers=4, num_dec_layers=4, max_len=20, n_epochs=args.epochs, batch_size=256,
        learning_rate=args.learning_rate, dropout=args.dropout, model_selection="best",
        val_eval_every=1 if args.epochs <= 2 else 5, val_metric="ndcg", val_k=10,
        val_sample=args.val_sample, scoring="beam", n_beams=20, device="cuda", seed=2025,
        rqvae_num_levels=codes.shape[1], rqvae_codebook_size=256)
    write(args.output / "config.json", config)
    model = TIGER(**config, precomputed_semantic_ids=codes)
    method = make_method(universe)
    source_paths = [Path(__file__).resolve(), ROOT / "papers/www2027-demo/fit_bert_asset.py",
                    ROOT / "cornac/models/tiger/recom_tiger.py", ROOT / "cornac/models/tiger/tiger.py"]
    source_hashes = {str(path.relative_to(ROOT)): sha(path) for path in source_paths}
    write(args.output / "provenance.json", {"universe_sha256": expected, "catalog_sha256": sha(CATALOG),
        "source_hashes": source_hashes, "torch": str(torch.__version__), "gpu": torch.cuda.get_device_name(),
        "tokenizer": "frozen existing OpenAI-2025 tokenizer, complete injective addresses reproduced",
        "hard_seconds": args.seconds, "test_used_for_selection": False, "val_sample": args.val_sample,
        "purpose": "full-data timed pilot" if args.epochs <= 2 else "validation-selected capped grid candidate"})
    for relative in source_hashes:
        destination = args.output / "source" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes((ROOT / relative).read_bytes())
    started, calls, best = time.monotonic(), 0, -float("inf")
    original = model._validate
    def validate(sessions, metric):
        nonlocal calls, best
        if not np.array_equal(model.sid_table, addresses):
            raise ValueError("Rebuilt TIGER addresses differ from frozen catalog")
        score = original(sessions, metric)
        calls += 1
        if score > best:
            best = float(score)
            temporary = args.output / "selected.tmp"
            torch.save({"state_dict": {key: value.detach().cpu() for key, value in model.model.state_dict().items()},
                "config": config, "item_ids": universe["items"], "universe_sha256": expected,
                "tokenizer_sids": torch.tensor(codes), "selected_epoch": calls * config["val_eval_every"],
                "validation_ndcg10": best}, temporary)
            temporary.replace(args.output / "selected.pt")
        write(args.output / "progress.json", {"epoch": calls * config["val_eval_every"],
            "best_validation_ndcg10": best, "seconds": time.monotonic() - started})
        return score
    model._validate = validate
    def deadline(signum, frame):
        raise TimeoutError("Bounded TIGER fit reached its hard limit")
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
        model._validate = original
    loaded, asset = load_tiger_asset(args.output / "selected.pt")
    if not np.array_equal(loaded.sid_table, addresses):
        raise ValueError("CPU reload changed complete TIGER addresses")
    for query in universe["validation"][:2]:
        a = loaded.predict_semantic_ids(query["items"][:-1])
        b = loaded.predict_semantic_ids(query["items"][:-1])
        np.testing.assert_array_equal(a.address_sids, b.address_sids)
        np.testing.assert_allclose(a.scores, b.scores, atol=1e-7)
    write(args.output / "result.json", {"status": status, "fit_and_reload_seconds": time.monotonic() - started,
        "completed_validation_epoch": calls * config["val_eval_every"], "selected_epoch": asset["selected_epoch"],
        "validation_ndcg10": best, "checkpoint_sha256": sha(args.output / "selected.pt"),
        "cpu_weights_only_reload": True, "catalog_injective": True, "test_used_for_selection": False,
        "pilot": args.epochs <= 2, "gpu": torch.cuda.get_device_name()})


if __name__ == "__main__":
    main()
