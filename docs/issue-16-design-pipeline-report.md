# Issue #16 — a design-intent → composition → build → verification pipeline

Code under test: **this commit** (`Issue #16: give the pipeline a brief, a plan, a trace and an honest report`)

## Scope of this pass

Issue #16 asks for a first-class pipeline: interpret the brief, plan a coherent
composition, build it from semantic primitives, verify the *actual* result, repair
what can be repaired safely, and report honestly what was done.

The issue is large and additive to #14 (geometry/QA) and #15 (latency). This pass
implements the **generation and orchestration layer** the issue describes, and it
implements it as a pipeline rather than as another primitive: one tool, one trace,
one report.

What is in:

| Stage | What it does | Where |
| --- | --- | --- |
| 1 — Brief | Normalizes the brief, separates statements from inferences, and refuses contradictions **before anything is created** | `mcp-server/src/pipeline/brief.ts` |
| 2 — Plan | Region tree with bounds, layout, padding, gap, alignment, responsive behaviour, density, constraints, priority, interaction, plus the content slots and a canvas-usage analysis | `mcp-server/src/pipeline/plan.ts` |
| 3/4 — Primitives & visual system | Maps the brief's information onto semantic primitives; the direction travels into the build as the runtime's style | `mcp-server/src/pipeline/program.ts` |
| 5 — Build | Two-pass compile (text widths are *measured* from the resolved layout), native auto-layout containers where they are exact, one tracked transaction | `mcp-server/src/pipeline/tools.ts`, `mcp-server/src/transaction.ts` |
| 6 — Verification | Structural checks against the resolved geometry — not the operation log | `mcp-server/src/pipeline/verify.ts` |
| 7 — Repair | Targeted, bounded, idempotent repairs; a repair without a named target is refused | `mcp-server/src/pipeline/repair.ts` |
| 8 — Report | Six buckets: generated, structurally verified, visually reviewed, automatically repaired, remaining findings, blocked | `mcp-server/src/pipeline/report.ts` |

## The finding that shaped the implementation

The issue's central claim is that *"successful Figma operations and a successful
render did not, by themselves, guarantee a polished result."* That is not a
theoretical concern in this codebase, and the pipeline found the reason it keeps
happening:

**The runtime computed the geometry; the plan promised a different geometry.**

`plan_screen` resolves the shell layout from the region's *declared* size. The
compiler then places the content, and a region whose content needs more room than
it was given grows — pushing every region below it down. The plan's numbers were
never updated, so the plan and the build disagreed, and the disagreement showed up
as content running off the bottom of the canvas.

So the pipeline does not trust the plan's numbers. It compiles once, measures the
layout the compiler actually produced, and compiles again with the text widths
taken from that measurement. The pipeline's verification then compares the plan's
bounds with the compiled bounds and reports the difference as a finding
(`plan-matches-build`) rather than letting the two disagree quietly.

Two more findings came out of building the pipeline:

- **A region's capacity is a function of its size, not a number.** A status rail
  is a 56px strip. The first version of the pipeline put nine readouts into it,
  the region grew to 692px, and the screen ran off the canvas. The pipeline now
  works out each region's column count from its height *and* its width — enough
  columns for the items to sit in the rows the region has, and never so many that
  a column is narrower than the content it holds — and then moves or drops what
  still does not fit.
- **A repeated readout is a row, not a card.** The product's own guard allows two
  metric cards on a screen. A dense dashboard of thirty items drawn as thirty
  cards is the wall that guard exists to prevent, so past the second card the
  pipeline draws rows.

## Changes outside the pipeline

| File | Change | Why |
| --- | --- | --- |
| `mcp-server/src/transaction.ts` | `dispatchTransaction` moved out of the tool table | The semantic runtime reached the plugin directly and bypassed the job ledger, so a retried runtime build duplicated the whole screen and a timed-out one left nothing to reconcile against. One dispatcher, three callers. |
| `mcp-server/src/runtime/tools.ts` | `design_runtime` now dispatches through the ledger | G10: a retry must not duplicate a screen. |
| `mcp-server/src/runtime/compile.ts` | New `autoLayout: "vertical"` region option | Stage 3/5: a region whose children have known extents is built as a native Figma auto-layout container, so a designer can re-lay it out in the file. Refused (with a stated reason) when the region holds text, because text height is estimated rather than measured and Figma's own layout would move every sibling below it. |
| `mcp-server/src/runtime/interpreter.ts`, `primitive-schema.ts`, `shared/ir.ts` | The new option is carried through the IR | — |
| `mcp-server/src/tools.ts`, `shared/protocol.ts` | The `design_pipeline` tool | The pipeline is one call, not eight. |

