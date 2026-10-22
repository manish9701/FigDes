# Issue #23 — report: enforce the design-intelligence pipeline and block avoidable screen-quality failures

**Date:** 22 October 2026
**Scope:** implement [GitHub issue #23](https://github.com/manish9701/FigDes/issues/23). Existing systems were audited first and extended; no parallel framework was created, and no prompt-only behaviour was involved.

## What was audited and reused

The audit confirmed the pipeline exists end to end and is the primary path (`mcp-server/src/pipeline/tools.ts` 8-stage `design_pipeline`: brief → skills → alternatives → plan → program/verify → apply → verify-live → repair → final QA), with the planner (`plan/planner.ts`), intent compiler (`design/skills/intent-compiler.ts`), composition engine (`design/composition/planner.ts` + alternatives engine), design guards (`memory/guard.ts` + `effectiveRules`), critic (`design/quality/*`), renderer (`render-tool.ts` + `figdes_inspect_visual`), and final gate (`design/quality/final-gate.ts`). The gaps were: (a) the preflight edge warned instead of blocking for the geometry classes issue #23 names; (b) "product truth" text demanded per-value disclosure labeling — producing disclaimer pressure; (c) typography/contrast floors existed but were advisory; (d) the final verdict was score-shaped rather than truth-shaped; (e) no committed regression fixtures pinned the EXO V2 first-pass failure classes.

## Changes

### 1. Blocking preflight before any document mutation (`preflight-blocking.ts` — new)

Deterministic, no-async, dry-run-safe program-level checks appended to `validateTransaction` and enforced at the transaction edge (`transaction.ts` delegates and refuses with the ledger label `blocked: preflight (<tag>) refused N issue(s)`):

| Check | Rule |
|---|---|
| Duplicate identity / multi-parent | An id declared twice, or a node assigned >1 parent within one transaction, blocks (createGroup/boolean re-cluster carve-out covers legitimate op patterns) |
| Children outside parent bounds | Blocks unless the owning region's overflow is `"allow"` **with a recorded justification**; `clip`/`forbid` and allow-without-reason block; a missing overflow record fails **closed** to blocking |
| Text bounds | Measured content wider than its allocation by >1px blocks unless the text can wrap; auto-sizing text exempt; text with no measurement is silent (neither pass nor warning) |
| Connector alignment | Resolved connector endpoints must land on the `from`/`to` boxes (2px touch epsilon, matched to the compiler's REACH); a label fully off its edge's hull blocks |
| Ambiguous/stale targets | A target removed earlier in the same transaction, or provably unmintable, blocks; a merely-suspicious forward reference stays a warning |
| Resolved vs emitted geometry | >1px drift on deliberately-sized axes blocks unless the trace records a validated reason; fill/hug axes are exempt via the sizing map |
| Brief blockers at the edge | A brief with blocking contradictions refused at the dispatch boundary (before the idempotency lookup), so it can never reach a live build even when invoked off-path |

**Wiring (orchestrator):** the pipeline's apply stage now passes `PreflightContext` — resolved boxes, per-region overflow, sizing intents, measured text metrics, brief blockers — with `create_design`; `design_runtime` passes the same evidence from the compiled IR. No emitter makes a check "skip silently": absent evidence leaves a check un-run rather than passing.

### 2. Mandatory pipeline, integrated not duplicated

The pre-flight layer is threaded through the *existing* dispatcher every mutating tool shares; `create_design`/`modify_design`/`design_runtime`/`figdes_use_figma` all inherit it. The pipeline's `applicability` refusal ("resolved geometry is not what the program asked for") stays the gate before any build; draft briefs with blockers cannot pass the transaction edge. No alternative code path bypasses the checks.

### 3. Composition reasoning

Already present from issues #22/#24 (≥3 audited-distinct alternatives, six structural axes, `selectComposition`, plan-level composition hints, negative-space/density commitments, trace provenance). Verified against #23's list; no new system added. The final-gate regression test asserts a high numeric score cannot produce a PASS verdict while severe geometry issues (duplicate id + out-of-bounds child) FAIL the guard.

### 4. Disclosure noise without faking truth (`pipeline/disclosure.ts` — new)

- The audit found the noise's real source: `product-critic`'s repair text demanded "every value labelled", plus assumption/trace notes repeating "illustrative, not live telemetry" — no screen element ever carried it.
- Policy: **at most one** concise disclosure per screen, placed once (footer-adjacent or on the data region it qualifies); deterministic ladder, dedupe via a data-word marker set; `cleanConcept: true` (new brief field, provenance-tracked) suppresses the on-screen disclosure entirely while the trace/report keep the illustrative truth.
- `product.claims-live-data-without-source` stays **critical** — truthfulness and visual quality are now separate checks: the suggested fix asks for one disclosure, not per-value labels, and invented live-capability claims still FAIL.

### 5. Blocking typography / accessibility / design-system rules

Already present and upgraded where advisory: 12px body / new 11px dense-technical floors (below-floor text blocks **unless** a documented exception reason is attached, which is then recorded); WCAG AA contrast (4.5:1 / 3:1) now a critical finding; state-not-colour-only (identical text differing only by resolved colour on one surface); one-off colour blocking when it sits within 0.04 redmean distance of a token colour; near-duplicate token consolidation warnings with `suggestedOperations`; stroke-count and off-scale-spacing consistency symmetric to the existing radius/family rules; no token system discovered ⇒ `not-evaluated`, never a false verdict.

### 6. Truthful final QA — PASS / FAIL / BLOCKED by evidence

`FinalQualityReport` gains additive `verdict` / `verdictReasons` / `gates` / `stamp`: six required gates enumerated with status (`ran` | `skipped` | `failed` | `notEvaluated`); a skipped, failed, or not-evaluated required gate forces FAIL (ran-and-found-blocker) or BLOCKED (could not run) — **never PASS**; a build/session stamp (`SERVER_BUILD` + transaction) ties the verdict to the exact build and screen transaction. `status` semantics are untouched for backward compatibility.

### 7. Regression fixtures — the EXO V2 first-pass failure classes

`design/benchmark/offline-briefs.ts` adds `EXO_REGRESSION_BRIEFS` (topology/compute-operations, model selection/configuration, dense table, empty/error state + the existing `generic-saas-dashboard` negative control by reference) and `EXO_REGRESSION_FAILURE_CLASSES` (8 classes). `suite.ts` registers `EXO_REGRESSION_CASES` (5). The frozen v1 benchmark lists are byte-untouched, so `issue-22-benchmark-gate` and existing artifacts are unaffected. New standard test: `tests/issue-23-exo-regressions.test.mjs`.

## Test evidence

| Suite | Coverage | Result |
|---|---|---|
| `tests/issue-23-preflight.test.mjs` | 27 tests: all seven classes + misses/carve-outs/dispatch-edge refusals/ledger tagging | 27/27 pass |
| `tests/issue-23-disclosure.test.mjs` | 8 tests: exactly-one disclosure, cleanConcept suppression with provenance, live ⇒ zero, dedupe, single-disclosure critic fix, invented-claim still critical | 8/8 pass |
| `tests/issue-23-quality.test.mjs` | 14 tests: 11px/12px floors + exception path, contrast 4.2 blocks / 4.6 passes / 2.8 large blocks, colour-only state, one-off colour, near-duplicate tokens | 14/14 pass |
| `tests/issue-23-exo-regressions.test.mjs` | 11 tests: 5 fixture ids load + invariants; each of the 8 failure classes detected through its real mechanism; truthful-gate behaviour (cannot PASS on skip, stamp binding, severe geometry ⇒ FAIL despite a high score) | 11/11 pass |
| Full matrix `npm test` | All ~33 suites, `test:issue23` and `test:issue24` in the chain, e2e against a rebuilt server bundle | all suites green, 0 failures (two full-matrix runs; the first caught the deck-build false positive below, which was fixed and everything re-verified) |

`tsc --noEmit` clean. New suites wired as `npm run test:issue23` and appended to the `test` chain.

## Honest limits

- **Live render evidence cannot be produced offline:** the final gate reports BLOCKED for offline runs by design (the `render-evidence` and live `session-stamp` gates only exercise against a real plugin session). The verdict machinery is proven deterministically; the live path awaits a live session run.
- Preflight runs evidence-based: a check without its evidence (e.g. no text measurement) stays silent rather than being guessed — the issue's "do not claim a pass" rule, applied to the gate itself.
- The benchmark baseline (`artifacts/benchmark/*`) is intentionally NOT regenerated: the fixtures are additive, frozen lists unchanged, offline scores unaffected.
- A first full-matrix run caught one real bug in the blocking layer: path-bearing `createVector` ops (logoMark's tight mark bbox, connector route bboxes) position themselves from their own path, so the resolved-vs-emitted geometry check false-blocked a valid deck build. Fixed by marking path-derived geometry in the replay and exempting it from the plan-box comparison (containment and connector checks still judge it). The e2e deck-build test is the contract.
