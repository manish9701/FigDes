/**
 * End-to-end smoke test.
 *
 * Boots the real server, connects a mock plugin over /ws, and drives the real
 * MCP transport at /mcp — asserting the whole SPEC §28 chain except the actual
 * figma.* calls, which require the Figma desktop app.
 *
 *   npm run smoke
 *
 * Plain sequential script rather than node:test so progress is visible and the
 * process can exit deterministically.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "smoke-secret";

/** Temp directory so project_memory writes never touch the repo. */
const MEMORY_DIR = join(tmpdir(), `design-agent-smoke-${process.pid}`);

let server = null;
let passed = 0;

/* -------------------------------------------------------------------------- */
/* Mock plugin — speaks the real wire protocol from shared/protocol.ts         */
/* -------------------------------------------------------------------------- */

class MockPlugin {
  ws = null;
  sessionId = null;
  frameId = "24:1";
  nextId = 100;
  created = [];

  async connect() {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?secret=${SECRET}`);

    this.ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === "welcome") {
        this.sessionId = msg.sessionId;
        return;
      }
      if (msg.type === "request") {
        let data;
        let error;
        try {
          data = this.handle(msg.tool, msg.payload ?? {});
        } catch (err) {
          error = err.message;
        }
        this.ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, ok: !error, data, error }));
      }
    });

    await once(this.ws, "open");

    this.ws.send(
      JSON.stringify({
        type: "register",
        fileKey: "abc123",
        fileName: "EXO Labs",
        pageId: "0:1",
        pageName: "Dashboard",
        selection: [],
        pluginVersion: "0.1.0",
        secret: SECRET,
      }),
    );

    for (let i = 0; i < 100 && !this.sessionId; i++) await sleep(25);
    if (!this.sessionId) throw new Error("Mock plugin never received a session id.");
    return this.sessionId;
  }

  mint() {
    return `24:${this.nextId++}`;
  }

  handle(tool, payload) {
    switch (tool) {
      case "figma_status":
        return {
          connected: true,
          fileName: "EXO Labs",
          fileKey: "abc123",
          pageId: "0:1",
          pageName: "Dashboard",
          selection: [],
          selectionCount: 0,
          pluginVersion: "0.1.0",
        };

      case "inspect_selection":
        return {
          selection: [
            {
              id: this.frameId,
              type: "FRAME",
              name: "Dashboard",
              x: 0,
              y: 0,
              width: 1440,
              height: 900,
              childCount: 1,
              children: [{ id: "24:9", type: "TEXT", name: "Title", characters: "EXO Labs", childCount: 0 }],
            },
          ],
          truncated: false,
        };

      case "inspect_file":
        return {
          fileName: "EXO Labs",
          fileKey: "abc123",
          currentPage: { id: "0:1", name: "Dashboard" },
          pages: [{ id: "0:1", name: "Dashboard", childCount: 1 }],
          selection: [],
          topLevelFrames: [],
          counts: { FRAME: 1, TEXT: 1 },
          truncated: false,
        };

      case "extract_design_system":
        return {
          fileName: "EXO Labs",
          scope: "page",
          pagesScanned: ["Dashboard"],
          nodesScanned: 42,
          truncated: false,
          colors: [{ hex: "#111111", count: 4, sampleNames: ["Sidebar"] }],
          colorsTotal: 9,
          strokes: [{ hex: "#E5E5E5", count: 3 }],
          radii: [{ value: 8, count: 6 }],
          shadows: [],
          typography: [{ label: "Inter Regular @13", sampleNames: ["Body"], count: 5 }],
          spacing: { inferredBase: 8, values: [{ value: 8, count: 7 }] },
          layoutPatterns: [{ signature: "VERTICAL gap=8", count: 2 }],
          components: [{ name: "Card", count: 3 }],
          variables: [{ name: "color/bg", type: "COLOR", id: "VariableID:1", scopes: ["FRAME_FILL"] }],
          styles: { paint: 2, text: 4, effect: 1 },
          naming: { defaultNamed: 5, conventions: ["Nav/*"] },
          health: { textNodes: 5, unstyledText: 3, hardcodedColors: 7, hardcodedWithExistingVariable: 2 },
          scan: { pageLoads: 1, pagesCached: false },
        };

      case "render_node": {
        // A missing node is an error result, which is what the real plugin does.
        if (payload.nodeId === "does-not-exist") {
          throw new Error(`Node not found: ${payload.nodeId}. It may have been deleted, or it lives on a page that is not loaded.`);
        }

        // Shape matches what figma-plugin/src/render.ts returns.
        const width = Math.min(payload.maxWidth ?? 1024, 1440);
        const height = Math.round((width / 1440) * 900);
        return {
          nodeId: payload.nodeId,
          nodeName: "Dashboard",
          nodeType: "FRAME",
          width,
          height,
          nativeWidth: 1440,
          nativeHeight: 900,
          scale: width / 1440,
          format: payload.format ?? "png",
          detail: payload.detail ?? "high",
          byteLength: 12000,
          base64Length: 16000,
          estimatedTokens: 680,
          data: "iVBORw0KGgoAAAANSUhEUg==",
          budget: { tokensSpent: 680, softLimit: 120000, hardLimit: 200000, overSoftLimit: false },
          downscaled: width < 1440,
        };
      }

      case "reset_render_budget":
        return { status: "reset", budget: { tokensSpent: 0, softLimit: 120000, hardLimit: 200000, overSoftLimit: false } };

      case "find_components":
        return {
          truncated: false,
          total: 3,
          matches: [
            {
              component: {
                id: "1:50",
                name: "StatusRow",
                type: "COMPONENT",
                description: "A row showing status",
                properties: [],
                width: 320,
                height: 48,
                instanceCount: 12,
              },
              score: 0.9,
              reason: 'name contains "status"',
            },
            {
              component: {
                id: "1:51",
                name: "StatusRow copy",
                type: "COMPONENT",
                description: "",
                properties: [],
                width: 320,
                height: 48,
                instanceCount: 0,
              },
              score: 0.5,
              reason: "smoke mock",
            },
            {
              component: {
                id: "1:52",
                name: "OldBadge",
                type: "COMPONENT",
                description: "",
                properties: [],
                width: 64,
                height: 24,
                instanceCount: 0,
              },
              score: 0.4,
              reason: "smoke mock",
            },
          ],
        };

      case "list_variables":
        return {
          variables: [{ collection: "exo", name: "surface", type: "COLOR", value: "#FFFDF9", modes: 1 }],
        };

      case "create_component":
        return { componentId: "1:60", componentSetId: null, name: payload.name, description: payload.description ?? "", properties: [] };

      case "create_instance":
        return { instanceId: "1:70", name: payload.name ?? "StatusRow", componentId: payload.componentId, width: 320, height: 48 };

      case "collect_metrics": {
        const nodes = [
          {
            id: "24:1",
            parentId: null,
            type: "FRAME",
            name: "Dashboard",
            depth: 0,
            x: 0,
            y: 0,
            w: 1440,
            h: 900,
            visible: true,
            defaultNamed: false,
            zIndex: 0,
            // Deliberately hardcoded: migrate_to_tokens must match this to exo/surface.
            fill: "#FFFDF9",
          },
          {
            id: "24:2",
            parentId: "24:1",
            type: "TEXT",
            name: "Muted",
            depth: 1,
            x: 8,
            y: 8,
            w: 200,
            h: 20,
            visible: true,
            defaultNamed: false,
            zIndex: 0,
            background: "#FFFFFF",
            text: {
              content: "hello",
              length: 5,
              truncated: false,
              size: 14,
              family: "Inter",
              style: "Regular",
              color: "#BBBBBB",
              styled: false,
            },
          },
        ];
        return {
          target: payload.target ?? null,
          scope: "1 selected",
          nodes,
          nodeCount: nodes.length,
          truncated: false,
          scan: { pageLoads: 0, pagesCached: true },
        };
      }

      case "find_node": {
        if (!payload.role && !payload.name && !payload.text) {
          throw new Error("find_node needs at least one of role, name or text.");
        }
        return {
          truncated: false,
          total: 1,
          matches: [{ id: "24:2", type: "TEXT", name: "Muted", score: 1, reason: "smoke mock", path: ["Dashboard"] }],
          searched: payload,
        };
      }

      case "set_variant": {
        return { instanceId: "50:1", from: "Primary", to: "50:2", toName: payload.variant ?? "Secondary" };
      }

      case "update_component": {
        if (payload.dryRun) {
          return { transactionId: "tx_dry", status: "success", dryRun: true, createdNodes: [], applied: [] };
        }
        return { transactionId: "tx_1", status: "success", dryRun: false, createdNodes: [], applied: ["update"] };
      }

      case "create_design":
      case "modify_design": {
        if (payload.dryRun) {
          return {
            transactionId: "tx_dry",
            status: "success",
            dryRun: true,
            createdNodes: [],
            applied: payload.operations.map((o) => o.type),
          };
        }
        const created = [];
        for (const op of payload.operations) {
          if (String(op.type).startsWith("create")) {
            created.push({ temporaryId: op.id, figmaNodeId: this.mint(), type: "FRAME", name: op.name ?? "Frame" });
          }
        }
        this.created = created;
        return {
          transactionId: "tx_1",
          status: "success",
          dryRun: false,
          createdNodes: created,
          applied: payload.operations.map((o) => o.type),
        };
      }

      case "undo_last_operation":
        this.created = [];
        return { status: "success", message: "Reverted the last committed design transaction." };

      default:
        throw new Error(`Mock plugin has no handler for ${tool}`);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* MCP client                                                                 */
/* -------------------------------------------------------------------------- */

async function rpc(method, params = {}, { auth = true } = {}) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (auth) headers.authorization = `Bearer ${SECRET}`;

  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text();
  if (!res.ok) return { httpStatus: res.status, text };

  const payload = JSON.parse(text);
  if (payload.error) throw new Error(`${method} -> ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function callTool(name, args = {}) {
  const result = await rpc("tools/call", { name, arguments: args });
  return { isError: Boolean(result.isError), text: result.content?.[0]?.text ?? "", data: result.structuredContent };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(label, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${label}`);
  } catch (err) {
    console.log(`  FAIL ${label}`);
    console.log(`       ${err.message.split("\n").join("\n       ")}`);
    process.exitCode = 1;
  }
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log("\n  figma-design-agent smoke test\n");

  server = spawn(process.execPath, ["mcp-server/dist/index.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DESIGN_AGENT_SECRET: SECRET,
      NODE_ENV: "test",
      // Memory and snapshot writes must not land in the repo during a test run.
      DESIGN_AGENT_MEMORY_DIR: MEMORY_DIR,
      DESIGN_AGENT_SNAPSHOT_DIR: MEMORY_DIR,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(500) });
      break;
    } catch {
      await sleep(100);
    }
  }

  const plugin = new MockPlugin();
  let second = null;

  console.log("  security");
  await check("MCP rejects requests without the bearer secret", async () => {
    const res = await rpc("tools/list", {}, { auth: false });
    assert.equal(res.httpStatus, 401);
  });

  await check("plugin WebSocket rejects a bad secret", async () => {
    await assert.rejects(
      () =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?secret=wrong`);
          ws.on("open", () => {
            ws.close();
            resolve();
          });
          ws.on("error", reject);
        }),
    );
  });

  console.log("\n  transport");
  await check("plugin registers and receives a session id", async () => {
    const sessionId = await plugin.connect();
    assert.ok(sessionId.startsWith("session_"));
  });

  await check("health reports the connected session", async () => {
    const body = await (await fetch(`${BASE}/health`)).json();
    assert.equal(body.ok, true);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].fileName, "EXO Labs");
  });

  await check("server advertises the full tool surface", async () => {
    const { tools } = await rpc("tools/list");
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "audit_components",
        "audit_design",
        "collect_metrics",
        "compare_visuals",
        "compile_ir",
        "create_component",
        "create_component_set",
        "create_design",
        "create_instance",
        "create_slide",
        "critique_visual",
        "design_brief",
        "design_guard",
        "design_runtime",
        "design_snapshot",
        "diff_design",
        "export_code",
        "figdes_inspect_visual",
        "figdes_read_context",
        "figdes_use_figma",
        "figma_status",
        "final_qa",
        "find_component",
        "find_node",
        "inspect_design_system",
        "inspect_file",
        "inspect_selection",
        "migrate_to_tokens",
        "modify_design",
        "plan_screen",
        "project_memory",
        "prototype_flow",
        "refine_screen",
        "render_design",
        "review_design",
        "runtime_primitives",
        "score_design",
        "seed_exo_system",
        "set_variant",
        "undo_last_operation",
        "update_component",
      ],
    );
  });

  await check("create_design exposes a documented operations schema", async () => {
    const { tools } = await rpc("tools/list");
    const create = tools.find((t) => t.name === "create_design");
    assert.ok(create.inputSchema.properties.operations);
    assert.match(create.inputSchema.properties.operations.description, /createFrame/);
  });

  console.log("\n  tools");
  await check("figma_status reports the connected file", async () => {
    const { data } = await callTool("figma_status");
    assert.equal(data.connected, true);
    assert.equal(data.fileName, "EXO Labs");
    assert.equal(data.pageName, "Dashboard");
  });

  await check("inspect_selection returns a native node tree", async () => {
    const { data } = await callTool("inspect_selection", { depth: 3 });
    assert.equal(data.selection[0].type, "FRAME");
    assert.equal(data.selection[0].width, 1440);
    assert.equal(data.selection[0].children[0].type, "TEXT");
  });

  await check("inspect_file returns file structure", async () => {
    const { data } = await callTool("inspect_file", {});
    assert.equal(data.currentPage.name, "Dashboard");
    assert.equal(data.pages.length, 1);
  });

  await check("create_design creates native nodes and returns real figma ids", async () => {
    const { data, isError } = await callTool("create_design", {
      description: "ChatGPT Test",
      operations: [{ type: "createFrame", id: "temp_1", name: "ChatGPT Test", width: 400, height: 300 }],
    });
    assert.equal(isError, false);
    assert.equal(data.status, "success");
    assert.equal(data.createdNodes[0].temporaryId, "temp_1");
    assert.match(data.createdNodes[0].figmaNodeId, /^24:\d+$/);
  });

  await check("dryRun validates without creating anything", async () => {
    const before = plugin.created.length;
    const { data } = await callTool("create_design", {
      operations: [{ type: "createFrame", width: 400, height: 300 }],
      dryRun: true,
    });
    assert.equal(data.dryRun, true);
    assert.equal(plugin.created.length, before);
  });

  await check("an operation type outside the allowlist is rejected", async () => {
    const { isError } = await callTool("create_design", {
      operations: [{ type: "evalArbitraryJavascript", code: "figma.createFrame()" }],
    });
    assert.equal(isError, true);
  });

  await check("modify_design round-trips", async () => {
    const { data } = await callTool("modify_design", {
      targets: ["24:1"],
      operations: [
        { type: "renameNode", target: "24:1", name: "Updated Dashboard" },
        { type: "setSize", target: "24:1", width: 1200, height: 800 },
      ],
    });
    assert.equal(data.status, "success");
  });

  await check("undo_last_operation reverts", async () => {
    const { data } = await callTool("undo_last_operation");
    assert.equal(data.status, "success");
  });

  await check("unknown tools are rejected", async () => {
    const { isError, text } = await callTool("delete_everything");
    assert.equal(isError, true);
    assert.match(text, /not found/i);
  });

  console.log("\n  design intelligence");
