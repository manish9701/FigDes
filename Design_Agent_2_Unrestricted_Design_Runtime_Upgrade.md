# Design Agent 2 — Unrestricted Design Runtime & Visual Authoring Upgrade

## Purpose

This document proposes a redesigned architecture for **Design Agent 2** so it can move from a constrained “structured Figma editor” into a **high-fidelity autonomous design system**.

The goal is not simply to add more low-level Figma operations.

The goal is to make Design Agent 2 capable of:

- designing sophisticated layouts instead of only assembling rectangles and text
- creating custom geometry and visual systems
- understanding an existing design language before editing
- iterating visually instead of guessing from node structure
- building reusable components, variables, styles, and responsive systems
- making large changes safely through transactions and diffs
- validating designs through screenshots/rendered previews
- preserving semantic editability
- exposing an escape hatch for advanced design operations
- learning from the existing document rather than recreating generic SaaS UI
- operating at a higher abstraction level than one-node-at-a-time editing

The target is a tool that can compete with or exceed a Figma-MCP-style workflow while retaining the safety and determinism of Design Agent 2.

---

# 1. Current Problem

Design Agent 2 is currently too constrained because the authoring interface is mostly a finite set of structured operations such as:

- createFrame
- createRectangle
- createEllipse
- createText
- setPosition
- setSize
- setFill
- setStroke
- setTypography
- setAutoLayout

These operations are useful for deterministic manipulation, but they encourage the model to think like this:

> “Create a rectangle here, create text there, add another rectangle...”

instead of:

> “Build a coherent visual composition with a strong hierarchy, computational topology, semantic relationships, and intentional rhythm.”

That difference is fundamental.

A high-quality design tool needs to operate at multiple abstraction levels.

---

# 2. Design Agent 2 Should Become a Two-Layer System

## Layer A — Design Intelligence

This is the reasoning layer.

It should understand:

- hierarchy
- visual rhythm
- density
- alignment
- spatial relationships
- information architecture
- component reuse
- responsive behavior
- interaction intent
- brand language
- visual balance
- semantic meaning
- current document conventions

The agent should make decisions about **what should exist**.

## Layer B — Design Runtime

This is the execution layer.

It should have much broader capabilities than the current structured schema.

It should be able to:

- create any supported Figma node
- create vector geometry
- create components
- create instances
- create variables
- create styles
- create auto-layout structures
- create masks
- create groups
- create sections
- create text
- create custom icons
- create effects
- create gradients
- create images
- manipulate existing nodes
- run layout algorithms
- calculate geometry
- generate repeated structures
- export visual previews
- perform reversible transactions

The model should reason at a high level while the runtime handles complex implementation.

---

# 3. The Biggest Change: Add a Design Runtime Escape Hatch

The most important architectural improvement is an **Advanced Design Runtime**.

Instead of forcing every action through a tiny allowlist such as:

```text
createRectangle
createText
setFill
setPosition
setSize
```

add a controlled execution environment that accepts a higher-level design program.

For example:

```ts
design_runtime.execute({
  target: "59:338",
  program: `
    const hero = frame({
      name: "Hero",
      width: 1440,
      height: 900
    });

    const topology = topologyMap({
      nodes: [...],
      links: [...],
      center: { x: 720, y: 420 }
    });

    hero.append(topology);
  `
});
```

The runtime should execute inside the Figma plugin context.

The agent is no longer limited to expressing every design as hundreds of primitive operations.

---

# 4. Do Not Give the Model Raw Infinite Figma Access

The escape hatch should still be safe.

A better architecture is:

```text
LLM
  ↓
Design Intent
  ↓
Design Runtime
  ↓
Sandboxed Plugin Execution
  ↓
Figma Document
```

The runtime should expose a controlled but expressive API.

For example:

```ts
runtime.frame()
runtime.text()
runtime.vector()
runtime.component()
runtime.instance()
runtime.image()
runtime.group()
runtime.section()
runtime.autoLayout()
runtime.grid()
runtime.stack()
runtime.flow()
runtime.connector()
runtime.path()
runtime.chart()
runtime.diagram()
runtime.canvas()
```

