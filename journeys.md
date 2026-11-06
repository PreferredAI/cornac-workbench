# Beauty Recommendation Journeys

Implemented 3 November 2026 in the existing WWW demo scope; all eight model
pairs were promoted to the static site on 4 November 2026. The release sections
remain Cornac 2.0 sequential and Cornac 3.0/3.1 generative recommendation;
the primary interaction now follows attendee-selected products.

## Runtime and preparation

Build `web/` with `npm run build`, then serve `web/dist` on any static host.
The journey makes only same-origin JSON/font/script requests and requires no
inference service, GPU, model checkpoint, or Python runtime. For example:

```bash
python -m http.server 8110 --bind 127.0.0.1 --directory papers/www2027-demo/web/dist
```

The existing Python workbench server serves both journeys and the retained
18-case diagnostic inspector at `?view=diagnostics`. The latter still needs
its local API; it is not a static-hosting feature.

Regenerate real model outputs from the canonical checkout on a CPU compute
node. `scripts/slurm/python-job.sbatch` runs the `cn` environment with the
checkout on `PYTHONPATH`. `--output` is required and must be a scratch
directory; only `promote_journeys.py` replaces `web/public/journeys`:

```bash
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 sbatch --job-name=journey-export \
  scripts/slurm/python-job.sbatch papers/www2027-demo/prepare_journeys.py \
  --output runs/<scratch>/journeys --traditional sasrec --sid letter
```

BERT4Rec (MLM) and TIGER exports also take `--traditional-checkpoint` and
`--sid-checkpoint` from `runs/www2027-demo-beauty-models-2026-11-03/selection.json`.
This performs **no training**. It hashes and reloads existing checkpoints,
verifies catalog alignment and reproduces qualified query 145/210 native paths
and rankings before generating branches. The first export took 172.5 CPU
seconds, including the full-cohort evaluation. Each branch receives
actual inference on its displayed history; identical LETTER semantic histories
reuse identical native predictions. Exported metadata contains hashes rather
than machine-specific checkpoint paths.

Eight pairs ship, SASRec then BERT4Rec (MLM), each with LETTER, RPG, DiffGRM
and TIGER in that display order (`TRADITIONAL_ORDER`, `SID_ORDER` in
`prepare_journeys.py`). Every pair has the same two deliberately selected
starting histories (queries 145 and 210), two choices per journey, and its own
fixed full-cohort benchmark, qualification receipt and replay provenance.
Pair switching resets the journey. States and transitions after deduplication,
with export wall-clock seconds on CPU nodes (including the full-cohort
evaluation):

| Pair | States / transitions | Export s |
| --- | --- | --- |
| `sasrec-letter` | 906 / 904 | 172.5 |
| `sasrec-rpg` | 193 / 191 | 99.8 |
| `sasrec-diffgrm` | 411 / 409 | 341.9 |
| `sasrec-tiger` | 211 / 209 | 1,611.3 |
| `bert-mlm-letter` | 924 / 922 | 1,151.0 |
| `bert-mlm-rpg` | 199 / 197 | 107.8 |
| `bert-mlm-diffgrm` | 424 / 422 | 450.9 |
| `bert-mlm-tiger` | 202 / 200 | 105.1 |
| **Total** | **3,470 / 3,454** | |

Existing LETTER, RPG and DiffGRM checkpoints reproduce the stored native paths
on queries 145/210. The newly trained TIGER finalist has no stored oracle, so it
is compared against an independent weights-only reload; `sasrec-tiger` computed
its fresh full-cohort native predictions once and `bert-mlm-tiger` reused them.
Seconds are shared-node wall-clock observations, not a benchmark.
Every card from every strategy is selectable until the final screen. A graph
validator checks exact history extension and complete edge coverage. States
are fetched separately; immediate successors are prefetched and cached.

The comparison uses equal-width desktop columns with five aligned product rows;
columns stack below 760 px. Copy is limited to controls, a precomputed-output
badge and the held-out metric distinction. Resolver/protocol explanations stay
in expandable details; selection updates are announced to screen readers.

## Resolution and metrics contract

All four strategies preserve complete-SID order after Cornac 3.1 compaction of
invalid/repeated addresses. One-per-SID selects one bucket member. Expanded
mode orders all members within each bucket, concatenates the buckets, and
truncates to five items. The ordering score is either training purchase count
or cosine against the normalized sum of normalized ST5 vectors from the entire
visible history, including repeats. Ties use the smallest global item index.
Targets never enter resolver scoring. Zero profiles give zero-score ties.

