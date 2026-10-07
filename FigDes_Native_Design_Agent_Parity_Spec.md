# FigDes — Native Design Agent Parity Specification

## Goal

Upgrade FigDes from a semantic UI generator into a high-fidelity native Figma design agent with the practical freedom, iterative workflow, and canvas control of a strong Figma MCP workflow.

The central decision is:

> Keep FigDes's safety, transactions, project memory, EXO rules, semantic runtime and QA, but stop forcing every visual decision through a restricted primitive vocabulary.

FigDes should support three execution modes:

```text
Semantic Mode
  Repeatable product UI and known patterns.

Native Design Mode
  Broad native Figma control for original visual composition.

Hybrid Mode
  Existing components + semantic patterns + custom native composition.
```

Hybrid should become the normal mode for sophisticated screens.

---

# 1. Why the Current Architecture Still Has a Ceiling

The current FigDes pipeline is approximately:

```text
LLM
 ↓
semantic primitives
 ↓
Design IR
 ↓
layout algorithms
 ↓
compiler
 ↓
fixed Figma operation vocabulary
 ↓
Figma
```

This is reliable and safe, but it encourages the model to think in terms of:

```text
panel
metric
grid
row
button
status
hero
```

instead of:

```text
composition
focal point
visual field
layer
negative space
visual rhythm
depth
optical balance
spatial relationship
```

The problem is therefore not mainly prompt quality. The execution layer creates an **expression ceiling**.

The target is not to replace the current architecture. The target is to add a native execution path beside it.

---

# 2. What We Are Matching

Figma's current MCP workflow combines a general-purpose native Figma execution capability with workflow skills for design generation, component/library creation, and validation. The important capabilities to reproduce are:

```text
native Figma execution
rich file inspection
design-system discovery
incremental writes
screenshot checkpoints
visual validation
error recovery
component/variant reuse
```

Official references used for this specification:

- https://developers.figma.com/docs/figma-mcp-server/
- https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
- https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/
- https://github.com/figma/mcp-server-guide/blob/main/skills/figma-use/SKILL.md
- https://github.com/figma/mcp-server-guide/blob/main/skills/figma-generate-design/SKILL.md
- https://github.com/figma/mcp-server-guide/blob/main/skills/figma-generate-library/SKILL.md

We should reproduce the capability and workflow, not copy internal implementation details.

---

# 3. Target Architecture

```text
                         USER
                           │
                           ▼
                  ┌────────────────┐
                  │  Design Brief  │
                  └───────┬────────┘
                          │
                          ▼
                  ┌────────────────┐
                  │ Design Reasoner│
                  │ goal           │
                  │ hierarchy      │
                  │ visual intent  │
                  │ interaction    │
                  └───────┬────────┘
                          │
                          ▼
                  ┌────────────────┐
                  │   Visual IR    │
                  │ focal / field  │
                  │ stage / layer  │
                  │ cluster / path │
                  │ relationships  │
                  └───────┬────────┘
                          │
             ┌────────────┴────────────┐
             │                         │
             ▼                         ▼
       Semantic Mode              Native Mode
             │                         │
             ▼                         ▼
        Design IR              Native Figma Runtime
             │                         │
             └────────────┬────────────┘
                          ▼
                    Figma Canvas
                          │
                          ▼
                      Screenshot
                          │
                          ▼
                   Visual Critic
                          │
                     revise/keep
                          │
                          └───────────↺
```

The current Design IR and semantic runtime remain the reliable production path. Native Mode becomes the freedom layer.

---

# 4. Add a Native Execution Tool

Introduce a tool conceptually equivalent to a `use_figma` workflow:

```text
figdes_use_figma
```

Purpose:

> Execute controlled Figma-native code/operations against the connected document and return structured evidence.

The native layer must support, at minimum:

```text
pages
frames
sections/groups
text
vectors
components
component sets
instances
variants
component properties
variables
styles
auto-layout
constraints
fills
strokes
effects
images/assets
prototype links
```

The model must not need to request a new semantic primitive every time it invents a new visual object.

Semantic primitives become accelerators, not restrictions.

---

# 5. Native Execution Safety

Do not remove the current safety architecture merely to gain freedom.

Native execution should still have explicit boundaries:

```text
NO filesystem access
NO shell/process execution
NO credentials
NO environment secrets
NO arbitrary external network access from model code
NO access outside the connected Figma document/session
```

Enforce hard limits:

