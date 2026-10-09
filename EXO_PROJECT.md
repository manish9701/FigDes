# EXO Labs — Project Control Room

Purpose: editable source of truth for progress, scope, research evidence, decisions, Figma screens, design reviews, and slide-deck accuracy.

Last updated: 9 October 2026  
Status: Foundation drafted; screen-by-screen design is next  
Figma: https://www.figma.com/design/dkVVX7tVzvsk8HBrUoGen8/Exo-Labs?node-id=112-1632

## 1. Current status

| Workstream | Status | Next action | Evidence/output |
|---|---|---|---|
| Product definition and UX architecture | Drafted | Verify product capabilities against current EXO implementation | EXO_Product_UX_Architecture_Design_Foundation.md |
| User and competitor research | Baseline exists; verification pending | Verify material claims against primary sources and record dates | Research register below |
| Consumer information architecture | Proposed | Validate against actual capabilities | Foundation document |
| Enterprise scope | Unconfirmed | Separate shipped, planned, and future capabilities | Open decisions |
| Visual direction | Proposed, not approved | Explore distinct Home compositions | Figma |
| Screen 01 — Home | NEXT | Inspect existing work, explore directions, build and review | Figma review required |
| Screens 02–10 | Pending | Start in dependency order after Home approval | Screen tracker |
| Empty/error/offline states | Incomplete | Specify alongside each screen | Screen specifications |
| Slide deck | Not started | Build only from verified research and approved designs | Evidence-backed deck |
| Final QA | Not started | Inspect actual renders, editability, consistency, accessibility | Review log |

Status definitions: NEXT/active, Draft, Verified/approved, Pending, Blocked. A verified status must link to evidence. A successful build or CI run does not prove visual quality or product correctness.

## 2. Product north star

Working positioning: EXO is a visual operating layer for local and distributed AI compute.

Product promise: **Your machines become one AI computer.**

The experience should answer:
1. Is my AI computer ready?
2. What devices and resources are available?
3. What model can I run for my task?
4. Why does it fit—or not fit?
5. How will EXO distribute the workload?
6. Is the model running well?
7. How can existing tools connect to it?

Differentiation to protect:
- Many devices represented as one coherent compute system.
- Automatic, topology-aware placement that can be inspected and explained.
- Hardware-aware model fit and trade-offs.
- Runtime diagnosis across compute and network.
- Straightforward integration with existing developer tools.

Design guardrails:
- No default generic SaaS dashboard/card wall.
- Different tasks get different compositions.
- Distinguish live, measured, estimated, sample, stale, and unknown data.
- Do not present unsupported features as shipped.
- Review real Figma renders, not just planner scores or successful code tests.
- Keep chat secondary; compute understanding and operations are primary.

## 3. Work plan and phase gates

### Phase 0 — Foundation
- [x] Gather existing EXO UX research and prior decisions.
- [x] Draft consolidated product/UX architecture foundation.
- [ ] Verify current EXO product/API capabilities and map them to screens.
- [ ] Resolve decisions that affect the first screens.

Exit gate: product thesis and core consumer flow are clear; unsupported assumptions are labelled.

### Phase 1 — Research and evidence integrity
- [ ] Maintain a source register with claim, exact source, source publication/update date, access date, and confidence.
- [ ] Re-check EXO claims against primary documentation and target version/API.
- [ ] Re-check competitor claims against official documentation.
- [ ] Gather user/community evidence for high-impact pain points; preserve links, dates, context, and caveats.
- [ ] Separate research findings from recommendations and hypotheses.
- [ ] Mark unsupported claims unverified; never invent statistics.

Exit gate: every material claim intended for slides is sourced or explicitly labelled as a hypothesis/recommendation.

### Phase 2 — Screen 01: Home
- [ ] Inspect existing Figma frames before modifying them.
- [ ] Explore at least three genuinely different compositions.
- [ ] Compare them against product principles and the primary user question.
- [ ] Select a direction and record why alternatives were rejected.
- [ ] Build editable Figma layers/components and relevant states.
- [ ] Render and inspect at actual presentation scale.
- [ ] Review hierarchy, content accuracy, typography, contrast, responsive behavior, empty/degraded states.
- [ ] Iterate with user feedback.
- [ ] Record approval and limitations.

