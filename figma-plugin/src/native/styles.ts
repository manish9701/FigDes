import { resolve, serialize } from "./utils";

function findStyle(idOrName: string, kind?: "paint" | "text" | "effect") {
  const groups = {
    paint: figma.getLocalPaintStyles(),
    text: figma.getLocalTextStyles(),
    effect: figma.getLocalEffectStyles()
  };
  const source = kind ? groups[kind] : [...groups.paint, ...groups.text, ...groups.effect];
  return source.find((style: any) => style.id === idOrName || style.name === idOrName);
}

export function handleStyles(action: string, target: any, params: any) {
  switch (action) {
    case "listStyles":
      return [
        ...figma.getLocalPaintStyles().map((s: any) => ({ id: s.id, name: s.name, type: "PAINT" })),
        ...figma.getLocalTextStyles().map((s: any) => ({ id: s.id, name: s.name, type: "TEXT" })),
        ...figma.getLocalEffectStyles().map((s: any) => ({ id: s.id, name: s.name, type: "EFFECT" }))
      ];

    case "findStyle": {
      const style = findStyle(String(params.query ?? ""), params.kind);
      return style ? { id: style.id, name: style.name, type: style.type } : null;
    }

    case "createPaintStyle": {
      const style = figma.createPaintStyle();
      style.name = params.name;
      if (params.paints) style.paints = params.paints;
      return { id: style.id, name: style.name, type: "PAINT" };
    }

    case "createTextStyle": {
      const style = figma.createTextStyle();
      style.name = params.name;
      if (params.font) style.fontName = params.font;
      if (params.fontSize !== undefined) style.fontSize = params.fontSize;
      if (params.letterSpacing !== undefined) style.letterSpacing = params.letterSpacing;
      if (params.lineHeight !== undefined) style.lineHeight = params.lineHeight;
      return { id: style.id, name: style.name, type: "TEXT" };
    }

    case "createEffectStyle": {
      const style = figma.createEffectStyle();
      style.name = params.name;
      if (params.effects) style.effects = params.effects;
      return { id: style.id, name: style.name, type: "EFFECT" };
    }

    case "applyStyle": {
      const node = resolve(target) as any;
      const style = findStyle(String(params.styleId ?? params.style), params.kind);
      if (!style) throw new Error(`Style ${params.styleId ?? params.style} not found.`);
      if (style.type === "PAINT" && "fillStyleId" in node) node.fillStyleId = style.id;
      else if (style.type === "TEXT" && "textStyleId" in node) node.textStyleId = style.id;
      else if (style.type === "EFFECT" && "effectStyleId" in node) node.effectStyleId = style.id;
      else throw new Error(`Style type ${style.type} is incompatible with node ${node.type}.`);
      return serialize(node);
    }
  }
  return null;
}
