# FigDes Professional Design System — Implementation Handoff

Repository: `manish9701/FigDes`

## Mission

Implement one integrated design-quality pipeline, not another series of isolated UI fixes:

**brief → visual direction → composition candidates → canonical design IR → native Figma rendering → screenshot capture → visual critique → targeted repair → regression checks → evidence-backed final gate → benchmark artifacts**

A successful Figma API call is not evidence of good design. A dry run is not execution. A structural planner score is not a visual score. Never fabricate screenshot evidence or visual scores.

## Current modules to reuse

Audit and extend these before introducing replacements:
- `mcp-server/src/plan/planner.ts`
- `mcp-server/src/design/composition/derive.ts`
- `mcp-server/src/design/composition/planner.ts`
- `mcp-server/src/design/composition/relationships.ts`
- `mcp-server/src/design/compiler/screen-compiler.ts`
- `mcp-server/src/design/compiler/native-plan.ts`
- `mcp-server/src/design/compiler/component-resolver.ts`
- `mcp-server/src/design/system/typography.ts`
- `mcp-server/src/design/system/token-intelligence.ts`
- `mcp-server/src/design/system/component-intelligence.ts`
- `mcp-server/src/design/quality/{visual-critic,visual-findings,repair-planner,genericity,comparison,final-gate}.ts`
- `mcp-server/src/design/benchmark/suite.ts`
- `scripts/run-design-benchmark.mjs`
- existing plugin/native execution, tests and `.github/workflows/ci.yml`

Preserve the working native Figma plugin path and transaction/rollback behavior. The current benchmark runner is explicitly offline/structural and sets `visualBenchmarkComplete: false`; keep that honest.

## 1. Canonical typed contracts

Create or consolidate one shared intermediate representation. Avoid every subsystem inventing its own data shape.

### DesignBrief
Include ID/name/product/platform/viewport, audience, user context, goal, primary decision, content inventory and priority, entities, relationships, interactions, states, accessibility requirements, brand/design-system constraints, references, acceptance criteria, unknowns and assumptions.

### VisualDirection
Include selected composition family and rationale, focal point/hierarchy, density/whitespace, typography voice/scale, color/surface treatment, asset strategy, product-specific signature, reference evidence/provenance, tokens, rejected alternatives and reasons.

Generate at least three materially different internal composition candidates when direction choice matters. Candidates must differ in structure, not just color. Score against task fit, hierarchy, product identity, content fit, accessibility and reference alignment. Keep candidate records in benchmark artifacts; do not create extra visible frames unless asked.

### DesignIR
Semantic Screen/Region/Component/Text/Asset/DataViz/DiagramNode/Relationship/Interaction/TokenBinding records with stable IDs, parent-child structure, constraints, tokens, z-order, accessibility role/name/state, provenance, confidence and unresolved decisions. Relationships encode types such as `connectsTo`, `dependsOn`, `assignedTo`, `flowsTo`, `contains`, and `comparesWith`, with relevant labels/data.

### RenderEvidence
Store page/frame IDs, screenshot artifact/reference, capture time, viewport/native dimensions, commit/plugin version, run ID, IR revision/hash, render number, critique results, affected nodes, human inspection status and changes since the previous render.

### CritiqueFinding / RepairTrace
Every finding needs a rule/category/severity/confidence, evidence type, screenshot crop or geometry, affected semantic/native IDs, impact explanation, repair hypothesis, expected improvement and verification result. Every repair trace records targeted findings, operations, before/after scores, regressions, render IDs and outcome.

## 2. Brief intelligence and reference analysis

Compile the user brief before planning. Identify the user’s actual goal, one primary decision, information needed, entities/relationships, content priority, interaction states, platform constraints and acceptance criteria. Represent unknowns explicitly; do not invent real-looking data.

Analyze provided/current-file reference designs for macro composition, region ratios, focal point, type scale, density, whitespace, grid/alignment, surfaces, asset treatment and distinctive details. Extract principles rather than copying whole screens. Preserve reference provenance.

