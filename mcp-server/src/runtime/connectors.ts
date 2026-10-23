/**
 * Connectors (spec §16).
 *
 * ## Why this is not just a line
 *
 * The spec lists connectors alongside curves and polygons, but they are the only
 * one of those that depend on *other nodes' geometry*. That dependency is the
 * whole value: a topology diagram is meaningless if the lines do not terminate on
 * the machines they connect, and it becomes stale the moment anything moves.
 *
 * So a connector is expressed as a relationship (`from`, `to`) and the geometry
 * is solved here, at compile time, from the boxes that were just computed. If a
 * node moves later the connector does not follow — Figma has no such constraint
 * — but the diagram is correct at authoring time, which is when it is read.
 *
 * ## Geometry
 *
 * Endpoints are found by clipping the centre-to-centre ray against each box, so
 * a connector terminates *on the machine* rather than at the middle of it. Then:
 *
 * - `straight`   one segment
 * - `orthogonal` a three-segment Z route, horizontal- or vertical-dominant by
 *                whichever displacement is larger. This is what makes a rack
 *                diagram look deliberate; diagonal lines between boxes read as
 *                spaghetti.
 * - `curved`     a single quadratic bowed away from the straight line
 *
 * Arrowheads are emitted as closed triangular subpaths rather than as separate
 * nodes, so a connector is one vector: one node in the layer list, one object to
 * select, and no risk of an arrowhead detaching from its line.
 */
import type { ResolvedBox } from "../../../shared/ir";
import type { PlacedBox } from "./constraints";

export type Routing = "straight" | "orthogonal" | "curved";

export interface ConnectorSpec {
  id: string;
  from: string;
  to: string;
  routing?: Routing;
  label?: string;
  stroke?: string | number;
  strokeWeight?: number;
  /** Arrowhead at the `from` end. */
  arrowStart?: boolean;
  /** Arrowhead at the `to` end. Defaults to true. */
  arrowEnd?: boolean;
  dashPattern?: number[];
  /** Bow amount for `curved`, as a fraction of the displacement. */
  curvature?: number;
}

export interface ConnectorResult {
  /** SVG path data in absolute coordinates, ready for normalisation. */
  path: string;
  /** Midpoint of the route, where a label should sit. */
  labelAt?: { x: number; y: number };
  /**
   * Absolute polyline vertices of the main route (curve control points
   * excluded). Used for clearance checks and label-tangent derivation, so
   * callers measure what was actually routed rather than re-deriving it.
   */
  points: Array<{ x: number; y: number }>;
  /** Human-readable description used in the operation name. */
  summary: string;
  /**
   * True when heads were wanted but the gap was too short for them, so the
   * route is a plain line. The summary already says so in prose; this flag
   * carries the same fact as data so the caller can report it without parsing
   * its own sentence.
   */
  arrowheadsOmitted: boolean;
}

/** Default arrowhead length. Scaled by stroke weight in `arrowHead`. */
const ARROW = 10;

/**
 * Minimum connector chord that keeps both arrowheads, for a stroke weight.
 *
 * Arrowheads scale with the stroke, so a heavier edge needs a longer run:
 * a 3px critical edge needs 50px where a 1px edge needs 20px. Layout uses
 * this to pitch nodes far enough apart to keep their direction; anything
 * shorter degrades to a plain line with a warning (see `routeConnector`).
 */
export function arrowSpace(strokeWeight?: number): number {
  const w = strokeWeight ?? 1;
  return 2 * Math.max(6, ARROW * Math.min(2.5, Math.max(0.75, w)));
}

/**
 * Clips a ray from a box's centre to its boundary.
 *
 * A rectangle is not a circle, so the exit distance is the *smaller* of the
 * horizontal and vertical crossings. Using the larger one places endpoints
 * outside the box, which is the classic off-by-a-box bug in diagram tools.
 */
function edgePoint(box: ResolvedBox, towardX: number, towardY: number): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = towardX - cx;
  const dy = towardY - cy;

  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x: cx, y: cy };

  const halfW = Math.max(1, box.w / 2);
  const halfH = Math.max(1, box.h / 2);

  // Time along the ray at which each axis leaves the box.
  const tx = Math.abs(dx) < 1e-6 ? Infinity : halfW / Math.abs(dx);
  const ty = Math.abs(dy) < 1e-6 ? Infinity : halfH / Math.abs(dy);
  const t = Math.min(tx, ty);

  return { x: cx + dx * t, y: cy + dy * t };
}