await check("inspect_design_system returns an extracted system", async () => {
    const { data, isError } = await callTool("inspect_design_system", {});
    assert.equal(isError, false);
    assert.equal(data.spacing.inferredBase, 8);
    assert.ok(data.colors.length > 0);
    assert.ok(data.variables.length > 0);
    assert.equal(data.health.hardcodedWithExistingVariable, 2);
  });

await check("review_design runs the critic over plugin metrics", async () => {
    const { data, isError } = await callTool("review_design", {});
    assert.equal(isError, false);
    assert.equal(data.reviewedNodes, 2);
    assert.ok(data.summary.total > 0, "expected findings from the fixture");

    const contrast = data.findings.find((f) => f.rule === "text-contrast");
    assert.ok(contrast, "fixture contains low-contrast text");
    assert.equal(contrast.confidence, "high");
    assert.ok(contrast.evidence.ratio < contrast.evidence.required);
  });

await check("review findings never expose a fabricated quality score", async () => {
    const { data } = await callTool("review_design", {});
    for (const f of data.findings) {
      for (const [k, v] of Object.entries(f.evidence)) {
        if (typeof v !== "number") continue;
        assert.ok(!/score|quality|rating/i.test(k), `${f.rule} exposes ${k}`);
      }
    }
  });

await check("minConfidence filters out the medium band", async () => {
    const all = await callTool("review_design", {});
    const highOnly = await callTool("review_design", { minConfidence: "high" });
    assert.ok(highOnly.data.summary.medium === 0, "no medium findings should survive");
    assert.ok(highOnly.data.summary.total <= all.data.summary.total);
  });

