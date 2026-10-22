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


---

# Phases 2–4 (same-session follow-up commit): offline critique, alternatives, regression gate

Scope note up front, kept honest: **the rendered-screenshot critique/repair loop (§4 steps 5–10, live Figma) is still not in this commit.** What this commit adds is the deterministic half of that loop plus the two remaining wiring gaps — the alternatives engine, and the benchmark gate — each with contract tests.

## Phase 2 (partial) — declared criteria enforced on compiled evidence

`design/quality/type-criteria.ts` audits the `type-and-space` skill's *declared* acceptance criteria against the pipeline's compiled program and resolved plan, before any node exists:

- `type.space.readable-labels` — no compiled text below the 11px floor (high severity when violated);
- `type.space.uppercase-in-check` — no uppercase run of 4+ words in planned text (the uppercase budget);
- `type.space.one-rhythm` — one gap value across sibling regions; two values are a medium finding that names the odd regions and demands a stated reason; three or more fail high;
- `type.space.column-length-sane` — explicitly `not-evaluated` offline (needs plugin text measurement); the audit refuses to fake it.

The audit runs as pipeline stage 4.5 (`type-criteria`), its findings ride the existing findings flow (`automatable: false` — a deliberate rhythm break is a human decision), and the criteria verdicts are in the response payload (`typeCriteria.criteria`), each as `pass | fail | not-evaluated`.

## Phase 3 — the alternatives engine is wired, not merely pinned

`design/skills/alternatives.ts` bridges the blueprint engine (`design/composition/candidates.ts`) into the live path. It is not a second planner: it proposes seven family hypotheses (each authored against §4.1's six structural axes, so candidates are pairwise-distinct by construction and audited rather than assumed), scores only the dimensions the brief's own content can measure — task fit (ranked affinity by decision class, in the honest sense: an unfit constraint still hits the disqualification floors), hierarchy and scanability (inventory shape vs family), relationship clarity (stated relationships vs families that draw them), design-system fit (the patterns the brief names) — and lets the shared `selectComposition` engine choose. Unmeasured dimensions stay at the engine's neutral 5.

Pipeline stage 1.6 records the whole decision: candidate count, distinctness audit, ranking with per-family totals and disqualified dimensions, trade-offs, and provenance strings. Steering is bounded three ways:

1. a **caller-stated `desiredComposition` is a hard constraint** — the engine ranks against it but never replaces it; the plan receives the user's composition untouched (`buildCompositionPlan` applies the engine's choice only when the brief states none);
2. a constraint that **fails the dimension floors** (e.g. an editorial constraint on a monitoring decision) forces nothing: user override is recorded as `honored: false` and the report names the contradiction for a human;
3. briefs below an **evidentiary floor of 3 information items** are never steered — the engine records why and leaves composition to the planner.

The planner keeps its viability rules; a steered label can still be rejected by them.

## Phase 4 — benchmark baseline + regression gate

`design/benchmark/regression.ts` connects three pieces that previously never met:

- **evidence scoring** — `scoreOfflineEvidence` maps a pipeline plan-mode run onto `scoreBenchmark`'s 100-point offline scorecard. Every dimension carries the deterministic mapping that produced it (`dimensionEvidence`); `productSpecificity` is named not-evaluated and scored 0 (offline evidence cannot measure it); plan-mode runs say so in the result notes. Deterministic: the same response scores the same total.
- **a versioned baseline** — `figdes-benchmark-baseline-v1` (zod-validated, strict): per case, the brief, the recorded pipeline config, the evidence, and the scored result, so a prior case reproduces from brief + context + configuration. `parseBaseline` refuses a foreign schema or a non-baseline shape instead of accepting whatever parses.
- **the gate** — `runRegressionGate` is three-valued on purpose: `REGRESSION` on a drop ≥ the threshold (suite default 5) via `compareBenchmarkRuns`, `NOT_EVALUATED` when the candidate run does not reproduce every baseline case (missing cases are named, never averaged away), `PASS` only on full parity. An improvement average can never clear unreproduced cases.

## Tests

`tests/issue-22-phase34.test.mjs` (16 tests, all passing; `npm run test:issue22` now runs 43):