/**
 * Builds a closed triangular arrowhead pointing along `dir`.
 *
 * The base is offset backwards along the direction and spread perpendicular, so
 * it always sits outside the target box and points into it.
 */
function arrowHead(tip: { x: number; y: number }, dir: { x: number; y: number }, size: number): string {
  const len = Math.hypot(dir.x, dir.y) || 1;
  const ux = dir.x / len;
  const uy = dir.y / len;
  const px = -uy;
  const py = ux;

  const bx = tip.x - ux * size;
  const by = tip.y - uy * size;
  const spread = size * 0.5;

  const f = (n: number): number => Math.round(n * 100) / 100;
  return `M ${f(tip.x)} ${f(tip.y)} L ${f(bx + px * spread)} ${f(by + py * spread)} L ${f(bx - px * spread)} ${f(by - py * spread)} Z`;
}

/**
 * Routes one connector between two resolved boxes.
 *
 * Returns `null` when either box is missing, so the caller can record a
 * violation instead of emitting a line to nowhere.
 */
export function routeConnector(spec: ConnectorSpec, from: ResolvedBox | undefined, to: ResolvedBox | undefined): ConnectorResult | null {
  if (!from || !to) return null;

  const routing: Routing = spec.routing ?? "orthogonal";
  const f = (n: number): number => Math.round(n * 100) / 100;

  const c1 = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const c2 = { x: to.x + to.w / 2, y: to.y + to.h / 2 };

  const p1 = edgePoint(from, c2.x, c2.y);
  const p2 = edgePoint(to, c1.x, c1.y);

  const parts: string[] = [];
  let labelAt: { x: number; y: number } | undefined;
  let points: Array<{ x: number; y: number }>;

  if (routing === "straight") {
    parts.push(`M ${f(p1.x)} ${f(p1.y)} L ${f(p2.x)} ${f(p2.y)}`);
    labelAt = { x: f((p1.x + p2.x) / 2), y: f((p1.y + p2.y) / 2) };
    points = [p1, p2];
  } else if (routing === "curved") {
    // Bow perpendicular to the chord. Sign follows the vertical displacement so
    // curves do not flip sides when a node crosses the diagonal.
    const k = Math.min(2, Math.max(-2, spec.curvature ?? 0.2));
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const nx = -(p2.y - p1.y);
    const ny = p2.x - p1.x;
    const len = Math.hypot(nx, ny) || 1;
    const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const offset = (chord * k) / 2;
    const cx = mx + (nx / len) * offset;
    const cy = my + (ny / len) * offset;
    parts.push(`M ${f(p1.x)} ${f(p1.y)} Q ${f(cx)} ${f(cy)} ${f(p2.x)} ${f(p2.y)}`);
    // The quadratic's midpoint is not the control point, so the label is placed
    // on the real curve: B(0.5) = 0.25*p1 + 0.5*c + 0.25*p2.
    labelAt = { x: f(0.25 * p1.x + 0.5 * cx + 0.25 * p2.x), y: f(0.25 * p1.y + 0.5 * cy + 0.25 * p2.y) };
    // Clearance and tangents measure the chord: the bow never leaves it by more
    // than half the chord times curvature, and measuring the bowed midpoint
    // against node boxes is the label pass's job, not the clearance pass's.
    points = [p1, p2];
  } else {
    const dx = Math.abs(p2.x - p1.x);
    const dy = Math.abs(p2.y - p1.y);
    const pts: Array<{ x: number; y: number }> = [p1];

    if (dx >= dy) {
      const mid = p1.x + (p2.x - p1.x) / 2;
      pts.push({ x: mid, y: p1.y }, { x: mid, y: p2.y });
    } else {
      const mid = p1.y + (p2.y - p1.y) / 2;
      pts.push({ x: p1.x, y: mid }, { x: p2.x, y: mid });
    }
    pts.push(p2);

    parts.push(pts.map((p, i) => `${i === 0 ? "M" : "L"} ${f(p.x)} ${f(p.y)}`).join(" "));
    const midIndex = Math.floor(pts.length / 2);
    labelAt = { x: f(pts[midIndex]!.x), y: f(pts[midIndex]!.y) };
    points = pts;
  }

  // Arrowheads ride along as closed subpaths so the whole connector is one node.
  //
  // They are sized against the stroke weight, which assumes there is a run of
  // line for them to sit at the end of. When two nodes are adjacent — a stacked
  // cluster puts them 8px apart — the chord is shorter than the heads, so the
  // heads cover it completely and what reaches Figma is a floating triangle with
  // a stub inside it. That is what the live frame showed (issue L07): a small
  // grey arrowhead in empty canvas that belonged to nothing.
  //
  // So the heads are only drawn when the line is long enough to show one. Below
  // that the connector stays a plain line, which is truthful: two adjacent nodes
  // 8px apart do not need a direction cue, they need to be further apart.
  const weight = spec.strokeWeight ?? 1;
  const size = arrowSpace(weight) / 2;
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const headsFit = chord >= arrowSpace(weight);

  if (spec.arrowEnd !== false && headsFit) parts.push(arrowHead(p2, { x: p2.x - p1.x, y: p2.y - p1.y }, size));
  if (spec.arrowStart && headsFit) parts.push(arrowHead(p1, { x: p1.x - p2.x, y: p1.y - p2.y }, size));

  const summary = `${routing} connector ${spec.from} -> ${spec.to}`;

  // A degenerate route is still a real route, so it is reported rather than
  // dropped — but the summary says why it looks the way it does, because
  // "why is this a bare line?" is otherwise unanswerable from the file.
  const note = headsFit
    ? ""
    : ` (nodes ${Math.round(chord)}px apart, closer than the ${Math.round(size * 2)}px the arrowheads need, so it is drawn without one)`;

  // Heads were wanted (an end head is the default) but the gap could not show
  // them. Reported as data, not just prose, so the compile can warn on it.
  // The fallback is deliberately a plain line, never a detached triangle: a
  // short gap reads as adjacency, and adjacency needs no direction cue.
  const headsWanted = spec.arrowEnd !== false || spec.arrowStart === true;
  return { path: parts.join(" "), points, ...(labelAt ? { labelAt } : {}), summary: summary + note, arrowheadsOmitted: headsWanted && !headsFit };
}

