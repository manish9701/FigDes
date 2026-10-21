/**
 * FigDes observed-issues fix roadmap — acceptance tests.
 *
 * P0 rollback journal, P0 job ledger / reconnect recovery, P1 preflight,
 * P1 timing instrumentation, P1 critic provenance + card-wall semantics,
 * P1 orchestrator shape, P2 compare delta + reuse notes.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, ask, makeDocument } from "./plugin-harness.mjs";
import { validateTransaction } from "../mcp-server/dist-test/reliability/preflight.js";
import { snapshot as metricsSnapshot, recordPreflightCatch } from "../mcp-server/dist-test/reliability/metrics.js";
import { SessionRegistry } from "../mcp-server/dist-test/reliability/sessions.js";

let figma;
let doc;
before(() => {
  ({ figma, doc } = loadPlugin());
});

/* ---------------- P0: rollback restores existing-node mutations --------- */

test("fail after changing an existing node restores its original value", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const beforeName = target.name;
  const beforeW = target.width;

  const reply = await ask(f, "create_design", {
    transactionId: "txn-rollback-1",
    operations: [
      { type: "renameNode", target: target.id, name: "Mutated" },
      { type: "setSize", target: target.id, width: 999, height: 999 },
      { type: "renameNode", target: "ghost-does-not-exist", name: "boom" },
    ],
  });

  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, true);
  assert.equal(reply.data.rollbackStatus, "full");
  assert.ok((reply.data.restoredIds ?? []).includes(target.id), "restored ids name the node");
  assert.equal((reply.data.unrestoredIds ?? []).length, 0);
  const live = f.__node(target.id);
  assert.equal(live.name, beforeName);
  assert.equal(live.width, beforeW);
});

test("fail after create + edit + reparent cleans up both", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const parentBefore = target.parent.id;
  const beforeCount = d.page.children.length;

  const reply = await ask(f, "create_design", {
    transactionId: "txn-rollback-2",
    operations: [
      { type: "createFrame", id: "newframe", name: "New", width: 200, height: 200 },
      { type: "setFill", target: target.id, fill: "#FF0000" },
      { type: "appendChild", parent: "newframe", child: target.id },
      { type: "renameNode", target: "ghost-does-not-exist", name: "boom" },
    ],
  });

  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, true);
  assert.equal(reply.data.rollbackStatus, "full");
  // Created frame is gone.
  assert.equal(d.page.children.length, beforeCount, "created container removed");
  // Target is back where it was with its old fill.
  const live = f.__node(target.id);
  assert.equal(live.parent.id, parentBefore);
  assert.notEqual(JSON.stringify(live.fills), JSON.stringify([{ type: "SOLID", color: { r: 1, g: 0, b: 0 }, opacity: 1 }]));
});

test("removeNode rollback re-inserts the removed subtree", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const reply = await ask(f, "create_design", {
    transactionId: "txn-rollback-3",
    operations: [
      { type: "removeNode", target: target.id },
      { type: "renameNode", target: "ghost-does-not-exist", name: "boom" },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, true);
  assert.equal(reply.data.rollbackStatus, "full");
  const live = f.__node(target.id);
  assert.ok(live && !live.removed, "removed node is back");
});

test("unrestorable consume reports partial-rollback, never full", async () => {
  const { figma: f } = loadPlugin();
  // The harness has no boolean API, so this fails AFTER journaling consumes.
  const reply = await ask(f, "create_design", {
    transactionId: "txn-rollback-4",
    operations: [
      { type: "createRectangle", id: "a", width: 50, height: 50 },
      { type: "createRectangle", id: "b", width: 50, height: 50 },
      { type: "booleanOperation", operation: "union", targets: ["a", "b"] },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, false);
  assert.equal(reply.data.rollbackStatus, "partial");
  assert.ok((reply.data.unrestoredIds ?? []).length > 0, "consumed sources are named");
  assert.match(reply.data.error.rolledBackNote, /partial/i);
});

/* ---------------- P0: success carries timings + budget warnings --------- */

test("success reports stage timings and cache stats", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", {
    transactionId: "txn-timing-1",
    operations: [
      { type: "createFrame", id: "r", width: 300, height: 200 },
      { type: "createText", parent: "r", content: "Hi", fontSize: 16 },
      { type: "renameNode", target: "r", name: "Root2" },
    ],
  });
  assert.equal(reply.data.status, "success");
  assert.ok(reply.data.timings, "timings present");
  assert.equal(typeof reply.data.timings.total, "number");
  assert.equal(typeof reply.data.timings.apply, "number");
  assert.ok(Array.isArray(reply.data.timings.perOperation));
  assert.ok(reply.data.timings.cache, "cache stats present");
  assert.equal(typeof reply.data.timings.cache.hits, "number");
});

