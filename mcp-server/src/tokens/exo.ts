/**
 * The canonical EXO design tokens (spec §7, §17).
 *
 * ## Why a seed exists
 *
 * Tokens only work if they exist before anyone needs them. Expecting every
 * screen to declare `exo/surface` from scratch means the third screen invents
 * `surface-2`, and the design system is back to hardcoded hex with extra steps.
 * One call creates the whole set, idempotently: re-running updates values in
 * place rather than duplicating names.
 *
 * ## Where the values come from
 *
 * Not invented here. Every value is already in use somewhere in this codebase
 * or the spec's visual identity: warm neutral canvas, technical editorial type,
 * yellow intent/action, green health, dark runtime surfaces, thin rules, small
 * radii. The seed gathers them into one collection instead of leaving them
 * scattered across a hundred string literals.
 */

export interface ExoToken {
  name: string;
  type: "color" | "number";
  values: Record<string, string | number>;
  scopes?: string[];
  description?: string;
}

/** Paint tokens: the EXO palette as variables. */
export const EXO_PAINT_TOKENS: ExoToken[] = [
  { name: "canvas", type: "color", values: { default: "#F7F5EF" }, description: "Warm neutral canvas. Screens start here." },
  { name: "surface", type: "color", values: { default: "#FFFDF9" }, description: "Raised surfaces: cards, panels, dialogs." },
  { name: "sidebar", type: "color", values: { default: "#111111" }, description: "Navigation rail and window chrome." },
  { name: "text", type: "color", values: { default: "#242521" }, description: "Primary text." },
  { name: "muted", type: "color", values: { default: "#6F716A" }, description: "Secondary text and metadata." },
  { name: "border", type: "color", values: { default: "#E0E0E0" }, description: "Hairlines and rules. Thin, never heavy." },
  { name: "action", type: "color", values: { default: "#F2C94C" }, description: "Intent and primary action. Yellow, used sparingly." },
  { name: "actionSoft", type: "color", values: { default: "#F2C94C33" }, description: "Active navigation and soft action fills." },
  { name: "health", type: "color", values: { default: "#2D7A4D" }, description: "System health. Green, never neon." },
  { name: "healthSoft", type: "color", values: { default: "#2D7A4D1A" }, description: "Healthy-state backgrounds." },
  { name: "warning", type: "color", values: { default: "#B26A00" }, description: "Degraded states and cautions." },
  { name: "error", type: "color", values: { default: "#D13415" }, description: "Failures and destructive intent." },
  { name: "runtime", type: "color", values: { default: "#111111" }, description: "Dark runtime and high-information surfaces." },
  { name: "info", type: "color", values: { default: "#0B6BCB" }, description: "Informational accents: links, selections, shard markers." },
];

/** Spacing scale, 4px base. */
export const EXO_SPACING_TOKENS: ExoToken[] = [4, 8, 12, 16, 20, 24, 32, 40, 48, 64].map((value) => ({
  name: `space/${value}`,
  type: "number" as const,
  values: { default: value },
  scopes: ["GAP"],
  description: `Spacing step ${value}px.`,
}));

/** Corner radii. Small by identity: 4, 8, 12. */
export const EXO_RADIUS_TOKENS: ExoToken[] = [4, 8, 12].map((value) => ({
  name: `radius/${value}`,
  type: "number" as const,
  values: { default: value },
  scopes: ["CORNER_RADIUS"],
  description: `Corner radius ${value}px.`,
}));

export interface ExoTextStyle {
  name: string;
  family: string;
  weight: number;
  fontSize: number;
  lineHeight?: number;
  letterSpacing?: number;
}

/** The EXO type ramp as named styles. Technical values ship monospaced. */
export const EXO_TEXT_STYLES: ExoTextStyle[] = [
  { name: "exo/display", family: "Inter", weight: 700, fontSize: 56 },
  { name: "exo/pageTitle", family: "Inter", weight: 600, fontSize: 32 },
  { name: "exo/sectionTitle", family: "Inter", weight: 600, fontSize: 18 },
  { name: "exo/body", family: "Inter", weight: 400, fontSize: 14 },
  { name: "exo/label", family: "Inter", weight: 500, fontSize: 12 },
  { name: "exo/caption", family: "Inter", weight: 400, fontSize: 11 },
  { name: "exo/technical", family: "JetBrains Mono", weight: 400, fontSize: 12 },
];

/**
 * Builds the full seed as operations.
 *
 * Everything goes into one `exo` collection, so the file gains one source of
 * truth instead of fourteen loose variables. Idempotent by construction: every
 * op is create-or-update.
 */
export function exoSeedOperations(): Array<Record<string, unknown>> {
  const ops: Array<Record<string, unknown>> = [];

  for (const token of [...EXO_PAINT_TOKENS, ...EXO_SPACING_TOKENS, ...EXO_RADIUS_TOKENS]) {
    ops.push({
      type: "createVariable",
      id: `exo-${token.name.replace(/[^a-zA-Z0-9]+/g, "-")}`,
      name: token.name,
      variableType: token.type,
      collection: "exo",
      values: token.values,
      ...(token.scopes !== undefined ? { scopes: token.scopes } : {}),
      ...(token.description !== undefined ? { description: token.description } : {}),
    });
  }

  for (const style of EXO_TEXT_STYLES) {
    ops.push({
      type: "createTextStyle",
      id: `exo-style-${style.name.replace(/[^a-zA-Z0-9]+/g, "-")}`,
      name: style.name,
      family: style.family,
      weight: style.weight,
      fontSize: style.fontSize,
      ...(style.lineHeight !== undefined ? { lineHeight: style.lineHeight } : {}),
      ...(style.letterSpacing !== undefined ? { letterSpacing: style.letterSpacing } : {}),
    });
  }

  return ops;
}

/** How many variables and styles the seed declares. Reported, not trusted. */
export function exoSeedCounts(): { variables: number; textStyles: number } {
  return {
    variables: EXO_PAINT_TOKENS.length + EXO_SPACING_TOKENS.length + EXO_RADIUS_TOKENS.length,
    textStyles: EXO_TEXT_STYLES.length,
  };
}