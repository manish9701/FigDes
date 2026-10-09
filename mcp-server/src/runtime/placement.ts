/**
 * Root-frame auto-placement (canvas packing).
 *
 * Every screen used to land at (0,0), so each new design buried the previous
 * ones in one overlapping pile and the model had to go move them by hand —
 * or never noticed. New root frames now go into free canvas space: right of
 * existing content with a deliberate gap, wrapping to a new row when the page
 * runs wide.
 *
 * Pure and dependency-free: existing frames in, coordinates out. The caller
 * (runRuntimeTool / create_design) supplies the file state; this module only
 * does the geometry, which is what makes the no-overlap property testable
 * without Figma.
 */

export interface PlacedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap between a new frame and its neighbours. Room to breathe, not a canyon. */
export const PLACEMENT_GAP = 240;
/** Page width at which a row wraps instead of running further right. */
export const PLACEMENT_MAX_ROW_WIDTH = 12000;

export interface Placement {
  x: number;
  y: number;
  /** Why this position: which frames were avoided. */
  reason: string;
}

function intersects(a: PlacedRect, b: PlacedRect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Finds free canvas for a w×h frame.
 *
 * Rows start at x=0 and stack downward: the candidate sits right of the
 * rightmost frame on the topmost row that has room, else opens a new row
 * below the lowest frame. The returned rect is guaranteed disjoint from
 * every input rect (asserted by tests, not hoped).
 */
export function placeRootFrame(
  existing: readonly PlacedRect[],
  rootW: number,
  rootH: number,
  gap = PLACEMENT_GAP,
  maxRowWidth = PLACEMENT_MAX_ROW_WIDTH,
): Placement {
  const frames = existing.filter((f) => f.w > 0 && f.h > 0);
  if (frames.length === 0) {
    return { x: 0, y: 0, reason: "Empty page: first frame goes at the origin." };
  }

  const rightEdge = Math.max(...frames.map((f) => f.x + f.w));
  const bottomEdge = Math.max(...frames.map((f) => f.y + f.h));

  // Preferred: right of everything, aligned to the top row.
  const topRow = frames.filter((f) => f.y < bottomEdge - 1);
  const rowRight = topRow.length > 0 ? Math.max(...topRow.map((f) => f.x + f.w)) : rightEdge;
  const candidate: PlacedRect = { x: rowRight + gap, y: 0, w: rootW, h: rootH };

  if (candidate.x + rootW <= maxRowWidth && !frames.some((f) => intersects(candidate, f))) {
    const neighbour = topRow.length > 0 ? `right of x=${rowRight}` : "on a clear row";
    return { x: candidate.x, y: 0, reason: `Free canvas ${neighbour} with a ${gap}px gap; verified disjoint from ${frames.length} existing frame(s).` };
  }

  // No room on the top row (or past the width budget): open a new row below.
  const below: PlacedRect = { x: 0, y: bottomEdge + gap, w: rootW, h: rootH };
  if (!frames.some((f) => intersects(below, f))) {
    return { x: 0, y: below.y, reason: `Top row full past x=${maxRowWidth}; new row below y=${bottomEdge} with a ${gap}px gap.` };
  }

  // Pathological overlap (should not happen): shift right until clear, bounded.
  let x = below.x;
  let guard = 0;
  while (frames.some((f) => intersects({ x, y: below.y, w: rootW, h: rootH }, f)) && guard < 1000) {
    const blocker = frames.filter((f) => intersects({ x, y: below.y, w: rootW, h: rootH }, f));
    x = Math.max(...blocker.map((f) => f.x + f.w)) + gap;
    guard++;
  }
  return { x, y: below.y, reason: `Crowded canvas: walked right to x=${x} to clear ${frames.length} frame(s).` };
}