## What the pipeline refuses to do

These are the issue's guardrails, and each one is a test:

- **A contradictory brief is refused before any mutation.** A direction that
  contradicts an anti-goal, data called live that is described as sample, the
  same item both required and optional, an action that is both primary and
  secondary, a viewport too small to compose: each is a blocker, and the
  pipeline returns without contacting Figma (`G11`).
- **An empty or stale inspection is never a pass.** A build that created no
  nodes is `indeterminate`; a render of an older revision is `fail` (`G13`).
- **A render discrepancy is caught even when every operation succeeded** (`G14`).
- **A repair touches only the nodes it names.** A finding with no targeted
  operation is reported for a human instead of being applied (`G12`).
- **A retry cannot duplicate the screen.** The build is deterministic, and the
  ledger returns the prior result for a repeated transaction id (`G10`).

## Testing

`tests/issue-16-pipeline.test.mjs` — 22 tests, one per fixture and one per
guardrail. The fixtures run offline against the real planner, the real compiler
and the real verifier, and each stores its evidence in `artifacts/pipeline/`:

| Fixture | What it proves | Evidence |
| --- | --- | --- |
| G01 | A product overview becomes a composed screen with a focal region, a primary action and supporting content, and the program resolves | `artifacts/pipeline/G01.json` |
| G02 | An asymmetric split view keeps the inspector fixed and the canvas fluid | `G02.json` |
| G03 | A dense dashboard holds thirty items without losing its structure | `G03.json` |
| G04 | Long identifiers and error messages wrap inside their region at 390px and 1440px | `G04.json` |
| G05 | A relationship is drawn between the nodes it names, and the connector resolves to them | `G05.json` |
| G06 | A reference-led direction becomes rules, and the observation stays separate from the assumption | `G06.json` |
| G07 | One visual system produces two different screens | `G07.json` |
| G08 | Repeated surfaces are reported as duplicates rather than shipped silently | `G08.json` |
| G09 | The declared states are part of the composition | `G09.json` |

The remaining tests cover G10, G11, G12, G13 and G14.

```
npm run test:issue16
```

The whole suite is green (`npm test`), and #14's geometry/QA regressions were
not weakened: the compiler change is opt-in, and the dispatcher's behaviour is
unchanged for the tools that already used it.

## Not addressed

Honest list of what this pass does **not** do:

- **The native path is not wired into the pipeline.** The pipeline builds through
  the semantic runtime. `plan_screen.execution.nativeRequired` still routes
  composition-led screens to `figdes_use_figma` by hand. Wiring the native path
  into the pipeline would need a native program compiler, which does not exist.
- **The runtime still creates no component instances.** A repeated surface is
  *reported* (`reuse`) rather than turned into a shared instance, because the
  runtime has no instance primitive. G08 is therefore a detection, not a fix.
- **Text height is still estimated.** The pipeline measures the *width* a text
  node gets from the resolved layout, but the height Figma will use is not known
  server-side, so a region holding text still cannot be handed to Figma's own
  auto layout.
- **The visual review is still the model's judgement.** The pipeline renders the
  built frame and binds the render to a revision, and it reports the visual
  bucket as `review` rather than `pass` until a human or a vision model has
  looked at it. It does not claim a visual verdict it cannot make.
- **Live Figma evidence was not produced for this pass.** The fixtures run
  offline; the apply, read-back, render and repair stages are exercised against
  the same code paths but not against a live document. `npm run benchmark:live`
  with the plugin connected is the gate for that.

## How to use it

```jsonc
{
  "brief": {
    "product": "EXO Labs",
    "screen": "Fleet Overview",
    "purpose": "See the health of the fleet and decide where to intervene",
    "primaryDecision": "monitor fleet health and decide where to intervene",
    "primaryAction": "Open cluster",
    "requiredInformation": ["cluster health", "GPU memory", "model throughput", "node topology"],
    "visualDirection": "technical-instrument",
    "antiGoals": ["a wall of identical metric cards"],
    "dataMode": "demo"
  },
  "mode": "build"
}
```

`mode: "plan"` returns the brief, the plan, the program and the structural
verification without touching Figma. `mode: "build"` applies it as one tracked
transaction, reads the screen back, runs the review rules, renders it, applies
the safe repairs, and returns the report.
