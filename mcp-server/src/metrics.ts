/**
 * Server-side operational metrics (P1 latency instrumentation).
 *
 * In-memory only: p50/p95 transaction durations by stage, timeout/disconnect
 * rates, reconnect-to-ready time, rollback completeness, preflight catches,
 * duplicate retries, render/inspect cost. Bounded arrays so a long-lived
 * server cannot grow without bound. Exposed via figma_status and get_job_status.
 */

export interface DurationSample {
  ms: number;
  at: number;
  ops?: number;
  nodes?: number;
}

const CAP = 500;

function pushBounded<T>(arr: T[], v: T): void {
  arr.push(v);
  if (arr.length > CAP) arr.splice(0, arr.length - CAP);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function stats(samples: DurationSample[]): { count: number; p50: number; p95: number; avg: number } {
  const vals = samples.map((s) => s.ms).sort((a, b) => a - b);
  const count = vals.length;
  if (count === 0) return { count: 0, p50: 0, p95: 0, avg: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  return { count, p50: percentile(vals, 50), p95: percentile(vals, 95), avg: Math.round(sum / count) };
}

export const toolDurations = new Map<string, DurationSample[]>();
export const transactionApplyMs: DurationSample[] = [];
export const transactionTotalMs: DurationSample[] = [];
export const inspectMs: DurationSample[] = [];
export const renderMs: DurationSample[] = [];

/**
 * The counters are process-global, not module-global.
 *
 * Like the plan registry (issue #29): the server is built one-bundle for
 * production and per-area bundles for the test suites, and a module-level
 * object would give each bundle its own counters — a waiver recorded by the
 * tools bundle would be invisible in the metrics bundle's snapshot. A
 * symbol-keyed global keeps one set of counters per process whichever bundle
 * imports this module.
 */
const COUNTER_KEY = Symbol.for("figdes.contractCounters");

function zeroedCounters() {
  return {
    toolCalls: 0,
    toolTimeouts: 0,
    socketDisconnects: 0,
    reconnects: 0,
    unknownSessionErrors: 0,
    rollbacksFull: 0,
    rollbacksPartial: 0,
    preflightCatches: 0,
    duplicateRetries: 0,
    renders: 0,
    renderTokens: 0,
    renderBytes: 0,
    /* --- First-Pass Quality Contract (issue #26): outcomes that used to be
           computed per call and discarded are aggregated here, so a run can say
           "verified with zero repairs" and mean it across runs. --- */
    /** Built screens verified with zero repairs attempted. */
    firstPassAccepted: 0,
    /** Built screens with zero repairs attempted (the acceptance denominator). */
    firstPassTotal: 0,
    /** Pipeline visual checks that failed. */
    visualQAFailures: 0,
    /** Runs whose payload carried intelligence-applied:true. */
    intelligenceAppliedCount: 0,
    /** Runs that disclosed design-intelligence provenance either way. */
    intelligenceTotal: 0,
    /** Runs whose plan carried a composition hint. */
    compositionHintAppliedCount: 0,
    /** Runs that disclosed composition-hint provenance either way. */
    hintTotal: 0,
    /* --- Plan registry (issue #29): the bypass paths the gates now refuse are
          counted, so a weak client's skip-the-plan rate is visible instead of
          silent. --- */
    /** Planless screen-scale builds refused at the design_runtime gate. */
    planlessScreenRefusals: 0,
    /** Raw mutating calls dispatched only after an approved+reason waiver. */
    intelligenceBypassWaivers: 0,
    /** Repair self-verifications that passed (no unresolved, no regression). */
    repairVerificationPass: 0,
    /** Repair self-verifications that failed. */
    repairVerificationFail: 0,
  };
}

type CounterTable = ReturnType<typeof zeroedCounters>;

export const counters: CounterTable = ((globalThis as unknown as Record<symbol, CounterTable | undefined>)[COUNTER_KEY] ??=
  zeroedCounters());

export function recordToolCall(tool: string, ms: number, opts?: { ops?: number; nodes?: number }): void {
  counters.toolCalls += 1;
  const arr = toolDurations.get(tool) ?? [];
  pushBounded(arr, { ms, at: Date.now(), ...(opts?.ops !== undefined ? { ops: opts.ops } : {}), ...(opts?.nodes !== undefined ? { nodes: opts.nodes } : {}) });
  toolDurations.set(tool, arr);
}

export function recordTimeout(): void {
  counters.toolTimeouts += 1;
}

export function recordDisconnect(): void {
  counters.socketDisconnects += 1;
}

export function recordReconnect(readyMs?: number): void {
  counters.reconnects += 1;
  if (readyMs !== undefined) pushBounded(reconnectReadyMs, { ms: readyMs, at: Date.now() });
}

export const reconnectReadyMs: DurationSample[] = [];

export function recordUnknownSession(): void {
  counters.unknownSessionErrors += 1;
}

export function recordRollback(status: "full" | "partial" | "none"): void {
  if (status === "full") counters.rollbacksFull += 1;
  else if (status === "partial") counters.rollbacksPartial += 1;
}

export function recordPreflightCatch(count = 1): void {
  counters.preflightCatches += count;
}

export function recordDuplicateRetry(): void {
  counters.duplicateRetries += 1;
}

export function recordRender(tokens: number, base64Bytes: number, ms: number): void {
  counters.renders += 1;
  counters.renderTokens += tokens;
  counters.renderBytes += base64Bytes;
  pushBounded(renderMs, { ms, at: Date.now() });
}

/* -------------------------------------------------------------------------- */
/* First-Pass Quality Contract recorders (issue #26)                           */
/* -------------------------------------------------------------------------- */

/**
 * Records a first-pass outcome: a built screen with zero repairs attempted.
 * `verified` is true only when the report's own status is `verified` — a
 * screen that needed no repair and still did not verify is a first pass that
 * did not accept, not a silent pass.
 */
export function recordFirstPass(verified: boolean): void {
  counters.firstPassTotal += 1;
  if (verified) counters.firstPassAccepted += 1;
}

/** Records the pipeline visual check's outcome; only failures aggregate. */
export function recordVisualQA(status: string): void {
  if (status === "fail") counters.visualQAFailures += 1;
}

/**
 * Records design-intelligence provenance disclosure. `hintApplied` is
 * optional because not every provenance payload names a composition hint;
 * the hint rate is computed over runs that disclosed it either way.
 */
export function recordIntelligence(applied: boolean, hintApplied?: boolean): void {
  counters.intelligenceTotal += 1;
  if (applied) counters.intelligenceAppliedCount += 1;
  if (hintApplied !== undefined) {
    counters.hintTotal += 1;
    if (hintApplied) counters.compositionHintAppliedCount += 1;
  }
}

/** Records the repair pass's own verdict (self-verification, not the build). */
export function recordRepairVerification(verdict: string): void {
  if (verdict === "PASS") counters.repairVerificationPass += 1;
  else if (verdict === "FAIL") counters.repairVerificationFail += 1;
}

/** Records a planless screen-scale build refused at the runtime gate (issue #29). */
export function recordPlanlessScreenRefusal(): void {
  counters.planlessScreenRefusals += 1;
}

/** Records a raw mutating call dispatched after an approved+reason waiver (issue #29). */
export function recordProvenanceWaiver(): void {
  counters.intelligenceBypassWaivers += 1;
}

/** Resets only the contract counters, so tests can aggregate deterministically. */
export function resetContractCounters(): void {
  counters.firstPassAccepted = 0;
  counters.firstPassTotal = 0;
  counters.visualQAFailures = 0;
  counters.intelligenceAppliedCount = 0;
  counters.intelligenceTotal = 0;
  counters.compositionHintAppliedCount = 0;
  counters.hintTotal = 0;
  counters.planlessScreenRefusals = 0;
  counters.intelligenceBypassWaivers = 0;
  counters.repairVerificationPass = 0;
  counters.repairVerificationFail = 0;
}

function rate(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round((numerator / denominator) * 100) / 100;
}

export function recordInspect(ms: number): void {
  pushBounded(inspectMs, { ms, at: Date.now() });
}

export function recordTransaction(timings?: { apply?: number; total?: number; operationCount?: number; nodeCount?: number }): void {
  if (timings?.apply !== undefined) {
    pushBounded(transactionApplyMs, {
      ms: timings.apply,
      at: Date.now(),
      ...(timings.operationCount !== undefined ? { ops: timings.operationCount } : {}),
      ...(timings.nodeCount !== undefined ? { nodes: timings.nodeCount } : {}),
    });
  }
  if (timings?.total !== undefined) {
    pushBounded(transactionTotalMs, {
      ms: timings.total,
      at: Date.now(),
      ...(timings.operationCount !== undefined ? { ops: timings.operationCount } : {}),
      ...(timings.nodeCount !== undefined ? { nodes: timings.nodeCount } : {}),
    });
  }
}

export function snapshot(): Record<string, unknown> {
  const tools: Record<string, { count: number; p50: number; p95: number; avg: number }> = {};
  for (const [tool, samples] of toolDurations) tools[tool] = stats(samples);
  return {
    counters: { ...counters },
    contract: {
      firstPassAccepted: counters.firstPassAccepted,
      firstPassTotal: counters.firstPassTotal,
      firstPassAcceptanceRate: rate(counters.firstPassAccepted, counters.firstPassTotal),
      visualQAFailures: counters.visualQAFailures,
      intelligenceAppliedCount: counters.intelligenceAppliedCount,
      intelligenceTotal: counters.intelligenceTotal,
      intelligenceAppliedRate: rate(counters.intelligenceAppliedCount, counters.intelligenceTotal),
      compositionHintAppliedCount: counters.compositionHintAppliedCount,
      hintTotal: counters.hintTotal,
      hintAppliedRate: rate(counters.compositionHintAppliedCount, counters.hintTotal),
      planlessScreenRefusals: counters.planlessScreenRefusals,
      intelligenceBypassWaivers: counters.intelligenceBypassWaivers,
      repairVerificationPass: counters.repairVerificationPass,
      repairVerificationFail: counters.repairVerificationFail,
      repairVerificationPassRate: rate(
        counters.repairVerificationPass,
        counters.repairVerificationPass + counters.repairVerificationFail,
      ),
    },
    transactions: { apply: stats(transactionApplyMs), total: stats(transactionTotalMs) },
    inspect: stats(inspectMs),
    render: stats(renderMs),
    reconnectReady: stats(reconnectReadyMs),
    tools,
  };
}
