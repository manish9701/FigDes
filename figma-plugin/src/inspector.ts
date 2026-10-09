/**
 * Read-only serialization of Figma nodes.
 *
 * SPEC §34: never ship a whole document to the model. Everything here is
 * depth-limited and node-budgeted, and truncation is reported honestly rather
 * than silently dropped.
 */
import type { InspectedNode } from "../../shared/protocol";
import { allPages } from "./cache";

export interface InspectOptions {
  depth: number;
  includeText: boolean;
  budget: number;
}

export const DEFAULT_INSPECT: InspectOptions = { depth: 4, includeText: true, budget: 400 };

interface WalkResult {
  node: InspectedNode;
  truncated: boolean;
  remaining: number;
}

function serialize(node: SceneNode, depth: number, opts: InspectOptions, budget: number): WalkResult {
  const out: InspectedNode = {
    id: node.id,
    type: node.type,
    name: node.name,
  };

  if ("visible" in node) out.visible = node.visible;
  if ("opacity" in node && typeof node.opacity === "number") out.opacity = node.opacity;

  out.x = Math.round(node.x * 100) / 100;
  out.y = Math.round(node.y * 100) / 100;
  const size = absoluteSize(node);
  out.width = Math.round(size.w * 100) / 100;
  out.height = Math.round(size.h * 100) / 100;

  if ("layoutMode" in node && node.layoutMode && node.layoutMode !== "NONE") {
    out.layoutMode = `${node.layoutMode} gap=${Math.round((node as FrameNode).itemSpacing)}`;
  }

  if (opts.includeText && node.type === "TEXT") {
    const t = node as TextNode;
    const chars = t.characters.length > 300 ? `${t.characters.slice(0, 300)}…` : t.characters;
    out.characters = chars;
    out.fontSize = typeof t.fontSize === "number" ? t.fontSize : undefined;
    out.fontName = typeof t.fontName === "object" ? `${t.fontName.family} ${t.fontName.style}` : "mixed";
  }

  if (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION" || node.type === "STAR" || node.type === "POLYGON") {
    const v = node as VectorNode;
    try {
      const paths = v.vectorPaths ?? [];
      let curves = 0;
      for (const p of paths) {
        const d = p.data;
        for (let i = 0; i < d.length; i++) {
          const ch = d[i];
          if (ch === "C" || ch === "Q") curves += 1;
        }
      }
      (out as InspectedNode & { vector?: unknown }).vector = {
        subpathCount: paths.length,
        curveCount: curves,
        winding: paths.map((p) => p.windingRule),
        // Path data is evidence for revision, capped so a dense logo does not
        // flood the model with geometry on every inspect.
        data: paths.map((p) => (p.data.length > 1000 ? `${p.data.slice(0, 1000)}…` : p.data)),
      };
    } catch {
      /* vectorPaths can throw on unusual nodes; inspect must not fail for it */
    }
    if ("strokes" in node && Array.isArray((node as VectorNode).strokes)) {
      try {
        const strokes = (node as VectorNode).strokes;
        const weight = (node as VectorNode).strokeWeight;
        (out as InspectedNode & { vector?: Record<string, unknown> }).vector = {
          ...(((out as InspectedNode & { vector?: Record<string, unknown> }).vector ?? {}) as Record<string, unknown>),
          ...(typeof weight === "number" ? { strokeWeight: weight } : {}),
          strokeCount: strokes.length,
        };
      } catch {
        /* best-effort */
      }
    }
  }

  let left = budget - 1;

  if ("children" in node && node.children.length > 0) {
    out.childCount = node.children.length;

    if (depth <= 0) {
      out.truncated = true;
      return { node: out, truncated: true, remaining: left };
    }

    const children: InspectedNode[] = [];
    let truncated = false;

    for (const child of node.children) {
      if (left <= 0) {
        truncated = true;
        break;
      }
      const r = serialize(child, depth - 1, opts, left);
      children.push(r.node);
      left = r.remaining;
      if (r.truncated) truncated = true;
      // Hard stop so a pathological document cannot stall the main thread.
      if (left <= 0) {
        truncated = true;
        break;
      }
    }

    if (truncated && children.length < node.children.length) {
      out.childCount = node.children.length;
    }

    out.children = children;
    if (truncated) out.truncated = true;
    return { node: out, truncated, remaining: left };
  }

  return { node: out, truncated: false, remaining: left };
}

/** Width/height without triggering an exception on unusual node types. */
function absoluteSize(node: SceneNode): { w: number; h: number } {
  try {
    if ("absoluteRenderBounds" in node && node.absoluteRenderBounds) {
      const b = node.absoluteRenderBounds;
      if (b.width > 0 || b.height > 0) return { w: b.width, h: b.height };
    }
    return { w: node.width, h: node.height };
  } catch {
    return { w: 0, h: 0 };
  }
}

export function inspectNodes(nodes: readonly SceneNode[], opts: InspectOptions = DEFAULT_INSPECT): {
  selection: InspectedNode[];
  truncated: boolean;
} {
  const selection: InspectedNode[] = [];
  let truncated = false;
  let left = opts.budget;

  for (const n of nodes) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    const r = serialize(n, opts.depth, opts, left);
    selection.push(r.node);
    left = r.remaining;
    if (r.truncated) truncated = true;
  }

  return { selection, truncated };
}

/** Top-level frames on a page, with a shallow look at what is inside them. */
export function inspectTopLevelFrames(page: PageNode, opts: InspectOptions = DEFAULT_INSPECT): {
  topLevelFrames: InspectedNode[];
  truncated: boolean;
} {
  const topLevelFrames: InspectedNode[] = [];
  let truncated = false;
  let left = opts.budget;

  // Newest first: page.children appends at the end, so oldest-first order
  // truncates exactly the frames the agent just built — which then read as
  // "my build vanished" when they are sitting right there on the canvas.
  // Truncation now drops the oldest frames instead; the truncated flag (always
  // returned) says so honestly.
  const ordered = [...page.children].reverse();
  for (const child of ordered) {
    if (left <= 0) {
      truncated = true;
      break;
    }
    if (child.type === "FRAME" || child.type === "COMPONENT" || child.type === "COMPONENT_SET") {
      const r = serialize(child, Math.min(opts.depth, 2), opts, left);
      topLevelFrames.push(r.node);
      left = r.remaining;
      if (r.truncated) truncated = true;
    }
  }

  return { topLevelFrames, truncated };
}

/** Cheap node-type census for inspect_file. */
export function countByType(page: PageNode): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (node: BaseNode & { children?: readonly BaseNode[] }) => {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
    if ("children" in node && node.children) {
      for (const c of node.children) visit(c as BaseNode & { children?: readonly BaseNode[] });
    }
  };
  for (const child of page.children) visit(child);
  return counts;
}

export async function listPages(): Promise<Array<{ id: string; name: string; childCount: number }>> {
  const pages = await allPages();
  return pages.map((p) => ({ id: p.id, name: p.name, childCount: p.children.length }));
}