/**
 * Unit tests for the design critic.
 *
 * The rules are pure functions over measured facts, which is the whole reason
 * they live on the server: they can be verified here without Figma, and the
 * numbers in a finding can be checked by hand.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio, relativeLuminance, requiredRatio, parseHex } from "../mcp-server/dist-test/review/contrast.js";
import { runRules, summarise, inferBase, validated } from "../mcp-server/dist-test/review/rules.js";
import { evaluateQualityGate } from "../mcp-server/dist-test/review/quality.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
/* -------------------------------------------------------------------------- */

function node(over = {}) {
  return {
    id: "1:1",
    parentId: null,
    type: "FRAME",
    name: "Frame",
    depth: 0,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    visible: true,
    defaultNamed: false,
    zIndex: 0,
    ...over,
  };
}

function metrics(nodes, over = {}) {
  return {
    target: null,
    scope: "test",
    nodes,
    nodeCount: nodes.length,
    truncated: false,
    scan: { pageLoads: 0, pagesCached: true },
    ...over,
  };
}

function find(findings, rule) {
  return findings.filter((f) => f.rule === rule);
}

/* -------------------------------------------------------------------------- */
/* Contrast — verified against the WCAG reference values                       */
/* -------------------------------------------------------------------------- */

test("relative luminance matches the WCAG reference values", () => {
  assert.equal(Math.round(relativeLuminance({ r: 1, g: 1, b: 1 }) * 1000) / 1000, 1);
  assert.equal(Math.round(relativeLuminance({ r: 0, g: 0, b: 0 }) * 1000) / 1000, 0);
});

test("contrast ratio hits 21 for black on white", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#FFFFFF")), 21);
});

test("contrast ratio is 1 for identical colours", () => {
  assert.equal(Math.round(contrastRatio("#123456", "#123456")), 1);
});

test("contrast ratio matches a known pair", () => {
  // #767676 on white is the canonical "just passes AA at 4.5" grey.
  const r = contrastRatio("#767676", "#FFFFFF");
  assert.ok(r > 4.5 && r < 4.6, `expected ~4.54, got ${r}`);
});

test("required ratio relaxes for large or bold text", () => {
  assert.equal(requiredRatio(16, false), 4.5);
  assert.equal(requiredRatio(18, false), 3);
  assert.equal(requiredRatio(14, true), 3);
  assert.equal(requiredRatio(13, true), 4.5);
});

test("parseHex rejects malformed input rather than guessing", () => {
  assert.equal(parseHex("nope"), null);
  assert.deepEqual(parseHex("#fff"), { r: 1, g: 1, b: 1 });
});

/* -------------------------------------------------------------------------- */
/* text-contrast — the flagship high-confidence rule                            */
/* -------------------------------------------------------------------------- */

test("flags text below WCAG AA", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", type: "FRAME", name: "Card", w: 300, h: 100, fill: "#FFFFFF", background: "#FFFFFF" }),
      node({
        id: "1:2",
        parentId: "1:1",
        type: "TEXT",
        name: "Muted label",
        depth: 1,
        x: 16,
        y: 16,
        w: 200,
        h: 20,
        background: "#FFFFFF",
        text: { content: "hello", length: 5, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#BBBBBB", styled: false },
      }),
    ]),
    "review",
  );

  const contrast = find(findings, "text-contrast");
  assert.equal(contrast.length, 1, "expected exactly one contrast finding");
  assert.equal(contrast[0].confidence, "high");
  assert.equal(contrast[0].evidence.required, 4.5);
  assert.ok(contrast[0].evidence.ratio < 4.5);
  assert.deepEqual(contrast[0].nodeIds, ["1:2"]);
});

test("does not flag text that passes AA", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", background: "#FFFFFF" }),
      node({
        id: "1:2",
        parentId: "1:1",
        type: "TEXT",
        name: "Body",
        depth: 1,
        background: "#FFFFFF",
        text: { content: "hi", length: 2, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#111111", styled: true },
      }),
    ]),
    "review",
  );
  assert.equal(find(findings, "text-contrast").length, 0);
});

