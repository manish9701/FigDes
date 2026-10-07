---
name: figdes-use
description: Native Figma execution for FigDes — how to build fast without tripping safety rails.
---

# figdes-use

Native execution foundation: which execution mode to use, how to batch for
speed, and how to recover. Read this before calling `figdes_use_figma`.

## Execution modes (pick one per pass)

1. **Semantic** (`design_runtime`) — standard product UI from primitives.
   One call compiles to one transaction. Always the fastest path for screens.
2. **Native batch** (`figdes_use_figma` + `fig.batch`) — creative/custom work:
   logos, vectors, booleans, diagrams, slides. One logical pass per script,
   related operations inside `fig.batch([...])` with `$refs`.
3. **Inspect** (`figdes_use_figma` with `readonly: true`, or
   `figdes_read_context`) — reads only. Skips the session lock, so inspection
   runs concurrently. Mutations are refused, never silently unprotected.

## The performance contract

- A complex pass should be **one script, few RPCs**: `begin + batch + commit`
  is 3 RPCs for any number of operations. A script with 50 sequential
  `await fig.*` calls is 52 RPCs and will feel minutes slow.
- `fig.batch` operations execute locally in the plugin through the same
  validate-then-dispatch path as individual calls: same allowlist, same
  parameter validation, same transaction. Only the round-trips collapse.
- Batch results are **compact by default** (id, type, name, bounds). Full
  summaries are available per batch (`compact: false`) but cost context.
- **Never render per operation.** Construction scripts stay render-free;
  run `figdes_inspect_visual` / `render_design` / `collect_metrics` only at
  checkpoints (skeleton done, pass done). Render time dominates everything.
- **Context is lightweight first**: `figdes_read_context` defaults to an
  800-node, depth-2 design-system snapshot. Escalate `maxNodes`/`depth` only
  when the summary reports truncation.

## Batch `$ref` pattern

```js
const { results } = await fig.batch([
  { action: "createFrame", params: { name: "Card", width: 320, height: 200 }, ref: "card" },
  { action: "createText", params: { parent: "$card", content: "Hello", fontSize: 20 } },
  { action: "setFill", target: "$card", params: { paint: "#FFFFFF" } },
  { action: "setAutoLayout", target: "$card", params: { direction: "VERTICAL", itemSpacing: 12 } },
]);
// results: [{ ref: "card", id: "12:34", type: "FRAME", x, y, width, height }, ...]
```

Rules: `ref` names a created node; later ops use `"$name"` or `{ $ref: "name" }`
as `target`/`parent`/any id field. A batch failure reports its index
(`Batch op 2 (setFill) failed: …`) and the surrounding transaction rolls back,
so a half-built pass never lands.

## Telemetry

Every execution returns `telemetry: { rpcCalls, batchOps, pluginMs, totalMs }`
plus the script's own `result`. When a pass is slow, read it before guessing:
high `rpcCalls` with low `pluginMs` means transport-bound (batch more);
high `pluginMs` means Figma-bound (fewer/smaller ops).

## Recovery

| Code | Meaning | Fix |
|---|---|---|
| `UNKNOWN_ACTION` | invented action | use a listed name |
| `INVALID_PARAMETERS` | wrong field | the field path names it |
| `RPC_LIMIT` | too many calls | rewrite with `fig.batch` |
| `ABORTED` | 30s budget hit | split into smaller passes, inspect first |
| `NODE_NOT_FOUND` | stale id | re-inspect, use fresh ids or `$refs` |
| `FONT_UNAVAILABLE` | missing font | use an installed family |

## Workflow (Diamond loop)

`inspect (readonly) → plan → skeleton batch → compose batches → render →
critique → revise batch → lock`. Never one giant transaction for the whole
creative decision; never a render between every operation.
