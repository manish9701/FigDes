/**
 * Issue #23 — EXO regression fixtures + the truthful final gate.
 *
 * Three things are pinned here, offline and deterministically:
 *
 *  (A) the regression fixtures load as NEW versioned arrays while every
 *      frozen list keeps its pinned length (OFFLINE_BRIEFS 9, BENCHMARKS 9,
 *      EXPANDED_BENCHMARKS 8), each fixture carries a full reproducible brief,
 *      and together the five fixtures cover all eight canonical failure
 *      classes;
 *  (B) every failure class a fixture targets is actually detected through the
 *      mechanism that reports it — `executeRuntime` violation rules,
 *      `auditTypeCriteria`, `evaluateAccessibility`, and (for the disclosure
 *      policy stage owned by another workstream) the final gate's
 *      caller-enumerated gate records;
 *  (C) `evaluateFinalGate` keeps its pinned `status` semantics exactly and
 *      gains `verdict` (PASS | FAIL | BLOCKED), `gates` and `stamp`: a
 *      required gate that was skipped or never evaluated can never PASS, a
 *      gate that ran and found a blocker makes the verdict FAIL, and an
 *      unstamped verdict cannot PASS.
 *
 * Modules changed by this issue are bundled fresh into
 * `mcp-server/dist-test/`; the files owned by the other issue #23
 * workstreams (type criteria, accessibility) are imported from the standard
 * dist-test paths, like every other test does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  OFFLINE_BRIEFS,
  OFFLINE_VIEWPORT,
  EXO_REGRESSION_FAILURE_CLASSES,
  EXO_REGRESSION_BRIEFS,
  EXO_REGRESSION_FIXTURES,
  EXO_REGRESSION_NEGATIVE_CONTROL_ID,
} from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";
import {
  BENCHMARKS,
  EXPANDED_BENCHMARKS,
  EXO_REGRESSION_SUITE_VERSION,
  EXO_REGRESSION_CASES,
} from "../mcp-server/dist-test/design/benchmark/suite.js";
import {
  evaluateFinalGate,
  REQUIRED_GATES,
} from "../mcp-server/dist-test/design/quality/final-gate.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { auditTypeCriteria, MIN_LABEL_PX } from "../mcp-server/dist-test/design/quality/type-criteria.js";
import { evaluateAccessibility, CONTRAST_MIN_NORMAL } from "../mcp-server/dist-test/design/quality/accessibility.js";
import { SERVER_BUILD } from "../mcp-server/dist-test/shared/protocol.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/* -------------------------------------------------------------------------- */
/* Programs: the failure classes, run through the real runtime                  */
/* -------------------------------------------------------------------------- */

const CANVAS = { name: "T", width: 1440, height: 900 };

/** One content id declared under the same region twice → identity violation. */
const duplicateIdsProgram = {
  canvas: CANVAS,
  regions: [{ fn: "inspector", id: "table", args: { width: 640, height: "fill" } }],
  content: [
    { fn: "text", id: "row-7", parent: "table", args: { text: "GPU pressure 84%" } },
    { fn: "text", id: "row-7", parent: "table", args: { text: "GPU pressure 88%" } },
  ],
};

/** Distinct ids, same shape: the constructive counterpart must stay clean. */
const uniqueIdsProgram = {
  canvas: CANVAS,
  regions: [{ fn: "inspector", id: "table", args: { width: 640, height: "fill" } }],
  content: [
    { fn: "text", id: "row-7", parent: "table", args: { text: "GPU pressure 84%" } },
    { fn: "text", id: "row-8", parent: "table", args: { text: "GPU pressure 88%" } },
  ],
};

/** One nav item claimed by a second region → identity violation (exactly one). */
const twoParentsProgram = {
  canvas: CANVAS,
  regions: [
    { fn: "navigation", id: "nav", args: { width: 220, height: "fill" } },
    { fn: "inspector", id: "config", args: { width: 320, height: "fill" } },
  ],
  content: [
    { fn: "navItem", id: "shared-item", args: { label: "Assignments" } },
    { fn: "navItem", id: "shared-item", parent: "config", args: { label: "Assignments" } },
  ],
};