The bucket inspector shows up to 12 leading members for each resolver with
native address score, bucket size, and member scores. Existing diagnostic
pagination remains available in the local legacy inspector.

The fixed evaluation panel recomputes Item/SID/CCE Recall/NDCG@5 on **all
22,363 original held-out study queries**, using the same 12,068-item catalog,
including train-unseen catalog items. It intentionally does not mix the newer
22,225-query resource cohort. Per-user leave-last-out is the historical study
protocol and does not establish global temporal isolation. Resolver cosine sees
the entire visible prefix. Context limits per pair are in `contexts`: SASRec,
BERT4Rec (MLM), RPG and DiffGRM use up to 50 items; LETTER and TIGER up to 20.
Different context
limits/recipes preclude an architecture-controlled comparison. TIGER pairs show
identical SID, CCE and Item values under every resolver view because TIGER
addresses are injective (one item per SID), so every policy returns the same
items. Hypothetical branches have no observed next target and contain no
accuracy metrics. CCE is a uniform expectation, not either explicit resolver.

Journey export/replay checks model provenance, supported edges, and the exact
saved history against prepared states. It is a replay of this prepared bundle,
not a standalone model inference package. The legacy diagnostic export retains
its independent Python replay workflow.

## Manifest and provenance contract

`manifest.json` is schema 2, written by `build_manifest` in `prepare_journeys.py`.
Top level: `schema_version, dataset, catalog_items, execution, max_choices,
strategies, pairs, pending_models, exporter_sha256, resolver_sha256,
generated_at, totals{pairs,states,transitions}, release_status`. The top-level
hashes identify the code that assembled the manifest. Provenance, qualification
receipts, graph validation and export `seconds` live only on their own pair.
Schema 1 also copied the first pair's provenance and the last export's
qualification, validation and seconds to the top level, mixing pairs.

Each pair's `provenance` has exactly the 13 `PROVENANCE_KEYS` in writer order:
`universe_sha256, traditional_model, traditional_checkpoint_sha256, sid_model,
sid_checkpoint_sha256, raw_predictions_sha256, raw_query_target_alignment,
resolver_inputs_sha256, exporter_sha256, resolver_sha256, torch_version, seed,
contexts`. Its `<pair>/benchmark.json` carries the identical object. Replay
compares a saved journey's provenance with its pair's by string equality
(`Journeys.jsx`), so key order is part of the contract.

Migration, 4 November. The first three pairs (`sasrec-letter`, `sasrec-rpg`,
`sasrec-diffgrm`) were exported with `sasrec_checkpoint_sha256` and without
`traditional_model` or the `traditional_checkpoint_qualified` receipt flag.
`promote_journeys.py` migrated their manifest records, `<pair>/benchmark.json`
and the top-level `benchmark.json` (`migrate_legacy_provenance`,
`migrate_legacy_qualification`) instead of re-exporting them, so every state
file is byte-identical. Exporter hashes were preserved, so three exporter
generations are legitimate: `3a3c605d…` (the three migrated pairs), `e930eaa6…`
(the five campaign pairs), and `f9e70d83…` (the current exporter, which
assembled the manifest). `--skip-benchmark` compares the migrated saved
provenance with the current one, ignoring only `exporter_sha256`, then
re-stamps the saved benchmark. Job 352824 re-exported `sasrec-rpg` this way into
scratch on another CPU host: provenance matched, benchmark metrics and the
catalog were identical, and all 193 state ids, edges, items, orders, bucket
sizes and resolver scores matched exactly. Only float32 model scores differed
(SASRec by at most 1.0e-5, RPG native by 1.2e-6), so re-exports are not
byte-identical across hosts; this is why the migration did not re-export. Journey files saved before the migration carry
the old provenance and fail replay; the site was never deployed, so there is no
compatibility shim.

## Model qualification and capped search

All eight pairs are qualified and shown in the UI; the first is SASRec/LETTER.
The existing generic runner's BERT4Rec CLM-last default must not be mistaken
for the canonical masked objective. The campaign followed these rules:

1. Audit existing Beauty configurations, selection objectives, catalog and source
   identities; preserve qualified winners rather than rerunning a fresh search.
2. Qualify the new TIGER finalist; retain RPG's verified deterministic seeded
   decoding. Audit full-address
   collisions and top-five exposure rather than assuming them from SID length.
