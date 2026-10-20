# Issue #17 — release gate

**Verdict: INDETERMINATE** — 1 group(s) could not run: live

Run `6a4ee738-2026-10-20T04-31-24-224Z` on commit `6a4ee738bf76695ed829296589583d98759c8d0a` (main), 2026-10-20T04:31:24.224Z → 2026-10-20T04:33:27.437Z, 123.2s.
Node v22.17.0 on win32-x64.

## Groups

| Group | What it covers | Status | Time | Detail |
| --- | --- | --- | --- | --- |
| **gauntlet** | Integrated gauntlet (brief, plan, native mutation, geometry, review, repair, report) | **PASS** | 0.8s | 18/18 case(s) passed, run twice with identical verdicts |
| **stress-matrix** | Issue #12 stress matrix | **PASS** | 1.3s | every case(s) passed |
| **acceptance** | Issue #13 acceptance matrix | **PASS** | 1.2s | every acceptance case passed |
| **regression** | Offline regression suites (#14 geometry and QA, #15 transactions, #16 generation) | **PASS** | 75.1s | 879/879 test(s) passed |
| **design-benchmark** | Offline design-planning benchmark | **PASS** | 41.4s | 9/9 benchmark case(s) passed |
| **live** | Live Figma evidence (render and review of a real screen) | **BLOCKED** | 3.3s | the live benchmark did not complete (9/10 case(s) produced, missing hard-stress-test) |

## Gauntlet cases (18/18 passed)

| ID | Case | Issue | Status | Measured |
| --- | --- | --- | --- | --- |
| **A01** | A complex brief becomes a composed screen with a dominant primary visualisation | #16 | **PASS** | focal 'content' holds 42% of the canvas; 4 regions, 16 content calls, 2 metric card(s) |
| **A02** | The visual direction is applied across the frame, not only to the dark visualisation | #16 | **PASS** | style 'technical-instrument' on 4/4 region(s); 1 dark surface(s) of 12; no invented values |
| **B01** | An asymmetric split view keeps the inspector fixed and the canvas fluid | #14 | **PASS** | canvas 816 wide at x=272, inspector 320 wide at x=1120, both at y=0 |
| **B02** | A five-region dashboard with thirty items keeps every child inside its parent | #14 | **PASS** | 5 regions, 32 items, every child contained |
| **B03** | A diagram's edges resolve their semantic endpoints and survive a resize | #14 | **PASS** | 2 connector(s) resolved against their nodes; a second compile of the same diagram agreed |
| **B04** | Long identifiers and error strings stay inside their region at 390px and 1440px | #14 | **PASS** | 8 text node(s) bounded at both viewports |
| **B05** | Extreme padding, gaps and nested sizing resolve to sane geometry | #14 | **PASS** | 4 extreme layout(s) resolved with positive extents |
| **B06** | Invalid input fails closed instead of producing a successful screen | #14 | **PASS** | 4 invalid input(s) all failed closed |
| **C01** | Every edge contacts the node it names, and a connector inside its parent is not a defect | #14 | **PASS** | the edge resolved to both device nodes, and the reviewer did not report its parent as the endpoint |
| **D01** | Seeded legibility defects are detected with targets and measurements | #14 | **PASS** | 2 review finding(s); contrast {"textColor":"#C9C6BC","background":"#FFFFFF","surfaceSource":"parent surface 'Nav'","ratio":1.71,"required":4.5,"fontSize":14,"bold":false,"layerName":"Cluster","proposedFill":"#7C7664","proposedRatio":4.53,"repairVerified":true}; the identifier is truncated and reported |
| **D02** | Legitimate patterns are not reported, and the thresholds are not lowered | #14 | **PASS** | no finding against the 1 legitimate pattern(s); thresholds unchanged (4.5:1 / 3:1, 11px baseline) |
| **E01** | The review engine finds the seeded defects and leaves the legitimate patterns alone | #14 | **PASS** | 1 true defect(s) found with node ids, 0 false positives |
| **F01** | A repair is proposed with targets, applied, re-checked, and its effect is measured | #14 | **PASS** | one targeted repair, one named target, nothing else touched |
| **F02** | An unrepairable issue and a failed repair are not reported as fixed | #14 | **PASS** | no repair was invented, and the budget exhaustion was reported as such |
| **G01** | The real plugin bundle applies 15/40/62/100/150-op workloads and reports the timings | #15 | **PASS** | 5 workload(s) applied atomically; median apply 15ms, worst 17ms |
| **G02** | A validation failure, a mid-batch failure and a duplicate transaction all fail safely | #15 | **PASS** | validation, mid-batch failure and duplicate submission all behaved |
| **H01** | An empty, stale, missing or disconnected inspection can never report PASS | #14 | **PASS** | every empty or missing input produced a non-PASS outcome |
| **I01** | Two consecutive builds of the same brief produce the same structure | #17 | **PASS** | 38 operation(s) and 4 region(s) identical across two runs |

## Coverage map

The gate is only as good as this map: a criterion with no test is a criterion nobody is checking.

| Acceptance criterion | Exercised by |
| --- | --- |
| #14 geometry, constraint, ID/token and empty-scope regressions stay green | `B01`, `B02`, `B03`, `B04`, `B05`, `B06`, `H01`, `suite:issue14` |
| #16 generation fixtures G01-G14 are included or mapped | `A01`, `A02`, `I01`, `suite:issue16` |
| #15 transaction safety and failure injection are included or mapped | `G01`, `G02`, `suite:issue15` |
| Topology edges attach to correct semantic nodes after reflow | `B03`, `C01` |
| No unexpected clipping, collision, overflow, broken hierarchy or unreadable operational text | `B04`, `D01`, `D02`, `E01` |
| Contrast is measured against the true rendered surface; thresholds unchanged | `D01`, `D02` |
| Semantic false-positive and false-negative counts are reported against seeded expectations | `D02`, `E01` |
| Every repair is verified by a second structural check and render/review | `F01`, `F02` |
| No empty, stale, skipped or failed inspection can return PASS | `H01`, `B06` |
| Performance is measured without bypassing correctness checks | `G01`, `suite:issue15` |
| Retrying or rolling back leaves no duplicate or orphan nodes | `G02`, `suite:issue15` |
| The evidence bundle is complete and tied to an exact commit SHA | `gate:summary` |
| The test is repeatable on two consecutive runs | `I01`, `gate:repeat` |

## How to reproduce

```
npm run gate
```

The machine-readable summary is `artifacts/release-gate/latest.json`, and the per-case evidence is in `artifacts/release-gate/cases/`.
