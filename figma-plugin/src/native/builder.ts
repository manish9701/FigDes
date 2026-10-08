/**
 * FigDes Native Builder
 *
 * A small, plan-oriented layer over the real Figma Plugin API.
 *
 * Raw Plugin API execution gives the model capability, but leaves it to hand-write
 * every resize/append/font/layout ordering detail. This builder handles those
 * API footguns without choosing the visual direction for the model.
 *
 * It is intentionally NOT a template library. Composition remains model-led.
 */
type AnyNode = any;
type AnyFigma = any;

export interface BuilderOptions {
  name?: string;
  parent?: AnyNode;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fill?: string | null;
  stroke?: string | null;
  strokeWeight?: number;
  radius?: number;
  opacity?: number;
  visible?: boolean;
  rotation?: number;
  clipsContent?: boolean;
}

export interface StackOptions extends BuilderOptions {
  direction?: "HORIZONTAL" | "VERTICAL";
  gap?: number;
  padding?: number | { top?: number; right?: number; bottom?: number; left?: number };
  align?: "MIN" | "CENTER" | "MAX" | "SPACE_BETWEEN";
  crossAlign?: "MIN" | "CENTER" | "MAX" | "BASELINE";
  widthSizing?: "FIXED" | "HUG" | "FILL";
  heightSizing?: "FIXED" | "HUG" | "FILL";
}

export interface TextOptions extends BuilderOptions {
  text: string;
  family?: string;
  style?: string;
  size?: number;
  weight?: number;
  lineHeight?: number | { value: number; unit: "PIXELS" | "INTRINSIC_%"; };
  letterSpacing?: number;
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFIED";
  verticalAlign?: "TOP" | "CENTER" | "BOTTOM";
  autoResize?: "NONE" | "WIDTH_AND_HEIGHT" | "HEIGHT" | "TRUNCATE";
  width?: number;
}

