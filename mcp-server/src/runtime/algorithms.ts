/**
 * Layout algorithms (spec §17).
 *
 * ## Why these are here
 *
 * The spec's list is `layout.grid()`, `layout.stack()`, `layout.pack()`,
 * `layout.distribute()`, `layout.radial()`, `layout.tree()`, `layout.forceGraph()`,
 * `layout.masonry()`, `layout.timeline()`, `layout.cluster()`. Six already exist in
 * `layout.ts` (grid via `packContent`, stack via `solveAxis`, distribute via
 * `solveAxis` weighting, radial and forceGraph above, pack via `packContent`).
 *
 * This file adds the four that were genuinely missing and that the model
 * otherwise has to approximate with hand-written coordinates: `tree`, `masonry`,
 * `timeline` and `cluster`.
 *
 * Two properties are non-negotiable for all of them:
 *
 * 1. **Deterministic.** No `Math.random()`, no time-dependent seeding. The same
 *    graph must produce the same coordinates on every run, or every render
 *    diff would report spurious movement and undo would look broken.
 * 2. **Pure.** Boxes in, boxes out. No Figma, no DOM, no mutation — which is
 *    what makes the geometry assertable in tests against hand-computed values
 *    instead of eyeballed in the app.
 *
 * Returning *centres* rather than top-left corners is deliberate: the caller
 * sizes each node, and centring is what lets a node of any size sit correctly in
 * a slot without the algorithm needing to know its size.
 */
import { round } from "./layout";

export interface AlgorithmNode {
  id: string;
  /** Explicit depth. Overrides the computed one when supplied. */
  depth?: number;
  /** Grouping key. Only `cluster` reads it. */
  group?: string;
  /** Numeric position along an axis. Only `timeline` reads it. */
  at?: number;
  /** Ordering hint for algorithms that accept sibling order. */
  order?: number;
}

export interface AlgorithmLink {
  from: string;
  to: string;
}

export interface Place {
  x: number;
  y: number;
}

export type PointMap = Map<string, Place>;

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AlgorithmOptions {
  /** The area to lay out inside. */
  bounds: Bounds;
  /** Space between siblings. */
  gap?: number;
  /** Distance between tree levels / timeline lanes. */
  levelGap?: number;
  /** Cluster / masonry column count. Auto-derived when omitted. */
  columns?: number;
  /** Timeline minimum and maximum x position. */
  domain?: { min: number; max: number };
}

/* -------------------------------------------------------------------------- */
/* tree                                                                         */
/* -------------------------------------------------------------------------- */

export interface TreeResult extends PointMap {
  /** Roots found in the input, in input order. Useful for labelling a diagram. */
  roots: string[];
  /** Deepest level reached. */
  depth: number;
}

/**
 * Tidy tree layout.
 *
 * Nodes are placed on rows by depth, then given horizontal positions by an
 * in-order walk: every leaf takes the next free column slot, and each parent
 * centres over its children. That is the standard simple tidy-tree construction
 * and it produces the property that matters visually — a parent sits above the
 * middle of its subtree, so a topology diagram reads as a hierarchy instead of a
 * ragged list.
 *
 * Cycles are tolerated rather than fatal: a node already visited becomes a leaf
 * at its current depth. Real topology data from a discovery sweep routinely
 * contains a loop, and refusing to draw it would be worse than drawing it once.
 */
