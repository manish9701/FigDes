/**
 * Native execution tests.
 *
 * The native path now mirrors the useful part of Figma MCP: real Plugin API
 * execution plus a higher-level figdes builder, with an explicit render gate.
 * These tests intentionally test the current contract rather than the retired
 * action/RPC-batch executor.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DESIGN_AGENT_NATIVE_TIMEOUT_MS = "1000";

const {
  figdesUseFigmaHandler,
  figdesInspectVisualHandler,
  figdesReadContextHandler,
} = await import("../mcp-server/dist-test/native/use-figma.js");
const { withSessionLock, lockedSessions } = await import("../mcp-server/dist-test/native/lock.js");

function makeSession({ onRequest } = {}) {
  const calls = [];
  return {
    id: "session_test",
    calls,
    async request(tool, payload) {
      calls.push({ tool, payload });
      if (onRequest) return onRequest(tool, payload);

      if (tool === "execute_figma_script") {
        if (payload?.readonly) {
          return { status: "success", readonly: true, result: 42 };
        }
        return {
          status: "success",
          transactionId: payload.transactionId,
          result: { rootId: "1:1", createdNodeIds: ["1:1", "1:2"] },
          transaction: { status: "committed", createdNodes: ["1:1", "1:2"] },
        };
      }

      if (tool === "render_node") {
        return { data: "AAAA", width: 1024, height: 640, estimatedTokens: 340 };
      }

      if (tool === "collect_metrics") {
        return {
          nodes: [
            { id: "1:1", parentId: "PAGE", depth: 0, name: "Screen", type: "FRAME", x: 0, y: 0, w: 1440, h: 900, fill: "#FFFFFF", radius: 0, visible: true },
            { id: "1:2", parentId: "1:1", depth: 1, name: "Hero", type: "FRAME", x: 80, y: 80, w: 900, h: 700, fill: "#F4F2EA", radius: 0, visible: true },
          ],
          nodeCount: 2,
          truncated: false,
        };
      }

      return { ok: true };
    },
  };
}

test("native script succeeds through the real execution channel", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, { script: "return { rootId: '1:1', createdNodeIds: ['1:1'] };" });
  assert.equal(res.status, "success");
  assert.equal(res.result.rootId, "1:1");
  assert.ok(session.calls.some((c) => c.tool === "execute_figma_script"));
});

test("native build can render its returned root in the same call", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, {
    script: "return { rootId: '1:1', createdNodeIds: ['1:1'] };",
    renderAfter: "first-created",
  });
  assert.ok(Array.isArray(res.content));
  assert.equal(res.content.some((c) => c.type === "image"), true);
  const summary = JSON.parse(res.content.find((c) => c.type === "text").text);
  assert.equal(summary.renderStatus, "ok");
  assert.equal(summary.renderTarget, "1:1");
});

test("explicit render target works when the script does not return ids", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, {
    script: "return { ok: true };",
    renderAfter: "explicit",
    renderNodeId: "1:1",
  });
  assert.equal(res.content.some((c) => c.type === "image"), true);
});

test("readonly native execution skips the mutation path", async () => {
  const session = makeSession();
  const res = await figdesUseFigmaHandler(session, { script: "return 42;", readonly: true });
  assert.equal(res.status, "success");
  assert.equal(res.readonly, true);
  assert.equal(res.result, 42);
});

test("native execution reports a script failure without pretending it succeeded", async () => {
  const session = makeSession({
    onRequest: (tool) => {
      if (tool === "execute_figma_script") {
        return {
          status: "failed",
          transactionId: "ntx_test",
          error: { code: "FIGMA_API_ERROR", message: "Node 9:9 not found" },
        };
      }
      return {};
    },
  });
  const res = await figdesUseFigmaHandler(session, { script: "throw new Error('Node 9:9 not found');" });
  assert.equal(res.status, "failed");
  assert.equal(res.error.code, "FIGMA_API_ERROR");
});

test("render failure is surfaced instead of silently passing", async () => {
  const session = makeSession({
    onRequest: (tool) => {
      if (tool === "execute_figma_script") {
        return { status: "success", result: { rootId: "1:1", createdNodeIds: ["1:1"] }, transaction: { status: "committed" } };
      }
      if (tool === "render_node") throw new Error("Node not found: 1:1");
      return {};
    },
  });
  const res = await figdesUseFigmaHandler(session, {
    script: "return { rootId: '1:1', createdNodeIds: ['1:1'] };",
    renderAfter: "first-created",
  });
  assert.equal(res.renderStatus, "failed");
  assert.match(res.renderError, /not found/i);
});

test("figdes_read_context remains bounded by default", async () => {
  const seen = [];
  const session = makeSession({
    onRequest: (tool, payload) => {
      if (tool === "native_design") seen.push(payload);
      return { ok: true };
    },
  });
  await figdesReadContextHandler(session, { scope: "design-system" });
  assert.equal(seen[0].maxNodes, 800);
  assert.equal(seen[0].depth, 2);
});

test("visual inspection includes a real image when render succeeds", async () => {
  const session = makeSession();
  const res = await figdesInspectVisualHandler(session, { target: "1:1" });
  assert.equal(res.content.some((c) => c.type === "image"), true);
});

test("withSessionLock serializes work for one session", async () => {
  const order = [];
  const p1 = withSessionLock("lock-a", async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 10));
    order.push("a-end");
    return 1;
  });
  const p2 = withSessionLock("lock-a", async () => {
    order.push("b-start");
    order.push("b-end");
    return 2;
  });
  assert.deepEqual(await Promise.all([p1, p2]), [1, 2]);
  assert.deepEqual(order, ["a-start", "a-end", "b-start", "b-end"]);
  assert.equal(lockedSessions().includes("lock-a"), false);
});
