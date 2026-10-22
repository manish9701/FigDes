/**
 * Issue #23 §4–6: BLOCKING typography / accessibility / design-system
 * consistency rules and their explicit exception paths.
 *
 * What is asserted here (per the issue's demand that these rules block, not
 * advise, unless a documented intentional reason is attached):
 * - (a)(b) legibility floors block: body text < 12px, dense-technical and
 *   supporting text < 11px — unless the text itself carries
 *   `exception: { reason }` with a stated justification;
 * - (c) WCAG AA contrast blocks (4.5:1 normal, 3:1 large);
 * - (d) state not colour-only: two same-text badges differing only in fill
 *   block when the content names no state, and pass when it does
 *   (encodesState semantics);
 * - (e) a one-off colour near-duplicating a token blocks when a token system
 *   was discovered, and is not-evaluated when none was;
 * - (f) near-duplicate tokens warn with consolidation operations.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAccessibility,
  accessibilityInputFromMetrics,
  MIN_BODY_TEXT_PX,
  MIN_DENSE_TEXT_PX,
} from "../mcp-server/dist-test/design/quality/accessibility.js";
import { evaluateConsistency } from "../mcp-server/dist-test/design/quality/consistency.js";
import { auditTypeCriteria, MIN_LABEL_PX } from "../mcp-server/dist-test/design/quality/type-criteria.js";
import { isBlocking } from "../mcp-server/dist-test/design/quality/finding.js";

/* -------------------------------------------------------------------------- */
/* (a) body text floor: 12px, blocking, explicit exception path               */
/* -------------------------------------------------------------------------- */

test("11px body text blocks without an exception and stops blocking with a documented one", () => {
  const blocked = evaluateAccessibility({
    revisionId: "rev-a",
    texts: [{ id: "t1", content: "hello", size: 11, contrastRatio: 8 }],
  });
  const small = blocked.findings.filter((f) => f.ruleId === "a11y.text-too-small");
  assert.equal(small.length, 1);
  assert.equal(small[0].severity, "critical");
  assert.equal(small[0].status, "open");
  assert.equal(isBlocking(small[0]), true);
  assert.equal(blocked.exceptions.length, 0);

  const exempt = evaluateAccessibility({
    revisionId: "rev-a",
    texts: [
      {
        id: "t1",
        content: "hello",
        size: 11,
        contrastRatio: 8,
        exception: { role: "caption", reason: "Fixed-density legal footnote; 12px overflows the table cell it lives in." },
      },
    ],
  });
  assert.equal(exempt.findings.some((f) => f.ruleId === "a11y.text-too-small"), false);
  assert.equal(exempt.exceptions.length, 1);
  assert.equal(exempt.exceptions[0].threshold, MIN_BODY_TEXT_PX);
  assert.ok(exempt.exceptions[0].reason.includes("footnote"));
  assert.ok(exempt.summary.includes("1 documented exception"));
});

test("an exception with a blank reason is no exception: the size still blocks", () => {
  const r = evaluateAccessibility({
    revisionId: "rev-a2",
    texts: [{ id: "t1", content: "hello", size: 11, contrastRatio: 8, exception: { reason: "   " } }],
  });
  assert.equal(r.findings.some((f) => f.ruleId === "a11y.text-too-small"), true);
  assert.equal(r.exceptions.length, 0);
  assert.equal(r.findings.find((f) => f.ruleId === "a11y.text-too-small")?.severity, "critical");
});

/* -------------------------------------------------------------------------- */
/* (b) dense-technical / supporting floor: 11px, blocking, exception path     */
/* -------------------------------------------------------------------------- */

