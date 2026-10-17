/**
 * Issue #15 — apply-path performance and failure injection.
 *
 * ## The defect this file exists for
 *
 * A 62-operation consumer screen took ~250s live. The plugin's own stage
 * timings already said `apply` was the hot path, but they did not say *why*:
 * summing `timings.perOperation` and comparing it to `timings.apply` showed the
 * per-operation work explained almost none of it.
 *
 * Measured on the mock document (see `artifacts/perf/before.json`), a 175-op
 * screen spent **671ms of its 680ms apply stage in time the per-operation
 * timings could not account for**. It was the yield that lets the canvas
 * repaint between operations, gated on the *operation count* rather than on
 * elapsed time. `setTimeout(0)` measured ~15ms per call here, so the cost
 * scaled with batch size instead of with wall-clock — the larger the screen,
 * the more time spent waiting to be allowed to paint.
 *
 * Two fixes follow from the measurement, and both are asserted below:
 *   P01  Yields are time-gated, so they track wall-clock (one per paint
 *        interval) instead of op count.
 *   P02  `register()` seeds the handle cache with the node it just built, so the
 *        verify pass stops re-fetching by id. Lookups were O(ops) — 184 for 175
 *        ops; they are now constant at 9 regardless of size.
 *
 * ## What is verified here, and what is not
 *
 * Offline. The real plugin bundle and the real server modules run against a
 * mock `figma`. The timings below measure the *plugin's own* cost; the API call
 * *counts* are trustworthy, because every one is a real round trip in the
 * editor, but the wall-clock is not Figma's wall-clock. The ~250s live figure
 * is **not** reproduced here and the report says so. The transaction now reports
 * `timings.yields` precisely so a live run can confirm P01 rather than take it
 * on trust.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugin, ask } from "./plugin-harness.mjs";
import { Session, SessionRegistry } from "../mcp-server/dist-test/reliability/sessions.js";
import { screen } from "../scripts/lib/screen-workload.mjs";

/** Runs one workload and returns the transaction result plus its document. */
async function run(prefix, ops, { timeoutMs = 60000 } = {}) {
  const { figma, doc } = loadPlugin();
  const before = doc.page.children.length;
  const reply = await ask(figma, "create_design", { transactionId: `txn_i15_${prefix}`, description: prefix, operations: ops }, { timeoutMs });
  return { reply, doc, before, figma };
}

/**
 * The diagnostic that found the defect, as a test.
 *
 * If this fails, apply time is again going somewhere the per-operation timings
 * cannot see — which is the condition under which the hot path is invisible and
 * the next investigation has to start from scratch.
 */
function assertApplyIsAccountedFor(timings, label) {
  const perOp = (timings.perOperation ?? []).reduce((s, p) => s + p.ms, 0);
  const apply = timings.apply ?? 0;
  const unexplained = apply - perOp;
  // Generous, because it still has to cover the final yield and the progress
  // callbacks. Pre-fix this was 671ms at 175 ops; anything near that is the
  // same defect returning under another name.
  assert.ok(unexplained < apply * 0.5 + 25, `${label}: ${unexplained}ms of apply is unexplained (apply=${apply}ms, per-op sum=${perOp}ms)`);
}

/* -------------------------------------------------------------------------- */
/* P01 — the yield is gated on elapsed time, not operation count                 */
/* -------------------------------------------------------------------------- */

test("P01 — apply time is accounted for by the operations that ran", async () => {
  const ops = screen("p01", 175);
  const { reply } = await run("p01", ops);
  assert.equal(reply.data.status, "success");
  assertApplyIsAccountedFor(reply.data.timings, "175 ops");
});

test("P01 — a build reports its own paint cadence so a live run can check it", async () => {
  const { reply } = await run("p01_yields", screen("p01y", 100));
  const y = reply.data.timings.yields;
  assert.ok(y, "timings.yields is how apply time is attributed; it must be reported");
  assert.equal(typeof y.count, "number");
  assert.equal(typeof y.ms, "number");
  assert.ok(y.intervalMs > 0);
  // Yields track elapsed time, so a fast build yields about once, not once per
  // operation. Pre-fix this was 175 for a 175-op screen.
  assert.ok(y.count <= Math.ceil((reply.data.timings.apply ?? 0) / y.intervalMs) + 1, `expected yields to follow the paint interval, got ${y.count} yields for ${reply.data.timings.apply}ms of apply`);
});

