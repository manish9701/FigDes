# FigDes — Design Engine Upgrade Specification
## From a UI Construction Tool to a High-Fidelity Design Agent

**Repository:** `manish9701/FigDes`  
**Primary goal:** Make FigDes capable of producing the level of visual quality, composition, detail, iteration, and native Figma fidelity expected from a strong human designer / Figma MCP workflow.

---

# 1. Executive Summary

FigDes is already a strong foundation.

The current repository has several sophisticated systems:

- a custom MCP server
- a native Figma plugin bridge
- a declarative Design IR
- semantic runtime primitives
- layout algorithms
- relationship constraints
- connectors and topology generation
- design-system extraction
- component discovery
- rendering
- structural review
- score/refine workflows
- project memory
- design guards
- transactional writes and rollback
- testing around the runtime and plugin

The central problem is **not that FigDes lacks engineering**.

The problem is that its architecture currently optimizes for:

> **Reliable construction of UI**

while the desired output requires:

> **High-quality visual design generation + exploration + visual judgement + iterative refinement**

The current engine is therefore capable of creating a technically valid screen while still producing a screen that feels:

- generic
- overly dashboard-like
- repetitive
- card-heavy
- visually flat
- weakly art-directed
- insufficiently composed
- insufficiently detailed
- less premium than a strong Figma MCP workflow

The upgrade should preserve the existing safe/runtime architecture while introducing a new layer between product intent and geometry:

```text
Product Intent
      ↓
Art Direction
      ↓
Visual Composition
      ↓
Composition Variants
      ↓
Design IR
      ↓
Layout / Constraints
      ↓
Native Figma Components
      ↓
Render
      ↓
Visual Critic
      ↓
Revision
      ↺
```

This document defines that upgrade.

---

# 2. Core Diagnosis

## 2.1 FigDes currently behaves like a UI compiler

The current pipeline is approximately:

```text
LLM
 ↓
semantic runtime program
 ↓
Design IR
 ↓
layout algorithms
 ↓
compiler
 ↓
Figma operations
```

This is excellent for deterministic generation.

But a strong design workflow is closer to:

```text
Intent
 ↓
visual interpretation
 ↓
composition exploration
 ↓
prototype
 ↓
render
 ↓
visual judgement
 ↓
revision
 ↓
render
 ↓
final selection
```

The missing concept is **design judgement as a first-class system**.

---

# 3. The Main Architectural Gap

## 3.1 Current primitives describe UI pieces

Examples from the current runtime:

```text
navigation
header
hero
inspector
stack
grid
text
metric
statusPill
deviceNode
panel
button
sectionHeader
modelRow
topologyMap
placementMap
memoryBudget
fitGauge
compatibilityMatrix
logoMark
connector
```

These are useful.

However, most of them describe **what information exists**, not **how the information should be visually composed**.

For example:

```json
{
  "fn": "metric",
  "label": "GPU",
  "value": "8x H100"
}
```

communicates content.

It does not communicate:

- visual importance
- focal priority
- relationship to other elements
- intended visual weight
- density
- rhythm
- depth
- spatial hierarchy
- optical balance
- compositional role

The runtime therefore tends to fall back to safe patterns.

---

# 4. Introduce a Visual Intent Layer

Add a declarative layer that sits above the Design IR.

## 4.1 Example

```json
{
  "visualIntent": {
    "style": "technical-editorial",
    "composition": "asymmetric",
    "density": "calm",
    "focal": "topology",
    "visualWeight": {
      "topology": 0.9,
      "modelStatus": 0.6,
      "metrics": 0.35,
      "navigation": 0.15
    },
    "depth": "subtle",
    "rhythm": "generous",
    "alignment": "strong",
    "contrast": "restrained"
  }
}
```

This is still safe structured data.

It does not require `eval`.

## 4.2 Recommended visual intent vocabulary

```text
style
composition
density
focal
visualWeight
depth
rhythm
alignment
contrast
scale
surface
tone
emphasis
grouping
balance
motion
```

---

# 5. Build a True Art Director Layer

This should be the most important new subsystem.

## 5.1 Responsibilities

The Art Director should decide:

- what the eye sees first
- what is supporting information
- where whitespace is intentional
- whether the screen is symmetrical or asymmetric
- which object becomes the hero
- how large the hero should be
- how secondary information clusters around it
- whether a screen should feel editorial, instrument-like, spatial, dense, or calm
- how data becomes visual rather than becoming another card

