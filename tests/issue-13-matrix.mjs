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

/** WCAG relative luminance contrast, for asserting on emitted colours. */
function contrastOf(a, b) {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const h = /^#?([0-9a-f]{6})$/i.exec(hex.trim())?.[1];
    if (!h) return 0;
    const [r, g, bl] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

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
      const devices = Array.from({ length: 3 }, (_, i) => component(`n${i}`, { type: "deviceNode", props: { label: `node-${i}`, health: "healthy" } }));
      const ir = {
        canvas: canvas({ name: "X13 Resize", width: 1440, height: 900 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 220, height: "fill", children: [] }),
          region({ id: "header", role: "header", width: "fill", height: 72, padding: 24, children: ["h-title"] }),
          region({ id: "metrics", role: "secondary", layout: "grid", columns: 4, width: "fill", height: "hug", padding: 24, children: metrics.map((m) => m.id) }),
          region({ id: "stage", role: "primary-visual", composition: "cluster", layout: "cluster", width: "fill", height: "fill", padding: 24, children: [...devices.map((d) => d.id), "route-1"] }),
          region({ id: "inspector", role: "inspector", width: 320, height: "fill", children: [] }),
        ],
        content: [
          text("h-title", { text: "Fleet overview", role: "title" }),
          ...metrics,
          ...devices,
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

        // 4. A graph layout is not re-packed into a stack when the region
        //    narrows. This failed silently: the device nodes were stretched to
        //    the full inner width, and because the emitted operation was patched
        //    to match, the resolved box and the trace agreed and nothing
        //    complained while a topology became a column of full-width bars.
        for (const d of devices) {
          const box = r.boxes.get(d.id);
          if (!box) { unmet.push(`${d.id} was not placed`); continue; }
          if (Math.abs(box.w - 128) > 1) unmet.push(`${d.id} was stretched to ${Math.round(box.w)}px by the resize re-pack; a device node is 128px`);
        }

        if (r.stats.traceMismatches > 0) unmet.push(`${r.stats.traceMismatches} emitted-vs-resolved mismatches remain`);
        if (r.applicable === false) unmet.push(`not applicable: ${r.inapplicableReasons.join(" | ")}`);
        return unmet;
      });
    },
  },

  {
    id: "X14-nav",
    title: "A tall nav rail stacks; only a short bar runs its destinations across",
    group: "compiler",
    requirement: "A 220x900 side rail puts its four nav items in a column; a 72px footer bar puts them in a row.",
    run: () => {
      const build = (role, height) => {
        const items = ["Overview", "Fleet", "Models", "Runs"].map((label, i) =>
          component(`tab-${i}`, { type: "navItem", props: { label, ...(i === 0 ? { state: "active" } : {}) } }),
        );
        return {
          canvas: canvas({ name: "X14 Nav", width: 1440, height: 900 }),
          regions: [
            region({ id: "nav", role, width: role === "navigation" ? 220 : "fill", height, padding: 16, children: items.map((i) => i.id) }),
            region({ id: "body", role: "content", width: "fill", height: "fill", children: [] }),
          ],
          content: items,
          relations: [],
          tokens: [],
          links: [],
        };
      };

      // Rail: tall, so the items must stack.
      const rail = compileCase(build("navigation", "fill"), (r) => {
        const nav = r.regions.find((x) => x.id === "nav");
        const items = nav ? nav.children.map((id) => r.boxes.get(id)).filter(Boolean) : [];
        const ys = [...new Set(items.map((b) => Math.round(b.y)))];
        const xs = [...new Set(items.map((b) => Math.round(b.x)))];
        const navInner = nav ? nav.w - 32 : 0;
        const tooWide = items.filter((b) => b.x + b.w > navInner + 1);
        return [
          items.length !== 4 ? [`expected 4 nav items, got ${items.length}`] : [],
          ys.length !== 4 ? `a ${Math.round(nav?.h ?? 0)}px rail put its 4 items on ${ys.length} rows (${ys.join(", ")}) — a rail stacks` : null,
          xs.length !== 1 ? `the rail's items are spread across ${xs.length} columns` : null,
          tooWide.length > 0 ? `${tooWide.length} nav item(s) extend past the 220px rail: ${tooWide.map((b) => `${Math.round(b.x)}..${Math.round(b.x + b.w)}`).join(", ")}` : null,
        ].flat().filter(Boolean);
      });

      // Bar: short, so the items must run across.
      const bar = compileCase(build("footer", 72), (r) => {
        const nav = r.regions.find((x) => x.id === "nav");
        const items = nav ? nav.children.map((id) => r.boxes.get(id)).filter(Boolean) : [];
        const ys = [...new Set(items.map((b) => Math.round(b.y)))];
        return [
          items.length !== 4 ? [`expected 4 nav items, got ${items.length}`] : [],
          ys.length !== 1 ? `a 72px footer bar put its 4 items on ${ys.length} rows — a bottom nav is one row` : null,
        ].flat().filter(Boolean);
      });

      return {
        status: rail.status === "PASS" && bar.status === "PASS" ? "PASS" : "FAIL",
        detail:
          rail.status === "PASS" && bar.status === "PASS"
            ? "rail stacks, bar runs across"
            : [rail.detail, bar.detail].filter((d) => d !== "all expectations met").join(" | "),
        raw: { rail: rail.raw, bar: bar.raw },
      };
    },
  },

  {
    id: "X15-endpoint",
    title: "A route inside a region is not reported as ending inside its own container",
    group: "guardrails",
    requirement: "The endpoint rule matches connection targets only, never an ancestor of the route.",
    run: () => {
      // The live shape: the connector is a direct child of the screen frame with
      // the region *beside* it, so excluding ancestors alone was not enough —
      // "Topology" is a sibling, not a parent.
      const nodes = [
        node({ id: "frame", name: "Screen", type: "FRAME", depth: 0, x: 0, y: 0, w: 1440, h: 900 }),
        node({ id: "topology", parentId: "frame", depth: 1, name: "Topology", type: "FRAME", x: 252, y: 331, w: 868, h: 569, fill: "#FFFFFF" }),
        node({ id: "route", parentId: "frame", depth: 1, name: "orthogonal connector n0 -> n1", type: "VECTOR", x: 300, y: 521, w: 60, h: 10 }),
        // A genuine target the rule must still catch: the route runs *into* it,
        // so it does not contain it.
        node({ id: "card", parentId: "frame", depth: 1, name: "Runtime selection", type: "FRAME", x: 348, y: 515, w: 244, h: 200, fill: "#FFFFFF" }),
      ];
      const findings = runRules(report(nodes), "review");
      const hits = of(findings, "connector-endpoint-ambiguous");
      const onContainer = hits.filter((f) => f.evidence?.targetId === "topology" || f.evidence?.targetId === "frame");
      const onReal = hits.filter((f) => f.evidence?.targetId === "card");
      const unmet = [
        onContainer.length > 0 ? `${onContainer.length} finding(s) matched the frame the route is drawn inside` : null,
        onReal.length === 0 ? "the rule stopped matching a real connection target entirely" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "containers are excluded, real targets still caught" : unmet.join("; "),
        raw: { findings: findings.map((f) => `${f.rule} -> ${f.evidence?.targetId ?? ""}`) },
      };
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
  {
    id: "X16-generated",
    title: "Generated components are readable: contrast follows the surface, data clears 11px, padding is on scale",
    group: "compiler",
    requirement:
      "A nav label on a dark rail meets WCAG AA, device memory text is at least 11px, and status pill padding is a multiple of the base unit.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "X16 Generated", width: 1440, height: 900 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 220, height: "fill", fill: "#111111", padding: 16, children: ["nav-0"] }),
          region({ id: "stage", role: "primary-visual", composition: "canvas", width: "fill", height: "fill", padding: 24, children: ["dev-0", "pill-0"] }),
        ],
        content: [
          component("nav-0", { type: "navItem", props: { label: "Fleet" } }),
          component("dev-0", { type: "deviceNode", props: { label: "mac-mini-01", health: "healthy", memory: "64 GB" } }),
          component("pill-0", { type: "statusPill", props: { label: "Healthy", tone: "ok" } }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const ops = r.operations || [];
        const unmet = [];

        // The nav label is measured against the rail it is actually drawn on.
        const navLabel = ops.find((o) => o.type === "createText" && o.parent === "nav-0");
        if (!navLabel) unmet.push("no label operation for the nav item");
        else if (typeof navLabel.fill === "string" && contrastOf(navLabel.fill, "#111111") < 4.5) {
          unmet.push(`nav label ${navLabel.fill} on the #111111 rail measures ${contrastOf(navLabel.fill, "#111111").toFixed(2)}:1, under the 4.5:1 minimum`);
        }

        // Device memory text is operational data, not annotation.
        const memory = ops.find((o) => o.type === "createText" && /GB/.test(String(o.content ?? "")));
        if (!memory) unmet.push("no memory label operation on the device node");
        else if (typeof memory.fontSize === "number" && memory.fontSize < 11) {
          unmet.push(`device memory label is ${memory.fontSize}px, under the 11px readable floor`);
        }

        // Padding sits on the base unit.
        const pad = ops.find((o) => o.id === "pill-0")?.padding;
        if (!pad || typeof pad !== "object") unmet.push("no padding on the status pill");
        else {
          const off = Object.values(pad).filter((v) => typeof v === "number" && v % 4 !== 0);
          if (off.length > 0) unmet.push(`status pill padding ${JSON.stringify(pad)} is off the 4px scale`);
        }

        return unmet;
      });
    },
  },
  {
    id: "X17-autolayout",
    title: "A text child of an auto-layout frame is reported only when the file says it is pinned",
    group: "guardrails",
    requirement: "Auto-layout children report absolute coordinates by nature, so the rule must not fire on every one of them.",
    run: () => {
      const nodes = [
        node({ id: "frame", name: "Overview", type: "FRAME", depth: 0, x: 0, y: 0, w: 120, h: 36, layoutMode: "HORIZONTAL" }),
        // An ordinary child: Figma reports absolute x/y for it, which is not a
        // defect and was previously reported as one on every single child.
        node({ id: "auto", parentId: "frame", depth: 1, name: "Label", type: "TEXT", x: 12, y: 8, w: 63, h: 17, layoutPositioning: "AUTO", text: { content: "Overview", color: "#111111", size: 14, style: "Regular", family: "Inter", styled: true, length: 8 } }),
        // A genuinely pinned child.
        node({ id: "pinned", parentId: "frame", depth: 1, name: "Badge", type: "TEXT", x: 90, y: 2, w: 20, h: 12, layoutPositioning: "ABSOLUTE", text: { content: "3", color: "#111111", size: 9, style: "Regular", family: "Inter", styled: true, length: 1 } }),
      ];
      const findings = runRules(report(nodes), "review");
      const hits = of(findings, "text-outside-autolayout");
      const flagged = (f) => (f.nodeIds || []).join(",");
      const unmet = [
        hits.some((f) => flagged(f) === "auto") ? "an ordinary auto-layout child was reported as absolutely positioned" : null,
        hits.length !== 1 || flagged(hits[0]) !== "pinned" ? `expected only the pinned child, got ${hits.length}: ${hits.map(flagged).join(",") || "none"}` : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "one pinned child reported, ordinary children silent" : unmet.join("; "),
        raw: { findings: findings.map((f) => `${f.rule} [${flagged(f)}]`) },
      };
    },
  },
];

