/**
 * Invariants that must hold for *any* input, not just the cases in issue #10.
 *
 * ## Why this file exists
 *
 * Issue #10 was fixed with 43 case tests. Case tests pin the symptom; they do
 * not stop the next contributor from reintroducing the same *class* of defect
 * through a different path. Every bug in that issue shared one root cause: the
 * system asserted success over geometry or evidence it had not actually
 * measured.
 *
 * So each invariant here is stated over generated inputs rather than fixed ones,
 * and each is checked against an **independent oracle** wherever one exists. The
 * path-bounds test is the important one: it drives the bezier-preserving
 * bounding-box code with points produced by the *other*, separately-written
 * flattener, so a bug in one cannot hide inside the other. That is exactly the
 * arrangement that let the arc bounds ship wrong — both the bug and its test
 * used the same code.
 *
 * The generator is seeded rather than `Math.random()`, so a failure is
 * reproducible from the seed printed in the assertion message.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { runGuard, snapshotHasEvidence } from "../mcp-server/dist-test/memory/guard.js";
import {
  parseSvgPath,
  parseVectorSegments,
  segmentsBounds,
  normalizeVectorPath,
  normalizePath,
} from "../mcp-server/dist-test/shared/path.js";

/* -------------------------------------------------------------------------- */
/* Seeded generator                                                            */
/* -------------------------------------------------------------------------- */

/**
 * mulberry32. Small, fast, and identical on every platform, so a CI failure
 * reproduces exactly from the seed the test prints.
 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = [1, 7, 42, 1337, 90210, 5150, 31337, 271828, 161803, 99991];

/** Random number in [min, max). */
const between = (r, min, max) => min + r() * (max - min);
const f = (n) => Math.round(n * 100) / 100;

/**
 * Builds a random but *valid* path: absolute commands only, matching exactly
 * what the parser accepts, with every coordinate finite.
 */
function randomPath(seed) {
  const r = rng(seed);
  const parts = [`M ${f(between(r, -200, 200))} ${f(between(r, -200, 200))}`];
  const kind = seed % 6;
  const moves = 2 + Math.floor(r() * 5);
  let x = 0;
  let y = 0;

  for (let i = 0; i < moves; i++) {
    if (kind === 0 || (kind === 4 && r() < 0.5)) {
      // Cubic
      x = f(between(r, -200, 200));
      y = f(between(r, -200, 200));
      parts.push(
        `C ${f(between(r, -200, 200))} ${f(between(r, -200, 200))} ${f(between(r, -200, 200))} ${f(between(r, -200, 200))} ${x} ${y}`,
      );
    } else if (kind === 1) {
      // Quadratic
      x = f(between(r, -200, 200));
      y = f(between(r, -200, 200));
      parts.push(`Q ${f(between(r, -200, 200))} ${f(between(r, -200, 200))} ${x} ${y}`);
    } else if (kind === 2 || kind === 5) {
      // Elliptical arc — the family that broke issue #10
      const rx = f(between(r, 1, 200));
      const ry = f(between(r, 1, 200));
      x = f(between(r, -200, 200));
      y = f(between(r, -200, 200));
      parts.push(`A ${rx} ${ry} ${f(between(r, 0, 360))} ${r() < 0.5 ? 0 : 1} ${r() < 0.5 ? 0 : 1} ${x} ${y}`);
    } else {
      // Line
      x = f(between(r, -200, 200));
      y = f(between(r, -200, 200));
      parts.push(`L ${x} ${y}`);
    }
  }
  if (r() < 0.4) parts.push("Z");
  return parts.join(" ");
}

/* -------------------------------------------------------------------------- */
/* Invariant 1 — path bounds enclose the geometry they describe                */
/* -------------------------------------------------------------------------- */

/**
 * The oracle is `parseSvgPath`, a separate flattener with its own arc maths.
 * Two independent implementations agreeing is evidence; one implementation
 * checking itself is not.
 */
function oraclePoints(pathData) {
  const parsed = parseSvgPath(pathData);
  return [parsed.winding, ...parsed.regions].flat();
}