```text
maximum execution time
maximum input/script size
maximum created nodes
maximum mutation count
maximum result size
```

Every mutation must be transactional:

```text
start transaction
↓
execute
↓
validate result
↓
commit
```

On error:

```text
rollback
↓
return exact failure
↓
provide recovery information
```

Preserve FigDes's existing rollback and failure-reporting advantages.

---

# 6. Do Not Push Native Mode Back Through the Old Compiler

Do not implement this:

```text
Native request
 ↓
convert to existing semantic primitives
 ↓
convert to existing operation union
 ↓
Figma
```

That keeps the old design ceiling.

The native path must be:

```text
Native request
 ↓
controlled execution environment
 ↓
Figma Plugin API
```

The semantic path remains:

```text
Semantic request
 ↓
Design IR
 ↓
compiler
 ↓
Figma
```

---

# 7. Add a Small Native Helper Layer

The model should have concise helpers so native work is easy to express without inventing fragile boilerplate.

Example:

```js
const page = fig.page();

const screen = fig.frame({
  name: "Model Fit",
  width: 1440,
  height: 900
});

fig.append(page, screen);

const topology = fig.frame({
  name: "Topology Field",
  width: 820,
  height: 600
});

fig.append(screen, topology);
```

Helpers should include:

```text
fig.page()
fig.find()
fig.frame()
fig.text()
fig.rectangle()
fig.ellipse()
fig.vector()
fig.group()
fig.component()
fig.instance()
fig.variant()
fig.variable()
fig.style()
fig.effect()
fig.autoLayout()
fig.append()
fig.remove()
fig.clone()
fig.bounds()
fig.screenshot()
```

Advanced native Figma Plugin API access can remain available to Native Mode when appropriate.

---

# 8. Always Return Evidence

Every native execution call should return real state, for example:

```json
{
  "success": true,
  "createdNodeIds": ["101:21", "101:22"],
  "modifiedNodeIds": ["101:14"],
  "summary": "Created topology field and model-fit overlay.",
  "warnings": [],
  "bounds": {
    "101:21": {
      "x": 240,
      "y": 140,
      "width": 820,
      "height": 600
    }
  }
}
```

The next call must be able to operate from these IDs and measurements instead of guessing.

---

# 9. Add a Visual IR

The existing Design IR is valuable, but it is too close to geometry and UI structure.

Add a higher-level Visual IR between design reasoning and Design IR.

Example:

```json
{
  "composition": {
    "style": "technical-editorial",
    "balance": "asymmetric",
    "density": "calm"
  },
  "focal": {
    "id": "topology",
    "weight": 0.9
  },
  "visualObjects": [
    {
      "id": "topology",
      "role": "hero-field",
      "depth": 2
    },
    {
      "id": "fit",
      "role": "decision-overlay",
      "weight": 0.8
    }
  ]
}
```

Initial vocabulary:

```text
focal
hero
field
stage
layer
cluster
rail
anchor
orbit
trace
lens
overlay
marker
path
comparison
context
surface
spotlight
callout
```

These are visual concepts. They should compile into native Figma geometry without forcing the model to calculate every coordinate itself.

---

# 10. Make `visualIntent` Executable

Current intent concepts such as:

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
```

must have a real downstream implementation.

Required mapping:

```text
style
→ typography + palette + surfaces + components + effects

composition
→ layout strategy

density
→ spacing + content density

focal
→ size + position + contrast + isolation

visualWeight
→ size + spacing + placement + emphasis

depth
→ z-order + layered surfaces + effects

rhythm
→ spacing relationships

alignment
→ alignment constraints

contrast
→ visual hierarchy + accent usage
```

If a property does not yet affect the canvas, do not pretend it is implemented.

---

# 11. Content-Level Focal Points

Focal targets must support:

```text
region IDs
content IDs
component IDs
visual-object IDs
```

Example:

```json
{
  "focal": "model-footprint"
}
```

The model footprint itself should become the visual hero even when its parent region contains other content.

The focal engine should combine:

```text
semantic importance
declared intent
area
position
contrast
typographic prominence
isolation
complexity
color salience
role
```

Do not use `largest region = focal` as the main strategy.

---

# 12. Real Composition Variants

Composition candidates must become actual designs, not just descriptions.

Required flow:

```text
Design Brief
 ↓
Variant A
Variant B
Variant C
 ↓
Compile
 ↓
Render
 ↓
Evaluate
 ↓
