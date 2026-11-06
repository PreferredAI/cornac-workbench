# Qualified collision/resolver demonstration assets

Verified 26 October 2026 for the authors' master plan, milestone
M1. The qualification script (`runs/www2027-demo-qualification-2026-10-26/qualify.py`
in the Cornac research tree) and [machine-readable receipt](qualification/qualification.json)
preserve the exact inputs, hashes, selected cases and numerical checks. The
assets are published in the companion repository: code under Apache-2.0, and
the Amazon-derived data under the original dataset's terms (see its README).

## Selected source contract

Frozen source: `papers/ecir2027-replicability/artifact-bundle/data/beauty/`.
Both SID models use OpenAI tokenization features and training seed 2025. The
explicit history resolver intentionally uses a separate common raw ST5 matrix.
Do not label resolver ST5 features as either model's tokenization features.

| Asset | Qualified behavior |
| --- | --- |
| `letter-openai-2025` | 12,068 items; 570 collision groups; 3,421 collided items; maximum group size 1,643; 20 native beams/query |
| `tiger-openai-2025` | Same item/query universe; injective complete addresses; 50 native beams/query |
| `resolver-inputs.npz` | 12,068 × 768 ST5 features; 153,776 training user/item events; explicit user count |
| SASRec checkpoint | Existing portable `selected.pt`, SHA-256 `860cf2a74874d46f1f0b45106530a25e305290a7cdc8d151c6e34c370df7b77e`; selected epoch 50; no new fit |

All 22,363 ordered SID query identities, target addresses and catalog indices
were checked against canonical `runs/beauty-search-2026-09-14/matched_universe.json`
(SHA-256 `de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21`).
Training arrays exactly equal the canonical training events, including repeats;
saved popularity equals their item counts. Resolver feature rows were independently
joined by original ASIN against the source ST5 file and found exactly equal.

For LETTER preserve raw arrays and expose its separately saved native ordering:
stable descending score, with invalid paths assigned the historical -1000 score
sentinel. The qualifier reconstructed every native ordered address/score array.
TIGER retains its original decoder slot order. Neither operation is a resolver.
Source confirmation recipes remain in the frozen bundle's `configs/confirmation/`;
the [portable API](workbench-api.md) now exposes the recipes and verified
context limits: both SID models 20 items, SASRec 50. TIGER's implicit limit was
checked in the hash-matched historic source snapshot.

Popularity selects the largest training count inside each predicted address group.
History cosine uses float64 row-normalized ST5, normalized sums of the user's
training item vectors including repeats, and dot products. Zero profiles give
zero scores. Both policies select only existing group members, preserve the
declared SID order, and break score ties by smallest global item index.
Targets are used only for correctness checks and evaluation.

Keep SID credit, CCE group-expansion expectation, and one-member item selection
distinct. A uniform one-member resolver is not CCE. Invalid and repeated address
slots keep the evaluator's declared empty-slot behavior; do not silently compact.

## Bounded matched query slice

The selected slice has **18 queries**, purposefully mixing diagnostic cases with
an outcome-independent sample. It is not an aggregate recommendation benchmark.

- Twelve evenly spaced neutral indices: 0, 2032, 4065, 6098, 8131, 10164, 12197,
  14230, 16263, 18296, 20329, 22362.
- SID hit but popularity-resolved item miss at 10: 7, 30.
- Popularity item hit, history-cosine item miss at 10: 210, 288.
- History-cosine item hit, popularity item miss at 10: 145, 453.

Diagnostic indices are the first two matching each declared category in the
frozen LETTER oracle; their deliberate selection must be visible. The qualifier
then recomputed these results from native predictions and resolver inputs.

Selected SID/CCE/popularity/history-cosine metrics agree with the frozen ECIR
per-query oracles to absolute tolerance 1e-12. All four views agree on the injective
TIGER control. The saved [selected metric oracle](qualification/selected-oracle-metrics.json)
contains 5/10/20 cutoffs; source oracle comparisons cover the cutoffs supplied by
each source artifact (LETTER 5/10, TIGER 5/10/20).

The [matched SASRec slice](qualification/sasrec-slice.json)
was inferred on CPU from the existing checkpoint for those exact 18 histories.
Checkpoint item order and universe hash match; all scores are finite. Recorded
load time was 0.061 seconds and inference time 0.065 seconds in the existing `cn`
environment with one PyTorch thread. These are qualification timings, not yet
browser/system-performance measurements. No full-cohort SASRec export was run.

## Integration handoff

The engine can load selected records from both complete SID source arrays and
the matched SASRec slice. Retain raw and native LETTER outputs, target/history
separation, exact indices and provenance. Browser member inspection must handle
large groups (up to 1,643 items) without trying to display every row at once.
Expose source recipes/context limits and the 20-versus-50 SID beam budgets;
matched identities do not establish equal tuning or architecture-controlled results.

The previous notebook's TIGER-ST5 replay remains a historical fallback. It is not
the newly selected OpenAI control. BERT+MLM and additional bundles remain optional.
