/**
 * The composition handoff (issue #28).
 *
 * ## The defect this closes
 *
 * `plan_screen` resolves a *composition model* — the regions, the hierarchy
 * between them, the box each one was given — and `design_runtime` resolves the
 * geometry that is actually built. Between those two resolutions there was no
 * check at all.
 *
 * So the runtime was free to resolve a **different composition** and say
 * nothing: the inspector grew into the hero, a region stepped out of its
 * column, a panel that was planned inside a region landed beside it, a
 * stacked shell became a band. The build still reported
 * `status: "completed"`, because "completed" only ever meant "the operations
 * ran" — never "the composition is the one that was planned".
 *
 * That is exactly the failure the live session hit: the runtime composition
 * build did not hold, the screen was made by hand on the native path, and
 * nothing in the system said *why* the runtime's answer differed from the
 * plan's. The workaround was practical; the defect was still there.
 *
 * ## What a composition actually is
 *
 * Not a list of pixels. A composition is five things, and this module checks
 * all five against the **resolved** geometry:
 *
 * 1. **presence** — the regions the plan promised are on the screen;
 * 2. **containment** — what the plan put inside a region is still inside it,
 *    and what it put beside it is still beside it;
 * 3. **arrangement** — the plan's left/right/above/below relations hold;
 * 4. **alignment** — a column still starts on one line, a band still starts on
 *    one line;
 * 5. **hierarchy** — the plan's visual priority still reads the same way: the
 *    focal region still holds the canvas, and no secondary region has taken
 *    it over.
 *
 * A violation is **blocking**: the build is refused and the defect is
 * explained, rather than shipping a composition nobody planned.
 *
 * ## What it deliberately tolerates
 *
 * Content changes size. A region holding more text than the plan assumed
 * grows, everything below it moves, and the canvas-fit pass shrinks the stack
 * to bring it back inside the canvas. That is a legitimate build, not a
 * different composition.
 *
 * So the handoff compares **structure**, not pixels: presence, containment,
 * arrangement, the *leading* edges (a column's left edge, a band's top edge —
 * the edges a proportional reflow cannot move), and prominence. Raw pixel
 * drift is reported as advisory, with the numbers, so a caller can see the
 * movement without the build being refused for it.
 *
 * A composition that survives all of it is the same composition, however the
 * pixels moved.
 */
import { z } from "zod";
import { inferComposition } from "./layout";
import type { Region } from "../../../shared/ir";

/* -------------------------------------------------------------------------- */
/* The contract                                                                 */
/* -------------------------------------------------------------------------- */

const BoxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().min(0),
  h: z.number().min(0),
});

/**
 * The plan's composition model, frozen into something a machine can check.
 *
 * It is derived from a plan (a `plan_screen` output, a screen plan, or the
 * pipeline's composition plan) and then travels with the program into the
 * build, so the build is measured against the intent that produced it rather
 * than against nothing.
 */
export const CompositionContractSchema = z.object({
  /** The canvas the plan was resolved for. */
  canvas: z.object({
    width: z.number().positive().max(20000),
    height: z.number().positive().max(20000),
  }),
  /** Every region the plan declared, with the box it was given. */
  regions: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        role: z.string().min(1).max(40).default("custom"),
        composition: z.string().min(1).max(40).default("auto"),
        /** Visual priority. 1 is the most important. 0 when the plan ranked none. */
        rank: z.number().int().min(0).max(40).default(0),
        /** True for the plan's focal region. */
        focal: z.boolean().default(false),
        planned: BoxSchema,
      }),
    )
    .min(1)
    .max(40),
  /** Regions the plan nested inside another. */
  containment: z
    .array(z.object({ inner: z.string().min(1).max(64), outer: z.string().min(1).max(64) }))
    .max(200)
    .default([]),
  /** Edges the plan's geometry shared. They must still be shared. */
  alignment: z
    .array(
      z.object({
        a: z.string().min(1).max(64),
        b: z.string().min(1).max(64),
        edge: z.enum(["left", "right", "top", "bottom"]),
      }),
    )
    .max(400)
    .default([]),
  /** The plan's relative placement: what was left of what, above what. */
  arrangement: z
    .array(
      z.object({
        a: z.string().min(1).max(64),
        b: z.string().min(1).max(64),
        relation: z.enum(["left", "right", "above", "below"]),
      }),
    )
    .max(400)
    .default([]),
  /** What the plan put inside which region. */
  content: z
    .array(z.object({ id: z.string().min(1).max(64), region: z.string().min(1).max(64) }))
    .max(800)
    .default([]),
  /** Where the contract came from, for the receipt. */
  source: z.string().min(1).max(120).default("plan"),
});

