# FigDes Design Intelligence & Production-Quality Generation Blueprint

**Purpose:** Make FigDes consistently produce excellent, distinctive, editable, product-aware Figma designs—not merely structurally valid frames or polished dashboard-shaped layouts.

**Status:** Engineering blueprint and definition of done. This document describes proposed improvements to be implemented on top of the existing FigDes planner, Figma construction tools, visual critic, repair history, evidence gate, and benchmark infrastructure. It is not a claim that every proposed module or behavior already exists.

**Primary objective:** Every design should be driven by the user's task, use an appropriate composition, respect the product's design system, survive rendering and inspection, and ship with evidence tied to the exact final revision.

---

## 0. Non-negotiable principles

1. **Design the task, not the template.** Choose information architecture and composition from the user's goal, domain, content, and interactions. Do not default to a sidebar + header + grid of cards.
2. **Visual polish is not product completeness.** A visually attractive screen can still be wrong, misleading, incomplete, inaccessible, or unusable.
3. **Structure is necessary, not sufficient.** Passing geometry checks does not prove visual quality. Passing a visual critique does not prove structural correctness.
4. **Use evidence, not intuition alone.** Findings should be traceable to a rendered image, source nodes, measurable geometry, design tokens, or explicit requirements.
5. **Preserve user work.** Inspect before modifying. Do not overwrite, delete, or rearrange existing work unless the task requires it.
6. **Use native, editable Figma structures.** Prefer components, variants, Auto Layout, constraints, semantic layer names, and genuine graph relationships over piles of manually positioned primitives.
7. **Keep the design system coherent without making screens identical.** Consistent tokens and interaction patterns are good; repeated composition regardless of task is not.
8. **Never manufacture a PASS.** Keep structural, visual, product, accessibility, and evidence statuses distinct. A pending check is not a pass.
9. **Repairs must address causes.** Do not suppress a finding, add a whitelist, weaken a threshold, or change the evaluator merely to make a score improve.
10. **Verify the exact final revision.** After the last mutation, render again and bind reviews, scores, screenshots, and gate decisions to that revision.
11. **Illustrative data must be labelled.** Never imply sample hardware, telemetry, benchmark numbers, or runtime states are live data.
12. **Optimize for quality and generalization, not output volume.** Three exceptional, differentiated screens are better than dozens of generic variants.

---

## 1. Current baseline and intended evolution

FigDes already has useful foundations, including a task-aware planner, composition/topology concepts, a visual critic, structured findings, repair history, evidence-oriented quality gates, and an offline benchmark with a separate live-validation path. Preserve and extend these foundations instead of building competing versions of the same systems.

The EXO Labs screen exercise exposed areas to improve:

- Screens were coherent but leaned on a familiar navigation-rail + header + panel layout.
- Some layouts repeated the same spatial grammar even when the task differed.
- Several charts and values were illustrative rather than connected to a real data source.
- A node graph can look plausible without proving that edge anchors and graph semantics are robust.
- A Figma frame can be visually complete without containing proper responsive behavior, interaction states, reusable components, or a handoff-ready layer structure.
- A heuristic review may identify measurable issues but cannot, by itself, fully judge visual distinction or task effectiveness.

These are observations from the design exercise, not proof that every part of the codebase currently has these defects. Confirm the current implementation before changing it.

### Goal state

FigDes should behave like a senior product designer collaborating with a reliable design engineer:

1. Understand the brief and existing product.
2. Inspect the current file, design system, constraints, and existing work.
3. Generate multiple composition hypotheses.
4. Compare and select a direction with explicit reasoning.
5. Construct a native, editable Figma design.
6. Render the actual output.
7. Evaluate structure, visual quality, product completeness, accessibility, and consistency independently.
8. Repair confirmed problems at their source.
9. Render and verify the final revision.
10. Deliver the design, evidence, known limitations, and honest gate verdict.

---

## 2. Proposed architecture

These are target responsibilities, not a statement that every module already exists. Map them to existing code before implementing. Reuse existing planner, critic, repair, gate, and benchmark infrastructure wherever possible.