test("uses the relaxed threshold for large text", () => {
  const build = (size) =>
    runRules(
      metrics([
        node({ id: "1:1", name: "Card", background: "#FFFFFF" }),
        node({
          id: "1:2",
          parentId: "1:1",
          type: "TEXT",
          name: "Heading",
          depth: 1,
          background: "#FFFFFF",
          text: { content: "x", length: 1, truncated: false, size, family: "Inter", style: "Regular", color: "#8A8A8A", styled: true },
        }),
      ]),
      "review",
    );

  assert.equal(find(build(14), "text-contrast").length, 1, "14pt regular still needs 4.5");
  assert.equal(find(build(24), "text-contrast").length, 0, "24pt only needs 3");
});

test("skips a 1:1 ratio because it means the measurement is broken, not the design", () => {
  // Regression: a text node's own fill used to be folded into its "background",
  // so every contrast ratio came out as exactly 1:1 and the reviewer reported
  // the whole file as critically inaccessible.
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", background: "#FFFFFF" }),
      node({
        id: "1:2",
        parentId: "1:1",
        type: "TEXT",
        name: "Label",
        depth: 1,
        background: "#111111",
        text: { content: "hi", length: 2, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#111111", styled: true },
      }),
    ]),
    "review",
  );
  assert.equal(find(findings, "text-contrast").length, 0);
});

test("ignores empty and whitespace-only text", () => {
  const mk = (content) =>
    find(
      runRules(
        metrics([
          node({ id: "1:1", name: "Card", background: "#FFFFFF" }),
          node({
            id: "1:2",
            parentId: "1:1",
            type: "TEXT",
            name: "Blank",
            depth: 1,
            background: "#FFFFFF",
            text: { content, length: content.length, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#EEEEEE", styled: true },
          }),
        ]),
        "review",
      ),
      "text-contrast",
    );
  assert.equal(mk("").length, 0);
  assert.equal(mk("   \n ").length, 0);
});

test("caps repeat findings per rule and reports how many were suppressed", () => {
  // 200 low-contrast labels would otherwise crowd out every other rule.
  const nodes = [node({ id: "1:1", name: "Card", w: 2000, h: 2000, background: "#FFFFFF" })];
  for (let i = 0; i < 200; i++) {
    nodes.push(
      node({
        id: `1:${100 + i}`,
        parentId: "1:1",
        type: "TEXT",
        name: `Label ${i}`,
        depth: 1,
        x: (i % 20) * 90,
        y: Math.floor(i / 20) * 20,
        w: 80,
        h: 16,
        background: "#FFFFFF",
        text: { content: `x${i}`, length: 2, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#CCCCCC", styled: true },
      }),
    );
  }

  const findings = runRules(metrics(nodes), "review");
  const contrast = find(findings, "text-contrast");

  assert.ok(contrast.length <= 12, `expected a capped list, got ${contrast.length}`);
  assert.ok(contrast.length > 0);
  assert.ok("additionalOccurrences" in contrast[0].evidence, "suppressed count must be reported");
  assert.ok(Number(contrast[0].evidence.additionalOccurrences) > 0);
});

test("a single rule cannot crowd out the others", () => {
  const nodes = [node({ id: "1:1", name: "Card", w: 2000, h: 2000, background: "#FFFFFF" })];
  for (let i = 0; i < 150; i++) {
    nodes.push(
      node({
        id: `1:${100 + i}`,
        parentId: "1:1",
        type: "TEXT",
        name: "Frame 1",
        depth: 1,
        x: (i % 20) * 90,
        y: Math.floor(i / 20) * 20,
        w: 80,
        h: 16,
        background: "#FFFFFF",
        text: { content: `x${i}`, length: 2, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#CCCCCC", styled: true },
      }),
    );
  }

  const findings = runRules(metrics(nodes), "review");
  const rules = new Set(findings.map((f) => f.rule));
  assert.ok(rules.size > 1, "more than one rule should survive the cap");
});

test("skips mixed-font text instead of guessing", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", background: "#FFFFFF" }),
      node({
        id: "1:2",
        parentId: "1:1",
        type: "TEXT",
        name: "Mixed",
        depth: 1,
        background: "#FFFFFF",
        text: { content: "x", length: 1, truncated: false, size: 12, family: "mixed", style: "mixed", color: "#CCCCCC", styled: true },
      }),
    ]),
    "review",
  );
  assert.equal(find(findings, "text-contrast").length, 0);
});

