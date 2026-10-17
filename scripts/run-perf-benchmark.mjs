/**
 * Issue #15 — repeatable apply-path benchmark.
 *
 *   node scripts/run-perf-benchmark.mjs [--repeat=3] [--out=artifacts/perf/latest.json]
 *
 * ## What this measures, and what it cannot
 *
 * It runs the real plugin bundle against the mock document, so it measures the
 * plugin's own work: schema parse, per-operation apply, the post-commit verify
 * pass, reveal, and the event-loop yields between operations.
 *
 * It does NOT measure Figma. `figma.createFrame()` and `getNodeByIdAsync()` are
 * near-free in the mock and are real, variable round trips in the editor. So
 * these numbers answer "is the plugin's own path efficient?" and the API call
 * *counts* answer "how many round trips would this cost?" — together they bound
 * the work, but neither is a substitute for the live stage timings that the
 * transaction now reports (`timings.yields`, `timings.perOperation`).
 *
 * Benchmark sizes are the matrix from the issue.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadPlugin, ask } from "../tests/plugin-harness.mjs";
import { screen } from "./lib/screen-workload.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const REPEAT = Math.max(1, Number(args.repeat ?? 3));
const OUT = args.out ?? "artifacts/perf/latest.json";

/* -------------------------------------------------------------------------- */
/* Workload                                                                    */
/* -------------------------------------------------------------------------- */

/** Wraps figma API methods so a run reports round-trip counts, not just time. */
function instrument(figma) {
  const counts = new Map();
  for (const name of [
    "getNodeByIdAsync", "loadFontAsync", "listAvailableFontsAsync", "commitUndo", "triggerUndo",
    "createFrame", "createRectangle", "createEllipse", "createText", "createVector",
    "createComponent", "createInstance", "scrollAndZoomIntoView",
  ]) {
    const original = figma[name];
    if (typeof original !== "function") continue;
    counts.set(name, 0);
    figma[name] = function (...a) { counts.set(name, counts.get(name) + 1); return original.apply(this, a); };
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

async function once(label, targetOps, attempt) {
  const { figma, doc } = loadPlugin();
  const ops = screen(`${label}${attempt}`, targetOps);
  const counts = instrument(figma);
  const before = doc.page.children.length;

  const t0 = performance.now();
  const reply = await ask(figma, "create_design", { transactionId: `txn_bench_${label}_${attempt}`, description: `${label} ${targetOps}`, operations: ops }, { timeoutMs: 180000 });
  const wall = performance.now() - t0;
  const d = reply.data;
  if (!d || d.status !== "success") throw new Error(`${label}/${targetOps} did not commit: ${JSON.stringify(reply).slice(0, 300)}`);

  const t = d.timings ?? {};
  const perOp = t.perOperation ?? [];
  const perOpMs = perOp.reduce((s, p) => s + p.ms, 0);
  const api = Object.fromEntries([...counts.entries()].filter(([, n]) => n > 0));
  const apiTotal = Object.values(api).reduce((s, n) => s + n, 0);

  return {
    ops: ops.length,
    wallMs: Math.round(wall),
    stages: { parse: t.parse ?? 0, apply: t.apply ?? 0, verify: t.verify ?? 0, reveal: t.reveal ?? 0, total: t.total ?? 0 },
    yields: t.yields ?? null,
    perOp: { count: perOp.length, sumMs: perOpMs },
    // How much of `apply` the per-operation times fail to explain. This gap is
    // the diagnostic: a large gap means the time went somewhere other than
    // applying operations, which is how the yield defect was found.
    unexplainedApplyMs: (t.apply ?? 0) - perOpMs,
    cache: t.cache ?? null,
    apiCalls: api,
    apiTotal,
    apiPerOp: Number((apiTotal / ops.length).toFixed(2)),
    nodesCreated: d.createdNodes.length,
    nodeDelta: doc.page.children.length - before,
    unconfirmed: (d.unconfirmedIds ?? []).length,
    cacheHitRate: t.cache ? Number((t.cache.hits / Math.max(1, t.cache.hits + t.cache.misses)).toFixed(3)) : null,
  };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

const MATRIX = [
  { label: "small", ops: 15 },
  { label: "medium", ops: 40 },
  { label: "baseline", ops: 62 },
  { label: "large", ops: 100 },
  { label: "stress", ops: 175 },
];

const results = [];
for (const { label, ops } of MATRIX) {
  const runs = [];
  for (let i = 0; i < REPEAT; i++) runs.push(await once(label, ops, i));
  const summary = {
    label, ops: runs[0].ops,
    wallMedianMs: median(runs.map((r) => r.wallMs)),
    wallWorstMs: Math.max(...runs.map((r) => r.wallMs)),
    applyMedianMs: median(runs.map((r) => r.stages.apply)),
    applyWorstMs: Math.max(...runs.map((r) => r.stages.apply)),
    unexplainedApplyMedianMs: median(runs.map((r) => r.unexplainedApplyMs)),
    yieldCountMedian: median(runs.map((r) => r.yields?.count ?? 0)),
    yieldMsMedian: median(runs.map((r) => r.yields?.ms ?? 0)),
    apiPerOp: runs[0].apiPerOp,
    lookups: runs[0].apiCalls.getNodeByIdAsync ?? 0,
    cacheHitRate: runs[0].cacheHitRate,
    nodesCreated: runs[0].nodesCreated,
    unconfirmed: runs.reduce((s, r) => s + r.unconfirmed, 0),
  };
  results.push({ summary, runs });
}

const pad = (s, n) => String(s).padStart(n);
console.log("\n=== Apply-path benchmark (mock figma: plugin cost + API call counts) ===");
console.log(
  "workload".padEnd(11) + pad("ops", 6) + pad("wall med", 10) + pad("wall max", 10) + pad("apply med", 11) +
  pad("unexpl", 8) + pad("yields", 8) + pad("yield ms", 10) + pad("api/op", 8) + pad("lookups", 9) + pad("cache hit", 11),
);
for (const { summary: s } of results) {
  console.log(
    s.label.padEnd(11) + pad(s.ops, 6) + pad(s.wallMedianMs, 10) + pad(s.wallWorstMs, 10) + pad(s.applyMedianMs, 11) +
    pad(s.unexplainedApplyMedianMs, 8) + pad(s.yieldCountMedian, 8) + pad(s.yieldMsMedian, 10) + pad(s.apiPerOp, 8) +
    pad(s.lookups, 9) + pad(s.cacheHitRate, 11),
  );
}

const failures = results.flatMap(({ summary: s, runs }) =>
  runs.flatMap((r) => [
    r.unconfirmed ? `${s.label}: ${r.unconfirmed} created node(s) did not resolve` : null,
    r.nodesCreated !== r.ops ? `${s.label}: created ${r.nodesCreated} for ${r.ops} ops` : null,
  ].filter(Boolean)));
console.log(failures.length ? `\nFAILURES:\n${failures.join("\n")}` : "\nAll runs committed with every created node resolved.");

const payload = {
  generatedAt: new Date().toISOString(),
  repeat: REPEAT,
  harness: "mock-figma (plugin cost only; API counts are real round-trip counts, timings are not Figma timings)",
  matrix: MATRIX,
  results,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(payload, null, 2)}\n`);
console.log(`\nwrote ${OUT}`);
process.exit(failures.length ? 1 : 0);
