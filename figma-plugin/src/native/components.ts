import { serialize, resolve, asScene } from "./utils";
import { allPages } from "../cache";

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

export async function handleComponents(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "createInstance": {
      const source = (await resolve(params.componentId as string)) as unknown as {
        type: string;
        defaultVariant?: ComponentNode;
        createInstance?: () => InstanceNode;
      };
      const component = source.type === "COMPONENT_SET" ? source.defaultVariant : (source as unknown as ComponentNode);
      if (!component || component.type !== "COMPONENT") {
        throw new Error("createInstance requires a COMPONENT or COMPONENT_SET with a default variant.");
      }
      const instance = component.createInstance();
      if (params.name) instance.name = String(params.name);
      const parent = params.parent ? await resolve(params.parent as string) : figma.currentPage;
      if (!("appendChild" in parent)) throw new Error("Instance parent cannot contain children.");
      (parent as ChildrenMixin).appendChild(instance);
      if (params.x !== undefined) instance.x = Number(params.x);
      if (params.y !== undefined) instance.y = Number(params.y);
      return serialize(instance);
    }

    case "setVariant": {
      const instance = (await resolve(target)) as InstanceNode;
      if (instance.type !== "INSTANCE") throw new Error("setVariant requires an INSTANCE target.");
      const properties = (params.properties as Record<string, string> | undefined) ?? parseVariantString(params.variant as string | undefined);
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
      const instance = (await resolve(target)) as InstanceNode;
      if (instance.type !== "INSTANCE") throw new Error("getComponentProperties requires an INSTANCE target.");
      // dynamic-page: the sync `.mainComponent` throws, the async accessor works.
      const main = await instance.getMainComponentAsync().catch(() => null);
      return {
        id: instance.id,
        mainComponentId: main?.id ?? null,
        properties: instance.componentProperties ?? {},
        variantProperties: (instance as InstanceNode & { variantProperties?: unknown }).variantProperties ?? null,
      };
    }

    case "detachInstance": {
      const instance = (await resolve(target)) as InstanceNode;
      if (instance.type !== "INSTANCE") throw new Error("detachInstance requires an INSTANCE target.");
      return serialize(instance.detachInstance());
    }

    case "listComponents": {
      await allPages();
      const out: Array<Record<string, unknown>> = [];
      for (const page of figma.root.children) {
        for (const node of page.findAll((n) => n.type === "COMPONENT" || n.type === "COMPONENT_SET")) {
          const n = node as ComponentNode | ComponentSetNode;
          out.push({
            id: n.id,
            name: n.name,
            type: n.type,
            description: n.type === "COMPONENT" ? n.description : (n as ComponentSetNode).description,
            page: page.name,
            variantCount: n.type === "COMPONENT_SET" ? (n as ComponentSetNode).children.length : undefined,
          });
        }
      }
      return out;
    }
  }
  return null;
}

export { asScene };