test("10.5px technical label blocks without an exception and passes with one", () => {
  const blocked = evaluateAccessibility({
    revisionId: "rev-b",
    texts: [{ id: "v1", content: "p99 latency", size: 10.5, role: "dense-technical", contrastRatio: 8 }],
  });
  const small = blocked.findings.find((f) => f.ruleId === "a11y.text-too-small");
  assert.ok(small, "the dense floor blocks before render-critique");
  assert.equal(small.severity, "critical");
  assert.ok(small.summary.includes("11px"), `names the dense floor: ${small.summary}`);

  const passes = evaluateAccessibility({
    revisionId: "rev-b",
    texts: [
      {
        id: "v1",
        content: "p99 latency",
        size: 10.5,
        role: "dense-technical",
        contrastRatio: 8,
        exception: { role: "dense-technical", reason: "Instrument readout row; the brief fixes this column at the declared 11px dense floor." },
      },
    ],
  });
  assert.equal(passes.findings.length, 0);
  assert.equal(passes.exceptions.length, 1);
  assert.equal(passes.exceptions[0].threshold, MIN_DENSE_TEXT_PX);
});

test("supporting text holds the 11px floor, body still holds 12", () => {
  const supportingAt11 = evaluateAccessibility({
    revisionId: "rev-b2",
    texts: [{ id: "s1", content: "helper", size: 11, role: "supporting", contrastRatio: 8 }],
  });
  assert.equal(supportingAt11.findings.length, 0, "roleless body floors do not apply to supporting text");
  const bodyAt12 = evaluateAccessibility({
    revisionId: "rev-b2",
    texts: [{ id: "b1", content: "body", size: 12, contrastRatio: 8 }],
  });
  assert.equal(bodyAt12.findings.length, 0);
  assert.equal(MIN_BODY_TEXT_PX, 12);
  assert.equal(MIN_DENSE_TEXT_PX, 11);
  // The compile-time floor (type-criteria) keeps the system's 11px enforcement.
  assert.equal(MIN_LABEL_PX, 11);
});

/* -------------------------------------------------------------------------- */
/* (c) contrast: WCAG AA blocks                                                */
/* -------------------------------------------------------------------------- */

test("4.2:1 normal text blocks at critical; 4.6:1 passes", () => {
  const below = evaluateAccessibility({
    revisionId: "rev-c",
    texts: [{ id: "t1", content: "hi", size: 14, contrastRatio: 4.2 }],
  });
  const finding = below.findings.find((f) => f.ruleId === "a11y.text-contrast");
  assert.ok(finding, "below-AA contrast fires");
  assert.equal(finding.severity, "critical");
  assert.equal(isBlocking(finding), true);

  const passes = evaluateAccessibility({
    revisionId: "rev-c",
    texts: [{ id: "t1", content: "hi", size: 14, contrastRatio: 4.6 }],
  });
  assert.equal(passes.findings.length, 0);
});

test("large text holds the 3:1 requirement, not 4.5", () => {
  const largeFail = evaluateAccessibility({
    revisionId: "rev-c2",
    texts: [{ id: "t1", content: "hi", size: 24, contrastRatio: 2.8 }],
  });
  assert.equal(largeFail.findings.some((f) => f.ruleId === "a11y.text-contrast" && f.severity === "critical"), true);
  const largePass = evaluateAccessibility({
    revisionId: "rev-c2",
    texts: [{ id: "t1", content: "hi", size: 24, contrastRatio: 3.1 }],
  });
  assert.equal(largePass.findings.length, 0);
});

/* -------------------------------------------------------------------------- */
/* (d) state not colour-only, derived from the metrics shape                   */
/* -------------------------------------------------------------------------- */

const metricNode = (id, color, content) => ({
  id,
  parentId: null,
  type: "TEXT",
  name: id,
  depth: 0,
  x: 0,
  y: 0,
  w: 64,
  h: 16,
  visible: true,
  defaultNamed: false,
  zIndex: 0,
  fill: color,
  background: "#FFFFFF",
  text: { content, length: content.length, truncated: false, size: 12, family: "Inter", style: "Regular", color, styled: false },
});

const metricsReport = (nodes) => ({
  target: "badge-screen",
  scope: "badge-screen",
  nodeCount: nodes.length,
  truncated: false,
  scanBudget: 1,
  scan: { pageLoads: 0, pagesCached: false },
  nodes,
});

