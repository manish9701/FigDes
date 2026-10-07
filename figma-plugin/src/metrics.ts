/**
 * Fact collection for the design critic (spec §8, §25).
 *
 * The plugin gathers *measurements* only — geometry, resolved colours, text
 * properties. It makes no judgements: all rules live in the server, where they
 * are pure functions and can be unit tested without Figma.
 */
import { effectiveFill, flattenPaints, isDefaultName, primaryFill, primaryStroke, toHex } from "./resolve";
import { allPages, beginScan, getNode, scanStats } from "./cache";
import type { NodeMetrics, MetricsReport } from "../../shared/protocol";

const MAX_NODES = 1500;
const MAX_DEPTH = 12;
const TEXT_SAMPLE = 120;

export interface CollectOptions {
  /** Figma node id. Omit to review the current selection. */
  target?: string;
  maxNodes: number;
  depth: number;
  includeHidden: boolean;
}

export const DEFAULT_COLLECT: CollectOptions = { maxNodes: 2000, depth: 12, includeHidden: false };

export async function collectMetrics(opts: CollectOptions): Promise<MetricsReport> {
  beginScan();

  let roots: BaseNode[] = [];
  let scopeLabel = "selection";

  if (opts.target) {
    const node = await getNode(opts.target);
    if (!node) {
      return {
        target: opts.target,
        scope: scopeLabel,
        nodes: [],
        nodeCount: 0,
        truncated: false,
        scanBudget: opts.maxNodes,
        error: `Node not found: ${opts.target}. It may have been deleted, or it lives on a page that is not loaded.`,
        scan: scanStats(),
      };
    }
    roots = [node];
    scopeLabel = node.name;
  } else {
    roots = [...figma.currentPage.selection];
    scopeLabel = roots.length === 0 ? "selection (empty)" : `${roots.length} selected`;
  }

  if (roots.length === 0) {
    // Reviewing the page keeps the tool useful when nothing is selected, but it
    // says so explicitly rather than silently widening the scope.
    roots = [figma.currentPage];
    scopeLabel = "current page (nothing was selected)";
  }

  const nodes: NodeMetrics[] = [];
  const budget = { count: 0 };
  let truncated = false;

  for (const root of roots) {
    const result = walk(root, opts, nodes, budget);
    truncated = truncated || result;
  }

  return {
    target: opts.target ?? null,
    scope: scopeLabel,
    nodes,
    nodeCount: nodes.length,
    truncated: truncated || budget.count >= opts.maxNodes,
    // Default review budget was smaller than the default extraction budget, so
    // a page-heavy file got silently clipped and the reviewer reported on a
    // fraction of it while claiming to describe the selection.
    scanBudget: opts.maxNodes,
    scan: scanStats(),
  };
}

function walk(
  root: BaseNode,
  opts: CollectOptions,
  out: NodeMetrics[],
  budget: { count: number },
): boolean {
  const stack: Array<{ node: BaseNode; depth: number }> = [{ node: root, depth: 0 }];
  let truncated = false;

  while (stack.length > 0) {
    const entry = stack.pop()!;
    if (budget.count >= opts.maxNodes) {
      truncated = true;
      break;
    }
    if (entry.depth > opts.depth) continue;

    const { node, depth } = entry;
    budget.count += 1;

    const visible = "visible" in node ? (node as SceneNode).visible !== false : true;
    if (visible || opts.includeHidden) {
      out.push(measure(node, depth));
    }

    if ("children" in node && node.children) {
      for (let i = node.children.length - 1; i >= 0; i--) {
        stack.push({ node: node.children[i]!, depth: depth + 1 });
      }
    }
  }

  return truncated;
}

function measure(node: BaseNode, depth: number): NodeMetrics {
  const scene = node as SceneNode & {
    fills?: unknown;
    effects?: unknown;
    strokeWeight?: number | symbol;
    strokeAlign?: string;
    constraints?: { horizontal: number; vertical: number };
    opacity?: number;
  };

  const box = boxOf(scene);
  const parent = "parent" in node ? node.parent : null;

  const m: NodeMetrics = {
    id: node.id,
    parentId: parent ? parent.id : null,
    type: node.type,
    name: node.name,
    depth,
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    visible: "visible" in node ? node.visible !== false : true,
    defaultNamed: isDefaultName(node.name),
    zIndex: parent && "children" in parent ? parent.children.indexOf(node as never) : 0,
  };

  if (typeof scene.opacity === "number") m.opacity = scene.opacity;

  /* fill + resolved background */
  const fills = flattenPaints(scene.fills);
  const solid = fills.find((f) => f.kind === "solid");
  if (solid) {
    m.fill = solid.hex;
    m.fillAlpha = solid.alpha;
  } else if (fills.length > 0) {
    // Gradient or image: report the kind so rules can skip rather than guess.
    m.fillKind = fills[0]!.kind === "solid" ? "gradient" : fills[0]!.kind;
  }

  // skipSelf: a text node's own fill is its text colour, not its backdrop.
  const bg = effectiveFill(node, { skipSelf: node.type === "TEXT" });
  m.background = bg ? bg.hex : "#FFFFFF";

  const stroke = primaryStroke(node);
  if (stroke) m.stroke = { hex: stroke.hex, weight: stroke.weight };

  /* radius */
  const radius = (node as SceneNode & { cornerRadius?: number | symbol }).cornerRadius;
  if (typeof radius === "number") m.radius = radius;

  /* layout */
  if ("layoutMode" in node) {
    const f = node as FrameNode;
    // GRID exists in newer API versions and has no counterpart in our model, so
    // it is reported as NONE rather than silently treated as horizontal.
    m.layoutMode = f.layoutMode === "GRID" ? "NONE" : f.layoutMode;
    if (m.layoutMode !== "NONE") {
      m.itemSpacing = f.itemSpacing;
      m.padding = { top: f.paddingTop, right: f.paddingRight, bottom: f.paddingBottom, left: f.paddingLeft };
      m.primaryAxisSizing = f.primaryAxisSizingMode;
      m.counterAxisSizing = f.counterAxisSizingMode;
    }
  }

  /* text */
  if (node.type === "TEXT") {
    const t = node as TextNode;
    const chars = t.characters;
    m.text = {
      content: chars.length > TEXT_SAMPLE ? `${chars.slice(0, TEXT_SAMPLE)}…` : chars,
      length: chars.length,
      truncated: chars.length > TEXT_SAMPLE,
      size: typeof t.fontSize === "number" ? t.fontSize : null,
      family: typeof t.fontName === "object" ? t.fontName.family : "mixed",
      style: typeof t.fontName === "object" ? t.fontName.style : "mixed",
      color: primaryFill(node)?.hex ?? null,
      styled: Boolean(t.textStyleId),
    };
  }

  /* component info */
  if (node.type === "INSTANCE") {
    m.instanceOf = (node as InstanceNode).mainComponent?.name ?? null;
  }
  if (node.type === "COMPONENT" || node.type === "COMPONENT_SET") {
    m.componentKey = (node as ComponentNode).key ?? null;
  }

  return m;
}

function boxOf(node: SceneNode): { x: number; y: number; w: number; h: number } {
  try {
    return { x: round(node.x), y: round(node.y), w: round(node.width), h: round(node.height) };
  } catch {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
}

const round = (n: number): number => Math.round(n * 100) / 100;

/** Exposed for the server-side tests: true when the file has multiple pages. */
export async function pageCount(): Promise<number> {
  return (await allPages()).length;
}