| Responsibility | Proposed module | Output |
|---|---|---|
| Understand task | `design-brief` | Structured brief and constraints |
| Inspect Figma/product context | `context-inspector` | Existing frames, tokens, components, styles, conventions |
| Generate layout directions | `composition-planner` | Several distinct, feasible composition candidates |
| Choose direction | `composition-selector` | Selected candidate and reasoned trade-off record |
| Discover and bind tokens | `design-system-intelligence` | Token/component inventory and bindings |
| Compute geometry | `layout-solver` | Bounds, relationships, constraints, layout rules |
| Build native Figma output | `figma-builder` | Editable frames, components, constraints and semantic nodes |
| Check structural correctness | `structural-validator` | Geometry, edges, clipping, overlaps and hierarchy findings |
| Review visual quality | `visual-critic` | Evidence-backed visual findings |
| Review product usability | `product-critic` | Task, workflow, content and state findings |
| Review accessibility | `accessibility-checker` | Contrast, text size, state differentiation and keyboard/focus requirements where representable |
| Repair defects | `repair-engine` | Minimal causal mutations and verification requirements |
| Benchmark quality | `benchmark-engine` | Per-dimension outcomes, regressions and challenge artifacts |
| Control release | `evidence-gate` | Revision-bound status and unresolved limitations |
| Learn across tasks | `design-memory` | Confirmed decisions, successful repairs and adjudicated findings |

### Architecture rule

Do not create a new module just to rename an existing function. Start by mapping the current repository modules to these responsibilities. Split modules only when the responsibilities are genuinely missing or tightly coupled in a way that prevents testing and maintenance.

### Recommended data flow

```text
User brief
  -> Design brief
  -> Existing-file and design-system inspection
  -> Composition candidates
  -> Candidate evaluation and selection
  -> Layout specification
  -> Native Figma construction
  -> Structural validation
  -> Render actual Figma result
  -> Visual + product + accessibility critiques
  -> Causal repair loop
  -> Fresh final render and revision-bound evidence
  -> Evidence gate
  -> Handoff package + design memory
```

---

## 3. Design brief and product reasoning

Before building, derive a compact, explicit brief. Do not jump straight from a prompt to coordinates.

### Required brief fields

- `product`: product name and domain.
- `screen_goal`: what this screen must enable.
- `primary_user`: primary user/persona or role, if known.
- `primary_task`: the user's primary job on this screen.
- `primary_decision`: the most important decision this interface supports.
- `supporting_tasks`: secondary jobs, ordered by importance.
- `content_inventory`: required data, actions, entities, and relationships.
- `information_priority`: critical, important, secondary, optional.
- `interaction_model`: canvas, table, graph, editor, inspector, timeline, form, feed, command surface, or a justified hybrid.
- `data_states`: realistic, empty, loading, stale, partial, error, disconnected, disabled, success.
- `constraints`: viewport, platform, accessibility, technical limitations, existing system, brand, and time constraints.
- `visual_direction`: desired character with references or verbal rationale when supplied.
- `design_system_source`: existing file/styles/components to inspect.
- `unknowns`: assumptions that must not be presented as facts.
- `acceptance_criteria`: observable conditions for success.

### Brief rules

- If a critical requirement is ambiguous, ask one concise clarification when the answer materially changes the result. Otherwise record an explicit assumption and continue.
- Never invent user research, product behavior, APIs, or live metrics.
- Separate requirements provided by the user from assumptions and design recommendations.
- If a screen's goal is unclear, do not use a generic dashboard as a fallback. Identify the likely user task and document the assumption.
- Rank information by the task. Do not give every field equal prominence.
- Ensure the primary action, system status, and consequences of an action are understandable.

### EXO example

**Compute Fabric**
- Primary job: understand distributed machines and their relationships.
- Primary decision: where workload capacity is available and what needs attention.
- Natural composition: graph/spatial canvas + selection details + compact workload assignment.
- Required semantics: machine nodes, actual network links, link latency, resource status, workload placement, selected-node details.
- Critical states: disconnected node, stale telemetry, link failure, capacity pressure, selected node, empty fabric.
- Avoid: decorative graph lines, fabricated live status, or an arbitrary card grid.

**Model Studio**
- Primary job: choose a model and runtime configuration that will work on the available hardware.
- Primary decision: which model/quantization/context profile fits the user's cluster and requirements.
- Natural composition: comparison-oriented list/table + evidence-backed fit explanation + configuration preview.
- Required semantics: memory estimates, runtime overhead, compatibility limitations, model availability, context length, placement and a clear run action.
- Critical states: insufficient memory, unsupported runtime, download in progress, missing model, failed load.
- Avoid: calling a model “recommended” without explaining the criteria.

