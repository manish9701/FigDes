# Design Agent — Advanced Product Specification

## Vision
Turn the current working ChatGPT → Custom MCP → Figma Plugin → native Figma pipeline into an AI design partner, not a basic Figma command executor.

```text
UNDERSTAND → PLAN → DESIGN → EXECUTE → REVIEW → IMPROVE → REMEMBER
```

The agent should be able to take a product-level request such as:

> Redesign EXO's deployment experience so a first-time user understands what is happening.

and inspect the current product, understand the design system, diagnose UX problems, propose a direction, generate screens/states, execute native Figma changes, review its own work, fix high-confidence issues, and remember the decisions.

---

# 1. Architecture

```text
User
 ↓
ChatGPT
 ↓
Custom MCP
 ↓
Design Agent
 ├─ Intent / UX reasoning
 ├─ Project memory
 ├─ Design-system intelligence
 ├─ Semantic Figma understanding
 ├─ Planning
 ├─ Design critic
 ├─ QA
 └─ Orchestration
 ↓
Structured Design Model
 ↓
Validated Design Operations
 ↓
Figma Plugin
 ↓
Figma Plugin API
 ↓
Native Figma
```

## Non-negotiable
**Do not use the Figma MCP Server as the execution layer.**

The Figma plugin is the execution layer. The custom MCP is the communication layer.

The system must work with Figma MCP completely unavailable.

---

# 2. Product principles

### Intent before pixels
Understand the product goal, user, information hierarchy, constraints, existing patterns, and desired outcome before drawing.

### Existing system before new system
Prioritize:

```text
existing component
→ existing variant
→ existing variable/token
→ existing style
→ existing pattern
→ new component
```

### Native by default
Prefer native Figma frames, text, components, variables, auto layout, and editable nodes.

### Review your own work
Default workflow:

```text
Create → Inspect → Review → Fix → Verify
```

### Product thinking over isolated screens
Understand:

```text
screen → flow → state → system → product
```

### User remains in control
Large/destructive changes should be previewable and approval-gated.

---

# 3. Agent modes

Expose these high-level modes:

```text
CREATE
EDIT
REVIEW
AUDIT
REFACTOR
EXPLORE
RESPONSIVE
IMPLEMENT
MISSION
```

## CREATE
Create screens or flows.

## EDIT
Modify current selection/screen.

## REVIEW
Critique only; do not change Figma.

## AUDIT
Find systematic design problems.

## REFACTOR
Clean structure/design-system issues.

## EXPLORE
Generate multiple directions.

## RESPONSIVE
Adapt a design across breakpoints.

## IMPLEMENT
Work with code integrations when available.

## MISSION
Perform a multi-step product-design task autonomously.

---

# 4. Project Design Memory

The agent needs persistent, project-scoped memory.

```text
PROJECT
├── Product
│   ├── purpose
│   ├── target users
│   ├── terminology
│   └── jobs-to-be-done
├── Brand
│   ├── colors
│   ├── typography
│   ├── identity
│   └── visual language
├── Design System
│   ├── components
│   ├── variants
│   ├── variables
│   ├── styles
│   ├── spacing
│   └── patterns
├── UX
│   ├── navigation
│   ├── flows
│   ├── states
│   └── interaction decisions
├── Decisions
│   ├── accepted
│   ├── rejected
│   └── rationale
└── Agent History
    ├── generated work
    ├── reviews
    └── checkpoints
```

Required operations:

```text
get_project_memory
save_project_memory
update_project_memory
```

Never leak memory from one project into another.

---

# 5. Semantic Figma understanding

Raw Figma nodes are not enough.

Convert:

```text
FRAME
TEXT
RECTANGLE
INSTANCE
```

into semantic concepts such as:

```text
Sidebar
Navigation
PrimaryButton
MetricCard
DeploymentTable
TopologyVisualization
SearchField
Modal
EmptyState
ErrorState
```

Architecture:

```text
Figma node tree
 ↓
Node normalization
 ↓
Pattern recognition
 ↓
Semantic classification
 ↓
Project model
```

Store confidence:

```json
{
  "nodeId": "40:317",
  "semanticType": "MetricCard",
  "confidence": 0.94
}
```

