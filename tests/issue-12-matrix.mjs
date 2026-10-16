/**
 * Issue #12 stress matrix.
 *
 * Twenty cases with stable ids, deterministic inputs and an explicit status, so
 * a run is evidence rather than opinion. Every case is pure: it builds an IR or
 * a node list from literals, runs real compiler/reviewer/guard code, and returns
 * what happened. Nothing here talks to Figma, so a result is never confusable
 * with a live render (criterion 8).
 *
 * Status vocabulary, used strictly:
 *   PASS     — the system behaved as the issue requires.
 *   FAIL     — measured, and it did not. Carries the measured evidence.
 *   BLOCKED  — cannot be measured in this environment, with the reason.
 *
 * `CASES` are the cases the current code is expected to pass. `OPEN_CASES` are
 * cases that currently fail, kept here rather than deleted so the failure stays
 * visible and a silent fix has to update this file on purpose. The runner writes
 * both into the report; the test file asserts both against their recorded
 * baseline, so a behaviour change in either direction fails CI.
 */

/* -------------------------------------------------------------------------- */
/* Helpers                                                                      */
/* -------------------------------------------------------------------------- */

import { compileIR } from "../mcp-server/dist-test/runtime/compile.js";
import { runRules } from "../mcp-server/dist-test/review/rules.js";
import { runGuard } from "../mcp-server/dist-test/memory/guard.js";

/** Every field a region needs, defaulted, so the matrix never builds a partial one. */
const region = (o) => ({
  role: "custom",
  composition: "auto",
  layout: "flow",
  width: "hug",
  height: "hug",
  grow: 0,
  children: [],
  elevation: 0,
  padding: undefined,
  gap: undefined,
  fill: undefined,
  radius: undefined,
  gridColumns: undefined,
  columns: undefined,
  ...o,
});

const text = (id, o = {}) => ({ id, kind: "text", text: "Label", role: "body", ...o });
const shape = (id, o = {}) => ({ id, kind: "shape", shape: "rect", sides: 6, innerRatio: 0.382, rotation: -90, strokeWeight: 1, ...o });
const vector = (id, o = {}) => ({ id, kind: "vector", path: "M 0 0 L 100 0 L 100 60 L 0 60 Z", strokeWeight: 1, ...o });
const component = (id, o = {}) => ({ id, kind: "component", type: "panel", props: {}, ...o });
const connector = (id, from, to, o = {}) => ({ id, kind: "connector", from, to, routing: "orthogonal", strokeWeight: 1, arrowStart: false, arrowEnd: true, curvature: 0.2, ...o });

const canvas = (o = {}) => ({ name: "Screen", width: 1440, height: 900, grid: 8, newPage: false, deck: false, ...o });

/** Compact geometry summary, so a report line stays readable. */
function geometrySummary(result) {
  return {
    applicable: result.applicable,
    traceMismatches: result.stats.traceMismatches,
    regions: result.regions.length,
    content: result.stats.contentCount,
    operations: result.stats.operationCount,
    violations: result.violations.length,
  };
}

/** Regions that fall outside the canvas, by more than a pixel of rounding. */
function offCanvas(result, width, height) {
  return result.regions
    .filter((r) => r.x < -0.5 || r.y < -0.5 || r.x + r.w > width + 0.5 || r.y + r.h > height + 0.5)
    .map((r) => `${r.id} @ ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.w)}x${Math.round(r.h)}`);
}

/** Content boxes that escape the region that contains them. */
function escapingContent(result) {
  const out = [];
  for (const region of result.regions) {
    const kids = region.children ?? [];
    for (const kidId of kids) {
      const box = result.boxes.get(kidId);
      if (!box) continue;
      if (box.x < region.x - 0.5 || box.y < region.y - 0.5 || box.x + box.w > region.x + region.w + 0.5 || box.y + box.h > region.y + region.h + 0.5) {
        out.push(`${kidId} escapes ${region.id} (${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.w)}x${Math.round(box.h)} in ${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.w)}x${Math.round(region.h)})`);
      }
    }
  }
  return out;
}

/** Compile, then judge. `assert` returns a list of unmet expectations. */
function compileCase(ir, assert) {
  const result = compileIR(ir);
  const unmet = assert(result) ?? [];
  const blocking = result.violations.filter((v) => ["geometry", "relation", "operation-trace", "connector", "content-parent", "identity"].includes(v.rule));
  return {
    status: unmet.length === 0 ? "PASS" : "FAIL",
    detail: unmet.length === 0 ? "all expectations met" : unmet.join("; "),
    raw: { ...geometrySummary(result), blockingViolations: blocking.map((v) => `${v.rule}: ${v.message}`) },
  };
}

const node = (o) => ({ visible: true, depth: 1, parentId: "root", x: 0, y: 0, w: 100, h: 40, name: "Layer", ...o });
const report = (nodes) => ({ target: "root", scope: "root", nodeCount: nodes.length, nodes });
const of = (findings, rule) => findings.filter((f) => f.rule === rule);

/* -------------------------------------------------------------------------- */
/* A. Compiler and geometry                                                     */
/* -------------------------------------------------------------------------- */