test("two same-text badges differing only in fill: colour-only state blocks when the content names no state", () => {
  const input = accessibilityInputFromMetrics(
    metricsReport([metricNode("ta", "#2D7A4D", "Status"), metricNode("tb", "#D13415", "Status")]),
    "rev-d",
  );
  const report = evaluateAccessibility(input);
  const findings = report.findings.filter((f) => f.ruleId === "a11y.color-only-state");
  assert.ok(findings.length >= 2, `one finding per colour-carried element: ${report.findings.map((f) => f.ruleId).join(", ")}`);
  const ids = findings.flatMap((f) => f.affectedNodeIds);
  assert.ok(ids.includes("ta") && ids.includes("tb"));
  assert.ok(findings.every((f) => f.severity === "critical" || f.severity === "high"));
});

test("the same badges whose content names the state carry a textual cue and pass", () => {
  const input = accessibilityInputFromMetrics(
    metricsReport([metricNode("ta", "#2D7A4D", "Ready"), metricNode("tb", "#D13415", "Ready")]),
    "rev-d",
  );
  const report = evaluateAccessibility(input);
  assert.equal(report.findings.length, 0, `encodesState text passes: ${report.findings.map((f) => f.ruleId).join(", ")}`);
});

test("identical labels on different surfaces are decorative tone inversion, not colour-only state", () => {
  const nav = { ...metricNode("t-nav", "#FFFFFF", "Home"), background: "#111111" };
  const footer = { ...metricNode("t-footer", "#242521", "Home"), background: "#FFFDF9" };
  const input = accessibilityInputFromMetrics(metricsReport([nav, footer]), "rev-d2");
  const report = evaluateAccessibility(input);
  assert.equal(report.findings.some((f) => f.ruleId === "a11y.color-only-state"), false);
});

/* -------------------------------------------------------------------------- */
/* (e) one-off colour: blocking with a discovered token system, else not-evaluated */
/* -------------------------------------------------------------------------- */

test("one-off colour blocks when a token system exists and is not-evaluated when none", () => {
  const withTokens = evaluateConsistency({
    fills: ["#2D7A4D", "#2E7C4F"],
    approvedTokens: ["#2D7A4D"],
    tokenSystem: {
      colors: [{ name: "exo/health", role: "success", value: "#2D7A4D" }],
      radii: [8],
      spacing: [8, 16],
    },
    revisionId: "rev-e",
  });
  assert.equal(withTokens.tokenCheck, "evaluated");
  assert.equal(withTokens.blocking, true);
  assert.ok(withTokens.evidence.some((e) => e.startsWith("BLOCKING")));
  const oneOff = withTokens.findings.find((f) => f.ruleId === "consistency.one-off-color");
  assert.ok(oneOff, `findings: ${withTokens.findings.map((f) => f.ruleId).join(", ")}`);
  assert.equal(oneOff.severity, "critical");
  assert.equal(isBlocking(oneOff), true);

  const noTokens = evaluateConsistency({ fills: ["#2E7C4F", "#111111"] });
  assert.equal(noTokens.tokenCheck, "not-evaluated");
  assert.equal(noTokens.blocking, false);
  assert.ok(noTokens.evidence.some((e) => e.startsWith("token consistency not evaluated")));
  assert.equal(noTokens.findings.some((f) => f.ruleId === "consistency.one-off-color"), false);
});

test("a genuinely different unapproved fill stays a penalty, not a one-off block", () => {
  const r = evaluateConsistency({
    fills: ["#2D7A4D", "#FF0000"],
    approvedTokens: ["#2D7A4D"],
    tokenSystem: { colors: [{ name: "exo/health", role: "success", value: "#2D7A4D" }] },
    revisionId: "rev-e2",
  });
  assert.equal(r.findings.some((f) => f.ruleId === "consistency.one-off-color"), false);
  assert.equal(r.blocking, false);
  assert.ok(r.evidence.some((e) => e.includes("outside the approved set")));
});

