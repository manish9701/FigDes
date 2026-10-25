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
## Issue #26 (GitHub): enforce composition-first design quality gates and evidence-based visual QA

**Audit first** (the issue's own approach): most of its requirements already had enforced gates - plan_screen's decision-classified composition model with focal/hierarchy/density/action/states, three structural variants, the pipeline's bounded verify/repair loop, the revision-bound freshness spine (evaluateFreshness), never-PASS-without-render (verdictFor), the product guard + capability truth on every build, the genericity intake gate, the refusal-golden negative control, and the release gauntlet. Four gaps made those gates beatable; this closes them.

**Gap 1 - generic-plan detection was opt-in.** auditPlanShape (plan/tools.ts) now runs on EVERY plan_screen call: even card grids (3+ equal content tiles), no focal entry point, and uniform sectioning are named with the repair that earns the pattern, and land in guardPreview so the build-time guard enforces them too.

**Gap 2 - final_qa's render was a liveness probe.** The final gate's required render-evidence record was derived notEvaluated, so the verdict could never stand on inspected evidence. final_qa now collects the live tree once, fingerprints it into a content revision (the same binding the pipeline uses), renders, sanity-checks the image, and feeds visualEvidenceVerified + expectedRevision/evidenceRevision into evaluateFinalGate. A missing, failed or undecodable render refuses visual approval; the evidence (revision, rendered, inspected, sanity warnings) is stated on the payload.

**Gap 3 - screenshot-qa was dead code.** analyzeScreenshot (blank/uniform/band detection) existed and was tested but ran in no live path. Both final_qa and the pipeline's verifyLiveScreen now run it on every render: a render that decodes to a blank canvas or a plain fill raises a visual finding and the visual verdict says fail (blank) - never a pass.

**Gap 4 - no escalation from repair to re-composition.** When the bounded repair loop ends with composition-scope findings outstanding (genericity, template, distinctiveness, composition, card-wall - the same scope diagnose() calls structural), both the pipeline and refine_screen now return a compositionReviewRequired block: stop cosmetic patching, re-run plan_screen or design_pipeline, compare structural variants, then rebuild.

**Tests:** tests/issue-26-quality-gates.test.mjs (9 tests) pins all four gaps, including the real-PNG fixtures in tests/lib/png.mjs (the old fake-image fixture is honestly flagged undecodable now). test:issue26 includes it; smoke 67/67, e2e 15/15, issue24 113/113, issue25 296/296; offline design benchmark stays 9/9 with visualEvidence honestly NOT_CAPTURED.

**Known remaining limitations** (documented, per the issue's definition of done): reference-frame selection/recording is not a benchmark concept yet; a weak-but-guard-passing composition is rejected by the genericity/final gates but not by a dedicated benchmark case; product-critic still runs at release-gate time, not per build; image inspection remains caller judgement - the server refuses to approve what was not seen, it does not claim taste.
## End-to-end workflow contract (issue #30 audit): plan context travels, failed dry runs block, overflow repairs on both axes, and build success demands visual proof

**Audit first** (3 explore agents over plan→runtime handoff, pre-build validation/dry-run gates, post-build loop + EXO): the workflow machinery from #22-#29 was in place, but four holes let the chain break between links. This closes the chain end to end.

**Handoff - the plan travels with the build.** The plan registry stored only a digest, so a `design_runtime` call carrying ONLY the planId proved that a plan exists while inheriting nothing - regions, style, constraints and the composition contract all had to be re-stated by the caller (the exact context loss a weak client exhibits). The registry now retains the issued payload and program skeleton (`registry.ts`, stamped by `plan/tools.ts`), and `design_runtime` hydrates a planId-only program from it (`hydratePlanFromRegistry`): the inherited plan enters through the same channel as an inline plan, so intelligence basis "plan", regions, visualIntent and the composition contract all flow without re-statement. A program with its own regions gets the plan's visualIntent backfilled ONLY when it declares none (the caller's own intent always wins), and plan-issued builds skip the generic auto art-direction fallback (`applyAutoArtDirection(opts.fromPlan)`), so the planner's manner is never double-directed or overwritten. Fail-closed: a bare planId that resolves to nothing (invented, evicted, or predating payload retention) is refused `refusedBy: "plan-handoff"` instead of compiling an empty screen.

**Pre-build - validation that repairs, and evidence that persists.** Canvas-spill validation existed and auto-repaired the vertical axis; horizontal spill had no repair. `canvasFitReflow` gained a rows pass: widths are peeled right-to-left above per-region floors (usable minimum, then content need), so one overflow class no longer depends on the axis it points at, with the repair counted in `reflowed`. Geometric honesty preserved: a row flush with the canvas edge is untouched (the peel triggers on exact spill, no tolerance inflation), and a region whose nested content demands its width is never truncated - the honest refusal stands rather than minting containment findings. Beyond validation, the dry run is now EVIDENCE, not a suggestion: every `design_runtime` dry run records its verdict per program fingerprint in the job ledger (`recordDryRun`/`lastDryRun`), and the live build of the SAME fingerprint is refused `refusedBy: "dry-run-evidence"` when the recorded dry run reported not-applicable, completed-with-violations, a failed composition handoff, or a capability-truth FAIL. A failed dry run can no longer be patched over by re-sending the identical program with dryRun:false; a changed program gets a fresh gate. Capability truth moved to build time (`checkCapabilityTruth` over the guard snapshot of compiled texts/layer names): a screen presenting, say, unpinned "SSO" as shipped is refused `refusedBy: "capability-truth"` before anything dispatches - previously that check ran only in design_guard and the pipeline's final gate.

**Post-build - success demands the visual loop.** A `design_runtime` build success used to close the payload with nothing demanded, so a weak client stopped at the build. Both success returns now carry a `verification` worksheet: status `built-not-verified`, the created root node id, and the concrete chain - `render_design` (detail low), `review_design` (free structural checks), `critique_visual` + targeted repairs or `refine_screen`, then `final_qa` - with the rule stated plainly: do not call the screen done without the revision-bound gate's PASS. Traceability became structural: `dispatchTransaction` threads planId into the job ledger (`JobRecord.planId`, protocol), so plan → transaction is a chain instead of the caller's memory. `render_design` now calls `recordRender` (the counter existed and was never invoked - "are builds followed by a render?" was unmeasurable), and its output names the workflow explicitly.

**Tests:** tests/issue-30-workflow-contract.test.mjs (15 tests) pins the chain: payload retention at registration, planId-only hydration (provenance receipt, applied basis "plan", handoff checked, real regions built), intent backfill only for unstated fields, both fail-closed handoff refusals, horizontal repair with exact right-edge landing, nested-floor freeze on unrepairable content, flush-edge tolerance, dry-run recording blocking an identical live rebuild (and the gate in isolation), clean dry run opening the gate to a built-not-verified success, planId on the ledger's begin record, capability-truth refusal naming the claim, and the render counter. Wired as `test:issue30`; typecheck clean; existing chain fully green (smoke 67/67, e2e 15/15, issue20 41, issue24 113, issue25 296, runtime 254, issue26 68).

**Known remaining limitations** (documented, not fixed): decision records are still not disk-persisted across restarts (in-memory chain per session); refine_screen does not yet consume critique_visual findings structurally; the low-level create_design/modify_design path threads preflight context only where evidence is provable offline (fail-open classes documented in preflight.ts); exo monochrome restraint is enforced through seeded tokens + the genericity/card-wall gates rather than a dedicated hue-count rule; deck-bound geometry validation remains compile-time only.

## Issue #30, phase 2: the phase-1 leftover list closed - refine consumes critique evidence, raw builds face their preflight gate, decision records persist on disk, EXO restraint is a measured rule, and deck slides hold their bounds

**Refinement - critique_visual findings reach the loop without re-statement.** `refine_screen` now accepts `fromCritique` (`mcp-server/src/review/workflow.ts`): the `VisualFinding` shapes critique produces (or minimal `{area, defect}` pairs, ids minted deterministically through visual-findings' own `makeFindings` - no second hash, no clock, no randomness, so replay is stable) enter refinement as evidence alongside the rule loop. A finding whose nodeIds intersect a rule finding tags that disposition `[vf-*]` with the linked outcome; a finding on a `preserve[]` target becomes `blocked`; a finding no rule finding reports is classified `needs-human` - deliberately in a separate vf ledger so the loop's convergence arithmetic, `dispositionCounts` and `compositionReviewRequired` still read exactly what the rules alone measured and a visual defect can never block or inflate the loop. Defect texts seed `visualGoals` behind the caller's own goals (priority, dedupe, cap 10), and the return payload (final + both fix-failed) carries a `visualFindings` section: dispositions, counts, the loop's own verdict as `structuralVerdict`, `visualVerdict: "unverified"` (structural repair verification sees only collect_metrics-measurable items), and `trackFindings` reconciliation against `priorFindings`.

**Raw builds - a low-level create/modify now carries the preflight evidence its own provenance can honestly support.** `derivedRawPreflightContext` (`mcp-server/src/tools.ts`) compiles the REGISTERED plan a call names (planId, or an inline plan's id) through `runtimePreflightContext` - the same channel design_runtime ships through - so client-authored operations evaluate against the plan at truth: `checkResolvedVsEmitted`, `checkChildBounds` with the plan's real overflow permissions, text and connector classes all run on the raw path. A planId the registry never issued (or one issued for another file) threads only the empty plan; a planless call still seeds `{ planBoxes: {} }` so replay containment runs ON the op stream's own declared chains. The approval waiver: waivable geometry tags (outside-bounds / text-overflow / geometry-drift / connector) refuse unless `approved: true` plus a reason - the same explicit-justification shape the provenance gate and score guard already accept - and a waived dispatch COMMITS with the findings surfaced as `[preflight-waived]` warnings plus a searchable final ledger label ("committed (N geometry finding(s) waived on approval)"; the earlier preflight-passed label is overwritten by apply, so the note rides the terminal state). Structural tags (schema, dup-id, dup-parent, unknown-ref, stale-ref, self-parent, page-target) never waive: an approval about judgment is not evidence about identity. Dry runs stay open: the threaded context runs the geometry classes there too, waivable findings surface as warnings ("dispatch without approval would be refused"), hard findings refuse as before; plan provenance lands on the ledger from both handlers.

**Chunk boundary - the gate no longer double-requires its own accepted testimony.** `runChunked` used to thread a `{ briefBlockers }` shell to every slice, which put the geometry classes in the fail-closed hole: no overflow permission records exist on a chunk-local replay, so an `overflow:"allow"` region whose children crossed a chunk boundary was refused for overflow the plan itself declared at the whole-list pass. The per-chunk context now carries only the brief blockers (real evidence, gating per chunk exactly like a single transaction) and is `undefined` otherwise - the whole-list pass stays the single program-level gate. The issue-23 contract is consciously re-worked to pin the new shape (chunks may carry briefBlockers and NOTHING else that activates a geometry class); tests/issue-23-preflight.test.mjs passes 31/31 on the re-pin.

**Decision records - decisions survive a restart and are surfaced on re-entry.** `persistDecisionRecord` gained the memory-store disk disciplines (atomic temp-then-rename, path-escape refusal on keys) and `decisionRecordStoreDir` honors `DESIGN_AGENT_DECISION_RECORD_DIR`, defaulting to `artifacts/decision-records/` - deliberately NOT the committed `artifacts/benchmark/decision-records/` gate fixtures, which keep their frozen history. The pipeline persists one record per fileKey at both final report stages and reads the record back at pipeline entry (`decisionRecord`, `decisionRecordNote`, plus `decisionRecordDrift` from `resumeDrift` when the record and the re-run brief describe the same screen), so a restarted session regains the recorded brief lock, constraints, direction, skills, discoveries and rejected alternatives instead of redesigning from scratch. Persistence problems are notes on the payload, never build failures. Pipeline records carry `caseId: null` (the pipeline tool has no caseId argument; the issue-22 benchmark runner's caseId path is untouched - gate 12/12).

**EXO - monochrome restraint is measured, not vibes.** `snapshotFromIR` now derives `hueFamilies` (`mcp-server/src/memory/guard.ts`): resolved colors from the program's content props bucketed into 8 stable HSL family bands (documented boundaries, red wrapping at 0; near-greys below saturation 0.12 never count; same-family repeats set-dedupe; values the snapshot cannot resolve - semantic words, gradients - count 0 rather than being guessed). New rule `exo.restrained-accent` (`mcp-server/src/memory/rules-exo.ts`, severity `warn` - a valid `ProductRuleSchema` value, graded WARNING, never FAIL): more than 3 distinct accent families trip the rule with the measured count in the evidence.

**Decks - slide bounds are compile-time geometry, not render luck.** `assertSlideBounds` beside `assertResolvedGeometry` (`mcp-server/src/runtime/compile.ts`, with `DECK_SLIDE_W/H` constants): every slide region and every child's absolute box is checked against 0,0,1920,1080 using the SAME violation vocabulary (`containment` / `geometry` - the existing blocking gate reads them unchanged; `overflow: "allow"` keeps the advisory `containment-allowed` escape, matching the canvas path). Deck compiles stay exempt from text fit and trace verification on purpose (the slides engine recomputes geometry at render time), but out-of-bounds slide content no longer compiles silently. Non-deck paths are unchanged; a negative-coordinate route that schema allows (negative per-slide padding) is pinned as a violation.

**Wiring and chain.** `test:issue30` now runs all six issue-30 test files (57 tests = phase-1 contract 15 + raw-preflight 15 + refine-critique 8 + exo-palette 6 + deck-validation 8 + decision-records 5); `.gitignore` ignores `artifacts/decision-records/` (runtime per-file state; the committed benchmark fixtures stay tracked). `npx tsc --noEmit` clean. Full chain on freshly rebuilt bundles (`npm run build:test`), 38 script families + smoke, ~1653 tests, zero failures: review 54, issue10 43, issue26 68, issue23 64, issue22 62, pipeline 24, runtime 254, plan included, invariants 14, issue24 113, issue25 296, plugin 119, product-guard 26, reliability 21, e2e 15, smoke green. The issue-16 (G01/G02/G04) and issue-17 (A01/B04) gauntlet failures recorded against the phase-1 baseline did not reproduce on this rebuilt run (22/22 and 22/22); treated as not-reproduced, not as a fix this phase contributed.

**Known remaining limitations** (documented, not fixed): the other dispatchTransaction callers (update_component, seed_exo, migrate_to_tokens, prototype_flow, create_slide, resume_job, the review fix-loop and the pipeline repair path) still dispatch server-generated operation lists without threading a preflight context - their ops are generated from compile-validated content rather than client-authored raw streams, but the change is ab-aware rather than closed; refine_screen's needs-approval gate-pause return carries the per-finding `[vf-*]` tags in its dispositions but not the aggregate visualFindings section (it rides the final and fix-failed returns, where a re-sent approved build finds it); pipeline decision records key on fileKey with `caseId: null`; `hueFamilies` sees only what the IR content props expose (unresolvable values count 0, never estimated); deck `overflow:"allow"` remains advisory, so a deliberate spill past a slide is a warning, not a refusal.

## Issue #30, phase 3 (close-out): the phase-2 limitation list closed - every dispatch site threads preflight evidence, gate pauses carry the findings honestly, decision records carry their case, the guard names what it did not evaluate, and a declared deck bleed is surfaced data rather than a shrug

**Dispatch sites - server-generated operation lists now carry the same evidence discipline as client-authored streams, with the escapes one argument away.** `containmentOnlyPreflightContext()` (`mcp-server/src/preflight.ts`) hands out the empty-plan replay context (`{ planBoxes: {} }`) so containment runs on each op stream's own declared chains. The template and sweep flows thread it at dispatch (`mcp-server/src/tools.ts`): `seed_exo_system`, `migrate_to_tokens`, `prototype_flow` and `create_slide` - their commit paths stayed green unchanged, which is the regression proof that containment-only threading keeps the creative flows one-argument-safe. `update_component` owns its preflight outside the dispatcher and now mirrors `transaction.ts`'s waiver exactly: soft-only geometry findings proceed on `approved:true` plus a reason (committed with `preflightWaived`/`[preflight-waived]` warnings riding the result), structural tags never waive, and a preflight-failed refusal teaches the waiver channel when waivable findings caused it (refusal and result both come off the one `splitPreflightIssues` split: the refusal names the waivable tag classes and how many of its findings they cover, the committed result carries `preflightWaived` plus the `[preflight-waived]`-prefixed warnings - nothing re-summarizes the findings twice). `resume_job` re-threads the evidence the stalled job actually had: the stored ledger record's `planId` (when the original dispatch recorded one) is compiled through `derivedRawPreflightContext` against the reconnecting session's `fileKey`, falling back to containment-only when no plan was recorded; both resume schema copies gain optional `approved`/`reason`. `edit_screen` threads both of its dispatch sites (apply and the repair loop) and runs the same waiver mirror on its early pass, so an approved geometry finding names itself in the timeline rather than stranding the caller. The refine fix-loop and the pipeline's build/repair dispatches thread containment-only with the caller's `approved`/`reason` passed through untouched on every fix round (never invented, never coerced).

**Gate pauses - a refine_screen `needs-approval` return now carries the fromCritique aggregate as pending, never pre-classified.** `vfPauseLedger`/`vfPauseSection` (`mcp-server/src/review/workflow.ts`) build the section in scope for both pause returns (build-phase gate and fix-loop gate): `stage: "gate-pause"` states where the loop stopped, items carry the caller's findings with `disposition: "pending"` and `verified: false` (nothing was applied, so nothing is addressed or needs-human - classifying at a pause would fabricate outcomes nobody measured), `counts` report `{pending, addressed: 0, needsHuman: 0, blocked: 0}`, `trackFindings` reconciliation still runs when `priorFindings` is supplied (resolved/persisting/introduced is arithmetic the pause is honest about), and a note names the pause. The section is absent when no visual findings exist, so a rules-only session's pause payload does not grow. The classified ledger keeps riding the final and fix-failed returns unchanged.

**Decision records - a named benchmark case identity rides the record.** `design_pipeline` gains an optional `caseId` (`z.string().min(1).max(200)`, threaded into `recordBaseInput` as `caseId: args.caseId ?? null`): an offline-brief run the caller names is recorded under that identity instead of a hardcoded null, an unnamed run still records `null` (identity nobody gave is not invented), and the identity survives the frozen-schema round-trip on restart read-back. The issue-22 benchmark runner's own caseId path is untouched (gate 12/12).

**Guard honesty - an unevaluated check is neither pass nor fail, and the finding says so.** The guard's missing-metric message now states the state plainly: "was not collected by this snapshot - unevaluated, neither pass nor fail", with the per-surface reason attached (`hueFamilies`: program snapshots carry it from resolved style colours, live inspect snapshots cannot because colour props do not survive measurement - run design_guard with the program to evaluate it); the `implies` branch labels dependency skips the same way. When a graded rule has no breaches but unevaluated checks, its finding carries that aggregate on `evidence` (the unevaluated checks' own messages plus the manual-only questions, joined) so a WARNING-scoped rule cannot read as a clean pass that silently skipped its own criteria.

**Deck bleed - declared escapes are surfaced data.** Parity verified first: the dispatch-time gate (phase-1) requires a non-empty reason on an `overflow:"allow"` op stream, while the compile-time advisory keeps bare-allow semantics for program-authored regions - the creative escape stays one argument away at both gates. Deck/canvas compiles now collect deliberate bleed while asserting geometry: `assertResolvedGeometry` and `assertSlideBounds` take a bleed collector, `bleedByRegion` is threaded to both call sites, and the compile result attaches `boundsAdvisories` (`shared/ir.ts`: `{ count, regions: [{region, children}], note }`) whenever any escape was collected - the region that declared the escape, the children that wander past it, and a note naming both the declaration and what an undeclared spill would have been. Undeclared spill still refuses as blocking `containment` and never appears in the advisory payload; well-behaved screens carry no key at all.

**Wiring and chain.** `test:issue30` now runs seven issue-30 test files (82 tests = phase-1 contract 15 + dispatch-threading 15 + raw-preflight 15 + refine-critique 11 + exo-palette 7 + deck-validation 11 + decision-records 8). New `tests/issue-30-dispatch-threading.test.mjs` pins the threading at every site: the four template/sweep flows commit with containment-only context (the creativity check - no new refusals for the flows that were always allowed), update_component's three-way (structural refusal without a waiver path, unapproved refusal naming `approved:true plus reason`, approved commit carrying the waived findings), resume_job's stored-plan derivation plus containment-only fallback, edit_screen's early-pass teaching/waiver/commit and repair-threading, refine's fix-dispatch passthrough, and the pipeline repair dispatch. The paused/refused verdict taken at the gate is asserted alongside `stage:"gate-pause"`, exact pending items, counts, reconciliation, and the no-leak case (a run that never pauses never carries the stage). `npx tsc --noEmit` clean. Chain on rebuilt bundles: issue30 82/82, issue23 64/64, issue26 68/68, issue16 22/22, review 54/54, runtime 254/254, reliability 21/21, smoke 67 checks, e2e 15/15.

**Known remaining limitations** (documented, not fixed): a `resume_job` on a `timed-out` ledger record stays reconcile-first at the dispatcher by contract (the outcome is unknown and a late commit may still land, so a same-id retry is refused until a late result reconciles the record - the retryable branch is `failed`/`rolled-back`/`partial-rollback`); the pipeline repair dispatch threading is contract-pinned through the harness (the repair payload observable on the recorded session) and not E2E-exercised on a live file; the bare-allow compile advisory and the dispatch gate's reason requirement are intentionally different strengths (a program region may declare `overflow:"allow"` without prose, a raw op stream must state it on the record); `boundsAdvisories` lists which children escaped each region but not the region's own resolved box; a gate-pause reports the caller's fromCritique findings as pending without localizing rule findings into them (that reconciliation is the classified ledger's job, and at a pause no classification was earned).

## Issue #23 §4 re-pin: production screens are clean by default - the pipeline no longer paints provenance captions on the deliverable

**Observed:** the disclosure policy's default was ON - any brief whose values are not live (`dataMode: demo`/unknown) and that carries content had the fixed caveat sentence ("Illustrative values - the screen is not connected to live data.") painted onto the built screen, and the product-critic's repair instruction told the loop to add more of them. A production design deliverable that labels itself a demo stops being the deliverable: the user called the screens useless for production.

**Fix - silence on the surface, truth in the ledger.** The policy's polarity is reversed (`mcp-server/src/pipeline/disclosure.ts`): no provenance caption is painted unless the caller explicitly passes `onScreenDisclosure: true` (new brief field, normalized in `brief.ts` with its own stated assumption record, documented on the tool schema in `pipeline/contracts.ts`). `cleanConcept: true` keeps its meaning - the explicit no-caption request recorded with provenance - and wins when both flags are set (a contradiction resolves toward the cleaner screen). The opt-in still earns the original guarantees: exactly one caption, deduped against copy that already discloses, placed by the same ladder (footer, then the region with the most illustrative values, never header/nav chrome), and the build note names the placement as "as explicitly requested". The default run still records the data mode everywhere that matters - the illustrative-data assumption records, one build note naming the default and the opt-in that would restore the caption, and the release gate's limitations line - so a clean screen is not a lost truth; it is the product look production runs asked for.

**The repair loop is no longer sent back to paint.** The product-critic's `product.claims-live-data-without-source` finding keeps its critical severity (an invented live claim is still called what it is), but its remedy changed from "add a single concise disclosure" to "reword the live-sounding labels" - the screen stops claiming a connected source, provenance stays in the report, and the one caption path left is the explicit `onScreenDisclosure` request (the rationale names the re-pin).

**Wiring and chain.** `tests/issue-23-disclosure.test.mjs` re-pinned (10 tests): the default illustrative screen paints ZERO captions with the data-mode note carrying the opt-in name; the explicit request places exactly one node beside the data (never the chrome) with the stated assumption record; footer-ladder preference on the opted-in run; `cleanConcept` beats `onScreenDisclosure`; clean-concept and live-mode records unchanged; the dedupe and marker vocabulary hold on the opted-in path; the critic's fix demands honest rewording and must not teach painting; an invented live claim still fails critical. Chain: pipeline 24/24, issue22 62/62, issue23 66/66, issue24 113/113, review 54/54, runtime 254/254, design 53/53, blueprint 27/27, reliability 21/21, smoke 67 checks, e2e 15/15, `npx tsc --noEmit` clean. One gauge re-pin off this change: issue-25's G02 (`the focal region built at 27.0% against a planned 27.1%`) - without the caption row the plan's fractional fit estimate rounds a fill height up to 301px while the compiler's integer row-solve lands 300px, a one-pixel solver-resolution drift the gauge was never about; its assertion now allows exactly one pixel and pins the reasoning in the test.



