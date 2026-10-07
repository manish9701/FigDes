import { serialize, resolve } from "./utils";

function parseVariantString(input?: string): Record<string, string> {
  if (!input) return {};
  const result: Record<string, string> = {};
  for (const piece of input.split(",")) {
    const [key, ...rest] = piece.split("=");
    if (!key || rest.length === 0) continue;
    result[key.trim()] = rest.join("=").trim();
  }
  return result;
}

export function handleComponents(action: string, target: any, params: any) {
  switch (action) {
    case "createInstance": {
      const source = resolve(params.componentId) as any;
      const component = source.type === "COMPONENT_SET" ? source.defaultVariant : source;
      if (!component || component.type !== "COMPONENT") {
        throw new Error("createInstance requires a COMPONENT or COMPONENT_SET with a default variant.");
      }
      const instance = component.createInstance();
      if (params.name) instance.name = params.name;
      const parent = params.parent ? resolve(params.parent) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Instance parent cannot contain children.");
      (parent as ChildrenMixin).appendChild(instance);
      return serialize(instance);
    }
    case "setVariant": {
      const instance = resolve(target) as any;
      if (instance.type !== "INSTANCE") throw new Error("setVariant requires an INSTANCE target.");
      const properties = params.properties ?? parseVariantString(params.variant);
      if (!properties || Object.keys(properties).length === 0) {
        throw new Error("setVariant requires properties or a variant string.");
      }
      if (typeof instance.setProperties !== "function") {
        throw new Error("This Figma API version does not support instance.setProperties().");
      }
      instance.setProperties(properties);
      return serialize(instance);
    }
    case "getComponentProperties": {
      const instance = resolve(target) as any;
      if (instance.type !== "INSTANCE") throw new Error("getComponentProperties requires an INSTANCE target.");
      return {
        id: instance.id,
        mainComponentId: instance.mainComponent?.id ?? null,
        properties: instance.componentProperties ?? {}
      };
    }
    case "detachInstance": {
      const instance = resolve(target) as any;
      if (instance.type !== "INSTANCE") throw new Error("detachInstance requires an INSTANCE target.");
      return serialize(instance.detachInstance());
    }
    case "listComponents": {
      const nodes = figma.currentPage.findAll((n: any) => n.type === "COMPONENT" || n.type === "COMPONENT_SET");
      return nodes.map((n: any) => ({
        id: n.id,
        name: n.name,
        type: n.type,
        description: n.description ?? "",
        variantCount: n.type === "COMPONENT_SET" ? n.children.length : undefined
      }));
    }
  }
  return null;
}
