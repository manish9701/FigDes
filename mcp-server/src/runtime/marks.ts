/**
 * Logo geometry (spec §16: custom geometry for brand graphics).
 *
 * ## Why generated paths, not model-written ones
 *
 * A hexagon is six vertices on a circle. A five-point star is ten. A ring is
 * two arcs. Every one of these is trivially computable and routinely botched
 * when a model hand-writes the coordinates — one vertex off and the mark looks
 * amateur in a way no amount of surrounding polish can fix.
 *
 * So the model names the mark and its parameters, and these builders emit the
 * path data. The output goes through the same validated path pipeline as
 * everything else (`normalizePath` reframes it, `parseSvgPath` parses it), so
 * generated geometry gets no special trust.
 *
 * All builders work in absolute coordinates centred on `(cx, cy)` with radius
 * `r`. The caller owns the placement; the mark owns its own proportions.
 */

import { mirrorSegments, parseVectorSegments, segmentsBounds, segmentsToPathData, translateSegments } from "../../../shared/path";

export type LogoMark = "ring" | "orbit" | "chevron" | "hex" | "bars" | "prism" | "wave" | "grid" | "shield" | "bolt" | "lens" | "arc";

export const LOGO_MARKS: LogoMark[] = ["ring", "orbit", "chevron", "hex", "bars", "prism", "wave", "grid", "shield", "bolt", "lens", "arc"];

const f = (n: number): number => Math.round(n * 100) / 100;

/** Vertices of a regular polygon, starting at the top and going clockwise. */
export function polygonVertices(cx: number, cy: number, r: number, sides: number, rotationDeg = -90): Array<{ x: number; y: number }> {
  const n = Math.max(3, Math.min(24, Math.round(sides)));
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n; i++) {
    const angle = ((rotationDeg + (360 * i) / n) * Math.PI) / 180;
    out.push({ x: f(cx + r * Math.cos(angle)), y: f(cy + r * Math.sin(angle)) });
  }
  return out;
}

/** Serialises vertices as a closed subpath. */
export function polygonPath(cx: number, cy: number, r: number, sides: number, rotationDeg = -90): string {
  const pts = polygonVertices(cx, cy, r, sides, rotationDeg);
  return `M ${pts[0]!.x} ${pts[0]!.y} ` + pts.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ") + " Z";
}

/** A star: alternating outer and inner vertices, points defaulting to five. */
export function starPath(cx: number, cy: number, outerR: number, innerRatio = 0.382, points = 5, rotationDeg = -90): string {
  const n = Math.max(3, Math.min(24, Math.round(points)));
  const inner = Math.max(0.05, Math.min(0.95, innerRatio)) * outerR;
  const pts: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < n * 2; i++) {
    const radius = i % 2 === 0 ? outerR : inner;
    const angle = ((rotationDeg + (180 * i) / n) * Math.PI) / 180;
    pts.push({ x: f(cx + radius * Math.cos(angle)), y: f(cy + radius * Math.sin(angle)) });
  }
  return `M ${pts[0]!.x} ${pts[0]!.y} ` + pts.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ") + " Z";
}

/**
 * A full circle as two arc segments.
 *
 * A single `A` cannot draw a complete circle (start equals end is degenerate),
 * so every ring is two half-circles. `sweep=1` draws clockwise.
 */
export function circlePath(cx: number, cy: number, r: number): string {
  const left = f(cx - r);
  const right = f(cx + r);
  const mid = f(cy);
  const rr = f(r);
  return `M ${left} ${mid} A ${rr} ${rr} 0 1 1 ${right} ${mid} A ${rr} ${rr} 0 1 1 ${left} ${mid} Z`;
}

/**
 * A ring: outer circle plus inner circle as a second subpath.
 *
 * The compiler stores later subpaths as EVENODD fill regions, so the inner
 * circle cuts a hole rather than stacking a second disc on top.
 */