export type CompositionContract = z.infer<typeof CompositionContractSchema>;

/* -------------------------------------------------------------------------- */
/* Findings                                                                     */
/* -------------------------------------------------------------------------- */

export type HandoffRule =
  | "region-missing"
  | "region-unplanned"
  | "containment-broken"
  | "alignment-broken"
  | "arrangement-changed"
  | "hierarchy-inverted"
  | "focal-diminished"
  | "geometry-drift"
  | "composition-changed";

export interface HandoffFinding {
  id: string;
  rule: HandoffRule;
  /** "blocking" refuses the build; "advisory" is reported and does not. */
  severity: "blocking" | "advisory";
  /** What the plan said. */
  planned: string;
  /** What the build resolved. */
  resolved: string;
  /** One sentence: what is wrong. */
  summary: string;
  /** Why it matters to the screen. */
  why: string;
  /** What would fix it. */
  fix: string;
  /** The regions the finding is about. */
  nodes: string[];
}

export type HandoffStatus = "pass" | "fail" | "review" | "unchecked" | "not-applicable";

export interface HandoffReceipt {
  status: HandoffStatus;
  /** How many assertions ran. Zero means nothing was checked. */
  checked: number;
  /** The contract's provenance. */
  source: string;
  /** One line: what the handoff concluded. */
  summary: string;
  findings: HandoffFinding[];
  /** The blocking findings as plain sentences — the refusal carries these. */
  reasons: string[];
  /** Why the check did not run, when it did not. */
  notChecked?: string;
}

/* -------------------------------------------------------------------------- */
/* Tolerances                                                                   */
/* -------------------------------------------------------------------------- */

/** Two planned edges this close (px) are the same line. */
const PLANNED_EDGE_EPS = 2;

/**
 * How far a resolved edge may drift from a line the plan declared shared.
 *
 * Generous on purpose: a proportional canvas-fit shrink moves trailing edges
 * by tens of pixels, and that is a legitimate reflow. What must not survive is
 * a *rearrangement* — an edge that moved by a fraction of the canvas means
 * the region is now somewhere else.
 */
function edgeTolerance(canvas: number): number {
  return Math.max(8, Math.round(canvas * 0.02));
}

/** Chrome is furniture. It is allowed to be large without leading the screen. */
const CHROME_ROLES = new Set(["navigation", "header", "footer", "status-rail"]);

/* -------------------------------------------------------------------------- */
/* Deriving the contract from a plan                                            */
/* -------------------------------------------------------------------------- */

type Box = { x: number; y: number; w: number; h: number };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBox(record: Record<string, unknown>): Box | null {
  const x = asNumber(record["x"]) ?? asNumber(record["left"]);
  const y = asNumber(record["y"]) ?? asNumber(record["top"]);
  const w = asNumber(record["w"]) ?? asNumber(record["width"]);
  const h = asNumber(record["h"]) ?? asNumber(record["height"]);
  if (x === null || y === null || w === null || h === null) return null;
  return { x, y, w, h };
}

/** The canvas the plan was resolved for, from whichever shape carried it. */
function readCanvas(source: Record<string, unknown>): { width: number; height: number } | null {
  const composition = asRecord(source["composition"]);
  const intent = asRecord(source["intent"]);
  const candidates = [
    composition === null ? null : asRecord(composition["canvas"]) ?? composition,
    intent === null ? null : asRecord(intent["canvas"]) ?? intent,
    asRecord(source["canvas"]),
    source,
  ];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const width = asNumber(candidate["width"]);
    const height = asNumber(candidate["height"]);
    if (width !== null && height !== null && width > 0 && height > 0) return { width, height };
  }
  return null;
}

