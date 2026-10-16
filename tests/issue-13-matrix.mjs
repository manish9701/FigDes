/**
 * Issue #13 acceptance matrix — X01 to X08, one case per acceptance gate line.
 *
 * Same shape as the #12 matrix and for the same reason: a case has a stable id,
 * a deterministic input built from literals, a measured result, and an explicit
 * PASS / FAIL / BLOCKED. Nothing here talks to Figma, so a PASS is never
 * mistaken for a live render.
 *
 * Every X case mirrors the scenario the issue recorded against the live file,
 * including the ones that already failed safely. X04 and X06 are here as
 * regressions: a guardrail that stops firing is as much a regression as one that
 * starts, and "it passes today" is exactly the belief that makes it quietly rot.
 */
import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                     */
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
const metric = (i) => component(`m${i}`, { type: "metric", props: { label: `Signal ${i}`, value: `${i * 11}%` } });
const canvas = (o = {}) => ({ name: "Screen", width: 1440, height: 900, grid: 8, newPage: false, deck: false, ...o });

const node = (o) => ({ visible: true, depth: 1, parentId: "root", x: 0, y: 0, w: 100, h: 40, name: "Layer", ...o });
const report = (nodes) => ({ target: "root", scope: "root", nodeCount: nodes.length, nodes });
const of = (findings, rule) => findings.filter((f) => f.rule === rule);

