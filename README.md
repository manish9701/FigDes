# Figma Design Agent

ChatGPT → custom MCP server → Figma plugin → **native** Figma Plugin API.

Figma's own MCP server is **not** used anywhere in this chain. Every change is
applied by the Figma Plugin API inside the user's open file, so it is subject
to no Figma MCP tool-call quota.

```text
ChatGPT
   │  Streamable HTTP
   ▼
/mcp  (Design Agent MCP server, this repo)
   │  WebSocket
   ▼
/ws   Figma plugin iframe
   │  postMessage
   ▼
plugin main thread → figma.*  →  native Figma document
```

## Layout

```text
figma-design-agent/
├── scripts/launch.mjs        one-command launcher: server + tunnel + URL
├── shared/
│   ├── protocol.ts        wire format + the zod operation allowlist
│   ├── ir.ts              Design IR schema (canvas, regions, content)
│   └── contrast.ts        WCAG maths, shared by the critic and the panel
├── figma-plugin/
│   ├── manifest.json
│   ├── src/code.ts           main thread: owns figma.*, no network access
│   ├── src/operations.ts     the ONLY place that mutates the document
│   ├── src/inspector.ts      depth/budget-limited node serialization
│   ├── src/cache.ts          page/variable/style caches (perf)
│   ├── src/resolve.ts        colour flattening + ancestor compositing
│   ├── src/design-system.ts  design-system extraction
│   ├── src/metrics.ts        measurements for the critic
│   ├── src/panel.ts          what the panel shows (no server needed)
│   ├── src/render.ts         node → PNG, with the context budget
│   ├── src/components.ts     find / promote / instance / variants
│   ├── src/find.ts           semantic node targeting by role/name/text
│   ├── ui/index.html         iframe — the only context with network access
│   ├── ui/ui.ts              minimal status light + server connection (no workbench)
│   ├── ui/transport.ts       DOM-free wire transport used by ui.ts and e2e tests
│   └── esbuild.config.mjs
├── mcp-server/
│   └── src/
│       ├── index.ts          one process: /mcp + /ws + /health
│       ├── mcp.ts            MCP server + Streamable HTTP transport
│       ├── tools.ts          the tool surface
│       ├── sessions.ts       session registry, request/response correlation
│       ├── security.ts       bearer auth for both transports
│       ├── render-tool.ts    render_design + the context budget note
│       ├── review/
│       │   ├── contrast.ts   re-export of shared/contrast
│       │   ├── rules.ts      the deterministic critic (+a11y rules)
│       │   ├── score.ts      0-10 composition scoring from measurements
│       │   └── workflow.ts   score/refine/diff tools
│       ├── code/
│       │   └── export.ts     frame to React + Tailwind, deterministic
│       ├── tokens/
│       │   └── exo.ts        the canonical exo token set
│       ├── memory/
│       │   ├── store.ts       atomic, file-backed project memory
│       │   ├── rules-exo.ts   the EXO product truths as checkable data
│       │   ├── guard.ts       PASS / WARNING / FAIL with evidence
│       │   └── tools.ts       project_memory + design_guard
│       ├── snapshots/
│       │   └── store.ts       V1/V2/V3 checkpoints with programs
│       ├── plan/
│       │   ├── planner.ts      decision -> composition + five passes
│       │   ├── brief.ts        design_brief: goal, object, hierarchy, risks
│       │   ├── checkpoints.ts  human approval rules
│       │   ├── gate.ts         mutating-tool refusal + approvals
│       │   └── tools.ts        plan_screen (+variants, archetypes, deck)
│       └── runtime/
│           ├── interpreter.ts  primitives -> Design IR (no eval)
│           ├── layout.ts       solveAxis / radial / force / pack
│           ├── algorithms.ts   tree / masonry / timeline / cluster
│           ├── constraints.ts  relationship solver (rightOf, below, fill)
│           ├── connectors.ts   routing, endpoint clipping, arrowheads
│           ├── marks.ts        logo geometry: polygons, stars, rings, marks
│           ├── compile.ts      Design IR -> Figma operations
│           └── tools.ts        design_runtime + compile_ir
├── shared/
│   ├── protocol.ts           operation allowlist + wire types
│   ├── ir.ts                 the Design IR
│   ├── memory.ts             notes, product rules, verdicts
│   ├── contrast.ts           WCAG maths, shared by critic and runtime
│   └── path.ts               SVG path parser + bbox normalisation
├── .memory/                  durable per-project design memory (committed)
└── tests/
    ├── smoke.mjs             65 end-to-end checks with a mock plugin
    ├── review.test.mjs       31 tests over the critic
    ├── code.test.mjs         9 tests over the React + Tailwind exporter
    ├── ui.test.mjs           5 checks: UI/HTML agreement, minimal panel, progress + stream wiring
    ├── runtime.test.mjs + plan.test.mjs  206 tests over runtime, intent, planner, solver, gates, templates, slides, marks, scoring
    ├── plugin-runtime.test.mjs  93 tests against the real bundled plugin
    └── plugin-e2e.test.mjs   15 checks: real bundle + real server over a real socket, incl. live stream
```

`tests/plugin-harness.mjs` loads the actual `dist/code.js` against a mock Figma
API. That is what makes plugin-side bugs testable — previously the only signal
was ChatGPT reporting something vague.

## Setup

```bash
npm install
npm run build        # bundles the plugin (figma-plugin/dist) and the server
npm test             # 424 checks: critic, code, UI, runtime/planner, plugin runtime, smoke, e2e
```

## Run it

```bash
npm start
```

That is the whole command. It starts the server, opens a public HTTPS tunnel,
waits for the real address, then prints it in a box, **copies it to your
clipboard**, and saves it to `.tools/current-url.txt`.

```
----------------------------------------------------------------
  YOUR CHATGPT ADDRESS
----------------------------------------------------------------

  https://something.trycloudflare.com/mcp

  Already copied to your clipboard.
```

