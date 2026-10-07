/**
 * Visual style presets (FigDes §26): the same layout, different feel.
 *
 * A preset is five mechanics, not five adjectives: density (how much fits),
 * spacing (how air moves), align (how edges behave), contrast (how emphasis
 * speaks) and typography (how words carry weight). The compiler applies them
 * in builders; the interpreter only fills intent fields it already understands
 * (density, contrast, alignment). One registry, one resolver, two consumers —
 * so a preset can never mean one thing at plan time and another at build time.
 *
 * Accordion words ("compact" unfolds to "dense, quiet") and compound
 * directives ("dense, warm") compose. Unknown names warn; contradictory pairs
 * ("airy" + "dense") are rejected with default taste rather than averaged,
 * because the average of two opposing manners is a guess.
 */
export interface StyleMechanics {
  name: string;
  density: "airy" | "calm" | "balanced" | "dense";
  spacing: string;
  align: string;
  contrast: string;
  typography: string;
  colorUsage: string;
  surfaces: string;
  contentDensity: string;
  numbers: string;
  shape: string;
  sizing: string;
  warmth: string;
  description: string;
  why: string;
}

export type StylePreset = StyleMechanics;

export const STYLES: Record<string, StylePreset> = {
  "calm-technical": {
    name: "calm-technical",
    density: "calm",
    spacing: "8px-even",
    align: "relaxed-left",
    contrast: "restrained",
    typography: "quiet",
    colorUsage: "ink-on-paper",
    surfaces: "bordered",
    contentDensity: "roomy",
    numbers: "tabular",
    shape: "geometric",
    sizing: "comfortable",
    warmth: "neutral",
    description: "Calm technical: generous whitespace, quiet labels, tabular numerals for telemetry.",
    why: "Telemetry rewards calm scanning over shouting; restraint here is functional, not decorative.",
  },
  "technical-editorial": {
    name: "technical-editorial",
    density: "balanced",
    spacing: "8px-loose",
    align: "relaxed-left",
    contrast: "restrained",
    typography: "editorial",
    colorUsage: "ink-on-paper",
    surfaces: "bordered",
    contentDensity: "roomy",
    numbers: "tabular",
    shape: "geometric",
    sizing: "comfortable",
    warmth: "neutral",
    description: "Technical editorial: a report that happens to be live data.",
    why: "Headlines carry the decision, readouts support it; nothing competes with the verdict.",
  },
  "quiet-instrument": {
    name: "quiet-instrument",
    density: "dense",
    spacing: "4px-tight",
    align: "strict-grid",
    contrast: "muted",
    typography: "quiet",
    colorUsage: "muted-on-dark",
    surfaces: "open",
    contentDensity: "compact",
    numbers: "mono-first",
    shape: "geometric",
    sizing: "compact",
    warmth: "cool",
    description: "Quiet instrument: dense, grid-aligned, values first and mono.",
    why: "Operators read values, not chrome; density is the point, so alignment does the organizing.",
  },
  "high-contrast-ops": {
    name: "high-contrast-ops",
    density: "balanced",
    spacing: "8px-even",
    align: "strict-grid",
    contrast: "bold",
    typography: "confident",
    colorUsage: "signal-on-dark",
    surfaces: "bordered",
    contentDensity: "roomy",
    numbers: "tabular",
    shape: "geometric",
    sizing: "comfortable",
    warmth: "neutral",
    description: "High-contrast ops: bold emphasis for state that must be seen across the room.",
    why: "Alerts and state changes are the product here; contrast is load-bearing.",
  },
  "gallery-warm": {
    name: "gallery-warm",
    density: "airy",
    spacing: "12px-loose",
    align: "centered",
    contrast: "muted",
    typography: "editorial",
    colorUsage: "warm-on-cream",
    surfaces: "open",
    contentDensity: "airy",
    numbers: "proportional",
    shape: "organic",
    sizing: "generous",
    warmth: "warm",
    description: "Gallery warm: airy, centered, warm surfaces for showcase content.",
    why: "Showcase content is looked at, not operated; air and warmth invite the eye to linger.",
  },
};

/**
 * Accordion words: shorthands that unfold to full directives. "compact"
 * expands to "dense, quiet" — the two mechanics the word actually promises.
 */
export const ACCORDION: Record<string, string[]> = {
  compact: ["dense", "quiet"],
  airy: ["airy"],
  minimal: ["calm", "quiet", "open"],
  editorial: ["editorial"],
  instrument: ["dense", "strict-grid", "mono-first"],
  warm: ["warm"],
};

/**
 * Bare directive words that are mechanics without a preset: "dense" means
 * density dense, "quiet" means quiet typography, "mono-first" tabular numbers.
 * Preset names are NOT in this table; they arrive via STYLES.
 */
