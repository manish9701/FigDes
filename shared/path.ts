/**
 * SVG path parsing for `createVector`.
 *
 * This is a **parser**, not an evaluator. Path data is untrusted model input, so
 * it is read into a fixed command table and nothing else is possible: no
 * `eval`, no dynamic property lookup, no execution of any kind. Only absolute
 * `M`/`L`/`H`/`V`/`C`/`Q`/`A`/`Z` are accepted; relative commands are
 * rejected with a clear error rather than silently approximated, because a
 * quietly wrong shape is worse than a refused one.
 *
 * Curved segments are flattened into polylines. Figma's VectorNode accepts
 * cubic beziers, but flattening keeps the parser small and the output
 * predictable, at the cost of a slightly higher point count on smooth curves.
 *
 * `A` (elliptical arc) deserves a note: it is supported because logos are
 * largely arcs — rings, rounded marks, circular badges — and without it every
 * curve has to be hand-approximated with cubics, which models do badly. The
 * endpoint parameterisation is converted to centre form and then to beziers by
 * the book algorithm, so an arc is never a guess.
 */

export type PathCommand = "M" | "L" | "H" | "V" | "C" | "Q" | "A" | "Z";

interface Point {
  x: number;
  y: number;
}

const NUM = /-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g;

/** Default flattening tolerance. 0.5px is well below a perceptible curve error. */
const CURVE_SEGMENTS = 12;

export interface ParsedPath {
  /** First subpath, kept separate because Figma treats it as the winding path. */
  winding: Point[];
  /** Remaining closed subpaths as fill regions. */
  regions: Point[][];
}

export function parseSvgPath(d: string): ParsedPath {
  const tokens = tokenize(d);
  const subpaths: Point[][] = [];

  let cursor: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let current: Point[] = [];
  let closed = false;

  // Commands and numbers are two parallel lists with independent positions.
  // Sharing one index between them silently skips values: after reading command 0
  // the shared index is 1, so the first `nextNum()` reads numbers[1] and drops
  // numbers[0]. Every coordinate came out shifted, which is exactly the kind of
  // quiet corruption this parser exists to make impossible.
  let ci = 0;
  let ni = 0;

  const nextNum = (): number => {
    const v = tokens.numbers[ni++];
    if (v === undefined) {
      throw new Error(`Path ended early: expected a number after '${tokens.commands[Math.max(0, ci - 1)]}'.`);
    }
    return v;
  };

  while (ci < tokens.commands.length) {
    const cmd = tokens.commands[ci++]!;

    switch (cmd) {
      case "M": {
        // An M after the first point is an implicit L, per SVG.
        if (current.length > 0) {
          subpaths.push(closed ? current : [...current, { ...start }]);
          closed = false;
        }
        cursor = { x: nextNum(), y: nextNum() };
        start = { ...cursor };
        current = [{ ...cursor }];
        break;
      }

      case "L": {
        cursor = { x: nextNum(), y: nextNum() };
        current.push({ ...cursor });
        break;
      }

      case "H": {
        cursor = { x: nextNum(), y: cursor.y };
        current.push({ ...cursor });
        break;
      }

      case "V": {
        cursor = { x: cursor.x, y: nextNum() };
        current.push({ ...cursor });
        break;
      }

      case "C": {
        const c1 = { x: nextNum(), y: nextNum() };
        const c2 = { x: nextNum(), y: nextNum() };
        const to = { x: nextNum(), y: nextNum() };
        current.push(...flattenCubic(cursor, c1, c2, to));
        cursor = to;
        break;
      }

      case "Q": {
        const c1 = { x: nextNum(), y: nextNum() };
        const to = { x: nextNum(), y: nextNum() };
        current.push(...flattenQuadratic(cursor, c1, to));
        cursor = to;
        break;
      }

      case "A": {
        const rx = nextNum();
        const ry = nextNum();
        const rotation = nextNum();
        const largeArc = nextNum() !== 0;
        const sweep = nextNum() !== 0;
        const to = { x: nextNum(), y: nextNum() };
        current.push(...flattenArc(cursor, rx, ry, rotation, largeArc, sweep, to));
        cursor = to;
        break;
      }

      case "Z": {
        if (current.length > 0) {
          current.push({ ...start });
          subpaths.push(current);
        }
        closed = true;
        cursor = { ...start };
        current = [];
        break;
      }

      default: {
        // Relative commands are refused rather than approximated.
        throw new Error(
          `Unsupported path command '${cmd}'. Use only absolute M, L, H, V, C, Q, A, Z. Relative commands are not supported.`,
        );
      }
    }
  }

  if (current.length > 0) subpaths.push(closed ? current : [...current, { ...start }]);

  const meaningful = subpaths.filter((p) => p.length >= 2);
  if (meaningful.length === 0) throw new Error("Path produced no drawable geometry.");

  return { winding: meaningful[0]!, regions: meaningful.slice(1) };
}

