import { serialize, resolve, asScene } from './utils';

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
