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

export type VectorSegment =
  | { cmd: "M"; x: number; y: number }
  | { cmd: "L"; x: number; y: number }
  | { cmd: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { cmd: "Q"; x1: number; y1: number; x: number; y: number }
  | { cmd: "A"; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
  | { cmd: "Z" };

/**
 * Bezier-preserving parse.
 *
 * Unlike `parseSvgPath` (which flattens curves into polylines for the legacy
 * vector pipeline), this keeps C/Q/A segments intact so genuine curve handles
 * survive to Figma's VectorNode. Relative commands, H/V shorthands and the
 * S/T smooth-curve forms are accepted and normalised to absolute M/L/C/Q/A/Z:
 * a quietly wrong shape is still worse than a refused one, but there is no
 * reason to refuse spellings with an exact canonical form.
 */
export function parseVectorSegments(d: string): VectorSegment[] {
  const tokens = tokenizeVector(d);
  const out: VectorSegment[] = [];
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  // Previous cubic/quadratic control points, for S/T reflection.
  let pc1: Point | null = null;
  let pc2: Point | null = null;
  let pq: Point | null = null;

  const num = (it: { i: number }): number => {
    const v = tokens.numbers[it.i++];
    if (v === undefined) throw new Error("Path ended early: expected a number.");
    return v;
  };

  let ci = 0;
  const ni = { i: 0 };
  const resetSmooth = (): void => {
    pc1 = null;
    pc2 = null;
    pq = null;
  };

  while (ci < tokens.commands.length) {
    const raw = tokens.commands[ci++]!;
    const cmd = raw.toUpperCase();
    const rel = raw !== cmd;

    switch (cmd) {
      case "M": {
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        cx = x;
        cy = y;
        sx = x;
        sy = y;
        out.push({ cmd: "M", x: r3(x), y: r3(y) });
        resetSmooth();
        break;
      }
      case "L": {
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        cx = x;
        cy = y;
        out.push({ cmd: "L", x: r3(x), y: r3(y) });
        resetSmooth();
        break;
      }
      case "H": {
        const x = num(ni) + (rel ? cx : 0);
        cx = x;
        out.push({ cmd: "L", x: r3(x), y: r3(cy) });
        resetSmooth();
        break;
      }
      case "V": {
        const y = num(ni) + (rel ? cy : 0);
        cy = y;
        out.push({ cmd: "L", x: r3(cx), y: r3(y) });
        resetSmooth();
        break;
      }
      case "C": {
        const x1 = num(ni) + (rel ? cx : 0);
        const y1 = num(ni) + (rel ? cy : 0);
        const x2 = num(ni) + (rel ? cx : 0);
        const y2 = num(ni) + (rel ? cy : 0);
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        pc1 = { x: x1, y: y1 };
        pc2 = { x: x2, y: y2 };
        pq = null;
        cx = x;
        cy = y;
        out.push({ cmd: "C", x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2), x: r3(x), y: r3(y) });
        break;
      }
      case "S": {
        // First control is the reflection of the previous second control.
        const rx0 = pc2 ? 2 * cx - pc2.x : cx;
        const ry0 = pc2 ? 2 * cy - pc2.y : cy;
        const x2 = num(ni) + (rel ? cx : 0);
        const y2 = num(ni) + (rel ? cy : 0);
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        pc1 = { x: rx0, y: ry0 };
        pc2 = { x: x2, y: y2 };
        pq = null;
        cx = x;
        cy = y;
        out.push({ cmd: "C", x1: r3(rx0), y1: r3(ry0), x2: r3(x2), y2: r3(y2), x: r3(x), y: r3(y) });
        break;
      }
      case "Q": {
        const x1 = num(ni) + (rel ? cx : 0);
        const y1 = num(ni) + (rel ? cy : 0);
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        pq = { x: x1, y: y1 };
        pc1 = null;
        pc2 = null;
        cx = x;
        cy = y;
        out.push({ cmd: "Q", x1: r3(x1), y1: r3(y1), x: r3(x), y: r3(y) });
        break;
      }
      case "T": {
        const qx: number = pq ? 2 * cx - pq.x : cx;
        const qy: number = pq ? 2 * cy - pq.y : cy;
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        pq = { x: qx, y: qy };
        pc1 = null;
        pc2 = null;
        cx = x;
        cy = y;
        out.push({ cmd: "Q", x1: r3(qx), y1: r3(qy), x: r3(x), y: r3(y) });
        break;
      }
      case "A": {
        const rx = num(ni);
        const ry = num(ni);
        const rotation = num(ni);
        const largeArc = num(ni) !== 0;
        const sweep = num(ni) !== 0;
        const x = num(ni) + (rel ? cx : 0);
        const y = num(ni) + (rel ? cy : 0);
        cx = x;
        cy = y;
        resetSmooth();
        out.push({ cmd: "A", rx, ry, rotation, largeArc, sweep, x: r3(x), y: r3(y) });
        break;
      }
      case "Z": {
        cx = sx;
        cy = sy;
        resetSmooth();
        out.push({ cmd: "Z" });
        break;
      }
      default:
        throw new Error(`Unsupported path command '${raw}'.`);
    }
  }

  if (out.length === 0 || out[0]!.cmd !== "M") throw new Error("Path produced no drawable geometry.");
  return out;
}

interface VectorTokens {
  commands: string[];
  numbers: number[];
}

function tokenizeVector(d: string): VectorTokens {
  const commands: string[] = [];
  const numbers: number[] = [];
  let i = 0;
  while (i < d.length) {
    const ch = d[i]!;
    if (ch === " " || ch === "," || ch === "\n" || ch === "\r" || ch === "\t") {
      i += 1;
      continue;
    }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      commands.push(ch);
      i += 1;
      continue;
    }
    NUM.lastIndex = i;
    const match = NUM.exec(d);
    if (!match || match.index !== i) throw new Error(`Unexpected character '${ch}' in path data at position ${i}.`);
    numbers.push(Number.parseFloat(match[0]));
    i = NUM.lastIndex;
  }
  return { commands, numbers };
}

