/**
 * Design-to-code export (the market's #1 hired job for a Figma MCP).
 *
 * ## Why this lives here and not in the model
 *
 * Every Figma-to-code agent does the same mechanical translation: auto-layout
 * becomes flex, fills become backgrounds, text becomes tags. Done by hand (or
 * rather by prompt), it comes out as absolutely-positioned div soup with
 * invented values, because nothing constrains the mapping. Done here, the
 * mapping is fixed, total and tested: the same frame always produces the same
 * component, and every emitted value traces to a measured node property.
 *
 * ## What it is and is not
 *
 * It emits React + Tailwind for the selected subtree: layout, type, colour,
 * radius, opacity and hierarchy. It does not invent responsive behaviour,
 * interactions or component abstractions beyond what the file declares — a
 * static export that claims to be a design system would be lying, and the
 * export says so in its header comment.
 *
 * Colours are emitted as CSS custom properties (`--color-0` etc.) alongside
 * the component, so the output is one mechanical step from real design tokens
 * instead of a hundred hardcoded hexes to hunt down later.
 */
import type { NodeMetrics } from "../../../shared/protocol";

export interface ExportOptions {
  /** Component name for the root. Defaults to the frame name, PascalCased. */
  componentName?: string;
  /** Maximum nodes converted. Deeper subtrees are cut with a comment. */
  maxNodes?: number;
}

export interface ExportResult {
  componentName: string;
  /** The .tsx source. */
  tsx: string;
  /** The :root custom-property block the tsx references. */
  css: string;
  stats: {
    nodes: number;
    truncated: boolean;
    textNodes: number;
    colors: number;
  };
  /** What the export deliberately does not cover. */
  limitations: string[];
}

interface TreeNode extends NodeMetrics {
  kids: TreeNode[];
}

/** Builds a tree from the flat parentId-linked metrics list. */
function buildTree(nodes: NodeMetrics[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const n of nodes) byId.set(n.id, { ...n, kids: [] });

  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.kids.push(node);
    else roots.push(node);
  }

  // Deterministic order: document order is z-order noise, so sort siblings by
  // position. Top-to-bottom, then left-to-right, like reading.
  const sort = (list: TreeNode[]): void => {
    list.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const n of list) sort(n.kids);
  };
  sort(roots);
  return roots;
}

const toPascal = (name: string): string => {
  const words = name.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const pascal = words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join("");
  return pascal || "ExportedFrame";
};

