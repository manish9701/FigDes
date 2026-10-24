/**
 * Issue #24 — mandatory design-intelligence gate.
 *
 * What is under test is a sentence about honesty: every build path must say
 * whether design intelligence ran on it. A raw program (no plan_screen plan,
 * no declared visualIntent.style), raw IR, or any path that skips decision
 * classification and composition hints must disclose `intelligence.applied:
 * false` with a warning naming the fix — while the product guard still runs
 * unconditionally. The intelligence paths (plan_screen output, declared
 * style, the pipeline) must carry `applied: true` with provenance.
 *
 * All fixtures are offline: no Figma, no render. Imports point at the
 * standard dist-test families (built by `npm run build:test`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assessIRIntelligence,
  assessRuntimeIntelligence,
} from "../mcp-server/dist-test/design/intelligence-gate.js";
import { buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { registerPlan, resetPlanRegistry } from "../mcp-server/dist-test/plan/registry.js";
import { compileIrTool, runRuntimeTool } from "../mcp-server/dist-test/runtime/tools.js";
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";

/* -------------------------------------------------------------------------- */
/* 1. The gate itself: bypass is disclosed, intelligence passes                 */
/* -------------------------------------------------------------------------- */

test("a raw program with no plan and no style is disclosed as bypassed", () => {
  const assessment = assessRuntimeIntelligence({ regions: [], content: [] });
  assert.equal(assessment.applied, false);
  assert.equal(assessment.basis, "auto-art-direction");
  assert.equal(assessment.warnings.length, 1);
  assert.match(assessment.warnings[0], /plan_screen/, "the warning names the mandatory first step");
  assert.match(assessment.warnings[0], /design_pipeline/, "the warning names the whole-loop alternative");
});

test("the bypass warning names the fallback style when one applied", () => {
  const assessment = assessRuntimeIntelligence({ regions: [] }, { autoStyle: "calm-technical" });
  assert.equal(assessment.applied, false);
  assert.match(assessment.warnings[0], /calm-technical/);
  assert.match(assessment.detail, /calm-technical/);
});

test("a plan-carrying program passes the gate", () => {
  // Issue #29: a plan counts when it is plan-shaped — a real plan_screen
  // payload carries the `program` skeleton and the `intelligence` receipt.
  const assessment = assessRuntimeIntelligence({
    plan: { program: {}, intelligence: { applied: true, basis: "plan-screen" } },
    regions: [],
  });
  assert.equal(assessment.applied, true);
  assert.equal(assessment.basis, "plan");
  assert.deepEqual(assessment.warnings, []);
});

test("an invented inline plan no longer passes the gate (issue #29)", () => {
  // A bare object is what a model improvises when it skipped plan_screen.
  const assessment = assessRuntimeIntelligence({ plan: { decision: "show status" }, regions: [] });
  assert.equal(assessment.applied, false);
  assert.equal(assessment.basis, "auto-art-direction");
});

test("an unresolvable planId no longer passes the gate (issue #29)", () => {
  const assessment = assessRuntimeIntelligence({ planId: "plan-not-issued", regions: [] });
  assert.equal(assessment.applied, false);
});

test("a registered planId passes the gate (issue #29)", () => {
  resetPlanRegistry();
  const { planId } = registerPlan({ fileKey: "k1", primaryDecision: "select a model", program: {} });
  const assessment = assessRuntimeIntelligence({ planId, regions: [] }, { fileKey: "k1" });
  assert.equal(assessment.applied, true);
  assert.equal(assessment.basis, "plan");
  resetPlanRegistry();
});

test("a declared visualIntent.style passes the gate", () => {
  const assessment = assessRuntimeIntelligence({ visualIntent: { style: "quiet-instrument" }, regions: [] });
  assert.equal(assessment.applied, true);
  assert.equal(assessment.basis, "visual-intent");
  assert.deepEqual(assessment.warnings, []);
});

test("raw IR is disclosed with the none basis; a styled IR passes", () => {
  const raw = assessIRIntelligence({ canvas: {}, regions: [] });
  assert.equal(raw.applied, false);
  assert.equal(raw.basis, "none");
  assert.equal(raw.warnings.length, 1);
  assert.match(raw.warnings[0], /plan_screen/);

  const styled = assessIRIntelligence({ visualIntent: { style: "quiet-instrument" }, regions: [] });
  assert.equal(styled.applied, true);
  assert.equal(styled.basis, "visual-intent");
  assert.deepEqual(styled.warnings, []);
});

/* -------------------------------------------------------------------------- */
/* 2. plan_screen: classification + composition hint are proven in-payload      */
/* -------------------------------------------------------------------------- */

test("plan_screen proves classifyDecision ran: decision kinds follow the decision", () => {
  const select = buildPlan({ primaryDecision: "select a model", availableInformation: ["latency", "memory"] });
  assert.equal(select.intelligence.applied, true);
  assert.equal(select.intelligence.basis, "plan-screen");
  assert.equal(select.intelligence.decisionKind, "select");
  assert.equal(select.decision.kind, "select");

  const monitor = buildPlan({ primaryDecision: "monitor cluster health", availableInformation: ["cpu", "memory"] });
  assert.equal(monitor.intelligence.decisionKind, "monitor");
  assert.equal(monitor.decision.kind, "monitor");
});

