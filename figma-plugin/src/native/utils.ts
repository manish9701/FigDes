/**
 * Node resolution and bounded serialization for the native API.
 *
 * Two things matter here:
 *
 * 1. Resolution is **async**. The manifest runs with
 *    `documentAccess: "dynamic-page"`, where the synchronous `figma.getNodeById`
 *    throws. The native layer used it anyway, so every native call that touched
 *    an existing node failed on a real file. `getNodeByIdAsync` is the only
 *    correct accessor.
 *
 * 2. Serialization is **rich but bounded**. Returning `{id,type,name,x,y,width,
 *    height}` tells the agent almost nothing about a node it just made. The
 *    summary now carries layout, paints, styles, text and component state, with
 *    every property read behind a guard (mixed values and dynamic-page getters
 *    throw) and long text truncated.
 */
import type { InspectedNode } from "../../../shared/protocol";

export async function resolve(id?: string | null): Promise<BaseNode> {
  if (!id || id === "page") return figma.currentPage;
  let node: BaseNode | null = null;
  try {
    node = await figma.getNodeByIdAsync(id);
  } catch {
    node = null;
  }
  if (!node) throw new Error(`Node ${id} not found`);
  return node;
}

export function asScene(n: BaseNode): SceneNode {
  if (n.type === "PAGE" || n.type === "DOCUMENT") throw new Error("Expected a SceneNode");
  return n as SceneNode;
}

export async function resolveScene(id?: string | null): Promise<SceneNode> {
  return asScene(await resolve(id));
}

/* -------------------------------------------------------------------------- */
/* Safe reads                                                                  */
/* -------------------------------------------------------------------------- */

/** Reads a property that may throw (mixed values, dynamic-page getters). */
export function safe<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Parses `#RGB`, `#RRGGBB` or `#RRGGBBAA` into a Figma RGB(A) colour.
 *
 * Returns null for anything unrecognised rather than guessing, so a bad colour
 * becomes "no fill" instead of silently becoming black.
 */
export function hexToRgb(hex: string): { r: number; g: number; b: number; a: number } | null {
  const raw = hex.trim().replace(/^#/, "");
  const expand = (s: string): string => s.split("").map((c) => c + c).join("");
  let body = raw;
  if (body.length === 3) body = expand(body);
  if (body.length !== 6 && body.length !== 8) return null;
  if (!/^[0-9a-fA-F]+$/.test(body)) return null;
  const n = parseInt(body.slice(0, 6), 16);
  const a = body.length === 8 ? parseInt(body.slice(6, 8), 16) / 255 : 1;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
}

/**
 * Coerces model paint input into real Figma `Paint` objects.
 *
 * The native API accepts the friendly forms an agent naturally writes — a hex
 * string, an array of them, or a paint object — but the Plugin API only accepts
 * `Paint` objects. Assigning a raw string to `fills` throws on a real file, so
 * every paint assignment goes through here.
 */
export function toPaints(value: unknown): Paint[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v) => toPaints(v));
  if (typeof value === "string") {
    const rgb = hexToRgb(value);
    return rgb ? [{ type: "SOLID", color: { r: rgb.r, g: rgb.g, b: rgb.b }, opacity: rgb.a }] : [];
  }
  if (typeof value === "object") {
    const paint = value as Record<string, unknown>;
    // Normalise `{ type: "SOLID", color: "#fff" }` into Figma's RGB form.
    if (paint.type === "SOLID" && typeof paint.color === "string") {
      const rgb = hexToRgb(paint.color);
      if (!rgb) return [];
      return [
        {
          type: "SOLID",
          color: { r: rgb.r, g: rgb.g, b: rgb.b },
          opacity: typeof paint.opacity === "number" ? (paint.opacity as number) : rgb.a,
        },
      ];
    }
    return [value as Paint];
  }
  return [];
}

