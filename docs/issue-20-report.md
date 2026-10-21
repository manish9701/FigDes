# Issue #20 — design generation, validation, and repair, made reliable end to end

Code under test: **this commit** (same-commit builds only).
Issue: [manish9701/FigDes#20](https://github.com/manish9701/FigDes/issues/20) — 10 workstreams.
Complements #17 (release gate), #18 (pipeline reliability), #19 (leaf-selection guard).

## Method

The issue explicitly scopes the work as *audit, reproduce, then fix*: "it does not assert that
every listed behavior is currently broken." So this pass started from a source audit of both
execution halves (server rules/review/pipeline, plugin operations), produced a defect list per
workstream, then fixed every defect that reproduces offline, and pinned each fix with a
regression test in `tests/issue-20-regressions.test.mjs` (24 tests). Everything not closable
this pass is stated in "Not closed by this pass" at the end.

Baseline before the pass: full suite green. After the pass: full suite green plus the 24 new
regressions — the release gate's regression group reports **947/947** on this commit. The gate
verdict is below.

## What changed, per workstream

### 1. Brief/plan schema consistency

| Change | Where |
| --- | --- |
| **`design_brief` → `design_pipeline` is bridged by construction, not by copy-paste.** A new adapter converts the brief tool's args into the pipeline's `BriefInputSchema` (with `.parse` at the seam, so the converted shape cannot fail at the next boundary), and `buildBrief` now returns `pipelineBrief: { brief, renamed, unmapped }` in its result. | `mcp-server/src/pipeline/adapters.ts`, `mcp-server/src/plan/brief.ts` |
| **No silent field loss.** Every field that cannot cross the seam is inventoried: `goal → purpose` and `canvas{w,h} → viewport{w,h}` are reported as *renames*; `user`, `canvas.grid` as *unmapped*, each with a reason. Nothing is dropped without a written reason. | `pipeline/adapters.ts` |
| **Boundary errors name the stage and the field.** Tool-call validation errors are prefixed at the one dispatcher every call passes through: `design_pipeline: invalid arguments — brief.primaryDecision: missing…` instead of a bare Zod message with no stage. | `mcp-server/src/mcp.ts` (all `.parse` failures) |
| **Schema agreement is pinned.** A test asserts the two tools accept the same `audience` cohort; older (decision-only) briefs still normalize with blockers that carry id/message/fix. | `tests/issue-20-regressions.test.mjs` |

The third schema (`design/contracts.ts` `DesignBriefSchema`) remains an unused canonical
declaration — rather than delete it mid-stream, its status is recorded in the "not closed"
list below.

### 2. Layout compilation and native geometry

| Change | Where |
| --- | --- |
| **`patchPosition` covers `createVector`.** When a constraint reflow moved a region that produced *shape/vector* content (`shape` marks are emitted with `id: spec.id`), the narrower position-patch skipped the op and the vector kept stale coordinates. `patchEmit` had the fix; `patchPosition` never received it. | `mcp-server/src/runtime/compile.ts` |
| Post-mutation geometry read-back already exists and is unchanged: the pipeline measures the built frame (`collect_metrics`), compares file size against the planned canvas (`geometry-agreement`), checks plan-region presence in the file (`live-structure`), and reconciles resolved boxes with emitted ops (`operation-trace`, real tolerance ±1px). This pass extends the honesty of that stage (see workstream 4/5) rather than reinventing it. | `pipeline/tools.ts` `verifyLiveScreen`, `runtime/compile.ts` |

Deterministic geometry fixtures for nav/sidebar/cards/tables/forms/dialogs remain from issues
#12/#13 (X-case matrices) and the offline gauntlet; the known gap — no *shared* replayable
fixture module for those scene classes — is stated below.

### 3. Semantic collisions

| Change | Where |
| --- | --- |
| **Collision findings now carry a machine-readable taxonomy.** Every collision-class finding (`overflow`, `sibling-region-overlap`, `text-route-collision`) carries `evidence.collision = { type, involvedIds, intent, classification }` — containment vs sibling vs label-over-route, the two involved node IDs, and whether the overlap is accidental — so a consumer no longer parses rule names or prose. `nodeIds` was widened to name *both* involved nodes. | `mcp-server/src/review/rules.ts`, `shared/protocol.ts` |
| The existing semantic split is preserved and still regression-tested: text-vs-text only for siblings, input fields are not connectors, backdrops decided by paint order, dividers are rules not controls. | `review/rules.ts` (issues #14/#12) |
| The evidence type was widened for one nested value; `design/quality/finding.ts` serialises it. | `shared/protocol.ts`, `design/quality/finding.ts` |

### 4. Exact scope and truthful verdicts

| Change | Where |
| --- | --- |
| **`refine_screen` reviewed the wrong scope even when a node was given.** It passed `{ nodeId }` to `collect_metrics`, which the plugin reads as *no target* — the loop then measured the selection or the page. The same defect was fixed twice already (`final_qa`, line 1158) and the refine loop was missed. Now `{ target }`, with the reason next to it. | `mcp-server/src/review/workflow.ts` |
| **A 1-node review can no longer be a PASS.** `reviewVerdict` gained the same floor the guard has (`MIN_REVIEW_NODES = 3`): the live retest showed a leaf review with zero findings reading as a clean bill. | `review/verdict.ts` |
| **`scopeIsScreen` was `nodeCount > 0`** — any nonempty scan declared itself a screen. Now: ≥3 nodes AND not the page fallback AND not a bare selection label; the resolved **target id/name** travels in the report (`target`, `targetName`), and `scopeIsNamedTarget` says whether the scan named an explicit target at all. | `mcp-server/src/tools.ts`, `shared/protocol.ts` |
| **`rulesSkipped` was hardwired `0`.** Now it counts the node material the rules never saw — hidden layers and nodes beyond the scan budget — with `skipReason` naming why, and `rulesEvaluatedNames` lists every rule that ran. A crashing rule throws (never a silent skip); the report says the difference. | `mcp-server/src/tools.ts`, `shared/protocol.ts` |
| **A crashed rule engine in the pipeline no longer disappears.** When `runRules` throws in `verifyLiveScreen`, the review-rules check is recorded `indeterminate` (previously the check *did not exist*, and a built screen could aggregate to pass via the checks that did run). | `pipeline/tools.ts`, `pipeline/verify.ts` |
| **A truncated live census fails closed.** `snapshotFromMetrics` now marks a truncated scan `resolved: false`, so the guard refuses with INDETERMINATE instead of evaluating absence rules (`forbiddenText`, `maxNodes`, …) over un-scanned nodes. The `inspect_selection` path already behaved this way; the metrics path now agrees. | `mcp-server/src/memory/tools.ts` |
| **Truncated pipeline metrics are a state of their own**: `verifyLive` adds a `live-scan-complete` check (indeterminate) plus a finding when `metrics.truncated`, so an incomplete census cannot aggregate to a pass. | `pipeline/verify.ts` |
| **Guard verdict flattening removed.** The pipeline guard check folded guard `INDETERMINATE` into `review`; the mapping now keeps `INDETERMINATE → indeterminate`. | `pipeline/tools.ts` |
| The guard's own INDETERMINATE discipline (blank/ambiguous/leaf targets, empty evidence, unevaluated manual rules) is unchanged from #19 and still pinned. | `tests/product-guard-regressions.test.mjs` |

### 5. Closed-loop render → review → targeted repair

| Change | Where |
| --- | --- |
| **`maxRounds` is real.** The schema advertised "how many rounds of build → verify → repair → rebuild. Default 1" and the parameter was dead — only one pass ever ran and unresolved findings ended in `incomplete` with no retry. The loop now exists, bounded from every side: total repair budget across rounds, a round cap, and stop conditions that don't rely on either (verified pass ⇒ stop; nothing applied ⇒ stop). | `pipeline/tools.ts`, `pipeline/tools.ts` schema |
| **Anti-repeat guard.** After two attempts that leave a finding in place, the loop refuses to apply the same mutation a third time and records *why* ("the diagnosis needs to be revised") instead of burning budget. Attempt bookkeeping is keyed on the finding and fed from the repair verdict's `unresolved` list. | `pipeline/tools.ts` |
| **A re-planned retry cannot double-apply.** Repairs go through `deduplicateOperations` (previously dead code), and a later round repairing the same finding mints a *distinct* transaction id (`_fix_<id>_<attempt>`), because the ledger short-circuits a known id with its cached success — reusing it would report the retry as applied without touching the file. | `pipeline/repair.ts`, `pipeline/tools.ts` |
| **A repair re-check crash no longer escapes the pipeline.** If the post-repair `verifyLiveScreen` throws (plugin disconnected mid-verify), the loop records an `indeterminate` repair-recheck check, reports the applied repairs as *applied but unverified* via `verifyRepairs(recheck: "failed")` — INDETERMINATE, never a pass — names the last-known-good/ledger path, and stops instead of mutating an unverified screen again. | `pipeline/tools.ts` |
| **`verified` status is reachable.** `visualStatus` could never be `pass`, so `buildReport`'s `verified` branch was unreachable even for a clean run. Now: fresh render + no notable visual finding ⇒ `pass` (the report text still says the low-detail render awaits a human look — the honesty lives in wording, not in a permanent `review`). | `pipeline/tools.ts` |
| Bounded budget, fresh re-checks, before/after pairing, and honest per-repair failure reporting are unchanged from #16/#18 and still pinned. | `tests/issue-16-pipeline.test.mjs`, `tests/figdes-reliability.test.mjs` |

### 6. Component and design-system reuse

| Change | Where |
| --- | --- |
| **Declared tokens absorb matching raw hexes.** A program declares `exo/ink = #242521` with one hand and paints `fill: "#242521"` with the other — the runtime shipped the literals while the palette sat in Figma unused. `bindPaletteToTokens` now binds every unambiguous single-mode colour literal to the variable the same program declares, without changing any visible colour. A hex two variables share stays a literal rather than guessing a token. | `mcp-server/src/runtime/compile.ts` |
| Binding order is preserved (after node creation, after the variable definition) and the whole op stream still passes the native allowlist — both pinned by tests. | `tests/issue-20-regressions.test.mjs` |
| What already existed and is unchanged: `bindTokenRefs` for token *names*, `migrate_to_tokens` for live files, `textStyleId` binding from #18, `find_component`/`create_instance`/`set_variant` reuse tools, one-off-style and font-family-count rules. | — |

### 7. Accessibility and interaction quality

| Change | Where |
| --- | --- |
| **Accessibility is in the gate that actually runs.** The blueprint evaluator (`accessibility.ts`: text + non-text contrast, target size, unlabelled controls, colour-only state, line length…) was implemented and tested but *invoked by nothing*; the wired final gate had no accessibility dimension, so WCAG failures never blocked. `final_qa` now measures the live tree through a new adapter (`accessibilityInputFromMetrics` — only honestly measurable inputs enter; variable-bound fills go to `notChecked` rather than guessed colour) and feeds the final gate. | `mcp-server/src/review/workflow.ts`, `design/quality/accessibility.ts` |
| **An a11y finding blocks; an unevaluated a11y check also refuses a clean pass.** `evaluateFinalGate` receives `accessibility: { findings, notChecked }`: findings ⇒ FAIL blocker; `notChecked ⇒ REVIEW with the list named. Evaluating nothing is not passing everything. | `design/quality/final-gate.ts` |
| The check not verifiable from a static Figma design is surfaced as exactly that: keyboard/focus behaviour and screen-reader semantics are appended to `notChecked` and named in the gate reason and the checklist item. | `review/workflow.ts` |
| `${n.background}` printed literally: the unrepairable-contrast guidance string pasted a template placeholder inside a double-quoted string, so users got literal `${n.background}`. | `review/rules.ts` |

### 8. EXO product-truth guard

| Change | Where |
| --- | --- |
| **A capability-truth registry now exists**, separate from the design-truth rules: per-capability `confirmed | proposed | estimate` with a note, and UI-language patterns for fleet controls, roles, SSO, policies, audit logs, metering, multi-cluster, offline operation. | `mcp-server/src/memory/capability-truth.ts` (new) |
| **Unpinned target ⇒ stricter, not looser.** `EXO_CAPABILITY_SOURCE` starts *unpinned* by design; while unpinned, a proposed capability shown without a visible "proposed/planned/estimate/concept…" marker is a FAIL, and even a marked claim is INDETERMINATE (the marker can't be verified against a build nobody pinned). `pinCapabilitySource(build)` pins after verification and refuses an empty id. | `capability-truth.ts` |
| **The guard wiring is real**: `design_guard` runs the capability check beside the design rules and folds its verdict (a capability FAIL fails the guard; it never silently upgrades anything); `final_qa`'s product item counts capability unbacked claims; the pipeline's final guard stage runs it too. | `memory/tools.ts`, `review/workflow.ts`, `pipeline/tools.ts` |
| **Model-fit claims need their facts.** A "fits"/"compatible"/"recommended" verdict without required/available memory and machines beside it, or without an estimate marker, is flagged (`product.fit-claim-without-context`), severity fail when facts are absent entirely. | `capability-truth.ts` |
| **`trust_remote_code` and async readiness have semantics now.** A custom-model option without visible opt-in/caution is flagged; an "engine is ready" stance that names no check (payload state / poll / health) is flagged with the same rule the transaction ledger already applies to Figma mutations: transport success ≠ work complete — HTTP 200 with a payload reporting a timeout is a not-ready instance. | `capability-truth.ts` |
| A run over zero text material is INDETERMINATE, never PASS. | `capability-truth.ts` |

### 9. Plugin/server compatibility and transactions

| Change | Where |
| --- | --- |
| **Build compatibility is enforced on the workflow path, not just reported.** `buildCompatibility` lived only inside `figma_status`. Twenty `BUILD_DEPENDENT_TOOLS` (review, guard, pipeline, runtime, native, mutate) annotate their results with a `buildCompatibility` warning when the session is `different-commit`/`unverifiable`, so the mismatch stands next to the verdict it colours. | `mcp-server/src/tools.ts`, `mcp-server/src/mcp.ts` |
| **`recordTimeout` was dead** — three timeout paths never counted, so `toolTimeouts` was permanently 0 while timeouts happened. All three paths now record. | `mcp-server/src/sessions.ts` |
| **Ledger eviction is honest.** The bounded window's eviction contained a commented-out no-op; now evicted ids are remembered (bounded) and `get_job_status` distinguishes "never dispatched" from "ran, committed/rolled back, and its record was evicted — the same-id idempotency guarantee no longer holds." | `mcp-server/src/sessions.ts`, `mcp-server/src/tools.ts` |
| **A per-session in-flight ceiling** (24) turns runaway parallel firing into an explicit, described rate-limit error naming what to do, instead of an unbounded queue against one Figma thread. | `mcp-server/src/sessions.ts` |
| Unchanged and still pinned: the transaction ledger's states, timeout reconciliation, duplicate-safe same-id retry, journaled rollback with `rolledBackNote`, the disconnect lineage from #19, and error messages that name the exact recovery call. | `tests/issue-14-*.test.mjs`, `tests/figdes-reliability.test.mjs`, `tests/plugin-e2e.test.mjs` |

### 10. The deterministic release gate

`npm run gate` on this commit:

```
PASS  gauntlet          26/26 case(s) passed, run twice with identical verdicts
PASS  stress-matrix     every case
PASS  acceptance        every acceptance case
PASS  regression        947/947 test(s)
PASS  design-benchmark  9/9 case(s)
PASS  live              10/10 live case(s) with real renders and reviews
VERDICT: PASS
```

The live group still reports its ten cases were measured against an older commit and cannot
name their build: that is the honest state until the deployed server and plugin bundle are
refreshed (item 5 in "not closed" below). This pass makes that same limit visible on every
single workflow call via the `buildCompatibility` annotation, so a live measurement taken over
a mismatched pair carries the warning next to its verdict.

## Regression tests added

`tests/issue-20-regressions.test.mjs` — 24 tests, each named after the behaviour it pins:
brief bridge round-trip, older-brief normalization, audience-cohort agreement, the 1-node
verdict floor, truncated-census fail-closed, op-deduplication idempotency, INDETERMINATE
repair re-check, declared-token absorption (and the ambiguous-hex refusal), a11y blocks /
outstanding-a11y refuses / verified pass reachable, the live a11y adapter, all six capability
truths, empty-material INDETERMINATE, pin refusal + pin effect, ledger eviction honesty,
build-compatibility warning, and the collision taxonomy.

## Not closed by this pass

Stated rather than hidden:

1. **`DesignBriefSchema` (design/contracts.ts) is still an orphaned declaration.** Nothing constructs it; the working pipeline runs on `BriefInputSchema`. Deleting it or promoting it is a migration decision this pass deliberately does not make for the two live pipelines.
2. **Component reuse on the `design_runtime` path is still advisory.** `resolveComponents`/`component-intelligence` are wired into the plan and screen-compiler paths only; the IR has no `instanceOf` content kind, so a semantic program cannot yet *become* component instances server-side. The hex→variable binding (this pass) closes the token half; the component-instance half needs the IR extension.
3. **The EXO capability registry is not pinned.** `EXO_CAPABILITY_SOURCE.pinned` is false and must stay false until an EXO target build/commit is actually verified against product behaviour — the guard is deliberately stricter in that state. Pinning is a one-call act (`pinCapabilitySource`), but the *verification* it requires is product work, not code work.
4. **No shared replayable fixture module** for nav/sidebar/cards/tables/forms/dialogs scene classes; the fixtures live in the issue #12/#13 matrices and the gauntlet.
5. **Live verification on this build, as of 21 Oct 2026 — now complete.** The deployment and the plugin were refreshed to this commit; a live `figma_status` probe confirmed `builds.compatibility: "same-commit"` (server and plugin both `ccc8fd2a0279`), and the live stress case (`hard-stress-test`) ran end to end against that pair: built on frame `507:374` with 47 operations, rendered with real PNG bytes, reviewed by the real rules, and all six of issue #10's seeded defects resolved with their measurements — **the first live evidence case that names the build that produced it** (`case-hard-stress-test.json`: commit, serverBuild, pluginBuild). An earlier attempt against the first same-commit pair hit a genuine plugin-apply timeout (47 ops, budget spent at 19 applied; cooperative-cancel + journaled rollback held, blind retry correctly refused, `toolTimeouts` visibly counting) — that incident is retained as measured data for issue #15's liveness instrumentation; the completed run is in the gate's live group. The remaining 9 live cases are historical artifacts from earlier builds and are reported as such.
6. **The ledger survives connection loss, not process loss** (documented in `sessions.ts`): a server restart loses in-memory ledger history; the new eviction honesty at least distinguishes "evicted" from "never ran" where the process survived long enough to evict.

## Verdict

The six-bucket report pipeline can now legitimately reach `verified`; every check that
cannot run names itself; a 1-node scan, a truncated census, a crashed rule engine, and an
unverified repair are all INDETERMINATE/FAIL-by-construction; the brief survives the full
pipeline without undocumented field loss; declared tokens stop the one-off fills issue names;
accessibility and capability truth participate in the same gate the product guard uses; and
the repair loop is bounded from both ends with an anti-repeat guard that says "revised
diagnosis required" instead of retrying a mutation that doesn't work.