export function tree(nodes: AlgorithmNode[], links: AlgorithmLink[], opts: AlgorithmOptions): TreeResult {
  const gap = opts.gap ?? 24;
  const levelGap = opts.levelGap ?? gap * 2;
  const { bounds } = opts;

  const out: PointMap = new Map();
  if (nodes.length === 0) return Object.assign(out, { roots: [], depth: 0 }) as TreeResult;

  const known = new Set(nodes.map((n) => n.id));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const n of nodes) children.set(n.id, []);
  for (const link of links) {
    // A link to an unknown id is dropped: the diagram should show the nodes it
    // was given, not invent placeholders.
    if (!known.has(link.from) || !known.has(link.to)) continue;
    if (link.from === link.to) continue;
    children.get(link.from)!.push(link.to);
    hasParent.add(link.to);
  }

  // Stable child ordering: an explicit `order` wins, otherwise input order.
  const order = new Map(nodes.map((n, i) => [n.id, n.order ?? i]));
  for (const list of children.values()) list.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const roots = nodes.filter((n) => !hasParent.has(n.id)).map((n) => n.id);
  const effectiveRoots = roots.length > 0 ? roots : [nodes[0]!.id];

  const depth = new Map<string, number>();
  const setDepth = (id: string, d: number): void => {
    if (depth.has(id)) return;
    depth.set(id, d);
    for (const child of children.get(id) ?? []) setDepth(child, d + 1);
  };
  for (const root of effectiveRoots) setDepth(root, 0);

  // Any node only reachable through a cycle gets appended to the first root's
  // forest so it still receives a row.
  let orphanDepth = 0;
  for (const n of nodes) {
    if (!depth.has(n.id)) setDepth(n.id, orphanDepth);
    const explicit = n.depth;
    if (explicit !== undefined && depth.has(n.id)) depth.set(n.id, Math.max(0, Math.round(explicit)));
  }

  // In-order walk assigning leaf columns, parents centred over their children.
  let column = 0;
  const xById = new Map<string, number>();
  /**
   * Nodes on the current recursion path.
   *
   * This is the cycle guard. `setDepth` has its own visited check, but that only
   * stops the depth pass -- without this one, a link pair `a -> b -> a` sends the
   * column walk into infinite recursion and takes the whole transaction down.
   * Real topology data from a discovery sweep contains loops, so handling this is
   * not hypothetical.
   */
  const onPath = new Set<string>();

  const assign = (id: string): number => {
    const existing = xById.get(id);
    if (existing !== undefined) return existing;
    if (onPath.has(id)) {
      // Already being placed further up this walk: treat it as a leaf and read
      // the current column *without* consuming one, so a loop does not leave a
      // phantom gap in the layout.
      return column;
    }

    onPath.add(id);
    const kids = (children.get(id) ?? []).filter((child) => !xById.has(child));
    let x: number;
    if (kids.length === 0) {
      x = column;
      column += 1;
    } else {
      const xs = kids.map(assign);
      x = (Math.min(...xs) + Math.max(...xs)) / 2;
    }
    onPath.delete(id);
    xById.set(id, x);
    return x;
  };
  for (const root of effectiveRoots) assign(root);

  // Depth is resolved in its own pass. Computing it inside the placement loop
  // would make each node's origin depend on how many shallower nodes happened to
  // be processed first, so the same tree would render differently depending on
  // input order.
  let maxDepth = 0;
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (d > maxDepth) maxDepth = d;
  }

  const widest = Math.max(...[...xById.values()], 0);
  const rowHeight = levelGap;

  // Centre the whole forest inside the bounds rather than letting it overflow
  // to the right, which is what a naive `column * gap` does.
  const span = (widest + 1) * gap;
  const originX = bounds.x + Math.max(0, (bounds.w - span) / 2);
  const originY = bounds.y + Math.max(0, (bounds.h - (maxDepth + 1) * rowHeight) / 2);

  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const col = xById.get(n.id) ?? 0;
    out.set(n.id, { x: round(originX + col * gap), y: round(originY + d * rowHeight) });
  }

  return Object.assign(out, { roots: effectiveRoots, depth: maxDepth }) as TreeResult;
}

/* -------------------------------------------------------------------------- */
/* masonry                                                                      */
/* -------------------------------------------------------------------------- */

export interface MasonryItem extends AlgorithmNode {
  height: number;
}

/**
 * Masonry / Pinterest packing.
 *
 * Each item goes into whichever column currently ends highest, which is what
 * makes the bottom edge ragged in a controlled way instead of leaving a large
 * hole. Column count is derived from the available width and a target column
 * width when not given, because asking the model to pick a column count that
 * happens to divide the region evenly is exactly the kind of arithmetic it gets
 * wrong.
 */