**Runtime**
- Primary job: diagnose active inference and resource pressure.
- Primary decision: whether to continue, pause, rebalance or intervene.
- Natural composition: workload-focused metrics + time series + node diagnostics + event timeline.
- Required semantics: units, time range, update freshness, threshold, severity, event source, actions.
- Critical states: telemetry unavailable, stale values, paused run, failed request, overload.
- Avoid: decorative charts, unexplained numbers, or implying static mock data is live.

---

## 4. Composition engine

### 4.1 Generate alternatives before committing

For a substantial screen, generate at least 3 genuinely different composition hypotheses at the planning stage. They can be low-cost structural candidates; they do not all need full Figma rendering.

Candidates must differ meaningfully in at least one of:
- Information architecture.
- Primary spatial arrangement.
- Interaction pattern.
- Relative emphasis and hierarchy.
- Navigation model.
- Treatment of the main object/task.

Changing only color, corner radius, or card count does not count as a distinct composition.

### 4.2 Composition families

Use these as a vocabulary, not a fixed template catalogue:

- Spatial graph / topology.
- Canvas / node editor.
- Comparison / decision workspace.
- Dense table / data explorer.
- Monitoring / observability.
- Timeline / event stream.
- Document / editorial workspace.
- Form / configuration.
- Command palette / task surface.
- Search and results.
- Map / geospatial view.
- Inspector-led workspace.
- Split editor / preview.
- Feed / triage queue.
- Guided onboarding / empty state.
- Hybrid compositions with explicit reasons.

The system must be allowed to invent new compositions when known families do not fit. A composition family is not a requirement to use a specific layout.

### 4.3 Candidate evaluation

Score and explain each candidate against:
- Task fit.
- Information hierarchy.
- Relationship clarity.
- Data density and scanability.
- Interaction efficiency.
- Product identity.
- Existing design-system fit.
- Responsive feasibility.
- Accessibility.
- Implementation feasibility.

Weights should be configurable per task category and versioned. The agent must retain the raw dimensions and explanation; never use a single score to hide a serious failure.

### 4.4 Layout solver

The layout solver should reason about:
- Parent/child geometry and coordinate spaces.
- Bounds and clipping.
- Alignment and spacing relationships.
- Minimum/maximum sizes and content fit.
- Typography metrics, line wrapping, truncation and line count.
- Grid and responsive constraints.
- Visual grouping and proximity.
- Dominant and supporting regions.
- Relationship paths, edge anchors, crossing, direction and overlap.
- Whitespace as a deliberate layout resource.
- Selection/inspector states and resizing behavior.

Do not optimize geometry by merely minimizing whitespace or making all regions similarly sized. Whitespace is correct when it supports hierarchy, focus, grouping and reading rhythm.

### 4.5 Prevent template collapse

Track similarity across generated screens using composition-level features, not only colors or shapes. Features may include:
- Relative region bounds.
- Number and placement of columns.
- Dominant region.
- Distribution of text, data and actions.
- Navigation pattern.
- Primary interaction model.
- Relative area of canvas/table/inspector.
- Graph/table/chart topology.

If multiple screens have the same structure despite different tasks, trigger a composition review. Do not punish reuse of a genuinely shared product shell; evaluate the task-specific main region separately from the global shell.

---

## 5. Design-system intelligence

Inspect the existing Figma file before generating. Discover, when available:
- Color variables and semantic roles.
- Typography styles, type scale and font availability.
- Spacing, sizing and grid conventions.
- Radii, borders, shadows, effects.
- Components, component sets and variants.
- Buttons, inputs, menus, tables, badges, tooltips and navigation.
- Existing layout patterns.
- Brand elements and iconography.
- Light/dark themes and platform conventions.
- Naming conventions and layer structure.

### Binding policy

1. Reuse existing components and variables where semantically appropriate.
2. Do not substitute a near-match token solely because it is visually similar.
3. Do not introduce a new token when a suitable semantic token exists.
4. If a required token is missing, propose or create a justified token consistently rather than hardcoding scattered values.
5. Distinguish semantic roles (success, warning, danger, selected, muted) from raw color values.
6. Check text contrast and state differentiation after binding.
7. Record any deliberate deviations and their reasons.

### Consistency versus sameness

Consistency includes shared tokens, typography, spacing logic, interaction conventions, terminology and component behavior.

Sameness is reusing the same screen structure when the task calls for something different. The engine must preserve consistency while varying composition.

### Token-aware repairs

Repairs should prefer semantic token changes or component-level changes when that is the correct cause. Avoid patching dozens of individual node fills when the issue is a shared semantic style. However, do not globally change a token if only one exceptional component is wrong.

---

