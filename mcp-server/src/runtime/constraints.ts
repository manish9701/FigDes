/**
 * Constraint-based layout (spec §18).
 *
 * ## The problem this solves
 *
 * The spec's example is `constraint("inspector", { rightOf: "topology", gap: 24, width: 320 })`
 * instead of `{ x: 968, y: 0, width: 320, height: 900 }`.
 *
 * That difference is not cosmetic. Absolute coordinates are the single largest
 * source of layout defects when a model writes them: a 24px gutter becomes 20
 * on one side, two panels stop aligning, and every resize invalidates all of it.
 * A constraint states the *relationship*, so the solver computes the coordinate
 * and the relationship cannot drift.
 *
 * ## Design
 *
 * The solver runs after the shell layout has produced boxes, and only moves
 * boxes that a constraint actually names. Untouched boxes keep their computed
 * positions, so adding one constraint never disturbs the rest of the screen.
 *
 * Constraints are applied in dependency order, so a chain
 * (`c rightOf b`, `b rightOf a`) resolves regardless of the order the model
 * wrote them in. Cycles are reported as violations rather than resolved by
 * arbitrary ordering, because a silently wrong position is the failure mode this
 * whole module exists to prevent.
 */
import type { PlacedBox } from "../../../shared/ir";
import { round } from "./layout";

export type { PlacedBox };

export type Align =
  | "start"
  | "center"
  | "end"
  | "stretch"
  | "top"
  | "middle"
  | "bottom"
  | "baseline";

export type FlexibleSize = number | "fill" | "hug";

export interface ConstraintSpec {
  /** Which box this constrains. Must already exist. */
  id: string;
  /** Anchor box on the same parent. */
  rightOf?: string;
  /** Anchor box above this one. */
  below?: string;
  /** Alignment against the anchor, or against the parent when no anchor is given. */
  alignTo?: Align;
  top?: number;
  left?: number;
  right?: number;
  bottom?: number;
  width?: FlexibleSize;
  height?: FlexibleSize;
  /** Space from the anchor. Overrides a single-edge offset when both are set. */
  gap?: number;
  /** Inset from the parent's edges. Pairs with `right`/`bottom` for `fill`. */
  inset?: number;
}

export interface SolveInput {
  boxes: PlacedBox[];
  constraints: ConstraintSpec[];
  /** Parent extent, needed to resolve `fill` and edge insets. */
  parent: PlacedBox;
  violations: Array<{ rule: string; message: string }>;
}

/**
 * Applies constraints in place-ish (returns a new list) and reports anything it
 * could not honour.
 *
 * Returns the same array instance when nothing changed, so callers can cheaply
 * detect that a program contained no constraints at all.
 */
