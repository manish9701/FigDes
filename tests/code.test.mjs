/**
 * Design-to-code export tests.
 *
 * The claims under test:
 *   1. The mapping is total: auto-layout becomes flex, text becomes tags, every
 *      value traces to a measured property.
 *   2. The mapping is deterministic: the same frame always emits the same
 *      component, so regenerating diffs cleanly.
 *   3. Nothing is invented: no responsive behaviour, no component boundaries
 *      beyond what the file declares, and the limitations are stated.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exportCode } from "../mcp-server/dist-test/code/export.js";

const FRAME = (overrides = {}) => ({
  id: "1:1",
  parentId: null,
  type: "FRAME",
  name: "Dashboard",
  depth: 0,
  x: 0,
  y: 0,
  w: 1440,
  h: 900,
  visible: true,
  defaultNamed: false,
  zIndex: 0,
  ...overrides,
});

const TEXT = (overrides = {}) => ({
  id: "1:2",
  parentId: "1:1",
  type: "TEXT",
  name: "Title",
  depth: 1,
  x: 24,
  y: 24,
  w: 400,
  h: 40,
  visible: true,
  defaultNamed: false,
  zIndex: 0,
  text: { content: "Compute", length: 7, truncated: false, size: 32, family: "Inter", style: "SemiBold", color: "#242521", styled: false },
  ...overrides,
});

test("an auto-layout frame becomes flex with gaps and padding", () => {
  const result = exportCode([
    FRAME({ layoutMode: "VERTICAL", itemSpacing: 16, padding: { top: 24, right: 24, bottom: 24, left: 24 } }),
    TEXT(),
  ]);

  assert.match(result.tsx, /flex flex-col/);
  assert.match(result.tsx, /gap-\[16px\]/);
  assert.match(result.tsx, /p-\[24px\]/);
  assert.match(result.tsx, /<h1 className="[^"]*text-\[32px\][^"]*">Compute<\/h1>/);
});

test("colours become custom properties, not scattered hexes", () => {
  const result = exportCode([FRAME({ fill: "#FFFDF9" }), TEXT()]);

  assert.match(result.tsx, /bg-\[var\(--color-0\)\]/);
  assert.match(result.css, /--color-0: #fffdf9/i);
  assert.equal(result.stats.colors, 2, "frame fill plus text colour");
  assert.ok(!result.tsx.includes("#FFFDF9") && !result.tsx.includes("#242521"), "no raw hex may remain in the tsx");
});

test("a mono family maps to font-mono and weights map to Tailwind", () => {
  const result = exportCode([
    FRAME(),
    TEXT({ text: { content: "8 us", length: 4, truncated: false, size: 12, family: "JetBrains Mono", style: "Regular", color: "#666666", styled: false } }),
  ]);

  assert.match(result.tsx, /font-mono/);
  assert.match(result.tsx, /font-normal/);
});

test("absolute frames position children absolutely", () => {
  const result = exportCode([FRAME({ layoutMode: "NONE" }), TEXT({ x: 100, y: 50 })]);

  assert.match(result.tsx, /absolute left-\[100px\] top-\[50px\]/);
});

test("text content is JSX-escaped", () => {
  const result = exportCode([
    FRAME(),
    TEXT({ text: { content: "<b>{x}</b> & co", length: 12, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#111111", styled: false } }),
  ]);

  assert.match(result.tsx, /&lt;b&gt;&#123;x&#125;&lt;\/b&gt; &amp; co/);
  assert.ok(!result.tsx.includes("<b>{x}</b>"), "raw HTML must never reach the output");
});

test("the export is deterministic across runs", () => {
  const nodes = [FRAME({ layoutMode: "VERTICAL", itemSpacing: 8 }), TEXT()];
  assert.equal(exportCode(nodes).tsx, exportCode(nodes).tsx);
});

test("deep trees truncate with a count, not a crash", () => {
  const nodes = [FRAME()];
  for (let i = 0; i < 40; i++) {
    nodes.push({ ...TEXT(), id: `1:${i + 2}`, parentId: "1:1" });
  }
  const result = exportCode(nodes, { maxNodes: 10 });
  assert.equal(result.stats.truncated, true);
  assert.ok(result.stats.nodes > 10);
});

test("invisible nodes are skipped", () => {
  const result = exportCode([FRAME(), TEXT({ visible: false })]);
  assert.equal(result.stats.textNodes, 0);
  assert.ok(!result.tsx.includes("Compute"));
});

test("the component name follows the frame", () => {
  const result = exportCode([FRAME({ name: "exo home v2" })]);
  assert.equal(result.componentName, "ExoHomeV2");
  assert.match(result.tsx, /export function ExoHomeV2\(\)/);
});