/* -------------------------------------------------------------------------- */
/* Geometry rules                                                               */
/* -------------------------------------------------------------------------- */

test("flags a child that overflows its parent", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", w: 200, h: 100 }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Wide bar", x: 0, y: 0, w: 260, h: 20 }),
    ]),
    "review",
  );
  const over = find(findings, "overflow");
  assert.equal(over.length, 1);
  assert.equal(over[0].confidence, "high");
  assert.ok(String(over[0].evidence.spills).includes("right"));
});

test("does not flag a child that fits", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", w: 200, h: 100 }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Bar", x: 8, y: 8, w: 100, h: 20 }),
    ]),
    "review",
  );
  assert.equal(find(findings, "overflow").length, 0);
});

test("off-grid geometry is medium confidence and needs an inferred base", () => {
  const withGrid = runRules(
    metrics([
      node({ id: "1:1", name: "Root", itemSpacing: 8, padding: { top: 8, right: 8, bottom: 8, left: 8 } }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Odd", x: 13, y: 8, w: 100, h: 20 }),
    ]),
    "review",
  );
  const grid = find(withGrid, "off-grid-geometry");
  assert.equal(grid.length, 1);
  assert.equal(grid[0].confidence, "medium");
  assert.equal(grid[0].evidence.base, 8);

  const noGrid = runRules(
    metrics([
      node({ id: "1:1", name: "Root" }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Odd", x: 13, y: 8, w: 100, h: 20 }),
    ]),
    "review",
  );
  assert.equal(find(noGrid, "off-grid-geometry").length, 0, "no base inferred, so no claim made");
});

/* -------------------------------------------------------------------------- */
/* Consistency rules                                                            */
/* -------------------------------------------------------------------------- */

test("flags minority corner radii and offers a validated fix", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Row", w: 600, h: 100 }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "A", x: 0, y: 0, w: 190, h: 100, radius: 8 }),
      node({ id: "1:3", parentId: "1:1", depth: 1, name: "B", x: 200, y: 0, w: 190, h: 100, radius: 8 }),
      node({ id: "1:4", parentId: "1:1", depth: 1, name: "C", x: 400, y: 0, w: 190, h: 100, radius: 16 }),
    ]),
    "review",
  );

  const radii = find(findings, "radius-inconsistency");
  assert.equal(radii.length, 1);
  assert.equal(radii[0].confidence, "high");
  assert.equal(radii[0].evidence.majorityRadius, 8);
  assert.deepEqual(radii[0].nodeIds, ["1:4"]);

  const ops = radii[0].suggestedOperations;
  assert.ok(ops, "a safe fix should be offered");
  assert.equal(ops.length, 1);
  assert.equal(ops[0].type, "setCornerRadius");
  assert.equal(ops[0].radius, 8);
});

test("flags default layer names with high confidence", () => {
  const findings = runRules(metrics([node({ id: "1:1", name: "Frame 12", type: "FRAME" })]), "review");
  const named = find(findings, "default-layer-name");
  assert.equal(named.length, 1);
  assert.equal(named[0].confidence, "high");
});

test("flags likely duplicate siblings at medium confidence", () => {
  const dup = (id) => node({ id, parentId: "1:1", depth: 1, name: "Rectangle", x: 0, y: 0, w: 100, h: 100, fill: "#FFFFFF", fillAlpha: 1 });
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Grid", w: 400, h: 400 }),
      dup("1:2"),
      dup("1:3"),
      dup("1:4"),
    ]),
    "review",
  );
  const d = find(findings, "duplicate-siblings");
  assert.equal(d.length, 1);
  assert.equal(d[0].confidence, "medium");
  assert.equal(d[0].nodeIds.length, 3);
});

/* -------------------------------------------------------------------------- */
/* Audit ruleset                                                                */
/* -------------------------------------------------------------------------- */