/* -------------------------------------------------------------------------- */
/* (f) near-duplicate tokens warn with consolidation operations                */
/* -------------------------------------------------------------------------- */

test("near-duplicate tokens (same role, near values) warn with suggested consolidation operations", () => {
  const r = evaluateConsistency({
    fills: ["#F2C94C"],
    approvedTokens: ["#F2C94C"],
    tokenSystem: {
      colors: [
        { name: "exo/action", role: "accent", value: "#F2C94C" },
        { name: "brand/accent-alt", role: "accent", value: "#F3CA4E" },
      ],
      radii: [8, 9],
      typeSizes: [12, 12.5],
    },
    revisionId: "rev-f",
  });
  const warnings = r.findings.filter((f) => f.ruleId === "consistency.near-duplicate-token");
  assert.equal(warnings.length, 1, `one consolidation finding: ${r.findings.map((f) => f.ruleId).join(", ")}`);
  const warn = warnings[0];
  assert.ok(Array.isArray(warn.suggestedOperations) && warn.suggestedOperations.length >= 3, `consolidation ops present: ${JSON.stringify(warn.suggestedOperations)}`);
  assert.ok(warn.suggestedOperations.every((op) => /consolidate/i.test(String(op["op"]))));
  assert.ok(JSON.stringify(warn.suggestedOperations).includes("brand/accent-alt"));
  assert.equal(isBlocking(warn), false, "warnings do not block");
  assert.equal(r.blocking, false);
});

/* -------------------------------------------------------------------------- */
/* compile-time exception path + existing verdicts keep their shape            */
/* -------------------------------------------------------------------------- */

test("the compile-time 11px floor fails without an exception and passes with a documented one", () => {
  const failed = auditTypeCriteria({ ops: [{ type: "createText", id: "t9", content: "micro label", fontSize: 10 }] });
  assert.ok(failed.findings.some((f) => f.rule === "type.space.readable-labels"));

  const exempt = auditTypeCriteria({
    ops: [
      {
        type: "createText",
        id: "t9",
        content: "micro label",
        fontSize: 10,
        exception: { reason: "Spatial-density thumbnail grid; the waiver is recorded in the brief." },
      },
    ],
  });
  assert.equal(exempt.findings.length, 0);
  const labels = exempt.criteria.find((c) => c.criterion === "readable-labels");
  assert.equal(labels?.status, "pass");
  assert.ok(labels?.detail.includes("documented exception"));
});

test("existing consistency verdicts keep their shape: clean passes, repair-introduced drift blocks", () => {
  const clean = evaluateConsistency({
    fills: ["#0b0e14", "#ffffff"],
    approvedTokens: ["#0b0e14", "#ffffff"],
    radii: [8],
    families: ["Inter"],
  });
  assert.ok(clean.score >= 70 && !clean.blocking);
  assert.equal(clean.findings.length, 0);

  const drift = evaluateConsistency({
    fills: ["#0b0e14", "#ff0000"],
    approvedTokens: ["#0b0e14"],
    radii: [8],
    families: ["Inter"],
    repairIntroducedUnknown: true,
  });
  assert.equal(drift.blocking, true);
  assert.ok(drift.evidence.some((e) => /BLOCKING/.test(e)));

  // The figdes-pipeline suite's assertions, re-proven against this build.
  const pipelineClean = evaluateConsistency({
    fills: ["#FFFDF9", "#242521", "#FFFFFF"],
    approvedTokens: ["#FFFDF9", "#242521", "#FFFFFF"],
    radii: [8, 12],
    families: ["Inter"],
  });
  assert.ok(pipelineClean.score >= 90, `clean token system scores high: ${pipelineClean.score}`);
  const rainbow = evaluateConsistency({ fills: Array.from({ length: 15 }, (_, i) => `#${i.toString(16).padStart(6, "0")}`) });
  assert.ok(rainbow.score < pipelineClean.score, "15 fills score below a 3-fill system");
});
