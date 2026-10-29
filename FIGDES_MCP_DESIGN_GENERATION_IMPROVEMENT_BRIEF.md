# Figdes MCP Design Generation Improvement Brief

## Purpose

Improve the Figdes MCP and Figma plugin so an AI agent can reliably turn a product brief into complete, editable, production-quality Figma screens. The system must not treat a valid frame, a list of regions, or a few labels as a finished screen.

The target outcome is a reliable loop:

```text
Product decision
  -> information model
  -> visual composition
  -> reusable product components and states
  -> native Figma nodes
  -> render
  -> visual critique
  -> targeted repair
  -> rendered acceptance
```

## Observed Problems

### Native Figma writing is unreliable

The native write tool failed for both a large custom screen and a minimal probe that created one rectangle:

```text
proxy: inconsistent get
```

This is a blocking reliability issue. When the direct native writer fails, the agent is forced onto a high-level generator that creates skeletal screens. Fix this before optimizing prompts or visual planning.

### The screen generator produces plans, not complete interfaces

`plan_screen` successfully identifies decisions, hierarchy, regions, and composition. The later build often converts requirements into labels such as:

- `Explicit fit uncertainty`
- `Topology plus a device-list alternative`
- `Path to a real test request`

These are requirements, not usable interface elements. A production screen needs concrete controls, content patterns, data states, and interaction affordances.

### Generated layouts can become generic or sparse

The system correctly avoids generic SaaS card walls, but sometimes over-corrects into mostly empty regions with a title, button, and placeholder label. Honesty about unknown product data must result in explicit uncertainty states, not empty UI.

### Visual review is stronger than visual repair

The MCP can render and identify issues, but it cannot always execute the required detailed repair. The final quality gate must require a successful repair path, not merely report a problem.

### Design system drift

The existing file has many hard-coded colors and unstyled text nodes. Without reusable components, variables, and styles, later generations drift from the visual language and become worse over time.

## Non-Negotiable Reliability Requirements

### 1. Repair native write execution

The Figma plugin API proxy must support reliable reads and writes during one transaction.

Required regression tests:

- Create a rectangle, set fill, size, position, and parent it.
- Create a frame with nested text, shapes, and auto-layout children.
- Load fonts and create wrapping text.
- Create 100+ nodes in one transaction.
- Create a screen, render it, mutate two nodes, and render it again.
- Create, inspect, and modify nodes with no stale or proxy errors.
- Return every created and mutated node ID.

Expected behaviour:

```text
No `proxy: inconsistent get` failures.
Any failed transaction is fully rolled back.
Successful transactions report rootId, createdNodeIds, mutatedNodeIds, and render target.
```

### 2. Add transaction-safe high-level primitives

The agent should not need to hand-create every rectangle and text node. Provide reliable, editable primitives that create native Figma nodes.

Required primitives:

- `appShell`
- `sidebarNavigation`
- `topBar`
- `pageHeader`
- `primaryButton`
- `secondaryButton`
- `statusBadge`
- `notice`
- `sectionHeader`
- `dataTable`
- `dataRow`
- `keyValueList`
- `metricReadout`
- `progressSequence`
- `timeline`
- `codeBlock`
- `copyField`
- `emptyState`
- `errorState`
- `loadingState`
- `successState`
- `inspectorPanel`
- `splitView`
- `topologyCanvas`
- `topologyNode`
- `topologyEdge`

Each primitive must support semantic content, tokens, states, accessibility labels, auto-layout, and return native node IDs.

## Design Generation Contract

### A screen is not complete unless all conditions pass

Do not call a screen complete when it has only regions, placeholder labels, or an unpopulated scaffold.

Required completion criteria:

1. A specific user decision is obvious within five seconds.
2. The primary task has real controls and realistic content.
3. Every required information item is represented by a concrete UI pattern.
4. Relevant loading, empty, uncertainty, error, and success states are designed.
5. The screen uses shared components and tokens where applicable.
6. It renders successfully.
7. The agent visually reviews the render.
8. Visual findings are repaired and re-rendered.
9. No placeholder-only regions remain.
10. The result passes structural, product-truth, and visual QA.

### Never replace concrete content with requirement labels

Bad output:

```text
Explicit fit uncertainty
Path to a real test request
```

Good output:

```text
Fit needs confirmation

Known: selected model and quantization
Still needed: runtime memory estimate and target context length

Why this matters: a download can finish even when the chosen configuration
cannot run reliably.

[Review fit inputs]
```

### Preserve visual intent across edits

Store a `visualIntent` contract on each generated screen:

```json
{
  "density": "calm-medium",
  "composition": "technical instrument",
  "focal": "one operational decision",
  "surfaceStrategy": "open canvas with sparse grounded panels",
  "type": "human-readable serif-free UI plus mono machine values",
  "accents": "green only for verified; amber only for attention",
  "antiPatterns": ["generic card wall", "dashboard KPI wall", "chat-first layout"]
}
```

All later edits must inspect and preserve this contract unless the user explicitly requests a redesign.

## Required Design-System Workflow

Before creating screens:

1. Inspect the Figma file for components, variables, styles, fonts, and naming conventions.
2. Create missing semantic tokens rather than repeatedly using hard-coded values.
3. Create or update reusable components.
4. Build screens using instances where possible.
5. Keep new work additive unless the user explicitly requests replacement.

Required token categories:

- Background: canvas, surface, subtle surface
- Text: primary, secondary, muted, inverse
- Border: subtle, strong, focus
- State: verified, attention, danger, unknown
- Spacing: 4, 8, 12, 16, 24, 32, 48
- Radius: 0, 8, 12, 16
- Type: display, title, section, body, label, machine-data, caption

## EXO Product Profile

The EXO profile must turn product truth into screen patterns. It must not rely on generic dashboard assumptions.

### Product rules

- Device discovery is automatic.
- Placement is automatic; do not invent manual shard controls.
- Model fit is configuration-specific.
- Downloaded files, prepared model, running runtime, reachable endpoint, and successful inference are distinct states.
- A real test request is the activation milestone.
- Topology must explain a relationship and always have a list alternative.
- Unknown, inferred, live, stale, estimate, and illustrative values must be distinguishable.
- Enterprise controls are proposed until backed by a pinned build and capability evidence.
- Chat must not be the primary interface.

### EXO-specific semantic primitives

- `devicePoolSummary`
- `deviceLedger`
- `topologyWithListToggle`
- `modelFitExplanation`
- `fitInputsLedger`
- `preparationSequence`
- `runtimeStateRail`
- `endpointVerification`
- `inferenceTestResult`
- `clientConnectionRecipe`
- `diagnosticEvidencePanel`
- `recoveryRecommendation`
- `provenanceLabel`

### Required screen recipes

#### Overview

Decision: what should I do next?

Must include:

- A plain-language current state
- One dominant next action
- Compact pool summary
- Clear distinction between verified and not-yet-verified states
- A lifecycle rail showing pool, fit, preparation, runtime, endpoint, and test request

#### Compute

Decision: what devices are available and why do they matter?

Must include:

- Topology and list/table alternative
- Device identity, state, contribution, and freshness when available
- Selected-device inspector
- No invented bandwidth, latency, or capacity fields

#### Model Fit

Decision: can this exact configuration run?

Must include:

- Model and configuration selector
- Fit verdict: fits, blocked, or needs confirmation
- Known evidence, missing inputs, and assumptions
- Candidate devices and resource explanation
- A call to prepare only when fit is sufficiently confirmed

#### Prepare

Decision: what remains before runtime start?

Must include:

- Preparation stages
- Current stage and remaining work
- Clear distinction between preparation completion and runtime readiness
- Recovery path for a failed preparation step

#### Run Verification

Decision: is the model ready for real use?

Must include:

- Startup and runtime state timeline
- Endpoint reachability status
- Real inference test result
- Timestamp and relevant evidence
- Clear timeout state that does not automatically claim failure

#### Connect

Decision: how do I use this verified runtime in a tool?

Must include:

- Base URL and protocol
- Model profile
- Copyable client configuration
- Supported client examples only
- Explicit prerequisite that a test request succeeded

#### Diagnostics

Decision: what is the safest next recovery action?

Must include:

- What is known
- What is inferred
- Supporting evidence
- A concrete next step
- Link to detailed diagnostics only when available
- No invented cause, remediation, audit log, or history

## Better Build Algorithm

Use this sequence for every screen:

1. Read product profile and screen recipe.
2. State the user decision and primary action.
3. Map every requirement to a semantic primitive.
4. Build the shell with shared components.
5. Populate concrete content and interaction states.
6. Apply tokens, type styles, and spacing rules.
7. Render at useful resolution.
8. Critique focal hierarchy, whitespace, density, visual balance, legibility, and product truth.
9. Apply targeted repairs.
10. Re-render and compare before versus after.
11. Run structural and product-truth QA.
12. Mark complete only when all acceptance criteria pass.

## Agent Behaviour Requirements

The agent must:

- Be honest when a screen is only a scaffold.
- Never call a frame with placeholder labels a finished screen.
- Hide or remove incomplete experiments rather than leaving them visible.
- Avoid broad redesigns during local repair work.
- Build one full screen at a time when native mutation reliability is uncertain.
- Use screenshots as evidence; do not claim visual quality without rendering.
- Preserve user-owned older work unless explicitly asked to replace it.
- Ask for help only when a true capability blocker exists, including reproducible error output.

## Acceptance Tests

### Native writer acceptance test

```text
Given: a blank Figma page and the EXO profile
When: the agent requests a full Overview screen
Then: the plugin creates an editable app shell, navigation, summary, topology/list view,
      inspector, state rail, buttons, and evidence labels in native Figma nodes.
And: the screen renders without overlap, clipping, or blank regions.
And: the build returns every created node ID.
```

### Full-screen acceptance test

```text
Given: an EXO screen recipe and illustrative demo data
When: the agent builds the screen
Then: no requirement is represented only as a raw label.
And: every key state has an appropriate UI treatment.
And: the screen has a meaningful focal task, not a generic card grid.
And: the generated screen passes final visual, technical, and product-truth QA.
```

## Priority Order

1. Fix `proxy: inconsistent get` in the native Figma writer.
2. Add component-aware native primitives.
3. Add semantic-to-concrete UI compilation.
4. Add a token/component-first design-system workflow.
5. Add EXO screen recipes and semantic primitives.
6. Enforce render, repair, and completion gates.

## Definition of Success

Success is not “the MCP made a frame.”

Success is: an AI agent can create a complete, visually coherent, editable Figma screen that an experienced product designer recognizes as a usable production design, then improve it without reducing its quality on subsequent iterations.