test("audit flags unstyled text and mostly-unnamed frames", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Card", w: 300, h: 200 }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Frame 3", x: 0, y: 0, w: 100, h: 20, defaultNamed: true }),
      node({ id: "1:3", parentId: "1:1", depth: 1, name: "Rectangle 4", x: 0, y: 24, w: 100, h: 20, defaultNamed: true }),
      node({
        id: "1:4",
        parentId: "1:1",
        depth: 1,
        type: "TEXT",
        name: "Label",
        x: 0,
        y: 48,
        w: 100,
        h: 20,
        text: { content: "hi", length: 2, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#111111", styled: false },
      }),
    ]),
    "audit",
  );

  assert.equal(find(findings, "unstyled-text").length, 1);
  const unnamed = find(findings, "unnamed-frame-children");
  assert.equal(unnamed.length, 1);
  assert.equal(unnamed[0].nodeIds.length, 2);
  assert.equal(find(findings, "text-contrast").length, 0, "audit does not run review rules");
});

/* -------------------------------------------------------------------------- */
/* Invariants that matter more than any single rule                            */
/* -------------------------------------------------------------------------- */

test("no rule ever emits a numeric quality score", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Frame 1", w: 200, h: 100, defaultNamed: true }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Button", x: 200, y: 0, w: 20, h: 20, radius: 4 }),
      node({ id: "1:3", parentId: "1:1", depth: 1, name: "Rectangle 2", x: 0, y: 0, w: 300, h: 20, radius: 12 }),
    ]),
    "review",
  );

  for (const f of findings) {
    // A value in 0..100 with no unit would be a fabricated quality score.
    for (const [k, v] of Object.entries(f.evidence)) {
      if (typeof v !== "number") continue;
      assert.ok(
        !(k.toLowerCase().includes("score") || k.toLowerCase().includes("quality")),
        `finding ${f.rule} exposes a score-like field ${k}`,
      );
    }
  }
});

test("every finding carries evidence, a confidence band and node ids", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Frame 1", w: 200, h: 100, defaultNamed: true }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Button", x: 200, y: 0, w: 20, h: 20 }),
    ]),
    "review",
  );

  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(f.rule, "rule name");
    assert.ok(["high", "medium", "low"].includes(f.confidence), "confidence band");
    assert.ok(["critical", "serious", "minor"].includes(f.severity), "severity");
    assert.ok(Object.keys(f.evidence).length > 0, "evidence present");
    assert.ok(f.nodeIds.length > 0, "node ids present");
    assert.ok(f.title.length > 0, "human title present");
  }
});

test("auto-fixable findings are only ever high confidence", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Row", w: 600, h: 100 }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "A", x: 0, y: 0, w: 190, h: 100, radius: 8 }),
      node({ id: "1:3", parentId: "1:1", depth: 1, name: "B", x: 200, y: 0, w: 190, h: 100, radius: 8 }),
      node({ id: "1:4", parentId: "1:1", depth: 1, name: "Button", x: 400, y: 0, w: 20, h: 20 }),
    ]),
    "review",
  );

  for (const f of findings) {
    if (f.suggestedOperations?.length) {
      assert.equal(f.confidence, "high", `${f.rule} offered a fix at ${f.confidence} confidence`);
    }
  }
});

test("hidden nodes are never reviewed", () => {
  const findings = runRules(
    metrics([node({ id: "1:1", name: "Hidden", visible: false, defaultNamed: true })]),
    "review",
  );
  assert.equal(findings.length, 0);
});

test("suggested operations are dropped unless they pass the allowlist", () => {
  assert.equal(validated([{ type: "evalJavascript", code: "x" }]), undefined);
  assert.equal(validated([{ type: "notARealOp" }]), undefined);
  assert.equal(validated([]), undefined);

  const ok = validated([{ type: "setCornerRadius", target: "1:1", radius: 4 }]);
  assert.equal(ok.length, 1);
  assert.equal(ok[0].type, "setCornerRadius");
});

test("inferBase only reports a base it can actually justify", () => {
  assert.equal(inferBase([8, 16, 24, 32]), 8);
  assert.equal(inferBase([4, 8, 12]), 4);
  assert.equal(inferBase([7, 11, 13]), 0, "no consistent base means no claim");
  assert.equal(inferBase([]), 0);
});

test("inferBase never reports 1, which would accept every integer", () => {
  // 1 trivially divides everything, so reporting it would make the grid rules
  // endorse every off-grid value in the file as correctly aligned.
  assert.equal(inferBase([1, 3, 7, 11, 13]), 0);
  assert.equal(inferBase([1, 1, 1]), 0);
  assert.equal(inferBase([3, 5, 9, 11, 13, 17, 19]), 0);
  assert.notEqual(inferBase([1, 2, 3, 4, 5, 7, 11]), 1);
});

