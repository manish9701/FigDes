# FigDes Native Design Agent — Coding Agent Implementation Spec

**Repository:** `manish9701/FigDes`  
**Reviewed commit:** `7c20fa9399ac055687d2180f547fb239188bbe90`  
**Objective:** make FigDes a real Figma-native design agent rather than a semantic UI generator with a small native wrapper.

---

## 1. Current status

The latest commit is a **real improvement**. Native execution now reaches the Figma plugin and calls real Figma Plugin API methods instead of routing native scripts through the old operation compiler.

Current path:

```text
LLM
  ↓
figdes_use_figma
  ↓
Node VM / safe script
  ↓
Session RPC
  ↓
Figma plugin main thread
  ↓
nativeExecutor.ts
  ↓
Figma Plugin API
```

This fixes the largest problem from the previous implementation.

However, the native API is still too small, some methods are stubs, visual inspection is still heavily metadata-driven, and the Art Director still tends toward predefined composition vocabulary.

**Do not spend the next iteration adding more screen archetypes or dashboard components. Fix the native design engine and visual loop first.**

---

# 2. Target architecture

Build toward:

```text
USER REQUEST
    ↓
PRODUCT INTENT
    ↓
UX / INFORMATION HIERARCHY
    ↓
ART DIRECTOR
    ↓
COMPOSITION GENERATOR
    ├── Semantic candidate
    ├── Native candidate
    ├── Hybrid candidate
    └── 2–4 alternatives
    ↓
EXECUTION ROUTER
    ├── Semantic Executor
    ├── Native Executor
    └── Hybrid Executor
    ↓
REAL FIGMA CANVAS
    ↓
STRUCTURAL INSPECTION
    ↓
SCREENSHOT / IMAGE REVIEW
    ↓
STRUCTURAL CRITIC + VISION CRITIC
    ↓
REVISION PLAN
    ↓
TARGETED NATIVE MODIFICATIONS
    ↺
FINAL DESIGN
```

The key principle is:

```text
Semantic UI = WHAT exists
Art Direction = HOW it should feel
Composition = HOW elements relate
Native execution = HOW relationships become Figma geometry
Visual review = WHETHER it actually works
Iteration = HOW quality improves
```

---

# 3. Required implementation order

```text
P0  Complete native API
P1  Components / variants / variables / styles
P2  Geometry / paint / typography / vectors / effects
P3  Native transaction + batching
P4  Screenshot-aware visual inspection
P5  Vision critic + visual comparison
P6  Art Director relationship model
P7  Executable composition alternatives
P8  Native / Hybrid execution router
P9  Agent skills + MCP instruction cleanup
P10 EXO Consumer + Enterprise acceptance tests
```

---

# 4. `mcp-server/src/native/use-figma.ts`

Keep the VM sandbox, but turn `fig` into a complete controlled design API.

**Do not expose the raw global `figma` object.**

The API needs these groups.

## 4.1 Document / inspection

```ts
fig.currentPage()
fig.pages()
fig.getSelection()
fig.setSelection(nodeIds)
fig.find(query, root?)
fig.getNode(id)
fig.getChildren(id)
fig.getParent(id)
fig.getBounds(id)
fig.getAbsoluteBounds(id)
fig.getProperties(id)
fig.inspect(id, options?)
```

Example:

```js
const matches = await fig.find({ name: "Runtime", type: "FRAME" });
const bounds = await fig.getBounds(matches[0].id);
const details = await fig.inspect(matches[0].id, {
  depth: 3,
  includeText: true,
  includeStyles: true,
  includeEffects: true
});
```

`getBounds()` must remain a **read** operation. Never combine reading geometry with mutation.

---

# 5. Node creation

Implement:

```ts
fig.createFrame(options)
fig.createRectangle(options)
fig.createEllipse(options)
fig.createPolygon(options)
fig.createStar(options)
fig.createLine(options)
fig.createVector(options)
fig.createText(options)
fig.createGroup(options)
fig.createComponent(options)
fig.createInstance(options)
```

Each creation function should return a complete serializable node summary:

