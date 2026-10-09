# FigDes — Design Intelligence & Visual Quality System
## Implementation Specification for the Coding Agent

**Status:** Implementation-ready specification  
**Target:** FigDes / `manish9701/FigDes`  
**Primary objective:** Close the remaining quality gap between FigDes and the design-generation workflow used by Figma MCP.

---

# 1. Executive Summary

FigDes already has a strong native execution foundation:

- Native Figma Plugin API execution
- `figdes` native builder
- Frames, text, vectors, lines, ellipses and geometry
- Auto Layout
- Components / instances
- Native editable output
- Native rendering
- Planner and screen plans
- Visual quality gates
- Native critique
- Transaction safety
- Retry-safe execution

The remaining problem is **not primarily execution**.

The current system can physically construct sophisticated Figma compositions, but its **design intelligence is still too weak**. It can produce a technically valid Figma file without reliably producing a design that feels authored, intentional, product-specific, visually distinctive and professionally refined.

The core change is:

> Transform FigDes from an AI system that knows how to use Figma into an AI design system that knows how to design, then uses Figma to construct the design.

The target workflow is:

```text
USER REQUEST
    ↓
PRODUCT / FILE DISCOVERY
    ↓
DESIGN-SYSTEM DISCOVERY
    ↓
COMPONENT + TOKEN INTELLIGENCE
    ↓
DESIGN CONTEXT
    ↓
VISUAL DIRECTION
    ↓
COMPOSITION PLAN
    ↓
SCREEN COMPILER
    ↓
NATIVE FIGMA EXECUTION
    ↓
RENDER
    ↓
VISUAL CRITIQUE
    ↓
TARGETED REPAIR
    ↓
RENDER AGAIN
    ↓
QUALITY GATE
    ↓
FINAL DESIGN
```

This document defines the systems, architecture, implementation sequence and acceptance criteria required to build that workflow.

---

# 2. Problem We Are Solving

## Current FigDes failure mode

FigDes can now create richer native compositions, but generated screens can still feel:

- generic
- assembled rather than designed
- overly dashboard-like
- overly dependent on cards and panels
- weak in visual hierarchy
- weak in spatial relationships
- inconsistent in typography
- inconsistent in density
- visually under-refined
- insufficiently product-specific
- accepted too early after the first render

The system often knows **what objects exist**, but not sufficiently:

- why an object exists
- what should dominate the screen
- what relationships matter
- how much visual weight each object deserves
- which existing component should be reused
- which design patterns belong to the product
- what should be removed
- what makes the result distinctive
- whether the final composition actually looks good

---

# 3. Benchmark: What We Need to Match

The benchmark is not:

> "Can FigDes call the Figma API?"

It already can.

The benchmark is:

> "Can FigDes reliably produce a professional, native, editable Figma design through a design-generation → render → critique → repair workflow?"

The target behavior is based on the principles exposed by Figma's current design-generation workflow:

1. Inspect context before designing.
2. Discover existing design-system assets.
3. Discover typography and styles.
4. Understand existing product patterns.
5. Plan the composition.
6. Build incrementally.
7. Produce native/editable output.
8. Render the result.
9. Visually evaluate the result.
10. Repair targeted weaknesses.
11. Re-render.
12. Only then accept the design.

Do not copy Figma's implementation. Reproduce the **capability and workflow** inside FigDes.

---

# 4. Non-Goals

Do NOT spend the next implementation cycle on:

- adding dozens of new primitive drawing APIs
- adding random visual effects
- adding gradients just to make screens look richer
- adding more generic dashboard templates
- adding more card types without composition intelligence
- blindly copying Figma MCP source code
- replacing the current native executor
- rewriting the whole application
- introducing unnecessary infrastructure
- building a huge autonomous agent framework before the design loop works

The existing native execution layer should remain the foundation.

---

# 5. Current Foundation to Preserve

The following existing systems are valuable and should not be casually rewritten:

## Native execution

`mcp-server/src/native/use-figma.ts`

`figma-plugin/src/native/script.ts`

`figma-plugin/src/native/builder.ts`