/* -------------------------------------------------------------------------- */
/* Tokenizer                                                                   */
/* -------------------------------------------------------------------------- */

interface Tokens {
  commands: PathCommand[];
  numbers: number[];
}

function tokenize(d: string): Tokens {
  const commands: PathCommand[] = [];
  const numbers: number[] = [];

  let i = 0;
  while (i < d.length) {
    const ch = d[i]!;

    if (ch === " " || ch === "," || ch === "\n" || ch === "\r" || ch === "\t") {
      i += 1;
      continue;
    }

    if (/[MmLlHhVvCcQqAaZz]/.test(ch)) {
      const upper = ch.toUpperCase();
      if (ch !== upper) {
        throw new Error(
          `Relative path command '${ch}' is not supported. Use the absolute form '${upper}'.`,
        );
      }
      if (!"MLHV CQAZ".includes(upper) && upper !== "Z") {
        throw new Error(`Unsupported path command '${ch}'.`);
      }
      commands.push(upper as PathCommand);
      i += 1;
      continue;
    }

    if (/[SsTt]/.test(ch)) {
      throw new Error(`Path command '${ch}' is not supported. Curves must be written as absolute C, Q or A.`);
    }

    NUM.lastIndex = i;
    const match = NUM.exec(d);
    if (!match || match.index !== i) {
      throw new Error(`Unexpected character '${ch}' in path data at position ${i}.`);
    }
    numbers.push(Number.parseFloat(match[0]));
    i = NUM.lastIndex;
  }

  return { commands, numbers };
}

/* -------------------------------------------------------------------------- */
/* Curve flattening                                                           */
/* -------------------------------------------------------------------------- */

function flattenCubic(p0: Point, c1: Point, c2: Point, p1: Point): Point[] {
  const out: Point[] = [];
  for (let s = 1; s <= CURVE_SEGMENTS; s++) {
    const t = s / CURVE_SEGMENTS;
    const mt = 1 - t;
    const a = mt * mt * mt;
    const b = 3 * mt * mt * t;
    const c = 3 * mt * t * t;
    const d = t * t * t;
    out.push({
      x: round(a * p0.x + b * c1.x + c * c2.x + d * p1.x),
      y: round(a * p0.y + b * c1.y + c * c2.y + d * p1.y),
    });
  }
  return out;
}

function flattenQuadratic(p0: Point, c: Point, p1: Point): Point[] {
  // Elevate the quadratic to a cubic so one flattener handles both.
  const c1 = { x: p0.x + (2 / 3) * (c.x - p0.x), y: p0.y + (2 / 3) * (c.y - p0.y) };
  const c2 = { x: p1.x + (2 / 3) * (c.x - p1.x), y: p1.y + (2 / 3) * (c.y - p1.y) };
  return flattenCubic(p0, c1, c2, p1);
}

/**
 * Flattens an SVG elliptical arc into a polyline.
 *
 * Endpoint-to-centre conversion per the SVG specification, then each span of at
 * most 90 degrees becomes one cubic (the standard approximation, exact enough
 * that the flattening tolerance dominates the error). A degenerate arc — zero
 * radii, or start equal to end — becomes a straight line rather than throwing,
 * because that is what the SVG spec mandates and a logo path with a zero-radius
 * corner should not fail a whole transaction.
 */
