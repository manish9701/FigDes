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
 * A region's grow weight, defensively read.
 *
 * `grow` has a schema default of 0, but the layout engine is also reachable
 * with a hand-built IR — `compile_ir` validates through zod, tests and internal
 * callers do not. `Math.max(0, undefined)` is `NaN`, and a single `NaN` in the
 * weight sum turns every fill child's share into `NaN`, which then surfaces much
 * later as "Compiler produced an invalid operation (height: received nan)" and
 * blames the compiler rather than the absent field.
 */
function growOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

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
 * The shortest region a canvas-fit reflow may leave behind.
 *
 * Below this a stacked region cannot hold even a heading and a line of body
 * (a 32px title line plus a 20px label plus padding), so "redistribute" would
 * be a euphemism for "crush". Regions whose declared height is smaller keep it —
 * a 40px footer bar did not ask to become a squeeze.
 */
export const MIN_STACK_REGION_H = 64;

/**
 * Pulls an overflowing stack of region heights back inside the canvas.
 *
 * ## Why this exists
 *
 * `solveAxis` hands out exactly `available` only when a `fill` child exists. An
 * all-fixed stack simply returns the declared sizes, so three fixed regions
 * totalling more than the canvas height overflowed silently — the live stress
 * case put an inspector at y=940 on a 900px canvas with nothing reporting why.
 * Overflow to the bottom edge is never a design someone asked for: regions
 * below the fold are not visible, they are lost.
 *
 * Shrinkage is water-filled: each shrinkable region gives up height in
 * proportion to how far it sits above its floor, so a 420px header contributes
 * far more than a 64px rail would (and a region already at its floor gives
 * nothing). If the floors themselves cannot fit, the overflow is returned
 * honestly — the caller's geometry check reports it rather than a layout
 * pretending it fit.
 */
export function fitStackToCanvas(args: {
  heights: number[];
  /** `true` for a region whose declared height is a number we may shrink. */
  shrinkable: boolean[];
  canvasH: number;
  gutter: number;
  /** Optional per-region floor (e.g. a content floor). Defaults to `MIN_STACK_REGION_H`. */
  mins?: number[];
}): { heights: number[]; changed: number } {
  const { heights, shrinkable, canvasH, gutter } = args;
  const out = heights.slice();
  const n = out.length;
  if (n === 0) return { heights: out, changed: 0 };

  const gaps = gutter * Math.max(0, n - 1);
  let overflow = out.reduce((a, b) => a + b, 0) + gaps - canvasH;
  if (overflow <= 1e-6) return { heights: out, changed: 0 };

  const floorOf = (i: number): number => {
    const declared = args.mins?.[i];
    // Never below 1, never above the region's own height: a floor taller than
    // the region would make it "grow" under the guise of shrinking.
    return Math.max(1, Math.min(typeof declared === "number" ? declared : MIN_STACK_REGION_H, out[i]!));
  };

  // One proportional-to-headroom pass distributes at most `cap`, and every
  // region's share is bounded by its own headroom, so no region can be pushed
  // below its floor by the pass itself. The loop only guards float residue.
  for (let pass = 0; pass < n + 1 && overflow > 1e-6; pass++) {
    const flexible = shrinkable.map((s, i) => (s && out[i]! - floorOf(i) > 1e-6 ? i : -1)).filter((i) => i >= 0);
    if (flexible.length === 0) break;
    const headroom = flexible.reduce((a, i) => a + (out[i]! - floorOf(i)), 0);
    const take = Math.min(overflow, headroom);
    for (const i of flexible) out[i] = out[i]! - take * ((out[i]! - floorOf(i)) / headroom);
    overflow -= take;
  }

  // Integer heights, then absorb any rounding residue on the largest
  // shrinkable region so the stack lands exactly on (or under) the canvas edge
  // rather than 1px past it.
  for (let i = 0; i < n; i++) out[i] = Math.max(floorOf(i), Math.round(out[i]!));
  const residual = out.reduce((a, b) => a + b, 0) + gaps - canvasH;
  if (residual > 0) {
    const donors = shrinkable.map((s, i) => (s && out[i]! - floorOf(i) >= residual ? i : -1)).filter((i) => i >= 0);
    if (donors.length > 0) {
      const donor = donors.reduce((a, i) => (out[i]! > out[a]! ? i : a), donors[0]!);
      out[donor] = out[donor]! - residual;
    }
  }

  let changed = 0;
  for (let i = 0; i < n; i++) if (Math.abs(out[i]! - heights[i]!) > 0.5) changed++;
  return { heights: out, changed };
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
  const growWeights = fillIndices.map((i) => 1 + growOf(children[i]!.grow));
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

  return roleWeight + growOf(region.grow) * 50 + (typeof region.width === "number" ? region.width / 1000 : 1);
}