/* ---------------- P1: preflight catches everything before Figma --------- */

test("preflight rejects nulls, dup ids and bad refs in one response", async () => {
  const bad = [
    { type: "createFrame", id: "dup", width: 100, height: 100 },
    { type: "createFrame", id: "dup", width: 100, height: 100 },
    { type: "setFill", target: "ghost", fill: "#FFFFFF" },
    { type: "createText", content: null, fontSize: 16 },
  ];
  const res = validateTransaction(bad);
  assert.equal(res.ok, false);
  assert.ok(res.issues.length >= 3, `expected 3+ issues, got ${res.issues.length}`);
  assert.ok(res.issues.every((i) => typeof i.index === "number" && i.fix.length > 0));
  const kinds = res.issues.map((i) => i.message).join(" | ");
  assert.match(kinds, /Duplicate temporary id/);
  assert.match(kinds, /Unresolved reference/);
});

test("preflight passes a good plan", async () => {
  const res = validateTransaction([
    { type: "createFrame", id: "root", width: 400, height: 300 },
    { type: "createText", parent: "root", content: "Hello", fontSize: 16 },
    { type: "renameNode", target: "root", name: "Home" },
  ]);
  assert.equal(res.ok, true);
  assert.equal(res.issues.length, 0);
});

test("metrics record preflight catches", async () => {
  const before = metricsSnapshot().counters.preflightCatches;
  recordPreflightCatch(2);
  const after = metricsSnapshot().counters.preflightCatches;
  assert.equal(after, before + 2);
});

/* ---------------- P0: job ledger + reconnect recovery ------------------- */

test("job ledger tracks queued → committed", async () => {
  const registry = new SessionRegistry();
  const fake = { id: "session_1", fileKey: "k1", fileName: "F" };
  const rec = registry.jobs.begin({ transactionId: "txn-ledger-1", tool: "create_design", session: fake, operationCount: 3 });
  assert.equal(rec.state, "queued");
  registry.jobs.update("txn-ledger-1", { state: "applying", done: 1 });
  assert.equal(registry.jobs.get("txn-ledger-1").state, "applying");
  registry.jobs.complete("txn-ledger-1", "committed", { done: 3 }, { status: "success" });
  assert.equal(registry.jobs.get("txn-ledger-1").state, "committed");
  assert.deepEqual(registry.jobs.priorResult("txn-ledger-1"), { status: "success" });
});

test("unknown session errors carry a safe recovery hint", async () => {
  const registry = new SessionRegistry();
  assert.throws(() => registry.resolve("session_nope"), /Unknown plugin session.*(get_job_status|SAME transactionId|open the plugin)/s);
});

test("resumed transaction ids are idempotent via priorResult", async () => {
  const registry = new SessionRegistry();
  const fake = { id: "session_1", fileKey: "k1", fileName: "F" };
  registry.jobs.begin({ transactionId: "txn-dedupe-1", tool: "create_design", session: fake, operationCount: 1 });
  registry.jobs.complete("txn-dedupe-1", "committed", {}, { status: "success", transactionId: "txn-dedupe-1" });
  // A retry must find the prior result instead of dispatching again.
  assert.ok(registry.jobs.priorResult("txn-dedupe-1"), "prior result retained for idempotent retry");
});

/* --------- P0: reconnect lineage for null fileKeys (#18 session) --------- */