## 6. Native Figma construction and implementation quality

The builder must produce editable, maintainable Figma artifacts—not just a screenshot-like arrangement.

### Required capabilities

- Correct parent-local coordinate handling with explicit coordinate-space contracts.
- Valid finite geometry; reject `NaN`, `Infinity`, negative or impossible dimensions.
- Real relationships and connectors anchored to the correct graph objects.
- Native Auto Layout for content that should flow or resize.
- Constraints and resizing behavior where appropriate.
- Components and variants for repeated UI elements.
- Semantic layer names and clean grouping.
- Consistent typography and line-height settings.
- Real text fit: avoid clipping, overlap, accidental truncation and overflow.
- Reusable graph nodes, data rows, status indicators, chart labels and inspector sections.
- Consistent component properties and states.
- A clear separation between structural primitives and product components.
- Safe transactions, operation validation, idempotency where possible, and rollback or recovery for failed writes.
- Preserve unrelated frames and content.
- Avoid excessive one-off primitive layers when a semantic component is appropriate.

### Graph-specific requirements

- Model graph nodes, edges, clusters and ports as distinct semantic entities.
- Edges reference stable node/port identities, not only fixed coordinates.
- Node movement recalculates connected edges.
- Edge routing accounts for bounds, overlap and crossing.
- Validate missing endpoints, duplicate edges, self-loops where disallowed, disconnected subgraphs and invalid topology.
- Layout algorithms must return finite coordinates and respect separation/bounds.
- Include tests for radial, force-directed, grid and other supported layouts.
- Render a graph-only view during debugging to reveal missing or occluded edges.
- A topology screenshot is not proof of graph correctness; test the graph data model and live rendered output.

### Interaction states

Represent relevant states rather than creating only a happy-path screenshot:
- Default.
- Hover and focus, where appropriate to the target platform.
- Selected.
- Disabled.
- Loading.
- Empty.
- Error.
- Success.
- Stale data.
- Disconnected/unavailable.
- Warning/critical.
- Confirmation or destructive-action state when needed.

Not every component needs every state. Select states based on the actual product and task.

---

## 7. Visual evaluation

Use multiple complementary evaluators. No single heuristic or vision model should be treated as a complete judge.

### 7.1 Structural evaluator

Deterministic checks for:
- Out-of-bounds and overflow.
- Clipping and hidden content.
- Unintended overlap.
- Missing/invalid connectors and references.
- Invalid geometry and coordinate-space mistakes.
- Text bounding boxes and visible truncation where detectable.
- Missing required content and actions.
- Invalid parent-child structures.
- Duplicate elements and unintended duplicate siblings.
- Frame and viewport consistency.

### 7.2 Visual critic

Evaluate the rendered screenshot for:
- Clear focal point and visual hierarchy.
- Balance and spatial composition.
- Alignment and spacing rhythm.
- Density and scanability.
- Typography scale, contrast and readability.
- Component consistency.
- Color use and semantic state encoding.
- Intentional whitespace.
- Repetition and genericity.
- Product identity and visual distinctiveness.
- Chart and diagram legibility.
- Whether the design looks intentionally composed rather than assembled.

Visual critiques must reference regions or nodes whenever possible. Region-count heuristics may be useful as a signal but must not be treated as decisive evidence of poor design.

### 7.3 Product critic

Check:
- Can the user identify the primary task and action?
- Is the required information present and ordered correctly?
- Are the consequences of primary actions clear?
- Do labels use domain-appropriate language?
- Are system states and failures understandable?
- Is the content sufficient for the decision the user must make?
- Does the screen solve the requested workflow?
- Are the displayed metrics interpretable with units, context and freshness?
- Does the interface distinguish recommendations, facts and estimates?

### 7.4 Accessibility evaluator

Check as applicable:
- Text and non-text contrast.
- Legible text sizes and line lengths.
- Reliance on color alone to communicate state.
- Focus/selection visibility.
- Hit-target sizes and spacing.
- Error-message clarity.
- Labels and control identification.
- Keyboard/navigation expectations for the platform.
- Reduced-motion or motion concerns when relevant.

Do not claim full accessibility conformance from screenshot checks alone. Report what was and was not tested.

### 7.5 Consistency evaluator

Check:
- Design-system token adherence.
- Typography and spacing drift.
- Component/variant misuse.
- Inconsistent interaction patterns.
- Duplicated component implementations.
- Inconsistent terminology and status semantics.

### 7.6 Evidence record for every finding

Every material finding should include:

