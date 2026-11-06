# Portable resolver workbench: runtime and API

Implemented 26 October 2026 under internal task 17.
This backend supports the [implemented web interface](web/README.md). It reconstructs member selection
and metrics at request time; it does not select cached metric reports. Browser
controls and visual validation are recorded in internal task 18.

## Launch and dependencies

From the repository root:

```bash
python papers/www2027-demo/serve_workbench.py --host 127.0.0.1 --port 8080
```

Runtime needs only the Python standard library, `workbench.py`,
`serve_workbench.py` and `workbench-assets/bundle.json.gz`. No Cornac, NumPy,
PyTorch, checkpoint, network service or absolute ECIR source path is used.
The server serves the production build from `web/dist`; `--static PATH`
overrides that directory. During Vite development, proxy `/api` to
`http://127.0.0.1:8080`. Python loopback sockets require execution outside the
restricted sandbox in this environment; the HTTP tests passed with escalation.

Preparation uses the existing development installation and source artifacts,
run from the Cornac research tree root; the tests also run from the companion
repository root as `python -m unittest test_workbench -v`:

```bash
PYTHONPATH=. python papers/www2027-demo/prepare_workbench.py
python -m unittest discover -s papers/www2027-demo -p test_workbench.py -v
```

The compressed [bundle](workbench-assets/bundle.json.gz) is about 2.37 MiB.
[manifest.json](workbench-assets/manifest.json) records its exact size/hash and
source lineage. [Validation receipt](workbench-validation.json) records checks.
The [asset contract](asset-contract.md) defines selection and source semantics.

## Stable HTTP interface, schema version 1

All responses are JSON; request errors return HTTP 400 with `{"error": "..."}`.
Model IDs are `letter-openai-2025` and `tiger-openai-2025`. Explicit resolver IDs
are `popularity` and `history_cosine`; supported cutoffs are 5, 10 and 20.

| Request | Response |
| --- | --- |
| `GET /api/bootstrap` | `schema_version`, `scope`, `models` (without full groups), `baseline`, `resolver_contract`, `policies`, `cutoffs`, `provenance` |
| `GET /api/queries?model=letter-openai-2025&cutoff=10&category=all` | `queries`: row summaries, runtime metrics/tags and resolver disagreement counts |
| `GET /api/query?query=145&model=letter-openai-2025&cutoff=10` | Synchronized comparison and product metadata described below |
| `GET /api/group?query=145&model=letter-openai-2025&address=195,184,83,0&resolver=history_cosine&offset=0&limit=50` | Paginated scored members, selected item, target highlighting; maximum page size 200 |
| `GET /api/export?query=145&model=letter-openai-2025&cutoff=10` | Downloadable independently replayable session JSON with checksum |
| `POST /api/replay` | Send exported session JSON; returns `status: passed` and reconstructed `result`, or HTTP 400 |

`/api/query` has this shape (illustrative fields, not a second cached result):

```json
{
  "query_index": 145,
  "model_id": "letter-openai-2025",
  "cutoff": 10,
  "categories": ["cosine_hit_popularity_miss"],
  "history_item_indices": [],
  "effective_history_item_indices": [],
  "target_item_index": 0,
  "policies": {
    "popularity": {
      "slots": [{"rank": 1, "raw_rank": 1, "address": [195,184,83,0], "model_score": -1.0,
                 "valid": true, "duplicate": false, "group_size": 2,
                 "selected_item_index": 0, "selection_score": 4, "target_address": false}],
      "metrics": {"sid": {"hit": 0, "ndcg": 0}, "cce": {"hit": 0, "ndcg": 0}, "item": {"hit": 0, "ndcg": 0}},
      "target_sid_rank": null,
      "target_item_rank": null,
      "target_group_size": 2,
      "diagnostics": {},
      "sasrec_overlap_count": 0
    },
    "history_cosine": {}
  },
  "sasrec": {"ranked_item_indices": [], "scores": [], "metrics": {"hit": 0, "ndcg": 0}},
  "resolver_disagreement_ranks": [],
  "items": {"0": {"item_index": 0, "item_id": "ASIN", "title": "Product title", "training_count": 4}},
  "scope": "18 selected walkthrough cases; not a representative model-quality benchmark"
}
```

The real response contains full histories, both complete resolver objects and
real products. Slots expose evaluator/native rank separately from original raw
rank. `selected_item_index: null` denotes an empty invalid/repeated slot.
Metrics use one-based ranks in visible fields and preserve empty slots.
`target_item_rank: null` means absent from the exported candidate ranking; SASRec
exports only top 20, so it does not establish an absolute full-catalog target rank.

Query categories include the declared selection categories and runtime-derived
`target_sid_absent`, `sid_hit_item_miss`, `resolver_disagreement`, `collided_target`,
`invalid_outputs` and `repeated_outputs`. A category may have no selected cases.
The 18 cases comprise 12 neutral samples and six deliberately selected diagnostic
cases; no summary should be presented as representative model-quality evidence.

## UI requirements carried by the contract

Both SID runs tokenize OpenAI features; the member resolver uses **separate ST5
features** and training-only user profiles. Training-derived member scores are
frozen inputs; the selected resolver and metrics are recomputed at runtime.
The policies only choose within existing predicted address groups.

Both SID context limits are **20 items**; SASRec uses **50**. LETTER's limit is
explicit in its confirmation configuration. TIGER's default was checked in the
hash-matched historic source snapshot; its verification hash is exposed by
`models[model].context`. The API also exposes selected recipes/objectives and
20-versus-50 decoder budgets. Equal identities do not imply equal tuning.

Defaulting to query **145** demonstrates an actual cosine win; queries **210**
and **288** demonstrate popularity wins, and **7/30** show SID hits with item
misses. TIGER provides the no-collision control. Inspectable groups can contain
1,643 members, so use the group endpoint's pagination instead of rendering all.
CCE is an expanded-group expectation, not an explicit one-member resolver.

## Standalone session replay

Save `/api/export` output, then run:

```bash
python -S papers/www2027-demo/workbench.py --replay /path/to/session.json
```

This was verified with site packages disabled. The export includes selected raw
predictions, complete catalog groups and member score inputs, recipe/context and
provenance, SASRec results, both reconstructed policy outcomes and an integrity
checksum. No external source files are used during replay.

Full-cohort SASRec export is deferred: the current portable runtime uses the
explicitly labeled 18-case slice. No new fit or GPU run was performed.