test("P01 — the yield cadence has no cliff at the old 60-operation threshold", async () => {
  // The pre-fix cadence was `total <= 60 ? yield every op : every 4th op`. That
  // threshold is arbitrary and inverted: in `artifacts/perf/before.json` a 40-op
  // screen took 583ms while a *larger* 62-op screen took 239ms, because
  // crossing 60 divided the yield rate by four. A bigger screen being more than
  // twice as fast is the signature of a cost that depends on batch size.
  //
  // Asserted by counting the yields rather than by timing them: the apply loop's
  // `setTimeout(0)` is the yield, and counting it is exact, whereas comparing
  // two single-digit-millisecond builds by wall-clock would be pure noise.
  const countYields = async (size) => {
    const { figma, doc } = loadPlugin();
    const realSetTimeout = globalThis.setTimeout;
    let yields = 0;
    globalThis.setTimeout = function (fn, ms, ...rest) {
      if (!ms) yields += 1;
      return realSetTimeout(fn, ms, ...rest);
    };
    try {
      const reply = await ask(figma, "create_design", { transactionId: `txn_i15_cliff_${size}`, operations: screen(`cliff${size}`, size) }, { timeoutMs: 60000 });
      assert.equal(reply.data.status, "success");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    void doc;
    return yields;
  };

  const under = await countYields(55);
  const over = await countYields(100);

  // Post-fix both builds yield about once. Pre-fix: 55 yields for the 55-op
  // build against 25 for the 100-op one — strictly backwards.
  assert.ok(under <= 4, `a 55-op build yielded ${under} times; the cadence still follows the operation count`);
  assert.ok(over <= 4, `a 100-op build yielded ${over} times`);
});

/* -------------------------------------------------------------------------- */
/* P02 — created nodes are not re-fetched by id                                 */
/* -------------------------------------------------------------------------- */

test("P02 — node lookups are constant, not proportional to the build", async () => {
  const counts = [];
  for (const size of [15, 100, 175]) {
    const { reply } = await run(`p02_${size}`, screen(`p02${size}`, size));
    counts.push({
      size,
      misses: reply.data.timings.cache?.misses ?? -1,
      hits: reply.data.timings.cache?.hits ?? -1,
    });
  }
  // Pre-fix: misses grew with the workload (16 / ~44 / ~120). Every created node
  // was re-fetched by the verify pass although register() already held it.
  for (const c of counts) {
    assert.equal(c.misses, 0, `${c.size} ops: ${c.misses} live lookups, expected 0 — a created node is being re-fetched instead of using its handle`);
    assert.ok(c.hits > 0, `${c.size} ops: expected the handle cache to be used`);
  }
});

/* -------------------------------------------------------------------------- */
/* The yield is load-bearing for cancellation — prove it still is                */
/* -------------------------------------------------------------------------- */

test("a cancel still lands mid-build under time-gated yields", async () => {
  // The yield is not only for painting: it is how a `cancel` frame from the
  // server gets delivered at all, because the main thread's event loop only runs
  // between operations. Removing yields naively would silently make every
  // transaction uncancellable, so this asserts the guarantee directly.
  //
  // The mock applies an operation in microseconds, so a 60-op build finishes
  // before any cancel could arrive. Making every create slow makes the build
  // outlive the cancel the way a real Figma transaction does.
  const { figma, doc } = loadPlugin();
  for (const name of ["createFrame", "createRectangle", "createEllipse", "createText"]) {
    const real = figma[name];
    figma[name] = () => {
      const until = performance.now() + 4;
      while (performance.now() < until);
      return real();
    };
  }

  const before = doc.page.children.length;
  const ops = screen("cancel", 120);
  figma.__posted.length = 0;
  const handler = figma.ui.onmessage;
  const inFlight = handler({ kind: "request", requestId: "i15_cancel", tool: "create_design", payload: { transactionId: "txn_i15_cancel", operations: ops } });

  await new Promise((r) => setTimeout(r, 120));
  await handler({ kind: "cancel", requestId: "i15_cancel", transactionId: "txn_i15_cancel", reason: "server timeout" });
  await inFlight;

  const reply = figma.__posted.find((m) => m.kind === "response" && m.requestId === "i15_cancel");
  assert.equal(reply.data.status, "failed");
  assert.match(reply.data.error.message, /cancelled after \d+\/\d+ operations/, "the cancel must be observed mid-build, not after it finishes");
  assert.equal(reply.data.rollbackStatus, "full", "a cancelled build rolls back fully");
  assert.equal(doc.page.children.length - before, 0, "no partial work may survive");
});

/* -------------------------------------------------------------------------- */
/* Failure injection (issue #15 list, cases that are meaningful here)            */
/* -------------------------------------------------------------------------- */

test("FI01 — a validation failure before any mutation leaves the document alone", async () => {
  const { figma, doc } = loadPlugin();
  const before = doc.page.children.length;
  const reply = await ask(figma, "create_design", {
    transactionId: "txn_i15_fi01",
    operations: [{ type: "createFrame", id: "ok", name: "Fine", width: 10, height: 10 }, { type: "notARealOperation" }],
  });
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rolledBack, false, "nothing was applied, so nothing needed rolling back");
  assert.equal(doc.page.children.length, before);
});

