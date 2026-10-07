import { serialize, resolve, resolveScene } from "./utils";
import { applyCommonSceneProps } from "./create";

interface PathPoint {
  command: "M" | "L" | "H" | "V" | "C" | "S" | "Q" | "T" | "A" | "Z";
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  rx?: number;
  ry?: number;
  rotation?: number;
  largeArc?: boolean;
  sweep?: boolean;
}

/**
 * Turns the declarative point list into Figma's SVG-ish path data string.
 *
 * S/T smooth curves are elevated to explicit C/Q with reflected controls, and
 * H/V shorthands become L, so the emitted grammar is the M/L/C/Q/A/Z subset
 * Figma's VectorNode accepts.
 */
export function pathToData(path: PathPoint[]): string {
  let data = "";
  let cx = 0;
  let cy = 0;
  let pc2x: number | null = null;
  let pc2y: number | null = null;
  let pqx: number | null = null;
  let pqy: number | null = null;
  for (const pt of path) {
    switch (pt.command) {
      case "M":
        cx = pt.x ?? 0;
        cy = pt.y ?? 0;
        data += `M ${cx} ${cy} `;
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
      case "L":
        cx = pt.x ?? 0;
        cy = pt.y ?? 0;
        data += `L ${cx} ${cy} `;
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
      case "H":
        cx = pt.x ?? cx;
        data += `L ${cx} ${cy} `;
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
      case "V":
        cy = pt.y ?? cy;
        data += `L ${cx} ${cy} `;
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
      case "C": {
        const x1 = pt.x1 ?? cx;
        const y1 = pt.y1 ?? cy;
        const x2 = pt.x2 ?? cx;
        const y2 = pt.y2 ?? cy;
        cx = pt.x ?? cx;
        cy = pt.y ?? cy;
        data += `C ${x1} ${y1} ${x2} ${y2} ${cx} ${cy} `;
        pc2x = x2;
        pc2y = y2;
        pqx = pqy = null;
        break;
      }
      case "S": {
        const x1 = pc2x !== null ? 2 * cx - pc2x : cx;
        const y1 = pc2y !== null ? 2 * cy - pc2y : cy;
        const x2 = pt.x2 ?? cx;
        const y2 = pt.y2 ?? cy;
        cx = pt.x ?? cx;
        cy = pt.y ?? cy;
        data += `C ${x1} ${y1} ${x2} ${y2} ${cx} ${cy} `;
        pc2x = x2;
        pc2y = y2;
        pqx = pqy = null;
        break;
      }
      case "Q": {
        const x1 = pt.x1 ?? cx;
        const y1 = pt.y1 ?? cy;
        cx = pt.x ?? cx;
        cy = pt.y ?? cy;
        data += `Q ${x1} ${y1} ${cx} ${cy} `;
        pqx = x1;
        pqy = y1;
        pc2x = pc2y = null;
        break;
      }
      case "T": {
        const x1: number = pqx !== null ? 2 * cx - pqx : cx;
        const y1: number = pqy !== null ? 2 * cy - pqy : cy;
        cx = pt.x ?? cx;
        cy = pt.y ?? cy;
        data += `Q ${x1} ${y1} ${cx} ${cy} `;
        pqx = x1;
        pqy = y1;
        pc2x = pc2y = null;
        break;
      }
      case "A":
        cx = pt.x ?? cx;
        cy = pt.y ?? cy;
        data += `A ${pt.rx ?? 0} ${pt.ry ?? 0} ${pt.rotation ?? 0} ${pt.largeArc ? 1 : 0} ${pt.sweep ? 1 : 0} ${cx} ${cy} `;
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
      case "Z":
        data += "Z ";
        pc2x = pc2y = null;
        pqx = pqy = null;
        break;
    }
  }
  return data.trim();
}

/** Structural read-out of a vector node for inspect-before-revision. */
function describeVector(node: VectorNode): Record<string, unknown> {
  const paths = node.vectorPaths ?? [];
  let curveCount = 0;
  for (const p of paths) {
    const d = p.data;
    for (let i = 0; i < d.length; i++) {
      const ch = d[i];
      if (ch === "C" || ch === "Q") curveCount += 1;
    }
  }
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    x: Math.round(node.x * 100) / 100,
    y: Math.round(node.y * 100) / 100,
    width: Math.round(node.width * 100) / 100,
    height: Math.round(node.height * 100) / 100,
    subpaths: paths.map((p) => ({ windingRule: p.windingRule, data: p.data.slice(0, 2000) })),
    subpathCount: paths.length,
    curveCount,
    fills: "fills" in node ? (node.fills as unknown) : undefined,
    strokes: "strokes" in node ? (node.strokes as unknown) : undefined,
    strokeWeight: "strokeWeight" in node ? (node as VectorNode).strokeWeight : undefined,
  };
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
    case "getVectorPath": {
      const sn = await resolveScene(target);
      if (sn.type !== "VECTOR") throw new Error(`getVectorPath requires a VECTOR node, got ${sn.type}`);
      return describeVector(sn as VectorNode);
    }
    case "booleanOperation": {
      const operation = String(params.operation ?? "union") as "union" | "subtract" | "intersect" | "exclude";
      const ids = (params.targets as string[] | undefined) ?? [];
      if (ids.length < 2) throw new Error("booleanOperation needs at least two target ids.");
      const nodes: SceneNode[] = [];
      for (const id of ids) {
        const n = (await resolve(id)) as SceneNode;
        nodes.push(n);
      }
      const firstParent = nodes[0]!.parent;
      for (const n of nodes.slice(1)) {
        if (n.parent !== firstParent) throw new Error("All boolean targets must share a parent.");
      }
      const api = figma as unknown as Record<string, ((nodes: SceneNode[], parent: ChildrenMixin & BaseNode) => BooleanOperationNode) | undefined>;
      const fn = api[operation];
      if (typeof fn !== "function") throw new Error(`This Figma version does not expose boolean '${operation}'.`);
      const parentNode = (params.parent ? await resolve(params.parent as string) : firstParent ?? figma.currentPage) as ChildrenMixin & BaseNode;
      const result = (fn as (nodes: SceneNode[], parent: ChildrenMixin & BaseNode) => BooleanOperationNode).bind(figma)(nodes, parentNode);
      if (params.name) result.name = String(params.name);
      return serialize(result);
    }
    case "outlineStroke": {
      const sn = await resolveScene(target);
      if (!("outlineStroke" in sn) || typeof (sn as VectorNode).outlineStroke !== "function") {
        throw new Error(`${sn.type} does not support outlineStroke in this Figma version.`);
      }
      const outlined = (sn as VectorNode).outlineStroke();
      if (!outlined) throw new Error("outlineStroke produced no geometry: the node may have no stroke.");
      if (params.name) outlined.name = String(params.name);
      return serialize(outlined);
    }
    case "mirrorNode": {
      const sn = await resolveScene(target);
      const axis = String(params.axis ?? "vertical");
      if ("relativeTransform" in sn) {
        const node = sn as SceneNode & { relativeTransform: [[number, number, number], [number, number, number]]; width: number; height: number; x: number; y: number };
        if (axis === "vertical") {
          node.relativeTransform = [[-1, 0, node.x * 2 + node.width], [0, 1, 0]];
        } else {
          node.relativeTransform = [[1, 0, 0], [0, -1, node.y * 2 + node.height]];
        }
      }
      return serialize(sn);
    }
  }
  return null;
}
