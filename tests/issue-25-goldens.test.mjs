/**
 * Issue #25 close-out: the negative control's refusal is a regression reference.
 *
 * `generic-saas-dashboard` exists to prove the product guard refuses a generic
 * metric-card dashboard — its value is the recorded refusal, not a built frame.
 * The golden layer used to skip it (no PNG to compare), so the one case that
 * proves the guard works had nothing to regress against. These tests pin the
 * fix: a GUARD_BLOCKED record for a declared negative control is covered by a
 * *refusal golden* (`goldens/<id>.refusal.json`), stored only through the
 * explicit --approve path, compared on the stable shape of the refusal (which
 * rules, how many) plus the case's structure signature.
 *
 * The scripts are exercised the way tests/live-evidence.test.mjs exercises the
 * validator: spawned as subprocesses against a throwaway FIGDES_LIVE_DIR, so
 * what is tested is the real script, not a copy of its logic.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deflateSync } from "node:zlib";

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const validatorScript = join(root, "scripts/run-live-benchmark.mjs");
const goldensScript = join(root, "scripts/update-live-goldens.mjs");

const HEAD12 = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { cwd: root }).toString().trim();
const HEAD_FULL = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();

const NEGATIVE_CONTROL = "generic-saas-dashboard";

/** A GUARD_BLOCKED record for the declared negative control, as the loop writes it. */
const refusalCase = (overrides = {}) => ({
  caseId: NEGATIVE_CONTROL,
  status: "GUARD_BLOCKED",
  guardViolations: [
    { rule: "product", message: "exo.no-generic-saas: contradicts: Avoid generic SaaS dashboard composition. [maxComponents=3]" },
  ],
  commit: HEAD_FULL,
  serverBuild: HEAD12,
  pluginBuild: HEAD12,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * A minimal valid PNG, so the PNG-golden path can be pinned too.      *
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function makePng(width, height, fill = [250, 250, 250, 255]) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(fill, y * (stride + 1) + 1 + x * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------ *
 * Running the real scripts against a throwaway directory.             *
 * ------------------------------------------------------------------ */

/** The scripts print JSON first; a dry run may append a trailing sentence. */
function parseLeadingJson(text) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(0, i + 1));
    }
  }
  throw new Error(`no leading JSON object in: ${text.slice(0, 120)}`);
}

async function makeLiveDir(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "figdes-issue25-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), JSON.stringify(body, null, 2), "utf8");
  }
  return dir;
}

async function runValidator(dir) {
  const out = join(dir, "report.json");
  await run(process.execPath, [validatorScript], {
    env: { ...process.env, FIGDES_LIVE_DIR: dir, FIGDES_LIVE_REPORT: out },
  });
  return JSON.parse(await readFile(out, "utf8"));
}

async function runGoldens(dir, args = []) {
  const { stdout } = await run(process.execPath, [goldensScript, ...args], {
    env: { ...process.env, FIGDES_LIVE_DIR: dir },
  });
  return parseLeadingJson(stdout);
}

const vrEntry = (report, caseId) => report.visualRegression.cases.find((v) => v.caseId === caseId);

