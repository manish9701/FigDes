# Issue #24 — 24-item quality checklist: status and what changed

**Date:** 22 October 2026
**Scope:** audit every item on the P0/P1/P2 quality checklist against the codebase, then close the concrete gaps that were actually missing. Items already implemented were verified, not rebuilt.

The checklist was audited against the code before any change. Roughly two thirds of the items were already implemented by earlier issues (the pipeline, the benchmark suite, the transaction ledger, the final gate, and the release-gate cases cover most of the list); this pass closed the gaps the audit surfaced. Every claim below names the code that backs it.

---

## What changed in this pass

| # | Item | Gap found by the audit | Fix |
|---|---|---|---|
| 3 | Visual-intent compiler | The `composition` intent field was declared **unsupported** in the consumer ledger | Closed vocabulary of composition descriptors (`asymmetric \| split \| centered \| radial \| dense-editorial \| topology-over-inspector`) compiled into concrete density/geometry/negative-space/focal commitments; ledger entry flipped to `consumed` truthfully; applied at plan level in both the `plan_screen` path (`applyCompositionHint`) and the pipeline path (spacing scaled before geometry resolves). `design/skills/composition.ts`, `design/skills/contracts.ts`, `design/skills/intent-compiler.ts`, `design/skills/direction.ts`, `design/composition/planner.ts`, `pipeline/plan.ts`, `plan/tools.ts` |
| 4 | Screenshot-based QA | No server-side image-level defect detection | Zero-dependency PNG inspector (`design/quality/screenshot-qa.ts`): IDAT inflate + full unfilter (filters 0–4 incl. Paeth), near-blank / near-uniform / flat-band detection, dominant colour, luminance variance; findings map into the canonical `DesignFinding` at heuristic confidence (0.5, below the confirmed-defect bar) so the caller decides |
| 9 | Component intelligence | The resolver only instanced whole components; never reasoned about component-set variants | `matchVariant` in `design/compiler/component-resolver.ts`: exact-match fraction scoring with named reasons, a wrong-value key disqualifies, stated `VARIANT_MATCH_BAR = 0.6`, honest fallback with the best candidate and the bar named |
| 14 | Product rules during generation | Rules recorded via `project_memory` were checked only at final review; `plan_screen`'s runtime guard and `design_runtime` used built-ins only | `effectiveRules(memory)` (built-in + stored, built-in wins id collisions; uncompilable stored rules degrade to guidance, never a guessed FAIL) now wired into the runtime guard at build time (`RuntimeOptions.rules`) at every call site that has project memory loaded: the pipeline, `design_runtime`, and `design_guard`'s pre-build program path |
| 15 | Semantic node targeting | Role vocabulary was 7 roles | Extended to 27 scored roles with confident-or-silent predicates and evidence-carrying reasons in `figma-plugin/src/find.ts`; the `find_node` tool copy advertises the full vocabulary |
| 20 | Transaction reliability | Mixed-edit rollback had no acceptance contract (the journal itself was already implemented) | Acceptance tests added: fail-after-mutate restores prior values, fail-after-create+edit+reparent restores both, user-deleted-node mid-transaction reports `partial` with exact ids + recovery action, boolean-operation sources pre-marked non-rollbackable |
| 21 | Concurrency | Two sessions pointed at the same document could write concurrently | Document-keyed advisory write lock (`native/lock.ts`: `withDocumentLock`, `DocumentLockBusyError` naming holder session + document + hold time) wrapped at both dispatch choke points; `dryRun` bypasses; readonly scripts bypass byte-for-byte as before; lock releases in `finally` so timeout/disconnect cannot strand it |
| 23 | Diagnostics | Some findings carried only prose advice; screenshot-grounded findings could not prove freshness | `normalizeFinding` in `design/quality/finding.ts`: additive fields `suggestedOperations`, structured `nextStep {tool, needs, detail}`, `renderRevision`, `stale`, `targetsHint`; live critique findings bind `contentRevision` and carry explicit `stale:false` |

## Items verified already implemented (evidence)