Paste it into ChatGPT → Plugins → `+` → Connection URL. Include the `/mcp` path;
ChatGPT does not add it for you.

Other modes:

```bash
npm run start:local             # server only, no tunnel - for MCP Inspector
npm run start:server            # bare server process
npm run watch:plugin            # rebuild the plugin on save
npm start -- --provider=tailscale   # stable hostname, free, no domain
npm start -- --provider=ngrok        # stable hostname via ngrok's free dev domain
```

## More agents on the same server

Yes — ChatGPT, Claude, Antigravity and anything else can connect at once. The
server is stateless per request and shares one session registry, so concurrent
clients are safe by construction. Two honest caveats: agents editing the *same*
file interleave at transaction granularity (last writer wins per transaction —
give them different areas, or preview with `dryRun` first), and they share one
render budget per open file.

Local clients need no tunnel — they reach the server directly:

| Client | Where | URL |
|---|---|---|
| ChatGPT | Connector URL | the `trycloudflare.com/mcp` address from `npm start` |
| Claude Code | `claude mcp add --transport http figma-design-agent <url>` | `http://127.0.0.1:8787/mcp` |
| Antigravity | `mcp_config.json` (below) | `http://127.0.0.1:8787/mcp` |
| Cursor / VS Code / Windsurf | MCP settings, Streamable HTTP | `http://127.0.0.1:8787/mcp` |

### Antigravity setup

No tunnel, no account, no auth to configure — Antigravity runs on your machine,
so it talks to the server over localhost:

1. Start the server once: `npm run start:local` (leave it running).
2. Open the agent side panel → `…` → **MCP Servers** → **Manage MCP Servers** →
   **View raw config**. Or edit the file directly:
   - global (all workspaces): `~/.gemini/config/mcp_config.json`
   - this workspace only: `.agents/mcp_config.json`
3. Add:
   ```json
   { "mcpServers": { "figma-design-agent": { "serverUrl": "http://127.0.0.1:8787/mcp" } } }
   ```
4. Restart Antigravity (or Refresh in Manage MCP Servers), then ask the agent to
   list its tools — you should see all 33, from `plan_screen` to `export_code`.
5. Open the Design Agent plugin in your Figma file so there is a live session to
   drive. Then: *"Plan a topology screen for my cluster with plan_screen"* is a
   good first prompt.

Tip: if 33 tools feel like a lot of context, Antigravity supports
`"disabledTools": [...]` on the entry to withhold the ones you never use.

### Hosting the server on Render (no local terminal)

Run the server on Render and drive it from anywhere. The tradeoff is auth:
on a public host `/mcp` must have a secret, so only clients that can send a
Bearer header work (Antigravity, Claude Code, Cursor — not the ChatGPT
connector, which cannot).

1. On Render, set two env vars (strong random strings, may be the same value)
   and redeploy:
   - `DESIGN_AGENT_SECRET` — guards `/mcp`
   - `PLUGIN_SECRET` — guards `/ws` (falls back to the MCP secret if unset)
2. Allow the Render host in `figma-plugin/manifest.json`, keeping localhost:
   ```json
   "networkAccess": {
     "allowedDomains": ["https://YOUR-APP.onrender.com", "wss://YOUR-APP.onrender.com"],
     "devAllowedDomains": ["http://localhost:8787", "ws://localhost:8787"],
   }
   ```
3. In Figma, remove and re-add the dev plugin (the manifest is read at import),
   open it, and under **Server connection** paste the public URL plus the
   secret, then Apply. The socket line should turn green.
4. Point agents at it:
   - Antigravity `mcp_config.json`:
     ```json
     { "mcpServers": { "figma-design-agent": {
       "serverUrl": "https://YOUR-APP.onrender.com/mcp",
       "headers": { "Authorization": "Bearer YOUR-DESIGN-AGENT-SECRET" }
     } } }
     ```
   - Claude Code: `claude mcp add --transport http --header "Authorization: Bearer ..." figma-design-agent https://YOUR-APP.onrender.com/mcp`

   No tunnel, no terminal. Figma Desktop with the plugin open is still required —
   there is no other path into the document.

The tunnel URL is read out of the tunnel's own output rather than scraped from
the terminal, because cloudflared prints it to stderr inside a box that scrolls
past before you can read it.

### Setting the ChatGPT endpoint up once

With the default `cloudflared` quick tunnel the hostname is random every launch,
so ChatGPT needs updating each time. Two fixes, both automatic once configured:

**Option A — Tailscale Funnel (recommended).** Free on every plan, permanent
`device.tailnet.ts.net` hostname, no domain to buy, no interstitial page.

```powershell
npm install -g tailscale
tailscale up
# then enable Funnel for your tailnet in the admin console
npm start -- --provider=tailscale
```

**Option B — ngrok's free dev domain.** Every free account is permanently
assigned one hostname.

```powershell
npm install -g ngrok
ngrok config add-authtoken YOUR_TOKEN
npm start -- --provider=ngrok
```

Either way, the launcher saves the hostname to `.tools/endpoint.txt` and
**reuses it on every subsequent start** — no tunnel is even opened, and you
never paste a new link into ChatGPT. Delete that file to go back to a quick
tunnel.

**`localhost` cannot work here.** ChatGPT's connectors only accept remote HTTPS
endpoints — OpenAI's servers cannot reach a port on your machine. The port is
irrelevant; the address must be publicly resolvable. The plugin itself has no
such restriction, which is why it talks to `localhost:8787` directly.

For iterating on the plugin, `npm run watch:plugin` rebuilds on save, then close
and re-run the plugin in Figma.

## 1. The panel

Opening the plugin shows a dashboard, not a log viewer. Everything on it is read
straight from the Figma API, so it stays useful with the server offline.

- **Selection** — type, name and dimensions of what is selected
- **This file uses** — palette swatches, colour count, components, variables,
  default-named layers, the type ramp, and the inferred spacing base
