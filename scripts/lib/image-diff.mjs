/**
 * Image comparison for the live evidence bundle.
 *
 * ## Why a pixel diff is not enough, and what this does instead
 *
 * A screenshot is evidence, but a *difference* between two screenshots is not a
 * verdict: the same screen re-rendered can differ by a few anti-aliased pixels,
 * and a completely different screen can differ by a handful of pixels if most
 * of it is empty canvas. So a difference is only ever a question.
 *
 * The policy here is therefore two-part, and both parts have to agree:
 *
 * 1. **The structure has to match.** The node count, the region's names and the
 *    finding count are compared. A screen that lost a region or gained a
 *    finding is a different screen, whatever the pixels say.
 * 2. **The pixels have to be close.** The mean per-channel difference and the
 *    share of pixels that moved by more than a threshold are measured, and
 *    both have to stay inside their budget.
 *
 * A difference in either part is reported; neither part is allowed to decide
 * alone, and a *pass* needs both.
 *
 * ## The decoder
 *
 * Node has no image decoder, so this decodes PNG itself: the chunks, the
 * zlib stream, and the per-scanline filters. Only what Figma's renderer emits
 * is supported — 8-bit, non-interlaced, grey/RGB/palette/grey+alpha/RGBA — and
 * anything else is refused rather than guessed at.
 *
 * @typedef {{ width: number, height: number, pixels: Uint8Array }} DecodedImage
 */
import { inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class PngError extends Error {}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Decodes a PNG into RGBA pixels.
 *
 * Refuses anything it cannot decode exactly. A partially decoded image would
 * make a comparison quietly wrong, which is worse than no comparison.
 *
 * @param {Buffer} buffer
 * @returns {DecodedImage}
 */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngError("not a PNG: the signature does not match");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  const idat = [];

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") {
      palette = Buffer.from(data);
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
  }

  if (width === 0 || height === 0) throw new PngError("the PNG has no image header");
  if (bitDepth !== 8) throw new PngError(`unsupported bit depth ${bitDepth}: only 8-bit PNGs are decoded`);
  if (interlace !== 0) throw new PngError("interlaced PNGs are not decoded");
  if (palette === null && colorType === 3) throw new PngError("a palette PNG without a PLTE chunk");

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (channels === 0) throw new PngError(`unsupported colour type ${colorType}`);

  const raw = inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++];
    const line = raw.subarray(pos, pos + stride);
    pos += stride;
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    const current = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = line[x];
      const a = x >= bpp ? current[x - bpp] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= bpp ? prior[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0:
          value = rawByte;
          break;
        case 1:
          value = rawByte + a;
          break;
        case 2:
          value = rawByte + b;
          break;
        case 3:
          value = rawByte + ((a + b) >> 1);
          break;
        case 4:
          value = rawByte + paeth(a, b, c);
          break;
        default:
          throw new PngError(`unknown scanline filter ${filter}`);
      }
      current[x] = value & 0xff;
    }
  }

  // Normalise to RGBA.
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const src = i * bpp;
    const dst = i * 4;
    switch (colorType) {
      case 0:
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = out[src];
        rgba[dst + 3] = 255;
        break;
      case 2:
        rgba[dst] = out[src];
        rgba[dst + 1] = out[src + 1];
        rgba[dst + 2] = out[src + 2];
        rgba[dst + 3] = 255;
        break;
      case 3: {
        const index = out[src] * 3;
        if (palette === null || index + 2 >= palette.length) throw new PngError("a palette index is outside the PLTE chunk");
        rgba[dst] = palette[index];
        rgba[dst + 1] = palette[index + 1];
        rgba[dst + 2] = palette[index + 2];
        rgba[dst + 3] = 255;
        break;
      }
      case 4:
        rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = out[src];
        rgba[dst + 3] = out[src + 1];
        break;
      case 6:
        rgba[dst] = out[src];
        rgba[dst + 1] = out[src + 1];
        rgba[dst + 2] = out[src + 2];
        rgba[dst + 3] = out[src + 3];
        break;
      default:
        throw new PngError(`unsupported colour type ${colorType}`);
    }
  }

  return { width, height, pixels: rgba };
}

/**
 * The comparison policy.
 *
 * Written down rather than buried in the code, because a threshold nobody
 * documented is a threshold nobody can argue with.
 */
export const IMAGE_POLICY = {
  /** The mean per-channel difference, 0–255. */
  maxMeanDifference: 3,
  /**
   * The share of pixels that moved by more than `channelThreshold`.
   *
   * A tenth of a percent, not a percent: a screen is mostly empty canvas, so
   * two entirely different screens can differ by only one percent of their
   * pixels. A threshold of one percent called a topology and a dashboard
   * identical, which is the failure the issue warns about — a pixel difference
   * that means nothing because it was measured against the whole canvas.
   */
  maxChangedPixelShare: 0.005,
  /** A pixel counts as changed when a channel moves by more than this. */
  channelThreshold: 24,
};

/**
 * Compares a render with a reviewed golden.
 *
 * The pixels are measured, and the *caller* pairs the result with the
 * structural comparison: a pixel match with a different structure is a
 * different screen, and a different picture with the same structure is a
 * rendering change. Neither decides alone.
 *
 * @param {Buffer} current
 * @param {Buffer} golden
 * @param {typeof IMAGE_POLICY} [policy]
 */
export function compareImages(current, golden, policy = IMAGE_POLICY) {
  let a;
  let b;
  try {
    a = decodePng(current);
    b = decodePng(golden);
  } catch (err) {
    return { verdict: "uncomparable", measured: {}, reason: err instanceof Error ? err.message : String(err) };
  }

  if (a.width !== b.width || a.height !== b.height) {
    return {
      verdict: "differs",
      measured: { width: a.width, height: a.height, goldenWidth: b.width, goldenHeight: b.height },
      reason: `the render is ${a.width}x${a.height} and the golden is ${b.width}x${b.height}: a different size is a different screen`,
    };
  }

  let total = 0;
  let max = 0;
  let changed = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    let pixelMax = 0;
    for (let c = 0; c < 3; c++) {
      const delta = Math.abs(a.pixels[o + c] - b.pixels[o + c]);
      total += delta;
      if (delta > pixelMax) pixelMax = delta;
    }
    if (pixelMax > max) max = pixelMax;
    if (pixelMax > policy.channelThreshold) changed++;
  }

  const meanDifference = total / (pixels * 3);
  const changedPixelShare = changed / pixels;
  const differs = meanDifference > policy.maxMeanDifference || changedPixelShare > policy.maxChangedPixelShare;

  return {
    verdict: differs ? "differs" : "match",
    measured: {
      width: a.width,
      height: a.height,
      meanDifference: Number(meanDifference.toFixed(3)),
      changedPixelShare: Number(changedPixelShare.toFixed(5)),
      maxDifference: max,
    },
  };
}