Exit gate: Home is explicitly approved by the user; rendered frame and decisions are recorded.

### Phase 3 — Core screens
Design in dependency order, one screen at a time:
1. Home / AI computer overview
2. Compute / topology
3. Models / discovery
4. Model detail / fit
5. Deployment plan
6. Deployment runtime
7. Performance / diagnosis
8. Integrations / API
9. First-run and recovery states
10. Enterprise screens after scope confirmation

For every screen, record the user question, evidence/dependencies, composition, Figma frame/link, state coverage, critique findings, changes, and approval.

Exit gate: coherent end-to-end journey, not just a collection of attractive screens.

### Phase 4 — Product and visual validation
- [ ] Check screens against actual supported capabilities and API contracts.
- [ ] Test represented user tasks in the prototype.
- [ ] Verify relationships, states, text, contrast, and accessible alternatives.
- [ ] Check responsive behavior where required.
- [ ] Verify editable layer structure and reusable components.
- [ ] Record critical/major/minor findings and retest outcomes.

Exit gate: no unresolved critical issue; major limitations disclosed.

### Phase 5 — Slide deck
- [ ] Agree audience, objective, and desired decision before finalizing slide count.
- [ ] Use the research register as the source for factual claims.
- [ ] Separate user evidence, competitor facts, interpretation, proposal, and forecast.
- [ ] Add source notes to relevant slides and a complete source list at the end.
- [ ] Use approved Figma renders; label prototypes and sample data.
- [ ] Include limitations and assumptions when they affect conclusions.
- [ ] Verify every number, date, quote, capability, and comparison before export.

Exit gate: slides are traceable to sources and approved designs; no unsupported statistics or implied capabilities.

## 4. Screen tracker

| ID | Screen | Primary question | Status | Figma frame/link | Next action | Approved? |
|---|---|---|---|---|---|---|
| S01 | Home / AI computer overview | Is my AI computer ready, and what can I do next? | 🟡 Concept v1 rendered | https://www.figma.com/design/dkVVX7tVzvsk8HBrUoGen8/Exo-Labs?node-id=182-1911 | Fix contrast/readability; review composition with user | No |
| S02 | Compute / topology | What devices make up the system and how are they connected? | Pending | Existing work may be reusable | Validate topology data and accessible list alternative | No |
| S03 | Models / discovery | What can I run on this system? | Pending | Existing work may be reusable | Validate catalog fields and fit semantics | No |
| S04 | Model detail / fit | Can I run this model and what are the trade-offs? | Pending | Existing work may be reusable | Validate requirements and estimate provenance | No |
| S05 | Prepare model | What needs to happen before it is ready? | Pending | TBD | Confirm lifecycle/progress and retry support | No |
| S06 | Deployment plan | How will EXO distribute this workload? | Pending | Existing work may be reusable | Confirm placement details exposed by runtime | No |
| S07 | Deployment runtime | Is it running and how do I use/manage it? | Pending | Existing Runtime frame may be reusable | Verify lifecycle states and endpoint readiness | No |
| S08 | Performance / diagnosis | How well is it running and what limits it? | Pending | TBD | Confirm telemetry and measured-vs-estimated status | No |
| S09 | Integrations / API | How do I connect tools safely? | Pending | Existing work may be reusable | Verify protocols, auth, endpoint configuration | No |
| S10 | First-run / recovery | What has EXO found and what needs attention? | Pending | TBD | Validate discovery/error paths | No |
| E01 | Enterprise fleet overview | Which clusters need attention? | Scope unconfirmed | TBD | Confirm enterprise scope | No |
| E02 | Enterprise cluster detail | What is happening in this cluster? | Scope unconfirmed | TBD | Confirm sites/clusters data model | No |
| E03 | Access & governance | Who can access/change the system? | Scope unconfirmed | TBD | Confirm roles, SSO, policy capabilities | No |
| E04 | Events / alerts / audit | What changed or failed? | Scope unconfirmed | TBD | Confirm event/audit data and retention | No |
| E05 | Usage reporting | How are resources used across teams? | Scope unconfirmed | TBD | Confirm business need and data availability | No |

Do not mark a screen approved based only on a plan or tool success message. Require rendered design review.

## 5. Research register — required for slide accuracy

One row per meaningful claim. Link the exact page/document, not only a homepage.

