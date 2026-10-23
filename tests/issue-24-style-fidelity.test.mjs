/**
 * Issue #24 follow-up — text-style/token adoption + semantic-fidelity.
 *
 * 1. **Text styles** — role→style map from discovered `inspect_design_system`
 *    names (`mapTextStylesToRoles`); an explicit program `textStyleId` wins
 *    (`bindRoleTextStyle`); otherwise the discovered shared style binds by
 *    role; with nothing to bind, the caller falls back to raw fill+size with
 *    a warning. Hierarchy is preserved: scarce styles claim only their
 *    closest role, never every label identically.
 * 2. **Tokens** — `checkTokenConsistency` prefers the discovered variable
 *    over a duplicating hex and checks strokes/radii/spacing against the
 *    token scale.
 * 3. **Benchmark** — `scoreSemanticFidelity` scores node types, component
 *    linkage, stroke bounds, auto-layout and connector attachment (0–10);
 *    `scoreBenchmarkWithFidelity` attaches it without touching the pinned
 *    100-pt `BENCHMARK_WEIGHTS` totals.
 * 4. **Review** — the `fake-primitive` rule advises (minor/low, never
 *    blocking) on thin filled rects in divider/connector roles and frames
 *    that redraw an existing component.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mapTextStylesToRoles,
  bindRoleTextStyle,
} from "../mcp-server/dist-test/design/system/typography.js";
import {
  resolveTokens,
  checkTokenConsistency,
} from "../mcp-server/dist-test/design/system/token-intelligence.js";
import {
  BENCHMARK_WEIGHTS,
  scoreBenchmark,
  scoreSemanticFidelity,
  scoreBenchmarkWithFidelity,
} from "../mcp-server/dist-test/design/benchmark/suite.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";

/* -------------------------------------------------------------------------- */
/* 1. Text-style adoption                                                       */
/* -------------------------------------------------------------------------- */

const EXO_STYLES = ["EXO/Display", "EXO/Heading", "EXO/Body", "EXO/Label", "EXO/Caption", "EXO/Mono"];

test("each role claims its own shared style, preserving hierarchy", () => {
  const map = mapTextStylesToRoles(EXO_STYLES);
  assert.equal(map.display, "EXO/Display");
  assert.equal(map.heading, "EXO/Heading");
  assert.equal(map.body, "EXO/Body");
  assert.equal(map.label, "EXO/Label");
  assert.equal(map.caption, "EXO/Caption");
  assert.equal(map.technical, "EXO/Mono");
  assert.equal(new Set(Object.values(map)).size, 6, "no two roles share one style");
});

test("an explicit program textStyleId always wins over discovery", () => {
  const map = mapTextStylesToRoles(EXO_STYLES);
  const bound = bindRoleTextStyle("body", { explicitTextStyleId: "S:custom-1", roleMap: map });
  assert.equal(bound.textStyleId, "S:custom-1");
  assert.equal(bound.fallbackToRaw, false);
  assert.equal(bound.warning, undefined);
});

test("a discovered shared style binds by role without a warning", () => {
  const map = mapTextStylesToRoles(EXO_STYLES);
  const bound = bindRoleTextStyle("heading", { roleMap: map });
  assert.equal(bound.textStyleId, "EXO/Heading");
  assert.equal(bound.fallbackToRaw, false);
});

test("scarce styles claim only their closest role — never every label identically", () => {
  const map = mapTextStylesToRoles(["EXO/Title"]);
  assert.equal(map.display, "EXO/Title");
  assert.equal(map.heading, undefined, "heading must not be force-bound to the display style");
  assert.equal(map.body, undefined);
  const fallback = bindRoleTextStyle("body", { roleMap: map });
  assert.equal(fallback.fallbackToRaw, true);
  assert.ok(fallback.warning?.includes("body"), `warning names the role: ${fallback.warning}`);
});

test("with no discovered styles every role falls back with a warning", () => {
  const bound = bindRoleTextStyle("caption", { roleMap: {} });
  assert.equal(bound.fallbackToRaw, true);
  assert.equal(bound.textStyleId, undefined);
  assert.ok(bound.warning && bound.warning.length > 0);
});