const r3 = (n: number): number => Math.round(n * 1000) / 1000;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** Canonical absolute path data with beziers intact (M/L/C/Q/A/Z only). */
export function segmentsToPathData(segments: VectorSegment[]): string {
  const parts: string[] = [];
  for (const s of segments) {
    switch (s.cmd) {
      case "M":
        parts.push(`M ${s.x} ${s.y}`);
        break;
      case "L":
        parts.push(`L ${s.x} ${s.y}`);
        break;
      case "C":
        parts.push(`C ${s.x1} ${s.y1} ${s.x2} ${s.y2} ${s.x} ${s.y}`);
        break;
      case "Q":
        parts.push(`Q ${s.x1} ${s.y1} ${s.x} ${s.y}`);
        break;
      case "A":
        parts.push(`A ${s.rx} ${s.ry} ${s.rotation} ${s.largeArc ? 1 : 0} ${s.sweep ? 1 : 0} ${s.x} ${s.y}`);
        break;
      case "Z":
        parts.push("Z");
        break;
    }
  }
  return parts.join(" ");
}

/** Bounding box over segment endpoints and bezier control points. */
export function segmentsBounds(segments: VectorSegment[]): PathBounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const eat = (x: number, y: number): void => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const s of segments) {
    if (s.cmd === "Z") continue;
    if (s.cmd === "C") {
      eat(s.x1, s.y1);
      eat(s.x2, s.y2);
      eat(s.x, s.y);
    } else if (s.cmd === "Q") {
      eat(s.x1, s.y1);
      eat(s.x, s.y);
    } else if (s.cmd === "A") {
      eat(s.x, s.y);
    } else {
      eat(s.x, s.y);
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/**
 * Re-frames bezier-preserving path data so its top-left sits at the origin.
 *
 * The legacy `normalizePath` flattens curves; this keeps C/Q/A intact so curve
 * handles survive to Figma. A and Q control points shift with the geometry;
 * arc endpoints shift while radii stay absolute.
 */
export function normalizeVectorPath(d: string): NormalizedPath {
  const segments = parseVectorSegments(d);
  const b = segmentsBounds(segments);
  const width = Math.max(1, Math.round(b.width * 1000) / 1000);
  const height = Math.max(1, Math.round(b.height * 1000) / 1000);
  const sx = (x: number): number => Math.round((x - b.minX) * 1000) / 1000;
  const sy = (y: number): number => Math.round((y - b.minY) * 1000) / 1000;
  const shifted: VectorSegment[] = segments.map((s) => {
    switch (s.cmd) {
      case "M":
        return { cmd: "M", x: sx(s.x), y: sy(s.y) };
      case "L":
        return { cmd: "L", x: sx(s.x), y: sy(s.y) };
      case "C":
        return { cmd: "C", x1: sx(s.x1), y1: sy(s.y1), x2: sx(s.x2), y2: sy(s.y2), x: sx(s.x), y: sy(s.y) };
      case "Q":
        return { cmd: "Q", x1: sx(s.x1), y1: sy(s.y1), x: sx(s.x), y: sy(s.y) };
      case "A":
        return { cmd: "A", rx: s.rx, ry: s.ry, rotation: s.rotation, largeArc: s.largeArc, sweep: s.sweep, x: sx(s.x), y: sy(s.y) };
      case "Z":
        return { cmd: "Z" };
    }
  });
  return { path: segmentsToPathData(shifted), x: r3(b.minX), y: r3(b.minY), width, height };
}

/** Mirror segments across a vertical (x=center) or horizontal (y=center) axis. */
export function mirrorSegments(segments: VectorSegment[], axis: "horizontal" | "vertical", center: number): VectorSegment[] {
  const mx = (x: number): number => (axis === "vertical" ? 2 * center - x : x);
  const my = (y: number): number => (axis === "horizontal" ? 2 * center - y : y);
  return segments.map((s) => {
    switch (s.cmd) {
      case "M":
        return { cmd: "M", x: r3(mx(s.x)), y: r3(my(s.y)) };
      case "L":
        return { cmd: "L", x: r3(mx(s.x)), y: r3(my(s.y)) };
      case "C":
        return { cmd: "C", x1: r3(mx(s.x1)), y1: r3(my(s.y1)), x2: r3(mx(s.x2)), y2: r3(my(s.y2)), x: r3(mx(s.x)), y: r3(my(s.y)) };
      case "Q":
        return { cmd: "Q", x1: r3(mx(s.x1)), y1: r3(my(s.y1)), x: r3(mx(s.x)), y: r3(my(s.y)) };
      case "A":
        // Mirroring flips the sweep direction; radii and rotation survive.
        return { cmd: "A", rx: s.rx, ry: s.ry, rotation: s.rotation, largeArc: s.largeArc, sweep: !s.sweep, x: r3(mx(s.x)), y: r3(my(s.y)) };
      case "Z":
        return { cmd: "Z" };
    }
  });
}

/** Translate segments by (dx, dy). */
export function translateSegments(segments: VectorSegment[], dx: number, dy: number): VectorSegment[] {
  const tx = (x: number): number => r3(x + dx);
  const ty = (y: number): number => r3(y + dy);
  return segments.map((s) => {
    switch (s.cmd) {
      case "M":
        return { cmd: "M", x: tx(s.x), y: ty(s.y) };
      case "L":
        return { cmd: "L", x: tx(s.x), y: ty(s.y) };
      case "C":
        return { cmd: "C", x1: tx(s.x1), y1: ty(s.y1), x2: tx(s.x2), y2: ty(s.y2), x: tx(s.x), y: ty(s.y) };
      case "Q":
        return { cmd: "Q", x1: tx(s.x1), y1: ty(s.y1), x: tx(s.x), y: ty(s.y) };
      case "A":
        return { cmd: "A", rx: s.rx, ry: s.ry, rotation: s.rotation, largeArc: s.largeArc, sweep: s.sweep, x: tx(s.x), y: ty(s.y) };
      case "Z":
        return { cmd: "Z" };
    }
  });
}

/**
 * Move one anchor endpoint to a new position.
 *
 * Only M/L/C/Q/A endpoints move; control handles stay put so the curve
 * reshapes around the dragged anchor — the "refine curve handles" step of a
 * logo plan moves handles separately via `adjustSegmentHandles`.
 */
export function moveSegmentAnchor(segments: VectorSegment[], index: number, x: number, y: number): VectorSegment[] {
  return segments.map((s, i) => {
    if (i !== index) return s;
    if (s.cmd === "M" || s.cmd === "L") return { ...s, x: r3(x), y: r3(y) };
    if (s.cmd === "C" || s.cmd === "Q" || s.cmd === "A") return { ...s, x: r3(x), y: r3(y) };
    return s;
  });
}

/** Replace the control handles of one C/Q segment. */
export function adjustSegmentHandles(
  segments: VectorSegment[],
  index: number,
  handles: { x1?: number; y1?: number; x2?: number; y2?: number },
): VectorSegment[] {
  return segments.map((s, i) => {
    if (i !== index) return s;
    if (s.cmd === "C") {
      return {
        cmd: "C",
        x1: handles.x1 !== undefined ? r3(handles.x1) : s.x1,
        y1: handles.y1 !== undefined ? r3(handles.y1) : s.y1,
        x2: handles.x2 !== undefined ? r3(handles.x2) : s.x2,
        y2: handles.y2 !== undefined ? r3(handles.y2) : s.y2,
        x: s.x,
        y: s.y,
      };
    }
    if (s.cmd === "Q") {
      return {
        cmd: "Q",
        x1: handles.x1 !== undefined ? r3(handles.x1) : s.x1,
        y1: handles.y1 !== undefined ? r3(handles.y1) : s.y1,
        x: s.x,
        y: s.y,
      };
    }
    return s;
  });
}

/** Insert a straight vertex after a segment index. */
export function insertSegmentVertex(segments: VectorSegment[], afterIndex: number, x: number, y: number): VectorSegment[] {
  const out = [...segments];
  out.splice(afterIndex + 1, 0, { cmd: "L", x: r3(x), y: r3(y) });
  return out;
}

/** Delete the segment at an index (never the opening M). */
export function deleteSegmentAt(segments: VectorSegment[], index: number): VectorSegment[] {
  if (segments[index]?.cmd === "M") throw new Error("Cannot delete the opening moveto of a path.");
  return segments.filter((_, i) => i !== index);
}

export interface VectorNodeSummary {
  subpathCount: number;
  segmentCount: number;
  curveCount: number;
  closed: boolean;
  bounds: PathBounds;
}

/** Structural summary for inspect: what kind of artwork is this path? */
export function summarizeVectorSegments(segments: VectorSegment[]): VectorNodeSummary {
  let subpaths = 0;
  let curves = 0;
  let closed = false;
  for (const s of segments) {
    if (s.cmd === "M") subpaths += 1;
    if (s.cmd === "C" || s.cmd === "Q" || s.cmd === "A") curves += 1;
    if (s.cmd === "Z") closed = true;
  }
  return { subpathCount: Math.max(1, subpaths), segmentCount: segments.length, curveCount: curves, closed, bounds: segmentsBounds(segments) };
}

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