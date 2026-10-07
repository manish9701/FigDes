import { serialize, resolveScene } from "./utils";

export async function handleTypography(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "loadFont":
      await figma.loadFontAsync(params.font as FontName);
      return { status: "loaded", font: params.font };

    case "setTypography": {
      const sn = await resolveScene(target);
      if (sn.type !== "TEXT") throw new Error("setTypography requires a TEXT target.");
      const textNode = sn as TextNode;

      if (params.font) {
        await figma.loadFontAsync(params.font as FontName);
        textNode.fontName = params.font as FontName;
      }
      if (params.size !== undefined) textNode.fontSize = Number(params.size);
      if (params.lineHeight !== undefined) textNode.lineHeight = params.lineHeight as LineHeight;
      if (params.letterSpacing !== undefined) textNode.letterSpacing = params.letterSpacing as LetterSpacing;
      if (params.textCase !== undefined) textNode.textCase = params.textCase as TextNode["textCase"];
      if (params.textDecoration !== undefined) textNode.textDecoration = params.textDecoration as TextNode["textDecoration"];
      if (params.horizontalAlign !== undefined) textNode.textAlignHorizontal = params.horizontalAlign as TextNode["textAlignHorizontal"];
      if (params.verticalAlign !== undefined) textNode.textAlignVertical = params.verticalAlign as TextNode["textAlignVertical"];
      if (params.resizingMode !== undefined) textNode.textAutoResize = params.resizingMode as TextNode["textAutoResize"];
      return serialize(sn);
    }

    case "setTextContent": {
      const sn = await resolveScene(target);
      if (sn.type !== "TEXT") throw new Error("setTextContent requires a TEXT target.");
      const textNode = sn as TextNode;
      const fontName = textNode.fontName;
      if (fontName && fontName !== figma.mixed) {
        await figma.loadFontAsync(fontName as FontName);
      } else {
        await figma.loadFontAsync({ family: "Inter", style: "Regular" });
      }
      textNode.characters = String(params.content);
      return serialize(sn);
    }
  }
  return null;
}