/* -------------------------------------------------------------------------- */
/* 2. Token preference                                                          */
/* -------------------------------------------------------------------------- */

function exoTokens() {
  return resolveTokens({ variables: [], spacingBase: 8 });
}

test("a hardcoded fill duplicating a token value prefers the variable", () => {
  const tokens = exoTokens();
  const surface = tokens.colors.surface.value;
  const report = checkTokenConsistency(tokens, { fills: [surface.toLowerCase(), "#123456"] });
  assert.equal(report.preferVariable.length, 1);
  assert.equal(report.preferVariable[0].hex, surface.toUpperCase());
  assert.equal(report.preferVariable[0].variable, "exo/surface");
  assert.ok(report.score < 100, "duplication costs score");
});

test("an already-bound variable reference is not flagged as hardcoded", () => {
  const tokens = exoTokens();
  const report = checkTokenConsistency(tokens, { fills: ["exo/surface"] });
  assert.equal(report.preferVariable.length, 0);
  assert.equal(report.score, 100);
});

test("strokes, radii and spacing off the token scale are reported", () => {
  const tokens = exoTokens();
  const report = checkTokenConsistency(tokens, {
    fills: [],
    strokes: [1, 7],
    radii: [tokens.radii.small, 33],
    spacing: [8, 999],
  });
  const dims = new Set(report.offScale.map((o) => o.dimension));
  assert.ok(dims.has("stroke"), `off-scale: ${JSON.stringify(report.offScale)}`);
  assert.ok(dims.has("radius"));
  assert.ok(dims.has("spacing"));
  assert.ok(report.evidence.length >= 3);
});

test("on-scale strokes/radii/spacing score full marks with evidence", () => {
  const tokens = exoTokens();
  const report = checkTokenConsistency(tokens, {
    fills: [],
    strokes: [1, 2],
    radii: [tokens.radii.small, tokens.radii.medium],
    spacing: [tokens.spacing[0]],
  });
  assert.equal(report.offScale.length, 0);
  assert.equal(report.score, 100);
});

/* -------------------------------------------------------------------------- */
/* 3. Semantic-fidelity benchmark                                               */
/* -------------------------------------------------------------------------- */