/* -------------------------------------------------------------------------- */
/* Label placement + edge clearance (issue #24 follow-up)                      */
/* -------------------------------------------------------------------------- */

/**
 * Z-order contract for connectors.
 *
 * Within one parent (a region, or the root for cross-region edges) the emit
 * order is: region frame, node fills/frames, connector vectors, connector
 * labels. Operation order is paint order, so edges paint above node fills but
 * below every label, and a label never hides behind its own line. Connector
 * vectors are kind-distinct from decorative borders and rules: the operation
 * name states the routed edge (`"<routing> connector <from> -> <to>"`), and
 * no shape/vector/line decoration emission sets `fillArrows` — so a hairline
 * border or rule can never be mistaken for an edge by inspection.
 */
export const CONNECTOR_CLEARANCE_MIN = 8;

export interface LabelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Estimated label extent for collision checks.
 *
 * Matches the emitted label (JetBrains Mono 11px, weight 600): ~6.6px per
 * glyph plus padding, 14px tall. An estimate, not a measurement — the plugin
 * owns the true metrics — but the same estimate reserves the lane and tests
 * the overlap, so the two can never disagree with each other.
 */
export function labelBoxAt(x: number, y: number, text: string): LabelBox {
  return { x, y, w: Math.max(24, Math.round(text.length * 6.6 + 12)), h: 14 };
}

function boxesOverlap(a: LabelBox, b: LabelBox, pad = 0): boolean {
  return a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;
}

/**
 * Picks a label anchor that does not sit on a node or another label.
 *
 * Candidates are tried perpendicular to the edge, above first: an edge label
 * reads as a caption, and captions sit above what they describe. `tangent` is
 * the edge direction at the anchor; the perpendicular picks the upward side.
 * `placed` is the lane reservation — every accepted label is pushed there by
 * the caller, so two edges sharing a midpoint cannot stack their captions.
 * Deterministic: the candidate order never changes, and the fallback is the
 * first candidate (above), matching the old fixed offset when nothing is free.
 */