| Claim ID | Claim | Type | Source URL | Source date | Access date | Confidence | Slide use | Status |
|---|---|---|---|---|---|---|---|---|
| R-001 | EXO supports the described multi-device compute workflow | Product fact | https://github.com/exo-explore/exo | Verify current revision | 2026-10-09 | Pending verification | Product context | Needs source check |
| R-002 | EXO documents APIs for relevant system/runtime actions | Product fact | https://github.com/exo-explore/exo/blob/main/docs/api.md | Verify current revision | 2026-10-09 | Pending verification | Architecture/integration | Needs source check |
| R-003 | Jan provides model discovery and a local API server | Competitor fact | https://www.jan.ai/docs/desktop/quickstart and https://www.jan.ai/docs/desktop/api-server | Verify page dates | 2026-10-09 | Medium until rechecked | Competitive analysis | Needs source check |
| R-004 | LM Studio has distinct model discovery/loading workflows | Competitor fact | https://lmstudio.ai/docs/app/basics | Verify page date | 2026-10-09 | Medium until rechecked | Competitive analysis | Needs source check |
| R-005 | Ollama supports OpenAI-compatible API patterns | Competitor fact | https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx | Verify current revision | 2026-10-09 | Medium until rechecked | Integration opportunity | Needs source check |

Research hygiene:
- Access date is when we inspected a source; it is not its publication date.
- Never invent dates, sample sizes, percentages, market sizes, quotes, or adoption figures.
- Prefer official documentation for competitor feature claims.
- Community comments are qualitative evidence, not representative market statistics.
- Record the exact passage/section that supports a slide claim.
- If a source does not support a claim, mark it unverified and omit or qualify it.
- Separate **Fact** (directly supported), **Interpretation** (our synthesis), **Hypothesis** (to test), and **Recommendation** (proposed action).

## 6. Decision log

| ID | Date | Decision | Rationale/evidence | Status | Revisit condition |
|---|---|---|---|---|---|
| D-001 | 2026-10-09 | This file is the project control room | One editable place for scope, progress, research, decisions, and slide readiness | Active | Reorganize only if hard to maintain |
| D-002 | 2026-10-09 | Design screen-by-screen with review before moving on | User wants to iterate on each screen and avoid mass-producing unvalidated layouts | Active | If dependencies require limited parallel exploration |
| D-003 | 2026-10-09 | Keep evidence separate from proposals | Slides will be presented; claims must be traceable | Active | Permanent rule |
| D-004 | 2026-10-09 | Explore Compute Field as initial Home direction alongside two alternatives | Expresses connected devices as one AI computer; not yet approved | Proposed | Revisit after rendered comparison |
| D-005 | 2026-10-09 | Treat enterprise features as unconfirmed until implementation/scope is checked | Avoid implying proposed governance/billing is shipped | Active | Update after scope confirmation |

When changing a decision, add a new row; do not silently rewrite history.

## 7. Design review and change log

Add an entry after every review iteration.

| Review ID | Date | Screen | Finding | Severity | Change made | Evidence after change | Outcome |
|---|---|---|---|---|---|---|---|
| REV-001 | 2026-10-09 | S01 | First Compute Field concept rendered. Topology focal point and next action read clearly, but technical labels are too small/low contrast; device relationships need visual review. The node labels and metrics are illustrative sample content, not confirmed EXO telemetry. | Major + minor | Build v1 as editable native Figma frame; kept existing screens untouched. | https://www.figma.com/design/dkVVX7tVzvsk8HBrUoGen8/Exo-Labs?node-id=182-1911 ; FigDes review reported 25 findings: 6 high, 19 medium, 0 critical. High-confidence contrast issues include #8A8C84 on light surfaces (3.12–3.35:1). 12 tiny technical-text findings; some are 8–10px. | Iterate; not approved |

Severity:
- Critical: wrong behavior, misleading data, broken core task, unsafe exposure.
- Major: core task cannot be completed/understood; hierarchy/relationship is materially misleading.
- Minor: polish, spacing, secondary copy, non-blocking consistency.
- Question: needs user/product/engineering decision rather than a visual patch.

A change is not verified until the new render is inspected. Record rejected alternatives and why when relevant.

## 8. Risks and open questions