## 5.2 Example output

Instead of:

```text
navigation
header
grid
metric
metric
metric
panel
```

it should produce something like:

```text
┌───────────────────────────────────────────────────────────────┐
│ navigation                                                    │
│                                                               │
│                    PRIMARY TOPOLOGY                           │
│             large visual network / system map                 │
│                                                               │
│                         ↙       ↘                             │
│                 MODEL FIT      THROUGHPUT                     │
│                                                               │
│  recent activity                 selected machine             │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

The key change is that the layout is driven by **visual hierarchy**, not by a list of components.

---

# 6. Add Composition Search

A single generated composition should not be considered final.

The engine should generate 2–4 lightweight structural variants.

## 6.1 Variant families

For a major screen:

```text
A — Instrument
B — Editorial
C — Spatial
D — Analytical
```

### Instrument

Dense, technical, highly aligned.

### Editorial

Large typography, calm whitespace, stronger focal object.

### Spatial

Large visual canvas, relationships and topology dominate.

### Analytical

Data comparison and decision support dominate.

The model should select the strongest composition after review.

---

# 7. Add a Visual Design Grammar

The current system has a UI grammar.

It needs a visual grammar.

## 7.1 Visual primitives

Add concepts such as:

```text
Focal
Anchor
Cluster
Field
Layer
Rail
Orbit
Band
Stage
Lens
Marker
Trace
Path
Frame
Focus Zone
Comparison Zone
Context Zone
```

These should not necessarily map 1:1 to Figma nodes.

They should be **semantic visual composition objects** which later compile into many native nodes.

---

# 8. Upgrade the Design IR

The current Design IR is useful but needs higher-level metadata.

Add fields similar to:

```ts
interface VisualComposition {
  style?: string;
  composition?: string;
  focal?: string;
  density?: "airy" | "balanced" | "dense";
  balance?: "centered" | "asymmetric" | "radial" | "editorial";
  visualWeight?: Record<string, number>;
  relationships?: VisualRelationship[];
  layers?: VisualLayer[];
}

interface VisualRelationship {
  source: string;
  target: string;
  relation:
    | "dominates"
    | "supports"
    | "anchors"
    | "surrounds"
    | "flows-into"
    | "compares-with"
    | "depends-on";
}
```

This gives the compiler enough context to produce stronger layouts without letting the LLM draw arbitrary coordinates.

---

# 9. Separate Semantic Layout from Visual Layout

The current runtime combines content meaning and geometry.

Split this into two levels.

## Semantic layout

Answers:

```text
What belongs where?
What is primary?
What is secondary?
What relates to what?
```

## Visual layout

Answers:

```text
How large?
How far apart?
How much whitespace?
Which edges align?
How much contrast?
How do layers overlap?
Where does the eye travel?
```

This separation is essential.

---

# 10. Add Optical Layout

Mathematical alignment is not enough.

A human designer routinely applies optical corrections.

Examples:

- a text block can need 4px–12px visual correction
- icons may need optical centering
- a large circle may need to sit slightly above mathematical center
- irregular topology nodes may need non-uniform spacing
- large titles often need different side padding from body content

Add an optical correction pass:

```text
computed geometry
       ↓
optical correction
       ↓
Figma geometry
```

---

# 11. Improve the Layout Engine

Keep the existing layout algorithms, but add compositional algorithms.

Current:

```text
flow
grid
tree
cluster
masonry
timeline
radial
force
topology
```

Add:

```text
hero-split
asymmetric-grid
editorial
layered-canvas
focus-orbit
hero-with-support
sidecar
stacked-visual
comparison-field
freeform-constrained
```

The goal is not arbitrary positioning.

The goal is **controlled visual variety**.

---

# 12. Make Data Visualization a First-Class Primitive

EXO is fundamentally a visualization-heavy product.

Do not represent its most important information as cards.

Add primitives such as:

```text
capacityField
memoryMap
performanceCurve
throughputTrace
networkPath
deviceCluster
modelFootprint
resourceBar
utilizationField
latencyGraph
routingGraph
shardMap
systemTimeline
```

Example:

```text
model footprint
      ↓
cluster capacity
      ↓
available memory
      ↓
network constraints
      ↓