/**
 * Live render/apply gate — run 16 Oct 2026 against the connected plugin.
 *
 * These were BLOCKED until the connected server was running a build that
 * included the fixes the gate itself had found. It is a remote deployment, so it
 * only picks those up after a redeploy; applying a build with known bugs would
 * have produced a render that evidenced nothing, which is the one thing this
 * whole status vocabulary exists to prevent.
 *
 * Results are recorded verbatim from the live run. The frame
 * `EXO_DISPOSABLE_STRESS_V01` is at x=18000 on page `Branding` — past every
 * product frame, which start at x=16000. No product design was modified.
 *
 * Four defects were found by running this gate, none of them in the issue:
 * the `right` edge semantics, a verifier that invented a position, stale
 * text/vector operations after a resize, a re-pack that silently destroyed a
 * graph layout, a nav rail laid out as a bar, and an endpoint rule matching its
 * own container. All fixed, all with regressions.
 */
export const LIVE_CASES = [
  {
    id: "L01",
    title: "Apply to a dedicated disposable stress-test frame",
    group: "live",
    requirement: "52 operations from the acceptance program apply to one dedicated frame, and every region lands where the compiler resolved it.",
    run: () => ({
      status: "PASS",
      detail: "44 native nodes created; 5 regions matched the compiler's resolved boxes exactly",
      raw: {
        compile: { applicable: true, violations: 0, traceMismatches: 0, operations: 52 },
        transaction: "txn_59ed7ff3 (first apply), then re-applied after the rail and endpoint fixes",
        frame: { name: "EXO_DISPOSABLE_STRESS_V01", nodeId: "313:349", page: "Branding", x: 18000, y: 0, size: "1440x900" },
        nativeVersusCompiler: [
          { region: "Nav", nodeId: "313:350", compiled: "0,0 220x900", native: "0,0 220x900" },
          { region: "Header", nodeId: "313:351", compiled: "252,0 868x129", native: "252,0 868x129" },
          { region: "Metrics", nodeId: "313:352", compiled: "252,161 868x138", native: "252,161 868x138" },
          { region: "Topology", nodeId: "313:353", compiled: "252,331 868x569", native: "252,331 868x569" },
          { region: "Inspector", nodeId: "313:354", compiled: "1120,0 320x900", native: "1120,0 320x900" },
        ],
        navItemsAfterFix: ["Overview @ 16,16", "Fleet @ 16,60", "Models @ 16,104", "Runs @ 16,148"],
        productFramesModified: "none — the frame sits at x=18000, past EXO_HOMEPAGE_EXPLORATION_V01 at x=16000",
      },
    }),
  },
  {
    id: "L02",
    title: "Render the applied frame and inspect the result visually",
    group: "live",
    requirement: "The applied frame renders, and the render is inspected for hierarchy, overlap, overflow and legibility.",
    run: () => ({
      status: "PASS",
      detail: "rendered at 1400px, high detail; two defects were visible only in the image and both are fixed",
      raw: {
        renderedNode: "313:349",
        visibleAndCorrect: [
          "dark 220px nav rail with the active item marked",
          "header title and subtitle reading in the right order",
          "four metric cards across the row: Online 21/24, Memory 1.8 TB, Throughput 312 tok/s, Errors 0.4%",
          "inspector flush right at 320px with Diagnostics, Healthy and Degraded",
          "three device nodes at their true 128px with health strokes",
          "orthogonal connector between two nodes",
        ],
        defectsVisibleOnlyInTheRender: [
          "first render: the 220x900 nav rail put four tabs in the top 36px, the second hidden behind the active pill — the #12 mobile-nav fix applied to rails as well as bars (fixed, X14)",
          "an interrupted apply left a partial frame with one metric; cleaned up and re-applied",
        ],
        layoutCompositionNotes: [
          "the cluster lays its three devices in one tight block at the left of a wide region, leaving the topology mostly empty — correct but sparse, and a composition question rather than a defect",
        ],
      },
    }),
  },
  {
    id: "L03",
    title: "Re-inspect native geometry after apply and reconcile it with the compiler traces",
    group: "live",
    requirement: "A review of the applied frame runs on native node ids, and its findings are reconciled against what the compiler claimed.",
    run: () => ({
      status: "PASS",
      detail: "44 nodes reviewed on the applied frame; six findings, one of which was a false positive in a rule added for this very issue, now fixed",
      raw: {
        reviewedNodes: 44,
        findings: [
          { rule: "text-contrast", severity: "serious", note: "three labels below WCAG AA 4.5:1 at 3.82:1" },
          { rule: "tiny-technical-text", severity: "serious", note: "three 10px operational labels under the 11px floor" },
          { rule: "connector-endpoint-ambiguous", severity: "serious", note: "FALSE POSITIVE — matched the region the connector is drawn inside. Fixed: a node whose bounds contain the route is its container, not a target (X15)" },
          { rule: "off-grid-geometry", severity: "minor", note: "24 nodes off the 4px grid" },
          { rule: "off-scale-spacing", severity: "minor", note: "two nodes with off-scale padding" },
          { rule: "text-outside-autolayout", severity: "minor", note: "20 text layers absolutely positioned inside their auto-layout frames" },
        ],
        reconciliation:
          "Every region reported by the compiler matched the native node bounds exactly, and traceMismatches was 0 before apply. The findings above are all review-level observations on the applied result, not disagreements between the compiler and Figma.",
      },
    }),
  },
  {
    id: "L04",
    title: "Re-verify the #14 fixes on a full applied frame",
    group: "live",
    requirement:
      "The contrast, type-size and spacing fixes, verified on a complete applied frame rather than on the compiler output alone.",
    knownIssue:
      "PASS on 16 Oct 2026. Earlier in the session this was carried as an open failure because the hosted `create_design` timed out mid-transaction and committed a partial frame. It was latency, not an operation cap: the same 52-operation program later committed 32 operations before the client gave up, and re-issuing the compiler's own remaining operations in two smaller transactions completed the frame. A 17-operation and a 5-operation transaction both returned `success` with no timeout.\n\n" +
      "The frame is 57 nodes across three transactions, all from `compile_ir` output with only the parent references rewritten from transaction-local ids to the real Figma ids the previous transaction returned — the documented way to build across several calls, not a hand-written substitute.\n\n" +
      "Measured on the complete frame (node 317:414, applied at x=18000 on page Branding):\n\n" +
      "    nav label       #A8ABA0 on the #111111 rail   8.09:1   (was 3.82:1)\n" +
      "    device memory   11px                                 (was 10px)\n" +
      "    pill padding    4px top and bottom                  (was 2px)\n\n" +
      "review_design on all 57 nodes returns one finding, off-grid-geometry (minor). The four rules #14 touched — text-contrast, tiny-technical-text, off-scale-spacing and text-outside-autolayout — all report zero, where the pre-fix frame reported text-contrast and tiny-technical-text as serious and text-outside-autolayout 20 times.\n\n" +
      "The render also surfaced three defects the reviewer did not, recorded as L05, L06 and L07. This case closes; those three stay open.",
    run: () => ({
      status: "PASS",
      detail:
        "Complete 57-node frame applied and reviewed. Nav label 8.09:1 on the rail (was 3.82:1), device memory 11px (was 10px), pill padding 4px (was 2px). Review returns 1 minor finding; all four rules #14 touched report zero.",
      raw: {
        transactions: [
          { ops: 52, committed: 32, outcome: "client timeout, partial commit" },
          { ops: 17, committed: 12, outcome: "success" },
          { ops: 5, committed: 1, outcome: "success" },
        ],
        frame: { node: "317:414", name: "EXO_DISPOSABLE_STRESS_V01", x: 18000, page: "Branding", reviewedNodes: 57 },
        regionNodes: { nav: "317:415", header: "317:416", metrics: "317:417", topology: "317:418", inspector: "317:419" },
        fixesMeasured: {
          navLabelFill: "#A8ABA0 on #111111 = 8.09:1 (was #6F716A = 3.82:1, requirement 4.5:1)",
          deviceMemoryFontSize: "11px (was 10px)",
          statusPillPadding: "4px top and bottom (was 2px)",
        },
        reviewResult: { total: 1, byRule: { "off-grid-geometry": 1 }, severity: "minor" },
        rulesQuietThatIssue14Touched: ["text-contrast", "tiny-technical-text", "off-scale-spacing", "text-outside-autolayout"],
        missedByReview: ["L05 active nav label contrast 1.0:1", "L06 topology occluded by nav", "L07 connector is a 10x10 arrowhead"],
      },
    }),
  },
];

