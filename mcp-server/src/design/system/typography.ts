/**
 * System 4 — Product Font Intelligence (spec §10).
 *
 * Typography is one of the fastest ways to make a generated design feel
 * generic. This module discovers the product's real type system (primary,
 * secondary, technical/mono, weights, scale, line-height and letter-spacing
 * conventions) and validates built text against it.
 *
 * Rule: do not silently fall back to Inter unless the product actually uses it.
 */

export type TypeRole = "display" | "heading" | "body" | "label" | "caption" | "technical";

export interface TypeLevel {
  role: TypeRole;
  family: string;
  weight: number;
  size: number;
  lineHeight?: number;
  letterSpacing?: number;
}

export interface TypographySystem {
  primary: string;
  secondary: string;
  mono: string;
  weights: number[];
  scale: TypeLevel[];
  lineHeightConvention?: number;
  letterSpacingConvention?: number;
  source: "discovered" | "defaults";
}

const MONO_HINT = /mono|code|jetbrains|fira|roboto mono|sfmono|consolas|technical/i;

function parseLabel(label: string): { family: string; style: string; size: number | null } {
  // Labels look like "Inter SemiBold @16" (from extract_design_system).
  const sizeMatch = label.match(/@([\d.]+)\s*$/);
  const size = sizeMatch ? Number(sizeMatch[1]) : null;
  const withoutSize = label.replace(/\s*@[\d.]+\s*$/, "").trim();
  const parts = withoutSize.split(/\s+/);
  const style = parts.length > 1 ? parts[parts.length - 1]! : "Regular";
  const family = parts.length > 1 ? parts.slice(0, -1).join(" ") : withoutSize || "unknown";
  return { family, style, size };
}

const STYLE_WEIGHTS: Array<{ weight: number; pattern: RegExp }> = [
  { weight: 700, pattern: /bold|700|heavy|black/i },
  { weight: 600, pattern: /semibold|semi-bold|600|demi/i },
  { weight: 500, pattern: /medium|500/i },
  { weight: 400, pattern: /regular|normal|400|book/i },
  { weight: 300, pattern: /light|300/i },
];

function weightForStyle(style: string): number {
  for (const { weight, pattern } of STYLE_WEIGHTS) {
    if (pattern.test(style)) return weight;
  }
  return 400;
}

/**
 * Discovers the product type system from observed labels plus the font list
 * the plugin reports via listAvailableFontsAsync.
 */
export function discoverTypography(input: {
  labels?: Array<{ label?: string; count?: number }>;
  availableFonts?: Array<{ family?: string; style?: string }>;
}): TypographySystem {
  const counts = new Map<string, number>();
  const stylesByFamily = new Map<string, Set<string>>();
  const sizes: number[] = [];
  for (const entry of input.labels ?? []) {
    if (!entry.label) continue;
    const { family, style, size } = parseLabel(entry.label);
    counts.set(family, (counts.get(family) ?? 0) + (entry.count ?? 1));
    const set = stylesByFamily.get(family) ?? new Set<string>();
    set.add(style);
    stylesByFamily.set(family, set);
    if (size !== null) sizes.push(size);
  }
  for (const f of input.availableFonts ?? []) {
    if (!f.family) continue;
    const set = stylesByFamily.get(f.family) ?? new Set<string>();
    if (f.style) set.add(f.style);
    stylesByFamily.set(f.family, set);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const mono = ranked.find((f) => MONO_HINT.test(f)) ?? [...stylesByFamily.keys()].find((f) => MONO_HINT.test(f)) ?? "JetBrains Mono";
  const primary = ranked.find((f) => f !== mono) ?? ranked[0] ?? "Inter";
  const secondary = ranked.find((f) => f !== primary && f !== mono) ?? primary;
  const weights = [...new Set([...(stylesByFamily.get(primary) ?? [])].map(weightForStyle))].sort((a, b) => a - b);
  const sortedSizes = [...new Set(sizes)].sort((a, b) => a - b);
  const pick = (candidates: number[], fallback: number): number => {
    for (const c of candidates) {
      const hit = sortedSizes.find((s) => Math.abs(s - c) <= 2);
      if (hit !== undefined) return hit;
    }
    return fallback;
  };
  const scale: TypeLevel[] = [
    { role: "display", family: primary, weight: 700, size: pick([56, 48, 40, 32], 56) },
    { role: "heading", family: primary, weight: 600, size: pick([32, 24, 20, 18], 18) },
    { role: "body", family: primary, weight: 400, size: pick([16, 14], 14) },
    { role: "label", family: primary, weight: 500, size: pick([14, 12], 12) },
    { role: "caption", family: secondary, weight: 400, size: pick([12, 11], 11) },
    { role: "technical", family: mono, weight: 400, size: pick([13, 12], 12) },
  ];
  return {
    primary,
    secondary,
    mono,
    weights: weights.length > 0 ? weights : [400, 500, 600, 700],
    scale,
    source: ranked.length > 0 ? "discovered" : "defaults",
  };
}

export interface FontValidation {
  ok: boolean;
  family: string;
  expected: string;
  detail: string;
}

/** Verifies representative text nodes use the product font (never silent Inter). */
export function validateFonts(
  system: TypographySystem,
  nodes: Array<{ family?: string | null; role?: TypeRole }>,
): FontValidation[] {
  return nodes.map((n) => {
    const family = n.family ?? "unknown";
    const expected = n.role === "technical" ? system.mono : system.primary;
    const ok = family === expected || (n.role !== "technical" && family === system.secondary);
    return {
      ok,
      family,
      expected,
      detail: ok ? `uses product font '${family}'` : `'${family}' is not the product font (expected '${expected}'). Do not silently fall back.`,
    };
  });
}

/** The scale entry a builder should use for a type role. */
export function levelFor(system: TypographySystem, role: TypeRole): TypeLevel {
  return system.scale.find((l) => l.role === role) ?? system.scale[2]!;
}
