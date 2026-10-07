import { serialize, resolve, asScene } from './utils';

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
      if ('rotation' in sn) (sn as any).rotation = params.rotation;
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