```ts
type DesignFinding = {
  id: string;
  ruleId: string;
  category: "structural" | "visual" | "product" | "accessibility" | "consistency";
  severity: "critical" | "high" | "medium" | "low" | "info";
  confidence: number;
  summary: string;
  rationale: string;
  evidence: Array<{
    type: "screenshot-region" | "node" | "geometry" | "token" | "requirement" | "test";
    revisionId: string;
    reference: string;
    details?: string;
  }>;
  affectedNodeIds: string[];
  suggestedFix?: string;
  verification: string;
  status: "open" | "fixed" | "adjudicated" | "accepted-risk";
};
```

Adapt this schema to existing types rather than creating incompatible parallel finding formats. Evidence must identify the exact revision being evaluated. Findings without adequate evidence should have reduced confidence and must not be presented as confirmed defects.

---

## 8. Causal repair engine

Repairs should fix the underlying cause with the smallest reliable change.

### Repair procedure

1. Read the finding, evidence, source node and relevant constraints.
2. Determine the likely cause.
3. Identify the smallest valid set of mutations.
4. Predict possible side effects and impacted components.
5. Validate the operation plan before mutation.
6. Apply the repair.
7. Render the updated design.
8. Re-run the specific check and relevant regression checks.
9. Confirm that the original issue is fixed and no material regressions were introduced.
10. Record the repair, result and evidence.

### Repair rules

- Prefer component- or token-level repairs when the defect is shared.
- Prefer local repairs when the defect is genuinely local.
- Do not fix overflow by hiding content unless hiding is the intended behavior.
- Do not fix contrast by making every color identical or breaking semantic state encoding.
- Do not fix spacing by flattening the hierarchy.
- Do not fix a missing graph edge by dismissing the finding; inspect the source relationship and rendered connector.
- Do not suppress a finding or weaken a threshold solely to achieve PASS.
- Do not repeatedly apply a failed repair without revisiting the diagnosis.
- If the evaluator and human evidence disagree, retain the evidence and adjudicate the disagreement explicitly.
- If the correct fix cannot be verified, keep the finding open.

### Repair history

Record:
- Finding ID and revision.
- Diagnosis.
- Mutation set.
- Why the repair should work.
- Result after rendering.
- Regression findings.
- Whether the repair was accepted, rejected or rolled back.

Use repair history to guide future suggestions, not to automatically repeat a mutation that was successful in an unrelated context.

---

## 9. Render-and-verify loop

A design is not verified merely because Figma accepted the write operations.

### Mandatory loop

1. Complete construction.
2. Render the actual Figma frame.
3. Inspect the render at the intended viewport.
4. Run structural checks.
5. Run visual, product, accessibility and consistency critiques.
6. Repair confirmed material defects.
7. Render again after the final repair.
8. Bind final scores, findings, screenshots and gate output to the new revision.
9. Verify that no post-render mutations occurred.
10. Package the evidence and report unresolved limitations.

### Freshness requirements

Evidence must include:
- Figma document/file identity.
- Frame identity.
- Viewport dimensions.
- Revision or content fingerprint.
- Render timestamp.
- Critic/evaluator version.
- Design-system version or token snapshot where available.
- Hashes of exported screenshots/artifacts where practical.

Any mutation after the last screenshot invalidates the claim that the screenshot proves the final state. Re-render before passing the gate.

### Live-data honesty

- Label mock data, demo values and placeholder telemetry clearly.
- Never imply live device discovery, resource usage, availability or runtime events without a connected source.
- Keep “visual concept validated” separate from “data integration validated.”
- Keep “Figma artifact verified” separate from “interaction implemented and tested.”

---

## 10. Evidence gate and release policy

The gate should report independent statuses, not a single misleading green badge.

Suggested dimensions:
- `structure`
- `visual`
- `product`
- `accessibility`
- `consistency`
- `evidence_freshness`
- `live_validation`
- `benchmark_regression`

Each dimension should have `PASS`, `FAIL`, `PENDING`, `NOT_APPLICABLE`, or an equivalent explicit state. The overall status must follow a documented policy.

### Example release logic

- **PASS:** All required gates pass with fresh evidence.
- **PASS WITH LIMITATIONS:** Required gates pass; explicitly accepted, non-blocking limitations remain.
- **MIXED:** Some dimensions pass while a material critique or required check remains unresolved.
- **FAIL:** A required gate fails or a critical defect is confirmed.
- **PENDING:** Required evidence or validation has not yet completed.

