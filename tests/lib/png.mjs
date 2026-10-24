/**
 * Minimal real-PNG fixtures for tests that exercise render evidence.
 *
 * The render pipeline now sanity-checks the IMAGE (issue #26: a render that
 * decodes to a blank canvas is not visual evidence), so fixtures must return
 * actual PNG bytes — the old `"aGVsbG8="` placeholder is honestly flagged as
 * undecodable now. This encoder produces 8-bit non-interlaced RGB PNGs
 * (colour type 2) via node:zlib, no dependencies.
 */
import { deflateSync } from "node:zlib";

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** An 8-bit RGB PNG; each pixel is `pixelFn(x, y)` → [r, g, b]. */
export function pngFromPixels(width, height, pixelFn) {
  const stride = width * 3;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + stride)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelFn(x, y);
      const o = y * (1 + stride) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A varied image (gradient + a colour block): passes the screenshot sanity check. */
export function realScreenPng() {
  return pngFromPixels(16, 12, (x, y) => {
    if (x >= 10 && y >= 8) return [30, 60, 200];
    return [240 - (y * 18) % 200, 160 - (x * 9) % 150, 120 + ((x + y) * 7) % 130];
  });
}

/** An all-white flat canvas: the suspect-blank render shape. */
export function blankPng() {
  return pngFromPixels(16, 12, () => [255, 255, 255]);
}