export function pickLabelPosition(
  anchor: { x: number; y: number },
  tangent: { x: number; y: number },
  text: string,
  obstacles: LabelBox[],
  placed: LabelBox[],
): { x: number; y: number } {
  const len = Math.hypot(tangent.x, tangent.y) || 1;
  let px = -tangent.y / len;
  let py = tangent.x / len;
  // Prefer the upward side: flip the perpendicular when it points down.
  if (py > 0) {
    px = -px;
    py = -py;
  }
  const above: Array<{ x: number; y: number }> = [
    { x: anchor.x + px * 10 + 6, y: anchor.y + py * 10 - 20 },
    { x: anchor.x + px * 22 + 6, y: anchor.y + py * 22 - 20 },
    { x: anchor.x - px * 10 + 6, y: anchor.y - py * 10 + 6 },
    { x: anchor.x - px * 22 + 6, y: anchor.y - py * 22 + 6 },
    { x: anchor.x + 14, y: anchor.y - 7 },
    { x: anchor.x - labelBoxAt(0, 0, text).w - 14, y: anchor.y - 7 },
  ];
  for (const c of above) {
    const box = labelBoxAt(c.x, c.y, text);
    const hitsNode = obstacles.some((o) => boxesOverlap(box, o, 2));
    const hitsLabel = placed.some((o) => boxesOverlap(box, o, 2));
    if (!hitsNode && !hitsLabel) return { x: Math.round(c.x * 100) / 100, y: Math.round(c.y * 100) / 100 };
  }
  return { x: Math.round(above[0]!.x * 100) / 100, y: Math.round(above[0]!.y * 100) / 100 };
}

/** Tangent of the routed polyline at its label anchor (middle segment). */
export function labelTangent(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length < 2) return { x: 1, y: 0 };
  const mid = Math.floor(points.length / 2);
  const a = points[mid - 1] ?? points[0]!;
  const b = points[mid] ?? points[points.length - 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
    const p = points[0]!;
    const q = points[points.length - 1]!;
    const tx = q.x - p.x;
    const ty = q.y - p.y;
    if (Math.abs(tx) < 1e-6 && Math.abs(ty) < 1e-6) return { x: 1, y: 0 };
    return { x: tx, y: ty };
  }
  return { x: dx, y: dy };
}

function segIntersectsRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: { x: number; y: number; w: number; h: number },
): boolean {
  const inside = (p: { x: number; y: number }): boolean => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  if (inside(a) || inside(b)) return true;
  const edges: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
    [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }],
    [{ x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }],
    [{ x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
    [{ x: r.x, y: r.y + r.h }, { x: r.x, y: r.y }],
  ];
  const orient = (p: { x: number; y: number }, q: { x: number; y: number }, s: { x: number; y: number }): number =>
    (q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x);
  for (const [c, d] of edges) {
    const o1 = orient(a, b, c);
    const o2 = orient(a, b, d);
    const o3 = orient(c, d, a);
    const o4 = orient(c, d, b);
    // Contact counts: a route grazing a node's halo boundary is still inside
    // the clearance it owes, and collinear overlap (orient 0) is contact, not
    // a miss. Zero-length jogs are skipped by the caller, so a degenerate
    // point-segment cannot trip this.
    if (o1 * o2 <= 0 && o3 * o4 <= 0) return true;
  }
  return false;
}

/**
 * Nodes a routed edge passes too close to.
 *
 * A segment that enters a third-party node's box — or its clearance halo
 * (`min` px on every side) — is a readability defect: the edge reads as
 * connecting to a node it merely passes over. Endpoint boxes are excluded:
 * touching the nodes it connects is the route's job. Returns the offending
 * node ids, sorted, so the caller can name them in one advisory warning.
 */
