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
  /** Human-readable description used in the operation name. */
  summary: string;
}

/** Default arrowhead length. Scaled by stroke weight in `arrowHead`. */
const ARROW = 10;

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

  if (routing === "straight") {
    parts.push(`M ${f(p1.x)} ${f(p1.y)} L ${f(p2.x)} ${f(p2.y)}`);
    labelAt = { x: f((p1.x + p2.x) / 2), y: f((p1.y + p2.y) / 2) };
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
  }

  // Arrowheads ride along as closed subpaths so the whole connector is one node.
  const weight = spec.strokeWeight ?? 1;
  const size = Math.max(6, ARROW * Math.min(2.5, Math.max(0.75, weight)));
  const headDir = { x: p2.x - p1.x, y: p2.y - p1.y };

  if (spec.arrowEnd !== false) parts.push(arrowHead(p2, headDir, size));
  if (spec.arrowStart) parts.push(arrowHead(p1, { x: -headDir.x, y: -headDir.y }, size));

  const summary = `${routing} connector ${spec.from} -> ${spec.to}`;

  return { path: parts.join(" "), ...(labelAt ? { labelAt } : {}), summary };
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