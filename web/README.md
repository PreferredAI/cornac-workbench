# Cornac Workbench

The default route is the static **Beauty Recommendation Journeys** screen. It
opens on a five-step tour (`src/tour/`) with SASRec and LETTER on one real
Amazon Beauty purchase history: (1) the shopper's purchases as photos and
"Which item did this user buy next? Pick one." among four items, after which
the real next purchase is marked; (2) both models' top five side by side,
SASRec's items with their item IDs and LETTER's with their SIDs; (3) LETTER's
top SID, shared by 1,643 items, with two switches for the resolver (one or all
items per SID; most similar or most popular), the ranking inside each SID, and
LETTER's Recall@5 at the SID level, at the item level and under CCE; (4) how
each model reads the history, with items 88 and 610 that share a LETTER SID,
then up to two added items and a line on how each list changed; (5) the Cornac
experiment in Python, a Recall@5 chart of all models, `pip install cornac` and
a QR code for the repository. `Preliminaries` (before step 1,
`src/tour/Scene0.jsx`, `sc=0`) shows how each kind of model reads a history
and which items share TIGER's first SID tokens
(`public/journeys/prefixes.json`). `Open the full workbench` (or `Skip tour`)
opens the workbench (`src/Explore.jsx`): step 4's layout under menus for the
sequential model, the SID model (eight pairs, 9,627 prepared states), the
history (six) and the resolver (four), with the pair's Recall@5 and NDCG@5
below. The hash keeps the mode and step (`v=tour&sc=N` or `v=explore`) and the
journey, so a reload or a link reopens it. A `Try the demo!` card in the
bottom-right corner shows a QR code of the site (the `qrcode` package, loaded
only when needed), and `#k=1` turns on kiosk mode, which plays tour steps 1-3
with captions after 60 s without input. `/video/` plays a one-minute captioned
recording of the tour, made by `node scripts/record-tour.mjs`. Photos and
short names are read from `public/journeys/media.json` and
`public/journeys/thumbs/` (2,407 WebP files, at most 320 px on a side),
written by [prepare_media.py](../prepare_media.py); if `media.json` is
missing, the page skips the guess and shows placeholders. See [journey
preparation](../journeys.md). Serve `dist` with any static host for this
experience; it does not call the Python API. `npm run test:journeys` runs 71
browser checks against a plain static server on port 8110 and writes [the
results](../journeys-validation.json) and `../figures/journeys-*.png`; `node
scripts/capture-figure.mjs` captures the paper figures.

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

## Typography and paper captures

Apple devices use their native San Francisco system font; other platforms use
the bundled Google Sans Flex, with a system sans-serif fallback. SF Pro font files
are not distributed with the site. `font-optical-sizing: auto` lets supporting
browsers use size-appropriate outlines; no manual SF Pro Text/Display switch is
needed.

To capture the paper figures in SF Pro, run the existing capture script on macOS
with Node dependencies and Playwright Chromium installed. From this directory,
start the journey-only development server:

```bash
npm run dev -- --port 8110
```

In another terminal in the same directory:

```bash
JOURNEY_URL=http://127.0.0.1:8110 JOURNEY_EVIDENCE_DIR=/tmp/cornac-mac-figures node scripts/capture-figure.mjs
```

The script uses fixed paper viewports and writes the three figures under
`/tmp/cornac-mac-figures/figures/`. A Linux browser, including one emulating an
Apple device, does not provide the native Apple font.

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
