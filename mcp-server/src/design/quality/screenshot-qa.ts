/**
 * Screenshot sanity QA at the server boundary (issue #24, item 4).
 *
 * Renders arrive as PNG bytes. Before any visual critique spends context on
 * the image, a cheap, dependency-free structural read of the PNG can say
 * whether there is anything to look at: a blank canvas, a single flat fill, a
 * band-of-colour render or a real image. This module parses the PNG header and
 * IDAT stream with `node:zlib`, unfilters the scanlines (filters 0-4 including
 * Paeth) and measures the pixels it can afford to sample.
 *
 * ## The trust rule
 *
 * Heuristic findings here are *evidence with confidence*, never hard failures.
 * A "suspect-uniform" render may be a legitimately empty state; the caller
 * (the critique flow that owns the decision) reads `renderStatus` and
 * `warnings` and decides. Nothing in this module throws on odd pixels — only
 * on inputs that are not PNGs at all, which it reports as a warning instead of
 * a crash so a bad render can never take a review pass down with it.
 */
import { inflateSync } from "node:zlib";

import { makeFinding, type DesignFinding } from "./finding";

/* -------------------------------------------------------------------------- */
/* Types                                                                        */
/* -------------------------------------------------------------------------- */

export type ScreenshotRenderStatus = "ok" | "suspect-blank" | "suspect-uniform" | "undecodable";

export interface ScreenshotWarning {
  /** Stable code, e.g. 'near-uniform', 'row-band', 'png-invalid'. */
  code: string;
  /** The measured evidence in one sentence. */
  message: string;
  /** 0-1. These are heuristics; nothing here is a certainty. */
  confidence: number;
}

