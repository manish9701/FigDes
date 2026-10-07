/**
 * Full end-to-end test: the REAL plugin bundle against the REAL server.
 *
 * ## Why this exists
 *
 * Everything else has a seam:
 * - `plugin-runtime.test.mjs` loads the real bundle but calls it in-process.
 * - `smoke.mjs` uses a real server and a real socket but a mock plugin.
 *
 * So a mismatch between what the plugin *posts* and what the server *expects*
 * would pass both. That class of bug is exactly the one that shows up as
 * "inspection calls are failing internally" and takes an hour to find.
 *
 * This closes the loop: the actual `dist/code.js` bundle, driven over an actual
 * WebSocket, by the actual server, with the real protocol. The only thing faked
 * is `figma.*` itself, which no test can avoid without Figma Desktop.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createTransport } from "../mcp-server/dist-test/ui/transport.js";
import { loadPlugin } from "./plugin-harness.mjs";

const PORT = Number(process.env.E2E_PORT ?? 8801);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "e2e-secret";

let server;
let plugin;
let transport;
let registeredSessionId = null;

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Loads the real plugin bundle and drives it through the **real** UI transport.
 *
 * This is the seam that matters. `loadPlugin()` runs the actual `dist/code.js`
 * against a mock `figma`, and the translation between the server's wire frames and
 * the main thread's postMessage protocol comes from `figma-plugin/ui/transport.ts`
 * -- the same module the shipped iframe uses. Only the DOM is missing.
 *
 * Reimplementing that translation in the test would have been the tempting move and
 * the wrong one: a hand-written copy passes while the real UI is broken, which is
 * exactly the bug this file exists to catch.
 */
async function connectRealPlugin(wsUrl) {
  const { figma, doc } = loadPlugin();
  const logs = [];

  // The real iframe announces itself with `ready` before it knows the server
  // address; the main thread answers with `server-config`. Reproduced here because
  // it is part of the startup sequence, not part of the transport.
  await new Promise((resolve) => {
    figma.ui.onmessage({ kind: "ready" });
    resolve();
  });

  const config = figma.__posted.find((m) => m.kind === "server-config");
  if (!config) throw new Error("the main thread never sent server-config after ready");

  const t = createTransport({
    url: wsUrl,
    secret: SECRET,
    createSocket: (url) => new WebSocket(url),
    postToMain: (msg) => {
      // The main thread's `ui.onmessage` is the handler the bundle registered.
      void Promise.resolve(figma.ui.onmessage(msg)).catch((error) => {
        logs.push({ level: "error", message: `main-thread handler threw: ${error.message}` });
      });
    },
    log: (level, message) => logs.push({ level, message }),
    onRegistered: (sessionId) => {
      registeredSessionId = sessionId;
    },
    // Fast heartbeat so the session's liveness is exercised without a 5s wait.
    heartbeatMs: 150,
    requestTimeoutMs: 8000,
  });

  // The other half of the bridge: replies the main thread posts back on its UI
  // port must reach the transport, which is what settles its pending requests.
  const originalPost = figma.ui.postMessage;
  figma.ui.postMessage = (message) => {
    originalPost(message);
    try {
      t.acceptFromMain(message);
    } catch (error) {
      logs.push({ level: "error", message: `transport rejected a main-thread message: ${error.message}` });
    }
  };

  t.start();
  return { figma, doc, logs, config, transport: t };
}

let nextId = 1;

async function callTool(name, args = {}) {
  const response = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${SECRET}`,
    },
    // `id` must be a string or an integer: JSON-RPC 2.0 forbids a float, and the
    // MCP SDK's schema rejects the whole message as a parse error.
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();

  // The server answers with SSE when the client accepts it and plain JSON
  // otherwise. Handle both rather than assuming one.
  const line = text.split("\n").find((l) => l.startsWith("data:"));
  const payload = JSON.parse(line ? line.slice(5) : text);

  if (payload.error) throw new Error(`${name} returned a protocol error: ${JSON.stringify(payload.error)}`);

  const result = payload.result ?? {};
  return {
    isError: result.isError === true,
    data: result.structuredContent ?? {},
    text: (result.content ?? []).map((c) => c.text ?? "").join("\n"),
  };
}

async function waitForHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(400) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server never became healthy");
}

/* -------------------------------------------------------------------------- */

before(async () => {
  server = spawn(process.execPath, ["mcp-server/dist/index.js"], {
    env: {
      ...process.env,
      PORT: String(PORT),
      DESIGN_AGENT_SECRET: SECRET,
      NODE_ENV: "test",
      DESIGN_AGENT_MEMORY_DIR: join(tmpdir(), `design-agent-e2e-${process.pid}`),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  server.stderr.on("data", (d) => process.stderr.write(`  [server] ${d}`));

  await waitForHealth();

  plugin = await connectRealPlugin(`ws://127.0.0.1:${PORT}/ws?secret=${SECRET}`);

  for (let i = 0; i < 60; i++) {
    if (registeredSessionId) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`the real plugin never registered; transport logs: ${JSON.stringify(plugin.logs)}`);
});

