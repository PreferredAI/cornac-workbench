# Beauty Recommendation Journeys

Implemented 3 November 2026 in the existing WWW demo scope; all eight model
pairs were promoted to the static site on 4 November 2026. On 9 November they
were exported again with six starting histories instead of two and a catalog
trimmed to the items that the states show. The release sections
remain Cornac 2.0 sequential and Cornac 3.0/3.1 generative recommendation;
the primary interaction now follows attendee-selected products.

## Runtime and preparation

Build `web/` with `npm run build`, then serve `web/dist` on any static host.
The journey makes only same-origin JSON/font/script/image requests and requires no
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
checks catalog alignment, and reproduces the stored native paths of all six
starting histories, and SASRec's stored top-20 ranking for queries 145 and 210,
before generating branches. Each branch receives
actual inference on its displayed history; identical LETTER semantic histories
reuse identical native predictions. Exported metadata contains hashes rather
than machine-specific checkpoint paths.

Eight pairs ship, SASRec then BERT4Rec (MLM), each with LETTER, RPG, DiffGRM
and TIGER in that display order (`TRADITIONAL_ORDER`, `SID_ORDER` in
`prepare_journeys.py`). Every pair has the same six starting histories (see
below), two choices per journey, and its own fixed full-cohort benchmark,
qualification record and replay provenance. Pair switching resets the journey.
States and transitions after deduplication, with the wall-clock seconds of the
9 November export (one CPU job per pair on `carpet`, AMD EPYC 9654, 4 CPUs, under
2 GB; the full-cohort benchmarks were reused rather than recomputed):

| Pair | States / transitions | Export s |
| --- | --- | --- |
| `sasrec-letter` | 2,534 / 2,528 | 70.8 |
| `sasrec-rpg` | 512 / 506 | 20.5 |
| `sasrec-diffgrm` | 1,086 / 1,080 | 613.9 |
| `sasrec-tiger` | 561 / 555 | 43.6 |
| `bert-mlm-letter` | 2,635 / 2,629 | 76.0 |
| `bert-mlm-rpg` | 560 / 554 | 22.3 |
| `bert-mlm-diffgrm` | 1,174 / 1,168 | 659.1 |
| `bert-mlm-tiger` | 565 / 559 | 43.2 |
| **Total** | **9,627 / 9,579** | **1,549.4** |

Existing LETTER, RPG and DiffGRM checkpoints reproduce the stored native paths
of all six starting histories. The newly trained TIGER finalist has no stored oracle, so it
is compared against an independent weights-only reload; `sasrec-tiger` computed
its fresh full-cohort native predictions once and `bert-mlm-tiger` reused them.
Seconds are shared-node wall-clock observations, not a benchmark.
Every card from every strategy is selectable until the final screen. A graph
validator checks exact history extension and complete edge coverage. States
are fetched separately; immediate successors are prefetched and cached.

The 9 November export ran `runs/www2027-demo-journeys-2026-11-09/export_pair.sbatch`
once per pair (jobs 358947-358954, about 26 minutes of CPU time in total), each
with `--skip-benchmark` into its own directory seeded with that pair's
`benchmark.json`. `merge.py` in the same directory then copied the eight pairs into
one candidate, wrote the combined manifest with `build_manifest`, the trimmed
catalog and the top-level `benchmark.json`, validated every graph and wrote
`candidate-qualification.json`. The same day, `promote_journeys.py --campaign
runs/www2027-demo-journeys-2026-11-09 --candidate
runs/www2027-demo-journeys-2026-11-09/candidate` replaced `web/public/journeys`
(the previous bundle is in `runs/www2027-demo-journeys/public-backup-2026-11-09`),
and `prepare_media.py` was run again. `catalog.json` now lists only the 2,408
items that appear in some state of some pair; `catalog_items` in the manifest is
its length. The dataset still has 12,068 items, and the benchmarks use all of
them.

## Starting histories

`journey-seeds.json` lists the six starting histories in display order;
`prepare_journeys.py` reads it and takes each history and its real next purchase
from the held-out cohort (`runs/beauty-search-2026-09-14/matched_universe.json`,
`test[i]["items"]`: history `[:-1]`, next purchase `[-1]`). Queries 145 and 210
come first with their earlier ids, labels and order; they were chosen by hand.
`select_seeds.py` chose the other four: 8 to 20 purchases, at least 20 valid
DiffGRM codes (so that every state after a choice still has five), a real next
purchase with a photo that is not already in the history, and a different main
category for each. Each fills one case of whether the real next purchase is on
LETTER's starting list (one product per code, closest to the history) and on
SASRec's top five. Query 7337 is left out because the DiffGRM checkpoint does not
reproduce its stored beams.