await check("audit_design runs a different rule set", async () => {
    const { data } = await callTool("audit_design", {});
    const rules = new Set(data.findings.map((f) => f.rule));
    assert.ok(rules.has("unstyled-text"), "fixture has unstyled text");
    assert.ok(!rules.has("text-contrast"), "audit must not run review rules");
  });

await check("collect_metrics returns measurements directly", async () => {
    const { data } = await callTool("collect_metrics", {});
    assert.equal(data.nodeCount, 2);
    assert.equal(data.nodes[0].id, "24:1");
    assert.equal(data.nodes[1].parentId, "24:1", "real parent ids, not inferred from depth");
  });

console.log("\n  render + components");
await check("render_design returns an image block plus cost metadata", async () => {
  const { data, isError } = await callTool("render_design", { nodeId: "24:1", maxWidth: 1024 });
  assert.equal(isError, false);

  // The image must be a real MCP image block, not base64 inside a text field.
  // That distinction is the whole reason this is affordable.
  const image = data.content?.find((c) => c.type === "image");
  assert.ok(image, `expected an image content block, got: ${JSON.stringify(data.content?.map((c) => c.type))}`);
  assert.equal(image.mimeType, "image/png");
  assert.ok(image.data.length > 0);

  const note = data.content.find((c) => c.type === "text");
  assert.match(note.text, /tokens/i, "the cost must be stated next to the image");
});