Rules:
- A checklist passing must not override a failed visual or product critique.
- A live check cannot be marked passed merely because a screenshot exists.
- Pending evidence must remain pending.
- Missing scores or stale revisions block PASS.
- Accepted risk requires a recorded reason, evidence, owner or adjudicator if applicable, and correction conditions.
- Retain disagreements between automated and human reviews.
- Never use a whitelist to hide a genuine regression.
- Keep thresholds stable during a benchmark run. Any threshold changes must be versioned and tested separately.

---

## 11. Benchmark and regression suite

The benchmark should measure actual design quality and generalization—not only whether the builder successfully created nodes.

### Challenge matrix

Maintain challenges across at least these categories:

1. Graph/topology.
2. Workflow or agent builder.
3. Dense comparison table.
4. Observability/monitoring.
5. Form/configuration.
6. Search and results.
7. Document/editor workspace.
8. Empty/loading/error states.
9. Multi-screen product coherence.
10. Existing-file extension with component reuse.
11. Unfamiliar domain to test generalization.
12. A deliberate generic-SaaS negative control.
13. A spatial/canvas challenge.
14. Responsive adaptation.
15. Design-system adherence under constraints.

Each challenge should have:
- Brief and constraints.
- Expected required content and states.
- Reference images or a rubric, where available.
- Structural invariants.
- Product-specific acceptance criteria.
- Expected design-system rules.
- Generated output and screenshot.
- Evaluator results and evidence.
- Repair history.
- Human adjudication for material disagreements.
- Final gate result.

### Quality dimensions

Track separately:
- Structural correctness.
- Composition and visual hierarchy.
- Typography and spacing.
- Design-system adherence.
- Task completion and interaction clarity.
- Product-specific completeness.
- Accessibility checks.
- Semantic graph/relationship correctness.
- Repair success rate.
- Regression rate.
- Design distinctiveness without unnecessary inconsistency.
- Generalization across product types.

Do not collapse all dimensions into one score without preserving the underlying results.

### Comparison methodology

- Compare baseline and candidate versions using the same briefs, viewport, data and evaluation policy.
- Prefer blind human comparison where practical.
- Include positive and negative controls.
- Report failures and disagreements rather than omitting them.
- Keep live screenshot validation distinct from offline planning tests.
- Do not optimize only for evaluator scores.
- Require improvement across multiple categories before claiming broad quality improvement.

### Minimum definition of done for a design-engine release

- No confirmed critical structural defects.
- No unexplained missing graph relationships or invalid geometry.
- Final render is fresh and revision-bound.
- Product-specific requirements are evaluated.
- No critical product or accessibility issue remains unaddressed.
- Material findings are fixed or formally adjudicated.
- Benchmark results include both wins and regressions.
- A generalization test shows the new behavior works outside the screen used to develop it.

---

## 12. Design memory and learning

Persist design knowledge in a structured, inspectable form.

### Store

- User brief and explicit constraints.
- Composition candidates and selection rationale.
- Design-system inventory and bindings.
- Final composition and task-to-layout rationale.
- Confirmed visual/product findings.
- Human adjudications.
- Successful and failed repairs.
- Before/after render references and revision IDs.
- Benchmark outcomes and regressions.
- Known limitations and accepted risks.

### Use memory to

- Avoid repeating known failure modes.
- Recommend repairs with prior evidence of success.
- Select composition strategies that worked for similar tasks.
- Preserve product-specific conventions.
- Detect recurring weak layouts and genericity.

### Do not

- Copy a previous layout without checking task fit.
- Treat an unverified suggestion as a confirmed rule.
- Treat one human preference as universal design law.
- Train the system to maximize one heuristic at the expense of other dimensions.
- Retain sensitive user or project data without appropriate controls.

Every memory item should have provenance, confidence, scope and a way to invalidate or update it.

---

## 13. EXO-specific design acceptance criteria

Use EXO as a real multi-screen challenge, not as the only target domain.

### Compute Fabric
- Graph nodes represent actual machines.
- Edges are based on real modeled relationships and anchored correctly.
- Selection state and machine inspector remain coherent.
- Workload placement is explainable.
- Health, capacity and network conditions are distinguishable.
- Stale/disconnected/attention states exist.
- Layout remains legible with more machines and more links.
- Graph-only rendering can verify connectors.
- Sample metrics are labelled if not live.