/** JSX-escapes text content. Layer names are untrusted input. */
function escapeJsx(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

const WEIGHTS: Array<{ match: RegExp; tw: string }> = [
  { match: /thin/i, tw: "font-thin" },
  { match: /light/i, tw: "font-light" },
  { match: /medium/i, tw: "font-medium" },
  { match: /semi\s?bold/i, tw: "font-semibold" },
  { match: /bold/i, tw: "font-bold" },
  { match: /extra\s?bold|heavy|black/i, tw: "font-extrabold" },
];

const MONO = /mono|menlo|consolas|courier|jetbrains/i;

interface Emitter {
  /** Maps a hex colour to its custom property, registering first use. */
  color: (hex: string | undefined | null, kind: "bg" | "text" | "border") => string;
  count: { nodes: number; texts: number; truncated: boolean };
  maxNodes: number;
}

function classesFor(node: TreeNode, emitter: Emitter, isRoot: boolean, absolute: boolean): string[] {
  const cls: string[] = [];

  if (node.type === "TEXT") {
    const t = node.text;
    if (t) {
      if (t.size !== null && t.size !== undefined) cls.push(`text-[${Math.round(t.size)}px]`);
      const weight = WEIGHTS.find((w) => t.style && w.match.test(t.style));
      cls.push(weight ? weight.tw : "font-normal");
      if (t.family && MONO.test(t.family)) cls.push("font-mono");
      if (t.color) cls.push(emitter.color(t.color, "text"));
    }
    if (node.opacity !== undefined && node.opacity < 1) cls.push(`opacity-[${Math.round(node.opacity * 100)}]`);
    // Text in an absolute parent needs positioning like any other child; in a
    // flex parent it flows.
    if (absolute) cls.push("absolute", `left-[${Math.round(node.x)}px]`, `top-[${Math.round(node.y)}px]`);
    return cls;
  }

  // Layout: auto-layout becomes flex, absolute stays absolute. This is the
  // mapping that decides whether the output is maintainable or div soup.
  // (Alignment is not exported: metrics carry sizing modes, not align items,
  // so anything beyond the axis would be invented.)
  if (node.layoutMode === "HORIZONTAL" || node.layoutMode === "VERTICAL") {
    cls.push("flex", node.layoutMode === "HORIZONTAL" ? "flex-row" : "flex-col");
    if (typeof node.itemSpacing === "number" && node.itemSpacing > 0) cls.push(`gap-[${Math.round(node.itemSpacing)}px]`);
    if (node.padding) {
      const p = node.padding;
      if (p.top === p.bottom && p.left === p.right && p.top === p.left) {
        if (p.top > 0) cls.push(`p-[${Math.round(p.top)}px]`);
      } else {
        if (p.top === p.bottom && p.top > 0) cls.push(`py-[${Math.round(p.top)}px]`);
        if (p.left === p.right && p.left > 0) cls.push(`px-[${Math.round(p.left)}px]`);
        if (p.top !== p.bottom || p.left !== p.right) {
          if (p.top > 0) cls.push(`pt-[${Math.round(p.top)}px]`);
          if (p.right > 0) cls.push(`pr-[${Math.round(p.right)}px]`);
          if (p.bottom > 0) cls.push(`pb-[${Math.round(p.bottom)}px]`);
          if (p.left > 0) cls.push(`pl-[${Math.round(p.left)}px]`);
        }
      }
    }
  } else if (!isRoot) {
    cls.push("absolute", `left-[${Math.round(node.x)}px]`, `top-[${Math.round(node.y)}px]`);
  } else {
    cls.push("relative");
  }

  if (!isRoot || node.layoutMode === "NONE" || !node.layoutMode) {
    if (node.w > 0) cls.push(`w-[${Math.round(node.w)}px]`);
    if (node.h > 0) cls.push(`h-[${Math.round(node.h)}px]`);
  } else if (node.w > 0 && node.h > 0) {
    cls.push(`w-[${Math.round(node.w)}px]`, `h-[${Math.round(node.h)}px]`);
  }

  if (node.fill && node.fillKind !== "image") cls.push(emitter.color(node.fill, "bg"));
  if (node.stroke) cls.push(emitter.color(node.stroke.hex, "border"), `border-[${Math.round(node.stroke.weight)}px]`, "border-solid");
  if (typeof node.radius === "number" && node.radius > 0) cls.push(`rounded-[${Math.round(node.radius)}px]`);
  if (node.opacity !== undefined && node.opacity < 1) cls.push(`opacity-[${Math.round(node.opacity * 100)}]`);

  return cls;
}

/** Chooses a tag by role: headings for large text, spans otherwise. */
function tagFor(node: TreeNode): string {
  if (node.type !== "TEXT") return "div";
  const size = node.text?.size ?? 16;
  if (size >= 28) return "h1";
  if (size >= 20) return "h2";
  if (size >= 16) return "h3";
  return "span";
}

function emit(node: TreeNode, emitter: Emitter, isRoot: boolean, depth: number, absolute: boolean): string {
  emitter.count.nodes += 1;
  if (emitter.count.nodes > emitter.maxNodes) {
    emitter.count.truncated = true;
    return "";
  }

  const indent = "  ".repeat(depth + 2);
  const cls = classesFor(node, emitter, isRoot, absolute).join(" ");

  if (node.type === "TEXT") {
    emitter.count.texts += 1;
    const content = escapeJsx(node.text?.content ?? node.name);
    return `${indent}<${tagFor(node)} className="${cls}">${content}</${tagFor(node)}>`;
  }

  const open = cls ? `<div className="${cls}">` : "<div>";
  if (node.kids.length === 0) return `${indent}${open}</div>`;

  // Children of a non-flex container are absolutely positioned.
  const kidsAbsolute = node.layoutMode !== "HORIZONTAL" && node.layoutMode !== "VERTICAL";
  const kids = node.kids.map((k) => emit(k, emitter, false, depth + 1, kidsAbsolute)).filter(Boolean).join("\n");
  return `${indent}${open}\n${kids}\n${indent}</div>`;
}

/**
 * Converts measured nodes to a React + Tailwind component.
 *
 * Pure: nodes in, source out. Deterministic, so the same frame always emits the
 * same component — regenerating after a design tweak diffs cleanly instead of
 * reshuffling every class.
 */
export function exportCode(nodes: NodeMetrics[], opts: ExportOptions = {}): ExportResult {
  const maxNodes = opts.maxNodes ?? 500;
  const roots = buildTree(nodes.filter((n) => n.visible));
  const root = roots[0];

  const colors = new Map<string, string>();
  const emitter: Emitter = {
    color: (hex, kind) => {
      if (!hex) return kind === "text" ? "text-inherit" : kind === "border" ? "border-current" : "bg-transparent";
      const key = hex.toLowerCase();
      let name = colors.get(key);
      if (!name) {
        name = `--color-${colors.size}`;
        colors.set(key, name);
      }
      const prefix = kind === "text" ? "text" : kind === "border" ? "border" : "bg";
      return `${prefix}-[var(${name})]`;
    },
    count: { nodes: 0, texts: 0, truncated: false },
    maxNodes,
  };

  const componentName = toPascal(opts.componentName ?? root?.name ?? "ExportedFrame");
  const body = root ? emit(root, emitter, true, 0, false) : "    <div />";

  const cssVars = [...colors.entries()].map(([hex, name]) => `  ${name}: ${hex};`).join("\n");
  const css = `:root {\n${cssVars}\n}`;

  const tsx = [
    `// Exported from Figma frame "${root?.name ?? "?"}" (${root ? `${Math.round(root.w)}x${Math.round(root.h)}` : "?"}).`,
    "// Static export: layout, type, colour, radius and hierarchy only.",
    "// No responsive behaviour, interactions or component abstractions claimed.",
    `export function ${componentName}() {`,
    "  return (",
    body,
    "  );",
    "}",
    "",
  ].join("\n");

  return {
    componentName,
    tsx,
    css,
    stats: {
      nodes: emitter.count.nodes,
      truncated: emitter.count.truncated,
      textNodes: emitter.count.texts,
      colors: colors.size,
    },
    limitations: [
      "Instances render inline; component boundaries are not preserved.",
      "Effects, gradients beyond flat fills and images are not emitted.",
      "Auto-layout alignment (justify/items) is not exported: metrics carry sizing, not align items.",
      "Auto-layout wrap and absolute positioning inside auto-layout are simplified.",
    ],
  };
}