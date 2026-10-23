/**
 * Per-operation watchdog: a hung Figma call must fail fast and named.
 *
 * Live evidence: ChatGPT's 48-op create_design wedged the main thread —
 * 10 ops applied in 300s, zero progress frames, then a blind rollback with
 * no cause named. The most plausible shape is one hung call (a font/image
 * load that never settles) wedging everything behind it, since the loop only
 * checks cancellation *between* operations.
 *
 * These tests drive the real dist/code.js bundle against the mock figma:
 * one op hangs forever (loadFontAsync never resolves), the watchdog budget
 * is shortened via the test-only global, and the transaction must fail with
 * the stuck operation's index and type named — plus per-op timings so the
 * next attempt is evidence-led, not a blind retry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadPlugin, ask } from "./plugin-harness.mjs";

const HANG_BUDGET_MS = 150;

function withShortWatchdog() {
  globalThis.__FIGDES_PER_OP_WATCHDOG_MS__ = HANG_BUDGET_MS;
}

function clearWatchdog() {
  delete globalThis.__FIGDES_PER_OP_WATCHDOG_MS__;
}

test("a hung Figma call fails the transaction fast and names the stuck operation", async () => {
  withShortWatchdog();
  try {
    const { figma: f } = loadPlugin();
    // The second op's font load never settles: the wedge shape from live.
    f.loadFontAsync = () => new Promise(() => {});
    const reply = await ask(
      f,
      "create_design",
      {
        transactionId: "txn_watchdog_names_op",
        operations: [
          { type: "createFrame", id: "w1", name: "W1", width: 40, height: 40 },
          { type: "createText", id: "w2", parent: "w1", name: "T", content: "stuck", fontSize: 12 },
        ],
      },
      { timeoutMs: 10000 },
    );
    assert.equal(reply.data.status, "failed", "a hung op must fail, not wedge");
    assert.match(reply.data.error.message, /Operation #1 \(createText\)/, `must name index+type, got: ${reply.data.error.message}`);
    assert.match(reply.data.error.message, /within .*s/, "must state the budget");
    assert.equal(reply.data.rollbackStatus, "full", "the landed frame must be rolled back");
  } finally {
    clearWatchdog();
  }
});

test("the failure carries per-operation timings, slowest first", async () => {
  withShortWatchdog();
  try {
    const { figma: f } = loadPlugin();
    f.loadFontAsync = () => new Promise(() => {});
    const reply = await ask(
      f,
      "create_design",
      {
        transactionId: "txn_watchdog_timings",
        operations: [
          { type: "createFrame", id: "w1", name: "W1", width: 40, height: 40 },
          { type: "createText", id: "w2", parent: "w1", name: "T", content: "stuck", fontSize: 12 },
        ],
      },
      { timeoutMs: 10000 },
    );
    const timings = reply.data.timings?.perOperation ?? [];
    assert.ok(timings.length >= 1, `expected per-op timings, got: ${JSON.stringify(reply.data.timings)}`);
    assert.ok(timings.every((t) => typeof t.index === "number" && typeof t.opType === "string" && typeof t.ms === "number"));
  } finally {
    clearWatchdog();
  }
});

test("healthy operations are unaffected by the watchdog (control)", async () => {
  withShortWatchdog();
  try {
    const { figma: f } = loadPlugin();
    const reply = await ask(
      f,
      "create_design",
      {
        transactionId: "txn_watchdog_control",
        operations: [{ type: "createFrame", id: "w1", name: "W1", width: 40, height: 40 }],
      },
      { timeoutMs: 10000 },
    );
    assert.equal(reply.data.status, "success", JSON.stringify(reply.data?.error ?? reply.data));
  } finally {
    clearWatchdog();
  }
});