Choose
```

First variant families:

```text
Spatial
Editorial
Instrument
Analytical
Asymmetric
Split
Hero-centered
Canvas-first
```

Each variant must produce a real buildable Visual IR / program.

---

# 13. Variant Selection

Evaluate variants with:

```text
product fit
hierarchy
focal agreement
visual balance
density
component consistency
anti-patterns
technical correctness
visual critic
```

Use deterministic metrics to reject broken designs.

Use visual judgement to select among valid designs.

Do not let a geometry-only score decide the final design.

---

# 14. Build a Separate Visual Critic

Keep the structural critic. Add a visual critic.

Structural:

```text
overflow
alignment
contrast
tokens
accessibility
naming
component correctness
```

Visual:

```text
focal clarity
hierarchy
balance
whitespace
density
rhythm
contrast hierarchy
depth
surface hierarchy
repetition
template-ness
card-wall tendency
data visualization quality
visual tension
```

Example:

```json
{
  "severity": "high",
  "finding": "The inspector competes with the topology.",
  "reason": "It has nearly equal contrast and density to the primary visual.",
  "suggestion": "Reduce surface contrast, compress metadata, and increase topology isolation."
}
```

The visual critic must answer:

> Does this look designed?

not merely:

> Is this structurally valid?

---

# 15. Make Screenshots First-Class

The normal design loop should be:

```text
inspect
 ↓
build a small part
 ↓
metadata check
 ↓
screenshot
 ↓
visual critique
 ↓
modify
 ↓
screenshot
 ↓
continue
```

Screenshot checkpoints should occur after:

```text
composition
major visual change
component composition
final state
```

Do not wait until the entire screen is finished before looking at it.

---

# 16. Add Fine-Grained Design Mode

The current chunked write system is useful for reliability.

Keep it for construction mode.

Add a visual `designMode` where changes are smaller:

```text
3–10 meaningful visual changes
→ inspect
→ screenshot
```

Use larger transactions only for repetitive deterministic work.

High-fidelity composition should be incremental.

---

# 17. Add `figdes_inspect_visual`

Create a lightweight visual-summary read tool that reports:

```text
canvas dimensions
largest objects
focal candidates
text hierarchy
surface count
card-like surfaces
color distribution
whitespace distribution
alignment groups
visual layers
component usage
```

This gives the model useful visual evidence without always requiring a high-resolution screenshot.

---

# 18. Expand Design-System Discovery

Search should cover:

```text
local components
component sets
variants
variables
styles
connected libraries
```

Return:

```text
component name
visual role
variant list
usage count
source
thumbnail
```

Preferred workflow:

```text
inspect design system
 ↓
search component
 ↓
inspect candidate
 ↓
instantiate
```

Do not redraw a component that already exists unless there is a good reason.

---

# 19. Visual Component Discovery

Component search must become visual as well as semantic.

Example:

```text
Query:
quiet status indicator

Result:
Status / Quiet
[thumbnail]