export interface ShellInput {
  regions: Region[];
  canvasW: number;
  canvasH: number;
  gutter: number;
  /**
   * Decline the canvas-fit reflow (`reflow: false`) or collect how many regions
   * it moved (`reflowOut`). Both default to the reflow being on and uncounted.
   */
  reflow?: boolean;
  reflowOut?: (changed: number) => void;
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

  return isSideRail ? layoutSideRail(input, nav!) : layoutStack(input);
}

function layoutStack(input: ShellInput): ResolvedRegion[] {
  const { regions, canvasW, canvasH, gutter } = input;

  const stack = regions.map((r) => ({
    id: r.id,
    grow: r.grow,
    width: resolveMajor(r.width),
    height: resolveMajor(r.height),
  }));

  const solved = solveAxis({ children: stack, axis: "column", gap: gutter, available: canvasH });

  // Canvas-fit reflow: when no child is `fill`, `solveAxis` returns the declared
  // sizes unclamped, and a stack totalling more than the canvas overflowed
  // silently (a 420px header, a 456px stage and a 340px inspector on a 900px
  // canvas put the inspector at y=940). Shrink the fixed heights back inside.
  // `fill` and `hug` children are not shrinkable here — the leftover they were
  // given (or will claim once measured) is theirs by contract. Declined when
  // the caller says so: with relations in play the solver owns the geometry,
  // and pre-shrinking the stack would fight the placement it is about to get.
  const heights =
    input.reflow === false
      ? solved
      : (() => {
          const refit = fitStackToCanvas({
            heights: solved,
            shrinkable: stack.map((c) => typeof c.height === "number"),
            canvasH,
            gutter,
          });
          if (refit.changed > 0) input.reflowOut?.(refit.changed);
          return refit.heights;
        })();

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

  const solved = solveAxis({ children: stack, axis: "column", gap: gutter, available: canvasH });

  // Canvas-fit reflow, as in `layoutStack`: the content column stacks beside the
  // rail, and the rail cannot lend it height, so an over-tall content column
  // spilled past the bottom edge with nothing pulling it back.
  const heights =
    input.reflow === false
      ? solved
      : (() => {
          const refit = fitStackToCanvas({
            heights: solved,
            shrinkable: stack.map((c) => typeof c.height === "number"),
            canvasH,
            gutter,
          });
          if (refit.changed > 0) input.reflowOut?.(refit.changed);
          return refit.heights;
        })();

  let y = 0;
  const out: ResolvedRegion[] = others.map((r, i) => {
    const box: ResolvedRegion = {
      ...r,
      x: contentX,
      y: Math.round(y),
      // An explicit width is honoured and clamped to what is actually available.
      //
      // Forcing the full content width here contradicted `layoutStack`, which
      // honours it, so the same program behaved differently depending on whether
      // a navigation rail happened to be present. A `rightOf` relation against a
      // 860px panel then landed 584px off-canvas (issue #11: "unexpected width
      // expansion"). Clamping rather than trusting keeps an over-wide request
      // inside the canvas instead of producing another out-of-canvas region.
      w: typeof r.width === "number" ? Math.min(r.width, contentW) : contentW,
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
  let placed = 0;

  for (const item of items) {
    // Fill across, then wrap down.
    //
    // This used to take the first column with room, which is column-major: every
    // item went into column 0 until it ran out, then column 1, and so on. With 36
    // uniform cells and 6 declared columns that produced five used columns of
    // eight rows each — a 6x6 grid came out as a tall stack plus one — and the
    // declared column count was never honoured at all (issue #13, X05).
    //
    // Taking the expected column first and only then falling back keeps the
    // masonry behaviour this function also serves: an item whose expected column
    // is full moves to whichever column still has room, which is the shortest-
    // column rule under a different name.
    const expected = placed % columns;
    let col = expected;
    if (cursor[col]! + item.height > region.y + region.h) {
      let fallback = -1;
      for (let i = 0; i < columns; i++) {
        if (cursor[i]! + item.height <= region.y + region.h) {
          fallback = i;
          break;
        }
      }
      col = fallback >= 0 ? fallback : cursor.indexOf(Math.min(...cursor));
    }
    placed++;

    out.set(item.id, {
      x: round(region.x + col * (colW + gap)),
      y: round(cursor[col]!),
      w: round(colW),
      h: item.height,
    });
    cursor[col] = cursor[col]! + item.height + gap;
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

/* -------------------------------------------------------------------------- */
/* Overlap separation                                                        */
/* -------------------------------------------------------------------------- */

export interface SeparableBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Pushes overlapping boxes apart until none overlap (or passes run out).
 *
 * Layout algorithms return *centres* without knowing node sizes, so a correct
 * tree can still pile 128px tiles on 24px slots — the exact collapse seen live
 * when three device nodes landed within 8px of each other. This post-pass runs
 * on sized boxes: pairwise repulsion along the smaller overlap axis, clamped to
 * bounds, deterministic (input order, fixed pass count). Returns how many
 * pairs still overlap, so the caller can warn instead of pretending.
 */
export function separateOverlaps(
  boxes: SeparableBox[],
  bounds: { x: number; y: number; w: number; h: number },
  minGap = 8,
  maxPasses = 24,
): { moved: number; remaining: number } {
  let moved = 0;
  const EPS = 1e-6;
  const overlap = (a: SeparableBox, b: SeparableBox, gap: number): { ox: number; oy: number } => {
    const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
    const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;
    return { ox, oy };
  };
  const clampBox = (b: SeparableBox): void => {
    b.x = Math.min(Math.max(b.x, bounds.x), Math.max(bounds.x, bounds.x + bounds.w - b.w));
    b.y = Math.min(Math.max(b.y, bounds.y), Math.max(bounds.y, bounds.y + bounds.h - b.h));
  };
  for (let pass = 0; pass < maxPasses; pass++) {
    let any = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const { ox, oy } = overlap(a, b, minGap);
        if (ox <= EPS || oy <= EPS) continue;
        any = true;
        if (ox < oy) {
          const shift = ox / 2;
          if (a.x <= b.x) { a.x -= shift; b.x += shift; } else { a.x += shift; b.x -= shift; }
        } else {
          const shift = oy / 2;
          if (a.y <= b.y) { a.y -= shift; b.y += shift; } else { a.y += shift; b.y -= shift; }
        }
        clampBox(a);
        clampBox(b);
        moved++;
      }
    }
    if (!any) break;
  }
  let remaining = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      // True overlap counts with no gap demand: the loop aims for minGap, but
      // only actual intersection is a defect worth reporting.
      const { ox, oy } = overlap(boxes[i]!, boxes[j]!, 0);
      if (ox > EPS && oy > EPS) remaining++;
    }
  }
  return { moved, remaining };
}

/* -------------------------------------------------------------------------- */

/** Convenience used by the compiler. */
export function planLayout(ir: DesignIR, gutter?: number): ResolvedRegion[] {
  return planLayoutReflowed(ir, gutter).regions;
}

/**
 * `planLayout`, plus the count of regions the canvas-fit reflow moved.
 *
 * The compiler reports `reflowed` honestly: a stack the shell layout had to
 * shrink to fit is a repair the caller (and the payload stats) should see, not
 * a silent correction. `reflow` can be declined — the compiler passes false
 * when the program declares relations, because the relation solver then owns
 * the geometry and pre-shrinking the stack would fight the placement it is
 * about to be given.
 */
export function planLayoutReflowed(
  ir: DesignIR,
  gutter?: number,
  opts?: { reflow?: boolean },
): { regions: ResolvedRegion[]; reflowed: number } {
  const g = gutter ?? defaultGutter(ir.canvas.grid);
  if (opts?.reflow === false) {
    // Reflow off: solveAxis is returned to untouched so the relation solver
    // measures the geometry the declarations asked for.
    const regions = layoutRegions({
      regions: ir.regions,
      canvasW: canvasSize(ir.canvas.width, 1440),
      canvasH: canvasSize(ir.canvas.height, 900),
      gutter: g,
      reflow: false,
    });
    return { regions, reflowed: 0 };
  }
  let reflowed = 0;
  const regions = layoutRegions({
    regions: ir.regions,
    canvasW: canvasSize(ir.canvas.width, 1440),
    canvasH: canvasSize(ir.canvas.height, 900),
    gutter: g,
    reflowOut: (n) => {
      reflowed += n;
    },
  });
  return { regions, reflowed };
}