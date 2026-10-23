/**
 * Issue #26 — First-Pass Quality Contract metrics + cross-run repair learning
 * + build-mismatch refusal.
 *
 * Three claims, each offline:
 *
 * 1. Counters aggregate correctly: a `verified` report with zero repairs is a
 *    first-pass acceptance; intelligence, hint and repair-verification
 *    outcomes aggregate with rates — and a refused `verified` is recorded as
 *    refused, never as accepted.
 * 2. A repair trace persisted by one run is consulted by the next:
 *    `planRepairs` refuses to plan the same failed mutation again (new
 *    diagnosis required), while an empty history plans it normally.
 * 3. Build mismatch refuses `verified`/PASS: the pipeline report withholds
 *    `verified` and the final gate withholds PASS — while `same-commit` (or an
 *    unmeasured, read-only path) still passes.
 *
 * Imports point at the standard dist-test families (built by the area
 * builds). The contract counters are read through the *pipeline* bundle,
 * which is the bundle that records them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildReport,
  resetContractCounters,
  snapshot,
} from "../mcp-server/dist-test/pipeline/report.js";
import { planRepairs } from "../mcp-server/dist-test/pipeline/repair.js";
import {
  clearRepairHistory,
  getRepairHistory,
  recordRepair,
  reloadRepairHistory,
  requiresNewDiagnosis,
  setRepairHistoryPath,
  summarizeRepairs,
} from "../mcp-server/dist-test/design/quality/repair-history.js";
import { evaluateFinalGate, verdictFor } from "../mcp-server/dist-test/design/quality/final-gate.js";
import { persistedRepairSummary } from "../mcp-server/dist-test/design/quality/release-gate.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

// All history writes in this file stay in a temp dir: recordRepair persists,
// and the repo checkout is never touched.
const SHARED_HISTORY_FILE = join(mkdtempSync(join(tmpdir(), "issue-26-")), "repair-history.jsonl");
setRepairHistoryPath(SHARED_HISTORY_FILE);
reloadRepairHistory();
clearRepairHistory();

function trace() {
  return {
    briefId: "brief_x",
    planId: "plan_x",
    stages: [],
    operations: [],
    nodeIds: [],
    checks: [],
    findings: [],
    repairs: [],
    render: null,
  };
}

function passChecks() {
  return [{ id: "c1", question: "ok?", status: "pass", detail: "measured", nodeIds: [] }];
}

/** A report input that would verify, before provenance fields are added. */
function verifiableInput() {
  return {
    planned: true,
    applied: true,
    operations: 4,
    nodeIds: ["n1"],
    transactionId: "tx-1",
    structure: { status: "pass", checks: passChecks(), detail: "structure measured" },
    live: { status: "pass", checks: passChecks(), detail: "live measured" },
    visual: { status: "pass", detail: "render reviewed", renderRevision: "rev-1" },
    repairs: [],
    findings: [],
    blocked: [],
    trace: trace(),
  };
}

function contractOf() {
  return snapshot().contract;
}

/* -------------------------------------------------------------------------- */
/* 1. Counters aggregate correctly                                              */
/* -------------------------------------------------------------------------- */

test("first-pass acceptance, intelligence, hint and repair-verification outcomes aggregate", () => {
  resetContractCounters();

  const first = buildReport({
    ...verifiableInput(),
    buildCompatibility: "same-commit",
    intelligence: { applied: true, compositionHintApplied: true },
  });
  assert.equal(first.status, "verified");

  // Built with zero repairs but not verified: a first pass that did not accept.
  const second = buildReport({
    ...verifiableInput(),
    visual: { status: "review", detail: "needs human eyes", renderRevision: "rev-1" },
    intelligence: { applied: false },
  });
  assert.equal(second.status, "built");

  // A repair was attempted, so this run is not a first pass at all — but its
  // self-verification verdict still aggregates.
  const third = buildReport({
    ...verifiableInput(),
    repairs: [{ findingId: "f1", operations: 1, result: "applied", detail: "moved the node" }],
    repairVerification: { verdict: "PASS", reason: "gone on re-measure", fixed: ["f1"], unresolved: [], regressions: [] },
  });
  assert.equal(third.status, "verified");

  const fourth = buildReport({
    ...verifiableInput(),
    visual: { status: "fail", detail: "overlap on render", renderRevision: "rev-1" },
    repairs: [{ findingId: "f2", operations: 1, result: "applied", detail: "moved the node" }],
    repairVerification: { verdict: "FAIL", reason: "still reported", fixed: [], unresolved: [], regressions: [] },
  });
  assert.equal(fourth.status, "incomplete");

  const c = contractOf();
  assert.equal(c.firstPassTotal, 2, "only applied runs with zero repairs count");
  assert.equal(c.firstPassAccepted, 1, "only the verified one accepted");
  assert.equal(c.firstPassAcceptanceRate, 0.5);
  assert.equal(c.visualQAFailures, 1);
  assert.equal(c.intelligenceTotal, 2, "only runs that disclosed provenance count");
  assert.equal(c.intelligenceAppliedCount, 1);
  assert.equal(c.intelligenceAppliedRate, 0.5);
  assert.equal(c.hintTotal, 1, "the hint rate counts runs that disclosed a hint either way");
  assert.equal(c.compositionHintAppliedCount, 1);
  assert.equal(c.hintAppliedRate, 1);
  assert.equal(c.repairVerificationPass, 1);
  assert.equal(c.repairVerificationFail, 1);
  assert.equal(c.repairVerificationPassRate, 0.5);
});

