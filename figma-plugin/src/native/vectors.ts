import { serialize, resolve, resolveScene } from "./utils";
import { applyCommonSceneProps } from "./create";

interface PathPoint {
  command: "M" | "L" | "C" | "Q" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

/** Turns the declarative point list into Figma's SVG-ish path data string. */
export function pathToData(path: PathPoint[]): string {
  let data = "";
  for (const pt of path) {
    switch (pt.command) {
      case "M":
        data += `M ${pt.x ?? 0} ${pt.y ?? 0} `;
        break;
      case "L":
        data += `L ${pt.x ?? 0} ${pt.y ?? 0} `;
        break;
      case "C":
        data += `C ${pt.x1 ?? 0} ${pt.y1 ?? 0} ${pt.x2 ?? 0} ${pt.y2 ?? 0} ${pt.x ?? 0} ${pt.y ?? 0} `;
        break;
      case "Q":
        data += `Q ${pt.x1 ?? 0} ${pt.y1 ?? 0} ${pt.x ?? 0} ${pt.y ?? 0} `;
        break;
      case "Z":
        data += "Z ";
        break;
    }
  }
  return data.trim();
}

export async function handleVectors(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "createVector": {
      const v = figma.createVector();
      if (params.name) v.name = String(params.name);
      if (params.path) {
        v.vectorPaths = [{ windingRule: "EVENODD", data: pathToData(params.path as PathPoint[]) }];
      }
      const parent = params.parent ? await resolve(params.parent as string) : figma.currentPage;
      if ("appendChild" in parent) (parent as ChildrenMixin).appendChild(v);
      applyCommonSceneProps(v, params);
      return serialize(v);
    }
    case "setPathData": {
      const sn = await resolveScene(target);
      if (sn.type === "VECTOR") {
        (sn as VectorNode).vectorPaths = [{ windingRule: "EVENODD", data: pathToData(params.path as PathPoint[]) }];
      }
      return serialize(sn);
    }
  }
  return null;
}
