import { handleCreate } from './create';
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

    throw new Error(`Unknown native action: ${action}`);
  } catch (err: any) {
    throw new Error(`Native execution failed: ${err.message}`);
  }
}