Detect genericity with evidence: repeated equal-sized card grids/KPI strips, the same shell across unrelated tasks, irrelevant charts, decorative empty blocks, excessive rounded containers, and default centered-hero/three-card layouts where they do not fit. Each finding must propose a task-relevant alternative.

## 3. Composition engine

Build multiple genuinely distinct strategies: spatial topology/graph, object/model inspector, monitoring instrument, comparison/compatibility matrix, configuration workbench, data-heavy workspace, editorial/product storytelling, exploration/list-detail, authoring canvas and onboarding/setup.

`decisionKind` may influence strategy selection but must not impose a fixed shell. Geometry must derive from content, relationships and constraints. Use deterministic constraint/layout logic rather than asking an LLM to guess dozens of unrelated absolute coordinates. Account for text measurement/wrapping, hierarchy, whitespace, asymmetry, density, viewport constraints, overflow and responsive reflow.

For topology/diagrams: size nodes from content, place by semantic grouping/dependency/flow, route edges between node boundaries, avoid node/edge/label collisions, label relationship meaning, show direction when relevant, and preserve graph meaning when nodes change. Validate that every declared relationship is visible or explicitly summarized.

Add geometry tests for overlaps, connector routing, label collisions, long text, dense graphs and viewport overflow.

## 4. Reusable design system

Implement semantic tokens for typography, colors/contrast, spacing/grid, radii/borders/elevation, icons/targets, chart/diagram semantics and state labels. Resolve tokens into native Figma text styles, paint styles, variables and components/variants when supported. Reuse compatible existing styles instead of creating one-off styles for every text layer.

Keep EXO’s established light theme for EXO, but do not impose it on unrelated products. Use mono for technical identifiers/latency/hashes when appropriate. Verify font availability, text wrapping, contrast and state labels. Static labels must not be treated as controls merely because they are text.

## 5. Native Figma renderer

Compile the canonical IR into allowlisted native Figma operations using the existing plugin path. Generate editable frames/text/vectors/components/styles, use Auto Layout/constraints when suitable, preserve semantic names and parent-child relationships, validate local-vs-absolute coordinates, and inspect the created nodes after execution.

Support text measurement, vector connectors, image crop/provenance, styles/variables and component instances when available. Use transactions/rollback, do not touch unrelated user work, create a named new frame for a new concept, and make retries idempotent. Return a manifest of created/modified IDs, warnings and unsupported operations. Unsupported primitives must fail clearly rather than disappear silently.

## 6. Screenshot capture and two critics

Connect the live plugin render path to screenshot capture and return screenshot/reference plus revision metadata. If the transport cannot return screenshots, implement a small explicit protocol extension. Never fabricate image bytes or score an unseen screenshot.

Run:
1. **Structural critic:** bounds/overlap/clipping, content presence, text wrap, contrast, token/style consistency, connector geometry, relationship coverage, valid operation support and actual interactive target sizes.
2. **Screenshot visual critic:** macro composition, focal point, hierarchy at intended viewing size, balance/whitespace, genericity, density, typography rhythm, product identity, relationship comprehension, craft/assets and brief fidelity.

Provide the critic with full screenshot, selected crops, DesignIR, brief/direction, reference evidence and structural findings. Findings must cite visual evidence and native node IDs. If visual inspection is unavailable, visual score is unavailable.

False-positive tests are mandatory: static connector labels are not buttons; ordinary text is not automatically interactive; decorative shapes do not automatically need labels. Use semantic role/state to decide which checks apply.

## 7. Targeted repair loop

Prioritize:
1. critical brief failure/missing primary information
2. clipping/overlap/broken relationships
3. weak focal point/hierarchy
4. unreadable typography/contrast
5. composition/density/whitespace
6. style/component inconsistency
7. minor polish

Each repair names findings and affected nodes, explains the hypothesis, changes the smallest possible scope, preserves correct regions, rerenders when needed, verifies resolution and checks for regressions.

Default budget: one initial build, one initial critique, up to three repair batches, at most four full renders. Stop early on passing criteria, stop if two successive passes do not improve, and otherwise return the best known version with unresolved findings. Budget exhaustion must never convert REVIEW to PASS.

## 8. Evidence-backed final gate