```json
{
  "id": "123:456",
  "type": "FRAME",
  "name": "Runtime Visual",
  "x": 120,
  "y": 80,
  "width": 720,
  "height": 560,
  "children": 3
}
```

---

# 6. Generic node mutation

Implement:

```ts
fig.rename(node, name)
fig.setPosition(node, { x?, y? })
fig.setSize(node, { width?, height? })
fig.setBounds(node, { x?, y?, width?, height? })
fig.setRotation(node, degrees)
fig.setOpacity(node, opacity)
fig.setVisible(node, visible)
fig.setBlendMode(node, mode)
fig.setClipContent(node, value)
fig.setConstraints(node, constraints)
fig.remove(node)
fig.clone(node, options?)
fig.append(parent, child)
fig.insertChild(parent, child, index)
fig.reorder(parent, child, index)
```

Reject invalid numbers and invalid node types with structured errors.

---

# 7. Geometry / vectors

The current native layer must go beyond rectangles.

Implement:

```ts
fig.setCornerRadius(node, radius)
fig.setIndividualCornerRadii(node, radii)
fig.setArcData(node, data)
fig.setVectorGeometry(node, geometry)
fig.setPathData(node, path)
```

Support an allowlisted path format:

```ts
[
  { command: "M", x, y },
  { command: "L", x, y },
  { command: "C", x1, y1, x2, y2, x, y },
  { command: "Q", x1, y1, x, y },
  { command: "A", ... },
  { command: "Z" }
]
```

This is required for topology, technical diagrams, custom brand geometry, rings, orbit visuals and non-box compositions.

---

# 8. Paint / fill

Current `setFill` is too limited.

Implement:

```ts
fig.setFill(node, paint)
fig.setFills(node, paints)
fig.clearFill(node)
```

Support at least:

```ts
SOLID
GRADIENT_LINEAR
GRADIENT_RADIAL
GRADIENT_ANGULAR
IMAGE
```

Do not silently downgrade unsupported paint types.

---

# 9. Stroke

Implement:

```ts
fig.setStroke(node, {
  paints,
  weight,
  align,
  dashPattern,
  cap,
  join
})
```

Support the Figma stroke alignment/cap/join combinations applicable to the target node.

---

# 10. Effects — remove the current stub

Current implementation effectively clears effects. That must be replaced.

Implement:

```ts
fig.setEffects(node, effects)
```

Support:

```text
DROP_SHADOW
INNER_SHADOW
LAYER_BLUR
BACKGROUND_BLUR
```

Example:

```ts
await fig.setEffects(card, [
  {
    type: "DROP_SHADOW",
    color: { r: 0, g: 0, b: 0, a: 0.18 },
    offset: { x: 0, y: 12 },
    radius: 30,
    spread: 0
  }
]);
```

---

# 11. Typography

The current API only changes font size. Replace it with a real typography API.

Implement:

```ts
fig.loadFont(font)
fig.setTypography(node, {
  family?,
  style?,
  size?,
  lineHeight?,
  letterSpacing?,
  textCase?,
  textDecoration?,
  horizontalAlign?,
  verticalAlign?,
  paragraphSpacing?,
  paragraphIndent?,
  resizing?,
  maxLines?
})
fig.setTextContent(node, content)
fig.setTextRangeStyle(node, range, style)
```

Required behavior:

1. Resolve the requested font.
2. `await figma.loadFontAsync(...)` before changing font properties.
3. Return a clear error when the font is unavailable.
4. Do not silently substitute another font.

---

# 12. Auto Layout

Support:

```ts
fig.setAutoLayout(node, {
  direction,
  primaryAxisSizing,
  counterAxisSizing,
  primaryAxisAlignItems,
  counterAxisAlignItems,
  itemSpacing,
  paddingTop,
  paddingRight,
  paddingBottom,
  paddingLeft,
  layoutWrap,
  counterAxisAlignContent
})
```

And helpers:

```ts
fig.setPadding(node, padding)
fig.setGap(node, gap)
fig.setAlignment(node, alignment)
```

Use constraints and relationships instead of hard-coding every x/y.

---

