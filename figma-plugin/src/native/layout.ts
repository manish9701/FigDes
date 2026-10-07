import { serialize, resolve, resolveScene, hexToRgb } from "./utils";

export async function handleLayout(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "setAutoLayout": {
      const sn = await resolveScene(target);
      if ("layoutMode" in sn) {
        const f = sn as FrameNode;
        if (params.direction) f.layoutMode = params.direction as FrameNode["layoutMode"];
        if (params.primaryAxisSizing) f.primaryAxisSizingMode = params.primaryAxisSizing as FrameNode["primaryAxisSizingMode"];
        if (params.counterAxisSizing) f.counterAxisSizingMode = params.counterAxisSizing as FrameNode["counterAxisSizingMode"];
        if (params.primaryAxisAlignItems) f.primaryAxisAlignItems = params.primaryAxisAlignItems as FrameNode["primaryAxisAlignItems"];
        if (params.counterAxisAlignItems) f.counterAxisAlignItems = params.counterAxisAlignItems as FrameNode["counterAxisAlignItems"];
        if (params.itemSpacing !== undefined) f.itemSpacing = Number(params.itemSpacing);
        if (params.paddingTop !== undefined) f.paddingTop = Number(params.paddingTop);
        if (params.paddingRight !== undefined) f.paddingRight = Number(params.paddingRight);
        if (params.paddingBottom !== undefined) f.paddingBottom = Number(params.paddingBottom);
        if (params.paddingLeft !== undefined) f.paddingLeft = Number(params.paddingLeft);
        if (params.layoutWrap !== undefined) f.layoutWrap = params.layoutWrap as FrameNode["layoutWrap"];
        if (params.counterAxisAlignContent !== undefined) {
          f.counterAxisAlignContent = params.counterAxisAlignContent as FrameNode["counterAxisAlignContent"];
        }
      }
      return serialize(sn);
    }
    case "setClipContent": {
      const sn = await resolveScene(target);
      if ("clipsContent" in sn) (sn as FrameNode).clipsContent = Boolean(params.value);
      return serialize(sn);
    }
    case "setConstraints": {
      const sn = await resolveScene(target);
      if ("constraints" in sn) {
        (sn as unknown as { constraints: unknown }).constraints = params.constraints;
      }
      return serialize(sn);
    }
    case "clone": {
      const sn = await resolveScene(target);
      const cloned = sn.clone();
      if (params.x !== undefined) cloned.x = Number(params.x);
      if (params.y !== undefined) cloned.y = Number(params.y);
      if (params.parent) {
        const parent = await resolve(params.parent as string);
        if ("appendChild" in parent) (parent as ChildrenMixin).appendChild(cloned);
      }
      return serialize(cloned);
    }
    case "remove": {
      const sn = await resolveScene(target);
      sn.remove();
      return { status: "removed", id: sn.id };
    }
    case "append": {
      const parent = target ? await resolve(target) : figma.currentPage;
      const child = await resolveScene(params.child as string);
      if ("appendChild" in parent) (parent as ChildrenMixin).appendChild(child);
      return serialize(child);
    }
    case "rename": {
      const sn = await resolveScene(target);
      sn.name = String(params.name);
      return serialize(sn, { detail: "summary" });
    }
    case "insertChild": {
      const parent = target ? await resolve(target) : figma.currentPage;
      const child = await resolveScene(params.child as string);
      if ("insertChild" in parent) (parent as ChildrenMixin).insertChild(Number(params.index), child);
      return serialize(child);
    }
    case "setLayoutGrid": {
      const sn = await resolveScene(target);
      if (!("layoutGrids" in sn)) throw new Error(`${sn.type} does not support layout grids. Target a frame or component.`);
      const pattern = String(params.pattern ?? "COLUMNS") as "COLUMNS" | "ROWS" | "GRID";
      const holder = sn as SceneNode & { layoutGrids: LayoutGrid[] };
      const grid: LayoutGrid =
        pattern === "GRID"
          ? {
              pattern: "GRID",
              sectionSize: typeof params.sectionSize === "number" ? params.sectionSize : 8,
              visible: params.visible === true,
            }
          : {
              pattern,
              alignment: "STRETCH",
              gutterSize: typeof params.gutter === "number" ? params.gutter : 24,
              count: typeof params.count === "number" ? params.count : 12,
              ...(typeof params.offset === "number" ? { offset: params.offset } : {}),
              visible: params.visible === true,
            };
      if (typeof params.color === "string") {
        const rgb = hexToRgb(params.color);
        if (!rgb) throw new Error(`Unrecognized grid color: ${params.color}.`);
        (grid as { color?: RGBA }).color = { r: rgb.r, g: rgb.g, b: rgb.b, a: rgb.a };
      }
      holder.layoutGrids = [...(holder.layoutGrids ?? []), grid];
      return serialize(sn, { detail: "summary" });
    }
  }
  return null;
}
