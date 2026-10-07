const fs = require('fs');
const path = require('path');
const dir = 'd:/Desktop/exo/figma-plugin/src/native';

fs.mkdirSync(dir, { recursive: true });

const utils = `export function resolve(id: string | null | undefined): BaseNode {
  if (!id || id === 'page') return figma.currentPage;
  const n = figma.getNodeById(id);
  if (!n) throw new Error(\`Node \${id} not found\`);
  return n;
}

export function asScene(n: BaseNode): SceneNode {
  if (n.type === 'PAGE' || n.type === 'DOCUMENT') throw new Error('Expected a SceneNode');
  return n as SceneNode;
}

export function serialize(n: BaseNode) {
  if (n.type === 'PAGE' || n.type === 'DOCUMENT') return { id: n.id, type: n.type, name: n.name };
  const sn = n as SceneNode;
  return { id: sn.id, type: sn.type, name: sn.name, x: sn.x, y: sn.y, width: sn.width, height: sn.height };
}
`;
fs.writeFileSync(path.join(dir, 'utils.ts'), utils);

const create = `import { serialize, resolve, asScene } from './utils';

export function handleCreate(action: string, params: any) {
  switch (action) {
    case 'createFrame': {
      const frame = figma.createFrame();
      if (params.name) frame.name = params.name;
      if (params.width && params.height) frame.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(frame);
      return serialize(frame);
    }
    case 'createRectangle': {
      const rect = figma.createRectangle();
      if (params.name) rect.name = params.name;
      if (params.width && params.height) rect.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(rect);
      return serialize(rect);
    }
    case 'createEllipse': {
      const ell = figma.createEllipse();
      if (params.name) ell.name = params.name;
      if (params.width && params.height) ell.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(ell);
      return serialize(ell);
    }
    case 'createPolygon': {
      const p = figma.createPolygon();
      if (params.name) p.name = params.name;
      if (params.width && params.height) p.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(p);
      return serialize(p);
    }
    case 'createStar': {
      const p = figma.createStar();
      if (params.name) p.name = params.name;
      if (params.width && params.height) p.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(p);
      return serialize(p);
    }
    case 'createLine': {
      const p = figma.createLine();
      if (params.name) p.name = params.name;
      if (params.width && params.height) p.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(p);
      return serialize(p);
    }
    case 'createGroup': {
      const children = (params.children || []).map(resolve).map(asScene);
      if (children.length === 0) throw new Error('Cannot create empty group');
      const parent = params.parent ? resolve(params.parent) : children[0].parent || figma.currentPage;
      const group = figma.group(children, parent as any);
      if (params.name) group.name = params.name;
      return serialize(group);
    }
    case 'createComponent': {
      const comp = figma.createComponent();
      if (params.name) comp.name = params.name;
      if (params.width && params.height) comp.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(comp);
      return serialize(comp);
    }
    case 'createInstance': {
      const comp = resolve(params.componentId);
      if (comp.type !== 'COMPONENT' && comp.type !== 'COMPONENT_SET') throw new Error('Not a component');
      const inst = (comp as ComponentNode).createInstance();
      if (params.name) inst.name = params.name;
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(inst);
      return serialize(inst);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'create.ts'), create);

const inspect = `import { serialize, resolve, asScene } from './utils';

