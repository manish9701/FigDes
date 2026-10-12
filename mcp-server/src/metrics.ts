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

export const counters = {
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
};

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
    transactions: { apply: stats(transactionApplyMs), total: stats(transactionTotalMs) },
    inspect: stats(inspectMs),
    render: stats(renderMs),
    reconnectReady: stats(reconnectReadyMs),
    tools,
  };
}
