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
 * ## Refusal goldens (issue #25 close-out)
 *
 * A **negative control** is a case whose contract is to be refused by the
 * product guard (`generic-saas-dashboard`; the declared set lives in
 * run-live-benchmark.mjs). It never builds, so it has no pixels and no PNG —
 * its *value* is the refusal itself. That is still evidence worth a reference:
 * without one, the one case that proves the guard works is the one case with
 * nothing to regress against.
 *
 * So a GUARD_BLOCKED record for a declared negative control is coverable too,
 * through the same explicit `--approve` path: the script stores
 * `goldens/<id>.refusal.json`, holding the recorded violations and the case's
 * structure signature. A refusal golden compares the *stable* shape of the
 * refusal — which rules were violated and how many violations there were; the
 * violation message is written for a human and may be reworded without the
 * behaviour changing.
 *
 * Like every golden, it is a regression reference, not an approval: it records
 * what the guard refused, so a later run can be told that the refusal changed.
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
// FIGDES_LIVE_DIR lets the tests (and any other run) point both live scripts at
// a throwaway directory; unset, this is the same live directory it always was.
const liveDir = resolve(process.env.FIGDES_LIVE_DIR ?? resolve(root, "artifacts/design-benchmark/live"));
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

/**
 * The cases whose contract is to be refused by the product guard.
 *
 * Declared here too so a refusal golden is never stored for a case that was
 * supposed to build and did not — that record is incomplete evidence, and a
 * golden must not launder it into a reference. Keep in sync with
 * NEGATIVE_CONTROLS in run-live-benchmark.mjs.
 */
const NEGATIVE_CONTROLS = new Set(["generic-saas-dashboard"]);

/** The structure of a case, as far as a golden records it. */
function signatureOf(caseBody) {
  const regionNames = Array.isArray(caseBody.plan?.regions) ? caseBody.plan.regions.map((r) => r.id) : [];
  return {
    reviewedNodes: caseBody.reviewedNodes ?? null,
    findingCount: Array.isArray(caseBody.structuralFindings) ? caseBody.structuralFindings.length : null,
    regionNames,
  };
}

/**
 * The stable fingerprint of a refusal.
 *
 * A violation's message is written for the human reading the report, so it can
 * be reworded without the guard's behaviour changing. What identifies the
 * refusal is the violated rule ids and how many violations there were — so
 * that is what a refusal golden compares.
 */
function guardFingerprintOf(violations) {
  const list = Array.isArray(violations) ? violations : [];
  return {
    count: list.length,
    rules: [...new Set(list.map((v) => (typeof v?.rule === "string" ? v.rule : null)).filter(Boolean))].sort(),
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

  // No screenshot means the PNG path below has nothing to compare — but for a
  // declared negative control that refused to build, the refusal itself is the
  // evidence, and it gets a refusal golden through the same approval path.
  if (typeof shot !== "string" || !shot.endsWith(".png")) {
    const violations = Array.isArray(body.guardViolations) ? body.guardViolations : [];
    const isRefusal = body.status === "GUARD_BLOCKED" && NEGATIVE_CONTROLS.has(id) && violations.length > 0;
    if (isRefusal) {
      const refusalPath = resolve(goldensDir, `${id}.refusal.json`);
      const signature = signatureOf(body);
      const fingerprint = guardFingerprintOf(violations);
      const goldenRefusal = existsSync(refusalPath) ? JSON.parse(await readFile(refusalPath, "utf8")) : null;
      const guardDrift =
        goldenRefusal !== null &&
        JSON.stringify(guardFingerprintOf(goldenRefusal.guardViolations)) !== JSON.stringify(fingerprint);
      const structureChanged =
        goldenRefusal !== null &&
        goldenRefusal.signature !== undefined &&
        JSON.stringify(goldenRefusal.signature) !== JSON.stringify(signature);
      const refusalDrift = goldenRefusal === null ? "missing" : guardDrift ? "guardViolations" : structureChanged ? "signature" : null;

      summary.push({
        caseId: id,
        refusal: true,
        golden: goldenRefusal !== null,
        pixels: null,
        measured: null,
        refusalDrift,
        structureChanged,
        signature,
      });

      if (approve) {
        await writeFile(
          refusalPath,
          `${JSON.stringify(
            {
              caseId: id,
              guardViolations: violations,
              guardFingerprint: fingerprint,
              signature,
              commit,
              createdAt: new Date().toISOString(),
              note: "A refusal regression reference, not an approval. It records the refusal a declared negative control received, so a later run can be told that the refusal changed.",
            },
            null,
            2,
          )}\n`,
        );
      }
    }
    continue;
  }

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

const writeCount = summary.filter((s) => (s.refusal ? s.refusalDrift !== null : s.pixels !== "match" || s.structureChanged)).length;
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
