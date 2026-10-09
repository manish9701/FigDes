/**
 * figdes builder tests (quality-reliability P0).
 *
 * `connect()` computed absolute centers but positioned the line before
 * appending it, so absolute values were reinterpreted as parent-local and
 * every connector parked far outside its field — invisible edges reported as
 * overflow on a correct-looking screen. These tests pin append-then-position
 * with a faithful fake Figma API.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFigdesBuilder } from "../mcp-server/dist-test/builder/builder.js";

let seq = 0;
function node(over = {}) {
  const n = {
    id: `n${++seq}`,
    type: "FRAME",
    name: "Node",
    x: 0, y: 0, width: 100, height: 100,
    children: [],
    parent: null,
    rotation: 0,
    strokes: [],
    strokeWeight: 1,
    fills: [],
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    resize(w, h) { n.width = w; n.height = h; },
    ...over,
  };
  Object.defineProperty(n, "absoluteBoundingBox", {
    configurable: true,
    get() {
      let x = n.x ?? 0, y = n.y ?? 0;
      let p = n.parent;
      while (p) { x += p.x ?? 0; y += p.y ?? 0; p = p.parent; }
      return { x, y, width: n.width ?? 0, height: n.height ?? 0 };
    },
  });
  return n;
}

function fakeFigma() {
  const page = node({ id: "PAGE", type: "PAGE", name: "Page", width: 3000, height: 2000 });
  return {
    currentPage: page,
    createFrame: () => node({ type: "FRAME", name: "Frame" }),
    createLine: () => node({ type: "LINE", name: "Line", width: 1, height: 0 }),
    loadFontAsync: async () => {},
  };
}

test("connect lands the line at parent-local coordinates inside its field", () => {
  const figma = fakeFigma();
  const figdes = createFigdesBuilder(figma);
  // Root far from the page origin, like a real file with prior screens.
  const root = figdes.frame({ name: "Root", x: 1560, y: 0, width: 1440, height: 900 });
  figma.currentPage.appendChild(root);
  const map = figdes.frame({ name: "Map", parent: root, x: 256, y: 112, width: 824, height: 600 });
  const a = figdes.frame({ name: "A", parent: map, x: 44, y: 254, width: 150, height: 92 });
  const b = figdes.frame({ name: "B", parent: map, x: 304, y: 100, width: 160, height: 92 });

  const line = figdes.connect(a, b, { parent: map });

  assert.equal(line.parent, map, "line is parented to the field");
  // Hub center rel-to-map: (44+75, 254+46) = (119, 300). Absolute would be 1935.
  assert.ok(Math.abs(line.x - 119) < 1, `line x is parent-local, got ${line.x}`);
  assert.ok(Math.abs(line.y - 300) < 1, `line y is parent-local, got ${line.y}`);
  const inside =
    line.x >= -0.5 && line.y >= -0.5 &&
    line.x <= map.width && line.y <= map.height;
  assert.ok(inside, "connector starts inside its field");
});

test("connect without an explicit parent uses page coordinates", () => {
  const figma = fakeFigma();
  const figdes = createFigdesBuilder(figma);
  const a = figdes.frame({ name: "A", x: 100, y: 100, width: 50, height: 50 });
  figma.currentPage.appendChild(a);
  const b = figdes.frame({ name: "B", x: 300, y: 100, width: 50, height: 50 });
  figma.currentPage.appendChild(b);
  const line = figdes.connect(a, b);
  assert.equal(line.parent, figma.currentPage);
  assert.ok(Math.abs(line.x - 125) < 1 && Math.abs(line.y - 125) < 1, `page-level line starts at the midpoint origin, got ${line.x},${line.y}`);
});