after(async () => {
  try {
    transport?.close(1000, "e2e done");
  } catch {
    /* already closed */
  }
  server?.kill();
  await new Promise((r) => setTimeout(r, 150));
  rmSync(join(tmpdir(), `design-agent-e2e-${process.pid}`), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* The loop the user actually runs                                             */
/* -------------------------------------------------------------------------- */

test("the real plugin connects over a real socket", async () => {
  const { data } = await callTool("figma_status");
  assert.equal(data.connected, true);
  assert.ok(data.fileName, "the plugin reported its file");
});

test("inspect_selection round-trips through both processes", async () => {
  const { data, isError, text } = await callTool("inspect_selection");
  assert.equal(isError, false, `inspect_selection failed: ${JSON.stringify(data).slice(0, 400)} / ${text.slice(0, 300)}`);
  assert.ok(data.selection, "returned a selection");
});

test("inspect_design_system round-trips", async () => {
  const { data, isError } = await callTool("inspect_design_system");
  assert.equal(isError, false);
  assert.ok(data, "returned a payload");
});

test("a full runtime build lands in the real document", async () => {
  const { data, isError } = await callTool("design_runtime", {
    description: "e2e topology",
    program: {
      canvas: { name: "E2E Topology", width: 1200, height: 800, grid: 8 },
      regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
      links: [
        { from: "hub", to: "n1" },
        { from: "hub", to: "n2" },
      ],
      content: [
        { fn: "variable", id: "tok", args: { name: "surface", color: "#FFFDF9" } },
        { fn: "shape", id: "hub", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
        { fn: "shape", id: "n1", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
        { fn: "shape", id: "n2", parent: "map", args: { shape: "ellipse", fill: "#111111" } },
        { fn: "connector", id: "c1", parent: "map", args: { from: "hub", to: "n1", label: "8us" } },
        { fn: "connector", id: "c2", parent: "map", args: { from: "hub", to: "n2" } },
      ],
    },
  });

  assert.equal(isError, false, `build failed: ${JSON.stringify(data)}`);
  assert.ok(data.transaction, `no transaction in the response: ${JSON.stringify(data).slice(0, 500)}`);
  assert.equal(data.transaction.status, "success", `transaction failed: ${JSON.stringify(data.transaction?.error ?? {})}`);

  // The connector and the variable must both have been created in the document.
  const created = data.transaction.createdNodes.map((n) => n.name);
  assert.equal(created.some((n) => /connector/i.test(n)), true, `no connector was created: ${JSON.stringify(created)}`);
  assert.ok(plugin.doc.variables.some((v) => v.name === "surface"), "the variable reached the document");
});

test("a deck build lands real slides through the real plugin", async () => {
  // The harness pretends to be a design file by default. Slides only exist in
  // Figma Slides, so the editor is switched for this test and restored after.
  plugin.figma.editorType = "slides";
  try {
    const { data, isError } = await callTool("design_runtime", {
      description: "e2e deck",
      program: {
        canvas: { name: "E2E Deck", width: 1440, height: 900, grid: 8, deck: true },
        regions: [{ fn: "frame", id: "title", args: {} }],
        content: [
          { fn: "logoMark", id: "mark", parent: "title", args: { mark: "hex", color: "#FFFFFF" } },
          { fn: "text", id: "t1", parent: "title", args: { text: "EXO", role: "title", letterSpacing: 12 } },
        ],
      },
    });

    assert.equal(isError, false, `deck build failed: ${JSON.stringify(data).slice(0, 400)}`);
    assert.equal(data.transaction.status, "success");

    const created = data.transaction.createdNodes.map((n) => n.type);
    assert.equal(created.includes("SLIDE"), true, `no slide was created: ${JSON.stringify(created)}`);
    assert.equal(plugin.doc.slideGrid.length, 1, "the deck gained exactly one slide");

    const slide = plugin.doc.slideGrid[0];
    assert.equal(slide.width, 1920);
    assert.equal(slide.children.length, 2, "mark plus wordmark inside the slide");
  } finally {
    plugin.figma.editorType = "figma";
  }
});

test("review_design works on what was just built", async () => {
  const { data, isError } = await callTool("review_design", {});
  assert.equal(isError, false);
  assert.ok(Array.isArray(data.findings) || Array.isArray(data.issues) || data, "returned a payload");
});

/**
 * Finds a node id that genuinely exists.
 *
 * Read from the document rather than hardcoded, because the point of the tests
 * that use it is the *gate*. A nonexistent id fails the request correctly, which
 * would make those tests assert on Figma's error handling instead.
 */
async function realNodeId() {
  const inspected = await callTool("inspect_selection");

  // `selection` is a single node object or an array depending on the selection,
  // so both shapes are handled rather than assumed.
  const raw = inspected.data.selection ?? inspected.data.node;
  const first = Array.isArray(raw) ? raw[0] : raw;
  const id = first?.id;

  assert.ok(id, `no node id available: ${JSON.stringify(inspected.data).slice(0, 400)}`);
  return id;
}

test("render_node produces an image through the real plugin", async () => {
  const nodeId = await realNodeId();
  const { data, isError, text } = await callTool("render_design", { nodeId, maxWidth: 512, detail: "low" });
  assert.equal(isError, false, `render failed: ${JSON.stringify(data).slice(0, 400)} / ${text.slice(0, 300)}`);

  const image = data.content?.find((c) => c.type === "image");
  assert.ok(image, "the render came back as an MCP image block");
  assert.equal(image.mimeType, "image/png");
  assert.ok(image.data.length > 0, "non-empty image data");
});

test("component discovery round-trips", async () => {
  const { data, isError } = await callTool("find_component", { query: "card" });
  assert.equal(isError, false);
  assert.equal(typeof data.total, "number");
});

test("plan_screen works with no plugin involvement at all", async () => {
  // Planning must not require a connection: it is useful while Figma is closed.
  const { data, isError, text } = await callTool("plan_screen", {
    primaryDecision: "select a model to run",
    audience: "developer",
    availableInformation: ["model name", "memory", "fit state", "throughput"],
  });

assert.equal(isError, false, `plan_screen failed: ${text.slice(0, 300)}`);
  assert.equal(data.decision.composition, "table", `got composition ${data.decision.composition}`);
  assert.equal(data.passes.length, 5, "the five-pass build plan is present");
  assert.ok(data.composition.boxes.length > 0, "the 2D composition model has boxes");
  assert.ok(
    data.composition.boxes.every((b) => typeof b.why === "string" && b.why.length > 5),
    "every planned region explains itself",
  );
  assert.ok(data.program?.regions?.length > 0, "a buildable region program is included");
});

test("design_guard agrees with the planner about a metric screen", async () => {
  const { data, text } = await callTool("design_guard", {
    project: "e2e",
    program: {
      canvas: { name: "Card wall", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [
        { fn: "metric", id: "m1", parent: "main", args: { label: "GPUs", value: "8" } },
        { fn: "metric", id: "m2", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
        { fn: "metric", id: "m3", parent: "main", args: { label: "Throughput", value: "42" } },
      ],
    },
  });

  assert.equal(data.verdict, "FAIL", `guard said: ${JSON.stringify(data).slice(0, 400)} / ${text.slice(0, 200)}`);
});

test("a destructive change is refused by the real tool", async () => {
  const target = await realNodeId();
  const { data, isError } = await callTool("modify_design", {
    operations: [{ type: "removeNode", target }],
  });

  assert.equal(isError, false, "a refusal is a result, not an error");
  assert.equal(data.status, "needs-approval");
  assert.equal(data.measured.destructive, 1);
});

test("an approved destructive change is actually applied", async () => {
  const target = await realNodeId();
  const { data, text } = await callTool("modify_design", {
    operations: [{ type: "removeNode", target }],
    approved: true,
    reason: "user approved in the e2e test",
  });

  assert.equal(data.status, "success", `approval did not let it through: ${JSON.stringify(data).slice(0, 400)} / ${text.slice(0, 300)}`);
});

test("no unexpected error reached the plugin's log", async () => {
  const errors = plugin.figma.__logs.filter((l) => l.level === "error");
  assert.deepEqual(errors, [], `plugin logged errors: ${JSON.stringify(errors)}`);
});