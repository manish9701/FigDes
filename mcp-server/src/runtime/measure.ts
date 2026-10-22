/**
 * Measuring the program's text through the plugin.
 *
 * ## The problem this solves
 *
 * The compiler lays a screen out from estimates: a character-count heuristic
 * for how many lines a string takes. That is close enough to place a screen
 * and nowhere near close enough to be the truth, and the difference is not
 * theoretical — it is the difference between a dry run that agrees with the
 * screen Figma builds and one that does not.
 *
 * Figma owns the font, the metrics and the layout, so the measurement is asked
 * of Figma: a text node is created at the width the layout resolved, measured,
 * and removed again. Nothing is left in the document.
 *
 * ## The order of the two passes
 *
 * 1. Compile with the estimates. The point of this pass is the *widths*: the
 *    column a text lands in depends on the region's size, and the region's
 *    size depends on the content's heights.
 * 2. Measure the text at those widths.
 * 3. Compile again with the measurements. The heights are now the truth, so the
 *    rows, the columns and the positions follow from real numbers.
 *
 * The second pass can shift a column width slightly, because a row is now as
 * tall as the text really is. That is why the caller is told what the
 * measurement changed.
 */
import type { Session } from "../sessions";

export interface TextMeasurement {
  width: number;
  height: number;
}

export interface MeasureOutcome {
  /** The measurements, keyed by the text node's id. */
  metrics: Map<string, TextMeasurement>;
  /** How many text nodes were measured. */
  measured: number;
  /** How many could not be measured, and why. */
  failed: Array<{ id: string; reason: string }>;
  /** Whether the measurement changed the compiled geometry. */
  changed: boolean;
}

/**
 * Per-session measurement cache.
 *
 * The measurement is a pure function of (text, family, style, size, box
 * width), but it costs a plugin round trip — and when that round trip fails
 * or is skipped on one call and succeeds on the next, the same program
 * compiles to DIFFERENT geometry: measured live on the issue-22 loop, where a
 * dry run validated against estimates (applicable) and the apply that
 * followed validated against real text heights (refused for a spill the dry
 * run could not see). Caching per session makes back-to-back compiles of the
 * same program agree, which is what makes a dry run predictive.
 */
const measureCache = new WeakMap<object, Map<string, TextMeasurement>>();
const MEASURE_CACHE_CAP = 512;

function cacheKey(spec: { text: string; family: string; style: string; size: number; width?: number }): string {
  return `${spec.text}\u0000${spec.family}\u0000${spec.style}\u0000${spec.size}\u0000${spec.width ?? "*"}`;
}

/** The text calls in a program, with the arguments the plugin needs. */
function textCalls(program: unknown): Array<{ id: string; text: string; role: string; size?: number; family?: string; style?: string; weight?: number; maxWidth?: number }> {
  const content = (program as { content?: unknown })?.content;
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; text: string; role: string; size?: number; family?: string; style?: string; weight?: number; maxWidth?: number }> = [];
  for (const call of content as Array<Record<string, unknown>>) {
    if (call.fn !== "text") continue;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const text = typeof args.text === "string" ? args.text : typeof args.content === "string" ? args.content : "";
    if (text.length === 0) continue;
    out.push({
      id: typeof call.id === "string" ? call.id : `text-${out.length + 1}`,
      text,
      role: typeof args.role === "string" ? args.role : "body",
      ...(typeof args.size === "number" ? { size: args.size } : {}),
      ...(typeof args.family === "string" ? { family: args.family } : {}),
      ...(typeof args.style === "string" ? { style: args.style } : {}),
      ...(typeof args.weight === "number" ? { weight: args.weight } : {}),
      ...(typeof args.maxWidth === "number" ? { maxWidth: args.maxWidth } : {}),
    });
  }
  return out;
}

/** The type scale the compiler uses, so the measurement is taken at the right size. */
const ROLE_SIZE: Record<string, number> = {
  eyebrow: 11,
  title: 28,
  subtitle: 16,
  body: 14,
  label: 12,
  value: 20,
  caption: 11,
  code: 12,
};

/** The style name for a weight, the way the emitter spells it. */
function styleFor(weight: number | undefined): string {
  if (weight === undefined) return "Regular";
  if (weight >= 800) return "ExtraBold";
  if (weight >= 700) return "Bold";
  if (weight >= 600) return "SemiBold";
  if (weight >= 500) return "Medium";
  return "Regular";
}

/**
 * Measures a program's text through the plugin.
 *
 * `widths` are the widths the first compile resolved, so the text is measured
 * at the width it will actually be drawn at.
 */
export async function measureProgramText(
  session: Session | null,
  program: unknown,
  widths: Map<string, number>,
): Promise<MeasureOutcome> {
  const metrics = new Map<string, TextMeasurement>();
  const failed: Array<{ id: string; reason: string }> = [];
  const calls = textCalls(program);
  if (session === null || calls.length === 0) {
    return { metrics, measured: 0, failed, changed: false };
  }

  const specs = calls.map((c) => ({
    key: c.id,
    text: c.text,
    family: c.family ?? "Inter",
    style: c.style ?? styleFor(c.weight),
    size: c.size ?? ROLE_SIZE[c.role] ?? 14,
    ...(widths.get(c.id) !== undefined ? { width: Math.max(40, Math.round(widths.get(c.id)!)) } : {}),
  }));

  /** Serve hits from the session cache; only misses cost a round trip. */
  let cache = measureCache.get(session);
  if (cache === undefined) {
    cache = new Map();
    measureCache.set(session, cache);
  }
  const misses = specs.filter((s) => {
    const hit = cache.get(cacheKey(s));
    if (hit !== undefined) metrics.set(s.key, hit);
    return hit === undefined;
  });

  if (misses.length === 0) {
    return { metrics, measured: metrics.size, failed, changed: false };
  }

  try {
    const reply = (await session.request("measure_text", { specs: misses })) as {
      measurements?: Array<{ key: string; width: number; height: number }>;
      failed?: Array<{ key: string; reason: string }>;
    };
    for (const m of reply?.measurements ?? []) {
      if (typeof m.key !== "string" || !(m.height > 0)) continue;
      const spec = misses.find((s) => s.key === m.key);
      if (spec) {
        const value = { width: m.width, height: m.height };
        metrics.set(m.key, value);
        cache.set(cacheKey(spec), value);
        // Bounded: drop the oldest entry (Map preserves insertion order) once
        // the cache would otherwise grow with every new screen.
        if (cache.size > MEASURE_CACHE_CAP) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
      }
    }
    for (const f of reply?.failed ?? []) failed.push({ id: f.key, reason: f.reason });
  } catch (err) {
    failed.push({ id: "*", reason: err instanceof Error ? err.message : String(err) });
  }

  return { metrics, measured: metrics.size, failed, changed: false };
}

/** Whether the program's content includes text calls at all (no session needed). */
export function programHasText(program: unknown): boolean {
  return textCalls(program).length > 0;
}