This is much more powerful than exposing only primitive rectangles.

---

# 5. Use a High-Level Design DSL

Design Agent 2 should have its own design language.

Call it:

**EXO Design Runtime DSL**

or more generically:

**Design Runtime DSL (DR-DSL)**

The model can produce a declarative design description instead of manipulating every node manually.

Example:

```ts
screen({
  name: "EXO Home",
  size: [1440, 900],

  navigation: {
    width: 208,
    style: "minimal"
  },

  content: {
    layout: "editorial",

    header: {
      eyebrow: "YOUR AI COMPUTER",
      title: "Your hardware is ready.",
      description:
        "EXO discovered 3 machines and built a unified compute system."
    },

    primary: topology({
      variant: "network",
      emphasis: "system"
    }),

    secondary: [
      readinessPanel(),
      modelRecommendation()
    ]
  }
});
```

The runtime converts this into native Figma nodes.

This gives the model a semantic language for design.

---

# 6. Add Semantic Components

Instead of rebuilding a panel from rectangles each time, the agent should have semantic primitives.

Examples:

```ts
topologyMap()
deviceNode()
networkLink()
modelCard()
modelTable()
fitAnalysis()
memoryBudget()
deploymentGraph()
telemetryChart()
providerPanel()
statusRail()
commandBar()
inspector()
metric()
timeline()
```

These should produce editable Figma structures.

For example:

```ts
topologyMap({
  nodes: [
    {
      id: "m1",
      label: "Mac Studio",
      memory: "192 GB",
      compute: "M2 Ultra"
    },
    {
      id: "m2",
      label: "Mac Studio",
      memory: "192 GB",
      compute: "M2 Ultra"
    }
  ],

  links: [
    {
      from: "m1",
      to: "m2",
      latency: "8 μs"
    }
  ]
});
```

This would be dramatically better for EXO because the visual object is the **system relationship**, not a collection of generic cards.

---

# 7. Add a Visual Evaluation Loop

This is one of the most important missing capabilities.

The workflow should become:

```text
Inspect
   ↓
Plan
   ↓
Generate
   ↓
Render
   ↓
Evaluate
   ↓
Refine
   ↓
Render again
```

Current workflows often stop at:

```text
Inspect → Generate
```

That is not enough for visual design.

---

# 8. Add Native Screenshot / Render Support

Design Agent 2 needs a tool such as:

```text
render_design
```

Input:

```json
{
  "nodeId": "59:338",
  "scale": 2,
  "format": "png",
  "background": true
}
```

Output:

```text
Rendered visual preview
```

The agent should be able to see the rendered screen.

This enables actual visual reasoning:

- Is the main object too small?
- Is the whitespace balanced?
- Does the hierarchy work?
- Are panels too repetitive?
- Is the navigation visually dominant?
- Are elements aligned?
- Does the page feel like a design tool or a generic SaaS dashboard?
- Is the main relationship obvious?

This is far more valuable than simply inspecting node metadata.

---

# 9. Add Visual Critique as a First-Class Operation

Add:

```text
evaluate_visual
```

It should analyze a rendered frame against both general principles and project-specific rules.

Example result:

```json
{
  "hierarchy": 82,
  "balance": 71,
  "density": 64,
  "alignment": 91,
  "consistency": 87,
  "distinctiveness": 54,
  "repetition": 38,
  "issues": [
    {
      "severity": "high",
      "type": "composition",
      "message":
        "The primary topology visualization occupies too little visual area."
    },
    {
      "severity": "medium",
      "type": "repetition",
      "message":
        "Three secondary panels use the same card geometry."
    }
  ]
}
```

The agent should then automatically refine the design.

---

# 10. Separate Structural QA From Visual QA

There are two completely different validation systems.

## Structural QA

Checks:

- overflow
- missing fonts
- invalid nodes
- incorrect references
- duplicate IDs
- broken constraints
- bad auto-layout
- invalid components
- missing variables
- naming issues

## Visual QA

Checks:

- hierarchy
- balance
- density
- rhythm
- alignment
- contrast
- repetition
- visual focus
- empty space
- composition
- semantic clarity

Both are needed.

A design can pass every structural check and still look terrible.

---

# 11. Add Design-System Extraction

Before creating a new screen, Design Agent 2 should be able to inspect the existing document and build a **Design System Snapshot**.

Example:

```json
{
  "colors": {
    "background": "#F7F5EF",
    "surface": "#FFFDF9",
    "text": "#242521",
    "muted": "#6F716A",
    "accent": "#F2C94C",
    "success": "#2D7A4D"
  },

  "spacing": {
    "base": 4,
    "common": [8, 12, 16, 24, 32, 48, 64]
  },

  "radii": [5, 8, 12, 14],

  "type": {
    "sans": "Inter",
    "mono": "JetBrains Mono"
  },

  "patterns": [
    "navigation",
    "status-row",
    "data-table",
    "inspector",
    "dark-status-rail"
  ]
}
```

But this should go further.

It should identify:

```text
composition patterns
density patterns
visual hierarchy
preferred widths
common layout ratios
button hierarchy
title scales
panel relationships
information grouping
```

---

# 12. Extract the Existing Visual Grammar

A good agent should not merely copy colors.

It should understand:

### Geometry grammar

Examples:

- wide horizontal compositions
- restrained cards
- strong horizontal rules
- low-radius surfaces
- large empty areas
- technical mono labels

### Typography grammar

Examples:

- large editorial headlines
- compact metadata
- mono technical values
- sparse labels

### Spatial grammar

Examples:

- left navigation
- large primary visualization
- secondary analytical region
- clear alignment columns

### Behavioral grammar

Examples:

- selected states
- status indicators
- progressive disclosure
- contextual inspectors

This should become a reusable **Project Design Grammar**.

---

# 13. Add a Design Context Object

Every new screen should receive:

```ts
DesignContext
```

Example:

```ts
{
  project: "EXO Labs",

  brand: {
    principles: [
      "external",
      "connected",
      "cognitive"
    ]
  },

  visualLanguage: {
    density: "medium-low",
    tone: "technical editorial",
    geometry: "restrained",
    surfaces: "minimal"
  },

  constraints: {
    noGenericSaaSCards: true,
    noManualDevicePairing: true,
    noChatAsPrimaryUI: true
  },

  productModel: {
    primaryFlow: [
      "discover",
      "topology",
      "fit",
      "download",
      "deploy",
      "measure",
      "integrate"
    ]
  }
}
```

This stops the agent from producing generic UI.

---

# 14. Add Design Goals

Every screen should have one primary question.

Examples:

### Home

> Is my AI computer ready?

### Compute

> What hardware is EXO seeing?

### Models

> What can I run?

### Model Detail

> Can I run this?

### Download

> How do I get this model onto the cluster?

### Deployment

> Where is EXO putting it?

### Performance

> Is it performing well?

### Integrations

> How do I use this compute elsewhere?

Design Agent 2 should optimize the layout around that question.

This is more useful than treating every screen as a dashboard.

---

# 15. Add Composition Modes

Design Agent 2 should not default to a card grid.

Provide explicit composition strategies:

```ts
composition({
  mode: "editorial"
});

composition({
  mode: "instrument"
});

composition({
  mode: "canvas"
});

composition({
  mode: "topology"
});

composition({
  mode: "table"
});

composition({
  mode: "timeline"
});

composition({
  mode: "split-view"
});

composition({
  mode: "spatial"
});
```

The agent chooses the appropriate mode based on the information.

For EXO:

```text
Home → spatial / instrument
Compute → topology
Models → table
Model detail → analytical split
Download → process / progress
Deployment → topology + status
Performance → analytical
Integrations → configuration
```

This directly addresses repetitive layouts.

---

# 16. Add Custom Geometry Generation

Design Agent 2 should support:

- vector paths
- curves
- line segments
- polygons
- rings
- arcs
- connectors
- arrowheads
- bezier paths
- custom icons
- geometric backgrounds
- graphs
- node-link diagrams

