import { serialize, resolve, asScene } from "./utils";

export async function handleTypography(action: string, target: any, params: any) {
  switch (action) {
    case "loadFont":
      await figma.loadFontAsync(params.font);
      return { status: "loaded", font: params.font };

    case "setTypography": {
      const sn = asScene(resolve(target));
      if (sn.type !== "TEXT") throw new Error("setTypography requires a TEXT target.");
      const textNode = sn as TextNode;

      if (params.font) {
        await figma.loadFontAsync(params.font);
        textNode.fontName = params.font;
      }
      if (params.size !== undefined) textNode.fontSize = params.size;
      if (params.lineHeight !== undefined) textNode.lineHeight = params.lineHeight;
      if (params.letterSpacing !== undefined) textNode.letterSpacing = params.letterSpacing;
      if (params.textCase !== undefined) textNode.textCase = params.textCase;
      if (params.textDecoration !== undefined) textNode.textDecoration = params.textDecoration;
      if (params.horizontalAlign !== undefined) textNode.textAlignHorizontal = params.horizontalAlign;
      if (params.verticalAlign !== undefined) textNode.textAlignVertical = params.verticalAlign;
      if (params.resizingMode !== undefined) textNode.textAutoResize = params.resizingMode;
      return serialize(sn);
    }

    case "setTextContent": {
      const sn = asScene(resolve(target));
      if (sn.type !== "TEXT") throw new Error("setTextContent requires a TEXT target.");
      const textNode = sn as TextNode;
      const fontName = textNode.fontName;
      if (fontName && fontName !== figma.mixed) {
        await figma.loadFontAsync(fontName as FontName);
      } else {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      }
      textNode.characters = params.content;
      return serialize(sn);
    }
  }
  return null;
}
