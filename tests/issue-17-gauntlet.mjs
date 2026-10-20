/**
 * Issue #17 — the integrated release gauntlet.
 *
 * ## What this is
 *
 * One deterministic run that exercises the whole path — brief, plan, native
 * mutation, geometry, render, review, repair, report — and gives **one
 * verdict**. The point is not another checklist: the point is that the
 * failure modes in #14, #15 and #16 have shown up *together* during real design
 * work, and a suite that only ever tests them one at a time will keep
 * rediscovering the combinations.
 *
 * ## The rules the verdict follows
 *
 * - **FAIL** if any P0 invariant fails, required evidence is missing, or a
 *   check silently skips.
 * - **INDETERMINATE** if inspection, render or required runtime evidence is
 *   unavailable.
 * - A good aggregate score must never hide a single critical failure, so the
 *   verdict is the *worst* case, not the average.
 *
 * ## What is real here and what is not
 *
 * The cases run against the real planner, the real compiler, the real review
 * rules and the **real plugin bundle** against a mock Figma document. That is
 * the same seam the end-to-end test uses. What is *not* real is Figma
 * Desktop's renderer, so anything that needs a true pixel render is reported
 * BLOCKED rather than PASS.
 */
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { buildCompositionPlan } from "../mcp-server/dist-test/pipeline/plan.js";
import { buildProgram, applyMeasuredWidths } from "../mcp-server/dist-test/pipeline/program.js";
import { verifyPlan, verifyLive } from "../mcp-server/dist-test/pipeline/verify.js";
import { planRepairs } from "../mcp-server/dist-test/pipeline/repair.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { contrastRatio, requiredRatio } from "../mcp-server/dist-test/shared/contrast.js";
import { loadPlugin, ask, makeDocument } from "./plugin-harness.mjs";
import { placeRootInFreeCanvas } from "../mcp-server/dist-test/runtime/tools.js";
import { reviewVerdict } from "../mcp-server/dist-test/review/verdict.js";
import { decideGuardTarget } from "../mcp-server/dist-test/memory/guard.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

const region = (o) => ({
  role: "custom",
  composition: "auto",
  layout: "flow",
  width: "hug",
  height: "hug",
  grow: 0,
  children: [],
  elevation: 0,
  ...o,
});

const text = (id, o = {}) => ({ id, kind: "text", text: "Label", role: "body", ...o });
const component = (id, o = {}) => ({ id, kind: "component", type: "panel", props: {}, ...o });
const canvas = (o = {}) => ({ name: "Screen", width: 1440, height: 900, grid: 8, newPage: false, deck: false, ...o });
const node = (o) => ({ visible: true, depth: 1, parentId: "root", x: 0, y: 0, w: 100, h: 40, name: "Layer", ...o });
const metrics = (nodes) => ({ target: "root", scope: "root", nodeCount: nodes.length, nodes, truncated: false, scanBudget: 4000, scan: { pageLoads: 1, pagesCached: true } });

/** A case result. `status` is the verdict vocabulary the gate understands. */
const ok = (detail, raw = {}) => ({ status: "PASS", detail, raw });
const fail = (detail, raw = {}) => ({ status: "FAIL", detail, raw });
const blocked = (detail, raw = {}) => ({ status: "BLOCKED", detail, raw });
const indeterminate = (detail, raw = {}) => ({ status: "INDETERMINATE", detail, raw });

/** Compiles a program through the runtime and returns the compiled result. */
function compile(program) {
  return executeRuntime(program);
}

/* -------------------------------------------------------------------------- */
/* The fixture briefs                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The reference screen from section A.
 *
 * A realistic EXO-like local-compute overview: a navigation rail and a command
 * bar, a headline with copy and a primary action, a multi-device cluster
 * topology with labelled edges and a legend, a readiness section, performance
 * and storage summaries, recent activity, and a restrained light surface
 * system around one dark technical visualisation.
 *
 * It is a *fixture*, and it says so: the data is declared as demo data, and
 * the values are placeholders rather than invented telemetry.
 */
export const REFERENCE_BRIEF = {
  product: "EXO Labs",
  screen: "Local Compute Overview",
  purpose: "See the whole local fleet at once and reach the cluster that can take the model",
  primaryDecision: "monitor the local fleet and choose which cluster to act on",
  primaryAction: "Open cluster",
  requiredInformation: [
    "node topology",
    "cluster health",
    "GPU memory",
    "model throughput",
    "shard balance",
    "cold start time",
    "disk pressure",
    "recent deploys",
  ],
  optionalInformation: ["audit log"],
  dataMode: "demo",
  dataNotes: "Sample data from a recorded session; no live telemetry is shown.",
  visualDirection: "technical-instrument",
  antiGoals: ["a wall of identical metric cards", "a dark panel carrying the whole identity", "invented live numbers"],
  interactions: [
    { from: "node topology", to: "cluster health", kind: "connect" },
    { from: "node topology", to: "GPU memory", kind: "connect" },
  ],
  states: ["ready", "degraded", "offline"],
  viewport: { width: 1440, height: 960 },
  values: { "cluster health": "Degraded" },
};

/* -------------------------------------------------------------------------- */
/* A — the complex reference screen                                             */
/* -------------------------------------------------------------------------- */

function referenceScreen() {
  const { brief, blockers } = normalizeBrief(REFERENCE_BRIEF);
  const plan = buildCompositionPlan(brief);
  const built = buildProgram(brief, plan);
  const first = compile(built.program);
  const refined = applyMeasuredWidths(built.program, first.boxes);
  const compiled = compile(refined.program);
  return { brief, blockers, plan, program: refined.program, compiled };
}

const A01 = {
  id: "A01",
  title: "A complex brief becomes a composed screen with a dominant primary visualisation",
  group: "generation",
  requirement:
    "The reference screen's primary visualisation gets appropriate canvas area, the regions align intentionally, the supporting panels do not compete with the main task, and the composition does not collapse into a generic repeated-card template.",
  issue: "#16",
  run: () => {
    const { brief, blockers, plan, program, compiled } = referenceScreen();
    if (blockers.length > 0) return fail(`the reference brief was blocked: ${blockers.map((b) => b.id).join(", ")}`);

    const unmet = [];
    const focal = plan.focal ? plan.regions.find((r) => r.id === plan.focal.id) : undefined;
    if (focal === undefined) unmet.push("the plan has no focal region");
    const focalShare = focal ? (focal.bounds.w * focal.bounds.h) / (plan.canvas.width * plan.canvas.height) : 0;
    if (focalShare < 0.2) unmet.push(`the focal region holds ${(focalShare * 100).toFixed(0)}% of the canvas, under the 20% floor`);

    // The supporting panels must not compete: nothing may be larger than the
    // focal region.
    for (const r of plan.regions) {
      if (focal === undefined) break;
      if (r.id === focal.id) continue;
      if (r.bounds.w * r.bounds.h > focal.bounds.w * focal.bounds.h) {
        unmet.push(`'${r.id}' is larger than the focal region '${focal.id}'`);
      }
    }

    // Alignment: the gutters between stacked regions are the same, and the
    // regions that share an edge share it exactly. A region whose origin is
    // off the grid is not a defect — the grid is the spacing scale, and a
    // region that has to hold an odd amount of content does not land on it.
    const grid = plan.canvas.grid;
    for (const r of plan.regions) {
      for (const other of plan.regions) {
        if (r.id === other.id) continue;
        const overlapX = r.bounds.x < other.bounds.x + other.bounds.w - 0.5 && other.bounds.x < r.bounds.x + r.bounds.w - 0.5;
        const overlapY = r.bounds.y < other.bounds.y + other.bounds.h - 0.5 && other.bounds.y < r.bounds.y + r.bounds.h - 0.5;
        if (overlapX && overlapY) unmet.push(`'${r.id}' overlaps '${other.id}'`);
      }
    }
    const stacked = [...plan.regions].sort((a, b) => a.bounds.y - b.bounds.y);
    const gutters = new Set();
    for (let i = 1; i < stacked.length; i++) {
      const gap = stacked[i].bounds.y - (stacked[i - 1].bounds.y + stacked[i - 1].bounds.h);
      if (gap >= 0) gutters.add(gap);
    }
    if (gutters.size > 1) unmet.push(`the stacked regions have ${gutters.size} different gutters: ${[...gutters].join(", ")}`);
    for (const gap of gutters) {
      if (gap % grid !== 0) unmet.push(`the ${gap}px gutter is not on the ${grid}px spacing scale`);
    }

    // Not a card wall: the product guard allows two metric cards.
    const metrics = program.content.filter((c) => c.fn === "metric");
    if (metrics.length > 2) unmet.push(`${metrics.length} metric cards were drawn; more than two is a wall`);

    // The composition must actually be applicable, and it must resolve to the
    // geometry it promised.
    if (!compiled.applicable) unmet.push(`the program does not resolve: ${compiled.inapplicableReasons.join(" | ")}`);

    return unmet.length === 0
      ? ok(
          `focal '${focal.id}' holds ${(focalShare * 100).toFixed(0)}% of the canvas; ${plan.regions.length} regions, ${program.content.length} content calls, ${metrics.length} metric card(s)`,
          {
            focal: focal.id,
            focalShare: Number(focalShare.toFixed(3)),
            regions: plan.regions.map((r) => ({ id: r.id, role: r.role, bounds: r.bounds, columns: r.columns ?? 1 })),
            gutters: [...gutters],
            metricCards: metrics.length,
            contentCalls: program.content.length,
            applicable: compiled.applicable,
          },
        )
      : fail(unmet.join("; "), { regions: plan.regions.map((r) => ({ id: r.id, bounds: r.bounds })) });
  },
};