Example:

```ts
vectorPath({
  path: "M 0 40 C 40 0 80 80 120 40",
  stroke: "#242521",
  strokeWidth: 1.5
});
```

Or:

```ts
connector({
  from: nodeA,
  to: nodeB,
  routing: "orthogonal",
  label: "8 μs"
});
```

This is especially important for:

- topology maps
- network diagrams
- performance graphs
- system architecture
- brand graphics

---

# 17. Add Layout Algorithms

Do not require the LLM to calculate every coordinate.

The runtime should include algorithms.

Examples:

```ts
layout.grid()
layout.stack()
layout.pack()
layout.distribute()
layout.radial()
layout.tree()
layout.forceGraph()
layout.masonry()
layout.timeline()
layout.cluster()
```

Example:

```ts
forceGraph({
  nodes,
  links,
  center: [600, 400],
  radius: 280
});
```

The runtime computes the geometry.

This reduces model errors and makes output more sophisticated.

---

# 18. Add Constraint-Based Layout

The agent should be able to express relationships like:

```ts
constraint("hero", {
  alignTo: "content",
  top: 96,
  width: "fill"
});
```

or:

```ts
constraint("inspector", {
  rightOf: "topology",
  gap: 24,
  width: 320
});
```

The runtime should then solve the layout.

This is better than manually setting hundreds of coordinates.

---

# 19. Add Responsive Breakpoints

The runtime should understand:

```ts
responsive({
  desktop: 1440,
  laptop: 1200,
  tablet: 768,
  mobile: 390
});
```

Components can define behavior:

```ts
navigation({
  desktop: "expanded",
  tablet: "compact",
  mobile: "collapsed"
});
```

Even when the Figma file is primarily desktop-based, the design system should still understand responsive behavior.

---

# 20. Add Reusable Design Functions

The runtime should support design functions:

```ts
const Section = ({ title, children }) => {
  ...
};

const Metric = ({ label, value, state }) => {
  ...
};

const DeviceNode = ({ device }) => {
  ...
};
```

Then a screen can be built from semantic code.

This enables:

- consistency
- rapid iteration
- reusable patterns
- less duplication
- easier global changes

---

# 21. Add Component Awareness

Before creating a node, the agent should ask:

```text
Does this component already exist?
```

Search:

```text
find_component("StatusRow")
find_component("ButtonPrimary")
find_component("InspectorPanel")
find_component("DeviceNode")
```

If found:

```text
create_instance(...)
```

Instead of:

```text
create_frame(...)
create_text(...)
create_rectangle(...)
```

This keeps the design system coherent.

---

# 22. Add Variables and Styles

The current file has many hardcoded values.

The runtime should create and use:

```text
Color variables
Number variables
String variables
Boolean variables
Typography styles
Effect styles
Grid styles
```

Example:

```ts
vars.color("surface", "#FFFDF9");
vars.color("text", "#242521");
vars.color("success", "#2D7A4D");

vars.number("space-md", 24);
vars.number("radius-md", 12);
```

Then:

```ts
panel.fill = variable("surface");
panel.cornerRadius = variable("radius-md");
```

This makes global refinement possible.

---

# 23. Add Safe Transactions

Large design operations should be atomic.

Example:

```ts
transaction({
  name: "Redesign EXO Home",
  operations: [...]
});
```

Execution:

```text
validate
→ preview
→ apply
→ render
→ evaluate
→ commit
```

If something fails:

```text
rollback
```

The agent should never leave the Figma file half-modified.

---

# 24. Add Dry Run + Diff

Before changing the file:

```ts
design.diff({
  target: "59:338",
  proposal: ...
});
```

Return:

```text
+ 24 nodes
~ 17 nodes
- 8 nodes

Visual impact:
Large

Risk:
Low
```

Then:

```ts
design.commit(...)
```

This is much safer than blindly creating another frame.

---

# 25. Add Semantic Diffs

A raw node diff is not enough.

The agent should say:

```text
Changed:
- hero visualization enlarged 42%
- navigation reduced 16px
- secondary cards replaced with analytical rail
- title scale increased
- topology visualization moved to primary focus
```

