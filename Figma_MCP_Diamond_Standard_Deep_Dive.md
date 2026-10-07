# Figma MCP → FigDes “Diamond Standard” Deep Dive

## Executive conclusion

The biggest hidden lesson is that high-quality Figma agent output is **not primarily coming from a larger list of Figma API operations**. Figma's current stack combines:

`agent reasoning + workflow skills + rich file/design-system context + native Plugin API execution + incremental visual verification + domain-specific tools`

The `use_figma` tool is the execution layer, but Figma explicitly pairs it with skills such as `figma-use`, `figma-generate-design`, `figma-generate-library`, `figma-use-slides`, and motion/diagram workflows. Figma also exposes design-system search, libraries, variable definitions, metadata, screenshots, Code Connect, diagrams, Slides operations, generative plugins, and shaders.

That means FigDes should stop thinking only in terms of “more Figma actions”. The next major upgrade is a **workflow + context + visual iteration system around the native executor**.

---

## 1. What Figma MCP is actually doing

### Layer A — Context extraction

Before writing, the agent can inspect the file and retrieve:

- document/page structure
- metadata and node hierarchy
- design context
- libraries
- components
- variables/styles
- Code Connect mappings
- screenshots
- motion data
- design-system search results

This lets the agent infer what already exists instead of inventing a design from scratch.

### Layer B — Skill / workflow guidance

Figma's own repository now treats skills as a first-class part of the workflow.

Examples:

- `figma-use` → Plugin API execution rules and safe patterns
- `figma-generate-design` → build pages/screens incrementally using the existing design system
- `figma-generate-library` → create production-quality components with variables/tokens/variants
- `figma-use-slides` → Slides-specific creation/editing workflow
- motion/diagram skills → specialized workflows

The important discovery is that a skill is not merely documentation. It tells the agent **what sequence of actions to take, what to inspect first, what not to do, how to validate, and how to recover from errors**.

### Layer C — Native execution

`use_figma` executes JavaScript in the Figma Plugin API context. This is effectively the escape hatch from a small semantic JSON schema.

The agent can work with real Figma nodes, components, variables, auto layout, text, images, styles, Slides, FigJam objects, and more.

### Layer D — Visual verification

Figma's workflow is not “generate once and stop”. The documented workflow explicitly says to inspect first, build incrementally, verify the result, and continue refining. The `use_figma` skill also exposes inline node screenshots for visual checking.

### Layer E — Domain extensions

Current Figma tooling goes beyond normal UI screens:

- `generate_diagram` for architecture/flow/state/ER diagrams
- Figma Slides support
- code-to-canvas (`generate_figma_design`)
- generative plugins
- shader effects/fills
- external context from files, web, and connectors in the design agent

This is a major reason a generic “dashboard generator” cannot match the overall system.

---

# 2. The hidden corners that matter most

## Hidden corner #1: Skills are part of the design engine

This is probably the largest thing missing from an ordinary MCP clone.

Figma's own `figma-use` skill is mandatory before `use_figma`. It contains concrete execution rules, API gotchas, preferred patterns, error recovery, page handling, incremental construction, screenshots, and ID-return conventions.

For full-screen generation, Figma additionally uses `figma-generate-design`, which tells the agent to search and reuse the design system and assemble screens incrementally.

### Implication for FigDes

Create an equivalent **FigDes Skill Engine** instead of putting every rule into the model prompt.

Suggested skills:

- `figdes-use` — native API foundation
- `figdes-generate-screen` — full-screen workflow
- `figdes-generate-library` — component/variant/token workflow
- `figdes-brand` — logo/identity/vector workflow
- `figdes-visualize` — diagrams/infographics/data visualization
- `figdes-slides` — deck workflow
- `figdes-art-direction` — visual style/composition exploration
- `figdes-review` — visual critique/refinement

Each skill should contain:

`when to use → inspect → plan → execute → validate → recovery → examples`

This is much more powerful than adding another 50 generic commands.

---

## Hidden corner #2: Context is a graph, not a snapshot

Figma does not only give an agent a screenshot. It can expose:

`file → pages → nodes → components → libraries → variables → styles → Code Connect → screenshots`

The agent can search the connected design system instead of guessing which component to use.

### Implication for FigDes

Our `figdes_read_context` is a useful beginning, but the next level should be a **Design Context Graph**.

The agent should be able to query things such as:

- What visual language does this file use?
- What components already exist?
- Which components are preferred for this use case?
- What spacing scale is being used?
- What text hierarchy exists?
- Which colors are semantic tokens?
- What styles are repeated?
- Which pages are good visual references?
- What is the closest existing composition to the requested one?
- Which assets/icons are already available?

The output should be compact, structured context rather than dumping the entire document.

---

## Hidden corner #3: Incremental construction is a quality mechanism

Figma's published `figma-use` workflow explicitly recommends:

1. inspect first
2. create the skeleton
3. populate sections incrementally
4. screenshot/validate
5. continue/refine

It also recommends keeping operations small rather than attempting the entire design in one huge operation.

This is not just an engineering optimization. It improves design quality because the agent gets multiple opportunities to observe the canvas state and change direction.

### Implication for FigDes

The design orchestrator should become a state machine:

`DISCOVER → PLAN → SKELETON → COMPOSE → RENDER → CRITIQUE → REVISE → LOCK`

Never treat a full-screen generation call as one transaction containing the whole creative decision.

---

## Hidden corner #4: The model is allowed to use the entire native canvas

Figma's `use_figma` is intentionally general-purpose rather than a fixed UI schema.

That means the model can decide to create:

- a component
- a vector
- a boolean operation
- a custom layout
- a diagram
- a slide composition
- unusual visual geometry
- a custom effect/tool

This matters because a rigid IR like:

`sidebar + header + cards + table`

will naturally produce repetitive outputs even when the underlying model is capable of better design.

### Implication for FigDes

Keep the IR, but make it **optional**.

Use three routing modes:

`Semantic` → standard product UI
`Native` → creative/custom composition
`Hybrid` → components + custom native artwork

The agent should choose the mode per region, not only per screen.

---

## Hidden corner #5: Screenshot feedback is part of the generation loop

Figma exposes screenshots specifically to preserve visual fidelity and the `use_figma` skill supports inline node screenshots after edits.

This gives the agent a visual feedback loop:

`write → screenshot → inspect → adjust`

### Implication for FigDes

Our visual inspector should evolve from a passive reviewer into an active **Design Critic**.

It should score:

- focal point
- hierarchy
- density
- spacing rhythm
- alignment
- typography
- balance
- contrast
- repetition
- component overuse
- whitespace quality
- visual distinctiveness
- consistency with the selected art direction

Then produce a small set of high-confidence actions:

`increase title dominance`
`reduce secondary card prominence`
`remove repeated border treatment`
`rebalance left/right mass`
`increase whitespace around focal object`

The critic should be able to trigger another native edit automatically.

---

## Hidden corner #6: Figma has separate creative domains

Current Figma MCP supports Figma Design, FigJam, and Slides through the native execution tool. It also has specialized tools for diagrams, code-to-canvas, motion context, generative plugins, and shaders.

This suggests a broader architecture:

`Design Agent Core`

with specialized domain packs:

`UI / Brand / Vector / Slides / Diagram / Data Viz / Motion / Generative`

### Implication for FigDes

Do not create one giant “design generator”. Create a common orchestration core plus domain-specific design intelligence.

---

# 3. The biggest hidden distinction: Figma MCP vs Figma Design Agent

This is extremely important.

The current Figma product is no longer only “MCP”. Figma now has a dedicated **Figma Design Agent** that runs directly on the canvas.

Figma describes the agent as having deeper context about components, tokens, standards, and best practices, plus the ability to work with custom tools, skills, external context, multiple directions, and direct canvas iteration.

So when we compare FigDes against “Figma”, we need to identify which benchmark we actually mean:

### Figma MCP

Primarily the bridge/execution/context layer used by coding agents and other MCP clients.

### Figma Design Agent

A purpose-built design agent with deeper product-level context and creative workflow support.

### Diamond-standard target for FigDes

We should combine the best parts of both:

`MCP-like native control`
+
`Figma skill-style workflows`
+
`Design Agent-level visual reasoning`
+
`our own visual critic`
+
`our own art-direction system`

That is a much more ambitious and useful target than “copy Figma MCP”.

---

# 4. What Figma does that explains the “cleaner” output

The strongest factors are probably:

### A. Existing design-system reuse

Instead of recreating UI primitives, the agent searches libraries and reuses components, variables and styles.

### B. Stronger procedural instructions

Skills specify the order of operations and validation strategy.

### C. Native execution freedom

The model is not forced to stay inside a narrow semantic schema.

### D. Continuous visual context

The workflow repeatedly observes the canvas instead of assuming the first generated composition is correct.

### E. Multiple-direction exploration

Figma's design agent explicitly supports going wide with multiple stylistic approaches and then going deep on a chosen direction.

### F. Domain-specific tooling

Slides, diagrams, shaders, generative plugins and other tools give the agent more ways to express a design than plain UI components.

---

# 5. What FigDes should change to reach the Diamond Standard

## Layer 1 — FigDes Skill System

Build skills as first-class files/configuration rather than hidden prompt text.

Every skill should define:

- trigger
- intent
- required context
- step-by-step workflow
- allowed native operations
- validation checks
- visual review criteria
- recovery rules
- examples

## Layer 2 — Design Context Graph

Upgrade `figdes_read_context` into a structured design knowledge layer.

Suggested context objects:

`FileContext`
`PageContext`
`ComponentContext`
`TokenContext`
`StyleContext`
`ReferenceContext`
`AssetContext`
`CompositionContext`