These already provide the core mechanism for native Figma construction.

## Planner

`mcp-server/src/plan/planner.ts`

The planner already has:

- execution strategy
- native/hybrid/semantic decisions
- visual directions
- composition-led goals
- spatial/topology handling

Extend this rather than replacing it.

## Quality system

`mcp-server/src/review/quality.ts`

`mcp-server/src/review/critique.ts`

`mcp-server/src/review/workflow.ts`

Keep the existing quality gate and evolve it into a stronger iterative visual-quality system.

## Runtime

`mcp-server/src/runtime/compile.ts`

Keep semantic runtime support, but do not make the semantic runtime the preferred path for composition-heavy screens.

---

# 6. Target Architecture

Build the following layers.

```text
┌───────────────────────────────────────────────┐
│                 USER REQUEST                  │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│             1. DISCOVERY ENGINE               │
│ Product / file / screens / components / fonts │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│          2. DESIGN CONTEXT ENGINE             │
│ Product rules / decisions / constraints       │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│       3. DESIGN SYSTEM INTELLIGENCE           │
│ Tokens / components / styles / variables      │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│          4. VISUAL GRAMMAR ENGINE              │
│ Patterns / composition / hierarchy / density  │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│             5. COMPOSITION PLANNER             │
│ Focal / relationships / supporting context    │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│               6. SCREEN COMPILER               │
│ Converts design intent into native build plan │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│             7. NATIVE FIGMA BUILDER            │
│ Existing figdes builder + Plugin API          │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│                 8. RENDERER                    │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│              9. VISUAL CRITIC                  │
│ Hierarchy / balance / density / genericity    │
└───────────────────────┬───────────────────────┘
                        ↓
┌───────────────────────────────────────────────┐
│             10. REPAIR PLANNER                 │
│ Small targeted modifications                  │
└───────────────────────┬───────────────────────┘
                        ↓
                  RE-RENDER
                        ↓
                  QUALITY GATE
```

---

# 7. System 1 — Design Discovery Engine

## Purpose

Before generating a screen, FigDes needs to understand the environment in which the design will live.

## Required capabilities

Create a discovery layer that can retrieve:

- current page
- relevant existing screens
- relevant frames
- component inventory
- component variants
- styles
- variables
- fonts
- existing visual patterns
- relevant assets
- design-system libraries where available
- nearby screens for contextual consistency

## Proposed API

```ts
type DesignDiscovery = {
  file: FileContext;
  page: PageContext;
  screens: ScreenSummary[];
  components: ComponentSummary[];
  variables: VariableSummary[];
  styles: StyleSummary[];
  fonts: FontSummary[];
  assets: AssetSummary[];
  patterns: PatternSummary[];
};
```

Possible functions:

```ts
discoverDesignContext()
discoverScreens()
discoverComponents()
discoverVariables()
discoverStyles()
discoverFonts()
discoverAssets()
discoverPatterns()
```

## Important rule

Discovery must be **bounded**.

Do not inspect the entire file blindly.

Use:

1. current page
2. relevant nearby frames
3. semantic search
4. limited expansion when necessary

The agent should not spend enormous execution budgets dumping the entire Figma document.

---

# 8. System 2 — Component Intelligence

## Problem

Knowing that a component exists is not enough.

FigDes needs to understand the semantic role of components.

## Component registry

Create a normalized representation:

```ts
type ComponentKnowledge = {
  nodeId: string;
  name: string;
  description?: string;

  role:
    | "navigation"
    | "input"
    | "button"
    | "status"
    | "data"
    | "container"
    | "inspector"
    | "command"
    | "content"
    | "visualization"
    | "unknown";

  variants: VariantKnowledge[];

  dimensions: {
    minWidth?: number;
    maxWidth?: number;
    height?: number;
  };

  spacing?: SpacingKnowledge;

  typography?: TypographyKnowledge;

  states?: string[];

  usageExamples?: string[];

  visualWeight?: "low" | "medium" | "high";
};
```

## Component selection

The planner should be able to ask:

```text
"What existing component is appropriate for this role?"
```

and receive ranked candidates.

Ranking should consider:

1. semantic role
2. context
3. visual similarity
4. dimensions
5. existing usage
6. product relevance
7. variants

## Rule

Prefer an existing native component over reconstructing the same UI from rectangles and text.

---

# 9. System 3 — Token & Design-System Intelligence

## Required understanding

FigDes needs semantic knowledge of:

### Color

```text
surface
surface-secondary
surface-elevated
text-primary
text-secondary
text-tertiary
border
accent
success
warning
danger
```

### Spacing

```text
4
8
12
16
24
32
48
64
```

Actual values must come from discovered product tokens where available.

### Typography

```text
display
heading
body
label
caption
technical
```

### Radius

```text
small
medium
large
```

### Effects

```text
shadow
border
opacity
```

## Critical rule

Do not blindly hardcode tokens when the file already contains equivalent native variables/styles.

Use the native source of truth whenever possible.

---

# 10. System 4 — Product Font Intelligence

Typography is one of the fastest ways to make a generated design feel generic.

The system should discover:

- primary font
- secondary font
- technical/monospace font
- available weights
- actual Figma font family
- type scale
- line-height conventions
- letter-spacing conventions

## Validation

After construction, inspect representative text nodes and verify the actual font family and weight.

Do not silently fall back to Inter unless the product actually uses Inter.

---

# 11. System 5 — Design Context Memory

Create a product-level context object.

```ts
type DesignContext = {
  productName: string;

  audience: string[];

  productDescription: string;

  designIntent: string;

  visualDirection:
    | "spatial-field"
    | "editorial-focus"
    | "technical-instrument"
    | "custom";

  typography: TypographySystem;

  tokens: TokenSystem;

  components: ComponentKnowledge[];

  patterns: PatternKnowledge[];

  existingScreens: ScreenSummary[];

  decisions: DesignDecision[];

  constraints: DesignConstraint[];

  antiPatterns: AntiPattern[];

  brandRules: BrandRule[];
};
```

## Example

For EXO:

```text
Product:
EXO

Character:
technical, calm, spatial, precise

Avoid:
generic SaaS dashboard
card wall
excessive rounded cards
unnecessary gradients
visual noise

Prefer:
spatial relationships
physical compute metaphors
clear focal objects
native geometry
instrument-like telemetry
restrained typography
light surfaces
meaningful technical detail
```

The exact values should be discovered/approved rather than blindly copied from this example.

---

# 12. System 6 — Visual Grammar Engine

This is one of the most important additions.

FigDes currently understands primitives.

It needs to understand **design patterns**.

Create a visual grammar library.

## Initial pattern set

At minimum:

```text
SpatialTopology
MonitoringInstrument
ObjectInspector
ConfigurationWorkbench
EditorialFocus
ComparisonField
RelationshipGraph
TimelineFlow
CommandSurface
DataWorkspace
CanvasWorkspace
ObjectDetail
ExplorationSurface
```

## Pattern schema

```ts
type VisualPattern = {
  id: string;
  name: string;

  purpose: string;

  suitableFor: string[];

  focalStrategy: string;

  hierarchyRules: string[];

  geometryRules: string[];

  spacingRules: string[];

  density: "sparse" | "balanced" | "dense";

  allowedComponents: string[];

  relationshipRules: string[];

  antiPatterns: string[];

  examples?: string[];
};
```

## Example

`SpatialTopology`

```text
Purpose:
Show relationships between physical devices, runtime processes,
models and workloads.

Rules:
- one dominant focal node
- supporting nodes positioned spatially
- relationships shown geometrically
- connectors should communicate meaning
- labels should support rather than define relationships
- avoid equal-sized cards
- avoid card grid
- preserve whitespace around focal object
```

This makes composition reusable without turning the system into a collection of rigid templates.

---

# 13. System 7 — Composition Planner

The planner needs to move from:

> "What UI components do I need?"

to:

> "What should the viewer understand first, second and third?"

## Composition model