Statuses:
- `PASS`: evidence complete and all acceptance gates met
- `REVIEW`: no hard blocker, but evidence/quality requires human review
- `FAIL`: hard requirement violated, execution invalid or critical defect remains

PASS requires all required evidence-backed scores, no critical/blocking findings, complete content/relationships, a fresh screenshot matching the final frame revision, screenshot critique, structural checks, regression verification and valid run metadata. Missing/stale/mismatched screenshots or missing scores must never pass. Remove fallback scores that make missing evidence look complete. Critical blockers override aggregate scores.

## 9. Benchmark and scoring

Retain the existing nine cases: EXO topology, model fit, runtime monitoring, configuration, enterprise workspace, generic SaaS negative control, data-heavy workspace, spatial relationship and editorial product page.

Keep the existing runner labelled `offline-planner-structural`. Add a separate live Figma benchmark mode. Every live case stores brief/fixtures, candidate direction, IR/operation manifest, native frame ID, screenshot, structural findings, visual findings/scores, repairs, unresolved issues, runtime and source commit. Fixture values must be clearly marked.

Proposed starting 100-point scorecard (calibrate against human ratings):
- composition/hierarchy 25
- visual identity/distinctiveness 20
- typography/information design 20
- geometry/spacing/alignment 15
- detail/assets/component craft 10
- brief fidelity/accessibility 10

A critical failure overrides the total. Compare baseline vs new output at fixed viewports. Use blind human judgments when possible. Track whether repairs improve human preference, not merely the automated critic. Do not optimize only for the critic.

## 10. CI and regression tests

CI should run deterministic build/typecheck/unit/contract tests and the offline structural benchmark. Live plugin tests must be opt-in/manual when no active session exists, and save screenshot/evidence artifacts. CI must not imply a live test occurred when it did not.

Required tests:
- missing visual evidence/scores never PASS
- stale screenshot or wrong revision never PASS
- no screenshot means no visual score
- static connector labels do not trigger target-size rules
- adding a node does not create overlaps and preserves graph relationships
- long labels reflow rather than clip
- targeted repairs resolve findings without regressions
- unsupported primitives fail explicitly
- retries do not duplicate frames
- negative control detects generic dashboard composition
- distinct briefs yield meaningfully distinct structures
- benchmark completeness and report schema validation

## 11. Suggested source organization

Adapt to existing files; do not duplicate working modules:
- `design/brief/`
- `design/direction/`
- `design/ir/`
- existing `design/composition/`
- existing `design/system/`
- existing `design/compiler/`
- `design/evidence/`
- existing `design/quality/`
- existing `design/benchmark/`

## 12. Execute as one integrated milestone

Work in one coherent branch/PR; do not ask the user to approve every subsystem.

1. Audit modules and document reuse points.
2. Consolidate contracts and validators.
3. Implement content/relationship-aware composition and graph layout.
4. Compile IR to editable native Figma with reusable styles/tokens.
5. Wire screenshot capture to final frame revision.
6. Combine structural and visual critics with false-positive controls.
7. Wire targeted repairs, rerenders and regression checks.
8. Enforce evidence-backed final gate.
9. Add live benchmark and artifacts without mislabelling offline tests.
10. Run builds/tests and, with an active plugin session, live Figma tests.
11. Deliver one PR with implementation, tests, baseline/final screenshots, benchmark report and explicit blockers.

If environment constraints prevent full live execution, implement what is possible and state exact blockers. Do not claim end-to-end completion without evidence.

## 13. Required final report

Return file paths changed; reused modules; exact commands and exit statuses; plugin session status; screenshot/artifact references; benchmark results per case; per-dimension scores/evidence; findings resolved/open; whether a human reviewed; and blockers.

Use labels accurately: `IMPLEMENTED`, `UNIT_TESTED`, `CI_VERIFIED`, `LIVE_FIGMA_VERIFIED`, `HUMAN_REVIEWED`. Never substitute one for another.

## Core principle

**FigDes must become a design decision system, not a shape-placement system.** The design must solve the brief, have deliberate visual identity, communicate clearly, remain editable in Figma, and carry evidence that the final result was inspected and improved.