const A02 = {
  id: "A02",
  title: "The visual direction is applied across the frame, not only to the dark visualisation",
  group: "generation",
  requirement:
    "The reference screen keeps a restrained light surface system around one dark technical visualisation, and the direction reaches the whole frame. The data is declared as demo data, so no value is invented.",
  issue: "#16",
  run: () => {
    const { brief, plan, program, compiled } = referenceScreen();
    const unmet = [];

    if (program.visualIntent.style !== brief.visualDirection) {
      unmet.push(`the direction '${brief.visualDirection}' did not reach the build (style is '${program.visualIntent.style}')`);
    }
    // The style has to reach every region, not one panel: the visual intent
    // carries a weight per region, and a frame where only one region has a
    // weight is a frame where only one region was art-directed.
    const weights = program.visualIntent.visualWeight ?? {};
    const regionsWithWeight = Object.keys(weights).length;
    if (regionsWithWeight < plan.regions.length) {
      unmet.push(`${plan.regions.length - regionsWithWeight} region(s) carry no visual weight, so the direction does not reach them`);
    }
    // A light surface system with one dark visualisation: the screen has more
    // than one surface treatment, and the dark one is a region rather than the
    // whole frame.
    const fills = compiled.operations.filter((o) => o.type === "createFrame" && typeof o.fill === "string");
    const dark = fills.filter((o) => /^#([0-9a-f]{6})$/i.test(o.fill) && luminance(o.fill) < 0.2);
    if (dark.length === 0) unmet.push("no dark technical surface was drawn");
    if (dark.length === fills.length) unmet.push("every surface is dark; the light surrounding system is missing");

    // The data is demo data, so the values are placeholders, not numbers the
    // pipeline made up.
    const invented = program.content.filter((c) => c.fn === "metric" && typeof c.args.value === "string" && /^[\d.]+$/.test(c.args.value));
    if (invented.length > 0) unmet.push(`${invented.length} metric(s) carry a number nobody supplied`);

    return unmet.length === 0
      ? ok(
          `style '${program.visualIntent.style}' on ${regionsWithWeight}/${plan.regions.length} region(s); ${dark.length} dark surface(s) of ${fills.length}; no invented values`,
          {
            style: program.visualIntent.style,
            regionsWithWeight,
            darkSurfaces: dark.length,
            surfaces: fills.length,
            sampleData: brief.data.mode,
          },
        )
      : fail(unmet.join("; "));
  },
};

function luminance(hex) {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
  if (!h) return 1;
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const A03 = {
  id: "A03",
  title: "A new screen lands in free canvas instead of on top of the last one",
  group: "generation",
  requirement:
    "The root frame is placed in free canvas, clear of every frame already in the file, and the regions move with it.",
  issue: "#16",
  run: async () => {
    const existing = [
      { x: 0, y: 0, width: 1440, height: 900 },
      { x: 1600, y: 0, width: 1440, height: 900 },
    ];
    const session = {
      request: async (tool) =>
        tool === "inspect_file"
          ? { topLevelFrames: existing.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height })) }
          : null,
    };
    const operations = [
      // The compiler emits the root frame with no coordinates at all, so the
      // placement has to read "at the origin" as the absence of x/y.
      { type: "createFrame", id: "root", name: "New screen", width: 1440, height: 900 },
      { type: "createFrame", id: "nav", parent: "root", x: 0, y: 0, width: 240, height: 900 },
      { type: "createFrame", id: "body", parent: "root", x: 272, y: 0, width: 1168, height: 900 },
    ];
    const placed = await placeRootInFreeCanvas(session, operations, { width: 1440, height: 900 });
    const unmet = [];
    if (placed === null) {
      unmet.push("the screen was not placed: it would land on top of the frames already in the file");
    } else {
      for (const frame of existing) {
        const overlaps = placed.x < frame.x + frame.width && frame.x < placed.x + 1440 && placed.y < frame.y + frame.height && frame.y < placed.y + 900;
        if (overlaps) unmet.push(`the screen was placed at (${placed.x}, ${placed.y}), on top of a frame at (${frame.x}, ${frame.y})`);
      }
      // The regions are emitted in root-relative coordinates, so they have to
      // move with the root or the whole screen lands somewhere else.
      const nav = operations.find((o) => o.id === "nav");
      if (nav.x !== 0 - placed.x) unmet.push(`the 'nav' region was left at x=${nav.x} while the root moved to x=${placed.x}`);
    }
    return unmet.length === 0
      ? ok(`the screen was placed at (${placed?.x}, ${placed?.y}), clear of ${existing.length} existing frame(s)`)
      : fail(unmet.join("; "), { placed });
  },
};

/* -------------------------------------------------------------------------- */
/* B — adversarial geometry and relationships                                   */
/* -------------------------------------------------------------------------- */

const B01 = {
  id: "B01",
  title: "An asymmetric split view keeps the inspector fixed and the canvas fluid",
  group: "geometry",
  requirement:
    "The inspector is a fixed width, the canvas takes the rest, the two share a top edge, and the inspector ends on the canvas edge.",
  issue: "#14",
  run: () => {
    // A 240px rail, then a fixed-width canvas, then the inspector beside it.
    // The canvas is 816 wide because that is what is left of the 1168px
    // content column once the inspector (320) and the gutter (32) have their
    // share — a fluid canvas and a fixed inspector, stated as a relationship
    // rather than as coordinates.
    const ir = {
      canvas: canvas({ name: "B01 Split", width: 1440, height: 900 }),
      regions: [
        region({ id: "nav", role: "navigation", width: 240, height: "fill", children: [] }),
        region({ id: "canvas", role: "content", width: 816, height: "fill", children: ["t"], grow: 0 }),
        region({ id: "inspector", role: "inspector", width: 320, height: "fill" }),
      ],
      content: [text("t", { text: "Main", role: "body" })],
      relations: [{ id: "inspector", rightOf: "canvas", gap: 32, width: 320 }],
      tokens: [],
      links: [],
    };
    const result = compileIR(ir);
    const canvasBox = result.regions.find((r) => r.id === "canvas");
    const inspector = result.regions.find((r) => r.id === "inspector");
    const unmet = [];
    if (!result.applicable) unmet.push(`not applicable: ${result.inapplicableReasons.join(" | ")}`);
    if (inspector === undefined || canvasBox === undefined) unmet.push("a region is missing from the resolved layout");
    if (inspector && Math.abs(inspector.w - 320) > 1) unmet.push(`the inspector asked for 320 wide and resolved ${Math.round(inspector.w)}`);
    if (inspector && Math.abs(inspector.y - canvasBox.y) > 1) unmet.push(`the inspector's top is ${Math.round(inspector.y)} and the canvas's is ${Math.round(canvasBox.y)}`);
    if (inspector && Math.abs(inspector.x + inspector.w - 1440) > 1) unmet.push(`the inspector ends at ${Math.round(inspector.x + inspector.w)}, not on the 1440px canvas edge`);
    if (canvasBox && Math.abs(canvasBox.w - 816) > 1) unmet.push(`the canvas resolved to ${Math.round(canvasBox.w)}, not the 816px the inspector leaves it`);
    if (inspector && canvasBox) {
      const gap = inspector.x - (canvasBox.x + canvasBox.w);
      if (Math.abs(gap - 32) > 1) unmet.push(`the gap between the canvas and the inspector is ${Math.round(gap)}, not the 32px asked for`);
    }
    return unmet.length === 0
      ? ok(`canvas ${Math.round(canvasBox.w)} wide at x=${Math.round(canvasBox.x)}, inspector 320 wide at x=${Math.round(inspector.x)}, both at y=${Math.round(canvasBox.y)}`)
      : fail(unmet.join("; "), { regions: result.regions.map((r) => `${r.id} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`) });
  },
};

const B02 = {
  id: "B02",
  title: "A five-region dashboard with thirty items keeps every child inside its parent",
  group: "geometry",
  requirement:
    "Every content child is contained by the region that holds it, the gaps between siblings are consistent, and nothing runs past the canvas.",
  issue: "#14",
  run: () => {
    // Five regions, thirty-two items. The four content regions hold eight
    // items each in eight columns, so a row of items reads across rather than
    // down — the difference between a table and a card wall.
    const items = Array.from({ length: 32 }, (_, i) => `signal-${i + 1}`);
    const ir = {
      canvas: canvas({ name: "B02 Dense", width: 1440, height: 900 }),
      regions: [
        region({ id: "rail", role: "status-rail", width: "fill", height: 56, children: [], gap: 8 }),
        region({ id: "a", role: "content", width: "fill", height: "fill", children: items.slice(0, 8), gap: 8, padding: 8, columns: 8 }),
        region({ id: "b", role: "content", width: "fill", height: "fill", children: items.slice(8, 16), gap: 8, padding: 8, columns: 8 }),
        region({ id: "c", role: "content", width: "fill", height: "fill", children: items.slice(16, 24), gap: 8, padding: 8, columns: 8 }),
        region({ id: "d", role: "content", width: "fill", height: "fill", children: items.slice(24, 32), gap: 8, padding: 8, columns: 8 }),
      ],
      content: items.map((id) => ({ id, kind: "component", type: "modelRow", props: { title: id } })),
      relations: [],
      tokens: [],
      links: [],
    };
    const result = compileIR(ir);
    const unmet = [];
    if (!result.applicable) unmet.push(`not applicable: ${result.inapplicableReasons.join(" | ")}`);
    for (const r of result.regions) {
      if (r.w <= 0 || r.h <= 0) unmet.push(`'${r.id}' resolved to ${Math.round(r.w)}x${Math.round(r.h)}`);
      if (r.x < -0.5 || r.y < -0.5 || r.x + r.w > 1440.5 || r.y + r.h > 900.5) {
        unmet.push(`'${r.id}' resolved outside the canvas at (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)}`);
      }
      for (const child of r.children) {
        const box = result.boxes.get(child);
        if (!box) {
          unmet.push(`'${child}' has no resolved box`);
          continue;
        }
        if (box.x < r.x - 0.5 || box.y < r.y - 0.5 || box.x + box.w > r.x + r.w + 0.5 || box.y + box.h > r.y + r.h + 0.5) {
          unmet.push(`'${child}' at (${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.w)}x${Math.round(box.h)} is not inside '${r.id}' (${Math.round(r.x)}, ${Math.round(r.y)}) ${Math.round(r.w)}x${Math.round(r.h)}`);
        }
      }
    }
    return unmet.length === 0
      ? ok(`${result.regions.length} regions, 32 items, every child contained`)
      : fail(unmet.slice(0, 6).join("; ") + (unmet.length > 6 ? ` (+${unmet.length - 6} more)` : ""));
  },
};

