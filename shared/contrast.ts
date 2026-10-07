/**
 * WCAG contrast math.
 *
 * Lives in `shared/` because two very different places need the exact same
 * numbers: the server's critic and the plugin panel's inline readout. If they
 * disagree, the panel would show "passing" for a contrast failure the reviewer
 * had already flagged.
 *
 * Pure arithmetic, deliberately isolated so it can be unit tested against the
 * published ratios.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export function parseHex(hex: string): RGB | null {
  const m = hex.replace("#", "").match(/^([0-9a-f]{6}|[0-9a-f]{3})$/i);
  if (!m) return null;
  let x = m[1]!;
  if (x.length === 3) x = x.split("").map((c) => c + c).join("");
  const n = parseInt(x, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(c: RGB): number {
  const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2.1 contrast ratio, 1..21. Null when a colour cannot be parsed. */
export function contrastRatio(fgHex: string, bgHex: string): number | null {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) return null;

  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * WCAG AA threshold. "Large" is >=18pt, or >=14pt when bold.
 */
export function requiredRatio(fontSizePt: number, bold: boolean): number {
  const large = fontSizePt >= 18 || (bold && fontSizePt >= 14);
  return large ? 3 : 4.5;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const BOLD = /bold|black|heavy/i;

/**
 * One-call contrast check for a piece of text.
 *
 * A ratio of exactly 1 means the text colour and the background resolved to the
 * same value, which means the *measurement* is wrong rather than the design.
 * Reporting that as a failure would be worse than saying nothing, so it is
 * reported as `unmeasurable`.
 */
export function evaluateTextContrast(input: {
  color: string | null;
  background: string | null;
  fontSize: number | null;
  bold: boolean;
}): { ratio: number; required: number; passes: boolean } | { unmeasurable: true } {
  if (!input.color || !input.background || !input.fontSize) return { unmeasurable: true };

  const ratio = contrastRatio(input.color, input.background);
  if (ratio === null) return { unmeasurable: true };
  if (ratio <= 1.001) return { unmeasurable: true };

  const required = requiredRatio(input.fontSize, input.bold);
  return { ratio: round2(ratio), required, passes: ratio >= required };
}

export function isBoldStyle(style: string | null | undefined): boolean {
  return BOLD.test(style ?? "");
}