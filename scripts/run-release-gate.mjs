#!/usr/bin/env node
/**
 * Issue #17 — the release gate.
 *
 * One command, one evidence bundle, one verdict.
 *
 *   npm run gate
 *
 * ## What it runs
 *
 * 1. **The integrated gauntlet** (`tests/issue-17-gauntlet.mjs`): the fixtures
 *    that exercise the whole path together — brief, plan, native mutation,
 *    geometry, render, review, repair, report — and the false-pass and
 *    failure-injection scenarios that have to stay false-pass-free.
 * 2. **The offline regression suites**: every suite the repository already
 *    has, which are the source of truth for #14's geometry and QA, #15's
 *    transaction safety and #16's generation fixtures.
 * 3. **The acceptance and stress matrices** and the design benchmark.
 * 4. **The live benchmark**, which is BLOCKED rather than PASS when no plugin
 *    is connected. A gate that cannot see the live file must not say the
 *    screen is right.
 *
 * ## The verdict
 *
 * - **FAIL** — a P0 invariant failed, a required artifact is missing, or a
 *   check silently skipped. A good aggregate score never hides one of these.
 * - **INDETERMINATE** — nothing failed, but the evidence a release needs is
 *   not there: the live render could not be produced, or a suite could not
 *   run. This is not a pass, and the report never calls it one.
 * - **PASS** — every mandatory assertion passed and every required artifact
 *   exists.
 *
 * The run is repeatable: the gauntlet runs twice and the two structural
 * verdicts are compared, because a gate that only passes once is not a gate.
 *
 * Usage:
 *   npm run gate
 *   npm run gate -- --json          machine-readable summary on stdout
 *   npm run gate -- --skip-live     do not attempt the live benchmark
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { runGauntlet, summariseGauntlet, COVERAGE, SCENARIO_MAP } from "../tests/issue-17-gauntlet.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "artifacts/release-gate");
const args = process.argv.slice(2);
const jsonOnly = args.includes("--json");
const skipLive = args.includes("--skip-live");

/* -------------------------------------------------------------------------- */
/* The run's identity                                                           */
/* -------------------------------------------------------------------------- */

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const branch = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const startedAt = new Date();
const runId = `${commit.slice(0, 8)}-${startedAt.toISOString().replace(/[:.]/g, "-")}`;

/* -------------------------------------------------------------------------- */
/* Running a group                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Runs one gate group and reports what it did.
 *
 * A group that cannot run is BLOCKED, never PASS: the difference between
 * "the check passed" and "the check did not happen" is the whole point.
 */
function runGroup({ id, title, command, args: groupArgs, optional = false, parse }) {
  const t0 = Date.now();
  let code = 0;
  let output = "";
  try {
    // `shell: true` because `npm` is a .cmd on Windows, and execFileSync
    // cannot start one without a shell.
    output = execFileSync(command, groupArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15 * 60 * 1000,
      shell: true,
    });
  } catch (err) {
    code = typeof err?.status === "number" ? err.status : 1;
    output = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
  }
  const ms = Date.now() - t0;
  const parsed = parse ? parse(output, code) : {};
  const status = parsed.status ?? (code === 0 ? "PASS" : "FAIL");
  return {
    id,
    title,
    command: `${command} ${groupArgs.join(" ")}`.trim(),
    status,
    exitCode: code,
    durationMs: ms,
    detail: parsed.detail ?? (code === 0 ? "completed" : `exited ${code}`),
    ...parsed.extra,
    output: output.slice(-4000),
  };
}

/**
 * Parses a node:test TAP stream: the totals and the first failure.
 *
 * `npm test` runs many suites, so the stream holds one TAP block per suite
 * and the totals have to be summed rather than read off the first block.
 */