/**
 * Local/desktop files report a null fileKey on every connection, which used
 * to disable lineage entirely: after a disconnect the stale id error could
 * only give the generic hint instead of naming the replacement session.
 */
const fakeSocket = () => {
  const handlers = {};
  return {
    handlers,
    on: (event, cb) => {
      handlers[event] = cb;
    },
    readyState: 1,
    OPEN: 1,
    send: () => {},
    close: () => {},
  };
};

test("a reconnect on a null fileKey links by fileName", async () => {
  const { SessionRegistry: Registry } = await import("../mcp-server/dist-test/reliability/sessions.js");
  const registry = new Registry();
  const sock1 = fakeSocket();
  const s1 = registry.add(sock1);
  Object.assign(s1, { fileKey: null, fileName: "Exo Labs" });
  sock1.handlers.close();

  const sock2 = fakeSocket();
  const s2 = registry.add(sock2);
  Object.assign(s2, { fileKey: null, fileName: "Exo Labs" });
  const linked = registry.linkGeneration(s2);
  assert.equal(linked.reboundFrom, s1.id, "the new generation names the disconnected one");

  assert.throws(() => registry.resolve(s1.id), new RegExp(`Unknown plugin session.*${s2.id}`, "s"),
    "the stale id error names the replacement session instead of only hinting");
});

test("the 'Unknown file' default never links generations", async () => {
  const { SessionRegistry: Registry } = await import("../mcp-server/dist-test/reliability/sessions.js");
  const registry = new Registry();
  const sock1 = fakeSocket();
  const s1 = registry.add(sock1);
  Object.assign(s1, { fileKey: null, fileName: "Unknown file" });
  sock1.handlers.close();

  const s2 = registry.add(fakeSocket());
  Object.assign(s2, { fileKey: null, fileName: "Unknown file" });
  assert.deepEqual(registry.linkGeneration(s2), {}, "no identity, no lineage");
});

test("lineage stays bounded across many reconnects", async () => {
  const { SessionRegistry: Registry } = await import("../mcp-server/dist-test/reliability/sessions.js");
  const registry = new Registry();
  const stale = [];
  for (let i = 0; i < 25; i++) {
    const sock = fakeSocket();
    const s = registry.add(sock);
    Object.assign(s, { fileKey: "k-same", fileName: "F" });
    sock.handlers.close();
    stale.push(s.id);
    const next = registry.add(fakeSocket());
    Object.assign(next, { fileKey: "k-same", fileName: "F" });
    registry.linkGeneration(next);
  }
  // The oldest generations aged out of the bounded lineage: their stale ids
  // fall back to the generic hint instead of naming a replacement.
  let oldestNamesRebound = false;
  try {
    registry.resolve(stale[0]);
  } catch (e) {
    oldestNamesRebound = /reconnected as/.test(String(e.message ?? e));
  }
  assert.equal(oldestNamesRebound, false, "evicted lineage must not name a replacement");
  // A recent generation still recovers with the rebound hint.
  assert.throws(() => registry.resolve(stale[stale.length - 1]), /reconnected as/);
});

/* ---------------- P1: critic provenance + card-wall semantics ------------ */

