# Issue #17 — release gate

**Verdict: PASS** — every mandatory assertion passed and every required artifact exists

Run `40bc6f89-2026-10-21T12-51-52-511Z` on commit `40bc6f893f935606140a1ccb710d2d93a88a48c0` (main), 2026-10-21T12:51:52.511Z → 2026-10-21T12:53:00.648Z, 68.1s.
Node v22.17.0 on win32-x64.

## Groups

| Group | What it covers | Status | Time | Detail |
| --- | --- | --- | --- | --- |
| **gauntlet** | Integrated gauntlet (brief, plan, native mutation, geometry, review, repair, report) | **PASS** | 0.6s | 26/26 case(s) passed, run twice with identical verdicts |
| **stress-matrix** | Issue #12 stress matrix | **PASS** | 0.7s | every case(s) passed |
| **acceptance** | Issue #13 acceptance matrix | **PASS** | 0.6s | every acceptance case passed |
| **regression** | Offline regression suites (#14 geometry and QA, #15 transactions, #16 generation) | **PASS** | 56.2s | 964/964 test(s) passed |
| **design-benchmark** | Offline design-planning benchmark | **PASS** | 8.7s | 9/9 benchmark case(s) passed |
| **live** | Live Figma evidence (render and review of a real screen) | **PASS** | 1.3s | the live benchmark completed (10/10 case(s) with real renders and reviews); 1 case(s) have no golden to compare against |

## Gauntlet cases (26/26 passed)

| ID | Case | Issue | Status | Measured |
| --- | --- | --- | --- | --- |
| **A01** | A complex brief becomes a composed screen with a dominant primary visualisation | #16 | **PASS** | focal 'content' holds 33% of the canvas; 5 regions, 16 content calls, 2 metric card(s) |
| **A02** | The visual direction is applied across the frame, not only to the dark visualisation | #16 | **PASS** | style 'technical-instrument' on 5/5 region(s); 1 dark surface(s) of 11; no invented values |
| **A03** | A new screen lands in free canvas instead of on top of the last one | #16 | **PASS** | the screen was placed at (3280, 0), clear of 2 existing frame(s) |
| **B01** | An asymmetric split view keeps the inspector fixed and the canvas fluid | #14 | **PASS** | canvas 816 wide at x=272, inspector 320 wide at x=1120, both at y=0 |
| **B02** | A five-region dashboard with thirty items keeps every child inside its parent | #14 | **PASS** | 5 regions, 32 items, every child contained |
| **B03** | A diagram's edges resolve their semantic endpoints and survive a resize | #14 | **PASS** | 2 connector(s) resolved against their nodes; a second compile of the same diagram agreed |
| **B04** | Long identifiers and error strings stay inside their region at 390px and 1440px | #14 | **PASS** | 8 text node(s) bounded at both viewports |
| **B05** | Extreme padding, gaps and nested sizing resolve to sane geometry | #14 | **PASS** | 4 extreme layout(s) resolved with positive extents |
| **B06** | Invalid input fails closed instead of producing a successful screen | #14 | **PASS** | 4 invalid input(s) all failed closed |
| **B08** | The compiler keeps one coordinate space and reconciles the other | #18 | **PASS** | the resolved box is page-absolute, the operation is parent-local, and the trace check agrees |
| **C01** | Every edge contacts the node it names, and a connector inside its parent is not a defect | #14 | **PASS** | the edge resolved to both device nodes, and the reviewer did not report its parent as the endpoint |
| **D01** | Seeded legibility defects are detected with targets and measurements | #14 | **PASS** | 2 review finding(s); contrast {"textColor":"#C9C6BC","background":"#FFFFFF","surfaceSource":"parent surface 'Nav'","ratio":1.71,"required":4.5,"fontSize":14,"bold":false,"layerName":"Cluster","proposedFill":"#7C7664","proposedRatio":4.53,"repairVerified":true}; the identifier is truncated and reported |
| **D02** | Legitimate patterns are not reported, and the thresholds are not lowered | #14 | **PASS** | no finding against the 1 legitimate pattern(s); thresholds unchanged (4.5:1 / 3:1, 11px baseline) |
| **E01** | The review engine finds the seeded defects and leaves the legitimate patterns alone | #14 | **PASS** | 1 true defect(s) found with node ids, 0 false positives |
| **E02** | The reviewer tells a search field from a topology connector | #14 | **PASS** | the placeholder inside the search field and the two rules are untouched; the label on the connector is still serious and the icon button is still reported |
| **E03** | Intended containment is not a collision; every real overlap still is | #18 | **PASS** | 5 intended containments left alone; the stray connector and the overlapping text are reported |
| **F01** | A repair is proposed with targets, applied, re-checked, and its effect is measured | #14 | **PASS** | one targeted repair, one named target, nothing else touched |
| **F02** | An unrepairable issue and a failed repair are not reported as fixed | #14 | **PASS** | no repair was invented, and the budget exhaustion was reported as such |
| **G01** | The real plugin bundle applies 15/40/62/100/150-op workloads and reports the timings | #15 | **PASS** | 5 workload(s) applied atomically; median apply 7ms, worst 19ms |
| **G02** | A validation failure, a mid-batch failure and a duplicate transaction all fail safely | #15 | **PASS** | validation, mid-batch failure and duplicate submission all behaved |
| **G03** | Concurrent mutations against the same session do not lose or duplicate a node | #15 | **PASS** | two concurrent transactions both landed; the document holds 2 frames and no duplicates |
| **H01** | An empty, stale, missing or disconnected inspection can never report PASS | #14 | **PASS** | every empty or missing input produced a non-PASS outcome |
| **H02** | A render that fails after a successful commit is blocked, not verified | #14 | **PASS** | a successful commit with no render is 'indeterminate', not a pass |
| **H03** | A review that could not examine the screen is INDETERMINATE, never a pass | #14 | **PASS** | an empty, a truncated, a failing, an advisory and a clean review each get their own verdict |
| **H04** | A screen that cannot be resolved is an ambiguity, not a random selection | #18 | **PASS** | a node id is used directly, a unique name resolves, and an ambiguous or missing name asks |
| **I01** | Two consecutive builds of the same brief produce the same structure | #17 | **PASS** | 38 operation(s) and 5 region(s) identical across two runs |

## Coverage map

The gate is only as good as this map: a criterion with no test is a criterion nobody is checking.

| Acceptance criterion | Exercised by |
| --- | --- |
| #14 geometry, constraint, ID/token and empty-scope regressions stay green | `B01`, `B02`, `B03`, `B04`, `B05`, `B06`, `B08`, `H01`, `suite:issue14` |
| The compiler keeps one coordinate space and reconciles the other | `B08` |
| #16 generation fixtures G01-G14 are included or mapped | `A01`, `A02`, `A03`, `I01`, `suite:issue16` |
| #15 transaction safety and failure injection are included or mapped | `G01`, `G02`, `G03`, `suite:issue15` |
| Topology edges attach to correct semantic nodes after reflow | `B03`, `C01` |
| No unexpected clipping, collision, overflow, broken hierarchy or unreadable operational text | `B04`, `D01`, `D02`, `E01` |
| Contrast is measured against the true rendered surface; thresholds unchanged | `D01`, `D02` |
| Semantic false-positive and false-negative counts are reported against seeded expectations | `D02`, `E01`, `E02`, `E03` |
| The review engine tells a search field from a topology connector, and containment from a collision | `E02`, `E03` |
| Every repair is verified by a second structural check and render/review | `F01`, `F02`, `H02` |
| No empty, stale, skipped or failed inspection can return PASS | `H01`, `H02`, `H03`, `B06` |
| Scope is resolved to the intended screen, and an ambiguous scope asks | `H04` |
| Performance is measured without bypassing correctness checks | `G01`, `suite:issue15` |
| Retrying or rolling back leaves no duplicate or orphan nodes | `G02`, `G03`, `suite:issue15` |
| The evidence bundle is complete and tied to an exact commit SHA | `gate:summary` |
| The test is repeatable on two consecutive runs | `I01`, `gate:repeat` |

## Failure-injection scenarios

Each scenario the issue names, and the test that covers it. A scenario nobody claims is a scenario nobody is running.

| Scenario | Exercised by |
| --- | --- |
| A validation failure before any mutation | `G02`, `suite:issue15#FI01` |
| A mid-batch creation failure | `G02`, `suite:issue15#FI02` |
| A timeout while the apply is still running, with a late completion | `suite:issue14#T01`, `suite:issue14#T02`, `suite:issue15#cancel` |
| A retry while the original status is unknown | `suite:issue14#T02`, `suite:issue15#FI04` |
| A partial rollback failure | `suite:issue15#FI06`, `suite:issue14#P06` |
| A parent that disappears during execution | `suite:issue15#FI03` |
| A delayed or failed font load | `suite:issue15#FI05` |
| A render or review failure after a successful commit | `H02`, `suite:issue14#review-failures` |
| A duplicate transaction submission | `G02`, `suite:issue15#FI04` |
| Concurrent mutations against the same target | `G03` |
| An empty target snapshot despite a non-empty requested frame | `H01`, `B06` |
| A stale or unresolved node id | `B06`, `suite:issue13#L02` |
| A disconnected inspection or runtime | `suite:issue14#T01` |
| A missing render output | `H02` |
| A review failure | `H01`, `suite:issue14#review-failures` |
| A mismatch between the reported and the native geometry | `B02`, `B03`, `suite:issue14#L06` |
| Missing expected components | `B06`, `suite:issue13#L02` |
| Operation success with a visually broken result | `H02`, `A01` |
| An unresolved mandatory constraint | `B06` |
| A skipped test or an absent artifact | `gate:summary` |

## What this gate does not cover

Stated here rather than left for someone to find. A gate that lists its gaps is more useful than one that claims to check everything.

### The live evidence was measured against a deployment, and the deployment is not the repository

The server is deployed and Figma loads the plugin bundle once, so either can be older than the commit the evidence names. The live group now says how many cases were measured against an older commit and how many cannot name their build at all. Redeploying the server and reopening the plugin panel is what ties the live evidence to the code.

### A golden is a regression reference, not an approval

The goldens record what each screen looked like when a human looked at it, so a later run can be told that it changed. They do not say the screen was good: the review rules judge the screen, and a golden can only be stored through an explicit review (npm run goldens:update -- --approve).

### Text height is estimated, not measured

The server has no font metrics, so a text node's height is a character-count estimate. The pipeline measures the width a text lands at, and a region holding text cannot be handed to Figma's own auto layout for that reason.

### The native path is covered structurally, not visually

The native check proves the native path executes against the real Plugin API, builds a real auto-layout frame, renders it, and cleans up after itself. It does not compare that render against a golden: the native path is model-authored, so what it builds is not a fixed reference.

## How to reproduce

```
npm run gate
```

The machine-readable summary is `artifacts/release-gate/latest.json`, and the per-case evidence is in `artifacts/release-gate/cases/`.