test("INV-1: segmentsBounds encloses every point the flattener produces", () => {
  // Tolerance absorbs the cubic approximation in the flattener (sub-0.01px on
  // these spans) without being loose enough to hide a real defect: the issue
  // #10 failures were 25px and 53px out.
  const TOLERANCE = 0.5;

  for (const seed of SEEDS) {
    const path = randomPath(seed);
    let bounds;
    let points;
    try {
      bounds = segmentsBounds(parseVectorSegments(path));
      points = oraclePoints(path);
    } catch {
      // A path the generator produced but the parser rejects is a generator
      // problem, not a bounds problem. Skip rather than assert noise.
      continue;
    }

    for (const p of points) {
      assert.ok(
        p.x >= bounds.minX - TOLERANCE && p.x <= bounds.maxX + TOLERANCE,
        `seed ${seed}: point x=${p.x} escapes the box [${bounds.minX}, ${bounds.maxX}] for path "${path}"`,
      );
      assert.ok(
        p.y >= bounds.minY - TOLERANCE && p.y <= bounds.maxY + TOLERANCE,
        `seed ${seed}: point y=${p.y} escapes the box [${bounds.minY}, ${bounds.maxY}] for path "${path}"`,
      );
    }
  }
});

test("INV-1: bounds are not wildly larger than the geometry (no over-estimation)", () => {
  // An over-estimated box is not a safety net, it is a misplaced node: Figma
  // sizes the node to this box, so slack shows up as a gap around the art.
  const TOLERANCE = 1.5;

  for (const seed of SEEDS) {
    const path = randomPath(seed);
    let bounds;
    let points;
    try {
      bounds = segmentsBounds(parseVectorSegments(path));
      points = oraclePoints(path);
    } catch {
      continue;
    }
    if (points.length < 2) continue;

    const actual = points.reduce(
      (acc, p) => ({
        minX: Math.min(acc.minX, p.x),
        maxX: Math.max(acc.maxX, p.x),
        minY: Math.min(acc.minY, p.y),
        maxY: Math.max(acc.maxY, p.y),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    );

    assert.ok(
      bounds.minX <= actual.minX + TOLERANCE && bounds.maxX >= actual.maxX - TOLERANCE,
      `seed ${seed}: x box [${bounds.minX}, ${bounds.maxX}] is not the geometry's [${actual.minX}, ${actual.maxX}]`,
    );
    assert.ok(
      bounds.minY <= actual.minY + TOLERANCE && bounds.maxY >= actual.maxY - TOLERANCE,
      `seed ${seed}: y box [${bounds.minY}, ${bounds.maxY}] is not the geometry's [${actual.minY}, ${actual.maxY}]`,
    );
  }
});

test("INV-1: both normalisers agree on where the artwork is", () => {
  // `normalizeVectorPath` preserves beziers, `normalizePath` flattens them.
  // They route different call sites, so a disagreement is a shape that renders
  // differently depending on which primitive drew it.
  const TOLERANCE = 1.5;
  for (const seed of SEEDS) {
    const path = randomPath(seed);
    let preserving;
    let flattening;
    try {
      preserving = normalizeVectorPath(path);
      flattening = normalizePath(path);
    } catch {
      continue;
    }
    assert.ok(
      Math.abs(preserving.x - flattening.x) <= TOLERANCE && Math.abs(preserving.y - flattening.y) <= TOLERANCE,
      `seed ${seed}: origin differs — preserving (${preserving.x}, ${preserving.y}) vs flattening (${flattening.x}, ${flattening.y})`,
    );
    assert.ok(
      Math.abs(preserving.width - flattening.width) <= TOLERANCE && Math.abs(preserving.height - flattening.height) <= TOLERANCE,
      `seed ${seed}: size differs — preserving ${preserving.width}x${preserving.height} vs flattening ${flattening.width}x${flattening.height}`,
    );
    assert.ok(preserving.width >= 1 && preserving.height >= 1, "Figma refuses a zero-size node");
  }
});

test("INV-1: the normalized path stays inside its own node box", () => {
  const TOL = 0.5;
  for (const seed of SEEDS) {
    const path = randomPath(seed);
    let normalized;
    let raw;
    try {
      normalized = normalizeVectorPath(path);
      raw = segmentsBounds(parseVectorSegments(path));
    } catch {
      continue;
    }

    // The node is placed at the raw bounds, so shifting by exactly that origin
    // is what makes the local frame start at the artwork's own top-left.
    assert.ok(Math.abs(normalized.x - raw.minX) < 0.01, `seed ${seed}: node x=${normalized.x} but the artwork starts at ${raw.minX}`);
    assert.ok(Math.abs(normalized.y - raw.minY) < 0.01, `seed ${seed}: node y=${normalized.y} but the artwork starts at ${raw.minY}`);

    // Everything drawn must therefore land within the node's own width/height.
    for (const p of oraclePoints(normalized.path)) {
      assert.ok(p.x >= -TOL && p.x <= normalized.width + TOL, `seed ${seed}: normalized x=${p.x} outside 0..${normalized.width}`);
      assert.ok(p.y >= -TOL && p.y <= normalized.height + TOL, `seed ${seed}: normalized y=${p.y} outside 0..${normalized.height}`);
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Invariant 2 — the guard never certifies a screen it did not measure        */
/* -------------------------------------------------------------------------- */

const RULES = [
  { id: "no-chat", rule: "chat is not primary", therefore: "remove chat", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "chat" }] },
  { id: "no-wall", rule: "no card wall", therefore: "replace the cluster", severity: "fail", evidence: [{ kind: "maxNodes", namePattern: "Card", max: 3 }] },
];

test("INV-2: PASS implies the snapshot carried evidence", () => {
  // Exhaustively enumerate the shapes an unresolved snapshot can take. Each
  // one must refuse to PASS.
  const empties = [
    {},
    { nodeNames: [], texts: [], components: [], metrics: {} },
    { metrics: { nodes: 0, textNodes: 0 } },
    { nodeNames: [] },
    { texts: [] },
    { components: [] },
    { composition: undefined, nodeNames: [], texts: [], metrics: { regions: 0, content: 0 } },
    { resolved: false, nodeNames: ["a"], texts: ["b"], metrics: { nodes: 1, textNodes: 1 } },
    { source: "live", resolved: false, unresolvedReason: "empty selection" },
  ];

  for (const snapshot of empties) {
    const result = runGuard(RULES, snapshot);
    assert.notEqual(result.verdict, "PASS", `an empty snapshot produced PASS: ${JSON.stringify(snapshot)}`);
    assert.equal(snapshotHasEvidence(snapshot), false, `snapshotHasEvidence disagreed: ${JSON.stringify(snapshot)}`);
  }
});

test("INV-2: a snapshot with any real content can still PASS", () => {
  // The counterpart, so the invariant is not satisfied by refusing everything.
  const populated = [
    { nodeNames: ["Header"] },
    { texts: ["Cluster"] },
    { components: [{ type: "metric", count: 1 }] },
    { composition: "spatial" },
    { metrics: { nodes: 3 } },
    { metrics: { textNodes: 2 } },
    { metrics: { regions: 1 } },
  ];
  for (const snapshot of populated) {
    const result = runGuard(RULES, { ...snapshot, resolved: true });
    assert.equal(result.verdict, "PASS", `a populated snapshot failed to pass: ${JSON.stringify(snapshot)}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Invariant 3 — bad geometry is always reported                              */
/* -------------------------------------------------------------------------- */

/**
 * The point of the assertion pass: a region off the canvas, or a relation that
 * was not honoured, must surface as a violation. If a generated program
 * produces geometry the assertions reject silently, that is a new instance of
 * issue #10 and the test should say so.
 */
test("INV-3: every region outside the canvas produces a geometry violation", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const count = 2 + Math.floor(r() * 3);
    const canvasW = f(between(r, 800, 2000));
    const canvasH = f(between(r, 600, 1600));

    const regions = Array.from({ length: count }, (_, i) => ({
      fn: "frame",
      id: `r${i}`,
      args: { width: f(between(r, 100, canvasW)), height: f(between(r, 100, canvasH)), grow: r() < 0.5 ? 0 : 1 },
    }));

    const compiled = compileIR({
      canvas: { name: "Generated", width: canvasW, height: canvasH, grid: 8 },
      regions,
      content: [],
      tokens: [],
      relations: [],
    });

    for (const region of compiled.regions) {
      const outside =
        region.x < -1 || region.y < -1 || region.x + region.w > canvasW + 1 || region.y + region.h > canvasH + 1;
      const collapsed = region.w <= 0 || region.h <= 0;
      if (!outside && !collapsed) continue;

      const reported = compiled.violations.some((v) => v.rule === "geometry" && v.message.includes(`'${region.id}'`));
      assert.ok(
        reported,
        `seed ${seed}: region ${region.id} is outside the ${canvasW}x${canvasH} canvas at (${region.x}, ${region.y}, ${region.w}, ${region.h}) and was not reported`,
      );
    }
  }
});

test("INV-3: a relation that resolves off-canvas is reported as a relation violation", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const canvasW = f(between(r, 800, 2000));
    const canvasH = f(between(r, 600, 1600));
    const anchorW = f(between(r, 100, canvasW));
    const sideW = f(between(r, 100, canvasW));
    const gap = f(between(r, 0, 64));

    const compiled = compileIR({
      canvas: { name: "Generated", width: canvasW, height: canvasH, grid: 8 },
      regions: [
        { id: "anchor", role: "content", width: anchorW, height: canvasH, children: [] },
        { id: "side", role: "inspector", width: sideW, height: canvasH, children: [] },
      ],
      content: [],
      tokens: [],
      relations: [{ id: "side", rightOf: "anchor", gap, width: sideW }],
    });

    const side = compiled.regions.find((r2) => r2.id === "side");
    if (side.x + side.w <= canvasW + 1) continue;
    assert.ok(
      compiled.violations.some((v) => v.rule === "relation" && v.message.includes("'side'")),
      `seed ${seed}: side panel ends at ${side.x + side.w} on a ${canvasW}px canvas and no relation violation was raised`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Invariant 4 — a declared node is placed or reported                        */
/* -------------------------------------------------------------------------- */

test("INV-4: every connector endpoint either resolves or is reported by name", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const count = 2 + Math.floor(r() * 3);
    const ids = Array.from({ length: count }, (_, i) => `n${i}`);
    // Deliberately leave some nodes unparented, which is what compile_ir
    // receives from a hand-written IR.
    const parented = r() < 0.5 ? ids : ids.slice(0, Math.max(1, count - 1));

    const ir = {
      canvas: { name: "Generated", width: 1600, height: 1100, grid: 8 },
      regions: [{ id: "map", role: "primary-visual", composition: "topology", children: parented }],
      content: [
        ...ids.map((id) => ({ kind: "component", id, type: "deviceNode", props: { label: id } })),
        { kind: "connector", id: "edge", from: ids[0], to: ids[ids.length - 1] },
      ],
      tokens: [],
      relations: [],
    };

    const compiled = compileIR(ir);

    // Every declared id is placed, because unparented content is adopted.
    for (const id of ids) {
      assert.ok(compiled.boxes.has(id), `seed ${seed}: declared node ${id} was neither placed nor reported`);
    }
    assert.deepEqual(
      compiled.violations.filter((v) => v.rule === "connector"),
      [],
      `seed ${seed}: a connector between declared, now-placed nodes failed to resolve`,
    );
  }
});

test("INV-4: a connector naming an undeclared node says so precisely", () => {
  const compiled = compileIR({
    canvas: { name: "Generated", width: 1600, height: 1100, grid: 8 },
    regions: [{ id: "map", role: "content", children: ["a"] }],
    content: [
      { kind: "component", id: "a", type: "deviceNode", props: {} },
      { kind: "connector", id: "edge", from: "a", to: "does-not-exist" },
    ],
    tokens: [],
    relations: [],
  });
  const message = compiled.violations.filter((v) => v.rule === "connector").map((v) => v.message).join(" ");
  assert.match(message, /'does-not-exist' \(not declared anywhere in this IR\)/);
});

/* -------------------------------------------------------------------------- */
/* Invariant 5 — "applicable" means the geometry is actually drawable          */
/* -------------------------------------------------------------------------- */

test("INV-5: an applicable plan has every region inside the canvas", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const canvasW = f(between(r, 800, 2000));
    const canvasH = f(between(r, 600, 1600));
    const count = 2 + Math.floor(r() * 3);

    const regions = Array.from({ length: count }, (_, i) => ({
      id: `r${i}`,
      role: i === 0 ? "navigation" : "content",
      width: i === 0 ? f(between(r, 120, 360)) : r() < 0.5 ? "fill" : f(between(r, 200, canvasW)),
      height: r() < 0.5 ? "fill" : f(between(r, 120, canvasH)),
      children: [],
    }));

    const compiled = compileIR({
      canvas: { name: "Generated", width: canvasW, height: canvasH, grid: 8 },
      regions,
      content: [],
      tokens: [],
      relations: [],
    });

    if (!compiled.applicable) {
      assert.ok(compiled.inapplicableReasons.length > 0, `seed ${seed}: inapplicable with no reason`);
      continue;
    }

    for (const region of compiled.regions) {
      assert.ok(
        region.x >= -1 && region.y >= -1 && region.x + region.w <= canvasW + 1 && region.y + region.h <= canvasH + 1,
        `seed ${seed}: plan marked applicable but region ${region.id} sits at (${region.x},${region.y}) ${region.w}x${region.h} on a ${canvasW}x${canvasH} canvas`,
      );
      assert.ok(region.w > 0 && region.h > 0, `seed ${seed}: applicable plan contains a collapsed region ${region.id}`);
    }
  }
});

test("INV-5: an applicable plan satisfies every declared relation", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const canvasW = f(between(r, 900, 2000));
    const canvasH = f(between(r, 600, 1600));

    const compiled = compileIR({
      canvas: { name: "Generated", width: canvasW, height: canvasH, grid: 8 },
      regions: [
        { id: "body", role: "content", width: f(between(r, 200, canvasW * 0.6)), height: canvasH, children: [] },
        { id: "side", role: "inspector", width: f(between(r, 120, 400)), height: canvasH, children: [] },
      ],
      content: [],
      tokens: [],
      relations: [{ id: "side", rightOf: "body", gap: f(between(r, 0, 40)), width: f(between(r, 120, 400)) }],
    });

    if (!compiled.applicable) continue;

    const body = compiled.regions.find((x) => x.id === "body");
    const side = compiled.regions.find((x) => x.id === "side");
    const gap = side.x - (body.x + body.w);
    assert.ok(gap >= -1, `seed ${seed}: applicable plan overlaps body and side by ${-gap}px`);
    assert.ok(side.x >= body.x - 1, `seed ${seed}: applicable plan put 'side' left of its anchor`);
  }
});

test("INV-5: the operation trace and the resolved boxes never disagree", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const compiled = compileIR({
      canvas: { name: "Generated", width: 1600, height: 1000, grid: 8 },
      regions: [
        { id: "nav", role: "navigation", width: f(between(r, 120, 300)), height: "fill", children: ["t1", "m1"] },
        { id: "body", role: "content", width: "fill", height: "fill", children: ["t2"] },
      ],
      content: [
        { kind: "text", id: "t1", text: "Machines" },
        { kind: "component", id: "m1", type: "metric", props: { label: "GPUs", value: "8" } },
        { kind: "text", id: "t2", text: "Topology" },
      ],
      tokens: [],
      relations: [],
    });

    const trace = compiled.violations.filter((v) => v.rule === "operation-trace");
    assert.deepEqual(trace, [], `seed ${seed}: operation trace disagrees with resolved geometry`);
    assert.equal(compiled.stats.traceMismatches, 0, `seed ${seed}: ${compiled.stats.traceMismatches} trace mismatch(es)`);
  }
});

test("INV-5: content is never placed outside the region that owns it", () => {
  for (const seed of SEEDS) {
    const r = rng(seed);
    const canvasW = f(between(r, 1200, 2000));
    const canvasH = f(between(r, 900, 1600));
    const compiled = compileIR({
      canvas: { name: "Generated", width: canvasW, height: canvasH, grid: 8 },
      regions: [
        { id: "body", role: "content", width: f(between(r, 400, canvasW - 200)), height: f(between(r, 300, canvasH - 200)), children: ["t1", "m1", "p1"] },
      ],
      content: [
        { kind: "text", id: "t1", text: "Machines" },
        { kind: "component", id: "m1", type: "metric", props: { label: "GPUs", value: "8" } },
        { kind: "component", id: "p1", type: "statusPill", props: { label: "Online", tone: "healthy" } },
      ],
      tokens: [],
      relations: [],
    });

    const escaped = compiled.violations.filter((v) => v.rule === "containment");
    assert.deepEqual(
      escaped,
      [],
      `seed ${seed}: content escaped its region: ${escaped.map((v) => v.message).join(" | ")}`,
    );
  }
});