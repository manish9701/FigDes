# FigDes — Combined Quality & Reliability Fix Plan
**Date:** 9 October 2026  
**Repo:** https://github.com/manish9701/FigDes  
**Live challenge:** EXO Compute Fabric, run `d92282f`, frame `142:811`, 1440×900.

## Executive decision

The reported live run is a meaningful generation-and-repair milestone, but the final quality gate correctly remains **FAIL**. Do not lower thresholds, suppress findings for EXO, or force a PASS. Fix the evaluator and repair-system defects together, then rerun the same challenge.

The report says the first render had 15 findings and 3 critical issues; later renders made labels readable and removed critical findings. The final screen reportedly has a five-device topology, labeled edges, inspector, memory pressure, verdict, and decision band. The remaining reported issues are four high overflow findings believed to be false positives, a card-wall disagreement, consistency score 4, whitespace/density failures, two visual minors, and plugin flapping.

## GitHub state checked

- [PR #8 — Fix visual evidence gates and benchmark coverage](https://github.com/manish9701/FigDes/pull/8): merged.
- [PR #9 — Add executable design-planning benchmark runner](https://github.com/manish9701/FigDes/pull/9): merged.
- `mcp-server/src/design/quality/final-gate.ts`: missing scores and stale/mismatched screenshot revisions block PASS; visual verification is required. Preserve this.
- `mcp-server/src/design/quality/genericity.ts`: current card-wall heuristic counts bordered/rounded frame/rectangle operations and similar dimensions, without enough semantic knowledge to distinguish peer cards from topology + inspector. Purple/violet fills are also penalized via literal hex matching.
- `mcp-server/src/design/quality/visual-critic.ts`: adds relationship clarity, typography, product character, authorship and genericity; some dimensions are heuristic, not screenshot-grounded.
- `mcp-server/src/design/quality/visual-findings.ts`: stable finding IDs, node localization, repair instructions, and finding lifecycle already exist.
- `mcp-server/src/design/composition/relationships.ts`: already models focal nodes, edge meaning/weight, clusters, and flow/radial/layered direction.
- `mcp-server/src/plan/planner.ts`: already has task-derived decision kinds and composition planning.
- `mcp-server/src/design/benchmark/suite.ts`: nine offline cases, plus a separate live scorecard. Keep offline structural scores distinct from live visual scores.
- `scripts/run-design-benchmark.mjs` and `.github/workflows/ci.yml`: CI runs build/typecheck/tests and offline planning benchmark. The offline runner explicitly does not capture live Figma screenshots. Do not claim CI proves live visual quality.

I checked the code and PR state, but did not independently inspect the live plugin's artifact directory or screenshots. The report's claims that the four overflow findings are false positives must be verified by tracing the measurements and rerunning the challenge.

## P0 — Fix coordinate normalization and overflow metrics

**Reported defect:** line coordinates may be absolute while being compared to parent-local dimensions (example cited: x=1935 vs parent width 824).

Implementation:
1. Trace one reported overflow from raw plugin/Figma node data through normalization, rule evaluation, critique, and gate.
2. Define a canonical geometry contract: document/canvas coordinates, parent-local coordinates, bounds, node type, parent ID, and coordinate-space metadata.
3. Convert to canonical parent-local bounds before comparing with parent dimensions. Never compare absolute X/Y to parent width/height.
4. Handle line endpoints/bounds and stroke bounds separately from rectangular frames. Account for transforms/rotation if supported; if not reliable, report uncertainty instead of a high-confidence hard failure.
5. Preserve genuine overflow as a blocker. No blanket line exemption.

Regression tests: absolute vs local coordinates; line that is outside in document coordinates but inside its parent; truly overflowing line; nested frames; negative local coordinates; clipping on/off; zero-size lines; rotated/transformed nodes if supported; connector labels; boundary and rounding cases.

**Acceptance:** the four reported false positives disappear for a demonstrated reason, while a deliberate real overflow still fails.

## P0 — Make card-wall detection semantic and composition-aware

**Verified code issue:** `genericity.ts` flags three or more bordered/rounded surfaces and groups them by approximate size. It does not sufficiently distinguish semantic peer cards from nested inspector sections or topology elements.

Implementation:
1. Feed the evaluator semantic roles, parent/containment, planned composition/pattern, and whether a surface is a peer card vs a layout container.
2. Exclude or separately classify topology nodes/labels, nested inspector sections, status/decision bands, and containers.
3. Preserve the generic SaaS dashboard negative control; it must still trigger.
4. Add positive controls for topology + inspector, spatial field + single inspector, editor/canvas + tool panel, and telemetry with annotations.
5. Include exact counted node IDs, roles, sizes, parents, and rule in the finding evidence.
6. Replace hard-coded purple-hex penalties with token-aware checks: approved EXO semantic tokens should not be penalized merely for their hue; unapproved decorative accents can still be flagged.

**Acceptance:** the intended field + inspector no longer triggers solely because it has multiple rounded surfaces, and the generic SaaS negative control still triggers. No EXO/frame-ID whitelist and no threshold reduction.

## P0 — Prevent repair-induced design-system inconsistency

**Reported issue:** contrast/label repairs improved readability, but final consistency was scored 4, reportedly due to new tints.

Implementation:
1. Capture existing EXO color, typography, spacing, radius, border, and component tokens before repairs.
2. Repairs should reuse approved tokens. If a new semantic token is necessary, name it, justify it, and reuse it consistently.
3. Preserve palette and hierarchy unless measured contrast/accessibility evidence requires a change.
4. Every repair must cite findings and limit unrelated node changes.
5. Run whole-frame consistency evaluation after every repair pass, not just a local label check.
6. Record token/style diffs and add tests for unknown-token introduction, approved token reuse, and contrast fixes that introduce inconsistent fills.

**Acceptance:** readable labels remain readable, and repairs no longer silently degrade consistency.

## P1 — Make findings auditable and confidence-aware

Each finding should retain:
- stable ID and rule version;
- severity separate from confidence;
- evidence type (`geometry`, `screenshot`, `accessibility`, `design-system`, `heuristic`);
- node IDs, semantic region, raw measurements, and coordinate space;
- screenshot/render ID and Figma revision;
- disposition (`confirmed`, `false-positive`, `intentional`, `unresolved`), rationale, reviewer, and timestamp.

Do not erase a finding when a reviewer disputes it. Preserve the original and record the adjudication. High severity with low confidence should request verification; it should not be treated as equivalent to high severity with direct geometric proof. Heuristic findings must not be described as image-grounded.

**Gate rule:** unresolved high-confidence blockers fail; uncertain findings require review; adjudicated false positives stop blocking only with retained evidence and a tested rule correction.

## P1 — Separate score systems and improve consistency scoring

The program score 7.6, human/live scorecard 73.5, and critique/QA gate are different measures. Document each scale, dimensions, weights, and evidence source. Keep structural, heuristic, human visual, and gate results separate.

Add an explicit consistency dimension covering token reuse, typography scale, radius/border/fill/spacing, repeated components, and repair-introduced changes. Critical blockers must not average away. Calibrate weights only after multiple screens are independently rated by humans; do not tune them to make this run pass.

## P1 — Investigate whitespace/density rather than dismissing it

The supplied summary does not prove these findings are false positives. Inspect the actual r3 screenshot and the precise regions/evidence that caused the failures. Separate measurable unused space from subjective density. Evaluate viewport coverage, node/edge separation, visual balance, readability, and grouping in context: topology needs breathing room; inspectors need readable grouping.

Add tests for intentionally sparse topology, dense data workspaces, and genuinely underfilled layouts. Keep real density issues visible.

## P1 — Make the live evidence pack reproducible

Keep the offline runner's `visualBenchmarkComplete: false` until screenshots are actually recorded. The live run pack should include:
- commit SHA, plugin/server version, brief, derived plan, and design-system scan;
- Figma file/frame IDs and initial/final revision IDs;
- initial/final screenshot paths and hashes, all render attempts, plugin retries/errors;
- findings before and after each repair, reviews, critique, final QA and gate output;
- score definitions, per-dimension evidence, unresolved issues and environment limitations.

Bind screenshots to the exact revision they depict. Keep failed/flapping attempts in the record. Rerun the same brief and viewport for a before/after comparison. After EXO, add a different EXO screen, a spatial task from another domain, and the SaaS negative control.

## P2 — Expand planner/topology regression tests

Preserve the existing task-derived planner and relationship semantics. Add briefs for:
- the exact EXO Compute Fabric task;
- “monitor cluster health” (instrument/monitor, not topology solely because of “cluster”);
- “find the bottleneck in a connected workload” (topology);
- “choose a model” (selection/comparison);
- unrelated graph/spatial work;
- generic dashboard negative control.

Assert nodes are separated; edges refer to existing nodes and have meaningful labels; focal bottleneck is identifiable; coordinates contain no NaN/Infinity; there are no unintended pile-ups; bounds stay in-frame; inspector does not obscure the topology; visual emphasis reflects semantic status/rank.

## Recommended one-go implementation sequence

1. Trace the overflow findings end-to-end in the live metric path.
2. Fix coordinate normalization and add geometry regressions.
3. Make genericity/card-wall detection semantic and add positive/negative controls.
4. Make repair token-aware and add consistency regressions.
5. Extend finding provenance/confidence/disposition and integrate with the existing gate.
6. Adjudicate whitespace/density from the actual screenshot evidence.
7. Update live evidence pack and repeat-run comparison.
8. Expand planner/topology regression tests.
9. Run full CI and the connected-plugin live challenge.
10. Publish one report with commit SHA, CI status, screenshots, finding dispositions, separate scorecards, unresolved issues, and the exact gate result.

Use one coordinated branch/PR, with traceable commits, rather than a sequence of tiny requests. Do not claim tests or CI passed unless a run proves it.

## Definition of done

- [ ] Four reported overflow findings traced to source; false positives fixed and real overflow still fails.
- [ ] Topology + inspector positive control and generic SaaS negative control behave correctly.
- [ ] Approved EXO tokens reused; no unexplained repair-introduced tints.
- [ ] Consistency has evidence-backed scoring.
- [ ] Every finding is tied to rule, evidence, confidence, and current revision.
- [ ] Whitespace/density findings have exact region evidence and remain open if unresolved.
- [ ] Topology tests cover NaN, pile-up, missing edges, and bounds.
- [ ] Full CI passes (or is explicitly marked unverified).
- [ ] Same 1440×900 live challenge rerun with initial/final screenshots bound to the final revision.
- [ ] Gate remains exactly as computed; no threshold relaxation or forced PASS.
- [ ] Evidence pack is linked in the final report.

A PASS is not required to call the engineering milestone complete. Correct evidence, regression coverage, and an honest gate are. If real defects remain, the design should still fail.

## Explicit non-goals

Do not tune for 10/10, whitelist EXO or frame `142:811`, disable overflow/card-wall/whitespace/density checks globally, treat offline planning as visual proof, or replace the existing planner/critic/gate with a parallel system.

**Bottom line:** fix geometry evidence, semantic false-positive handling, and repair-induced consistency together; prove them with regression tests and the same live challenge; keep the gate honest.
