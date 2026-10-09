import { test } from "node:test";
import assert from "node:assert/strict";

import { planScreen, classifyDecision } from "../mcp-server/dist-test/plan/planner.js";
import { buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { buildBrief } from "../mcp-server/dist-test/plan/brief.js";
import { classifyInformation } from "../mcp-server/dist-test/design/composition/derive.js";

/* -------------------------------------------------------------------------- */
/* Phase 1.1: user context survives from the MCP tool to the final plan        */
/* -------------------------------------------------------------------------- */

test("availableInformation raw text survives classification into the derivation", () => {
  const info = ["node latency", "link throughput", "device health", "mystery blob xyz"];
  const plan = planScreen({ primaryDecision: "show network topology of the fleet", availableInformation: info });
  assert.equal(plan.derivation.strategy, "task-derived");
  const texts = plan.derivation.information.map((i) => i.text);
  for (const item of info) assert.ok(texts.includes(item), `raw item lost: ${item}`);
  assert.ok(plan.derivation.unclassified.includes("mystery blob xyz"));
  // And the raw items survive on the plan intent itself.
  assert.deepEqual(plan.intent.availableInformation, info);
});

test("shell-fallback still records what was attempted", () => {
  const plan = planScreen({ primaryDecision: "zzzz qqq", availableInformation: ["mystery blob xyz"] });
  assert.equal(plan.derivation.strategy, "shell-fallback");
  assert.ok(plan.derivation.information.some((i) => i.text === "mystery blob xyz" && i.kind === "unknown"));
  assert.ok(plan.derivation.unclassified.includes("mystery blob xyz"));
});

test("every audience produces build-actionable guidance, not a passive label", () => {
  const audiences = ["developer", "operator", "engineer", "leadership", "general"];
  for (const audience of audiences) {
    const plan = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu", "memory"], audience });
    assert.ok(
      plan.artDirection.designRisks.some((r) => r.toLowerCase().includes(`audience is ${audience === "general" ? "general consumer" : audience}`)),
      `no active guidance for ${audience}`,
    );
  }
  // Different audiences on the same decision produce different plans.
  const op = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"], audience: "operator" });
  const lead = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"], audience: "leadership" });
  assert.notDeepEqual(op.artDirection.designRisks, lead.artDirection.designRisks);
});

test("visualDirection biases pattern matching and is recorded", () => {
  const plain = planScreen({ primaryDecision: "show network topology of the fleet", availableInformation: ["nodes", "links"] });
  const directed = planScreen({
    primaryDecision: "show network topology of the fleet",
    availableInformation: ["nodes", "links"],
    visualDirection: "calm editorial narrative",
  });
  assert.equal(directed.intent.visualDirection, "calm editorial narrative");
  assert.ok(
    directed.derivation.appliedGuidance.some((g) => g.includes("Visual direction 'calm editorial narrative'")),
    "direction influence not recorded",
  );
  void plain;
});

test("density preference sets gaps and is recorded, without reordering regions", () => {
  const low = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu", "memory"], densityPreference: "low" });
  const high = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu", "memory"], densityPreference: "high" });
  assert.deepEqual(low.regions.map((r) => r.id), high.regions.map((r) => r.id));
  assert.ok(low.regions.every((r) => r.gap === 32));
  assert.ok(high.regions.every((r) => r.gap === 12));
  assert.ok(low.derivation.appliedGuidance.some((g) => g.includes("density preference 'low'")));
});

test("buildPlan echoes user context verbatim alongside the plan", () => {
  const out = buildPlan({
    primaryDecision: "select a model",
    goal: "run inference on the edge cluster",
    audience: "engineer",
    availableInformation: ["model name", "memory", "fit state"],
    existingPatterns: ["status-rail", "inspector-rail"],
    visualDirection: "technical-instrument",
  });
  assert.deepEqual(out.context.availableInformation, ["model name", "memory", "fit state"]);
  assert.deepEqual(out.context.existingPatterns, ["status-rail", "inspector-rail"]);
  assert.equal(out.context.visualDirection, "technical-instrument");
  assert.equal(out.context.audience, "engineer");
  assert.equal(out.context.goal, "run inference on the edge cluster");
  // And the direction reaches the design context enum, not just a string.
  assert.equal(out.designContext.direction, "technical-instrument");
});

test("buildPlan maps an editorial direction onto the editorial context", () => {
  const out = buildPlan({
    primaryDecision: "compare throughput against latency",
    availableInformation: ["throughput", "latency"],
    visualDirection: "calm editorial story",
  });
  assert.equal(out.designContext.direction, "editorial-focus");
});

test("buildPlan honours artDirection density without touching structure", () => {
  const out = buildPlan({
    primaryDecision: "monitor cluster health",
    availableInformation: ["cpu", "memory", "disk"],
    artDirection: {
      visualCharacter: "dense",
      primaryFocalObject: "signal",
      density: "high",
      gridStrategy: "8px",
      spatialRhythm: "compact",
      surfaceStrategy: "layered",
      typographyHierarchy: "mono values",
      colorStrategy: "restrained",
      depthStrategy: "flat",
      interactionEmphasis: "intervention",
      compositionType: "signal dominates",
      rejectGenericDashboard: false,
    },
  });
  assert.ok(out.regions.every((r) => r.gap === 12));
});

test("design_brief accepts audience and emits raw context plus derivation", () => {
  const brief = buildBrief({
    primaryDecision: "select a model",
    goal: "run inference on the edge cluster",
    audience: "engineer",
    availableInformation: ["model name", "memory", "fit state"],
    existingPatterns: ["status-rail"],
    visualDirection: "technical-instrument",
  });
  assert.equal(brief.audience, "engineer");
  assert.deepEqual(brief.availableInformation, ["model name", "memory", "fit state"]);
  assert.deepEqual(brief.existingPatterns, ["status-rail"]);
  assert.ok(brief.derivation.information.length >= 3);
  assert.equal(brief.decision.kind, classifyDecision("select a model"));
});

test("classification is honest about unknowns", () => {
  const classified = classifyInformation(["mystery blob xyz", "cpu"]);
  assert.equal(classified.find((c) => c.text === "mystery blob xyz").kind, "unknown");
  assert.equal(classified.find((c) => c.text === "cpu").kind, "signal");
});
