/**
 * Issue #25 — honest verdicts for text measurement and composition.
 *
 * Two P0 fixes, both about payloads that read as passes while standing on
 * evidence they do not have:
 *
 *   1. TEXT MEASUREMENT. Text emitted by primitives (deviceNode labels,
 *      statusPills, connector labels, metrics) was never measured, a dry run
 *      without a sessionId discarded the connected plugin (guaranteeing zero
 *      measurements), and `applicabilityBasis` said "measured" when even one
 *      of N text nodes had been measured. Now the requirement is counted from
 *      the compiled `createText` operations, the measurement derives specs
 *      from those ops, "measured" means ALL text measured, and a run whose
 *      required text went unmeasured carries a fail-closed BLOCKED marker.
 *
 *   2. COMPOSITION RECEIPT. `compositionHintApplied` only meant "a hint source
 *      was found"; the runtime's applied composition was never exposed. Now
 *      design_runtime reports `appliedComposition`, the pipeline reports a
 *      full requested/selected/applied receipt, and plan_screen echoes
 *      requested vs selected vs predicted-applied.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { measureProgramText } from "../mcp-server/dist-test/runtime/measure.js";
import { runRuntimeTool } from "../mcp-server/dist-test/runtime/tools.js";
import { designPipelineTool, compositionMatches } from "../mcp-server/dist-test/pipeline/tools.js";
import { buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { mapOfflineDimensions } from "../mcp-server/dist-test/design/benchmark/regression.js";
import { scorePlanToBuildFidelity } from "../mcp-server/dist-test/design/benchmark/fidelity.js";

/**
 * A component-only program: every piece of text comes from a primitive
 * (deviceNode label/memory, statusPill) — there is not a single direct
 * `fn:"text"` call. This is the shape the live EXO topology fixture uses, the
 * one that measured zero nodes and still read as a pass.
 */
const COMPONENT_ONLY_PROGRAM = {
  canvas: { name: "EXO Topology", width: 1440, height: 900, grid: 8 },
  regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
  links: [{ from: "hub", to: "n1", label: "8us" }],
  content: [
    { fn: "deviceNode", id: "hub", parent: "map", args: { label: "hub-01", memory: "1.8 TB" } },
    { fn: "deviceNode", id: "n1", parent: "map", args: { label: "node-01" } },
    { fn: "statusPill", id: "st", parent: "map", args: { label: "1 needs attention" } },
  ],
};

/** A session whose measure_text round trip answers for every spec it is asked. */
const measuringSession = {
  async request(tool, payload) {
    assert.equal(tool, "measure_text");
    return { measurements: (payload.specs ?? []).map((s) => ({ key: s.key, width: 120, height: s.size * 1.4 })), failed: [] };
  },
};