/** An instance wider than its overflow-forbidden region → containment. */
const wideInstanceProgram = {
  canvas: CANVAS,
  regions: [
    { fn: "navigation", id: "nav", args: { width: 220, height: "fill" } },
    { fn: "stage", id: "map", args: { width: "fill", height: "fill" } },
    { fn: "inspector", id: "inspector", args: { width: 320, height: "fill" } },
  ],
  content: [
    { fn: "instance", id: "wide-widget", parent: "inspector", args: { componentId: "fit-gauge", width: 600, height: 120 } },
    { fn: "text", id: "t1", parent: "inspector", args: { text: "Fit verdict" } },
  ],
};

/** Text whose maxWidth sits under the floor → one consistent width, no drift. */
const narrowTextProgram = {
  canvas: CANVAS,
  regions: [{ fn: "inspector", id: "table", args: { width: 640, height: "fill", padding: 16 } }],
  content: [{ fn: "text", id: "col-note", parent: "table", args: { text: "fail", maxWidth: 30 } }],
};

/** A connector to a node that was never declared → connector violation. */
const danglingConnectorProgram = {
  canvas: CANVAS,
  regions: [{ fn: "stage", id: "map", args: { width: "fill", height: "fill", layout: "cluster" } }],
  content: [
    { fn: "deviceNode", id: "node-a", parent: "map", args: { label: "node-a", health: "healthy" } },
    { fn: "deviceNode", id: "node-b", parent: "map", args: { label: "node-b", health: "degraded" } },
    { fn: "connector", id: "link-1", parent: "map", args: { from: "node-a", to: "node-b", label: "24us" } },
    { fn: "connector", id: "bad-link", parent: "map", args: { from: "node-a", to: "ghost-node" } },
  ],
};

/** Same topology without the dangling endpoint: the positive control. */
const healthyTopologyProgram = {
  canvas: CANVAS,
  regions: [{ fn: "stage", id: "map", args: { width: "fill", height: "fill", layout: "cluster" } }],
  content: [
    { fn: "deviceNode", id: "node-a", parent: "map", args: { label: "node-a", health: "healthy" } },
    { fn: "deviceNode", id: "node-b", parent: "map", args: { label: "node-b", health: "degraded" } },
    // Owns the plain line: a cluster stacks its nodes 8px apart, closer than
    // arrowheads need, so the default heads would be omitted with an advisory.
    // arrowEnd:false declares the headless edge deliberate, keeping this
    // fixture violation-free.
    { fn: "connector", id: "link-1", parent: "map", args: { from: "node-a", to: "node-b", label: "24us", arrowEnd: false } },
  ],
};

const violationSummary = (result) =>
  result.violations.map((v) => `[${v.rule}] ${v.message}`).join("; ");

/* -------------------------------------------------------------------------- */
/* Detectors: one per canonical failure class, asserting real detection         */
/* -------------------------------------------------------------------------- */

const GOOD_INPUT = {
  scores: { hierarchy: 88, composition: 85, typography: 82, readability: 88, density: 80, distinctiveness: 76, genericity: 85, productFit: 88 },
  blockingIssues: [],
  visualEvidenceVerified: true,
  states: { declared: 2 },
  accessibility: { findings: 0, notChecked: [] },
  stamp: { pluginBuild: "abc123-example", transactionId: "tx-42" },
};

