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
  /**
   * Output: the ids of boxes whose relations were refused and therefore have no
   * resolved position.
   *
   * The caller needs this to stop asking whether those relations were honoured.
   * Re-measuring a refused relation against the shell layout produced a second,
   * contradictory report for the same three nodes — "asked for x=216 but the
   * region resolved to x=0" — immediately after the cycle diagnostic had already
   * said they were never applied. Two answers to one relation, one of them false.
   */
  unresolved?: string[];
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
  const unresolved: string[] = input.unresolved ?? [];
  for (const c of constraints) {
    if (!boxes.has(c.id)) {
      violations.push({ rule: "constraint", message: `Constraint targets unknown node '${c.id}'.` });
      // No box exists to move, so this relation has no resolved position either.
      if (!unresolved.includes(c.id)) unresolved.push(c.id);
    }
    for (const anchor of [c.rightOf, c.below]) {
      if (anchor !== undefined && !boxes.has(anchor)) {
        violations.push({ rule: "constraint", message: `Constraint on '${c.id}' references unknown anchor '${anchor}'.` });
        if (!unresolved.includes(c.id)) unresolved.push(c.id);
      }
    }
  }

  const ordered = dependencyOrder(constraints, boxes, violations, unresolved);

  for (const c of ordered) {
    const box = boxes.get(c.id);
    if (!box) continue;

    const anchor = c.rightOf !== undefined ? boxes.get(c.rightOf) : c.below !== undefined ? boxes.get(c.below) : undefined;

    /* ---- explicit sizes first; `fill` is deferred until after positioning -- */

    if (typeof c.width === "number") box.w = c.width;
    // "hug" is left alone: measuring content is the compiler's job.

    if (typeof c.height === "number") box.h = c.height;

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
      align(box, parent, c.alignTo, c.width === "fill" || c.left !== undefined ? "x" : c.height === "fill" || c.top !== undefined ? "y" : undefined);
    }

    /* ---- `fill` resolved last, from the position this constraint just set --- */

    // `fill` is a measurement from an edge, so it is only meaningful once the
    // edge is known. Resolving it before positioning measured from wherever the
    // shell layout had parked the box, which for an anchored region is the wrong
    // place entirely: `rightOf` plus `height: "fill"` computed the height from
    // the pre-move y and produced a 1px-tall panel at the far right of the
    // canvas (issue #11: "ignores intended side-by-side composition").
    //
    // Fill is resolved after alignment so an explicit size wins over an
    // alignment hint: `width:"fill"` and `alignTo:"stretch"` contradict each
    // other, and the explicit size is the one the author actually typed.
    if (c.width === "fill") {
      const rightEdge = c.right !== undefined ? parent.x + parent.w - c.right : parent.x + parent.w - (c.inset ?? 0);
      box.w = Math.max(1, round(rightEdge - box.x));
    }
    if (c.height === "fill") {
      const bottomEdge = c.bottom !== undefined ? parent.y + parent.h - c.bottom : parent.y + parent.h - (c.inset ?? 0);
      box.h = Math.max(1, round(bottomEdge - box.y));
    }
  }

  // Preserve the caller's ordering: a constraint must not reorder the stack.
  return input.boxes.map((b) => boxes.get(b.id) ?? b);
}

/**
 * Orders constraints so every anchor is positioned before the box that
 * references it.
 *
 * Kahn's algorithm over the anchor edges. Anything left over is part of a cycle.
 *
 * ## A cycle is not ordered, it is refused
 *
 * This used to emit the leftovers "in declaration order" with a warning, and
 * that is the worst of both behaviours: the positions it produced were
 * self-contradictory — `b rightOf a` resolved to x=316 when it expected x=1048 —
 * and the run still reported success, so the nonsense geometry went to Figma.
 * Diagnosing a cycle and then guessing at its layout is the exact failure this
 * module exists to prevent, stated in the warning itself.
 *
 * So a cyclic component is now left entirely unapplied, reported under the
 * blocking `relation` rule, and therefore marks the whole compile
 * inapplicable. The boxes involved keep their shell-layout positions, which is
 * at least visibly *not* the requested arrangement, and the author is told
 * exactly which nodes to break the loop on.
 */
