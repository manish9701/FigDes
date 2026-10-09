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