This is useful to both the model and the designer.

---

# 26. Add Versioned Design States

Create checkpoints:

```text
EXO Home
  ├── v1 Original
  ├── v2 Experimental
  ├── v3 Current
  └── v4 Proposed
```

The agent should be able to:

```text
compare(v1, v4)
restore(v2)
fork(v1)
merge(v4)
```

This makes visual experimentation much safer.

---

# 27. Add a Visual Memory System

Design Agent 2 should remember successful patterns.

For example:

```text
Project memory:

EXO / topology screens
- large spatial diagrams perform better
- avoid repeated 3-card metric layout
- selected node uses dark inspector
- mono labels work well for technical metadata
- whitespace should remain high
```

This is not generic conversation memory.

It is **design memory**.

---

# 28. Add a "Do Not Drift" Layer

A recurring problem with generative UI is design drift.

Create:

```text
DesignGuard
```

It checks:

- color drift
- typography drift
- spacing drift
- radius drift
- component duplication
- inconsistent controls
- excessive card usage
- accidental SaaS-dashboard patterns
- excessive shadows
- excessive visual noise

For EXO:

```text
FAIL:
Too many metric cards

FAIL:
Manual device connection UI

FAIL:
Chat used as primary navigation

WARNING:
Panel density increasing

PASS:
Topology remains primary visual object
```

---

# 29. Add Semantic Product Constraints

The design agent should understand product truth.

For EXO:

```text
RULE:
Devices auto-discover each other.

Therefore:
Do not create a "connect device" wizard.

RULE:
EXO reads network topology automatically.

Therefore:
Display network state rather than asking the user to choose Wi-Fi/TB5.

RULE:
EXO automatically places model shards.

Therefore:
Show recommended placement, not manual shard dragging as the default.

RULE:
EXO exposes standard APIs.

Therefore:
Integrations should expose provider / endpoint / model profile concepts.
```

This prevents visual designs from contradicting the product.

---

# 30. Create a Screen-Level Planning Tool

Add:

```text
plan_screen
```

Input:

```text
Goal:
"What can I run?"

Audience:
Developer

Primary decision:
Select a model

Available information:
Models, memory, fit, speed, architecture

Existing patterns:
Model table, status, action

Desired composition:
Dense analytical table
```

Output:

```text
1. Header
2. Search / filters
3. Model list
4. Fit state
5. Runtime estimate
6. Primary action
7. Optional detail inspector
```

Only then should the runtime generate the Figma nodes.

This prevents immediate low-level drawing.

---

# 31. Create a Composition Planner

Before drawing, generate a 2D composition model.

Example:

```json
{
  "canvas": [1440, 1000],

  "regions": [
    {
      "name": "navigation",
      "x": 0,
      "y": 0,
      "w": 208,
      "h": 1000
    },

    {
      "name": "hero",
      "x": 256,
      "y": 96,
      "w": 1100,
      "h": 520
    },

    {
      "name": "secondary",
      "x": 256,
      "y": 664,
      "w": 1100,
      "h": 240
    }
  ]
}
```

The visual renderer then builds details inside these regions.

This separates:

```text
Composition
```

from:

```text
Implementation
```

That separation is essential.

---

# 32. Use a Multi-Pass Generation Strategy

Do not generate every detail at once.

Use:

## Pass 1 — Composition

Only:

- navigation
- headline
- primary visual
- major regions

## Pass 2 — Information

Add:

- content
- labels
- controls
- metrics

## Pass 3 — Visual refinement

Tune:

- spacing
- scale
- alignment
- typography
- density

## Pass 4 — Interaction states

Add:

- hover
- selected
- loading
- disabled
- error
- success

## Pass 5 — QA

Check:

- structure
- visual quality
- consistency
- product truth

This dramatically reduces bad one-pass designs.

---

# 33. Add an "Explore Three Directions" Mode

Instead of producing one layout immediately:

```text
design.explore({
  variants: 3,
  strategy: "composition"
});
```

Generate:

### Direction A
Editorial

