# Issue #19 — Consumer Model Library accessibility and design-system fixes

Live frame: **`V2 · Consumer · 02 Model library` (`358:1551`)** on page `New Designs `,
file `Exo Labs`.
Repo baseline for the code change: **`b051f18bdd30`**; landed as **`69fb17a`**
(`setTextStyle` + 0.2.0) with report follow-ups in **`5d6c738`**.
Final end-to-end verification ran with plugin and server on the **same**
build, **`5d6c73829256`** (`same-commit`, v0.2.0) — see §3 and §6.

## 1. Before

`review_design` on `358:1551` returned **FAIL** (35 nodes, 20 rules), exactly
matching the issue:

| Finding | Nodes |
|---|---|
| `text-contrast` — 7 nodes at 3.86–4.22:1 against `#EEECE5`/`#F7F6F2`, below WCAG AA 4.5:1 | `358:1554`, `358:1555`, `358:1557`, `358:1561`, `358:1562`, `358:1563`, `358:1565` |
| `color-only-state` — 4 `#D9E66A` accents with no detected state label | `358:1567`, `358:1572`, `358:1577`, `358:1582` |
| `tap-target-size` — primary action `172×40` | `358:1558` |
| `duplicate-siblings` — 4 identical `1128×118` row surfaces | `358:1566`, `358:1571`, `358:1576`, `358:1581` |

`audit_design` returned **REVIEW** with 1 grouped finding: `unstyled-text`
covering **23** text nodes (wordmark, workspace, breadcrumb, title, subtitle,
action label, section label, 4 nav items, 4× row title/detail/status).

## 2. What was changed live (all committed, none dry-run-only)

**Txn `txn_a44f8625` — contrast, target size, status redundancy.**
Seven `setFill` repairs using exactly the reviewer-proposed fills
(surface-specific — see §4), `setSize` of the primary action to `172×44`
with `setPosition` to `y=46` so its vertical centre does not move, and
`setTextContent` on the four row-status labels to `✓ Installed` (×3) and
`○ Available` (×1) so state survives greyscale.

**Status glyphs + left alignment.**
Row titles became `✓ Qwen2.5 Coder 7B`, `✓ Mistral Nemo 12B`,
`✓ Llama 3.1 8B Instruct`, `○ Gemma 2 9B`; titles and details moved from
`x=288` to `x=276` (8 px from the accent edge, inside the reviewer's
16 px sibling-label window, no overlap with each other). Colour is now
backed by two text cues per row: the leading glyph and the right-hand
status word. Txn `txn_bf5f0202`.

**Row structure + reusable component.**
The four flat 5-node row clusters were grouped (`txn_2ca8455b`) into
`Model row — …` groups (`466:574`–`466:577`), then the first group was
promoted with `create_component` to **`Model row / Installed` (`466:578`)**.
Promotion consumed the group into a page-level master, so an instance
(`466:579`) was placed back into the frame at `264,204`. A follow-up
`update_component` normalised the master's children to component-relative
coordinates (they had retained absolute frame coordinates, which rendered
the instance double-offset and briefly produced a false `overflow`
finding). The other three rows stay as identically-structured groups;
migrating them to instances with per-model text overrides is open work
(the operation layer has no text-override primitive for instances).

## 3. After (re-run on the same frame, per the acceptance criteria)

- `review_design(358:1551)` → **PASS, 0 findings.** Contrast, colour-only
  state, tap-target and duplicate-sibling findings are all gone.
  Re-verified on matching builds (plugin `5d6c73829256` = server
  `5d6c73829256`, `same-commit`), so this is a valid end-to-end pass, not
  a cross-build reading.
- `audit_design(358:1551)` → **PASS, 0 findings**, re-verified on the same
  matching builds.
- `design_guard(inspect, target 358:1551)` → **0 failures** (6 PASS,
  7 INDETERMINATE/manual). No product-truth violation was introduced.
- `render_design(358:1551, low)` → layout verified by eye: four aligned
  rows, Qwen row restored on top, glyphs + status words legible, primary
  action visually unchanged at `172×44`.

Acceptance mapping: normal-text contrast ✓ (measured, §4); status without
colour ✓ (glyph + word); `≥44 px` target ✓ (`172×44`); reusable row
structure ✓ (component + instance + consistent groups); semantic text
styles ✓ (all 23 bound, audit PASS — §6).

## 4. Contrast evidence (measured, not claimed)

`#77766E` on `#EEECE5` = **3.86:1**; on `#F7F6F2` = **4.22:1**;
on `#FFFFFF` = 4.56:1 (which is why row details on white were never
flagged). Applied repairs: `#6C6B64` on `#EEECE5` = **4.53:1** (sidebar
texts `1554`, `1562`, `1563`, `1565`); `#72716A` on `#F7F6F2` =
**4.53:1** (main-column texts `1555`, `1557`, `1561`). The fills are
surface-specific and not interchangeable: `#72716A` on `#EEECE5` measures
4.15:1 and fails. Status `#52633A` on white = 6.55:1; action label
`#252620` on `#D9E66A` = 11.24:1. These pairs are locked by
`tests/issue-19-regressions.test.mjs`.

## 5. Repo change: the missing `setTextStyle` operation

The audit could never clear because no mutating operation binds a style to
an existing node (`createText.textStyleId` is create-only, and the
`figdes_use_figma` sandbox cannot reach the style APIs). Added:

- `shared/protocol.ts` — `SetTextStyleOp` (`target` + `style` accepting a
  local style name or id) in `OperationSchema`, so server preflight,
  `modify_design`/`create_design`/`update_component` and suggested-operation
  validation accept it with no further wiring.
- `figma-plugin/src/operations.ts` — handler: TEXT-only check, lookup by
  name-or-id via `getLocalTextStylesAsync`, actionable error naming
  `createTextStyle`/`seed_exo_system` when missing, bind via
  `setTextStyleIdAsync` (sync fallback for older API surfaces), journalled
  `textStyleId` for truthful rollback including an async-setter restore
  path under `documentAccess: dynamic-page`.
- `mcp-server/src/preflight.ts` (`MUTATE_TARGET_TYPES`) and the
  `OPERATION_GUIDE` in `mcp-server/src/tools.ts`.
- `tests/issue-19-regressions.test.mjs` (7 tests: bind by name/id, unknown
  style fails cleanly, non-text refusal, rollback restores the prior
  binding, preflight acceptance, §4 contrast locks); `test:issue19` script
  chained into `npm test`. `tsc --noEmit` clean; neighbouring suites pass:
  `plugin-runtime` + `review` + `reliability` (190), `invariants` +
  `live-evidence` (27), issue-10/11/14 sets (96).

## 6. Remaining work (recorded, not hidden)

**Version:** after the user's redeploy + plugin re-upload, `figma_status`
reports plugin **`0.2.0`** (`PLUGIN_VERSION` bumped in `shared/protocol.ts`,
mirrored in both `package.json` files, `package-lock.json`, and the MCP
server name in `mcp-server/src/mcp.ts`; `tests/plugin-runtime.test.mjs`
asserts `0.2.0`). Rebuild (`npm run build`, `npm run build:test`) and
`tsc --noEmit` are clean; `issue-19` + `plugin-runtime` + `smoke` pass
(127 checks). **Rule going forward: every plugin/server change ships with
a version bump** — the version is the only thing that distinguishes two
bundles built from the same commit.

1. **Bind the 23 nodes — DONE live.** `EXO/Brand` (Inter 700/25, for the
   wordmark) was created (`txn_9ca510f1`); all 23 bindings applied in
   `txn_b58e91e2` per the mapping below (instance children follow the
   master `358:1568–1570`, so only master + grouped texts were targeted).
   One follow-up: binding `1554` to Mono `EXO/Eyebrow` tripped
   `tiny-technical-text` (uppercase kicker read as operational, floor 11 px),
   so it was rebound to `EXO/Caption` (Mono 11) in `txn_f1b925c3`.
   Final re-run on the same frame: **`review_design` PASS (0 findings),
   `audit_design` PASS (0 findings)**, `design_guard` 0 failures, and a
   fresh low-detail render confirms the layout holds after the size changes
   — all measured with plugin and server on build `5d6c73829256`
   (`same-commit`, v0.2.0).
   Two process notes: (a) the interactive session's cached tool catalog
   predates `setTextStyle`, so the batch went through a direct MCP call —
   restart the agent session to refresh the catalog; (b) an intermediate
   verification ran while the plugin was still on `b051f18bdd30-dirty`
   against server `5d6c73829256` (`different-commit`) and is **not** counted
   as the end-to-end pass — only the same-commit re-run above is.
   Recommended semantic mapping against the existing `EXO/*` styles (all Inter unless noted):
   - `1553` wordmark (25 Bold) → **new `EXO/Brand`** (25 Bold) — a logotype
     must not be squeezed into `EXO/Title`; creating the style first keeps
     the audit honest. Applied, no visual change.
   - `1554` Workspace → `EXO/Caption` (Mono 11 Regular). First bound to
     `EXO/Eyebrow` (Mono 10) per the kicker convention, but the
     all-uppercase content classifies as operational (floor 11 px), so it
     moved to Caption — same Mono voice, one px larger.
   - `1554` Workspace → `EXO/Eyebrow` (Mono 10); `1555` breadcrumb →
     `EXO/Caption` (Mono 11); `1561` section label → `EXO/Caption`
     (sidebar kickers/breadcrumbs are Mono across the EXO screens).
   - `1556` page title (30 Semi Bold) → `EXO/Title` (24 Semi Bold; verify
     reflow). `1557` subtitle → `EXO/Small` (exact 13 Regular).
   - `1559` action label → `EXO/Action` (13 Semi Bold).
   - `1562`/`1563`/`1565` nav → `EXO/Nav` (exact); `1564` Models →
     `EXO/NavActive` (exact).
   - Row titles (16 Semi Bold) → `EXO/Subtitle` (18 Semi Bold; rows have
     room). Row details → `EXO/Tiny` (exact 12 Regular). Row status →
     `EXO/Health` (Inter 11 Medium; status semantics match).
   - Ready op shape: `{ "type": "setTextStyle", "target": "<node>", "style": "EXO/Nav" }`
     (instance children `I466:579;…` bind through the master: apply to the
     master texts `358:1568–1570` once and all instances follow).
2. **File hygiene found along the way:** two text styles share the name
   `EXO/Wordmark` (Inter Regular 12 and Inter Semi Bold 15) — name
   binding is ambiguous until one is renamed.
3. **Rows 2–4 → instances** once instance text overrides are supported.
4. This report, not a dry run, is the completion evidence for every
   criterion; all six acceptance items verify live on frame `358:1551`.