test("inferBase still finds a real system in noisy values", () => {
  const noisy = [...Array(50).fill(8), ...Array(30).fill(16), ...Array(20).fill(24), 13, 27];
  assert.equal(inferBase(noisy), 8);
});

test("summarise counts by rule and by band", () => {
  const findings = runRules(
    metrics([
      node({ id: "1:1", name: "Frame 1", defaultNamed: true }),
      node({ id: "1:2", parentId: "1:1", depth: 1, name: "Button", x: 200, y: 0, w: 20, h: 20 }),
    ]),
    "review",
  );
  const s = summarise(findings);
  assert.equal(s.total, findings.length);
  assert.equal(s.high + s.medium + s.low, s.total);
  assert.ok(Object.keys(s.byRule).length > 0);
});

test("empty input is handled without throwing", () => {
  assert.deepEqual(runRules(metrics([]), "review"), []);
});
/* -------------------------------------------------------------------------- */
/* Governance: font families and button overload (report section 18)           */
/* -------------------------------------------------------------------------- */

function textNode(id, family, parentId = null) {
  return node({ id, parentId, type: "TEXT", name: `Text ${id}`, text: { content: "Hello", size: 14, family, style: "Regular", color: "#111111" } });
}

test("flags more than three font families exactly once", () => {
  const nodes = [textNode("1:1", "Inter"), textNode("1:2", "Roboto"), textNode("1:3", "Georgia"), textNode("1:4", "JetBrains Mono")];
  const findings = find(runRules(metrics(nodes), "review"), "font-family-count");
  assert.equal(findings.length, 1, "one file-level finding, not one per text node");
  assert.equal(findings[0].confidence, "high");
  assert.match(findings[0].title, /4 font families/);
});

test("three font families are a system, not a finding", () => {
  const nodes = [textNode("1:1", "Inter"), textNode("1:2", "Roboto"), textNode("1:3", "JetBrains Mono")];
  assert.equal(find(runRules(metrics(nodes), "review"), "font-family-count").length, 0);
});

function buttonScreen(count) {
  const root = node({ id: "0:1", name: "Screen" });
  const kids = [];
  for (let i = 0; i < count; i++) {
    kids.push(node({ id: `2:${i}`, parentId: "0:1", name: `Button ${i}`, w: 120, h: 40 }));
  }
  return [root, ...kids];
}

test("flags more than five buttons on one screen", () => {
  const findings = find(runRules(metrics(buttonScreen(6)), "review"), "button-overload");
  assert.equal(findings.length, 1, "one finding per screen, not per button");
  assert.match(findings[0].title, /6 buttons/);
});

test("five buttons are fine", () => {
  assert.equal(find(runRules(metrics(buttonScreen(5)), "review"), "button-overload").length, 0);
});

test("button variants inside a component set are not screen buttons", () => {
  const set = node({ id: "0:9", name: "Button set", type: "COMPONENT_SET" });
  const kids = [];
  for (let i = 0; i < 6; i++) {
    kids.push(node({ id: `3:${i}`, parentId: "0:9", type: "COMPONENT", name: `Button variant ${i}` }));
  }
  assert.equal(find(runRules(metrics([set, ...kids]), "review"), "button-overload").length, 0);
});


/* -------------------------------------------------------------------------- */
/* Professional visual quality gate                                           */

function critiqueFixture(over = {}) {
  const dimensions = [
    { dimension: "Focal clarity", verdict: "PASS", evidence: "one clear focal" },
    { dimension: "Hierarchy", verdict: "PASS", evidence: "clear type hierarchy" },
    { dimension: "Composition", verdict: "PASS", evidence: "resolved composition" },
    { dimension: "Card-wall tendency", verdict: "PASS", evidence: "no card wall" },
    { dimension: "Template feel", verdict: "PASS", evidence: "no template markers" },
    ...(over.dimensions ?? []),
  ];
  return { verdict: over.verdict ?? "PASS", dimensions };
}

test("quality gate requires a render for composition-led work", () => {
  const gate = evaluateQualityGate(critiqueFixture(), { compositionLed: true, renderReviewed: false });
  assert.equal(gate.status, "REVIEW");
  assert.equal(gate.renderRequired, true);
});