describe("workstream 1 — text measurement honesty", () => {
  test("measureProgramText with operations measures primitive-emitted text", async () => {
    const { executeRuntime } = await import("../mcp-server/dist-test/runtime/interpreter.js");
    const firstPass = executeRuntime(COMPONENT_ONLY_PROGRAM, {});
    const textOps = firstPass.operations.filter((op) => op.type === "createText");
    assert.ok(textOps.length > 0, "the component-only program must compile to createText ops");

    const measured = await measureProgramText(measuringSession, COMPONENT_ONLY_PROGRAM, new Map(), firstPass.operations);
    assert.equal(measured.measured, textOps.length, "every emitted text op gets a measurement, keyed and sized");
    // Primitive text has no call id: the spec key falls back to parent::name,
    // which is how the preflight and the recompile can still find it.
    assert.ok(measured.metrics.has("hub::Device"), `primitive label measured: ${[...measured.metrics.keys()].join(", ")}`);
  });

  test("the three-argument contract is intact: no operations, no primitive text measured", async () => {
    const measured = await measureProgramText(measuringSession, COMPONENT_ONLY_PROGRAM, new Map());
    assert.equal(measured.measured, 0, "without operations the scan only sees direct text calls (of which there are none)");
  });

  test("a component-only dry run with a live session measures ALL its text and reports basis measured", async () => {
    const result = await runRuntimeTool(measuringSession, { program: COMPONENT_ONLY_PROGRAM, dryRun: true });
    assert.ok(result.stats.requiredTextNodes > 0, "the requirement is counted from the compiled createText ops");
    assert.equal(result.stats.measuredTextNodes, result.stats.requiredTextNodes, "every required text node was measured");
    assert.equal(result.applicabilityBasis, "measured");
    assert.equal(result.measurement.verdict, "ok");
    assert.equal(result.measurement.required, result.stats.requiredTextNodes);
    assert.equal(result.measurement.measured, result.stats.measuredTextNodes);
    assert.equal(result.acceptance, undefined, "a fully measured run is not blocked");
  });

  test("with no session and required text, the run fails closed: BLOCKED, not a quiet pass", async () => {
    const result = await runRuntimeTool(null, { program: COMPONENT_ONLY_PROGRAM, dryRun: true });
    assert.equal(result.applicabilityBasis, "estimates");
    assert.equal(result.measurement.verdict, "BLOCKED");
    assert.equal(result.acceptance, "BLOCKED");
    assert.ok(Array.isArray(result.acceptanceReasons) && result.acceptanceReasons.length > 0);
    assert.match(result.acceptanceReasons[0], /0 of 5 text nodes measured/);
    // The warning names X of Y, so a consumer reading only warnings still sees it.
    assert.match(String(result.applicabilityWarning ?? ""), /0 of 5 text nodes were measured/);
    assert.ok(
      result.warnings.some((w) => /text measurement unavailable/.test(w) && /BLOCKED/.test(w)),
      `warnings carry the block: ${JSON.stringify(result.warnings)}`,
    );
    // Honest counts ride in stats next to the legacy stat.
    assert.equal(result.stats.requiredTextNodes, 5);
    assert.equal(result.stats.measuredTextNodes, 0);
  });

  test("a partially measured run is also estimates (measured must mean ALL required text)", async () => {
    const partial = {
      async request(tool, payload) {
        // Measure only the first spec; the round trip is lossy under load.
        const specs = payload.specs ?? [];
        return { measurements: specs.slice(0, 1).map((s) => ({ key: s.key, width: 120, height: s.size * 1.4 })), failed: [] };
      },
    };
    const result = await runRuntimeTool(partial, { program: COMPONENT_ONLY_PROGRAM, dryRun: true });
    assert.equal(result.applicabilityBasis, "estimates", `basis: ${result.applicabilityBasis}`);
    assert.equal(result.acceptance, "BLOCKED");
    assert.match(String(result.applicabilityWarning ?? ""), /1 of 5 text nodes were measured/);
  });

  test("the dry-run payload exposes the runtime's applied composition", async () => {
    const result = await runRuntimeTool(null, { program: COMPONENT_ONLY_PROGRAM, dryRun: true });
    assert.equal(typeof result.appliedComposition, "string");
    assert.equal(result.appliedComposition, "topology", "a hero region declaring composition topology applies topology");
  });

  test("a program with no text at all is none-needed (no BLOCKED marker)", async () => {
    const result = await runRuntimeTool(null, {
      program: {
        canvas: { name: "Blank", width: 800, height: 600 },
        regions: [{ fn: "frame", id: "a", args: { width: 400, height: 400 } }],
      },
      dryRun: true,
    });
    assert.equal(result.applicabilityBasis, "none-needed");
    assert.equal(result.measurement.verdict, "ok");
    assert.equal(result.measurement.required, 0);
    assert.equal(result.acceptance, undefined);
  });
});

describe("workstream 2 — the composition receipt", () => {
  const BASE_BRIEF = {
    product: "fenek-clusters",
    screen: "Policy approval",
    purpose: "approve the runtime policy and its thresholds before the cluster runs it",
    primaryDecision: "approve this policy",
    primaryAction: "approve policy",
    requiredInformation: [
      "settings the policy changes",
      "approval thresholds",
      "rebalance schedule",
      "provider and model covered",
      "who approved the last change",
      "approval state",
    ],
    optionalInformation: ["change history"],
    viewport: { width: 1440, height: 900 },
  };

  test("pipeline plan mode reports requested vs selected vs applied, with evidence", async () => {
    const resp = await designPipelineTool(null, null, { brief: BASE_BRIEF, mode: "plan" });
    assert.equal(resp.status, "planned");
    const receipt = resp.compositionReceipt;
    assert.ok(receipt, "the pipeline carries a composition receipt");
    assert.equal(receipt.requested, null);
    assert.equal(typeof receipt.selected, "string");
    assert.equal(typeof receipt.applied, "string");
    assert.equal(receipt.mismatch.requested, false, "nothing was requested, so nothing mismatches");
    assert.equal(typeof receipt.evidence.hintApplied, "boolean");
    assert.ok(Array.isArray(receipt.evidence.regions) && receipt.evidence.regions.length > 0);
    for (const r of receipt.evidence.regions) {
      assert.ok(typeof r.id === "string" && typeof r.role === "string" && typeof r.composition === "string" && typeof r.layout === "string");
    }
    assert.ok(receipt.evidence.algorithms && Object.keys(receipt.evidence.algorithms).length > 0);
    // The receipt agrees with the plan's own composition decision.
    assert.equal(receipt.selected, resp.plan.composition);
  });

  test("a requested topology over list-detail/table regions is recorded as a mismatch", async () => {
    const resp = await designPipelineTool(null, null, {
      brief: { ...BASE_BRIEF, desiredComposition: "topology" },
      mode: "plan",
    });
    const receipt = resp.compositionReceipt;
    assert.equal(receipt.requested, "topology");
    assert.equal(receipt.applied, "canvas", "the shell resolved to a canvas subject over an inspector, not the topology field");
    assert.equal(receipt.mismatch.requested, true, "requested topology, applied canvas — the receipt must say so");
    assert.equal(receipt.selected, "topology");
  });

  test("a requested composition that matches the applied regions is not a mismatch", async () => {
    const resp = await designPipelineTool(null, null, {
      brief: { ...BASE_BRIEF, desiredComposition: "canvas" },
      mode: "plan",
    });
    assert.equal(resp.compositionReceipt.mismatch.requested, false);
    assert.equal(resp.compositionReceipt.mismatch.selected, false);
  });

  test("the alias helper matches the vocabulary pairs and nothing else", () => {
    assert.equal(compositionMatches("topology", "Topology"), true, "case-insensitive exact");
    assert.equal(compositionMatches("topology", "spatial"), true);
    assert.equal(compositionMatches("diagram", "topology"), true);
    assert.equal(compositionMatches("comparison", "split-view"), true);
    assert.equal(compositionMatches("split-view", "comparison"), true);
    assert.equal(compositionMatches("table", "topology"), false);
    assert.equal(compositionMatches(null, "topology"), false);
    assert.equal(compositionMatches("topology", null), false);
    assert.equal(compositionMatches("", "topology"), false);
  });

  test("plan_screen echoes requested, selected and PREDICTED applied composition", () => {
    const planned = buildPlan({
      primaryDecision: "Which device in the EXO compute topology needs attention first?",
      availableInformation: ["devices", "links", "memory pressure"],
    });
    assert.equal(planned.requestedComposition, null, "nothing requested, nothing echoed");
    assert.equal(planned.selectedComposition, planned.decision.composition, "the selected composition is the decision's");
    assert.equal(planned.predictedAppliedComposition, "topology");
    assert.ok(Array.isArray(planned.regions));

    const requested = buildPlan({
      primaryDecision: "Which device in the EXO compute topology needs attention first?",
      availableInformation: ["devices", "links", "memory pressure"],
      desiredComposition: "topology",
    });
    assert.equal(requested.requestedComposition, "topology");
    assert.equal(requested.selectedComposition, "topology");
    assert.equal(requested.predictedAppliedComposition, "topology");
  });
});

