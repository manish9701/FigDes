/**
 * Text measurement.
 *
 * ## Why this exists
 *
 * The server lays a screen out from *estimates*: a character-count heuristic
 * for how many lines a string takes, and a table for how tall each primitive
 * is. Those numbers are close enough to place a screen, and nowhere near
 * close enough to be the truth — a string of 40 characters in Inter at 14px is
 * 300-something pixels wide, and the heuristic says something else. The
 * consequence is that a screen's *dry run* and the screen Figma actually
 * builds disagree, and the disagreement is invisible until somebody looks at
 * the result.
 *
 * Figma, on the other hand, knows the truth: it owns the font, the metrics and
 * the layout. So the measurement is asked of Figma, before the layout is
 * computed, and the server lays the screen out with the numbers the renderer
 * will actually use.
 *
 * The measurement is a read: a text node is created, measured and removed
 * again, and nothing is left in the document.
 */
import { loadFont } from "./operations";

export interface TextMeasureSpec {
  /** The caller's key, so the answer can be paired with the request. */
  key: string;
  text: string;
  family: string;
  style: string;
  size: number;
  /** The width the text wraps at, when it wraps. */
  width?: number;
  letterSpacing?: number;
  lineHeight?: number;
}

export interface TextMeasurement {
  key: string;
  width: number;
  height: number;
  /** True when Figma truncated the text rather than wrapping it. */
  truncated: boolean;
}

export interface MeasureTextResult {
  measurements: TextMeasurement[];
  /** The specs that could not be measured, and why. */
  failed: Array<{ key: string; reason: string }>;
}

const MAX_SPECS = 400;

export async function measureText(payload: unknown): Promise<MeasureTextResult> {
  const raw = (payload as { specs?: unknown })?.specs;
  const specs: TextMeasureSpec[] = Array.isArray(raw) ? (raw as TextMeasureSpec[]).slice(0, MAX_SPECS) : [];

  const measurements: TextMeasurement[] = [];
  const failed: Array<{ key: string; reason: string }> = [];

  for (const spec of specs) {
    if (typeof spec?.key !== "string" || typeof spec?.text !== "string") {
      failed.push({ key: String(spec?.key ?? "?"), reason: "the spec has no key or no text" });
      continue;
    }
    const size = typeof spec.size === "number" && spec.size > 0 ? spec.size : 16;
    let node: TextNode | null = null;
    try {
      const font = await loadFont(spec.family ?? "Inter", spec.style ?? "Regular");
      node = figma.createText();
      node.fontName = font;
      node.fontSize = size;
      if (spec.letterSpacing !== undefined) node.letterSpacing = { unit: "PIXELS", value: spec.letterSpacing };
      if (spec.lineHeight !== undefined) node.lineHeight = { unit: "PIXELS", value: spec.lineHeight };
      node.characters = spec.text;
      if (typeof spec.width === "number" && spec.width > 0) {
        // The same setting the build uses: wrap at the width, grow downwards.
        node.textAutoResize = "HEIGHT";
        node.resize(spec.width, node.height);
      } else {
        node.textAutoResize = "WIDTH_AND_HEIGHT";
      }
      measurements.push({
        key: spec.key,
        width: Math.round(node.width * 100) / 100,
        height: Math.round(node.height * 100) / 100,
        // A text that was measured at a width and came back shorter than one
        // line was cut rather than wrapped: Figma keeps the height it was
        // given. The caller asked for a wrap, so the text was clipped.
        truncated: typeof spec.width === "number" && spec.width > 0 && node.height < size * 1.5,
      });
    } catch (err) {
      failed.push({ key: spec.key, reason: err instanceof Error ? err.message : String(err) });
    } finally {
      // The measurement leaves nothing behind. A read that leaves debris is
      // not a read.
      try {
        node?.remove();
      } catch {
        // The node was never added; nothing to remove.
      }
    }
  }

  return { measurements, failed };
}