await check("render_design explains the cost of a downscaled image", async () => {
  const { data } = await callTool("render_design", { nodeId: "24:1", maxWidth: 512, detail: "low" });
  const note = data.content.find((c) => c.type === "text");
  assert.match(note.text, /downscaled|lost/i);
  assert.match(note.text, /review_design/, "should point at the free alternative");
});

await check("find_component returns matches rather than nothing", async () => {
  const { data, isError } = await callTool("find_component", { query: "card" });
  assert.equal(isError, false);
  assert.ok(typeof data.total === "number");
  assert.ok(Array.isArray(data.matches));
});

await check("a missing node id fails with guidance toward inspection", async () => {
  const { isError, text } = await callTool("render_design", { nodeId: "does-not-exist" });
  assert.equal(isError, true);
  assert.match(text, /not found/i);
});

console.log("\n  design runtime");
await check("runtime_primitives lists the vocabulary", async () => {
  const { data, isError } = await callTool("runtime_primitives", {});
  assert.equal(isError, false);
  assert.ok(data.primitives.length >= 15);
  assert.ok(data.primitives.some((p) => p.name === "metric"));
  assert.ok(data.primitives.some((p) => p.kind === "region"));
  assert.match(data.note, /no eval path/i);
});

await check("design_runtime dryRun compiles a program", async () => {
  const { data, isError } = await callTool("design_runtime", {
    dryRun: true,
    program: {
      canvas: { name: "EXO Compute", width: 1440, height: 900, grid: 8 },
      regions: [
        { fn: "navigation", id: "nav", args: { width: 240 } },
        { fn: "hero", id: "hero", args: { grow: 2, padding: 32 } },
      ],
      content: [
        { fn: "text", id: "title", parent: "hero", args: { text: "Compute", role: "title" } },
        { fn: "metric", id: "m1", parent: "hero", args: { label: "GPUs", value: "8x H100" } },
      ],
    },
  });

  assert.equal(isError, false);
  assert.equal(data.dryRun, true);
  assert.ok(data.operations.length > 5, "should compile a real node tree");
  assert.equal(data.stats.regions, 2);
  assert.equal(data.warnings.length, 0);
});