12 instances
4 variants
EXO System
```

The model should be able to choose by appearance and role, not only by component name.

---

# 20. Asset Support

Native Mode should support:

```text
SVG
images
logos
icons
illustrations
gradients
custom vectors
```

Do not force all visual richness into rectangles and text.

Prefer:

```text
existing asset
or editable vector
or native component
```

---

# 21. Native Figma Coverage

Priority order:

### Tier 1

```text
frames
text
vectors
groups
components
instances
variants
auto-layout
constraints
variables
styles
effects
```

### Tier 2

```text
images
SVG import
component properties
instance swaps
page/section management
prototype links
export
```

### Tier 3

```text
advanced motion
advanced shaders
specialized effects
```

Do not delay Tier 1 to chase Tier 3.

---

# 22. Workflow Skills

Create separate workflow skills instead of relying on one giant MCP instruction string:

```text
figdes-use
figdes-generate-design
figdes-generate-library
figdes-visual-review
figdes-design-system
figdes-exo-consumer
figdes-exo-enterprise
```

Each skill should specify:

```text
when to use
what to inspect
what to build first
what to avoid
when to screenshot
how to validate
how to recover
```

The goal is to teach the agent a reliable design workflow, not just expose tools.

---

# 23. `figdes-use`

Teach the agent:

```text
native execution
node lookup
page selection
font loading
component creation
instance creation
variables
styles
effects
auto-layout
safe mutation
result tracking
rollback
error recovery
```

Every meaningful write must return node IDs.

---

# 24. `figdes-generate-design`

Recommended sequence:

```text
1. Inspect file
2. Inspect design system
3. Find reusable components
4. Define visual direction
5. Choose composition
6. Create skeleton
7. Screenshot
8. Create primary visual
9. Screenshot
10. Refine
11. Validate
12. Final screenshot
```

Do not default to one giant screen-generation call.

---

# 25. `figdes-visual-review`

The agent should explicitly ask:

```text
What do I see first?
What should I see first?
Are they the same?
Is there a second focal point competing?
Is whitespace intentional?
Are surfaces helping the hierarchy?
Is important information visualized or merely boxed?
Does the screen feel generic?
Does it resemble a dashboard template?
```

Then make targeted changes instead of blindly regenerating the whole screen.

---

# 26. Remove Excessive Blocking Instructions

Do not tell the agent:

```text
Never use custom geometry.
Never create rectangles directly.
Never improvise.
Never skip the planner.
Only use semantic primitives.
```

Replace them with preferences:

```text
Prefer existing components when appropriate.
Prefer semantic primitives for repeatable product patterns.
Use native composition when the semantic layer would reduce visual quality.
Inspect before modifying existing structures.
Use the smallest useful mutation.
Verify visually after major changes.
```

The agent needs an escape hatch, not a cage.

---

# 27. Let the Agent Choose Execution Strategy

Every meaningful task should be able to choose:

```text
semantic
native
hybrid
```

Example:

```text
Sidebar
→ existing component

Button
→ component instance

Topology
→ native custom composition

Model visualization
→ native custom composition

Status pill
→ existing component
```

This prevents unnecessary custom work without limiting visual creativity.

---

# 28. EXO Model-Fit Example

The target should be a visual decision experience rather than a wall of cards.

Conceptually:

```text
┌──────────────────────────────────────────────────┐
│ EXO                                  Model Fit   │
│                                                  │
│                  MODEL                           │
│               70B / 42 GB                        │
│                     │                            │
│                     ▼                            │
│          ┌─────────────────────┐                 │
│          │     DEVICE MAP      │                 │
│          │                     │                 │
│          │ Mac ── GPU ── Mac   │                 │
│          │      ↘   ↙          │                 │
│          │       SHARDS        │                 │
│          └─────────────────────┘                 │
│                                                  │
│                              FITS ✓              │
│                              42 / 64 GB          │
│                                                  │
│                              [ Run model ]       │
└──────────────────────────────────────────────────┘
```

This should become one coherent visual composition.

It should not become six generic cards.

---

# 29. EXO Anti-Patterns

Add warning rules for:

```text
generic SaaS dashboard
card wall
three-card KPI row
pill overload
unnecessary borders
equal-weight regions
chat-first UI
raw technical spec dump
panel-with-title repetition
table where a visualization is more useful
```

These are warnings, not hard blockers.

A strong design can intentionally violate an anti-pattern when there is a reason.

---

# 30. Split QA Into Structural and Visual

Structural QA:

```text
no overflow
alignment
contrast
tokens
components
naming
accessibility
```

Visual QA:

```text
strong focal
clear hierarchy
intentional whitespace
balanced composition
meaningful visualization
controlled repetition
reasonable depth
no accidental template feeling
```

A design is not finished because structural QA passes.

---

# 31. Error Recovery

Every native call must report:

```text
operation
node
error
whether the document changed
rollback state
recovery step
```

Recovery strategy:

```text
execute
 ↓
error
 ↓
if safe-to-retry:
  fix and retry
else:
  inspect current state
  modify from evidence