```ts
type CompositionPlan = {
  visualDirection: VisualDirection;

  focal: FocalRegion;

  primaryRelationships: Relationship[];

  supportingContext: Region[];

  controls: ControlRegion[];

  polish: PolishInstruction[];

  hierarchy: HierarchyPlan;

  density: DensityPlan;

  geometry: GeometryPlan;

  negativeSpace: NegativeSpacePlan;
};
```

## Build order

The existing native composition contract should evolve toward:

```text
1. canvas-and-focal
2. primary-relationships
3. supporting-context
4. controls-and-states
5. typography
6. polish
```

## Important rule

The screen must remain understandable if secondary details are removed.

If everything has equal visual weight, the composition failed.

---

# 14. System 8 — Anti-Generic Design Evaluator

This should be a first-class quality gate.

## Detect

### Card-wall behavior

```text
many equal cards
```

### Dashboard syndrome

```text
sidebar
+
header
+
metric cards
+
chart
+
table
```

when that structure isn't justified by the task.

### Equal-weight regions

Everything has the same size/contrast.

### Excessive rounding

Every object becomes a rounded rectangle.

### Excessive borders

Every region is boxed.

### Excessive pills

Status and controls become pill-shaped without semantic reason.

### Generic spacing

Uniform gaps used regardless of semantic relationship.

### Empty panels

Large containers with little meaningful content.

### Repeated metrics

Several isolated numbers instead of meaningful visualization.

### Generic AI aesthetic

Unnecessary gradients, glow, purple accents, floating cards, etc.

## Output

```ts
type GenericityReport = {
  score: number;
  blocking: boolean;
  findings: GenericityFinding[];
  repairs: RepairInstruction[];
};
```

Example:

```text
Genericity: 72/100
BLOCKED

Findings:
- 8 equal-weight cards
- generic 3-column dashboard
- insufficient focal hierarchy
- repeated metrics
- excessive containers

Recommended:
- remove 4 cards
- promote runtime object
- convert metrics into contextual annotations
- strengthen spatial relationship
```

---

# 15. System 9 — Native Screen Compiler

The Screen Compiler translates the CompositionPlan into a native execution plan.

It should NOT directly produce arbitrary primitive spam.

## Input

```text
DesignContext
+
CompositionPlan
+
ComponentKnowledge
+
VisualPattern
```

## Output

```ts
type NativeScreenPlan = {
  nodes: NativeNodePlan[];
  relationships: RelationshipPlan[];
  components: ComponentInstancePlan[];
  text: TextPlan[];
  geometry: GeometryPlan[];
  validationTargets: ValidationTarget[];
};
```

## Compiler principles

1. Use existing native components when possible.
2. Use semantic layers.
3. Use auto-layout for structural containers.
4. Use absolute positioning only for deliberate spatial relationships.
5. Use vectors/connectors for relationships.
6. Use native geometry for focal visual structures.
7. Keep semantic names.
8. Preserve editability.
9. Avoid primitive duplication.
10. Build incrementally.

---

# 16. System 10 — Render / Critique / Repair Loop

This is mandatory.

A design should no longer be considered finished after one successful build.

## Required loop

```text
BUILD
 ↓
RENDER
 ↓
CRITIQUE
 ↓
REPAIR PLAN
 ↓
APPLY REPAIR
 ↓
RENDER
 ↓
COMPARE
 ↓
PASS / REPAIR AGAIN
```

## Critique dimensions

At minimum:

### 1. Hierarchy

- What is the first focal point?
- Is it obvious?
- Is anything competing with it?

### 2. Balance

- Is the composition visually balanced?
- Are large empty regions intentional?

### 3. Rhythm

- Are spacing relationships intentional?
- Are sections too uniform?

### 4. Density

- Too sparse?
- Too dense?
- Appropriate for the product?

### 5. Relationship clarity

- Can the user understand relationships without reading every label?

### 6. Typography

- hierarchy
- readability
- scale
- weight
- consistency

### 7. Contrast

- text
- controls
- state indicators
- surfaces

### 8. Genericity

- does it look like an AI-generated dashboard?

### 9. Product character