/**
 * The planned box of every region, from whichever shape carried it.
 *
 * Three shapes are read, because three places carry a plan: a `plan_screen`
 * output (`composition.boxes`), a screen plan (`boxes`), and the pipeline's
 * composition plan (`regions[].bounds`).
 */
function readPlannedBoxes(source: Record<string, unknown>): Map<string, Box> {
  const out = new Map<string, Box>();

  const lists = [asRecord(source["composition"])?.["boxes"], source["boxes"]];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const entry = asRecord(raw);
      if (entry === null) continue;
      const id = typeof entry["name"] === "string" ? entry["name"] : typeof entry["id"] === "string" ? entry["id"] : null;
      if (id === null) continue;
      const box = readBox(entry);
      if (box !== null && !out.has(id)) out.set(id, box);
    }
  }

  const regions = source["regions"];
  if (Array.isArray(regions)) {
    for (const raw of regions) {
      const region = asRecord(raw);
      if (region === null) continue;
      const id = typeof region["id"] === "string" ? region["id"] : null;
      if (id === null) continue;
      const bounds = asRecord(region["bounds"]);
      if (bounds === null) continue;
      const box = readBox(bounds);
      if (box !== null && !out.has(id)) out.set(id, box);
    }
  }

  return out;
}

/** Role, composition, rank and focal status, from whichever shape carried them. */
function readRegionMeta(source: Record<string, unknown>): {
  roles: Map<string, { role: string; composition: string }>;
  ranks: Map<string, number>;
  focal: string | null;
} {
  const roles = new Map<string, { role: string; composition: string }>();
  const regions = source["regions"];
  if (Array.isArray(regions)) {
    for (const raw of regions) {
      const region = asRecord(raw);
      if (region === null) continue;
      const id = typeof region["id"] === "string" ? region["id"] : null;
      if (id === null) continue;
      roles.set(id, {
        role: typeof region["role"] === "string" ? region["role"] : "custom",
        composition: typeof region["composition"] === "string" ? region["composition"] : "auto",
      });
    }
  }

  const ranks = new Map<string, number>();
  const artDirection = asRecord(source["artDirection"]);
  const hierarchies = [artDirection?.["hierarchy"], source["hierarchy"]];
  for (const hierarchy of hierarchies) {
    if (!Array.isArray(hierarchy)) continue;
    for (const raw of hierarchy) {
      const entry = asRecord(raw);
      if (entry === null) continue;
      const id = typeof entry["id"] === "string" ? entry["id"] : null;
      const rank = asNumber(entry["rank"]);
      if (id === null || rank === null) continue;
      if (!ranks.has(id)) ranks.set(id, rank);
    }
  }

  let focal: string | null = null;
  const focalCandidates = [artDirection?.["focal"], source["focal"]];
  for (const candidate of focalCandidates) {
    const entry = asRecord(candidate);
    if (entry === null) continue;
    if (typeof entry["id"] === "string") {
      focal = entry["id"];
      break;
    }
  }

  return { roles, ranks, focal };
}

/** The content the plan put inside which region. */
function readContentAssignments(source: Record<string, unknown>): Array<{ id: string; region: string }> {
  const out: Array<{ id: string; region: string }> = [];
  const content = source["content"];
  if (!Array.isArray(content)) return out;
  for (const raw of content) {
    const entry = asRecord(raw);
    if (entry === null) continue;
    const id = typeof entry["id"] === "string" ? entry["id"] : null;
    const region =
      typeof entry["region"] === "string"
        ? entry["region"]
        : typeof entry["regionId"] === "string"
          ? entry["regionId"]
          : typeof entry["parent"] === "string"
            ? entry["parent"]
            : null;
    if (id === null || region === null) continue;
    out.push({ id, region });
  }
  return out;
}

/** True when `inner` sits inside `outer`. */
function inside(inner: Box, outer: Box, eps = 1): boolean {
  return (
    inner.x >= outer.x - eps &&
    inner.y >= outer.y - eps &&
    inner.x + inner.w <= outer.x + outer.w + eps &&
    inner.y + inner.h <= outer.y + outer.h + eps
  );
}