Low-confidence classifications must not trigger destructive automatic changes.

---

# 6. Design-system intelligence

Extract and understand:

```text
Colors
Typography
Spacing
Radius
Borders
Shadows
Components
Variants
Variables
Styles
Auto-layout patterns
Naming conventions
Navigation
Cards
Forms
Tables
Data visualization
Empty states
Errors
```

A request like:

> Create a new card.

should reuse the current card pattern rather than inventing a new one.

---

# 7. Autonomous design loop

This is the core differentiator.

Default:

```text
Understand
 ↓
Inspect
 ↓
Plan
 ↓
Generate
 ↓
Measure
 ↓
Critique
 ↓
Patch
 ↓
Verify
 ↓
Complete
```

Example:

> Make the topology screen easier to understand.

Agent should:

1. inspect the screen;
2. identify hierarchy problems;
3. identify crowded/ambiguous elements;
4. create a design plan;
5. apply native Figma changes;
6. review the result;
7. fix high-confidence problems;
8. report what changed.

---

# 8. Design Critic / QA Engine

Review dimensions:

```text
Visual hierarchy
Alignment
Spacing
Typography
Contrast
Density
Consistency
Component reuse
Information architecture
Responsive behavior
Accessibility
Content clarity
Interaction clarity
```

Example:

```text
DESIGN REVIEW

Hierarchy       84/100
Spacing         91/100
Consistency     76/100
Density         68/100
Accessibility   89/100

Issues:
1. Secondary metrics compete with the primary action.
2. Two cards use inconsistent radius.
3. Navigation has weak active-state contrast.
```

Support:

> Fix all high-confidence issues.

Only high-confidence findings should be auto-fixed.

---

# 9. Design refactoring / Design ESLint

Detect:

```text
Duplicate components
Duplicate styles
Unused styles
Inconsistent spacing
Inconsistent radius
Bad layer names
Poor auto-layout usage
Repeated UI that should be a component
Outdated components
Orphaned nodes
Inconsistent typography
Unused colors
```

Example audit:

```text
DESIGN AUDIT

128 issues found
High confidence: 42
Medium confidence: 51
Low confidence: 35

Safe:
18 duplicate layers
8 inconsistent radii
11 outdated text styles
```

Allow:

> Apply safe changes.

---

# 10. Full-flow generation

Understand product flows, not just screens.

Example:

```text
Welcome
 ↓
Automatic discovery
 ↓
Devices found
 ↓
Topology
 ↓
Model selection
 ↓
Can I run this?
 ↓
Download
 ↓
Deployment
 ↓
Running
```

The agent should generate:

- screens
- states
- shared components
- navigation relationships
- flow structure

---

# 11. State generator

Each important screen should be able to generate:

```text
Default
Loading
Empty
Success
Error
Offline
Disabled
Partial
First-time
Returning-user
Permission-required
No-results
```

Example:

> Create the Devices screen and all important states.

Expected variants:

```text
Devices — populated
Devices — loading
Devices — no devices
Devices — node offline
Devices — discovery failed
Devices — partial discovery
```

---

# 12. Responsive Design Agent

Given a desktop design:

```text
1440
 ↓
1280
 ↓
1024
 ↓
768
 ↓
390
```

The agent should decide what to:

```text
collapse
wrap
scroll
hide
reorder
simplify
convert to drawer
convert to sheet
```

Do not merely scale everything.

Example:

```text
Desktop
- sidebar
- 3-column metrics
- large topology

Tablet
- compact navigation
- 2-column metrics
- reduced topology

Mobile
- bottom navigation
- 1-column metrics
- simplified topology
```

---

# 13. Exploration / Alternatives

Allow:

> Give me three directions.

Create:

```text
A — Minimal
B — Data-rich
C — Editorial
```

All should be native Figma frames.

Then support:

> Combine B's information hierarchy with A's visual language.

The agent generates a fourth direction.

---

# 14. Compare and choose

For each direction, summarize tradeoffs:

```text
OPTION A
Better clarity
Lower density

OPTION B
Higher information density
Better for expert users

OPTION C
Higher visual impact
More interaction cost
```

The user chooses which direction to refine.

---

# 15. Content intelligence

Avoid lorem ipsum.