export function ringPath(cx: number, cy: number, outerR: number, thicknessRatio = 0.22): string {
  const thickness = Math.max(0.05, Math.min(0.45, thicknessRatio));
  return `${circlePath(cx, cy, outerR)} ${circlePath(cx, cy, outerR * (1 - thickness))}`;
}

/**
 * One deterministic geometric mark, sized to radius `r` around `(cx, cy)`.
 *
 * The set is deliberately small. A logo system with forty marks is a clip-art
 * library; eight disciplined ones on a consistent grid read as a system. Every
 * mark is drawn on the same optical grid — same outer radius, same stroke logic
 * — so marks from different screens sit together without one shouting.
 */
export function logoMarkPath(mark: LogoMark, cx: number, cy: number, r: number): string {
  switch (mark) {
    case "ring":
      return ringPath(cx, cy, r);

    case "orbit": {
      // A ring with a planet: the dot sits on the ring at 45 degrees, sized to
      // the ring's own thickness so it reads as part of the mark.
      const dotR = r * 0.22;
      const dotX = f(cx + r * Math.cos(-Math.PI / 4));
      const dotY = f(cy + r * Math.sin(-Math.PI / 4));
      return `${ringPath(cx, cy, r)} ${circlePath(dotX, dotY, dotR)}`;
    }

    case "chevron": {
      // Two chevrons, the second nested. Drawn as strokes (open subpaths), so
      // the vector needs a stroke but no fill.
      const arm = (offset: number): string =>
        `M ${f(cx - r * 0.5 + offset)} ${f(cy - r * 0.6)} L ${f(cx + r * 0.1 + offset)} ${f(cy)} L ${f(cx - r * 0.5 + offset)} ${f(cy + r * 0.6)}`;
      return `${arm(-r * 0.18)} ${arm(r * 0.22)}`;
    }

    case "hex":
      return polygonPath(cx, cy, r, 6);

    case "bars": {
      // Ascending signal bars, four of them, spaced on the grid. Widths and gaps
      // share one unit so the rhythm is even.
      const unit = (2 * r) / 7;
      const parts: string[] = [];
      for (let i = 0; i < 4; i++) {
        const h = unit * (i + 1) * 1.5;
        const x = cx - r + unit * i * 1.75;
        const y = cy + r - h;
        parts.push(`M ${f(x)} ${f(y)} L ${f(x + unit)} ${f(y)} L ${f(x + unit)} ${f(cy + r)} L ${f(x)} ${f(cy + r)} Z`);
      }
      return parts.join(" ");
    }

    case "prism": {
      // An upward triangle with its inner triangle cut out.
      const outer = polygonVertices(cx, cy, r, 3);
      const inner = polygonVertices(cx, cy, r * 0.55, 3);
      const close = (pts: Array<{ x: number; y: number }>): string =>
        `M ${pts[0]!.x} ${pts[0]!.y} ` + pts.slice(1).map((p) => `L ${p.x} ${p.y}`).join(" ") + " Z";
      return `${close(outer)} ${close(inner)}`;
    }

    case "wave": {
      // Two parallel sine-ish strokes built from quadratics.
      const wave = (dy: number, amp: number): string =>
        `M ${f(cx - r)} ${f(cy + dy)} Q ${f(cx - r / 2)} ${f(cy + dy - amp)} ${f(cx)} ${f(cy + dy)} Q ${f(cx + r / 2)} ${f(cy + dy + amp)} ${f(cx + r)} ${f(cy + dy)}`;
      return `${wave(-r * 0.25, r * 0.5)} ${wave(r * 0.25, r * 0.5)}`;
    }

    case "grid": {
      // A 3x3 dot grid with the centre dot enlarged: order with one accent.
      const parts: string[] = [];
      const step = (2 * r) / 3;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const centre = row === 1 && col === 1;
          parts.push(circlePath(f(cx - r + step * (col + 0.5)), f(cy - r + step * (row + 0.5)), centre ? r * 0.22 : r * 0.13));
        }
      }
      return parts.join(" ");
    }

    case "shield": {
      // Geometric shield with true bezier shoulders: flat top, curved sides
      // meeting at a bottom point. Curves survive via the bezier pipeline.
      const w = r * 1.1;
      const top = cy - r;
      const bottom = cy + r;
      return [
        `M ${f(cx - w / 2)} ${f(top)}`,
        `L ${f(cx + w / 2)} ${f(top)}`,
        `L ${f(cx + w / 2)} ${f(cy - r * 0.1)}`,
        `C ${f(cx + w / 2)} ${f(cy + r * 0.45)} ${f(cx + w * 0.18)} ${f(cy + r * 0.72)} ${f(cx)} ${f(bottom)}`,
        `C ${f(cx - w * 0.18)} ${f(cy + r * 0.72)} ${f(cx - w / 2)} ${f(cy + r * 0.45)} ${f(cx - w / 2)} ${f(cy - r * 0.1)}`,
        "Z",
      ].join(" ");
    }

    case "bolt": {
      // Lightning bolt with a single negative-space cut: outer silhouette plus
      // an inner counter as a second EVENODD subpath.
      const outer = [
        `M ${f(cx + r * 0.25)} ${f(cy - r)}`,
        `L ${f(cx - r * 0.45)} ${f(cy + r * 0.15)}`,
        `L ${f(cx - r * 0.02)} ${f(cy + r * 0.15)}`,
        `L ${f(cx - r * 0.25)} ${f(cy + r)}`,
        `L ${f(cx + r * 0.45)} ${f(cy - r * 0.15)}`,
        `L ${f(cx + r * 0.02)} ${f(cy - r * 0.15)}`,
        "Z",
      ].join(" ");
      return outer;
    }

    case "lens": {
      // Vesica-piscis lens: two overlapping circles drawn as bezier arcs, for
      // the classic aperture / focus / vision mark.
      const w = r * 0.62;
      return [
        `M ${f(cx)} ${f(cy - r)}`,
        `C ${f(cx + w)} ${f(cy - r * 0.55)} ${f(cx + w)} ${f(cy + r * 0.55)} ${f(cx)} ${f(cy + r)}`,
        `C ${f(cx - w)} ${f(cy + r * 0.55)} ${f(cx - w)} ${f(cy - r * 0.55)} ${f(cx)} ${f(cy - r)}`,
        "Z",
      ].join(" ");
    }

    case "arc": {
      // Open orbital arc with rounded ambition: a 270-degree swept stroke with
      // a terminal dot, for motion / signal / range marks.
      return `M ${f(cx + r)} ${f(cy)} C ${f(cx + r)} ${f(cy - r * 0.75)} ${f(cx + r * 0.4)} ${f(cy - r)} ${f(cx - r * 0.2)} ${f(cy - r * 0.97)}`;
    }
  }
}

