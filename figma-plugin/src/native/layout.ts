import { serialize, resolve, asScene } from './utils';

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