expected throughput
```

This should render as a coherent visual system.

---

# 13. Build a Better Native Figma Layer

The engine currently compiles down to low-level operations.

That is safe, but the native Figma representation should become richer.

Prioritize:

```text
Components
Component Sets
Variants
Instances
Auto Layout
Constraints
Variables
Text Styles
Paint Styles
Effects
Vectors
Masks
Groups
Nested components
```

The agent should prefer:

```text
find existing component
→ instantiate
→ modify variant
```

over:

```text
rebuild from primitives
```

---

# 14. Strengthen Component Discovery

Current component APIs are a good start.

Expand discovery beyond names.

Search using:

```text
semantic role
visual role
component type
appearance
usage count
variant
context
```

For example:

```json
{
  "query": {
    "semanticRole": "status",
    "visualRole": "quiet",
    "variant": "compact"
  }
}
```

Return:

```text
best match
confidence
usage count
variants
thumbnail
```

This allows the agent to reuse strong existing components.

---

# 15. Add Component Thumbnails

Component discovery should return a rendered thumbnail.

Example:

```text
Search result:

Status / Quiet / Compact
[thumbnail]

used 28 times
3 variants
```

This dramatically improves agent selection because a design model can reason visually rather than only from names.

---

# 16. The Current Critic Needs to Become a Visual Critic

The structural critic is useful but cannot determine:

> "This feels generic."

Add a second critic.

## 16.1 Structural critic

Continue using:

```text
contrast
alignment
overflow
spacing
naming
typography
component reuse
```

## 16.2 Visual critic

Evaluate:

```text
focal clarity
composition
visual balance
hierarchy
whitespace
density
rhythm
visual tension
repetition
novelty
information-to-ink ratio
surface hierarchy
visual depth
data visualization quality
```

The structural critic answers:

> Is it correct?

The visual critic answers:

> Is it good?

---

# 17. Render-and-Compare Loop

The current render capability is valuable.

Make it the central feedback loop.

Recommended loop:

```text
1. Generate composition
2. Render
3. Structural review
4. Visual review
5. Identify top 3 problems
6. Modify only those problems
7. Render again
8. Compare against previous render
9. Repeat
10. Select final
```

Avoid huge batch rewrites.

---

# 18. Add Screenshot-Level Comparison

`diff_design` currently performs structural comparison.

Add visual comparison.

Possible output:

```text
Visual difference:
- focal region enlarged 18%
- top whitespace reduced
- right rail simplified
- topology moved toward center
- metric cluster removed
```

Eventually support:

```text
pixel diff
perceptual diff
layout diff
attention diff
```

The first implementation can use a perceptual image metric rather than attempting exact pixel equality.

---

# 19. Introduce Attention Mapping

A very useful future capability:

Estimate where a user is likely to look first.

For example:

```text
Focal score