## Layer 3 — Native Freedom

Continue expanding native capabilities, but only where they unlock design decisions:

- Bézier/path editing
- boolean geometry
- SVG import/export
- advanced typography
- image/assets
- richer effects
- component properties
- variables/styles
- full Slides primitives
- diagrams/connectors
- generative/plugin hooks

Do not blindly chase complete Plugin API parity.

## Layer 4 — Composition Engine

Add explicit concepts for:

`focal point`
`hierarchy`
`grid`
`mass`
`rhythm`
`whitespace`
`scale`
`contrast`
`repetition`
`visual tension`
`art direction`

This is where “pretty but generic” designs become intentional designs.

## Layer 5 — Visual Critic

Every major creation should support:

`render → inspect → score → diagnose → patch`

The critic must be able to recommend concrete native edits, not just return prose feedback.

## Layer 6 — Exploration Engine

Generate 2–4 substantially different compositions before committing when the task is exploratory.

Example:

`Direction A — editorial`
`Direction B — technical`
`Direction C — minimal architectural`

Then select one and iterate deeply.

## Layer 7 — Domain Packs

Start with:

1. Product UI
2. Brand/vector
3. Slides
4. Diagram/data visualization

Then add motion/generative later.

---

# 6. Proposed FigDes Diamond Workflow

```text
USER INTENT
    ↓
TASK CLASSIFIER
    ↓
DOMAIN + SKILL SELECTION
    ↓
DESIGN CONTEXT GRAPH
    ↓
ART DIRECTION
    ↓
COMPOSITION OPTIONS
    ↓
SELECT / REASON
    ↓
NATIVE / HYBRID EXECUTION
    ↓
SCREENSHOT / RENDER
    ↓
VISUAL CRITIC
    ↓
PATCH PLAN
    ↓
NATIVE REVISION
    ↓
FINAL QUALITY CHECK
```

For a logo:

```text
brand intent
→ visual references
→ geometry concept
→ vector construction
→ boolean/path refinement
→ optical review
→ black/white test
→ small-size test
→ final mark
```

For a UI screen:

```text
product intent
→ existing design-system context
→ information hierarchy
→ 2–3 composition directions
→ selected direction
→ native construction
→ screenshot review
→ hierarchy/spacing/type refinement
→ final screen
```

For a deck:

```text
story / narrative
→ slide architecture
→ visual language
→ master/grid
→ slide-by-slide composition
→ data/diagram treatment
→ screenshot review
→ consistency pass
```

---

# 7. Benchmark we should use

Do not benchmark FigDes against “does it create a page?”.

Benchmark these tasks:

### Benchmark A — Existing-system screen

Can it inspect an existing file, find the correct components/tokens, and build a screen that looks native to that system?

### Benchmark B — Custom premium screen

Can it create a distinctive composition without falling back to cards/sidebar/table patterns?

### Benchmark C — Logo

Can it create original geometry and refine it optically?

### Benchmark D — Diagram

Can it convert a conceptual system into a readable visual architecture?

### Benchmark E — Deck

Can it produce multiple slide compositions while maintaining a coherent visual system?

### Benchmark F — Revision

Can it look at its own screenshot and materially improve the design after critique?

The **revision benchmark** is especially important. A good first generation is not enough.

---

# 8. The most important conclusion for our current FigDes branch

We do **not** need another giant rewrite of the native layer right now.

The native foundation we built is now good enough to support the next step.

The next highest-value work is:

```text
1. FigDes Skill System
2. Design Context Graph
3. Visual Critic + automatic revision
4. Composition / Art Direction engine
5. Domain skills for vector, slides and diagrams
6. Fill remaining native gaps only when a benchmark exposes them
```

That is the hidden corner.

We were previously treating the problem as:

`“FigDes doesn't have enough Figma operations.”`

The deeper problem is:

`“FigDes does not yet have the same workflow intelligence around those operations.”`

The final target should therefore be:

> **Native canvas control + design-system context + procedural design skills + visual feedback + creative exploration.**

That is a realistic “Diamond Standard” target rather than merely copying the Figma MCP API surface.

---

## Sources

- Figma MCP tools and prompts: https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/
- Figma write-to-canvas: https://developers.figma.com/docs/figma-mcp-server/write-to-canvas/
- Figma skills: https://developers.figma.com/docs/figma-mcp-server/create-skills/
- Figma `figma-use` skill repository: https://github.com/figma/mcp-server-guide/tree/main/skills/figma-use
- Figma `figma-generate-design` skill: https://github.com/figma/mcp-server-guide/tree/main/skills/figma-generate-design
- Figma Slides skill: https://github.com/figma/mcp-server-guide/tree/main/skills/figma-use-slides
- Figma Design Agent: https://www.figma.com/blog/the-figma-agent-is-here/
- Figma custom tools/context/skills: https://www.figma.com/blog/agent-custom-tools-context-skills/