export function edgeClearanceViolations(
  points: Array<{ x: number; y: number }>,
  boxes: ReadonlyMap<string, { x: number; y: number; w: number; h: number }>,
  fromId: string,
  toId: string,
  min = CONNECTOR_CLEARANCE_MIN,
): string[] {
  const hit = new Set<string>();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    // Zero-length jogs (a straight horizontal orthogonal route has one) touch
    // nothing; measuring them would flag the endpoints' own halo.
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
    for (const [id, box] of boxes) {
      if (id === fromId || id === toId) continue;
      if (box.w <= 0 || box.h <= 0) continue;
      const halo = { x: box.x - min, y: box.y - min, w: box.w + min * 2, h: box.h + min * 2 };
      if (segIntersectsRect(a, b, halo)) hit.add(id);
    }
  }
  return [...hit].sort();
}

/**
 * Half-pixel shrink applied when a route segment is tested against a node box.
 *
 * A segment exactly along a box edge — the jog down the side of the box the
 * connector itself exits, or a midline grazing a neighbour — touches the box's
 * boundary, and the boundary is also where endpoints live. Counting exact
 * contact would flag every orthogonal route that clips its own endpoint boxes,
 * so a segment has to be *inside* by this much (or cross a face) to count as
 * passing through. Full-halo proximity (within `CONNECTOR_CLEARANCE_MIN`) stays
 * the advisory check; crossing the box itself is the harder, rarer defect.
 */
export const ROUTE_BOX_EPSILON = 0.5;

export interface RouteBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which third-party node boxes a route *passes through*.
 *
 * This is the hard sibling of `edgeClearanceViolations`: a segment entering a
 * node's box — not merely its clearance halo — reads as connecting to a node it
 * was never wired to, so it is a route defect rather than a spacing judgement.
 * Endpoint boxes are excluded (touching the nodes it connects is the route's
 * job) as are zero-size boxes. Returns ids sorted, deterministic input out.
 */
export function routeThroughNodes(
  points: Array<{ x: number; y: number }>,
  boxes: ReadonlyMap<string, RouteBox>,
  fromId: string,
  toId: string,
): string[] {
  const hit = new Set<string>();
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    // Zero-length jogs (a straight horizontal orthogonal route has one) touch
    // nothing; measuring them would flag the endpoint's own box.
    if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6) continue;
    for (const [id, box] of boxes) {
      if (id === fromId || id === toId) continue;
      if (box.w <= 0 || box.h <= 0) continue;
      const inner = {
        x: box.x + ROUTE_BOX_EPSILON,
        y: box.y + ROUTE_BOX_EPSILON,
        w: box.w - ROUTE_BOX_EPSILON * 2,
        h: box.h - ROUTE_BOX_EPSILON * 2,
      };
      if (segIntersectsRect(a, b, inner)) hit.add(id);
    }
  }
  return [...hit].sort();
}

/**
 * Z-shaped orthogonal route between two resolved boxes whose midline is set
 * by an explicit corridor, instead of by the displacement's dominance.
 *
 * Every reroute candidate ends up here: with the corridor on the vertical axis
 * the stair runs horizontally at `mid.y`, with it on the horizontal axis the
 * stair runs vertically at `mid.x`. The jogs stay at the endpoints' own
 * columns, so a shed route keeps terminating on the boxes it names.
 */
function corridorRoutePoints(mid: { x?: number; y?: number }, p1: { x: number; y: number }, p2: { x: number; y: number }): Array<{ x: number; y: number }> {
  if (mid.y !== undefined) {
    return [p1, { x: p1.x, y: mid.y }, { x: p2.x, y: mid.y }, p2];
  }
  const midX = mid.x ?? (p1.x + p2.x) / 2;
  return [p1, { x: midX, y: p1.y }, { x: midX, y: p2.y }, p2];
}

/**
 * Packages an explicit point list as a `ConnectorResult`, keeping the same
 * output contract as `routeConnector`: arrowheads as closed triangular
 * subpaths scaled to the stroke (only when the chord has room), a label anchor
 * at the middle segment, and an honest summary naming the route.
 */
