# Cornac Workbench

Interactive companion to **Cornac 3.0: An Open-Source Framework and Interactive
Workbench for Sequential and Generative Recommendation** (Jaime Hieu Do,
Trung-Hoang Le, Quoc-Tuan Truong, Hady W. Lauw; WWW 2027 Demo track, under
submission). Cornac itself is at <https://github.com/PreferredAI/cornac>.

**Live journey:** <https://cornac-workbench.preferred.ai>

Start from a real Amazon Beauty history, make two product choices, and compare
SASRec or BERT4Rec with Semantic-ID recommenders (LETTER, TIGER, RPG, DiffGRM)
side by side. Switch among four SID-to-item policies, open colliding SID
buckets, and save and replay the journey. All 3,470 journey states (eight model
pairs) come from offline model inference and are served as static files: no
server, GPU or network is needed at runtime.

![Journey workbench](figures/journeys-paper-desktop.png)

## How it relates to Cornac

Cornac trains and evaluates the models; this repository turns their outputs
into something you can click through.

1. **Exporter** (`prepare_journeys.py`, `journeys.py`): runs offline inference
   with fitted Cornac models on every state a two-choice journey can reach and
   writes a static *bundle* (`manifest.json` plus one `states/` folder per pair).
2. **Viewer** (`web/`): a static React app that only reads a bundle. The hosted
   journey is this viewer plus the Beauty bundle in `web/public/journeys/`.

## Run the journey

Node 24 (tested) with the checked-in lockfile:

```bash
cd web
npm ci
npm run build
python3 -m http.server 8110 --directory dist   # http://127.0.0.1:8110/
```

Any static host works if it serves `web/dist` at a domain root: the build uses
root-absolute `/assets/` and `/journeys/` paths.

## Diagnostic inspector (optional)

The earlier per-query inspector runs on the standard library only:

```bash
python3 -S serve_workbench.py   # http://127.0.0.1:8080/?view=diagnostics
```

It serves `web/dist` plus a local API over `workbench-assets/bundle.json.gz`.
See [workbench-api.md](workbench-api.md).

## Tests

- Python, from the repository root after `npm run build` in `web/` (one
  inspector test serves `web/dist`):
  `python3 -m unittest test_journeys test_workbench -v` (15 journey and 11
  inspector tests). Everything runs on the standard library except one journey
  test that cross-checks against Cornac's evaluator (`pip install "cornac>=3.1"`).
  The inspector's 216-configuration metric oracle is
  [`qualification/selected-oracle-metrics.json`](qualification/selected-oracle-metrics.json).
- Browser (Playwright Chromium, `npx playwright install chromium` once):
  `npm run test:journeys` against the static server on port 8110 (14 checks;
  rewrites `journeys-validation.json` and `figures/journeys-*.png`), and
  `npm run test:browser` against `serve_workbench.py` on port 8080 (17 checks;
  receipt in `web-validation.json`).

## Layout

| Path | Contents |
| --- | --- |
| `web/` | React/Vite app; `web/public/journeys/` is the eight-pair journey bundle (manifest schema 2); `web/design/` is the UI design record |
| `journeys.py`, `prepare_journeys.py`, `promote_journeys.py`, `journeys.md` | Journey export, promotion gates and asset contract |
| `fit_*_asset.py`, `run_*_grid.py`, `finalize_model_campaign.py`, `sasrec_asset.py`, `sasrec-beauty.sbatch`, `asset-run.md` | Offline BERT4Rec / TIGER / SASRec model campaign |
| `assets/`, `prepare_replay.py`, `prepare_sasrec_replay.py` | Model recipes, metrics and replay inputs read by the campaign and inspector scripts |
| `workbench.py`, `serve_workbench.py`, `prepare_workbench.py`, `workbench-assets/`, `qualification/`, `asset-contract.md` | Diagnostic inspector (`?view=diagnostics`) and its qualification evidence |
| `*-validation.json` | QA receipts |

## Preparation scripts are provenance

The exporter, training and preparation scripts record exactly how the bundle
and checkpoints were made. They expect to sit at `papers/www2027-demo/` inside
the authors' Cornac research tree and read checkpoints and data splits from its
`runs/` directory, which is not distributed here. `prepare_workbench.py` and
`prepare_replay.py` also name the original fit directories on the authors'
cluster. Each script's SHA-256 is recorded in what it produced (journey
`exporter_sha256`, `workbench-assets/manifest.json`, `assets/provenance.json`),
so the scripts are kept byte-for-byte as run rather than edited for
portability. The viewer, bundle, inspector and tests above run without them.

## License and data

Code is released under the [Apache License 2.0](LICENSE), as is Cornac. The
journey bundle, `assets/`, `workbench-assets/` and `qualification/` contain
product titles, item identifiers and integer interaction sequences derived from
the Amazon Review Data (2014) Beauty 5-core subset (McAuley et al.); those data
remain subject to that dataset's terms.