- does it feel specific to the product?

### 10. Authorship

- does it feel intentionally designed rather than assembled?

---

# 17. Repair Planner

The repair planner must generate **small, targeted changes**.

Bad:

```text
Regenerate entire screen.
```

Good:

```text
Repair 1:
Increase focal runtime node width by 16%.

Repair 2:
Reduce inspector visual weight.

Repair 3:
Increase technical labels from 9px to 11px.

Repair 4:
Remove three redundant grid lines.

Repair 5:
Darken secondary labels to improve contrast.

Repair 6:
Move model node 72px closer to runtime.
```

## Repair priorities

```text
P0 = broken / unusable
P1 = hierarchy / composition
P2 = readability / typography
P3 = spacing / rhythm
P4 = visual polish
```

Never spend time polishing a screen whose hierarchy is broken.

---

# 18. Visual Quality Gate

Extend the existing quality gate.

A composition-led screen should fail if:

- focal hierarchy is weak
- visual relationships are unclear
- genericity is high
- screenshot has serious readability issues
- typography is visibly inconsistent
- major visual imbalance exists
- repeated card structure dominates without justification
- the first render has obvious problems that were not repaired

## Suggested final result

```ts
type FinalQualityReport = {
  status: "PASS" | "REVIEW" | "FAIL";

  scores: {
    hierarchy: number;
    composition: number;
    typography: number;
    readability: number;
    density: number;
    distinctiveness: number;
    genericity: number;
    productFit: number;
  };

  blockingIssues: Finding[];

  repairHistory: RepairResult[];

  renderEvidence: RenderEvidence[];

  reason: string;
};
```

---

# 19. Design Iteration Budget

Do not create an infinite loop.

Recommended default:

```text
Initial build: 1
Major visual review: 1
Repair passes: 1–3
Maximum renders: 4
```

If the screen is still failing after the repair budget:

```text
FAIL / REVIEW
```

and return a useful reason.

Do not repeatedly regenerate the whole screen.

---

# 20. Discovery Budget

Discovery must also be bounded.

Suggested strategy:

```text
Phase 1:
current page + relevant context

Phase 2:
semantic component/style search

Phase 3:
expand only if confidence is low
```

Avoid dumping thousands of nodes into the model context.

Every discovery result should have a purpose.

---

# 21. Suggested Module Structure

A possible architecture:

```text
mcp-server/src/design/
│
├── discovery/
│   ├── index.ts
│   ├── screens.ts
│   ├── components.ts
│   ├── variables.ts
│   ├── styles.ts
│   ├── fonts.ts
│   └── assets.ts
│
├── context/
│   ├── design-context.ts
│   ├── product-memory.ts
│   └── decisions.ts
│
├── system/
│   ├── token-intelligence.ts
│   ├── component-intelligence.ts
│   └── typography.ts
│
├── grammar/
│   ├── registry.ts
│   ├── patterns.ts
│   ├── matcher.ts
│   └── anti-patterns.ts
│
├── composition/
│   ├── planner.ts
│   ├── hierarchy.ts
│   ├── geometry.ts
│   └── relationships.ts
│
├── compiler/
│   ├── screen-compiler.ts
│   ├── native-plan.ts
│   └── component-resolver.ts
│
└── quality/
    ├── visual-critic.ts
    ├── genericity.ts
    ├── repair-planner.ts
    ├── comparison.ts
    └── final-gate.ts
```

Do not create all files blindly. First inspect the existing repository architecture and integrate with current modules where equivalent functionality already exists.

---

# 22. Agent Implementation Order

The coding agent should implement in this order.

## Phase 0 — Audit

Before writing code:

1. Inspect repository.
2. Inspect current planner.
3. Inspect native builder.
4. Inspect discovery/context functionality already present.
5. Inspect critique/quality system.
6. Inspect rendering path.
7. Inspect runtime.
8. Identify duplicate functionality.
9. Produce a short implementation map.
10. Do not rewrite working systems.

---

# Phase 1 — Discovery

Implement:

- screen discovery
- component discovery
- variable discovery
- style discovery
- font discovery
- bounded design-context assembly

Acceptance:

```text
Given a Figma page,
FigDes can return a compact semantic description
of the relevant design environment.
```

---

# Phase 2 — Design Context

Implement:

- `DesignContext`
- product decisions
- visual direction
- anti-patterns
- typography context
- token context
- component context

Acceptance:

```text
A second screen generated for the same product
receives the same visual/product context
without rediscovering everything from scratch.
```

---

# Phase 3 — Component / Token Intelligence

Implement:

- semantic component registry
- component ranking
- token mapping
- style mapping
- font mapping

Acceptance:

```text
When an appropriate existing component exists,
FigDes can identify and use it rather than rebuilding it.
```

---

# Phase 4 — Visual Grammar

Implement the first pattern library:

1. SpatialTopology
2. MonitoringInstrument
3. ObjectInspector
4. ConfigurationWorkbench
5. EditorialFocus
6. ComparisonField
7. RelationshipGraph
8. TimelineFlow

Acceptance:

```text
The planner chooses a composition pattern based on
the user's actual design problem rather than defaulting
to a dashboard/card layout.
```

---

# Phase 5 — Composition Planner

Upgrade the existing planner.

It must output:

```text
focal
relationships
supporting context
controls
hierarchy
density
geometry
negative space
```

Acceptance:

```text
Two screens with different product goals
produce meaningfully different compositions.
```

---

# Phase 6 — Screen Compiler

Connect:

```text
DesignContext
+
VisualPattern
+
CompositionPlan
+
Components
+
Tokens
```

to the existing native builder.

Acceptance:

```text
The compiler produces editable native Figma nodes
with meaningful hierarchy and semantic structure.
```

---

# Phase 7 — Visual Critique

Extend the current critique system.

Add:

- hierarchy
- balance
- rhythm
- density
- relationship clarity
- product character
- genericity
- authorship

Acceptance:

```text
The system can explain why a visually valid screen
is still a bad design.
```

---

# Phase 8 — Repair Loop

Implement:

```text
render
→ critique
→ repair
→ render
```

Acceptance:

```text
The system can repair a generated screen
without rebuilding the entire screen.
```

---

# Phase 9 — Anti-Generic Gate

Add hard/soft thresholds.

Example:

```text
Genericity > 70 → FAIL
Hierarchy < 60 → REVIEW
Readability < 70 → FAIL
ProductFit < 60 → REVIEW
```

Thresholds should be calibrated through benchmark tests rather than treated as permanent numbers.

---

# Phase 10 — Benchmark

Create a fixed benchmark suite.

At minimum:

```text
EXO compute topology
EXO model detail
EXO runtime monitoring
EXO configuration
EXO enterprise workspace
generic SaaS dashboard
data-heavy workspace
spatial relationship interface
editorial product page
```

For each benchmark:

1. Generate with FigDes.
2. Render.
3. Critique.
4. Repair.
5. Render again.
6. Review native structure.
7. Score against the benchmark criteria.

---

# 23. Benchmark Scoring

Use a 100-point score.

```text
Visual hierarchy          15
Composition               15
Product specificity       15
Typography                10
Spacing / rhythm          10
Relationship clarity      10
Density                   10
Native/editable quality    5
Distinctiveness            5
Readability                5
────────────────────────────
Total                    100
```

Additionally track:

```text
Genericity score
Repair count
Render count
Discovery calls
Execution time
Token/context cost
```

The target is not merely a high score.

The system should show **why** it improved.

---

# 24. Definition of Done

The project is NOT done when:

- code compiles
- Figma nodes are created
- the screen looks acceptable
- the quality gate returns PASS once

It is done when:

### Design intelligence

- FigDes discovers relevant context.
- FigDes discovers design-system assets.
- FigDes understands component roles.
- FigDes understands typography.
- FigDes chooses an appropriate visual pattern.
- FigDes plans hierarchy before construction.

### Construction

- output remains native/editable
- components are reused when appropriate
- tokens are reused when appropriate
- spatial relationships are native
- semantic naming is preserved

