/**
 * The visual-regression policy (issue #17, §I).
 *
 * The comparison is only as trustworthy as its policy, so the policy is
 * tested here rather than assumed:
 *
 * 1. the decoder reads a real Figma render;
 * 2. it refuses what it cannot decode exactly, rather than guessing;
 * 3. a difference in the structure is a difference, whatever the pixels say;
 * 4. a small pixel difference is *not* a difference — otherwise every
 *    anti-aliased edge would fail the build;
 * 5. a large pixel difference is a difference;
 * 6. a different size is a different screen.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { compareImages, decodePng, IMAGE_POLICY, PngError } from "../scripts/lib/image-diff.mjs";

/**
 * A minimal PNG encoder, so the test can build the images it needs.
 *
 * Filter 0 on every scanline, 8-bit RGBA, one IDAT. That is enough for the
 * decoder under test and nothing more.
 */
function encodePng(width, height, pixels) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(pixels.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (CRC_TABLE === null) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

function solid(width, height, [r, g, b]) {
  const pixels = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    pixels[i * 4] = r;
    pixels[i * 4 + 1] = g;
    pixels[i * 4 + 2] = b;
    pixels[i * 4 + 3] = 255;
  }
  return pixels;
}

test("the decoder reads a real Figma render", () => {
  const png = readFileSync("artifacts/design-benchmark/live/shots/exo-compute-topology-r1.png");
  const image = decodePng(png);
  assert.equal(image.width, 1024);
  assert.equal(image.height, 640);
  assert.equal(image.pixels.length, 1024 * 640 * 4);
  // The canvas is a light surface, so the top-left pixel is not black.
  assert.ok(image.pixels[0] + image.pixels[1] + image.pixels[2] > 300, "the render decoded to something implausible");
});

test("the decoder refuses what it cannot decode exactly", () => {
  assert.throws(() => decodePng(Buffer.from("not a png at all")), PngError);
  assert.throws(() => decodePng(Buffer.alloc(0)), PngError);
  const comparison = compareImages(Buffer.from("nope"), Buffer.from("nope"));
  assert.equal(comparison.verdict, "uncomparable");
  assert.ok(comparison.reason.length > 0, "an uncomparable comparison must say why");
});

test("an identical image matches", () => {
  const png = encodePng(40, 30, solid(40, 30, [250, 248, 240]));
  const comparison = compareImages(png, png);
  assert.equal(comparison.verdict, "match");
  assert.equal(comparison.measured.meanDifference, 0);
  assert.equal(comparison.measured.changedPixelShare, 0);
});

test("a small difference is not a difference", () => {
  // One anti-aliased edge moving by a few levels is not a changed screen.
  const base = solid(40, 30, [250, 248, 240]);
  const nudged = Uint8Array.from(base);
  nudged[0] = 244;
  const comparison = compareImages(encodePng(40, 30, nudged), encodePng(40, 30, base));
  assert.equal(comparison.verdict, "match");
  assert.ok(comparison.measured.meanDifference < IMAGE_POLICY.maxMeanDifference);
});

test("a large difference is a difference", () => {
  const a = solid(40, 30, [250, 248, 240]);
  const b = solid(40, 30, [20, 30, 40]);
  const comparison = compareImages(encodePng(40, 30, a), encodePng(40, 30, b));
  assert.equal(comparison.verdict, "differs");
  assert.ok(comparison.measured.meanDifference > IMAGE_POLICY.maxMeanDifference);
  assert.ok(comparison.measured.changedPixelShare > IMAGE_POLICY.maxChangedPixelShare);
});

test("a different size is a different screen", () => {
  const comparison = compareImages(encodePng(40, 30, solid(40, 30, [0, 0, 0])), encodePng(41, 30, solid(41, 30, [0, 0, 0])));
  assert.equal(comparison.verdict, "differs");
  assert.match(comparison.reason, /different size/);
});

test("two different real renders differ", () => {
  const a = readFileSync("artifacts/design-benchmark/live/shots/exo-compute-topology-r1.png");
  const b = readFileSync("artifacts/design-benchmark/live/shots/generic-saas-dashboard-r1.png");
  const comparison = compareImages(a, b);
  assert.equal(comparison.verdict, "differs", "two different screens compared as identical");
});

test("the policy is documented where it is enforced", () => {
  // A threshold nobody can find is a threshold nobody can argue with.
  for (const key of ["maxMeanDifference", "maxChangedPixelShare", "channelThreshold"]) {
    assert.equal(typeof IMAGE_POLICY[key], "number", `the policy has no ${key}`);
  }
  assert.ok(IMAGE_POLICY.maxMeanDifference > 0 && IMAGE_POLICY.maxMeanDifference <= 32);
  assert.ok(IMAGE_POLICY.maxChangedPixelShare > 0 && IMAGE_POLICY.maxChangedPixelShare <= 0.25);
  assert.ok(IMAGE_POLICY.channelThreshold > 0 && IMAGE_POLICY.channelThreshold <= 64);
});

test("the policy is tight enough to see two different screens", () => {
  // A screen is mostly empty canvas, so a loose threshold calls a topology and
  // a dashboard identical. The two real renders are the check: they differ,
  // and the policy has to say so.
  const a = readFileSync("artifacts/design-benchmark/live/shots/exo-compute-topology-r1.png");
  const b = readFileSync("artifacts/design-benchmark/live/shots/generic-saas-dashboard-r1.png");
  const comparison = compareImages(a, b);
  assert.equal(comparison.verdict, "differs");
  assert.ok(
    comparison.measured.changedPixelShare > IMAGE_POLICY.maxChangedPixelShare,
    `the two renders share ${comparison.measured.changedPixelShare} of their pixels, which is under the ${IMAGE_POLICY.maxChangedPixelShare} budget: the policy cannot see a real change`,
  );
});
