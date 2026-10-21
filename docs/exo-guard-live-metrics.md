# EXO product guard on live frames: measure instead of shrug

Code under test: **`0.3.0`** (live-metrics for the guard's assert rules).
Baseline: **`5d6c738`** (0.2.0, `setTextStyle`).

## Scope

`design_guard(inspect, target 358:1551)` — the freshly repaired Consumer
Model Library frame — returned **INDETERMINATE** with 8 of 13 checks
"needing a human judgement". Five of those were not judgement calls at
all: `critical-states-labeled`, `technical-typography`,
`primary-action-dominant`, `selected-unambiguous` and
`topology-explains-relationships` all assert numeric metrics, but the live
snapshot builder (`snapshotFromMetrics`) never populated any metric — so
every assert evaluated to "metric not collected" and the guard could only
shrug at real screens. (The remaining two manuals, `developer-apis` and
`model-fit-context`, genuinely need a human and are untouched.)

This is the same failure mode the guard's own test file pins down for
programs — a verdict that cannot tell "nothing wrong" from "nothing
checked" — except it was still the live path's everyday behaviour.

## The fix

`metricsFromLiveNodes` (`mcp-server/src/memory/guard.ts`, exported and
unit-tested) measures four metrics from the same `NodeMetrics` the
reviewer reasons over, and `snapshotFromMetrics`
(`mcp-server/src/memory/tools.ts`) now attaches them to every live
snapshot. The program path (`snapshotFromIR`) is unchanged in behaviour;
its machine-data recognisers were hoisted into the shared
`looksLikeMachineData` / `isMonospacedFace` helpers so the two paths
cannot disagree about what counts.

Precision-first rules, documented at each site:

- **unlabeledComponents** — non-TEXT layers named button/cta/pill/badge/
  chip/tab/action/indicator/status/state/dot/device. A candidate passes
  with words in its subtree, a caption contained in its bounds, an
  adjacent sibling label (the reviewer's geometry, so the two never
  disagree), or words in its GROUP/INSTANCE/COMPONENT unit — a status
  accent inside a row group that names its state is labelled. Dividers
  and hairlines (`isRuleLikeLive`) are never controls.
- **dominantActions** — non-TEXT layers named `\bprimary\b|\bcta\b|
  \bcommit\b`, same divider exclusion. Text captions are not claims, so a
  button and its label count once.
- **machineDataInProportionalFace** — the rule's exact four shapes
  (IP, latency, UUID, hex-with-digit); mono faces pass. Byte quantities
  stay display values.
- **ambiguousSelections** — only explicitly `active`/`selected` containers
  are checkable live (props do not survive measurement); nav-named nodes
  stay exempt as on the program path; a bold descendant or a signal-named
  sibling clears.

Genuinely absent measurements stay absent: links never survive to live
metrics, so the topology rules remain manual by construction — and say so
— rather than by default.

## Verification

- `tests/product-guard-regressions.test.mjs`: 6 new live tests (labelled
  row-group shape passes all four rules; anonymous button FAILs;
  divider/panel false-positive locks; double primary WARNINGs;
  proportional-vs-mono-vs-display typography; active-without-signal
  WARNINGs). Full file green.
- Full `npm test` chain green (see commit message for the count).
- Live, after deploy: `design_guard` on `358:1551` must show the four
  assert rules evaluated (PASS on this frame) with only
  `topology-explains-relationships` (links never survive measurement),
  `developer-apis` and `model-fit-context` manual — 0 failures.
  Verified 21 Oct 2026 on same-commit `055d7459eb6e`: 10 passed,
  0 failures, 0 warnings, manual count 4 (topology's two link checks plus
  the two genuinely-manual rules); measured metrics in evidence:
  `unlabeledComponents=0, dominantActions=1`,
  `machineDataInProportionalFace=0, ambiguousSelections=0`.

## Remaining deliberately-manual checks

`developer-apis` and `model-fit-context` are `manual`-kind evidence;
`topology-explains-relationships` needs links, which live measurement
does not produce. A live verdict therefore stays INDETERMINATE overall —
that is the honest verdict while judgement calls are open, pinned by the
existing "never PASS while unevaluated" tests.

## Follow-up: target selection asks instead of guessing (#18 scope)

Probed live against the same file, three defects in how `design_guard`
resolves its target (`decideGuardTarget` / `resolveGuardTarget`):

- `design_guard({target: ""})` threw a bare `find_node` transport error
  instead of returning the INDETERMINATE scope finding. A blank target is
  now a not-found miss with the same shape as every other miss.
- `design_guard({target: "Row"})` reported "matches 10 nodes" with 10
  candidates — but `find_node` matches **80**. The lookup window (now 25)
  is reported against the file-wide total, so a capped list says "at
  least N, showing first M" and never presents the cap as the count.
- A single match with no usable id became `use-id: ""`, which would
  resolve to whatever is selected — the silently-checked random selection
  #18 forbids. It is now a not-found miss.

Existing H04 wording (exact count, unique-name and missing-name messages)
is preserved. Covered by three `decideGuardTarget` unit tests in
`tests/product-guard-regressions.test.mjs`; shipped in **0.3.1**.