- ≥3 audited-distinct hypotheses with carried rationale; relationship-led brief steers to `topology` and the plan records the steering; caller constraints honoured untouched; disposition on evidence-vs-constraint contradiction; inventory floor;
- the criteria audit unit-tested (one-rhythm medium/high, 11px floor, uppercase budget, clean pass, not-evaluated honesty) and through the pipeline (stage + findings flow);
- pipeline evidence scores through the scorecard deterministically; baseline round-trips and refuses foreign documents; the gate is PASS/REGRESSION/NOT_EVALUATED with reasons.

Full suite green: every existing suite passes after the wiring (43 issue-22 tests, 250 runtime, 24 pipeline, 26 product-guard, plus review/blueprint/geometry/plugins/e2e/smoke).

## Honest limitations after this commit

- `productSpecificity` scores 0 offline (by design, with the reason in `notEvaluated`) — the calibration stays conservative until live evidence exists.
- **The 11px/uppercase/one-rhythm checks are a compile-time gate.** They are structural critiques of pre-render evidence; the rendered-screenshot loop (capture → critique → targeted repair → re-render → resolution ledger) remains the live phase-2 deliverable.
- **Task-category weights still map `select → explore`** (nearest by task shape), recorded in provenance rather than hidden.
- **No live-Figma before/after screenshots** for the alternatives loop; the offline equivalents are the steered plan's recorded composition + warnings, reproducible without a live file.


---

# Close-out commit: the benchmark becomes a gate, the decision record exists, artifacts persist

The three §-items that were still library-only are now executable, measured, and pinned:

## §6 delivered — the offline pipeline benchmark runner + a committed frozen baseline

`scripts/run-issue22-benchmark.mjs` (`npm run benchmark:issue22`) runs all nine v1 briefs through the **full plan-mode pipeline** — brief normalization, skills, alternatives engine, anti-generic review, type-criteria audit, structure verification — not the bare planner the older `run-design-benchmark.mjs` drives. Differences that matter:

- **The briefs are library data.** `design/benchmark/offline-briefs.ts` carries the nine fixtures in full pipeline-brief form, plus the one shared `evidenceFromResponse` mapper. The runner, the baseline and the tests now measure the same cases the same way; a test-local duplicate mapper was deleted (`tests/issue-22-phase34.test.mjs` imports the shared one). The runner refuses to run when fixture ids and `suite.ts` ids drift apart.
- **The baseline is frozen, versioned, and committed.** First run writes `artifacts/benchmark/issue22-baseline-v1.json` (`figdes-benchmark-baseline-v1`, strict zod): per case, the reproduced brief, the recorded config (`mode: plan, render: false, repairBudget: 2, maxRounds: 1`), the evidence and the scored result — 9 cases, totals 53–69.5 on the shared 1440×900 v1 viewport. `freezeBaseline` refuses a silent overwrite; `--force` is deliberate. The gateable document round-trips through `loadFrozenBaseline`.
- **Every later run is gated.** The runner re-runs all nine cases, and `runRegressionGate` compares against the frozen baseline: exit 1 on REGRESSION (any case −≥5), explicit refusal on NOT_EVALUATED (a baseline case the candidate could not reproduce is named, never averaged away), PASS otherwise. Improvements pass — the bar only matters when a case drops.
- **It is a CI-shaped gate in tests too.** `tests/issue-22-benchmark-gate.test.mjs` runs the nine cases through the pipeline fresh and asserts the gate PASSes against the committed artifact. A future pulse that degrades planning quality fails this test before it fails a user; a broad improvement passes, by design.

Freeze evidence (all deterministic — a second run reproduced every total exactly, 0/9 improved, 0 regressed): `exo-compute-topology` 69.5, `generic-saas-dashboard` 68, `spatial-relationship` 62.5, `exo-model-detail` 62, `exo-runtime-monitoring` 62, `exo-enterprise-workspace` 61.5, `editorial-product-page` 61.5, `data-heavy-workspace` 53.5, `exo-configuration` 53. Honest per-case detail — every dimension score carries the one-sentence mapping that produced it, and `productSpecificity` is named not-evaluated and scored 0 — lands in `artifacts/benchmark/latest.json`.

## §7 delivered — the design decision record, durable and loadable on resume