3. Fit/tune only missing or failed checkpoints after timed pilots. Reuse recorded
   Beauty search ranges, capped at 12 configurations per traditional model and
   six per SID model, with fixed tokenizer recipes and validation-only selection.
4. Reuse DiffGRM's qualified checkpoint and measured branch-export cost.
   Follow the Slurm budget decision gate before broad jobs.
5. Export each additional qualified model pair as a separate graph; changing
   pairs starts a fresh journey. Never substitute existing unrelated outputs
   for a newly chosen history.

Release (6 November 2026): the companion repository
`PreferredAI/cornac-workbench` is public, with code under Apache-2.0 and the
Amazon-derived data under the original dataset's terms; its
`.github/workflows/deploy.yml` deploys the site to `https://cornac-workbench.preferred.ai`.
The manifest's `release_status` string was written at export time and is kept
as is, because the bundle hashes cover it.

### Capped offline model campaign, 3 November 2026

The user subsequently authorized up to 24 GPU-hours for the missing BERT/TIGER
models. This concerns offline preparation only; website serving remains static.
Campaign ledger: `runs/www2027-demo-beauty-models-2026-11-03/budget.json`.

- BERT pilot 350864 completed 2 full-data epochs plus CPU reload in 118.0 s
  (131 s allocation, .0364 GPUh), validation NDCG@10 = .004664. It is explicitly
  a pilot and cannot be selected by the journey exporter.
- TIGER pilot 350868 completed 2 full-data epochs with 256 fixed validation
  queries in 77.6 s (85 s allocation, .0236 GPUh), validation NDCG@10 = .012228.
  It reproduces the existing full injective OpenAI-2025 address catalog using
  frozen tokenizer codes; no tokenizer fitting is charged or implied.
- BERT grid 350869: LR {.0003, .0005, .001} × dropout {.2, .5}, dim 128,
  80 epochs, full validation NDCG@10 each epoch, 100 min/job, 6 fits,
  maximum 10 GPUh.
- TIGER grid 350872: LR {.0003, .0005, .001} × dropout {.1, .3}, 100 epochs,
  fixed 2,000-query validation NDCG@10 every 5 epochs, 120 min/job, 6 fits,
  maximum 12 GPUh. Both arrays limit concurrent jobs to 2 and disable requeue.
- Combined completed pilots plus maximum grid allocations reserved 22.06 GPUh.
  No retry was submitted.

Outcome: all twelve grid fits completed (Slurm `COMPLETED 0:0`; 350869_0-5 by
13:03, 350872_0-5 by 15:12). Slurm elapsed for both pilots and both grids is
50,770 s, 14.10 GPUh of the 24 authorized. Validation-only winners
(`selection.json`): `bert-2` (LR .0005, dropout .2, selected epoch 67,
validation NDCG@10 .0308 on full validation) and `tiger-0` (LR .0003, dropout
.1, epoch 80, .0499 on the fixed 2,000-query sample). Selection is uneven by
design: TIGER was validated on a sample every five epochs, BERT4Rec on full
validation every epoch, and TIGER's winner is at the grid's lowest learning
rate.

`fit_bert_asset.py` and `fit_tiger_asset.py` save validation-selected CPU-loadable
weights, source/config/universe hashes and progress before a deadline. Grid
runners reuse only identical completed fits and reject partial directories.
`finalize_model_campaign.py --campaign runs/www2027-demo-beauty-models-2026-11-03`
selects completed winners using validation alone; budget-stopped fits and pilots
are excluded. Add `--output runs/www2027-demo-beauty-models-2026-11-03/prepared-journeys`
to prepare a private eight-pair candidate and validate every graph/metric cohort.
It never replaces the reviewed static site. Browser review and local promotion
remain pending after preparation. Newly trained TIGER receives fresh full-cohort
native predictions; the old model's predictions are never substituted.
A failed candidate is recorded/excluded; there must be a completed qualified
winner for each model before export begins. CPU-only job 350880 ran that exact
private-candidate command after both arrays and completed with exit 0 at 16:09
(3,438 s). It exported the five new pairs and recorded status
`graph_and_metric_gates_passed_browser_review_pending` in
`candidate-qualification.json`. Do not re-run it: it re-exports five pairs
(about an hour of CPU) and re-merges the candidate.

### Promotion, 4 November 2026

