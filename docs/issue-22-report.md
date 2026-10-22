# Issue #22 — Design Skills and Visual Intelligence (Phase 0 audit + Phase 1 delivery)

Status: **Phase 0 complete, Phase 1 complete (milestone scope)**, with one benchmark worked example and the
contract that no visual-intent field is dead. Phases 2–4 (rendered-screenshot critique loop, alternatives
scoring already part-wired, benchmark gate) are scoped below honestly rather than claimed.

---

## Phase 0 — audit and baseline

What the repository already had, with exact file paths. "Exists" = working and wired; "partial" = working but
not reached by the `design_pipeline` live path; "missing" = not present.

| Capability | Status | Where it lives now |
| --- | --- | --- |
| Native Figma execution + transaction pipeline | Exists | `mcp-server/src/native/use-figma.ts`, `mcp-server/src/transaction.ts`, `figma-plugin/src/native/builder.ts` |
| Screen planner (task classification → regions → geometry) | Exists | `mcp-server/src/plan/planner.ts` (`planScreen`, `classifyDecision`), `mcp-server/src/runtime/layout.ts` |
| Design IR compiler + visual intent parsing | Exists | `mcp-server/src/runtime/compile.ts`, `mcp-server/src/runtime/interpreter.ts`; canonical schema `shared/ir.ts` (`VisualIntentSchema`) |
| Style/art-direction presets + curated inference | Exists | `mcp-server/src/runtime/visual-presets.ts` (`STYLES`, `ACCORDION`, `resolveStyleTokens`, `inferArtDirection`) |
| Composition planner + candidate scoring engine | Exists (planner wired) / **partial (scoring)** | `mcp-server/src/design/composition/planner.ts`, `candidates.ts` (`selectComposition`, `scoreCandidate`). `candidates.ts` is pinned by tests but the live planner path composes without consuming it — integration gap kept open (phase 3) |
| Grammar patterns + anti-patterns | Exists | `mcp-server/src/design/grammar/{patterns,matcher,anti-patterns,registry}.ts` |
| Design-system intelligence (tokens/components/typography) | Exists | `mcp-server/src/design/system/*`, `mcp-server/src/design/discovery/index.ts` |
| Critics | Exists (multi-critic) / **partial (screenshot-driven)** | `mcp-server/src/design/quality/visual-critic.ts`, `product-critic.ts`, `accessibility.ts`, `genericity.ts`. Visual critique currently runs on structure/geometry evidence; the screenshot loop is phase 2 |
| Dimensioned gate (execution/structure/visual/… separated) | Exists | `mcp-server/src/design/quality/dimensions.ts` (`GATE_DIMENSIONS`, `evaluateGate`), `final-gate.ts`, `release-gate.ts` |
| Bounded repair (planner, history, comparison) | Exists | `mcp-server/src/design/quality/repair-planner.ts`, `repair-history.ts`, `comparison.ts` |
| Benchmark suite + live fixture records | Exists | `mcp-server/src/design/benchmark/suite.ts`, `artifacts/design-benchmark/` (live cases, goldens, shots) |
| Brief pipeline with honesty rules | Exists | `mcp-server/src/pipeline/{contracts,brief,plan,program,verify,repair,report}.ts` (`design_pipeline` in `tools.ts`) |
| Explicit, typed **skills** with selection, decision trails and validation | **Missing → delivered in this commit** | `mcp-server/src/design/skills/*` (new) |
| Compile-time wiring: brief manner words → canonical executable intent | **Partial → delivered** | `visualDirection` was a bare string pushed into `program.visualIntent.style`; strings the style resolver did not know were silently ignored at the runtime with a single warning |

