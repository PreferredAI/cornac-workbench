#!/usr/bin/env bash
# Fit the Beauty SASRec asset (asset-run.md). Submit from the Cornac research tree root, e.g.
#   sbatch --account=<account> --partition=<partition> papers/www2027-demo/sasrec-beauty.sbatch
# The original run used one Quadro RTX 8000 (--gres=gpu:quadro_rtx_8000:1).
#SBATCH --job-name=cornac-www-demo-sasrec
#SBATCH --gres=gpu:1
#SBATCH --cpus-per-task=8
#SBATCH --mem=32G
#SBATCH --time=02:00:00
#SBATCH --no-requeue
#SBATCH --output=runs/www2027-demo-sasrec-beauty-2026-10-25/fit-%j.log
set -euo pipefail
cd "${SLURM_SUBMIT_DIR:-.}"
export PYTHONPATH=. PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=8 MKL_NUM_THREADS=8
export MPLCONFIGDIR=/tmp/cornac-www-demo-matplotlib
"${PYTHON:-python}" papers/www2027-demo/sasrec_asset.py \
  --output runs/www2027-demo-sasrec-beauty-2026-10-25/asset