- **Contrast** — WCAG AA failures inside your selection, ranked by severity.
  Click one to select that layer in Figma and zoom the viewport to it.

Sections update automatically on selection and page change. `Server connection`
and `Activity log` are collapsed by default.

## 2. Run the plugin in Figma

1. Open a design file in the **Figma desktop app** (not the browser — the
   plugin iframe's WebSocket and `dynamic-page` document access need it).
2. Plugins → Development → **Import plugin from manifest…**
3. Pick `figma-plugin/manifest.json`.
4. Run it. The panel should turn green and show `session_…`.

The panel has a server URL and secret field. Defaults to
`http://localhost:8787`. It persists to Figma's `clientStorage`, so you only
set it once. Leave the plugin open — every tool call needs it.

## 3. Test locally before involving ChatGPT

```bash
npx @modelcontextprotocol/inspector@latest
```

Connect to `http://localhost:8787/mcp` and run, in order:

```text
figma_status          → connected: true, fileName: "EXO Labs"
inspect_selection     → native node tree
create_design         → a real 400×300 frame
modify_design         → rename + resize it
undo_last_operation   → reverts the transaction
```

Do not move to ChatGPT until this works. SPEC §24.

## 4. Connect ChatGPT

**Two hard constraints, both from OpenAI, not from this repo:**

1. **ChatGPT cannot reach a local server.** Custom MCP connectors are remote
   HTTPS only. You need a tunnel.
2. **ChatGPT cannot send a bearer token.** Custom connectors accept only
   *no auth* or *OAuth*. So leave `DESIGN_AGENT_SECRET` unset — set
   `PLUGIN_SECRET` instead to keep the Figma document channel locked.

Developer mode also requires a paid plan (Plus/Pro/Business/Enterprise/Edu),
and on Business/Enterprise/Edu a workspace admin may have to enable it.

### Steps

1. Start the server **with `PLUGIN_SECRET` set**:

   ```powershell
   $env:PLUGIN_SECRET = "pick-a-long-random-string"
   npm start
   ```

2. Open a tunnel to it:

   ```powershell
   cloudflared tunnel --url http://127.0.0.1:8787
   # or:  ngrok http 8787
   ```

   Note the HTTPS hostname it prints, e.g. `https://abc-def.trycloudflare.com`.

3. Start the plugin in Figma. Paste the server URL (`http://localhost:8787`)
   and the same `PLUGIN_SECRET` into the panel. It should turn green.

4. In ChatGPT: **Settings → Security and login → Developer mode → on**.
   (Workspace admins: this toggle lives in workspace settings.)

5. **ChatGPT → Plugins → +**. Name it, then under Connection enter the **full**
   URL including the path — ChatGPT does not append `/mcp` for you:

   ```text
   https://abc-def.trycloudflare.com/mcp
   ```

   Leave authentication as none. ChatGPT has no way to send your secret.

6. Review the six discovered tools, create the connection, then **open a new
   conversation** and select the app.

7. After changing tool names or schemas, hit **Refresh** on the connection
   page — ChatGPT caches metadata.

### First test prompt

> Check whether my Figma Design Agent plugin is connected. If it is connected,
> create a 400×300 native Figma frame named "ChatGPT Test".

Keep the tunnel alive for the whole session. If it dies, restart it and Refresh
the connection — the plugin reconnects on its own with exponential backoff.

### Security posture

`/mcp` is open behind the tunnel, so anyone who guesses the tunnel hostname can
create designs in your file. Mitigations:

- Use a quick tunnel and shut it down when you are done.
- Set `PLUGIN_SECRET` so the plugin only accepts that one client.
- Run only while the Figma plugin is open — the server does nothing without a
  connected session.

## Configuration

| Env var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8787` | HTTP + WebSocket port |
| `HOST` | `127.0.0.1` | Bind address |
| `PLUGIN_SECRET` | _(unset)_ | Guards `/ws`, the Figma write channel. Set this |
| `DESIGN_AGENT_SECRET` | _(unset)_ | Guards `/mcp`. Leave unset for ChatGPT — it cannot send bearer tokens |
| `DESIGN_AGENT_PUBLIC_URL` | _(unset)_ | Fixed public endpoint. Baked into the plugin at build time |
| `NODE_ENV` | — | `production` warns loudly about an open `/mcp` |
| `ALLOWED_ORIGINS` | ChatGPT + localhost | CORS allowlist for browser MCP clients |

Both secrets default to unset, meaning open. The server prints which channels
are open on startup — read that line before pointing anything at it.

### Baking a pinned address into the plugin

Once `.tools/endpoint.txt` holds a stable hostname, you can bake it in so the
plugin skips the tunnel entirely and needs no Apply:

```powershell
$env:DESIGN_AGENT_PUBLIC_URL = "https://your-stable-host"
npm run build:plugin           # bakes that address into the plugin
```

Add the host to `manifest.json` `allowedDomains` (or `devAllowedDomains`) first.

Alternatively deploy the server (Render, Railway, Fly — all have free tiers)
for an always-on instance.

## Tools

| Tool | Purpose |
| --- | --- |
| `design_runtime` | **Build screens from semantic primitives.** Preferred over `create_design` |
| `runtime_primitives` | List every primitive the runtime accepts |
| `compile_ir` | Compile a Design IR to operations without touching Figma |
| `render_design` | **See the result as an image.** The visual feedback loop |
| `find_component` | Search for an existing component before rebuilding one |
| `create_component` | Promote a frame to a real component |
| `create_instance` | Place an instance of an existing component |
| `find_node` | Find a node by screen, role, name or text instead of a raw id |
| `set_variant` | Switch an instance to another variant of its set |
| `update_component` | Edit a component master so every instance follows |
| `create_component_set` | Combine components or frames into a variant set |
| `seed_exo_system` | Create the canonical exo token set in one transaction |
| `migrate_to_tokens` | Bind hardcoded fills to matching variables |
| `audit_components` | Report unused and duplicated components |
| `prototype_flow` | Link frames into a clickable prototype flow |
| `export_code` | Export a frame as React + Tailwind |
| `score_design` | Score a program 0-10 per dimension with evidence |
| `refine_screen` | Run the review-fix loop to convergence |
| `diff_design` | Structural before/after delta between two snapshots |
| `plan_screen` | Plan a screen before drawing it: decision, composition, regions, passes |
| `design_brief` | Write the brief before the plan: goal, object, hierarchy, risks |
| `design_snapshot` | Save, list and fetch V1/V2/V3 design checkpoints |
| `final_qa` | Run the ship checklist across product, composition, system, visual, technical |
| `create_slide` | Create one titled slide in Figma Slides |
| `project_memory` | Read and record durable project design memory |
| `design_guard` | Check a design against the project's product rules |
| `figma_status` | Is the plugin connected? Which file/page/selection? |
| `inspect_selection` | Compact native node tree for the current selection |
| `inspect_file` | File name, pages, top-level frames, node-type census |
| `inspect_design_system` | The palette, type ramp, spacing scale, radii, shadows, components, variables, styles and naming conventions already in use |
| `collect_metrics` | Raw measurements: geometry, resolved colours, text properties, layout |
| `review_design` | Deterministic defect finder with evidence and confidence bands |
| `audit_design` | Design-system governance: unstyled text, unnamed layers |
| `create_design` | Low-level primitive operations |
| `modify_design` | Change existing nodes by real Figma id |
| `undo_last_operation` | Revert the last committed transaction |
| `figdes_use_figma` | Native execution: a controlled script against the native design API |
| `figdes_read_context` | Read the file before changing it: metadata, design context, libraries, components, one node |
| `figdes_inspect_visual` | Structural evidence plus a screenshot, with an explicit render status |
| `compare_visuals` | Measurable before/after evidence plus both screenshots |

Every tool takes an optional `sessionId`. If more than one Figma file has the
plugin open, tools **fail** and list the candidates rather than guessing.

### Native mode

`figdes_use_figma` runs a controlled script against a `fig` API that wraps the
Figma Plugin API. It is not eval and it does not expose the raw `figma` global —
only `fig`, `Math`, `JSON`, `Date` and `console` are in scope. Every call is:

- **Validated** against a strict per-action schema. An unknown action or a
  misspelled parameter is rejected with the supported names, not forwarded to
  Figma to fail obscurely.
- **Transactional.** One script is one undo step. A failure rolls back and the
  document is left unchanged.
- **Time-bounded.** A hard wall-clock budget covers awaited work, not just
  synchronous execution, so a script cannot hang on a slow RPC.
- **Serialized per session.** Two native scripts can never interleave their
  transactions on the same file.
- **Explicit about rollback state.** A rollback only undoes the transaction that
  is actually open and that actually made a change; it never triggers a blind
  undo that could hit a previous operation.

Every mutation returns a rich node summary (geometry, layout, paints, styles,
text, component state), so the next call can operate from evidence instead of
guessing. Failures come back classified (`NODE_NOT_FOUND`, `INVALID_PARAMETERS`,
`ABORTED`, …) with a recovery step.

`figdes_read_context` is the read half: file metadata, a bounded design-context
summary, library collections, local components, or one node's full state — so
the agent can reuse what already exists before building.

The visual loop is `inspect → render → critique → modify → render → compare`:
`figdes_inspect_visual` returns structural evidence plus a screenshot and an
explicit `renderStatus` (a failed render is reported, never silently skipped),
and `compare_visuals` returns measured before/after deltas and both images. It
deliberately never fabricates an `improved: true` verdict — the measured deltas
are evidence, the judgement is the model's.

`design_runtime`, `compile_ir`, `create_design` and `modify_design` accept
`dryRun: true`, which validates the whole plan and returns the operation trace
without touching the document.

---

## The design runtime

### Why it exists

Measured, not assumed: a modest dashboard costs the model ~700 tokens of
primitive JSON, while the entire tool round-trip is ~21 ms. Generation is
roughly 840x the transport cost, so the pipeline was never the bottleneck —
**payload size was**.

Hand-placing 18 primitives also invites the model to think in rectangles. The
runtime lets it state intent instead, and the layout engine computes the
geometry.

| | Hand-written primitives | `design_runtime` |
|---|---|---|
| Model input | ~704 tokens | ~293 tokens (**58% less**) |
| Model must know | every coordinate, every font size | roles and content |
| Radius consistency | whatever it remembered | one call, enforced |
| Type scale | whatever it guessed | from the scale table |

### Using it

```json
{
  "canvas": { "name": "EXO Compute", "width": 1440, "height": 900, "grid": 8 },
  "regions": [
    { "fn": "navigation", "id": "nav", "args": { "width": 240, "fill": "#111111", "padding": 24 } },
    { "fn": "hero", "id": "hero", "args": { "grow": 2, "gap": 16, "padding": 32 } }
  ],
  "content": [
    { "fn": "text", "id": "title", "parent": "hero", "args": { "text": "Compute", "role": "title" } },
    { "fn": "metric", "id": "m1", "parent": "hero", "args": { "label": "GPUs", "value": "8x H100" } }
  ]
}
```

That compiles to 19 real Figma operations: a 240px rail at `x=0`, content at
`x=272` filling to `1440`, a 32px type scale, three consistent metrics.

### Why it is not an eval escape hatch

The design document proposed `design_runtime.execute({ program: "..." })`.
Executing that string would be `eval` on model output — which the same document
forbids in §34 and §45, and which this codebase has never had.

So the escape hatch exists, but it takes **JSON naming built-in primitives**.
There is no `program` string, no expression parser, and no dynamic dispatch on
model-provided strings. The model chooses *what* to build from the primitive
vocabulary; the runtime decides *how*.

Send `program: "figma.createFrame()"` and you get a warning saying the runtime
takes declarative arguments and never executes code — the string is inert and is
not silently dropped either, because a silently ignored argument reads to the
model as success.

### Vocabulary

**Regions:** `navigation` `hero` `header` `inspector` `frame`
**Content:** `text` `metric` `statusPill` `deviceNode` `navItem` `panel` `button` `divider` `sectionHeader` `modelRow` `shape` `vector` `template` `logoMark` `connector` `variable` `paintStyle` `textStyle`

Sizing accepts a number, `"fill"` (share leftover space) or `"hug"`. `grow`
(0–10) weights how a fill region absorbs slack.

### Plan before drawing — `plan_screen`

For a new screen, call `plan_screen` before `design_runtime`. It classifies the
primary decision, infers the composition, returns real 2D geometry, ordered
regions with reasons, product-rule previews, and the five passes:

1. composition — frames plus one headline; no metrics or repeated components
2. information — real data, labels, controls, component reuse
3. refinement — spacing, type, density; tune only, no new content
4. states — hover, selected, disabled, loading, empty, error, success
5. QA — `review_design`, one low-detail render, `design_guard`

Destructive/global changes can be refused with `needs-approval`. Re-send with
`approved: true` after the user approves; use `dryRun: true` to preview without
asking. Approvals are single-use.

### The layout engine

Pure functions, no Figma, fully unit tested against hand-computed expectations
(`tests/runtime.test.mjs`):

- `solveAxis` — divides leftover space, weights by `grow`. Verified to tile an
  axis exactly with no rounding drift.
- `radial` — deterministic node placement on a ring
- `forceDirected` — seeded force layout; no `Math.random`, so the same graph
  always renders identically
- `packContent` — column wrapping that never overflows its region
- `inferComposition` — picks a composition strategy from region roles, and does
  **not** collapse a lone region into a card grid
- `tree` — tidy tree: parents sit above the centre of their subtree. Cycle-safe,
  because real topology data from a discovery sweep contains loops
- `masonry` — packs into the shortest column, so the bottom edge is ragged rather
  than leaving a hole
- `timeline` — time along x, lanes along y; stretches the value domain so a
  1–800 µs span uses the width instead of hugging the left edge
- `cluster` — packs group members into blocks, ordered by weight, so related
  machines read as one object

All five are deterministic. A layout that moved between identical runs would make
every render diff report spurious movement and undo look broken.

Composition inference is the mechanism behind spec §15: a narrow rail plus a
hero resolves to `spatial`, not a generic dashboard.

### Constraint layout — relationships, not coordinates

This is the single biggest change in how a screen gets authored. Instead of

```json
{ "id": "inspector", "x": 968, "y": 0, "width": 320, "height": 900 }
```

you write

```json
"relations": [
  { "id": "inspector", "rightOf": "topology", "gap": 24, "width": 320 }
]
```

The solver computes the coordinate, so the relationship cannot drift. Absolute
coordinates written by a model are the largest single source of layout defects: a
24 px gutter becomes 20 on one side, two panels stop aligning, and every resize
invalidates all of it.

| Field | Effect |
| --- | --- |
| `rightOf` / `below` | Anchor to another node, with `gap` |
| `alignTo` | `start` `center` `end` `stretch` `top` `middle` `bottom` `baseline` |
| `width` / `height` | A number, or `"fill"` to span to the parent edge |
| `top` `left` `right` `bottom` `inset` | Offsets relative to the parent |

Two behaviours worth knowing:

- **Chains resolve in dependency order**, not the order you wrote them. `c
  rightOf b` plus `b rightOf a` resolves correctly even when written backwards.
- **A cycle is reported, not silently mis-positioned.** A single violation naming
  the cycle beats N contradictory positions.

`stretch` follows the axis of the relation: `rightOf` copies width, `below` copies
height.

### Connectors — for topology maps

Connectors are the only geometry in the system that depends on *other* nodes, and
that dependency is the whole value. A connector is expressed as a relationship
and solved against the boxes that were just placed, so it terminates **on** the
machine it names rather than at the middle of it.

```json
"links":     [ { "from": "hub", "to": "n1", "label": "8us" } ],
"content":   [ { "fn": "connector", "id": "c1", "parent": "map",
                 "args": { "from": "hub", "to": "n1", "label": "8us" } } ]
```

| Routing | Shape |
| --- | --- |
| `straight` | one segment |
| `orthogonal` | three-segment Z route, horizontal- or vertical-dominant |
| `curved` | one quadratic bowed off the chord |

Arrowheads are emitted as closed triangular subpaths *inside the same path*, so a
connector is a single vector node — one thing to select, and no risk of a head
detaching from its line. A label rides along at the route midpoint.

`layout: "topology"` on a region picks `tree` when links exist and `cluster`
when they do not, so a topology map needs no algorithm argument at all.

### Design tokens and styles — `variable`, `paintStyle`, `textStyle`

Declared as primitives, created as real Figma variables and styles:

```json
{ "fn": "variable", "args": { "name": "surface", "color": "#FFFDF9" } },
{ "fn": "variable", "args": { "name": "space/md", "type": "number", "value": 24 } },
{ "fn": "variable", "args": { "name": "bg", "values": { "Mode 1": "#FFFFFF", Dark: "#111111" } } },
{ "fn": "paintStyle", "args": { "name": "Surface", "color": "#FFFDF9" } },
{ "fn": "textStyle",  "args": { "name": "Display", "size": 32, "weight": 600 } }
```

They are emitted **before** the nodes that use them, and re-running a program
updates the existing token rather than creating `space/md` and `space/md 2`.
That is what makes a global refinement a single edit later rather than a sweep
over hardcoded values.

### Design memory — `project_memory`

Durable, structured notes about how this project should look, stored as JSON in
`.memory/<project>.json`. Deliberately *not* conversation memory: this is
inspectable, diffable and correctable by a human, which matters because a design
rule nobody can edit is a rule nobody can argue with.

```json
{ "action": "record",
  "note": { "id": "topology-style", "scope": "project",
            "note": "Topology screens read better as one large spatial diagram." } }
```

- `scope: "project"` applies everywhere; `"screen"` and `"composition"` only
  apply there, which stops a decision made on one screen from silently becoming a
  global law.
- Recording the same `id` **corrects** the note instead of adding a contradictory
  sibling.
- The agent never records on its own initiative — a memory full of its own guesses
  stops being trusted.

### `design_guard` — the do-not-drift layer

Checks a design against the project's product truths and returns PASS / WARNING /
FAIL with the measured evidence for each. Pass a program to check a design before
building it, or `inspect: true` to check what is in the file.

The built-in rule set is spec §29/§51 written as data rather than prose in a
prompt — devices auto-discover so no pairing wizard, placement is automatic so no
manual shard dragging, chat is not primary, no three-card SaaS metric walls,
technical values in a monospaced face.

Three decisions make it trustworthy rather than decorative:

- **Only measured evidence can produce a FAIL.** A rule needing judgement is
  returned as a question for a human, never asserted. Guessing produces a false
  FAIL, and the first false FAIL teaches you to ignore the whole layer.
- **Never fail on absence.** A screen with nothing to do with pairing passes the
  pairing rule; "no connect-device wizard" must not fail an unrelated screen.
- **Evidence is reported with every verdict.** `FAIL exo.auto-discovery: matched
  "Connect device"` is actionable. `FAIL` alone is not.

```json
{ "verdict": "FAIL",
  "findings": [
    { "verdict": "FAIL", "rule": "exo.auto-discovery",
      "message": "contradicts: Do not create manual device-pairing UI.",
      "evidence": "Connect device",
      "nextStep": "Show discovered devices as already-present state." }
  ],
  "stats": { "rulesChecked": 8, "passed": 7, "warnings": 0, "failures": 1, "manual": 2 } }
```

### Slides — one program, one deck

The same plugin runs in Figma Slides (`editorType: ["figma", "slides"]`).
`design_runtime` with `deck: true` on the canvas turns every region into a
1920x1080 slide: no root frame, type scaled 1920/1440 for the back of the room,
relations skipped (positioning across slides is meaningless), and connectors
must stay inside one slide or they are reported rather than misplaced.
`plan_screen` accepts `format: "deck"` so plan and build agree, and
`create_slide` builds a single titled slide with background and speaker notes
in one transaction. Outside Slides, `createSlide` refuses loudly instead of
making a broken frame in the wrong product.

### Logos — computed geometry, never hand-drawn

A hexagon is six vertices on a circle; one vertex off and the mark reads as a
mistake. So the model names the mark and the runtime computes it: `logoMark`
with `ring|orbit|chevron|hex|bars|prism|wave|grid` on a shared optical grid,
`shape` with `polygon|star` plus `sides`/`innerRatio`/`rotation`, and vector
paths with full arc (`A`) support alongside `C`/`Q`. Pair a mark with a text
wordmark in caps plus `letterSpacing` — tracked-out capitals are what make it a
wordmark rather than a label.

### Semantic components — product language, not schema archaeology

`navItem` takes `state: active`, `statusPill` takes `tone: success`,
`button` takes `variant: destructive`, `metric` takes `valueStyle: technical`,
`deviceNode` takes `health:`/`selected:`. These read like the product because
they are the product's own concepts; every one of them was previously rejected
as an unknown argument, which is exactly how a model learns to stop trying.
`topologyMap` takes `nodes`/`edges`/`selectedNode` and expands to placed devices
plus routed, labelled connectors. `placementMap` does the same for model→machine
shard assignments, with `memoryBudget`, `fitGauge`, `shardBlock` and
`compatibilityMatrix` for the fit question around it.

### Screen templates and the plan-to-build handoff

`plan_screen` names the screen template it follows (`topology`, `list-detail`,
`model-analysis`, `runtime`, `telemetry`, `integration`) and returns a
paste-ready `program` skeleton. `design_runtime` accepts that output as `plan:`
directly, so the model never retypes geometry it already approved. Pass
`archetype: 'model-fit'` (or topology, runtime, fleet...) to inherit a named
EXO screen's objective, decision and anti-patterns. Everyday patterns also ship
as built-in content templates (`page-header`, `field-row`, `action-row`,
`section`, `empty-state`, `error-state`); a program template with the same name
replaces the built-in silently.

### Taste is data: visual intent and the art director

Programs accept `visualIntent` — style, density, focal region, per-region
weights — and it visibly takes effect: density rescales the spacing system,
weights become growth, the focal region absorbs slack first, and every change
is reported back. `plan_screen` answers the art director's questions with it:
the focal region, ranked hierarchy, component and visualization strategy,
relevant interaction states, design risks and composition candidates to compare.
`design_brief` frames all of this before any geometry exists.

### Code, flows and system hygiene

`export_code` turns the selection into React + Tailwind — flex from auto-layout,
headed tags from type, colours as CSS custom properties — deterministically, so
regenerating diffs cleanly. `prototype_flow` links frames into a clickable flow,
appending reactions rather than replacing hand-built ones. `migrate_to_tokens`
sweeps hardcoded fills into variable bindings on exact hex matches (approximate
colours are left alone), and `audit_components` reports unused and duplicated
components with the evidence for a human decision.

### Watching it work — the live stream

Two things used to be invisible: what the agent is doing right now, and what it
just saw. Every tool call now narrates itself to the panel in one line
(`review_design — 3 finding(s)`), and every render pushes its thumbnail there
with no second render cost. The screen itself lands region by region — large
programs yield between chunks so the canvas repaints instead of appearing all
at once — while a slim bar narrates the commit. Nothing to click, nothing to
configure: the panel stays a status light that happens to show the work.

### Seeing the result — `render_design`

Everything else in this system reads node metadata, which is why the loop
previously stopped at inspect → generate with no feedback. `render_design` returns
an actual image.

**The context problem is real.** A 1440×900 PNG is ~150–300 KB, which is
roughly 40,000–80,000 tokens once base64-encoded and tiled. Render a few and the
window is gone. Three things prevent that:

| Lever | Effect |
|---|---|
| MCP **image block**, not base64 in JSON | Tiled and tokenised properly instead of +33% as text |
| `maxWidth` (default 1024, max 2048) | Cost scales with area. 512px ≈ a quarter of 1024px |
| `detail: "low"` | ~half the tokens — enough for layout, balance, hierarchy |
| Per-session budget | 120k soft / 200k hard. A render loop **cannot** run away |

Every render returns its own cost beside the image:

```
Rendered "Dashboard" (FRAME) at 1024x640.
Native size: 1440x900. Scale factor: 0.711x.
Cost: ~680 tokens (high detail), 16.7 KB base64.
Budget used: 680 of 200,000 tokens.
Note: this was downscaled from 1440px, so fine text detail is lost.
Judge hierarchy, balance, density, alignment...
```

The server instructions steer the model toward `review_design` (free) for
structural defects and reserve renders for what only a picture can answer. Two
renders per iteration is usually enough.

### Component awareness — `find_component`

The single biggest source of design-system drift is rebuilding UI that already
exists. `find_component` makes that lookup cheap:

```json
{ "name": "StatusRow", "instanceCount": 12, "score": 0.9, "reason": "name contains \"status\"; reused 12x" }
```

The instance count is a real signal — a component used 40 times is the safe
default. `create_component` promotes an existing frame via `fromNode`, keeping
its geometry rather than rebuilding it. `create_instance` then places copies.

### The critic's honesty model

`review_design` reports **findings with measurements**, not scores. The spec
asks for things like `Hierarchy 84/100`; a heuristic cannot compute that
honestly, so it does not pretend to. Instead:

```json
{
  "rule": "text-contrast",
  "confidence": "high",
  "severity": "critical",
  "title": "Text contrast 2.85:1 is below the WCAG AA minimum of 4.5:1",
  "evidence": { "textColor": "#999999", "background": "#FFFFFF", "ratio": 2.85, "required": 4.5, "fontSize": 13 },
  "nodeIds": ["36:287"],
  "guidance": "Darken or lighten the text fill…"
}
```

`confidence` is a band, and it governs autonomy (spec §29):

| Band | Meaning | Policy |
| --- | --- | --- |
| `high` | arithmetic or exact comparison | safe to auto-fix |
| `medium` | involves a judgement about intent | propose, wait for approval |
| `low` | speculative | observation only |

Only `high` findings ever carry `suggestedOperations`, and those operations are
parsed through `OperationSchema` when the finding is built — a fix can never
smuggle an unvalidated operation past the allowlist.

**Rules**

| Rule | Band | Why |
| --- | --- | --- |
| `text-contrast` | high | WCAG arithmetic on composited colours |
| `overflow` | high | child box vs parent box |
| `radius-inconsistency` | high | measured values differ |
| `default-layer-name` | high | regex on Figma's own naming |
| `unstyled-text` | high | `textStyleId` is empty |
| `unnamed-frame-children` | high | majority of children are default-named |
| `tap-target-size` | medium | "looks interactive" inferred from the name |
| `duplicate-siblings` | medium | identical type, size, fill and content |
| `off-grid-geometry` | medium | depends on inferring the spacing base |
| `text-outside-autolayout` | medium | often intentional |
| `off-scale-spacing` | medium | depends on inferring the spacing base |

If no consistent spacing base can be inferred, the grid rules make **no claim
at all** rather than guessing one.

## Operations

The model never emits JavaScript. It emits structured operations, which are
validated against a zod discriminated union and dispatched from a closed
switch. There is no `eval` and no `new Function` anywhere in this repo.

```json
{
  "operations": [
    { "type": "createFrame", "id": "root", "name": "Dashboard", "width": 1440, "height": 900, "fill": "#F7F5EF" },
    { "type": "setAutoLayout", "target": "root", "mode": "HORIZONTAL", "itemSpacing": 0, "counterAxisAlignItems": "STRETCH" },
    { "type": "createFrame", "id": "sidebar", "parent": "root", "name": "Sidebar", "width": 240, "height": 900,
      "layoutMode": "VERTICAL", "padding": 24, "itemSpacing": 12, "fill": "#111111" },
    { "type": "createText", "parent": "sidebar", "name": "Logo", "content": "EXO Labs", "fontSize": 20, "fill": "#FFFFFF" }
  ]
}
```

`id` mints a transaction-local reference that later operations address via
`target` / `parent` / `child`. Real Figma ids (`"12:34"`) work too, so a design
can be built across several tool calls.

Types: `createFrame` `createRectangle` `createEllipse` `createText` `createVector`
`createVariable` `createTextStyle` `createPaintStyle` `renameNode` `setPosition`
`setSize` `setFill` `setStroke` `setOpacity` `setCornerRadius` `appendChild`
`removeNode` `cloneNode` `setAutoLayout` `setPadding` `setGap` `setTypography`
`setTextContent` `setVisible` `setPage`

A connector is **not** a separate operation type. It compiles to `createVector`
with a solved path, which means it goes through the same allowlisted,
non-evaluating path pipeline as every other vector — one node, one operation
type, one code path to audit. Arrowheads are closed subpaths in that path, and
`fillArrows: true` gives the vector a fill so the heads render solid.

Adding a type means adding a zod case in `shared/protocol.ts` **and** a handler
in `figma-plugin/src/operations.ts`. The exhaustiveness guard in the `switch`
turns a missing handler into a compile error, not a silent no-op.

## Behaviour worth knowing

**Undo is Figma's.** Each transaction is sealed with `figma.commitUndo()` before
and after, so one native undo reverts the whole batch. A failed transaction
calls `triggerUndo()` to roll back the partial application.

**Performance.** `loadAllPagesAsync()` was the dominant cost on large files, so
pages load once per plugin session and are shared between concurrent callers.
Local variables and styles — also async document scans — use a 15s TTL so edits
are still picked up. Node lookup self-heals: a miss triggers one page load and
one retry, which removes a class of false "node not found" reports.

**Inspections are budgeted.** Output is capped by depth (default 4) and node
count (default 400 for selection, 250 for file). `truncated: true` is reported
honestly — narrow the request rather than assuming you saw everything.

**Fonts are verified.** A missing family raises an error listing what is
available instead of silently substituting. Characters are only set after
`loadFontAsync`, which Figma requires.

**Figma text is untrusted data.** Inspect results carry `contentTrust:
"untrusted"`, and the server instructions state that layer names and text nodes
are content to analyse, never instructions. A layer called "ignore previous
instructions" must not be able to steer the agent (spec §37).

**Failures are actionable.** A rejected transaction reports what failed, which
operation, whether the document was rolled back, and a concrete next step —
for example, "call inspect_selection to get current node ids" rather than a bare
"node not found" (spec §36).

**Figma tokens never reach the model.** No OAuth flow, no personal access
token, no file content beyond what `inspect_*` deliberately returns.

**`networkAccess` needs both schemes.** The plugin iframe opens a *WebSocket*, so
`devAllowedDomains` lists `ws://localhost:8787` as well as `http://`. Figma
accepts `http`/`https`/`ws`/`wss` patterns, but rejects bare IP addresses as
domain patterns — `localhost` is the only local address that both validates and
resolves. It also rejects a `wss://host:port` with an explicit port, so keep
production on a default-port hostname.

## Adding the next tier

The spec defers these until the end-to-end path works (§39). What's already in:

- **Semantic file understanding** → `inspect_design_system`
- **Design-system extraction** → `inspect_design_system`
- **Design critic** → `review_design`, `audit_design`
- **Create → review → fix** → the model chains the three; no extra code
- **Accessibility** → folded into the critic as computed checks

Already built since that note was written:

- **`render_design`** — visual feedback via an MCP image block, with a context
  budget, downscaling, detail levels, and cost reporting.
- **Project memory** (`project_memory`) — durable per-project JSON under
  `.memory/`, plus `design_guard` product-rule checks.
- **Human approval checkpoints** (`needs-approval`, single-use `approved: true`)
  for destructive or global changes. Version branching remains deferred because
  Figma has no branching.

Still to build:
- **Agent activity log** — append-only per project; also useful for debugging
- **Semantic naming** — propose-then-apply, never auto-rename wholesale
- **State generator / responsive / alternatives** — mostly orchestration on top
  of `design_runtime`, which now has the composition machinery to support them
- **Version checkpoints/branching** — deferred; Figma has no branching
- **Design-to-code and production drift** — needs a running app to compare against

### How to extend

| To add | Do this |
| --- | --- |
| A new operation | zod case in `shared/protocol.ts` **and** a handler in `figma-plugin/src/operations.ts`. The exhaustiveness guard makes a missing handler a compile error |
| A new semantic primitive | Add to `RUNTIME_PRIMITIVES` in `mcp-server/src/runtime/interpreter.ts`, allow its args in `CONTENT_ARGS`/`REGION_ARGS`, add a `case` in `emitComponent`. A test asserts every advertised primitive actually builds |
| A new layout algorithm | A pure function in `mcp-server/src/runtime/layout.ts` plus hand-computed expectations in `tests/runtime.test.mjs` |
| A new critic rule | A pure function in `mcp-server/src/review/rules.ts` returning `Finding[]`, plus a test |
| A new read tool | Handler in `figma-plugin/src/code.ts`, entry in `PLUGIN_TOOL_NAMES`, wrapper in `mcp-server/src/tools.ts` |
| A new server-only tool | Entry in `TOOL_NAMES` and `tools.ts`, reading data via `collect_metrics` |

Keep the plugin free of reasoning: it supplies measurements, the server decides.

### Invariants worth preserving

These are enforced by tests. If a change breaks one, the test will say so:

- **No eval path.** No `eval`, no `new Function`, no expression evaluation of
  model output anywhere. The runtime takes structured JSON; SVG path data is
  *parsed*, never evaluated.
- **No invented scores in findings.** Review findings carry measured evidence and a
  `high`/`medium`/`low` band. A test asserts no field looks like a quality score.
  (`score_design` is the deliberate exception: it computes 0-10 from measurements
  with evidence attached, never from judgement.)
- **Auto-fix only on high confidence.** A test asserts every finding that ships
  `suggestedOperations` is high confidence, and that those operations passed the
  allowlist.
- **Grid claims require evidence.** If no spacing base can be inferred, the
  rules say nothing rather than assuming one. `inferBase` never returns 1.
- **Untrusted text stays untrusted.** Inspect results carry
  `contentTrust: "untrusted"`, and the panel renders layer names with
  `textContent`, never `innerHTML`.
- **Nothing is silently dropped.** Unknown args, unusable regions and constraint
  violations are all returned to the caller as warnings rather than discarded.

## Troubleshooting

**Plugin panel stays grey.** The server is not running, or the manifest's
`devAllowedDomains` does not cover the URL. Check `npm start` and the URL field.
Figma enforces this as a CSP — open the developer console and look for
content-security-policy errors.

**`No Figma Design Agent plugin is connected`.** The plugin is closed, or it is
crashed. Reopen it; the panel logs the reconnect attempts.

**`Multiple Figma files have the plugin open`.** Pass an explicit `sessionId`
from `figma_status`, or close the extra files.

**ChatGPT discovers the tools but blocks writes.** That is a ChatGPT
account/workspace capability, not a bug here. Verify with the MCP Inspector
that `create_design` works; if it does, the server and plugin are fine.

**Fonts fail to load.** Only fonts installed in the Figma desktop app are
available to plugins. The error lists the families that are.
