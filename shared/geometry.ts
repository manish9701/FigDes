/**
 * Canonical geometry contract (quality-reliability P0).
 *
 * Every measurement carries its coordinate space, and comparisons only ever
 * happen inside one space. The live defect that motivated this: rotated LINE
 * nodes reported absolute page coordinates (x=1935) while the overflow rule
 * compared them against parent-local dimensions (w=824) — a guaranteed false
 * positive that no unit test caught because nothing named the space.
 *
 * Spaces:
 * - "page"          document/canvas coordinates (absoluteBoundingBox).
 * - "parent-local"  origin at the direct parent's top-left; sizes identical.
 * - "local-unverified" fallback when no absolute box exists; comparisons
 *   against it must downgrade confidence, never hard-fail.
 */
export type CoordinateSpace = "page" | "parent-local" | "local-unverified";

export interface AbsBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function isFiniteBox(b: AbsBox): boolean {
  return (
    Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.w) && Number.isFinite(b.h) && b.w >= 0 && b.h >= 0
  );
}

/**
 * Converts a child's absolute (page-space) bounds to parent-local bounds by
 * subtracting the parent's absolute origin. Sizes are identical in both
 * spaces; rotation is already baked into axis-aligned absolute boxes, so the
 * result is conservative for rotated nodes (may slightly over-cover, never
 * under-cover). Returns null when either box is non-finite.
 */
export function toParentLocal(childAbs: AbsBox, parentAbs: AbsBox): (AbsBox & { space: Extract<CoordinateSpace, "parent-local"> }) | null {
  if (!isFiniteBox(childAbs) || !isFiniteBox(parentAbs)) return null;
  return {
    x: childAbs.x - parentAbs.x,
    y: childAbs.y - parentAbs.y,
    w: childAbs.w,
    h: childAbs.h,
    space: "parent-local",
  };
}

/** True when box `inner` (in `outer`'s local space) spills past `outer`. */
export function spillSides(
  inner: AbsBox,
  outer: { w: number; h: number },
  tolerance = 0.5,
): Array<"left" | "right" | "top" | "bottom"> {
  const spills: Array<"left" | "right" | "top" | "bottom"> = [];
  if (inner.x + inner.w > outer.w + tolerance) spills.push("right");
  if (inner.y + inner.h > outer.h + tolerance) spills.push("bottom");
  if (inner.x < -tolerance) spills.push("left");
  if (inner.y < -tolerance) spills.push("top");
  return spills;
}