test("plan_screen proves the composition hint ran when the direction states one", () => {
  const hinted = buildPlan({
    primaryDecision: "monitor cluster health",
    availableInformation: ["cpu"],
    visualDirection: "asymmetric spatial field",
  });
  assert.equal(hinted.intelligence.compositionHintApplied, true);
  assert.match(hinted.intelligence.compositionHintWhy ?? "", /asymmetric spatial field/);

  const plain = buildPlan({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"] });
  assert.equal(plain.intelligence.applied, true);
  assert.equal(plain.intelligence.compositionHintApplied, false);
});

/* -------------------------------------------------------------------------- */
/* 3. design_runtime: bypass disclosed, guard + basis unavoidable               */
/* -------------------------------------------------------------------------- */

const RAW_PROGRAM = {
  canvas: { name: "Gate", width: 1440, height: 900 },
  regions: [{ fn: "frame", id: "body", args: { width: "fill", height: "fill" } }],
  content: [{ fn: "text", id: "t1", parent: "body", args: { text: "throughput now", role: "label" } }],
};

test("design_runtime dry-run discloses the bypass but still guards and labels the basis", async () => {
  const result = await runRuntimeTool(null, { program: RAW_PROGRAM, dryRun: true });
  assert.equal(result.intelligence.applied, false, "a raw program must not claim intelligence");
  assert.equal(result.intelligence.basis, "auto-art-direction");
  assert.ok(
    result.warnings.some((w) => /plan_screen/.test(w)),
    `the bypass warning must travel with the payload: ${JSON.stringify(result.warnings)}`,
  );
  // The guard is unavoidable even on the bypass path.
  assert.ok(result.productGuard, "the product guard verdict travels with every build");
  assert.ok(result.productGuard.rulesChecked > 0, "the guard actually ran");
  assert.equal(typeof result.productGuard.verdict, "string");
  // The geometry basis is disclosed even when the decisions are not.
  assert.equal(typeof result.applicabilityBasis, "string");
});

test("design_runtime with a plan_screen program passes the gate with no bypass warning", async () => {
  const planned = buildPlan({
    primaryDecision: "select a model",
    availableInformation: ["latency", "memory"],
    visualDirection: "quiet-instrument",
  });
  const result = await runRuntimeTool(null, { program: planned.program, dryRun: true });
  assert.equal(result.intelligence.applied, true);
  assert.equal(result.intelligence.basis, "visual-intent");
  assert.equal(
    result.warnings.some((w) => /Design intelligence bypassed/.test(w)),
    false,
    "the intelligence path must not carry the bypass warning",
  );
  assert.ok(result.productGuard.rulesChecked > 0, "the guard runs on the intelligence path too");
});

/* -------------------------------------------------------------------------- */
/* 4. compile_ir: the direct-compile bypass is disclosed and guarded            */
/* -------------------------------------------------------------------------- */

const RAW_IR = {
  canvas: { name: "Gate", width: 1440, height: 900 },
  regions: [{ id: "body", role: "content", composition: "instrument", width: "fill", height: "fill", grow: 1, children: [] }],
  content: [],
};

test("compile_ir discloses the bypass and still runs the product guard", () => {
  const result = compileIrTool({ ir: RAW_IR });
  assert.equal(result.intelligence.applied, false);
  assert.equal(result.intelligence.basis, "none");
  assert.ok(
    result.warnings.some((w) => /plan_screen/.test(w)),
    `the bypass warning must travel with the payload: ${JSON.stringify(result.warnings)}`,
  );
  assert.ok(result.productGuard, "the product guard runs on the direct-compile path too");
  assert.ok(result.productGuard.rulesChecked > 0, "the guard actually ran");
});

test("compile_ir with a declared style passes the gate", () => {
  const result = compileIrTool({ ir: { ...RAW_IR, visualIntent: { style: "quiet-instrument" } } });
  assert.equal(result.intelligence.applied, true);
  assert.equal(result.intelligence.basis, "visual-intent");
  assert.deepEqual(result.warnings, []);
});

/* -------------------------------------------------------------------------- */
/* 5. design_pipeline: the enforced-intelligence path carries applied:true      */
/* -------------------------------------------------------------------------- */

test("design_pipeline plan-mode carries intelligence-applied:true with its skills", async () => {
  const result = await designPipelineTool(null, null, {
    brief: {
      screen: "Fleet overview",
      purpose: "See cluster health and decide where to intervene",
      primaryDecision: "monitor fleet health and decide where to intervene",
    },
    mode: "plan",
  });
  assert.equal(result.intelligence.applied, true);
  assert.equal(result.intelligence.basis, "design-pipeline");
  assert.ok(Array.isArray(result.intelligence.skillsSelected), "the skills that ran are named");
  assert.ok(result.visualIntelligence, "the full skill output still travels with the payload");
  assert.ok(result.structure, "the structural verification still travels with the payload");
});
