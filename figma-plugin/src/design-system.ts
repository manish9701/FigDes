/**
 * Design-system extraction (spec §6, acceptance Test 1).
 *
 * Walks the document and reports what the project already uses: colours,
 * typography, spacing, radii, shadows, components, variables, styles, layout
 * patterns and naming conventions. This is the unlock for "existing system
 * before new system" — the model cannot reuse tokens it cannot see.
 *
 * Everything is frequency-ranked and capped so the payload stays small even on
 * a large file. Truncation is always reported rather than silently applied.
 */
import {
  cornerRadiusOf,
  effectiveFill,
  flattenPaints,
  isDefaultName,
  primaryStroke,
  toHex,
} from "./resolve";
import {
  allPages,
  beginScan,
  localEffectStyles,
  localPaintStyles,
  localTextStyles,
  localVariables,
  scanStats,
} from "./cache";
import type { DesignSystemReport, Frequency } from "../../shared/protocol";

const MAX_NODES = 6000;
const MAX_DEPTH = 14;

export interface ExtractOptions {
  scope: "page" | "file";
  maxNodes: number;
  includeVariables: boolean;
  includeStyles: boolean;
  maxPages: number;
}

export const DEFAULT_EXTRACT: ExtractOptions = {
  scope: "page",
  maxNodes: 3000,
  includeVariables: true,
  includeStyles: true,
  maxPages: 8,
};

/* -------------------------------------------------------------------------- */
/* Tally helpers                                                                */
/* -------------------------------------------------------------------------- */

function bump(map: Map<string, Frequency>, key: string, sample?: string): void {
  const hit = map.get(key);
  if (hit) {
    hit.count += 1;
    if (sample && hit.samples.length < 3 && !hit.samples.includes(sample)) hit.samples.push(sample);
    return;
  }
  map.set(key, { count: 1, samples: sample ? [sample] : [] });
}

interface RankedFrequency extends Frequency {
  key: string;
}