await check("design_runtime rejects a code-string argument rather than running it", async () => {
  const { data, isError } = await callTool("design_runtime", {
    dryRun: true,
    program: { regions: [{ fn: "frame", id: "r", args: { program: "figma.createFrame()" } }], content: [] },
  });

  assert.equal(isError, false, "must not crash the tool");
  assert.ok(data.warnings.some((w) => w.includes("program")));
  assert.match(data.warnings.join(" "), /never executes code/i);
});

await check("compile_ir resolves region geometry without touching Figma", async () => {
  const { data, isError } = await callTool("compile_ir", {
    ir: {
      canvas: { name: "S", width: 1440, height: 900, grid: 8 },
      regions: [
        { id: "nav", role: "navigation", width: 240, height: "hug", grow: 0, children: [], composition: "auto" },
        { id: "main", role: "custom", width: "fill", height: "fill", grow: 0, children: [], composition: "auto" },
      ],
      content: [],
    },
  });

  assert.equal(isError, false);
  assert.equal(data.dryRun, true);
  const nav = data.regions.find((r) => r.id === "nav");
  const main = data.regions.find((r) => r.id === "main");
  assert.equal(nav.w, 240);
  assert.equal(main.x, 272, "content offset by the rail plus gutter");
  assert.equal(main.x + main.w, 1440);
});

await check("a malformed runtime program fails with an actionable message", async () => {
  const { isError, text } = await callTool("design_runtime", {
    program: { regions: [{ fn: "notARealPrimitive", args: {} }], content: [] },
  });
  assert.equal(isError, true);
  assert.match(text, /notARealPrimitive|primitive/i);
});

console.log("\n  design memory and the drift guard");

await check("project_memory starts with the built-in rule set", async () => {
  const { data, isError } = await callTool("project_memory", { project: "smoke-test" });
  assert.equal(isError, false);
  assert.equal(data.ruleCount > 0, true, "a fresh project must not have zero rules");
  assert.equal(data.noteCount, 0);
});

await check("a recorded note is durable and appears in the prompt fragment", async () => {
  const { isError } = await callTool("project_memory", {
    project: "smoke-test",
    action: "record",
    note: { id: "topology-style", note: "Topology screens read better as one large spatial diagram.", scope: "project" },
  });
  assert.equal(isError, false);

  const { data } = await callTool("project_memory", { project: "smoke-test" });
  assert.equal(data.noteCount, 1);
  assert.match(data.promptFragment, /spatial diagram/);
});

await check("recording the same id updates rather than duplicating", async () => {
  await callTool("project_memory", {
    project: "smoke-test",
    action: "record",
    note: { id: "topology-style", note: "Topology screens read better as a clustered map.", scope: "project" },
  });

  const { data } = await callTool("project_memory", { project: "smoke-test" });
  assert.equal(data.noteCount, 1, "one note, corrected");
  assert.match(data.promptFragment, /clustered map/);
  assert.doesNotMatch(data.promptFragment, /spatial diagram/);
});

await check("a forgotten note is gone", async () => {
  const { data } = await callTool("project_memory", { project: "smoke-test", action: "forget", id: "topology-style" });
  assert.equal(data.notes, 0);
});

await check("design_guard passes a design that contradicts nothing", async () => {
  const { data, isError } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Guard ok", width: 1440, height: 900, grid: 8 },
      regions: [
        { fn: "navigation", id: "nav", args: { width: 240 } },
        { fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } },
      ],
      content: [
        { fn: "text", id: "t1", parent: "map", args: { text: "4 nodes discovered", role: "title" } },
        { fn: "deviceNode", id: "d1", parent: "map", args: { label: "node-01" } },
      ],
    },
  });

  assert.equal(isError, false);
  assert.equal(data.verdict, "PASS", `unexpected FAIL: ${JSON.stringify(data.findings.filter((f) => f.verdict === "FAIL"))}`);
});

await check("design_guard fails a manual connect-device wizard with evidence", async () => {
  const { data } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Guard fail", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [
        { fn: "text", id: "t1", parent: "main", args: { text: "Connect device", role: "title" } },
        { fn: "text", id: "t2", parent: "main", args: { text: "Scan the QR code to pair", role: "body" } },
      ],
    },
  });

  assert.equal(data.verdict, "FAIL");
  const hit = data.findings.find((f) => f.rule === "exo.auto-discovery");
  assert.equal(hit.verdict, "FAIL", "the auto-discovery rule must catch a pairing wizard");
  assert.match(hit.evidence, /Connect device/, "the verdict must name what it matched");
  assert.ok(hit.nextStep.length > 0, "a FAIL must say what to do instead");
});

