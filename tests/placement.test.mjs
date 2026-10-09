import { test } from "node:test";
import assert from "node:assert/strict";

import { placeRootFrame, PLACEMENT_GAP } from "../mcp-server/dist-test/runtime/placement.js";

/* -------------------------------------------------------------------------- */
/* Root-frame auto-placement: free canvas, never the pile at (0,0)              */
/* -------------------------------------------------------------------------- */

const disjoint = (frames, candidate) =>
  frames.every(
    (f) =>
      candidate.x + candidate.w <= f.x ||
      f.x + f.w <= candidate.x ||
      candidate.y + candidate.h <= f.y ||
      f.y + f.h <= candidate.y,
  );

test("empty page builds at the origin", () => {
  const p = placeRootFrame([], 1440, 900);
  assert.deepEqual([p.x, p.y], [0, 0]);
});

test("second screen goes right with a gap, never overlapping", () => {
  const existing = [{ x: 0, y: 0, w: 1440, h: 900 }];
  const p = placeRootFrame(existing, 1440, 900);
  assert.equal(p.x, 1440 + PLACEMENT_GAP);
  assert.equal(p.y, 0);
  assert.ok(disjoint(existing, { ...p, w: 1440, h: 900 }), "must not intersect");
});

test("third screen clears both predecessors", () => {
  const existing = [
    { x: 0, y: 0, w: 1440, h: 900 },
    { x: 1680, y: 0, w: 1440, h: 900 },
  ];
  const p = placeRootFrame(existing, 1440, 900);
  assert.ok(disjoint(existing, { ...p, w: 1440, h: 900 }));
  assert.ok(p.x >= 1680 + 1440, `lands right of both: x=${p.x}`);
});

test("a full row wraps below instead of running off-canvas", () => {
  const existing = [{ x: 0, y: 0, w: 11000, h: 900 }];
  const p = placeRootFrame(existing, 1440, 900);
  assert.ok(p.y >= 900, `new row below: y=${p.y}`);
  assert.ok(disjoint(existing, { ...p, w: 1440, h: 900 }));
});

test("zero-area and degenerate frames never block placement", () => {
  const p = placeRootFrame(
    [
      { x: 0, y: 0, w: 0, h: 0 },
      { x: 5000, y: 5000, w: -10, h: 900 },
    ],
    1440,
    900,
  );
  assert.deepEqual([p.x, p.y], [0, 0]);
});

test("placement holds across a crowded page (property check)", () => {
  const existing = [];
  let cursor = 0;
  for (let i = 0; i < 12; i++) {
    const w = 800 + ((i * 137) % 900);
    existing.push({ x: cursor, y: 0, w, h: 900 });
    cursor += w + PLACEMENT_GAP;
  }
  for (const [w, h] of [[1440, 900], [800, 600], [1920, 1080]]) {
    const p = placeRootFrame(existing, w, h);
    assert.ok(disjoint(existing, { ...p, w, h }), `overlaps at ${p.x},${p.y} for ${w}x${h}`);
    existing.push({ x: p.x, y: p.y, w, h });
  }
});