`promote_journeys.py --campaign runs/www2027-demo-beauty-models-2026-11-03`
migrated the three schema-1 pairs, built the schema-2 manifest, and re-checked
every pair before touching public files: the eight expected ids,
`pending_models == []`, graph validation equal to the recorded `validation` and
`state_count`, 22,363 benchmark queries, benchmark provenance equal to the pair
provenance, exactly `PROVENANCE_KEYS`, `traditional_model` equal to the pair's
traditional label, and the `selection.json` checkpoint hashes for the BERT4Rec
and TIGER pairs. It then moved the reviewed three-pair bundle to
`runs/www2027-demo-journeys/public-backup-2026-11-04`, copied the candidate to
`web/public/journeys`, and set the ledger to
`promoted_public_assets_replaced_browser_review_pending`. After the browser
review, `--record-browser-review papers/www2027-demo/journeys-validation.json`
requires every check passed, no console errors or external requests, all eight
pairs, and the promoted manifest hash. It then sets
`browser_review_passed_public_assets_replaced`. Receipt:
`21-www2027-demo-journey-promotion` (authors' internal receipt).

The LETTER examples (`sasrec-letter`, `bert-mlm-letter`) include two
selectable alternatives sharing SID `[195,184,83,0]`. Direct uncached inference
verifies identical next LETTER addresses/scores after either choice; the
traditional model's top-five differs. Undo lets the
attendee explore the other branch. This example does not claim cosine must
always change: its top-five is unchanged for these particular alternatives.

All reused benchmark prediction files are hashed, and complete query/user/
session/target-item/target-SID alignment is checked before evaluation.

## Verification

From the directory holding `test_journeys.py` (the companion repository root),
with Node 24 and Playwright Chromium installed (the authors ran both as CPU
Slurm jobs):

```bash
python -m unittest test_journeys -v
cd web && npm run build
python -m http.server 8110 --bind 127.0.0.1 --directory dist & S=$!; trap "kill $S" EXIT; sleep 2
npm run test:journeys && node scripts/capture-figure.mjs
```

The journey browser test uses a plain static server on `127.0.0.1:8110` by
default; `JOURNEY_URL` overrides it. Browser plugin unavailable; Playwright
Chromium from the shared default cache `~/.cache/ms-playwright` (leave
`PLAYWRIGHT_BROWSERS_PATH` unset) provides desktop/tablet/mobile validation.
Evidence persists under `JOURNEY_EVIDENCE_DIR` (default `papers/www2027-demo/`):
the receipt `journeys-validation.json` and
`figures/journeys-{desktop,desktop-bert-mlm,mobile,mobile-viewport}.png`.
`web/scripts/capture-figure.mjs` writes the paper figure
`figures/journeys-paper-desktop.png` (1536 px wide, default SASRec/LETTER
query-145 state, One per SID · History cosine) and prints its crop rows.
Downloads and failure screenshots stay in node-local scratch (`os.tmpdir()`;
`JOURNEY_QA_DIR` overrides). Legacy API tests and `test:browser` exercise the
preserved diagnostics through port 8080.

Validation on 3 November: eleven journey Python tests and eleven diagnostic
Python tests pass; twelve journey and seventeen diagnostic Chromium checks pass.
Independent review then added a thirteenth journey check, a delayed-network
regression: changing stories cancels an in-flight choice, so its old result
cannot enter the new history. Save/replay controls also respect pending
navigation. Static journey first meaningful render was 103.0 ms and one choice
updated the UI in 39.8 ms on that host. These are scripted local timings, not a
usability study. All three viewports passed without app errors, external
requests, or horizontal overflow. The journey made no inference/API requests.
Desktop/mobile screenshots were visually inspected. The static journey payload
then measured 7,090,889 bytes before host compression, split into lazy-loaded
state files rather than one initial download.

Validation on 4 November, after promotion (eight pairs): Slurm job 352814 ran
fifteen journey Python tests (OK); job 352818 built `web/dist` and passed
fourteen journey Chromium checks on compute node `violin` (Intel Xeon Platinum
8168, Chromium 156.0.8078.4). The new checks cover the traditional-model heading
of every pair, the same-SID probe for both LETTER pairs, and a BERT4Rec/TIGER
save and replay on the generic provenance schema. Static journey first
meaningful render was 262.8 ms and one choice updated the UI in 96.1 ms on that
node; these are scripted timings, not a usability study. The receipt records no
console errors and no external or `/api/` requests. `web/dist/journeys/manifest.json`
is byte-identical to the promoted public manifest (SHA-256 `f49c1f2f…`). The
static journey payload is 20,103,292 bytes (`du -sb web/public/journeys`) before
host compression. The diagnostic suite was not re-run in this step.
