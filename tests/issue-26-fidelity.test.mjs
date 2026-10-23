/**
 * Issue #26 — First-Pass Quality Contract: the plan-to-build fidelity gate.
 *
 * The contract demands a matrix on every change (consumer + enterprise
 * screens × layout types × connectors × overflow × spacing × typography ×
 * a11y × plan-to-build fidelity). This file holds the fidelity axis:
 *
 * 1. **Fidelity scorer units** — a faithful build passes at full marks;
 *    a missing region, a dropped connector, a wrong composition, sub-floor
 *    type, placeholder copy, failing contrast, a broken spacing rhythm,
 *    overflowing geometry, duplicated tokens, and blocking violations each
 *    fail with the exact list that names them.
 * 2. **Layout-type sweep** — every composition verifies when the build keeps
 *    it, so the gate does not silently favour one layout.
 * 3. **Release-gate wiring** — `benchmark_regression` stays advisory by
 *    default, blocks release builds when required, and is PENDING only when
 *    the baseline is missing; `runRegressionGate` feeds the release path.
 * 4. **End to end** — a representative consumer screen and a representative
 *    enterprise screen go plan → runtime → fidelity and clear the contract's
 *    acceptance thresholds (composition applied, no placeholders, connectors
 *    attached, contrast passes, type ≥ 11px).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import {
  scorePlanToBuildFidelity,
  meetsAcceptance,
  FIDELITY_ACCEPTANCE,
  FIDELITY_WEIGHTS,
} from "../mcp-server/dist-test/design/benchmark/fidelity.js";
import {
  buildReleaseGate,
  buildReleaseBuildGate,
  benchmarkRegressionForGate,
} from "../mcp-server/dist-test/design/quality/release-gate.js";
import {
  runRegressionGate,
  BASELINE_SCHEMA,
} from "../mcp-server/dist-test/design/benchmark/regression.js";
import { scoreBenchmark } from "../mcp-server/dist-test/design/benchmark/suite.js";

/* -------------------------------------------------------------------------- */
/* Synthetic builders                                                          */
/* -------------------------------------------------------------------------- */

function frameOp(id, x = 0, y = 0, w = 400, h = 200, extra = {}) {
  return { type: "createFrame", id, parent: "root", name: id, x, y, width: w, height: h, fill: [], ...extra };
}

function textOp(id, parent, content, fontSize = 12, fill = "#242521", extra = {}) {
  return { type: "createText", id, parent, name: content.slice(0, 24), content, fontSize, fill, ...extra };
}

function faithfulPlan() {
  return {
    composition: "split-view",
    regions: [
      { id: "header", composition: "editorial" },
      { id: "main", composition: "topology" },
      { id: "inspector", composition: "split-view" },
    ],
    links: [{ from: "gpu-1", to: "inf-1" }],
    canvas: { width: 1440, height: 900 },
  };
}

