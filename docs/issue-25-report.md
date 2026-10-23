# Issue #25 close-out — live EXO topology stress test

Generated 2026-10-23. **Tested commit `34b513a857808a42b9013892efe24acab4bd5a8d` (main).**
Live plugin build `34b513a85780`, live server build `34b513a85780`, compatibility `same-commit` (verified via `figma_status`, `buildSource: live`) immediately before the final evidence run.

## Verdict

**Release gate: PASS** (`npm run gate`, run `34b513a8-2026-10-23T16-35-53-975Z`) — every mandatory group green:

| Group | Result | Measured |
| --- | --- | --- |
| gauntlet (#17) | PASS | 26/26 case(s), run twice with identical verdicts |
| stress-matrix | PASS | every case passed |
| acceptance (#13) | PASS | every case passed |
| regression (full `npm test`) | PASS | 1266/1266 test(s) |
| design-benchmark | PASS | 9/9 case(s) |
| fidelity (#26) | PASS | 0/0 matrix |
| **build-integrity (#25, new)** | PASS | all 11 live evidence record(s) name this HEAD |
| live | PASS | 10/10 case(s) with real renders and reviews |

## What the stress test exposed, and what was fixed

### P0 — Environment/version integrity
- The issue's evidence ran a mixed pair (plugin `a41459502f13-dirty`, server `73e44a193909`, `different-commit`). During this close-out the live pair was redeployed and reloaded through three cycles (61a8b1e → 61f86dc → 34b513a); each redeploy was verified `same-commit` before measuring.
- **`build-integrity` is now a mandatory release-gate group** (`scripts/lib/live-client.mjs` `evaluateBuildIntegrityEvidence`, wired into `scripts/run-release-gate.mjs`): a `different-commit` pair, a missing/`unknown` stamp, or a stamp that does not name the current HEAD **fails the run outright** (nonzero exit). Absent evidence is BLOCKED — and a BLOCKED build-integrity group can never yield an overall PASS.
- `assertBuildIntegrity()` gates `benchmark:live:stress` and `benchmark:live:native` at startup; the dry-run verdict (`applicabilityBasis`, measurement receipt) is recorded in every live case record.
- The stale checked-in evidence (`40bc6f89`/`02c8af33`) was retroactively invalidated by the new rule — the gate helper returns FAIL against it, as intended. Fresh evidence replaced it.
- The server advertised version `0.3.4` while every manifest said `0.3.5`; `mcp-server/src/mcp.ts` now advertises `PLUGIN_VERSION`.

### P0 — Runtime geometry and text measurement
- **Root cause of `measuredTextUsed: 0` + estimates**: `measureProgramText` scanned only direct `fn:"text"` calls in the raw program, so text synthesized by primitives (`deviceNode`, `statusPill`, connector labels, `metric`) was never measured — and a component-only topology fixture didn't even count as needing measurement (`applicabilityBasis: "none-needed"`). A dry run without an explicit `sessionId` also discarded the connected plugin.
- Fixed: the measurement derives specs from the first compile's `createText` operations; `applicabilityBasis` is `"measured"` **only** when every required text node was measured (counted from the final compiled ops, surfaced as `stats.requiredTextNodes` / `stats.measuredTextNodes`); a dry run reuses the single connected plugin when unambiguous; a run with required-but-unmeasured text carries a fail-closed `measurement.verdict: "BLOCKED"` + `acceptance: "BLOCKED"` marker and warning.
- **Live verification**: the EXO topology fixture now measures **7/7** required text nodes (`applicabilityBasis: "measured"`, `measurement.verdict: "ok"`), and the full deployment-fit pipeline dry run measures **21/21** (the stress frame 26/26) — with no violations.
- **Containment/connector collision**: the stress fixture's topology region stacked its four device nodes into one **overlapping column** (root cause: interactions became connector *content* but never reached the graph layout as edges), which forced connector-2 (hub→device-02) through device-01's box. Fixed at the root: the pipeline emits `program.links` from the drawn interactions, so the region arranges as a real graph. The build then comes back applicable with **no connector-collision, no overlap, no off-canvas violations**, and the stress frame rendered and reviewed clean on the redeployed build (all six #10 defect probes measured resolved).
- **Text below the readable floor**: the `muted` contrast intent scaled display type by 0.9, rounding the 11px eyebrow to 10px and (correctly) refusing the build. The emitted font size is now floored at 11px (`emittedFontSize`, consistent across emit, fit-check and estimate paths) — the multipliers shape hierarchy but never override the floor.

### P0 — Plan-to-runtime composition fidelity
- The runtime now reports its own **`appliedComposition`** (`inferComposition` over the resolved regions) on every `design_runtime` payload.
- The pipeline reports a full **`compositionReceipt`**: `requested` (verbatim from the brief), `selected` (final plan-level choice), `steered` (engine proposal), `applied` (runtime's own resolver), `mismatch: { requested, selected }`, plus the evidence used (hint source, per-region composition/layout, actual algorithms). A tiny, tested alias table (`compositionMatches`) covers legitimate label synonyms.
- `plan_screen` echoes `requestedComposition`, `selectedComposition` and a clearly-labelled `predictedAppliedComposition` (predicted — no runtime compile happened).
- `compositionHintApplied` keeps its source-detection meaning (documented; not redefined), so it can no longer be mistaken for geometry evidence.
- **Live verification**: the deployment-fit dry run returns `requested: null → selected: "instrument" → applied: "split-view"`, `mismatch.selected: true` — the divergence between what the plan selected and what the region roles actually support is now a fact in the payload, not a silent drift.

### P1 — Quality and product guard
- Thresholds were verified in code and left untouched: normal-text contrast floor 4.5:1 (`CONTRAST_MIN_NORMAL`), large-text 3:1, technical-text floor 11px with a documented-exception mechanism (`exception: { reason }`), the radius scale rule (`RADIUS_SCALE` + `isOnRadiusScale`), token-consistency checks, and reusable-text-style adoption with an honest fallback warning. Nothing was lowered or suppressed.
- The honest-verdict rule held in practice: the stress frame's review reports 1 minor finding, and the product guard stays `INDETERMINATE` (13 rules checked, 0 failures, 2 needing human judgement) — never a PASS on incomplete evidence.

## Phase B visual evidence (disposable frames only)

Every evidence frame is a clearly-marked disposable fixture (`FigDes Live — <case>` / `[fixture]` text; the native-path check frame `FIGDES_NATIVE_CHECK_V01` was created, inspected, and removed with `leftBehind: 0` verified). No production EXO frame was touched.

- Fresh renders: `artifacts/design-benchmark/live/shots/<id>-r1.png` (9 semantic cases + stress frame, all recorded at build `34b513a85780`).
- Vision pass: `artifacts/design-benchmark/live/vision-phase-b-fresh.json` — every case judged by direct PNG inspection. Result: **all structurally clean** (no collisions, no clipping, no off-canvas, real content, readable labels); consistently **WATCH on sparsity** (the minimal fixture programs hug the top-left, leaving 60–90% empty canvas — recorded, not hidden), plus two named stress-frame findings: a red `ready` state pill beside a brief value of `Degraded`, and support metrics rendering blank dashes.
- Goldens: the three genuinely-changed cases (`exo-compute-topology`, `hard-stress-test`, `spatial-relationship`) were re-stored as reviewed references through the explicit-approval path (`node scripts/update-live-goldens.mjs --approve`), per the repo's golden policy.

## Consolidated remaining failures (honest list)

1. **Composition (scored 5/10 in the issue's evidence)** — the fixture screens remain under-composed: sparse top-left clustering with large empty bands. This is fixture minimalism plus real planner composition weakness; it is recorded in `vision-phase-b-fresh.json` and is the top remaining quality item, not a pass.
2. **The stress frame's `ready` state pill contradicts its stated `Degraded` cluster value** — the state-marker source (state expansion) needs to derive from the brief's value, not the default state.
3. **Support metrics that lack brief values render blank dashes** — they should be omitted or carry the disclosure rather than empty instrumentation.
4. **`generic-saas-dashboard` has no golden to compare against** (it is guard-refused evidence; its grading is the refusal itself — a golden reference for the refusal record would complete live coverage).
5. **`type.space.one-rhythm` (high)** — the deployment-fit plan stacks three sibling-gap values (8/16/24px); respacing or a stated reason per break is still owed.
6. **`plan-matches-build` drift (medium, advisory)** — planned vs built geometry differs in three regions (the build grows regions to fit content); the honest receipt reports it rather than hiding it.

Issues #17 (release gauntlet) and #23 (pipeline requirements) were exercised through their existing runners here — no duplicate harness was created, and neither is closed by this fixture.
