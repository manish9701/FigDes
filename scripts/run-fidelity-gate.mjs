#!/usr/bin/env node
/**
 * Issue #26 — the First-Pass Quality Contract fidelity gate.
 *
 * Runs the fidelity matrix (tests/issue-26-fidelity.test.mjs: scorer units,
 * the layout-type sweep, the release-gate wiring, and the consumer +
 * enterprise plan → runtime → fidelity end-to-end cases) and exits non-zero
 * on failure. Strict by default; `--lenient` reports without failing.
 *
 * The fidelity scorer itself is a single dependency-free module, so this
 * runner bundles it into mcp-server/dist-test when the committed build map
 * (package.json, owned elsewhere) has not produced it yet. Everything else
 * must already be built — the error names the exact `npm run build:<area>`
 * to run, the same way the area test commands assume it.
 *
 * Output: TAP passthrough on stdout plus artifacts/fidelity-gate/latest.json.
 * Usage: node scripts/run-fidelity-gate.mjs [--lenient]
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const lenient = process.argv.includes("--lenient");
const startedAt = new Date();

function fail(message, code = 1) {
  process.stderr.write(`fidelity-gate: ${message}\n`);
  process.exit(code);
}

/* --- the scorer bundle (single file, no imports) --------------------------- */

const fidelitySrc = resolve(root, "mcp-server/src/design/benchmark/fidelity.ts");
const fidelityDist = resolve(root, "mcp-server/dist-test/design/benchmark/fidelity.js");
if (!existsSync(fidelityDist)) {
  if (!existsSync(fidelitySrc)) fail(`missing ${fidelitySrc}`);
  const bundled = spawnSync(
    "npx",
    ["esbuild", fidelitySrc, "--bundle", "--platform=node", "--format=esm", "--target=node20", `--outfile=${fidelityDist}`],
    { cwd: root, encoding: "utf8", shell: true },
  );
  if (bundled.status !== 0) fail(`could not bundle fidelity.ts:\n${bundled.stderr || bundled.stdout}`);
}

/* --- everything else must already be built ---------------------------------- */

const required = new Map([
  ["mcp-server/dist-test/plan/planner.js", "npm run build:plan"],
  ["mcp-server/dist-test/runtime/interpreter.js", "npm run build:runtime"],
  ["mcp-server/dist-test/design/benchmark/regression.js", "npm run build:design"],
  ["mcp-server/dist-test/design/benchmark/suite.js", "npm run build:design"],
  ["mcp-server/dist-test/design/quality/release-gate.js", "npm run build:design"],
  ["mcp-server/dist-test/shared/contrast.js", "npm run build:shared"],
]);
const missing = [...required.entries()].filter(([file]) => !existsSync(resolve(root, file)));
if (missing.length > 0) {
  fail(
    `dist-test is stale. Build it first:\n${[...new Set(missing.map(([, build]) => `  ${build}`))].join("\n")}`,
    2,
  );
}

/* --- the matrix -------------------------------------------------------------- */

let code = 0;
let output = "";
try {
  output = execFileSync("node", ["--test", "tests/issue-26-fidelity.test.mjs"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10 * 60 * 1000,
    shell: true,
  });
} catch (err) {
  code = typeof err?.status === "number" ? err.status : 1;
  output = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
}
process.stdout.write(output);

const sum = (re) => [...output.matchAll(re)].reduce((total, m) => total + Number(m[1]), 0);
const summary = {
  schema: "fidelity-gate-v1",
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  strict: !lenient,
  status: code === 0 ? "PASS" : "FAIL",
  tests: sum(/^# tests (\d+)$/gm),
  pass: sum(/^# pass (\d+)$/gm),
  fail: sum(/^# fail (\d+)$/gm),
};

const outDir = resolve(root, "artifacts/fidelity-gate");
await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`\nfidelity gate: ${summary.status} — ${summary.pass}/${summary.tests} test(s) passed\n`);

if (code !== 0 && !lenient) process.exit(code);
if (code !== 0 && lenient) process.stdout.write("lenient mode: reporting the failure without failing.\n");