Topology       0.91
Model status   0.62
Throughput     0.41
Navigation     0.17
```

Then compare that with intended hierarchy.

If intended:

```text
topology > model status > throughput
```

but measured:

```text
throughput > topology
```

the system knows composition is wrong.

---

# 20. Add a Design Token + Theme Engine

Your existing token system should become more powerful.

Define:

```text
surface
surfaceElevated
surfaceSubtle
textPrimary
textSecondary
textMuted
border
accent
accentSoft
success
warning
danger
focus
```

Also define:

```text
spacing
radius
shadow
blur
type scale
content width
density
```

Then support themes:

```text
EXO Light
EXO Dark
EXO Dense
EXO Editorial
EXO Enterprise
```

---

# 21. Avoid the "Card Wall" Failure Mode

Add an explicit design guard:

```text
CARD_WALL_WARNING
```

Example rules:

```text
more than N isolated panels
more than N equal-weight cards
three or more consecutive metric cards
high percentage of screen area occupied by bordered rectangles
```

This should not automatically fail a screen.

It should trigger:

> "Consider converting one card cluster into a visual field, chart, topology, or open composition."

---

# 22. Avoid Repetitive Screen Templates

Templates are useful but can cause visual cloning.

The current template system should distinguish:

```text
structural template
```

from:

```text
visual expression
```

A single page-header template should support multiple visual expressions:

```text
editorial header
instrument header
compact header
hero header
contextual header
```

The semantics remain consistent while the visual result changes.

---

# 23. Build Screen Archetypes

Instead of only generic regions, define strong archetypes.

For EXO:

```text
Compute Overview
Device Setup
Device Detail
Model Explorer
Model Fit
Deployment
Runtime
Topology
Performance
Activity
Integration
API
Fleet
Site
Pool
Team
Policy
Audit
Capacity
```

Each archetype should have:

- product objective
- user decision
- information priority
- visual archetypes
- allowed patterns
- anti-patterns

---

# 24. EXO Consumer Design System

Consumer should feel:

```text
lightweight
fast
technical
calm
approachable
high-end
```

Primary visual language:

```text
large topology
model fit visualization
device relationships
quiet metrics
strong whitespace
clear action
minimal chrome
```

Do not make Consumer look like an enterprise admin system.

---

# 25. EXO Enterprise Design System

Enterprise needs:

```text
precision
density
control
global scale
traceability
operations
```

Primary visualization:

```text
fleet topology
site map
capacity
hardware state
deployments
permissions
policies
usage
audit
```

Enterprise can be denser, but it should still feel designed rather than like a generic SaaS dashboard.

---

# 26. Add a Design Brief Tool

Before drawing, add:

```text
design_brief
```

Input:

```json
{
  "screen": "model-fit",
  "user": "consumer",
  "goal": "decide whether a model can run locally",
  "primaryDecision": "run vs change model",
  "content": [...],
  "visualDirection": "technical-editorial"
}
```

Output:

```text
user goal
decision
primary object
secondary information
visual hierarchy
composition candidates
interaction states
design risks
```

Then hand the result to `plan_screen`.

---

# 27. Upgrade plan_screen

`plan_screen` should no longer only return:

```text
regions
composition
passes
```

It should return:

```text
design brief
visual direction
composition candidates
focal point
information hierarchy
component strategy
visualization strategy
interaction states
responsive strategy
anti-pattern warnings
```

Example:

```json
{
  "focal": "model footprint",
  "compositionCandidates": [
    "hero-split",
    "spatial-fit",
    "analytical-comparison"
  ],
  "recommended": "spatial-fit"
}
```

---

# 28. Add Interaction States as First-Class Objects

A design is not a single screenshot.

Support:

```text
default
hover
selected
focused
loading
empty
error
success
offline
partial
deploying
running
paused
```

Especially for EXO:

```text
device connecting
model downloading
model preparing
model fitting
model loading
inference running
device unavailable
cluster degraded
```

---

# 29. Make Motion Design Declarative

Later, support:

```json
{
  "transition": {
    "type": "crossfade",
    "duration": 180,
    "easing": "ease-out"
  }
}
```

For topology:

```text
device joins
→ topology updates
→ route animates
→ capacity changes
→ model status updates
```

This should remain declarative.

---

# 30. Improve Server Reliability

The previous EXO attempts exposed another problem:

Large generation requests can be brittle.

Do not treat a 30-screen design as one transaction.

Use:

```text
plan
↓
checkpoint
↓
screen 1
↓
render
↓
approve
↓
screen 2
...
```

For implementation:

```text
chunked writes
transaction checkpoints
retryable operations
idempotent IDs
partial success reporting
rollback per chunk
```

---

# 31. Add Persistent Design Checkpoints

Create:

```text
design_snapshot
```

Store:

```text
version
screen
composition
render
score
critic findings
selected variant
```

This enables:

```text
V1
V2
V3
```

comparison without relying on memory.

---

# 32. Build a Design Memory Layer

Your project memory is already a good foundation.

Extend it with visual decisions:

```text
brand personality
preferred density
preferred corner radius
preferred typography
approved compositions
rejected patterns
rejected colors
approved components
visual anti-patterns
```

For EXO, examples could be:

```text
avoid generic SaaS dashboard patterns
avoid unnecessary card borders
avoid excessive pills
prefer open surfaces
prefer topology as hero visualization
prefer restrained accent usage
```

---

# 33. Add a Design Quality Gate

Before finalizing a screen:

```text
PRODUCT
✓ primary user decision is obvious

COMPOSITION
✓ one dominant focal point
✓ visual hierarchy is intentional
✓ whitespace is intentional
✓ no accidental card wall

SYSTEM
✓ components reused
✓ tokens reused
✓ type scale consistent

VISUAL
✓ focal object is visually distinctive
✓ supporting content does not compete
✓ visualization carries meaning
✓ screen does not feel template-generated

