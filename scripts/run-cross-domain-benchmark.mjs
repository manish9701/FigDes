#!/usr/bin/env node
/**
 * Cross-domain benchmark runner (GitHub issue #27).
 *
 * Runs the twelve cross-domain fixtures against the real planner and guard
 * bundles: seven artefact-led domains (editorial, landing, mobile, dataviz,
 * diagram, identity, design-system), the content-led `product-ui` fixture,
 * the two general decision-led fixtures (the deploy flow and the dense ops
 * console) must plan their own compositions under NO product profile, the
 * EXO control must keep its product power inside its profile, and the guard
 * lane must refuse to lend EXO's truth set to a project that did not name it.
 *
 * Output: artifacts/cross-domain/result.json (the versioned report)
 * Exit:   0 iff the benchmark verdict is PASS; 1 on FAIL; 2 when the
 *         dist-test bundles are missing (never a benchmark FAIL — the run
 *         did not happen and must not be recorded as one).
 *
 * Memory note: memory/store.ts binds DESIGN_AGENT_MEMORY_DIR at module load,
 * so a fresh temp dir is set BEFORE any dist-test import; the guard lane's
 * project keys seed no profile.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Bind the memory store to a fresh directory first — the store reads this at
// import time, and the guard lane needs a store with no stored rules.
process.env.DESIGN_AGENT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "cross-domain-benchmark-"));
process.env.DESIGN_AGENT_SNAPSHOT_DIR = join(process.env.DESIGN_AGENT_MEMORY_DIR, "snapshots");

let buildPlan, planScreen, designGuardTool, runCrossDomainBenchmark, CROSS_DOMAIN_VERSION;
try {
  ({ buildPlan } = await import("../mcp-server/dist-test/plan/tools.js"));
  ({ planScreen } = await import("../mcp-server/dist-test/plan/planner.js"));
  ({ designGuardTool } = await import("../mcp-server/dist-test/memory/tools.js"));
  ({ runCrossDomainBenchmark, CROSS_DOMAIN_VERSION } = await import("../mcp-server/dist-test/design/benchmark/cross-domain.js"));
} catch (error) {
  console.error("cross-domain benchmark could not load its dist-test bundles — run `npm run build:test` first.");
  console.error(
    `if cross-domain.js is still absent after that, add benchmark/cross-domain.ts to the build:design esbuild entry list (${error?.message ?? error}).`,
  );
  process.exit(2);
}

const report = await runCrossDomainBenchmark({ buildPlan, designGuardTool, planScreen });

const outDir = resolve(root, "artifacts/cross-domain");
mkdirSync(outDir, { recursive: true });
writeFileSync(
  resolve(outDir, "result.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);

const statusOf = (fixture) => {
  const failed = fixture.traits.filter((t) => !t.ok);
  if (fixture.status === "PASS") return "PASS";
  return `${fixture.status} (${failed.map((f) => f.trait).join(", ")})`;
};
for (const fixture of report.results) {
  console.log(`  ${fixture.domain.padEnd(18)} ${statusOf(fixture).padEnd(34)} ${fixture.summary}`);
}
console.log(`cross-domain benchmark: ${report.verdict} (fixtures: ${report.results.length})`);
process.exit(report.verdict === "PASS" ? 0 : 1);
