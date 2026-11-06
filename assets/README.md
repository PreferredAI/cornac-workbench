# Qualified real-data replay schema

Prepared 25 October 2026 from the ECIR'27 under-review study's TIGER-ST5 seed2025
held-out artifact. This is a small, deterministic case-study replay. It is not
an aggregate model comparison or a new benchmark result.

- `tiger-replay.json`: 12 evenly spaced query indices from 22,363, selected without
  inspecting outcomes. Each query retains canonical user/session indices, target
  item, evaluation and visible-history positions, the complete history prefix,
  actual TIGER-visible prefix, and all 50 native paths/scores/validity flags in
  decoder order. Invalid and duplicate slots are preserved. Full histories can
  be passed to a model with its own declared history window; effective model
  contexts may differ and are not an architecture-controlled comparison.
- `sid_catalog.npz`: original hash-verified complete catalog, loaded with
  `allow_pickle=False`. All 12,068 complete addresses are injective. Keep the
  fourth suffix token: dropping it would manufacture collisions. Resolver
  choices and SID/item/CCE views agree for this artifact.
- `item-ids.json`: full ordered ASIN array; index is the catalog item index.
  `item-popularity.json` preserves the original training counts. `titles.json`
  maps only selected history/target/predicted ASINs to real product titles;
  absent titles must display the ASIN. Reviewer IDs and review text are omitted.
- `tiger-metrics.json`: original Cornac semantic evaluator output for this slice,
  cutoffs 5/10/20, first-member resolution. Values describe these cases only.
- `tiger-recipe.json`: source recipe/base config and effective seed/beam overrides,
  selected checkpoint identity and original fit/reload receipt fields. This is
  prepared replay; no TIGER model is fitted or run during notebook replay.
- `provenance.json`: raw NPZ/catalog/universe/checkpoint-source hashes, extraction
  source identity, metadata source hash, released files' sizes/checksums, and the
  verification count of **all 22,363 canonical query identities**.

The canonical source is the immutable `matched_universe.json` recorded by the
original study, SHA-256
`de948ed206722e2a477327723f4260d2853f19ef5de3ca5797cea8bdce7d8c21`.
Both the replay extractor and SASRec fit use that exact source and verify
catalog order. The current native resource-paper preflight has a different
22,225-query cohort and is not substituted here.

Regenerate from the local documented research sources with:

```bash
PYTHONPATH=. python papers/www2027-demo/prepare_replay.py
```

This command requires local full research artifacts and Amazon metadata. The
notebook should consume the checked-in small assets directly, without needing
those sources or model weights for TIGER replay. Confirm original Amazon dataset
terms and give dataset/ECIR-study attribution before public distribution. No
upload or public hosting has been performed by this preparation task.
