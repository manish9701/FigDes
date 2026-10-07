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

export type LogoMark = "ring" | "orbit" | "chevron" | "hex" | "bars" | "prism" | "wave" | "grid";

export const LOGO_MARKS: LogoMark[] = ["ring", "orbit", "chevron", "hex", "bars", "prism", "wave", "grid"];

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
  }
}

/** Parses a mark name, defaulting to `ring` rather than failing the program. */
export function coerceLogoMark(v: unknown): LogoMark {
  return typeof v === "string" && (LOGO_MARKS as string[]).includes(v) ? (v as LogoMark) : "ring";
}