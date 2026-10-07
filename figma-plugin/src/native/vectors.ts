import { serialize, resolve, asScene } from './utils';

export function handleVectors(action: string, target: any, params: any) {
  switch(action) {
    case 'createVector': {
      const v = figma.createVector();
      if (params.name) v.name = params.name;
      if (params.path) {
        let data = '';
        for (const pt of params.path) {
           if (pt.command === 'M') data += `M ${pt.x} ${pt.y} `;
           if (pt.command === 'L') data += `L ${pt.x} ${pt.y} `;
           if (pt.command === 'C') data += `C ${pt.x1} ${pt.y1} ${pt.x2} ${pt.y2} ${pt.x} ${pt.y} `;
           if (pt.command === 'Q') data += `Q ${pt.x1} ${pt.y1} ${pt.x} ${pt.y} `;
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
           if (pt.command === 'M') data += `M ${pt.x} ${pt.y} `;
           if (pt.command === 'L') data += `L ${pt.x} ${pt.y} `;
           if (pt.command === 'C') data += `C ${pt.x1} ${pt.y1} ${pt.x2} ${pt.y2} ${pt.x} ${pt.y} `;
           if (pt.command === 'Q') data += `Q ${pt.x1} ${pt.y1} ${pt.x} ${pt.y} `;
           if (pt.command === 'Z') data += 'Z ';
        }
        (sn as any).vectorPaths = [{ windingRule: 'EVENODD', data }];
      }
      return serialize(sn);
    }
  }
  return null;
}