### Direction B
Instrument

### Direction C
Spatial

Then evaluate them.

This is much closer to how a senior designer explores a problem.

The system should choose one direction only after comparison.

---

# 34. Add Pairwise Visual Comparison

Provide:

```text
compare_visual(A, B)
```

Return:

```text
A:
- stronger hierarchy
- less density
- weaker data scanning

B:
- stronger data scanning
- more technical
- slightly more crowded

Recommended:
B for developer workflow
```

This gives the agent actual design judgement rather than simply generating more UI.

---

# 35. Add Image-Based Inputs

The agent should be able to ingest:

- screenshots
- reference designs
- sketches
- whiteboards
- moodboards

Pipeline:

```text
Image
 ↓
Visual analysis
 ↓
Layout extraction
 ↓
Design grammar
 ↓
Editable Figma structure
```

This is useful for:

- reference analysis
- reverse engineering
- visual consistency
- redesigns

---

# 36. Add a Real Render → Critique → Edit Loop

The complete loop should look like:

```text
USER GOAL
    ↓
DESIGN CONTEXT
    ↓
SCREEN PLAN
    ↓
COMPOSITION PLAN
    ↓
GENERATE
    ↓
RENDER PNG
    ↓
VISION EVALUATION
    ↓
STRUCTURAL EVALUATION
    ↓
DESIGN GUARD
    ↓
TARGETED EDIT
    ↓
RENDER AGAIN
    ↓
FINALIZE
```

The agent should continue iterating until the design passes thresholds.

Example:

```text
Hierarchy ≥ 85
Balance ≥ 80
Consistency ≥ 90
Product accuracy = PASS
DesignGuard = PASS
Structural QA = PASS
```

---

# 37. Add a Maximum Iteration Budget

Do not allow infinite loops.

Example:

```ts
iterationBudget = {
  maxIterations: 5,
  minimumImprovement: 3
};
```

Stop when:

```text
score improvement < 3
```

This makes autonomous refinement practical.

---

# 38. Add Human Checkpoints

The system should pause when:

- a major composition choice is uncertain
- a destructive change is proposed
- a design-system decision is being changed globally
- more than N components would be modified
- a brand direction is uncertain

Example:

```text
Three viable compositions found.

A — editorial
B — instrument
C — spatial

Recommended:
C

Reason:
Best communicates distributed compute.

[Apply C]
[Explore another direction]
```

---

# 39. New Tool Set

A stronger Design Agent 2 should expose roughly this capability set.

## Inspection

```text
inspect_file
inspect_selection
inspect_design_system
inspect_components
inspect_variables
inspect_constraints
inspect_semantics
collect_metrics
```

## Planning

```text
plan_screen
plan_composition
extract_design_grammar
create_design_context
```

## Authoring

```text
create_design
modify_design
design_runtime_execute
create_component
create_instance
create_variable
create_style
create_vector
create_layout
```

## Visual

```text
render_design
evaluate_visual
compare_visual
generate_variants
```

## QA

```text
audit_design
review_design
design_guard
validate_product_truth
```

## Versioning

```text
create_checkpoint
restore_checkpoint
diff_design
rollback_design
```

---

# 40. Recommended Runtime Architecture

```text
                    ┌─────────────────────┐
                    │       LLM           │
                    │ Design Reasoning    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Design Planner     │
                    │ goal / IA / layout  │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │   Design DSL / IR    │
                    │ semantic structures │
                    └──────────┬──────────┘
                               │
                ┌──────────────┴──────────────┐
                ▼                             ▼
     ┌───────────────────┐         ┌───────────────────┐
     │ Layout Engine     │         │ Component Engine  │
     │ grids / graphs    │         │ styles / vars     │
     └─────────┬─────────┘         └─────────┬─────────┘
               └──────────────┬──────────────┘
                              ▼
                    ┌─────────────────────┐
                    │  Design Runtime     │
                    │ Figma Plugin API    │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │     Figma File      │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │  Render / Preview   │
                    └──────────┬──────────┘
                               │
                               ▼
                    ┌─────────────────────┐
                    │ Visual Evaluator    │
                    └──────────┬──────────┘
                               │
                               └───────→ refine
```