await check("design_guard fails a three-card SaaS metric wall", async () => {
  const { data } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Card wall", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [
        { fn: "metric", id: "m1", parent: "main", args: { label: "GPUs", value: "8" } },
        { fn: "metric", id: "m2", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
        { fn: "metric", id: "m3", parent: "main", args: { label: "Throughput", value: "42 TF" } },
      ],
    },
  });

  assert.equal(data.verdict, "FAIL");
  assert.equal(data.findings.some((f) => f.rule === "exo.no-generic-saas" && f.verdict === "FAIL"), true);
});

await check("a rule with only unmeasurable evidence is reported, not silently passed", async () => {
  const { data } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Manual", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "text", id: "t1", parent: "main", args: { text: "Compute", role: "title" } }],
    },
  });

  const manualRule = data.findings.find((f) => f.rule === "exo.technical-typography");
  assert.ok(manualRule, "the manual rule should still appear");
  assert.match(manualRule.message, /human judgement/i);
  assert.equal(data.stats.manual > 0, true, "unevaluated checks are counted, not hidden");
});

await check("design_guard warns on unexplained topology relationships", async () => {
  const { data } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Lonely pair", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology" } }],
      content: [
        { fn: "deviceNode", id: "d1", parent: "map", args: { label: "node-01" } },
        { fn: "deviceNode", id: "d2", parent: "map", args: { label: "node-02" } },
      ],
    },
  });

  assert.equal(data.verdict, "WARNING");
  assert.equal(data.findings.some((f) => f.rule === "exo.topology-explains-relationships"), true);
});

await check("design_guard fails an anonymous control", async () => {
  const { data } = await callTool("design_guard", {
    project: "smoke-test",
    program: {
      canvas: { name: "Anon", width: 800, height: 600, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "button", id: "b1", parent: "main", args: { label: "" } }],
    },
  });

  assert.equal(data.verdict, "FAIL");
  assert.equal(data.findings.some((f) => f.rule === "exo.critical-states-labeled" && f.verdict === "FAIL"), true);
});

await check("design_guard without a target explains itself", async () => {
  const { isError, text } = await callTool("design_guard", { project: "smoke-test" });
  assert.equal(isError, true);
  assert.match(text, /inspect|program/i);
});

console.log("\n  slides");

await check("create_slide builds one titled slide in a single transaction", async () => {
  const { data, isError } = await callTool("create_slide", {
    title: "EXO Launch",
    body: "Compute, everywhere.",
    background: "#111111",
    notes: "Say the thing.",
  });

  assert.equal(isError, false);
  assert.equal(data.status, "success");
  assert.equal(data.applied[0], "createSlide", "the slide itself comes first");
  assert.equal(data.createdNodes.length, 3, "slide plus title plus body");
});

await check("create_slide with dryRun creates nothing", async () => {
  const { data } = await callTool("create_slide", { title: "Dry", dryRun: true });
  assert.equal(data.dryRun, true);
  assert.equal(data.createdNodes.length, 0);
});

await check("plan_screen can plan a deck, not just a screen", async () => {
  const { data, isError } = await callTool("plan_screen", {
    primaryDecision: "show network topology of the fleet",
    format: "deck",
    availableInformation: ["nodes", "links", "latency"],
  });

  assert.equal(isError, false);
  assert.equal(data.program.canvas.deck, true, "the program must carry deck:true or the build makes frames");
  assert.equal(data.program.canvas.width, 1920);
  assert.equal(data.program.canvas.height, 1080);
});

await check("plan_screen accepts an archetype instead of a decision", async () => {
  const { data, isError } = await callTool("plan_screen", { archetype: "model-fit" });
  assert.equal(isError, false);
  assert.equal(data.decision.primaryDecision, "run vs change model");
  assert.equal(data.archetype.name, "model-fit");
  assert.ok(data.template.name.length > 0);
});

await check("design_runtime builds in chunks with per-chunk results", async () => {
  const regions = [];
  for (let i = 0; i < 8; i++) {
    regions.push({ fn: "frame", id: `r${i}`, args: { width: "fill", height: "fill" } });
  }
  const content = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 10; j++) {
      content.push({ fn: "text", id: `t${i}_${j}`, parent: `r${i}`, args: { text: `row ${i}.${j}` } });
    }
  }
  const { data, isError } = await callTool("design_runtime", {
    chunked: true,
    program: { canvas: { name: "Big", width: 1440, height: 900, grid: 8 }, regions, content },
  });

  assert.equal(isError, false);
  assert.equal(data.chunked, true);
  assert.ok(data.chunks.length > 1, "80+ ops must split into several chunks");
  assert.ok(data.chunks.every((c) => c.status === "success"));
});