test("FI02 — a mid-batch creation failure leaves no orphan nodes", async () => {
  const { figma, doc } = loadPlugin();
  const before = doc.page.children.length;
  const ops = screen("fi02", 40);
  ops.push({ type: "renameNode", target: "ghost-missing", name: "boom" });
  const reply = await ask(figma, "create_design", { transactionId: "txn_i15_fi02", operations: ops });
  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rollbackStatus, "full");
  assert.equal((reply.data.orphanIds ?? []).length, 0, "every created node was removed, so nothing is orphaned");
  assert.equal(doc.page.children.length, before);
});

test("FI03 — a create whose parent has been removed fails instead of writing into a dead subtree", async () => {
  // Failure-injection case 8, "parent disappears during execution". The node is
  // removed in an earlier transaction, so the second transaction must not resolve
  // it as a live parent.
  //
  // `resolve()` checked `.removed` on its cached path but not on a fresh lookup,
  // so whether this failed depended on whether the handle happened to be cached.
  // With the cache cold it happily created a child inside a removed frame — a
  // node that no longer exists in the document, reported as a clean success.
  const { figma, doc } = loadPlugin();
  const victim = doc.page.children[0];

  const removed = await ask(figma, "create_design", {
    transactionId: "txn_i15_fi03_rm",
    operations: [{ type: "removeNode", target: victim.id }],
  });
  assert.equal(removed.data.status, "success");

  const orphan = await ask(figma, "create_design", {
    transactionId: "txn_i15_fi03_orphan",
    operations: [{ type: "createFrame", id: "ghostchild", parent: victim.id, name: "Ghost child", width: 10, height: 10 }],
  });
  assert.equal(orphan.data.status, "failed", "a removed parent must not resolve");
  assert.match(orphan.data.error.message, /Node not found/i);
  // Nothing was created, so there is genuinely nothing to undo: a verified
  // empty rollback, which is a different claim from "failed before it started".
  assert.equal(orphan.data.rollbackStatus, "full");
  assert.equal(orphan.data.removedIds, undefined, "no nodes were created, so none were removed");

  const reachable = (node) => {
    const stack = [...doc.page.children];
    while (stack.length > 0) {
      const n = stack.pop();
      if (n.name === node) return true;
      if (Array.isArray(n.children)) stack.push(...n.children);
    }
    return false;
  };
  assert.equal(reachable("Ghost child"), false, "nothing may be written into a removed subtree");
});

test("FI04 — a duplicate submission of the same transaction does not duplicate nodes", async () => {
  const { figma, doc } = loadPlugin();
  const ops = screen("fi04", 30);
  const first = await ask(figma, "create_design", { transactionId: "txn_i15_fi04", operations: ops });
  assert.equal(first.data.status, "success");
  const after = doc.page.children.length;
  const second = await ask(figma, "create_design", { transactionId: "txn_i15_fi04", operations: ops });
  assert.equal(second.data.status, "success");
  assert.equal(doc.page.children.length, after, "the replay must return the prior result, not build again");
});