---

# 41. Internal Representation: Design IR

The most important engineering abstraction should be a **Design Intermediate Representation**.

Example:

```ts
type DesignIR = {
  canvas: Canvas;
  regions: Region[];
  components: ComponentRef[];
  primitives: Primitive[];
  constraints: Constraint[];
  semantics: SemanticNode[];
  tokens: TokenMap;
  behavior: BehaviorSpec[];
};
```

The LLM generates the IR.

The runtime renders the IR.

This means the model does not need to know every Figma API detail.

---

# 42. Example Design IR

```ts
{
  screen: {
    name: "EXO Home",
    size: [1440, 1000]
  },

  composition: {
    mode: "spatial"
  },

  regions: [
    {
      id: "nav",
      type: "navigation",
      width: 208
    },

    {
      id: "hero",
      type: "system-visualization",
      emphasis: "primary"
    },

    {
      id: "secondary",
      type: "analytical"
    }
  ],

  semantics: [
    {
      type: "cluster",
      nodes: ["m1", "m2", "m3"]
    },

    {
      type: "model",
      id: "qwen3-235b",
      status: "recommended"
    }
  ]
}
```

---

# 43. Why This Is Better Than Primitive Operations

Primitive operations force:

```text
Model
 ↓
Rectangle
 ↓
Text
 ↓
Rectangle
 ↓
Rectangle
 ↓
Text
```

A semantic runtime allows:

```text
Model
 ↓
EXO home composition
 ↓
System visualization
 ↓
Topology renderer
 ↓
Native Figma nodes
```

That is a much more powerful abstraction.

---

# 44. Performance Strategy

Large designs can easily create thousands of nodes.

Therefore:

### Batch operations

Use a single transaction.

### Cache components

Do not recreate reusable components.

### Diff before update

Only mutate changed regions.

### Lazy render

Do not rebuild untouched screens.

### Separate semantic and visual layers

Store the design model separately from implementation nodes.

---

# 45. Safety Strategy

The unrestricted runtime must still be bounded.

## Allowed

- create/edit Figma nodes
- change styles
- create components
- create vectors
- manipulate the current document

## Blocked by default

- arbitrary filesystem access
- arbitrary network requests
- secrets
- authentication tokens
- external code execution
- unknown plugin installation
- destructive operations without confirmation

The goal is:

**unrestricted design capability, not unrestricted computer access.**

---

# 46. Suggested Implementation Phases

## Phase 1 — Runtime Escape Hatch

Build:

```text
design_runtime_execute()
```

with:

- frames
- text
- rectangles
- ellipses
- vectors
- components
- instances
- styles
- variables
- auto-layout

This removes the immediate low-level restriction.

---

## Phase 2 — Rendering

Build:

```text
render_design()
```

Return:

- PNG
- dimensions
- node ID
- render metadata

Then provide the image back to the model.

---

## Phase 3 — Design IR

Implement:

```text
DesignIR
```

and a compiler:

```text
DesignIR → Figma
```

---

## Phase 4 — Layout Engine

Add:

- grid
- stack
- graph
- force layout
- radial layout
- timeline
- responsive constraints

---

## Phase 5 — Visual Evaluator

Add:

```text
evaluate_visual()
compare_visual()
```

---

## Phase 6 — Design Memory

Add:

```text
DesignGrammar
DesignContext
DesignGuard
```

---

## Phase 7 — Autonomous Refinement

Enable:

```text
plan
→ generate
→ render
→ evaluate
→ refine
→ validate
```

---

# 47. Priority Order

Do not build everything at once.

The highest-value changes are:

### Priority 1

**Runtime escape hatch**

Without this, the system remains constrained.

### Priority 2

**Render + screenshot feedback**

Without visual feedback, the agent is still designing blind.

### Priority 3

**Design IR**

Without a semantic intermediate layer, authoring becomes a giant list of primitives.

### Priority 4

**Composition planner**

This prevents generic dashboard layouts.

### Priority 5