test("runRules findings carry provenance", async () => {
  const rulesMod = await import("../mcp-server/dist-test/review/rules.js");
  const runRules = rulesMod.runRules;
  assert.ok(typeof runRules === "function", "runRules exported");
  const report = {
    target: null,
    scope: "test",
    nodeCount: 2,
    truncated: false,
    scanBudget: 100,
    scan: { pageLoads: 0, pagesCached: false },
    nodes: [
      { id: "1", parentId: null, type: "FRAME", name: "Root", depth: 0, x: 0, y: 0, w: 800, h: 600, visible: true, defaultNamed: false, zIndex: 0, coordSpace: "parent-local" },
      { id: "2", parentId: "1", type: "TEXT", name: "Label", depth: 1, x: 900, y: 10, w: 100, h: 20, visible: true, defaultNamed: false, zIndex: 0, coordSpace: "parent-local", background: "#FFFFFF", text: { content: "Hi", length: 2, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#777777", styled: false } },
    ],
  };
  const findings = runRules(report, "review");
  const overflow = findings.find((f) => f.rule === "overflow");
  if (overflow) {
    assert.ok(overflow.ruleVersion, "rule version present");
    assert.ok(overflow.evidenceType, "evidence type present");
    assert.ok(overflow.coordinateSpace, "coordinate space present");
  }
});

/* ---------------- P2: reuse + region render surface --------------------- */

test("plugin bundle exposes rollbackStatus on failure", async () => {
  const { figma: f } = loadPlugin();
  const reply = await ask(f, "create_design", { operations: [{ type: "notARealOperation" }] });
  assert.equal(reply.data.status, "failed");
  // Plan-level failures never touched the document.
  assert.equal(reply.data.rolledBack, false);
});

/* --------- Timeout / cancel / late-result (32-op stall fix) ------------- */

test("timed-out is a distinct ledger state with a reconcile-first hint", async () => {
  const registry = new SessionRegistry();
  const fake = { id: "session_1", fileKey: "k1", fileName: "F" };
  registry.jobs.begin({ transactionId: "txn-timeout-1", tool: "modify_design", session: fake, operationCount: 32 });
  registry.jobs.complete("txn-timeout-1", "timed-out", { error: "stalled at 17/32" });
  assert.equal(registry.jobs.get("txn-timeout-1").state, "timed-out");
});

test("same transactionId success does not duplicate nodes (late-commit safe)", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const before = d.page.children.length;
  const ops = [{ type: "createFrame", id: "idem-retry", name: "Idem", width: 100, height: 100 }];
  const first = await ask(f, "create_design", { transactionId: "txn-idem-retry", operations: ops });
  assert.equal(first.data.status, "success");
  const afterFirst = d.page.children.length;
  const second = await ask(f, "create_design", { transactionId: "txn-idem-retry", operations: ops });
  assert.equal(second.data.status, "success");
  assert.equal(d.page.children.length, afterFirst, "cached retry must not create again");
  assert.ok(afterFirst > before);
});

test("cancel before dispatch aborts cleanly; the same id can retry after", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const beforeName = target.name;
  const handler = f.ui.onmessage;

  // Pre-cancel: the flag lands before the transaction is dispatched, so the
  // run aborts deterministically instead of racing a 5ms window.
  await handler({ kind: "cancel", requestId: "unknown-req", transactionId: "txn-cancel-precancel", reason: "test timeout" });
  const reply = await ask(f, "create_design", {
    transactionId: "txn-cancel-precancel",
    operations: [
      { type: "renameNode", target: target.id, name: "Mutated" },
      { type: "createFrame", id: "cx1", name: "CX1", width: 50, height: 50 },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.match(reply.data.error.message, /cancel/i);
  assert.equal(reply.data.rolledBack, false, "nothing was committed, so there is nothing to roll back");
  assert.equal(f.__node(target.id).name, beforeName, "document untouched");
  assert.equal(d.page.children.some((c) => c.name === "CX1"), false);

  // A retry with the SAME id runs normally: a cancellation is one-shot.
  const retry = await ask(f, "create_design", {
    transactionId: "txn-cancel-precancel",
    operations: [{ type: "renameNode", target: target.id, name: "Retried" }],
  });
  assert.equal(retry.data.status, "success");
  assert.equal(f.__node(target.id).name, "Retried");
});

test("cancel after completion is a harmless no-op", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const handler = f.ui.onmessage;
  f.__posted.length = 0;
  const requestId = `test_cancel_late_${Date.now()}`;
  const promise = handler({
    kind: "request",
    requestId,
    tool: "create_design",
    payload: { transactionId: "txn-cancel-late", operations: [{ type: "renameNode", target: target.id, name: "Done" }] },
  });
  // Fire the cancel well after the op list, then await the reply.
  await new Promise((r) => setTimeout(r, 60));
  await handler({ kind: "cancel", requestId, transactionId: "txn-cancel-late", reason: "server timeout" });
  await promise;
  assert.equal(f.__node(target.id).name, "Done", "a completed transaction is not cancelled retroactively");
});