test("quality gate blocks card-wall and template warnings on composition-led screens", () => {
  const gate = evaluateQualityGate(critiqueFixture({ dimensions: [
    { dimension: "Card-wall tendency", verdict: "WATCH", evidence: "4 bordered surfaces cover 55%", suggestion: "Convert the cluster into a visual field." },
  ] }), { compositionLed: true, renderReviewed: true });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.blockingIssues[0], /Card-wall tendency/);
});

test("quality gate allows a watch item on information-led work without pretending it passed", () => {
  const gate = evaluateQualityGate(critiqueFixture({
    verdict: "WATCH",
    dimensions: [{ dimension: "Depth", verdict: "WATCH", evidence: "flat surface" }],
  }), { compositionLed: false, renderReviewed: true });
  assert.equal(gate.status, "REVIEW");
  assert.equal(gate.renderRequired, false);
  assert.equal(gate.repairPlan.length, 1);
});

test("quality gate fails any hard FAIL regardless of composition mode", () => {
  const gate = evaluateQualityGate(critiqueFixture({
    verdict: "FAIL",
    dimensions: [{ dimension: "Composition", verdict: "FAIL", evidence: "no focal region" }],
  }), { compositionLed: false, renderReviewed: true });
  assert.equal(gate.status, "FAIL");
  assert.match(gate.blockingIssues[0], /Composition/);
});

/* -------------------------------------------------------------------------- */
/* Pipeline fixes: critique_visual returns its qualityGate, score_design       */
/* scores live nodes, final_qa scopes to the node                              */

const workflow = await import("../mcp-server/dist-test/review/workflow.js");

function liveMetrics() {
  const frame = (id, parentId, name, x, y, w, h, extra = {}) => ({
    id, parentId, type: "FRAME", name, depth: parentId ? 1 : 0, x, y, w, h,
    visible: true, defaultNamed: false, zIndex: 0, fill: "#0F1110", background: "#0F1110", ...extra,
  });
  return {
    target: "1:1",
    scope: "Test Screen",
    nodeCount: 6,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
    nodes: [
      frame("1:1", null, "Screen", 0, 0, 1440, 900),
      frame("1:2", "1:1", "topology-field", 0, 56, 824, 844),
      frame("1:3", "1:1", "attention-rail", 824, 56, 384, 844),
      frame("1:4", "1:1", "rail", 0, 0, 232, 900),
      { id: "1:5", parentId: "1:2", type: "TEXT", name: "Title", depth: 2, x: 24, y: 38, w: 300, h: 21, visible: true, defaultNamed: false, zIndex: 0, background: "#0F1110", text: { content: "Where compute lives", length: 19, truncated: false, size: 17, family: "Inter", style: "Regular", color: "#FFFDF9", styled: true } },
      { id: "1:6", parentId: "1:3", type: "TEXT", name: "Action", depth: 2, x: 848, y: 100, w: 200, h: 15, visible: true, defaultNamed: false, zIndex: 0, background: "#151713", text: { content: "RTX 4090 under pressure", length: 22, truncated: false, size: 20, family: "Inter", style: "Regular", color: "#FFFDF9", styled: true } },
    ],
  };
}

function fakeRegistry(metrics) {
  const seen = [];
  return {
    seen,
    resolve() {
      return {
        request: async (tool, args) => {
          seen.push({ tool, args });
          assert.equal(tool, "collect_metrics");
          return metrics;
        },
      };
    },
  };
}