**Design-system extraction**

This preserves project consistency.

### Priority 6

**Visual evaluator**

This creates autonomous refinement.

### Priority 7

**Versioning / diff**

This makes experimentation safe.

---

# 48. What Should NOT Be Done

Do not solve this by simply adding 100 more primitive commands.

For example, adding:

```text
createPolygon
createLine
createArc
createMask
createGroup
...
```

helps, but it does not solve the core problem.

The system would still think at the wrong abstraction level.

The real progression should be:

```text
Primitive API
      ↓
High-Level Design API
      ↓
Design DSL
      ↓
Design IR
      ↓
Visual Refinement Loop
```

---

# 49. The Core Philosophy

Design Agent 2 should stop behaving like:

> “An AI that can edit Figma nodes.”

It should behave like:

> “A design compiler and visual reasoning system that happens to render into Figma.”

That distinction is the key architectural change.

---

# 50. Ideal End State

The best workflow should look like this:

```text
User:
"Redesign the EXO compute screen."

↓

Agent:
Understands EXO product model.

↓

Agent:
Reads existing EXO design grammar.

↓

Agent:
Studies similar existing screens.

↓

Agent:
Creates 3 composition concepts.

↓

Agent:
Chooses topology-first spatial direction.

↓

Agent:
Builds a semantic Design IR.

↓

Runtime:
Generates native Figma structure.

↓

Runtime:
Renders the screen.

↓

Vision evaluator:
Finds weak hierarchy.

↓

Agent:
Expands topology area,
reduces card repetition,
strengthens selected-node inspector.

↓

Runtime:
Applies a targeted diff.

↓

Render again.

↓

DesignGuard:
Checks consistency.

↓

ProductTruth:
Checks that EXO automatically discovers devices
and automatically places shards.

↓

Final:
Editable, componentized, tokenized,
visually coherent Figma design.
```

---

# 51. EXO-Specific Validation Rules

Because EXO is the current design project, the runtime should include a temporary project rule set.

## Product rules

```text
Device discovery is automatic.
Network topology is detected automatically.
Model placement is automatic.
Model shards are distributed by EXO.
EXO exposes standard developer APIs.
The product is a compute operating layer, not a generic chatbot.
```

## Visual rules

```text
Avoid generic SaaS dashboard composition.
Avoid repeating three-card metric layouts.
Avoid excessive rounded cards.
Do not make chat the primary interaction.
Do not create manual device-pairing UI.
Prefer computational/system visualizations.
Use whitespace intentionally.
Use technical typography for machine data.
Use topology and relationships as visual material.
```

## Design objective

The UI should feel like:

```text
instrument
+
operating system
+
compute system
```

not:

```text
generic analytics SaaS
```

---

# 52. Final Recommendation

The current Design Agent 2 limitation should not be solved by fighting the existing operation schema.

Instead, add a second execution layer:

```text
Structured Operations
        +
Design Runtime
```

Structured operations remain useful for:

- safe small edits
- predictable changes
- inspection
- simple transformations

The runtime handles:

- sophisticated compositions
- custom geometry
- components
- layout algorithms
- semantic design
- autonomous visual iteration

The resulting architecture becomes:

```text
                    Design Agent 2

        ┌───────────────────────────────────┐
        │        Design Intelligence        │
        │                                   │
        │  product reasoning                 │
        │  composition                      │
        │  design grammar                   │
        │  visual judgement                 │
        └────────────────┬──────────────────┘
                         │
                         ▼
        ┌───────────────────────────────────┐
        │          Design IR / DSL          │
        └────────────────┬──────────────────┘
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
      Structured API          Design Runtime
              │                     │
              └──────────┬──────────┘
                         ▼
                   Figma Plugin
                         │
                         ▼
                   Render Preview
                         │
                         ▼
                Visual Evaluation
                         │
                         └──────→ Refine
```

That is the architecture that would make Design Agent 2 substantially more capable than a simple Figma-node manipulation layer.

The objective is not “more commands.”

The objective is **higher-level design reasoning + unrestricted visual execution + continuous visual feedback**.
