# Issue #18 — closing the end-to-end pipeline reliability gaps

Code under test: **this commit**

## What this pass changed

Issue #18 asks for the whole pipeline to be demonstrably reliable, not one part
of it. The work is spread across the seven sections the issue lists; this pass
closes the parts that are defects in the code rather than gaps in the process.

### P0 — the layout compiler and geometry correctness

| Change | Where |
| --- | --- |
| **Text is measured, not estimated.** Figma owns the font and the metrics, so the plugin measures each string at the width the layout resolved, and the compiler lays the screen out from the measurement. The estimate survives only as the offline fallback. | `figma-plugin/src/measure.ts`, `mcp-server/src/runtime/measure.ts` |
| **The coordinate-space contract is written down and enforced.** Resolved boxes are page-absolute; emitted operations are parent-local; the blocking `operation-trace` check reconciles the two. | `mcp-server/src/runtime/compile.ts`, case B08 |
| **Containment fails closed.** Content that escapes the region that owns it is a blocking violation, unless the region explicitly allows overflow. | `mcp-server/src/runtime/compile.ts` |
| **The dry run and the built screen are compared.** The pipeline reads the created frame back and checks it against the plan. | `mcp-server/src/pipeline/tools.ts` |
| **The pipeline gives the screen's identity a band.** A plan with no header put the name, the task and the primary action into a 208px navigation rail — a title in a 53px column. The pipeline now adds the band and re-resolves the layout. | `mcp-server/src/pipeline/plan.ts` |
| **Relationships get a diagram.** A brief whose information is about relationships planned a list, because the planner picks the shell from the decision's phrasing. | `mcp-server/src/pipeline/plan.ts` |
| **A region that fills less than 55% of its box is a finding.** The live render of the stress frame was sixty percent empty, and every structural check had passed. | `mcp-server/src/pipeline/verify.ts` |

### P0 — semantic collision and containment logic

The reviewer now classifies a shape before it judges it: a **connector**, an
**input**, a **card**, a **background** or a **rule**. The false positives the
issue names were measured on the live V4 design, and the fixtures use its real
geometry:

| Was reported | Why | Now |
| --- | --- | --- |
| the search placeholder as a serious text-route-collision | the field is 930×44 — a 21:1 aspect ratio, and the aspect ratio was the only signal | an input is not a connector |
| a device label on the topology's grid line | a named grid is a decoration, not a connection | a decoration is not a connector |
| a divider as an unlabelled control, and as a too-small tap target | "divider" matched the interactive *name* pattern | a rule has no body and cannot be pressed |

The genuine collision (a label on a real connector) is still **serious**, and a
genuine unlabelled icon button is still reported. Case E02.

### P0 — scope resolution and trustworthy verdicts

- **`review_design` returns a verdict**, not just a count: `PASS`, `FAIL`,
  `REVIEW` or `INDETERMINATE`, with the nodes examined, the rules evaluated, the
  truncation and the reason. A scan that read no nodes is `INDETERMINATE` — never
  a pass.
- **`design_guard` takes a target.** A node id is used directly; a name is
  resolved; a name that matches several frames is an **ambiguity** that asks,
  rather than a random selection that is checked. The resolved target is
  reported with the verdict.

### P1 — a verified repair loop

`mcp-server/src/review/verdict.ts`. Every loop re-measures, pairs the findings
before and after, and gives itself a verdict: **PASS** (nothing survived, nothing
new appeared), **FAIL** (a repaired finding is still there, or the repair
introduced a new one), **INDETERMINATE** (the re-check could not run). The
before/after measurement is recorded for every repair, not only for the ones
that failed.

### P1 — design-system reuse

The capability was missing: a text node could not bind the file's own text
style, so a new screen could not use `EXO/Title` even when the file had it.
`createText` now accepts a `textStyleId`, the runtime's text primitive carries
it, and a program can bind the file's style rather than redrawing the type.

### P1 — build identity

The server carries a build stamp, the panel shows its own, and the status
compares the two: `same-commit`, `different-commit` or `unverifiable`. The
plugin bundle is rebuilt with the stamp baked in.

## The release gate

`npm run gate` runs the whole lifecycle and gives one verdict:

```
PASS  gauntlet          25/25 cases, run twice with identical verdicts
PASS  stress-matrix     every case
PASS  acceptance        every case
PASS  regression        898/898 tests
PASS  design-benchmark  9/9 cases
PASS  live              10/10 live cases with real renders and reviews
VERDICT: PASS
```

The live group still reports that its ten cases were measured against an older
commit and cannot name their build: that is the truth until the deployment is
refreshed and the panel is reopened.

## Not closed by this pass

Stated rather than left for someone to find:

1. **The live plugin still runs the old bundle.** Figma loads `dist/code.js` when
   the plugin starts, so the rebuilt bundle reaches the file only when the
   plugin is closed and reopened. Until then the live status says
   `plugin: unknown`, which is the honest answer.
2. **The deployed server is one commit behind** the code in this report, so the
   new compiler, the new rules and the new verdicts are not live yet. The gate
   says so on every run.
3. **The pipeline does not yet choose the file's text styles by itself.** The
   capability is there (`textStyleId`); the mapping from a screen's roles to
   `EXO/Title` and friends is not, and it needs the design-system scan wired
   into the plan.
4. **The live gauntlet has not been run on the build whose SHA is recorded**,
   for the reason in (2). The offline gauntlet passes on this commit.
5. **Text height is still estimated when no plugin is connected.** The measured
   path needs a live document; the offline dry run says which path it used.
