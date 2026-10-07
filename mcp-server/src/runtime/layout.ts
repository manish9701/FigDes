/**
 * Layout engine (spec §17, §31).
 *
 * Pure functions: boxes in, boxes out. No Figma, no DOM, no mutation. That is
 * what makes the geometry testable — every arrangement below is verified against
 * hand-computed expectations rather than eyeballed in the app.
 *
 * The model never computes coordinates. It states intent ("hero fills, sidebar
 * is 240, 32px gutter") and this resolves the arithmetic.
 */
import { canvasSize, type DesignIR, type Region, type ResolvedBox, type ResolvedRegion } from "../../../shared/ir";

export type Axis = "row" | "column";

/**
 * A child's size along the stacking axis.
 *
 * `number` is a fixed size, `"fill"` shares the leftover space, and `null`
 * means "hug" — measure it. The ResolvedBox variant carries an already-measured
 * size when one is known.
 */
export type MajorSize = number | "fill" | "hug" | ResolvedBox;

export interface StackChild {
  id: string;
  grow: number;
  width: MajorSize;
  height: MajorSize;
}

export interface StackInput {
  children: StackChild[];
  axis: Axis;
  gap: number;
  available: number;
}

/**
 * Distributes leftover space along one axis.
 *
 * Fixed and hug children keep their measured size. `fill` children share what
 * is left after those. Any remaining slack is then distributed by `grow` weight,
 * which is what lets a hero area absorb spare space instead of leaving a gap.
 *
 * Total distributed always equals `available` when there is at least one `fill`
 * child, so regions tile the canvas exactly with no rounding drift.
 */