function flattenArc(
  from: Point,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  to: Point,
): Point[] {
  const rxA = Math.abs(rx);
  const ryA = Math.abs(ry);

  // Degenerate cases per spec: zero radii or coincident endpoints draw a line.
  if (rxA < 1e-9 || ryA < 1e-9 || (Math.abs(from.x - to.x) < 1e-9 && Math.abs(from.y - to.y) < 1e-9)) {
    return [{ x: to.x, y: to.y }];
  }

  const phi = ((rotationDeg % 360) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: transform to the frame where the ellipse is axis-aligned.
  const dx = (from.x - to.x) / 2;
  const dy = (from.y - to.y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Step 2: the radii must be large enough to reach. Scale up, never down.
  const lambda = (x1p * x1p) / (rxA * rxA) + (y1p * y1p) / (ryA * ryA);
  const scaleUp = lambda > 1 ? Math.sqrt(lambda) : 1;
  const rxS = rxA * scaleUp;
  const ryS = ryA * scaleUp;

  // Step 3: centre in the transformed frame.
  const num = rxS * rxS * ryS * ryS - rxS * rxS * y1p * y1p - ryS * ryS * x1p * x1p;
  const den = rxS * rxS * y1p * y1p + ryS * ryS * x1p * x1p;
  const factor = (largeArc !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / Math.max(den, 1e-12)));
  const cxp = (factor * rxS * y1p) / ryS;
  const cyp = (factor * -ryS * x1p) / rxS;

  // Step 4: centre back in the original frame.
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.max(1e-12, Math.hypot(ux, uy) * Math.hypot(vx, vy));
    const angle = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    return ux * vy - uy * vx < 0 ? -angle : angle;
  };

  const startAngle = vectorAngle(1, 0, (x1p - cxp) / rxS, (y1p - cyp) / ryS);
  let sweepAngle = vectorAngle((x1p - cxp) / rxS, (y1p - cyp) / ryS, (-x1p - cxp) / rxS, (-y1p - cyp) / ryS);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  // One cubic per 90 degrees or less keeps the approximation error far below
  // the flattening tolerance.
  const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2)));
  const out: Point[] = [];

  const onEllipse = (angle: number): Point => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
      x: cx + rxS * c * cosPhi - ryS * s * sinPhi,
      y: cy + rxS * c * sinPhi + ryS * s * cosPhi,
    };
  };
  const tangent = (angle: number): Point => {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return {
      x: -rxS * s * cosPhi - ryS * c * sinPhi,
      y: -rxS * s * sinPhi + ryS * c * cosPhi,
    };
  };

  for (let i = 0; i < segments; i++) {
    const a1 = startAngle + (sweepAngle * i) / segments;
    const a2 = startAngle + (sweepAngle * (i + 1)) / segments;
    const p1 = onEllipse(a1);
    const p2 = onEllipse(a2);
    const d1 = tangent(a1);
    const d2 = tangent(a2);
    // The classic control-point distance, exact for circles and close for
    // ellipses at these spans.
    const alpha = (4 / 3) * Math.tan((a2 - a1) / 4);
    out.push(
      ...flattenCubic(p1, { x: p1.x + alpha * d1.x, y: p1.y + alpha * d1.y }, { x: p2.x - alpha * d2.x, y: p2.y - alpha * d2.y }, p2),
    );
  }

  return out;
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

/* -------------------------------------------------------------------------- */
/* Bounding box + origin normalisation                                          */
/* -------------------------------------------------------------------------- */

/**
 * Why this exists.
 *
 * Figma's `VectorNode.vectorPaths` is expressed in the vector's *own* coordinate
 * space, with the node's `x`/`y` placing it. A path written in absolute canvas
 * coordinates therefore has to be shifted into a local frame before it is
 * assigned, or the shape lands at a multiple of its own size away from where it
 * belongs.
 *
 * Every geometry producer in the runtime (vectors, connectors, arrowheads) ends
 * up calling this so that one rule applies everywhere: *path coordinates are
 * relative to the emitted node's origin*.
 */
export interface PathBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface NormalizedPath {
  /** Path data translated so its bounding box starts at (0, 0). */
  path: string;
  /** Absolute canvas position the node should be placed at. */
  x: number;
  y: number;
  width: number;
  height: number;
}

export function pathBounds(points: Point[]): PathBounds {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** Every point in the path, across the winding subpath and all fill regions. */
export function allPoints(parsed: ParsedPath): Point[] {
  return [parsed.winding, ...parsed.regions].flat();
}

/**
 * Re-frames a path so its top-left corner sits at the origin.
 *
 * A zero-extent path (a perfectly horizontal or vertical line) is padded to one
 * pixel on the constrained axis. Figma refuses a zero-size node, and a straight
 * connector is the most likely thing in the whole system to hit this.
 */
export function normalizePath(d: string): NormalizedPath {
  const parsed = parseSvgPath(d);
  const b = pathBounds(allPoints(parsed));

  const width = Math.max(1, round(b.width));
  const height = Math.max(1, round(b.height));

  const shifted = (p: Point): Point => ({ x: round(p.x - b.minX), y: round(p.y - b.minY) });

  // Serialise in absolute form with the shift baked in. Numbers are rounded to
  // three decimals so the emitted string stays short: this data crosses the
  // WebSocket and every digit is token the model pays for later if it inspects
  // the operation list.
  const serialize = (pts: Point[], close: boolean): string => {
    const first = shifted(pts[0]!);
    let out = `M ${first.x} ${first.y}`;
    for (let i = 1; i < pts.length; i++) {
      const p = shifted(pts[i]!);
      out += ` L ${p.x} ${p.y}`;
    }
    return close ? `${out} Z` : out;
  };

  const parts = [serialize(parsed.winding, false)];
  for (const region of parsed.regions) parts.push(serialize(region, true));

  return { path: parts.join(" "), x: round(b.minX), y: round(b.minY), width, height };
}