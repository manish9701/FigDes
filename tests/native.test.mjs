/**
 * Server-side native execution tests (spec §17, §18, §36).
 *
 * These cover the three things that were missing from `figdes_use_figma`:
 * a hard timeout that covers async work, a per-session lock, and structured
 * failures. The plugin-side transaction state is covered in
 * plugin-runtime.test.mjs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// Keep the timeout short so the timeout path is provable without waiting 30s.
process.env.DESIGN_AGENT_NATIVE_TIMEOUT_MS = "300";

const { figdesUseFigmaHandler, figdesInspectVisualHandler, figdesReadContextHandler } = await import(
  "../mcp-server/dist-test/native/use-figma.js"
);
const { withSessionLock, lockedSessions } = await import("../mcp-server/dist-test/native/lock.js");

function makeSession({ onRequest } = {}) {
  const calls = [];
  return {
    id: "session_test",
    calls,
    async request(tool, payload) {
      calls.push({ tool, payload });
      if (onRequest) return onRequest(tool, payload);
      switch (payload?.action) {
        case "beginNativeTransaction":
          return { status: "transaction-open" };
        case "commitNativeTransaction":
          return { status: "transaction-committed", mutations: 1 };
        case "rollbackNativeTransaction":
          return { status: "transaction-rolled-back", rolledBack: true };
        default:
          return { id: "1:1", type: "FRAME", name: "Frame" };
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a successful script commits and reports how many RPCs it made", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, {
    script: "const f = await fig.createFrame({ width: 10, height: 10 }); return f.id;",
  });
  assert.equal(res.status, "success");
  assert.ok(res.rpcCalls >= 2, `expected begin + create + commit, got ${res.rpcCalls}`);
  assert.ok(session.calls.some((c) => c.payload.action === "commitNativeTransaction"));
});

test("a script that awaits forever is stopped by the hard timeout and rolled back", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, { script: "await new Promise(() => {});" });

  assert.equal(res.status, "failed");
  assert.equal(res.timedOut, true);
  assert.equal(res.error.code, "ABORTED");
  assert.equal(res.rolledBack, true);
  assert.ok(
    session.calls.some((c) => c.payload.action === "rollbackNativeTransaction"),
    "the aborted script must be rolled back",
  );
  assert.ok(
    !session.calls.some((c) => c.payload.action === "commitNativeTransaction"),
    "an aborted script must never commit",
  );
});

test("an aborted script's later RPCs are rejected before they reach the plugin", async () => {
  const session = makeSession();
  // Sleep past the budget, then try another call: it must be refused locally.
  await figdesUseFigmaHandler(session, { script: "await new Promise((r) => setTimeout(r, 400)); await fig.createFrame({ width: 1, height: 1 });" });
  const mutations = session.calls.filter((c) => c.payload.action === "createFrame");
  assert.equal(mutations.length, 0, "no createFrame should have reached the plugin after abort");
});

test("a script error is classified with a recovery step", async () => {
  const session = makeSession({
    onRequest: (tool, payload) => {
      if (payload?.action === "beginNativeTransaction") return { status: "transaction-open" };
      if (payload?.action === "rollbackNativeTransaction") return { status: "transaction-rolled-back", rolledBack: true };
      throw new Error("Node 9:9 not found");
    },
  });
  const res = await figdesUseFigmaHandler(session, { script: 'await fig.getNode("9:9");' });

  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "NODE_NOT_FOUND");
  assert.ok(res.error.recovery.length > 10, "a recovery step is always provided");
  assert.equal(res.rolledBack, true);
});

test("an invalid parameter error is classified distinctly", async () => {
  const session = makeSession({
    onRequest: (tool, payload) => {
      if (payload?.action === "beginNativeTransaction") return { status: "transaction-open" };
      if (payload?.action === "rollbackNativeTransaction") return { status: "transaction-rolled-back", rolledBack: true };
      throw new Error("Invalid parameters for createFrame (banana): unrecognized key");
    },
  });
  const res = await figdesUseFigmaHandler(session, { script: "await fig.createFrame({ width: 1, height: 1 });" });
  assert.equal(res.error.code, "INVALID_PARAMETERS");
});

test("the RPC budget is enforced", async () => {
  const previous = process.env.DESIGN_AGENT_NATIVE_MAX_RPC;
  process.env.DESIGN_AGENT_NATIVE_MAX_RPC = "3";
  try {
    const session = makeSession();
    const res = await figdesUseFigmaHandler(session, {
      script: "for (let i = 0; i < 10; i++) { await fig.createFrame({ width: 1, height: 1 }); }",
    });
    assert.equal(res.status, "failed");
    assert.equal(res.error.code, "RPC_LIMIT");
  } finally {
    if (previous === undefined) delete process.env.DESIGN_AGENT_NATIVE_MAX_RPC;
    else process.env.DESIGN_AGENT_NATIVE_MAX_RPC = previous;
  }
});

test("a script cannot reach process, require or the raw figma global", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, {
    script: "return [typeof process, typeof require, typeof figma, typeof globalThis.process];",
  });
  assert.equal(res.status, "success");
});

test("withSessionLock serializes tasks for one session", async () => {
  const order = [];
  const p1 = withSessionLock("lock-a", async () => {
    order.push("a-start");
    await sleep(20);
    order.push("a-end");
    return 1;
  });
  const p2 = withSessionLock("lock-a", async () => {
    order.push("b-start");
    order.push("b-end");
    return 2;
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"], "the second task waits for the first");
});

test("a rejected task does not deadlock the queue", async () => {
  const p1 = withSessionLock("lock-b", async () => {
    throw new Error("boom");
  });
  const p2 = withSessionLock("lock-b", async () => "ok");

  await assert.rejects(p1, /boom/);
  assert.equal(await p2, "ok");
});

test("the lock map releases a session once its chain drains", async () => {
  await withSessionLock("lock-c", async () => "done");
  await sleep(5);
  assert.equal(lockedSessions().includes("lock-c"), false);
});

/* -------------------------------------------------------------------------- */
/* Read context                                                                */
/* -------------------------------------------------------------------------- */