function toHex(color: { r: number; g: number; b: number }): string {
  const part = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** A paint reduced to what an agent can reason about, without the noise. */
export function paintSummary(paint: unknown): unknown {
  if (paint === null || typeof paint !== "object") return paint ?? null;
  const p = paint as Record<string, unknown>;
  const out: Record<string, unknown> = { type: p.type };
  if (p.type === "SOLID" && p.color && typeof p.color === "object") {
    const c = p.color as { r: number; g: number; b: number };
    out.color = toHex(c);
  }
  if (typeof p.opacity === "number") out.opacity = p.opacity;
  if (p.visible === false) out.visible = false;
  if (typeof p.type === "string" && p.type.startsWith("GRADIENT")) {
    out.gradientStops = safe(() => (p.gradientStops as unknown[]).length, 0);
  }
  if (p.type === "IMAGE") out.imageHash = p.imageHash ?? null;
  return out;
}

function styleIds(node: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of ["fillStyleId", "strokeStyleId", "textStyleId", "effectStyleId"]) {
    const v = safe(() => node[key], "");
    if (typeof v === "string" && v.length > 0) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

const MAX_TEXT = 240;

export interface SerializeOptions {
  /** "summary" omits paints, effects and text details; "full" (default) includes them. */
  detail?: "summary" | "full";
}

export function serialize(n: BaseNode, opts: SerializeOptions = {}): Record<string, unknown> {
  const detail = opts.detail ?? "full";

  if (n.type === "PAGE" || n.type === "DOCUMENT") {
    return {
      id: n.id,
      type: n.type,
      name: n.name,
      childCount: safe(() => ("children" in n ? (n as PageNode).children.length : 0), 0),
    };
  }

  const sn = n as SceneNode;
  const out: Record<string, unknown> = { id: sn.id, type: sn.type, name: sn.name };

  out.x = round(sn.x);
  out.y = round(sn.y);
  out.width = round(sn.width);
  out.height = round(sn.height);

  if ("rotation" in sn) out.rotation = safe(() => (sn as LayoutMixin).rotation, 0);
  if ("visible" in sn) out.visible = safe(() => (sn as SceneNode).visible, true);
  if ("opacity" in sn) out.opacity = safe(() => (sn as unknown as { opacity: number }).opacity, 1);
  if ("blendMode" in sn) out.blendMode = safe(() => (sn as BlendMixin).blendMode, "PASS_THROUGH");
  if ("isMask" in sn) out.isMask = safe(() => (sn as SceneNode & { isMask: boolean }).isMask, false);
  if ("children" in sn) out.childCount = safe(() => (sn as ChildrenMixin).children.length, 0);

  if ("layoutMode" in sn && safe(() => (sn as FrameNode).layoutMode, "NONE") !== "NONE") {
    const f = sn as FrameNode;
    out.layoutMode = safe(() => f.layoutMode, "NONE");
    out.itemSpacing = safe(() => f.itemSpacing, 0);
    out.padding = safe(
      () => ({ top: f.paddingTop, right: f.paddingRight, bottom: f.paddingBottom, left: f.paddingLeft }),
      undefined,
    );
    out.primaryAxisSizingMode = safe(() => f.primaryAxisSizingMode, undefined);
    out.counterAxisSizingMode = safe(() => f.counterAxisSizingMode, undefined);
    out.primaryAxisAlignItems = safe(() => f.primaryAxisAlignItems, undefined);
    out.counterAxisAlignItems = safe(() => f.counterAxisAlignItems, undefined);
    out.layoutWrap = safe(() => f.layoutWrap, undefined);
  }
  if ("clipsContent" in sn) out.clipsContent = safe(() => (sn as FrameNode).clipsContent, false);
  if ("constraints" in sn) out.constraints = safe(() => (sn as SceneNode & { constraints: unknown }).constraints, undefined);
  if ("cornerRadius" in sn) {
    const r = safe(() => (sn as SceneNode & { cornerRadius: unknown }).cornerRadius, undefined);
    if (typeof r === "number") out.cornerRadius = r;
  }

  if (detail === "full") {
    if ("fills" in sn) {
      const fills = safe(() => (sn as GeometryMixin).fills, [] as readonly Paint[]);
      out.fills = Array.isArray(fills) ? fills.map(paintSummary) : "mixed";
    }
    if ("strokes" in sn) {
      const strokes = safe(() => (sn as GeometryMixin).strokes, [] as readonly Paint[]);
      out.strokes = Array.isArray(strokes) ? strokes.map(paintSummary) : "mixed";
    }
    if ("strokeWeight" in sn) out.strokeWeight = safe(() => (sn as GeometryMixin).strokeWeight, undefined);
    if ("strokeAlign" in sn) out.strokeAlign = safe(() => (sn as GeometryMixin).strokeAlign, undefined);
    if ("dashPattern" in sn) out.dashPattern = safe(() => (sn as GeometryMixin).dashPattern, []);
    if ("effects" in sn) {
      const effects = safe(() => (sn as BlendMixin).effects, [] as readonly Effect[]);
      out.effects = Array.isArray(effects)
        ? effects.map((e) => ({ type: e.type, visible: e.visible, radius: "radius" in e ? e.radius : undefined }))
        : "mixed";
    }
    const ids = styleIds(sn as unknown as Record<string, unknown>);
    if (ids) out.styleIds = ids;
  }

  if (sn.type === "TEXT") {
    const t = sn as TextNode;
    const chars = safe(() => t.characters, "");
    out.characters = chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT)}…` : chars;
    out.fontSize = safe(() => (typeof t.fontSize === "number" ? t.fontSize : "mixed"), "mixed");
    out.fontName = safe(() => {
      const fn = t.fontName as unknown;
      if (fn && typeof fn === "object" && "family" in fn) {
        const named = fn as FontName;
        return `${named.family} ${named.style}`;
      }
      return "mixed";
    }, "mixed");
    if (detail === "full") {
      out.textAlignHorizontal = safe(() => t.textAlignHorizontal, undefined);
      out.textAlignVertical = safe(() => t.textAlignVertical, undefined);
      out.textAutoResize = safe(() => t.textAutoResize, undefined);
      out.textCase = safe(() => t.textCase, undefined);
      out.textDecoration = safe(() => t.textDecoration, undefined);
      out.lineHeight = safe(() => t.lineHeight, undefined);
      out.letterSpacing = safe(() => t.letterSpacing, undefined);
    }
  }

  if (sn.type === "INSTANCE") {
    const i = sn as InstanceNode;
    // `.mainComponent` throws under dynamic-page; the async accessor is used by
    // the getComponentProperties action instead. Here it degrades to null.
    out.mainComponentId = safe(() => (i as unknown as { mainComponent: { id: string } }).mainComponent.id, null);
    out.variantProperties = safe(() => (i as InstanceNode & { variantProperties?: unknown }).variantProperties ?? null, null);
  }
  if (sn.type === "COMPONENT") {
    const c = sn as ComponentNode;
    out.description = safe(() => c.description, "");
    out.key = safe(() => c.key, undefined);
    out.propertyDefinitions = safe(() => Object.keys(c.componentPropertyDefinitions ?? {}), []);
  }
  if (sn.type === "COMPONENT_SET") {
    const set = sn as ComponentSetNode;
    out.description = safe(() => set.description, "");
    out.variantCount = safe(() => set.children.length, 0);
  }

  if (detail === "full") {
    const bb = safe(() => (sn as SceneNode).absoluteBoundingBox, null);
    if (bb) out.absoluteBoundingBox = { x: round(bb.x), y: round(bb.y), width: round(bb.width), height: round(bb.height) };
  }

  return out;
}

/** Re-exported so context.ts and inspect.ts share one node shape. */
export type { InspectedNode };

/* -------------------------------------------------------------------------- */
/* Batch-local node references                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Resolves `$ref` local references inside a batch operation's arguments.
 *
 * A batch stores newly created node ids under caller-chosen names (`ref`), and
 * later operations address them as `"$name"` strings or `{ $ref: "name" }`
 * objects — without another RPC round-trip to resolve the Figma id. Unknown
 * `$`-names pass through untouched so a literal string is never rewritten; the
 * subsequent resolve then fails loudly with the batch index attached.
 */
export function resolveBatchRefs(value: unknown, refs: Map<string, string>): unknown {
  if (typeof value === "string") {
    if (value.startsWith("$") && value.length > 1) {
      const hit = refs.get(value.slice(1));
      if (hit !== undefined) return hit;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => resolveBatchRefs(v, refs));
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o.$ref === "string") {
      const hit = refs.get(o.$ref);
      if (hit === undefined) throw new Error(`Unknown batch ref '${o.$ref}'. Declare it with ref on an earlier operation.`);
      return hit;
    }
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = resolveBatchRefs(o[k], refs);
    return out;
  }
  return value;
}