/**
 * The relations the planned geometry expresses.
 *
 * Derived once, from the plan's own boxes, and then frozen into the contract:
 * the build is checked against a statement of intent, not against a
 * recomputation that could drift with the code that checks it.
 *
 * Two boxes are read as *side by side* when they overlap vertically and are
 * separated horizontally, and as *stacked* when they overlap horizontally and
 * are separated vertically. Boxes that overlap on both axes are nested, and
 * nested boxes carry a containment relation rather than an arrangement one.
 */
function deriveRelations(
  regions: Array<{ id: string; planned: Box }>,
): {
  containment: Array<{ inner: string; outer: string }>;
  alignment: Array<{ a: string; b: string; edge: "left" | "right" | "top" | "bottom" }>;
  arrangement: Array<{ a: string; b: string; relation: "left" | "right" | "above" | "below" }>;
} {
  const containment: Array<{ inner: string; outer: string }> = [];
  const alignment: Array<{ a: string; b: string; edge: "left" | "right" | "top" | "bottom" }> = [];
  const arrangement: Array<{ a: string; b: string; relation: "left" | "right" | "above" | "below" }> = [];

  for (let i = 0; i < regions.length; i++) {
    for (let j = i + 1; j < regions.length; j++) {
      const a = regions[i]!;
      const b = regions[j]!;
      const ab = a.planned;
      const bb = b.planned;
      if (ab.w <= 0 || ab.h <= 0 || bb.w <= 0 || bb.h <= 0) continue;

      const vOverlap = Math.min(ab.y + ab.h, bb.y + bb.h) - Math.max(ab.y, bb.y);
      const hOverlap = Math.min(ab.x + ab.w, bb.x + bb.w) - Math.max(ab.x, bb.x);

      const aInsideB = inside(ab, bb);
      const bInsideA = inside(bb, ab);
      if (aInsideB && !bInsideA) containment.push({ inner: a.id, outer: b.id });
      else if (bInsideA && !aInsideB) containment.push({ inner: b.id, outer: a.id });

      if (vOverlap > 0 && hOverlap <= 0) {
        // Side by side. The leading edge of a band is its top: a band that
        // starts lower than its sibling is a different composition.
        const left = ab.x + ab.w / 2 <= bb.x + bb.w / 2 ? a : b;
        const right = left === a ? b : a;
        arrangement.push({ a: left.id, b: right.id, relation: "left" });
        if (Math.abs(ab.y - bb.y) <= PLANNED_EDGE_EPS) alignment.push({ a: a.id, b: b.id, edge: "top" });
      } else if (hOverlap > 0 && vOverlap <= 0) {
        // Stacked. The leading edge of a column is its left.
        const top = ab.y + ab.h / 2 <= bb.y + bb.h / 2 ? a : b;
        const bottom = top === a ? b : a;
        arrangement.push({ a: top.id, b: bottom.id, relation: "above" });
        if (Math.abs(ab.x - bb.x) <= PLANNED_EDGE_EPS) alignment.push({ a: a.id, b: b.id, edge: "left" });
      }
    }
  }

  return { containment, alignment, arrangement };
}

/**
 * Freezes a plan into a composition contract.
 *
 * Returns null when the plan carries no geometry to check against — a plan
 * with no boxes is not a composition model, and pretending otherwise would
 * let a build claim it was checked when it was not.
 */
export function deriveCompositionContract(source: unknown): CompositionContract | null {
  const record = asRecord(source);
  if (record === null) return null;

  const canvas = readCanvas(record);
  const boxes = readPlannedBoxes(record);
  if (canvas === null || boxes.size === 0) return null;

  const { roles, ranks, focal } = readRegionMeta(record);
  const regions = [...boxes.entries()].map(([id, planned]) => {
    const meta = roles.get(id);
    return {
      id,
      role: meta?.role ?? "custom",
      composition: meta?.composition ?? "auto",
      rank: ranks.get(id) ?? 0,
      focal: focal === id,
      planned,
    };
  });

  const relations = deriveRelations(regions);

  return {
    canvas,
    regions,
    containment: relations.containment,
    alignment: relations.alignment,
    arrangement: relations.arrangement,
    content: readContentAssignments(record),
    source: typeof record["source"] === "string" ? record["source"] : "plan",
  };
}

/* -------------------------------------------------------------------------- */
/* Verifying the handoff                                                        */
/* -------------------------------------------------------------------------- */