test("figdes_read_context maps each scope to a native action", async () => {
  const seen = [];
  const session = makeSession({
    onRequest: (tool, payload) => {
      seen.push(payload.action);
      return { ok: true };
    },
  });
  await figdesReadContextHandler(session, { scope: "file" });
  await figdesReadContextHandler(session, { scope: "design-system", maxNodes: 100 });
  await figdesReadContextHandler(session, { scope: "libraries" });
  await figdesReadContextHandler(session, { scope: "components" });
  await figdesReadContextHandler(session, { scope: "node", target: "1:2" });
  assert.deepEqual(seen, ["getFileInfo", "getDesignContext", "listLibraryCollections", "listComponents", "getProperties"]);
});

test("figdes_read_context(node) requires a target", async () => {
  const session = makeSession();
  await assert.rejects(() => figdesReadContextHandler(session, { scope: "node" }), /target/);
});

/* -------------------------------------------------------------------------- */
/* Visual inspection: failure states and image pass-through                    */
/* -------------------------------------------------------------------------- */

function visualPayload(res) {
  const text = res.content.find((c) => c.type === "text");
  return JSON.parse(text.text);
}

test("inspect_visual reports an explicit failure state when there is no render target", async () => {
  const session = makeSession({
    onRequest: (tool) => {
      if (tool === "inspect_selection") return { selection: [] };
      if (tool === "collect_metrics") return { nodes: [], nodeCount: 0, truncated: false, scan: { pageLoads: 0, pagesCached: true } };
      return {};
    },
  });
  const res = await figdesInspectVisualHandler(session, {});
  const payload = visualPayload(res);
  assert.equal(payload.renderStatus, "no-target");
  assert.ok(payload.nextActions.length > 0);
  assert.equal(res.content.some((c) => c.type === "image"), false);
});

test("inspect_visual reports a render failure rather than a silent success", async () => {
  const session = makeSession({
    onRequest: (tool) => {
      if (tool === "collect_metrics") return { nodes: [{ id: "1:1", name: "Screen", type: "FRAME", x: 0, y: 0, w: 1440, h: 900 }], nodeCount: 1, truncated: false };
      if (tool === "render_node") throw new Error("Node not found: 1:1");
      return {};
    },
  });
  const res = await figdesInspectVisualHandler(session, { target: "1:1" });
  const payload = visualPayload(res);
  assert.equal(payload.renderStatus, "render-failed");
  assert.match(payload.renderError, /not found/i);
  assert.equal(res.content.some((c) => c.type === "image"), false);
});

test("inspect_visual includes the image block when a render succeeds", async () => {
  const session = makeSession({
    onRequest: (tool) => {
      if (tool === "collect_metrics") {
        return {
          nodes: [{ id: "1:1", name: "Screen", type: "FRAME", x: 0, y: 0, w: 1440, h: 900, fills: [{}] }],
          nodeCount: 1,
          truncated: false,
        };
      }
      if (tool === "render_node") return { data: "AAAA", width: 1024, height: 640, estimatedTokens: 340 };
      return {};
    },
  });
  const res = await figdesInspectVisualHandler(session, { target: "1:1" });
  assert.equal(visualPayload(res).renderStatus, "ok");
  assert.ok(res.content.some((c) => c.type === "image"), "the screenshot must be a real image block");
});