export function solveConstraints(input: SolveInput): PlacedBox[] {
  const { constraints, parent, violations } = input;
  if (constraints.length === 0) return input.boxes;

  const boxes = new Map(input.boxes.map((b) => [b.id, { ...b }]));

  // Validate references up front so a typo is one clear message rather than a
  // cascade of "unknown anchor" failures.
  for (const c of constraints) {
    if (!boxes.has(c.id)) {
      violations.push({ rule: "constraint", message: `Constraint targets unknown node '${c.id}'.` });
    }
    for (const anchor of [c.rightOf, c.below]) {
      if (anchor !== undefined && !boxes.has(anchor)) {
        violations.push({ rule: "constraint", message: `Constraint on '${c.id}' references unknown anchor '${anchor}'.` });
      }
    }
  }

  const ordered = dependencyOrder(constraints, boxes, violations);

  for (const c of ordered) {
    const box = boxes.get(c.id);
    if (!box) continue;

    const anchor = c.rightOf !== undefined ? boxes.get(c.rightOf) : c.below !== undefined ? boxes.get(c.below) : undefined;

    /* ---- sizing, resolved before position so `fill` knows the parent ---- */

    if (typeof c.width === "number") box.w = c.width;
    else if (c.width === "fill") {
      // Fill runs from the box's *current* left edge to the parent's right
      // boundary. Anchoring the left edge here rather than assuming x = 0 is
      // what lets `content` fill the space beside a 240px nav rail instead of
      // jumping back to the canvas edge.
      const rightEdge = c.right !== undefined ? parent.x + parent.w - c.right : parent.x + parent.w - (c.inset ?? 0);
      box.w = Math.max(1, round(rightEdge - box.x));
    }
    // "hug" is left alone: measuring content is the compiler's job.

    if (typeof c.height === "number") box.h = c.height;
    else if (c.height === "fill") {
      const bottomEdge = c.bottom !== undefined ? parent.y + parent.h - c.bottom : parent.y + parent.h - (c.inset ?? 0);
      box.h = Math.max(1, round(bottomEdge - box.y));
    }

    /* ------------------------------------------------- positioning ----- */

    if (c.rightOf !== undefined && anchor) {
      const gap = c.gap ?? 0;
      // Prefer an explicit left offset, then the gap, then fall back to the
      // anchor's right edge with no gap.
      box.x = round(c.left !== undefined ? anchor.x + c.left : anchor.x + anchor.w + gap);
      if (c.top !== undefined) box.y = round(anchor.y + c.top);
      else if (c.alignTo === undefined) box.y = round(anchor.y);
      // `stretch` follows the axis of the relation: rightOf copies the width,
      // below copies the height. Copying width unconditionally would make
      // "same height as the panel above" silently do nothing.
      align(box, anchor, c.alignTo, "x");
    } else if (c.below !== undefined && anchor) {
      const gap = c.gap ?? 0;
      box.y = round(c.top !== undefined ? anchor.y + c.top : anchor.y + anchor.h + gap);
      if (c.left !== undefined) box.x = round(anchor.x + c.left);
      else if (c.alignTo === undefined) box.x = round(anchor.x);
      align(box, anchor, c.alignTo, "y");
    } else {
      // No anchor: offsets are relative to the parent.
      if (c.top !== undefined) box.y = round(parent.y + c.top);
      if (c.left !== undefined) box.x = round(parent.x + c.left);
      if (c.right !== undefined && c.width !== "fill") box.x = round(parent.x + parent.w - c.right - box.w);
      if (c.bottom !== undefined && c.height !== "fill") box.y = round(parent.y + parent.h - c.bottom - box.h);
      // `fill` here means "span the parent between these insets". The left edge
      // only moves when an explicit `left` was given, so a box the shell layout
      // already positioned keeps its position and simply grows.
      if (c.width === "fill" && c.left !== undefined) {
        const right = c.right ?? 0;
        box.w = Math.max(1, round(parent.w - c.left - right));
      }
      if (c.height === "fill" && c.top !== undefined) {
        const bottom = c.bottom ?? 0;
        box.h = Math.max(1, round(parent.h - c.top - bottom));
      }
      align(box, parent, c.alignTo, c.width === "fill" || c.left !== undefined ? "x" : c.height === "fill" || c.top !== undefined ? "y" : undefined);
    }
  }

  // Preserve the caller's ordering: a constraint must not reorder the stack.
  return input.boxes.map((b) => boxes.get(b.id) ?? b);
}

/**
 * Orders constraints so every anchor is positioned before the box that
 * references it.
 *
 * Kahn's algorithm over the anchor edges. Anything left over is part of a cycle
 * and is emitted in declaration order at the end, with one violation naming the
 * whole cycle — a single actionable message beats N contradictory ones.
 */
