import { serialize, resolve, asScene } from "./utils";

function appendToParent(node: SceneNode, parentRef?: string) {
  const parent = parentRef ? resolve(parentRef) : figma.currentPage;
  if (!("appendChild" in parent)) throw new Error("Parent cannot contain children.");
  (parent as ChildrenMixin).appendChild(node);
}

function applyCommonSceneProps(node: SceneNode, params: any) {
  if (params.name) node.name = String(params.name);
  if (params.x !== undefined) node.x = Number(params.x);
  if (params.y !== undefined) node.y = Number(params.y);
  if (params.width !== undefined && params.height !== undefined) node.resize(Number(params.width), Number(params.height));
  if (params.opacity !== undefined && "opacity" in node) (node as any).opacity = Number(params.opacity);
  if (params.visible !== undefined && "visible" in node) (node as any).visible = Boolean(params.visible);
  if (params.rotation !== undefined && "rotation" in node) node.rotation = Number(params.rotation);
  if (params.cornerRadius !== undefined && "cornerRadius" in node) (node as any).cornerRadius = params.cornerRadius;
  if (params.fill !== undefined && "fills" in node) (node as any).fills = params.fill == null ? [] : (Array.isArray(params.fill) ? params.fill : [params.fill]);
  if (params.fills !== undefined && "fills" in node) (node as any).fills = params.fills;
  if (params.stroke !== undefined && "strokes" in node) (node as any).strokes = params.stroke == null ? [] : (Array.isArray(params.stroke) ? params.stroke : [params.stroke]);
  if (params.strokes !== undefined && "strokes" in node) (node as any).strokes = params.strokes;
  if (params.strokeWeight !== undefined && "strokeWeight" in node) (node as any).strokeWeight = Number(params.strokeWeight);
}

async function createText(params: any) {
  const text = figma.createText();
  const font: FontName = params.font ?? {
    family: String(params.family ?? "Inter"),
    style: String(params.style ?? "Regular"),
  };

  await figma.loadFontAsync(font);
  text.fontName = font;

  if (params.fontSize !== undefined) text.fontSize = Number(params.fontSize);
  if (params.content !== undefined) text.characters = String(params.content);
  if (params.lineHeight !== undefined) text.lineHeight = params.lineHeight;
  if (params.letterSpacing !== undefined) text.letterSpacing = params.letterSpacing;
  if (params.textAlignHorizontal !== undefined) text.textAlignHorizontal = params.textAlignHorizontal;
  if (params.textAlignVertical !== undefined) text.textAlignVertical = params.textAlignVertical;
  if (params.textAutoResize !== undefined) text.textAutoResize = params.textAutoResize;
  if (params.textCase !== undefined) text.textCase = params.textCase;
  if (params.textDecoration !== undefined) text.textDecoration = params.textDecoration;
  if (params.fill !== undefined) text.fills = params.fill == null ? [] : (Array.isArray(params.fill) ? params.fill : [params.fill]);
  if (params.fills !== undefined) text.fills = params.fills;

  appendToParent(text, params.parent);
  applyCommonSceneProps(text, { ...params, width: undefined, height: undefined });
  if (params.width !== undefined && params.height === undefined) text.resize(Number(params.width), text.height);

  return serialize(text);
}

export async function handleCreate(action: string, params: any) {
  switch (action) {
    case "createFrame":
    case "createRectangle":
    case "createEllipse":
    case "createPolygon":
    case "createStar":
    case "createLine": {
      const factory: Record<string, () => SceneNode> = {
        createFrame: () => figma.createFrame(),
        createRectangle: () => figma.createRectangle(),
        createEllipse: () => figma.createEllipse(),
        createPolygon: () => figma.createPolygon(),
        createStar: () => figma.createStar(),
        createLine: () => figma.createLine(),
      };
      const node = factory[action]();
      appendToParent(node, params.parent);
      applyCommonSceneProps(node, params);

      if (action === "createFrame" && (params.layoutMode || params.mode || params.direction)) {
        const frame = node as FrameNode;
        frame.layoutMode = params.layoutMode ?? params.mode ?? params.direction ?? "NONE";
        if (params.primaryAxisSizing) frame.primaryAxisSizingMode = params.primaryAxisSizing;
        if (params.counterAxisSizing) frame.counterAxisSizingMode = params.counterAxisSizing;
        if (params.primaryAxisAlignItems) frame.primaryAxisAlignItems = params.primaryAxisAlignItems;
        if (params.counterAxisAlignItems) frame.counterAxisAlignItems = params.counterAxisAlignItems;
        if (params.itemSpacing !== undefined) frame.itemSpacing = Number(params.itemSpacing);
        if (params.paddingTop !== undefined) frame.paddingTop = Number(params.paddingTop);
        if (params.paddingRight !== undefined) frame.paddingRight = Number(params.paddingRight);
        if (params.paddingBottom !== undefined) frame.paddingBottom = Number(params.paddingBottom);
        if (params.paddingLeft !== undefined) frame.paddingLeft = Number(params.paddingLeft);
        if (params.clipsContent !== undefined) frame.clipsContent = Boolean(params.clipsContent);
      }

      return serialize(node);
    }

    case "createText":
      return createText(params);

    case "createVector": {
      // Vector creation is handled by vectors.ts, so leave it for that dispatcher.
      return null;
    }

    case "createGroup": {
      const children = (params.children || []).map(resolve).map(asScene);
      if (children.length === 0) throw new Error("Cannot create empty group.");
      const parent = params.parent ? resolve(params.parent) : children[0]?.parent ?? figma.currentPage;
      if (!parent || !("appendChild" in parent)) throw new Error("Group parent cannot contain children.");
      const group = figma.group(children, parent as ChildrenMixin);
      if (params.name) group.name = String(params.name);
      if (params.x !== undefined) group.x = Number(params.x);
      if (params.y !== undefined) group.y = Number(params.y);
      return serialize(group);
    }

    case "createComponent": {
      const comp = figma.createComponent();
      appendToParent(comp, params.parent);
      applyCommonSceneProps(comp, params);
      return serialize(comp);
    }
  }
  return null;
}