| Query | Label | Purchases | Real next purchase | SASRec | LETTER |
| ---: | --- | ---: | --- | ---: | ---: |
| 145 | Makeup & brushes, 16 purchases | 16 | item 2739, fine-liner brush | – | #1 |
| 210 | Mixed, 7 purchases | 7 | item 2993, dry shampoo | – | #4 |
| 2574 | Skin care, 8 purchases | 8 | item 667, Olay microdermabrasion | – | #2 |
| 21060 | Tools & accessories, 8 purchases | 8 | item 10732, nail stamp | #3 | – |
| 21667 | Hair care, 9 purchases | 9 | item 1024, Nexxus conditioner | #2 | #5 |
| 8564 | Fragrance, 11 purchases | 11 | item 3291, perfume | – | – |

Ranks are on the starting lists of the SASRec + LETTER pair, with LETTER on one
product per code, closest to the history. With the most popular product per
code, LETTER does not list the query-145 brush; the other ranks are the same.

Since 10 November the page opens on a five-step tour (`src/tour/Tour.jsx`,
`Scene1.jsx` to `Scene5.jsx`) with the pair's default history, query 145 on
SASRec + LETTER. A stepper at the top names the steps (`Shopper`, `Two
recommenders`, `SID to item`, `Next items`, `Made with Cornac`) next to `Back`,
`Next` and `Skip tour`; the arrow keys and the step dots also move between
steps. In steps 1-4, an item whose short name equals that of another item in
the history, on the starting lists or on the step's screen shows its full title
instead (for query 145, item 2739 reads "Real Techniques Fine Liner Brush").

1. **Shopper.** "One user's purchase history: 16 items from Amazon Beauty."
   (the count follows the history) above all purchases as numbered photos
   (phones show the last eight until `All 16` is pressed) and a `History` menu
   with the six histories, then "Which item did this user buy next? Pick one.",
   `Show the answer` and four photo cards sorted by item index: the real next
   purchase and three decoys, the first items of SASRec's top 5 and then of the
   SID model's most-similar and most-popular one-item-per-SID lists that are
   neither the target nor in the history, preferring distinct short names. A
   pick, or `Show the answer`, marks the real card `Next purchase` and the
   picked one `Your guess`.