function dependencyOrder(
  constraints: ConstraintSpec[],
  boxes: Map<string, PlacedBox>,
  violations: Array<{ rule: string; message: string }>,
): ConstraintSpec[] {
  const index = new Map(constraints.map((c, i) => [c.id, i]));
  const remaining = new Map(index);
  const out: ConstraintSpec[] = [];

  const anchorsOf = (c: ConstraintSpec): string[] => [c.rightOf, c.below].filter((a): a is string => a !== undefined);

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, i] of [...remaining]) {
      const c = constraints[i]!;
      const anchors = anchorsOf(c).filter((a) => index.has(a));
      // Ready when no anchor is still pending. Self-reference never resolves.
      const blocked = anchors.some((a) => remaining.has(a) && a !== id);
      if (!blocked) {
        out.push(c);
        remaining.delete(id);
        progressed = true;
      }
    }
  }

  if (remaining.size > 0) {
    const cycle = [...remaining.values()].map((i) => constraints[i]!.id).join(" -> ");
    violations.push({
      rule: "constraint",
      message: `Circular constraints could not be ordered (${cycle}). Applied in declaration order; verify the resulting positions.`,
    });
    for (const i of remaining.values()) out.push(constraints[i]!);
  }

  // A constraint on an unknown node cannot be ordered against anything.
  for (const c of out) {
    if (!boxes.has(c.id)) continue;
  }

  return out;
}

/**
 * Applies an alignment between a box and its anchor.
 *
 * `axis` decides what `stretch` copies. A horizontal relation stretches width, a
 * vertical one stretches height, and with no axis to go on (an alignment against
 * the parent with no offsets given) it defaults to width.
 */
function align(box: PlacedBox, anchor: PlacedBox, alignTo: Align | undefined, axis?: "x" | "y"): void {
  switch (alignTo) {
    case "start":
      break;
    case "center":
      box.x = round(anchor.x + (anchor.w - box.w) / 2);
      break;
    case "end":
      box.x = round(anchor.x + anchor.w - box.w);
      break;
    case "stretch":
      if (axis === "y") box.h = anchor.h;
      else box.w = anchor.w;
      break;
    case "top":
      box.y = anchor.y;
      break;
    case "middle":
      box.y = round(anchor.y + (anchor.h - box.h) / 2);
      break;
    case "bottom":
      box.y = round(anchor.y + anchor.h - box.h);
      break;
    case "baseline":
      // No baseline information is available at this stage, so this degrades to
      // vertical centering. Documented rather than faked: a true baseline pass
      // needs font metrics, which only the plugin can supply.
      box.y = round(anchor.y + (anchor.h - box.h) / 2);
      break;
    default:
      break;
  }
}

/* -------------------------------------------------------------------------- */
/* Spec parsing                                                                 */
/* -------------------------------------------------------------------------- */

/** Parses one loose constraint object into the solver's shape. */
export function parseConstraint(raw: unknown, id: string): ConstraintSpec | { error: string } {
  if (!raw || typeof raw !== "object") return { error: `Constraint for '${id}' is not an object.` };
  const o = raw as Record<string, unknown>;

  const num = (k: string): number | undefined => {
    const v = o[k];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    return v;
  };

  const anchor = (k: string): string | undefined => {
    const v = o[k];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };

  const size = (k: string): FlexibleSize | undefined => {
    const v = o[k];
    if (v === "fill" || v === "hug") return v;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    return undefined;
  };

  const alignRaw = o.alignTo ?? o.align;
  const aligns: Align[] = ["start", "center", "end", "stretch", "top", "middle", "bottom", "baseline"];

  return {
    id,
    ...(anchor("rightOf") !== undefined ? { rightOf: anchor("rightOf")! } : {}),
    ...(anchor("below") !== undefined ? { below: anchor("below")! } : {}),
    ...(typeof alignRaw === "string" && (aligns as string[]).includes(alignRaw) ? { alignTo: alignRaw as Align } : {}),
    ...(num("top") !== undefined ? { top: num("top")! } : {}),
    ...(num("left") !== undefined ? { left: num("left")! } : {}),
    ...(num("right") !== undefined ? { right: num("right")! } : {}),
    ...(num("bottom") !== undefined ? { bottom: num("bottom")! } : {}),
    ...(size("width") !== undefined ? { width: size("width")! } : {}),
    ...(size("height") !== undefined ? { height: size("height")! } : {}),
    ...(num("gap") !== undefined ? { gap: num("gap")! } : {}),
    ...(num("inset") !== undefined ? { inset: num("inset")! } : {}),
  };
}