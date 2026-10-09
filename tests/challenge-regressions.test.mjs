import { test } from "node:test";
import assert from "node:assert/strict";

import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { ReviewArgs } from "../mcp-server/dist-test/tools/tools.js";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { compositionSignature, detectTemplateCollapse } from "../mcp-server/dist-test/design/composition/similarity.js";

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

test("rows stack full-width instead of gridding into cards", () => {
  const out = executeRuntime({
    canvas: { name: "repro", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "content", args: { width: "fill", height: "fill", composition: "table" } },
    ],
    content: [
      { fn: "modelRow", parent: "content", args: { title: "a", status: "fits", memory: "4 GB" } },
      { fn: "modelRow", parent: "content", args: { title: "b", status: "fits", memory: "5 GB" } },
      { fn: "modelRow", parent: "content", args: { title: "c", status: "stale", memory: "6 GB" } },
    ],
  });
  const rows = ["a", "b", "c"].map((t) => [...out.boxes.values()].find((b) => {
    const op = out.operations.find((o) => o.id === b.id && o.type === "createFrame");
    return op && String(op.name).includes(t);
  }));
  assert.ok(rows.every(Boolean));
  // Same x (one column), strictly increasing y (stacked, not gridded).
  assert.ok(Math.abs(rows[0].x - rows[1].x) < 1 && Math.abs(rows[1].x - rows[2].x) < 1);
  assert.ok(rows[0].y < rows[1].y && rows[1].y < rows[2].y);
  assert.ok(rows[0].w > 700, "rows span the region width");
});

test("graph nodes pitch by node size so the fan never collapses", () => {
  const out = executeRuntime(topologyProgram());
  const hub = out.boxes.get("hub");
  const n1 = out.boxes.get("n1");
  // 128px-wide nodes need 128px+ of horizontal pitch to avoid overlap.
  assert.ok(Math.abs(hub.x - n1.x) > 100 || Math.abs(hub.y - n1.y) > 60,
    `hub ${JSON.stringify(hub)} n1 ${JSON.stringify(n1)} overlap by construction`);
  const boxes = [hub, n1].filter(Boolean);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
      const overlapY = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
      assert.ok(overlapX < 4 || overlapY < 4, `nodes overlap: ${a.id} vs ${b.id}`);
    }
  }
});

test("multi-screen flow: different tasks get different grammars, one product", () => {
  // Screen A: choose the model. Screen B: watch the chosen model run. The
  // selection (llama-3-8b) is handed explicitly — continuity is a contract,
  // not something the planner may invent or drop.
  const select = planScreen({
    primaryDecision: "select a model",
    audience: "engineer",
    availableInformation: ["model name", "memory", "fit state"],
  });
  const monitor = planScreen({
    primaryDecision: "monitor the inference run",
    audience: "operator",
    availableInformation: ["throughput", "latency", "selected model llama-3-8b"],
  });
  assert.notEqual(select.composition, monitor.composition, "one journey, two grammars");

  const toSignature = (screenId, taskKey, plan) => compositionSignature({
    screenId,
    frame: { width: plan.intent.canvas.width, height: plan.intent.canvas.height },
    regions: plan.boxes.map((b) => {
      const region = plan.regions.find((r) => r.id === b.name);
      return { id: b.name, role: region?.role ?? "content", x: b.x, y: b.y, width: b.w, height: b.h };
    }),
  });
  const collapse = detectTemplateCollapse([
    { screenId: "select", taskKey: "choose a model", signature: toSignature("select", "choose", select) },
    { screenId: "monitor", taskKey: "watch the run", signature: toSignature("monitor", "watch", monitor) },
  ]);
  assert.equal(collapse.collapsed, false, "coherence is not sameness");

  // The selection survives the handoff verbatim.
  assert.ok(
    monitor.intent.availableInformation?.some((i) => i.includes("llama-3-8b")),
    "the chosen model must travel into the monitoring screen",
  );
  // Both screens name the decision they serve.
  assert.ok(select.regions.some((r) => r.because.includes("model name")));
});

test("review_design accepts nodeId as a target alias instead of mistargeting", () => {
  // The live defect: passing nodeId (every other visual tool's shape) was
  // silently dropped, so the review measured the selection instead of the
  // requested frame — wrong evidence behind a correct-looking report.
  const byNodeId = ReviewArgs.safeParse({ nodeId: "171:1287" });
  assert.equal(byNodeId.success, true, "nodeId must parse");
  const byTarget = ReviewArgs.safeParse({ target: "171:1287", nodeId: "1:1" });
  assert.equal(byTarget.success, true);
  if (byTarget.success) assert.equal(byTarget.data.target, "171:1287", "target wins over the alias");
});

test("regions grow to fit content and shift siblings instead of overflowing", () => {
  // The live defect: a 24px headline in a 72px header spilled into the region
  // below and read as clipped. Regions now extend; nothing below is touched.
  const out = executeRuntime({
    canvas: { name: "repro", width: 1440, height: 900, grid: 8 },
    regions: [
      { fn: "frame", id: "nav", args: { width: 240, height: "fill", composition: "instrument" } },
      { fn: "frame", id: "header", args: { width: "fill", height: 72, padding: 24, composition: "editorial" } },
      { fn: "frame", id: "content", args: { width: "fill", height: "fill", grow: 1, gap: 16, padding: 24, composition: "table" } },
    ],
    content: [
      { fn: "text", parent: "header", args: { text: "Select a model that fits the edge cluster and its accelerators", size: 24, role: "title" } },
      { fn: "modelRow", parent: "content", args: { title: "a", status: "fits", memory: "4 GB" } },
    ],
  });
  const header = out.boxes.get("header");
  const content = out.boxes.get("content");
  const title = [...out.boxes.values()].find((b) => b.id !== "header" && b.y >= header.y && b.y < content.y);
  assert.ok(header.h >= 72, "regions only grow, never shrink");
  assert.ok(title.y + title.h <= header.y + header.h, "title sits inside the grown header");
  assert.ok(content.y >= header.y + header.h, "content starts below the grown header");
  // The emitted frame ops match the final geometry, not the declared kind.
  const headerOp = out.operations.find((o) => o.id === "header" && o.type === "createFrame");
  assert.equal(headerOp.height, header.h);
  assert.equal(headerOp.y, header.y);
});