| # | Item | Where it lives |
|---|---|---|
| 1 | Design intelligence from briefs | `pipeline/brief.ts` (stated/inferred/contradictory normalization, blockers), `plan/planner.ts` (`classifyDecision`, `planScreen`), `design/decision-record.ts`; `tests/design-intelligence.test.mjs` |
| 2 | Visual composition | `design/composition/planner.ts` (focal, hierarchy, density, negative space), `runtime/layout.ts` (fill/hug/grow solver), `review/critique.ts` (measured focal clarity, balance, whitespace, card-wall) |
| 5 | Automated repair loop | 8-stage `design_pipeline` with repair stage 7; `refine_screen` review→fix→re-review bounded loop; `design/quality/final-gate.ts` render budgets |
| 6 | Design-system awareness | `design/discovery/index.ts`, `design/system/token-intelligence.ts` (discovered variables preferred over seed), `inspect_design_system` / `figdes_read_context` |
| 7 | Anti-generic evaluation | `design/quality/genericity.ts` (blocking threshold, semantics-aware), `design/skills/anti-generic.ts`, `design/grammar/anti-patterns.ts`; the `generic-saas-dashboard` negative control still fails in the benchmark |
| 8 | Adaptive layouts | `runtime/layout.ts` + `runtime/constraints.ts` relational solver with cycle detection; the native builder avoids hand-written x/y |
| 10 | Typography system | `design/system/typography.ts` (product type discovery, no silent fallback), `design/quality/type-criteria.ts`, measured text widths (`runtime/measure.ts`) |
| 11 | Accessibility | `shared/contrast.ts` WCAG arithmetic, `review/contrast.ts`, `design/quality/accessibility.ts` (4.5/3.0 contrast, target sizes, state encoding), real-background compositing in the plugin |
| 12 | Context preservation | Pipeline trace carries brief → plan → ops → checks → repairs → render; `design/context/design-context.ts`; project memory persistence; brief re-verified against output in `pipeline/verify.ts` |
| 13 | Composition alternatives | `design/skills/alternatives.ts` (≥3 hypotheses across six structural axes, evidence-based scoring, audited-distinct selection) |
| 16 | Targeted modifications | `pipeline/repair.ts` (refuses ops without node ids; budget exhaustion ≠ convergence), `design/quality/repair-planner.ts` ("never regenerate entire screen"), `review/edit-screen.ts` (one edit = one transaction + dry-run) |
| 17 | Design-quality benchmark | `design/benchmark/suite.ts` — 9 fixed cases incl. negative control, 100-pt weights across 10 dimensions |
| 18 | Regression testing | `design/benchmark/regression.ts`, frozen baseline `artifacts/benchmark/issue22-baseline-v1.json`, golden-policy dual gate (`scripts/lib/image-diff.mjs`) |
| 19 | Reference comparison | `compare_visuals` (two renders + structural delta, never claims "better"), `design/quality/comparison.ts` (deltas resolved vs introduced) |
| 22 | Performance | `design_pipeline` = whole loop in one call; low-detail renders with token bills; per-session measurement cache; render caching; `collect_metrics` + perf benchmark (`scripts/run-perf-benchmark.mjs`) |
| 24 | End-to-end validation | `design/quality/final-gate.ts` + release gate + acceptance runner + `tests/plugin-e2e.test.mjs` mock-Figma harness; live gates require fresh render evidence of the exact revision |

## Residual honest gaps (not fixable offline)

- **Item 4:** the visual verdict itself is delegated to the calling model's judgement of the rendered image; the server adds structural + heuristic evidence (and now pixel sanity checks), not a vision model.
- **Item 8:** no multi-viewport breakpoint simulation; constraints and relational layout exist, responsive *simulation* does not.
- **Item 19:** compares two of the system's own states; no import path for arbitrary external reference images.
- **Item 21:** the document lock is tested at lock level and wired at both dispatch choke points; two live plugin sessions are needed for an end-to-end proof.
- **Item 22:** live-Figma round-trip latency is measured by the perf benchmark against the mock plugin path; live measurement remains script-driven.

## Tests added

- `tests/issue-24-rollback-journal.test.mjs` — item 20 acceptance contract (4 cases)
- `tests/issue-24-find-roles.test.mjs` — item 15 vocabulary + silent-on-absence contract
- `tests/issue-24-server-reliability.test.mjs` — items 14/21/23 (16 tests)
- `tests/issue-24-design-intel.test.mjs` — items 3/9/4 (20 tests, incl. a hand-rolled PNG encoder inverting the decoder)
- Wired into the matrix as `npm run test:issue24`.