await check("design_runtime compiles a deck without touching Figma", async () => {
  const { data, isError } = await callTool("design_runtime", {
    dryRun: true,
    program: {
      canvas: { name: "Deck", width: 1440, height: 900, grid: 8, deck: true },
      regions: [{ fn: "frame", id: "title", args: {} }],
      content: [{ fn: "text", id: "t1", parent: "title", args: { text: "EXO", role: "title" } }],
    },
  });

  assert.equal(isError, false);
  const types = data.operations.map((o) => o.type);
  assert.equal(types[0], "createSlide");
  assert.equal(types.includes("createFrame"), false);
});

console.log("\n  components, targeting and tokens");

await check("find_node resolves intent to an id with a reason", async () => {
  const { data, isError } = await callTool("find_node", { text: "hello" });
  assert.equal(isError, false);
  assert.equal(data.matches[0].id, "24:2");
  assert.ok(data.matches[0].reason.length > 0);
});

await check("find_node without a query explains itself", async () => {
  const { isError, text } = await callTool("find_node", {});
  assert.equal(isError, true);
  assert.match(text, /at least one of/i);
});

await check("set_variant switches the instance", async () => {
  const { data, isError } = await callTool("set_variant", { instanceId: "50:1", variant: "Secondary" });
  assert.equal(isError, false);
  assert.equal(data.toName, "Secondary");
});

await check("update_component edits through the master path", async () => {
  const { data, isError } = await callTool("update_component", {
    componentId: "40:1",
    operations: [{ type: "renameNode", target: "40:1", name: "V2" }],
  });
  assert.equal(isError, false);
  assert.equal(data.status, "success");
});

await check("seed_exo_system declares the canonical token set", async () => {
  const { data, isError } = await callTool("seed_exo_system", { dryRun: true });
  assert.equal(isError, false);
  assert.equal(data.dryRun, true);
  assert.ok(data.seeded.variables >= 20, `expected 20+ variables, got ${data.seeded.variables}`);
  assert.ok(data.seeded.textStyles >= 5, `expected 5+ text styles, got ${data.seeded.textStyles}`);
});

console.log("\n  review workflows");

await check("score_design scores a program with evidence", async () => {
  const { data, isError } = await callTool("score_design", {
    program: {
      canvas: { name: "S", width: 1440, height: 900, grid: 8 },
      regions: [
        { fn: "navigation", id: "nav", args: { width: 240 } },
        { fn: "hero", id: "hero", args: { grow: 2 } },
      ],
      content: [
        { fn: "text", id: "t1", parent: "hero", args: { text: "Compute", role: "title" } },
        { fn: "text", id: "t2", parent: "hero", args: { text: "online", role: "body" } },
        { fn: "text", id: "t3", parent: "hero", args: { text: "8us ago", role: "caption" } },
      ],
    },
  });

  assert.equal(isError, false);
  assert.equal(data.dimensions.length, 7);
  assert.ok(data.overall >= 0 && data.overall <= 10);
  assert.ok(data.doneChecklist !== undefined, "the definition of done rides along");
});

await check("refine_screen runs a bounded fix loop", async () => {
  const { data, isError } = await callTool("refine_screen", { maxIterations: 2 });
  assert.equal(isError, false);
  assert.ok(["converged", "budget-exhausted"].includes(data.status), `unexpected status ${data.status}`);
  assert.ok(data.iterations.length >= 1 && data.iterations.length <= 2, "bounded by maxIterations");
});

await check("diff_design reports structural deltas between snapshots", async () => {
  const before = {
    selection: [{ id: "1:1", type: "FRAME", name: "Card", x: 0, y: 0, w: 100, h: 100, background: "#FFFFFF" }],
  };
  const after = {
    selection: [
      { id: "1:1", type: "FRAME", name: "Card", x: 20, y: 0, w: 100, h: 100, background: "#111111" },
      { id: "1:2", type: "TEXT", name: "Title", x: 0, y: 0, w: 50, h: 20 },
    ],
  };
  const { data, isError } = await callTool("diff_design", { before, after });
  assert.equal(isError, false);
  assert.equal(data.summary.moved, 1);
  assert.equal(data.summary.recolored, 1);
  assert.equal(data.summary.added, 1);
});

console.log("\n  code, migration, health and flows");

await check("export_code emits a React component with Tailwind classes", async () => {
  const { data, isError } = await callTool("export_code", { componentName: "Dashboard" });
  assert.equal(isError, false);
  assert.match(data.tsx, /export function Dashboard\(\)/);
  assert.match(data.tsx, /className="/);
  assert.ok(data.css.includes("--color-"), "colours become custom properties");
  assert.ok(data.limitations.length > 0, "limits are stated, not hidden");
});

await check("migrate_to_tokens dryRun reports exact matches", async () => {
  // The mock Dashboard frame hardcodes #FFFDF9, which is exactly exo/surface.
  const { data, isError } = await callTool("migrate_to_tokens", { dryRun: true });
  assert.equal(isError, false);
  assert.equal(data.dryRun, true);
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].variable, "exo/surface");
  assert.equal(data.matches[0].nodes, 1);
});

