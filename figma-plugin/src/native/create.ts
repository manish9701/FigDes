import { serialize, resolve, toPaints, type SerializeOptions } from "./utils";

async function appendToParent(node: SceneNode, parentRef?: string): Promise<void> {
  const parent = parentRef ? await resolve(parentRef) : figma.currentPage;
  if (!("appendChild" in parent)) throw new Error("Parent cannot contain children.");
  (parent as ChildrenMixin).appendChild(node);
}

export function applyCommonSceneProps(node: SceneNode, params: Record<string, unknown>): void {
  if (params.name) node.name = String(params.name);
  if (params.x !== undefined) node.x = Number(params.x);
  if (params.y !== undefined) node.y = Number(params.y);
  if (params.width !== undefined && params.height !== undefined && "resize" in node) {
    (node as unknown as { resize: (w: number, h: number) => void }).resize(Number(params.width), Number(params.height));
  }
  if (params.opacity !== undefined && "opacity" in node) (node as unknown as { opacity: number }).opacity = Number(params.opacity);
  if (params.visible !== undefined && "visible" in node) (node as SceneNode).visible = Boolean(params.visible);
  if (params.rotation !== undefined && "rotation" in node) (node as unknown as LayoutMixin).rotation = Number(params.rotation);
  if (params.cornerRadius !== undefined && "cornerRadius" in node) {
    (node as unknown as { cornerRadius: unknown }).cornerRadius = params.cornerRadius;
  }
  if (params.fill !== undefined && "fills" in node) {
    (node as unknown as { fills: readonly Paint[] }).fills = toPaints(params.fill);
  }
  if (params.fills !== undefined && "fills" in node) (node as unknown as { fills: readonly Paint[] }).fills = toPaints(params.fills);
  if (params.stroke !== undefined && "strokes" in node) {
    (node as unknown as { strokes: readonly Paint[] }).strokes = toPaints(params.stroke);
  }
  if (params.strokes !== undefined && "strokes" in node) (node as unknown as { strokes: readonly Paint[] }).strokes = toPaints(params.strokes);
  if (params.strokeWeight !== undefined && "strokeWeight" in node) (node as unknown as GeometryMixin).strokeWeight = Number(params.strokeWeight);
}

async function createText(params: Record<string, unknown>): Promise<unknown> {
  const text = figma.createText();
  const font: FontName =
    (params.font as FontName | undefined) ??
    (params.fontName as FontName | undefined) ?? {
      family: String(params.family ?? "Inter"),
      style: String(params.style ?? "Regular"),
    };

  await figma.loadFontAsync(font);
  text.fontName = font;

  if (params.fontSize !== undefined) text.fontSize = Number(params.fontSize);
  if (params.content !== undefined) text.characters = String(params.content);
  if (params.lineHeight !== undefined) text.lineHeight = params.lineHeight as LineHeight;
  if (params.letterSpacing !== undefined) text.letterSpacing = params.letterSpacing as LetterSpacing;
  if (params.textAlignHorizontal !== undefined) text.textAlignHorizontal = params.textAlignHorizontal as TextNode["textAlignHorizontal"];
  if (params.textAlignVertical !== undefined) text.textAlignVertical = params.textAlignVertical as TextNode["textAlignVertical"];
  if (params.textAutoResize !== undefined) text.textAutoResize = params.textAutoResize as TextNode["textAutoResize"];
  if (params.textCase !== undefined) text.textCase = params.textCase as TextNode["textCase"];
  if (params.textDecoration !== undefined) text.textDecoration = params.textDecoration as TextNode["textDecoration"];
  if (params.fill !== undefined) text.fills = toPaints(params.fill);
  if (params.fills !== undefined) text.fills = toPaints(params.fills);

  await appendToParent(text, params.parent as string | undefined);
  applyCommonSceneProps(text, { ...params, width: undefined, height: undefined });
  if (params.width !== undefined && params.height === undefined) text.resize(Number(params.width), text.height);

  return serialize(text);
}

export async function handleCreate(action: string, params: Record<string, unknown>): Promise<unknown> {
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
      const node = factory[action]!();
      await appendToParent(node, params.parent as string | undefined);
      applyCommonSceneProps(node, params);

      if ((action === "createPolygon" || action === "createStar") && params.pointCount !== undefined) {
        (node as unknown as { pointCount: number }).pointCount = Number(params.pointCount);
      }
      if (action === "createStar" && params.innerRadius !== undefined) {
        (node as unknown as { innerRadius: number }).innerRadius = Number(params.innerRadius);
      }

      if (action === "createFrame" && (params.layoutMode || params.mode || params.direction)) {
        const frame = node as FrameNode;
        frame.layoutMode = (params.layoutMode ?? params.mode ?? params.direction ?? "NONE") as FrameNode["layoutMode"];
        if (params.primaryAxisSizing) frame.primaryAxisSizingMode = params.primaryAxisSizing as FrameNode["primaryAxisSizingMode"];
        if (params.counterAxisSizing) frame.counterAxisSizingMode = params.counterAxisSizing as FrameNode["counterAxisSizingMode"];
        if (params.primaryAxisAlignItems) frame.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode["primaryAxisAlignItems"];
        if (params.counterAxisAlignItems) frame.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode["counterAxisAlignItems"];
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
      // Handled by vectors.ts so the path pipeline lives in one place.
      return null;
    }

    case "createGroup": {
      const children = await Promise.all((params.children as string[]).map((id) => resolve(id)));
      if (children.length === 0) throw new Error("Cannot create empty group.");
      const parentRef = params.parent as string | undefined;
      const parent = parentRef ? await resolve(parentRef) : children[0]?.parent ?? figma.currentPage;
      if (!parent || !("appendChild" in parent)) throw new Error("Group parent cannot contain children.");
      const group = figma.group(children.map((c) => c as SceneNode), parent as BaseNode & ChildrenMixin);
      if (params.name) group.name = String(params.name);
      if (params.x !== undefined) group.x = Number(params.x);
      if (params.y !== undefined) group.y = Number(params.y);
      return serialize(group);
    }

    case "createComponent": {
      const comp = figma.createComponent();
      await appendToParent(comp, params.parent as string | undefined);
      applyCommonSceneProps(comp, params);
      return serialize(comp);
    }
  }
  return null;
}

export type { SerializeOptions };