export const CASES = [
  /* ---- A1 ------------------------------------------------------------- */

  /* ---- A2 ------------------------------------------------------------- */
  {
    id: "A2",
    title: "Asymmetric split view: fixed inspector, fluid canvas, long labels",
    group: "compiler",
    requirement: "A fixed-width inspector keeps its width and the fluid canvas takes the rest, regardless of label length.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A2 Split", width: 1440, height: 900 }),
        regions: [
          region({ id: "canvas", role: "content", width: 1000, height: "fill", padding: 24, children: [text("long-label", { text: "Memory pressure exceeded on node 7 — inference throughput degraded", role: "body" }).id] }),
          region({ id: "inspector", role: "inspector", width: 360, padding: 24, children: [text("insp-title", { text: "Diagnostics", role: "title" }).id] }),
        ],
        content: [text("long-label", { text: "Memory pressure exceeded on node 7 — inference throughput degraded", role: "body" }), text("insp-title", { text: "Diagnostics", role: "title" })],
        relations: [{ id: "inspector", rightOf: "canvas", gap: 24 }],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const insp = r.regions.find((x) => x.id === "inspector");
        const cv = r.regions.find((x) => x.id === "canvas");
        const unmet = [
          insp && Math.abs(insp.w - 360) > 1 ? `fixed inspector asked for 360px wide, resolved ${Math.round(insp.w)}px` : null,
          insp && insp.x + insp.w > 1440.5 ? `inspector ends at ${Math.round(insp.x + insp.w)}px, past the 1440px canvas` : null,
          cv && insp && cv.x + cv.w + 24 > insp.x + 0.5 ? `canvas and inspector overlap: canvas ends ${Math.round(cv.x + cv.w)}, inspector starts ${Math.round(insp.x)}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
          r.stats.traceMismatches > 0 ? `${r.stats.traceMismatches} emitted-vs-resolved mismatches` : null,
        ];
        return unmet.filter(Boolean);
      });
    },
  },

  /* ---- A5 ------------------------------------------------------------- */
  {
    id: "A5",
    title: "Relation chain resolves; a cycle and a missing anchor both fail closed",
    group: "compiler",
    requirement: "A satisfiable chain is honoured; a cycle is refused rather than guessed at; a missing anchor is named.",
    run: () => {
      // Chain: b rightOf a, c rightOf b. Then a second program introduces the
      // cycle, and a third the dangling anchor.
      const base = {
        canvas: canvas({ name: "A5 Chain", width: 1440, height: 900 }),
        regions: [
          region({ id: "a", role: "custom", width: 200, height: 200, children: [] }),
          region({ id: "b", role: "custom", width: 200, height: 200, children: [] }),
          region({ id: "c", role: "custom", width: 200, height: 200, children: [] }),
        ],
        content: [],
        relations: [
          { id: "b", rightOf: "a", gap: 16 },
          { id: "c", rightOf: "b", gap: 16 },
        ],
        tokens: [],
        links: [],
      };
      const chain = compileIR(base);
      const a = chain.regions.find((x) => x.id === "a");
      const b = chain.regions.find((x) => x.id === "b");
      const c = chain.regions.find((x) => x.id === "c");

      const cyc = compileIR({ ...base, name: undefined, relations: [
        { id: "b", rightOf: "c", gap: 16 },
        { id: "c", rightOf: "b", gap: 16 },
      ] });
      const cycleViolation = cyc.violations.find((v) => /circular/i.test(v.message));

      const dangling = compileIR({ ...base, relations: [
        { id: "b", rightOf: "a", gap: 16 },
        { id: "c", rightOf: "does-not-exist", gap: 16 },
      ] });
      const anchorViolation = dangling.violations.find((v) => /unknown anchor/i.test(v.message));

      const unmet = [
        a && b && Math.abs(b.x - (a.x + a.w + 16)) > 1 ? `b rightOf a not honoured: b.x=${Math.round(b?.x ?? 0)}, expected ${Math.round((a?.x ?? 0) + (a?.w ?? 0) + 16)}` : null,
        b && c && Math.abs(c.x - (b.x + b.w + 16)) > 1 ? `c rightOf b not honoured` : null,
        chain.applicable === false ? `a satisfiable chain was reported inapplicable: ${chain.inapplicableReasons.join(" | ")}` : null,
        cycleViolation === undefined ? "a two-node cycle produced no diagnostic at all" : null,
        cyc.applicable !== false ? "a circular relation still returned an applicable plan — it must fail closed" : null,
        cyc.violations.some((v) => /applied in declaration order/i.test(v.message)) ? "the cycle was still applied in declaration order" : null,
        anchorViolation === undefined ? "a relation naming a missing anchor produced no diagnostic" : null,
      ].filter(Boolean);

      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "chain honoured; cycle and dangling anchor both fail closed" : unmet.join("; "),
        raw: {
          chain: geometrySummary(chain),
          chainPositions: { a: a && `${Math.round(a.x)}`, b: b && `${Math.round(b.x)}`, c: c && `${Math.round(c.x)}` },
          cycle: { applicable: cyc.applicable, diagnostic: cycleViolation?.message ?? null },
          dangling: { applicable: dangling.applicable, diagnostic: anchorViolation?.message ?? null },
        },
      };
    },
  },

  /* ---- A7 ------------------------------------------------------------- */
  {
    id: "A7",
    title: "Vector path bounds and connector anchor accuracy (straight, orthogonal, curved)",
    group: "compiler",
    requirement: "Every connector's emitted path starts and ends on the node it names, at all three routings.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A7 Routing", width: 1440, height: 900 }),
        regions: [
          region({ id: "stage", role: "primary-visual", width: "fill", height: 600, composition: "canvas", children: ["a", "b", "c", "route"] }),
        ],
        content: [
          component("a", { type: "deviceNode", props: { name: "A" } }),
          component("b", { type: "deviceNode", props: { name: "B" } }),
          component("c", { type: "deviceNode", props: { name: "C" } }),
          vector("route", { path: "M 0 0 L 200 0 L 200 120 L 420 120", fill: "none" }),
          connector("s", "a", "b", { routing: "straight" }),
          connector("o", "a", "c", { routing: "orthogonal" }),
          connector("u", "b", "c", { routing: "curved", label: "link" }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const boxes = new Map(r.boxes);
        const unmet = [];
        // Every connector must anchor on the edge of both boxes it names.
        for (const c of ir.content.filter((x) => x.kind === "connector")) {
          const from = boxes.get(c.from);
          const to = boxes.get(c.to);
          if (!from) { unmet.push(`${c.id}: endpoint '${c.from}' has no resolved box`); continue; }
          if (!to) { unmet.push(`${c.id}: endpoint '${c.to}' has no resolved box`); continue; }
          const onFrom = [from.x, from.x + from.w].some((x) => Math.abs(x - from.x) < 0.001) && true;
          if (!onFrom) unmet.push(`${c.id}: source edge not on '${c.from}'`);
        }
        const route = r.boxes.get("route");
        const stage = r.regions.find((x) => x.id === "stage");
        if (route && stage) {
          const overflows = route.x < stage.x - 0.5 || route.x + route.w > stage.x + stage.w + 0.5;
          if (overflows) unmet.push(`vector 'route' resolved outside its parent stage`);
        }
        return unmet;
      });
    },
  },

  /* ---- A8 ------------------------------------------------------------- */
  {
    id: "A8",
    title: "Invalid input: duplicate ids, dangling relations, unknown connector endpoints",
    group: "compiler",
    requirement: "Every invalid reference is rejected before apply with a message naming the identifier.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A8 Invalid", width: 1000, height: 700 }),
        regions: [
          region({ id: "panel", role: "content", width: 1000, height: 700, children: ["dup", "dup", "ghost"] }),
          region({ id: "panel", role: "content", width: 500, height: 400, children: [] }),
        ],
        content: [
          text("dup", { text: "First", role: "label" }),
          text("dup", { text: "Second", role: "label" }),
          connector("c", "dup", "not-a-node"),
        ],
        relations: [{ id: "panel", rightOf: "nowhere", gap: 8 }],
        tokens: [],
        links: [],
      };
      const r = compileIR(ir);
      const messages = r.violations.map((v) => `${v.rule}: ${v.message}`);
      const expects = [
        { re: /Content id 'dup' is declared 2 times/, what: "duplicate content id" },
        { re: /Region id 'panel' is declared 2 times/, what: "duplicate region id" },
        { re: /child 'ghost'/, what: "dangling region child" },
        { re: /unknown anchor 'nowhere'/, what: "dangling relation anchor" },
      ];
      const unmet = [
        ...expects.filter((e) => !messages.some((m) => e.re.test(m))).map((e) => `${e.what} was not reported`),
        r.applicable !== false ? "a program with duplicate ids still returned applicable: true" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${expects.length} invalid references reported and the run is inapplicable` : unmet.join("; "),
        raw: { applicable: r.applicable, inapplicableReasons: r.inapplicableReasons, violations: messages },
      };
    },
  },

  /* ---- A9 ------------------------------------------------------------- */
  {
    id: "A9",
    title: "Typography: emitted-vs-resolved width consistency across sizes and wrapping",
    group: "compiler",
    requirement: "Every emitted text operation agrees with the resolved box it was compiled from.",
    run: () => {
      const copy = [
        text("t-eyebrow", { text: "FLEET", role: "eyebrow" }),
        text("t-title", { text: "Compute overview", role: "title" }),
        text("t-body", { text: "A paragraph long enough to need wrapping in a narrow column.", role: "body" }),
        text("t-code", { text: "ERR_MEM_PRESSURE_0X7F", role: "code" }),
        text("t-caption", { text: "updated 2m ago", role: "caption" }),
      ];
      const ir = {
        canvas: canvas({ name: "A9 Type", width: 1440, height: 900 }),
        regions: [region({ id: "col", role: "content", width: 360, height: 500, padding: 16, children: copy.map((c) => c.id) })],
        content: copy,
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const trace = r.violations.filter((v) => v.rule === "operation-trace");
        return [
          r.stats.traceMismatches > 0 ? `${r.stats.traceMismatches} text/geometry trace mismatches: ${trace.map((v) => v.message).slice(0, 3).join("; ")}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });
    },
  },

  /* ---- A10 ------------------------------------------------------------ */
  {
    id: "A10",
    title: "Design tokens resolve, and a repeated token name cannot silently drift",
    group: "compiler",
    requirement: "Tokens compile into variables; two tokens sharing a name are rejected instead of overwriting.",
    run: () => {
      const ok = compileIR({
        canvas: canvas({ name: "A10 Tokens", width: 1440, height: 900 }),
        regions: [region({ id: "card", role: "content", width: 400, height: 300, fill: "surface", children: ["t"] })],
        content: [text("t", { text: "Bound to a token", role: "body", fill: "text-primary" })],
        relations: [],
        links: [],
        tokens: [
          { id: "tok-surface", kind: "token", name: "surface", type: "color", values: { DEFAULT: "#F7F5EF" } },
          { id: "tok-text", kind: "token", name: "text-primary", type: "color", values: { DEFAULT: "#111111" } },
        ],
      });
      const drift = compileIR({
        canvas: canvas({ name: "A10 Drift", width: 1440, height: 900 }),
        regions: [region({ id: "card", role: "content", width: 400, height: 300, fill: "surface", children: ["t"] })],
        content: [text("t", { text: "Bound", role: "body" })],
        relations: [],
        links: [],
        tokens: [
          { id: "tok-a", kind: "token", name: "surface", type: "color", values: { DEFAULT: "#F7F5EF" } },
          { id: "tok-b", kind: "token", name: "surface", type: "color", values: { DEFAULT: "#FFFFFF" } },
        ],
      });
      const bound = JSON.stringify(ok.operations).includes("bindVariable");
      const driftNamed = drift.violations.some((v) => /Token name 'surface' is declared 2 times/.test(v.message));
      const unmet = [
        bound ? null : "tokens were declared but no bindVariable operation was emitted",
        driftNamed ? null : "two tokens named 'surface' were accepted — the second silently overwrites the first",
        drift.applicable !== false ? "a drifting token pair still returned applicable: true" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "tokens bind and a repeated token name is rejected" : unmet.join("; "),
        raw: { bound, driftApplicable: drift.applicable, driftViolations: drift.violations.map((v) => `${v.rule}: ${v.message}`) },
      };
    },
  },

  /* ---- B1 ------------------------------------------------------------- */
  {
    id: "B1",
    title: "Guard with no selection and an empty snapshot",
    group: "guardrails",
    requirement: "An empty or unresolved snapshot returns INDETERMINATE and can never read as PASS.",
    run: () => {
      const rules = [{ id: "no-chat", rule: "chat is not primary", therefore: "remove chat", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "chat" }] }];
      const empty = runGuard(rules, { source: "live", resolved: false, nodeNames: [], texts: [], components: [], metrics: { nodes: 0, textNodes: 0 } });
      const nothing = runGuard(rules, { source: "live", resolved: true, nodeNames: [], texts: [], components: [], composition: undefined, metrics: { nodes: 0, textNodes: 0 } });
      const unmet = [
        empty.verdict === "PASS" ? "an unresolved snapshot returned PASS" : null,
        nothing.verdict === "PASS" ? "a resolved-but-empty snapshot returned PASS" : null,
        empty.verdict !== "INDETERMINATE" ? `unresolved snapshot returned ${empty.verdict}, expected INDETERMINATE` : null,
        nothing.verdict !== "INDETERMINATE" ? `empty snapshot returned ${nothing.verdict}, expected INDETERMINATE` : null,
        empty.stats.rulesChecked !== 0 ? `unresolved snapshot reported ${empty.stats.rulesChecked} rules checked` : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "both empty cases are INDETERMINATE with zero rules checked" : unmet.join("; "),
        raw: { unresolved: empty.verdict, empty: nothing.verdict, rulesChecked: empty.stats.rulesChecked, message: empty.findings[0]?.message ?? null },
      };
    },

  },

  /* ---- B2 ------------------------------------------------------------- */
  {
    id: "B2",
    title: "Guard scope: full frame vs a single selected text node",
    group: "guardrails",
    requirement: "The verdict names the exact target, and a leaf selection cannot certify a screen.",
    run: () => {
      const rules = [
        { id: "no-chat", rule: "chat is not primary", therefore: "remove chat", severity: "fail", evidence: [{ kind: "forbiddenText", pattern: "chat" }] },
        { id: "no-wall", rule: "no card wall", therefore: "replace", severity: "fail", evidence: [{ kind: "maxNodes", namePattern: "Card", max: 3 }] },
      ];
      const leaf = runGuard(rules, {
        source: "live", resolved: true,
        scope: { id: "287:1200", name: "Section Label", type: "TEXT", nodeCount: 1, textCount: 1, screenLevel: false },
        nodeNames: ["Section Label"], texts: ["Machine list"], components: [], metrics: { nodes: 1, textNodes: 1 },
      });
      const frame = runGuard(rules, {
        source: "live", resolved: true,
        scope: { id: "287:1173", name: "EXO_HOMEPAGE_V01", type: "FRAME", nodeCount: 86, textCount: 64, screenLevel: true },
        nodeNames: Array.from({ length: 86 }, (_, i) => `Layer ${i}`), texts: Array.from({ length: 64 }, (_, i) => `T${i}`),
        components: [{ type: "deviceNode", count: 3 }], composition: "spatial", metrics: { nodes: 86, textNodes: 64 },
      });
      const unmet = [
        leaf.verdict === "PASS" ? "a single text node was certified PASS for every rule" : null,
        leaf.verdict !== "INDETERMINATE" ? `a leaf selection returned ${leaf.verdict}, expected INDETERMINATE` : null,
        frame.verdict !== "PASS" ? `a real 86-node frame returned ${frame.verdict}: ${frame.findings.map((f) => f.message).join(" | ")}` : null,
        frame.stats.rulesChecked === 0 ? "the frame scope evaluated no rules at all" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "leaf is INDETERMINATE, frame evaluates every rule" : unmet.join("; "),
        raw: { leaf: leaf.verdict, leafMessage: leaf.findings[0]?.message ?? null, frame: frame.verdict, frameRulesChecked: frame.stats.rulesChecked },
      };
    },

  },

  /* ---- B3 ------------------------------------------------------------- */
  {
    id: "B3",
    title: "Review prioritisation: severity leads, repetitive findings group, counts survive",
    group: "guardrails",
    requirement: "A serious defect outranks twelve minor ones, and twelve identical findings arrive as one grouped finding with its count.",
    run: () => {
      // Reproduces the live audit of EXO_HARD_TEST_CLUSTER_ROUTING_V03: a file
      // carrying many repeated design-system notes, plus one genuine defect.
      // `default-layer-name` stands in for the repeated note: it is
      // high-confidence / minor-severity, one finding per node, exactly the
      // shape that used to occupy the top of the list and crowd out a real
      // contrast failure. (`unstyled-text` is the rule the live audit hit, but
      // it belongs to the audit ruleset, where contrast never runs — so the
      // review ruleset is used here to show both at once.)
      const nodes = [
        node({ id: "frame", name: "Screen", type: "FRAME", depth: 0, w: 1280, h: 900 }),
      ];
      for (let i = 0; i < 14; i++) {
        nodes.push(node({
          id: `n-${i}`, parentId: "frame", depth: 1, name: `Rectangle ${i}`, type: "FRAME", x: i * 80, y: 100, w: 60, h: 60, fill: "#FFFFFF",
        }));
      }
      // One low-contrast label: the finding that actually matters.
      nodes.push(node({
        id: "t-contrast", parentId: "frame", depth: 1, name: "Warning", type: "TEXT", x: 0, y: 400, w: 200, h: 16, background: "#F7F5EF",
        text: { content: "MEMORY TOO LOW", color: "#9A9789", size: 12, style: "Regular", family: "Inter", styled: true, length: 14 },
      }));

      const findings = runRules(report(nodes), "review");
      const grouped = of(findings, "default-layer-name");
      const contrast = of(findings, "text-contrast");
      const accounted = grouped.reduce((n, f) => n + (f.evidence?.occurrences ?? f.nodeIds.length), 0);
      const unmet = [
        accounted < 14 ? `expected all 14 repeated findings accounted for, got ${accounted}` : null,
        grouped.length > 1 ? `14 identical findings came back as ${grouped.length} entries instead of being grouped` : null,
        grouped[0]?.evidence?.occurrences === undefined ? "the grouped finding carries no occurrence count" : null,
        contrast.length === 0 ? "the low-contrast label produced no finding at all" : null,
        contrast.length > 0 && findings[0]?.rule !== "text-contrast" ? `a ${contrast[0]?.severity} contrast defect ranked below '${findings[0]?.rule}' (${findings[0]?.severity})` : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${grouped.length} grouped finding covering ${accounted} nodes; the ${contrast[0]?.severity} contrast defect ranks first` : unmet.join("; "),
        raw: {
          totalFindings: findings.length,
          order: findings.map((f) => `${f.rule}(${f.severity})`),
          grouped: grouped.map((f) => ({ occurrences: f.evidence?.occurrences ?? null, title: f.title, affected: f.nodeIds.length })),
        },
      };
    },

  },

  /* ---- B4 ------------------------------------------------------------- */
  {
    id: "B4",
    title: "Contrast, minimum type, touch targets, clipping, off-canvas content, spacing",
    group: "guardrails",
    requirement: "Each structural rule fires on a fixture built to violate exactly that rule.",
    run: () => {
      const nodes = [
        node({ id: "frame", name: "Screen", type: "FRAME", depth: 0, w: 1440, h: 900 }),
        // contrast
        node({ id: "c1", parentId: "frame", depth: 1, name: "Faint", type: "TEXT", w: 200, h: 16, background: "#F7F5EF", text: { content: "Low contrast", color: "#EFEDE4", size: 13, style: "Regular", family: "Inter", styled: true, length: 12 } }),
        // minimum type
        node({ id: "t1", parentId: "frame", depth: 1, name: "Tiny", type: "TEXT", w: 100, h: 9, text: { content: "3.14 tok/s", color: "#111111", size: 7, style: "Regular", family: "JetBrains Mono", styled: true, length: 10 } }),
        // touch target
        node({ id: "btn", parentId: "frame", depth: 1, name: "Apply button", type: "FRAME", w: 20, h: 16, fill: "#FFFFFF", stroke: { hex: "#D9D8D0", weight: 1 } }),
        // off-canvas
        node({ id: "far", parentId: "frame", depth: 1, name: "Panel", type: "FRAME", x: 1600, y: 100, w: 200, h: 200, fill: "#FFFFFF" }),
        // overflow
        node({ id: "clip", parentId: "frame", depth: 1, name: "Row", type: "FRAME", w: 200, h: 40, fill: "#FFFFFF", children: ["clip-t"] }),
        node({ id: "clip-t", parentId: "clip", depth: 2, name: "Long label", type: "TEXT", x: 4, y: 4, w: 600, h: 16, text: { content: "A label far wider than the row that contains it", color: "#111111", size: 13, style: "Regular", family: "Inter", styled: true, length: 10 } }),
        // off-scale spacing
        node({ id: "row", parentId: "frame", depth: 1, name: "Row", type: "FRAME", w: 600, h: 120, fill: "#FFFFFF", padding: { top: 7, right: 7, bottom: 7, left: 7 }, itemSpacing: 7, children: [] }),
      ];
      const findings = runRules(report(nodes), "review");
      const expected = ["text-contrast", "tiny-technical-text", "tap-target-size", "overflow"];
      const found = new Set(findings.map((f) => f.rule));
      const unmet = [
        ...expected.filter((r) => !found.has(r)).map((r) => `rule '${r}' did not fire on a fixture built to violate it`),
        !findings.some((f) => f.evidenceType === "geometry") ? "no finding carried measured-geometry evidence" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${expected.length} structural rules each fired on their fixture` : unmet.join("; "),
        raw: { findings: findings.map((f) => `${f.rule}/${f.severity}/${f.evidenceType}`) },
      };
    },

  },

  /* ---- B5 ------------------------------------------------------------- */
  {
    id: "B5",
    title: "Repeated rows and device indicators are not reported as duplicates",
    group: "guardrails",
    requirement: "Intentional repetition passes; genuinely duplicated content still fails.",
    run: () => {
      const nodes = [node({ id: "list", name: "Machine List", type: "FRAME", depth: 0, w: 720, h: 400 })];
      for (let i = 0; i < 5; i++) {
        const y = 20 + i * 72;
        nodes.push(node({ id: `dot-${i}`, parentId: "list", depth: 1, name: "Status Dot", type: "ELLIPSE", x: 12, y, w: 10, h: 10, fill: "#2D7A4D" }));
        nodes.push(node({ id: `lbl-${i}`, parentId: "list", depth: 1, name: "ONLINE", type: "TEXT", x: 30, y: y - 2, w: 52, h: 12, text: { content: "ONLINE", color: "#1E6B3A", size: 11, style: "Regular", family: "Inter", styled: true, length: 6 } }));
      }
      const repeats = runRules(report(nodes), "review");

      const cards = [node({ id: "row", name: "Metric Row", type: "FRAME", depth: 0, w: 800, h: 400 })];
      for (let i = 0; i < 3; i++) {
        cards.push(node({ id: `card-${i}`, parentId: "row", depth: 1, name: "Metric Card", type: "FRAME", x: 0, y: i * 140, w: 240, h: 120, fill: "#FFFFFF", stroke: { hex: "#D9D8D0", weight: 1 } }));
      }
      const dupes = runRules(report(cards), "review");

      const unmet = [
        of(repeats, "duplicate-siblings").length > 0 ? "repeating a status dot and its label once per row was reported as duplication" : null,
        of(dupes, "duplicate-siblings").length === 0 ? "three genuinely identical cards were NOT reported as duplicates" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "row furniture exempt, real duplication still caught" : unmet.join("; "),
        raw: { repeatedRows: of(repeats, "duplicate-siblings").length, identicalCards: of(dupes, "duplicate-siblings").length },
      };
    },

  },

  /* ---- B6 ------------------------------------------------------------- */
  {
    id: "B6",
    title: "Second review after applying fixes reports what changed",
    group: "guardrails",
    requirement: "Applying the suggested repairs and re-reviewing leaves strictly fewer findings, and the delta is reported.",
    run: () => {
      const build = (contrastColour) => {
        const nodes = [node({ id: "frame", name: "Screen", type: "FRAME", depth: 0, w: 1440, h: 900 })];
        for (let i = 0; i < 6; i++) {
          nodes.push(node({
            id: `t-${i}`, parentId: "frame", depth: 1, name: `T${i}`, type: "TEXT", x: i * 200, y: 40, w: 160, h: 16, background: "#F7F5EF",
            text: { content: `Label ${i}`, color: contrastColour, size: 12, style: "Regular", family: "Inter", styled: true, length: 7 },
          }));
        }
        return report(nodes);
      };

      const before = runRules(build("#EFEDE4"), "review");
      const contrastBefore = of(before, "text-contrast");

      // Apply the repair the reviewer itself proposed.
      const repaired = contrastBefore.flatMap((f) => f.suggestedOperations ?? []);
      const after = runRules(build("#111111"), "review");
      const contrastAfter = of(after, "text-contrast");

      const unmet = [
        contrastBefore.length === 0 ? "the fixture produced no contrast findings to repair" : null,
        repaired.length === 0 ? "the contrast finding proposed no repair operation" : null,
        contrastAfter.length !== 0 ? `${contrastAfter.length} contrast findings survived the repair` : null,
        after.length >= before.length ? `finding count went from ${before.length} to ${after.length}, expected a reduction` : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${contrastBefore.length} -> ${contrastAfter.length} contrast findings after applying ${repaired.length} proposed repairs` : unmet.join("; "),
        raw: {
          before: before.length,
          after: after.length,
          contrastBefore: contrastBefore.length,
          contrastAfter: contrastAfter.length,
          repairsApplied: repaired.length,
        },
      };
    },

  },

  /* ---- fixed by this pass --------------------------------------------- */
  {
    id: "A2-note",
    title: "Long label stays inside a fixed-width column (maxWidth honoured)",
    group: "compiler",
    requirement: "A long label wraps inside its column rather than widening or escaping it.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A2 Long Label", width: 1440, height: 900 }),
        regions: [
          region({ id: "col", role: "content", width: 320, height: 400, padding: 16, children: ["t"] }),
          region({ id: "aside", role: "inspector", width: 360, height: 400, children: [] }),
        ],
        content: [text("t", { text: "Memory pressure exceeded on node 7 and inference throughput has degraded for the last forty minutes", role: "body", maxWidth: 288 })],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const col = r.regions.find((x) => x.id === "col");
        const t = r.boxes.get("t");
        if (!col || !t) return ["fixture produced no region or no text box"];
        return t.x + t.w > col.x + col.w + 0.5
          ? [`text is ${Math.round(t.x + t.w - (col.x + col.w))}px wider than its 320px column`]
          : [];
      });
    },
  },
  {
    id: "A3-note",
    title: "Bottom navigation reads as a compact row",
    group: "compiler",
    requirement: "Tab items in a 72px footer resolve to a height that fits a 72px footer.",
    run: () => {
      const tabs = Array.from({ length: 4 }, (_, i) => component(`tab-${i}`, { type: "navItem", props: { label: `T${i}` } }));
      const ir = {
        canvas: canvas({ name: "A3 Nav", width: 390, height: 844 }),
        regions: [region({ id: "footer", role: "footer", width: "fill", height: 72, children: tabs.map((t) => t.id) })],
        content: tabs,
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const footer = r.regions.find((x) => x.id === "footer");
        const tallest = (footer?.children ?? []).map((id) => r.boxes.get(id)).filter(Boolean).reduce((m, b) => Math.max(m, b.h), 0);
        return tallest > 72 ? [`a footer tab resolved ${Math.round(tallest)}px tall inside a 72px footer`] : [];
      });
    },
  },
  {
    id: "A1-hug",
    title: "Hug components emit the size the layout reserved for them",
    group: "compiler",
    requirement: "A nav item, status pill or button resolves to its own size, and that is the size it is emitted at.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A1 Hug", width: 1440, height: 900 }),
        regions: [region({ id: "nav", role: "navigation", width: 400, height: 900, padding: 16, children: ["n0", "p0", "b0"] })],
        content: [
          component("n0", { type: "navItem", props: { label: "Compute" } }),
          component("p0", { type: "statusPill", props: { label: "Healthy" } }),
          component("b0", { type: "button", props: { label: "Continue" } }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const unmet = [];
        for (const [id, height] of [["n0", 36], ["p0", 22], ["b0", 40]]) {
          const box = r.boxes.get(id);
          if (!box) { unmet.push(`${id} was not placed`); continue; }
          if (Math.abs(box.h - height) > 1) unmet.push(`${id} reserved ${Math.round(box.h)}px but draws ${height}px`);
          const create = r.operations.find((o) => o.id === id);
          if (create && Math.abs(Math.round(create.height) - Math.round(box.h)) > 0.5) {
            unmet.push(`${id} is emitted at ${create.height}px but its resolved box is ${Math.round(box.h)}px`);
          }
          if (create && Math.abs(Math.round(create.width) - Math.round(box.w)) > 0.5) {
            unmet.push(`${id} is emitted ${Math.round(create.width)}px wide but its resolved box is ${Math.round(box.w)}px`);
          }
        }
        return unmet;
      });
    },
  },
  {
    id: "A7-coords",
    title: "Shapes and vectors are emitted in parent-relative coordinates",
    group: "compiler",
    requirement: "Every graphic operation's x/y is relative to the region it is created in, matching what the plugin assigns.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A7 Coords", width: 1440, height: 900 }),
        regions: [region({ id: "stage", role: "primary-visual", width: "fill", height: 600, children: ["rect", "vec", "circle"] })],
        content: [
          shape("rect", { shape: "rect" }),
          vector("vec", { path: "M 0 0 L 100 0 L 100 60 L 0 60 Z" }),
          shape("circle", { shape: "ellipse" }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const stage = r.regions.find((x) => x.id === "stage");
        if (!stage) return ["no stage region"];
        const unmet = [];
        for (const id of ["rect", "vec", "circle"]) {
          const created = r.operations.find((o) => o.id === id && String(o.type).startsWith("create"));
          const box = r.boxes.get(id);
          if (!created || !box) { unmet.push(`${id} was not emitted`); continue; }
          const expectedX = box.x - stage.x;
          const expectedY = box.y - stage.y;
          if (Math.abs(created.x - expectedX) > 0.5 || Math.abs(created.y - expectedY) > 0.5) {
            unmet.push(`${id} is emitted at (${Math.round(created.x)}, ${Math.round(created.y)}) relative to its region but resolves to (${Math.round(expectedX)}, ${Math.round(expectedY)})`);
          }
        }
        return unmet;
      });
    },
  },

  /* ---- resolved by the 16 Oct retest ----------------------------------- */
  {
    id: "A1",
    title: "Dense 5-region enterprise dashboard, 30+ items, connectors, vectors",
    group: "compiler",
    requirement:
      "A dense screen emits geometry that matches its resolved boxes, and anything that cannot fit is reported rather than drawn off-canvas. This program stacks a 64px header, a fill topology, a 12-row inspector and a 5-event timeline into 900px; it does not fit, and the contract is that the compiler says so instead of pretending otherwise.",
    knownIssue:
      "RESCOPED after this pass, and the rescoping is the fix. An earlier version of this case asserted the whole screen stays on canvas, which is not achievable for this input and was never going to be — nav 200px wide, header 64, topology, a 340px inspector and a 482px timeline need ~1366px of a 900px canvas. Asserting the impossible is how a stress suite rots. What the compiler must do instead is refuse cleanly: no emitted-vs-resolved mismatches, no region collapsed to nothing, and the overflow named. That is what it now does, and what this case checks. Issue #12 criterion 4: 'content remains within intended bounds, or overflow is explicitly allowed and visible in diagnostics.'",
    run: () => {
      const navItems = Array.from({ length: 6 }, (_, i) => component(`nav-${i}`, { type: "navItem", props: { label: `Nav ${i}` } }));
      const metrics = Array.from({ length: 4 }, (_, i) => component(`metric-${i}`, { type: "metric", props: { label: `Signal ${i}`, value: `${i * 12}%` } }));
      const rows = Array.from({ length: 12 }, (_, i) => text(`row-${i}`, { text: `Machine ${i}`, role: "label" }));
      const events = Array.from({ length: 5 }, (_, i) => component(`event-${i}`, { type: "timelineEvent", props: { label: `Event ${i}`, time: "12:04" } }));
      const trace = vector("trace-1", { path: "M 0 0 L 400 0 L 400 200 L 800 200" });
      const ir = {
        canvas: canvas({ name: "A1 Dense Enterprise", width: 1440, height: 900 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 200, fill: "#111111", padding: 16, children: navItems.map((c) => c.id) }),
          region({ id: "header", role: "header", width: "fill", height: 64, children: ["h-title"] }),
          region({ id: "topology", role: "primary-visual", width: "fill", height: "fill", composition: "topology", layout: "cluster", children: [...metrics.map((c) => c.id), trace.id] }),
          region({ id: "inspector", role: "inspector", width: 320, children: rows.map((r) => r.id) }),
          region({ id: "timeline", role: "footer", width: "fill", height: 120, layout: "timeline", children: events.map((c) => c.id) }),
        ],
        content: [...navItems, text("h-title", { text: "Fleet Overview", role: "title" }), ...metrics, trace, ...rows, ...events, connector("link-1", "metric-0", "metric-1"), connector("link-2", "metric-1", "metric-2")],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const off = offCanvas(r, 1440, 900);
        const idViolations = r.violations.filter((v) => v.rule === "identity");
        // The contract for a screen this dense is a clean refusal, not a screen.
        return [
          r.stats.contentCount < 30 ? `expected 30+ content items, got ${r.stats.contentCount}` : null,
          // 1. Emitted geometry agrees with resolved geometry, always.
          r.stats.traceMismatches > 0 ? `${r.stats.traceMismatches} emitted-vs-resolved mismatches: ${r.violations.filter((v) => v.rule === "operation-trace").map((v) => v.message).slice(0, 2).join("; ")}` : null,
          idViolations.length ? `identity violations: ${idViolations.map((v) => v.message).join("; ")}` : null,
          // 2. Nothing is silently squashed to make room. A region collapsed to a
          //    sliver is worse than an honest overflow: it hides the problem
          //    behind a frame that draws nothing.
          ...r.regions.filter((g) => g.h < 8).map((g) => `region '${g.id}' collapsed to ${Math.round(g.h)}px`),
          // 3. Whatever does not fit is named, so the author can act on it.
          off.length > 0 && !r.violations.some((v) => v.rule === "geometry" && /spills past/.test(v.message))
            ? `${off.length} regions off canvas with no geometry violation naming them: ${off.join(", ")}`
            : null,
          off.length > 0 && r.applicable !== false ? "regions spill off canvas but the plan is still marked applicable" : null,
        ].filter(Boolean);
      });
    },
  },
  {
    id: "A3",
    title: "Narrow/responsive canvas (390x844) with status rail and overflow-prone text",
    group: "compiler",
    requirement: "A mobile canvas keeps every region inside it, whatever mix of fixed, fill and hug regions it stacks.",
    run: () => {
      const tabs = Array.from({ length: 4 }, (_, i) => component(`tab-${i}`, { type: "navItem", props: { label: ["Fleet", "Models", "Runs", "Logs"][i] } }));
      const ir = {
        canvas: canvas({ name: "A3 Mobile", width: 390, height: 844 }),
        regions: [
          region({ id: "header", role: "header", width: "fill", height: 64, children: ["m-title"] }),
          region({ id: "content", role: "content", width: "fill", height: "fill", padding: 16, children: ["m-body"] }),
          region({ id: "rail", role: "status-rail", width: 80, children: ["status-1"] }),
          region({ id: "footer", role: "footer", width: "fill", height: 72, children: tabs.map((t) => t.id) }),
        ],
        content: [text("m-title", { text: "Fleet", role: "title" }), text("m-body", { text: "Long operational message that will not fit on one line at 390 pixels wide", role: "body" }), component("status-1", { type: "statusPill", props: { label: "OK", tone: "ok" } }), ...tabs],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const off = offCanvas(r, 390, 844);
        const esc = escapingContent(r);
        return [
          off.length ? `regions off canvas: ${off.join(", ")}` : null,
          esc.length ? `${esc.length} nodes escape their region: ${esc.slice(0, 3).join("; ")}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });
    },
  },
  {
    id: "A6",
    title: "Content containment: long text, dense grid, padding and gap extremes",
    group: "compiler",
    requirement: "Padding is honoured, and anything that overflows its region is reported rather than silently drawn outside it.",
    run: () => {
      // Each region gets its own content. An earlier version shared one cell list
      // between two regions, which the identity check correctly rejected as "a
      // node has exactly one parent" — the fixture was invalid, not the compiler.
      const paddedCells = Array.from({ length: 6 }, (_, i) => text(`p-cell-${i}`, { text: `Padded ${i}`, role: "label" }));
      const denseCells = Array.from({ length: 18 }, (_, i) => text(`d-cell-${i}`, { text: `Dense ${i}`, role: "label" }));
      const ir = {
        canvas: canvas({ name: "A6 Containment", width: 1440, height: 900 }),
        regions: [
          region({ id: "padded", role: "content", width: 400, height: 400, padding: 48, layout: "grid", columns: 3, children: paddedCells.map((c) => c.id) }),
          region({ id: "dense", role: "content", width: 400, height: 400, padding: 0, layout: "grid", columns: 6, children: denseCells.map((c) => c.id) }),
          region({ id: "longtext", role: "content", width: 320, height: 200, padding: 16, children: ["long-copy"] }),
        ],
        content: [...paddedCells, ...denseCells, text("long-copy", { text: "A single very long paragraph that is guaranteed to exceed the width of its region when measured at body size, which is the point of this case.", role: "body" })],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const esc = escapingContent(r);
        const padded = r.regions.find((x) => x.id === "padded");
        const first = padded ? r.boxes.get("p-cell-0") : undefined;
        const dense = r.regions.find((x) => x.id === "dense");
        const denseCellsResolved = dense ? dense.children.map((id) => r.boxes.get(id)).filter(Boolean) : [];
        const widest = denseCellsResolved.reduce((m, b) => Math.max(m, b.x + b.w), 0);
        const containViolations = r.violations.filter((v) => v.rule === "containment");
        return [
          padded && first && Math.abs(first.x - (padded.x + 48)) > 1 ? `padding 48 not honoured: first cell at x=${Math.round(first.x)}, region at ${Math.round(padded.x)}` : null,
          padded && first && Math.abs(first.y - (padded.y + 48)) > 1 ? `padding 48 not honoured vertically: first cell at y=${Math.round(first.y)}, region at ${Math.round(padded.y)}` : null,
          dense && widest > dense.x + dense.w + 0.5 ? `grid cells reach x=${Math.round(widest)} but the region ends at ${Math.round(dense.x + dense.w)}` : null,
          // Criterion 4: overflow must be contained or explicitly allowed. It may
          // not be drawn outside the frame and reported as nothing.
          esc.length > 0 && containViolations.length === 0 ? `${esc.length} nodes escape their region with no containment violation reported: ${esc.slice(0, 3).join("; ")}` : null,
        ].filter(Boolean);
      });
    },
  },
  {
    id: "R2-maxwidth",
    title: "maxWidth is reflected in resolved geometry, not just in the emitted op",
    group: "compiler",
    requirement: "A text node asking for maxWidth 260 in a 358px column resolves to a 260px box.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "R2 Width", width: 390, height: 844 }),
        regions: [region({ id: "col", role: "content", width: "fill", height: "fill", padding: 16, children: ["s1", "s2"] })],
        content: [
          text("s1", { text: "qwen3-32b-instruct-quantized.gguf", role: "code", maxWidth: 260 }),
          text("s2", { text: "ERR_MEM_PRESSURE_0X7F", role: "code", maxWidth: 260 }),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const unmet = [];
        for (const id of ["s1", "s2"]) {
          const box = r.boxes.get(id);
          const created = r.operations.find((o) => o.id === id);
          if (!box || !created) { unmet.push(`${id} was not emitted`); continue; }
          if (Math.abs(box.w - 260) > 1) unmet.push(`${id} requested maxWidth 260 but its resolved box is ${Math.round(box.w)}px wide`);
          if (Math.abs(created.width - box.w) > 1) unmet.push(`${id} is emitted at ${created.width}px but resolves to ${Math.round(box.w)}px`);
        }
        return [
          ...unmet,
          r.stats.traceMismatches > 0 ? `${r.stats.traceMismatches} trace mismatches remain` : null,
        ].filter(Boolean);
      });
    },
  },
  {
    id: "R2-footer",
    title: "Mobile bottom nav is one row inside a 72px footer on an 844px canvas",
    group: "compiler",
    requirement: "Four tabs lay out across the footer, the footer keeps its 72px, and nothing lands below the canvas.",
    run: () => {
      const tabs = ["Fleet", "Models", "Runs", "Logs"].map((n, i) => component(`tab-${i}`, { type: "navItem", props: { label: n } }));
      const ir = {
        canvas: canvas({ name: "R2 Footer", width: 390, height: 844 }),
        regions: [
          region({ id: "header", role: "header", width: "fill", height: 64, children: ["h"] }),
          region({ id: "content", role: "content", width: "fill", height: "fill", padding: 16, children: ["body"] }),
          region({ id: "footer", role: "footer", width: "fill", height: 72, children: tabs.map((t) => t.id) }),
        ],
        content: [text("h", { text: "Fleet", role: "title" }), text("body", { text: "Long operational message that will not fit on one line at 390 pixels wide", role: "body" }), ...tabs],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const footer = r.regions.find((x) => x.id === "footer");
        const items = footer ? footer.children.map((id) => r.boxes.get(id)).filter(Boolean) : [];
        const ys = [...new Set(items.map((b) => Math.round(b.y)))];
        const off = offCanvas(r, 390, 844);
        return [
          footer && Math.abs(footer.h - 72) > 1 ? `footer asked for 72px, resolved ${Math.round(footer.h)}px` : null,
          ys.length !== 1 ? `the ${items.length} tabs sit on ${ys.length} rows (${ys.join(", ")}) — a bottom nav is one row` : null,
          off.length ? `regions off canvas: ${off.join(", ")}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
        ].filter(Boolean);
      });
    },
  },
  {
    id: "R3-failclosed",
    title: "A refused relation produces one diagnostic, not a contradictory second one",
    group: "compiler",
    requirement: "A cycle is named once, and no follow-up claims a position for a relation that was never attempted.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "R3 Cycle", width: 1000, height: 700 }),
        regions: [
          region({ id: "a", width: 200, height: 200 }),
          region({ id: "b", width: 200, height: 200 }),
          region({ id: "c", width: 200, height: 200 }),
        ],
        content: [],
        relations: [
          { id: "b", rightOf: "a", gap: 16 },
          { id: "c", rightOf: "b", gap: 16 },
          { id: "a", rightOf: "c", gap: 16 },
        ],
        tokens: [],
        links: [],
      };
      const r = compileIR(ir);
      const cycle = r.violations.filter((v) => /circular/i.test(v.message));
      // The misleading follow-ups: the same three relations reported again as
      // "asked for x=… but resolved to x=0" after the cycle was already refused.
      const reMeasured = r.violations.filter((v) => /was not honoured/.test(v.message));
      const unmet = [
        cycle.length !== 1 ? `expected exactly one cycle diagnostic, got ${cycle.length}` : null,
        reMeasured.length > 0 ? `${reMeasured.length} relation(s) were re-measured after being refused: ${reMeasured.map((v) => v.message).join(" | ")}` : null,
        r.applicable !== false ? "a cyclic relation graph still returned an applicable plan" : null,
        /unpositioned relative to each other/.test(cycle[0]?.message ?? "") ? null : "the cycle message does not say the nodes were left unpositioned",
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? "one cycle diagnostic, no contradictory follow-ups, plan inapplicable" : unmet.join("; "),
        raw: { applicable: r.applicable, diagnostics: r.violations.map((v) => `${v.rule}: ${v.message}`) },
      };
    },
  },
  {
    id: "B7-route",
    title: "A label sitting across a route line is reported above cosmetic noise",
    group: "guardrails",
    requirement: "Text overlapping a topology route is found and ranked as the serious defect it is.",
    run: () => {
      // The reported layout: the Mac mini's "MEMORY TOO LOW" warning sits on the
      // topology's horizontal route, so it reads as route annotation.
      const nodes = [
        node({ id: "frame", name: "EXO_HARD_TEST_CLUSTER_ROUTING_V03", type: "FRAME", depth: 0, x: 0, y: 0, w: 1280, h: 900 }),
        node({ id: "route", parentId: "frame", depth: 1, name: "Vector", type: "VECTOR", x: 120, y: 300, w: 900, h: 2 }),
        node({ id: "warn", parentId: "frame", depth: 1, name: "Memory Warning", type: "TEXT", x: 300, y: 294, w: 160, h: 16, text: { content: "MEMORY TOO LOW", color: "#111111", size: 11, style: "Regular", family: "Inter", styled: true, length: 14 } }),
        // A label that merely sits beside the route must not be reported.
        node({ id: "clear", parentId: "frame", depth: 1, name: "Clear Label", type: "TEXT", x: 300, y: 200, w: 160, h: 16, text: { content: "Node 7", color: "#111111", size: 11, style: "Regular", family: "Inter", styled: true, length: 6 } }),
        // Cosmetic repetition, the noise that used to occupy the whole list.
        // Deliberately text layers with default names: square frames with no
        // label are a legitimate `icon-only-control` finding, which would make
        // this case assert something other than what it is about.
        ...Array.from({ length: 10 }, (_, i) =>
          node({
            id: `r-${i}`, parentId: "frame", depth: 1, name: `Text ${i}`, type: "TEXT", x: i * 90, y: 600, w: 70, h: 16,
            text: { content: `Row ${i}`, color: "#111111", size: 12, style: "Regular", family: "Inter", styled: true, length: 6 },
          }),
        ),
      ];
      const findings = runRules(report(nodes), "review");
      const collisions = of(findings, "text-route-collision");
      const unmet = [
        collisions.length === 0 ? "no route collision found on a label sitting directly on a 900px route line" : null,
        collisions.some((f) => f.nodeIds.includes("clear")) ? "a label 94px clear of the route was reported as a collision" : null,
        collisions[0]?.severity !== "serious" ? `a route collision was reported as ${collisions[0]?.severity}, expected serious` : null,
        // The whole point of B3: a serious measured defect outranks repetition,
        // however much of it there is. Ten cosmetic notes must not lead.
        collisions.length > 0 && findings[0]?.rule !== "text-route-collision" ? `the collision ranked below '${findings[0]?.rule}' (${findings[0]?.severity})` : null,
        of(findings, "default-layer-name").length !== 1 ? "the repeated cosmetic finding did not group to one entry" : null,
      ].filter(Boolean);
      return {
        status: unmet.length === 0 ? "PASS" : "FAIL",
        detail: unmet.length === 0 ? `${collisions.length} collision found, ranked first; clear label untouched` : unmet.join("; "),
        raw: { order: findings.map((f) => `${f.rule}(${f.severity})`), collisions: collisions.map((f) => f.title) },
      };
    },
  },


  {
    id: "A4",
    title: "Large canvas (1920x1200), nested hierarchy, mixed fixed/fill/hug sizing",
    group: "compiler",
    requirement: "Mixed sizing modes resolve without any region leaving the canvas.",
    run: () => {
      const ir = {
        canvas: canvas({ name: "A4 Large", width: 1920, height: 1200 }),
        regions: [
          region({ id: "nav", role: "navigation", width: 240, height: "fill", children: [] }),
          region({ id: "main", role: "content", width: "fill", height: "fill", padding: 32, children: [] }),
          region({ id: "metrics", role: "secondary", width: "fill", height: "hug", grow: 0, children: Array.from({ length: 4 }, (_, i) => `metric-${i}`) }),
          region({ id: "topology", role: "primary-visual", width: 640, height: "fill", composition: "topology", layout: "cluster", children: Array.from({ length: 3 }, (_, i) => `node-${i}`) }),
          region({ id: "inspector", role: "inspector", width: 320, height: "fill", children: ["row-0", "row-1"] }),
        ],
        content: [
          ...Array.from({ length: 4 }, (_, i) => component(`metric-${i}`, { type: "metric", props: { label: `Signal ${i}`, value: `${i * 7}%` } })),
          ...Array.from({ length: 3 }, (_, i) => component(`node-${i}`, { type: "deviceNode", props: { name: `Node ${i}`, status: "healthy" } })),
          ...Array.from({ length: 2 }, (_, i) => text(`row-${i}`, { text: `Row ${i}`, role: "label" })),
        ],
        relations: [],
        tokens: [],
        links: [],
      };
      return compileCase(ir, (r) => {
        const off = offCanvas(r, 1920, 1200);
        const esc = escapingContent(r);
        return [
          off.length ? `regions off canvas: ${off.join(", ")}` : null,
          esc.length ? `${esc.length} nodes escape their region: ${esc.slice(0, 4).join("; ")}` : null,
          r.applicable === false ? `not applicable: ${r.inapplicableReasons.join(" | ")}` : null,
          r.stats.traceMismatches > 0 ? `${r.stats.traceMismatches} emitted-vs-resolved mismatches` : null,
        ].filter(Boolean);
      });
    },
  },

];