function faithfulBuild(overrides = {}) {
  return {
    operations: [
      { type: "createFrame", id: "root", name: "Screen", width: 1440, height: 900, fill: "#FFFFFF" },
      frameOp("header", 0, 0, 1440, 72),
      frameOp("main", 0, 72, 1040, 828),
      frameOp("inspector", 1040, 72, 400, 828),
      textOp("header-title", "header", "Cluster routing", 18),
      textOp("main-body", "main", "Shard links carry the rebalance decision", 14),
      textOp("insp-note", "inspector", "Node gpu-1 is pressured", 12, "#5A5C54"),
    ],
    composition: "split-view",
    regionCompositions: { header: "editorial", main: "topology", inspector: "split-view" },
    boxes: {
      header: { x: 0, y: 0, w: 1440, h: 72 },
      main: { x: 0, y: 72, w: 1040, h: 828 },
      inspector: { x: 1040, y: 72, w: 400, h: 828 },
    },
    connectorRoutes: [{ id: "e1", from: "gpu-1", to: "inf-1" }],
    violations: [],
    regions: [
      { id: "header", gap: 24 },
      { id: "main", gap: 24 },
      { id: "inspector", gap: 24 },
    ],
    canvas: { width: 1440, height: 900 },
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The scorer                                                                  */
/* -------------------------------------------------------------------------- */

describe("the fidelity scorer", () => {
  test("the eight weights sum to 100", () => {
    const total = Object.values(FIDELITY_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.equal(total, 100);
    assert.deepEqual(Object.keys(FIDELITY_WEIGHTS).sort(), [
      "composition", "connectors", "contrast", "geometry",
      "regions", "spacing", "tokens", "typography",
    ]);
  });

  test("a faithful build passes at full marks", () => {
    const result = scorePlanToBuildFidelity(faithfulPlan(), faithfulBuild());
    assert.equal(result.verdict, "PASS", `failures: ${result.failures.join(" | ")}`);
    assert.equal(result.score, 100);
    assert.deepEqual(result.missingRegions, []);
    assert.deepEqual(result.droppedConnectors, []);
    assert.deepEqual(result.placeholderNodes, []);
    assert.deepEqual(result.subFloorTexts, []);
    assert.deepEqual(result.contrastFailures, []);
    assert.ok(result.evidence.length >= 8, `evidence: ${result.evidence.join(" | ")}`);
    assert.equal(meetsAcceptance(result).ok, true);
  });

  test("a missing region fails and names it", () => {
    const build = faithfulBuild();
    build.operations = build.operations.filter((op) => op.id !== "inspector");
    delete build.boxes.inspector;
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.missingRegions, ["inspector"]);
    assert.ok(result.failures.some((f) => f.includes("inspector")), result.failures.join(" | "));
    assert.equal(meetsAcceptance(result).ok, false);
  });

  test("a dropped connector fails and names the planned link", () => {
    const build = faithfulBuild({ connectorRoutes: [] });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.droppedConnectors, ["gpu-1→inf-1"]);
  });

  test("a wrong composition fails instead of averaging through", () => {
    const build = faithfulBuild({ composition: "table" });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => /composition drift/.test(f)), result.failures.join(" | "));
    assert.equal(result.signals.composition, 0);
  });

  test("a drifted region composition fails even when the overall matches", () => {
    const build = faithfulBuild({ regionCompositions: { header: "editorial", main: "table", inspector: "split-view" } });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => f.includes("'main'")), result.failures.join(" | "));
  });

  test("sub-floor type fails; a documented exception passes", () => {
    const small = faithfulBuild();
    small.operations = small.operations.map((op) => (op.id === "insp-note" ? { ...op, fontSize: 10 } : op));
    const failed = scorePlanToBuildFidelity(faithfulPlan(), small);
    assert.equal(failed.verdict, "FAIL");
    assert.deepEqual(failed.subFloorTexts, ["insp-note"]);

    const exempt = faithfulBuild();
    exempt.operations = exempt.operations.map((op) =>
      op.id === "insp-note" ? { ...op, fontSize: 10, exception: { reason: "caption glyph for the status dot" } } : op,
    );
    const passed = scorePlanToBuildFidelity(faithfulPlan(), exempt);
    assert.equal(passed.verdict, "PASS", `failures: ${passed.failures.join(" | ")}`);
  });

  test("placeholder copy fails and names the node", () => {
    const build = faithfulBuild();
    build.operations = build.operations.map((op) => (op.id === "main-body" ? { ...op, content: "Lorem ipsum dolor sit amet" } : op));
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.placeholderNodes, ["main-body"]);
  });

  test("failing contrast fails and names the node", () => {
    const build = faithfulBuild();
    build.operations = build.operations.map((op) =>
      op.id === "insp-note" ? { ...op, fill: "#CCCCCC" } : op,
    );
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.deepEqual(result.contrastFailures, ["insp-note"]);
  });

  test("a broken spacing rhythm fails", () => {
    const two = faithfulBuild({ regions: [{ id: "header", gap: 24 }, { id: "main", gap: 24 }, { id: "inspector", gap: 32 }] });
    const twoResult = scorePlanToBuildFidelity(faithfulPlan(), two);
    assert.equal(twoResult.verdict, "FAIL");
    assert.ok(twoResult.failures.some((f) => /rhythm is broken/.test(f)), twoResult.failures.join(" | "));

    const three = faithfulBuild({ regions: [{ id: "header", gap: 16 }, { id: "main", gap: 24 }, { id: "inspector", gap: 32 }] });
    const threeResult = scorePlanToBuildFidelity(faithfulPlan(), three);
    assert.equal(threeResult.verdict, "FAIL");
    assert.equal(threeResult.signals.spacing, 0);
  });

  test("overflowing geometry fails and names the region", () => {
    const build = faithfulBuild({ boxes: { ...faithfulBuild().boxes, main: { x: 1400, y: 0, w: 200, h: 100 } } });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => f.includes("'main'") && /spills/.test(f)), result.failures.join(" | "));
  });

  test("blocking geometry violations fail the build", () => {
    const build = faithfulBuild({ violations: [{ rule: "containment", message: "child outside its region" }] });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => f.includes("containment")), result.failures.join(" | "));
  });

  test("a hardcoded fill duplicating a declared token fails; bound fills pass", () => {
    const dup = faithfulBuild({
      operations: [
        ...faithfulBuild().operations,
        { type: "createVariable", id: "tok-surface", name: "exo/surface", variableType: "COLOR", values: { default: "#FFFFFF" } },
      ],
    });
    const dupResult = scorePlanToBuildFidelity(faithfulPlan(), dup);
    assert.equal(dupResult.verdict, "FAIL");
    assert.ok(dupResult.failures.some((f) => /duplicates token/.test(f)), dupResult.failures.join(" | "));

    const bound = faithfulBuild({
      operations: faithfulBuild().operations.map((op) =>
        op.id === "root" ? { ...op, fill: "exo/surface" } : op,
      ).concat([
        { type: "createVariable", id: "tok-surface", name: "exo/surface", variableType: "COLOR", values: { default: "#FFFFFF" } },
        { type: "bindVariable", target: "root", field: "fills", variable: "exo/surface" },
      ]),
    });
    const boundResult = scorePlanToBuildFidelity(faithfulPlan(), bound);
    assert.equal(boundResult.signals.tokens, FIDELITY_WEIGHTS.tokens);
    assert.ok(!boundResult.failures.some((f) => /duplicates token/.test(f)), boundResult.failures.join(" | "));
  });

  test("a product-rule contradiction fails the build", () => {
    const build = faithfulBuild({ violations: [{ rule: "product", message: "noGenericCardGrid: three metric cards in a row" }] });
    const result = scorePlanToBuildFidelity(faithfulPlan(), build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => /product rule/.test(f)), result.failures.join(" | "));
  });

  test("a low score fails even when every hard list is empty", () => {
    // Genuinely weak on several soft axes at once: the floor still holds.
    const plan = {
      composition: "editorial",
      regions: [{ id: "a", composition: "editorial" }, { id: "b", composition: "editorial" }],
      links: [],
      canvas: { width: 1440, height: 900 },
    };
    const build = {
      operations: [
        { type: "createFrame", id: "root", name: "Screen", width: 1440, height: 900, fill: "#FFFFFF" },
        frameOp("a", 0, 0, 700, 900),
        frameOp("b", 740, 0, 700, 900),
        textOp("t1", "a", "First panel", 10),
        textOp("t2", "b", "Second panel", 10),
      ],
      regionCompositions: { a: "editorial", b: "editorial" },
      violations: [],
      regions: [{ id: "a", gap: 16 }, { id: "b", gap: 32 }],
      canvas: { width: 1440, height: 900 },
    };
    const result = scorePlanToBuildFidelity(plan, build);
    assert.equal(result.verdict, "FAIL");
    assert.ok(result.failures.some((f) => /acceptance floor/.test(f) || /below the 11px floor/.test(f)), result.failures.join(" | "));
  });
});