test("critique_visual on a program returns its qualityGate, not just the verdict", async () => {
  const out = await workflow.critiqueVisualTool({
    program: {
      canvas: { name: "T", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [],
    },
  });
  assert.equal(out.status, "ok");
  assert.ok(out.qualityGate, "qualityGate must be present");
  assert.ok(["PASS", "REVIEW", "FAIL"].includes(out.qualityGate.status));
  assert.ok(Array.isArray(out.blockingIssues), "blockingIssues must be present");
  assert.ok(Array.isArray(out.repairPlan), "repairPlan must be present");
  assert.equal(typeof out.renderRequired, "boolean");
});

test("critique_visual on a live node gates on vision, with REVIEW until the render is judged", async () => {
  const before = await workflow.critiqueVisualTool({
    nodeId: "105:286",
    visionCriticObservations: {
      focalPoint: "PASS: RTX pressure node clearly focal in the topology field",
      hierarchy: "PASS: headline then field then rail reads clearly",
      balance: "center field slightly heavy on the right, needs a look",
      templateFeel: "PASS: spatial instrument with open surfaces and restrained color",
    },
  });
  assert.equal(before.status, "ok");
  assert.equal(before.source, "live");
  assert.ok(before.qualityGate, "native path must return a qualityGate");
  assert.equal(before.qualityGate.status, "REVIEW");
  assert.equal(before.renderRequired, true);

  const after = await workflow.critiqueVisualTool({
    nodeId: "105:286",
    renderReviewed: true,
    visionCriticObservations: {
      focalPoint: "PASS: pressure node is clearly focal",
      hierarchy: "PASS: strong restrained hierarchy",
      balance: "PASS: calm spatial balance",
      templateFeel: "PASS: open surfaces, no template markers",
    },
  });
  assert.equal(after.qualityGate.status, "PASS");
});

test("critique_visual on a live node FAILs a generic dashboard sighting", async () => {
  const out = await workflow.critiqueVisualTool({
    nodeId: "105:286",
    renderReviewed: true,
    visionCriticObservations: {
      focalPoint: "no focal point, everything equal",
      hierarchy: "flat",
      balance: "static symmetry",
      templateFeel: "FAIL: generic sidebar header three-card dashboard with card wall",
    },
  });
  assert.equal(out.verdict, "FAIL");
  assert.equal(out.qualityGate.status, "FAIL");
  assert.ok(out.blockingIssues.length > 0);
  assert.ok(out.repairPlan.length > 0);
});

test("score_design scores a live node with the same dimensions as a program", async () => {
  const registry = fakeRegistry(liveMetrics());
  const out = await workflow.scoreDesignTool({ nodeId: "1:1" }, registry);
  assert.equal(out.status, "ok");
  assert.equal(out.source, "live");
  assert.equal(typeof out.overall, "number");
  assert.ok(out.overall >= 0 && out.overall <= 10);
  assert.ok(out.dimensions.length >= 6, "same dimension family as program scoring");
  assert.ok(out.dimensions.some((d) => d.dimension === "Composition"));
  assert.ok(out.dimensions.every((d) => typeof d.evidence === "string" && d.evidence.length > 0));
  assert.deepEqual(registry.seen[0].args, { target: "1:1" }, "must scope collection to the node");
});

test("final_qa scopes collect_metrics to the node, not the whole file", async () => {
  const seen = [];
  const session = {
    request: async (tool, args) => {
      seen.push({ tool, args });
      return liveMetrics();
    },
  };
  const out = await workflow.finalQaTool(session, { nodeId: "1:1" });
  assert.equal(seen[0].tool, "collect_metrics");
  assert.deepEqual(seen[0].args, { target: "1:1" });
  const technical = out.checklist.find((i) => i.check === "no overflow or broken structure");
  assert.match(technical.detail, /Test Screen/, "detail must name the scoped subtree");
});

/* -------------------------------------------------------------------------- */
/* Live-critique measurement fixes: regions, focal, balance, surfaces          */

function liveTree() {
  const n = (over = {}) => ({
    parentId: null,
    type: "FRAME",
    name: "Frame",
    depth: 0,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    visible: true,
    defaultNamed: false,
    zIndex: 0,
    ...over,
  });
  const t = (over = {}) =>
    n({
      type: "TEXT",
      name: "Label",
      w: 200,
      h: 20,
      text: { content: "hi", length: 2, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#111111", styled: true },
      ...over,
    });
  return {
    target: "9:9",
    scope: "Screen",
    nodeCount: 5,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
    nodes: [
      n({ id: "9:9", name: "Screen", w: 1440, h: 900, parentId: "page1", fill: "#F7F5EF", background: "#F7F5EF" }),
      n({ id: "9:10", parentId: "9:9", name: "Focal Hero", depth: 1, y: 64, w: 1440, h: 500, fill: "#ECEBE4", background: "#F7F5EF" }),
      n({ id: "9:12", parentId: "9:9", name: "Detail", depth: 1, y: 600, w: 1440, h: 240, fill: "#ECEBE5", background: "#F7F5EF" }),
      t({ id: "9:11", parentId: "9:9", depth: 1, x: 24, y: 700, background: "#F7F5EF" }),
      n({ id: "8:8", parentId: "page1", name: "Other Screen", x: 1500, w: 1440, h: 900 }),
    ],
  };
}

function stubCritiqueRegistry(metrics) {
  return {
    resolve() {
      return {
        request: async (tool) => {
          if (tool === "collect_metrics") return metrics;
          return {}; // render_node with no image: an explicit failure state
        },
      };
    },
  };
}

function liveCritiquePayload(out) {
  return JSON.parse(out.content[0].text);
}

test("live regions are the target's children, not siblings or loose text", async () => {
  const out = await workflow.critiqueVisualTool({ nodeId: "9:9" }, stubCritiqueRegistry(liveTree()));
  const payload = liveCritiquePayload(out);
  const density = payload.dimensions.find((d) => d.dimension === "Density");
  assert.match(density.evidence, /2 regions/, `sibling frame and text node must not count as regions: ${density.evidence}`);
});

test("the screen frame is never its own focal point", async () => {
  const out = await workflow.critiqueVisualTool({ nodeId: "9:9" }, stubCritiqueRegistry(liveTree()));
  const payload = liveCritiquePayload(out);
  const focal = payload.dimensions.find((d) => d.dimension === "Focal clarity");
  assert.match(focal.evidence, /9:10/, "the named hero must be the intended focal");
  assert.doesNotMatch(focal.evidence, /intended '9:9'/, "the root frame must not be a focal candidate");
});

test("a centered full-width stack reads as balanced, not toppled", async () => {
  const out = await workflow.critiqueVisualTool({ nodeId: "9:9" }, stubCritiqueRegistry(liveTree()));
  const payload = liveCritiquePayload(out);
  const balance = payload.dimensions.find((d) => d.dimension === "Visual balance");
  assert.equal(balance.verdict, "PASS", `straddling boxes split half/half: ${balance.evidence}`);
});

test("near-identical tonal fills read as one surface", async () => {
  const out = await workflow.critiqueVisualTool({ nodeId: "9:9" }, stubCritiqueRegistry(liveTree()));
  const payload = liveCritiquePayload(out);
  const surfaces = payload.dimensions.find((d) => d.dimension === "Surface hierarchy");
  assert.equal(surfaces.verdict, "PASS");
  assert.match(surfaces.evidence, /2 surface/, `#ECEBE4 and #ECEBE5 are one warm grey: ${surfaces.evidence}`);
});

test("visualFindings localize to measured nodes with repairs that cite them", async () => {
  const out = await workflow.critiqueVisualTool(
    { nodeId: "9:9", visualFindings: [{ area: "center", defect: "hero too quiet", severity: "minor" }] },
    stubCritiqueRegistry(liveTree()),
  );
  const payload = liveCritiquePayload(out);
  assert.equal(payload.findings.length, 1);
  assert.match(payload.findings[0].id, /^vf-[0-9a-f]+$/);
  assert.deepEqual(payload.findings[0].nodeIds, ["9:10"]);
  assert.match(payload.findings[0].repair, new RegExp(`\\[${payload.findings[0].id}\\]`));
});

test("resolution needs a fresh report, and tracks persisting honestly", async () => {
  const registry = stubCritiqueRegistry(liveTree());
  const first = liveCritiquePayload(await workflow.critiqueVisualTool(
    { nodeId: "9:9", visualFindings: [{ area: "center", defect: "hero too quiet", severity: "minor" }] },
    registry,
  ));
  const id = first.findings[0].id;
  const noFresh = liveCritiquePayload(await workflow.critiqueVisualTool(
    { nodeId: "9:9", priorFindings: [{ id }] },
    registry,
  ));
  assert.equal(noFresh.resolution, null, "no fresh report means nothing verifiable");
  assert.match(noFresh.resolutionNote, /re-reported/);
  const again = liveCritiquePayload(await workflow.critiqueVisualTool(
    { nodeId: "9:9", priorFindings: [{ id }], visualFindings: [{ area: "center", defect: "hero too quiet", severity: "minor" }] },
    registry,
  ));
  assert.deepEqual(again.resolution.persisting, [id]);
  assert.deepEqual(again.resolution.resolved, []);
});