test("the pinned 100-pt weights are untouched", () => {
  const total = Object.values(BENCHMARK_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.equal(total, 100);
  assert.deepEqual(Object.keys(BENCHMARK_WEIGHTS).sort(), [
    "composition",
    "density",
    "distinctiveness",
    "hierarchy",
    "nativeQuality",
    "productSpecificity",
    "readability",
    "relationshipClarity",
    "spacingRhythm",
    "typography",
  ]);
});

test("a fully semantic screen scores 10 with per-signal evidence", () => {
  const result = scoreSemanticFidelity({
    nodes: [
      { type: "LINE", name: "Section divider" },
      { type: "INSTANCE", name: "Primary Button", instanceOf: "btn-1" },
      { type: "VECTOR", name: "Node ring", stroke: { weight: 2 } },
      { type: "FRAME", name: "Inspector", layoutMode: "VERTICAL" },
      { type: "CONNECTOR", name: "Edge a-b", connectorAttached: true },
    ],
    promisedInstances: [{ regionId: "r1", componentId: "btn-1" }],
    promisedConnectors: [{ from: "a", to: "b" }],
  });
  assert.equal(result.score, 10);
  assert.equal(result.evidence.length, 5);
  assert.deepEqual(Object.keys(result.signals).sort(), [
    "autoLayout",
    "componentLinkage",
    "connectorAttachment",
    "nodeTypes",
    "strokeBounds",
  ]);
});

test("thin filled rects in divider roles and unlinked instances lose fidelity", () => {
  const result = scoreSemanticFidelity({
    nodes: [
      { type: "RECTANGLE", name: "Section divider", w: 400, h: 1 },
      { type: "FRAME", name: "Button copy", layoutMode: "NONE" },
      { type: "CONNECTOR", name: "Edge a-b", connectorAttached: false },
    ],
    promisedInstances: [{ regionId: "r1", componentId: "btn-1" }],
    promisedConnectors: [{ from: "a", to: "b" }],
  });
  assert.ok(result.signals.nodeTypes < 3, `nodeTypes: ${result.signals.nodeTypes}`);
  assert.equal(result.signals.componentLinkage, 0);
  assert.equal(result.signals.connectorAttachment, 0);
  assert.ok(result.score < 10);
});

test("unknowns are skipped, never zeroed", () => {
  const result = scoreSemanticFidelity({ nodes: [{ type: "TEXT", name: "Title" }] });
  assert.equal(result.score, 10);
  assert.ok(result.evidence.some((e) => e.includes("nothing to verify")));
});

test("fidelity attaches without touching the 100-pt total", () => {
  const scored = scoreBenchmark({
    caseId: "exo-compute-topology",
    dimensions: {
      hierarchy: 8, composition: 8, productSpecificity: 8, typography: 8,
      spacingRhythm: 8, relationshipClarity: 8, density: 8,
      nativeQuality: 8, distinctiveness: 8, readability: 8,
    },
  });
  const withFidelity = scoreBenchmarkWithFidelity(scored, {
    nodes: [{ type: "RECTANGLE", name: "divider", w: 300, h: 1 }],
  });
  assert.equal(withFidelity.total, scored.total);
  assert.equal(withFidelity.total, 80);
  assert.ok(withFidelity.fidelity.score < 10);
});

/* -------------------------------------------------------------------------- */
/* 4. Fake-primitive advisory                                                   */
/* -------------------------------------------------------------------------- */

function metricsReport(nodes) {
  return {
    target: null,
    scope: "selection",
    nodes: nodes.map((n, i) => ({
      id: n.id ?? `n${i}`,
      parentId: n.parentId ?? null,
      type: "RECTANGLE",
      name: `layer-${i}`,
      depth: 1,
      x: 0,
      y: i * 10,
      w: 100,
      h: 20,
      visible: true,
      defaultNamed: false,
      zIndex: i,
      ...n,
    })),
    nodeCount: nodes.length,
    truncated: false,
    scanBudget: 5000,
    scan: { pageLoads: 1, pagesCached: true },
  };
}

test("a thin filled rect named as a divider draws an advisory, never a block", () => {
  const findings = runRules(
    metricsReport([{ id: "div1", type: "RECTANGLE", name: "Section divider", w: 400, h: 1 }]),
    "review",
  ).filter((f) => f.rule === "fake-primitive");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "minor");
  assert.equal(findings[0].confidence, "low");
  assert.ok(findings[0].guidance.includes("LINE"), findings[0].guidance);
});

test("a stroked thin rect and a plain rect are not fake primitives", () => {
  const findings = runRules(
    metricsReport([
      { id: "ok1", type: "RECTANGLE", name: "Section divider", w: 400, h: 1, stroke: { hex: "#111111", weight: 1 } },
      { id: "ok2", type: "RECTANGLE", name: "Card fill", w: 400, h: 1 },
      { id: "ok3", type: "LINE", name: "Section divider", w: 400, h: 1 },
    ]),
    "review",
  ).filter((f) => f.rule === "fake-primitive");
  assert.equal(findings.length, 0);
});

test("a variant-named frame beside real instances advises instancing", () => {
  const findings = runRules(
    metricsReport([
      { id: "frame1", type: "FRAME", name: "Primary Button state=default", parentId: "root" },
      { id: "inst1", type: "INSTANCE", name: "Primary Button", parentId: "root", instanceOf: "btn-1" },
      { id: "root", type: "FRAME", name: "Screen", parentId: null, depth: 0, w: 1440, h: 900 },
    ]),
    "review",
  ).filter((f) => f.rule === "fake-primitive");
  assert.equal(findings.length, 1);
  assert.ok(findings[0].guidance.includes("create_instance"));
});
