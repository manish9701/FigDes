/**
 * Review workflows (spec §8, §9, §10, §19).
 *
 * Three tools that connect the pieces the system already has into the loop the
 * spec asks for: plan → compose → create → render → judge → review → fix.
 *
 * - `score_design` turns a compiled program into per-dimension 0-10 scores with
 *   evidence. It answers "is this a 6 or a 9" before presentation, deterministically.
 * - `refine_screen` runs the fix loop server-side: review, apply
 *   high-confidence fixes, re-review, up to a bounded iteration count. The model
 *   judges renders between iterations; the tool does the mechanical part.
 * - `diff_design` answers "what changed visually" structurally: two inspect
 *   snapshots in, a compact delta out. No pixel heatmap is claimed, because none
 *   is computed — layout delta, movement, density, colour and text changes are.
 */
import { z } from "zod";
import { executeRuntime } from "../runtime/interpreter";
import { inferComposition } from "../runtime/layout";
import { canvasSize } from "../../../shared/ir";
import { runRules } from "./rules";
import { scoreDesign } from "./score";
import { guardMutation } from "../plan/gate";
import type { Session } from "../sessions";
import type { Finding, MetricsReport, ReviewReport } from "../../../shared/protocol";

/* -------------------------------------------------------------------------- */
/* score_design                                                                */
/* -------------------------------------------------------------------------- */

export const ScoreArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    program: z.unknown().describe("The declarative program to score. Compiled and scored without touching Figma."),
  })
  .strict();

export function scoreDesignTool(rawArgs: unknown): unknown {
  const args = ScoreArgs.parse(rawArgs);
  const result = executeRuntime(args.program);

  const report = scoreDesign({
    boxes: result.boxes,
    operations: result.operations as never,
    regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
    composition: inferComposition(result.ir.regions),
    canvasW: canvasSize(result.ir.canvas.width, 1440),
    canvasH: canvasSize(result.ir.canvas.height, 900),
    ...(result.ir.visualIntent?.focal !== undefined ? { focal: result.ir.visualIntent.focal } : {}),
  });

  return {
    status: "ok",
    overall: report.overall,
    dimensions: report.dimensions,
    weakSpots: report.weakSpots,
    /**
     * The spec's definition of done (§19), evaluated against what can be known
     * offline. Structural QA and visual review need the live file, so they are
     * listed as remaining rather than assumed.
     */
    doneChecklist: {
      "primary decision obvious": report.dimensions.find((d) => d.dimension === "Composition")!.score >= 7,
      "intentional hierarchy": report.dimensions.find((d) => d.dimension === "Hierarchy")!.score >= 7,
      "no weak spots below 6": report.weakSpots.length === 0,
      "structural QA (review_design on the live file)": false,
      "rendered and visually reviewed": false,
    },
    warnings: result.warnings,
    violations: result.violations,
  };
}

/* -------------------------------------------------------------------------- */
/* refine_screen                                                               */
/* -------------------------------------------------------------------------- */

export const RefineArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Build this program first, then refine what it made. */
    program: z.unknown().optional(),
    /** Otherwise refine the current selection (or nodeId). */
    nodeId: z.string().max(200).optional(),
    /** What the iterations should optimise for. Reported back each round. */
    visualGoals: z.array(z.string().max(200)).max(10).optional(),
    /** Node ids or rule names the loop must not touch. */
    preserve: z.array(z.string().max(200)).max(50).default([]),
    /** Hard bound. A loop without one is a loop that can run forever. */
    maxIterations: z.number().int().min(1).max(5).default(3),
    description: z.string().max(1000).optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();

interface RefineIteration {
  iteration: number;
  highConfidenceFindings: number;
  appliedFixes: number;
  appliedRules: string[];
  skipped: string[];
  remainingHigh: number;
}