### Model Studio
- Compare models by fit and user needs, not parameter count alone.
- Show the assumptions behind memory estimates and compatibility.
- Account for runtime overhead, quantization and context requirements when supported.
- Clearly distinguish compatible, constrained, incompatible and unknown.
- Make the selected model and configuration explicit.
- Include loading/download/failure/insufficient-memory states.
- Explain recommendations instead of presenting them as unexplained facts.

### Runtime
- Metrics have units, timestamps/time range and freshness.
- Charts use coherent axes and labels.
- Critical resource pressure is visible without relying on color alone.
- Events have severity, source and timestamp.
- Actions are tied to meaningful consequences.
- Stale or missing telemetry is explicit.
- Mock telemetry is clearly labelled.
- Runtime and inference behavior must not be claimed as implemented solely because the visual screen exists.

### Cross-screen coherence
- Share design tokens and common components.
- Use consistent terminology and status semantics.
- Keep navigation and global actions coherent.
- Allow the primary content layout to differ according to task.
- Ensure selected model, workload placement and runtime state can be understood as one product journey.

---

## 14. Suggested implementation sequence

### Phase 0 — Repository mapping and baseline
1. Inspect current planner, composition, builder, design-system discovery, visual critic, finding model, repair system, evidence gate, and benchmark.
2. Map each existing implementation to the target responsibilities in Section 2.
3. Identify duplication and actual gaps before writing new modules.
4. Capture baseline challenge outputs and test results.
5. Preserve the existing evidence and known disagreements.
6. Write an implementation plan with files, interfaces, dependencies and tests.

**Exit criteria:** Everyone can identify what exists, what is missing, what will change, and how the result will be verified.

### Phase 1 — Design brief and composition hypotheses
1. Add/extend structured brief output.
2. Add at least three genuinely different low-cost composition candidates.
3. Evaluate candidates with task-specific dimensions.
4. Preserve candidate reasoning and selected direction.
5. Add tests that prevent identical layouts from winning by default.
6. Run on EXO and at least two unrelated domains.

**Exit criteria:** The agent can choose different layout grammars for different tasks and explain why.

### Phase 2 — Design-system intelligence and native construction
1. Inspect existing variables, styles, components and variants.
2. Bind semantic tokens and component properties.
3. Add layout/Auto Layout/constraint capabilities where supported.
4. Improve semantic layer names and graph node/edge construction.
5. Add geometry and relationship tests.
6. Test edits to existing files without disturbing unrelated content.

**Exit criteria:** Output is editable, coherent, and responsive where required; graph relationships survive movement and rerendering.

### Phase 3 — Critique and causal repair
1. Separate structural, visual, product, accessibility and consistency results.
2. Make every material finding evidence-backed.
3. Link findings to nodes/regions and exact revisions.
4. Add diagnosis and mutation planning.
5. Re-render after each material repair batch.
6. Run regression checks and preserve rejected repairs.
7. Keep disputed findings visible until adjudicated.

**Exit criteria:** Repairs improve the underlying design and do not make the gate pass by suppressing findings.

### Phase 4 — Evidence gate and live validation
1. Enforce revision-bound screenshot evidence.
2. Enforce freshness and invalidate evidence after mutations.
3. Keep offline planning and live visual validation separate.
4. Define explicit overall-status aggregation.
5. Test missing evidence, stale screenshots, pending live checks and contradictory critiques.
6. Ensure failures are preserved in the evidence package.

**Exit criteria:** PASS is only possible when all required checks are satisfied by fresh evidence.

### Phase 5 — Benchmark and design memory
1. Expand the challenge matrix.
2. Track dimension-level results and regressions.
3. Add positive/negative controls.
4. Add blind comparison or structured human adjudication where possible.
5. Persist successful repairs and confirmed design rules with provenance.
6. Test generalization on unfamiliar tasks.
7. Publish a report comparing baseline and candidate versions.

**Exit criteria:** The team can demonstrate that output quality improved across multiple domains without hiding failures.

### Execution policy
- Work in a branch and make changes in coherent groups.
- Run relevant tests after each phase.
- Do not make unrelated changes while fixing a core design defect.
- Do not declare a phase done based on code compilation alone.
- Do not merge until acceptance criteria and required evidence are met.
- If an acceptance criterion cannot be verified, label it pending rather than claiming completion.

---

## 15. Testing requirements

At minimum, add or preserve tests for:

### Brief/planning
- Missing or ambiguous primary task.
- Explicit user constraints.
- Different tasks produce distinct composition hypotheses.
- Candidate selection respects task fit.
- Existing-file conventions are considered.

