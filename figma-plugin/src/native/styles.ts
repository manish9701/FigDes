import { resolve, serialize } from "./utils";

interface AnyStyle {
  id: string;
  name: string;
  type: string;
  [key: string]: unknown;
}

async function localPaintStyles(): Promise<AnyStyle[]> {
  return (await figma.getLocalPaintStylesAsync()) as unknown as AnyStyle[];
}
async function localTextStyles(): Promise<AnyStyle[]> {
  return (await figma.getLocalTextStylesAsync()) as unknown as AnyStyle[];
}
async function localEffectStyles(): Promise<AnyStyle[]> {
  return (await figma.getLocalEffectStylesAsync()) as unknown as AnyStyle[];
}

async function findStyle(idOrName: string, kind?: "paint" | "text" | "effect"): Promise<AnyStyle | undefined> {
  const groups: Record<string, () => Promise<AnyStyle[]>> = {
    paint: localPaintStyles,
    text: localTextStyles,
    effect: localEffectStyles,
  };
  const source = kind ? await groups[kind]!() : [...(await localPaintStyles()), ...(await localTextStyles()), ...(await localEffectStyles())];
  return source.find((style) => style.id === idOrName || style.name === idOrName);
}

export async function handleStyles(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "listStyles": {
      const [p, t, e] = await Promise.all([localPaintStyles(), localTextStyles(), localEffectStyles()]);
      return [
        ...p.map((s) => ({ id: s.id, name: s.name, type: "PAINT" })),
        ...t.map((s) => ({ id: s.id, name: s.name, type: "TEXT" })),
        ...e.map((s) => ({ id: s.id, name: s.name, type: "EFFECT" })),
      ];
    }

    case "findStyle": {
      const style = await findStyle(String(params.query ?? ""), params.kind as "paint" | "text" | "effect" | undefined);
      return style ? { id: style.id, name: style.name, type: style.type } : null;
    }

    case "createPaintStyle": {
      const style = figma.createPaintStyle();
      style.name = String(params.name);
      // Accept `paints` (array) or a single `paint`.
      const paints = params.paints ?? (params.paint !== undefined ? [params.paint] : undefined);
      if (paints) style.paints = paints as Paint[];
      return { id: style.id, name: style.name, type: "PAINT" };
    }

    case "createTextStyle": {
      const style = figma.createTextStyle();
      style.name = String(params.name);
      if (params.font) style.fontName = params.font as FontName;
      if (params.fontSize !== undefined) style.fontSize = Number(params.fontSize);
      if (params.letterSpacing !== undefined) style.letterSpacing = params.letterSpacing as LetterSpacing;
      if (params.lineHeight !== undefined) style.lineHeight = params.lineHeight as LineHeight;
      return { id: style.id, name: style.name, type: "TEXT" };
    }

    case "createEffectStyle": {
      const style = figma.createEffectStyle();
      style.name = String(params.name);
      if (params.effects) style.effects = params.effects as Effect[];
      return { id: style.id, name: style.name, type: "EFFECT" };
    }

    case "applyStyle": {
      const node = (await resolve(target)) as unknown as Record<string, unknown>;
      const key = String(params.styleId ?? params.style ?? "");
      const style = await findStyle(key, params.kind as "paint" | "text" | "effect" | undefined);
      if (!style) throw new Error(`Style ${key} not found.`);
      if (style.type === "PAINT" && "fillStyleId" in node) node.fillStyleId = style.id;
      else if (style.type === "TEXT" && "textStyleId" in node) node.textStyleId = style.id;
      else if (style.type === "EFFECT" && "effectStyleId" in node) node.effectStyleId = style.id;
      else throw new Error(`Style type ${style.type} is incompatible with this node.`);
      return serialize((await resolve(target)) as never);
    }
  }
  return null;
}