await check("audit_components flags unused and duplicated components", async () => {
  const { data, isError } = await callTool("audit_components", {});
  assert.equal(isError, false);
  assert.equal(data.unused.length, 2, "two zero-instance components in the mock");
  assert.equal(data.duplicates.length, 1, "StatusRow + StatusRow copy share a stem and size");
  assert.equal(data.duplicates[0].members.length, 2);
});

await check("prototype_flow links frames in one transaction", async () => {
  const { data, isError } = await callTool("prototype_flow", {
    links: [{ from: "24:1", to: "24:2" }],
  });
  assert.equal(isError, false);
  assert.equal(data.status, "success");
  assert.deepEqual(data.applied, ["prototypeLink"]);
});

await check("create_component_set combines members server-side", async () => {
  // The smoke mock has no handler for it: the tool must fail with guidance,
  // not with a transport error.
  const { isError, text } = await callTool("create_component_set", { name: "Button", members: ["1:50", "1:51"] });
  assert.equal(isError, true);
  assert.match(text, /no handler/i);
});

console.log("\n  briefs, snapshots and the ship gate");

await check("design_brief frames the work before any plan", async () => {
  const { data, isError } = await callTool("design_brief", {
    screen: "model-fit",
    user: "consumer",
    goal: "decide whether a model can run locally",
    primaryDecision: "run vs change model",
    visualDirection: "technical-editorial",
  });
  assert.equal(isError, false);
  // "run vs change model" is explicitly framed as a comparison, so the
  // classifier reads it as one. A decision phrased with "vs" gets a
  // side-by-side surface, which is exactly right for run-vs-change.
  assert.equal(data.decision.kind, "compare");
  assert.ok(data.primaryObject !== null);
  assert.ok(data.focal !== undefined);
  assert.ok(data.template.name.length > 0);
  assert.ok(data.compositionCandidates.length > 0);
  assert.ok(Array.isArray(data.interactionStates) && data.interactionStates.length > 0);
  assert.match(data.howToProceed, /plan_screen/);
});

await check("design_snapshot saves, lists and fetches versions", async () => {
  const saved = await callTool("design_snapshot", { project: "smoke-shots", action: "save", screen: "Home", composition: "spatial", overall: 8.2, note: "v1" });
  assert.equal(saved.isError, false);
  assert.equal(saved.data.version, 1);

  const saved2 = await callTool("design_snapshot", { project: "smoke-shots", action: "save", screen: "Home", overall: 8.8, note: "v2" });
  assert.equal(saved2.data.version, 2);

  const listed = await callTool("design_snapshot", { project: "smoke-shots", action: "list" });
  assert.equal(listed.data.snapshots.length, 2);
  assert.equal(listed.data.snapshots[0].version, 2, "newest first");

  const fetched = await callTool("design_snapshot", { project: "smoke-shots", action: "get", version: 1 });
  assert.equal(fetched.data.snapshot.note, "v1");

  const missing = await callTool("design_snapshot", { project: "smoke-shots", action: "get", version: 99 });
  assert.equal(missing.data.status, "not-found");
});

await check("final_qa gates a program with a checklist", async () => {
  const { data, isError } = await callTool("final_qa", {
    project: "smoke-test",
    program: {
      canvas: { name: "QA", width: 1440, height: 900, grid: 8 },
      regions: [
        { fn: "navigation", id: "nav", args: { width: 240 } },
        { fn: "hero", id: "hero", args: { grow: 2 } },
      ],
      content: [
        { fn: "text", id: "t1", parent: "hero", args: { text: "Compute", role: "title" } },
        { fn: "text", id: "t2", parent: "hero", args: { text: "online", role: "body" } },
        { fn: "text", id: "t3", parent: "hero", args: { text: "8us", role: "caption" } },
      ],
    },
  });
  assert.equal(isError, false);
  assert.ok(["FAIL", "PASS WITH LIVE CHECKS PENDING"].includes(data.verdict));
  assert.ok(data.checklist.length >= 8);
  assert.ok(data.pendingLiveChecks.length > 0, "offline-only runs must name their live checks");
});

await check("final_qa fails a screen with no focal hierarchy", async () => {
  const { data } = await callTool("final_qa", {
    project: "smoke-test",
    program: {
      canvas: { name: "Flat", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "text", id: "t", parent: "main", args: { text: "hi" } }],
    },
  });
  assert.equal(data.verdict, "FAIL");
  assert.ok(data.failed.length > 0);
});

console.log("\n  session safety");
  await check("refuses to guess when the target file is ambiguous", async () => {
    second = new MockPlugin();
    await second.connect();
    const { isError, text } = await callTool("figma_status");
    assert.equal(isError, true);
    assert.match(text, /ambiguous/i);
  });

  console.log(`\n  ${passed} checks passed${process.exitCode ? ", some failed" : ""}\n`);

  second?.ws.close();
  plugin.ws.close();
  server.kill();
  await sleep(100);
  rmSync(MEMORY_DIR, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  server?.kill();
  rmSync(MEMORY_DIR, { recursive: true, force: true });
  process.exit(1);
});