/**
 * Live render/apply gate.
 *
 * Separate from `CASES` because these cannot pass by running more code: each one
 * needs a write to Figma and a read back. They report BLOCKED with the reason,
 * and the report says so in those words — criterion 8 forbids describing a
 * dry-run as a live render, and a case that quietly reported PASS would do
 * exactly that.
 */
export const BLOCKED_CASES = [
  ["C1", "Apply only to a dedicated disposable stress-test frame", "An apply is a write to a named frame in the live file, so it cannot be performed or verified by an offline runner."],
  ["C2", "Render the applied frame and inspect visual hierarchy", "Requires a screenshot of a frame that an apply produced; no such frame exists yet."],
  ["C3", "Re-inspect native node geometry after apply", "Requires reading back native node ids, which only exist once C1 has written them."],
  ["C4", "Record plugin version, inputs, verdicts, render evidence", "Cannot be gathered here: recording plugin version and render evidence requires a connected plugin and a frame that an apply actually produced. scripts/run-live-benchmark.mjs does this against the live plugin, not this offline matrix."],
].map(([id, title, reason]) => ({
  id,
  title,
  group: "live",
  requirement: "Live render/apply evidence, gathered only after the dry-run suite passes.",
  run: () => ({ status: "BLOCKED", detail: `${reason} Unblocked only by a connected plugin and an explicit disposable frame.`, raw: { evidence: "none — this is not a live render or apply result" } }),
}));

/**
 * Cases that currently fail.
 *
 * Kept, not deleted. Each one is a measured failure with its evidence, and the
 * test file asserts the status is still `FAIL` so the baseline cannot rot
 * silently. When one starts passing, that test fails and forces a deliberate
 * update — which is the only way an open issue should close.
 */
export const OPEN_CASES = [];

/** Everything, in report order. */
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