Generate realistic:

```text
Product copy
Empty states
Error messages
Table data
Device names
Model names
Statuses
Edge cases
```

Respect constraints such as:

> Keep every button label below 18 characters.

---

# 16. Asset intelligence

Assets should be first-class.

Capabilities:

```text
Search approved asset library
Choose best-fit asset
Evaluate aspect ratio
Crop appropriately
Replace placeholders
Create image treatments
Preserve project asset conventions
```

Do not randomly invent a new visual language when project assets exist.

---

# 17. "Improve this"

Support a simple request:

> Improve this.

Offer focused options:

```text
Improve hierarchy
Reduce density
Improve accessibility
Simplify layout
Increase consistency
Improve copy
Make responsive
Use existing design system
```

The user can choose one or more.

---

# 18. Explain this design

The agent should be able to explain existing decisions.

Example:

> Why is this card here?

Possible response:

```text
This card appears to duplicate information already
shown in the deployment summary.

Recommendation:
remove the card and promote throughput into
the performance section.

Confidence: High
```

It should explain both product and design rationale where recoverable from the project.

---

# 19. Design branches / checkpoints

Major agent operations create checkpoints:

```text
V1 — Original
V2 — Simplified
V3 — Higher hierarchy
V4 — Mobile adaptation
```

Support:

```text
Create checkpoint
Compare checkpoint
Restore checkpoint
Branch checkpoint
```

Long-lived versioning must not depend only on native Figma undo.

---

# 20. Controlled autonomy

Large changes should produce a proposal first.

Example:

```text
PROPOSED CHANGE

The agent will:
- replace 6 duplicate card patterns
- convert 18 spacing values to existing variables
- rename 43 layers
- rebuild the sidebar using the existing component

Estimated nodes affected: 71
Risk: Medium

[Apply]
[Review changes]
```

Small, local, high-confidence fixes can execute directly.

---

# 21. Mission mode

Flagship capability.

Example:

> Redesign EXO's deployment experience so first-time users understand what is happening.

Workflow:

```text
Inspect product
 ↓
Read current flow
 ↓
Read design memory
 ↓
Identify friction
 ↓
Form hypotheses
 ↓
Propose direction
 ↓
Generate screens
 ↓
Generate states
 ↓
Reuse design system
 ↓
Connect flow
 ↓
Review consistency
 ↓
Fix high-confidence issues
 ↓
Create checkpoint
 ↓
Summarize
```

Mission mode is a multi-step orchestration, not one primitive tool call.

---

# 22. Design-to-code loop

When a code integration exists:

```text
Figma
 ↓
Design Agent
 ↓
Code representation
 ↓
Running product
 ↓
Visual comparison
 ↓
Design/code correction
```

Detect:

```text
Visual drift
Spacing differences
Typography differences
Component mismatch
Missing states
Missing interactions
```

Support both directions:

```text
Figma → implementation
implementation → Figma
```

Only apply changes to the chosen source of truth.

---

# 23. Production drift detection

Support:

> Compare this approved Figma screen with production.

Report:

```text
Visual drift
- button height differs
- spacing differs
- typography differs
- radius differs

Content drift
- production includes another status
- production copy differs

State drift
- loading state is missing in Figma
```

Then propose which side should be updated.

---

# 24. Semantic naming

Automatically maintain meaningful names.

Bad:

```text
Frame 102
Group 17
Rectangle 3
Text 48
```

Good:

```text
Sidebar
Navigation
Primary Button
Deployment Card
Throughput Value
Topology Header
Error Message
```

Follow project naming conventions.

---

# 25. Accessibility audit

Audit:

```text
Contrast
Text size
Interactive target size
Hierarchy
Focus states
Error clarity
Disabled states
Color dependence
```

Flag uncertainty instead of pretending every issue can be inferred perfectly from Figma structure.

---

# 26. Design constraints

Allow users to define:

```text
No new colors
Use current components
Desktop only
Use 8px spacing system
No gradients
Maximum 3 metric cards
Primary CTA must remain visible
```

Represent as:

```json
{
  "hardConstraints": [
    "Do not introduce new colors",
    "Preserve primary CTA"
  ],
  "softConstraints": [
    "Prefer existing components"
  ]
}
```