export function solveAxis(input: StackInput): number[] {
  const { children, axis, available } = input;
  if (children.length === 0) return [];

  const sizes = children.map((c) => (axis === "row" ? c.width : c.height));

  // "hug" is not measurable without content, so it counts as zero here and the
  // caller overrides it with a measured size if it has one.
  const numeric = sizes.map((s) => (typeof s === "number" ? s : 0));
  const fillIndices = sizes.map((s, i) => (s === "fill" ? i : -1)).filter((i) => i >= 0);

  const gaps = input.gap * Math.max(0, children.length - 1);
  const fixedTotal = numeric.reduce((a, b) => a + b, 0);
  const free = Math.max(0, available - fixedTotal - gaps);

  const out = numeric.slice();

  if (fillIndices.length === 0) {
    // Nothing flexible: leave any remainder unclaimed rather than inventing
    // space for a child that asked to hug its content.
    return out;
  }

  // Weighting is applied to the shared free space itself, not to leftover slack.
  // Weighting only the remainder would make every fill child equal whenever the
  // free space is fully consumed, which is precisely the case that matters for a
  // hero region next to a rail.
  //
  // The weight is `1 + grow`, never `grow`. Using the raw value means a fill child
  // with `grow: 0` gets *nothing* as soon as any sibling has grow > 0 -- the
  // region silently collapses to zero height and the layout looks like a bug with
  // no cause. The baseline of 1 keeps "share the leftover" true for every fill
  // child while still letting `grow: 2` outgrow a `grow: 0` by 3:1.
  const growWeights = fillIndices.map((i) => 1 + Math.max(0, children[i]!.grow));
  const totalGrow = growWeights.reduce((a, b) => a + b, 0);

  fillIndices.forEach((index, n) => {
    out[index] = (free * growWeights[n]!) / totalGrow;
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/* Composition strategies                                                      */
/* -------------------------------------------------------------------------- */

export type Composition =
  | "editorial"
  | "instrument"
  | "canvas"
  | "topology"
  | "table"
  | "timeline"
  | "split-view"
  | "spatial"
  | "diagram"
  | "sequence"
  | "comparison"
  | "auto";

/**
 * Resolves how regions are arranged, given their semantic roles.
 *
 * `auto` infers a strategy from the roles present, which is what stops a
 * navigation + hero + secondary layout from collapsing into the default card
 * grid the spec calls out as the failure mode (§15, §51).
 */
export function inferComposition(
  regions: Array<Pick<Region, "role" | "composition" | "width" | "grow">>,
): Composition {
  // An explicit composition counts, but only from a region that actually leads the
  // screen. Taking the *first* one lets a 56px status rail declare the whole layout
  // `instrument` while the 900px map beneath it sits in `topology` -- and then the
  // planner and the build disagree about what the screen is.
  if (regions.some((r) => r.composition !== "auto")) {
    const dominant = pickDominant(regions);
    if (dominant && dominant.composition !== "auto") return dominant.composition as Composition;
    const explicit = regions.find((r) => r.composition !== "auto");
    if (explicit) return explicit.composition as Composition;
  }

  const roles = new Set(regions.map((r) => r.role));

  if (roles.has("navigation")) {
    // A narrow vertical strip beside content is a shell, not a canvas.
    const nav = regions.find((r) => r.role === "navigation");
    if (nav && typeof nav.width === "number" && nav.width < 400) {
      if (roles.has("primary-visual") || roles.has("hero")) return "spatial";
      if (roles.has("inspector")) return "instrument";
      return "split-view";
    }
    return "instrument";
  }

  if (roles.has("primary-visual") || roles.has("hero")) return "editorial";
  if (roles.has("status-rail")) return "instrument";
  if (roles.has("inspector")) return "split-view";
  if (roles.size >= 3) return "spatial";

  // A lone generic region is the shape the spec warns about: a card grid with
  // nothing in it. "editorial" gives the content full bleed, which is the least
  // presumptuous choice for a single region.
  return "editorial";
}

/**
 * The region that leads the screen.
 *
 * Scored on role first (a hero *is* the primary object), then grow as an explicit
 * "absorb the slack" signal, then width as a proxy for area. Height is
 * unavailable here -- the shell has not been laid out yet -- so width is the best
 * signal available, and it is enough to stop a narrow rail outvoting the main
 * event.
 */
function pickDominant<T extends Pick<Region, "role" | "composition" | "width" | "grow">>(regions: T[]): T | undefined {
  if (regions.length === 0) return undefined;

  let best = regions[0]!;
  let bestScore = dominanceScore(best);
  for (const region of regions.slice(1)) {
    const score = dominanceScore(region);
    if (score > bestScore) {
      best = region;
      bestScore = score;
    }
  }
  return best;
}

function dominanceScore(region: Pick<Region, "role" | "width" | "grow">): number {
  const roleWeight =
    region.role === "primary-visual" || region.role === "hero"
      ? 1000
      : region.role === "content" || region.role === "secondary"
        ? 500
        : region.role === "inspector"
          ? 200
          : region.role === "navigation" || region.role === "header" || region.role === "status-rail" || region.role === "footer"
            ? 100
            : 0;

  return roleWeight + Math.max(0, region.grow) * 50 + (typeof region.width === "number" ? region.width / 1000 : 1);
}

export interface ShellInput {
  regions: Region[];
  canvasW: number;
  canvasH: number;
  gutter: number;
}

/**
 * Main entry point: places every region.
 *
 * Two shells cover the realistic cases. A navigation region wider than `shellSplit`
 * is treated as a full-height side rail; otherwise regions stack vertically,
 * which is what editorial and instrument layouts actually look like.
 */
export function layoutRegions(input: ShellInput): ResolvedRegion[] {
  const { regions, canvasW, canvasH, gutter } = input;
  if (regions.length === 0) return [];

  const nav = regions.find((r) => r.role === "navigation");
  const isSideRail = nav && typeof nav.width === "number" && nav.width > 0 && nav.width < Math.min(500, canvasW * 0.4);

  return isSideRail
    ? layoutSideRail(input, nav!)
    : layoutStack(input);
}

function layoutStack(input: ShellInput): ResolvedRegion[] {
  const { regions, canvasW, canvasH, gutter } = input;

  const stack = regions.map((r) => ({
    id: r.id,
    grow: r.grow,
    width: resolveMajor(r.width),
    height: resolveMajor(r.height),
  }));

  const heights = solveAxis({ children: stack, axis: "column", gap: gutter, available: canvasH });

  let y = 0;
  return regions.map((r, i) => {
    const h = heights[i] ?? 0;

    // An explicit width is honoured, left-aligned.
    //
    // The alternative -- forcing every region to the full canvas width -- makes
    // `width: 320` a lie, and it defeats `rightOf`: an inspector declared 320
    // wide would still measure 1440, so placing it beside an 800px panel would
    // land it at x=1824, off the canvas. Left rather than centred because a
    // relation is the intended way to compose columns, and centring would put a
    // gap on the left that `rightOf` then adds to.
    const w = typeof r.width === "number" ? r.width : canvasW;

    const box: ResolvedRegion = {
      ...r,
      x: 0,
      y: Math.round(y),
      w,
      h: Math.round(h),
    };
    y += h + gutter;
    return box;
  });
}

function layoutSideRail(input: ShellInput, nav: Region): ResolvedRegion[] {
  const { regions, canvasW, canvasH, gutter } = input;

  const railW = Math.round(typeof nav.width === "number" ? nav.width : gutter * 16);
  const contentX = railW + gutter;
  const contentW = canvasW - contentX;

  const others = regions.filter((r) => r.id !== nav.id);
  const stack = others.map((r) => ({
    id: r.id,
    grow: r.grow,
    width: resolveMajor(r.width),
    height: resolveMajor(r.height),
  }));

  const heights = solveAxis({ children: stack, axis: "column", gap: gutter, available: canvasH });

  let y = 0;
  const out: ResolvedRegion[] = others.map((r, i) => {
    const box: ResolvedRegion = {
      ...r,
      x: contentX,
      y: Math.round(y),
      w: contentW,
      h: Math.round(heights[i] ?? 0),
    };
    y += (heights[i] ?? 0) + gutter;
    return box;
  });

  // The rail itself is emitted first so it sits behind the content in z-order.
  out.unshift({ ...nav, x: 0, y: 0, w: railW, h: canvasH });

  return out;
}

/**
 * Normalises a region's size hint into a `MajorSize`.
 *
 * `"fill"` stays symbolic so `solveAxis` can divide the remainder; `"hug"` is
 * returned as-is because only the caller knows the measured content size.
 */
function resolveMajor(v: Region["width"] | Region["height"]): MajorSize {
  if (typeof v === "number") return v;
  return v;
}

/* -------------------------------------------------------------------------- */
/* Topological layouts                                                         */
/* -------------------------------------------------------------------------- */

export interface GraphNode {
  id: string;
  x?: number;
  y?: number;
}

export interface GraphLink {
  from: string;
  to: string;
}

/**
 * Radial placement (spec §16, §17).
 *
 * Cheaper and far more legible than a force simulation for the common case of a
 * handful of machines around a hub. Deterministic: no randomness, so the same
 * graph always renders identically.
 */
export function radial(nodes: GraphNode[], center: { x: number; y: number }, radius: number): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return out;

  const n = nodes.length;
  for (let i = 0; i < n; i++) {
    const angle = (2 * Math.PI * i) / n - Math.PI / 2;
    out.set(nodes[i]!.id, {
      x: round(center.x + radius * Math.cos(angle)),
      y: round(center.y + radius * Math.sin(angle)),
    });
  }
  return out;
}

/**
 * Force-directed layout (spec §16, §17), run to a fixed iteration count.
 *
 * Deterministic: a seeded initial ring rather than `Math.random()`, so repeated
 * renders of the same graph are identical. Bounded iterations keep it fast
 * enough to run inside a transaction.
 */
export function forceDirected(
  nodes: GraphNode[],
  links: GraphLink[],
  opts: { center: { x: number; y: number }; radius: number; iterations?: number; seedPhase?: number },
): Map<string, { x: number; y: number }> {
  const { center, radius } = opts;
  const iterations = opts.iterations ?? 200;
  const phase = opts.seedPhase ?? 0;

  const ids = nodes.map((n) => n.id);
  const pos = new Map<string, { x: number; y: number }>();

  // Seed on a ring: deterministic, and avoids the degenerate all-at-zero start
  // that makes naive implementations explode.
  const ring = radial(nodes, center, radius);
  for (const id of ids) pos.set(id, ring.get(id) ?? { x: center.x, y: center.y });

  const index = new Map(ids.map((id, i) => [id, i]));
  const adjacency = new Map<string, string[]>();
  for (const id of ids) adjacency.set(id, []);
  for (const link of links) {
    adjacency.get(link.from)?.push(link.to);
    adjacency.get(link.to)?.push(link.from);
  }

  const ideal = radius * 1.4;
  const repulsion = (ideal * ideal) / 8;
  const springLength = ideal;

  for (let step = 0; step < iterations; step++) {
    const cooling = 1 - step / iterations;
    const forces = new Map<string, { x: number; y: number }>();
    for (const id of ids) forces.set(id, { x: 0, y: 0 });

    // Repulsion between all pairs. Node counts here are small (tens), so the
    // O(n^2) term is acceptable and keeps the code obvious.
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = pos.get(ids[i]!)!;
        const b = pos.get(ids[j]!)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy);
        if (dist < 0.01) {
          // Coincident nodes: nudge using the index so it stays deterministic.
          dx = (i - j) * 0.01 + 0.01;
          dy = 0.01;
          dist = Math.hypot(dx, dy);
        }
        const force = (repulsion / (dist * dist)) * cooling;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        forces.get(ids[i]!)!.x += fx;
        forces.get(ids[i]!)!.y += fy;
        forces.get(ids[j]!)!.x -= fx;
        forces.get(ids[j]!)!.y -= fy;
      }
    }

    // Spring attraction along links.
    for (const link of links) {
      const a = pos.get(link.from);
      const b = pos.get(link.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(0.01, Math.hypot(dx, dy));
      const force = ((dist - springLength) / dist) * 0.5 * cooling;
      const fx = dx * force;
      const fy = dy * force;
      forces.get(link.from)!.x += fx;
      forces.get(link.from)!.y += fy;
      forces.get(link.to)!.x -= fx;
      forces.get(link.to)!.y -= fy;
    }

    // Weak pull to the centre keeps disconnected nodes from drifting away.
    for (const id of ids) {
      const p = pos.get(id)!;
      const f = forces.get(id)!;
      f.x += (center.x - p.x) * 0.01;
      f.y += (center.y - p.y) * 0.01;
      p.x += f.x;
      p.y += f.y;
    }
  }

  const out = new Map<string, { x: number; y: number }>();
  for (const id of ids) {
    const p = pos.get(id)!;
    out.set(id, { x: round(p.x), y: round(p.y) });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Content packing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Places content inside a region.
 *
 * Vertical flow with an optional column count. Used for text blocks and lists;
 * graphic content (topology, charts) is placed by its own algorithm.
 */
export function packContent(opts: {
  region: ResolvedBox;
  items: Array<{ id: string; height: number }>;
  gap: number;
  columns: number;
}): Map<string, ResolvedBox> {
  const { region, items, gap, columns } = opts;
  const out = new Map<string, ResolvedBox>();
  if (items.length === 0 || columns < 1) return out;

  const colW = (region.w - gap * (columns - 1)) / columns;
  const cursor = new Array(columns).fill(region.y);

  for (const item of items) {
    // First column with room, so items fill left-to-right then wrap.
    let col = cursor.findIndex((y) => y + item.height <= region.y + region.h);
    if (col === -1) col = cursor.indexOf(Math.min(...cursor));

    out.set(item.id, {
      x: round(region.x + col * (colW + gap)),
      y: round(cursor[col]),
      w: round(colW),
      h: item.height,
    });
    cursor[col] += item.height + gap;
  }

  return out;
}

/* -------------------------------------------------------------------------- */

export const round = (n: number): number => Math.round(n * 100) / 100;

/* -------------------------------------------------------------------------- */
/* Gutter                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The default gutter between regions.
 *
 * Defined once, in one module, because two places need it and they must agree:
 * the compiler (`planLayout`) and the planner. When they disagreed, the plan
 * promised geometry the build did not produce — off by a full gutter — which made
 * the plan worse than useless, since a "preview" that lies about the numbers
 * trains the reader to distrust it.
 */
export const defaultGutter = (grid: number): number => grid * 4;

/** Convenience used by the compiler. */
export function planLayout(ir: DesignIR, gutter?: number): ResolvedRegion[] {
  const g = gutter ?? defaultGutter(ir.canvas.grid);
  // The canvas cannot itself be flexible, so "fill"/"hug" there mean the default
  // desktop canvas. The compiler resolves this too; doing it in both places
  // keeps planLayout usable standalone.
  return layoutRegions({
    regions: ir.regions,
    canvasW: canvasSize(ir.canvas.width, 1440),
    canvasH: canvasSize(ir.canvas.height, 900),
    gutter: g,
  });
}