import { serialize, resolveScene, toPaints } from "./utils";

/** The actions this module owns. Checked before resolving a target, so a
 *  targetless action (getPages, createPage) is not mis-resolved here. */
const PAINT_ACTIONS = new Set([
  "setFill",
  "setFills",
  "clearFill",
  "setOpacity",
  "setVisible",
  "setBlendMode",
  "setStroke",
  "setEffects",
]);

export async function handlePaint(
  action: string,
  target: string | undefined,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (!PAINT_ACTIONS.has(action)) return null;
  const sn = await resolveScene(target);

  switch (action) {
    case "setFill":
      if ("fills" in sn) (sn as unknown as { fills: Paint[] }).fills = toPaints(params.paint);
      return serialize(sn);
    case "setFills":
      if ("fills" in sn) (sn as unknown as { fills: Paint[] }).fills = toPaints(params.paints);
      return serialize(sn);
    case "clearFill":
      if ("fills" in sn) (sn as unknown as { fills: Paint[] }).fills = [];
      return serialize(sn);
    case "setOpacity":
      if ("opacity" in sn) (sn as unknown as { opacity: number }).opacity = Number(params.opacity);
      return serialize(sn);
    case "setVisible":
      if ("visible" in sn) (sn as SceneNode).visible = Boolean(params.visible);
      return serialize(sn);
    case "setBlendMode":
      if ("blendMode" in sn) (sn as BlendMixin).blendMode = params.mode as BlendMixin["blendMode"];
      return serialize(sn);
    case "setStroke": {
      if ("strokes" in sn) {
        const g = sn as GeometryMixin;
        if (params.paints) g.strokes = toPaints(params.paints);
        if (params.weight !== undefined) g.strokeWeight = Number(params.weight);
        if (params.align !== undefined) g.strokeAlign = params.align as GeometryMixin["strokeAlign"];
        if (params.dashPattern !== undefined) g.dashPattern = params.dashPattern as number[];
        if (params.cap !== undefined) g.strokeCap = params.cap as GeometryMixin["strokeCap"];
        if (params.join !== undefined) g.strokeJoin = params.join as GeometryMixin["strokeJoin"];
      }
      return serialize(sn);
    }
    case "setEffects":
      if ("effects" in sn) (sn as BlendMixin).effects = params.effects as readonly Effect[];
      return serialize(sn);
  }
  return null;
}