function routeFromPoints(spec: ConnectorSpec, from: ResolvedBox, to: ResolvedBox, points: Array<{ x: number; y: number }>, note: string): ConnectorResult {
  const f = (n: number): number => Math.round(n * 100) / 100;
  const p1 = points[0]!;
  const p2 = points[points.length - 1]!;
  const parts = points.map((p, i) => `${i === 0 ? "M" : "L"} ${f(p.x)} ${f(p.y)}`);
  const weight = spec.strokeWeight ?? 1;
  const size = arrowSpace(weight) / 2;
  const chord = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  const headsFit = chord >= arrowSpace(weight) && points.length >= 2;
  if (spec.arrowEnd !== false && headsFit) {
    parts.push(arrowHead(p2, { x: p2.x - p1.x, y: p2.y - p1.y }, size));
  }
  if (spec.arrowStart === true && headsFit) {
    parts.push(arrowHead(p1, { x: p1.x - p2.x, y: p1.y - p2.y }, size));
  }
  const midIndex = Math.floor(points.length / 2);
  const labelAt = { x: f(points[midIndex]!.x), y: f(points[midIndex]!.y) };
  const headsWanted = spec.arrowEnd !== false || spec.arrowStart === true;
  const arrowNote = headsFit
    ? ""
    : ` (nodes ${Math.round(chord)}px apart, closer than the ${Math.round(size * 2)}px the arrowheads need, so it is drawn without one)`;
  return {
    path: parts.join(" "),
    points,
    ...(labelAt ? { labelAt } : {}),
    summary: `orthogonal connector ${spec.from} -> ${spec.to}${note}${arrowNote}`,
    arrowheadsOmitted: headsWanted && !headsFit,
  };
}

/** Obstacle that can block a stair candidate, in deterministic sweep order. */
interface DetourObstacle {
  id: string;
  box: RouteBox;
}

/**
 * Deterministic candidate list: how a corridor can dodge each blocking box.
 *
 * For the given axis, the midline takes: the displacement's own mid, then each
 * blocking box's band edges (+clearance outside the box), then the far edge of
 * the whole obstacle set on that side. Candidates are bounded (`MAX_STAIRS`)
 * so a crowded map stays a bounded pass, not a search; duplicates are dropped
 * and the order never depends on hash iteration.
 */
function corridorCandidates(axis: "flat" | "steep", p1: { x: number; y: number }, p2: { x: number; y: number }, obstacles: DetourObstacle[], clearance: number): Array<number> {
  const MAX_STAIRS = 24;
  const rivals = obstacles.slice(0, MAX_STAIRS);

  const mids: number[] = [];
  const push = (m: number): void => {
    const v = Math.round(m * 100) / 100;
    if (Number.isFinite(v) && !mids.some((seen) => Math.abs(seen - v) < 1e-6)) mids.push(v);
  };

  const natural = axis === "flat" ? (p1.x + p2.x) / 2 : (p1.y + p2.y) / 2;
  push(natural);
  let bandLo = Infinity;
  let bandHi = -Infinity;
  for (const rival of rivals) {
    if (axis === "flat") {
      push(rival.box.x - clearance);
      push(rival.box.x + rival.box.w + clearance);
      bandLo = Math.min(bandLo, rival.box.x);
      bandHi = Math.max(bandHi, rival.box.x + rival.box.w);
    } else {
      push(rival.box.y - clearance);
      push(rival.box.y + rival.box.h + clearance);
      bandLo = Math.min(bandLo, rival.box.y);
      bandHi = Math.max(bandHi, rival.box.y + rival.box.h);
    }
  }
  if (Number.isFinite(bandLo) && Number.isFinite(bandHi)) {
    push(bandHi + clearance);
    push(bandLo - clearance);
  }
  return mids;
}

export interface ClearanceSolution {
  /** The route to emit: the standard one when clean, else the best variant. */
  result: ConnectorResult;
  /**
   * Third-party node boxes the chosen route still passes through, sorted.
   * A non-empty list is worth a named compile violation, never silence.
   */
  through: string[];
  /** Nodes the chosen route approaches too closely (the advisory class). */
  halo: string[];
  /** True when a reroute replaced the default route. */
  detoured: boolean;
}