export async function refineScreenTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = RefineArgs.parse(rawArgs);
  const goals = args.visualGoals ?? [];
  const preserve = new Set(args.preserve);
  const iterations: RefineIteration[] = [];

  if (!session) {
    throw new Error("refine_screen needs a connected Figma plugin: it reviews and fixes the live document.");
  }

  let target: Record<string, unknown> = {};
  if (args.nodeId) target = { nodeId: args.nodeId };

  // Optional build phase: the program lands first, then the loop polishes it.
  if (args.program !== undefined) {
    const { runRuntimeTool } = await import("../runtime/tools");
    await runRuntimeTool(session, { program: args.program, description: args.description ?? "refine_screen build phase" });
  }

  let converged = false;
  for (let i = 1; i <= args.maxIterations; i++) {
    const raw = (await session.request("collect_metrics", target)) as MetricsReport;
    const findings = runRules(raw, "review").filter((f) => f.confidence === "high");

    // Preserve list applies to node ids and to rule names: either skips a fix.
    const actionable = findings.filter(
      (f) => !preserve.has(f.rule) && f.suggestedOperations && f.suggestedOperations.length > 0 && !f.nodeIds.some((id) => preserve.has(id)),
    );
    const skipped = findings.filter((f) => !actionable.includes(f)).map((f) => f.rule);

    if (actionable.length === 0) {
      iterations.push({ iteration: i, highConfidenceFindings: findings.length, appliedFixes: 0, appliedRules: [], skipped, remainingHigh: findings.length });
      converged = findings.length === 0;
      break;
    }

    const operations = actionable.flatMap((f) => f.suggestedOperations ?? []);
    const gate = guardMutation({
      operations: operations as Array<Record<string, unknown>>,
      approved: args.approved,
      reason: args.reason,
    });
    if (gate) {
      return {
        status: "needs-approval",
        iterations,
        question: gate.question,
        ifApproved: gate.ifApproved,
        instead: gate.instead,
        howToProceed: "Nothing further was changed. Re-send with approved:true to let the loop apply these fixes.",
      };
    }

    const applied = (await session.request("modify_design", {
      description: `refine_screen iteration ${i}: ${actionable.map((f) => f.rule).join(", ")}`,
      operations,
    })) as { status?: string; error?: { message?: string } };

    if (applied.status !== "success") {
      iterations.push({
        iteration: i,
        highConfidenceFindings: findings.length,
        appliedFixes: 0,
        appliedRules: [],
        skipped,
        remainingHigh: findings.length,
      });
      return {
        status: "fix-failed",
        iterations,
        error: applied.error?.message ?? "the fix transaction failed",
        howToProceed: "Inspect the target and fix by hand, or narrow preserve[] and retry.",
      };
    }

    iterations.push({
      iteration: i,
      highConfidenceFindings: findings.length,
      appliedFixes: operations.length,
      appliedRules: actionable.map((f) => f.rule),
      skipped,
      remainingHigh: -1,
    });

    if (i === args.maxIterations) break;

    // Re-review to see what is left; the next iteration decides from evidence.
    const recheck = (await session.request("collect_metrics", target)) as MetricsReport;
    const remaining = runRules(recheck, "review").filter((f) => f.confidence === "high").length;
    iterations[iterations.length - 1]!.remainingHigh = remaining;
    if (remaining === 0) {
      converged = true;
      break;
    }
  }

  return {
    status: converged ? "converged" : "budget-exhausted",
    iterations,
    visualGoals: goals,
    howToProceed: converged
      ? "No high-confidence findings remain. Render at low detail to judge hierarchy, then run design_guard before calling it done."
      : `Still ${iterations[iterations.length - 1]?.remainingHigh ?? "?"} high-confidence finding(s) after ${args.maxIterations} iteration(s). Widen maxIterations (max 5) or fix the rest by hand.`,
  };
}

/* -------------------------------------------------------------------------- */
/* final_qa                                                                  */
/* -------------------------------------------------------------------------- */

export const FinalQaArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Score and guard this program offline. */
    program: z.unknown().optional(),
    /** Also review the live selection (or nodeId) for the technical checks. */
    target: z.record(z.unknown()).optional(),
    nodeId: z.string().max(200).optional(),
    project: z.string().max(200).optional(),
  })
  .strict();

interface ChecklistItem {
  area: "PRODUCT" | "COMPOSITION" | "SYSTEM" | "VISUAL" | "TECHNICAL";
  check: string;
  pass: boolean | null;
  detail: string;
}

/**
 * The §33 quality gate: one checklist, five areas, one verdict.
 *
 * Each item is measured or explicitly marked unmeasurable — never guessed. A
 * null pass means "needs the live file", which is itself the instruction. The
 * generation fails (verdict FAIL) only on measured critical misses; everything
 * else is a warning or a pending live check.
 */
