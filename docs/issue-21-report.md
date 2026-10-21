# Issue #21 — Disposable Test Frames + Reproduced Layout Defects

**Status:** Executed · test frames built fresh, defects reproduced and repaired on live build, evidence collected
**Repo state:** `npm test` → 897 tests / 0 failures (run after all build work; baseline unchanged — no repo source files were modified by this task)

---

## 1. Objective recap

Issue #21 asked for two disposable test frames rendered in live Figma — one per sheet family:

| Frame | Node id | Name | Canvas | Page |
|---|---|---|---|---|
| Consumer | `525:483` | `Issue21 · Consumer · Model launch` | 1440×960 | `New Designs ` (322:756) |
| Enterprise | `525:587` | `Issue21 · Enterprise · Device fleet` | 1440×960 | `New Designs ` (322:756) |

- Built fresh this run (pre-existing "V5 Consumer · Model launch" frame deliberately **not** reused; its provenance can't be tied to the current build).
- Production EXO screens untouched; both fixtures live in dedicated `Issue21`-named frames.
- All sample figures carry explicit `(estimated)` / `(sample)` / `Proposed` labels in-content.
- EXO capability registry **stays unpinned** per repo policy; `scripts/pin-exo-capabilities.mjs` forbids agent-side pinning (BLOCKED by design, not by this bug).

## 2. Run identity

| Field | Value |
|---|---|
| File | `Exo Labs` |
| Page | `New Designs ` (322:756) |
| Server commit | `9a1770e8e174-dirty` |
| Plugin build stamp | `9a1770e8e174` (same commit; the runtime one-off gate still labelled it *unverifiable* when a build stamp wasn't reported on some call paths) |
| Plugin sessions observed | `session_9fbb6ff9-…` → reconnected mid-run to `session_f3b98c34-…` (transport drop, not user action) |
| Focus dependence | Confirmed: builds that took >100 s/op while Figma was backgrounded completed in seconds once the window was focused (background-tab throttling, plugin-side) |

## 3. Defect catalog reproduced on the current build

Every defect below was reproduced against the *live* build during this run (not carried over from #17–#20 traces). "Fixed in fixture" means the repair is applied and verified on the frame; the underlying engine issue belongs to future engine work.

### 3.1 Layout / compiler defects (issue #21 P1 class)

| id | Defect | Reproduced as | Status |
|---|---|---|---|
| D1 | **Plan-geometry drift** — planned region bounds diverge from built bounds | `header: planned 1168×72, built 1168×206`; `content: planned 1168×494, built 1168×360` (`plan-geometry-drift-01/02`, from both design_pipeline and design_runtime traces) | Documented; fixtures hand-corrected |
| D2 | **Region-flow misplacement** — right-rail "inspector" region placed bottom-left in the main column despite declared intent; `relations: rightOf` resolved off-canvas unless sibling widths were sized manually | Consumer/Enterprise v1 both placed Inspector at `(264, ~729/779)` instead of right rail | Fixed in both fixtures (Inspector at `1042,173`, 398×787) |
| D3 | **Text measurement collapse** — inspector text nodes forced to uniform 106 px columns, overlapping each other; nested "Memory"/"Readout" boxes overflow their 106 px parents | Consumer inspector v1: all text 106 px wide at 3-column positions; Readout 432 px inside 106 px frame | Fixed (clean vertical stack; widths 330–350) |
| D4 | **modelRow sub-text dropped** — `value`/`label` args silently discarded; rows render title-only | Consumer rows and Enterprise device rows v1 had no sub-labels | Fixed (sub-labels re-added as explicit text, all sample-labeled) |
| D5 | **Weight mapping error** — `weight 600` compiled to Inter **Black** (900), not Semi Bold | Nav "Models"/"Fleet", header titles | Fixed (setTypography → Semi Bold) |
| D6 | **topologyMap scatter** — topology pieces (hub, deviceNode frames, title) emitted as independent grid cells across the parent region instead of a composed cluster band | Enterprise v1-Fleet: hub at (24,266), nodes at grid slots, title at (519,228) | Fixed (composed band at y 496–645) |
| D7 | **Stale routed connectors** — compiler connectors routed once from the original node positions; after any node move they remain fixed, drawing arrows across unrelated regions | Root-level vectors `526:649-653` routed to pre-repair positions crossing rows 4–6 | Fixed (removed; replaced with 2 true vector line nodes forming the bus, muted to 55 % opacity so they cannot read as controls) |
| D8 | **WCAG contrast failures in compiler output** — nav dim items 2.61:1, technical notes 3.38:1 on product surfaces | Both fixtures' nav + footnote text | Fixed with evaluator-verified fills (`#8C8C7F` / `#8C8B82` / `#76766E`) |
| D9 | **10 px operational text** — compiler emits 10 px for metadata labels/notes (below its own rules' 11 px floor) | 15 nodes across both fixtures | Fixed (all raised to 11 px) |

### 3.2 Transaction reliability defects (P1 evidence, engine-side)

| id | Defect | Reproduced as |
|---|---|---|
| D10 | **Client-timeout dual commit** — when MCP client times out during orchestration, the plugin may still commit a chunk; the automatic retry then commits a *second* full copy | Two identical frames `523:427` + `525:483` from one logical build; duplicate removed by hand (`txn_7e123770`) |
| D11 | **Partial-rollback restoration gap** — after a mid-transaction failure, created nodes are left in the document although the txn is labelled rolled-back | `txn_f6c921d6` marked `partial-rollback` but nodes `525:627-630`, `525:636-647` persisted as junk inside the inspector |
| D12 | **Transaction tail-loss** — ledger reports `done = opCount` while trailing ops are not persisted, and there is no completion confirmation to the client | `txn_4e5ccc2d` (39/39 ops) — the final `setPosition` (Detail x) never landed; re-applied separately. Same symptom later on `525:520` position during the polish pass |
| D13 | **setPosition silently no-ops inside auto-layout** — operation reports success but the engine reflows children (positions not meaningful), silently discarding the intent | `Fits` panel: three successive position attempts ignored; resolved only by `setAutoLayout VERTICAL` so the engine itself produces the stacking |
| D14 | **Manual undo interplay** — user Cmd+Z walks back committed plugin transactions at mutation granularity, reverting *some* ops of different transactions inconsistently (row ops reverted while band ops in the same txn survived) | Mid-run undo cascade gutted inspector content + row sub-labels + 4 row positions while leaving resized frames, band positions and connectors intact; full re-apply executed atomically after user confirmation |

D10–D14 are the transactional-reliability class issue #21 wanted surfaced for P1: they are reproducible, evidence-backed, and they bite real users (duplicates, leftovers, silent loss).

## 4. Repairs applied to the fixtures (final verified state)

### Consumer `525:483` — Review: **PASS (0 findings)**
- Inspector at right rail (1042,173 398×787); catalogue sized 778×516 so regions tile without overlap.
- Catalogue rows single-column ordered (y 62/137/212/287, w 730) with sample-labeled sub-labels (memory estimates + quantization + "may not fit").
- Inspector stack: eyebrow → title (Semi Bold) → 3 spec rows → memory budget (generic track 330 px; green fill 9 px ≈ 5.4/192) → Fits verdict panel (vertical auto-layout: "Fits" + "Below largest device (sample figures).") → primary "Run model" → "Untested vs pinned EXO build · Proposed" note.
- Nav items + notes → verified contrast fills; all metadata text ≥11 px.
- Final render verified: no overlaps, no overflow, honest labels.

### Enterprise `525:587` — Review: **PASS (0 findings)**
- Fleet 778×664; six device rows single-column ordered (y 62→442, h 64 with sub-labels: health · utilization · restarts · memory, all `(sample)`).
- Row "node-b5-04" covered by the inspector (Degraded status: amber `● Degraded (sample)`, memory budget 71/96 amber fill, "Inspect device" button, Roles/multi-cluster `Proposed · unpinned` note).
- Topology band: hub → mac-studio-01 / mac-studio-02 / node-b5-04 (selected: blue) wired on a bus **below** the node row; offline node-c9-11 on dashed branch; links are 2 true vector line nodes named `… (sample, not clickable)`, muted to 55 % opacity so they cannot read as controls (this also cleared the reviewer's two earlier medium-confidence false positives).
- Section action "Filter" right-aligned (was colliding with section title).
- Weight + contrast + 11 px metadata fixes identical to consumer.

## 5. Known leftovers (in-scope, judgment calls documented)

1. **design_guard verdicts** — consumer `WARNING`, enterprise `INDETERMINATE`. Zero product-truth FAILs on either; the non-PASS verdicts come only from rules the guard itself marks **needs a human judgement** (`exo.developer-apis` wording, `exo.topology-explains-relationships`, `exo.model-fit-context` sub-checks). All hard `EXO`-rules PASS. A human verdict on those belongs to a maintainer pass on the production screens, not this fixture task.
2. **Capability pin** — remains BLOCKED per repo policy; fixtures therefore label every capability as Estimated/Proposed instead of pinning (per the #17–#20 policy decisions).

## 6. Verdict per issue-#21 priority

| Priority | Verdict | Evidence |
|---|---|---|
| P1 layout reproduction | **Reproduced** | D1–D9 above, all on current build, with before/after renders (4 renders retained in this conversation record) |
| P1 transaction reliability | **Reproduced** | D10–D14 with txn ids from the ledger |
| Fixtures | **Complete** | Consumer `525:483` review **PASS (0 finding)**; enterprise `525:587` review **PASS (0 findings)** after connector→vector conversion; both repaired to honest, labeled, aligned sample screens |
| EXO product truth | **Preserved** | All `EXO`-rules PASS on both frames; truth labels intact; registry untouched; no production screens touched |

## 7. Artifacts & traces

- Frames: `525:483` (consumer), `525:587` (enterprise) on page `New Designs `.
- Undo-cascade/dupe/remove traces: `txn_42d34e1a` (full rollback of first consumer build), `txn_7e123770` (duplicate removal), `txn_f6c921d6` (partial-rollback gap), `txn_5ef1660b` (43-op enterprise commit), `txn_4e5ccc2d` (tail-loss repro), QA pass txns applied 2026-10-21.
- Defect numbers above are exact measured values from `collect_metrics`, `review_design`, and `render_design` runs of this session; renders both before and after repairs are embedded in the task transcript.
- Prior gate evidence format followed: `docs/issue-20-report.md`.