/**
 * Routes one connector, keeping it clear of the other nodes in its region.
 *
 * The default route is solved exactly as `routeConnector` always has, then
 * tested against the third-party boxes: first for *passing through* (a
 * segment entering a box it does not connect) and then for the advisory halo.
 * Only when the default route actually crosses a box do reroute candidates
 * run: deterministic Z-stair corridors — the displacement's own mid, corridor
 * shifts forced to each blocking box's band edge, and the far side of the
 * whole obstacle set, both axes, natural axis first. The first candidate with
 * no crossings wins; otherwise the variant with the fewest crossings (then the
 * fewest halo grazes) does, and the caller has to see the leftover in a
 * violation rather than in the layout.
 *
 * Curves keep their geometry: an author-declared bow is a shape choice, and a
 * chord measured through a bowed route can say "crossed" about a line that
 * curved around, so curves carry only the existing advisory. Everything else
 * — the default orthogonal stair, or a `straight` edge that is blocked —
 * reroutes within bounds.
 */
export function routeConnectorClearance(
  spec: ConnectorSpec,
  from: ResolvedBox | undefined,
  to: ResolvedBox | undefined,
  obstacles?: ReadonlyMap<string, RouteBox>,
  minClearance = CONNECTOR_CLEARANCE_MIN,
): ClearanceSolution | null {
  const base = routeConnector(spec, from, to);
  const boxes = obstacles ?? new Map<string, RouteBox>();
  if (!from || !to || !base) return null;

  const through = routeThroughNodes(base.points, boxes, spec.from, spec.to);
  const halo = edgeClearanceViolations(base.points, boxes, spec.from, spec.to);
  const routing = spec.routing ?? "orthogonal";

  // A curve's actual paint departs from its chord, so the chord cannot be trusted
  // as the shaped route's clearance evidence; the advisory carries curves only.
  if (routing === "curved" || through.length === 0) {
    return { result: base, through, halo, detoured: false };
  }

  // The self-mid stair IS what the old fallback retry produced, so swopping an
  // author-straight edge for it keeps the historical behaviour where there was
  // one, while the remaining candidates give that route a genuinely clearer
  // corridor instead of one fixed shift.
  const naturalAxis = Math.abs(to.x + to.w / 2 - (from.x + from.w / 2)) >= Math.abs(to.y + to.h / 2 - (from.y + from.h / 2)) ? "flat" : "steep";
  const otherAxis = naturalAxis === "flat" ? "steep" : "flat";
  const clearance = minClearance + 2;

  const rivals: DetourObstacle[] = [...boxes.entries()]
    .filter(([id, box]) => id !== spec.from && id !== spec.to && box.w > 0 && box.h > 0)
    .sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y || a[0].localeCompare(b[0]))
    .map(([id, box]) => ({ id, box }));

  const p1 = base.points[0]!;
  const p2 = base.points[base.points.length - 1]!;

  let best = { points: base.points, through, halo, score: through.length * 16 + halo.length };
  const run = (candidates: Array<number>, axis: "flat" | "steep"): void => {
    for (const mid of candidates) {
      const points = corridorRoutePoints(axis === "flat" ? { x: mid } : { y: mid }, p1, p2);
      const cThrough = routeThroughNodes(points, boxes, spec.from, spec.to);
      const cHalo = edgeClearanceViolations(points, boxes, spec.from, spec.to);
      const score = cThrough.length * 16 + cHalo.length;
      if (score < best.score) {
        best = { points, through: cThrough, halo: cHalo, score };
        if (cThrough.length === 0 && cHalo.length === 0) break;
      }
    }
  };
  run(corridorCandidates(naturalAxis, p1, p2, rivals, clearance), naturalAxis);
  run(corridorCandidates(otherAxis, p1, p2, rivals, clearance), otherAxis);

  const detoured = best.points !== base.points;
  const note = detoured
    ? through.length > 0
      ? ` (rerouted clear of ${through.map((n) => `'${n}'`).slice(0, 2).join(" and ")})`
      : ""
    : "";
  const result = routeFromPoints(spec, from, to, best.points, note);
  return { result, through: best.through, halo: best.halo, detoured };
}

/**
 * Collects the axis-aligned extent of every placed box.
 *
 * The compiler needs a lookup from node id to box to route connectors, and
 * connectors can reference content *or* regions, so this spans both.
 */
export function boxIndex(boxes: PlacedBox[]): Map<string, PlacedBox> {
  const out = new Map<string, PlacedBox>();
  for (const b of boxes) out.set(b.id, { ...b });
  return out;
}