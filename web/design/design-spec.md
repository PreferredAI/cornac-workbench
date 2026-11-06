# Workbench design specification

Active redesign concept: [workbench-concept-v2.png](workbench-concept-v2.png), generated
with the built-in Image Gen tool on 2 November 2026 and inspected with `view_image`
before implementation. The previous primary concept remains as historical evidence.
The user authorized implementation: an independent workbench layout, Google Sans
Flex typography, and only a subtle PreferredAI signature/touch.

## Tokens and component map

- Canvas `#f7f9fa`; surfaces true white `#ffffff`; case rail navy `#142f40`.
- Ink `#142b3b`; secondary ink `#607284`; border `#dfe6eb`.
- Teal `#087e78`; selected outcome `#f5fbfa`; selected scenario `#edf8f6`.
- Typeface: self-hosted Google Sans Flex Latin variable WOFF2, with its SIL OFL
  in `public/fonts/OFL.txt`. System fallback covers unsupported characters.
  No font request leaves the local application. Monospace for code and IDs;
  tabular numerals for metrics/ranks. No Apple font files are distributed.
- Scale: 28px page heading; 21px brand; 15px section; 12–14px body/controls;
  25px outcome metrics; 10–12px dense table metadata. Normal widths and no
  ornamental variable-font animation.
- Header 64px; case rail 236px; main gutter 24px; radius 6–8px; 1px borders.
- One primary Export session action, outlined API/replay controls, understated
  `by PreferredAI.` signature. All branding remains text/code-native.
- Ordered workflow: guided scenarios/configuration; 01 Query context;
  02 Compare recommendations; 03 Inspect the decision; contracts disclosure.
- Repeated families: scenario buttons, selected case rows, context/history chips,
  comparison columns, ruled tables, disclosures, Python code drawer.
- Existing React ownership and request cancellation remain intact; no new
  dependencies, artificial navigation, invented dashboard or new API calls.
- Motion is limited to short state-color transitions, respecting reduced motion.

## Copy and data discipline

Allowed shell copy: Cornac Workbench; by PreferredAI.; Recommendation diagnostics;
Follow a prediction from history to recommendation.; Amazon Beauty · 18 selected
cases; Guided scenarios; Configuration; Query context; Compare recommendations;
Inspect the decision; Python API; Replay session; Export session.

All existing diagnostic labels, model/cutoff choices, exact API-driven case IDs,
histories, target titles, metric values, native SID slots, resolver scores and
scientific qualification notes are preserved. The concept's invented stationery
products, numeric values, recency labels and simplified table columns are never
implemented as research data. User history retains its actual chronological order;
there is no claimed recency timestamp or live editable seed field. Real native
trace and collision-table columns supersede the illustrative mockup columns.

Desktop retains two linked inspector panes; tablet stacks those panes; mobile
uses a contained horizontal case rail and stacks comparison/context content.
Tables scroll inside their panes; history/ranking disclosure remains functional.
Skip navigation, visible keyboard focus, selected states and semantic section
headings make the expanded layout usable without a pointer.