export interface ScreenshotAnalysis {
  renderStatus: ScreenshotRenderStatus;
  /** Dominant sampled colour as `#rrggbb` ('' when the image could not be read). */
  dominantColor: string;
  /** Share of sampled pixels carrying the dominant colour, 0-1. */
  dominantColorRatio: number;
  /** Number of distinct sampled colours (capped; a cap hit is itself a warning). */
  colorCount: number;
  /** Normalised luminance variance across sampled pixels, 0-1. */
  luminanceVariance: number;
  /** Count of sampled rows/cols that are a single flat colour (band evidence). */
  uniformRows: number;
  uniformCols: number;
  /** Sample size, so the numbers are readable as measurements, not truths. */
  sampledWidth: number;
  sampledHeight: number;
  warnings: ScreenshotWarning[];
  /** Present when the bytes are not a decodable PNG. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/* PNG reading                                                                  */
/* -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per colour type (8-bit depth only is decoded; the rest are flagged). */
const COLOR_TYPE_CHANNELS: Record<number, number> = {
  0: 1, // greyscale
  2: 3, // rgb
  3: 1, // palette (indexed; expanded below when a PLTE chunk is present)
  4: 2, // greyscale + alpha
  6: 4, // rgba
};

interface DecodedPng {
  width: number;
  height: number;
  /** RGBA tuples per sampled pixel, row-major. */
  pixels: Array<[number, number, number, number]>;
  sampledWidth: number;
  sampledHeight: number;
}

/**
 * Decodes an 8-bit, non-interlaced PNG down to *sampled* pixels (capped grid),
 * unfiltering every scanline with zlib inflate. Palette images expand through
 * their PLTE chunk; unsupported shapes report an error instead of throwing.
 */
function decodePng(bytes: Uint8Array): { png?: DecodedPng; error?: string } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { error: "not a PNG (signature mismatch)" };
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let pos = 8;
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString("ascii");
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) return { error: "truncated PNG (chunk runs past the buffer)" };
    const data = buf.subarray(dataStart, dataEnd);
    switch (type) {
      case "IHDR": {
        if (length < 13) return { error: "malformed IHDR" };
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8]!;
        colorType = data[9]!;
        interlace = data[12]!;
        break;
      }
      case "PLTE":
        palette = Buffer.from(data);
        break;
      case "IDAT":
        idat.push(Buffer.from(data));
        break;
      case "IEND":
        pos = buf.length; // stop the loop
        break;
      default:
        break; // ancillary chunks are irrelevant here
    }
    pos = type === "IEND" ? buf.length : dataEnd + 4;
  }
  if (width <= 0 || height <= 0) return { error: "malformed IHDR (no dimensions)" };
  if (bitDepth !== 8) return { error: `unsupported bit depth ${bitDepth} (only 8-bit is inspected)` };
  if (interlace !== 0) return { error: "interlaced PNGs are not inspected" };
  if (idat.length === 0) return { error: "no IDAT data" };
  let channels = COLOR_TYPE_CHANNELS[colorType];
  if (channels === undefined) return { error: `unsupported colour type ${colorType}` };

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch (error) {
    return { error: `IDAT failed to inflate: ${(error as Error).message}` };
  }
  const stride = width * channels;
  const expected = height * (stride + 1);
  if (raw.length < expected) return { error: `scanline data truncated (got ${raw.length} bytes, expected ${expected})` };

  /* Unfilter: work in-place on a copy so filters 1-4 read reconstructed bytes. */
  const lines: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const lineStart = y * (stride + 1);
    const filter = raw[lineStart]!;
    const line = Buffer.from(raw.subarray(lineStart + 1, lineStart + 1 + stride));
    const bpp = channels;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp]! : 0;
      const b = lines.length > 0 ? lines[lines.length - 1]![x]! : 0;
      const c = lines.length > 0 && x >= bpp ? lines[lines.length - 1]![x - bpp]! : 0;
      switch (filter) {
        case 0: // None
          break;
        case 1: // Sub
          line[x] = (line[x]! + a) & 0xff;
          break;
        case 2: // Up
          line[x] = (line[x]! + b) & 0xff;
          break;
        case 3: // Average
          line[x] = (line[x]! + ((a + b) >> 1)) & 0xff;
          break;
        case 4: // Paeth
          line[x] = (line[x]! + paeth(a, b, c)) & 0xff;
          break;
        default:
          return { error: `unknown scanline filter ${filter} on row ${y}` };
      }
    }
    lines.push(line);
  }

  /* Sample: cap the sampled grid so a huge render stays a bounded read. */
  const MAX_SAMPLES_PER_AXIS = 256;
  const stepX = Math.max(1, Math.ceil(width / MAX_SAMPLES_PER_AXIS));
  const stepY = Math.max(1, Math.ceil(height / MAX_SAMPLES_PER_AXIS));
  const sampledWidth = Math.floor((width + stepX - 1) / stepX);
  const sampledHeight = Math.floor((height + stepY - 1) / stepY);
  const pixels: Array<[number, number, number, number]> = [];
  for (let y = 0; y < height; y += stepY) {
    const line = lines[y]!;
    for (let x = 0; x < width; x += stepX) {
      const o = x * channels;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 3) {
        const index = line[o]!;
        if (palette !== null && index * 3 + 2 < palette.length) {
          r = palette[index * 3]!;
          g = palette[index * 3 + 1]!;
          b = palette[index * 3 + 2]!;
        } else {
          return { error: "palette PNG without a usable PLTE chunk" };
        }
      } else if (channels === 1) {
        r = g = b = line[o]!;
      } else if (channels === 2) {
        r = g = b = line[o]!;
        a = line[o + 1]!;
      } else {
        r = line[o]!;
        g = line[o + 1]!;
        b = line[o + 2]!;
        if (channels === 4) a = line[o + 3]!;
      }
      pixels.push([r, g, b, a]);
    }
  }

  return { png: { width, height, pixels, sampledWidth, sampledHeight } };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/* -------------------------------------------------------------------------- */
/* Analysis                                                                     */
/* -------------------------------------------------------------------------- */

/** Cap on distinct colours tracked; beyond it the image is 'varied' by definition. */
const MAX_DISTINCT_COLORS = 4096;
/** Dominant-colour share above which the render is called uniform. */
const UNIFORM_RATIO = 0.99;
/** Dominant-colour share above which the render is called blank (flat canvas). */
const BLANK_RATIO = 0.999;

