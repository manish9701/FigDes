# FigDes: Observed Issues & Engineering Fix Roadmap

**Prepared:** 12 October 2026  
**Repository:** [manish9701/FigDes](https://github.com/manish9701/FigDes)  
**Basis:** live use of FigDes while designing the EXO Labs consumer product, plus a targeted inspection of the current repository.  
**Scope:** improve reliability, speed, design quality and iteration quality. This is an assessment and proposal; no repository code was changed as part of this review.

## Executive recommendation

FigDes has a credible native Figma execution foundation. It already has progress reporting, operation yielding, reconnect backoff, page/style/font caches, a native operation allowlist, render budgeting, a planner, a critic, refinement tools and automated tests. The bottleneck is not a shortage of primitives.

Prioritize, in order:

1. **P0 — Make failed transactions genuinely safe to roll back.**
2. **P0 — Preserve job/session identity and recover after reconnect or timeout.**
3. **P1 — Validate a whole plan before sending it to Figma, with the same schema on both sides.**
4. **P1 — Instrument and optimize the actual hot paths before increasing timeouts.**
5. **P1 — Fix visual critic false positives and prevent repairs from degrading token consistency.**
6. **P1 — Make the existing plan â†’ build â†’ render â†’ critique â†’ repair â†’ final QA tools work as one reliable loop.**
7. **P2 — Improve native component/token reuse and reduce the cost of visual comparison.**

Keep the current native Plugin API architecture. Extend the existing systems rather than building a parallel agent framework.

---

## 1. Live observations and code-backed issues

### P0 — Transaction rollback is incomplete for mixed edits

**What I observed:** large edits frequently mixed existing-node changes with newly created shapes and text. When a complex batch encountered a schema/runtime error, I needed to inspect whether anything changed and then retry with a smaller operation set. This is risky for iterative screen editing because a user should never have to guess whether a failed edit partially stuck.

**Code evidence:** in `figma-plugin/src/operations.ts`, the failure path passes created node IDs into `failure()` and removes those nodes. Existing-node mutations are tracked in `ctx.modified` for evidence, but not journaled with their prior properties for rollback. The `rolledBack` flag can be true when there were no created nodes, even if an earlier existing-node mutation succeeded before a later operation failed.

**Fix:** add a pre-mutation journal for supported mutations, recording prior values for each touched property (position, size, fills, strokes, typography, visibility, names, radius, parent/order, etc.). On failure, restore mutated nodes and remove created nodes in reverse dependency order. Where a mutation cannot be restored safely, return `partial-rollback` with exact affected IDs and a clear recovery action; never report a full rollback based only on removed creations. Prefer atomic snapshot/restore for the operation types the plugin can support reliably.

**Acceptance tests:**
- Fail after changing an existing node and prove its original value is restored.
- Fail after create + edit + reparent and prove both existing state and created-node cleanup are correct.
- Report `rolledBack: true` only if every mutation is confirmed restored.
- Simulate a node deleted or moved by the user during execution and surface a precise partial-rollback report.

### P0 — Session reconnect does not preserve an in-flight job identity

**What I observed:** during this live Figma session, several large/complex tool calls timed out or the plugin connection disappeared. After reconnecting, the previous session ID returned `Unknown plugin session`; I had to re-check plugin status and obtain a new session ID before continuing. It was not safe to assume that a timed-out edit had either committed or not committed.

**Code evidence:** `mcp-server/src/sessions.ts` creates a new random session ID per WebSocket connection. `SessionRegistry.resolve(sessionId)` fails when the supplied ID is no longer registered. The panel has exponential reconnect backoff and the server has a longer build timeout with progress heartbeats, but the server session keeps pending requests in memory and does not expose a durable status/resume record for a transaction after connection loss.

**Fix:** introduce a stable plugin-client identity and session lineage, scoped to the open Figma document where possible. On reconnect, explicitly rebind a session generation to the prior client/job lineage without guessing the document when multiple files are open. Add a transaction/job ledger keyed by `transactionId` with states such as `queued`, `preflight`, `applying`, `verifying`, `committed`, `rolled-back`, `partial-rollback`, `failed`, plus operation progress and final node IDs. Add `get_job_status` / `resume_job` semantics. A retry must reuse the same transaction ID and be idempotent, not blindly create the same objects again.

**Important safety rule:** when multiple files are connected, never silently retarget an old session ID to an arbitrary open file. Return the replacement session and file identity clearly, and ask for disambiguation when needed.

**Acceptance tests:**
- Disconnect/reconnect while a job is in progress; reconnect reports the correct job state.
- A retried transaction does not duplicate created nodes.
- Stale session errors include a safe recovery hint and candidate connected sessions.
- Two open Figma files remain unambiguous.

### P1 — Preflight validation should catch malformed operations before dispatch

**What I observed:** some invalid operation fields (for example nullable fields where the operation contract expects an omitted value or a string) surfaced only when the Figma-side transaction was executed. That wastes a plugin round trip and makes large batches more expensive to debug.

**Code evidence:** `mcp-server/src/tools.ts` advertises a deliberately permissive `OperationItem` and uses `.passthrough()`; the definitive `OperationSchema` validation happens inside `figma-plugin/src/operations.ts`. The strict native allowlist is good, but errors could be caught earlier and consistently before the live document is contacted.

**Fix:** import and run the same shared `OperationSchema` in the MCP server for both `create_design` and `modify_design`. Add transaction-level preflight for temporary-ID uniqueness, references, parent/child validity, operation ordering, page targets and type compatibility. Return all validation failures in one response with operation indices and minimal fix suggestions. The plugin must repeat the validation as a trust boundary, but a bad request should normally fail before touching the WebSocket/document.

**Acceptance tests:**
- Invalid nulls, missing required fields, duplicate temporary IDs and unresolved references fail in preflight.
- A 150-operation batch with a single bad operation returns the full actionable error before execution.
- Client and plugin validation produce the same result for the same payload.

### P1 — Optimize measured latency, do not merely raise the timeout

**What I observed:** complex batches containing many native nodes and property edits were noticeably more fragile than smaller targeted edits. Splitting a large transaction into verified logical passes was more reliable. There were also repeated inspection and render calls during the visual iteration loop.

**What is already good:** `figma-plugin/src/operations.ts` caches available fonts and yields during long operations; `figma-plugin/src/cache.ts` caches pages and styles; the panel reports progress; the session layer extends the request timer on progress. Preserve these protections.

**Potential hot paths to measure:**
- Repeated `figma.getNodeByIdAsync` calls for the same referenced nodes during one transaction.
- Per-node font/style resolution and repeated paint construction in large screens.
- Repeated full subtree scans after selection or after every large edit.
- Serial verification of every created node after the build.
- Large render payloads sent into the model when a smaller target or a low-detail render would answer the question.

**Fix:** add stage and per-operation timing (parse, font load, create, mutate, verify, viewport reveal, render, inspect); collect node count, operation count, cache hits, bytes rendered, and retry count. Cache resolved node handles within a transaction with explicit invalidation on remove/reparent/page changes. Batch cheap property sets where safe, and verify only affected subtrees by default while retaining a full verification mode. Add adaptive render choices: thumbnail first, high detail only for text-level questions, and region crops or before/after diff images for local changes.

Set an operation budget using measured latency and node count. Warn or automatically split at logical region boundaries when a transaction exceeds budget. Do not split one user's intended atomic edit into unsafe independent commits without making the undo/rollback boundary explicit.

**Acceptance tests:**
- Benchmark small, medium and large screens on the same fixture.
- Report p50/p95 duration and time spent by stage.
- Ensure caching does not return stale nodes after remove/reparent/page switch.
- Confirm progress remains active and the Figma canvas repaints throughout a large build.

### P1 — The visual critic needs semantic context and evidence provenance

**What I observed:** the most useful designs here used a spatial topology with an inspector, compact open surfaces, custom diagram elements and model/device-specific details. Simple rules such as counting rounded/bordered rectangles can misread these layouts as generic dashboard cards. Conversely, a design can pass mechanical checks and still look plain or unfinished.

**Existing project evidence:** [`FigDes_Combined_Quality_Reliability_Fix_Plan.md`](https://github.com/manish9701/FigDes/blob/main/FigDes_Combined_Quality_Reliability_Fix_Plan.md) already calls out coordinate-space/overflow false positives, composition-unaware card-wall detection, repair-introduced token inconsistencies, confidence/evidence provenance, and the need to keep offline structural scores separate from live visual scores.

**Fix:** treat the plan's work as the existing source of truth, not a new parallel effort. Ensure each finding carries source type (`geometry`, `screenshot`, `a11y`, `token`, or `heuristic`), confidence, target node IDs, coordinate space and render revision. Make genericity checks aware of semantic roles and composition (topology vs inspector vs true peer cards). Keep negative controls so genuinely generic card walls still fail. Use design tokens/components for repairs and re-run whole-screen consistency after a local fix.

**Acceptance tests:**
- Topology + inspector passes the card-wall positive control.
- Generic SaaS three-card dashboard still triggers the negative control.
- A true overflow fails and an absolute/local coordinate mismatch does not produce a false hard failure.
- Contrast repairs improve readability without adding unexplained fills/radii/type sizes.
- A stale screenshot can never certify a newer Figma revision.

### P1 — The design workflow is available as tools, but needs one reliable orchestration path

**What I observed:** for one home-screen refinement, the loop involved many separate `find_node`, `inspect_file`, `modify_design`, `render_design` and `review_design` calls. Some edits failed from field/schema mismatches, and after large changes it was necessary to render the whole screen again to find overlapping remnants. This is slow and increases context use.

**What is already available:** the repository has screen planning, native design construction, scoring/critique, `refine_screen`, diffing, final QA and project-memory tools. Add an orchestrator around them rather than adding more low-level primitives.

**Fix:** provide a screen-edit workflow that accepts a target frame plus goals/preserve rules; discovers the relevant subtree and local tokens; drafts a patch; runs shared-schema preflight; applies it as a tracked transaction; renders a thumbnail; reviews geometry/accessibility/token consistency; produces a visual before/after diff; and stops for review or performs one targeted repair pass. Report every stage and require fresh screenshot evidence for acceptance.

**Keep human control:** never automatically apply large semantic layout changes or silently override a selected design direction. Make the proposed patch and expected affected nodes inspectable before commit.

**Acceptance tests:**
- One edit request gets one transaction ID, one timeline and one final diff.
- The workflow doesn't repeatedly re-inspect unchanged nodes.
- Failed preflight does not contact Figma.
- Final QA cannot pass without a fresh render of the exact revision.

### P2 — Make design-system reuse the default, not a follow-up step

**What I observed:** when manually refining the screens, it was easy to create many low-level rectangles and text layers. Repeated structures such as model cards, online status, device selectors, metadata readouts and navigation can drift unless they are tied to components and tokens.

**Fix:** before creation, detect matching components, variables, paint styles and text styles. Prefer instances where fit is acceptable; if not, state why a custom composition is justified. Expose a compact semantic specification for recurring product patterns—model profile, device row/inspector, state label, benchmark row, topology edge—while composing them through the existing primitive/IR layer. Add component/token adoption and style-drift metrics to QA.

Do not force everything into generic cards: use components for repeated details, but keep topology, custom 2.5D device assets and editorial layouts composition-led.

**Acceptance tests:**
- Repeated components stay visually consistent after a shared change.
- A custom component variant is explainable by a real content/interaction difference.
- Token adoption improves without inflating card count or weakening hierarchy.

### P2 — Reduce the cost of visual feedback

**What I observed:** render â†’ inspect â†’ repair loops are essential, but repeated whole-screen, high-detail renders are expensive when only one region changed.

**Fix:** add (or improve) target-region rendering, paired before/after comparisons, overlay/heat-map diffs and a concise machine-readable delta (`new overlaps`, `moved nodes`, `changed tokens`, `text overflow`, `contrast change`). Default to a low-detail full-screen thumbnail, then high-detail rendering only for the affected area or text. Keep the current hard render-budget guard.

**Acceptance tests:**
- A small component edit can be reviewed without exporting the entire large canvas at high detail.
- Diff artifacts identify exactly which frame/revision each image represents.
- Render budget and actual bytes/tokens are visible.

---

## What not to change

- **Do not add more drawing primitives as the first response.** The native execution layer is already capable.
- **Do not just increase all timeouts.** Instrument the slow stage and fix liveness/recovery and repeated work.
- **Do not lower the visual QA thresholds just to get a pass.** Fix false positives and preserve real blockers.
- **Do not claim offline tests prove live visual quality.** CI should keep offline structural/planner tests and live screenshot evidence separate.
- **Do not replace the current planner/critic/transaction architecture.** Build the missing reliability and orchestration around it.

## Suggested delivery sequence

| Order | Deliverable | Why first |
|---|---|---|
| 1 | Mutation journal and truthful partial-rollback state | Prevents silent corrupt/half-edited screens |
| 2 | Stable job ID, transaction ledger and reconnect recovery | Prevents â€œdid it apply?â€ ambiguity and duplicate edits |
| 3 | Shared server/plugin preflight validation | Catches bad requests before they incur a Figma round trip |
| 4 | Stage timing and operation/cache profiling | Finds the actual latency bottleneck before optimizing |
| 5 | Semantic quality findings + token-aware targeted repair | Improves visual quality without damaging consistency |
| 6 | Unified screen-edit orchestrator with render diff | Reduces tool-call count and context usage |
| 7 | Component reuse and region-level render comparisons | Compounds quality and speed gains over time |

## Initial metrics to track

- p50 / p95 transaction duration by operation count and created-node count
- tool timeout rate, socket disconnect rate and reconnect-to-ready time
- count of unknown-session errors after reconnect
- rollback completeness rate and number of partial rollbacks
- preflight catches per 100 requests
- duplicate-node incidents following retry
- inspect time, render time, payload bytes and estimated token cost
- percent of final screens with a fresh final render and an evidence-backed QA result
- token/component reuse and style drift after repair
- visual critic false-positive rate on the positive/negative benchmark suite

## Source links

- [FigDes README and current architecture](https://github.com/manish9701/FigDes/blob/main/README.md)
- [Native operation execution, progress, mutation tracking and rollback](https://github.com/manish9701/FigDes/blob/main/figma-plugin/src/operations.ts)
- [Session registry, request timeouts and reconnect/session resolution](https://github.com/manish9701/FigDes/blob/main/mcp-server/src/sessions.ts)
- [Plugin-side reconnect and progress UI](https://github.com/manish9701/FigDes/blob/main/figma-plugin/ui/ui.ts)
- [Shared operation protocol](https://github.com/manish9701/FigDes/blob/main/shared/protocol.ts)
- [Existing quality/reliability plan](https://github.com/manish9701/FigDes/blob/main/FigDes_Combined_Quality_Reliability_Fix_Plan.md)
- [Design intelligence implementation specification](https://github.com/manish9701/FigDes/blob/main/FigDes_Design_Intelligence_Implementation_Spec.md)

**Assessment limit:** this was a targeted read-only repository review plus live FigDes use. I did not clone the repo, run its test suite, benchmark a local build, or submit code changes. Treat the cited code paths as inspected source and the speed/reliability behavior as observed in this session, not as a complete production performance study.

## Planner: deployment decisions classified as generic select

**Observed:** the EXO enterprise brief "Choose a model deployment that fits the discovered compute cluster." was classified as a generic select decision. The resulting plan was a bare option list: it missed the automatic placement recommendation, the model-requirements-vs-cluster-resources fit, the selection+validation states, and the launch action with its prerequisites.

**Root cause:** classifyDecision (mcp-server/src/plan/planner.ts) is an ordered regex table and choose fired select before any deployment wording could matter; there was no deploy kind and no deploy shell, so no shell carried an action region or a placement/fit inspector. Archetype priority arrays (e.g. model-fit's "fit verdict / requires vs available / recommended config / run action") were dead data — only echoed in the plan_screen response, never compiled into the plan. primaryAction/states intent existed in the pipeline brief but was not accepted by plan_screen or the planner intent, so action/state intent could not reach the plan.

**Fix (this session):**
- Added a deploy decision kind whose conservative pattern (explicit deploy/deployment/rollout wording, or launch/ship only when the object is a model/cluster/fleet/node/machine/shard/device) is checked before the generic select pattern.
- Added a deployment-fit template and a deploy shell (nav, header, candidates table with fit verdicts, placement inspector carrying the automatic placement recommendation, required-vs-available memory and the fit verdict; reasons state placement is recommended, never dragged by hand).
- Archetype priority is now plan material: an archetype stated by name or inferred from the decision (deploy + model wording -> model-fit, deterministically, via the new resolveArchetype) compiles its priority items into the plan's requiredInformation, surfaced in the plan_screen response; the pipeline threads the brief's archetype and states the same way.
- plan_screen now accepts primaryAction, secondaryActions, states and primaryObject intent. A named primary action with no action-bearing region earns an action region; declared states merge into the art direction's interaction states. Callers that pass neither see unchanged plans.
- Deploy plans express the deployment runtime states (model downloading/preparing/fitting/loading, device unavailable, cluster degraded, validating, ready to launch).
- Added a plan-time completeness signal (plan-completeness:deploy) that warns, without blocking, when a deployment plan lacks the placement recommendation or a primary action.
- New offline regression brief exo-deployment-fit lives in EXO_DEPLOYMENT_BRIEFS (offline-briefs.ts) with its matching case in EXO_DEPLOYMENT_CASES (suite.ts), versioned apart because the frozen OFFLINE_BRIEFS/BENCHMARKS lists are length-pinned by test; tests assert the two stay in sync (tests/planner-deployment.test.mjs).

**Root cause (second leg, found in the live pipeline dry run):** the canvas-fit pass itself refused to shrink `fill` regions (`region.height === "fill"` returned not-shrinkable), so when a fixed header grew to fit its content the fill regions below slid down and nothing could pull them back — the placement inspector spilled to (290, 736) 184 tall on a 900px canvas with `reflowed: 3` claiming a repair that never covered the fills. A fill region may now give back space down to what its content stands in (the same floor `fitFillRegions` already applies), and a height-only repair patches the emitted op and the region's resolved box together, so the trace check can no longer catch them disagreeing.

**Verified:** the nine frozen benchmark briefs classify exactly as before, npm run benchmark:design stays 9/9 PASS, and the issue22 gate verdict is unchanged for every existing case (the new brief was never added to the frozen baseline inputs). The exact EXO brief through the plan-mode pipeline comes back applicable with every structural check passing and the placement region ending exactly at the canvas edge.

## Layout compiler: fixed stacks overflowed the canvas, relation content landed outside its region, and text widths contradicted their bounds

**Observed:** a 1440x900 enterprise dry run put the inspector at (248, 940) past the canvas bottom, placed nav content outside its navigation region, emitted text widths that contradicted the declared maxWidth values, clipped tracked uppercase labels ("OPERATIONS", "3 machines online", "Automatic distribution"), and reported constrained: 0 / reflowed: 0 although the compiler had detected every one of those problems.

**Root causes (runtime/compiler, not the screen program):**
- layout.ts solveAxis returns fixed sizes unclamped when no sibling is fill, and the stack/side-rail accumulators walked off the bottom edge with no canvas clamp. Detection existed (blocking geometry violation) but nothing reflowed - the compiler refused and shipped nothing, which is safe but not a fix.
- compile.ts patched relation-constrained content with canvas-absolute coordinates written into a parent-local op slot (patchEmit without origin), displacing the node by its region origin - the "nav-models outside its navigation region" class.
- emitText emitted spec.maxWidth verbatim while resolvedSize recorded min(box.w, maxWidth) - two formulas, contradictory geometry (the maxWidth contradiction and operation-trace drift).
- Every width estimate (estimateHeight, hugWidth, checkTextFit) ignored letterSpacing and uppercase, while style presets emit tracked uppercase nav labels - tracked caps rendered wider than every estimate, which is how the labels clipped.
- The runtime apply path built the preflight context with only planBoxes/overflow/sizing, so checkTextOverflow silently no-oped without textMeasurements and checkConnectors without connectors - both pieces of evidence were already in hand.
- An unknown parent id silently adopted the node into regions[0] with a warning; downstream containment checks then "proved" geometry about the wrong home.
- constrained/reflowed counted only manually declared relations, so an auto-repaired layout still reported zero.

**Fix (this session, mcp-server/src/runtime + shared/ir.ts):**
- fitStackToCanvas: a water-filled proportional shrink with per-region floors (MIN_STACK_REGION_H = 64) pulls an overflowing fixed stack back inside the canvas in layoutStack and layoutSideRail, and a final canvas-fit pass in compile.ts re-clamps after fitRegionsToContent growth. The repair is reported through reflowed (e.g. 3) instead of a silent refusal; if even the floors cannot fit, the overflow is returned honestly and still blocks.
- Relation-patched content now passes the parent origin into patchEmit, so constrained content emits parent-local and stays inside its region.
- One width formula (textEmittedWidth) is shared by emitText and resolvedSize; a path that skips resolution blocks with a text-bounds violation instead of shipping contradictory geometry.
- estimateTextRunWidth is tracking- and uppercase-aware and is used by estimateHeight, hugWidth and checkTextFit, so the compiler and the render agree; a tracked label that cannot fit its rail now blocks with containment instead of clipping.
- runtimePreflightContext threads textMeasurements, connectorRoutes, overflowReasons and geometryReasons into the preflight, so text-overflow and connector checks actually run on the design_runtime apply path.
- An unknown parent id is now a blocking parent violation (still warned, still reparented for testability, but applicable: false).
- Unknown-parent silent adoption, canvas overflow, width contradiction and tracked-label clipping are pinned by tests (tests/runtime.test.mjs, tests/issue-23-preflight.test.mjs, tests/issue-23-exo-regressions.test.mjs).

**Verified:** the reported reproduction (nav 216 / header 420 / frame 456 / inspector 340 on 1440x900) now resolves with every region inside the canvas, zero violations, applicable: true and reflowed: 3; npm test suites around runtime, layout, geometry, preflight and the exo regression detectors all pass, and the frozen issue22 gate stays PASS.

## Addendum (legs 4-7): the pipeline could not reach the EXO placement primitives, and three primitive renderers shipped absolute coordinates, wrong width sources or dropped values

The live E2E loop (three build-render-review rounds against the deployed fix) surfaced the next layers, each caught by visual review of the rendered frame rather than by the structural checks - which is the point of keeping structural validity and visual quality separate:

- The pipeline's label-to-primitive mapping had no route to fitGauge/memoryBudget, so a deployment screen drew its fit verdict and its resource fit as labelled cards - the generic metric-card shape the product truth forbids. Model-fit/deployment archetypes now route those two phrases to the real instruments (leg 4), with args synthesized from the brief's own demo values and no fabrication when a value is absent.
- memoryBudget emitted its track and fill rectangles with canvas-absolute x/y into a parent-local slot, so the bar overflowed its own card (leg 5); the track is now its own frame and both children are parent-local.
- The fit gauge block hug-sized itself to the detail line's width and slid under the neighbouring panel (legs 5-7); it now sizes to its packed column and the detail wraps, with resolvedSize sharing the emitter's wrap formula so the trace cannot catch them disagreeing.
- Word labels in the budget readout ("Required / Available GB used") and a hardcoded dash in every timelineEvent date (legs 5-7) - the readout states figures again, and the event's when comes from the brief.

All regression-pinned (tests/runtime.test.mjs, tests/planner-deployment.test.mjs). The frozen issue22 gate stayed PASS through every leg.

## Issue #29: provenance was self-reported, so a weaker client could skip the plan and still build

**Observed:** the design-intelligence rules survived only where the calling model chose to follow them. The gates accepted ``fromPlan:true`` / ``intelligenceApplied:true`` — flags the calling model sets about itself — and a ``planId``/``planRef`` string was accepted without ever being checked against anything. A client that skipped plan_screen (the observed weak-client failure mode) set the flag, opened every gate, and produced a generic, mediocre screen that the metrics recorded as intelligent.

**Root cause:** the rules were enforced by prose (tool descriptions, server instructions) while the few server-side gates trusted self-report. A plan was never registered anywhere, so "a plan ran" was unfalsifiable.

**Fix:**
- New plan registry (mcp-server/src/plan/registry.ts): the server remembers every plan it issues; the registry is process-global so all built bundles share it. plan_screen registers and stamps the planId on its payload and into the program skeleton, so provenance travels with the build even when the model only copies the program across.
- hasPlanProvenance now VERIFIES: a planId must resolve against the registry (and match the file); an inline plan must be plan-shaped (carry the program and intelligence receipts a real payload has); the self-asserted flags are accepted in the schema but ignored, so an old client gets the refusal rather than a schema error.
- design_runtime refuses a planless build of a full screen (3+ regions) with a needs-approval question instead of quietly building it on the auto art-direction fallback. One-region components keep the fallback; dry runs stay open; an approved+reason waiver still dispatches the one call.
- Both bypass paths are counted (planlessScreenRefusals, intelligenceBypassWaivers) and the counters are process-global, so a client's skip-the-plan rate is visible in figma_status instead of silent.

**Verified:** new regression suite (tests/issue-29-plan-registry.test.mjs, 13 tests) covers every refusal and every pass path; the issue-24/26 gate suites updated to the verified contract and green; the smoke suite's chunked-build case now plans first and passes 67/67. Two pre-existing failures (issue-16 G01/G02/G04, issue-17 release gauntlet A01/B04) reproduce unchanged on the unmodified baseline and are unrelated.