`design/decision-record.ts` (`figdes-decision-record-v1`, strict zod) freezes what the issue paragraph demands: the original brief and its hard constraints, the selected direction with its rationale (steered composition + provenance), **the skills that ran and why** (each decision quoted), the discoveries surfaced while planning, the rejected alternatives with their reasons, the outstanding findings that still stand, and each repair attempt — attempts are never erased from the record. Serialization refuses a foreign schema; `persistDecisionRecord`/`loadDecisionRecord` write one record per case next to the run (`artifacts/benchmark/decision-records/<caseId>.json`, committed). `resumeDrift` is the resume guard: the recorded style/density manner is compared against whatever a resume recompiles, and any change in manner without a new brief is *named as drift* — be that when it's intentional or when a repair would have quietly redesigned the screen.

## §4 step 11 delivered — run artifacts on disk

`design/benchmark/artifacts.ts` persists a run to `<root>/<runId>/run.json` — brief, config, evidence, scored result, decision record — and decodes any render data URL into a sibling `render.png`/`.jpeg`; an undecodable render is recorded as `render-decode-refused.txt` instead of being silently dropped, so a broken render path stays visible. The live loop (open the plugin, run the runner with `--runs` plus a render source) writes the same schema with the screenshot included.

## Tests

`npm run test:issue22` now runs **55 tests** (27 skills, 16 phase-3/4, 12 gate) plus the committed-baseline gate: fixtures align with the suite one-to-one, the committed baseline is a complete freeze, a fresh nine-case run PASSes without any case dropping, `productSpecificity` is provably named not-evaluated in the register, and the decision record / run artifact / frozen-baseline persistence round-trips strictly (foreign schemas and garbage refused, silent overwrite refused, absence is `null` — never a fabricated record or a fabricated baseline).

`tsc --noEmit` clean; `design-intelligence` (53) and `pipeline` (24) suites still green.

## Closing status of the issue's remaining item

- **The rendered-screenshot critique/repair loop (§4 steps 5–10) on real fixtures** is the one open item: it requires a connected Design Agent plugin session (`figma_status: connected` was false when this work was committed, and commit pins do not require a live file). The deterministic half of that loop — ranked pre-render critique, bounded repair, re-verification, resolution ledger, persisted before/after artifacts — is in place (`type-criteria.ts`, `repair-history.ts`, `artifacts.ts`); the live half executes the same steps with a render when the session connects.

---

# Live phase executed: §4 steps 5–10 ran on the open file (2026-10-22)

With a connected plugin session the live half ran end to end: all nine benchmark fixtures were **built, rendered (low-detail screenshots), critiqued, repaired through bounded `modify_design` transactions, and re-gated in the open EXO file**. This section supersedes the "one open item" note above. Evidence lives in `artifacts/benchmark/issue22-live/live-report.json` plus nine per-case artifacts beside it; every verdict, ledger id and transaction id traces to a real tool response or a render that was reviewed. The frozen offline baseline stays the regression reference — **not re-scored here, and live totals are not comparable 1:1**: live briefs carried file-real extensions (case 8 replaced its information set with a file-real cluster-placement brief, the weakest comparability, recorded in its artifact).

## Per-case outcomes after the loop

| Case | Frame | Final critique | Capability guard | final_qa |
| --- | --- | --- | --- | --- |
| exo-compute-topology | 539:391 Cluster routing | WATCH / REVIEW / 0 blocking; 3 resolved, 1 minor proposed | INDETERMINATE — no claim tripped | PASS · live checks pending |
| exo-model-detail | 542:437 Model detail | WATCH / REVIEW / 0 blocking; 4 resolved, 2 minor proposed | INDETERMINATE | PASS · live checks pending |
| exo-runtime-monitoring | 543:480 Runtime monitor | WATCH / REVIEW / 0 blocking; 3 resolved, 1 minor proposed | INDETERMINATE | PASS · live checks pending |
| exo-configuration | 544:520 Policy approval | WATCH / REVIEW / 0 blocking | FAIL → "proposed" marker → INDETERMINATE/manual | PASS · live checks pending |
| exo-enterprise-workspace | 544:560 Enterprise workspace | WATCH / REVIEW / 0 blocking; 4 resolved, 1 minor | FAIL → marker → INDETERMINATE/manual | FAIL (sibling-region overlap) → PASS |
| generic-saas-dashboard *negative control* | 545:607 Dashboard | FAIL / FAIL — valueless KPI skeleton realized; **verdicts only, no repairs by protocol** | WARNING — the genericity signature itself | not repaired by protocol |
| data-heavy-workspace | 545:631 Usage ledger | FAIL / FAIL with **zero** blocking, all dimensions PASS (gate oddity, recorded verbatim); 1 resolved, 1 minor | FAIL → metering marker → INDETERMINATE/manual | PASS · live checks pending |
| spatial-relationship | 545:666 Cluster map | WATCH / REVIEW / 0 blocking; 4 resolved (incl. my own id-fault damage), 1 minor | INDETERMINATE — capability truth PASS | FAIL twice (11px text floor, overflow) → PASS |
| editorial-product-page | 545:744 Run versus change | WATCH / REVIEW / 0 blocking; 4 resolved, 1 minor | FAIL → marker + fit verdict anchored to `orion-01` → WARNING | PASS · live checks pending |