function color(input: string | null | undefined): { r: number; g: number; b: number } | null {
  if (!input) return null;
  const s = input.trim().replace(/^#/, "");
  const value = s.length === 3 ? s.split("").map((c) => c + c).join("") : s.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  const n = parseInt(value, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function paint(input: string | null | undefined): any[] {
  const c = color(input);
  return c ? [{ type: "SOLID", color: c }] : [];
}

function setCommon(node: AnyNode, opts: BuilderOptions): AnyNode {
  if (opts.name !== undefined) node.name = opts.name;
  if (opts.x !== undefined) node.x = opts.x;
  if (opts.y !== undefined) node.y = opts.y;
  if (opts.width !== undefined || opts.height !== undefined) {
    const w = opts.width ?? node.width ?? 1;
    const h = opts.height ?? node.height ?? 1;
    node.resize(Math.max(1, w), Math.max(1, h));
  }
  if (opts.fill !== undefined) node.fills = paint(opts.fill);
  if (opts.stroke !== undefined) node.strokes = paint(opts.stroke);
  if (opts.strokeWeight !== undefined) node.strokeWeight = opts.strokeWeight;
  if (opts.radius !== undefined && "cornerRadius" in node) node.cornerRadius = opts.radius;
  if (opts.opacity !== undefined) node.opacity = opts.opacity;
  if (opts.visible !== undefined) node.visible = opts.visible;
  if (opts.rotation !== undefined) node.rotation = opts.rotation;
  if (opts.clipsContent !== undefined && "clipsContent" in node) node.clipsContent = opts.clipsContent;
  if (opts.parent) opts.parent.appendChild(node);
  return node;
}

function padding(node: AnyNode, value: StackOptions["padding"]): void {
  if (value === undefined) return;
  const p = typeof value === "number" ? { top: value, right: value, bottom: value, left: value } : value;
  if (p.top !== undefined) node.paddingTop = p.top;
  if (p.right !== undefined) node.paddingRight = p.right;
  if (p.bottom !== undefined) node.paddingBottom = p.bottom;
  if (p.left !== undefined) node.paddingLeft = p.left;
}

function applySizing(node: AnyNode, axis: "horizontal" | "vertical", value: string | undefined): void {
  if (!value) return;
  const prop = axis === "horizontal" ? "layoutSizingHorizontal" : "layoutSizingVertical";
  try { node[prop] = value; } catch { /* FILL/HUG is legal only in the right parent context. */ }
}

function setAutoLayout(node: AnyNode, opts: StackOptions): void {
  node.layoutMode = opts.direction ?? "VERTICAL";
  node.primaryAxisSizingMode = "FIXED";
  node.counterAxisSizingMode = "FIXED";
  if (opts.gap !== undefined) node.itemSpacing = opts.gap;
  if (opts.align !== undefined) node.primaryAxisAlignItems = opts.align;
  if (opts.crossAlign !== undefined) node.counterAxisAlignItems = opts.crossAlign;
  padding(node, opts.padding);
  applySizing(node, "horizontal", opts.widthSizing);
  applySizing(node, "vertical", opts.heightSizing);
}

function fontStyleForWeight(weight: number | undefined, fallback: string): string {
  if (weight === undefined) return fallback;
  if (weight >= 800) return "Extra Bold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "Semi Bold";
  if (weight >= 500) return "Medium";
  return "Regular";
}

function safeLineHeight(value: TextOptions["lineHeight"]): any {
  if (value === undefined) return undefined;
  return typeof value === "number" ? { unit: "PIXELS", value } : value;
}

function nodeSummary(node: AnyNode): Record<string, unknown> {
  return { id: node.id, type: node.type, name: node.name, x: node.x, y: node.y, width: node.width, height: node.height };
}

export function createFigdesBuilder(figmaApi: AnyFigma) {
  const create = (kind: string, opts: BuilderOptions = {}): AnyNode => {
    const node =
      kind === "frame" ? figmaApi.createFrame()
      : kind === "component" ? figmaApi.createComponent()
      : kind === "rect" ? figmaApi.createRectangle()
      : kind === "ellipse" ? figmaApi.createEllipse()
      : kind === "line" ? figmaApi.createLine()
      : kind === "vector" ? figmaApi.createVector()
      : (() => { throw new Error("Unknown FigDes primitive: " + kind); })();
    return setCommon(node, opts);
  };

  const frame = (opts: StackOptions = {}): AnyNode => {
    const node = create("frame", opts);
    if (opts.direction) setAutoLayout(node, opts);
    return node;
  };

  const stack = (opts: StackOptions = {}): AnyNode => {
    const node = typeof figmaApi.createAutoLayout === "function"
      ? figmaApi.createAutoLayout(opts.direction ?? "VERTICAL")
      : figmaApi.createFrame();
    setCommon(node, opts);
    setAutoLayout(node, opts);
    return node;
  };

  const text = async (opts: TextOptions): Promise<AnyNode> => {
    const family = opts.family ?? "Inter";
    const style = opts.style ?? fontStyleForWeight(opts.weight, "Regular");
    await figmaApi.loadFontAsync({ family, style });
    const node = figmaApi.createText();
    if (opts.parent) opts.parent.appendChild(node);
    node.fontName = { family, style };
    node.fontSize = opts.size ?? 16;
    if (opts.lineHeight !== undefined) node.lineHeight = safeLineHeight(opts.lineHeight);
    if (opts.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: opts.letterSpacing };
    if (opts.align !== undefined) node.textAlignHorizontal = opts.align;
    if (opts.verticalAlign !== undefined) node.textAlignVertical = opts.verticalAlign;
    if (opts.autoResize !== undefined) node.textAutoResize = opts.autoResize;
    if (opts.width !== undefined) node.resize(opts.width, Math.max(1, node.height));
    node.characters = opts.text;
    setCommon(node, { ...opts, width: undefined, height: undefined, parent: undefined });
    return node;
  };

  const rect = (opts: BuilderOptions = {}) => create("rect", opts);
  const ellipse = (opts: BuilderOptions = {}) => create("ellipse", opts);
  const line = (opts: BuilderOptions = {}) => create("line", opts);

  const vector = (pathData: string, opts: BuilderOptions = {}) => {
    const node = create("vector", opts);
    node.vectorPaths = [{ windingRule: "NONZERO", data: pathData }];
    return node;
  };

  const append = (
    parent: AnyNode,
    child: AnyNode,
    sizing?: { horizontal?: "FIXED" | "HUG" | "FILL"; vertical?: "FIXED" | "HUG" | "FILL" },
  ) => {
    parent.appendChild(child);
    if (sizing?.horizontal) applySizing(child, "horizontal", sizing.horizontal);
    if (sizing?.vertical) applySizing(child, "vertical", sizing.vertical);
    return child;
  };

  const place = (node: AnyNode, x: number, y: number) => { node.x = x; node.y = y; return node; };
  const fill = (node: AnyNode, value: string | null) => { node.fills = paint(value); return node; };
  const stroke = (node: AnyNode, value: string | null, weight = 1) => { node.strokes = paint(value); node.strokeWeight = weight; return node; };
  const radius = (node: AnyNode, value: number) => { if ("cornerRadius" in node) node.cornerRadius = value; return node; };
  const component = (opts: BuilderOptions = {}) => create("component", opts);

  const instance = async (componentId: string, opts: BuilderOptions = {}) => {
    const componentNode = await figmaApi.getNodeByIdAsync(componentId);
    if (!componentNode || componentNode.type !== "COMPONENT") {
      throw new Error("FigDes instance: " + componentId + " is not a local COMPONENT. Resolve the component first.");
    }
    return setCommon(componentNode.createInstance(), opts);
  };

  const connect = (
    from: AnyNode,
    to: AnyNode,
    opts: { stroke?: string; weight?: number; dash?: number[]; parent?: AnyNode } = {},
  ) => {
    const a = from.absoluteBoundingBox;
    const b = to.absoluteBoundingBox;
    if (!a || !b) throw new Error("FigDes connect requires nodes with absolute bounds.");
    const x1 = a.x + a.width / 2;
    const y1 = a.y + a.height / 2;
    const x2 = b.x + b.width / 2;
    const y2 = b.y + b.height / 2;
    const parent = opts.parent ?? figmaApi.currentPage;
    const lineNode = figmaApi.createLine();
    parent.appendChild(lineNode);
    lineNode.x = x1;
    lineNode.y = y1;
    lineNode.resize(Math.max(1, Math.hypot(x2 - x1, y2 - y1)), 0);
    lineNode.rotation = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
    lineNode.strokes = paint(opts.stroke ?? "#9B9B95");
    lineNode.strokeWeight = opts.weight ?? 1;
    if (opts.dash) lineNode.dashPattern = opts.dash;
    return lineNode;
  };

  const inspect = (node: AnyNode) => nodeSummary(node);

  const set = (node: AnyNode, values: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (key === "fill") node.fills = paint(value as string | null);
      else if (key === "stroke") node.strokes = paint(value as string | null);
      else if (key === "radius" && "cornerRadius" in node) node.cornerRadius = value;
      else (node as any)[key] = value;
    }
    return node;
  };

  return {
    frame,
    stack,
    text,
    rect,
    ellipse,
    line,
    vector,
    component,
    instance,
    append,
    place,
    fill,
    stroke,
    radius,
    connect,
    inspect,
    set,
    color,
    paint,
    fontStyleForWeight,
    summary: nodeSummary,
  };
}