export interface ResolvedComposition {
  canvas: { width: number; height: number };
  regions: Array<{ id: string; role: string; composition: string; x: number; y: number; w: number; h: number }>;
  content?: Array<{ id: string; parent?: string; x: number; y: number; w: number; h: number }>;
}

function fmt(box: { x: number; y: number; w: number; h: number }): string {
  return `(${Math.round(box.x)}, ${Math.round(box.y)}) ${Math.round(box.w)}x${Math.round(box.h)}`;
}

function edgeValue(box: { x: number; y: number; w: number; h: number }, edge: "left" | "right" | "top" | "bottom"): number {
  if (edge === "left") return box.x;
  if (edge === "right") return box.x + box.w;
  if (edge === "top") return box.y;
  return box.y + box.h;
}

const EDGE_NAME: Record<"left" | "right" | "top" | "bottom", string> = {
  left: "left",
  right: "right",
  top: "top",
  bottom: "bottom",
};

/**
 * Checks the resolved geometry against the plan's composition model.
 *
 * Blocking findings mean the build is a different composition from the one
 * that was planned, and the caller refuses to ship it.
 */
export function verifyCompositionHandoff(
  contract: CompositionContract,
  resolved: ResolvedComposition,
): HandoffReceipt {
  const findings: HandoffFinding[] = [];
  let checked = 0;

  const planned = new Map(contract.regions.map((r) => [r.id, r]));
  const built = new Map(resolved.regions.map((r) => [r.id, r]));
  const tolX = edgeTolerance(resolved.canvas.width);
  const tolY = edgeTolerance(resolved.canvas.height);

  const canvasArea = resolved.canvas.width * resolved.canvas.height;
  const plannedShare = (box: Box): number => (box.w * box.h) / (contract.canvas.width * contract.canvas.height);
  const builtShare = (box: { w: number; h: number }): number => (box.w * box.h) / canvasArea;

  /* --- 1. presence ------------------------------------------------------- */

  for (const region of contract.regions) {
    checked++;
    if (built.has(region.id)) continue;
    findings.push({
      id: `handoff-region-missing-${region.id}`,
      rule: "region-missing",
      severity: "blocking",
      planned: `'${region.id}' was planned at ${fmt(region.planned)} and had to be on the screen.`,
      resolved: `No region '${region.id}' was built.`,
      summary: `The region '${region.id}' the plan promised is not on the screen.`,
      why: "A region that was planned and then dropped is a hole in the composition: the screen reads as unfinished exactly where the plan promised content.",
      fix: `Restore region '${region.id}' with the role it was planned for ('${region.role}'), or change the plan and rebuild against the changed plan.`,
      nodes: [region.id],
    });
  }

  for (const region of resolved.regions) {
    checked++;
    if (planned.has(region.id)) continue;
    findings.push({
      id: `handoff-region-unplanned-${region.id}`,
      rule: "region-unplanned",
      severity: "advisory",
      planned: `The plan declared ${contract.regions.length} region(s) and did not declare '${region.id}'.`,
      resolved: `'${region.id}' was built at ${fmt(region)}.`,
      summary: `The build added a region the plan did not declare: '${region.id}'.`,
      why: "An unplanned region is not automatically wrong — but it changes the composition the plan was reviewed against, so it is named rather than left implicit.",
      fix: `Add '${region.id}' to the plan (with why it exists), or remove it from the build.`,
      nodes: [region.id],
    });
  }

  /* --- 2. containment ---------------------------------------------------- */

  for (const relation of contract.containment) {
    checked++;
    const inner = built.get(relation.inner);
    const outer = built.get(relation.outer);
    if (inner === undefined || outer === undefined) continue; // already reported as missing
    if (inside(inner, outer, 1)) continue;
    findings.push({
      id: `handoff-containment-${relation.inner}`,
      rule: "containment-broken",
      severity: "blocking",
      planned: `'${relation.inner}' was inside '${relation.outer}'.`,
      resolved: `'${relation.inner}' is at ${fmt(inner)}, outside '${relation.outer}' at ${fmt(outer)}.`,
      summary: `The region '${relation.inner}' escaped the region '${relation.outer}' that was supposed to hold it.`,
      why: "Containment is what makes a composition legible: a panel that belongs inside a region has to stay inside it, or the screen reads as a set of unrelated pieces.",
      fix: `Put '${relation.inner}' back inside '${relation.outer}', or move the content it holds into a region that fits it.`,
      nodes: [relation.inner, relation.outer],
    });
  }

  // The content the plan put inside a region must still be in that region.
  const builtContent = new Map((resolved.content ?? []).map((c) => [c.id, c]));
  for (const assignment of contract.content) {
    checked++;
    const content = builtContent.get(assignment.id);
    if (content === undefined) continue; // a slot the build chose not to draw is the planner's business
    const parent = content.parent;
    if (parent !== undefined && parent !== assignment.region) {
      findings.push({
        id: `handoff-content-parent-${assignment.id}`,
        rule: "containment-broken",
        severity: "blocking",
        planned: `'${assignment.id}' was planned inside '${assignment.region}'.`,
        resolved: `'${assignment.id}' was built inside '${parent}'.`,
        summary: `The content '${assignment.id}' was placed in '${parent}' instead of the region '${assignment.region}' the plan gave it.`,
        why: "Moving content between regions moves what the screen is about: the inspector's data inside the content column is a different screen, not a nudged one.",
        fix: `Parent '${assignment.id}' to '${assignment.region}', or move it in the plan first.`,
        nodes: [assignment.id, assignment.region],
      });
      continue;
    }
    const region = built.get(assignment.region);
    if (region === undefined) continue;
    if (inside(content, region, 1)) continue;
    findings.push({
      id: `handoff-content-escape-${assignment.id}`,
      rule: "containment-broken",
      severity: "blocking",
      planned: `'${assignment.id}' was planned inside '${assignment.region}' (${fmt(region)}).`,
      resolved: `'${assignment.id}' resolved to ${fmt(content)}, outside it.`,
      summary: `The content '${assignment.id}' does not fit inside the region '${assignment.region}' it belongs to.`,
      why: "Content that leaves its region either overlaps a neighbour or runs off the canvas. Both read as a broken screen rather than a dense one.",
      fix: `Give '${assignment.region}' the room '${assignment.id}' needs, or shorten what '${assignment.id}' carries.`,
      nodes: [assignment.id, assignment.region],
    });
  }

  /* --- 3. arrangement ---------------------------------------------------- */

  for (const relation of contract.arrangement) {
    checked++;
    const a = built.get(relation.a);
    const b = built.get(relation.b);
    if (a === undefined || b === undefined) continue;

    const horizontal = relation.relation === "left" || relation.relation === "right";
    const tol = horizontal ? tolX : tolY;
    const aCentre = horizontal ? a.x + a.w / 2 : a.y + a.h / 2;
    const bCentre = horizontal ? b.x + b.w / 2 : b.y + b.h / 2;
    const aStart = horizontal ? a.x : a.y;
    const aEnd = horizontal ? a.x + a.w : a.y + a.h;
    const bStart = horizontal ? b.x : b.y;
    const bEnd = horizontal ? b.x + b.w : b.y + b.h;

    // The relation holds when the first region still comes before the second
    // on that axis, and still does not reach past it.
    const ordered = relation.relation === "left" || relation.relation === "above" ? aCentre < bCentre : aCentre > bCentre;
    const separated = relation.relation === "left" || relation.relation === "above" ? aEnd <= bStart + tol : aStart >= bEnd - tol;
    if (ordered && separated) continue;

    findings.push({
      id: `handoff-arrangement-${relation.a}-${relation.relation}-${relation.b}`,
      rule: "arrangement-changed",
      severity: "blocking",
      planned: `'${relation.a}' was ${relation.relation} '${relation.b}'.`,
      resolved: `'${relation.a}' is at ${fmt(a)}, '${relation.b}' is at ${fmt(b)}.`,
      summary: `The arrangement changed: '${relation.a}' is no longer ${relation.relation} '${relation.b}'.`,
      why: "Which region sits beside which is the composition. A navigation rail that moves to the other side of the content is not a nudge — it is a different screen to read.",
      fix: `Restore '${relation.a}' ${relation.relation} '${relation.b}', or state the new arrangement in the plan so the build and the plan agree again.`,
      nodes: [relation.a, relation.b],
    });
  }

  /* --- 4. alignment ------------------------------------------------------ */

  for (const relation of contract.alignment) {
    checked++;
    const a = built.get(relation.a);
    const b = built.get(relation.b);
    if (a === undefined || b === undefined) continue;
    const tol = relation.edge === "left" || relation.edge === "right" ? tolX : tolY;
    const drift = Math.abs(edgeValue(a, relation.edge) - edgeValue(b, relation.edge));
    if (drift <= tol) continue;
    findings.push({
      id: `handoff-alignment-${relation.a}-${relation.edge}-${relation.b}`,
      rule: "alignment-broken",
      severity: "blocking",
      planned: `'${relation.a}' and '${relation.b}' shared their ${EDGE_NAME[relation.edge]} edge in the plan.`,
      resolved: `Their ${EDGE_NAME[relation.edge]} edges are now ${Math.round(drift)}px apart ('${relation.a}' at ${fmt(a)}, '${relation.b}' at ${fmt(b)}).`,
      summary: `The alignment broke: '${relation.a}' and '${relation.b}' no longer share their ${EDGE_NAME[relation.edge]} edge.`,
      why: "Shared edges are what make a screen read as one grid. When two panels that started on the same line no longer do, the eye has nothing to hold on to.",
      fix: `Put '${relation.a}' and '${relation.b}' back on the same ${EDGE_NAME[relation.edge]} edge, or change the plan so it never promised one.`,
      nodes: [relation.a, relation.b],
    });
  }

  /* --- 5. hierarchy ------------------------------------------------------ */

  const focal = contract.regions.find((r) => r.focal);
  if (focal !== undefined) {
    checked++;
    const builtFocal = built.get(focal.id);
    if (builtFocal !== undefined) {
      const before = plannedShare(focal.planned);
      const after = builtShare(builtFocal);
      const tolerance = Math.max(0.05, before * 0.25);
      if (after < before - tolerance) {
        findings.push({
          id: "handoff-focal-diminished",
          rule: "focal-diminished",
          severity: "blocking",
          planned: `The focal region '${focal.id}' held ${Math.round(before * 100)}% of the canvas.`,
          resolved: `It holds ${Math.round(after * 100)}% now (${fmt(builtFocal)}).`,
          summary: `The focal region '${focal.id}' lost its place on the screen.`,
          why: "The focal region is where the eye lands first. A build that shrinks it hands the screen to something else, and the hierarchy the plan decided is no longer the hierarchy on the canvas.",
          fix: `Give '${focal.id}' back the space the plan gave it, or name a different focal region in the plan and rebuild against that.`,
          nodes: [focal.id],
        });
      }
    }
  }

  // The plan's prominence order must survive. Chrome is exempt: a full-width
  // header band is furniture and is allowed to be the largest box on screen.
  const ranked = contract.regions
    .filter((r) => !CHROME_ROLES.has(r.role))
    .map((r) => ({ region: r, before: plannedShare(r.planned) }));
  for (let i = 0; i < ranked.length; i++) {
    for (let j = 0; j < ranked.length; j++) {
      if (i === j) continue;
      const a = ranked[i]!;
      const b = ranked[j]!;
      if (a.before <= b.before + 0.05) continue; // the plan did not separate them
      checked++;
      const builtA = built.get(a.region.id);
      const builtB = built.get(b.region.id);
      if (builtA === undefined || builtB === undefined) continue;
      const afterA = builtShare(builtA);
      const afterB = builtShare(builtB);
      const tolerance = Math.max(0.05, b.before * 0.2);
      if (afterB - afterA <= tolerance) continue;
      findings.push({
        id: `handoff-hierarchy-${a.region.id}-${b.region.id}`,
        rule: "hierarchy-inverted",
        severity: "blocking",
        planned: `'${a.region.id}' held ${Math.round(a.before * 100)}% of the canvas and '${b.region.id}' held ${Math.round(b.before * 100)}%.`,
        resolved: `'${a.region.id}' holds ${Math.round(afterA * 100)}% and '${b.region.id}' holds ${Math.round(afterB * 100)}%.`,
        summary: `The hierarchy inverted: '${b.region.id}' now outweighs '${a.region.id}', which the plan ranked above it.`,
        why: "The plan's order of importance is the screen's reading order. When a secondary region overtakes the primary one, the screen answers a different question than the one that was planned.",
        fix: `Restore '${a.region.id}' to the space the plan gave it, or re-rank it in the plan before rebuilding.`,
        nodes: [a.region.id, b.region.id],
      });
    }
  }

  /* --- 6. advisory drift and composition kind ---------------------------- */

  const drifted: string[] = [];
  for (const region of contract.regions) {
    const resolvedRegion = built.get(region.id);
    if (resolvedRegion === undefined) continue;
    const dx = Math.round(resolvedRegion.x - region.planned.x);
    const dy = Math.round(resolvedRegion.y - region.planned.y);
    const dw = Math.round(resolvedRegion.w - region.planned.w);
    const dh = Math.round(resolvedRegion.h - region.planned.h);
    if (Math.abs(dx) <= 24 && Math.abs(dy) <= 24 && Math.abs(dw) <= 24 && Math.abs(dh) <= 24) continue;
    drifted.push(`'${region.id}' planned ${fmt(region.planned)} → built ${fmt(resolvedRegion)} (Δ ${dx}, ${dy}, ${dw}, ${dh})`);
  }
  if (drifted.length > 0) {
    findings.push({
      id: "handoff-geometry-drift",
      rule: "geometry-drift",
      severity: "advisory",
      planned: `${contract.regions.length} region(s) at the boxes the plan resolved.`,
      resolved: drifted.join("; "),
      summary: `The build moved or resized ${drifted.length} region(s) against the plan.`,
      why: "Content that needed more room, and the canvas-fit pass that gave it back, move pixels. That is a legitimate build as long as the composition held — but the movement is reported so it is never a surprise.",
      fix: "Nothing to fix unless the movement is not explained by the content. Read the region that grew and the one that moved.",
      nodes: [],
    });
  }

  const plannedComposition = inferComposition(
    contract.regions.map((r) => ({
      role: r.role as Region["role"],
      composition: r.composition as Region["composition"],
      width: r.planned.w,
      grow: 0,
    })),
  );
  const appliedComposition = inferComposition(
    resolved.regions.map((r) => ({
      role: r.role as Region["role"],
      composition: r.composition as Region["composition"],
      width: r.w,
      grow: 0,
    })),
  );
  if (plannedComposition !== appliedComposition) {
    findings.push({
      id: "handoff-composition-changed",
      rule: "composition-changed",
      severity: "advisory",
      planned: `The plan's regions read as '${plannedComposition}'.`,
      resolved: `The built regions read as '${appliedComposition}'.`,
      summary: `The screen reads as '${appliedComposition}' rather than the planned '${plannedComposition}'.`,
      why: "Composition is inferred from the roles and weights that are on the screen. A different reading means the balance moved, even when every individual region is where the plan put it.",
      fix: "Re-check the regions' roles and weights, or state the composition explicitly on the region that should lead.",
      nodes: [],
    });
  }

  /* --- verdict ----------------------------------------------------------- */

  const blocking = findings.filter((f) => f.severity === "blocking");
  const advisory = findings.filter((f) => f.severity === "advisory");
  const status: HandoffStatus = blocking.length > 0 ? "fail" : advisory.length > 0 ? "review" : "pass";
  const summary =
    blocking.length > 0
      ? `The build is a different composition from the plan: ${blocking.length} blocking defect(s), ${advisory.length} advisory note(s).`
      : advisory.length > 0
        ? `The composition held: ${checked} check(s) passed, ${advisory.length} advisory note(s).`
        : `The composition held: ${checked} check(s) passed.`;

  return {
    status,
    checked,
    source: contract.source,
    summary,
    findings,
    reasons: blocking.map((f) => `${f.summary} ${f.why} ${f.fix}`),
  };
}

/**
 * The receipt for a check that could not run.
 *
 * "Nobody checked" and "nothing was wrong" are different sentences, and this
 * one says which of them it is.
 */
export function uncheckedReceipt(reason: string, source = "plan"): HandoffReceipt {
  return {
    status: "unchecked",
    checked: 0,
    source,
    summary: `The composition handoff did not run: ${reason}`,
    findings: [],
    reasons: [],
    notChecked: reason,
  };
}
