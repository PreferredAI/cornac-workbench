# Cornac Workbench

The default route is now the static **Beauty Recommendation Journeys** screen:
eight real model pairs (SASRec or BERT4Rec (MLM), each with LETTER, RPG, DiffGRM
or TIGER; 3,470 prepared states), two choice steps, four resolver strategies,
bucket inspection, fixed full-cohort Cornac 3.1 metrics, and verified
save/replay. See [journey preparation and contracts](../journeys.md). Serve
`dist` with any static host for this experience; it does not call the Python API.
`npm run test:journeys` checks it against a plain static server on port 8110 and
writes [its receipt](../journeys-validation.json) and `../figures/journeys-*.png`;
`node scripts/capture-figure.mjs` captures the paper figure.

The diagnostic interface described below is retained at `?view=diagnostics`
and uses the local Python API.

Implemented React/Vite interface for the [portable resolver API](../workbench-api.md).
The UI uses actual prepared LETTER/TIGER predictions, runtime member selection and
metric reconstruction, and matched SASRec output. Eighteen deliberately selected
walkthrough cases do not constitute a representative model-quality benchmark.

## Build and run

From this directory, using Node 24 (tested) and the checked-in lockfile:

```bash
npm ci
npm run build
```

Then from the parent directory (the one holding `serve_workbench.py`):

```bash
python -S serve_workbench.py --host 127.0.0.1 --port 8080
```

Open `http://127.0.0.1:8080`. The built runtime requires only Python standard-library
modules, `workbench.py`, `serve_workbench.py`, `workbench-assets/bundle.json.gz` and
`web/dist`. It makes no external requests and needs neither Node nor site packages
after building. Python 3.12 was tested. Node is needed only for rebuilding/testing;
`dist` and `node_modules` are ignored build outputs, not a published release package.

For development, keep the Python server running and use `npm run dev` in this
directory. Vite proxies `/api` to the exact loopback host above.

## Verified attendee tasks

1. Select query **7**: native SID credit is positive while both explicit resolvers
   miss the held-out item. Inspect the target-address row and its collision group.
2. Select **145** and switch the group resolver: history cosine selects the held-out
   brush, while popularity selects a sunscreen from the same 1,643-member group.
   Query **210** demonstrates the opposite outcome. No model predictions change.
3. Expand the SASRec ranking for the same query; compare explicit item metrics and
   shared items. Open the run contracts to inspect recipes/context differences.
4. Export the session, then use **Replay session** to validate and reconstruct it.
   The same JSON independently replays with `python -S ../workbench.py --replay FILE`.

CCE is a reference expectation after collision-group expansion, not an explicit
one-member resolver. Popularity/history-cosine scores are frozen training-derived
inputs; policy decisions and metrics are applied/reconstructed at request time.
The SID models use OpenAI tokenization features and up to 20 history items; the
member resolver uses separate raw ST5 features; SASRec uses up to 50 items.
Targets are used only for evaluation/highlighting, never member scoring.

## Browser verification

Browser plugin not available; Playwright Chromium is the fallback. After installing
dependencies, install its browser and run against the production Python server:

```bash
npx playwright install chromium
npm run test:browser
```

This environment uses the shared default browser cache `~/.cache/ms-playwright`
(leave `PLAYWRIGHT_BROWSERS_PATH` unset; earlier runs used a login-node `/tmp`
copy) and `WORKBENCH_PYTHON` set to the Python interpreter that runs
`serve_workbench.py`. Set the latter when repeating the checks. Loopback/browser execution and
dependency downloads required the normal sandbox escalation; no restrictions were
bypassed. The script records screenshots, raw video and machine-readable checks
under `/tmp/cornac-www2027-web-qa` by default; `WORKBENCH_QA_DIR` overrides it.

The earlier [validation receipt](../web-validation.json) records the original checks at
1536×1024, 1024×768 and 390×844, zero app console errors, and a clean copied runtime
under `python -S` with external requests blocked. This is scripted task validation,
not a participant usability study. Firefox/WebKit are not yet qualified.

The [concept](design/primary-concept.png), [specification](design/design-spec.md)
and [fidelity record](design/fidelity.md) document design and visual inspection.
Implementation follows the official [React root API](https://react.dev/reference/react-dom/client/createRoot)
and [Vite build workflow](https://vite.dev/guide/).

## November 2 visual redesign

The workbench has its own application layout with a subtle PreferredAI signature,
navy case rail and numbered context → comparison → inspection workflow. Google
Sans Flex is self-hosted in `public/fonts` with its SIL Open Font License, preserving
the portable runtime's zero external requests. The active concept and fidelity
record are in `design/`; the earlier concept is retained as history.

The current 17-check browser suite adds local font loading, section order, skip
navigation and selected-scenario semantics. Latest local evidence is under
`/tmp/cornac-workbench-redesign-qa`, including desktop/tablet/mobile screenshots
and `browser-validation.json`. Historical paper figures/receipts are preserved;
refresh publication artifacts as part of the final paper/package preparation.
