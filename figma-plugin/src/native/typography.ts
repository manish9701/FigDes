import { serialize, resolve, asScene } from './utils';

export async function handleTypography(action: string, target: any, params: any) {
  switch (action) {
    case 'loadFont': {
      await figma.loadFontAsync(params.font);
      return { status: 'loaded' };
    }
    case 'setTypography': {
      const sn = asScene(resolve(target));
      if (sn.type === 'TEXT') {
        const textNode = sn as TextNode;
        if (params.font) {
           await figma.loadFontAsync(params.font);
           textNode.fontName = params.font;
        }
        if (params.size) textNode.fontSize = params.size;
        if (params.lineHeight) textNode.lineHeight = params.lineHeight;
        if (params.letterSpacing) textNode.letterSpacing = params.letterSpacing;
        if (params.textCase) textNode.textCase = params.textCase;
        if (params.textDecoration) textNode.textDecoration = params.textDecoration;
        if (params.horizontalAlign) textNode.textAlignHorizontal = params.horizontalAlign;
        if (params.verticalAlign) textNode.textAlignVertical = params.verticalAlign;
      }
      return serialize(sn);
    }
    case 'setTextContent': {
      const sn = asScene(resolve(target));
      if (sn.type === 'TEXT') {
        const textNode = sn as TextNode;
        const fontName = textNode.fontName;
        if (fontName && typeof fontName === 'object' && fontName !== figma.mixed) {
          await figma.loadFontAsync(fontName as FontName);
        } else {
          await figma.loadFontAsync({family: 'Inter', style: 'Regular'});
        }
        textNode.characters = params.content;
      }
      return serialize(sn);
    }
  }
  return null;
}