export function masonry(items: MasonryItem[], opts: AlgorithmOptions & { targetColumnWidth?: number }): PointMap {
  const out: PointMap = new Map();
  if (items.length === 0) return out;

  const gap = opts.gap ?? 16;
  const { bounds } = opts;
  const target = opts.targetColumnWidth ?? 220;

  const columns = Math.max(1, Math.min(opts.columns ?? Math.max(1, Math.round((bounds.w + gap) / (target + gap))), items.length));

  const colWidth = (bounds.w - gap * (columns - 1)) / columns;
  const heights = new Array(columns).fill(0);

  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  for (const item of ordered) {
    let col = 0;
    for (let i = 1; i < columns; i++) {
      if (heights[i]! < heights[col]! - 0.5) col = i;
    }
    out.set(item.id, {
      x: round(bounds.x + col * (colWidth + gap)),
      y: round(bounds.y + heights[col]!),
    });
    heights[col] = heights[col]! + item.height + gap;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/* timeline                                                                     */
/* -------------------------------------------------------------------------- */

export interface TimelineItem extends AlgorithmNode {
  /** Which lane to sit in. Defaults to a single lane. */
  lane?: number;
  label?: string;
}

export interface TimelineResult extends PointMap {
  lanes: number;
  domain: { min: number; max: number };
}

/**
 * Timeline layout: time along x, lanes stacked along y.
 *
 * When no explicit `at` value is given, items are spaced evenly, which is the
 * useful default for an evenly-spaced sequence of events. When values are
 * given, the domain spans min..max and is stretched across the full width, so a
 * 1-800us latency span and a 0-1s span both use the space instead of both
 * hugging the left edge.
 *
 * Lane assignment defaults to round-robin so overlapping labels remain legible.
 */
export function timeline(items: TimelineItem[], opts: AlgorithmOptions): TimelineResult {
  const out: PointMap = new Map();
  if (items.length === 0) return Object.assign(out, { lanes: 0, domain: { min: 0, max: 0 } }) as TimelineResult;

  const gap = opts.gap ?? 24;
  const laneGap = opts.levelGap ?? gap;
  const { bounds } = opts;

  const ordered = [...items].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const valued = ordered.filter((i) => typeof i.at === "number");
  const useValues = valued.length === ordered.length && ordered.length > 1;

  let min = 0;
  let max = 1;
  if (useValues) {
    min = Math.min(...valued.map((i) => i.at as number));
    max = Math.max(...valued.map((i) => i.at as number));
    if (max - min < 1e-9) max = min + 1;
  }

  const laneCount = Math.max(1, ...ordered.map((i, idx) => (i.lane ?? idx % 2) + 1));

  for (let i = 0; i < ordered.length; i++) {
    const item = ordered[i]!;
    const lane = item.lane ?? i % 2;

    const t = useValues ? (item.at as number) : ordered.length === 1 ? 0 : i / (ordered.length - 1);
    const ratio = (t - min) / (max - min);
    const laneCount2 = laneCount;

    // Centre each lane vertically in its own band so a two-lane timeline reads
    // as two rows rather than one row with alternating heights.
    const bandHeight = bounds.h / laneCount2;
    const y = bounds.y + lane * bandHeight + bandHeight / 2;

    out.set(item.id, { x: round(bounds.x + ratio * (bounds.w - 24)), y: round(y) });
  }

  return Object.assign(out, { lanes: laneCount, domain: { min, max } }) as TimelineResult;
}

/* -------------------------------------------------------------------------- */
/* cluster                                                                      */
/* -------------------------------------------------------------------------- */

export interface ClusterItem extends AlgorithmNode {
  /** Weight used to order clusters, e.g. member count. */
  weight?: number;
}

export interface ClusterResult extends PointMap {
  /** Cluster key per node, so labels can be emitted. */
  groups: Map<string, string[]>;
  columns: number;
}

/**
 * Cluster layout (spec §17, and the `cluster` semantic in spec §42).
 *
 * Members of a group are packed into a tight block; the blocks themselves are
 * laid out on a coarse grid, ordered by weight so the heaviest group leads. This
 * is the layout that stops a machine-rack diagram from becoming a uniform grid:
 * related machines read as one object, and the objects are what the eye scans.
 *
 * Nodes with no `group` fall into a shared `"ungrouped"` bucket rather than
 * being dropped, because losing a node silently is worse than a slightly loose
 * default.
 */
export function cluster(items: ClusterItem[], opts: AlgorithmOptions): ClusterResult {
  const out: PointMap = new Map();
  const groups = new Map<string, string[]>();

  if (items.length === 0) return Object.assign(out, { groups, columns: 0 }) as ClusterResult;

  const gap = opts.gap ?? 16;
  const { bounds } = opts;

  const buckets = new Map<string, ClusterItem[]>();
  for (const item of items) {
    const key = item.group ?? "ungrouped";
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }

  const entries = [...buckets.entries()].map(([key, members]) => ({
    key,
    members,
    // Heaviest first, then alphabetical, so ordering is stable regardless of
    // input order.
    weight: members.reduce((a, m) => a + (m.weight ?? 1), 0),
  }));
  entries.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));

  // Block columns are sized from the average membership so one big group does
  // not force every other block to be full width.
  const avgMembers = Math.max(1, Math.round(items.length / entries.length));
  const targetBlockWidth = Math.max(120, avgMembers * (gap * 4) + gap);
  const columns = Math.max(1, Math.min(opts.columns ?? Math.max(1, Math.floor((bounds.w + gap) / (targetBlockWidth + gap))), entries.length));

  const blockW = (bounds.w - gap * (columns - 1)) / columns;

  entries.forEach((entry, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const originX = bounds.x + col * (blockW + gap);
    const originY = bounds.y + row * (gap * 12);

    const placed = masonry(
      entry.members.map((m) => ({ id: m.id, height: gap * 6, order: m.order })),
      { bounds: { x: originX, y: originY, w: blockW, h: bounds.h }, gap, targetColumnWidth: blockW },
    );

    for (const [id, at] of placed) out.set(id, at);
    groups.set(entry.key, entry.members.map((m) => m.id));
  });

  return Object.assign(out, { groups, columns }) as ClusterResult;
}

/* -------------------------------------------------------------------------- */

/** Chooses an algorithm from a name, defaulting to masonry-style packing. */
export function runAlgorithm(
  algorithm: string,
  nodes: AlgorithmNode[],
  links: AlgorithmLink[],
  opts: AlgorithmOptions,
): { points: PointMap; detail?: Record<string, unknown> } {
  switch (algorithm) {
    case "tree":
    case "tidyTree": {
      const r = tree(nodes, links, opts);
      return { points: r, detail: { roots: r.roots, depth: r.depth } };
    }
    case "timeline": {
      const r = timeline(nodes as TimelineItem[], opts);
      return { points: r, detail: { lanes: r.lanes, domain: r.domain } };
    }
    case "cluster": {
      const r = cluster(nodes as ClusterItem[], opts);
      return { points: r, detail: { groups: [...r.groups.keys()], columns: r.columns } };
    }
    case "masonry":
    case "pack":
    default: {
      const r = masonry(nodes as MasonryItem[], opts);
      return { points: r };
    }
  }
}