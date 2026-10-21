/**
 * Issue #20, workstream 9 — the job ledger survives a *process* restart.
 *
 * The ledger already survived connection loss; a restart lost everything, and
 * a same-id retry after a restart could re-execute a committed mutation with
 * no guard at all. Persistence is opt-in (`DESIGN_AGENT_JOB_DIR`, or an
 * explicit file in the constructor), flushed atomically on every state
 * transition that matters, and honest on restore: an in-flight record an
 * unclean restart cannot vouch for is demoted to a stated unknown, never a
 * terminal verdict.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { JobLedger } from "../mcp-server/dist-test/reliability/sessions.js";

function tmpLedgerFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "figdes-jobs-"));
  return path.join(dir, "job-ledger.json");
}

const fakeSession = { id: "s_test", fileKey: null, fileName: "Fixture file" };

test("persistence is off by default; a deployment turns it on explicitly", () => {
  const plain = new JobLedger();
  assert.equal(plain.persistenceFile, null, "default must be in-memory so dev/test processes leave no durable state");
});

test("a committed record and its result survive a restart, making the same-id retry duplicate-safe", () => {
  const file = tmpLedgerFile();
  const first = new JobLedger(file);
  const rec = first.begin({ transactionId: "txn_persist", tool: "create_design", session: fakeSession, operationCount: 3 });
  assert.equal(rec.state, "queued");
  first.update("txn_persist", { state: "applying", done: 3 });
  first.complete("txn_persist", "committed", { createdIds: ["n1", "n2"] }, { status: "success", createdNodes: [{ figmaNodeId: "n1" }, { figmaNodeId: "n2" }] });

  // The file exists and parses with the versioned shape.
  assert.ok(existsSync(file));
  const raw = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.jobs[0].transactionId, "txn_persist");

  // A new process (a new ledger instance over the same file) sees the truth.
  const second = new JobLedger(file);
  const restored = second.get("txn_persist");
  assert.ok(restored, "the record is restored");
  assert.equal(restored.state, "committed");
  assert.equal(restored.attempt, 1);
  const prior = second.priorResult("txn_persist");
  assert.ok(prior && prior.status === "success", "the cached result is restored for a duplicate-safe retry");
});

test("an in-flight record restored after an unclean restart is a stated unknown, not a terminal state", () => {
  const file = tmpLedgerFile();
  const first = new JobLedger(file);
  first.begin({ transactionId: "txn_mid", tool: "create_design", session: fakeSession, operationCount: 47 });
  first.update("txn_mid", { state: "applying", done: 19 });

  const second = new JobLedger(file);
  const restored = second.get("txn_mid");
  assert.ok(restored, "the record is restored");
  // Its "applying" was true a moment before the restart; treating it as
  // committed (or as nothing) would both be guesses. The honest record is the
  // timed-out semantics: outcome unknown, reconcile before retry.
  assert.equal(restored.state, "timed-out");
  assert.match(restored.label ?? "", /restarted/);
  assert.match(restored.label ?? "", /SAME transactionId/);
});

test("evicted ids survive a restart, so 'unknown' is still distinguishable from 'never ran'", () => {
  const file = tmpLedgerFile();
  const first = new JobLedger(file);
  for (let i = 0; i < 210; i++) {
    first.begin({ transactionId: `txn_ev_${i}`, tool: "modify_design", session: fakeSession, operationCount: 1 });
  }
  assert.equal(first.wasEvicted("txn_ev_0"), true);

  const second = new JobLedger(file);
  assert.equal(second.wasEvicted("txn_ev_0"), true, "the eviction history is restored");
  assert.equal(second.get("txn_ev_0"), undefined);
});

test("a corrupt ledger file degrades to an empty ledger, never a boot failure", () => {
  const file = tmpLedgerFile();
  writeFileSync(file, "{not json", "utf8");
  const ledger = new JobLedger(file);
  assert.equal(ledger.get("anything"), undefined);
  // And the ledger still works after the bad load.
  const rec = ledger.begin({ transactionId: "txn_after_bad", tool: "create_design", session: fakeSession, operationCount: 1 });
  assert.equal(rec.state, "queued");
});