### Geometry and layout
- `NaN`, `Infinity`, invalid dimensions.
- Parent-local versus absolute coordinate handling.
- Out-of-bounds elements and clipping.
- Text wrapping and overflow.
- Graph edges after node movement.
- Missing nodes/endpoints and duplicate edges.
- Node pile-up, edge crossings and bounds.
- Radial/force/grid layout stability.
- Whitespace and density should be judged in context rather than with a simplistic minimum/maximum rule.

### Design system
- Existing semantic token reuse.
- Missing-token fallback behavior.
- Typography and spacing consistency.
- Variant compatibility.
- No accidental semantic color inversion.
- Repairs do not introduce token drift.

### Critique/repair
- Findings have evidence and revision IDs.
- Low-confidence heuristics are not treated as confirmed defects.
- A real missing connector remains a failure.
- Repair fixes the cause and reruns relevant checks.
- Failed repairs remain visible in history.
- Human/automated disagreement remains recorded.
- Repair cannot suppress its own gate condition.

### Gate
- Missing scores block PASS.
- Stale evidence blocks PASS.
- Post-render mutations invalidate final evidence.
- Pending live checks stay pending.
- Failed required critiques prevent overall PASS.
- Accepted risk requires a documented reason.
- No whitelist bypasses a confirmed structural failure.

### Benchmark
- Stable fixture inputs.
- Repeatable evaluation policy.
- Baseline and candidate comparisons.
- Both positive and negative controls.
- All failed attempts and regressions retained.
- At least one unfamiliar-domain generalization test.

---

## 16. Performance, reliability and cost

Quality improvements must remain usable and affordable.

- Inspect the file once per design session where possible and cache a revision-bound inventory.
- Use inexpensive deterministic checks before expensive vision evaluation.
- Generate multiple candidate plans cheaply; fully render only promising candidates when feasible.
- Use targeted repairs instead of rebuilding an entire frame for a local issue.
- Batch compatible Figma operations while retaining clear failure attribution.
- Bound retry loops and require a new diagnosis after repeated repair failure.
- Cache only results whose input revision and evaluator version match.
- Separate offline benchmark cost from live rendering cost.
- Track latency, operation count, render count, repair count, failure rate and cost per accepted design.
- Fail safely on timeouts, rate limits or partial mutations.
- Preserve enough evidence to debug failures without rerunning the entire process.

Do not optimize speed by skipping final verification or weakening the release gate.

---

## 17. Required final deliverable for every substantial design task

The agent should return:

1. Link to the correct Figma file and the exact new/updated frame.
2. Summary of the chosen design direction and why it fits the task.
3. What was reused from the existing design system.
4. Important interactions and states represented.
5. What was rendered and reviewed.
6. Final per-dimension status: structure, visual, product, accessibility, consistency and evidence freshness.
7. Material findings fixed.
8. Findings still open or explicitly accepted, with reasons.
9. Whether data is live, mocked or illustrative.
10. Known limitations and what remains outside the Figma artifact.
11. Benchmark/regression results when the task is part of an engine improvement.

Do not say “production-ready” unless the required interactions, data integration, responsive behavior, accessibility checks and engineering handoff have actually been completed. Prefer precise wording such as “high-fidelity visual prototype” when that is what exists.

---

## 18. Final definition of done

A FigDes improvement is complete only when all applicable criteria are met:

- [ ] The implementation was mapped against existing code before adding parallel modules.
- [ ] The agent reasons from the task and produces meaningfully distinct composition candidates.
- [ ] The selected composition has a recorded rationale.
- [ ] Existing design-system assets are reused appropriately.
- [ ] Native Figma output is editable and semantically organized.
- [ ] Layout and graph relationships are structurally correct.
- [ ] Important product states are represented.
- [ ] The actual final revision has been rendered.
- [ ] Structural, visual, product, accessibility and consistency evaluations remain distinct.
- [ ] Material findings are evidence-backed.
- [ ] Repairs address root causes and are verified after rendering.
- [ ] The gate does not ignore pending checks, stale evidence or material failed critiques.
- [ ] The benchmark demonstrates improvement across multiple tasks and reports regressions.
- [ ] Generalization is tested outside the development example.
- [ ] The final report separates verified facts, assumptions, mock data and limitations.

**North-star principle:** FigDes should not optimize for creating the most Figma layers, achieving the highest heuristic score, or making every screen look conventionally polished. It should optimize for producing the right interface for the task—distinctive, coherent, usable, editable, structurally correct, and verified by fresh evidence.