function dependencyOrder(
  constraints: ConstraintSpec[],
  boxes: Map<string, PlacedBox>,
  violations: Array<{ rule: string; message: string }>,
  unresolved: string[],
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
    for (const i of remaining.values()) {
      const id = constraints[i]!.id;
      if (!unresolved.includes(id)) unresolved.push(id);
    }
    violations.push({
      rule: "relation",
      message: `Circular constraints could not be resolved (${cycle}). None of them were applied: these nodes keep wherever the shell layout left them and are unpositioned relative to each other — break the cycle (a relation needs at least one anchored node) and re-run.`,
    });
    // Deliberately not pushed onto `out`. See the note above.
  }

  return out;
}

/**
 * Where a relation says a box should end up, given final anchor geometry.
 *
 * ## Why this exists
 *
 * The compiler checks that relations were honoured by re-deriving the expected
 * position in a second place, and that second place had drifted. It verified
 * `rightOf` and `below` and nothing else, so a relation written as
 * `{ right: 0, top: 0, width: 300 }` was never checked at all: three-region
 * split, `applicable: true`, zero violations, inspector silently dropped to
 * y=366 instead of top-aligned (issue #13, X01 — the "false success" case, and
 * worse than a plain overflow because it produces a confident wrong layout).
 *
 * Duplicating the solver's rules here would only have moved the drift. So the
 * rules live in exactly one place: this function mirrors `solveConstraints`, and
 * both the solver and the verifier call it. A change to how a relation resolves
 * changes the check with it, because there is nothing else to change.
 *
 * `resolve` looks an anchor up by id; returning undefined means the anchor does
 * not exist, which the caller reports separately.
 */
export function expectedRelationBox(
  c: ConstraintSpec,
  parent: PlacedBox,
  resolve: (id: string) => PlacedBox | undefined,
): { x: number; y: number; w: number; h: number } | null {
  const anchor =
    c.rightOf !== undefined ? resolve(c.rightOf) : c.below !== undefined ? resolve(c.below) : undefined;

  // An explicit size is authoritative and is applied before positioning.
  let w: number | undefined = typeof c.width === "number" ? c.width : undefined;
  let h: number | undefined = typeof c.height === "number" ? c.height : undefined;

  let x: number | undefined;
  let y: number | undefined;

  if (anchor && c.rightOf !== undefined) {
    x = round(c.left !== undefined ? anchor.x + c.left : anchor.x + anchor.w + (c.gap ?? 0));
    if (c.top !== undefined) y = round(anchor.y + c.top);
    else if (c.alignTo === undefined) y = round(anchor.y);
  } else if (anchor && c.below !== undefined) {
    y = round(c.top !== undefined ? anchor.y + c.top : anchor.y + anchor.h + (c.gap ?? 0));
    if (c.left !== undefined) x = round(anchor.x + c.left);
    else if (c.alignTo === undefined) x = round(anchor.x);
  } else {
    if (c.top !== undefined) y = round(parent.y + c.top);
    if (c.left !== undefined) x = round(parent.x + c.left);
    // `right`/`bottom` position against the far edge, which needs the size, so
    // they are only meaningful when the size is not flexible.
    if (c.right !== undefined && c.width !== "fill") x = round(parent.x + parent.w - c.right - (w ?? 0));
    if (c.bottom !== undefined && c.height !== "fill") y = round(parent.y + parent.h - c.bottom - (h ?? 0));
  }

  // Alignment and `fill` are applied after positioning, and they override the
  // plain edge math — an explicit size still wins over an alignment hint,
  // which is the order `solveConstraints` uses.
  if (anchor && x !== undefined && w !== undefined) {
    if (c.alignTo === "center") x = round(anchor.x + (anchor.w - w) / 2);
    else if (c.alignTo === "end") x = round(anchor.x + anchor.w - w);
    else if (c.alignTo === "stretch") w = anchor.w;
  }

  if (w === undefined && c.width === "fill") {
    const rightEdge = c.right !== undefined ? parent.x + parent.w - c.right : parent.x + parent.w - (c.inset ?? 0);
    x = x ?? parent.x;
    w = Math.max(1, round(rightEdge - x));
  }
  if (h === undefined && c.height === "fill") {
    const bottomEdge = c.bottom !== undefined ? parent.y + parent.h - c.bottom : parent.y + parent.h - (c.inset ?? 0);
    y = y ?? parent.y;
    h = Math.max(1, round(bottomEdge - y));
  }

  if (x === undefined || y === undefined) return null;
  return { x, y, w: w ?? Number.NaN, h: h ?? Number.NaN };
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