export function handleInspect(action: string, target: any, params: any) {
  switch (action) {
    case 'find': {
      const query = params.query;
      const root = params.root ? resolve(params.root) : figma.currentPage;
      if (!('findAll' in root)) return [];
      const nodes = (root as any).findAll((n: any) => {
        if (query.name && !n.name.includes(query.name)) return false;
        if (query.type && n.type !== query.type) return false;
        return true;
      });
      return nodes.map(serialize);
    }
    case 'getSelection': {
      return figma.currentPage.selection.map(serialize);
    }
    case 'setSelection': {
      figma.currentPage.selection = params.nodeIds.map(resolve).map(asScene);
      return figma.currentPage.selection.map(serialize);
    }
    case 'getNode': {
      return serialize(resolve(target));
    }
    case 'getChildren': {
      const node = resolve(target);
      if (!('children' in node)) return [];
      return (node as any).children.map(serialize);
    }
    case 'getParent': {
      const node = resolve(target);
      if (!node.parent) return null;
      return serialize(node.parent);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'inspect.ts'), inspect);

const geometry = `import { serialize, resolve, asScene } from './utils';

export function handleGeometry(action: string, target: any, params: any) {
  switch(action) {
    case 'getBounds': {
      const sn = asScene(resolve(target));
      return { x: sn.x, y: sn.y, width: sn.width, height: sn.height };
    }
    case 'getAbsoluteBounds': {
      const sn = asScene(resolve(target));
      return sn.absoluteBoundingBox;
    }
    case 'setPosition': {
      const sn = asScene(resolve(target));
      if (params.x !== undefined) sn.x = params.x;
      if (params.y !== undefined) sn.y = params.y;
      return serialize(sn);
    }
    case 'setSize': {
      const sn = asScene(resolve(target));
      if (params.width !== undefined && params.height !== undefined) {
        if ('resize' in sn) (sn as any).resize(params.width, params.height);
      }
      return serialize(sn);
    }
    case 'setBounds': {
      const sn = asScene(resolve(target));
      if (params.x !== undefined) sn.x = params.x;
      if (params.y !== undefined) sn.y = params.y;
      if (params.width !== undefined && params.height !== undefined) {
        if ('resize' in sn) (sn as any).resize(params.width, params.height);
      }
      return serialize(sn);
    }
    case 'setRotation': {
      const sn = asScene(resolve(target));
      sn.rotation = params.rotation;
      return serialize(sn);
    }
    case 'setCornerRadius': {
      const sn = asScene(resolve(target));
      if ('cornerRadius' in sn) (sn as any).cornerRadius = params.radius;
      return serialize(sn);
    }
    case 'setIndividualCornerRadii': {
      const sn = asScene(resolve(target));
      if ('topLeftRadius' in sn) {
        (sn as any).topLeftRadius = params.radii[0];
        (sn as any).topRightRadius = params.radii[1];
        (sn as any).bottomRightRadius = params.radii[2];
        (sn as any).bottomLeftRadius = params.radii[3];
      }
      return serialize(sn);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'geometry.ts'), geometry);

const paint = `import { serialize, resolve, asScene } from './utils';

export function handlePaint(action: string, target: any, params: any) {
  if (!target && action !== 'clearFill' && action !== 'setFill' && action !== 'setFills' && action !== 'setOpacity' && action !== 'setVisible' && action !== 'setBlendMode' && action !== 'setStroke' && action !== 'setEffects') return null;
  const sn = target ? asScene(resolve(target)) : null;
  if(!sn) return null;

  switch(action) {
    case 'setFill': {
      if ('fills' in sn) {
        (sn as any).fills = [params.paint];
      }
      return serialize(sn);
    }
    case 'setFills': {
      if ('fills' in sn) {
        (sn as any).fills = params.paints;
      }
      return serialize(sn);
    }
    case 'clearFill': {
      if ('fills' in sn) {
        (sn as any).fills = [];
      }
      return serialize(sn);
    }
    case 'setOpacity': {
      if ('opacity' in sn) (sn as any).opacity = params.opacity;
      return serialize(sn);
    }
    case 'setVisible': {
      if ('visible' in sn) (sn as any).visible = params.visible;
      return serialize(sn);
    }
    case 'setBlendMode': {
      if ('blendMode' in sn) (sn as any).blendMode = params.mode;
      return serialize(sn);
    }
    case 'setStroke': {
      if ('strokes' in sn) {
        if (params.paints) (sn as any).strokes = params.paints;
        if (params.weight !== undefined) (sn as any).strokeWeight = params.weight;
        if (params.align !== undefined) (sn as any).strokeAlign = params.align;
        if (params.dashPattern !== undefined) (sn as any).dashPattern = params.dashPattern;
        if (params.cap !== undefined) (sn as any).strokeCap = params.cap;
        if (params.join !== undefined) (sn as any).strokeJoin = params.join;
      }
      return serialize(sn);
    }
    case 'setEffects': {
      if ('effects' in sn) {
        (sn as any).effects = params.effects;
      }
      return serialize(sn);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'paint.ts'), paint);

const layout = `import { serialize, resolve, asScene } from './utils';

export function handleLayout(action: string, target: any, params: any) {
  if (!target && action !== 'setAutoLayout' && action !== 'setClipContent' && action !== 'setConstraints' && action !== 'clone' && action !== 'remove' && action !== 'append' && action !== 'rename' && action !== 'insertChild') return null;
  const sn = target ? asScene(resolve(target)) : null;
  if (!sn && action !== 'append' && action !== 'insertChild') return null;

  switch (action) {
    case 'setAutoLayout': {
      if (sn && 'layoutMode' in sn) {
        (sn as any).layoutMode = params.direction || 'NONE';
        if (params.primaryAxisSizing) (sn as any).primaryAxisSizingMode = params.primaryAxisSizing;
        if (params.counterAxisSizing) (sn as any).counterAxisSizingMode = params.counterAxisSizing;
        if (params.primaryAxisAlignItems) (sn as any).primaryAxisAlignItems = params.primaryAxisAlignItems;
        if (params.counterAxisAlignItems) (sn as any).counterAxisAlignItems = params.counterAxisAlignItems;
        if (params.itemSpacing !== undefined) (sn as any).itemSpacing = params.itemSpacing;
        if (params.paddingTop !== undefined) (sn as any).paddingTop = params.paddingTop;
        if (params.paddingRight !== undefined) (sn as any).paddingRight = params.paddingRight;
        if (params.paddingBottom !== undefined) (sn as any).paddingBottom = params.paddingBottom;
        if (params.paddingLeft !== undefined) (sn as any).paddingLeft = params.paddingLeft;
        if (params.layoutWrap !== undefined) (sn as any).layoutWrap = params.layoutWrap;
        if (params.counterAxisAlignContent !== undefined) (sn as any).counterAxisAlignContent = params.counterAxisAlignContent;
      }
      return sn ? serialize(sn) : null;
    }
    case 'setClipContent': {
      if (sn && 'clipsContent' in sn) (sn as any).clipsContent = params.value;
      return sn ? serialize(sn) : null;
    }
    case 'setConstraints': {
      if (sn && 'constraints' in sn) {
        (sn as any).constraints = params.constraints;
      }
      return sn ? serialize(sn) : null;
    }
    case 'clone': {
      if (sn) {
        const cloned = sn.clone();
        if (params.x !== undefined) cloned.x = params.x;
        if (params.y !== undefined) cloned.y = params.y;
        const parent = params.parent ? resolve(params.parent) : sn.parent;
        if (parent && 'appendChild' in parent) (parent as any).appendChild(cloned);
        return serialize(cloned);
      }
      return null;
    }
    case 'remove': {
      if (sn) sn.remove();
      return { status: 'removed' };
    }
    case 'append': {
      const parent = target ? resolve(target) : figma.currentPage;
      const child = asScene(resolve(params.child));
      if ('appendChild' in parent) {
        (parent as any).appendChild(child);
      }
      return serialize(child);
    }
    case 'rename': {
      if (sn) sn.name = params.name;
      return sn ? serialize(sn) : null;
    }
    case 'insertChild': {
      const parent = target ? resolve(target) : figma.currentPage;
      const child = asScene(resolve(params.child));
      if ('insertChild' in parent) {
        (parent as any).insertChild(params.index, child);
      }
      return serialize(child);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'layout.ts'), layout);

const typography = `import { serialize, resolve, asScene } from './utils';

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
`;
fs.writeFileSync(path.join(dir, 'typography.ts'), typography);

const vectors = `import { serialize, resolve, asScene } from './utils';

export function handleVectors(action: string, target: any, params: any) {
  switch(action) {
    case 'createVector': {
      const v = figma.createVector();
      if (params.name) v.name = params.name;
      if (params.path) {
        let data = '';
        for (const pt of params.path) {
           if (pt.command === 'M') data += \`M \${pt.x} \${pt.y} \`;
           if (pt.command === 'L') data += \`L \${pt.x} \${pt.y} \`;
           if (pt.command === 'C') data += \`C \${pt.x1} \${pt.y1} \${pt.x2} \${pt.y2} \${pt.x} \${pt.y} \`;
           if (pt.command === 'Q') data += \`Q \${pt.x1} \${pt.y1} \${pt.x} \${pt.y} \`;
           if (pt.command === 'Z') data += 'Z ';
        }
        v.vectorPaths = [{ windingRule: 'EVENODD', data }];
      }
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      (parent as any).appendChild(v);
      return serialize(v);
    }
    case 'setPathData': {
      const sn = asScene(resolve(target));
      if (sn.type === 'VECTOR') {
        let data = '';
        for (const pt of params.path) {
           if (pt.command === 'M') data += \`M \${pt.x} \${pt.y} \`;
           if (pt.command === 'L') data += \`L \${pt.x} \${pt.y} \`;
           if (pt.command === 'C') data += \`C \${pt.x1} \${pt.y1} \${pt.x2} \${pt.y2} \${pt.x} \${pt.y} \`;
           if (pt.command === 'Q') data += \`Q \${pt.x1} \${pt.y1} \${pt.x} \${pt.y} \`;
           if (pt.command === 'Z') data += 'Z ';
        }
        (sn as any).vectorPaths = [{ windingRule: 'EVENODD', data }];
      }
      return serialize(sn);
    }
  }
  return null;
}
`;
fs.writeFileSync(path.join(dir, 'vectors.ts'), vectors);

const index = `import { handleCreate } from './create';
import { handleInspect } from './inspect';
import { handleGeometry } from './geometry';
import { handlePaint } from './paint';
import { handleLayout } from './layout';
import { handleTypography } from './typography';
import { handleVectors } from './vectors';

export async function executeNativeCall(payload: any): Promise<any> {
  const { action, target, ...params } = payload;
  
  try {
    let res = handleCreate(action, params);
    if (res !== null) return res;
    
    res = handleInspect(action, target, params);
    if (res !== null) return res;

    res = handleGeometry(action, target, params);
    if (res !== null) return res;

    res = handlePaint(action, target, params);
    if (res !== null) return res;

    res = handleLayout(action, target, params);
    if (res !== null) return res;

    res = await handleTypography(action, target, params);
    if (res !== null) return res;

    res = handleVectors(action, target, params);
    if (res !== null) return res;

    switch(action) {
      case 'setVariant':
      case 'bindVariable':
      case 'applyStyle':
        return { status: 'stub' };
    }

    throw new Error(\`Unknown native action: \${action}\`);
  } catch (err: any) {
    throw new Error(\`Native execution failed: \${err.message}\`);
  }
}
`;
fs.writeFileSync(path.join(dir, 'index.ts'), index);
