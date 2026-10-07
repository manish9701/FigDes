/**
 * Mechanical colour resolution.
 *
 * Nothing here makes judgement calls: it flattens Figma paint arrays into
 * concrete hex values and composites them down the ancestor chain so the server
 * can do the actual WCAG arithmetic on real numbers rather than guesses.
 */

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FlatColor extends RGBA {
  hex: string;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const byte = (v: number): string =>
  Math.round(clamp01(v) * 255)
    .toString(16)
    .padStart(2, "0");

export function toHex(c: RGBA): string {
  return `#${byte(c.r)}${byte(c.g)}${byte(c.b)}`.toUpperCase();
}

export function fromHex(hex: string, alpha = 1): RGBA {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return { r: 0, g: 0, b: 0, a: alpha };
  let x = m[1]!;
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  const n = parseInt(x, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: alpha };
}

/** White, used as the base when nothing else is painted behind. */
export const WHITE: RGBA = { r: 1, g: 1, b: 1, a: 1 };

/** Source-over composite of `fg` onto opaque `bg`. */
export function composite(fg: RGBA, bg: RGBA): RGBA {
  const a = clamp01(fg.a);
  return {
    r: clamp01(fg.r * a + bg.r * (1 - a)),
    g: clamp01(fg.g * a + bg.g * (1 - a)),
    b: clamp01(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Paints                                                                       */
/* -------------------------------------------------------------------------- */

type PaintHolder = { fills?: unknown; strokes?: unknown; opacity?: number };

/**
 * Flatten one paint array. Only SOLID paints carry a colour; gradients and
 * images are reported as `kind` so the caller knows a real colour was not
 * available instead of silently substituting black.
 */
export function flattenPaints(
  paints: unknown,
  opacity = 1,
): Array<{ hex: string; alpha: number; kind: "solid" | "gradient" | "image" }> {
  if (!Array.isArray(paints) || paints.length === 0) return [];

  const out: Array<{ hex: string; alpha: number; kind: "solid" | "gradient" | "image" }> = [];

  for (const raw of paints) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as { type?: string; color?: RGBA; opacity?: number; visible?: boolean };

    if (p.visible === false) continue;

    if (p.type === "SOLID" && p.color) {
      const alpha = clamp01((p.opacity ?? 1) * opacity);
      out.push({ hex: toHex({ ...p.color, a: alpha }), alpha, kind: "solid" });
    } else if (p.type && p.type.startsWith("GRADIENT")) {
      out.push({ hex: "#000000", alpha: 0, kind: "gradient" });
    } else if (p.type === "IMAGE") {
      out.push({ hex: "#000000", alpha: 0, kind: "image" });
    }
  }

  return out;
}

/**
 * Resolve the colour a viewer actually sees for a node's fill.
 *
 * Walks up the ancestor chain compositing each opaque-enough layer, which is
 * what makes contrast checking meaningful on nested cards.
 */
/**
 * The colour a viewer actually sees BEHIND a node, composited down the
 * ancestor chain.
 *
 * Two details that are easy to get wrong and produce nonsense contrast numbers:
 *
 * - `skipSelf` matters. A TEXT node's own fill is its text colour, so folding
 *   it into "the background" makes every contrast ratio exactly 1:1 and floods
 *   the reviewer with fake criticals. Background must start at the parent.
 * - Compositing order is source-over with the accumulated (nearer) layers on
 *   top, so the new ancestor layer is the backdrop: composite(acc, layer).
 */
export function effectiveFill(node: BaseNode, { skipSelf = false } = {}): FlatColor | null {
  let acc: RGBA | null = null;
  let cursor: BaseNode | null = skipSelf && "parent" in node ? node.parent : node;
  let guard = 0;

  while (cursor && guard++ < 64) {
    const holder = cursor as BaseNode & PaintHolder;
    const layerOpacity = typeof holder.opacity === "number" ? holder.opacity : 1;

    // An invisible node contributes nothing to what is visible behind it.
    if ("visible" in cursor && (cursor as { visible: boolean }).visible === false) break;

    const fills = solidFills(holder.fills, layerOpacity);
    const opaque = fills.find((f) => f.alpha >= 0.999) ?? fills.find((f) => f.alpha >= 0.5);

    if (opaque) {
      const backdrop: RGBA = { ...fromHex(opaque.hex), a: opaque.alpha };
      acc = acc ? composite(acc, backdrop) : backdrop;
      if (acc.a >= 0.999) break;
    }

    cursor = "parent" in cursor ? cursor.parent : null;
  }

  // Nothing painted behind it: white is the honest assumption for a design
  // canvas, and it is a normal outcome for a node directly on the page.
  const resolved = acc ? composite(acc, WHITE) : WHITE;
  return { ...resolved, hex: toHex(resolved) };
}

/**
 * Solid paints only.
 *
 * Layer effects (shadows, blurs) are excluded on purpose. A black 25%-alpha
 * drop shadow is a shadow, not a fill — including it here made every text node
 * inside a card report "#000000", which then composited into a background of
 * near-black and produced a bogus 1:1 contrast ratio against the text colour.
 */
function solidFills(paints: unknown, opacity = 1): Array<{ hex: string; alpha: number }> {
  if (!Array.isArray(paints)) return [];
  const out: Array<{ hex: string; alpha: number }> = [];

  for (const raw of paints) {
    if (!raw || typeof raw !== "object") continue;
    const p = raw as { type?: string; color?: RGBA; opacity?: number; visible?: boolean };
    if (p.visible === false) continue;
    if (p.type !== "SOLID" || !p.color) continue;
    const alpha = clamp01((p.opacity ?? 1) * opacity);
    out.push({ hex: toHex({ ...p.color, a: alpha }), alpha });
  }
  return out;
}

/**
 * The colour a viewer actually sees for a node's own fill, ignoring what is
 * behind it. Used for palette extraction and for text colour.
 */
export function primaryFill(node: BaseNode): FlatColor | null {
  const holder = node as BaseNode & PaintHolder;
  const fills = flattenPaints(holder.fills);
  const first = fills[0];
  return first ? { ...fromHex(first.hex, first.alpha), hex: first.hex } : null;
}

export function primaryStroke(node: BaseNode): { hex: string; alpha: number; weight: number } | null {
  const holder = node as BaseNode & PaintHolder & { strokeWeight?: number | symbol };
  const strokes = flattenPaints(holder.strokes);
  const first = strokes[0];
  if (!first) return null;
  const weight = typeof holder.strokeWeight === "number" ? holder.strokeWeight : 1;
  return { hex: first.hex, alpha: first.alpha, weight };
}

/* -------------------------------------------------------------------------- */
/* Geometry helpers                                                             */
/* -------------------------------------------------------------------------- */

export function cornerRadiusOf(node: BaseNode): number | null {
  const n = node as BaseNode & { cornerRadius?: number | symbol };
  return typeof n.cornerRadius === "number" ? n.cornerRadius : null;
}

export { isDefaultLayerName as isDefaultName } from "../../shared/protocol";