test("the repair history is surfaced in the pipeline report detail", () => {
  resetContractCounters();
  const designFinding = {
    id: "hist-1",
    ruleId: "layout.overlap",
    category: "structural",
    severity: "high",
    confidence: 0.9,
    summary: "overlap",
    rationale: "measured",
    evidence: [{ revisionId: "rev-a", reference: "n1" }],
    affectedNodeIds: ["n1"],
    verification: "re-render",
    status: "open",
  };
  const traces = [
    recordRepair({
      id: "hist-t1",
      finding: designFinding,
      revisionBefore: "rev-a",
      mutations: [{ kind: "operation", description: "move n1", targetIds: ["n1"] }],
      result: "resolved",
    }),
    recordRepair({
      id: "hist-t2",
      finding: { ...designFinding, id: "hist-2" },
      revisionBefore: "rev-a",
      mutations: [{ kind: "operation", description: "move n2", targetIds: ["n2"] }],
      result: "unchanged",
    }),
  ];
  const report = buildReport({ ...verifiableInput(), repairTraces: traces });
  assert.match(report.automaticallyRepaired.detail, /Repair history across runs: 2 trace\(s\)/);
  assert.match(report.automaticallyRepaired.detail, /1 resolved/);
  assert.equal(summarizeRepairs(traces).traces, 2);
  clearRepairHistory();
});

/* -------------------------------------------------------------------------- */
/* 2. Persisted repair traces are consulted on repeat                          */
/* -------------------------------------------------------------------------- */

test("a persisted failed trace is consulted before planning a repeat mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "repair-history-"));
  const file = join(dir, "repair-history.jsonl");
  setRepairHistoryPath(file);
  reloadRepairHistory();
  clearRepairHistory();
  try {
    const finding = {
      id: "repeat-1",
      ruleId: "layout.overlap",
      category: "structural",
      severity: "high",
      confidence: 0.9,
      summary: "node overlaps its sibling",
      rationale: "measured 12px overlap",
      evidence: [{ revisionId: "rev-a", reference: "n1" }],
      affectedNodeIds: ["n1"],
      verification: "re-render and re-measure",
      status: "open",
    };
    const mutation = { kind: "operation", description: '{"target":"n1","op":"move"}', targetIds: ["n1"] };
    recordRepair({ id: "rep-1", finding, revisionBefore: "rev-a", mutations: [mutation], result: "unchanged" });
    recordRepair({ id: "rep-2", finding, revisionBefore: "rev-b", mutations: [mutation], result: "regressed" });

    assert.ok(existsSync(file), "traces are appended to the file");
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 2, "both attempts persisted, one line each");

    reloadRepairHistory();
    assert.ok(getRepairHistory().length >= 2, "history survives a reload");
    assert.equal(requiresNewDiagnosis(getRepairHistory(), "repeat-1"), true);

    const pipelineFinding = {
      id: "repeat-1",
      stage: "live",
      severity: "high",
      confidence: 0.9,
      nodeIds: ["n1"],
      summary: "node overlaps its sibling",
      why: "measured 12px overlap",
      evidence: { kind: "geometry", detail: "12px overlap" },
      fix: "move n1",
      automatable: true,
      suggestedOperations: [{ target: "n1", op: "move" }],
    };
    const refused = planRepairs([pipelineFinding]);
    assert.equal(refused.instructions.length, 0, "the repeat is not planned");
    assert.equal(refused.skipped.length, 1);
    assert.match(refused.skipped[0].why, /new diagnosis/i);

    // The control: with no history the same finding plans normally.
    const planned = planRepairs([pipelineFinding], { history: [] });
    assert.equal(planned.instructions.length, 1);
    assert.equal(planned.skipped.length, 0);
  } finally {
    setRepairHistoryPath(SHARED_HISTORY_FILE);
    reloadRepairHistory();
    clearRepairHistory();
  }
});

