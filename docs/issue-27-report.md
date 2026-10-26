# Issue #27 — Project-aware, domain-agnostic FigDes: profiles, artefacts, isolation benchmark

Fixes: https://github.com/manish9701/FigDes/issues/27

## Problem

The core engine carried one product's (EXO's) behaviour everywhere:

- `plan/planner.ts` imported `defaultRules()` from `memory/rules-exo` and previewed `exo.no-generic-saas` for every project, whatever it was;
- the deploy shell stated EXO's placement truth (`"dragging shards by hand"`) in every deploy plan;
- EXO screen archetypes were inferred from decisions without an active profile, and EXO runtime states (`model fitting`, `cluster degraded`) multiplied into every project's plans;
- `design_context` gave every project EXO's product description, anti-patterns and brand rules;
- the capability-claim stage (EXO's claim set) ran unconditionally;
- fresh project memory seeded EXO's ruleset and the `compile_ir`/interpreter guard fell back to EXO rules when it found none;
- `plan/tools.ts` refused a plan with a hard-coded `exo.no-generic-saas` preview.

The result: a project with no relation to EXO was planned, checked and judged as if it were EXO.

## What changed

### P0 — Product behaviour moved into a typed Project Design Profile

- **New module `mcp-server/src/memory/profiles.ts`** — the single home for product profiles. `PRODUCT_PROFILES` is a registry; EXO is an ordinary entry (`EXO_PROFILE`), described by its own spec: rules, runtime states, archetype inference, placement truth, metric-wall rule id.
- **Resolution order** (`resolveProfile`): explicit tool argument → `memory.profile` (recorded via `project_memory`) → implied by stored `exo.*` rule ids (legacy files) → key seeding (`keySeedsProfile(key)` — word-boundary match against registered profile ids, so `exo-fleet` seeds and `nexo-crm` does not; the same honesty limits as the default notes) → **none**. "None" resolves to a general, domain-neutral project: no product rules, no product taste.
- **`ProjectProfileRef`** (`shared/memory.ts`) is a typed record the project writes about itself (product, domain, audience, artefact types, anti-goals, visual direction). Recording a profile requires a registered product id; unresolvable profiles are refused rather than silently no-op'd.
- **Memory seeding** (`memory/store.ts`): `fresh()` seeds rules, notes and profile **by project key**. An unrelated key seeds nothing; an exo-named key seeds EXO's — the same mechanism the default notes already used, now applied to rules too. `effectiveRules(memory, explicit)` merges the active profile's built-ins (which stored copies cannot shadow) with the project's own stored rules.
- **`effectiveRules` replaces every `defaultRules()` fallback**: planner, `compile_ir`, the interpreter, `design_guard` and the pipeline all check the merged per-project set. Zero product rules means the guard reports **INDETERMINATE with a `profile` finding naming the next step — never a PASS** (no single misleading PASS), and the interpreter/compile paths carry the same note (`productGuard.note`).
- **The capability-truth stage** runs only while the profile that owns the claim registry is active; otherwise `NOT EVALUATED` with the reason. `composition/derive.ts` now types its derivation strategy union (the artefact composer added a strategy).

### P0 — The planner is product-agnostic; the brief is the authority

- `plan/planner.ts` no longer imports the EXO rule set. It receives the resolved `product` (null = general) and `rules` from the tools layer, which resolves the profile once — plan previews and guard runs can no longer disagree about what is active.
- **Exo vocabulary only fires under the exo profile**: deploy placement wording uses `spec.placementTruth` when the profile is active and neutral wording otherwise; the shell's deploy structure is kept (it is decision vocabulary, not product-owned); EXO runtime states and archetype inference gate on the profile; `exo.no-generic-saas` previews compile from the resolved rule set, not a hard-coded id.
- **Artefact type is a first-class input** (P0): `product-ui, mobile, landing, editorial, dataviz, diagram, identity, design-system, presentation`, each with a reasoned composition table (`ARTEFACT_LAYOUTS`) — an editorial page plans a reading rhythm (masthead/column/furniture), a landing page plans a narrative with one conversion action, a narrow viewport plans one column with a pinned commit, an identity sheet plans editable vector marks with palette and ramp. The plan echoes `artefact`, `derivation.strategy: "artefact-composition"` and the artefact's template so misuse is visible.
- Products are addressed by an exact profile id in explicit args; brief-declared products resolve case-insensitively (`profileForProduct("EXO")` finds `exo`); unknown ids stay profile-neutral and are never invented.

### Smallest reversible edits elsewhere

- `plan/tools.ts`: `profile` + `artefact` args on `plan_screen`/`buildPlan`, profile threaded into the planner and `designContext` (general projects get a neutral base, `contextBrief` skips empty segments instead of printing `Product: — .`), `deployCompleteness` wording product-neutral.
- `runtime/tools.ts` / `runtime/interpreter.ts`: `profile` arg on `design_runtime`/`compile_ir`; `runGuard` runs the resolved set; honest zero-rule notes.
- `memory/tools.ts`: `profile` record/read on `project_memory`; `design_guard` resolves profile per run and reports `rulesSource` + `activeProfile` provenance (`explicit | memory | implied | key-seeded | none`) with the project's own rules a first-class citizen.
- `pipeline/plan.ts`: brief-declared products resolve through the same gated `profileForProduct`; archetypes resolve through the same gated `resolveArchetype`.
- **The pipeline has an explicit profile channel (issue #27)**: `BriefInputSchema.profile` names a registered profile id, validated loudly (`assertKnownProfile` — an unknown id fails instead of silently planning general) and threaded through `NormalizedBrief` into every `effectiveRules(memory, resolvedProfile)` site. The display `product` field keeps its old descriptive role and only becomes a profile when case-insensitively matching a registered id — `"EXO Labs"` matches no registered id and stays general.

## Regression tests (failing-first shape, all now green)

- **`tests/project-profile.test.mjs` (new, 13 tests)** — the acceptance core:
  - cross-project isolation in **both directions** (A's rule invisible to B; B's profile leaves A untouched), including effective rule sets at guard time;
  - a fresh general project opens with **zero rules and a `null` profile**; key seeding verified for both kinds of key;
  - a guard over zero rules returns **INDETERMINATE with a `profile` finding** (no PASS by inheritance);
  - the **original EXO checks still veto what they always vetoed** when the profile is active (recorded-profile and explicit-profile lanes both reach the full EXO truth set);
  - general plans carry no product states, no product archetypes, no `shards` vocabulary; the artefact table decides general compositions; EXO archetype inference needs a profile;
  - the **pipeline lane**: the same EXO brief run through `designPipelineTool` twice — with the explicit `profile: "exo"` the final guard counts product rules; without it the run stays general and the final guard honestly reports `0 rule(s)` (each leg re-runs the guard; it is never carried between runs).
- Updates to suites that previously pinned global-EXO behaviour — they now state the profile explicitly, which is what the change asks of every caller: `plan.test.mjs`, `planner-deployment.test.mjs`, `product-guard-regressions.test.mjs`, `issue-24-intelligence-gate.test.mjs`, `plugin-e2e.test.mjs`, `design-intelligence.test.mjs`, `smoke.mjs` (the memory section splits its EXO-keyed guard lane from a general-note lane).

## P0 — Versioned cross-domain benchmark (v2, 12 fixtures)

`mcp-server/src/design/benchmark/cross-domain.ts` + `scripts/run-cross-domain-benchmark.mjs` (`npm run benchmark:cross-domain`), artifact at `artifacts/cross-domain/result.json`:

- Per fixture: exact brief, declared expected traits (explicit presence lists — **no thresholds**), per-trait evidence expected-vs-observed, honest statuses `PASS/FAIL/WARNING/INDETERMINATE/NOT EVALUATED`; any FAIL ⇒ verdict FAIL; a throw is recorded as evidence; a missing tool module means NOT EVALUATED, never PASS.
- Fixtures cover the issue's representative tasks: editorial deep-dive, landing/narrative, mobile onboarding (narrow viewport), data-visualisation, technical diagram, identity (vector marks), design-system specimens, dense ops console (monitor + explicit intervention action, no card wall), content-heavy queue with declared empty/error/loading states, general deploy flow (neutral vocabulary), EXO deploy **under its profile** (states + placement truth fire), and the guard isolation lane (same card-wall program: INDETERMINATE with zero rules, FAIL with the EXO profile).
- Live-render evidence remains the live benchmark's job (`benchmark:live` harness); the structural cross-domain lane is hermetic on purpose.

## Verification

- `npm run typecheck` — clean.
- `npm test` (full chain, all suites) — green; `smoke` 68/68 checks; `plugin-e2e` 15/15.
- `npm run benchmark:cross-domain` — `cross-domain benchmark: PASS (fixtures: 12)`, exit 0.
- No acceptance threshold was weakened; no timeout was raised; existing suites' expectations were stated explicitly, not removed. `artifacts/pipeline/G*.json` were regenerated by the test run and **do** reflect the profile channel: issue-16 briefs declare `product: "EXO Labs"`, which matches no registered profile id, so the product-gate stage now details `0 rule(s)` where the old global-EXO default credited 14, and the G03/G08 guard statuses became `INDETERMINATE` rather than `WARNING` — a run with zero product rules refuses to read as a review that approved anything. The EXO briefs now carry their product behaviour through the explicit `profile: "exo"` channel where a profile is intended (see the pipeline lane in `tests/project-profile.test.mjs`).

## Acceptance mapping

| Issue criterion | Where it is proven |
| --- | --- |
| Explicit profile influences only its project | `memory/profiles.ts` resolution order + `project-profile.test.mjs` (A↔B isolation) |
| Conflicting projects, no cross-contamination | isolation tests + `guard-isolation-lane` in the benchmark |
| ≥6 distinct artefact types differ appropriately | benchmark fixtures 1–7 (editorial/landing/mobile/dataviz/diagram/identity/design-system) |
| Editorial/identity stay editorial/identity | benchmark traits pin template + regions (masthead/column/furniture, marks/palette/ramp) |
| Isolation passes both directions | `project-profile.test.mjs` (A→B and B→A plus recorded-profile direction) |
| Structural / visual / profile / human review distinguished | guard findings keep rule verdicts separate; benchmark statuses include NOT EVALUATED; live checks stay explicit |
| Profile integrity in the engine | `rulesSource`/`activeProfile` provenance on every guard run; planner echo `profile`/`profileSource`; pipeline `brief.profile` validated and threaded into every rules site (`resolvePipelineProfile`) |
| No weakening, suites stay green | full `npm test` chain green; thresholds untouched |

## Out of scope (documented)

- No live rendered screenshots for the cross-domain lane (the live harness covers rendered evidence; the lane is hermetic).
- The diagram fixture pins composition structure; "connections survive node moves/size changes" remains covered by the existing issue-24 topology suites.