const STYLE_FIELD_TOKENS: Record<string, { field: keyof Omit<StyleMechanics, "name" | "description" | "why">; value: string }> = {
  airy: { field: "density", value: "airy" },
  calm: { field: "density", value: "calm" },
  balanced: { field: "density", value: "balanced" },
  dense: { field: "density", value: "dense" },
  generous: { field: "spacing", value: "12px-loose" },
  tight: { field: "spacing", value: "4px-tight" },
  even: { field: "spacing", value: "8px-even" },
  strong: { field: "align", value: "strict-grid" },
  loose: { field: "align", value: "relaxed-left" },
  "strict-grid": { field: "align", value: "strict-grid" },
  centered: { field: "align", value: "centered" },
  bold: { field: "contrast", value: "bold" },
  muted: { field: "contrast", value: "muted" },
  restrained: { field: "contrast", value: "restrained" },
  quiet: { field: "typography", value: "quiet" },
  editorial: { field: "typography", value: "editorial" },
  confident: { field: "typography", value: "confident" },
  warm: { field: "warmth", value: "warm" },
  cool: { field: "warmth", value: "cool" },
  neutral: { field: "warmth", value: "neutral" },
  bordered: { field: "surfaces", value: "bordered" },
  borderless: { field: "surfaces", value: "borderless" },
  open: { field: "surfaces", value: "open" },
  crisp: { field: "surfaces", value: "bordered" },
  "mono-first": { field: "numbers", value: "mono-first" },
  tabular: { field: "numbers", value: "tabular" },
  proportional: { field: "numbers", value: "proportional" },
  geometric: { field: "shape", value: "geometric" },
  brutal: { field: "shape", value: "brutal" },
  organic: { field: "shape", value: "organic" },
};

/** Pairs that pull in opposite directions; both are dropped when combined. */
const CONTRADICTIONS: Array<[string, string]> = [
  ["airy", "dense"],
  ["calm", "dense"],
  ["generous", "tight"],
];

export interface ResolvedStyle {
  /** The first named preset wins identity; later ones only fill gaps. */
  preset?: StylePreset;
  /** Merged mechanics, first token wins per field. */
  mechanics: Partial<StyleMechanics>;
  /** Notes for intentNotes: what each token meant. */
  notes: string[];
  /** Warnings: unknown names, contradictions. */
  warnings: string[];
}

/**
 * Resolve `visualIntent.style` — a name, a comma string, or an array — into
 * merged mechanics. One function, used by the interpreter (intent-field
 * defaults) and the compiler (presentation mechanics), so the two can never
 * disagree about what a style means.
 */
export function resolveStyleTokens(raw: string | string[] | undefined): ResolvedStyle {
  const notes: string[] = [];
  const warnings: string[] = [];
  if (raw === undefined) return { mechanics: {}, notes, warnings };

  const tokens = (Array.isArray(raw) ? raw : String(raw).split(","))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);

  const expanded: string[] = [];
  for (const token of tokens) {
    const accordion = ACCORDION[token];
    if (accordion !== undefined) {
      expanded.push(...accordion);
      notes.push(`'${token}' means '${accordion.join(" + ")}'.`);
    } else {
      expanded.push(token);
    }
  }

  for (const [a, b] of CONTRADICTIONS) {
    if (expanded.includes(a) && expanded.includes(b)) {
      warnings.push(`Styles '${a}' and '${b}' pull in opposite directions; both were ignored. The program builds with default taste.`);
      return { mechanics: {}, notes, warnings };
    }
  }

  let preset: StylePreset | undefined;
  const mechanics: Partial<StyleMechanics> = {};
  const assign = (field: keyof StyleMechanics, value: string): void => {
    if (field === "name" || field === "description" || field === "why") return;
    (mechanics as Record<string, string>)[field] ??= value;
  };
  for (const token of expanded) {
    const named = STYLES[token];
    if (named !== undefined) {
      preset ??= named;
      for (const [field, value] of Object.entries(named) as Array<[keyof StyleMechanics, string]>) {
        assign(field, value);
      }
      continue;
    }
    const bare = STYLE_FIELD_TOKENS[token];
    if (bare !== undefined) {
      assign(bare.field, bare.value);
      continue;
    }
    warnings.push(`Style '${token}' is not a known preset, accordion word or directive; it was ignored. The program builds with default taste.`);
  }
  if (preset !== undefined) {
    notes.push(`${preset.description} ${preset.why}`);
  }
  return { preset, mechanics, notes, warnings };
}

/**
 * Bridge preset alignment onto the intent alignment the compiler already
 * understands: strict grids snap, everything else breathes.
 */
export function presetAlignment(align: string | undefined): "loose" | "strong" | undefined {
  if (align === undefined) return undefined;
  return align === "strict-grid" ? "strong" : "loose";
}