/** Parses a mark name, defaulting to `ring` rather than failing the program. */
export function coerceLogoMark(v: unknown): LogoMark {
  return typeof v === "string" && (LOGO_MARKS as string[]).includes(v) ? (v as LogoMark) : "ring";
}

/* -------------------------------------------------------------------------- */
/* Logo construction system                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Construction-grid path for a logo of radius r.
 *
 * A bounding square, centre cross, baseline thirds and the optical circle the
 * mark is drawn against. Emitted as hairline guides the designer deletes (or
 * keeps on a hidden layer) — the "grid construction" step of a logo plan.
 * Coordinates are absolute around (cx, cy) so the caller places the grid with
 * the mark instead of guessing alignment twice.
 */
export function logoConstructionGrid(cx: number, cy: number, r: number, divisions = 4): string {
  const parts: string[] = [];
  const n = Math.max(2, Math.min(12, Math.round(divisions)));
  for (let i = 0; i <= n; i++) {
    const t = -r + (2 * r * i) / n;
    parts.push(`M ${f(cx - r)} ${f(cy + t)} L ${f(cx + r)} ${f(cy + t)}`);
    parts.push(`M ${f(cx + t)} ${f(cy - r)} L ${f(cx + t)} ${f(cy + r)}`);
  }
  parts.push(`M ${f(cx - r)} ${f(cy - r)} L ${f(cx + r)} ${f(cy - r)} L ${f(cx + r)} ${f(cy + r)} L ${f(cx - r)} ${f(cy + r)} Z`);
  return parts.join(" ");
}

