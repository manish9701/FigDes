/**
 * System 3 — Token & Design-System Intelligence, part 1: tokens (spec §9).
 *
 * Semantic knowledge of colour, spacing, radius and effects. Actual values come
 * from discovered product variables where available; the EXO seed is the
 * fallback, never the override.
 *
 * Critical rule: never blindly hardcode a token when the file already contains
 * an equivalent native variable. `resolveToken` therefore prefers the
 * discovered variable name and only falls back to the canonical EXO value.
 */

export type TokenRole =
  | "surface"
  | "surface-secondary"
  | "surface-elevated"
  | "text-primary"
  | "text-secondary"
  | "text-tertiary"
  | "border"
  | "accent"
  | "success"
  | "warning"
  | "danger";

export interface TokenSystem {
  colors: Partial<Record<TokenRole, { variable: string; value: string }>>;
  spacing: number[];
  spacingBase: number;
  radii: { small: number; medium: number; large: number };
  effects: string[];
  source: "discovered" | "exo-defaults" | "mixed";
}

/** Canonical EXO values (mirrors tokens/exo.ts, kept local so this module is pure). */
const EXO_DEFAULTS: Record<TokenRole, { variable: string; value: string }> = {
  surface: { variable: "exo/surface", value: "#FFFDF9" },
  "surface-secondary": { variable: "exo/canvas", value: "#F7F5EF" },
  "surface-elevated": { variable: "exo/runtime", value: "#111111" },
  "text-primary": { variable: "exo/text", value: "#242521" },
  "text-secondary": { variable: "exo/muted", value: "#6F716A" },
  "text-tertiary": { variable: "exo/border", value: "#E0E0E0" },
  border: { variable: "exo/border", value: "#E0E0E0" },
  accent: { variable: "exo/action", value: "#F2C94C" },
  success: { variable: "exo/health", value: "#2D7A4D" },
  warning: { variable: "exo/warning", value: "#B26A00" },
  danger: { variable: "exo/error", value: "#D13415" },
};

/** Heuristic role mapping from a variable name to a semantic role. */
function roleForVariable(name: string): TokenRole | null {
  const s = name.toLowerCase();
  if (/surface-elevat|elevated|overlay|dialog/.test(s)) return "surface-elevated";
  if (/surface-secondary|canvas|background|bg-secondary/.test(s)) return "surface-secondary";
  if (/surface|background|^bg$|canvas/.test(s)) return "surface";
  if (/text-primary|foreground|ink|primary-text/.test(s)) return "text-primary";
  if (/text-secondary|muted|secondary|tertiary-hint/.test(s)) return "text-secondary";
  if (/tertiary|hint|placeholder|faint/.test(s)) return "text-tertiary";
  if (/border|rule|hairline|divider|stroke/.test(s)) return "border";
  if (/accent|action|primary|brand|link|info/.test(s)) return "accent";
  if (/success|health|ok|positive|confirm/.test(s)) return "success";
  if (/warn|caution|amber/.test(s)) return "warning";
  if (/danger|error|destruct|negative|critical/.test(s)) return "danger";
  return null;
}

/**
 * Maps discovered variables onto semantic roles. Discovered values win per
 * role; undiscovered roles fall back to EXO defaults so the system always has
 * a complete palette to plan against.
 */
export function resolveTokens(input: {
  variables?: Array<{ name: string; value?: string | number | boolean | null }>;
  spacingValues?: number[];
  spacingBase?: number;
  radii?: number[];
}): TokenSystem {
  const colors: TokenSystem["colors"] = {};
  let discovered = 0;
  for (const v of input.variables ?? []) {
    const role = roleForVariable(v.name);
    if (!role || colors[role]) continue;
    if (typeof v.value === "string" && /^#[0-9a-f]{3,8}$/i.test(v.value)) {
      colors[role] = { variable: v.name, value: v.value.toUpperCase() };
      discovered += 1;
    } else if (v.value === undefined || v.value === null) {
      // Name exists but no resolved value: still records the binding so the
      // builder references the native variable instead of hardcoding.
      colors[role] = { variable: v.name, value: EXO_DEFAULTS[role].value };
      discovered += 1;
    }
  }
  for (const role of Object.keys(EXO_DEFAULTS) as TokenRole[]) {
    if (!colors[role]) colors[role] = EXO_DEFAULTS[role];
  }
  const spacing = [...new Set((input.spacingValues ?? [4, 8, 12, 16, 24, 32, 48, 64]).filter((n) => n > 0))].sort((a, b) => a - b).slice(0, 12);
  const radiiSorted = [...new Set(input.radii ?? [])].filter((n) => n >= 0).sort((a, b) => a - b);
  return {
    colors,
    spacing,
    spacingBase: input.spacingBase ?? 0,
    radii: {
      small: radiiSorted[0] ?? 4,
      medium: radiiSorted[1] ?? radiiSorted[0] ?? 8,
      large: radiiSorted[2] ?? radiiSorted[1] ?? radiiSorted[0] ?? 12,
    },
    effects: ["shadow", "border", "opacity"],
    source: discovered > 0 ? (discovered >= 5 ? "mixed" : "mixed") : "exo-defaults",
  };
}