const DETECTORS = {
  "duplicate-content-or-component-ids": () => {
    const result = executeRuntime(duplicateIdsProgram);
    const hit = result.violations.find((v) => v.rule === "identity" && v.message.includes("declared 2 times"));
    assert.ok(hit, `a content id declared twice must surface as an identity violation, got: ${violationSummary(result)}`);
    // And the same ids, declared once each, must stay clean.
    const clean = executeRuntime(uniqueIdsProgram);
    assert.deepEqual(clean.violations.filter((v) => v.rule === "identity"), [], "unique ids never trip identity: " + violationSummary(clean));
  },

  "node-assigned-to-two-parents": () => {
    const result = executeRuntime(twoParentsProgram);
    const hit = result.violations.find((v) => v.rule === "identity" && v.message.includes("exactly one parent"));
    assert.ok(hit, `a node claimed by two regions must surface as an identity violation, got: ${violationSummary(result)}`);
  },

  "child-outside-overflow-forbidden-region": () => {
    const result = executeRuntime(wideInstanceProgram);
    const hit = result.violations.find((v) => v.rule === "containment");
    assert.ok(hit, `an instance wider than its region must surface as a containment violation, got: ${violationSummary(result)}`);
  },

  "text-emitted-width-vs-resolved-bounds": () => {
    // Since the text-width unification, emitted and resolved widths share one
    // formula (`textEmittedWidth`), so the contradiction can no longer ship —
    // a path that skips resolution now blocks as `text-bounds`. The detector
    // pins the positive control: a maxWidth under the floor emits at the floor,
    // with no operation-trace drift and no emitted/resolved disagreement.
    const result = executeRuntime(narrowTextProgram);
    assert.ok(
      !result.violations.some((v) => v.rule === "operation-trace" && v.message.includes("resolved box")),
      `emitted text width must agree with the resolved box (one formula), got: ${violationSummary(result)}`,
    );
    const op = result.operations.find((o) => o.id === "col-note");
    assert.ok(op, "the text op is emitted");
    assert.equal(op.width, 40, "a maxWidth under the floor emits at the floor, matching the resolved box");
  },

  "connector-endpoints-not-aligned": () => {
    const result = executeRuntime(danglingConnectorProgram);
    const hit = result.violations.find((v) => v.rule === "connector" && v.message.includes("ghost-node"));
    assert.ok(hit, `a connector to an undeclared node must surface as a connector violation, got: ${violationSummary(result)}`);
  },

  "sub-11px-technical-labels": () => {
    assert.equal(MIN_LABEL_PX, 11, "the type floor itself is pinned at 11px");
    const audit = auditTypeCriteria({
      ops: [
        { type: "createText", id: "tiny", content: "GPU memory pressure", fontSize: 9 },
        { type: "createText", id: "ok", content: "Shard pressure ok", fontSize: 12 },
      ],
    });
    const finding = audit.findings.find((f) => f.rule === "type.space.readable-labels");
    assert.ok(finding, `labels under ${MIN_LABEL_PX}px must surface in the type audit, got: ${JSON.stringify(audit.findings)}`);
    assert.ok(["critical", "high", "medium", "low", "info"].includes(finding.severity), `canonical severity, got: ${finding.severity}`);
  },

  "sub-wcag-aa-contrast": () => {
    assert.equal(CONTRAST_MIN_NORMAL, 4.5, "the AA normal-text threshold itself is pinned");
    const report = evaluateAccessibility({
      revisionId: "issue23-exo-regression",
      texts: [
        { id: "dim-label", content: "Node pressure 84%", size: 12, contrastRatio: 2.9 },
        { id: "ok-label", content: "Node pressure 12%", size: 12, contrastRatio: 7.2 },
      ],
    });
    const finding = report.findings.find((f) => f.ruleId === "a11y.text-contrast");
    assert.ok(finding, `contrast ${2.9} under ${CONTRAST_MIN_NORMAL} must surface as an accessibility finding, got: ${JSON.stringify(report.findings)}`);
    // Severity vocabulary is canonical (finding.ts); the exact level is the
    // accessibility workstream's calibrated call, not a fixture to pin here.
    assert.ok(["critical", "high", "medium", "low", "info"].includes(finding.severity), `canonical severity, got: ${finding.severity}`);
  },

  "repeated-illustrative-sample-disclosures": () => {
    // The disclosure policy lives in another workstream's module; what this
    // gate owns is the mechanism that makes its stage truthful: a
    // caller-supplied gate record wins by name and can never be PASSd away.
    const failed = evaluateFinalGate({
      ...GOOD_INPUT,
      gates: [{ name: "sample-content-disclosure", status: "failed", required: true, detail: "3 illustrative sample disclosures repeated after user content" }],
    });
    const record = failed.gates.find((g) => g.name === "sample-content-disclosure");
    assert.ok(record, "the disclosure gate record must be enumerable in the report");
    assert.equal(record.status, "failed");
    assert.equal(record.required, true);
    assert.equal(failed.verdict, "FAIL");
    assert.ok(failed.verdictReasons.some((r) => r.startsWith("sample-content-disclosure")), failed.verdictReasons.join(" | "));

    const neverRan = evaluateFinalGate({
      ...GOOD_INPUT,
      gates: [{ name: "sample-content-disclosure", status: "notEvaluated", required: true, detail: "the policy module was not wired into this run" }],
    });
    assert.equal(neverRan.verdict, "BLOCKED", "a disclosure stage that never ran can never PASS the verdict");
  },
};