```

Never blindly repeat a failed mutation.

---

# 32. Testing Strategy

Add four levels of tests.

## Runtime

```text
native mode starts
native mode finishes
limits work
rollback works
IDs return correctly
invalid execution fails safely
```

## Visual IR

```text
focal changes output
depth changes output
density changes output
style changes output
composition changes output
```

## Native Figma

```text
components
instances
variants
variables
styles
vectors
effects
auto-layout
assets
screenshots
```

## Generation benchmark

Test at least:

```text
Model Fit
Topology
Device Detail
Runtime
Performance
Fleet
Integration
API
```

Generate every benchmark in:

```text
semantic mode
native mode
hybrid mode
```

Compare visual quality and iteration count.

---

# 33. Success Metrics

Do not measure success by number of tools or primitives.

Measure:

```text
visual quality
design diversity
native editability
iteration quality
component reuse
time to good result
major revisions required
```

Suggested initial targets:

```text
90%+ successful native executions
0 silent mutations
0 unrecoverable transactions
high component reuse where appropriate
less than 3 major visual revisions for normal screens
2–4 meaningful composition variants for major screens
```

The strongest proof is:

> The model can create a high-quality design that cannot be cleanly represented by the old semantic primitive catalogue.

If it cannot, Native Mode is still too restricted.

---

# 34. Migration Plan

## Phase 1 — Native execution

Add:

```text
figdes_use_figma
native execution context
result tracking
transaction wrapper
execution limits
```

## Phase 2 — Native coverage

Add:

```text
components
instances
variants
variables
styles
vectors
effects
assets
auto-layout
constraints
```

## Phase 3 — Visual workflow

Add:

```text
fine-grained design mode
screenshot checkpoints
visual review
hybrid mode
```

## Phase 4 — Visual intelligence

Add:

```text
Visual IR
content-level focal
real composition variants
visual critic
visual attention
```

## Phase 5 — Skills

Add:

```text
figdes-use
figdes-generate-design
figdes-generate-library
figdes-visual-review
EXO consumer skill
EXO enterprise skill
```

---

# 35. What Must Stay

Do not remove:

```text
Design IR
semantic runtime
transactions
rollback
project memory
design guard
EXO product rules
snapshots
review rules
tokens
font validation
component audit
```

Native mode should sit beside them.

---

# 36. Master Coding-Agent Instruction

> Upgrade FigDes toward native Figma-MCP-level design freedom without replacing the existing safety and transaction architecture. Keep the Design IR, semantic runtime, rollback, project memory, design guard, EXO product rules, tokens and QA. Add a first-class Native Design Mode that can manipulate a substantially broader set of native Figma objects through a controlled Plugin API execution layer. Support pages, frames, groups, text, vectors, components, component sets, instances, variants, component properties, variables, styles, effects, auto-layout, constraints, assets and prototype relationships. Native execution must be transactional, resource-limited, observable and recoverable; every call must return real created and modified node IDs plus useful measurements. Do not route Native Mode back through the existing small primitive compiler because that recreates the current expression ceiling. Add a Visual IR between product reasoning and geometry so the model can represent focal points, visual fields, stages, layers, clusters, overlays, traces, anchors and relationships without manually calculating all coordinates. Make every visual-intent field executable rather than descriptive. Let focal targets reference content and components, not only regions. Make composition candidates real buildable variants; render them and evaluate them before selecting the best direction. Make screenshots part of the standard design loop: inspect → make a small change → screenshot → visually critique → modify → screenshot. Add a Visual Critic separate from structural QA for hierarchy, balance, whitespace, density, depth, repetition, template-ness, card-wall behavior and visualization quality. Add visual component/library discovery so the agent can reuse native components rather than rebuild them. Support semantic, native and hybrid strategies and let the model choose. Replace blocking 'never' rules with preference-based guidance: use semantic primitives and existing components when useful, but give the model freedom to create custom native compositions whenever they improve the design. Do not make the tool safer by making it less capable; make it safer through sandboxing, limits, validation, transactional writes and evidence-based recovery. The objective is not a larger UI DSL. The objective is to make the Figma canvas itself the model's design environment while preserving FigDes's safety, native editability, product intelligence and recoverability.

---

# 37. Definition of Done

```text
[ ] Native Design Mode exists
[ ] Semantic Mode still works
[ ] Hybrid Mode works
[ ] Native execution is transactional
[ ] Execution limits are enforced
[ ] Node IDs are returned reliably
[ ] Components and variants can be reused
[ ] Variables and styles can be searched and bound
[ ] Vectors/effects/assets are supported
[ ] Visual IR exists
[ ] Content-level focal points work
[ ] All visualIntent fields affect output
[ ] Composition variants are real builds
[ ] Screenshots are part of the design loop
[ ] Visual Critic is separate from structural QA
[ ] Component discovery has visual context
[ ] Workflow skills exist
[ ] EXO anti-patterns are warnings, not cages
[ ] Fine-grained design iteration is supported
[ ] Large builds remain chunkable
[ ] Benchmark suite shows visual improvement
```

---

# 38. Final Principle

> **Do not build a bigger box for the model. Give the model a better canvas.**

Semantic primitives should accelerate the agent.

They must never prevent the agent from producing a better design.
