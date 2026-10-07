import { serialize, resolve, asScene } from './utils';

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
