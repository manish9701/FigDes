import { serialize, resolve, resolveScene } from "./utils";

export async function handleGeometry(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (action) {
    case "getBounds": {
      const sn = await resolveScene(target);
      return { id: sn.id, x: sn.x, y: sn.y, width: sn.width, height: sn.height };
    }
    case "getAbsoluteBounds": {
      const sn = await resolveScene(target);
      return sn.absoluteBoundingBox;
    }
    case "setPosition": {
      const sn = await resolveScene(target);
      if (params.x !== undefined) sn.x = Number(params.x);
      if (params.y !== undefined) sn.y = Number(params.y);
      return serialize(sn);
    }
    case "setSize": {
      const sn = await resolveScene(target);
      // Figma's resize() needs both axes. A single-axis request keeps the other
      // axis at its current value rather than silently doing nothing.
      const w = params.width !== undefined ? Number(params.width) : sn.width;
      const h = params.height !== undefined ? Number(params.height) : sn.height;
      if (params.width === undefined && params.height === undefined) {
        throw new Error("setSize needs at least one of width or height.");
      }
      if ("resize" in sn) (sn as unknown as { resize: (w: number, h: number) => void }).resize(w, h);
      return serialize(sn);
    }
    case "setBounds": {
      const sn = await resolveScene(target);
      if (params.x !== undefined) sn.x = Number(params.x);
      if (params.y !== undefined) sn.y = Number(params.y);
      const w = params.width !== undefined ? Number(params.width) : sn.width;
      const h = params.height !== undefined ? Number(params.height) : sn.height;
      if ((params.width !== undefined || params.height !== undefined) && "resize" in sn) {
        (sn as unknown as { resize: (w: number, h: number) => void }).resize(w, h);
      }
      return serialize(sn);
    }
    case "setRotation": {
      const sn = await resolveScene(target);
      if ("rotation" in sn) (sn as unknown as LayoutMixin).rotation = Number(params.rotation);
      return serialize(sn);
    }
    case "setCornerRadius": {
      const sn = await resolveScene(target);
      if ("cornerRadius" in sn) (sn as unknown as { cornerRadius: number }).cornerRadius = Number(params.radius);
      return serialize(sn);
    }
    case "setIndividualCornerRadii": {
      const sn = await resolveScene(target);
      if ("topLeftRadius" in sn) {
        const radii = params.radii as number[];
        (sn as unknown as { topLeftRadius: number }).topLeftRadius = radii[0]!;
        (sn as unknown as { topRightRadius: number }).topRightRadius = radii[1]!;
        (sn as unknown as { bottomRightRadius: number }).bottomRightRadius = radii[2]!;
        (sn as unknown as { bottomLeftRadius: number }).bottomLeftRadius = radii[3]!;
      }
      return serialize(sn);
    }
  }
  return null;
}

/** Kept for callers that only need a resolved scene node. */
export { resolve };