test("FI05 — a font that cannot be loaded fails the transaction instead of substituting", async () => {
  const { figma, doc } = loadPlugin();
  const before = doc.page.children.length;

  // The mock accepts any font name, so the fallback path is what is under test
  // here: with no installed match, `loadFont` must refuse rather than quietly
  // render in a different family and let the model believe the brand font landed.
  figma.listAvailableFontsAsync = async () => [{ fontName: { family: "Inter", style: "Regular" } }];
  figma.loadFontAsync = async (name) => {
    if (name?.family !== "Inter") throw new Error(`Font not available: ${name?.family}`);
  };

  const reply = await ask(figma, "create_design", {
    transactionId: "txn_i15_fi05",
    operations: [
      { type: "createText", id: "t1", name: "T", content: "hello", family: "Nonexistent Font", fontSize: 12 },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.match(reply.data.error.message, /not available/i);
  assert.equal(doc.page.children.length, before, "a font failure must not leave half a screen");
});

test("FI06 — a rollback that cannot remove a node is reported partial, never full", async () => {
  const { figma, doc } = loadPlugin();
  const real = figma.createFrame;
  figma.createFrame = () => {
    const node = real();
    node.remove = () => {};
    return node;
  };
  const reply = await ask(figma, "create_design", {
    transactionId: "txn_i15_fi06",
    operations: [
      { type: "createFrame", id: "stubborn", name: "Stubborn", width: 10, height: 10 },
      { type: "renameNode", target: "ghost-missing", name: "boom" },
    ],
  });
  assert.equal(reply.data.status, "failed");
  assert.notEqual(reply.data.rollbackStatus, "full", "an unverified rollback must not be reported as clean");
  assert.equal(reply.data.rolledBack, false);
  assert.ok((reply.data.orphanIds ?? []).length > 0);
  assert.equal(doc.page.children.some((c) => c.name === "Stubborn"), true, "the survivor is named, not hidden");
});

/* -------------------------------------------------------------------------- */
/* Phase 4: reconciliation and stale-result handling                             */
/* -------------------------------------------------------------------------- */

function offlineSession() {
  const s = new Session({ readyState: 1, OPEN: 1, on() {}, send() {}, close() {} });
  s.send = () => {};
  return s;
}

test("the ledger records the wire request id so a late result can rebind", () => {
  // JobRecord.requestId exists precisely so a late plugin result can find its
  // transaction. Nothing used to write it, which made the `byRequestId`
  // reconciliation fallback unreachable.
  const s = offlineSession();
  s.request("create_design", { transactionId: "txn_req", operations: [] }, 5000).catch(() => {});
  const requestId = s.requestIdFor("txn_req");
  assert.ok(requestId, "a dispatched transaction must expose its wire request id");

  const registry = new SessionRegistry();
  const job = registry.jobs.begin({ transactionId: "txn_req", tool: "create_design", session: { id: "s1", fileKey: "k", fileName: "F" }, operationCount: 3 });
  registry.jobs.update("txn_req", { requestId });
  assert.equal(registry.jobs.byRequestId(requestId)?.transactionId, "txn_req");
  assert.ok(job.attempt >= 1);
});

test("a stale late result cannot overwrite a newer attempt", () => {
  // Attempt 1 times out; the caller reconciles and re-dispatches as attempt 2;
  // attempt 2 commits. The attempt-1 frame then arrives. Applying it would
  // relabel a committed transaction as rolled-back — the one mistake that loses
  // work the user can see.
  const registry = new SessionRegistry();
  const session = { id: "s1", fileKey: "k", fileName: "F" };
  registry.jobs.begin({ transactionId: "txn_stale", tool: "create_design", session, operationCount: 10 });
  const firstAttempt = registry.jobs.get("txn_stale").attempt;

  registry.jobs.begin({ transactionId: "txn_stale", tool: "create_design", session, operationCount: 10 });
  assert.equal(registry.jobs.get("txn_stale").attempt, firstAttempt + 1);
  registry.jobs.complete("txn_stale", "committed", { done: 10 });

  const stale = registry.jobs.completeLate({
    transactionId: "txn_stale",
    attempt: firstAttempt,
    state: "rolled-back",
    extra: { label: "late rollback from attempt 1" },
  });
  assert.equal(stale.applied, false, "a frame from a superseded attempt must not be applied");
  assert.match(stale.reason, /stale/);
  assert.equal(registry.jobs.get("txn_stale").state, "committed", "the newer attempt's outcome stands");

  // A frame from the current attempt is applied normally.
  const fresh = registry.jobs.completeLate({ transactionId: "txn_stale", attempt: firstAttempt + 1, state: "partial-rollback" });
  assert.equal(fresh.applied, true);
  assert.equal(registry.jobs.get("txn_stale").state, "partial-rollback");
});

/* -------------------------------------------------------------------------- */
/* Benchmark matrix: every size must commit correctly, not just quickly         */
/* -------------------------------------------------------------------------- */

test("every benchmark size commits atomically with all nodes resolved", async () => {
  for (const size of [15, 40, 62, 100, 175]) {
    const { figma, doc } = loadPlugin();
    const ops = screen(`matrix${size}`, size);
    assert.equal(ops.length, size, `the ${size}-op workload must really be ${size} operations`);
    const before = doc.page.children.length;
    const reply = await ask(figma, "create_design", { transactionId: `txn_i15_matrix_${size}`, operations: ops }, { timeoutMs: 60000 });

    assert.equal(reply.data.status, "success", `${size} ops must commit`);
    assert.equal(reply.data.timings.operationCount, size);
    assert.equal(reply.data.unconfirmedIds, undefined, `${size} ops: every created node must resolve`);
    assert.equal(doc.page.children.length - before, 1, `${size} ops: one root frame per screen, nothing extra`);
    assertApplyIsAccountedFor(reply.data.timings, `${size} ops`);
  }
});