/** Clearspace box: the exclusion zone around a mark, in units of r. */
export function logoClearspace(r: number, units = 0.5): { x: number; y: number; w: number; h: number } {
  const pad = r * units;
  return { x: -r - pad, y: -r - pad, w: 2 * (r + pad), h: 2 * (r + pad) };
}

/**
 * Optical vertical alignment for a mark beside cap-height text.
 *
 * Round marks overshoot the baseline and cap line by ~2% or they read small
 * next to flat-topped letters; triangular marks overshoot more. Returns the
 * dy to apply to the mark's centre.
 */
export function opticalAlignDy(kind: "round" | "flat" | "pointed", r: number): number {
  if (kind === "pointed") return r * 0.03;
  if (kind === "round") return r * 0.02;
  return 0;
}

/**
 * Negative-space cutout: appends an inner counter subpath to an outer
 * silhouette so one vector renders as a shape with a hole (EVENODD).
 */
export function withNegativeSpace(outer: string, inner: string): string {
  return `${outer} ${inner}`;
}

/**
 * Radial repetition: stamps a petal path around a centre n times.
 *
 * The workhorse for symmetrical marks, sunbursts, aperture blades and
 * radial layouts. Petals are rotated copies — computed, never hand-placed.
 */
export function radialLayout(petal: string, cx: number, cy: number, count: number): string {
  const n = Math.max(2, Math.min(24, Math.round(count)));
  const segs = parseVectorSegments(petal);
  const bounds = segmentsBounds(segs);
  const px = bounds.minX + bounds.width / 2;
  const py = bounds.minY + bounds.height / 2;
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const angle = (360 * i) / n;
    const rad = (angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const rotated = segs.map((s) => {
      if (s.cmd === "Z") return s;
      const rot = (x: number, y: number): [number, number] => {
        const dx = x - px;
        const dy = y - py;
        return [f(cx + dx * cos - dy * sin), f(cy + dx * sin + dy * cos)];
      };
      if (s.cmd === "M" || s.cmd === "L" || s.cmd === "A") {
        const [x, y] = rot(s.x, s.y);
        return { ...s, x, y };
      }
      if (s.cmd === "C") {
        const [x1, y1] = rot(s.x1, s.y1);
        const [x2, y2] = rot(s.x2, s.y2);
        const [x, y] = rot(s.x, s.y);
        return { ...s, x1, y1, x2, y2, x, y };
      }
      const [x1, y1] = rot(s.x1, s.y1);
      const [x, y] = rot(s.x, s.y);
      return { ...s, x1, y1, x, y };
    });
    parts.push(segmentsToPathData(rotated));
  }
  return parts.join(" ");
}

/**
 * Mirrored pair: the path plus its reflection across a vertical axis through
 * centre x. The "mirror geometry" step of a logo plan, computed exactly.
 */
export function mirroredPair(path: string, centerX: number): string {
  const segs = parseVectorSegments(path);
  const mirrored = mirrorSegments(segs, "vertical", centerX);
  return `${segmentsToPathData(segs)} ${segmentsToPathData(mirrored)}`;
}

/** Consistent stroke-system weights for a logo family, in grid units. */
export function logoStrokeSystem(grid: number): { hairline: number; regular: number; bold: number } {
  return { hairline: f(grid / 8), regular: f(grid / 4), bold: f(grid / 2) };
}