export async function finalQaTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = FinalQaArgs.parse(rawArgs);
  const items: ChecklistItem[] = [];

  if (args.program !== undefined) {
    const scored = scoreDesignTool({ program: args.program }) as {
      overall: number;
      dimensions: Array<{ dimension: string; score: number }>;
      weakSpots: string[];
    };
    const dimension = (name: string): number => scored.dimensions.find((d) => d.dimension === name)?.score ?? 0;

    items.push(
      { area: "PRODUCT", check: "primary user decision is obvious", pass: dimension("Composition") >= 7, detail: `composition ${dimension("Composition")}/10` },
      { area: "COMPOSITION", check: "one dominant focal point", pass: dimension("Focus") >= 6, detail: `focus ${dimension("Focus")}/10` },
      { area: "COMPOSITION", check: "visual hierarchy is intentional", pass: dimension("Hierarchy") >= 7, detail: `hierarchy ${dimension("Hierarchy")}/10` },
      { area: "COMPOSITION", check: "whitespace is intentional", pass: dimension("Information density") >= 6, detail: `density ${dimension("Information density")}/10` },
      { area: "SYSTEM", check: "type scale consistent", pass: dimension("Visual consistency") >= 6, detail: `consistency ${dimension("Visual consistency")}/10` },
      { area: "VISUAL", check: "supporting content does not compete", pass: dimension("Hierarchy") >= 7 && dimension("Focus") >= 6, detail: "hierarchy and focus agree" },
      { area: "VISUAL", check: "screen does not feel template-generated", pass: null, detail: "needs human eyes: does any region feel stamped?" },
    );

    const guarded = (await import("../memory/tools").then((m) =>
      m.designGuardTool(session, { ...(args.project !== undefined ? { project: args.project } : {}), program: args.program }),
    )) as { verdict?: string; findings?: Array<{ verdict?: string; rule?: string }> };
    const failed = (guarded.findings ?? []).filter((f) => f.verdict === "FAIL");
    items.push({
      area: "PRODUCT",
      check: "no product-truth violations",
      pass: failed.length === 0,
      detail: failed.length === 0 ? `guard: ${guarded.verdict ?? "PASS"}` : `failing rules: ${failed.map((f) => f.rule).join(", ")}`,
    });
  }

  if (session && (args.target !== undefined || args.nodeId !== undefined)) {
    const target = args.target ?? (args.nodeId !== undefined ? { nodeId: args.nodeId } : {});
    const raw = (await session.request("collect_metrics", target)) as MetricsReport;
    const findings = runRules(raw, "review");
    const high = findings.filter((f) => f.confidence === "high");
    const cardWall = findings.some((f) => f.rule === "card-wall");
    items.push(
      { area: "TECHNICAL", check: "no overflow or broken structure", pass: high.length === 0, detail: high.length === 0 ? "no high-confidence findings" : `${high.length} high-confidence: ${high.map((f) => f.rule).join(", ")}` },
      { area: "COMPOSITION", check: "no accidental card wall", pass: !cardWall, detail: cardWall ? "card-wall rule fired" : "no card wall detected" },
      { area: "TECHNICAL", check: "render succeeds", pass: null, detail: "render the selection at low detail to confirm" },
    );
  } else {
    items.push(
      { area: "TECHNICAL", check: "no overflow or broken structure", pass: null, detail: "needs the live file: run review_design" },
      { area: "TECHNICAL", check: "render succeeds", pass: null, detail: "needs the live file: render at low detail" },
    );
  }

  const failed = items.filter((i) => i.pass === false);
  const pending = items.filter((i) => i.pass === null);

  return {
    status: "ok",
    verdict: failed.length > 0 ? "FAIL" : "PASS WITH LIVE CHECKS PENDING",
    checklist: items,
    failed: failed.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    pendingLiveChecks: pending.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    howToProceed:
      failed.length > 0
        ? "Fix every failed item, then re-run. A screen that misses critical criteria is not finished."
        : "Clear the pending live checks (review_design, one low-detail render, design_guard with inspect:true), then call it done.",
  };
}

export const DiffArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Earlier snapshot: an inspect_selection-shaped node tree. */
    before: z.record(z.unknown()),
    /** Later snapshot, same shape. */
    after: z.record(z.unknown()),
  })
  .strict();