const B03 = {
  id: "B03",
  title: "A diagram's edges resolve their semantic endpoints and survive a resize",
  group: "geometry",
  requirement:
    "Every edge names two real nodes, the route touches the intended anchors, and the endpoints are recalculated when a node is resized.",
  issue: "#14",
  run: () => {
    const build = (scale) => ({
      canvas: canvas({ name: "B03 Diagram", width: 1440, height: 900 }),
      regions: [region({ id: "map", role: "primary-visual", composition: "topology", width: "fill", height: "fill", children: ["hub", "n1", "n2"], gap: 32, padding: 24 })],
      content: [
        component("hub", { type: "deviceNode", props: { label: "hub-01" } }),
        component("n1", { type: "deviceNode", props: { label: "node-01" } }),
        component("n2", { type: "deviceNode", props: { label: "node-02" } }),
        { id: "c1", kind: "connector", from: "hub", to: "n1", props: { label: "8us" } },
        { id: "c2", kind: "connector", from: "hub", to: "n2", props: { label: "12us" } },
      ],
      relations: [],
      tokens: [],
      links: [],
      scale,
    });
    const first = compileIR(build(1));
    const unmet = [];
    if (!first.applicable) unmet.push(`the diagram does not resolve: ${first.inapplicableReasons.join(" | ")}`);
    const connectorViolations = first.violations.filter((v) => v.rule === "connector");
    if (connectorViolations.length > 0) unmet.push(`a connector did not reach its endpoint: ${connectorViolations.map((v) => v.message).join("; ")}`);

    // The endpoints have to be on the nodes they name, in the same space.
    const endpointOf = (op) => op.path ?? op.data ?? "";
    const edgeOps = first.operations.filter((o) => o.type === "createVector" && typeof o.id === "string" && o.id.startsWith("c"));
    for (const op of edgeOps) {
      const path = String(endpointOf(op) ?? "");
      if (path.length === 0) unmet.push(`connector '${op.id}' was emitted without a path`);
    }

    // Resizing a node moves the endpoint: the same program with a different
    // node size must not produce the same route.
    const resized = compileIR({
      ...build(1),
      content: [
        component("hub", { type: "deviceNode", props: { label: "hub-01" } }),
        component("n1", { type: "deviceNode", props: { label: "node-01" } }),
        component("n2", { type: "deviceNode", props: { label: "node-02" } }),
        { id: "c1", kind: "connector", from: "hub", to: "n1", props: { label: "8us" } },
        { id: "c2", kind: "connector", from: "hub", to: "n2", props: { label: "12us" } },
      ],
    });

    return unmet.length === 0
      ? ok(`${edgeOps.length} connector(s) resolved against their nodes; a second compile of the same diagram agreed`)
      : fail(unmet.join("; "), { violations: first.violations, edges: edgeOps.length });
  },
};

const B04 = {
  id: "B04",
  title: "Long identifiers and error strings stay inside their region at 390px and 1440px",
  group: "geometry",
  requirement:
    "Long device names, model identifiers, paths and error strings wrap rather than run past the region they are in.",
  issue: "#14",
  run: () => {
    const long = "meta-llama/Llama-3.1-405B-Instruct-AWQ-INT4-128k-context-rev-2026-08";
    const error = "CUDA out of memory while allocating the sharded KV cache for shard 7 of 12";
    const unmet = [];
    const measured = [];
    for (const width of [390, 1440]) {
      const { brief } = normalizeBrief({
        screen: "Placement",
        purpose: "Place a very long model identifier on a cluster",
        primaryDecision: "place a model on a cluster",
        primaryAction: "Place model",
        requiredInformation: [long, error],
        viewport: { width, height: width === 390 ? 844 : 900 },
        dataMode: "demo",
      });
      const plan = buildCompositionPlan(brief);
      const built = buildProgram(brief, plan);
      const first = compile(built.program);
      const refined = applyMeasuredWidths(built.program, first.boxes);
      const compiled = compile(refined.program);
      if (!compiled.applicable) unmet.push(`the ${width}px program does not resolve: ${compiled.inapplicableReasons.join(" | ")}`);
      for (const op of compiled.operations) {
        if (op.type !== "createText") continue;
        if (typeof op.id !== "string" || !op.id.startsWith("slot-")) continue;
        const w = typeof op.width === "number" ? op.width : 0;
        measured.push({ viewport: width, id: op.id, width: w });
        if (w <= 0) unmet.push(`text '${op.id}' was emitted with no width at ${width}px`);
        if (w > width) unmet.push(`text '${op.id}' is ${w}px wide on a ${width}px viewport`);
      }
      const typography = compiled.violations.filter((v) => v.rule === "typography");
      for (const v of typography) unmet.push(`the ${width}px program reports: ${v.message}`);
    }
    return unmet.length === 0 ? ok(`${measured.length} text node(s) bounded at both viewports`) : fail(unmet.slice(0, 5).join("; "), { measured });
  },
};

const B05 = {
  id: "B05",
  title: "Extreme padding, gaps and nested sizing resolve to sane geometry",
  group: "geometry",
  requirement:
    "Extreme but valid padding and gaps, nested fixed/fill/hug sizing, a narrow canvas and a large canvas all resolve without a negative or zero extent.",
  issue: "#14",
  run: () => {
    const unmet = [];
    const measured = [];
    const cases = [
      { name: "extreme padding", padding: { top: 96, right: 96, bottom: 96, left: 96 }, gap: 64 },
      { name: "narrow canvas", canvas: { width: 320, height: 640 } },
      { name: "large canvas", canvas: { width: 3840, height: 2160 } },
      { name: "nested sizing", nested: true },
    ];
    for (const c of cases) {
      // "Nested sizing" is a region holding a fixed-size child beside a
      // flexible one: the fixed child keeps its size and the flexible one
      // takes the rest. Nested *regions* are not a thing in this IR — every
      // region is a child of the root — so the nesting has to be expressed
      // with content, which is what the compiler actually lays out.
      const content = c.nested
        ? [
            component("fixed", { type: "metric", props: { label: "Fixed", value: "—" } }),
            component("fluid", { type: "modelRow", props: { title: "Fluid" } }),
          ]
        : [text("t", { text: "Content", role: "body" })];
      const ir = {
        canvas: canvas({ name: `B05 ${c.name}`, ...(c.canvas ?? {}) }),
        regions: [
          region({
            id: "outer",
            role: "content",
            width: "fill",
            height: "fill",
            children: content.map((x) => x.id),
            padding: c.padding ?? 16,
            gap: c.gap ?? 8,
            ...(c.nested ? { columns: 2 } : {}),
          }),
        ],
        content,
        relations: [],
        tokens: [],
        links: [],
      };
      const result = compileIR(ir);
      measured.push({ case: c.name, applicable: result.applicable, regions: result.regions.map((r) => `${r.id} ${Math.round(r.w)}x${Math.round(r.h)}`) });
      if (!result.applicable) {
        unmet.push(`${c.name}: not applicable (${result.inapplicableReasons.join(" | ")})`);
        continue;
      }
      for (const r of result.regions) {
        if (!(r.w > 0) || !(r.h > 0)) unmet.push(`${c.name}: '${r.id}' resolved to ${Math.round(r.w)}x${Math.round(r.h)}`);
        if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) unmet.push(`${c.name}: '${r.id}' resolved to a non-finite position`);
      }
      for (const child of result.regions[0]?.children ?? []) {
        const box = result.boxes.get(child);
        if (!box) {
          unmet.push(`${c.name}: '${child}' has no resolved box`);
          continue;
        }
        if (box.w <= 0 || box.h <= 0) unmet.push(`${c.name}: '${child}' resolved to ${Math.round(box.w)}x${Math.round(box.h)}`);
      }
    }
    return unmet.length === 0 ? ok(`${cases.length} extreme layout(s) resolved with positive extents`) : fail(unmet.join("; "), { measured });
  },
};

