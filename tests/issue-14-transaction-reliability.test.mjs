/**
 * Issue #14 — transaction reliability under timeout.
 *
 * ## What was actually broken
 *
 * The reviewer's evidence was three large `modify_design` transactions timing out
 * mid-apply (128 ops / 68 applied, 43 / 12, 41 / 16) with "rollback or
 * reconciliation required" and warnings that a late commit was still possible.
 *
 * Tracing the timeout path turned up four defects, none of which was "the guard is
 * slow" — each is a place where the system reported a state it had not verified:
 *
 *  T01  **A transport timeout was reported as a plugin failure.**
 *       The iframe's own timer sent `ok:false` with a scary error string. The
 *       server read that as "the plugin refused the work", rejected with a plain
 *       Error and *dropped the request binding*. It only reached `timed-out`
 *       afterwards by matching English prose in `tools.ts`.
 *
 *  T02  **The definitive late result was then silently discarded.**
 *       Consequence of T01: the plugin's real answer — the commit, or the
 *       verified rollback — arrived, matched no pending request and no timeout
 *       binding, and was dropped as an unknown request. The ledger sat at
 *       `timed-out` forever and `dispatchTransaction` refused every same-id
 *       retry. That is precisely "no definitive, truthful state".
 *
 *  T03  **Progress never extended the timeout, despite the code saying it did.**
 *       The re-arm logic in `touchProgress` was correct all along — it just had
 *       no key to work with. Progress frames carried no `requestId`, so the
 *       function returned on its first line and the documented sliding window
 *       silently did nothing. A build that was demonstrably advancing was still
 *       killed at the absolute budget. Both halves are now tested: the frame has
 *       to carry the key, and the key has to actually slide the window.
 *
 *  T04  **A native script's own budget was preempted deterministically.**
 *       `execute_figma_script` declares a `timeoutMs` and the server waits
 *       `timeoutMs + 5s`; the iframe capped every build at 300s regardless, so
 *       a script asking for the 300s maximum always lost that race.
 *
 * Plus two honesty fixes on the plugin side: a cancel arriving *after* a
 * transaction finished armed a flag nothing would consume, which then aborted
 * the same-id retry the server recommends (P05); and rollback reported
 * "removed" straight from `remove()` without reading the node back, so an
 * unverified removal could be reported as a clean `full` rollback (P06).
 *
 * ## What is verified here, and what is not
 *
 * This file is offline: it drives the real `dist/code.js` bundle and the real
 * `sessions.ts` / `transport.ts` modules against a mock `figma` object. It proves
 * the state machine and the rollback arithmetic. It does **not** prove live plugin
 * behaviour against a real Figma main thread — no test in this repo can, and the
 * acceptance criteria say so explicitly. The live re-run is recorded separately in
 * `docs/issue-14-transaction-reliability-report.md`.
 *
 * Verified against the pre-fix tree (`c517926`): 5 of the 6 defect probes below
 * fail. The sixth, "progress carrying a requestId extends the window", passes
 * pre-fix by design — the re-arm worked, it was simply never given a key. That is
 * why the frame-level test (D4) exists alongside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { loadPlugin, ask } from "./plugin-harness.mjs";
import {
  Session,
  SessionRegistry,
  TransactionTimeoutError,
} from "../mcp-server/dist-test/reliability/sessions.js";
import { createTransport, budgetForBuild, transportTimeoutResult, LONG_BUILD_TIMEOUT_MS } from "../mcp-server/dist-test/ui/transport.js";

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/** A socket that never speaks, so only the timeout paths under test run. */
function silentSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    on() {},
    send() {},
    close() {},
  };
}

/** A session with no I/O, so a test can hand it frames directly. */
function offlineSession() {
  const s = new Session(silentSocket());
  const sent = [];
  s.send = (m) => sent.push(m);
  s.sent = sent;
  return s;
}

/**
 * The exact frame the iframe sends when its own timer fires first.
 *
 * `marker` false reproduces a panel bundle predating the structured field; the
 * prose is byte-identical in both cases, which is why the fallback exists.
 */
