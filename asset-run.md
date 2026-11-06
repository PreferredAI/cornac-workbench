# One bounded SASRec demo fit

25 October 2026. Authorized scope: one fixed Beauty fit, one GPU, hard two-hour
limit. Job **338147** was submitted with:

```bash
sbatch --parsable papers/www2027-demo/sasrec-beauty.sbatch
```

The job used one `quadro_rtx_8000` GPU, eight CPUs, 32 GB RAM,
`--time=02:00:00` and `--no-requeue` on the authors' Slurm cluster.
No arrays, searches, or additional GPU jobs were submitted.

**Final status:** all 200 training epochs completed in 43:28; best validation
checkpoint was epoch 50 (NDCG@10 0.0549768558). The scheduler recorded `FAILED`
with exit `1:0` because of the submitted worker's export-only loader defect.
CPU finalization succeeded, the paired twelve-query replay was exported, and
real CPU inference matched its frozen rankings/scores. See
[the finalized provenance](assets/sasrec-provenance.json). No retraining was needed.

Recipe: SASRec BCE, embedding128, length50, two blocks/two heads, batch128,
2048 sampled negatives, learning rate5e-4, dropout0.2, seed2025, up to200epochs;
validation NDCG@10 every10epochs. This is one declared demo recipe, not a tuned
comparison. Internal best validation weights are atomically exported as CPU
tensors after each improved validation. A95-minute fit alarm reserves remaining
time for export; the scheduler hard limit remains twohours.

Training, validation, and test datasets are reconstructed from the original
study's immutable canonical universe and every resulting indexed session is
checked for exact equality. All12,068 ASINs retain their original order. This
is the original study protocol, not the newer resource-paper preflight cohort.

Run directory:
`runs/www2027-demo-sasrec-beauty-2026-10-25/`.
`fit-338147.log` is the scheduler log. `asset/` contains configuration,
provenance, progress and periodic `selected.pt`. That checkpoint contains only
CPU state tensors, plain configuration/catalog data, selected epoch/validation
score and universe hash; load with `weights_only=True`, without deserializing
an arbitrary fitted research object. The original submitted worker is preserved
as `submitted-worker.py`; its SHA-256 matches the launch provenance.

## Completed CPU recovery and repeatable finalization

A post-submission loader test found an assignment to Cornac's read-only
`total_items` property in the submitted worker's final export code. The loader
has been fixed and validated on eight synthetic queries, with exact rankings
and score agreement. Training and periodic checkpoint selection are unaffected,
but the running process retains its original code and may fail during final
export. Preserve its fit/checkpoint and run the repaired CPU-only finalizer:

```bash
PYTHONPATH=. MPLCONFIGDIR=/tmp/cornac-www-demo-matplotlib \
  python papers/www2027-demo/sasrec_asset.py \
  --output runs/www2027-demo-sasrec-beauty-2026-10-25/asset --finalize
```

This performs **no training and requests no GPU**. It writes the12query
SASRec replay and `cpu-finalization.json`, checking the canonical universe hash.
Use `load_sasrec_asset(path, device="cpu")` for optional live notebook inference.
Wait for job termination before calling a checkpoint final. While it is running,
any checkpoint represents provisional best-so-far weights.

Scheduler completion, CPU finalization, catalog/query identity checks and the
implemented notebook checks are now recorded in `assets/sasrec-provenance.json`
and `validation.json`. A fresh kernel/browser rehearsal remains pending.
Selected examples must not be described as aggregate model performance. Broad
resource-paper experiments remain deferred.