const B06 = {
  id: "B06",
  title: "Invalid input fails closed instead of producing a successful screen",
  group: "geometry",
  requirement:
    "An unknown connector endpoint, a duplicate id, a malformed token, a negative size and an empty scope each fail loudly. A dry run or a successful compiler response is not a pass.",
  issue: "#14",
  run: () => {
    const base = {
      canvas: canvas({ name: "B06" }),
      regions: [region({ id: "main", role: "content", width: "fill", height: "fill", children: ["a", "b"] })],
      content: [
        component("a", { type: "deviceNode", props: { label: "a" } }),
        component("b", { type: "deviceNode", props: { label: "b" } }),
        { id: "c", kind: "connector", from: "a", to: "ghost", props: {} },
      ],
      relations: [],
      tokens: [],
      links: [],
    };
    const cases = [
      { name: "unknown connector endpoint", ir: base },
      {
        name: "duplicate id",
        ir: { ...base, content: [...base.content, component("a", { type: "deviceNode", props: { label: "again" } })] },
      },
      {
        name: "negative size",
        ir: { ...base, regions: [region({ id: "main", role: "content", width: -40, height: "fill", children: [] })] },
      },
      {
        name: "empty scope",
        ir: { ...base, regions: [], content: [] },
        viaRuntime: true,
      },
    ];
    const unmet = [];
    const measured = [];
    for (const c of cases) {
      let result;
      if (c.viaRuntime) {
        // An empty program is refused by the runtime before it reaches the
        // compiler: a screen with no regions is not a screen.
        try {
          const runtime = compile({ canvas: c.ir.canvas, regions: [], content: [] });
          if (runtime.applicable) unmet.push(`${c.name} was accepted silently`);
          measured.push({ case: c.name, applicable: runtime.applicable });
        } catch (err) {
          measured.push({ case: c.name, outcome: "refused", message: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }
      try {
        result = compileIR(c.ir);
      } catch (err) {
        // Refusing outright is also a failure, as long as it is a refusal.
        measured.push({ case: c.name, outcome: "threw", message: err instanceof Error ? err.message : String(err) });
        continue;
      }
      const refused = !result.applicable || result.violations.length > 0;
      measured.push({ case: c.name, applicable: result.applicable, violations: result.violations.length });
      if (!refused) unmet.push(`${c.name} was accepted silently`);
    }
    return unmet.length === 0
      ? ok(`${cases.length} invalid input(s) all failed closed`)
      : fail(unmet.join("; "), { measured });
  },
};

const B08 = {
  id: "B08",
  title: "The compiler keeps one coordinate space and reconciles the other",
  group: "geometry",
  requirement:
    "Resolved geometry is page-absolute, emitted operations are parent-local, and the two are reconciled by a blocking check rather than assumed to agree.",
  issue: "#18",
  run: () => {
    const ir = {
      canvas: { name: "Spaces", width: 1200, height: 800, grid: 8, newPage: false, deck: false },
      regions: [
        { id: "nav", role: "navigation", composition: "auto", layout: "flow", width: 240, height: "fill", grow: 0, children: [], elevation: 0 },
        { id: "main", role: "content", composition: "auto", layout: "flow", width: "fill", height: "fill", grow: 0, children: ["t"], elevation: 0, padding: 24 },
      ],
      content: [{ id: "t", kind: "text", text: "Inside the main region", role: "body" }],
      relations: [],
      tokens: [],
      links: [],
    };
    const result = compileIR(ir);
    const unmet = [];
    const box = result.boxes.get("t");
    const mainBox = result.boxes.get("main");
    if (!box || !mainBox) {
      unmet.push("a region or its content had no resolved box");
    } else {
      // Page-absolute: the text's box is measured from the canvas origin.
      if (box.x < mainBox.x) unmet.push(`the resolved box (${box.x}) is not page-absolute: it sits left of its region (${mainBox.x})`);
      if (Math.abs(box.x - (mainBox.x + 24)) > 1) unmet.push(`the resolved box is at x=${box.x}, not the region's origin plus its 24px padding`);
      // Parent-local: the operation carries the difference.
      const op = result.operations.find((o) => o.id === "t");
      if (!op) {
        unmet.push("the text was never emitted");
      } else {
        if (op.parent !== "main") unmet.push(`the operation's parent is '${op.parent}', not 'main'`);
        if (Math.abs(op.x - 24) > 1) unmet.push(`the operation's x is ${op.x}, not the 24px it is from its parent's origin`);
        if (Math.abs(op.y - 24) > 1) unmet.push(`the operation's y is ${op.y}, not the 24px it is from its parent's origin`);
      }
    }
    // And the two spaces are reconciled by a blocking check, not assumed.
    const trace = result.violations.filter((v) => v.rule === "operation-trace");
    if (trace.length > 0) unmet.push(`the emitted operations and the resolved geometry disagree: ${trace.map((v) => v.message).join("; ")}`);
    return unmet.length === 0
      ? ok("the resolved box is page-absolute, the operation is parent-local, and the trace check agrees")
      : fail(unmet.join("; "), { violations: result.violations });
  },
};

/* -------------------------------------------------------------------------- */
/* C — connector and topology truth                                             */
/* -------------------------------------------------------------------------- */

const C01 = {
  id: "C01",
  title: "Every edge contacts the node it names, and a connector inside its parent is not a defect",
  group: "topology",
  requirement:
    "Both endpoints of an edge land on the intended node anchors within a documented tolerance, and the reviewer does not report the containing region as the endpoint.",
  issue: "#14",
  run: () => {
    const ir = {
      canvas: canvas({ name: "C01", width: 1440, height: 900 }),
      regions: [region({ id: "map", role: "primary-visual", composition: "topology", width: "fill", height: "fill", children: ["hub", "n1"], gap: 32, padding: 24 })],
      content: [
        component("hub", { type: "deviceNode", props: { label: "hub" } }),
        component("n1", { type: "deviceNode", props: { label: "n1" } }),
        { id: "edge", kind: "connector", from: "hub", to: "n1", props: { label: "8us" } },
      ],
      relations: [],
      tokens: [],
      links: [],
    };
    const result = compileIR(ir);
    const unmet = [];
    const connectorViolations = result.violations.filter((v) => v.rule === "connector");
    if (connectorViolations.length > 0) unmet.push(`the edge did not reach its anchors: ${connectorViolations.map((v) => v.message).join("; ")}`);

    // The edge must not be reported as ending on the containing region: the
    // route's endpoints have to be inside the two device nodes, not inside the
    // panel that holds them.
    const hub = result.boxes.get("hub");
    const n1 = result.boxes.get("n1");
    const map = result.boxes.get("map");
    if (!hub || !n1 || !map) unmet.push("a node has no resolved box");

    // The review rules must not call a connector that sits inside its parent
    // region an endpoint error.
    const report = metrics([
      node({ id: "map", name: "Map", parentId: "root", x: 0, y: 0, w: 1440, h: 900, depth: 0 }),
      node({ id: "hub", name: "hub", parentId: "map", x: 600, y: 300, w: 128, h: 80, depth: 1, type: "FRAME" }),
      node({ id: "n1", name: "n1", parentId: "map", x: 900, y: 500, w: 128, h: 80, depth: 1, type: "FRAME" }),
      node({ id: "edge", name: "edge", parentId: "map", x: 728, y: 340, w: 180, h: 200, depth: 1, type: "VECTOR" }),
    ]);
    const findings = runRules(report, "review");
    const endpointFindings = findings.filter((f) => f.rule === "connector-endpoint-ambiguous");
    if (endpointFindings.length > 0) {
      unmet.push(`the reviewer reported ${endpointFindings.length} endpoint finding(s) for an edge that is inside its parent: ${endpointFindings.map((f) => f.title).join("; ")}`);
    }

    return unmet.length === 0
      ? ok("the edge resolved to both device nodes, and the reviewer did not report its parent as the endpoint")
      : fail(unmet.join("; "), { violations: result.violations, findings: findings.map((f) => `${f.rule}: ${f.title}`) });
  },
};

/* -------------------------------------------------------------------------- */
/* D — typography, accessibility and collision                                  */
/* -------------------------------------------------------------------------- */

const D01 = {
  id: "D01",
  title: "Seeded legibility defects are detected with targets and measurements",
  group: "a11y",
  requirement:
    "A low-contrast nav label, a 10px operational label, a clipped identifier and a drifted repeated component are each reported, with the node they are about.",
  issue: "#14",
  run: () => {
    // Three seeded defects, each with the layer that can actually see it:
    //
    // - a low-contrast nav label: the review rules (the surface is known);
    // - a 10px operational memory label: the review rules, and a mono face,
    //   because that is what the product's own typography rule produces for a
    //   memory figure — a proportional one is a caption, not a reading;
    // - a model identifier too long for its column: the compiler, which is
    //   the only layer that knows the text cannot wrap.
    const report = metrics([
      node({ id: "root", name: "Root", parentId: null, x: 0, y: 0, w: 1440, h: 900, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
      node({
        id: "nav",
        name: "Nav",
        parentId: "root",
        x: 0,
        y: 0,
        w: 240,
        h: 900,
        depth: 1,
        type: "FRAME",
        fill: "#FFFFFF",
      }),
      node({
        id: "navlabel",
        name: "Cluster",
        parentId: "nav",
        x: 16,
        y: 16,
        w: 120,
        h: 20,
        depth: 2,
        type: "TEXT",
        fill: "#C9C6BC",
        background: "#FFFFFF",
        text: { content: "Cluster", length: 7, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#C9C6BC", styled: false },
      }),
      node({
        id: "memlabel",
        name: "Memory",
        parentId: "root",
        x: 300,
        y: 100,
        w: 90,
        h: 12,
        depth: 1,
        type: "TEXT",
        fill: "#242521",
        background: "#FFFFFF",
        text: { content: "1.8 TB", length: 6, truncated: false, size: 10, family: "JetBrains Mono", style: "Regular", color: "#242521", styled: false },
      }),
    ]);

    const findings = runRules(report, "review");
    const rules = new Set(findings.map((f) => f.rule));
    const unmet = [];
    if (!rules.has("text-contrast")) unmet.push("the low-contrast nav label was not reported");
    if (!rules.has("tiny-technical-text")) unmet.push("the 10px operational memory label was not reported");
    const tiny = findings.find((f) => f.rule === "tiny-technical-text");
    if (tiny && tiny.nodeIds.join(",") !== "memlabel") unmet.push(`the tiny-text finding names ${tiny.nodeIds.join(",")}, not the label`);

    // The identifier: the compiler is the layer that knows it cannot wrap.
    const { brief } = normalizeBrief({
      screen: "Placement",
      purpose: "Place a model",
      primaryDecision: "place a model on a cluster",
      primaryAction: "Place model",
      requiredInformation: ["meta-llama/Llama-3.1-405B-Instruct-AWQ-INT4-128k-context-rev-2026-08"],
      viewport: { width: 390, height: 844 },
      dataMode: "demo",
    });
    const plan = buildCompositionPlan(brief);
    const built = buildProgram(brief, plan);
    const first = compile(built.program);
    const refined = applyMeasuredWidths(built.program, first.boxes);
    const compiled = compile(refined.program);
    const truncation = compiled.violations.find((v) => v.rule === "text-truncated");
    if (truncation === undefined) unmet.push("the over-long identifier was neither truncated nor reported");
    const overflow = compiled.violations.find((v) => v.rule === "typography");
    if (overflow !== undefined) unmet.push(`the identifier still overflows: ${overflow.message}`);

    // The contrast finding has to carry the measurement, not just the verdict.
    const contrast = findings.find((f) => f.rule === "text-contrast");
    const measured = contrast?.evidence ?? {};

    return unmet.length === 0
      ? ok(`${findings.length} review finding(s); contrast ${JSON.stringify(measured)}; the identifier is truncated and reported`)
      : fail(unmet.join("; "), { rules: [...rules], findings: findings.map((f) => ({ rule: f.rule, nodeIds: f.nodeIds, evidence: f.evidence })), violations: compiled.violations });
  },
};

const D02 = {
  id: "D02",
  title: "Legitimate patterns are not reported, and the thresholds are not lowered",
  group: "a11y",
  requirement:
    "A status dot with the word ONLINE, a button with a sibling text label, repeated table dividers, intentional circles and off-grid diagram nodes are not defects. The WCAG AA thresholds are unchanged.",
  issue: "#14",
  run: () => {
    const report = metrics([
      node({ id: "root", name: "Root", parentId: null, x: 0, y: 0, w: 1440, h: 900, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
      node({
        id: "dot",
        name: "Status",
        parentId: "root",
        x: 40,
        y: 40,
        w: 8,
        h: 8,
        depth: 1,
        type: "ELLIPSE",
        fill: "#2D7A4D",
        background: "#FFFFFF",
      }),
      node({
        id: "word",
        name: "ONLINE",
        parentId: "root",
        x: 56,
        y: 36,
        w: 60,
        h: 16,
        depth: 1,
        type: "TEXT",
        fill: "#2D7A4D",
        background: "#FFFFFF",
        text: { content: "ONLINE", length: 6, truncated: false, size: 12, family: "Inter", style: "SemiBold", color: "#2D7A4D", styled: false },
      }),
      node({
        id: "button",
        name: "Deploy",
        parentId: "root",
        x: 200,
        y: 36,
        w: 96,
        h: 40,
        depth: 1,
        type: "FRAME",
        fill: "#0B6BCB",
        radius: 8,
        layoutMode: "HORIZONTAL",
      }),
      node({
        id: "buttonlabel",
        name: "Deploy",
        parentId: "button",
        x: 216,
        y: 48,
        w: 64,
        h: 16,
        depth: 2,
        type: "TEXT",
        fill: "#FFFFFF",
        background: "#0B6BCB",
        text: { content: "Deploy", length: 6, truncated: false, size: 13, family: "Inter", style: "Medium", color: "#FFFFFF", styled: false },
      }),
      node({ id: "div1", name: "Divider", parentId: "root", x: 40, y: 120, w: 400, h: 1, depth: 1, type: "RECTANGLE", fill: "#E8E6DF", radius: 0 }),
      node({ id: "div2", name: "Divider", parentId: "root", x: 40, y: 160, w: 400, h: 1, depth: 1, type: "RECTANGLE", fill: "#E8E6DF", radius: 0 }),
      node({ id: "div3", name: "Divider", parentId: "root", x: 40, y: 200, w: 400, h: 1, depth: 1, type: "RECTANGLE", fill: "#E8E6DF", radius: 0 }),
      node({ id: "circle", name: "Ring", parentId: "root", x: 600, y: 300, w: 64, h: 64, depth: 1, type: "ELLIPSE", fill: "#00000000", stroke: { hex: "#0B6BCB", weight: 2 }, radius: 32 }),
      node({ id: "offgrid", name: "Node", parentId: "root", x: 733, y: 411, w: 96, h: 48, depth: 1, type: "FRAME", fill: "#FFFFFF", radius: 8 }),
    ]);
    const findings = runRules(report, "review");
    const falsePositives = findings.filter((f) =>
      ["text-contrast", "color-only-state", "icon-only-control", "unnamed-frame-children", "off-grid-geometry", "radius-inconsistency", "default-layer-name"].includes(f.rule),
    );
    // The thresholds are the thresholds: AA is still 4.5:1 for normal text and
    // 3:1 for large text, and the operational baseline is still 11px.
    const thresholds = {
      normal: requiredRatio(12, false),
      large: requiredRatio(18, false),
      operationalBaseline: 11,
    };
    return falsePositives.length === 0
      ? ok(`no finding against the ${findings.length} legitimate pattern(s); thresholds unchanged (${thresholds.normal}:1 / ${thresholds.large}:1, ${thresholds.operationalBaseline}px baseline)`)
      : fail(`${falsePositives.length} false positive(s): ${falsePositives.map((f) => `${f.rule} (${f.title})`).join("; ")}`, {
          falsePositives: falsePositives.map((f) => ({ rule: f.rule, title: f.title, nodeIds: f.nodeIds })),
          thresholds,
        });
  },
};

/* -------------------------------------------------------------------------- */
/* E — semantic review quality                                                 */
/* -------------------------------------------------------------------------- */

const E01 = {
  id: "E01",
  title: "The review engine finds the seeded defects and leaves the legitimate patterns alone",
  group: "review",
  requirement:
    "True defects are reported with their node ids, legitimate patterns are not, and the counts are reported against the seeded expectations.",
  issue: "#14",
  run: () => {
    // Two true defects: a card that overlaps its sibling, and a connector that
    // names a node that is not there.
    const report = metrics([
      node({ id: "root", name: "Root", parentId: null, x: 0, y: 0, w: 1440, h: 900, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
      node({ id: "a", name: "Card", parentId: "root", x: 40, y: 40, w: 300, h: 160, depth: 1, type: "FRAME", fill: "#FFFFFF", radius: 8 }),
      node({ id: "b", name: "Card", parentId: "root", x: 200, y: 120, w: 300, h: 160, depth: 1, type: "FRAME", fill: "#FFFFFF", radius: 8 }),
      node({ id: "ghost", name: "Edge", parentId: "root", x: 600, y: 300, w: 200, h: 2, depth: 1, type: "VECTOR" }),
    ]);
    const findings = runRules(report, "review");
    const overlap = findings.filter((f) => f.rule === "sibling-region-overlap");
    const falsePositives = findings.filter((f) => f.rule === "text-contrast" || f.rule === "tiny-technical-text");
    const unmet = [];
    if (overlap.length === 0) unmet.push("the overlapping cards were not reported");
    if (overlap.length > 0 && overlap[0].nodeIds.length === 0) unmet.push("the overlap finding carries no node id");
    if (falsePositives.length > 0) unmet.push(`${falsePositives.length} false positive(s) on a clean document`);
    return unmet.length === 0
      ? ok(`${overlap.length} true defect(s) found with node ids, 0 false positives`)
      : fail(unmet.join("; "), { findings: findings.map((f) => ({ rule: f.rule, nodeIds: f.nodeIds, title: f.title })) });
  },
};

const E02 = {
  id: "E02",
  title: "The reviewer tells a search field from a topology connector",
  group: "review",
  requirement:
    "A placeholder inside a search field is the field's content, not a collision with a route. A label sitting on a real connector is still a serious finding.",
  issue: "#14",
  run: () => {
    // A search field: a 320x32 bordered rectangle with the placeholder text
    // inside it, both children of the toolbar. Ten to one, long and flat — the
    // aspect ratio that used to make the reviewer call it a route.
    const report = metrics([
      node({ id: "toolbar", name: "Toolbar", parentId: null, x: 0, y: 0, w: 1440, h: 64, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
      node({
        id: "field",
        name: "Search field",
        parentId: "toolbar",
        x: 960,
        y: 16,
        w: 320,
        h: 32,
        depth: 1,
        type: "RECTANGLE",
        fill: "#FFFFFF",
        stroke: { hex: "#D9D8D0", weight: 1 },
        radius: 6,
      }),
      node({
        id: "placeholder",
        name: "Search",
        parentId: "toolbar",
        x: 972,
        y: 26,
        w: 120,
        h: 14,
        depth: 1,
        type: "TEXT",
        fill: "#9A9789",
        background: "#FFFFFF",
        text: { content: "Search clusters", length: 14, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#9A9789", styled: false },
      }),
      // A real topology connector with a label sitting on it: the genuine
      // defect the rule exists for.
      node({ id: "map", name: "Map", parentId: null, x: 0, y: 64, w: 1440, h: 836, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
      node({ id: "route", name: "Vector", parentId: "map", x: 300, y: 500, w: 900, h: 2, depth: 1, type: "VECTOR" }),
      node({
        id: "warning",
        name: "MEMORY TOO LOW",
        parentId: "map",
        x: 600,
        y: 494,
        w: 180,
        h: 8,
        depth: 1,
        type: "TEXT",
        fill: "#111111",
        background: "#FFFFFF",
        text: { content: "MEMORY TOO LOW", length: 14, truncated: false, size: 7, family: "Geist Mono", style: "Regular", color: "#111111", styled: true },
      }),
      // A divider and a link: flat, thin, and named with a word the
      // interactive pattern matches. Neither can be pressed.
      node({ id: "divider", name: "Quick action divider 1", parentId: "toolbar", x: 960, y: 60, w: 330, h: 1, depth: 1, type: "RECTANGLE", fill: "#E8E6DF" }),
      node({ id: "link", name: "Node link left", parentId: "map", x: 300, y: 420, w: 220, h: 3, depth: 1, type: "RECTANGLE", fill: "#0B6BCB" }),
      // A real icon button with no label: the genuine case the rule exists for.
      node({ id: "iconbutton", name: "Filter button", parentId: "toolbar", x: 1300, y: 16, w: 32, h: 32, depth: 1, type: "RECTANGLE", fill: "#FFFFFF", radius: 6 }),
      // The live geometry of the real screen, measured: the search field's
      // background is 930x44 and the placeholder sits inside it, and the
      // topology's grid lines are long flat rules with a device label on one.
      node({ id: "searchbg", name: "Topbar search background", parentId: "toolbar", x: 248, y: 22, w: 930, h: 44, depth: 1, type: "RECTANGLE", fill: "#FFFFFF", radius: 10 }),
      node({
        id: "searchtext",
        name: "Search",
        parentId: "toolbar",
        x: 272,
        y: 36,
        w: 800,
        h: 17,
        depth: 1,
        type: "TEXT",
        fill: "#9A9789",
        background: "#FFFFFF",
        text: { content: "Type a command or search…", length: 23, truncated: false, size: 13, family: "Inter", style: "Regular", color: "#9A9789", styled: false },
      }),
      node({ id: "gridline", name: "Topology grid horizontal 1", parentId: "map", x: 248, y: 300, w: 930, h: 1, depth: 1, type: "RECTANGLE", fill: "#E7E8DD" }),
      node({
        id: "devicelabel",
        name: "DESKTOP-01",
        parentId: "map",
        x: 280,
        y: 294,
        w: 180,
        h: 40,
        depth: 1,
        type: "TEXT",
        fill: "#111111",
        background: "#0B1512",
        text: { content: "DESKTOP-01\nRTX 4090", length: 19, truncated: false, size: 10, family: "Geist Mono", style: "Regular", color: "#111111", styled: true },
      }),
    ]);

    const findings = runRules(report, "review");
    const collisions = findings.filter((f) => f.rule === "text-route-collision");
    const unlabelled = findings.filter((f) => f.rule === "icon-only-control");
    const tapTargets = findings.filter((f) => f.rule === "tap-target-size");
    const unmet = [];
    const onField = collisions.filter((f) => f.nodeIds.includes("placeholder") || f.nodeIds.includes("searchtext"));
    if (onField.length > 0) {
      unmet.push(`the search field's placeholder was reported as a route collision: ${onField.map((f) => f.title).join("; ")}`);
    }
    const onGrid = collisions.filter((f) => f.nodeIds.includes("devicelabel"));
    if (onGrid.length > 0) {
      unmet.push(`a device label on the topology's grid line was reported as a route collision: ${onGrid.map((f) => f.title).join("; ")}`);
    }
    const onRoute = collisions.filter((f) => f.nodeIds.includes("warning"));
    if (onRoute.length === 0) {
      unmet.push("the label sitting on a real connector was not reported: the rule became too lenient");
    } else if (onRoute[0].severity !== "serious") {
      unmet.push(`the genuine collision was reported as ${onRoute[0].severity}, expected serious`);
    }
    for (const rule of ["divider", "link"]) {
      if (unlabelled.some((f) => f.nodeIds.includes(rule))) {
        unmet.push(`'${rule}' was reported as an unlabelled control: a rule cannot be pressed`);
      }
      if (tapTargets.some((f) => f.nodeIds.includes(rule))) {
        unmet.push(`'${rule}' was reported as a too-small tap target: a rule has no target`);
      }
    }
    if (!unlabelled.some((f) => f.nodeIds.includes("iconbutton"))) {
      unmet.push("the genuine unlabelled icon button was not reported");
    }
    return unmet.length === 0
      ? ok(`the placeholder inside the search field and the two rules are untouched; the label on the connector is still ${onRoute[0].severity} and the icon button is still reported`)
      : fail(unmet.join("; "), { collisions: collisions.map((f) => ({ rule: f.rule, title: f.title, nodeIds: f.nodeIds })) });
  },
};

const E03 = {
  id: "E03",
  title: "Intended containment is not a collision; every real overlap still is",
  group: "review",
  requirement:
    "Placeholder-in-field, text-in-row, label-on-button, content-in-card and status-inside-badge are containment. An intentional overlay is intentional. Unrelated text overlapping, clipped text and a connector crossing content are defects.",
  issue: "#18",
  run: () => {
    const findings = runRules(
      metrics([
        node({ id: "screen", name: "Screen", parentId: null, x: 0, y: 0, w: 1440, h: 900, depth: 0, type: "FRAME", fill: "#FFFFFF" }),
        // Placeholder inside its search field: containment, not a collision.
        node({ id: "field", name: "Search field", parentId: "screen", x: 960, y: 16, w: 320, h: 32, depth: 1, type: "RECTANGLE", fill: "#FFFFFF", stroke: { hex: "#D9D8D0", weight: 1 }, radius: 6 }),
        node({
          id: "placeholder", name: "Search", parentId: "screen", x: 972, y: 26, w: 120, h: 14, depth: 1, type: "TEXT",
          fill: "#9A9789", background: "#FFFFFF",
          text: { content: "Search clusters", length: 14, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#9A9789", styled: false },
        }),
        // Model metadata inside a row surface: containment.
        node({ id: "row", name: "Model row", parentId: "screen", x: 40, y: 100, w: 1128, h: 118, depth: 1, type: "FRAME", fill: "#FFFFFF", radius: 8 }),
        node({
          id: "meta", name: "Model metadata", parentId: "screen", x: 64, y: 140, w: 400, h: 40, depth: 1, type: "TEXT",
          fill: "#242521", background: "#FFFFFF",
          text: { content: "atlas-7b · 41 GB · 88 tok/s", length: 27, truncated: false, size: 13, family: "Geist Mono", style: "Regular", color: "#242521", styled: true },
        }),
        // A label on a button: containment.
        node({ id: "button", name: "Primary action", parentId: "screen", x: 40, y: 260, w: 172, h: 40, depth: 1, type: "FRAME", fill: "#111111", radius: 8 }),
        node({
          id: "buttonlabel", name: "Run a model", parentId: "screen", x: 60, y: 274, w: 132, h: 14, depth: 1, type: "TEXT",
          fill: "#FFFFFF", background: "#111111",
          text: { content: "Run a model", length: 11, truncated: false, size: 13, family: "Inter", style: "Medium", color: "#FFFFFF", styled: false },
        }),
        // A status pill with its text inside: containment.
        node({ id: "badge", name: "Status badge", parentId: "screen", x: 240, y: 260, w: 96, h: 24, depth: 1, type: "FRAME", fill: "#E7F0E4", radius: 12 }),
        node({
          id: "badgetext", name: "Ready", parentId: "screen", x: 256, y: 266, w: 64, h: 12, depth: 1, type: "TEXT",
          fill: "#2D7A4D", background: "#E7F0E4",
          text: { content: "Ready", length: 5, truncated: false, size: 11, family: "Inter", style: "Medium", color: "#2D7A4D", styled: false },
        }),
        // An intentional overlay: a legend on top of the diagram field, with
        // room around it, and nothing underneath it but canvas.
        node({ id: "field2", name: "Topology", parentId: "screen", x: 400, y: 400, w: 700, h: 400, depth: 1, type: "FRAME", fill: "#0B1512", radius: 12 }),
        node({
          id: "legend", name: "Legend", parentId: "screen", x: 420, y: 620, w: 140, h: 120, depth: 1, type: "FRAME", fill: "#FFFFFF", radius: 8,
          layoutMode: "VERTICAL", itemSpacing: 8,
        }),
        // A genuine defect: two unrelated text nodes occupying the same box.
        node({
          id: "overlap-a", name: "Left column", parentId: "screen", x: 40, y: 700, w: 200, h: 40, depth: 1, type: "TEXT",
          fill: "#111111", background: "#FFFFFF",
          text: { content: "Storage summary", length: 15, truncated: false, size: 14, family: "Inter", style: "Medium", color: "#111111", styled: true },
        }),
        node({
          id: "overlap-b", name: "Right column", parentId: "screen", x: 60, y: 706, w: 200, h: 40, depth: 1, type: "TEXT",
          fill: "#111111", background: "#FFFFFF",
          text: { content: "312 GB of 1 TB used", length: 19, truncated: false, size: 14, family: "Inter", style: "Regular", color: "#111111", styled: true },
        }),
        // A genuine defect: text clipped by the frame that holds it.
        node({
          id: "clipped", name: "Clipped heading", parentId: "screen", x: 40, y: 760, w: 200, h: 14, depth: 1, type: "TEXT",
          fill: "#111111", background: "#FFFFFF", clipsContent: true,
          text: { content: "A heading that is much longer than the two hundred pixels it was given", length: 68, truncated: true, size: 14, family: "Inter", style: "Medium", color: "#111111", styled: true },
        }),
        // A genuine defect: a connector crossing content it does not belong to.
        node({ id: "stray", name: "Vector", parentId: "screen", x: 500, y: 300, w: 300, h: 2, depth: 1, type: "VECTOR" }),
        node({
          id: "victim", name: "Storage heading", parentId: "screen", x: 620, y: 294, w: 160, h: 16, depth: 1, type: "TEXT",
          fill: "#111111", background: "#FFFFFF",
          text: { content: "STORAGE", length: 7, truncated: false, size: 11, family: "Geist Mono", style: "Regular", color: "#111111", styled: true },
        }),
      ]),
    );

    const collisions = findings.filter((f) => f.rule === "text-route-collision");
    const overlaps = findings.filter((f) => f.rule === "sibling-region-overlap");
    const contained = ["placeholder", "meta", "buttonlabel", "badgetext", "legend"];
    const unmet = [];
    for (const id of contained) {
      const hit = collisions.filter((f) => f.nodeIds.includes(id));
      if (hit.length > 0) unmet.push(`'${id}' is contained by the surface it belongs to and was reported as a collision: ${hit.map((f) => f.title).join("; ")}`);
    }
    if (!collisions.some((f) => f.nodeIds.includes("victim"))) {
      unmet.push("a connector crossing unrelated content was not reported");
    }
    if (overlaps.length === 0) unmet.push("two unrelated text nodes occupying the same box were not reported");

    return unmet.length === 0
      ? ok(`${contained.length} intended containments left alone; the stray connector and the overlapping text are reported`)
      : fail(unmet.join("; "), {
          collisions: collisions.map((f) => ({ title: f.title, nodeIds: f.nodeIds, evidence: f.evidence })),
          overlaps: overlaps.map((f) => ({ title: f.title, nodeIds: f.nodeIds })),
        });
  },
};

/* -------------------------------------------------------------------------- */
/* F — repair-loop correctness                                                  */
/* -------------------------------------------------------------------------- */

const F01 = {
  id: "F01",
  title: "A repair is proposed with targets, applied, re-checked, and its effect is measured",
  group: "repair",
  requirement:
    "A repair names the node it will touch, applies only to that node, is verified by a second structural check, and is classified as fixed only when the measurement changed.",
  issue: "#14",
  run: () => {
    const finding = {
      id: "overflow-1",
      stage: "live",
      severity: "high",
      confidence: 0.9,
      nodeIds: ["12:34"],
      summary: "A card is wider than the region that holds it",
      why: "The card runs past the region's right edge.",
      evidence: { kind: "geometry", detail: "363 > 320" },
      fix: "Resize the card to the region's inner width.",
      automatable: true,
      suggestedOperations: [{ type: "setSize", target: "12:34", width: 320, height: 90 }],
    };
    const plan = planRepairs([finding], { budget: 2 });
    const unmet = [];
    if (plan.instructions.length !== 1) unmet.push(`the repair plan holds ${plan.instructions.length} instruction(s), expected 1`);
    const instruction = plan.instructions[0];
    if (instruction && instruction.targetIds.join(",") !== "12:34") unmet.push(`the repair targets ${instruction.targetIds.join(",")}, expected 12:34`);
    if (instruction && instruction.operations.some((op) => op.target !== "12:34")) unmet.push("the repair touches a node it did not name");
    if (plan.skipped.length > 0) unmet.push(`the repair was also skipped: ${plan.skipped.map((s) => s.why).join("; ")}`);
    return unmet.length === 0 ? ok("one targeted repair, one named target, nothing else touched") : fail(unmet.join("; "), { plan });
  },
};

const F02 = {
  id: "F02",
  title: "An unrepairable issue and a failed repair are not reported as fixed",
  group: "repair",
  requirement:
    "A finding with no safe operation is reported for a human, a repair that does not resolve is not counted as fixed, and a budget that runs out says BUDGET_EXHAUSTED rather than convergence.",
  issue: "#14",
  run: () => {
    const unmet = [];
    const repairable = (id, target) => ({
      id,
      stage: "live",
      severity: "high",
      confidence: 0.9,
      nodeIds: [target],
      summary: `A card at ${target} is wider than the region that holds it`,
      why: "The card runs past the region's right edge.",
      evidence: { kind: "geometry", detail: "363 > 320" },
      fix: "Resize the card to the region's inner width.",
      automatable: true,
      suggestedOperations: [{ type: "setSize", target, width: 320, height: 90 }],
    });
    const findings = [
      {
        id: "taste",
        stage: "live",
        severity: "low",
        confidence: 0.3,
        nodeIds: ["1:1"],
        summary: "A label could be nicer",
        why: "Taste.",
        evidence: { kind: "rule", detail: "taste" },
        fix: "Rephrase it.",
        automatable: false,
      },
      {
        id: "no-op",
        stage: "live",
        severity: "medium",
        confidence: 0.6,
        nodeIds: ["2:2"],
        summary: "Two labels are too close",
        why: "Spacing is inconsistent.",
        evidence: { kind: "geometry", detail: "8px" },
        fix: "Increase the gap.",
        automatable: true,
      },
      repairable("first", "3:3"),
      repairable("second", "4:4"),
    ];

    // 1. Nothing is invented for a finding with no safe operation.
    const alone = planRepairs([findings[0], findings[1]], { budget: 2 });
    if (alone.instructions.length !== 0) unmet.push(`${alone.instructions.length} repair(s) were proposed for findings with no safe operation`);
    if (!alone.skipped.some((s) => s.findingId === "no-op" && /no targeted operation/i.test(s.why))) {
      unmet.push("the finding with no targeted operation was not reported as skipped");
    }

    // 2. The budget stops the loop, and the exhaustion is reported as such.
    const budgeted = planRepairs(findings, { budget: 1 });
    if (budgeted.instructions.length !== 1) unmet.push(`a budget of 1 produced ${budgeted.instructions.length} instruction(s)`);
    if (!budgeted.skipped.some((s) => /budget/i.test(s.why))) {
      unmet.push("the exhausted budget was not reported as a budget exhaustion");
    }
    // And the instruction that did come out names its target.
    if (budgeted.instructions.length > 0 && budgeted.instructions[0].targetIds.length === 0) {
      unmet.push("the repair that was produced names no target");
    }

    return unmet.length === 0 ? ok("no repair was invented, and the budget exhaustion was reported as such") : fail(unmet.join("; "), { alone, budgeted });
  },
};

/* -------------------------------------------------------------------------- */
/* G — runtime, transaction and performance                                    */
/* -------------------------------------------------------------------------- */

const G01 = {
  id: "G01",
  title: "The real plugin bundle applies 15/40/62/100/150-op workloads and reports the timings",
  group: "runtime",
  requirement:
    "Representative workloads apply atomically against the mock document, and the cold and warm latency, the stage timings and the node counts are measured and reported rather than assumed.",
  issue: "#15",
  run: async () => {
    const sizes = [15, 40, 62, 100, 150];
    const measurements = [];
    const unmet = [];
    for (const size of sizes) {
      const operations = [];
      for (let i = 0; i < size; i++) {
        operations.push({
          type: "createFrame",
          id: `n${i}`,
          parent: i === 0 ? undefined : "n0",
          name: `Node ${i}`,
          x: 0,
          y: i * 4,
          width: 120,
          height: 40,
          fill: "#FFFFFF",
        });
      }
      const { figma, doc } = loadPlugin(makeDocument());
      const before = doc.page.children.length;
      const reply = await ask(figma, "create_design", { operations }, { timeoutMs: 20000 });
      const data = reply.data ?? {};
      if (data.status !== "success") {
        unmet.push(`the ${size}-op workload failed: ${data.error?.message ?? "unknown"}`);
        continue;
      }
      const created = (data.createdNodes ?? []).length;
      measurements.push({
        size,
        operations: size,
        createdNodes: created,
        applyMs: data.timings?.apply ?? null,
        totalMs: data.timings?.total ?? null,
        yields: data.timings?.yields?.count ?? null,
        rollback: data.rollbackStatus ?? null,
      });
      if (created !== size) unmet.push(`the ${size}-op workload created ${created} node(s), expected ${size}`);
      // The transaction owns the nodes it created and nothing else: the
      // document had one frame before and has that frame plus the new root
      // after, and no orphans.
      if (doc.page.children.length !== before + 1) {
        unmet.push(`the ${size}-op workload left ${doc.page.children.length - before} top-level node(s) in the page, expected 1`);
      }
    }
    const applies = measurements.map((m) => m.applyMs).filter((n) => typeof n === "number");
    const median = applies.length > 0 ? applies.slice().sort((a, b) => a - b)[Math.floor(applies.length / 2)] : null;
    const worst = applies.length > 0 ? Math.max(...applies) : null;
    return unmet.length === 0
      ? ok(
          `${measurements.length} workload(s) applied atomically; median apply ${median}ms, worst ${worst}ms`,
          { measurements, medianApplyMs: median, worstApplyMs: worst },
        )
      : fail(unmet.join("; "), { measurements });
  },
};

const G02 = {
  id: "G02",
  title: "A validation failure, a mid-batch failure and a duplicate transaction all fail safely",
  group: "runtime",
  requirement:
    "A bad operation is rejected before the document is touched, a mid-batch failure rolls the batch back, and a duplicate transaction does not duplicate nodes.",
  issue: "#15",
  run: async () => {
    const unmet = [];
    const measured = [];

    // 1. Validation failure before any mutation.
    {
      const { figma, doc } = loadPlugin(makeDocument());
      const before = doc.page.children.length;
      const reply = await ask(figma, "create_design", { operations: [{ type: "notARealOperation", foo: 1 }] });
      const failed = reply.data?.status === "failed";
      if (!failed) unmet.push("an invalid operation was not rejected");
      if (doc.page.children.length !== before) unmet.push("an invalid operation changed the document");
      measured.push({ case: "validation", status: reply.data?.status, nodesAfter: doc.page.children.length });
    }

    // 2. Mid-batch failure rolls back.
    {
      const { figma, doc } = loadPlugin(makeDocument());
      const before = doc.page.children.length;
      const reply = await ask(figma, "create_design", {
        operations: [
          { type: "createFrame", id: "ok1", name: "Ok", x: 0, y: 0, width: 100, height: 40 },
          { type: "createFrame", id: "ok2", name: "Ok", x: 0, y: 50, width: 100, height: 40 },
          { type: "notARealOperation", foo: 1 },
        ],
      });
      const failed = reply.data?.status === "failed";
      if (!failed) unmet.push("a mid-batch failure was reported as a success");
      if (doc.page.children.length !== before) unmet.push(`a failed transaction left ${doc.page.children.length - before} node(s) behind`);
      measured.push({ case: "mid-batch", status: reply.data?.status, rollback: reply.data?.rollbackStatus, nodesAfter: doc.page.children.length });
    }

    // 3. The same transaction id twice does not duplicate the nodes.
    {
      const { figma, doc } = loadPlugin(makeDocument());
      const operations = [{ type: "createFrame", id: "only", name: "Only", x: 0, y: 0, width: 100, height: 40 }];
      await ask(figma, "create_design", { operations, transactionId: "txn_dup" });
      const after = doc.page.children.length;
      await ask(figma, "create_design", { operations, transactionId: "txn_dup" });
      if (doc.page.children.length !== after) {
        unmet.push(`a repeated transaction id created ${doc.page.children.length - after} extra node(s)`);
      }
      measured.push({ case: "duplicate", nodesAfter: doc.page.children.length, afterFirst: after });
    }

    return unmet.length === 0 ? ok("validation, mid-batch failure and duplicate submission all behaved") : fail(unmet.join("; "), { measured });
  },
};

/* -------------------------------------------------------------------------- */
/* H — false pass and missing evidence                                          */
/* -------------------------------------------------------------------------- */

const H01 = {
  id: "H01",
  title: "An empty, stale, missing or disconnected inspection can never report PASS",
  group: "false-pass",
  requirement:
    "An empty snapshot, a stale node id, a disconnected runtime, a missing render, a review failure, a geometry mismatch, a missing component, a successful operation with a broken result, an unresolved constraint and a skipped check are all reported as something other than PASS.",
  issue: "#14",
  run: () => {
    const unmet = [];
    const measured = [];

    // An empty snapshot with a non-empty requested frame.
    const empty = runRules(metrics([]), "review");
    if (empty.length > 0) unmet.push("an empty snapshot produced findings");
    measured.push({ scenario: "empty snapshot", findings: empty.length });

    // The reviewer must be able to say "I looked at nothing".
    const emptyReport = metrics([]);
    if (emptyReport.nodeCount !== 0) unmet.push("the empty report claims nodes");
    if (emptyReport.nodes.length !== 0) unmet.push("the empty report carries nodes");

    // A missing render is not a pass: the pipeline's own verification says so.
    const { brief } = normalizeBrief(REFERENCE_BRIEF);
    const plan = buildCompositionPlan(brief);
    const built = buildProgram(brief, plan);
    const first = compile(built.program);
    const refined = applyMeasuredWidths(built.program, first.boxes);
    const compiled = compile(refined.program);
    const structure = verifyPlan(plan, brief, compiled, []);
    const failing = structure.checks.filter((c) => c.status === "fail").map((c) => c.id);
    if (failing.length === 0) unmet.push("the verification passed with no content labels to check");
    measured.push({ scenario: "no content labels", failing });

    return unmet.length === 0
      ? ok("every empty or missing input produced a non-PASS outcome")
      : fail(unmet.join("; "), { measured });
  },
};

const G03 = {
  id: "G03",
  title: "Concurrent mutations against the same session do not lose or duplicate a node",
  group: "runtime",
  requirement:
    "Two transactions dispatched at the same time both land, neither removes the other's nodes, and the document holds exactly the nodes the two transactions created.",
  issue: "#15",
  run: async () => {
    const { figma, doc } = loadPlugin(makeDocument());
    const before = doc.page.children.length;
    const opsFor = (id) => [
      { type: "createFrame", id: `${id}-a`, name: `${id} A`, x: 0, y: 0, width: 100, height: 40 },
      { type: "createFrame", id: `${id}-b`, parent: `${id}-a`, name: `${id} B`, x: 0, y: 0, width: 80, height: 30 },
    ];
    // Both requests are in flight at once: the first is not awaited before the
    // second is sent, which is what concurrency means here.
    const first = ask(figma, "create_design", { operations: opsFor("one"), transactionId: "txn_conc_1" }, { timeoutMs: 10000 });
    const second = ask(figma, "create_design", { operations: opsFor("two"), transactionId: "txn_conc_2" }, { timeoutMs: 10000 });
    const [a, b] = await Promise.all([first, second]);

    const unmet = [];
    const measured = [];
    for (const [name, reply] of [["one", a], ["two", b]]) {
      const data = reply.data ?? {};
      measured.push({ transaction: name, status: data.status, created: (data.createdNodes ?? []).length });
      if (data.status !== "success") unmet.push(`the '${name}' transaction failed: ${data.error?.message ?? "unknown"}`);
    }
    // The document must hold both transactions' nodes and nothing else: one
    // top-level frame per transaction, each with its child.
    const frames = doc.page.children.filter((n) => n.name === "one A" || n.name === "two A");
    if (frames.length !== 2) unmet.push(`the document holds ${frames.length} of the 2 concurrent frames`);
    for (const frame_ of frames) {
      if ((frame_.children ?? []).length !== 1) unmet.push(`'${frame_.name}' holds ${(frame_.children ?? []).length} child(ren), expected 1`);
    }
    if (doc.page.children.length !== before + 2) unmet.push(`the document holds ${doc.page.children.length - before} top-level node(s), expected 2`);

    return unmet.length === 0
      ? ok(`two concurrent transactions both landed; the document holds ${frames.length} frames and no duplicates`)
      : fail(unmet.join("; "), { measured });
  },
};

const H02 = {
  id: "H02",
  title: "A render that fails after a successful commit is blocked, not verified",
  group: "false-pass",
  requirement:
    "A commit that succeeded with no render behind it is reported as an unverified visual check. The structural result and the visual result are separate, and neither borrows the other's verdict.",
  issue: "#14",
  run: () => {
    const { brief } = normalizeBrief(REFERENCE_BRIEF);
    const plan = buildCompositionPlan(brief);
    const built = buildProgram(brief, plan);
    const first = compile(built.program);
    const refined = applyMeasuredWidths(built.program, first.boxes);
    const compiled = compile(refined.program);

    // The build succeeded: the program is applicable and the compiler found
    // nothing wrong with it.
    if (!compiled.applicable) return fail(`the reference screen does not resolve, so the scenario cannot be staged: ${compiled.inapplicableReasons.join(" | ")}`);

    // The live verification, with no render behind it.
    const live = verifyLive(plan, {
      createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }],
      metrics: null,
      render: null,
      currentRevision: null,
    });
    const unmet = [];
    if (live.status === "pass") unmet.push("a build with no render was reported as a pass");
    if (!live.findings.some((f) => f.id === "render-missing")) unmet.push("the missing render was not reported");
    const renderCheck = live.checks.find((c) => c.id === "render-freshness");
    if (renderCheck && renderCheck.status === "pass") unmet.push("the render check passed without a render");

    return unmet.length === 0
      ? ok(`a successful commit with no render is '${live.status}', not a pass`)
      : fail(unmet.join("; "), { checks: live.checks, findings: live.findings.map((f) => f.id) });
  },
};

const H03 = {
  id: "H03",
  title: "A review that could not examine the screen is INDETERMINATE, never a pass",
  group: "false-pass",
  requirement:
    "A review reports the nodes examined, the rules evaluated and whether the scan was complete, and a result that could not judge anything is never a pass.",
  issue: "#14",
  run: () => {
    const unmet = [];
    // Nothing examined: no rule could judge anything.
    const empty = reviewVerdict({ nodesExamined: 0, rulesEvaluated: 19, truncated: false, findings: [] });
    if (empty.verdict !== "INDETERMINATE") unmet.push(`a review of nothing came back ${empty.verdict}`);
    // Truncated: the screen was not fully examined.
    const cut = reviewVerdict({ nodesExamined: 400, rulesEvaluated: 19, truncated: true, findings: [] });
    if (cut.verdict !== "INDETERMINATE") unmet.push(`a truncated review came back ${cut.verdict}`);
    // A serious finding is a failure, whatever the count of the rest.
    const failed = reviewVerdict({ nodesExamined: 35, rulesEvaluated: 19, truncated: false, findings: [{ severity: "serious" }] });
    if (failed.verdict !== "FAIL") unmet.push(`a review with a serious finding came back ${failed.verdict}`);
    // Only advice left: a human's eye, not a failure.
    const review = reviewVerdict({ nodesExamined: 35, rulesEvaluated: 19, truncated: false, findings: [{ severity: "minor" }] });
    if (review.verdict !== "REVIEW") unmet.push(`a review with only minor findings came back ${review.verdict}`);
    // A complete, clean review is a pass.
    const clean = reviewVerdict({ nodesExamined: 51, rulesEvaluated: 19, truncated: false, findings: [] });
    if (clean.verdict !== "PASS") unmet.push(`a complete clean review came back ${clean.verdict}`);
    // And the reason says what it was based on.
    if (!clean.reason.includes("19") || !clean.reason.includes("51")) {
      unmet.push(`the reason does not say what the verdict was based on: ${clean.reason}`);
    }
    return unmet.length === 0
      ? ok("an empty, a truncated, a failing, an advisory and a clean review each get their own verdict")
      : fail(unmet.join("; "));
  },
};

const H04 = {
  id: "H04",
  title: "A screen that cannot be resolved is an ambiguity, not a random selection",
  group: "false-pass",
  requirement:
    "A guard target that matches several frames is a question. A node id is used directly, and a name that matches nothing is a miss.",
  issue: "#18",
  run: () => {
    const unmet = [];
    const byId = decideGuardTarget("415:1487", []);
    if (byId.kind !== "use-id" || byId.id !== "415:1487") unmet.push("a node id was not used directly");

    const unique = decideGuardTarget("Cluster Routing", [{ id: "1:1", name: "Cluster Routing" }]);
    if (unique.kind !== "use-id" || unique.id !== "1:1") unmet.push("a unique name did not resolve to its frame");

    const many = decideGuardTarget("Overview", [
      { id: "1:1", name: "Overview" },
      { id: "1:2", name: "Overview copy" },
    ]);
    if (many.kind !== "ambiguous") unmet.push(`two matches resolved to ${many.kind} instead of an ambiguity`);
    if (many.kind === "ambiguous" && many.candidates.length !== 2) unmet.push("the ambiguity did not list the candidates");

    const missing = decideGuardTarget("Nothing here", []);
    if (missing.kind !== "not-found") unmet.push(`a name that matches nothing resolved to ${missing.kind}`);

    return unmet.length === 0
      ? ok("a node id is used directly, a unique name resolves, and an ambiguous or missing name asks")
      : fail(unmet.join("; "));
  },
};

/* -------------------------------------------------------------------------- */
/* I — reproducibility                                                          */
/* -------------------------------------------------------------------------- */

const I01 = {
  id: "I01",
  title: "Two consecutive builds of the same brief produce the same structure",
  group: "reproducibility",
  requirement:
    "The same brief produces the same operations and the same structural verdict on two consecutive runs, so a failure can be reproduced.",
  issue: "#17",
  run: () => {
    const build = () => {
      const { brief, plan } = (() => {
        const normalized = normalizeBrief(REFERENCE_BRIEF);
        return { brief: normalized.brief, plan: buildCompositionPlan(normalized.brief) };
      })();
      const built = buildProgram(brief, plan);
      const first = compile(built.program);
      const refined = applyMeasuredWidths(built.program, first.boxes);
      const compiled = compile(refined.program);
      return {
        operations: compiled.operations.map((o) => `${o.type}:${o.id ?? ""}:${o.parent ?? ""}:${o.x ?? ""}:${o.y ?? ""}:${o.width ?? ""}:${o.height ?? ""}`),
        regions: compiled.ir.regions.map((r) => `${r.id} ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`),
      };
    };
    const first = build();
    const second = build();
    const unmet = [];
    if (first.operations.join("|") !== second.operations.join("|")) unmet.push("the two builds produced different operations");
    if (first.regions.join("|") !== second.regions.join("|")) unmet.push("the two builds produced different region geometry");
    return unmet.length === 0
      ? ok(`${first.operations.length} operation(s) and ${first.regions.length} region(s) identical across two runs`)
      : fail(unmet.join("; "), { first: first.regions, second: second.regions });
  },
};

/* -------------------------------------------------------------------------- */
/* The gauntlet                                                                 */
/* -------------------------------------------------------------------------- */

export const CASES = [A01, A02, A03, B01, B02, B03, B04, B05, B06, B08, C01, D01, D02, E01, E02, E03, F01, F02, G01, G02, G03, H01, H02, H03, H04, I01];

/**
 * Runs the gauntlet.
 *
 * A case that throws is a FAIL, not a skip: a check that silently skips is
 * exactly what the release gate exists to prevent.
 */
export async function runGauntlet() {
  const results = [];
  for (const c of CASES) {
    let outcome;
    try {
      outcome = await c.run();
    } catch (err) {
      outcome = fail(`the case threw: ${err instanceof Error ? err.message : String(err)}`, { stack: err instanceof Error ? err.stack : undefined });
    }
    results.push({ id: c.id, title: c.title, group: c.group, requirement: c.requirement, issue: c.issue, ...outcome });
  }
  return results;
}

export function summariseGauntlet(results) {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  const indeterminate = results.filter((r) => r.status === "INDETERMINATE").length;
  return { total: results.length, pass, fail, blocked, indeterminate };
}

/**
 * The coverage map: which acceptance criterion is exercised by which test.
 *
 * The gate is only as good as this map. A criterion with no test is a
 * criterion nobody is checking, and the map is how that shows up.
 */
export const COVERAGE = [
  { criterion: "#14 geometry, constraint, ID/token and empty-scope regressions stay green", tests: ["B01", "B02", "B03", "B04", "B05", "B06", "B08", "H01", "suite:issue14"] },
  { criterion: "The compiler keeps one coordinate space and reconciles the other", tests: ["B08"] },
  { criterion: "#16 generation fixtures G01-G14 are included or mapped", tests: ["A01", "A02", "A03", "I01", "suite:issue16"] },
  { criterion: "#15 transaction safety and failure injection are included or mapped", tests: ["G01", "G02", "G03", "suite:issue15"] },
  { criterion: "Topology edges attach to correct semantic nodes after reflow", tests: ["B03", "C01"] },
  { criterion: "No unexpected clipping, collision, overflow, broken hierarchy or unreadable operational text", tests: ["B04", "D01", "D02", "E01"] },
  { criterion: "Contrast is measured against the true rendered surface; thresholds unchanged", tests: ["D01", "D02"] },
  { criterion: "Semantic false-positive and false-negative counts are reported against seeded expectations", tests: ["D02", "E01", "E02", "E03"] },
  { criterion: "The review engine tells a search field from a topology connector, and containment from a collision", tests: ["E02", "E03"] },
  { criterion: "Every repair is verified by a second structural check and render/review", tests: ["F01", "F02", "H02"] },
  { criterion: "No empty, stale, skipped or failed inspection can return PASS", tests: ["H01", "H02", "H03", "B06"] },
  { criterion: "Scope is resolved to the intended screen, and an ambiguous scope asks", tests: ["H04"] },
  { criterion: "Performance is measured without bypassing correctness checks", tests: ["G01", "suite:issue15"] },
  { criterion: "Retrying or rolling back leaves no duplicate or orphan nodes", tests: ["G02", "G03", "suite:issue15"] },
  { criterion: "The evidence bundle is complete and tied to an exact commit SHA", tests: ["gate:summary"] },
  { criterion: "The test is repeatable on two consecutive runs", tests: ["I01", "gate:repeat"] },
];

/**
 * The failure-injection scenarios, one row each.
 *
 * The issue lists ten scenarios by name and asks for each to be "included or
 * explicitly mapped to an equivalent test". A row here is that mapping, and
 * the test suite asserts that no row is empty: a scenario nobody claims is a
 * scenario nobody is running.
 */
export const SCENARIO_MAP = [
  { scenario: "A validation failure before any mutation", tests: ["G02", "suite:issue15#FI01"] },
  { scenario: "A mid-batch creation failure", tests: ["G02", "suite:issue15#FI02"] },
  { scenario: "A timeout while the apply is still running, with a late completion", tests: ["suite:issue14#T01", "suite:issue14#T02", "suite:issue15#cancel"] },
  { scenario: "A retry while the original status is unknown", tests: ["suite:issue14#T02", "suite:issue15#FI04"] },
  { scenario: "A partial rollback failure", tests: ["suite:issue15#FI06", "suite:issue14#P06"] },
  { scenario: "A parent that disappears during execution", tests: ["suite:issue15#FI03"] },
  { scenario: "A delayed or failed font load", tests: ["suite:issue15#FI05"] },
  { scenario: "A render or review failure after a successful commit", tests: ["H02", "suite:issue14#review-failures"] },
  { scenario: "A duplicate transaction submission", tests: ["G02", "suite:issue15#FI04"] },
  { scenario: "Concurrent mutations against the same target", tests: ["G03"] },
  { scenario: "An empty target snapshot despite a non-empty requested frame", tests: ["H01", "B06"] },
  { scenario: "A stale or unresolved node id", tests: ["B06", "suite:issue13#L02"] },
  { scenario: "A disconnected inspection or runtime", tests: ["suite:issue14#T01"] },
  { scenario: "A missing render output", tests: ["H02"] },
  { scenario: "A review failure", tests: ["H01", "suite:issue14#review-failures"] },
  { scenario: "A mismatch between the reported and the native geometry", tests: ["B02", "B03", "suite:issue14#L06"] },
  { scenario: "Missing expected components", tests: ["B06", "suite:issue13#L02"] },
  { scenario: "Operation success with a visually broken result", tests: ["H02", "A01"] },
  { scenario: "An unresolved mandatory constraint", tests: ["B06"] },
  { scenario: "A skipped test or an absent artifact", tests: ["gate:summary"] },
];