test("persistedRepairSummary reports the cross-run history without changing gate inputs", () => {
  const summary = persistedRepairSummary();
  assert.ok(
    summary === null ||
      (typeof summary.traces === "number" && typeof summary.repairSuccessRate === "number"),
    "null when no history, otherwise a valid summary shape",
  );
});

/* -------------------------------------------------------------------------- */
/* 3. Build mismatch refuses verified/PASS; same-commit passes                 */
/* -------------------------------------------------------------------------- */

test("the pipeline report withholds verified on build mismatch", () => {
  resetContractCounters();

  const clean = buildReport({ ...verifiableInput(), buildCompatibility: "same-commit" });
  assert.equal(clean.status, "verified");

  const unmeasured = buildReport({ ...verifiableInput() });
  assert.equal(unmeasured.status, "verified", "read-only/offline callers omit the field and are unaffected");

  const mismatched = buildReport({ ...verifiableInput(), buildCompatibility: "different-commit" });
  assert.equal(mismatched.status, "built", "the work landed but the verdict is withheld");
  assert.match(mismatched.summary, /verified refused/);

  const untraceable = buildReport({ ...verifiableInput(), buildCompatibility: "unverifiable" });
  assert.equal(untraceable.status, "built");
  assert.match(untraceable.summary, /verified refused/);

  const c = contractOf();
  assert.equal(c.firstPassTotal, 4, "every applied zero-repair run counts");
  assert.equal(c.firstPassAccepted, 2, "refused runs are recorded as refused, never as accepted");
});

test("the final gate withholds PASS on build mismatch and stamps it on same-commit", () => {
  const scores = {
    hierarchy: 90,
    composition: 90,
    typography: 90,
    readability: 90,
    density: 90,
    distinctiveness: 90,
    genericity: 90,
    productFit: 90,
  };
  const base = {
    scores,
    visualEvidenceVerified: true,
    expectedRevision: "r1",
    evidenceRevision: "r1",
    blockingIssues: [],
    accessibility: { findings: 0, notChecked: [] },
    stamp: { pluginBuild: "abc123", transactionId: "tx-1" },
  };

  const clean = evaluateFinalGate({ ...base, buildCompatibility: "same-commit" });
  assert.equal(clean.status, "PASS");
  assert.equal(clean.verdict, "PASS");
  assert.equal(clean.gates.find((g) => g.name === "build-compatibility")?.status, "ran");

  const unmeasured = evaluateFinalGate(base);
  assert.equal(unmeasured.verdict, "PASS", "callers that never measured a live file are unaffected");
  assert.equal(unmeasured.gates.some((g) => g.name === "build-compatibility"), false);

  const mismatched = evaluateFinalGate({ ...base, buildCompatibility: "different-commit" });
  assert.equal(mismatched.status, "PASS", "the coarse status keeps its semantics");
  assert.equal(mismatched.verdict, "FAIL", "a verdict under the wrong build fails");
  assert.ok(mismatched.verdictReasons.some((r) => r.startsWith("build-compatibility:")));

  const untraceable = evaluateFinalGate({ ...base, buildCompatibility: "unverifiable" });
  assert.equal(untraceable.verdict, "BLOCKED");
  assert.ok(untraceable.verdictReasons.some((r) => r.startsWith("build-compatibility:")));
});

test("verdictFor refuses PASS on mismatch or missing stamp, even when the gates say ran", () => {
  const ran = [{ name: "everything", status: "ran", required: true, detail: "ran" }];
  assert.equal(verdictFor("PASS", ran, { compatibility: "same-commit", stamped: true }), "PASS");
  assert.equal(verdictFor("PASS", ran), "PASS", "inspection paths that omit provenance are unaffected");
  assert.equal(verdictFor("PASS", ran, { compatibility: "different-commit", stamped: true }), "FAIL");
  assert.equal(verdictFor("PASS", ran, { compatibility: "unverifiable", stamped: true }), "BLOCKED");
  assert.equal(verdictFor("PASS", ran, { compatibility: "same-commit", stamped: false }), "BLOCKED");
  assert.equal(verdictFor("FAIL", ran, { compatibility: "same-commit", stamped: true }), "FAIL");
});