# 13. Components

Do not claim support unless it actually works.

Implement:

```ts
fig.findComponents(query?)
fig.getComponent(id)
fig.createComponent(options)
fig.createComponentSet(componentIds)
fig.createInstance(component)
fig.detachInstance(instance)
fig.getComponentProperties(instance)
fig.setComponentProperty(instance, property, value)
```

Return:

```json
{
  "id": "123:456",
  "type": "COMPONENT",
  "name": "Device Status",
  "componentSetId": null,
  "properties": []
}
```

---

# 14. Variants

Do not cast a `COMPONENT_SET` directly as a `ComponentNode` and assume `createInstance()` is correct.

Implement:

```ts
fig.getVariants(componentSet)
fig.getVariantProperties(component)
fig.setVariant(instance, {
  properties: {
    State: "Selected",
    Size: "Large",
    Theme: "Dark"
  }
})
```

Resolve the actual variant component first, then create the instance.

---

# 15. Variables

The current `setVariable` is a stub.

Implement:

```ts
fig.listVariables()
fig.findVariable(query)
fig.createVariable(options)
fig.setVariableValue(variable, value)
fig.bindVariable(node, property, variable)
fig.unbindVariable(node, property)
```

Support relevant types:

```text
COLOR
FLOAT
STRING
BOOLEAN
```

Use actual variable bindings for fill, stroke, opacity, spacing, radii and other supported Figma properties.

---

# 16. Styles

Implement:

```ts
fig.listStyles()
fig.findStyle(query)
fig.createPaintStyle(options)
fig.createTextStyle(options)
fig.createEffectStyle(options)
fig.applyStyle(node, styleId)
fig.removeStyle(node, type)
```

Always inspect first so duplicate styles are not created.

---

# 17. Native transactions

Native execution must be undoable as one conceptual action.

Required flow:

```text
start transaction
  ↓
run native calls
  ↓
success → commit
  ↓
error → rollback
```

Use Figma undo grouping where practical. The important requirement is that a failed generation does not leave a half-built composition behind.

Return:

```json
{
  "status": "failed",
  "rolledBack": true,
  "error": {
    "code": "INVALID_NODE_TYPE",
    "action": "setTypography",
    "target": "123:456",
    "message": "Target is RECTANGLE; typography requires TEXT.",
    "recovery": "Find a TEXT child or create a text node."
  }
}
```

---

# 18. Native script sandbox

Keep the VM approach, but expose only:

```text
fig
console
Math
JSON
Date
```

Never expose:

```text
figma
process
require
fs
child_process
fetch
WebSocket
eval
Function
```

Add limits:

```ts
MAX_SCRIPT_SIZE = 100_000
MAX_RPC_CALLS = 1_000
TIMEOUT_MS = 30_000
```

Count every native RPC call and reject scripts that exceed the budget.

---

# 19. Refactor `nativeExecutor.ts`

Do not allow one giant switch to become the permanent architecture.

Refactor to:

```text
figma-plugin/src/native/
  index.ts
  create.ts
  inspect.ts
  geometry.ts
  paint.ts
  vectors.ts
  typography.ts
  layout.ts
  components.ts
  variants.ts
  variables.ts
  styles.ts
  effects.ts
  transaction.ts
```

`nativeExecutor.ts` can remain as the dispatcher, but each action should call a typed module.

---

# 20. Render / screenshot loop

The repo already has a useful renderer in:

```text
figma-plugin/src/render.ts
mcp-server/src/render-tool.ts
```

Reuse it.

It already provides:

```text
PNG/JPG export
image blocks to MCP
max width
low/high detail
render budget
base64 conversion
```

The issue is that `figdesInspectVisualHandler()` still derives focal information mostly from metadata and currently sets focal candidates from largest objects.

---

# 21. Upgrade `figdes_inspect_visual`

Return both structural data and an image.

Structure:

```json
{
  "canvas": {},
  "nodes": [],
  "textHierarchy": [],
  "surfaceAnalysis": {},
  "componentUsage": {},
  "alignmentAnalysis": {},
  "spacingAnalysis": {},
  "focalCandidates": [],
  "image": "MCP image content block"
}
```