/** Frequency-rank a tally and cap it, keeping a true total for the remainder. */
function rank(map: Map<string, Frequency>, limit: number): { items: RankedFrequency[]; total: number } {
  const all: RankedFrequency[] = [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

  return { items: all.slice(0, limit), total: all.length };
}

/**
 * Naming conventions are inferred from separators, not guessed: a prefix that
 * recurs across many distinct names ("Card/", "Nav/") is evidence of a
 * convention. One-offs are excluded so the report stays honest.
 */
function deriveConventions(names: Map<string, number>): string[] {
  const prefixCounts = new Map<string, number>();

  for (const name of names.keys()) {
    const m = name.match(/^([A-Za-z][A-Za-z ]{0,24}?)\s*[/\\|]/);
    if (!m) continue;
    const prefix = m[1]!.trim();
    prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
  }

  return [...prefixCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([p]) => `${p}/*`);
}

/* -------------------------------------------------------------------------- */
/* Extraction                                                                   */
/* -------------------------------------------------------------------------- */

export async function extractDesignSystem(opts: ExtractOptions): Promise<DesignSystemReport> {
  beginScan();

  const ctx: CollectCtx = {
    colors: new Map(),
    strokes: new Map(),
    radii: new Map(),
    typography: new Map(),
    spacing: new Map(),
    shadows: new Map(),
    layouts: new Map(),
    components: new Map(),
    hardcodedColors: [],
    unstyledText: [],
    names: new Map(),
    textNodes: 0,
    defaultNamed: 0,
  };

  let pages: readonly PageNode[] = [figma.currentPage];
  if (opts.scope === "file") {
    const loaded = await allPages();
    pages = loaded.slice(0, Math.max(1, opts.maxPages));
  }

  // One bounded pass per page: tallies and paint data are gathered together so
  // the file is traversed exactly once.
  const budget = { count: 0 };
  for (const page of pages) collectFrom(page, opts, ctx, budget);

  let variables: DesignSystemReport["variables"] = [];
  if (opts.includeVariables) {
    try {
      const vars = await localVariables();
      variables = vars.slice(0, 80).map((v) => ({
        name: v.name,
        type: v.resolvedType,
        id: v.id,
        scopes: v.scopes,
      }));

      // Map resolved colour values back to token names, so a hardcoded hex that
      // already has a token can be flagged precisely.
      const byValue = new Map<string, string>();
      for (const v of vars) {
        if (v.resolvedType !== "COLOR") continue;
        for (const raw of Object.values(v.valuesByMode)) {
          const alias = raw as { type?: string; r?: number; g?: number; b?: number };
          if (alias?.type === "VARIABLE_ALIAS") continue;
          if (typeof alias?.r !== "number") continue;
          byValue.set(toHex({ r: alias.r, g: alias.g ?? 0, b: alias.b ?? 0, a: 1 }).toUpperCase(), v.name);
        }
      }
      for (const entry of ctx.hardcodedColors) {
        const match = byValue.get(entry.hex.toUpperCase());
        if (match) entry.variable = match;
      }
    } catch {
      variables = [];
    }
  }

  let styles: DesignSystemReport["styles"] = { paint: 0, text: 0, effect: 0 };
  let styleNames: DesignSystemReport["styleNames"] = { paint: [], text: [] };
  if (opts.includeStyles) {
    try {
      const [p, t, e] = await Promise.all([localPaintStyles(), localTextStyles(), localEffectStyles()]);
      styles = { paint: p.length, text: t.length, effect: e.length };
      // Names as well as counts. The checkpoint gate needs to know whether a style
      // already exists in order to tell *creating* one from *redefining* one.
      styleNames = { paint: p.map((s) => s.name), text: t.map((s) => s.name) };
    } catch {
      /* leave zeros */
    }
  }

  // Frequency-weighted inference needs every observed value, not just the top
  // 16, because a handful of stray values can otherwise dictate the base.
  const spacingRanks = rank(ctx.spacing, 16);
  const base = inferBase([...ctx.spacing.entries()].map(([k, v]) => ({ value: Number(k), count: v.count })));
  const colorRanks = rank(ctx.colors, 24);

  return {
    fileName: figma.root.name,
    scope: opts.scope,
    pagesScanned: pages.map((p) => p.name),
    nodesScanned: budget.count,
    truncated: budget.count >= opts.maxNodes,

    colors: colorRanks.items.map((c) => ({ hex: c.key, count: c.count, sampleNames: c.samples })),
    colorsTotal: rank(ctx.colors, 0).total,

    strokes: rank(ctx.strokes, 12).items.map((c) => ({ hex: c.key, count: c.count })),
    radii: rank(ctx.radii, 12).items.map((c) => ({ value: Number(c.key), count: c.count })),
    shadows: rank(ctx.shadows, 10).items.map((c) => ({ signature: c.key, count: c.count })),

    typography: rank(ctx.typography, 20).items.map((t) => ({
      label: t.key,
      sampleNames: t.samples,
      count: t.count,
    })),

    spacing: {
      inferredBase: base,
      values: spacingRanks.items.map((v) => ({ value: Number(v.key), count: v.count })),
    },

    layoutPatterns: rank(ctx.layouts, 12).items.map((l) => ({ signature: l.key, count: l.count })),
    components: rank(ctx.components, 40).items.map((c) => ({ name: c.key, count: c.count })),

    variables,
styles,
    styleNames,

    naming: {
      defaultNamed: ctx.defaultNamed,
      conventions: deriveConventions(ctx.names),
    },

    health: {
      textNodes: ctx.textNodes,
      unstyledText: ctx.unstyledText.length,
      hardcodedColors: ctx.hardcodedColors.length,
      hardcodedWithExistingVariable: ctx.hardcodedColors.filter((c) => c.variable).length,
    },

    scan: scanStats(),
  };
}

/* -------------------------------------------------------------------------- */
/* Per-node collection                                                          */
/* -------------------------------------------------------------------------- */

interface CollectCtx {
  colors: Map<string, Frequency>;
  strokes: Map<string, Frequency>;
  radii: Map<string, Frequency>;
  typography: Map<string, Frequency>;
  spacing: Map<string, Frequency>;
  shadows: Map<string, Frequency>;
  layouts: Map<string, Frequency>;
  components: Map<string, Frequency>;
  hardcodedColors: Array<{ nodeId: string; name: string; hex: string; variable: string }>;
  unstyledText: Array<{ nodeId: string; name: string; size: number | null; family: string | null }>;
  names: Map<string, number>;
  textNodes: number;
  defaultNamed: number;
}

function collectFrom(root: BaseNode, opts: ExtractOptions, ctx: CollectCtx, budget: { count: number }): void {
  const stack: Array<{ node: BaseNode; depth: number }> = [{ node: root, depth: 0 }];

  while (stack.length > 0 && budget.count < opts.maxNodes) {
    const entry = stack.pop()!;
    if (entry.depth > MAX_DEPTH) continue;

    const { node, depth } = entry;
    budget.count += 1;

    /* naming */
    ctx.names.set(node.name, (ctx.names.get(node.name) ?? 0) + 1);
    if (isDefaultName(node.name)) ctx.defaultNamed += 1;

    const holder = node as BaseNode & { fills?: unknown; effects?: unknown; boundVariables?: unknown };

    /* colours */
    for (const paint of flattenPaints(holder.fills)) {
      if (paint.kind !== "solid") continue;
      bump(ctx.colors, paint.hex, node.name);
      if (!isBound(holder, "fills")) {
        ctx.hardcodedColors.push({ nodeId: node.id, name: node.name, hex: paint.hex, variable: "" });
      }
    }

    const stroke = primaryStroke(node);
    if (stroke) bump(ctx.strokes, `${stroke.hex} @${stroke.weight}px`);

    /* radius. 999 is Figma's magic value for "mixed", not a real radius. */
    const radius = cornerRadiusOf(node);
    if (radius !== null && radius > 0 && radius < 999) bump(ctx.radii, String(Math.round(radius)));

    /* shadows */
    if (Array.isArray(holder.effects)) {
      for (const raw of holder.effects) {
        const e = raw as {
          type?: string;
          visible?: boolean;
          color?: { r: number; g: number; b: number };
          offset?: { x: number; y: number };
          radius?: number;
          spread?: number;
        };
        if (e.visible === false) continue;
        if (!e.type || !e.type.includes("SHADOW")) continue;
        const c = e.color ?? { r: 0, g: 0, b: 0 };
        const sig =
          `${e.type} ${toHex({ r: c.r, g: c.g, b: c.b, a: 1 })}` +
          ` off(${Math.round(e.offset?.x ?? 0)},${Math.round(e.offset?.y ?? 0)})` +
          ` blur${Math.round(e.radius ?? 0)} spread${Math.round(e.spread ?? 0)}`;
        bump(ctx.shadows, sig, node.name);
      }
    }

    /* typography */
    if (node.type === "TEXT") {
      const t = node as TextNode;
      ctx.textNodes += 1;
      const family = typeof t.fontName === "object" ? t.fontName.family : "mixed";
      const style = typeof t.fontName === "object" ? t.fontName.style : "mixed";
      const size = typeof t.fontSize === "number" ? Math.round(t.fontSize * 10) / 10 : null;
      bump(ctx.typography, `${family} ${style} @${size ?? "?"}`, node.name);
      if (!t.textStyleId) {
        ctx.unstyledText.push({ nodeId: node.id, name: node.name, size, family });
      }
    }

    /* auto layout + spacing */
    if ("layoutMode" in node) {
      const f = node as FrameNode;
      if (f.layoutMode && f.layoutMode !== "NONE") {
        const pad = `${f.paddingTop}/${f.paddingRight}/${f.paddingBottom}/${f.paddingLeft}`;
        bump(
          ctx.layouts,
          `${f.layoutMode} gap=${Math.round(f.itemSpacing)} pad=${pad}` +
            ` sizing=${f.primaryAxisSizingMode}/${f.counterAxisSizingMode}`,
        );
      }
      bump(ctx.spacing, String(Math.round(f.itemSpacing)));
      bump(ctx.spacing, String(Math.round(f.paddingTop)));
      bump(ctx.spacing, String(Math.round(f.paddingLeft)));
    }

    /* components */
    if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
      bump(ctx.components, node.name, node.type);
    } else if (node.type === "INSTANCE") {
      // Sync `.mainComponent` throws under documentAccess: dynamic-page, which
      // fails the whole inspect_design_system call. The label is best-effort,
      // so fall back to the instance name instead of going async here.
      let label = node.name;
      try {
        label = (node as InstanceNode).mainComponent?.name ?? node.name;
      } catch {
        /* dynamic-page: keep the instance name */
      }
      bump(ctx.components, label, "INSTANCE");
    }

    if ("children" in node && node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i]!, depth: depth + 1 });
      }
    }
  }
}

