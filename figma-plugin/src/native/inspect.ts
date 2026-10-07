import { serialize, resolve } from "./utils";
import { inspectNodes, DEFAULT_INSPECT } from "../inspector";

export async function handleInspect(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "find": {
      const query = params.query as { name?: string; type?: string; text?: string };
      const root = params.root ? await resolve(params.root as string) : figma.currentPage;
      if (!("findAll" in root)) return [];
      const nodes = (root as PageNode).findAll((n) => {
        if (query.name && !n.name.includes(query.name)) return false;
        if (query.type && n.type !== query.type) return false;
        if (query.text && n.type === "TEXT" && !String((n as TextNode).characters ?? "").toLowerCase().includes(query.text.toLowerCase())) {
          return false;
        }
        return true;
      });
      return nodes.map((n) => serialize(n, { detail: "summary" }));
    }

    case "getSelection":
      return figma.currentPage.selection.map((n) => serialize(n, { detail: "summary" }));

    case "setSelection": {
      const ids = params.nodeIds as string[];
      const nodes = await Promise.all(ids.map((id) => resolve(id)));
      figma.currentPage.selection = nodes.map((n) => n as SceneNode);
      return figma.currentPage.selection.map((n) => serialize(n, { detail: "summary" }));
    }

    case "getNode":
      return serialize(await resolve(target));

    case "getChildren": {
      const node = await resolve(target);
      if (!("children" in node)) return [];
      return (node as ChildrenMixin).children.map((c) => serialize(c as SceneNode, { detail: "summary" }));
    }

    case "getParent": {
      const node = await resolve(target);
      if (!node.parent) return null;
      return serialize(node.parent, { detail: "summary" });
    }

    case "inspect": {
      const node = await resolve(target);
      const opts = {
        depth: typeof params.depth === "number" ? params.depth : DEFAULT_INSPECT.depth,
        includeText: params.includeText !== false,
        budget: typeof params.budget === "number" ? params.budget : DEFAULT_INSPECT.budget,
      };
      if (node.type === "PAGE" || node.type === "DOCUMENT") {
        const children = ("children" in node ? (node as PageNode).children : []) as SceneNode[];
        const r = inspectNodes(children, opts);
        return { node: serialize(node), children: r.selection, truncated: r.truncated };
      }
      const r = inspectNodes([node as SceneNode], opts);
      return { node: serialize(node, { detail: "summary" }), tree: r.selection[0], truncated: r.truncated };
    }
  }
  return null;
}