/** The variable reference the builder should use for a role (never a hardcoded hex). */
export function tokenVariable(tokens: TokenSystem, role: TokenRole): string {
  return tokens.colors[role]?.variable ?? EXO_DEFAULTS[role].variable;
}

/* -------------------------------------------------------------------------- */
/* Token-reference preference (issue #24 follow-up: style/token fidelity)      */
/* -------------------------------------------------------------------------- */

export interface TokenConsistencyInput {
  /** Hex fills observed on the screen under test. */
  fills: string[];
  /** Stroke widths observed. */
  strokes?: number[];
  /** Corner radii observed. */
  radii?: number[];
  /** Spacing steps observed. */
  spacing?: number[];
}

export interface TokenConsistencyReport {
  /** 0–100. 100 means every observed value already resolves to a token step. */
  score: number;
  /** Hex fills that have an equivalent token variable and should bind it. */
  preferVariable: Array<{ hex: string; variable: string }>;
  /** Strokes/radii/spacing values off the token scale. */
  offScale: Array<{ dimension: "stroke" | "radius" | "spacing"; value: number; nearest: number | null }>;
  evidence: string[];
}

function nearestStep(value: number, steps: number[]): number | null {
  if (steps.length === 0) return null;
  let best = steps[0]!;
  for (const s of steps) if (Math.abs(s - value) < Math.abs(best - value)) best = s;
  return best;
}

/**
 * Token-reference preference plus strokes/radii/spacing discipline.
 *
 * Pure and advisory: fills matching a discovered token *value* are reported
 * as `preferVariable` (bind the variable, drop the hex); strokes, radii and
 * spacing are measured against the token scale with the same near-duplicate
 * tolerances `consistency.ts` uses. A missing dimension is skipped, never
 * failed — no token scale, no verdict.
 */
export function checkTokenConsistency(tokens: TokenSystem, input: TokenConsistencyInput): TokenConsistencyReport {
  const evidence: string[] = [];
  const preferVariable: TokenConsistencyReport["preferVariable"] = [];
  const offScale: TokenConsistencyReport["offScale"] = [];
  let score = 100;

  const tokenEntries = Object.entries(tokens.colors) as Array<[TokenRole, { variable: string; value: string }]>;
  const seen = new Set<string>();
  for (const raw of input.fills ?? []) {
    const hex = raw.toUpperCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    // Already a variable reference (contains a slash): bound, not hardcoded.
    if (raw.includes("/")) continue;
    const match = tokenEntries.find(([, c]) => c.value.toUpperCase() === hex);
    if (match) {
      preferVariable.push({ hex, variable: match[1].variable });
    }
  }
  if (preferVariable.length > 0) {
    score -= Math.min(20, preferVariable.length * 5);
    evidence.push(
      `${preferVariable.length} hardcoded fill(s) duplicate a token value — bind the variable: ${preferVariable.slice(0, 4).map((p) => `${p.hex} → ${p.variable}`).join(", ")}`,
    );
  } else {
    evidence.push("no hardcoded fill duplicates a token value");
  }

  const checks: Array<{ dimension: "stroke" | "radius" | "spacing"; values: number[]; steps: number[]; tolerance: number }> = [
    { dimension: "stroke", values: input.strokes ?? [], steps: [0.5, 1, 1.5, 2, 3], tolerance: 0.5 },
    { dimension: "radius", values: input.radii ?? [], steps: [tokens.radii.small, tokens.radii.medium, tokens.radii.large], tolerance: 1 },
    { dimension: "spacing", values: input.spacing ?? [], steps: tokens.spacing, tolerance: 2 },
  ];
  for (const check of checks) {
    const distinct = [...new Set(check.values)];
    if (distinct.length === 0) continue;
    const off = distinct.filter((v) => {
      const near = nearestStep(v, check.steps);
      return near === null || Math.abs(near - v) > check.tolerance;
    });
    for (const v of off) offScale.push({ dimension: check.dimension, value: v, nearest: nearestStep(v, check.steps) });
    if (off.length > 0) {
      score -= Math.min(15, off.length * 3);
      evidence.push(`${check.dimension}: ${off.length} value(s) off the token scale (${off.slice(0, 6).join(", ")})`);
    } else {
      evidence.push(`${check.dimension}: on the token scale (${distinct.length} distinct)`);
    }
  }

  return { score: Math.max(0, Math.round(score)), preferVariable, offScale, evidence };
}