function isBound(holder: BaseNode & { boundVariables?: unknown }, field: string): boolean {
  const bound = holder.boundVariables as Record<string, unknown> | undefined;
  return Boolean(bound && bound[field]);
}

/* -------------------------------------------------------------------------- */
/* Spacing scale inference                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Guess the base unit of the spacing system from observed padding/gap values.
 *
 * Returns the LARGEST unit that explains the observed values, not the smallest.
 * Iterating ascending would label an 8px-grid file as a 2px grid, which then
 * makes the off-grid and off-scale rules silently never fire.
 *
 * Weighting by frequency matters too: a file with 900 values of 8 and 3 stray
 * values of 13 should still report 8. Treating each distinct value as one vote
 * would let the strays pick the base.
 *
 * Zero means no consistent base was found, and callers must make no grid claim.
 */
export function inferBase(values: Array<number | { value: number; count: number }>): number {
  const counts = new Map<number, number>();

  for (const entry of values) {
    const { value, weight } =
      typeof entry === "number"
        ? { value: entry, weight: 1 }
        : { value: entry.value, weight: Math.max(1, entry.count) };

    if (!Number.isFinite(value) || value <= 0) continue;
    const key = Math.round(value * 100) / 100;
    counts.set(key, (counts.get(key) ?? 0) + weight);
  }

  if (counts.size === 0) return 0;

  const total = [...counts.values()].reduce((a, b) => a + b, 0);

  // A "base" of 1 means "any integer is on the grid", which is not a design
  // system, it is the absence of one. Report 0 so callers make no claim rather
  // than pretending every alignment is correct.
  const plausible = new Set([2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24]);
  const candidates = [...new Set([...counts.keys(), 10, 8, 4, 2])]
    .filter((c) => plausible.has(c))
    .sort((a, b) => b - a);

  if (candidates.length === 0) return 0;

  for (const base of candidates) {
    let on = 0;
    for (const [value, weight] of counts) {
      if (Math.abs(value / base - Math.round(value / base)) < 0.02) on += weight;
    }
    if (on / total >= 0.8) return base;
  }
  return 0;
}

/** Exposed for tests: does this node's fill come from a variable? */
export function hasVariableBinding(node: BaseNode): boolean {
  const holder = node as BaseNode & { boundVariables?: Record<string, unknown> };
  return Boolean(holder.boundVariables && Object.keys(holder.boundVariables).length > 0);
}

/** Exposed for tests: composited visible background for a node. */
export function backgroundOf(node: BaseNode): string | null {
  return effectiveFill(node)?.hex ?? null;
}