| Risk/question | Impact | Next action | Status |
|---|---|---|---|
| Public docs may differ from target EXO version | UI may imply unsupported controls | Map screen actions/data to target implementation | Open |
| Existing research includes illustrative examples | Slides could present examples as facts | Verify each material claim and label sample values | Open |
| Enterprise features may be future opportunities | Scope creep/misleading UI | Confirm scope before enterprise screens | Open |
| Fit/performance estimates may lack validated methods | Users may over-trust estimates | Confirm calculation, assumptions, uncertainty | Open |
| Existing Figma styles/components may be inconsistent | Screens drift and are harder to edit | Establish tokens/components as first screen is built | Open |
| Attractive mockups may hide missing states | Product appears more complete than it is | Include state coverage in each review | Open |
| Slides may overstate conclusions | Credibility risk | Fact-check every slide claim against register | Open |

## 9. Slide-deck integrity checklist

- [ ] Every factual claim has a traceable source.
- [ ] Publication/update date is distinguished from access date.
- [ ] Competitor comparisons are verified and fairly phrased.
- [ ] Quantitative claims include source, unit, timeframe, and method.
- [ ] Research observations are separated from interpretation.
- [ ] Recommendations are clearly presented as proposals.
- [ ] Hypotheses/future opportunities are not described as proven.
- [ ] Prototypes are labelled; sample telemetry is labelled.
- [ ] Unsupported capabilities are removed or qualified.
- [ ] Material limitations and uncertainties are disclosed.
- [ ] Conclusions follow from the evidence shown.

## 10. Immediate next actions

1. Verify EXO capabilities relevant to Home, topology, fit, deployment, runtime, and integrations.
2. Inspect existing Figma overview and components; preserve useful work.
3. Explore three Home compositions: **Compute Field**, **System Brief**, and **Compute Instrument**.
4. Select based on task clarity, product truth, distinctiveness, and editability.
5. Build/render Screen 01, review with the user, record changes, and iterate.
6. Once Home is approved, establish tokens/components and start Screen 02.
7. Continue updating the research register so the later slide deck is evidence-backed.

**Single source of truth:** update this file whenever scope, decisions, research status, screen status, or review outcomes change. Detailed requirements live in EXO_Product_UX_Architecture_Design_Foundation.md; link to that document rather than duplicating long specifications.


## 11. Current Figma baseline — 9 October 2026

### Existing design-system audit
On page “Chatgpt Designs”, the inspection covered 354 nodes and found:
- 228 text nodes without attached text styles.
- 349 hardcoded color usages and 0 paint styles/variables discovered by the audit.
- 16 text styles exist (including EXO/Display, EXO/Title, EXO/Body, EXO/Eyebrow, EXO/Label, EXO/Value, EXO/Nav and EXO/NavActive).
- Inter and JetBrains Mono are the two established font families.
- Existing frames retained: 01 — Compute Fabric (158:877), 02 — Model Studio (158:985), 03 — Runtime & Diagnostics (158:1074), and older EXO Compute Fabric (142:811).

Note: the attempt to seed a reusable variable collection failed before making changes; no variables were created by that transaction. Do not report token seeding as complete.

### First Home concept
Frame: 04A — Home / Compute Field (Concept), node 182:1911.  
Link: https://www.figma.com/design/dkVVX7tVzvsk8HBrUoGen8/Exo-Labs?node-id=182-1911

What it explores:
- The connected compute system is the main visual.
- One next action: find a model that fits.
- Current workload has a clear empty state.
- Illustrative topology and device specs are labelled sample/not live.
- Existing frames were not overwritten.

Review findings:
- 25 total findings: 6 high-confidence, 19 medium-confidence, 0 critical.
- High-confidence contrast issue: #8A8C84 technical labels on light backgrounds measured around 3.12–3.35:1, below the 4.5:1 AA target for normal text.
- Technical labels between 8–10px need larger type or should be removed if they are merely decoration.
- The status dot should be accompanied by clear state text (already present nearby; reviewer flags dot in isolation).
- The “Action separator” finding appears to classify a divider as an interactive control; verify manually rather than blindly applying the suggested fix.
- The concept is not approved and is not connected to live EXO data.

Next: correct high-confidence contrast/readability issues, inspect topology line/node relationships at full scale, then ask the user to review composition and product content before polishing further.