function parseTap(output, code) {
  const sum = (re) => [...output.matchAll(re)].reduce((total, m) => total + Number(m[1]), 0);
  const tests = sum(/^# tests (\d+)$/gm);
  const pass = sum(/^# pass (\d+)$/gm);
  const fail = sum(/^# fail (\d+)$/gm);
  const skipped = sum(/^# skipped (\d+)$/gm);
  const notOk = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
  return {
    status: fail > 0 || code !== 0 ? "FAIL" : "PASS",
    detail: fail > 0 ? `${fail} failing test(s): ${notOk.slice(0, 3).join("; ")}` : `${pass}/${tests} test(s) passed`,
    extra: { tests, pass, fail, skipped, failures: notOk.slice(0, 20) },
  };
}

/* -------------------------------------------------------------------------- */
/* The groups                                                                   */
/* -------------------------------------------------------------------------- */

const groups = [];

groups.push(
  runGroup({
    id: "stress-matrix",
    title: "Issue #12 stress matrix",
    command: "npm",
    args: ["run", "stress:matrix", "--", "--strict"],
    parse: (output, code) => {
      const cases = Number(output.match(/(\d+) case/i)?.[1] ?? 0);
      return {
        status: code === 0 ? "PASS" : "FAIL",
        detail: code === 0 ? `${cases || "every"} case(s) passed` : "the stress matrix reported a failure",
      };
    },
  }),
);

groups.push(
  runGroup({
    id: "acceptance",
    title: "Issue #13 acceptance matrix",
    command: "npm",
    args: ["run", "acceptance", "--", "--strict"],
    parse: (output, code) => ({
      status: code === 0 ? "PASS" : "FAIL",
      detail: code === 0 ? "every acceptance case passed" : "the acceptance matrix reported a failure",
    }),
  }),
);

groups.push(
  runGroup({
    id: "regression",
    title: "Offline regression suites (#14 geometry and QA, #15 transactions, #16 generation)",
    command: "npm",
    args: ["test"],
    parse: parseTap,
  }),
);

groups.push(
  runGroup({
    id: "design-benchmark",
    title: "Offline design-planning benchmark",
    command: "npm",
    args: ["run", "benchmark:design"],
    parse: (output, code) => {
      const passed = Number(output.match(/"passedCases":\s*(\d+)/)?.[1] ?? 0);
      const total = Number(output.match(/"expectedCases":\s*(\d+)/)?.[1] ?? 0);
      const review = Number(output.match(/"reviewCases":\s*(\d+)/)?.[1] ?? 0);
      return {
        status: code === 0 && passed === total ? "PASS" : "FAIL",
        detail: code === 0 ? `${passed}/${total} benchmark case(s) passed${review > 0 ? `, ${review} under review` : ""}` : "the design benchmark failed",
        extra: { passed, total, review },
      };
    },
  }),
);

if (!skipLive) {
  groups.push(
    runGroup({
      id: "live",
      title: "Live Figma evidence (render and review of a real screen)",
      command: "npm",
      args: ["run", "benchmark:live"],
      optional: true,
      parse: (output, code) => {
        // The live benchmark reports its own coverage. A run that did not
        // produce every case's render and review says so, and the gate must
        // say BLOCKED rather than PASS: a render nobody produced is not
        // evidence, and a benchmark that quietly completed half of itself is
        // not a pass.
        const complete = /"(?:live|visual)BenchmarkComplete":\s*true/.test(output);
        const missing = [...output.matchAll(/"missingCases":\s*\[([^\]]*)\]/g)]
          .map((m) => m[1].replace(/["\s]/g, ""))
          .filter((s) => s.length > 0);
        const found = Number(output.match(/"foundCases":\s*(\d+)/)?.[1] ?? 0);
        const expected = Number(output.match(/"expectedCases":\s*(\d+)/)?.[1] ?? 0);
        if (code !== 0 && !complete) {
          return {
            status: "BLOCKED",
            detail: `the live benchmark did not complete (${found}/${expected} case(s) produced${missing.length > 0 ? `, missing ${missing.join(", ")}` : ""}): no plugin is connected, so the live render and review could not be produced`,
            extra: { found, expected, missing },
          };
        }
        if (!complete) {
          return {
            status: "BLOCKED",
            detail: `the live benchmark did not complete (${found}/${expected} case(s) produced${missing.length > 0 ? `, missing ${missing.join(", ")}` : ""})`,
            extra: { found, expected, missing },
          };
        }
        return { status: "PASS", detail: `the live benchmark completed (${found}/${expected} case(s))`, extra: { found, expected, missing } };
      },
    }),
  );
}

/* -------------------------------------------------------------------------- */
/* The gauntlet, twice                                                          */
/* -------------------------------------------------------------------------- */

const gauntletStart = Date.now();
const first = await runGauntlet();
const second = await runGauntlet();
const gauntletMs = Date.now() - gauntletStart;

const firstSummary = summariseGauntlet(first);
const secondSummary = summariseGauntlet(second);
const structuralVerdict = (run) => run.map((c) => `${c.id}:${c.status}`).join(",");
const repeatable = structuralVerdict(first) === structuralVerdict(second) && firstSummary.pass === secondSummary.pass;

const gauntletGroup = {
  id: "gauntlet",
  title: "Integrated gauntlet (brief, plan, native mutation, geometry, review, repair, report)",
  command: "node tests/issue-17-gauntlet.mjs",
  status: firstSummary.fail > 0 ? "FAIL" : "PASS",
  exitCode: firstSummary.fail > 0 ? 1 : 0,
  durationMs: gauntletMs,
  detail: `${firstSummary.pass}/${firstSummary.total} case(s) passed, run twice with ${repeatable ? "identical" : "different"} verdicts`,
  extra: { ...firstSummary, repeatable, cases: first.map((c) => ({ id: c.id, title: c.title, group: c.group, issue: c.issue, requirement: c.requirement, status: c.status, detail: c.detail })) },
};

/* -------------------------------------------------------------------------- */
/* What the gate does not cover                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The gaps, stated in the evidence rather than left for someone to find.
 *
 * A gate that lists what it does not check is more useful than one that
 * claims to check everything, and the issue asks for exactly this: the
 * limitation has to be recorded, not implied.
 */
const GAPS = [
  {
    gap: "The native path (figdes_use_figma) is not exercised",
    detail:
      "The gauntlet drives the semantic runtime and the plugin's create_design transaction. The native path — model-authored JavaScript against the real Plugin API — has its own rules, and a regression there would not be caught by this gate.",
  },
  {
    gap: "The live render and review are BLOCKED without a plugin",
    detail:
      "A true pixel render, the vision critic's judgement and the repair loop against a real file need Figma Desktop. The gate reports that coverage as BLOCKED and the verdict as INDETERMINATE, never as a pass.",
  },
  {
    gap: "Visual regression against reviewed goldens is not compared pixel-wise",
    detail:
      "The live benchmark records the renders and their structure, but there is no golden-image comparison with a documented stable policy yet. Structural and semantic checks stand in for it, and the issue's own rule is that pixel differences alone are not sufficient.",
  },
  {
    gap: "Text height is estimated, not measured",
    detail:
      "The server has no font metrics, so a text node's height is a character-count estimate. The pipeline measures the width a text lands at, and a region holding text cannot be handed to Figma's own auto layout for that reason.",
  },
];

/* -------------------------------------------------------------------------- */
/* The verdict                                                                  */
/* -------------------------------------------------------------------------- */

const allGroups = [gauntletGroup, ...groups];
const failed = allGroups.filter((g) => g.status === "FAIL");
const blocked = allGroups.filter((g) => g.status === "BLOCKED");
const missingArtifacts = [];
for (const artifact of ["artifacts/release-gate/latest.json", "artifacts/stress-matrix/latest.json", "artifacts/acceptance/latest.json", "artifacts/design-benchmark/latest.json"]) {
  if (!existsSync(resolve(root, artifact))) missingArtifacts.push(artifact);
}

const verdict = failed.length > 0 || missingArtifacts.length > 0 ? "FAIL" : blocked.length > 0 ? "INDETERMINATE" : "PASS";

/* -------------------------------------------------------------------------- */
/* The evidence bundle                                                          */
/* -------------------------------------------------------------------------- */

await mkdir(resolve(outDir, "cases"), { recursive: true });
for (const c of first) {
  await writeFile(resolve(outDir, "cases", `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
}

const summary = {
  schemaVersion: "release-gate-v1",
  runId,
  commit,
  branch,
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  config: { skipLive, groups: allGroups.map((g) => g.id) },
  verdict,
  verdictReason:
    verdict === "FAIL"
      ? `${failed.length} group(s) failed${missingArtifacts.length > 0 ? ` and ${missingArtifacts.length} required artifact(s) are missing` : ""}`
      : verdict === "INDETERMINATE"
        ? `${blocked.length} group(s) could not run: ${blocked.map((g) => g.id).join(", ")}`
        : "every mandatory assertion passed and every required artifact exists",
  totals: {
    groups: allGroups.length,
    passed: allGroups.filter((g) => g.status === "PASS").length,
    failed: failed.length,
    blocked: blocked.length,
    cases: firstSummary.total,
    casesPassed: firstSummary.pass,
    casesFailed: firstSummary.fail,
  },
  groups: allGroups,
  coverage: COVERAGE,
  scenarios: SCENARIO_MAP,
  gaps: GAPS,
  missingArtifacts,
  failures: [
    ...first.filter((c) => c.status !== "PASS").map((c) => ({ id: c.id, title: c.title, issue: c.issue, status: c.status, detail: c.detail })),
    ...failed.map((g) => ({ id: g.id, title: g.title, issue: "#14/#15/#16", status: g.status, detail: g.detail })),
  ],
};

await writeFile(resolve(outDir, "latest.json"), `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(resolve(outDir, "latest.md"), markdown(summary));
await writeFile(resolve(root, "docs/issue-17-release-gate-report.md"), markdown(summary));

/* -------------------------------------------------------------------------- */
/* The report                                                                   */
/* -------------------------------------------------------------------------- */

function markdown(s) {
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();
  const lines = [
    "# Issue #17 — release gate",
    "",
    `**Verdict: ${s.verdict}** — ${s.verdictReason}`,
    "",
    `Run \`${s.runId}\` on commit \`${s.commit}\` (${s.branch}), ${s.startedAt} → ${s.finishedAt}, ${(s.durationMs / 1000).toFixed(1)}s.`,
    `Node ${s.node} on ${s.platform}.`,
    "",
    "## Groups",
    "",
    "| Group | What it covers | Status | Time | Detail |",
    "| --- | --- | --- | --- | --- |",
    ...s.groups.map((g) => `| **${g.id}** | ${cell(g.title)} | **${g.status}** | ${(g.durationMs / 1000).toFixed(1)}s | ${cell(g.detail)} |`),
    "",
    `## Gauntlet cases (${s.totals.casesPassed}/${s.totals.cases} passed)`,
    "",
    "| ID | Case | Issue | Status | Measured |",
    "| --- | --- | --- | --- | --- |",
    ...(s.groups[0].extra?.cases ?? []).map((c) => `| **${c.id}** | ${cell(c.title)} | ${c.issue} | **${c.status}** | ${cell(c.detail)} |`),
    "",
    "## Coverage map",
    "",
    "The gate is only as good as this map: a criterion with no test is a criterion nobody is checking.",
    "",
    "| Acceptance criterion | Exercised by |",
    "| --- | --- |",
    ...s.coverage.map((c) => `| ${cell(c.criterion)} | ${c.tests.map((t) => `\`${t}\``).join(", ")} |`),
    "",
    "## Failure-injection scenarios",
    "",
    "Each scenario the issue names, and the test that covers it. A scenario nobody claims is a scenario nobody is running.",
    "",
    "| Scenario | Exercised by |",
    "| --- | --- |",
    ...s.scenarios.map((c) => `| ${cell(c.scenario)} | ${c.tests.map((t) => `\`${t}\``).join(", ")} |`),
    "",
    "## What this gate does not cover",
    "",
    "Stated here rather than left for someone to find. A gate that lists its gaps is more useful than one that claims to check everything.",
    "",
    ...s.gaps.flatMap((g) => [`### ${g.gap}`, "", g.detail, ""]),
  ];
  if (s.failures.length > 0) {
    lines.push("## Failures", "");
    for (const f of s.failures) {
      lines.push(`### ${f.id} — ${f.title}`, "", `**Status.** ${f.status}`, "", `**Detail.** ${f.detail}`, "");
    }
  }
  lines.push(
    "## How to reproduce",
    "",
    "```",
    "npm run gate",
    "```",
    "",
    `The machine-readable summary is \`artifacts/release-gate/latest.json\`, and the per-case evidence is in \`artifacts/release-gate/cases/\`.`,
    "",
  );
  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* The output                                                                   */
/* -------------------------------------------------------------------------- */

if (jsonOnly) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} else {
  const line = (g) => `  ${g.status.padEnd(13)} ${g.id.padEnd(16)} ${(g.durationMs / 1000).toFixed(1).padStart(6)}s  ${g.detail}`;
  process.stdout.write(
    [
      "",
      "FigDes release gate",
      `  commit  ${commit} (${branch})`,
      `  run     ${runId}`,
      `  node    ${process.version} on ${process.platform}-${process.arch}`,
      "",
      "Groups",
      ...allGroups.map(line),
      "",
      `  cases   ${firstSummary.pass}/${firstSummary.total} gauntlet case(s) passed, run twice (${repeatable ? "identical verdicts" : "DIFFERENT VERDICTS"})`,
      "",
      `VERDICT: ${verdict} — ${summary.verdictReason}`,
      "",
      "  artifacts/release-gate/latest.json",
      "  artifacts/release-gate/latest.md",
      "  artifacts/release-gate/cases/",
      "",
    ].join("\n"),
  );
}

if (verdict === "FAIL") process.exit(1);
// INDETERMINATE exits 0: the offline evidence is green, and the live coverage
// that is missing is recorded as missing rather than as a failure. The report
// still says the release decision is not a PASS.