/* -------------------------------------------------------------------------- */
/* (A) fixtures load; frozen lists stay frozen; coverage is complete            */
/* -------------------------------------------------------------------------- */

test("issue 23 fixtures load as new versioned arrays with the frozen lists untouched", () => {
  // New fixture set: four new briefs plus the referenced negative control.
  assert.equal(EXO_REGRESSION_FIXTURES.length, 5);
  const ids = EXO_REGRESSION_FIXTURES.map((f) => f.caseId);
  assert.deepEqual(ids, [
    "exo-regression-topology",
    "exo-regression-model-selection",
    "exo-regression-dense-table",
    "exo-regression-empty-error",
    EXO_REGRESSION_NEGATIVE_CONTROL_ID,
  ]);

  // The negative control is the v1 OBJECT by reference — never duplicated.
  const control = EXO_REGRESSION_FIXTURES.find((f) => f.caseId === EXO_REGRESSION_NEGATIVE_CONTROL_ID);
  const v1Control = OFFLINE_BRIEFS.find((b) => b.caseId === EXO_REGRESSION_NEGATIVE_CONTROL_ID);
  assert.ok(v1Control, "the v1 list still carries its negative control");
  assert.ok(control, "the fixture set references the v1 negative control");
  assert.equal(control.brief, v1Control.brief, "the control brief is the v1 brief object itself, not a copy");
  assert.deepEqual(control.failureTargets, []);

  // The four new briefs are genuinely NEW: no id reuse from the frozen v1 list.
  assert.equal(EXO_REGRESSION_BRIEFS.length, 4);
  for (const fixture of EXO_REGRESSION_BRIEFS) {
    assert.ok(!OFFLINE_BRIEFS.some((b) => b.caseId === fixture.caseId), `${fixture.caseId}: must not collide with a v1 case id`);
  }

  // Every fixture brief is a full brief the pipeline can plan from.
  for (const fixture of EXO_REGRESSION_FIXTURES) {
    for (const field of ["product", "screen", "purpose", "primaryDecision", "primaryAction"]) {
      assert.ok(fixture.brief[field] && fixture.brief[field].length > 0, `${fixture.caseId}: brief.${field} is non-empty`);
    }
    assert.ok(fixture.brief.requiredInformation.length >= 4, `${fixture.caseId}: at least four required information items`);
    assert.deepEqual(fixture.brief.viewport, OFFLINE_VIEWPORT, `${fixture.caseId}: offline viewport`);
    if (fixture.brief.optionalInformation !== undefined) assert.ok(Array.isArray(fixture.brief.optionalInformation));
  }

  // Failure targets reference only canonical classes, at least one per fixture…
  assert.equal(EXO_REGRESSION_FAILURE_CLASSES.length, 8);
  assert.equal(new Set(EXO_REGRESSION_FAILURE_CLASSES).size, 8, "canonical class names are distinct");
  for (const fixture of EXO_REGRESSION_FIXTURES) {
    if (fixture.caseId === EXO_REGRESSION_NEGATIVE_CONTROL_ID) continue; // the control has none by design
    assert.ok(fixture.failureTargets.length > 0, `${fixture.caseId}: regression targets declared`);
    for (const target of fixture.failureTargets) {
      assert.ok(EXO_REGRESSION_FAILURE_CLASSES.includes(target), `${fixture.caseId}: target '${target}' is a canonical class`);
    }
  }

  // …and together the fixture set covers all eight classes.
  const targeted = new Set(EXO_REGRESSION_FIXTURES.flatMap((f) => f.failureTargets));
  assert.deepEqual(
    [...EXO_REGRESSION_FAILURE_CLASSES].sort(),
    [...targeted].sort(),
    "the fixture set must cover every canonical failure class",
  );

  // The frozen lists keep their pinned lengths — regression data appended nowhere.
  assert.equal(OFFLINE_BRIEFS.length, 9);
  assert.equal(BENCHMARKS.length, 9);
  assert.equal(EXPANDED_BENCHMARKS.length, 8);

  // The suite carries the regression cases under its own version, in fixture order.
  assert.equal(EXO_REGRESSION_SUITE_VERSION, "benchmark-exo-regressions-v1");
  assert.deepEqual(EXO_REGRESSION_CASES.map((c) => c.id), ids);
  assert.deepEqual(
    EXO_REGRESSION_CASES.map((c) => [c.id, c.decisionKind, c.patternId]),
    [
      ["exo-regression-topology", "topology", "spatial-topology"],
      ["exo-regression-model-selection", "configure", "configuration-workbench"],
      ["exo-regression-dense-table", "explore", "exploration-surface"],
      ["exo-regression-empty-error", "monitor", "monitoring-instrument"],
      ["generic-saas-dashboard", "monitor", "monitoring-instrument"],
    ],
  );

  // The artifact runner falls back to these briefs for unknown case ids, so
  // the new cases are runnable from the library with no scripted copy.
  const script = readFileSync(join(repoRoot, "scripts", "run-design-benchmark.mjs"), "utf8");
  assert.ok(script.includes("taskByCase[benchmark.id] ?? benchmark.brief"), "the runner falls back to the suite brief for unknown ids");
  assert.ok(script.includes("informationByCase[benchmark.id] ?? []"), "the runner falls back to no information for unknown ids");
});