Use the existing `render_node` pipeline rather than duplicating `exportAsync` logic.

---

# 22. Focal analysis

Do not delete area as a signal, but stop using:

```ts
focalCandidates = largestObjects;
```

as the complete answer.

Calculate focal score from multiple signals:

```text
area ratio
relative size
contrast
saturation
whitespace isolation
position
text scale
edge density
semantic importance
component role
```

Example:

```ts
function focalScore(node: VisualNode): number {
  return (
    normalize(node.areaRatio) * 0.15 +
    normalize(node.contrast) * 0.20 +
    normalize(node.whitespaceIsolation) * 0.15 +
    normalize(node.semanticPriority) * 0.25 +
    normalize(node.sizeHierarchy) * 0.10 +
    normalize(node.positionFocus) * 0.05 +
    normalize(node.edgeDensity) * 0.10
  );
}
```

Weights are tunable; the key requirement is that a huge background frame cannot automatically beat the actual primary interaction.

---

# 23. Vision critique

Add a vision-aware critique result:

```ts
interface VisionCritique {
  focalPoint: {
    nodeId?: string;
    description: string;
    confidence: number;
  };
  hierarchy: { score: number; issues: string[] };
  composition: { score: number; issues: string[] };
  density: { score: number; issues: string[] };
  whitespace: { score: number; issues: string[] };
  repetition: { score: number; issues: string[] };
  templateSimilarity: { score: number; reasons: string[] };
  overall: number;
  topFixes: Array<{
    priority: number;
    issue: string;
    targetNodeIds: string[];
    suggestedChange: string;
  }>;
}
```

The model should be able to see the screenshot through the MCP image block.

---

# 24. Two-layer visual review

Always combine:

```text
STRUCTURAL CRITIC
  metadata / geometry / rules
        +
VISION CRITIC
  screenshot / visual judgement
        ↓
MERGED CRITIQUE
```

Structural critic catches:

```text
bad spacing
duplicate styles
missing components
invalid constraints
token misuse
accessibility
card walls
```

Vision critic catches:

```text
weak focal point
visual imbalance
boring composition
awkward rhythm
weak branding
visual noise
template feel
```

---

# 25. Revision loop

Use:

```text
BUILD
 ↓
RENDER LOW
 ↓
CRITIQUE
 ↓
SELECT TOP 3 ISSUES
 ↓
NATIVE PATCH
 ↓
RENDER LOW
 ↓
COMPARE
 ↓
PASS / WATCH / FAIL
```

Do not render after every node creation. Three renders are generally sufficient:

```text
composition
refinement
final
```

---

# 26. Visual comparison

Add:

```ts
compareVisuals(before, after)
```

Compare at least:

```text
focal region
occupied area
edge density
surface count
whitespace
text hierarchy
main alignment axes
```

Return:

```json
{
  "improved": true,
  "confidence": 0.89,
  "changes": [
    "Primary visual now dominates before metadata.",
    "Card-wall tendency decreased.",
    "Negative-space separation improved."
  ]
}
```

If a vision model is available, compare screenshots directly as well.

---

# 27. Art Director redesign

Keep existing composition labels such as `editorial`, `instrument`, `spatial`, `topology`, etc. as hints, but do not let them become templates.

Change the Art Director to produce relationships:

```ts
interface ArtDirection {
  visualCharacter: string;
  focal: {
    object: string;
    relativeWeight: number;
    position: string;
  };
  hierarchy: Array<{
    element: string;
    weight: number;
  }>;
  compositionRelationships: Array<{
    subject: string;
    relation:
      | "dominates"
      | "supports"
      | "anchors"
      | "surrounds"
      | "aligns-with"
      | "offsets"
      | "opposes"
      | "floats-near"
      | "separates";
    target: string;
    strength: number;
  }>;
  whitespaceStrategy: string;
  rhythmStrategy: string;
  typographyStrategy: string;
  surfaceStrategy: string;
  colorStrategy: string;
  depthStrategy: string;
  rejectGenericDashboard: boolean;
  reasonsToReject: string[];
}
```