Hard constraints cannot be violated silently.

---

# 27. Intent memory

Remember the reasoning behind major design decisions.

Example:

```text
Decision:
Topology is the primary visualization.

Reason:
It communicates distributed compute and differentiates
EXO from traditional model interfaces.

Status:
Accepted
```

Store rationale separately from raw Figma properties.

---

# 28. Agent activity log

Provide an audit trail:

```text
21:49 Connected to Figma
21:49 Inspected current page
21:50 Found existing card component
21:50 Generated deployment plan
21:51 Created 5 screens
21:52 Ran consistency review
21:52 Fixed 3 spacing issues
21:53 Created checkpoint
```

The user can request the log at any time.

---

# 29. Confidence-aware autonomy

Every important inference should have confidence.

```json
{
  "finding": "These two cards are duplicates",
  "confidence": 0.97
}
```

Suggested policy:

```text
0.90–1.00
safe to auto-fix

0.75–0.89
suggest + approval

0.50–0.74
observation only

<0.50
do not act automatically
```

Make thresholds configurable.

---

# 30. Internal Design Intermediate Representation

Introduce an intermediate model between model reasoning and Figma operations.

```text
User intent
 ↓
Design Plan
 ↓
Semantic Design Model
 ↓
Component/Layout Tree
 ↓
Validated Design Operations
 ↓
Figma Plugin
```

Example:

```json
{
  "screen": {
    "type": "dashboard",
    "purpose": "monitor active inference"
  },
  "layout": {
    "type": "sidebar-content",
    "sidebarWidth": 190
  },
  "components": [
    {
      "type": "MetricCard",
      "title": "Throughput"
    }
  ]
}
```

Do not make the AI reason directly in low-level Figma operations for large tasks.

---

# 31. Visual review architecture

Preferred loop:

```text
Figma
 ↓
Native inspection
 ↓
Screenshot/render
 ↓
Vision-capable reviewer
 ↓
Structured critique
 ↓
Patch proposal
 ↓
Figma Plugin
 ↓
Re-review
```

The reviewer should not directly mutate Figma.

The executor applies validated patches.

---

# 32. Project isolation

Each project has:

```text
projectId
memory
design-system snapshot
decision history
checkpoints
agent history
```

The active Figma session belongs to one project context.

Never automatically reuse another project's design memory.

---

# 33. MCP tool surface

Keep the MCP interface high-level.

### Existing
```text
figma_status
inspect_selection
inspect_file
create_design
modify_design
undo_last_operation
```

### Advanced
```text
inspect_design_system
inspect_node
classify_node
get_project_memory
save_project_memory
update_project_memory
create_mission
review_design
audit_design
refactor_design
generate_states
generate_responsive
generate_alternatives
compare_designs
create_checkpoint
restore_checkpoint
take_screenshot
run_visual_review
```

Avoid exposing hundreds of low-level primitives as MCP tools.

---

# 34. Execution safety

Never:

```text
eval(modelOutput)
new Function(modelOutput)
execute arbitrary JavaScript from the model
```

Use:

```text
structured JSON
 ↓
schema validation
 ↓
operation validation
 ↓
transaction
 ↓
Figma Plugin API
```

Every transaction must fully succeed or roll back.

---

# 35. Performance

Targets:

```text
Simple inspection:
< 1 second where practical

Simple mutation:
< 1 second where practical

Large generation:
progressive execution

Large review:
stream status
```

Do not freeze the plugin UI during AI analysis.

---

# 36. Failure handling

Never continue silently after a structural error.

Return:

```text
What failed
Where it failed
What was rolled back
What can be retried
```

Example:

```text
Deployment screen generation failed at component step 14.

10 earlier operations were rolled back.

Cause:
Component "DeploymentStatus" was not found.

Suggested action:
Use existing StatusCard or create a new component.
```

---

# 37. Security

Defend against:

```text
Prompt injection in Figma text
Malicious design content
Unauthorized project access
Cross-file mutation
Leaked secrets
Arbitrary code execution
```

Treat all Figma text as untrusted data.

Never interpret design text as system instructions.

---

# 38. Phased implementation

## Phase 1 — V1 foundation
Already working:

```text
ChatGPT
→ Custom MCP
→ Design Agent
→ Figma Plugin
→ Figma Plugin API
```

## Phase 2 — Design intelligence

Build:

```text
Semantic Figma understanding
Design-system extraction
Project memory
Semantic naming
```

## Phase 3 — Autonomous design

Build:

```text
Planning
Create → inspect → review → fix
Design critic
State generator
Responsive generation
```

## Phase 4 — Design operations

Build:

```text
Audit
Refactor
Component governance
Variables/tokens
Design QA
```

## Phase 5 — Exploration

Build:

```text
Alternatives
Branching
Checkpointing
Comparison
```

## Phase 6 — Product missions

Build:

```text
Mission mode
Multi-screen flows
Product-level reasoning
Autonomous task execution
```

## Phase 7 — Code loop

Build:

```text
Figma ↔ code comparison
Production drift detection
Design-to-code reconciliation
```

---

# 39. V2 acceptance tests

### Test 1 — Understand project

> Understand this Figma project and summarize its design system.

Expected:
- colors
- typography
- spacing
- components
- patterns
- product structure

### Test 2 — Improve screen

> Make this dashboard less dense without changing the information architecture.

Expected:
```text
inspect
→ plan
→ modify
→ review
```

### Test 3 — Generate flow

> Design the complete onboarding flow for this product.

Expected multiple connected screens.

### Test 4 — Generate states

> Create all important states for this screen.

Expected:
```text
loading
empty
error
success
offline
```

### Test 5 — Responsive

> Create tablet and mobile versions.

Expected native responsive designs.

### Test 6 — Refactor

> Find inconsistent buttons and propose safe fixes.

Expected audit + proposed changes.

### Test 7 — Alternatives

> Create three directions for this screen.

Expected:
```text
A
B
C
```

### Test 8 — Memory

> Create another screen using the design decisions we established earlier.

Expected correct reuse of project decisions.

### Test 9 — Mission

> Redesign this flow to make first-time users understand it faster.

Expected:
```text
inspect
→ diagnose
→ propose
→ create
→ review
→ fix
```

---

# 40. UX target

Ideal experience:

```text
User:
"Make EXO's deployment flow easier for first-time users."

Design Agent:
Analyzing current flow...
Found 6 screens.
Found 12 reusable components.
Found 4 UX issues.

I recommend:
1. Make deployment state explicit.
2. Explain shard placement.
3. Show what EXO is doing at each step.
4. Reduce advanced configuration.

Creating a revised flow...
```

Then native Figma changes appear without the user managing API calls.

---

# 41. Differentiation

Do not compete by exposing more Figma API operations.

Compete on:

```text
Understanding
Planning
Memory
Product thinking
Design critique
Autonomy
Consistency
Design-system governance
Exploration
Responsive adaptation
State completeness
Product flows
```

The positioning is:

```text
Figma MCP
=
AI ↔ Figma connectivity

Design Agent
=
AI product designer ↔ Figma execution
```

The product is a **design intelligence layer built on top of Figma**.

---

# 42. Immediate engineering priority

Do not implement every feature simultaneously.

Next milestone:

```text
1. Semantic file understanding
2. Project design memory
3. Design-system extraction
4. Design reviewer
5. Create → review → fix loop
```

Then:

```text
6. State generator
7. Responsive agent
8. Alternatives
9. Refactoring
10. Mission mode
```

---

# 43. Coding-agent instruction

You are the CTO and lead engineer for this product.

The current V1 already supports:

```text
ChatGPT
→ Custom MCP
→ Design Agent
→ Figma Plugin
→ Figma Plugin API
```

Do not rebuild that foundation.

Extend it.

The first implementation milestone is:

```text
INSPECT PROJECT
      ↓
UNDERSTAND DESIGN SYSTEM
      ↓
CREATE DESIGN PLAN
      ↓
EXECUTE NATIVE FIGMA CHANGES
      ↓
REVIEW RESULT
      ↓
PATCH HIGH-CONFIDENCE ISSUES
```

The user should be able to say:

> Improve this screen.

and the agent should understand the screen, identify meaningful problems, make sensible native Figma changes, and verify the result.

Optimize for:

**quality of design reasoning + quality of native execution.**