/* -------------------------------------------------------------------------- */
/* (B) every targeted failure class is detected through its real mechanism      */
/* -------------------------------------------------------------------------- */

test("constructive counterparts stay clean: healthy connector endpoints resolve through real boxes", () => {
  const result = executeRuntime(healthyTopologyProgram);
  assert.deepEqual(result.violations, [], "a healthy topology must not violate: " + violationSummary(result));

  const boxes = result.boxes;
  const op = result.operations.find((o) => o.type === "createVector" && o.id === "link-1");
  assert.ok(op, "the connector is emitted as a vector");
  const a = boxes.get("node-a");
  const b = boxes.get("node-b");
  assert.ok(a && b, "both connectors endpoints resolve to placed nodes");
  const hull = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    right: Math.max(a.x + a.w, b.x + b.w),
    bottom: Math.max(a.y + a.h, b.y + b.h),
  };
  const points = [...op.path.matchAll(/([ML]) (-?[\d.]+) (-?[\d.]+)/g)].map((m) => [Number(m[2]), Number(m[3])]);
  assert.ok(points.length >= 2, "the connector path carries its endpoints");
  const onHull = points.every(([x, y]) => x >= hull.x - 2 && x <= hull.right + 2 && y >= hull.y - 2 && y <= hull.bottom + 2);
  assert.ok(onHull, `connector endpoints land on the endpoint hull: ${JSON.stringify(points)} vs ${JSON.stringify(hull)}`);
});

test("healthy type and accessibility evidence produces no findings of the regressed classes", () => {
  const labeled = auditTypeCriteria({ ops: [{ type: "createText", id: "ok", content: "Shard pressure ok", fontSize: MIN_LABEL_PX }] });
  assert.ok(!labeled.findings.some((f) => f.rule === "type.space.readable-labels"), "labels at the minimum size must pass the type audit");
  const readable = evaluateAccessibility({
    revisionId: "issue23-positive-control",
    texts: [{ id: "ok-label", content: "Node pressure 12%", size: 12, contrastRatio: 7.2 }],
  });
  assert.ok(!readable.findings.some((f) => f.ruleId === "a11y.text-contrast"), "readable contrast must pass the a11y evaluator");
});

