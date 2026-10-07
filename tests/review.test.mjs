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