function hex([r, g, b]: [number, number, number, number]): string {
  const to2 = (n: number) => n.toString(16).padStart(2, "0");
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** True for all-white and all-black flat canvases — the empty-render shapes. */
function isExtremeFlatColor(color: string): boolean {
  if (!/^#[0-9a-f]{6}$/.test(color)) return false;
  const r = parseInt(color.slice(1, 3), 16);
  const g = parseInt(color.slice(3, 5), 16);
  const b = parseInt(color.slice(5, 7), 16);
  return (r >= 250 && g >= 250 && b >= 250) || (r <= 5 && g <= 5 && b <= 5);
}

/** Flat colour bands: a row/col whose sampled pixels all share one colour. */
function flatBandCounts(
  pixels: Array<[number, number, number, number]>,
  sampledWidth: number,
  sampledHeight: number,
): { uniformRows: number; uniformCols: number; rowBand: boolean; colBand: boolean } {
  let uniformRows = 0;
  let uniformCols = 0;
  for (let y = 0; y < sampledHeight; y++) {
    const first = hex(pixels[y * sampledWidth]!);
    let flat = true;
    for (let x = 1; x < sampledWidth; x++) {
      if (hex(pixels[y * sampledWidth + x]!) !== first) {
        flat = false;
        break;
      }
    }
    if (flat && sampledWidth > 1) uniformRows++;
  }
  for (let x = 0; x < sampledWidth; x++) {
    const first = hex(pixels[x]!);
    let flat = true;
    for (let y = 1; y < sampledHeight; y++) {
      if (hex(pixels[y * sampledWidth + x]!) !== first) {
        flat = false;
        break;
      }
    }
    if (flat && sampledHeight > 1) uniformCols++;
  }
  // A "band render" is when *every* sampled row (or col) is a flat band even
  // though the colours differ between rows — the plain-fill / gradient shape.
  return {
    uniformRows,
    uniformCols,
    rowBand: sampledHeight > 1 && uniformRows === sampledHeight,
    colBand: sampledWidth > 1 && uniformCols === sampledWidth,
  };
}

/**
 * The boundary helper: reads PNG bytes and reports what the image looks like
 * structurally. Never throws for bad pixels; undecodable bytes come back as
 * `undecodable` with a warning, so the caller decides what that means.
 */
export function analyzeScreenshot(pngBytes: Uint8Array): ScreenshotAnalysis {
  const { png, error } = decodePng(pngBytes);
  if (png === undefined) {
    return {
      renderStatus: "undecodable",
      dominantColor: "",
      dominantColorRatio: 0,
      colorCount: 0,
      luminanceVariance: 0,
      uniformRows: 0,
      uniformCols: 0,
      sampledWidth: 0,
      sampledHeight: 0,
      warnings: [{ code: "png-invalid", message: `The PNG could not be read: ${error}. No pixel evidence was gathered.`, confidence: 0.9 }],
      error,
    };
  }

  const counts = new Map<string, number>();
  const luminances: number[] = [];
  let colorCountCapped = false;
  for (const px of png.pixels) {
    const key = hex(px);
    const current = counts.get(key) ?? 0;
    if (current === 0 && counts.size >= MAX_DISTINCT_COLORS) {
      colorCountCapped = true;
      continue;
    }
    counts.set(key, current + 1);
    const [r, g, b] = px;
    luminances.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
  }
  const total = png.pixels.length;
  let dominantColor = "";
  let dominantCount = 0;
  for (const [key, count] of counts) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantColor = key;
    }
  }
  const dominantColorRatio = total > 0 ? dominantCount / total : 0;

  const mean = luminances.reduce((s, l) => s + l, 0) / (luminances.length || 1);
  const variance = luminances.reduce((s, l) => s + (l - mean) ** 2, 0) / (luminances.length || 1);
  const luminanceVariance = Math.min(1, variance / (255 * 255));

  const bands = flatBandCounts(png.pixels, png.sampledWidth, png.sampledHeight);

  const warnings: ScreenshotWarning[] = [];
  let renderStatus: ScreenshotRenderStatus = "ok";
  // "Blank" is a flat, extreme-brightness canvas: all-white or all-black (the
  // shapes of an empty Figma render). Any other flat colour is uniform, not blank.
  const isBlankish = isExtremeFlatColor(dominantColor);
  if (dominantColorRatio >= BLANK_RATIO && counts.size <= 2 && isBlankish) {
    renderStatus = "suspect-blank";
    warnings.push({
      code: "near-blank",
      message: `${Math.round(dominantColorRatio * 100)}% of sampled pixels are ${dominantColor} (${counts.size <= 1 ? "a single colour" : `${counts.size} colours`}); the render looks like an empty canvas, not a screen.`,
      confidence: 0.8,
    });
  } else if (dominantColorRatio >= UNIFORM_RATIO) {
    renderStatus = "suspect-uniform";
    warnings.push({
      code: "near-uniform",
      message: `${Math.round(dominantColorRatio * 100)}% of sampled pixels are the single colour ${dominantColor}; the render reads as a plain fill.`,
      confidence: 0.8,
    });
  }

  if (bands.rowBand && counts.size > 2) {
    warnings.push({
      code: "row-band",
      message: `All ${bands.uniformRows} sampled rows are single flat colour bands (${counts.size} colours overall) — the shape of a plain fill or gradient, not a screen.`,
      confidence: 0.6,
    });
  }
  if (bands.colBand && counts.size > 2) {
    warnings.push({
      code: "column-band",
      message: `All ${bands.uniformCols} sampled columns are single flat colour bands (${counts.size} colours overall) — the shape of a plain fill or gradient, not a screen.`,
      confidence: 0.6,
    });
  }
  if (luminanceVariance < 0.001 && renderStatus === "ok") {
    warnings.push({
      code: "low-signal",
      message: `Luminance variance ${luminanceVariance.toFixed(5)} is near zero: almost no visual signal for a critique to work with.`,
      confidence: 0.6,
    });
  }
  if (colorCountCapped) {
    warnings.push({
      code: "color-cap",
      message: `More than ${MAX_DISTINCT_COLORS} distinct sampled colours; colour-count figures below are capped and must be read as "very varied", not exact.`,
      confidence: 0.9,
    });
  }

  return {
    renderStatus,
    dominantColor,
    dominantColorRatio: Math.round(dominantColorRatio * 10000) / 10000,
    colorCount: counts.size,
    luminanceVariance: Math.round(luminanceVariance * 1e6) / 1e6,
    uniformRows: bands.uniformRows,
    uniformCols: bands.uniformCols,
    sampledWidth: png.sampledWidth,
    sampledHeight: png.sampledHeight,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Boundary helper for critique-style review flows                              */
/* -------------------------------------------------------------------------- */

export interface ScreenshotFindingContext {
  /** The revision the screenshot was rendered in (evidence is revision-bound). */
  revisionId: string;
  /** What the screenshot is of, e.g. 'focal frame after repair 2'. */
  reference: string;
}

/**
 * Maps the heuristic warnings into the canonical finding shape. Modest by
 * design: heuristic evidence only — severity `low`/`medium`, confidence held
 * below the 0.6 "confirmed defect" bar so a screenshot sanity flag can never
 * block a gate by itself; the caller decides. Returns null for a clean render,
 * so a "no finding" result is a measured one, not an absent check.
 */
export function screenshotFinding(analysis: ScreenshotAnalysis, context: ScreenshotFindingContext): DesignFinding | null {
  if (analysis.warnings.length === 0) return null;
  const worst = analysis.renderStatus !== "ok" && analysis.renderStatus !== "undecodable";
  return makeFinding({
    ruleId: "screenshot.sanity",
    category: "visual",
    severity: worst ? "medium" : "low",
    confidence: 0.5,
    summary:
      analysis.renderStatus === "ok"
        ? `Screenshot sanity: ${analysis.warnings.length} heuristic warning(s) on '${context.reference}'.`
        : `Screenshot sanity: render reads as '${analysis.renderStatus}' on '${context.reference}'.`,
    rationale:
      "Heuristic pixel evidence from the PNG itself (uniformity, luminance variance, colour bands). It is evidence with confidence, not a verdict: a legitimately empty state looks the same to this check as a failed render.",
    evidence: [
      {
        type: "screenshot-region",
        revisionId: context.revisionId,
        reference: context.reference,
        details: analysis.warnings.map((w) => `${w.code}: ${w.message}`).join(" | "),
      },
    ],
    suggestedFix: "Re-render the target node, and if the render is still blank or flat, check the program that built it for empty regions before spending critique context on the image.",
    verification: `Re-render '${context.reference}' and re-run analyzeScreenshot; the warnings should clear for a real screen.`,
  });
}