test("every failure class a fixture targets is detected through the mechanism that reports it", () => {
  const detectors = new Set(Object.keys(DETECTORS));
  assert.deepEqual(
    [...EXO_REGRESSION_FAILURE_CLASSES].sort(),
    [...detectors].sort(),
    "the detector set must match the canonical failure classes exactly",
  );
  for (const fixture of EXO_REGRESSION_FIXTURES) {
    for (const target of fixture.failureTargets) {
      DETECTORS[target](); // a regression throws with a class-bearing message
    }
  }
});

/* -------------------------------------------------------------------------- */
/* (C) the truthful final gate: status untouched; verdict, gates, stamp         */
/* -------------------------------------------------------------------------- */

test("the required gate enumeration is exactly these six", () => {
  assert.deepEqual(
    [...REQUIRED_GATES].sort(),
    ["accessibility", "evidence-backed-scores", "genericity", "render-evidence", "session-stamp", "structural-blockers"],
  );
});

test("a full run with the stamp supplied PASSES with every required gate recorded as ran", () => {
  const report = evaluateFinalGate(GOOD_INPUT);
  assert.equal(report.status, "PASS");
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.verdictReasons, [], "nothing forced the verdict — no reasons");
  assert.ok(SERVER_BUILD.length > 0, "server build present (dev offline)");
  assert.equal(report.stamp.serverBuild, SERVER_BUILD);
  assert.equal(report.stamp.pluginBuild, "abc123-example", "the stamp echoes the plugin build verbatim");
  assert.equal(report.stamp.transactionId, "tx-42", "the stamp echoes the transaction verbatim");

  const byName = new Map(report.gates.map((g) => [g.name, g]));
  for (const name of REQUIRED_GATES) {
    const gate = byName.get(name);
    assert.ok(gate, `${name}: enumerated in the report`);
    assert.equal(gate.status, "ran", `${name}: actually ran`);
    assert.equal(gate.required, true, `${name}: required`);
    assert.ok(gate.detail && gate.detail.length > 0, `${name}: carries what actually happened`);
  }
});

test("an offline program-only run stays REVIEW but is truthfully BLOCKED, naming what never ran", () => {
  const offline = evaluateFinalGate({
    scores: { hierarchy: 90, composition: 90, typography: 90, readability: 90, density: 90, distinctiveness: 90, genericity: 90, productFit: 90 },
  });
  assert.equal(offline.status, "REVIEW", "status semantics untouched");
  assert.equal(offline.verdict, "BLOCKED");
  assert.ok(offline.verdictReasons.length > 0);
  for (const needed of ["session-stamp", "render-evidence", "structural-blockers", "accessibility"]) {
    assert.ok(offline.verdictReasons.some((r) => r.startsWith(`${needed}:`)), `${needed} is named for never running`);
  }
  assert.ok(!offline.verdictReasons.some((r) => r.startsWith("genericity:")), "the genericity gate ran via the evidence-backed score");
  assert.ok(offline.verdictReasons.some((r) => r.includes("no stamp was supplied")), "the stamp gate says exactly what is missing");
});

test("the historically pinned all-scores shape keeps status PASS while the verdict is honestly BLOCKED", () => {
  const pinned = evaluateFinalGate({
    scores: { hierarchy: 90, composition: 90, typography: 90, readability: 90, density: 90, distinctiveness: 90, genericity: 90, productFit: 90 },
    visualEvidenceVerified: true,
  });
  assert.equal(pinned.status, "PASS", "the pinned shape still passes its own asserts");
  assert.equal(pinned.verdict, "BLOCKED", "the truth layer: stamp and accessibility never ran");
  assert.ok(pinned.verdictReasons.some((r) => r.startsWith("session-stamp:")));
  assert.ok(pinned.verdictReasons.some((r) => r.startsWith("accessibility:")));
});

