import { serialize, resolve, asScene } from "./utils";

export function handleCreate(action: string, params: any) {
  switch (action) {
    case "createFrame":
    case "createRectangle":
    case "createEllipse":
    case "createPolygon":
    case "createStar":
    case "createLine": {
      const factory: Record<string, () => SceneNode> = {
        createFrame: () => figma.createFrame(),
        createRectangle: () => figma.createRectangle(),
        createEllipse: () => figma.createEllipse(),
        createPolygon: () => figma.createPolygon(),
        createStar: () => figma.createStar(),
        createLine: () => figma.createLine(),
      };
      const node = factory[action]();
      if (params.name) node.name = params.name;
      if (params.width !== undefined && params.height !== undefined) node.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Parent cannot contain children.");
      (parent as ChildrenMixin).appendChild(node);
      return serialize(node);
    }
    case "createGroup": {
      const children = (params.children || []).map(resolve).map(asScene);
      if (children.length === 0) throw new Error("Cannot create empty group.");
      const parent = params.parent ? resolve(params.parent) : children[0]?.parent ?? figma.currentPage;
      if (!parent || !("appendChild" in parent)) throw new Error("Group parent cannot contain children.");
      const group = figma.group(children, parent as ChildrenMixin);
      if (params.name) group.name = params.name;
      return serialize(group);
    }
    case "createComponent": {
      const comp = figma.createComponent();
      if (params.name) comp.name = params.name;
      if (params.width !== undefined && params.height !== undefined) comp.resize(params.width, params.height);
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Component parent cannot contain children.");
      (parent as ChildrenMixin).appendChild(comp);
      return serialize(comp);
    }
  }
  return null;
}