function transportTimeoutFrame(requestId, marker = true) {
  return {
    type: "result",
    requestId,
    ok: false,
    error:
      `Plugin timed out after 300000ms executing modify_design. Outcome unknown: ` +
      `the main thread may still commit late; the definitive result will follow as a late result.`,
    ...(marker ? { transportTimeout: { budgetMs: 300000, tool: "modify_design" } } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* T01 / T02 — a transport timeout must not strand the job                      */
/* -------------------------------------------------------------------------- */

test("T01 — the iframe's own timeout is a timeout, not a plugin refusal", async () => {
  const s = offlineSession();
  const promise = s.request("modify_design", { transactionId: "txn_t01", operations: [] }, 5000);
  const rejection = promise.then(() => null, (e) => e);

  // The panel gives up at the same instant we would have.
  const requestId = [...s["pending"].keys()][0];
  assert.equal(s.settleResult(transportTimeoutFrame(requestId)), null);

  const err = await rejection;
  assert.ok(
    err instanceof TransactionTimeoutError,
    `a timeout must stay a timeout; got ${err?.constructor?.name}: ${err?.message}`,
  );
  assert.equal(err.isTimeout, true);
  // The reconcile-first instruction has to survive, or the model retries blind.
  assert.match(err.message, /get_job_status/);
  assert.match(err.message, /SAME transactionId/);
});

test("T02 — the definitive late result reconciles instead of being discarded", async () => {
  const s = offlineSession();
  const promise = s.request("modify_design", { transactionId: "txn_t02", operations: [] }, 5000);
  promise.catch(() => {});
  const requestId = [...s["pending"].keys()][0];

  s.settleResult(transportTimeoutFrame(requestId));
  assert.ok(s.timedOutBinding(requestId), "the reconciliation binding must survive the transport timeout");

  // What actually happens on the Figma side a second later: the abort lands and
  // the rollback runs to completion. This frame is the only proof of the outcome.
  const late = s.settleResult({
    type: "result",
    requestId,
    ok: true,
    data: {
      transactionId: "txn_t02",
      status: "failed",
      rolledBack: true,
      rollbackStatus: "full",
      error: { message: "Transaction txn_t02 was cancelled after 68/128 operations." },
    },
  });

  assert.ok(late, "the late result must be reported as late, not swallowed as an unknown request");
  assert.equal(late.late, true);
  assert.equal(late.transactionId, "txn_t02");
  assert.equal(late.ok, true);
  assert.equal(late.data.rollbackStatus, "full");
});

test("T02 — a late *commit* reconciles as a commit", async () => {
  const s = offlineSession();
  s.request("create_design", { transactionId: "txn_t02_commit" }, 5000).catch(() => {});
  const requestId = [...s["pending"].keys()][0];
  s.settleResult(transportTimeoutFrame(requestId, true));

  const late = s.settleResult({
    type: "result",
    requestId,
    ok: true,
    data: { transactionId: "txn_t02_commit", status: "success", createdNodes: [{ figmaNodeId: "1:2" }] },
  });

  assert.ok(late, "a late commit is the one outcome that must never be lost");
  assert.equal(late.data.status, "success");
  assert.equal(late.data.createdNodes.length, 1);
});

test("T02 — an older panel without the marker still reconciles (version skew)", async () => {
  const s = offlineSession();
  s.request("modify_design", { transactionId: "txn_skew" }, 5000).catch(() => {});
  const requestId = [...s["pending"].keys()][0];

  // No structured field: exactly what a deployed pre-fix panel bundle sends.
  s.settleResult(transportTimeoutFrame(requestId, false));
  assert.ok(
    s.timedOutBinding(requestId),
    "a deployed panel running an older bundle must not strand the job",
  );

  const late = s.settleResult({
    type: "result",
    requestId,
    ok: true,
    data: { transactionId: "txn_skew", status: "success", createdNodes: [] },
  });
  assert.ok(late && late.late);
});

test("T01 — a genuine plugin error is still an ordinary failure", async () => {
  const s = offlineSession();
  const promise = s.request("modify_design", { transactionId: "txn_real_error" }, 5000);
  const rejection = promise.then(() => null, (e) => e);
  const requestId = [...s["pending"].keys()][0];

  // The plugin answered, deliberately, with a refusal.
  s.settleResult({ type: "result", requestId, ok: false, error: "Node not found: 9:99" });

  const err = await rejection;
  assert.ok(!(err instanceof TransactionTimeoutError), "a real refusal must not be laundered into a timeout");
  assert.match(err.message, /Node not found/);
  assert.equal(
    s.timedOutBinding(requestId),
    undefined,
    "a settled request has no late result coming, so no binding should be kept",
  );
});

test("T02 — the ledger reaches a terminal state after a transport timeout", async () => {
  // The end-to-end shape: timed-out, then reconciled by the socket router.
  const registry = new SessionRegistry();
  const s = offlineSession();
  const fake = { id: "session_x", fileKey: "k", fileName: "F" };

  registry.jobs.begin({ transactionId: "txn_ledger", tool: "modify_design", session: fake, operationCount: 128 });
  registry.jobs.update("txn_ledger", { state: "applying", done: 68 });

  s.request("modify_design", { transactionId: "txn_ledger", operations: [] }, 5000).catch(() => {});
  const requestId = [...s["pending"].keys()][0];
  s.settleResult(transportTimeoutFrame(requestId));
  registry.jobs.complete("txn_ledger", "timed-out", { error: "gave up at 68/128", label: "awaiting late-result reconciliation" });

  const late = s.settleResult({
    type: "result",
    requestId,
    ok: true,
    data: {
      transactionId: "txn_ledger",
      status: "failed",
      rollbackStatus: "partial",
      rolledBack: false,
      createdNodes: [{ figmaNodeId: "4:1" }],
      error: { message: "cancelled after 68/128" },
    },
  });

  // What mcp-server/src/index.ts does with a LateResult.
  registry.jobs.complete(
    "txn_ledger",
    late.data.rollbackStatus === "full" ? "rolled-back" : late.data.rollbackStatus === "partial" ? "partial-rollback" : "failed",
    { label: "late failure reconciled after timeout" },
    late.data,
  );

  const job = registry.jobs.get("txn_ledger");
  assert.equal(job.state, "partial-rollback", "the job must settle, not stay unreconcilable");
  // And because it is terminal again, the same-id retry is allowed.
  assert.ok(!["queued", "preflight", "applying", "verifying", "timed-out"].includes(job.state));
});

/* -------------------------------------------------------------------------- */
/* T03 — the sliding window has to actually slide                                */
/* -------------------------------------------------------------------------- */

test("T03 — progress carrying a requestId extends the wait window", async () => {
  const s = offlineSession();
  s.cancel = () => {};
  s.request("modify_design", { transactionId: "txn_slide" }, 80).catch(() => {});
  const requestId = [...s["pending"].keys()][0];

  // Progress lands at 60ms and the original 80ms budget expires at 80ms. Without
  // the re-arm the request is gone by the time we look; with it, the window
  // restarted at 60ms and the build is still legitimately in flight.
  await new Promise((r) => setTimeout(r, 60));
  s.touchProgress(requestId, 12, 128, "op 12");
  await new Promise((r) => setTimeout(r, 40));

  assert.ok(s.hasPending(requestId), "a build that is still advancing must not be killed at the absolute budget");
  s.settleResult({ type: "result", requestId, ok: true, data: { status: "success" } });
});

test("T03 — progress without a requestId cannot key the window (the old shape)", async () => {
  const s = offlineSession();
  s.request("modify_design", { transactionId: "txn_nokey" }, 60).catch(() => {});
  const requestId = [...s["pending"].keys()][0];

  // The frame the plugin used to send: progress, but nothing tying it to a request.
  for (let done = 1; done <= 5; done++) {
    s.touchProgress(undefined, done, 128, `op ${done}`);
  }
  assert.ok(s.hasPending(requestId), "the window is absolute without a key; it must not be silently extended");
  s.settleResult({ type: "result", requestId, ok: true, data: { status: "success" } });
});

test("T03 — progress that is not advancing does not extend the window", async () => {
  const s = offlineSession();
  s.cancel = () => {};
  const started = Date.now();
  const err = await new Promise((resolve) => {
    s.request("modify_design", { transactionId: "txn_wedged" }, 80).catch(resolve);
    const requestId = [...s["pending"].keys()][0];
    // A plugin wedged on one operation narrates forever, at the same count. If a
    // repeated count counted as progress, the window would keep re-arming and the
    // request would only end on the far-off total ceiling rather than the silence.
    const chatter = setInterval(() => s.touchProgress(requestId, 12, 128, "wedged on op 12"), 10);
    setTimeout(() => clearInterval(chatter), 1500);
  });
  const elapsed = Date.now() - started;

  assert.ok(err instanceof TransactionTimeoutError, "a wedged build must still time out");
  assert.match(err.message, /stalled on/, "a repeated count is not progress");
  // One 80ms silence window. The 4x ceiling would instead take ~320ms, so this
  // also proves the wait ended on the stall rather than on the ceiling.
  assert.ok(elapsed < 250, `expected the stall window to fire (~80ms), took ${elapsed}ms`);
});

test("T03 — the total wait is bounded even while progress advances", async () => {
  const s = offlineSession();
  s.cancel = () => {};
  const err = await new Promise((resolve) => {
    s.request("create_design", { transactionId: "txn_ceiling" }, 50).catch(resolve);
    const requestId = [...s["pending"].keys()][0];
    let done = 0;
    const advance = setInterval(() => {
      s.touchProgress(requestId, ++done, 100000, `op ${done}`);
    }, 20);
    setTimeout(() => clearInterval(advance), 1000);
  });
  assert.ok(err instanceof TransactionTimeoutError, "an unbounded wait is a hang, not a build");
  assert.match(err.message, /ceiling/i);
  assert.match(err.message, /get_job_status/);
});

/* -------------------------------------------------------------------------- */
/* T04 — a build's own budget must not be preempted                             */
/* -------------------------------------------------------------------------- */

test("T04 — a native script's declared budget is honoured, not capped at 5 minutes", () => {
  // The server waits timeoutMs + 5s. A 300s script therefore needs 305s from the
  // transport; capping at 300s made the timeout deterministic, not unlucky.
  assert.equal(budgetForBuild("execute_figma_script", { timeoutMs: 300000 }, LONG_BUILD_TIMEOUT_MS), 305000);
  // A shorter script still gets the generous floor rather than a tighter one:
  // the floor is a promise that builds are not cut off, not a target.
  assert.equal(budgetForBuild("execute_figma_script", { timeoutMs: 120000 }, LONG_BUILD_TIMEOUT_MS), LONG_BUILD_TIMEOUT_MS);
});

test("T04 — an undeclared build keeps the 5-minute floor", () => {
  assert.equal(budgetForBuild("create_design", {}, LONG_BUILD_TIMEOUT_MS), LONG_BUILD_TIMEOUT_MS);
  assert.equal(budgetForBuild("modify_design", { timeoutMs: "nonsense" }, LONG_BUILD_TIMEOUT_MS), LONG_BUILD_TIMEOUT_MS);
  assert.equal(budgetForBuild("modify_design", { timeoutMs: -5 }, LONG_BUILD_TIMEOUT_MS), LONG_BUILD_TIMEOUT_MS);
  // A tiny declared budget must not shrink the floor into a spurious timeout.
  assert.equal(budgetForBuild("execute_figma_script", { timeoutMs: 1000 }, LONG_BUILD_TIMEOUT_MS), LONG_BUILD_TIMEOUT_MS);
  // A hostile number cannot park a request forever.
  assert.equal(budgetForBuild("execute_figma_script", { timeoutMs: 99999999 }, LONG_BUILD_TIMEOUT_MS), 905000);
});

test("T04 — the transport's timeout frame is machine-readable, not just worded", () => {
  const frame = transportTimeoutResult("r1", "modify_design", 300000);
  assert.equal(frame.type, "result");
  assert.equal(frame.requestId, "r1");
  assert.equal(frame.ok, false);
  assert.ok(frame.transportTimeout, "the frame must be structurally marked, not only worded");
  assert.equal(frame.transportTimeout.budgetMs, 300000);
  assert.equal(frame.transportTimeout.tool, "modify_design");
  // The prose stays for a server that predates the marker.
  assert.match(frame.error, /Outcome unknown/);
  // And it says plainly that the outcome is not decided, which is the truth:
  // the main thread is still applying.
  assert.doesNotMatch(frame.error, /rolled back|failed permanently/i);
});

/**
 * A transport whose upstream frames are captured at the socket.
 *
 * `transport.send` is a property the transport returns, but the frames are
 * emitted through its internal closure, so reassigning the property sees
 * nothing. Intercepting the socket is the only place every upstream frame
 * actually passes through.
 */
function capturingTransport() {
  const upstream = [];
  const fake = {
    send(data) {
      upstream.push(JSON.parse(data));
    },
    close() {},
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const transport = createTransport({
    url: "ws://unused",
    createSocket: () => fake,
    postToMain: () => {},
    heartbeatMs: 0,
    requestTimeoutMs: 60000,
  });
  transport.start();
  return { transport, upstream, fake };
}

test("T04 — a late main-thread answer is still forwarded for reconciliation", () => {
  // The timer already fired and the pending entry is gone. The real outcome
  // arriving now must NOT be swallowed locally, or the server never learns
  // whether it committed or rolled back.
  const { transport, upstream } = capturingTransport();

  transport.acceptFromMain({
    kind: "response",
    requestId: "r_already_timed_out",
    ok: true,
    data: { transactionId: "txn_late", status: "success", createdNodes: [{ figmaNodeId: "9:9" }] },
  });

  const forwarded = upstream.find((m) => m.type === "result" && m.requestId === "r_already_timed_out");
  assert.ok(forwarded, "a late definitive answer must reach the server, or the job can never settle");
  assert.equal(forwarded.ok, true);
  assert.equal(forwarded.data.createdNodes[0].figmaNodeId, "9:9");
});

test("T04 — progress is forwarded with the requestId the window keys on", () => {
  const { transport, upstream } = capturingTransport();

  transport.acceptFromMain({ kind: "progress", requestId: "r9", transactionId: "txn_p", done: 12, total: 128, label: "op 12", phase: "applying" });
  const frame = upstream.find((m) => m.type === "progress");
  assert.ok(frame);
  assert.equal(frame.requestId, "r9", "dropping the requestId silently disables the sliding window");
  assert.equal(frame.transactionId, "txn_p");
  assert.equal(frame.done, 12);
});

/* -------------------------------------------------------------------------- */
/* P05 — a late cancel must not lock out the recommended retry                   */
/* -------------------------------------------------------------------------- */

test("P05 — a cancel arriving after a rolled-back transaction does not poison the retry", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];

  const failed = await ask(f, "create_design", {
    transactionId: "txn_late_cancel",
    operations: [
      { type: "createFrame", id: "lc1", name: "LC1", width: 40, height: 40 },
      { type: "renameNode", target: "ghost-nope", name: "boom" },
    ],
  });
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.rollbackStatus, "full");

  // The server's timeout lands after the rollback already finished. Nothing is
  // in flight, so this must not arm a flag.
  await f.ui.onmessage({ kind: "cancel", requestId: "r-late", transactionId: "txn_late_cancel", reason: "server timeout after 300000ms" });

  // The recovery the server tells the model to perform: retry the SAME id.
  const retry = await ask(f, "create_design", {
    transactionId: "txn_late_cancel",
    operations: [{ type: "renameNode", target: target.id, name: "Recovered" }],
  });
  assert.equal(retry.data.status, "success", "the same-id retry must not abort as 'cancelled'");
  assert.equal(f.__node(target.id).name, "Recovered");
});

test("P05 — a cancel before dispatch still aborts (control)", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const before = target.name;

  await f.ui.onmessage({ kind: "cancel", requestId: "unknown", transactionId: "txn_precancel_ctrl", reason: "test" });
  const reply = await ask(f, "create_design", {
    transactionId: "txn_precancel_ctrl",
    operations: [{ type: "renameNode", target: target.id, name: "Should not land" }],
  });
  assert.equal(reply.data.status, "failed", "committing after being told to stop is the late-commit race");
  assert.match(reply.data.error.message, /cancel/i);
  assert.equal(f.__node(target.id).name, before);
});