2. **Two recommenders.** "SASRec and LETTER recommend from the same history."
   The result line (for query 145, "LETTER ranks the next purchase #1. SASRec
   does not have it in its top 5.") is followed by two columns, `Sequential
   model` (SASRec, "Scores all 12,068 items and shows the top 5.") and
   `Generative SID model` (LETTER, "Generates 5 Semantic IDs (SIDs), short token
   sequences computed from item text; several items can share one SID."; when
   each SID on the list belongs to one item, the line ends "Each of these SIDs
   belongs to one item."). Each column lists its top 5 with photos, SASRec's
   items with their item IDs and LETTER's with their SIDs (`195·184·83·0`; RPG's
   32-token SIDs read `32-part SID`), and the next purchase badged. This step
   reveals the answer if step 1 did not.
3. **SID to item.** The opening follows the history, not the resolver. For
   query 145: "LETTER predicted the next purchase's SID, but 1,643 items share
   it." and "It is LETTER's #1 SID. Which item LETTER shows from each SID is
   decided by a resolver:"; when each SID on the list belongs to one item, "Each
   of these SIDs belongs to one item." and "So the resolver does not change the
   list." Two switches set the resolver, `Items per SID` (`One item per SID` |
   `All items per SID`) and `Order within a SID` (`Most similar` | `Most
   popular`), with a note on the two scores. One row per generated SID gives
   its rank, the SID, the number of items that share it (1,643, 31, 2, 1 and 32
   for query 145) and the item that the resolver shows; under `All items per
   SID`, rows that the first five items do not reach read `Not used`. `Show
   ranking` opens one SID at a time: its items in the chosen order with their
   similarity or purchase counts (the brush first at similarity 0.954; by
   popularity, item 695, a sunscreen) and `Categories in this SID` as bars (573
   skin care, 366 hair care, 353 makeup, 159 bath and body, 106 tools and
   accessories, 86 fragrance). The step ends with "Cornac evaluates SID models
   at three levels (LETTER, Recall@5, 22,363 test users):" and three tiles:
   `SID-level` 0.196, `Item-level` 0.017 (it follows the resolver on screen)
   and `CCE` 0.004.
4. **Next items.** One step with two views. The first, "How each model reads the
   history", shows "Items 88 and 610 have the same LETTER SID. Pick one to see
   what each model reads and recommends." above two cards (photo, title, `item
   {id}`, SID), neither picked at first. Below are the two columns, each with an
   input row under its heading, "SASRec reads item IDs" and "LETTER reads SIDs":
   a count of the earlier positions (`13 earlier`), then the last three
   positions of the input as numbered cells (item IDs on light blue, SIDs on
   light purple), then the model's top 5. Cards show the item ID and, on the SID
   side, the SID, which opens a panel with the items that share it. Picking an
   item appends it to both input rows as a filled cell, `17 · added` (the row
   moves on by one), and shows each model's next top 5 with new items marked; a
   line under the columns compares the two items: "After item 88 or item 610,
   LETTER reads the same input and predicts the same 5 SIDs. SASRec reads two
   different item IDs; its two top-5 lists share 0 of 5 items." Nothing is added
   in this view. On the other histories and on the DiffGRM pairs the two items
   are the two lowest-numbered items of the first SID with at least two items on
   the starting lists that have stored next states; on RPG and TIGER pairs the
   view reads "Each of the 5 {sid} SIDs here belongs to one item, so there are
   no two items with the same SID to compare." `Choose items to add` opens the
   second view, "Add an item to the history and compare the new top 5.": the
   history strip with `Undo`, a result line, and the same two columns with `Add`
   buttons, the resolver fixed to "Resolver: one item per SID, most similar."
   After the brush the result line reads "SASRec: 4 of 5 items changed. LETTER:
   same 5 SIDs."; after the second item a recap names both items and both
   changes. `How each model reads the history` goes back to the first view
   without changing the journey, and entering step 4 with a journey in progress
   opens the second view.
5. **Made with Cornac.** "The Cornac experiment behind this demo". The
   `Experiment` listing from `paper.tex` beside three numbered captions that
   light up their part of the listing (one split and protocol for all models;
   sequential and SID models in one list; item-level, SID-level and CCE metrics
   from the same predictions), the Recall@5 chart at full width (item-level,
   SID-level and CCE bars for each model, DIGER last), "How each SID model
   handles collisions (items that share a SID)" with one line each for TIGER and
   DIGER, RPG, LETTER and DiffGRM, `Install Cornac` with `pip install cornac`,
   `Copy`, a link and a QR code for `https://github.com/PreferredAI/cornac`, and
   the buttons `Open the full workbench` ("All 8 model pairs, 6 histories and 4
   resolvers, with save and replay.") and `Start over` ("Back to step 1.").

`Open the full workbench`, or `Skip tour` on any step, opens the full screen
with the answer already revealed and a `Back to the tour` button: "Purchase
history: {n} items. Which item did this user buy next?" with the result line,
the history strip, `Undo`, `Restart`, `Save journey`, `Replay journey` and
`Share`, then "Add an item to the history and compare the new top 5." with
`Details`, the two columns `Sequential model` and `Generative SID model` with
the resolver menu (`One item per SID, most similar` and the other three), the
change line with `Why?`, the recap `What happened` after the second choice, the
step "Two items, one SID" on query 145 of the LETTER pairs, and "Try another
model" with `Model pair` and `Starting history`. Each SID card links to a panel,
"One SID, {n} items", with its categories and its items by popularity and by
similarity. `Details` shows the technical resolver names, SIDs in brackets,
scores, resolver notes, a Recall@5 chart of all eight pairs and the held-out
metric table. When each SID on screen belongs to one item (always on the TIGER
pairs), the resolver menu is replaced by "One item per SID".

The page keeps the mode and step and the journey in the URL hash
(`#p=<pair>&h=<history>&s=<strategy>&t=<state>,<state>&r=1&v=tour&sc=<n>`,
or `v=explore`), so a reload or a shared link restores it; a hash with choices
and no `v` opens the full screen. `Share` opens a panel with a QR code of that
link, the link itself and `Copy link`; the QR code is drawn by the `qrcode`
package, which is loaded only when needed. With `k=1` in the hash the page runs
in kiosk mode for a booth screen: after 60 s without input it plays tour steps
1-3 with captions (the shopper, the reveal, the two lists, the first SID with
the resolver switched once) and starts again, until someone touches the
screen or presses a key. Reduced motion turns the loop off. Columns stack below
760 px. The provenance of the data is stated once, in a footnote at the bottom
of every step; selection updates are announced to screen readers.

## Product photos and short names

`prepare_media.py` adds a photo, a short name, the brand, the category path and
the price for every item that appears in a state (history, either list or a
bucket member): 2,408 items. It reads `manifest.json` and the state files under
`web/public/journeys`, the titles of all 12,068 items from
`workbench-assets/bundle.json.gz`, the 2014 Beauty metadata
`.cache_data/amazon_review/meta_beauty_2014.json.gz` that `prepare_workbench.py`
also reads (`imUrl`, `brand`, `categories`, `price`), and the real next
purchases of all six histories from the held-out cohort (`matched_universe.json`). Each `imUrl` is downloaded from
`m.media-amazon.com` with its size suffix removed (8 threads, 3 attempts; raw
files are cached in `workbench-assets/images-raw/`, which is not shipped),
placed on a white background, resized to a longest side of 320 px and saved as
`web/public/journeys/thumbs/<item_index>.webp` (WebP quality 80). The script
then writes `web/public/journeys/media.json` (schema 2: `items` keyed by item
index with `image`, `width`, `height`, `short`, `brand`, `category`, `price`;
`targets` maps each starting-history id to its real next purchase; `buckets`
gives, for each SID model and each code that appears in a state, its size and
up to six top-level categories with counts, the rest summed as "Other", with
membership from the model's `sid_catalog.npz`) and the summary
`media-validation.json`. A short name is the brand followed by the
lower-cased last category, for example "Maybelline foundation", or the first
five words of the decoded title when either is missing; it has at most 40
characters. The current files (9 November 2026) hold 2,407 thumbnails
(14,988,300 bytes) and a 552,719-byte `media.json`; item 3982 (`B0009R5B8A`)
has only Amazon's "no image" picture and is shown with a placeholder.

Run it from the checkout root on the login node, because compute nodes may have
no outbound network, with the `cn` environment for Pillow (32 s on 9 November;
`--limit N` processes only the first N items):

```bash
python papers/www2027-demo/prepare_media.py
```

The step changes none of the hashed files: `catalog.json`, `manifest.json`, the
states and the benchmarks stay byte-identical. `promote_journeys.py` replaces
`web/public/journeys` as a whole and so deletes `media.json` and `thumbs/`;
re-run `prepare_media.py` after every promotion. Without `media.json` the page
still works: it skips the guess and shows placeholders instead of photos.

Python's `http.server` (3.12 on the cluster) sends `.webp` files as
`application/octet-stream` because its MIME table has no entry for them.
Chromium displays them anyway, and the browser tests check that every shelf
image has decoded (`naturalWidth > 0`).

The thumbnails are reduced copies of the product images linked from the 2014
metadata and, like the product titles, are used under the dataset's terms.

## Resolution and metrics

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

## Manifest and provenance

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

All eight pairs of the current bundle were exported on 9 November by one
exporter (`exporter_sha256` `f122d9a2…`, which also assembled the manifest).
`--skip-benchmark` compares the saved provenance with the current one, ignoring
only `exporter_sha256`, then re-stamps the saved benchmark. The bundle of
4 November mixed three exporter generations, because three schema-1 pairs had
been migrated by `promote_journeys.py` (`migrate_legacy_provenance`,
`migrate_legacy_qualification`) instead of being re-exported. Re-exports are not
byte-identical across hosts: a test re-export of `sasrec-rpg` on another CPU host
(job 352824) matched every state id, edge, item, order, bucket size and resolver
score, but float32 model scores differed (SASRec by at most 1.0e-5, RPG native
by 1.2e-6). Journey files saved from earlier builds, including the one on the
public site on 9 November, carry the old provenance and fail replay.

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
`web/scripts/capture-figure.mjs` writes the three paper figures from the default
SASRec/LETTER journey (query 145) in a 1000×1100 window at device scale 2, each
cropped to the tour column: `figures/journeys-paper-scene2.png` (step 2 after
the reveal, from the heading to the third list row),
`figures/journeys-paper-scene3.png` (step 3 under the default resolver with row
1's ranking open, from the heading to its sixth item and category bars) and
`figures/journeys-paper-scene4.png` (step 4's first view with item 88 picked,
from the two item cards to the third list row). It prints their sizes and crop
rows; with `--og` it writes the 1200×630 link preview of step 2 after the
reveal, `web/public/og.png`, instead.
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
was byte-identical to the promoted public manifest (SHA-256 `f49c1f2f…`). The
static journey payload was 20,103,292 bytes (`du -sb web/public/journeys`) before
host compression. The diagnostic suite was not re-run in this step.

Validation on 9 November, after the screen redesign: Slurm job 358869 built
`web/dist` and passed 21 journey Chromium checks on compute node `carpet` (AMD
EPYC 9654, Chromium 156.0.8078.4). Fourteen are the earlier checks updated for
the new screen; the seven new ones cover the reveal, the guess, the count of new
products (recomputed from the two lists), the product photos, the summary card,
the `Details` switch, and the RPG pair's "One product per code". The receipt
records no console errors, no external or `/api/` requests and no failed
responses. Static journey first meaningful render was 136.6 ms and one choice
updated the UI in 64.5 ms; these are scripted timings, not a usability study.
The same job ran the Python tests (15 journey, 11 diagnostic; 26 passed). With
`media.json` (297,380 bytes) and `thumbs/` (8,641,003 bytes), `du -sb
web/public/journeys` was 29,041,677 bytes.

Validation on 9 November, after the six-history export and the booth features:
Slurm job 358980 (`runs/www2027-demo-journeys-2026-11-09/web_qa.sh`) built
`web/dist` and passed 28 journey Chromium checks on `carpet` (AMD EPYC 9654,
Chromium 156.0.8078.4). The seven new checks cover restoring a journey from the
URL hash, the `Share` panel, the Recall@5 chart, the bucket categories, the kiosk
loop, the same six histories on every pair, and a catalog entry for every shown
item. `journeys-validation.json` records no console errors, no external or
`/api/` requests and no failed responses. First render took 137.0 ms and one
choice 68.3 ms; these are scripted timings, not a usability study. The same job
ran the Python tests (17 journey, 11 diagnostic; 28 passed); the two new journey
tests check that every pair starts from the same six histories and that the
catalog lists exactly the items the states show. The paper figure is
1536×2150 px; the paper keeps rows 74–1105, from the question to the end of the
recommendations. `du -sb web/public/journeys` is 64,511,943 bytes in 12,046
files: 49.5 MB of JSON, including `media.json`, and 14,990,707 bytes of
thumbnails.

Validation on 10 November, after the five-step tour: Slurm job 360456
(`runs/www2027-demo-journeys-2026-11-09/tour-qa/web_qa.sh`) built `web/dist`
and passed 29 journey Chromium checks on `carpet` (AMD EPYC 9654, Chromium
156.0.8078.4). The suite was rewritten for the tour. Its checks cover the photo grid
and the four guess cards, a wrong guess and `Just show me`, the stepper with
`Next`, `Back`, the arrow keys and the step dots, both lists in step 2, the
categories and the picking-rule switch in step 3 (and its one-product form on
RPG), a choice, the change line against a recount, `Undo`, the same-code step
and the summary in step 4, the listing, chart, QR code and `Share this
journey` in step 5, `Explore freely`, `Skip tour`, `Back to the tour` and the
`v=tour&sc=N` hash, and on the full screen the eight pairs with the policy
menu, the bucket view, save and replay with a tampered file, `Details`, the
same six histories on every pair, the catalog, the kiosk captions, horizontal
overflow on all five steps at 1440, 1024 and 390 px, and the absence of API
calls, other-host requests, failed responses and console errors. First render
took 142.9 ms and one choice 54.3 ms; these are scripted timings, not a
usability study. The same job ran the Python tests (17 journey, 11 diagnostic;
28 passed). The paper figures are 1116×785 px (step 2, rows 171–956)
and 1116×668 px (step 3, rows 171–839), crops of the 1536×1024
window; the paper sets them side by side at half the text width each.

Validation on 10 November, after the seventh round of tour changes: Slurm job
361886 (`runs/www2027-demo-journeys-2026-11-09/tour-r2/qa/web_qa_r2.sh`) built
`web/dist` and passed 58 journey Chromium checks on `carpet` (AMD EPYC 9654,
Chromium 156.0.8078.4). They cover each step as described above, including the
resolver switches and rankings in step 3, both views of step 4 (the two items
with one SID for every LETTER and DiffGRM pair and history, the input rows
lining up, adding, `Undo` and the recap), the collision lines in step 5,
`Open the full workbench`, the page title and link preview, and on the full
screen the eight pairs, the SID panel, save and replay with a tampered file,
`Details`, the kiosk captions and that no visible text says "code". The receipt records no console errors, no
external or `/api/` requests and no failed responses. First render took 149.8
ms and one choice 44.7 ms; these are scripted timings, not a usability study.
The same job ran the Python tests (17 journey, 11 diagnostic; 28 passed) and
wrote the paper figures: 1904×1026 px (step 2), 1904×1132 px (step 3) and
1904×1262 px (step 4).