### Visual quality

- screen has a clear focal point
- relationships are visually meaningful
- typography is coherent
- spacing has rhythm
- density is intentional
- generic dashboard patterns are avoided
- product character is apparent

### Iteration

- screenshot is generated
- visual critique is performed
- repairs are targeted
- screen is rendered again
- final quality gate considers the repaired result

---

# 25. Critical Design Principle

Never optimize for:

> "Can we make more things?"

Optimize for:

> "Can the system make better design decisions?"

The current FigDes execution layer is already capable of making sophisticated Figma objects.

The next generation must improve:

```text
DECISION QUALITY
      ↓
COMPOSITION QUALITY
      ↓
VISUAL QUALITY
      ↓
ITERATION QUALITY
```

not simply:

```text
MORE PRIMITIVES
MORE FEATURES
MORE API CALLS
```

---

# 26. Agent Operating Instructions

The coding agent receiving this document should follow these rules.

## Rule 1 — Inspect before changing

Do not assume the repository matches this document exactly.

Inspect the current implementation first.

## Rule 2 — Reuse existing systems

If a current module already solves part of the requirement, extend it.

Do not create duplicate implementations.

## Rule 3 — Preserve native execution

Do not replace the native Figma Plugin API architecture.

## Rule 4 — Small PRs

Implement in coherent stages.

Recommended:

```text
PR 1 — discovery
PR 2 — context + component/token intelligence
PR 3 — visual grammar
PR 4 — composition planner
PR 5 — screen compiler
PR 6 — visual critic
PR 7 — repair loop
PR 8 — benchmark + final quality gate
```

If repository conventions prefer fewer PRs, preserve the same logical boundaries.

## Rule 5 — Tests for every layer

Add unit tests for:

- discovery normalization
- component ranking
- token resolution
- pattern matching
- composition planning
- genericity detection
- repair planning
- quality gate

## Rule 6 — Do not trust structural tests alone

A design can pass all structural tests and still look bad.

Every composition-heavy benchmark must eventually include render-based evaluation.

## Rule 7 — Do not accept first-pass designs automatically

The default path must include a visual review.

---

# 27. Required Final Agent Report

When implementation is complete, the coding agent must report:

```text
1. What was implemented
2. Files changed
3. Existing systems reused
4. New architecture
5. Tests added
6. Tests passed
7. Benchmark screens generated
8. Before/after quality scores
9. Render/repair iterations
10. Remaining weaknesses
11. Deployment/build requirements
12. Recommended next step
```

Do not report:

> "Done, looks good."

Provide measurable evidence.

---

# 28. Final Target

The final FigDes workflow should feel like this:

```text
User:
"Design the EXO compute workspace."

FigDes:

1. Understands EXO.
2. Inspects relevant design context.
3. Discovers typography and tokens.
4. Finds existing useful components.
5. Determines the user's primary task.
6. Selects a visual grammar.
7. Creates a composition plan.
8. Identifies the focal object.
9. Defines spatial relationships.
10. Builds native Figma structure.
11. Renders it.
12. Critiques the screenshot.
13. Finds visual weaknesses.
14. Applies targeted repairs.
15. Renders again.
16. Evaluates the final result.
17. Returns a native editable design.
```

The user should not need to tell the system:

> "Don't make a card dashboard."

The system should already know.

---

# 29. Success Test

The ultimate test is simple:

Give FigDes and Figma MCP the same design brief.

Then compare:

- first-pass quality
- final-pass quality
- hierarchy
- composition
- product specificity
- typography
- visual rhythm
- relationship clarity
- genericity
- native editability
- number of repair iterations

If FigDes only wins because it creates more nodes, the implementation failed.

If FigDes can consistently produce a composition that looks **intentionally designed**, survives visual critique, and remains fully editable in Figma, the implementation succeeded.

---

# 30. Guiding Principle

> **Figma execution is no longer our bottleneck. Design intelligence is.**

Build the intelligence layer first.

Then let the existing native Figma execution system do what it is already good at:

**turn good design decisions into real editable Figma objects.**
