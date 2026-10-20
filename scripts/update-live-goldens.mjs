#!/usr/bin/env node
/**
 * Stores the reviewed reference renders for the live cases.
 *
 * ## What a golden is, and what it is not
 *
 * A golden is a **regression reference**: it records what a screen looked like
 * when a human looked at it, so a later run can be told *that it changed*. It
 * is not an approval — the review rules judge the screen itself, and a golden
 * cannot bless a screen that was never good.
 *
 * That is why a golden is only ever written here, through an explicit
 * approval, and why the write records what changed: a golden update that
 * silently overwrites the reference destroys the very thing it exists to
 * protect.
 *
 * ## The policy
 *
 * A run is compared on two axes, and both have to agree:
 *
 * 1. the **structure** — the node count, the finding count and the region's
 *    names, which say what the screen *is*;
 * 2. the **pixels** — the mean per-channel difference and the share of pixels
 *    that moved, which say how it *looks*.
 *
 * A difference in either is reported. Neither decides alone.
 *
 * Usage:
 *   npm run goldens:update            (dry run: reports what would change)
 *   npm run goldens:update -- --approve   (writes the goldens)
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { compareImages, IMAGE_POLICY } from "./lib/image-diff.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const liveDir = resolve(root, "artifacts/design-benchmark/live");
const shotsDir = resolve(liveDir, "shots");
const goldensDir = resolve(liveDir, "goldens");
const approve = process.argv.includes("--approve");

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

/** The structure of a case, as far as a golden records it. */
function signatureOf(caseBody) {
  const regionNames = Array.isArray(caseBody.plan?.regions) ? caseBody.plan.regions.map((r) => r.id) : [];
  return {
    reviewedNodes: caseBody.reviewedNodes ?? null,
    findingCount: Array.isArray(caseBody.structuralFindings) ? caseBody.structuralFindings.length : null,
    regionNames,
  };
}

await mkdir(goldensDir, { recursive: true });

const files = (await readdir(liveDir)).filter((f) => f.startsWith("case-") && f.endsWith(".json")).sort();
const summary = [];

for (const file of files) {
  const id = file.replace(/^case-/, "").replace(/\.json$/, "");
  const casePath = resolve(liveDir, file);
  if (!existsSync(casePath)) continue;
  const body = JSON.parse(await readFile(casePath, "utf8"));
  const shot = body.screenshotReference;
  if (typeof shot !== "string" || !shot.endsWith(".png")) continue;
  const currentPath = resolve(root, shot);
  if (!existsSync(currentPath)) continue;

  const goldenPath = resolve(goldensDir, `${id}.png`);
  const goldenMetaPath = resolve(goldensDir, `${id}.json`);
  const signature = signatureOf(body);

  let comparison = null;
  if (existsSync(goldenPath)) {
    comparison = compareImages(await readFile(currentPath), await readFile(goldenPath));
  }

  const changed = comparison !== null && comparison.verdict === "differs";
  const structureChanged =
    existsSync(goldenMetaPath) &&
    JSON.stringify(JSON.parse(await readFile(goldenMetaPath, "utf8")).signature) !== JSON.stringify(signature);

  summary.push({
    caseId: id,
    golden: existsSync(goldenPath),
    pixels: comparison?.verdict ?? "no-golden",
    measured: comparison?.measured ?? null,
    structureChanged,
    signature,
  });

  if (approve) {
    await writeFile(goldenPath, await readFile(currentPath));
    await writeFile(
      goldenMetaPath,
      `${JSON.stringify(
        {
          caseId: id,
          commit,
          createdAt: new Date().toISOString(),
          screenshotReference: `artifacts/design-benchmark/live/goldens/${id}.png`,
          policy: IMAGE_POLICY,
          signature,
          note: "A regression reference, not an approval. The review rules judge the screen; this records what it looked like.",
        },
        null,
        2,
      )}\n`,
    );
  }
}

const writeCount = summary.filter((s) => s.pixels !== "match" || s.structureChanged).length;
console.log(
  JSON.stringify(
    {
      mode: approve ? "approve" : "dry-run",
      commit: commit.slice(0, 12),
      policy: IMAGE_POLICY,
      cases: summary.length,
      changed: writeCount,
      detail: summary,
    },
    null,
    2,
  ),
);

if (!approve && writeCount > 0) {
  console.log("");
  console.log(`${writeCount} case(s) differ from their golden. Re-run with --approve to store the new references, after looking at them.`);
}