Totals: **38 committed repair transactions** (plus 4 zero-commit preflight/at-op rejections and 1 deliberate needs-approval pause); final resolution ledgers across all critiques: **25 resolved / 0 persisting / 9 introduced** — every introduced finding a minor restraint or judgement call, proposed but not applied; every case closed with **zero blocking issues**. `final_qa` caught real defects the review-side renders missed (100%-overlap siblings in the enterprise workspace; sub-floor technical text + label overflow in the cluster map).

## The capability-truth pattern — the loop's most valuable product finding

On four screens (policy approval, enterprise workspace, usage ledger, run/change) the guard's capability-truth layer failed the same way: an EXO ability that is only *proposed in this library* was presented as shipped while `EXO_CAPABILITY_SOURCE` was unpinned. The interim repair — a visible `proposed · no pinned build` marker — is the agreed state (verdict INDETERMINATE / manual until a build is pinned). One adjacent catch: the fit verdict had to be anchored to its device (`fits orion-01 · 6.9/24.0 GB`) before it passed `product.fit-claim-without-context`.

## Gate oddities recorded verbatim

- Case 7's critique emitted FAIL + FAIL with **zero blocking issues** and all dimensions PASS — recorded, no repair applied on empty evidence.
- `final_qa`'s "render succeeds" check stays pending even in a session with successful renders; satisfaction is recorded manually per artifact.
- `design_runtime` dry-run reported a program *applicable* that the apply gate then refused (a 4px support spill) — dry-run and apply are not the same check.
- The negative control was **not refused at intake** — a frame was committed for the contradictory generic brief (the offline machinery flags this class; the live pipeline did not) — a live-only refusal-gate gap, captured alongside the expected visual verdicts.

## Harness findings (what the live runs taught about the tool path)

- `figdes_use_figma` mutating scripts degraded mid-session (`proxy: inconsistent get`, `cannot convert to object`); all 38 mutations therefore ran through the allowlisted `modify_design` op path, which committed clean 38/38.
- One large multi-op transaction silently parented its created rows to the canvas **page** instead of the addressed frame (enterprise case) — created-node parents must be verified after transactions of ~10 ops.
- Never write to an id that was not captured from a response's applied list: unmatched guesses reject cleanly (zero commit), but wrong-but-existing ids silently edit the wrong node — the case-8 cluster-map header/mem clobber, fully restored in-file and double-recorded as a process fault.
- The `setSize` `set_minWidth: 0` fault is **fixture-scoped**: it reproduces on autolayout chip frames but worked on the case-9 hero (free composition), where resizing was the structural fix for a hero the runtime compile had clipped to 289px.
- `design_pipeline` **self-refused three times** on a deterministic 4px spill instead of committing a broken layout — a working fail-safe; the frame completed via `design_runtime` with the support band pinned 189→181.
- Autolayout hug chips grow when values are appended (the reliable value-filling path); `appendChild` rejects TEXT children (order fixes go through content+typography swaps).
- The plugin never reported a **build stamp**, so no live verdict can be tied to a client build — rebuild and reopen the plugin before the next live run.
- Proposed, not applied (bounded-repair policy): the case-9 off-grid compile positions (28 nodes, medium severity), and the per-case restraint-whitespace minors. The negative control stays unrepaired by protocol — repairing it would erase its evidence.