/* -------------------------------------------------------------------------- */
/* Layout-type sweep                                                           */
/* -------------------------------------------------------------------------- */

describe("the layout-type sweep", () => {
  test("every composition verifies when the build keeps it", () => {
    for (const composition of ["table", "topology", "split-view", "editorial", "instrument", "comparison"]) {
      const plan = {
        composition,
        regions: [{ id: "a", composition }, { id: "b", composition }],
        links: [],
        canvas: { width: 1440, height: 900 },
      };
      const build = {
        operations: [
          { type: "createFrame", id: "root", name: "Screen", width: 1440, height: 900, fill: "#FFFFFF" },
          frameOp("a", 0, 0, 700, 900),
          frameOp("b", 740, 0, 700, 900),
          textOp("t1", "a", `First ${composition} panel`, 12),
          textOp("t2", "b", `Second ${composition} panel`, 12),
        ],
        regionCompositions: { a: composition, b: composition },
        violations: [],
        regions: [{ id: "a", gap: 24 }, { id: "b", gap: 24 }],
        canvas: { width: 1440, height: 900 },
      };
      const result = scorePlanToBuildFidelity(plan, build);
      assert.equal(result.verdict, "PASS", `${composition}: ${result.failures.join(" | ")}`);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Release-gate wiring                                                         */
/* -------------------------------------------------------------------------- */

function baselineDoc(totals) {
  const brief = {
    screen: "Fidelity smoke",
    product: "fenek-clusters",
    purpose: "prove the regression gate feeds the release path",
    primaryDecision: "which pressured resource needs attention",
    primaryAction: "rebalance the shard",
    requiredInformation: ["shard links", "bandwidth", "drop rate", "pressure"],
    optionalInformation: [],
    desiredComposition: null,
    viewport: { width: 1440, height: 900 },
  };
  const config = { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 };
  const evidence = {
    caseId: "fidelity-smoke",
    decisionKind: "topology",
    primaryDecision: brief.primaryDecision,
    requiredInformation: brief.requiredInformation,
    optionalInformation: [],
    focalRegionId: "main",
    focalShare: 0.4,
    coverage: 0.8,
    largestEmptyBand: 0.1,
    compiledIntentFields: ["density"],
    alternatives: { candidateCount: 3, distinct: true, selectedFamily: "spatial-topology" },
    reviewFindings: 0,
    typeCriteria: { run: true, findings: 0 },
    structureStatus: "pass",
    overflowFindings: 0,
    geometryFindings: 0,
    nativeApplied: false,
  };
  const result = scoreBenchmark({ caseId: "fidelity-smoke", dimensions: totals });
  return {
    schema: BASELINE_SCHEMA,
    suite: "fidelity-test",
    recordedAt: "2026-05-14T00:00:00.000Z",
    cases: [{ caseId: "fidelity-smoke", brief, config, evidence, result }],
  };
}

const FULL = {
  hierarchy: 8, composition: 8, productSpecificity: 8, typography: 8, spacingRhythm: 8,
  relationshipClarity: 8, density: 8, nativeQuality: 8, distinctiveness: 8, readability: 8,
};

describe("the release-gate wiring", () => {
  test("benchmark_regression is advisory by default, blocking for release builds", () => {
    const base = { revisionId: "rev-fidelity", structuralFindings: [], evidence: null };
    const advisory = buildReleaseGate(base);
    const advisoryDim = advisory.dimensions.find((d) => d.dimension === "benchmark_regression");
    assert.equal(advisoryDim.status, "NOT_APPLICABLE");
    assert.equal(advisoryDim.required, false);

    const strict = buildReleaseBuildGate(base);
    const strictDim = strict.dimensions.find((d) => d.dimension === "benchmark_regression");
    assert.equal(strictDim.status, "PENDING");
    assert.equal(strictDim.required, true);
    assert.notEqual(strict.status, "PASS");
  });

  test("a release build with regressions fails; without comparison it pends", () => {
    const failing = buildReleaseBuildGate({
      revisionId: "rev-fidelity",
      structuralFindings: [],
      evidence: null,
      benchmarkRegression: { performed: true, regressions: ["fidelity-smoke"] },
    });
    assert.equal(failing.dimensions.find((d) => d.dimension === "benchmark_regression").status, "FAIL");
    assert.equal(failing.status, "FAIL");

    const pending = buildReleaseBuildGate({
      revisionId: "rev-fidelity",
      structuralFindings: [],
      evidence: null,
      benchmarkRegression: benchmarkRegressionForGate(null),
    });
    assert.equal(pending.dimensions.find((d) => d.dimension === "benchmark_regression").status, "PENDING");
  });

  test("PENDING only when the baseline is missing", () => {
    assert.equal(benchmarkRegressionForGate(null).performed, false);

    const baseline = baselineDoc(FULL);
    const candidate = [scoreBenchmark({ caseId: "fidelity-smoke", dimensions: FULL })];
    const gate = runRegressionGate({ candidate, baseline });
    assert.equal(gate.verdict, "PASS");
    const mapped = benchmarkRegressionForGate(gate);
    assert.equal(mapped.performed, true);
    assert.deepEqual(mapped.regressions, []);
    const released = buildReleaseBuildGate({
      revisionId: "rev-fidelity",
      structuralFindings: [],
      evidence: null,
      benchmarkRegression: mapped,
    });
    assert.equal(released.dimensions.find((d) => d.dimension === "benchmark_regression").status, "PASS");
  });

  test("a regressed candidate blocks the release build", () => {
    const baseline = baselineDoc(FULL);
    const worse = {
      hierarchy: 1, composition: 1, productSpecificity: 1, typography: 1, spacingRhythm: 1,
      relationshipClarity: 1, density: 1, nativeQuality: 1, distinctiveness: 1, readability: 1,
    };
    const gate = runRegressionGate({ candidate: [scoreBenchmark({ caseId: "fidelity-smoke", dimensions: worse })], baseline });
    assert.equal(gate.verdict, "REGRESSION");
    const released = buildReleaseBuildGate({
      revisionId: "rev-fidelity",
      structuralFindings: [],
      evidence: null,
      benchmarkRegression: benchmarkRegressionForGate(gate),
    });
    assert.equal(released.dimensions.find((d) => d.dimension === "benchmark_regression").status, "FAIL");
    assert.equal(released.status, "FAIL");
  });

  test("an unevaluated candidate blocks the release build instead of pending", () => {
    const baseline = baselineDoc(FULL);
    const gate = runRegressionGate({ candidate: [], baseline });
    assert.equal(gate.verdict, "NOT_EVALUATED");
    const mapped = benchmarkRegressionForGate(gate);
    assert.equal(mapped.performed, true);
    assert.ok(mapped.regressions.length > 0, "an unevaluated candidate is a blocking regression, not a pending check");
    const released = buildReleaseBuildGate({
      revisionId: "rev-fidelity",
      structuralFindings: [],
      evidence: null,
      benchmarkRegression: mapped,
    });
    assert.equal(released.dimensions.find((d) => d.dimension === "benchmark_regression").status, "FAIL");
  });
});

/* -------------------------------------------------------------------------- */
/* End to end: plan → runtime → fidelity                                       */
/* -------------------------------------------------------------------------- */

function toFidelityPlan(plan, links = []) {
  return {
    composition: plan.composition,
    regions: plan.regions.map((r) => ({ id: r.id, composition: r.composition, role: r.role })),
    links,
    canvas: { width: 1440, height: 900 },
  };
}

function toFidelityBuild(built, gap = 24) {
  return {
    operations: built.operations,
    // No global composition: the per-region path is what the build proves.
    regionCompositions: Object.fromEntries(built.ir.regions.map((r) => [r.id, r.composition])),
    boxes: built.boxes,
    connectorRoutes: built.connectorRoutes ?? [],
    violations: built.violations,
    regions: built.ir.regions.map((r) => ({ id: r.id, gap })),
    canvas: { width: 1440, height: 900 },
  };
}

function regionCopy(plan) {
  const titles = {
    navigation: "Fleet sections",
    header: "The decision, stated",
    content: "The options, compared",
    inspector: "Detail for the focus",
    footer: "Commit the decision",
    "primary-visual": "Where the strain shows",
    panel: "Evidence panel",
    status: "Status",
  };
  const bodies = {
    navigation: "Models, devices and runs stay one tap apart.",
    header: "Run this model or change models before the next window.",
    content: "Run cost against quality, with the fit check beside it.",
    inspector: "The recommended model clears the fit check with lower run cost.",
    footer: "Run the model that clears every check.",
    "primary-visual": "Pressure concentrates on one node and its links.",
    panel: "Evidence the decision needs, nothing it does not.",
    status: "Recovery is in progress on one path.",
  };
  return {
    title: (id, role) => titles[role] ?? `Evidence for ${id}`,
    body: (id, role) => bodies[role] ?? `The facts behind ${id}, stated plainly.`,
  };
}

function textContentFor(plan) {
  const copy = regionCopy(plan);
  const content = [];
  for (const region of plan.regions) {
    content.push({
      fn: "text",
      id: `${region.id}-title`,
      parent: region.id,
      args: { text: copy.title(region.id, region.role), size: 14, fill: "#242521" },
    });
    content.push({
      fn: "text",
      id: `${region.id}-body`,
      parent: region.id,
      args: { text: copy.body(region.id, region.role), size: 12, fill: "#242521" },
    });
  }
  return content;
}

function assertContract(result) {
  assert.equal(result.verdict, "PASS", `fidelity failures: ${result.failures.join(" | ")}`);
  assert.equal(meetsAcceptance(result).ok, true);
  // The contract's acceptance thresholds, each named.
  assert.equal(result.signals.composition, FIDELITY_WEIGHTS.composition, "composition applied");
  assert.deepEqual(result.missingRegions, [], "no missing regions");
  assert.deepEqual(result.placeholderNodes, [], "no placeholders");
  assert.deepEqual(result.droppedConnectors, [], "connectors attached");
  assert.deepEqual(result.subFloorTexts, [], "type at or above 11px");
  assert.deepEqual(result.contrastFailures, [], "contrast passes");
  assert.ok(result.score >= FIDELITY_ACCEPTANCE.minScore, `score ${result.score} below ${FIDELITY_ACCEPTANCE.minScore}`);
}

describe("end to end: plan → runtime → fidelity", () => {
  test("a consumer screen clears the contract", () => {
    const plan = planScreen({
      primaryDecision: "Run this model or change models",
      goal: "Compare model run cost, latency, quality and fit before choosing what to run",
      availableInformation: [
        "model name and publisher",
        "run cost per task",
        "latency p99",
        "quality verdict",
        "fit state on target device",
        "recommended last mile",
      ],
      primaryAction: "Run model",
    });
    assert.ok(plan.regions.length >= 3, `a consumer screen plans several regions, got ${plan.regions.length}`);

    const content = textContentFor(plan);
    const actionRegion = plan.regions.find((r) => r.id === "action" || r.role === "footer");
    if (actionRegion) {
      content.push({ fn: "button", id: `${actionRegion.id}-commit`, parent: actionRegion.id, args: { label: "Run model", variant: "primary" } });
    }
    const built = executeRuntime({
      canvas: plan.program.canvas,
      regions: plan.program.regions.map((r) => ({ fn: r.fn, id: r.id, args: { ...r.args, gap: 24 } })),
      content,
    });
    assert.equal(built.applicable, true, `build applicable: ${JSON.stringify(built.violations.slice(0, 3))}`);

    const result = scorePlanToBuildFidelity(toFidelityPlan(plan), toFidelityBuild(built));
    assertContract(result);
  });

  test("an enterprise screen with connectors clears the contract", () => {
    const plan = planScreen({
      primaryDecision: "Which compute node needs attention",
      goal: "Watch compute pressure across nodes and act on the node that endangers the fleet",
      availableInformation: [
        "compute nodes and their links",
        "bandwidth per link",
        "drop rate per path",
        "node pressure by resource",
        "route healthy vs struggling",
        "node traffic share",
      ],
      primaryAction: "Drain the pressured node",
    });
    const host = plan.regions.find((r) => r.role === "primary-visual") ?? plan.regions[0];
    assert.ok(host, "the enterprise screen plans a host region for the node graph");

    const content = textContentFor(plan).filter((c) => c.parent !== host.id);
    content.push(
      { fn: "deviceNode", id: "node-a", parent: host.id, args: { label: "edge-a", memory: "12 GB", compute: "41 TFLOPS" } },
      { fn: "deviceNode", id: "node-b", parent: host.id, args: { label: "edge-b", memory: "9 GB", compute: "28 TFLOPS" } },
      { fn: "deviceNode", id: "node-c", parent: host.id, args: { label: "edge-c", memory: "14 GB", compute: "52 TFLOPS" } },
      { fn: "connector", id: "e-ab", parent: host.id, args: { from: "node-a", to: "node-b", label: "8 ms" } },
      { fn: "connector", id: "e-bc", parent: host.id, args: { from: "node-b", to: "node-c", label: "41 ms" } },
    );
    const built = executeRuntime({
      canvas: plan.program.canvas,
      regions: plan.program.regions.map((r) => ({ fn: r.fn, id: r.id, args: { ...r.args, gap: 24 } })),
      content,
    });
    assert.equal(built.applicable, true, `build applicable: ${JSON.stringify(built.violations.slice(0, 3))}`);
    assert.equal(built.connectorRoutes?.length, 2, "both planned links route");

    const links = [
      { from: "node-a", to: "node-b" },
      { from: "node-b", to: "node-c" },
    ];
    const result = scorePlanToBuildFidelity(toFidelityPlan(plan, links), toFidelityBuild(built));
    assertContract(result);
  });
});