/**
 * Snapping helper: rounds every endpoint and handle to the construction grid.
 * Logo geometry drawn on-grid stays crisp at small sizes and reads as a
 * system rather than a sketch.
 */
export function snapToGrid(path: string, grid: number): string {
  const segs = parseVectorSegments(path);
  const snap = (v: number): number => Math.round(v / grid) * grid;
  const out = segs.map((s) => {
    if (s.cmd === "Z") return s;
    if (s.cmd === "M" || s.cmd === "L") return { ...s, x: snap(s.x), y: snap(s.y) };
    if (s.cmd === "C") {
      return { ...s, x1: snap(s.x1), y1: snap(s.y1), x2: snap(s.x2), y2: snap(s.y2), x: snap(s.x), y: snap(s.y) };
    }
    if (s.cmd === "Q") return { ...s, x1: snap(s.x1), y1: snap(s.y1), x: snap(s.x), y: snap(s.y) };
    return s;
  });
  return segmentsToPathData(out);
}

/* -------------------------------------------------------------------------- */
/* Vector plan executor                                                        */
/* -------------------------------------------------------------------------- */

export type LogoPlanStep =
  | { op: "silhouette"; mark: LogoMark; cx: number; cy: number; r: number }
  | { op: "path"; path: string }
  | { op: "cutout"; path: string }
  | { op: "mirror"; axis: "horizontal" | "vertical"; center: number }
  | { op: "translate"; dx: number; dy: number }
  | { op: "snap"; grid: number };

export interface LogoPlanResult {
  /** Final composed path data, beziers intact. */
  path: string;
  /** Cutout subpaths held separately so the caller can subtract instead. */
  cutouts: string[];
}

/**
 * Executes a vector plan step list into one composed path.
 *
 * The model reasons as "construct outer silhouette → create inner cutout →
 * mirror geometry → refine curve handles → align optically" and this executes
 * each step as pure geometry: silhouettes concatenate, cutouts append as
 * EVENODD holes, mirrors reflect across the named axis, translates shift, and
 * snaps quantise to the grid. Boolean subtraction itself happens in Figma via
 * the boolean operation — this composes the operands, it never fakes the cut.
 */
export function executeLogoPlan(steps: LogoPlanStep[]): LogoPlanResult {
  let main: string[] = [];
  const cutouts: string[] = [];
  let working: string | null = null;

  const commitWorking = (): void => {
    if (working !== null) {
      main.push(working);
      working = null;
    }
  };

  for (const step of steps) {
    switch (step.op) {
      case "silhouette":
        commitWorking();
        working = logoMarkPath(step.mark, step.cx, step.cy, step.r);
        break;
      case "path":
        commitWorking();
        working = step.path;
        break;
      case "cutout":
        commitWorking();
        cutouts.push(step.path);
        break;
      case "mirror":
        if (working !== null) {
          const segs = parseVectorSegments(working);
          working = segmentsToPathData(mirrorSegments(segs, step.axis === "horizontal" ? "horizontal" : "vertical", step.center));
        } else if (main.length > 0) {
          main = main.map((p) => segmentsToPathData(mirrorSegments(parseVectorSegments(p), step.axis === "horizontal" ? "horizontal" : "vertical", step.center)));
        }
        break;
      case "translate":
        if (working !== null) {
          working = segmentsToPathData(translateSegments(parseVectorSegments(working), step.dx, step.dy));
        } else {
          main = main.map((p) => segmentsToPathData(translateSegments(parseVectorSegments(p), step.dx, step.dy)));
        }
        break;
      case "snap":
        if (working !== null) {
          working = snapToGrid(working, step.grid);
        } else {
          main = main.map((p) => snapToGrid(p, step.grid));
        }
        break;
    }
  }
  commitWorking();

  return { path: [...main, ...cutouts].join(" "), cutouts };
}