Baseline: the existing suites passed before this commit (the repo's own gate scripts are untouched); the new
`test:issue22` suite pins the new layer. One deliberately hard brief (premium monitoring, below) is worked
through end-to-end as the milestone's challenging screen, with its intent trace and anti-generic critique
recorded in this document.

---

## Phase 1 — what was delivered

New module `mcp-server/src/design/skills/`:

| File | Role |
| --- | --- |
| `contracts.ts` | The typed skill spec (`SkillSpecSchema`, zod-strict): purpose, when/when-not, signals, decision rules per design dimension (11 dimensions), required inputs and optional context, outputs **each naming a consumer** (the schema refuses an output whose `consumedBy` is empty), measurable `qualityChecks`, examples, counterexamples, fixture ids. Also `SKILL_SIGNALS`, `SkillSelection` (skip reasons are mandatory) and `INTENT_FIELD_CONSUMERS` — the no-dead-fields ledger. |
| `registry.ts` | Registration with validation (`validateSkillSpec` throws naming the broken field), duplicate rejection, `applySkill` runs a skill and converts a skill bug into a named note rather than a generation failure. |
| `direction.ts` | **Skill A — brief interpretation and art direction.** An adjective dictionary (8 words) whose every token is re-checked through the runtime's `resolveStyleTokens`; hard constraints (design-system constraints, anti-goals, states) vs preference words; `not X` is compiled as a hard exclusion, never an ignored adverb; contradiction is caught word-by-word *before* the build (the runtime discards ALL style on a contradiction; the skill resolves it where a note can ask the brief to pick). Untranslatable words are recorded, never dropped. |
| `composition.ts` | **Skill B — visual hierarchy and composition strategy.** Reuses `classifyDecision` (planner's own classification — no second opinion) to pick an archetype (editorial-focus, asymmetric, split-view, workspace, data-dense, canvas, list-detail, form-led, dashboard) with rationale, density/whitespace/alignment contract and **at least one rejected alternative**. A caller-specified composition is a hard decision that wins and is recorded. |
| `type-space.ts` | **Skill C — typography and spacing.** Numeral discipline (tabular for ≥2 readouts), alignment (strong for readout scanning, loose otherwise) compiled where the runtime consumes them, plus the type-role contract and the declared acceptance criteria (labels ≥11px, uppercase budget, one spacing rhythm, ~75ch body columns) for the phase-2 critique to enforce. |
| `anti-generic.ts` | **Skill G — anti-generic review.** Reviews the *plan* (review-phase skill: its required input is the composition plan): even-card-grid, no-focal, metric-shouting, uniform-sectioning. No pattern is banned — each finding asks the plan to state its rationale or break the symmetry; findings carry severity, confidence, evidence and a stated repair, and are never auto-applied. |
| `intent-compiler.ts` | **The Visual Intent Compiler.** Derives signals from the brief, selects skills contextually (phase-aware: compile-phase vs review-phase; every non-selection carries its reason), applies them, and merges their `visual-intent.*` decisions into ONE canonical intent — `shared/ir.ts`'s `VisualIntentSchema`, the schema the interpreter already parses. Priority rules for conflicts (evidence beats manner; manner beats archetype defaults), density defers to a style that already implies one, numerals fold into the style string. Output intent is validated against the runtime schema; one invalid field is stripped with a note rather than invalidating the whole manner. |

Wiring into the existing pipeline (no new generator, no parallel runtime):

- `mcp-server/src/pipeline/tools.ts` — new stage 1.5 (`skills`): selection + decisions + notes; new stage 2.5 (`visual-review`): anti-generic review of the plan with findings pushed through the existing `trace.findings` flow mapped by `toPipelineFinding`. Response payload gains `visualIntelligence` (signals, selection, decisions, intent, notes, review).
- `mcp-server/src/pipeline/plan.ts` — `buildCompositionPlan` attaches the compiled intent to the plan (`plan.visualIntent`) and fills a missing focal region (highest-rank payload region, with a note) when the skill layer is active and the planner left none.
- `mcp-server/src/pipeline/program.ts` — `buildProgram` merges the canonical intent into `program.visualIntent`: the planner's focal/weights stay; compiled fields (`style`, `density`, `rhythm`, `alignment`, `depth`, `contrast`) ride to the runtime, replacing the previously free-worded `style` with the *validated token string derived from it*.

`tests/issue-22-skills.test.mjs` (27 tests, script `test:issue22`, wired into the `test` chain) plus bundle
entries in `build:design`. `npm run typecheck` clean; the relevant existing suites (`test:design`,
`test:pipeline`, `test:runtime`, `test:issue16`, `test:issue20`, `test:context`, `test:blueprint`,
`test:invariants`, `test:regressions`, `test:geometry`, `test:builder`, `test:productguard`, smoke)
all pass after the change (counts recorded in the commit).

---

## The no-dead-fields contract (issue acceptance criterion)

`INTENT_FIELD_CONSUMERS` (`design/skills/contracts.ts`) records each canonical field with:

| Field | Status | Consumer → effect |
| --- | --- | --- |
| `style` | consumed | `runtime/visual-presets.ts resolveStyleTokens` + `runtime/compile.ts styleLook` → surfaces/typography voice/numerals/warmth/shape mechanics |
| `density` | consumed | `runtime/interpreter.ts GAP_SCALE` → spacing-system scale (airy 1.5 … dense 0.75) |
| `focal` | consumed | interpreter → grow 2 + emphasis on the named region |
| `visualWeight` | consumed | interpreter → per-region growth weighting |
| `rhythm` | consumed | `runtime/compile.ts rhythmScale` → inter-region gutter ×1.25/×0.75 |
| `contrast` | consumed | `runtime/compile.ts titleScale` → display type ×1.15/×0.9 |
| `alignment` | consumed | `runtime/compile.ts alignGrid` → snap bounds to the canvas grid |
| `depth` | consumed | `runtime/compile.ts` → elevation for chrome/panel regions |
| `composition` | **explicitly unsupported** | the interpreter never reads it; a manner string there would bypass the planner's composition solver, so the compiled composition travels as auditable skill decisions on the plan instead |

The ledger is covered by a contract test that walks `VisualIntentSchema.shape` itself, so a future shared
field cannot appear without either wiring or an explicit, reasoned write-off.

### Traceable-effect test

The pipeline is run offline twice with the same brief, once with the direction `editorial` (compiles
`rhythm: generous`) and once with `instrument` (compiles `style: instrument`, even rhythm); both programs are
then executed through the real runtime and the resulting geometry **differs**. Intent is not storage.

---

## The challenging benchmark screen (milestone requirement)

Brief (fixture `issue-22-premium-direction`):

> Cluster health — "watch the cluster and intervene when a node is under pressure"; primary action *drain the
> node*; seven named telemetry items; states degraded/recovering; demo data; "premium technical, not";
> anti-goal: no generic SaaS card walls; file constraint: the existing EXO token ramp.

**Before this commit**, `visualDirection` went into the program as the raw string. In the runtime,
`premium` and `not playful` match no style token and are ignored with one warning; the screen's manner was
effectively "whatever the generic default is", and nothing downstream could be asked "does this look premium?
is playful really absent?"

**After this commit**, the same brief compiles:

- selection: `brief-art-direction`, `type-and-space`, `composition-strategy` (with reasons for anything skipped);
- canonical intent: `style: "generous,restrained,open,tabular,calm-technical"`,
  `rhythm: generous`, `contrast: restrained`, `depth: subtle`, `alignment: strong` — each with a decision and a
  why in `visualIntelligence.decisions`, each resolving cleanly through the runtime's style resolver;
- `not` is honoured as an exclusion decision (`direction-exclusion: playful`, hard);
- the anti-generic review runs on the plan and this brief's plan passes (indeed: the planner derived an
  instrument workspace with the state strip, not a tile dashboard).

Rendered screenshots with before/after critique belong to phase 2's screenshot loop; this milestone
deliberately restricts its claims to the intent contract and plan review, which the tests reproduce
deterministically without a live Figma session.

---

## Honest limitations and next steps

- **The archetype contract is recorded, not enforced against the planner's choice.** The composition skill
  states what the plan should be; the plan is verified structurally and reviewed anti-generically, but the
  archetype-vs-derivation mismatch is only visible in the payload today. Phase 3 (candidates engine
  integration, already pinned in tests) closes this.
- **The declared typography/spacing criteria are enforced only when rendered evidence exists.** They are
  recorded as quality checks; phase 2's screenshot critic is the enforcer.
- **No new style presets.** This deliberately extends the runtime's existing token vocabulary rather than
  adding presets; the issue's non-goal about preset accumulation is respected.
- **A screenshot-based before/after on a live Figma file** was not produced in this commit (nothing in the
  commit requires a live file, and the plugin session state is not guaranteed when a committer runs it). The
  offline runtime renders used by the traceable-effect test stand in for geometry; the screenshot loop is
  phase 2's deliverable.
- **Benchmark regression gate** (phase 4) is scoped: `benchmark/suite.ts` already separates dimensions and
  compares runs; connecting it to the skill layer's decisions lives in phase 3–4.