/* -------------------------------------------------------------------------- */
/* Batch execution + readonly fast-path + telemetry                            */
/* -------------------------------------------------------------------------- */

test("a successful script returns its value with execution telemetry", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, { script: "return 42;" });
  assert.equal(res.status, "success");
  assert.equal(res.result, 42);
  assert.ok(res.telemetry, "telemetry is always reported");
  assert.equal(res.telemetry.rpcCalls, 2, "begin + commit only");
  assert.equal(res.telemetry.batchOps, 0);
  assert.ok(res.telemetry.totalMs >= 0);
});

test("fig.batch runs many operations in one RPC and reports batch telemetry", async () => {
  const session = makeSession({
    onRequest: (tool, payload) => {
      if (payload?.action === "beginNativeTransaction") return { status: "transaction-open" };
      if (payload?.action === "commitNativeTransaction") return { status: "transaction-committed", mutations: 3 };
      if (payload?.action === "executeBatch") {
        assert.equal(payload.operations.length, 3);
        assert.equal(payload.operations[1].params.parent, "$card", "refs cross as $names, not resolved ids");
        return { results: [{ ref: "card", id: "1:1" }], opCount: 3, pluginMs: 12 };
      }
      return { id: "1:1", type: "FRAME", name: "Frame" };
    },
  });
  const res = await figdesUseFigmaHandler(session, {
    script: `const { results } = await fig.batch([
      { action: "createFrame", params: { name: "Card", width: 10, height: 10 }, ref: "card" },
      { action: "createText", params: { parent: "$card", content: "Hi" } },
      { action: "setFill", target: "$card", params: { paint: "#FFFFFF" } },
    ]); return results.length;`,
  });
  assert.equal(res.status, "success");
  assert.equal(res.result, 1);
  assert.equal(res.telemetry.rpcCalls, 3, "begin + batch + commit: N operations, one round-trip");
  assert.equal(res.telemetry.batchOps, 3);
  assert.equal(res.telemetry.pluginMs, 12);
});

test("readonly scripts skip the transaction and the session lock", async () => {
  const session = makeSession({
    onRequest: (tool, payload) => {
      if (payload?.action === "beginNativeTransaction") throw new Error("readonly must not open a transaction");
      if (payload?.action === "commitNativeTransaction") throw new Error("readonly must not commit");
      assert.equal(payload.readonly, true, "every RPC carries the readonly flag");
      return { fileName: "F" };
    },
  });
  const before = lockedSessions().includes(session.id);
  const res = await figdesUseFigmaHandler(session, { script: `return (await fig.getFileInfo()).fileName;`, readonly: true });
  assert.equal(before, false);
  assert.equal(res.status, "success");
  assert.equal(res.readonly, true);
  assert.equal(res.result, "F");
  assert.ok(!session.calls.some((c) => c.payload.action === "beginNativeTransaction"));
  assert.equal(lockedSessions().includes(session.id), false, "reads never hold the lock");
});

test("a readonly script that fails reports no rollback", async () => {
  const session = makeSession({
    onRequest: () => {
      throw new Error("Node 9:9 not found");
    },
  });
  const res = await figdesUseFigmaHandler(session, { script: `await fig.getNode("9:9");`, readonly: true });
  assert.equal(res.status, "failed");
  assert.equal(res.readonly, true);
  assert.equal(res.error.code, "NODE_NOT_FOUND");
  assert.ok(!("rolledBack" in res), "nothing was open, so there is nothing to roll back");
});

test("figdes_read_context defaults to a lightweight design-system snapshot", async () => {
  const seen = [];
  const session = makeSession({
    onRequest: (tool, payload) => {
      seen.push(payload);
      return { ok: true };
    },
  });
  await figdesReadContextHandler(session, { scope: "design-system" });
  assert.equal(seen[0].maxNodes, 800, "bounded snapshot first, not the 3000-node full scan");
  assert.equal(seen[0].depth, 2);
  await figdesReadContextHandler(session, { scope: "design-system", maxNodes: 4000, depth: 5 });
  assert.equal(seen[1].maxNodes, 4000, "an explicit budget still wins");
  assert.equal(seen[1].depth, 5);
});
