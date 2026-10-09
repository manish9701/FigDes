import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

/* -------------------------------------------------------------------------- */
/* Phase 2 P0 regressions: found by rendering real Figma challenges (P1 set)   */
/* -------------------------------------------------------------------------- */

const GRID = 8;

function topologyProgram(overrides = {}) {
  return {
    canvas: { name: "repro", width: 1440, height: 900, grid: GRID },
    regions: [
      { fn: "frame", id: "rail", args: { width: "fill", height: 56, gap: 24, padding: 16, composition: "instrument" } },
      { fn: "hero", id: "map", args: { width: "fill", height: "fill", grow: 1, gap: 32, padding: 24, composition: "topology" } },
    ],
    content: [
      { fn: "statusPill", parent: "rail", id: "pill-a", args: { label: "12 machines", tone: "healthy" } },
      { fn: "statusPill", parent: "rail", id: "pill-b", args: { label: "2 need attention", tone: "warning" } },
      { fn: "deviceNode", parent: "map", id: "hub", args: { label: "hub-01", health: "healthy" } },
      { fn: "deviceNode", parent: "map", id: "n1", args: { label: "edge-01", health: "degraded" } },
    ],
    links: [{ from: "hub", to: "n1", label: "8us" }],
    visualIntent: { focal: "map", visualWeight: { map: 0.9, rail: 0.15 } },
    ...overrides,
  };
}

test("top-level links draw connectors instead of only positioning nodes", () => {
  const out = executeRuntime(topologyProgram());
  const vectors = out.operations.filter((o) => o.type === "createVector");
  assert.equal(vectors.length, 1);
  assert.ok(vectors[0].name.includes("hub") && vectors[0].name.includes("n1"));
  const labels = out.operations.filter((o) => o.type === "createText" && o.content === "8us");
  assert.equal(labels.length, 1, "link label is drawn on the edge, not dropped");
});

test("a hand-written connector for the same pair wins over synthesis", () => {
  const program = topologyProgram();
  program.content.push({ fn: "connector", parent: "map", id: "hand", args: { from: "hub", to: "n1", label: "hand-drawn" } });
  const out = executeRuntime(program);
  const vectors = out.operations.filter((o) => o.type === "createVector");
  assert.equal(vectors.length, 1, "no duplicate edge");
  assert.equal(vectors[0].id, "hand");
});

test("a link to a missing node is a violation, never a silent drop", () => {
  const program = topologyProgram();
  program.links = [{ from: "hub", to: "ghost" }];
  const out = executeRuntime(program);
  assert.ok(out.violations.some((v) => v.rule === "connector" && v.message.includes("ghost")));
  assert.equal(out.operations.filter((o) => o.type === "createVector").length, 0);
});

test("root defaults to a light fill so exports never render black", () => {
  const out = executeRuntime(topologyProgram());
  const root = out.operations.find((o) => o.id === "root");
  assert.equal(root.fill, "#FFFFFF");
});

test("an explicit canvas fill still wins over the default", () => {
  const program = topologyProgram();
  program.canvas.fill = "#FAF6EF";
  const out = executeRuntime(program);
  assert.equal(out.operations.find((o) => o.id === "root").fill, "#FAF6EF");
});

test("a status rail lays pills in columns on any screen composition", () => {
  const out = executeRuntime(topologyProgram());
  const pills = ["pill-a", "pill-b"].map((id) => out.boxes.get(id));
  assert.ok(pills[0] && pills[1]);
  // Same row: the rail is 56px tall, so a single column would overflow it.
  assert.ok(Math.abs(pills[0].y - pills[1].y) < 1, `pills stacked vertically: ${JSON.stringify(pills)}`);
  assert.ok(pills[1].x > pills[0].x, "second pill sits beside the first");
});

test("product-language states map onto tones instead of falling neutral", () => {
  const program = {
    canvas: { name: "repro", width: 1440, height: 900, grid: GRID },
    regions: [{ fn: "frame", id: "content", args: { width: "fill", height: "fill", composition: "table" } }],
    content: [
      { fn: "modelRow", parent: "content", args: { title: "a", status: "fits", memory: "4 GB" } },
      { fn: "modelRow", parent: "content", args: { title: "b", status: "insufficient memory", memory: "26 GB" } },
      { fn: "modelRow", parent: "content", args: { title: "c", status: "stale", memory: "?" } },
    ],
  };
  const out = executeRuntime(program);
  const texts = out.operations.filter((o) => o.type === "createText" && ["fits", "insufficient memory", "stale"].includes(o.content));
  assert.equal(texts.length, 3);
  const fillOf = (content) => texts.find((t) => t.content === content).fill;
  assert.equal(fillOf("fits"), "#1E6B3A", "fits reads as success");
  assert.equal(fillOf("insufficient memory"), "#A32A12", "insufficient reads as error");
  assert.equal(fillOf("stale"), "#8A5200", "stale reads as warning");
});

test("deviceNode accepts status as an alias for health", () => {
  const program = topologyProgram();
  program.content = [
    { fn: "deviceNode", parent: "map", id: "hub", args: { label: "hub-01", status: "degraded" } },
  ];
  program.links = [];
  const out = executeRuntime(program);
  const frame = out.operations.find((o) => o.id === "hub" && o.type === "createFrame");
  assert.equal(frame.stroke, "#8A5200", "status degraded strokes the node");
});

test("an unrecognised state stays neutral instead of inventing meaning", () => {
  const program = topologyProgram();
  program.content = [
    { fn: "statusPill", parent: "rail", args: { label: "mystery", tone: "transmogrified" } },
  ];
  program.links = [];
  const out = executeRuntime(program);
  const label = out.operations.find((o) => o.type === "createText" && o.content === "mystery");
  assert.equal(label.fill, "#5A5C54", "unknown tone falls back to neutral");
});