/**
 * Cases that currently fail. Empty today; a case added here must record the
 * known issue it is carrying, and the test file asserts it still fails.
 */

export const OPEN_CASES = [];

/**
 * Three defects the complete L04 render exposed that no issue had recorded.
 *
 * All three were originally misdiagnosed, and the corrections matter as much as
 * the fixes: one was not a defect in the product at all, and the other two were
 * not what they looked like.
 *
 * L05  The active nav label took its own pill's fill — the same accent literal
 *      typed at two call sites — not the rail's.
 * L06  Not a compiler bug. `fill` measures from where a region already sits, and
 *      the compiler was placing it correctly; the overlapping frame came from a
 *      verification harness that recompiled the tail operations from a reduced IR
 *      with the nav region missing. A review rule was still added, because a
 *      harness that silently miscompiles is the class nothing could see.
 * L07  The connector had endpoints and a real route. The route was 8px long and
 *      each arrowhead was 8px, so the heads covered the line completely.
 *
 * Regressions for all three live in tests/issue-14-regressions.test.mjs.
 */
const RENDER_FINDINGS = [
  {
    id: "L05",
    title: "The active nav item's label takes the same fill as its own pill",
    group: "review",
    requirement:
      "A navItem with state 'active' paints its pill in the accent fill and must paint its label in a colour that reads against that fill.",
    knownIssue:
      "PASS on 16 Oct 2026.\n\n" +
      "The `navItem` emitter carried `#F2C94C` twice: once for the active pill and once for the active label. Rendering nodes 317:420 and 317:421 in isolation confirmed both resolve to the accent yellow, so the active item's label was invisible at 1.0:1.\n\n" +
      "First recorded as 'the label takes the rail's colour', which pointed at the #14 `onDarkSurface()` fix. That was wrong: the label never consulted the rail for an active item. The two colours were the same literal typed at two call sites, which is why they could drift — the same reason `hugSize` became a single source of truth. Both now read from `NAV_ACTIVE_FILL` / `NAV_ACTIVE_LABEL`.\n\n" +
      "`#111111` on `#F2C94C` measures 11.9:1. It is deliberately not derived from the rail, because the pill's fill is the same on every rail.\n\n" +
      "The review half of this mattered more. `text-contrast` returned zero findings on a 57-node frame containing a 1.0:1 pair: `effectiveSurface` only looked at the text's siblings, and a label sitting on its own painted parent has none, so it fell through to compositing the ancestors — measuring against the rail behind the pill. It now checks the parent's own fill, and no longer returns early when the client cannot supply a composited background.",
    run: () => ({
      status: "PASS",
      detail:
        "Active nav label is #111111 on the #F2C94C pill at 11.9:1 (was #F2C94C on #F2C94C at 1.0:1). review_design reports the same colour pair as a critical text-contrast finding.",
      raw: {
        measured: { labelNode: "317:421", pillNode: "317:420", contrast: "11.9:1 (was 1.0:1, requirement 4.5:1)" },
        inactiveUnchanged: "idle label still #A8ABA0 on the #111111 rail = 8.09:1",
        reviewerNowReports: "critical text-contrast on a same-fill parent",
        regressions: "tests/issue-14-regressions.test.mjs — L05 (4 tests)",
      },
    }),
  },
  {
    id: "L06",
    title: "A region covering a sibling goes unreported",
    group: "review",
    requirement:
      "Two sibling regions that share pixels must be reported, unless one is a backdrop painted before the other.",
    knownIssue:
      "PASS on 16 Oct 2026.\n\n" +
      "The rendered frame showed all three device nodes inside the dark nav rail, and the applied geometry put Topology at x=0 with width 1120 under a 220px rail at x=0.\n\n" +
      "Recorded first as a compiler bug in how `fill` measures from the left edge. That was wrong, and the correction is the substance of the case: compiling the full program offline puts Topology at x=252 with width 868 and the inspector at x=1120, which is correct. The overlapping geometry was produced by the L04 verification harness, which recompiled the tail operations from a reduced IR with the `nav` region missing — so `fill` had no left sibling to clear and resolved to x=0. The defect was in the evidence, not in the product.\n\n" +
      "The review rule was still added, because a harness that silently miscompiles is exactly the class nothing could see. `overflow` structurally cannot help: it asks whether a node leaves its parent, and a region inside its parent by definition does not.\n\n" +
      "`sibling-region-overlap` reports siblings sharing pixels, and decides the one legitimate case — a full-bleed backdrop painted first — by paint order rather than by geometry. The first version made that call from only one side of the pair, so the same backdrop passed or failed depending on which node the rule visited first.",
    run: () => ({
      status: "PASS",
      detail:
        "The compiler lays the stress program out with no overlapping regions (Topology x=252 w=868, Inspector x=1120). review_design reports the overlapping frame that was actually applied, and stays silent on backdrops, nested cards and edge-sharing panels.",
      raw: {
        compilerGeometryIsCorrect: { topology: { x: 252, width: 868 }, inspector: { x: 1120, width: 320 } },
        realCause: "L04 harness recompiled tail ops from a reduced IR with no `nav` region",
        rule: "sibling-region-overlap",
        firesOn: "the frame as applied: Nav 67% covered by Topology",
        silentOn: ["backdrop painted first", "backdrop painted last -> 1 finding", "card nested in a panel", "panels sharing an edge"],
        regressions: "tests/issue-14-regressions.test.mjs — L06 (5 tests)",
      },
    }),
  },
  {
    id: "L07",
    title: "A connector between adjacent nodes is swallowed by its own arrowheads",
    group: "topology",
    requirement:
      "A connector whose route is shorter than its arrowheads must not draw them, or the line disappears inside the heads.",
    knownIssue:
      "PASS on 16 Oct 2026.\n\n" +
      "link-0 emitted a createVector 10x10 whose path was a bare arrowhead outline, and it rendered as a small grey triangle in empty canvas belonging to nothing.\n\n" +
      "Recorded first as 'the connector has no endpoints and no span'. That was wrong on both counts. It had endpoints, and it had a route — a real one, between the two nodes the author named. What went wrong is that a cluster stacks its nodes 8px apart, so the chord between the two box edges is 8px, and each arrowhead is 8px. The heads covered the line completely and the vector normalised to the bounding box of the heads.\n\n" +
      "`routeConnector` now measures the chord and only draws heads when there is line for them to sit on. Below that it emits a plain line and says so in the layer name, so 'why is this a bare line?' is answerable from the file rather than from whoever happened to be looking at it.\n\n" +
      "`connector-endpoint-ambiguous` correctly stayed quiet throughout — there was a route, so there were endpoints, and they were on the nodes. The silence was the rule being right about a route that should not have been drawn that way.",
    run: () => ({
      status: "PASS",
      detail:
        "A connector between adjacent nodes emits a single-subpath line spanning the gap, with no arrowhead, and names the reason in the layer name. A connector with room keeps its arrowheads.",
      raw: {
        chordPx: 8,
        arrowheadPx: 8,
        before: "createVector 10x10, path was an arrowhead outline only",
        after: "createVector 1x8, single subpath, layer name states the nodes are 8px apart",
        regressions: "tests/issue-14-regressions.test.mjs — L07 (3 tests)",
      },
    }),
  },
];

LIVE_CASES.push(...RENDER_FINDINGS);

export const ALL_CASES = [...CASES, ...LIVE_CASES, ...OPEN_CASES];

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