describe("downstream gates do not award credit without measurement", () => {
  test("mapOfflineDimensions: nativeQuality is null when required text was not measured", () => {
    const evidence = {
      caseId: "honesty-probe",
      decisionKind: "topology",
      primaryDecision: "which node needs attention",
      requiredInformation: ["links", "pressure"],
      optionalInformation: [],
      focalRegionId: "map",
      focalShare: 0.4,
      coverage: 0.6,
      largestEmptyBand: 0.1,
      compiledIntentFields: [],
      alternatives: null,
      reviewFindings: 0,
      typeCriteria: { run: true, findings: 0 },
      structureStatus: "pass",
      overflowFindings: 0,
      geometryFindings: 0,
      nativeApplied: false,
      textRequired: 6,
      textMeasured: 0,
    };
    const { dimensions } = mapOfflineDimensions(evidence);
    assert.equal(dimensions["nativeQuality"].score, null, "no credit for structure verified on estimates");
    assert.match(dimensions["nativeQuality"].evidence, /text measurement unavailable/);
    assert.match(dimensions["nativeQuality"].evidence, /0 of 6/);
  });

  test("mapOfflineDimensions: without measurement evidence the old scoring stands (evidence literals keep passing)", () => {
    const evidence = {
      caseId: "honesty-probe",
      decisionKind: "topology",
      primaryDecision: "which node needs attention",
      requiredInformation: [],
      optionalInformation: [],
      focalRegionId: "map",
      focalShare: 0.4,
      coverage: 0.6,
      largestEmptyBand: 0.1,
      compiledIntentFields: [],
      alternatives: null,
      reviewFindings: 0,
      typeCriteria: { run: true, findings: 0 },
      structureStatus: "pass",
      overflowFindings: 0,
      geometryFindings: 0,
      nativeApplied: false,
    };
    const { dimensions } = mapOfflineDimensions(evidence);
    assert.equal(dimensions["nativeQuality"].score, 8);
  });

  test("fidelity records unmeasured text in notVerified — never a global FAIL by itself", () => {
    const plan = {
      composition: "editorial",
      regions: [{ id: "a", composition: "editorial" }],
      canvas: { width: 1440, height: 900 },
    };
    const build = {
      operations: [{ type: "createFrame", id: "a", x: 0, y: 0, width: 400, height: 300 }],
      boxes: { a: { x: 0, y: 0, w: 400, h: 300 } },
      canvas: { width: 1440, height: 900 },
      textRequired: 4,
      textMeasured: 0,
    };
    const result = scorePlanToBuildFidelity(plan, build);
    assert.ok(
      result.notVerified.some((n) => /text measurement unavailable/.test(n) && /0 of 4/.test(n)),
      `notVerified: ${JSON.stringify(result.notVerified)}`,
    );
    assert.ok(!result.failures.some((f) => /text measurement unavailable/.test(f)), "unmeasured text is not a failure, it is an unverified item");

    const withoutReceipt = scorePlanToBuildFidelity(plan, { ...build, textRequired: undefined, textMeasured: undefined });
    assert.ok(
      !withoutReceipt.notVerified.some((n) => /text measurement unavailable/.test(n)),
      "absent receipt means not stated — no invented unverified entry",
    );
  });
});
