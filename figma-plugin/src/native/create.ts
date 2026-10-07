import { serialize, resolve, asScene } from './utils';

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
