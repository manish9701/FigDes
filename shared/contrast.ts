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

/* -------------------------------------------------------------------------- */
/* Palette-safe repair                                                         */
/* -------------------------------------------------------------------------- */

export interface ColourRepair {
  /** The replacement foreground colour. */
  hex: string;
  /** Contrast ratio the replacement achieves against the same background. */
  ratio: number;
  /** Ratio the original achieved, for before/after reporting. */
  from: number;
}

/**
 * Moves a text colour just far enough to reach `required`, without leaving the
 * palette it came from.
 *
 * The repair walks the colour toward black (on a light background) or toward
 * white (on a dark one) through HSL, holding hue and saturation fixed. That is
 * what "stay inside the palette already used by this file" means mechanically:
 * a failing `#777777` on white becomes a darker grey, never a blue or a red
 * that happens to score well. A naive "pick black" repair would pass the check
 * and wreck the design.
 *
 * Returns null when the requirement cannot be met by a luminance shift alone
 * (a mid-grey background that both black and white fail against), because the
 * honest answer there is "change the surface", not a colour nobody can read.
 */
export function repairTextColour(fgHex: string, bgHex: string, required: number): ColourRepair | null {
  const fg = parseHex(fgHex);
  const bg = parseHex(bgHex);
  if (!fg || !bg) return null;

  const bgLuminance = relativeLuminance(bg);
  // On a light surface text goes darker, and vice versa. This direction is the
  // one that increases contrast; the other can only lower it, so it is never
  // worth searching.
  const toward = bgLuminance > 0.18 ? 0 : 1;

  // If even the far end of that direction cannot pass, no luminance shift will
  // do it: the surface, not the text, is what has to change.
  const extreme: RGB = toward === 0 ? { r: 0, g: 0, b: 0 } : { r: 1, g: 1, b: 1 };
  const bestPossible = contrastRatio(rgbToHex(extreme), bgHex);
  if (bestPossible === null || bestPossible < required) return null;

  const hsl = rgbToHsl(fg);
  const from = contrastRatio(fgHex, bgHex) ?? 0;

  // Contrast is monotonic in lightness once the direction is fixed, so a binary
  // search finds the *smallest* shift that passes — the repair changes as
  // little of the design as the requirement allows. `lo` is the known failure,
  // `hi` the known pass; the loop keeps tightening `hi` toward `lo`.
  let lo = hsl.l;
  let hi = toward;
  let best: ColourRepair | null = null;

  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const candidate = hslToHex({ h: hsl.h, s: hsl.s, l: mid });
    const ratio = contrastRatio(candidate, bgHex);
    if (ratio === null) break;
    if (ratio >= required) {
      best = { hex: candidate, ratio: round2(ratio), from: round2(from) };
      hi = mid;
    } else {
      lo = mid;
    }
  }

  return best;
}

/** 0-1 channels to a 6-digit uppercase hex. */
export function rgbToHex(rgb: RGB): string {
  const channel = (v: number): string =>
    Math.max(0, Math.min(255, Math.round(v * 255)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

interface HSL {
  h: number;
  s: number;
  l: number;
}

/** Standard RGB->HSL with h in degrees and s/l in 0..1. */
export function rgbToHsl(rgb: RGB): HSL {
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };

  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  const maxIsR = max === rgb.r;
  const maxIsG = max === rgb.g;
  if (maxIsR) h = ((rgb.g - rgb.b) / d) % 6;
  else if (maxIsG) h = (rgb.b - rgb.g) / d + 2;
  else h = (rgb.r - rgb.g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

function hslToRgb(hsl: HSL): RGB {
  const c = (1 - Math.abs(2 * hsl.l - 1)) * hsl.s;
  const hp = (((hsl.h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rgb: [number, number, number];
  if (hp < 1) rgb = [c, x, 0];
  else if (hp < 2) rgb = [x, c, 0];
  else if (hp < 3) rgb = [0, c, x];
  else if (hp < 4) rgb = [0, x, c];
  else if (hp < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const m = hsl.l - c / 2;
  return { r: rgb[0] + m, g: rgb[1] + m, b: rgb[2] + m };
}

export function hslToHex(hsl: HSL): string {
  return rgbToHex(hslToRgb(hsl));
}