interface FlatNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  texts: string[];
}

/** Flattens an inspect-shaped tree into id-keyed nodes. */
function flattenSnapshot(root: unknown): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();

  const walk = (node: unknown): string[] => {
    if (!node || typeof node !== "object") return [];
    const n = node as Record<string, unknown>;
    const kids = Array.isArray(n.children) ? n.children : [];
    const childTexts = kids.flatMap(walk);

    const id = typeof n.id === "string" ? n.id : "";
    if (id) {
      const own = typeof n.content === "string" ? [n.content] : typeof n.text === "string" ? [n.text] : [];
      out.set(id, {
        id,
        type: typeof n.type === "string" ? n.type : "?",
        name: typeof n.name === "string" ? n.name : "",
        x: typeof n.x === "number" ? n.x : 0,
        y: typeof n.y === "number" ? n.y : 0,
        w: typeof n.w === "number" ? n.w : (typeof n.width === "number" ? n.width : 0),
        h: typeof n.h === "number" ? n.h : (typeof n.height === "number" ? n.height : 0),
        ...(typeof n.background === "string" ? { fill: n.background } : {}),
        texts: [...own, ...childTexts],
      });
    }
    return id ? out.get(id)!.texts : childTexts;
  };

  if (root && typeof root === "object") {
    const r = root as Record<string, unknown>;
    // Accept either a bare node, {selection:[...]}, or {nodes:[...]}.
    const seeds: unknown[] = Array.isArray(r.selection) ? r.selection : Array.isArray(r.nodes) ? r.nodes : [root];
    for (const seed of seeds) walk(seed);
  }
  return out;
}

export function diffDesignTool(rawArgs: unknown): unknown {
  const args = DiffArgs.parse(rawArgs);
  const before = flattenSnapshot(args.before);
  const after = flattenSnapshot(args.after);

  const added: string[] = [];
  const removed: string[] = [];
  const moved: Array<{ id: string; name: string; dx: number; dy: number }> = [];
  const resized: Array<{ id: string; name: string; from: string; to: string }> = [];
  const recolored: Array<{ id: string; name: string; from?: string; to?: string }> = [];
  const renamed: Array<{ id: string; from: string; to: string }> = [];
  const textChanged: Array<{ id: string; name: string }> = [];

  for (const [id, node] of after) {
    if (!before.has(id)) {
      added.push(`${node.type} "${node.name}" (${id})`);
    }
  }
  for (const [id, node] of before) {
    if (!after.has(id)) {
      removed.push(`${node.type} "${node.name}" (${id})`);
      continue;
    }
    const next = after.get(id)!;
    if (Math.abs(next.x - node.x) > 1 || Math.abs(next.y - node.y) > 1) {
      moved.push({ id, name: next.name, dx: Math.round(next.x - node.x), dy: Math.round(next.y - node.y) });
    }
    if (Math.abs(next.w - node.w) > 1 || Math.abs(next.h - node.h) > 1) {
      resized.push({ id, name: next.name, from: `${Math.round(node.w)}x${Math.round(node.h)}`, to: `${Math.round(next.w)}x${Math.round(next.h)}` });
    }
    if (node.fill !== next.fill && (node.fill !== undefined || next.fill !== undefined)) {
      recolored.push({ id, name: next.name, ...(node.fill !== undefined ? { from: node.fill } : {}), ...(next.fill !== undefined ? { to: next.fill } : {}) });
    }
    if (node.name !== next.name) renamed.push({ id, from: node.name, to: next.name });
    if (node.texts.join("|") !== next.texts.join("|")) textChanged.push({ id, name: next.name });
  }

  const density = (map: Map<string, FlatNode>): number => {
    let area = 0;
    for (const node of map.values()) area += Math.max(0, node.w) * Math.max(0, node.h);
    return Math.round(area);
  };

  return {
    status: "ok",
    summary: {
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      resized: resized.length,
      recolored: recolored.length,
      renamed: renamed.length,
      textChanged: textChanged.length,
      areaDelta: density(after) - density(before),
    },
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    moved: moved.slice(0, 20),
    resized: resized.slice(0, 20),
    recolored: recolored.slice(0, 20),
    renamed: renamed.slice(0, 20),
    textChanged: textChanged.slice(0, 20),
  };
}