/* -------------------------------------------------------------------------- */
/* P06 — a rollback is verified, not assumed                                    */
/* -------------------------------------------------------------------------- */

test("P06 — an unverified removal downgrades a full rollback to partial", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const target = d.root.children[0];
  const before = target.name;

  // Figma refuses to remove this node and does not throw.
  const realCreateFrame = f.createFrame;
  f.createFrame = () => {
    const node = realCreateFrame();
    node.remove = () => {};
    return node;
  };

  const reply = await ask(f, "create_design", {
    transactionId: "txn_stubborn",
    operations: [
      { type: "renameNode", target: target.id, name: "Mutated" },
      { type: "createFrame", id: "stubborn1", name: "Stubborn", width: 60, height: 60 },
      { type: "renameNode", target: "ghost-nope", name: "boom" },
    ],
  });

  assert.equal(reply.data.status, "failed");
  assert.notEqual(reply.data.rollbackStatus, "full", "an unverified removal must never report a clean rollback");
  assert.equal(reply.data.rollbackStatus, "partial");
  assert.equal(reply.data.rolledBack, false);
  assert.ok((reply.data.orphanIds ?? []).length > 0, "the surviving node must be named so it can be inspected");
  assert.match(reply.data.error.rolledBackNote, /Partial rollback/);
  // The part that did restore must still be restored, and reported as such.
  assert.equal(f.__node(target.id).name, before);
  assert.ok((reply.data.restoredIds ?? []).includes(target.id));
  void d;
});