TECHNICAL
✓ no overflow
✓ no broken constraints
✓ correct Figma components
✓ render succeeds
```

Fail the generation if the screen misses critical criteria.

---

# 34. Recommended Architecture

The upgraded system should look like:

```text
                       ┌──────────────────────────┐
                       │          LLM             │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │       Design Brief       │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │      Art Director        │
                       │ hierarchy / mood /       │
                       │ composition / density    │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │   Composition Search     │
                       │      A / B / C           │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │      Visual IR           │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │      Design IR            │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │ Layout + Constraints     │
                       │ + Optical Correction     │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │ Native Figma Compiler    │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │        Render             │
                       └────────────┬─────────────┘
                                    │
                                    ▼
                       ┌──────────────────────────┐
                       │ Structural Critic        │
                       │ + Visual Critic          │
                       └────────────┬─────────────┘
                                    │
                              revise / select
                                    │
                                    └────────↺
```

---

# 35. Implementation Order

Do not implement everything at once.

## Phase 1 — Fix the design-generation ceiling

Highest priority:

1. Visual Intent schema
2. Art Director layer
3. richer composition primitives
4. composition variants
5. visual critic
6. render → critique → revise loop

This should be the first milestone.

---

## Phase 2 — Native Figma quality

7. component thumbnail discovery
8. stronger component reuse
9. nested components
10. variants and instances
11. vector/effect/mask support
12. optical correction
13. token/theme improvements

---

## Phase 3 — EXO-specific design engine

14. topology visualization
15. model footprint
16. memory map
17. performance visualization
18. deployment visualization
19. consumer archetypes
20. enterprise archetypes

---

## Phase 4 — Agent maturity

21. persistent design snapshots
22. visual diff
23. attention mapping
24. preference memory
25. responsive generation
26. interaction-state generation
27. motion declarations
28. design-to-code fidelity loop

---

# 36. What NOT to Do

Do not solve this by:

```text
adding more prompt text
```

Do not solve it by:

```text
adding 100 more generic components
```

Do not solve it by:

```text
allowing arbitrary JavaScript
```

Do not solve it by:

```text
generating 20 screens in one giant transaction
```

Do not solve it by:

```text
making the critic produce arbitrary aesthetic scores
```

Do not solve it by:

```text
replacing every existing system
```

The existing runtime/compiler/plugin architecture is valuable.

The goal is to add a **design intelligence layer above it**.

---

# 37. The Most Important Principle

FigDes should stop thinking:

> "What UI components should I place?"

and start thinking:

> "What visual composition best communicates the user's decision?"

This one change should guide the entire upgrade.

---

# 38. Definition of Success

The upgraded FigDes system should be capable of taking:

```text
"Design EXO's consumer Model Fit screen."
```

and producing:

### Step 1
A design brief.

### Step 2
Three composition directions.

### Step 3
A chosen art direction.

### Step 4
A coherent native Figma screen.

### Step 5
A rendered preview.

### Step 6
A visual critique.

### Step 7
Two or three targeted refinements.

### Step 8
A final design that:

- does not look template-generated
- does not look like a generic SaaS dashboard
- has clear hierarchy
- has a strong focal point
- uses whitespace intentionally
- turns important data into visualizations
- reuses native components
- maintains design-system consistency
- can be edited normally inside Figma

---

# 39. Immediate Recommendation for FigDes

Before doing more EXO screens, build one flagship demonstration:

## Consumer — Model Fit

The screen should contain:

```text
Model
      ↓
Requirements
      ↓
Your Devices
      ↓
Fit / Doesn't Fit
      ↓
Recommended configuration
      ↓
Run
```

But it should **not** be represented as six cards.

Make the visual system communicate the decision through:

```text
large model footprint
+
device topology
+
memory relationship
+
fit visualization
+
one strong action
```

Then create:

```text
Variant A — spatial
Variant B — instrument
Variant C — editorial
```

Render all three.

Review all three.

Choose one.

Only after that should the system derive the rest of the EXO screens.

That single experiment will tell us whether the architectural changes actually solved the problem.

---

# 40. Final Architecture Goal

The end state is:

```text
FigDes v1
= UI Construction Engine

FigDes v2
= Design Construction Engine

FigDes v3
= Design Reasoning + Visual Iteration Engine
```

The immediate target should be **FigDes v2.5**:

> a safe declarative design system that can reason about composition, generate multiple visual directions, render them, critique them, and iteratively converge on high-quality native Figma designs.

That is the missing layer between the current FigDes implementation and the quality you are expecting from a strong Figma MCP workflow.