test("issue-25 goldens: a matched refusal golden covers the negative control", async () => {
  const dir = await makeLiveDir({ [`case-${NEGATIVE_CONTROL}.json`]: refusalCase() });
  try {
    // The refusal golden is stored the only way a golden is ever stored: the
    // explicit approval path, run first so the validator has a reference.
    await runGoldens(dir, ["--approve"]);
    const report = await runValidator(dir);
    const entry = vrEntry(report, NEGATIVE_CONTROL);
    assert.equal(entry.verdict, "match", JSON.stringify(entry));
    assert.equal(entry.refusalGolden, true, "the coverage must come from the refusal golden, not the PNG path");
    assert.ok(
      !report.visualRegression.uncovered.includes(NEGATIVE_CONTROL),
      `expected the negative control to be covered, got ${JSON.stringify(report.visualRegression.uncovered)}`,
    );
    assert.deepEqual(report.visualRegression.refusalDrift, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-25 goldens: a refusal that no longer matches its golden is refusalDrift", async () => {
  const dir = await makeLiveDir({ [`case-${NEGATIVE_CONTROL}.json`]: refusalCase() });
  try {
    await runGoldens(dir, ["--approve"]);
    // The guard now refuses on a different rule: the same shape of refusal it
    // was approved against, but not the same refusal. That must be named.
    await writeFile(
      join(dir, `case-${NEGATIVE_CONTROL}.json`),
      JSON.stringify(refusalCase({ guardViolations: [{ rule: "structure", message: "a different refusal" }] }), null, 2),
      "utf8",
    );
    const report = await runValidator(dir);
    const entry = vrEntry(report, NEGATIVE_CONTROL);
    assert.equal(entry.verdict, "differs", JSON.stringify(entry));
    assert.equal(entry.guardDrift, true, "the drift is in the recorded guard violations");
    assert.ok(report.visualRegression.refusalDrift.includes(NEGATIVE_CONTROL), JSON.stringify(report.visualRegression));
    assert.ok(report.visualRegression.differing.includes(NEGATIVE_CONTROL), "drift is also a difference");
    assert.ok(
      !report.visualRegression.uncovered.includes(NEGATIVE_CONTROL),
      "a drifted golden is not 'uncovered' — it exists and was compared",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-25 goldens: without a refusal golden the negative control is still uncovered", async () => {
  const dir = await makeLiveDir({ [`case-${NEGATIVE_CONTROL}.json`]: refusalCase() });
  try {
    const report = await runValidator(dir);
    const entry = vrEntry(report, NEGATIVE_CONTROL);
    assert.equal(entry.verdict, "no-golden", JSON.stringify(entry));
    assert.ok(
      report.visualRegression.uncovered.includes(NEGATIVE_CONTROL),
      "no reference means no coverage, exactly as before this change",
    );
    assert.deepEqual(report.visualRegression.refusalDrift, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-25 goldens: goldens dry-run writes nothing; --approve writes the refusal golden and leaves PNG cases alone", async () => {
  const dir = await makeLiveDir({
    [`case-${NEGATIVE_CONTROL}.json`]: refusalCase(),
    "case-exo-configuration.json": {
      caseId: "exo-configuration",
      // An absolute shot path keeps the fixture self-contained: the script
      // resolves screenshot references against the repository root.
      screenshotReference: null, // filled in below
      reviewedNodes: 13,
      structuralFindings: [],
      plan: { regions: [{ id: "head" }, { id: "form" }] },
    },
  });
  try {
    const shotPath = join(dir, "shots", "exo-configuration-r1.png");
    await mkdir(join(dir, "shots"), { recursive: true });
    await writeFile(shotPath, makePng(8, 8));
    const pngCase = JSON.parse(await readFile(join(dir, "case-exo-configuration.json"), "utf8"));
    pngCase.screenshotReference = shotPath;
    await writeFile(join(dir, "case-exo-configuration.json"), JSON.stringify(pngCase, null, 2), "utf8");

    // A pre-existing reviewed PNG golden, so "the PNG cases are untouched" has
    // something concrete to be measured against.
    await mkdir(join(dir, "goldens"), { recursive: true });
    const goldenPng = makePng(8, 8);
    const goldenPngPath = join(dir, "goldens", "exo-configuration.png");
    const goldenMetaPath = join(dir, "goldens", "exo-configuration.json");
    await writeFile(goldenPngPath, goldenPng);
    const goldenMeta = {
      caseId: "exo-configuration",
      signature: { reviewedNodes: 13, findingCount: 0, regionNames: ["head", "form"] },
    };
    const goldenMetaText = `${JSON.stringify(goldenMeta, null, 2)}\n`;
    await writeFile(goldenMetaPath, goldenMetaText, "utf8");

    // Dry run: reports what would change, writes nothing.
    const dry = await runGoldens(dir, []);
    assert.equal(dry.mode, "dry-run");
    const refusalGoldenPath = join(dir, "goldens", `${NEGATIVE_CONTROL}.refusal.json`);
    assert.ok(!existsSync(refusalGoldenPath), "a dry run must not write the refusal golden");
    assert.deepEqual(
      (await readdir(join(dir, "goldens"))).sort(),
      ["exo-configuration.json", "exo-configuration.png"],
      "a dry run must not write the refusal golden",
    );
    assert.equal(Buffer.compare(await readFile(goldenPngPath), goldenPng), 0, "the PNG golden bytes are untouched by a dry run");
    assert.equal(await readFile(goldenMetaPath, "utf8"), goldenMetaText, "the PNG golden meta is untouched by a dry run");
    const dryEntry = dry.detail.find((s) => s.caseId === NEGATIVE_CONTROL);
    assert.equal(dryEntry.refusalDrift, "missing", JSON.stringify(dryEntry));
    assert.ok(dry.changed >= 1, "the missing refusal golden is reported as something a dry run would change");

    // Approve: the refusal golden is written; the PNG golden's bytes are the
    // same reviewed pixels as before.
    const approved = await runGoldens(dir, ["--approve"]);
    assert.equal(approved.mode, "approve");
    assert.ok(existsSync(refusalGoldenPath), "--approve must write the refusal golden");
    const refusalGolden = JSON.parse(await readFile(refusalGoldenPath, "utf8"));
    const caseBody = refusalCase();
    assert.equal(refusalGolden.caseId, NEGATIVE_CONTROL);
    assert.deepEqual(refusalGolden.guardViolations, caseBody.guardViolations);
    assert.deepEqual(refusalGolden.signature, { reviewedNodes: null, findingCount: null, regionNames: [] });
    assert.equal(typeof refusalGolden.commit, "string");
    assert.equal(typeof refusalGolden.createdAt, "string");
    assert.match(refusalGolden.note, /regression reference, not an approval/);
    assert.equal(
      Buffer.compare(await readFile(goldenPngPath), goldenPng),
      0,
      "--approve stores the same reviewed pixels for the PNG case, not a re-render",
    );
    const approvedPngMeta = JSON.parse(await readFile(goldenMetaPath, "utf8"));
    assert.deepEqual(approvedPngMeta.signature, goldenMeta.signature);
    assert.equal(approvedPngMeta.caseId, goldenMeta.caseId);

    // And once stored, a second dry run reports nothing left to change.
    const settled = await runGoldens(dir, []);
    assert.equal(settled.changed, 0, JSON.stringify(settled.detail));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("issue-25 goldens: the goldens dry run names refusal drift too", async () => {
  const dir = await makeLiveDir({ [`case-${NEGATIVE_CONTROL}.json`]: refusalCase() });
  try {
    await runGoldens(dir, ["--approve"]);
    const refusalGoldenPath = join(dir, "goldens", `${NEGATIVE_CONTROL}.refusal.json`);
    const storedRefusal = await readFile(refusalGoldenPath, "utf8");
    await writeFile(
      join(dir, `case-${NEGATIVE_CONTROL}.json`),
      JSON.stringify(
        refusalCase({
          guardViolations: [
            { rule: "product", message: "same rule" },
            { rule: "structure", message: "an extra violation" },
          ],
        }),
        null,
        2,
      ),
      "utf8",
    );
    const dry = await runGoldens(dir, []);
    const entry = dry.detail.find((s) => s.caseId === NEGATIVE_CONTROL);
    assert.equal(entry.refusalDrift, "guardViolations", JSON.stringify(entry));
    assert.equal(
      await readFile(refusalGoldenPath, "utf8"),
      storedRefusal,
      "a dry run still writes nothing: the stored reference is byte-for-byte what --approve left",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