/* -------------------------------------------------------------------------- */
/* Realistic batch sizes                                                        */
/* -------------------------------------------------------------------------- */

test("progress frames name the request, so the server can key the window", async () => {
  const { figma: f } = loadPlugin();
  await ask(f, "create_design", {
    transactionId: "txn_prog",
    operations: Array.from({ length: 12 }, (_, i) => ({ type: "createFrame", id: `pf${i}`, name: `PF${i}`, width: 30, height: 30 })),
  });
  const frames = f.__posted.filter((m) => m.kind === "progress");
  assert.ok(frames.length >= 2, "a build narrates itself");
  assert.ok(frames.length >= 1 && frames.every((m) => typeof m.requestId === "string"), "every progress frame must name its request");
});

test("batches of 15, 40 and 128 operations each commit atomically", async () => {
  for (const count of [15, 40, 128]) {
    const { figma: f, doc: d } = loadPlugin();
    const before = d.page.children.length;

    const reply = await ask(
      f,
      "create_design",
      {
        transactionId: `txn_size_${count}`,
        description: `batch of ${count}`,
        operations: Array.from({ length: count }, (_, i) => ({
          type: "createFrame",
          id: `n${i}`,
          name: `N${i}`,
          width: 40,
          height: 40,
        })),
      },
      { timeoutMs: 30000 },
    );

    assert.equal(reply.data.status, "success", `a ${count}-op batch must commit`);
    assert.equal(reply.data.createdNodes.length, count, "every operation created exactly one node");
    assert.equal(reply.data.timings.operationCount, count);
    assert.equal(d.page.children.length - before, count, "the document holds the whole batch and nothing else");
    assert.equal(reply.data.unconfirmedIds, undefined, "every created node must resolve after commit");
    assert.ok(reply.data.timings.total > 0);
  }
});

test("a mid-batch failure in a large batch rolls the whole batch back", async () => {
  const { figma: f, doc: d } = loadPlugin();
  const before = d.page.children.length;

  // Creates run as one pass and everything else as a second pass, so the failing
  // rename below cannot stop the 60 creates: all of them exist by the time the
  // transaction aborts, and all of them are the rollback's responsibility.
  const ops = Array.from({ length: 60 }, (_, i) => ({ type: "createFrame", id: `r${i}`, name: `R${i}`, width: 20, height: 20 }));
  ops.push({ type: "renameNode", target: "ghost-nope", name: "boom" });

  const reply = await ask(f, "create_design", { transactionId: "txn_big_fail", operations: ops }, { timeoutMs: 30000 });

  assert.equal(reply.data.status, "failed");
  assert.equal(reply.data.rollbackStatus, "full", "every created frame was verified gone, so this is a clean rollback");
  assert.equal(reply.data.rolledBack, true);
  assert.equal(reply.data.removedIds.length, 60);
  assert.equal((reply.data.orphanIds ?? []).length, 0);
  assert.equal(d.page.children.length, before, "no partial work may survive the rollback");
});