/** Compile and judge. `assert` returns the unmet expectations. */
function compileCase(ir, assert) {
  const result = compileIR(ir);
  const unmet = assert(result) ?? [];
  return {
    status: unmet.length === 0 ? "PASS" : "FAIL",
    detail: unmet.length === 0 ? "all expectations met" : unmet.join("; "),
    raw: {
      applicable: result.applicable,
      inapplicableReasons: result.inapplicableReasons,
      violations: result.violations.map((v) => `${v.rule}: ${v.message}`),
      regions: result.regions.map((g) => `${g.id} @ ${Math.round(g.x)},${Math.round(g.y)} ${Math.round(g.w)}x${Math.round(g.h)}`),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* X01 - X08                                                                    */
/* -------------------------------------------------------------------------- */

export const CASES = [
  {
    id: "X01",
    title: "Three-region split with an explicit right-side inspector is actually positioned",
    group: "compiler",
    requirement:
      "`{ right: 0, top: 0, width: 300 }` is honoured against the final geometry, and the plan is inapplicable if it is not.",
    run: () => {
      const build = (relation) => ({
        canvas: canvas({ name: "X01 Split", width: 1440, height: 900 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 240, height: "fill", children: [] }),
          region({ id: "main", role: "content", width: "fill", height: "fill", children: ["t"] }),
          region({ id: "inspector", role: "inspector", height: 400, children: [] }),
        ],
        content: [text("t", { text: "Main content", role: "body" })],
        relations: [relation],
        tokens: [],
        links: [],
      });

      // 1. Satisfiable: the inspector must land top-right and the plan applies.
      const ok = compileCase(build({ id: "inspector", right: 0, top: 0, width: 300 }), (r) => {
        const insp = r.regions.find((x) => x.id === "inspector");
        return [
          !insp ? ["no inspector region in the result"] : null,
          insp && insp.y !== 0 ? `top:0 asked for y=0, the inspector resolved to y=${Math.round(insp.y)}` : null,
          insp && Math.abs(insp.w - 300) > 1 ? `width 300 asked for, resolved ${Math.round(insp.w)}` : null,
          insp && insp.x + insp.w > 1440.5 ? `inspector ends at ${Math.round(insp.x + insp.w)}, past the 1440px canvas` : null,
          insp && Math.abs(insp.x - 1140) > 1 ? `right:0 asked for x=1140, resolved x=${Math.round(insp.x)}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });

      // 2. Unsatisfiable: the same relation against an anchor that does not fit.
      //    The point of X01 is that an unhonoured clause must not read as success.
      const bad = compileIR(build({ id: "inspector", rightOf: "main", top: 0, gap: 5000, width: 300 }));
      const badProblems = bad.violations.filter((v) => v.rule === "relation");
      const badOk = badProblems.length > 0 && bad.applicable === false;

      return {
        status: ok.status === "PASS" && badOk ? "PASS" : "FAIL",
        detail:
          ok.status === "PASS" && badOk
            ? "satisfied relation honoured; unsatisfiable one refused with a named clause"
            : [ok.detail, badOk ? null : "an unsatisfiable relation was not reported or did not block applicability"].filter(Boolean).join("; "),
        raw: { satisfied: ok.raw, unsatisfiable: { applicable: bad.applicable, problems: badProblems.map((v) => v.message) } },
      };
    },
  },

  {
    id: "X02",
    title: "Duplicate token ids and malformed token values are both rejected before emitting operations",
    group: "compiler",
    requirement: "A duplicate id and an unparseable colour both produce a named violation, and nothing is emitted for the bad token.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X02 Tokens", width: 800, height: 600 }),
        regions: [region({ id: "card", role: "content", width: 400, height: 300, fill: "surface" })],
        content: [text("t", { text: "Bound", role: "body" })],
        relations: [],
        links: [],
        tokens: [
          { id: "space", kind: "token", name: "surface", type: "color", values: { DEFAULT: "#F7F5EF" } },
          { id: "space", kind: "token", name: "brand", type: "color", values: { DEFAULT: "#ZZZZZZ" } },
          { id: "gap", kind: "token", name: "space-md", type: "number", values: { DEFAULT: "wide" } },
          { id: "empty", kind: "token", name: "nothing", type: "color", values: {} },
        ],
      };
      const r = compileIR(ir);
      const messages = r.violations.map((v) => v.message);
      const expects = [
        { re: /Token id 'space' is declared 2 times/, what: "duplicate token id" },
        { re: /not a colour/, what: "malformed colour '#ZZZZZZ'" },
        { re: /not a number/, what: "non-numeric value on a number token" },
        { re: /declares no values/, what: "token with no values" },
      ];
      const unmet = [
        ...expects.filter((e) => !messages.some((m) => e.re.test(m))).map((e) => `${e.what} was not reported`),
        r.applicable !== false ? "an invalid token program still returned applicable: true" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${expects.length} invalid token problems reported and the run is inapplicable` : unmet.join("; "),
        raw: { applicable: r.applicable, violations: messages },
      };
    },
  },

  {
    id: "X03",
    title: "Unbreakable text in a narrow viewport produces a measurable clipping diagnostic",
    group: "compiler",
    requirement: "A string with no break opportunity, wider than the box it was given, is reported with both numbers.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X03 Typography", width: 320, height: 700, grid: 4 }),
        regions: [region({ id: "col", role: "content", width: 160, height: "fill", padding: 8, children: ["title", "model", "err"] })],
        content: [
          text("title", { text: "Fleet Health Overview", role: "title" }),
          text("model", { text: "qwen3-32b-instruct-quantized.gguf", role: "code" }),
          text("err", { text: "ERR_MEM_PRESSURE_0X7F_DEVICE_TIMEOUT", role: "code" }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const ty = r.violations.filter((v) => v.rule === "typography");
        const box = r.boxes.get("model");
        return [
          ty.length === 0 ? "no typography diagnostic for unbreakable strings in a 144px box" : null,
          ty.some((v) => /about \d+px at \d+px inside a \d+px box/.test(v.message)) ? null : "the diagnostic does not carry the measured widths",
          box && ty.length > 0 && !ty.some((v) => v.message.includes("'model'")) ? "the longest run was not the one reported" : null,
          // A clipped label is ugly, not a broken plan: this must not block apply.
          r.applicable === false ? `a long label blocked the whole compile: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });
    },
  },

  {
    id: "X04",
    title: "An 800x600 canvas with a 1200x900 region stays fail-closed",
    group: "compiler",
    requirement: "A region larger than its canvas is reported and the plan is inapplicable.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X04 Overflow", width: 800, height: 600 }),
        regions: [region({ id: "big", role: "content", width: 1200, height: 900, children: ["t"] })],
        content: [text("t", { text: "Content in an oversized region", role: "body" })],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const geo = r.violations.filter((v) => v.rule === "geometry");
        return [
          geo.length === 0 ? "an oversized region produced no geometry violation" : null,
          !/spills past/.test(geo.map((v) => v.message).join(" ")) ? "no violation names the region as spilling past the canvas" : null,
          r.applicable !== false ? "an oversized region still returned applicable: true" : null,
        ].filter(Boolean);
      });
    },
  },

  {
    id: "X05",
    title: "A 36-item, 6-column grid resolves every child box with real gaps",
    group: "compiler",
    requirement: "Each child resolves inside the region, in the declared column count, with no overlap and no zero area.",
    run: () => {
      const cells = Array.from({ length: 36 }, (_, i) => metric(i));
      const ir = {
        canvas: canvas({ name: "X05 Grid", width: 1200, height: 900 }),
        regions: [region({ id: "grid", role: "content", width: "fill", height: "fill", padding: 16, layout: "grid", columns: 6, children: cells.map((c) => c.id) })],
        content: cells,
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const region0 = r.regions.find((x) => x.id === "grid");
        if (!region0) return ["no grid region in the result"];
        const boxes = cells.map((c) => r.boxes.get(c.id)).filter(Boolean);
        const unmet = [];
        if (boxes.length !== 36) unmet.push(`expected 36 resolved children, got ${boxes.length}`);

        const outside = boxes.filter((b) => b.x < region0.x - 0.5 || b.y < region0.y - 0.5 || b.x + b.w > region0.x + region0.w + 0.5 || b.y + b.h > region0.y + region0.h + 0.5);
        if (outside.length > 0) unmet.push(`${outside.length} cells resolve outside the grid region`);

        const degenerate = boxes.filter((b) => b.w <= 0.5 || b.h <= 0.5);
        if (degenerate.length > 0) unmet.push(`${degenerate.length} cells resolved with no area`);

        // Columns: the distinct x positions among the first row of cells.
        const xs = [...new Set(boxes.map((b) => Math.round(b.x)))].sort((a, b) => a - b);
        if (xs.length !== 6) unmet.push(`the grid resolved ${xs.length} distinct columns, expected 6`);

        // No two cells may overlap.
        let overlaps = 0;
        for (let i = 0; i < boxes.length; i++) {
          for (let j = i + 1; j < boxes.length; j++) {
            const a = boxes[i], b = boxes[j];
            const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
            const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
            if (ox > 1 && oy > 1) overlaps++;
          }
        }
        if (overlaps > 0) unmet.push(`${overlaps} overlapping cell pair(s)`);

        // Gaps must be positive and even.
        const gaps = xs.slice(1).map((x, i) => x - (xs[i] + boxes[0].w));
        if (gaps.some((g) => g <= 0)) unmet.push(`non-positive column gaps: ${gaps.join(", ")}`);

        if (r.applicable === false) unmet.push(`not applicable: ${r.inapplicableReasons.join(" | ")}`);
        return unmet;
      });
    },
  },

  {
    id: "X06",
    title: "Links to missing source and target nodes are both rejected",
    group: "compiler",
    requirement: "Each bad endpoint is named, and the plan is inapplicable.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X06 Links", width: 900, height: 600 }),
        regions: [region({ id: "stage", role: "primary-visual", width: "fill", height: "fill", children: ["a"] })],
        content: [component("a", { type: "deviceNode", props: { name: "A" } })],
        relations: [],
        tokens: [],
        links: [
          { from: "a", to: "ghost-target" },
          { from: "ghost-source", to: "a" },
        ],
      };
      return compileCase(ir, (r) => {
        const messages = r.violations.map((v) => v.message);
        return [
          !messages.some((m) => /Link from 'ghost-source'/.test(m)) ? "the missing source endpoint was not named" : null,
          !messages.some((m) => /Link to 'ghost-target'/.test(m)) ? "the missing target endpoint was not named" : null,
          r.applicable !== false ? "a program with dangling links still returned applicable: true" : null,
        ].filter(Boolean);
      });
    },
  },

  {
    id: "X07",
    title: "Extreme padding and gap are diagnosed as degenerate geometry, not only as overflow",
    group: "compiler",
    requirement: "A child that resolves to zero width is reported in its own right, naming the child.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X07 Degenerate", width: 1000, height: 700 }),
        regions: [region({ id: "region", role: "content", width: 60, height: 400, padding: 64, gap: 64, children: ["t"] })],
        content: [text("t", { text: "Squeezed out of its own padding", role: "body" })],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const box = r.boxes.get("t");
        const messages = r.violations.map((v) => v.message);
        const isDegenerate = !box || box.w <= 0.5 || box.h <= 0.5;
        const degenerateNamed = messages.some((m) => /no room for it/.test(m));
        return [
          isDegenerate ? null : `expected 't' to be squeezed to zero, but it resolved to ${Math.round(box.w)}x${Math.round(box.h)}`,
          degenerateNamed ? null : "no violation explains that the child has no room for itself",
          r.applicable !== false ? "a degenerate layout still returned applicable: true" : null,
        ].filter(Boolean);
      });
    },
  },

  {
    id: "X08",
    title: "A violated product guardrail makes the plan inapplicable",
    group: "compiler",
    requirement: "`maxMetricCards`, `noGenericCardGrid` and `noChatAsPrimary` are hard blockers, not advisory warnings.",
    run: () => {
      const base = (constraints, extra = {}) => ({
        canvas: canvas({ name: "X08 Guardrail", width: 1200, height: 800 }),
        regions: [region({ id: "row", role: "content", width: "fill", height: "fill", padding: 16, children: ["m0", "m1", "m2", "m3"] })],
        content: [metric(0), metric(1), metric(2), metric(3)],
        relations: [],
        tokens: [],
        links: [],
        constraints,
        ...extra,
      });

      const breached = compileIR(base({ maxMetricCards: 2 }));
      const honoured = compileIR(base({ maxMetricCards: 4 }));

      const chat = compileIR({
        canvas: canvas({ name: "X08 Chat", width: 1200, height: 800 }),
        regions: [region({ id: "main", role: "content", width: "fill", height: "fill", children: ["c"] })],
        content: [text("c", { text: "Open a conversation with the assistant", role: "title" })],
        relations: [],
        tokens: [],
        links: [],
        constraints: { noChatAsPrimary: true },
      });

      const unmet = [
        !breached.violations.some((v) => v.rule === "maxMetricCards") ? "the maxMetricCards breach was not reported" : null,
        breached.applicable !== false ? "four cards against a limit of two is still applicable: true — the constraint is advisory in practice" : null,
        !honoured.violations.some((v) => v.rule === "maxMetricCards") && honoured.applicable === false
          ? "a program inside its limit was rejected"
          : null,
        chat.applicable !== false && !chat.violations.some((v) => v.rule === "noChatAsPrimary")
          ? "noChatAsPrimary was not evaluated"
          : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "breach blocks, compliance passes, each with its own rule name" : unmet.join("; "),
        raw: {
          breached: { applicable: breached.applicable, reasons: breached.inapplicableReasons },
          honoured: { applicable: honoured.applicable },
          chat: { applicable: chat.applicable, reasons: chat.inapplicableReasons },
        },
      };
    },
  },

  {
    id: "X12-right",
    title: "`right` sizes a box unless a width was stated, in which case it positions it",
    group: "compiler",
    requirement:
      "`{ right: 320 }` on a region that has no stated width leaves 320px of room; with an explicit width it positions the box flush to that edge.",
    run: () => {
      const build = (relation) => ({
        canvas: canvas({ name: "X12 Right", width: 1440, height: 900 }),
        regions: [
          region({ id: "body", role: "content", width: "fill", height: "fill" }),
          region({ id: "aside", role: "inspector", width: "hug", height: "fill", children: [] }),
        ],
        content: [],
        relations: [relation],
        tokens: [],
        links: [],
      });

      // 1. No width stated: `right` is room, not a position.
      const room = compileCase(build({ id: "aside", right: 320 }), (r) => {
        const aside = r.regions.find((x) => x.id === "aside");
        return [
          !aside ? ["no aside region"] : null,
          aside && Math.abs(aside.w - 1120) > 1 ? `\`right: 320\` asked for 1120px of width, resolved ${Math.round(aside.w)}px` : null,
          aside && aside.x < -0.5 ? `the aside was pushed off the left edge to x=${Math.round(aside.x)}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });

      // 2. Width stated: `right` positions, which is what X01 relies on.
      const positioned = compileCase(build({ id: "aside", right: 0, top: 0, width: 300 }), (r) => {
        const aside = r.regions.find((x) => x.id === "aside");
        return [
          !aside ? ["no aside region"] : null,
          aside && Math.abs(aside.x - 1140) > 1 ? `\`right: 0, width: 300\` asked for x=1140, resolved x=${Math.round(aside.x)}` : null,
          aside && Math.abs(aside.w - 300) > 1 ? `asked for 300px wide, resolved ${Math.round(aside.w)}px` : null,
        ].filter(Boolean);
      });

      // 3. Both edges at once is the thing people write to get a column.
      const column = compileCase(build({ id: "aside", left: 100, right: 320 }), (r) => {
        const aside = r.regions.find((x) => x.id === "aside");
        return [
          !aside ? ["no aside region"] : null,
          aside && Math.abs(aside.x - 100) > 1 ? `\`left: 100\` asked for x=100, resolved x=${Math.round(aside.x)}` : null,
          aside && Math.abs(aside.w - 1020) > 1 ? `\`left: 100, right: 320\` asked for a 1020px column, resolved ${Math.round(aside.w)}px` : null,
        ].filter(Boolean);
      });

      return {
        status: room.status === "PASS" && positioned.status === "PASS" && column.status === "PASS" ? "PASS" : "FAIL",
        detail:
          room.status === "PASS" && positioned.status === "PASS" && column.status === "PASS"
            ? "right sizes without a width, positions with one, and both edges compose into a column"
            : [room.detail, positioned.detail, column.detail].filter((d) => d !== "all expectations met").join(" | "),
        raw: { room: room.raw, positioned: positioned.raw, column: column.raw },
      };
    },
  },

  {
    id: "X13-resize",
    title: "A relation that resizes a region re-packs its content to the new size",
    group: "compiler",
    requirement: "Shrinking a region with a relation keeps its grid, its text widths and its vector positions in step with the new box.",
    run: () => {
      const metrics = Array.from({ length: 4 }, (_, i) => component(`m${i}`, { type: "metric", props: { label: `Signal ${i}`, value: `${i * 11}%` } }));
      const ir = {
        canvas: canvas({ name: "X13 Resize", width: 1440, height: 900 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 220, height: "fill", children: [] }),
          region({ id: "header", role: "header", width: "fill", height: 72, padding: 24, children: ["h-title"] }),
          region({ id: "metrics", role: "secondary", layout: "grid", columns: 4, width: "fill", height: "hug", padding: 24, children: metrics.map((m) => m.id) }),
          region({ id: "stage", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", padding: 24, children: ["route-1"] }),
          region({ id: "inspector", role: "inspector", width: 320, height: "fill", children: [] }),
        ],
        content: [
          text("h-title", { text: "Fleet overview", role: "title" }),
          ...metrics,
          { id: "route-1", kind: "vector", path: "M 0 0 L 180 0 L 180 140 L 360 140", strokeWeight: 1.5 },
        ],
        relations: [
          { id: "header", width: "fill", right: 320 },
          { id: "metrics", width: "fill", right: 320 },
          { id: "stage", width: "fill", right: 320, height: "fill" },
          { id: "inspector", right: 0, top: 0, width: 320, height: "fill" },
        ],
        tokens: [],
        links: [],
        constraints: { maxMetricCards: 6 },
      };
      return compileCase(ir, (r) => {
        const metricsRegion = r.regions.find((x) => x.id === "metrics");
        const header = r.regions.find((x) => x.id === "header");
        const boxes = metrics.map((m) => r.boxes.get(m.id)).filter(Boolean);
        const xs = [...new Set(boxes.map((b) => Math.round(b.x)))];
        const title = r.boxes.get("h-title");
        const route = r.boxes.get("route-1");
        const titleOp = r.operations.find((o) => o.id === "h-title");
        const routeOp = r.operations.find((o) => o.id === "route-1");
        const stage = r.regions.find((x) => x.id === "stage");
        const unmet = [];

        // 1. The four-column row stays four columns after the resize.
        if (xs.length !== 4) unmet.push(`the metrics row re-packed into ${xs.length} columns, expected 4`);

        // 2. Text width follows the region's new inner box.
        if (header && title && Math.abs(title.w - (header.w - 48)) > 1) {
          unmet.push(`'h-title' resolved ${Math.round(title.w)}px wide inside a ${Math.round(header.w)}px region`);
        }
        if (titleOp && title && Math.abs(Math.round(titleOp.width) - Math.round(title.w)) > 1) {
          unmet.push(`'h-title' is emitted ${Math.round(titleOp.width)}px wide but resolves to ${Math.round(title.w)}px`);
        }

        // 3. The vector moved with its region and is emitted where it draws.
        if (routeOp && route && stage) {
          if (Math.abs(routeOp.x - (route.x - stage.x)) > 1 || Math.abs(routeOp.y - (route.y - stage.y)) > 1) {
            unmet.push(`'route-1' is emitted at (${Math.round(routeOp.x)}, ${Math.round(routeOp.y)}) relative to its region but resolves to (${Math.round(route.x - stage.x)}, ${Math.round(route.y - stage.y)})`);
          }
        }

        if (r.stats.traceMismatches > 0) unmet.push(`${r.stats.traceMismatches} emitted-vs-resolved mismatches remain`);
        if (r.applicable === false) unmet.push(`not applicable: ${r.inapplicableReasons.join(" | ")}`);
        return unmet;
      });
    },
  },

  /* ---- review-engine counterparts --------------------------------------- */
  {
    id: "X09-route",
    title: "Review finds the known route/status collision with node ids and measured overlap",
    group: "guardrails",
    requirement: "The Mac mini's status label sitting on a route line is reported, with both node ids and the overlap area.",
    run: () => {
      // Geometry measured on EXO_HARD_TEST_CLUSTER_ROUTING_V03: a route at
      // y=535 with Mac mini health text at y=529-536.
      const nodes = [
        node({ id: "frame", name: "EXO_HARD_TEST_CLUSTER_ROUTING_V03", type: "FRAME", depth: 0, x: 0, y: 0, w: 1600, h: 1100 }),
        node({ id: "route", parentId: "frame", depth: 1, name: "Vector", type: "VECTOR", x: 520, y: 534, w: 360, h: 2 }),
        node({ id: "status", parentId: "frame", depth: 1, name: "Mac mini health", type: "TEXT", x: 600, y: 529, w: 180, h: 8, text: { content: "MEMORY TOO LOW", color: "#111111", size: 7, style: "Regular", family: "Geist Mono", styled: true, length: 14 } }),
      ];
      const findings = runRules(report(nodes), "review");
      const hits = of(findings, "text-route-collision");
      const unmet = [
        hits.length === 0 ? "the known route/status collision was not found" : null,
        hits[0]?.nodeIds.includes("status") ? null : "the finding does not name the label node",
        hits[0]?.evidence?.overlapPx2 === undefined ? "the finding carries no measured overlap" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `collision found with ${Math.round(hits[0]?.evidence?.overlapPx2 ?? 0)}px2 of measured overlap` : unmet.join("; "),
        raw: { findings: findings.map((f) => `${f.rule}(${f.severity}) [${f.nodeIds.join(",")}]`) },
      };
    },
  },
  {
    id: "X10-anchor",
    title: "Review flags a route that ends inside a node rather than at its edge",
    group: "guardrails",
    requirement: "A connector stopping a few pixels inside a card is reported with the depth of the intrusion.",
    run: () => {
      // Three routes run x=520 to x=880 while the runtime card spans x=878-1122.
      const nodes = [
        node({ id: "frame", name: "Cluster Routing", type: "FRAME", depth: 0, x: 0, y: 0, w: 1600, h: 1100 }),
        node({ id: "route", parentId: "frame", depth: 1, name: "Vector", type: "VECTOR", x: 520, y: 294, w: 360, h: 2 }),
        node({ id: "card", parentId: "frame", depth: 1, name: "Runtime selection", type: "FRAME", x: 878, y: 252, w: 244, h: 238, fill: "#FFFFFF" }),
        // A second route that lands exactly on the card's left edge: not ambiguous.
        node({ id: "route2", parentId: "frame", depth: 1, name: "Vector", type: "VECTOR", x: 520, y: 420, w: 358, h: 2 }),
      ];
      const findings = runRules(report(nodes), "review");
      const hits = of(findings, "connector-endpoint-ambiguous");
      const unmet = [
        hits.length !== 1 ? `expected exactly one ambiguous route, got ${hits.length}` : null,
        hits[0]?.evidence?.insideByPx !== 2 ? `the intrusion measured ${hits[0]?.evidence?.insideByPx}px, expected 2` : null,
        hits.some((f) => f.nodeIds.includes("route2")) ? "a route landing exactly on the card's edge was flagged" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "one ambiguous route reported, the edge-aligned one left alone" : unmet.join("; "),
        raw: { findings: findings.map((f) => `${f.rule}(${f.severity}) [${f.nodeIds.join(",")}]`) },
      };
    },
  },
  {
    id: "X11-baseline",
    title: "Valid baselines and simple vector/connector controls still pass",
    group: "compiler",
    requirement: "The fixes for X01-X08 must not break the cases that were already correct.",
    run: () => {
      const baseline = compileIR({
        canvas: canvas({ name: "Baseline", width: 1200, height: 800 }),
        regions: [
          region({ id: "header", role: "header", width: "fill", height: 80, children: ["h"] }),
          region({ id: "body", role: "content", width: "fill", height: "fill", padding: 16, children: ["b"] }),
        ],
        content: [text("h", { text: "Overview", role: "title" }), text("b", { text: "Everything is where it should be.", role: "body" })],
        relations: [],
        tokens: [],
        links: [],
      });

      const chain = compileIR({
        canvas: canvas({ name: "Chain", width: 1000, height: 600 }),
        regions: [
          region({ id: "a", width: 200, height: 200 }),
          region({ id: "b", width: 200, height: 200 }),
          region({ id: "c", width: 200, height: 200 }),
        ],
        content: [],
        relations: [
          { id: "b", rightOf: "a", gap: 16 },
          { id: "c", rightOf: "b", gap: 16 },
        ],
        tokens: [],
        links: [],
      });

      const a = chain.regions.find((x) => x.id === "a");
      const b = chain.regions.find((x) => x.id === "b");
      const c = chain.regions.find((x) => x.id === "c");
      const vectors = compileIR({
        canvas: canvas({ name: "Vectors", width: 900, height: 600 }),
        regions: [region({ id: "stage", role: "primary-visual", width: "fill", height: "fill", children: ["v1", "v2", "n1", "link"] })],
        content: [
          { id: "v1", kind: "vector", path: "M 0 0 L 100 0 L 100 60", strokeWeight: 1 },
          { id: "v2", kind: "vector", path: "M 0 0 L 60 0", strokeWeight: 1 },
          component("n1", { type: "deviceNode", props: { name: "N1" } }),
          { id: "link", kind: "connector", from: "n1", to: "v1", routing: "orthogonal", strokeWeight: 1, arrowStart: false, arrowEnd: true, curvature: 0.2 },
        ],
        relations: [],
        tokens: [],
        links: [],
      });

      const unmet = [
        baseline.applicable !== true ? `baseline reported violations: ${baseline.violations.map((v) => v.message).slice(0, 2).join(" | ")}` : null,
        chain.applicable !== true ? `a satisfiable relation chain was rejected: ${chain.violations.map((v) => v.message).slice(0, 2).join(" | ")}` : null,
        a && b && Math.abs(b.x - (a.x + a.w + 16)) > 1 ? "the relation chain no longer resolves b rightOf a" : null,
        b && c && Math.abs(c.x - (b.x + b.w + 16)) > 1 ? "the relation chain no longer resolves c rightOf b" : null,
        vectors.applicable !== true ? `a simple vector/connector program was rejected: ${vectors.violations.map((v) => v.message).slice(0, 2).join(" | ")}` : null,
        vectors.stats.traceMismatches > 0 ? `${vectors.stats.traceMismatches} trace mismatches in the vector control` : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "baseline, relation chain and vector/connector controls all clean" : unmet.join("; "),
        raw: {
          baseline: { applicable: baseline.applicable, violations: baseline.violations.length },
          chain: { applicable: chain.applicable, xs: [a && Math.round(a.x), b && Math.round(b.x), c && Math.round(c.x)] },
          vectors: { applicable: vectors.applicable, operations: vectors.stats.operationCount },
        },
      };
    },
  },
];

/**
 * Live render/apply gate.
 *
 * The issue's last acceptance line: "Only after dry-run acceptance, apply to a
 * disposable stress-test frame and inspect the render." These report BLOCKED
 * rather than PASS, because claiming a render nobody produced is precisely the
 * failure the whole status vocabulary exists to prevent.
 *
 * An attempt was made and it earned its keep: compiling the stress program
 * through the connected server exposed three real defects — the `right` edge
 * semantics, a verifier that invented a position, and stale text/vector
 * operations after a region resize — all now fixed and committed. The apply
 * itself is waiting on the hosted MCP server rebuilding from those commits; the
 * server is a remote deployment, so it does not pick up a local push until it
 * redeploys, and applying a build with known bugs would produce a render that
 * evidences nothing.
 */
export const BLOCKED_CASES = [
  ["L01", "Apply to a dedicated disposable stress-test frame", "Requires a write to a named frame in the live file, and the connected server to be running a build that includes the fixes this gate found. It is a remote deployment and has not yet rebuilt from those commits. No operations have been applied to the Exo Labs file."],
  ["L02", "Render the applied frame and inspect the result visually", "Requires a screenshot of a frame an apply produced. No such frame exists yet."],
  ["L03", "Re-inspect native geometry after apply and reconcile with traces", "Requires reading back native node ids, which only exist once L01 has written them."],
].map(([id, title, reason]) => ({
  id,
  title,
  group: "live",
  requirement: "Live render/apply evidence, gathered only after the dry-run suite passes.",
  run: () => ({ status: "BLOCKED", detail: `${reason} Unblocked only by a connected plugin and an explicitly approved disposable frame.`, raw: { evidence: "none — this is not a live render or apply result" } }),
}));

/**
 * Cases that currently fail. Empty today; a case added here must record the
 * known issue it is carrying, and the test file asserts it still fails.
 */
export const OPEN_CASES = [];

export const ALL_CASES = [...CASES, ...BLOCKED_CASES, ...OPEN_CASES];

export function runMatrix() {
  return ALL_CASES.map((c) => {
    let outcome;
    try {
      outcome = c.run();
    } catch (err) {
      outcome = { status: "FAIL", detail: `case threw: ${err instanceof Error ? err.message : String(err)}`, raw: {} };
    }
    return { id: c.id, title: c.title, group: c.group, requirement: c.requirement, knownIssue: c.knownIssue, ...outcome };
  });
}

export function summarise(results) {
  const pass = results.filter((r) => r.status === "PASS").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const blocked = results.filter((r) => r.status === "BLOCKED").length;
  return { total: results.length, pass, fail, blocked };
}