test("a required gate that was skipped, failed or never evaluated can never PASS the verdict", () => {
  // Supplied records win by name — the caller ran the stage, the report says so.
  const skipped = evaluateFinalGate({
    ...GOOD_INPUT,
    gates: [{ name: "accessibility", status: "skipped", required: true, detail: "contrast could not run: no rendered text nodes in scope" }],
  });
  assert.equal(skipped.status, "PASS", "status semantics untouched by the supplied record");
  assert.equal(skipped.verdict, "BLOCKED");
  assert.equal(skipped.gates.find((g) => g.name === "accessibility").status, "skipped");
  assert.ok(skipped.verdictReasons.some((r) => r.startsWith("accessibility:")), skipped.verdictReasons.join(" | "));

  const failedGate = evaluateFinalGate({
    ...GOOD_INPUT,
    gates: [{ name: "accessibility", status: "failed", required: true, detail: "1 finding below WCAG thresholds" }],
  });
  assert.equal(failedGate.verdict, "FAIL", "a gate that ran and found a blocker makes the whole verdict FAIL");
  assert.equal(failedGate.status, "PASS", "the coarse status is not rewritten by the gate record");
  assert.ok(failedGate.verdictReasons.some((r) => r.startsWith("accessibility:")));

  const neverRan = evaluateFinalGate({
    ...GOOD_INPUT,
    gates: [{ name: "render-evidence", status: "notEvaluated", required: true }],
  });
  assert.equal(neverRan.verdict, "BLOCKED");
  assert.ok(neverRan.verdictReasons.some((r) => r.startsWith("render-evidence:")));

  // A non-required gate reports truthfully without holding the verdict hostage.
  const optional = evaluateFinalGate({
    ...GOOD_INPUT,
    gates: [{ name: "illustrative-sample-disclosure", status: "skipped", required: false, detail: "policy module not wired into this run" }],
  });
  assert.equal(optional.status, "PASS");
  assert.equal(optional.verdict, "PASS");
  const disclosed = optional.gates.find((g) => g.name === "illustrative-sample-disclosure");
  assert.ok(disclosed, "unknown gate names are appended, not dropped");
  assert.equal(disclosed.status, "skipped");
});

test("a missing or partial stamp holds the verdict at BLOCKED even when status PASSES", () => {
  const absent = evaluateFinalGate({ ...GOOD_INPUT, stamp: undefined });
  assert.equal(absent.status, "PASS", "status semantics untouched");
  assert.equal(absent.verdict, "BLOCKED");
  const stampGate = absent.gates.find((g) => g.name === "session-stamp");
  assert.equal(stampGate.status, "notEvaluated");
  assert.ok(stampGate.detail.includes("no stamp was supplied"));
  assert.equal(absent.stamp.pluginBuild, null);
  assert.equal(absent.stamp.transactionId, null);
  assert.equal(absent.stamp.serverBuild, SERVER_BUILD);
  assert.ok(SERVER_BUILD.length > 0, "the server build is always present (dev offline)");

  const partial = evaluateFinalGate({ ...GOOD_INPUT, stamp: { pluginBuild: "abc123-example" } });
  assert.equal(partial.status, "PASS");
  assert.equal(partial.verdict, "BLOCKED", "without a transactionId the verdict cannot claim to be tied to the session");
  assert.equal(partial.stamp.transactionId, null);
  assert.equal(partial.stamp.pluginBuild, "abc123-example");
});

test("severe structural geometry FAILs the verdict with the reasons carried through", () => {
  const program = executeRuntime(duplicateIdsProgram);
  assert.ok(program.violations.length > 0, "the fixture program really violates");
  const report = evaluateFinalGate({
    ...GOOD_INPUT,
    blockingIssues: program.violations.map((v) => v.message),
  });
  assert.equal(report.status, "FAIL");
  assert.equal(report.verdict, "FAIL");
  const structural = report.gates.find((g) => g.name === "structural-blockers");
  assert.equal(structural.status, "failed");
  assert.ok(structural.detail.includes("blocker"));
  assert.ok(report.verdictReasons.some((r) => r.startsWith("structural-blockers:")), report.verdictReasons.join(" | "));
  assert.ok(
    report.blockingIssues.some((m) => m.includes("declared 2 times")),
    "the blocking issues pass through verbatim",
  );
});