The Art Director should describe **why** elements relate, not only choose a layout preset.

---

# 28. Executable composition alternatives

Current composition alternatives need to become actual candidates.

Use:

```ts
interface CompositionCandidate {
  id: string;
  name: string;
  artDirection: ArtDirection;
  executionMode: "semantic" | "native" | "hybrid";
  program: unknown;
  expectedStrengths: string[];
  expectedWeaknesses: string[];
}
```

Example:

```text
Candidate A — Editorial
Candidate B — Instrument
Candidate C — Spatial
```

At least the strongest two should be renderable for important screens so the system can compare them instead of only describing them.

---

# 29. Native / Hybrid router

Choose execution mode **after Art Direction**.

## Semantic

Use for:

```text
settings
standard forms
tables
simple lists
CRUD-heavy screens
repeated internal UI
```

## Native

Use for:

```text
hero compositions
spatial interfaces
topology
custom diagrams
model-fit visualization
custom illustration
data visualization
brand-critical screens
unusual navigation
```

## Hybrid

Use for:

```text
custom composition
+
existing components
+
design system tokens
```

**Hybrid should be the normal choice for premium EXO product screens.**

---

# 30. MCP instruction change

Update `mcp-server/src/mcp.ts` so the model is not forced back into the semantic renderer.

Replace universal guidance like:

```text
Build screens with design_runtime.
```

with:

```text
Choose execution mode after Art Direction.

Semantic Mode: use design_runtime for predictable repeated UI.

Native Mode: use figdes_use_figma when visual composition itself is important,
when custom geometry is required, or when the screen cannot be expressed
without template-like constraints.

Hybrid Mode: use design_runtime for reusable structure and Native Mode for
composition-led regions.

For premium or visually distinctive EXO screens, prefer Hybrid or Native.
```

---

# 31. Generation skill

Expand `.agents/skills/figdes-generate-design/SKILL.md` into this mandatory workflow:

```text
1. figma_status
2. inspect_design_system
3. inspect_file / inspect_selection
4. design_brief when useful
5. plan_screen
6. Art Director
7. generate 2–3 composition candidates
8. choose Semantic / Native / Hybrid
9. build
10. render
11. critique
12. patch
13. render again
14. final QA
```

Explicit anti-pattern:

```text
Do not default to sidebar + header + KPI cards + table.
Do not use cards as the default answer to grouping.
Do not use a composition preset as a substitute for Art Direction.
```

---

# 32. Visual review skill

Expand `.agents/skills/figdes-visual-review/SKILL.md` to require:

```text
1. structural inspection
2. screenshot
3. visual judgement
4. structural judgement
5. merge findings
6. fix the highest-value problems
7. screenshot again
8. compare
9. stop at quality threshold
```

Explicitly forbid:

```text
largest object = focal point
```

as the sole focal heuristic.

---

# 33. Template detection

Add a template-feel rule.

Detect patterns like:

```text
sidebar
+
header
+
3–5 equal KPI cards
+
table
```

or:

```text
sidebar
+
hero card
+
3 equal panels
```

If this structure appears without product-specific evidence:

```text
WATCH / FAIL
```

Example finding:

```json
{
  "rule": "template-feel",
  "severity": "serious",
  "title": "Composition resembles a generic SaaS dashboard",
  "evidence": {
    "equalWeightPanels": 4,
    "cardAreaRatio": 0.67,
    "sidebar": true
  },
  "guidance": "Try an editorial, instrument, spatial or native composition."
}
```

---

# 34. Quality score

Use a multi-axis quality score as a decision aid:

```text
hierarchy       15%
composition     15%
visual balance  10%
whitespace      10%
typography      10%
consistency     10%
product fit     15%
originality     10%
accessibility    5%
```

Do not treat the score as truth. It is a prioritization mechanism.

---

# 35. Keep the semantic engine

Do NOT rewrite the whole system.

Keep:

```text
design_runtime
Design IR
OperationSchema
review_design
design_guard
component system
token system
snapshots
undo
```

Add Native Mode beside it:

```text
                    ┌──────────────┐
                    │ Semantic     │
                    │ Executor     │
                    └──────┬───────┘
                           │
REQUEST → ART DIRECTOR → ROUTER
                           │
              ┌────────────┼────────────┐
              ↓            ↓            ↓
          Semantic       Hybrid       Native
              ↓            ↓            ↓
           compiler       both      native API
              └────────────┼────────────┘
                           ↓
                      Figma Canvas
```

---

# 36. Native transaction / batching performance

Avoid thousands of individual websocket round trips for large compositions.

After correctness is stable, add:

```ts
fig.batch([...calls])
```

or a queued model with:

```ts
await fig.commit()
```

Desired architecture:

```text
script
 ↓
batched native calls
 ↓
plugin
 ↓
one conceptual transaction
```

rather than one network round trip per primitive.

Target rough performance:

```text
small screen    < 2s
medium screen   < 5s
large screen    < 15s
```

Treat these as engineering targets, not guarantees.

---

# 37. Security

The VM must never expose:

```text
process
require
fs
child_process
network
WebSocket
eval
Function constructor
raw figma global
```

Use:

```text
script length limit
execution timeout
RPC call limit
argument schemas
node id validation
action allowlist
```

---

# 38. Tool description accuracy

Update the `figdes_use_figma` MCP description so it only claims implemented features.

Recommended wording:

```text
Execute controlled JavaScript against the FigDes native design API.

Supports:
- node inspection and querying
- native node creation/modification
- typography
- fills, gradients, strokes and effects
- vectors and custom paths
- auto-layout and constraints
- components and instances
- variants
- variables and styles
- cloning, grouping and reordering
- geometry inspection
- transactional execution

Does not expose the raw global Figma API.
```

Do not claim a capability while its implementation is still a stub.

---

# 39. EXO-specific separation

Do not hard-code EXO product rules into `nativeExecutor.ts`.

Put them in:

```text
.agents/skills/exo-consumer/SKILL.md
.agents/skills/exo-enterprise/SKILL.md
design_guard
project_memory
```

The native engine must remain product-agnostic.

EXO rules should emphasize:

```text
technical
quiet
premium
spatial
precise
high information density when justified
```

Avoid:

```text
generic SaaS dashboards
unnecessary cards
purple-gradient AI clichés
marketing-hero behavior inside product UI
equal-weight panels
decorative charts
```

---

# 40. Example target native script

The final API should make a composition like this feasible:

```js
const root = await fig.createFrame({
  name: "EXO Runtime",
  width: 1440,
  height: 900,
  fill: { color: "#0B0C0E" }
});

await fig.setAutoLayout(root, {
  direction: "VERTICAL",
  padding: { top: 48, right: 48, bottom: 48, left: 48 }
});

const title = await fig.createText({
  parent: root,
  content: "Runtime",
  font: {
    family: "Inter",
    style: "Semi Bold",
    size: 42,
    lineHeight: 48
  },
  fill: { color: "#FFFFFF" }
});

const visual = await fig.createFrame({
  parent: root,
  name: "Topology",
  width: 960,
  height: 560,
  fill: { color: "#111318" }
});

await fig.setCornerRadius(visual, 28);

await fig.createVector({
  parent: visual,
  name: "Compute Orbit",
  path: [
    { command: "M", x: 140, y: 280 },
    { command: "C", x1: 180, y1: 80, x2: 620, y2: 80, x: 820, y: 280 },
    { command: "C", x1: 620, y1: 480, x2: 180, y2: 480, x: 140, y: 280 }
  ],
  stroke: {
    color: "#7C83FF",
    width: 2,
    opacity: 0.65
  },
  fill: null
});

const bounds = await fig.getBounds(visual);

await fig.setPosition(title, {
  x: 0,
  y: 0
});
```

The exact syntax can differ. The important requirement is that the native API can express the composition without converting it back into a predefined dashboard layout.

---

# 41. Testing requirements

Add unit/integration tests for:

```text
create frame
create text
create rectangle
create ellipse
create vector
get bounds
set bounds
position
rotation
opacity
fills
gradients
strokes
effects
typography
auto layout
constraints
append
clone
remove
components
instances
variants
variables
styles
find
inspect
selection
transaction rollback
script timeout
script call limit
invalid node type
missing node
missing font
```

Also add a native integration fixture that:

```text
creates root
creates typography
creates vector
creates component
creates instance
applies style
binds variable
sets auto layout
renders
inspects
```

and verifies all results from actual Figma nodes.

---

# 42. EXO acceptance tests

## Consumer — Model Fit

The engine must be able to create a layout with:

```text
model identity
large fit result
hardware / topology relationship
memory / compute information
one clear primary action
```

without automatically producing:

```text
3 KPI cards
sidebar
header-heavy SaaS shell
table-first interface
```

## Consumer — Runtime

The visual hierarchy must prioritize:

```text
running model
active devices
performance
status
```

## Enterprise — Fleet

The composition must communicate:

```text
fleet scale
site structure
device health
capacity
team usage
```

without automatically becoming a KPI dashboard.

## Enterprise — Topology

Must support:

```text
nodes
edges
selection
labels
health states
```

using true vector/line capabilities.

---

# 43. Definition of done

## Native execution

- [ ] Native mode does not route through the old operation compiler.
- [ ] Native scripts reach actual Figma Plugin API methods.
- [ ] Native execution is transactional / rollback-safe.
- [ ] Native inspection returns real node state.
- [ ] Vectors are supported.
- [ ] Typography is fully supported.
- [ ] Fills / gradients are supported.
- [ ] Strokes are supported.
- [ ] Effects are real, not stubs.
- [ ] Auto-layout is supported.
- [ ] Constraints are supported.
- [ ] Components work.
- [ ] Instances work.
- [ ] Variants work.
- [ ] Variables work.
- [ ] Styles work.
- [ ] No advertised native method remains a stub.

## Visual intelligence

- [ ] Screenshot is part of visual review.
- [ ] Focal detection uses multiple signals.
- [ ] Structural and visual critique are merged.
- [ ] Visual critique produces actionable fixes.
- [ ] Native patching can apply critique fixes.
- [ ] Before/after comparison exists.

## Planning

- [ ] Art Director outputs relationships, not only templates.
- [ ] Composition alternatives are executable.
- [ ] Native / Hybrid routing is explicit.
- [ ] Generic dashboard detection exists.

## Agent behavior

- [ ] Generation skill contains the complete workflow.
- [ ] Visual-review skill contains the complete workflow.
- [ ] MCP instructions allow Native / Hybrid when appropriate.
- [ ] Existing components are inspected before rebuilding repeated UI.
- [ ] Important screens are rendered and critiqued.

## EXO quality

- [ ] Consumer Model Fit passes.
- [ ] Consumer Runtime passes.
- [ ] Enterprise Fleet passes.
- [ ] Enterprise Topology passes.
- [ ] Generic dashboard output is rejected unless explicitly justified.

---

# 44. What NOT to do

Do not:

```text
add another 20 dashboard components
add more screen archetypes as the primary solution
add more visual presets instead of native freedom
replace Native Mode with more JSON
hard-code EXO screens
hard-code coordinates everywhere
use SVG strings as the only escape hatch
fake component support
fake screenshot review
claim parity while methods remain stubs
```

The target is **not**:

> a better dashboard generator.

The target is:

> **a controlled native design agent that can construct, inspect, judge and revise real Figma compositions.**

---

# 45. Final handoff to the coding agent

Implement this as an architectural upgrade.

The critical loop that must exist at the end is:

```text
prompt
 ↓
product intent
 ↓
art direction
 ↓
composition alternatives
 ↓
native/hybrid execution
 ↓
real Figma nodes
 ↓
screenshot
 ↓
visual + structural critique
 ↓
top 3 targeted fixes
 ↓
native revision
 ↓
new screenshot
 ↓
final QA
```

**Do not stop when the code compiles.** The final acceptance test is whether the agent can use this architecture to make a materially different, deliberate composition instead of producing another generic SaaS dashboard.
