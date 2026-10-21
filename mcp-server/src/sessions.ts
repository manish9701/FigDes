/**
 * Plugin session registry.
 *
 * SPEC §33: every plugin connection gets a session id, commands are scoped to
 * an active session, and if more than one Figma file is open we never guess the
 * target — the tool call fails and lists the candidates instead.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  JobRecord,
  JobState,
  ResultMessage,
  ServerMessage,
  StatusResult,
  PluginToolName,
} from "../../shared/protocol";
import { recordDisconnect, recordReconnect, recordTimeout, recordUnknownSession } from "./metrics";

const REQUEST_TIMEOUT_MS = 60_000;
/** Long builds (fonts + hundreds of ops) legitimately take minutes. Timing out
 * at 60s while the plugin is still applying is the "blank page, then
 * everything pops at once" race: ChatGPT reports failure, the late commit
 * lands anyway. */
const LONG_BUILD_TIMEOUT_MS = 300_000;
const STALE_AFTER_MS = 60_000;

/**
 * A server-side timeout is NOT proof the document stayed unchanged.
 *
 * The Figma main thread keeps applying after we give up waiting: a 32-op
 * batch can time out at 17/32 with the rest still landing late. Callers must
 * be able to distinguish "the plugin said no" from "we stopped waiting", so
 * timeouts (and disconnects mid-apply) reject with this instead of a generic
 * Error. Dispatch marks the ledger `timed-out` and the late-result path
 * reconciles when the plugin eventually answers.
 */
export class TransactionTimeoutError extends Error {
  readonly isTimeout = true;
  constructor(
    message: string,
    readonly requestId: string,
    readonly tool: PluginToolName,
    readonly transactionId: string | undefined,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TransactionTimeoutError";
  }
}

/** Socket died while a request was in flight: same unknown-outcome shape as a timeout. */
export class SessionDisconnectedError extends Error {
  readonly isDisconnect = true;
  constructor(
    message: string,
    readonly requestId: string,
    readonly tool: PluginToolName,
    readonly transactionId: string | undefined,
  ) {
    super(message);
    this.name = "SessionDisconnectedError";
  }
}

function transactionIdOf(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "transactionId" in payload) {
    const v = (payload as Record<string, unknown>).transactionId;
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function timeoutHint(tool: string, transactionId: string | undefined, timeoutMs: number): string {
  const id = transactionId ? ` transaction ${transactionId}` : " the transaction";
  return (
    `Outcome unknown: the plugin may still be applying${transactionId ? ` (${transactionId})` : ""}. ` +
    `Do NOT retry blindly with a new id — that duplicates nodes if the first run commits late. ` +
    `Call get_job_status with${id} to reconcile, inspect the target subtree for partial work, ` +
    `then resume/retry with the SAME transactionId once the ledger settles (timed out after ${timeoutMs}ms on ${tool}).`
  );
}

function timeoutForTool(tool: PluginToolName): number {
  switch (tool) {
    case "create_design":
    case "modify_design":
    case "update_component":
    case "native_design":
    case "execute_figma_script":
      return LONG_BUILD_TIMEOUT_MS;
    case "render_node":
      return 120_000;
    default:
      return REQUEST_TIMEOUT_MS;
  }
}

/**
 * How many consecutive budget windows a build may span while still progressing.
 *
 * The per-request timeout is a *silence* window, not a total cap, so a legitimately
 * slow 128-op build must not be killed just because it takes longer than one
 * window. Four windows is the compromise: generous for real builds, and still a
 * bounded wait rather than a request that never returns.
 */
const MAX_SLIDING_FACTOR = 4;

/**
 * Plugin requests one session may owe at once (issue #20, workstream 9).
 *
 * Generous by design: a real build is one transaction at a time plus a probe,
 * and even a parallel review rarely exceeds a handful. The ceiling exists to
 * turn runaway looping into an explicit, described limit instead of an
 * unbounded queue against a single Figma thread.
 */
const MAX_SESSION_IN_FLIGHT = 24;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: PluginToolName;
  timeoutMs: number;
  requestId: string;
  transactionId: string | undefined;
  /** When the request was dispatched; bounds the total sliding wait. */
  startedAt: number;
  /** Highest `done` reported so far. A lower value is not evidence of life. */
  lastProgress: number;
}

interface TimedOut {
  tool: PluginToolName;
  transactionId: string | undefined;
  timeoutMs: number;
  at: number;
}

/**
 * The sentence the iframe transport writes when *its own* timer fires.
 *
 * A panel bundle older than the structured `transportTimeout` marker still sends
 * exactly this text, and a deployed session runs whatever bundle it was launched
 * with. Recognising the sentinel keeps the reconciliation binding alive across
 * that version skew instead of stranding the job.
 */
const TRANSPORT_TIMEOUT_SENTINEL = /Outcome unknown: the main thread may still commit late/i;

/**
 * Whether this frame is the *transport* giving up, rather than the plugin
 * refusing the work.
 *
 * The structured marker is authoritative; the sentinel is the fallback for an
 * older panel. Without this distinction the outcome-unknown timeout is reported
 * as an ordinary failure, which is the state that silently discarded every
 * late commit and rollback.
 */
function transportTimeoutOf(msg: ResultMessage, entry: Pending): { budgetMs: number } | null {
  if (msg.transportTimeout) return { budgetMs: msg.transportTimeout.budgetMs };
  if (typeof msg.error === "string" && TRANSPORT_TIMEOUT_SENTINEL.test(msg.error)) {
    const declared = /timed out after (\d+)ms/i.exec(msg.error);
    const budgetMs = declared?.[1] ? Number(declared[1]) : entry.timeoutMs;
    return { budgetMs: Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : entry.timeoutMs };
  }
  return null;
}

export interface LateResult {
  late: true;
  requestId: string;
  tool: PluginToolName;
  transactionId: string | undefined;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export class Session {
  readonly id = `session_${randomUUID()}`;
  readonly connectedAt = Date.now();
  lastSeen = Date.now();
  /** Last WebSocket pong: proves the socket is alive even when the Figma main thread is wedged and heartbeats stall. */
  lastPongAt = 0;

  fileKey: string | null = null;
  fileName = "Unknown file";
  pageId = "";
  pageName = "";
  selection: Array<{ id: string; type: string; name: string }> = [];
  pluginVersion = "unknown";
  /** Commit the loaded plugin bundle was built from. Lets a live run prove which code it measured. */
  build = "unknown";
  editorType = "figma";

  private readonly pending = new Map<string, Pending>();
  /**
   * Requests that timed out (or died with the socket) but may still commit
   * late on the Figma side. Kept so a late `result` frame reconciles the job
   * ledger instead of being dropped as "unknown request".
   */
  private readonly timedOut = new Map<string, TimedOut>();
  /** transactionId -> the wire request currently dispatching it. */
  private readonly requestIdByTransaction = new Map<string, string>();
  private closed = false;

  constructor(readonly socket: WebSocket) {
    // One listener for the whole session, not one per request. Attaching a
    // `close` listener inside request() made the socket accumulate listeners
    // until Node warned about a leak after ten tool calls.
    socket.on("close", () => {
      this.failAllPending("The Figma plugin disconnected while executing a command.");
    });
    socket.on("error", () => {
      this.failAllPending("The connection to the Figma plugin failed.");
    });
  }

  get alive(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN && Date.now() - this.lastSeen < STALE_AFTER_MS;
  }

  /**
   * Socket-level reachability, ignoring message freshness.
   *
   * A wedged Figma main thread (long builds) or a throttled background panel
   * stops heartbeat *messages* while the socket stays open. Dispatching on
   * `alive` alone turned those stretches into "no plugin connected" failures
   * with the panel still showing Connected. Dispatch on reachability instead:
   * the per-request timeout (60s–5min) is the real guard, and a dead socket
   * fails fast at send/request time. Freshness stays visible in health.
   */
  get reachable(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN;
  }

  /** True when the socket is open but no message arrived recently. */
  get stale(): boolean {
    return this.reachable && Date.now() - this.lastSeen >= STALE_AFTER_MS;
  }

  /** WebSocket pong arrived: the transport is alive regardless of app traffic. */
  markPong(): void {
    this.lastPongAt = Date.now();
    this.lastSeen = Math.max(this.lastSeen, Date.now());
  }

  send(msg: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  /**
   * Pushes a one-way notification to the plugin panel.
   *
   * Fire-and-forget by design: a panel that is closed or on an old bundle
   * version drops unknown frames silently, and a notification must never fail
   * the tool call that triggered it.
   */
  notify(msg: Extract<ServerMessage, { type: "notify" }>): void {
    try {
      this.send({ ...msg, at: Date.now() });
    } catch {
      /* best-effort */
    }
  }

  register(msg: Extract<ClientMessage, { type: "register" }>): void {
    this.fileKey = msg.fileKey;
    this.fileName = msg.fileName || "Unknown file";
    this.pageId = msg.pageId;
    this.pageName = msg.pageName;
    this.selection = msg.selection ?? [];
    this.pluginVersion = msg.pluginVersion;
    // The panel reports which commit it was built from. Recorded so a live
    // measurement can be tied to code that exists, rather than to whatever
    // bundle happened to be open.
    if (typeof msg.build === "string" && msg.build.length > 0) this.build = msg.build;
    this.lastSeen = Date.now();
  }

  applyState(msg: Extract<ClientMessage, { type: "state" }>): void {
    this.pageId = msg.pageId;
    this.pageName = msg.pageName;
    this.selection = msg.selection ?? [];
    this.editorType = msg.editorType;
    if (typeof msg.build === "string" && msg.build.length > 0) this.build = msg.build;
    this.lastSeen = msg.at ?? Date.now();
  }

  /** Dispatch a tool to the plugin and await its result. */
  request(tool: PluginToolName, payload: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.reachable) {
      return Promise.reject(new Error(`Plugin session ${this.id} is not connected.`));
    }

    /**
     * A per-session in-flight ceiling (issue #20, workstream 9).
     *
     * Nothing bounded the number of plugin requests one session could owe at
     * once, so a loop that fired reviews/renders in parallel could queue
     * unboundedly against a single Figma thread — the shape of a rate limit,
     * self-inflicted. The ceiling is generous (a pipeline's genuine parallel
     * work never approaches it) and the failure is explicit: the caller is
     * told it has outrun the session and to retry after in-flight requests
     * settle, rather than watching an opaque queue grow.
     */
    if (this.pending.size >= MAX_SESSION_IN_FLIGHT) {
      return Promise.reject(
        new Error(
          `Rate limit: session ${this.id} already has ${this.pending.size} plugin request(s) in flight (ceiling ${MAX_SESSION_IN_FLIGHT}). Wait for the outstanding calls to settle — get_job_status names what is still being applied — then retry rather than queueing further work.`,
        ),
      );
    }

    const budget = timeoutMs ?? timeoutForTool(tool);
    const requestId = `r_${randomUUID()}`;
    const transactionId = transactionIdOf(payload);
    // Bound synchronously, before the caller's first await. A late plugin result
    // is only rebindable if something recorded which wire request belonged to
    // this transaction, and the ledger is written to immediately after
    // `request()` returns — so this has to be readable by then.
    if (transactionId) this.requestIdByTransaction.set(transactionId, requestId);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        recordTimeout();
        // Keep the binding for the late-result path: the Figma main thread
        // keeps running after we stop waiting. Dropping it here is what turned
        // a stall into "failure, then everything pops at once anyway".
        this.rememberTimedOut(requestId, { tool, transactionId, timeoutMs: budget, at: Date.now() });
        // Best-effort cancel: ask the plugin to abort between ops and roll
        // back, so the late outcome is rolled-back/partial instead of a silent
        // commit. Older panels ignore the frame; that is fine.
        this.cancel(requestId, transactionId, `server timeout after ${budget}ms`);
        reject(
          new TransactionTimeoutError(
            `The Figma plugin did not respond to ${tool} within ${budget}ms. ${timeoutHint(tool, transactionId, budget)}`,
            requestId,
            tool,
            transactionId,
            budget,
          ),
        );
      }, budget);

      this.pending.set(requestId, { resolve, reject, timer, tool, timeoutMs: budget, requestId, transactionId, startedAt: Date.now(), lastProgress: 0 });
      this.send({ type: "request", requestId, tool, payload });
    });
  }

  /**
   * Ask the plugin to abort an in-flight request.
   *
   * Fire-and-forget: the transaction may already have committed (then the
   * cancel is a no-op and the late-result path reports the commit), or the
   * panel may be too old to understand it (then the timeout ledger state still
   * forces reconciliation before any retry).
   */
  cancel(requestId: string, transactionId: string | undefined, reason: string): void {
    try {
      this.send({ type: "cancel", requestId, ...(transactionId ? { transactionId } : {}), reason });
    } catch {
      /* best-effort */
    }
  }

  /** True while a request is still awaiting its plugin answer. */
  hasPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /**
   * The wire request id bound to a transaction, if one is in flight.
   *
   * The job ledger records this so a late plugin result can rebind to its
   * transaction instead of being dropped as an unknown request. Without it the
   * ledger's `byRequestId` lookup can never match anything, because nothing
   * ever wrote the field.
   */
  requestIdFor(transactionId: string): string | undefined {
    return this.requestIdByTransaction.get(transactionId);
  }

  /** Binding kept for a timed-out request, if any (late-result reconciliation). */
  timedOutBinding(requestId: string): TimedOut | undefined {
    return this.timedOut.get(requestId);
  }

  /**
   * Upstream build heartbeat (see shared/protocol ProgressMessage).
   *
   * Every progress frame proves the plugin is still applying ops, so the
   * request timer restarts instead of firing mid-build. Without this sliding
   * window a 90s build always fails at 60s and commits late.
   *
   * Two limits keep that window from becoming a hang:
   *
   *  1. Only a frame that reports *more* progress re-arms the timer. A plugin
   *     stuck on one op while still narrating the same count is stalled, and an
   *     unbounded window would wait on it forever.
   *  2. The total wait is capped at `MAX_SLIDING_FACTOR` × the original budget.
   *     A genuinely enormous build then fails with a clear ceiling rather than
   *     holding the request indefinitely.
   *
   * The ceiling is recorded in the timeout message so the failure is
   * actionable rather than a bare "did not respond".
   */
  touchProgress(requestId: string | undefined, done: number, total: number, label: string): void {
    this.lastSeen = Date.now();
    if (!requestId) return;
    const entry = this.pending.get(requestId);
    if (!entry) return;
    // Strictly monotonic: only a frame that reports *more* progress is evidence
    // of life. A plugin wedged on one operation keeps narrating the same count,
    // and treating that as progress would hold the request open for good.
    if (done <= entry.lastProgress) return;
    entry.lastProgress = done;

    const elapsed = Date.now() - entry.startedAt;
    const ceiling = entry.timeoutMs * MAX_SLIDING_FACTOR;
    if (elapsed >= ceiling) {
      clearTimeout(entry.timer);
      this.pending.delete(requestId);
      recordTimeout();
      this.rememberTimedOut(requestId, { tool: entry.tool, transactionId: entry.transactionId, timeoutMs: entry.timeoutMs, at: Date.now() });
      this.cancel(requestId, entry.transactionId, `server gave up after ${Math.round(elapsed)}ms of progress on ${done}/${total} ${label}`);
      entry.reject(
        new TransactionTimeoutError(
          `The Figma plugin is still applying ${entry.tool} but exceeded the total wait ceiling: ${Math.round(elapsed)}ms of progress (last ${done}/${total} ${label}), against a ${entry.timeoutMs}ms budget per window. ${timeoutHint(entry.tool, entry.transactionId, entry.timeoutMs)}`,
          requestId,
          entry.tool,
          entry.transactionId,
          entry.timeoutMs,
        ),
      );
      return;
    }

    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      this.pending.delete(requestId);
      recordTimeout();
      this.rememberTimedOut(requestId, { tool: entry.tool, transactionId: entry.transactionId, timeoutMs: entry.timeoutMs, at: Date.now() });
      this.cancel(requestId, entry.transactionId, `server timeout after ${entry.timeoutMs}ms without progress`);
      entry.reject(
        new TransactionTimeoutError(
          `The Figma plugin stalled on ${entry.tool} (last progress ${done}/${total} ${label}). ${timeoutHint(entry.tool, entry.transactionId, entry.timeoutMs)}`,
          requestId,
          entry.tool,
          entry.transactionId,
          entry.timeoutMs,
        ),
      );
    }, entry.timeoutMs);
    // Refresh the liveness window without re-arming unref concerns; the timer
    // above is the budget that matters.
  }

  /** Progress without a request id still proves liveness (chunked builds). */
  touch(): void {
    this.lastSeen = Date.now();
  }

  /**
   * Settle an upstream result.
   *
   * Returns a LateResult when the request had already timed out: the awaiting
   * promise is gone, but the ledger still needs the true outcome. Callers
   * (the socket router) must reconcile the job record from it instead of
   * dropping the frame.
   *
   * The case that used to strand a job is the *iframe* giving up before we did.
   * Its frame carries `ok:false` and a scary error string, which reads exactly
   * like a plugin that refused the work — so it was rejected as an ordinary
   * failure and the request binding was dropped. The plugin's definitive answer
   * (the commit, or the verified rollback) then arrived and was discarded as an
   * unknown request, leaving the ledger at `timed-out` forever and refusing every
   * same-id retry. A transport timeout is now recognised structurally: the
   * binding is kept and the rejection is the same `TransactionTimeoutError` the
   * server's own timer raises, so both routes reconcile identically.
   */
  settleResult(msg: ResultMessage): LateResult | null {
    const entry = this.pending.get(msg.requestId);
    if (entry) {
      clearTimeout(entry.timer);
      this.pending.delete(msg.requestId);
      const transport = transportTimeoutOf(msg, entry);
      if (transport) {
        this.rememberTimedOut(msg.requestId, { tool: entry.tool, transactionId: entry.transactionId, timeoutMs: entry.timeoutMs, at: Date.now() });
        const budget = transport.budgetMs;
        entry.reject(
          new TransactionTimeoutError(
            `The plugin panel gave up waiting for ${entry.tool} after ${budget}ms. ${timeoutHint(entry.tool, entry.transactionId, budget)}`,
            msg.requestId,
            entry.tool,
            entry.transactionId,
            budget,
          ),
        );
        return null;
      }
      if (msg.ok) entry.resolve(msg.data);
      else entry.reject(new Error(msg.error ?? "The Figma plugin reported an unknown error."));
      return null;
    }
    const timed = this.timedOut.get(msg.requestId);
    if (!timed) return null;
    this.timedOut.delete(msg.requestId);
    return {
      late: true,
      requestId: msg.requestId,
      tool: timed.tool,
      transactionId: timed.transactionId,
      ok: msg.ok,
      ...(msg.data !== undefined ? { data: msg.data } : {}),
      ...(msg.error !== undefined ? { error: msg.error } : {}),
    };
  }

  /**
   * Keeps a bounded reconciliation binding for a request whose waiter is gone.
   *
   * Every path that stops waiting must go through here. Forgetting to is what
   * makes a real commit look like an unknown request and leaves the job
   * permanently unreconcilable.
   */
  private rememberTimedOut(requestId: string, binding: TimedOut): void {
    this.timedOut.set(requestId, binding);
    if (this.timedOut.size > 50) {
      const first = this.timedOut.keys().next().value;
      if (first) this.timedOut.delete(first);
    }
  }

  failAllPending(reason: string): void {
    for (const [requestId, entry] of this.pending) {
      clearTimeout(entry.timer);
      // A disconnect mid-apply has the same unknown outcome as a timeout: the
      // main thread may still commit. Keep the binding for reconciliation and
      // reject with a disconnect-shaped error the dispatcher marks timed-out.
      this.rememberTimedOut(requestId, { tool: entry.tool, transactionId: entry.transactionId, timeoutMs: entry.timeoutMs, at: Date.now() });
      entry.reject(
        new SessionDisconnectedError(
          `${reason} Outcome unknown${entry.transactionId ? ` for transaction ${entry.transactionId}` : ""} — the Figma main thread may still commit late. ${timeoutHint(entry.tool, entry.transactionId, entry.timeoutMs)}`,
          requestId,
          entry.tool,
          entry.transactionId,
        ),
      );
    }
    this.pending.clear();
  }

  dispose(reason: string): void {
    this.closed = true;
    this.failAllPending(reason);
  }

  status(): StatusResult {
    return {
      connected: this.reachable,
      sessionId: this.id,
      fileName: this.fileName,
      fileKey: this.fileKey,
      pageId: this.pageId,
      pageName: this.pageName,
      selectionCount: this.selection.length,
      pluginVersion: this.pluginVersion,
      build: this.build,
      lastSeen: this.lastSeen,
      ...(this.stale ? { stale: true as const } : {}),
    };
  }

  describe(): string {
    return `${this.fileName} — page "${this.pageName || "?"}" — ${this.pluginVersion}`;
  }
}

/* -------------------------------------------------------------------------- */
/* Transaction/job ledger (P0 reconnect recovery)                            */
/* -------------------------------------------------------------------------- */

/**
 * Durable status/resume record for every mutating transaction.
 *
 * Keyed by `transactionId` so a retry reuses the SAME id and is idempotent
 * instead of blindly creating the same objects again. Survives connection
 * loss: the ledger lives on the server, not on the socket, so a reconnect can
 * report the correct job state and resume or safely retry without duplicating
 * created nodes.
 */
export class JobLedger {
  private readonly jobs = new Map<string, JobRecord>();
  /** Completed transaction results for idempotent retry (bounded). */
  private readonly results = new Map<string, unknown>();
  /** Monotonic attempt counter per transactionId; guards stale late results. */
  private readonly attempts = new Map<string, number>();
  private order: string[] = [];
  /**
   * Terminal records the bounded window evicted, kept only as ids.
   *
   * After eviction a `get_job_status` would report "unknown" — which is
   * honest about memory, but a lie about history: the job *did* run and
   * complete, and the retry-safety that the ledger exists for (a same-id
   * retry must not re-execute a committed mutation) silently lapses once the
   * record and the result cache drop. The ids let the status answer say so:
   * "this transaction committed but its record was evicted; the idempotency
   * guarantee no longer holds for a blind retry."
   */
  private readonly evicted = new Set<string>();

  begin(input: { transactionId: string; tool: string; session: Session; operationCount: number; requestId?: string }): JobRecord {
    // A re-dispatch of the same id is a new attempt. Late results belonging to
    // the previous one must not be able to overwrite this attempt's state, so
    // the counter is monotonic across attempts rather than reset per record.
    const attempt = (this.attempts.get(input.transactionId) ?? 0) + 1;
    this.attempts.set(input.transactionId, attempt);
    const rec: JobRecord = {
      transactionId: input.transactionId,
      state: "queued",
      tool: input.tool,
      sessionId: input.session.id,
      fileKey: input.session.fileKey,
      fileName: input.session.fileName,
      operationCount: input.operationCount,
      done: 0,
      attempt,
      updatedAt: Date.now(),
      ...(input.requestId ? { requestId: input.requestId } : {}),
    };
    this.jobs.set(input.transactionId, rec);
    this.order.push(input.transactionId);
    if (this.order.length > 200) {
      const drop = this.order.splice(0, this.order.length - 200);
      for (const id of drop) {
        // Record which ids the bounded window gave up: a later get_job_status
        // for one of them will be told the record was evicted, so a caller
        // trusting "unknown" as "never ran" cannot be misled in either
        // direction (issue #20).
        this.evicted.add(id);
        if (this.evicted.size > 400) {
          const first = this.evicted.values().next().value;
          if (first) this.evicted.delete(first);
        }
        this.jobs.delete(id);
        this.results.delete(id);
      }
    }
    return rec;
  }

  /** Whether a transaction id had a ledger record that was since evicted. */
  wasEvicted(transactionId: string): boolean {
    return this.evicted.has(transactionId);
  }

  update(transactionId: string, patch: Partial<JobRecord>): JobRecord | undefined {
    const rec = this.jobs.get(transactionId);
    if (!rec) return undefined;
    Object.assign(rec, patch, { updatedAt: Date.now() });
    return rec;
  }

  get(transactionId: string): JobRecord | undefined {
    return this.jobs.get(transactionId);
  }

  complete(transactionId: string, state: JobState, extra?: Partial<JobRecord>, result?: unknown): JobRecord | undefined {
    const rec = this.update(transactionId, { state, ...(extra ?? {}) });
    if (result !== undefined) {
      this.results.set(transactionId, result);
      if (this.results.size > 200) {
        const first = this.results.keys().next().value;
        if (first) this.results.delete(first);
      }
    }
    return rec;
  }

  priorResult(transactionId: string): unknown | undefined {
    return this.results.get(transactionId);
  }

  /**
   * Apply a late plugin result, unless it belongs to a superseded attempt.
   *
   * A timeout, a reconcile and a re-dispatch can all be in flight for the same
   * transactionId. When the re-dispatch's answer has already landed, letting
   * the older frame overwrite it would resurrect a stale outcome — reporting a
   * transaction as `rolled-back` when this attempt in fact committed, which is
   * the one mistake that loses work.
   *
   * So the caller states which attempt the frame arrived under, and a mismatch
   * is recorded rather than applied.
   */
  completeLate(input: {
    transactionId: string;
    attempt?: number;
    state: JobState;
    extra?: Partial<JobRecord>;
    result?: unknown;
  }): { applied: boolean; record?: JobRecord; reason?: string } {
    const rec = this.jobs.get(input.transactionId);
    if (!rec) return { applied: false, reason: "no ledger record for this transaction" };
    if (input.attempt !== undefined && rec.attempt !== undefined && input.attempt < rec.attempt) {
      const stale = { ...rec, state: rec.state, label: `${rec.label ?? ""} (ignored stale result from attempt ${input.attempt}; current is ${rec.attempt})`.trim() };
      rec.label = stale.label;
      rec.updatedAt = Date.now();
      return { applied: false, record: rec, reason: `stale: frame is from attempt ${input.attempt}, record is on attempt ${rec.attempt}` };
    }
    this.complete(input.transactionId, input.state, input.extra, input.result);
    return { applied: true, record: this.jobs.get(input.transactionId) };
  }

  /**
   * Find a job by its wire request id (late-result reconciliation).
   *
   * A late plugin answer names the request, not the transaction — and on a
   * reconnect the transaction id may be the only stable key. Scanning is
   * bounded (≤200 records) and only used for reconciliation, never dispatch.
   */
  byRequestId(requestId: string): JobRecord | undefined {
    for (const rec of this.jobs.values()) {
      if (rec.requestId === requestId) return rec;
    }
    return undefined;
  }

  recent(limit = 20): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  forSession(sessionId: string, limit = 20): JobRecord[] {
    return [...this.jobs.values()]
      .filter((j) => j.sessionId === sessionId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly wsToSession = new WeakMap<WebSocket, Session>();
  /** Stable job identity across reconnects. */
  readonly jobs = new JobLedger();
  /** old session id -> replacement, so stale ids recover with a hint. */
  private readonly lineage = new Map<string, { to: string; fileKey: string | null; fileName: string; at: number }>();
  private readonly recentDisconnects: Array<{ sessionId: string; fileKey: string | null; fileName: string; at: number }> = [];

  add(socket: WebSocket): Session {
    const session = new Session(socket);
    // Lineage is linked in linkGeneration(), not here: fileKey is still
    // unset until the plugin's register message arrives, so any lookup at
    // add-time could never match and would only mislead.
    this.sessions.set(session.id, session);
    this.wsToSession.set(socket, session);

    socket.on("close", () => {
      recordDisconnect();
      this.recentDisconnects.push({ sessionId: session.id, fileKey: session.fileKey, fileName: session.fileName, at: Date.now() });
      if (this.recentDisconnects.length > 20) this.recentDisconnects.splice(0, this.recentDisconnects.length - 20);
      session.dispose("The Figma plugin closed the connection.");
      this.sessions.delete(session.id);
    });

    return session;
  }

  /**
   * Called when a registered session's file identity arrives: links the new
   * generation to any prior disconnected session on the same file so a
   * reconnect can report "your old session X is now Y on the same file".
   *
   * Identity prefers fileKey, but local/desktop files report a null key (as
   * this deployment does on every connection), which used to disable lineage
   * entirely: every reconnect after a disconnect produced only the generic
   * "your session id changed" hint instead of naming the replacement. The
   * fallback matches on fileName, excluding the "Unknown file" default,
   * which carries no identity. The hint always names the file, and recovery
   * still goes through the job ledger with the SAME transactionId, so a
   * same-named different file can cost at most a ledger check, never a
   * blind duplicate.
   */
  linkGeneration(session: Session): { reboundFrom?: string; readyMs?: number } {
    const match = [...this.recentDisconnects]
      .reverse()
      .find(
        (d) =>
          (d.fileKey !== null && d.fileKey === session.fileKey) ||
          (d.fileKey === null &&
            session.fileKey === null &&
            d.fileName !== "Unknown file" &&
            d.fileName === session.fileName),
      );
    if (!match) return {};
    this.lineage.set(match.sessionId, { to: session.id, fileKey: session.fileKey, fileName: session.fileName, at: Date.now() });
    if (this.lineage.size > 20) {
      const oldest = [...this.lineage.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.lineage.delete(oldest[0]);
    }
    const idx = this.recentDisconnects.indexOf(match);
    if (idx >= 0) this.recentDisconnects.splice(idx, 1);
    const readyMs = Date.now() - match.at;
    recordReconnect(readyMs);
    return { reboundFrom: match.sessionId, readyMs };
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  forSocket(socket: WebSocket): Session | undefined {
    return this.wsToSession.get(socket);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  alive(): Session[] {
    return this.all().filter((s) => s.alive);
  }

  /** Sessions with an open socket, whether or not recent app traffic arrived. */
  connected(): Session[] {
    return this.all().filter((s) => s.reachable);
  }

  /** SPEC §33: never guess the target when multiple files are open. */
  resolve(sessionId?: string): Session {
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (!found) {
        recordUnknownSession();
        const rebound = this.lineage.get(sessionId);
        const candidates = this.all()
          .filter((s) => s.reachable)
          .map((s) => `  ${s.id}  ${s.describe()}`)
          .join("\n");
        const hint = rebound
          ? ` That session reconnected as ${rebound.to} on "${rebound.fileName}". Retry with sessionId "${rebound.to}" and the SAME transactionId; the job ledger will report whether it committed instead of duplicating nodes.`
          : this.recentDisconnects.length > 0 || this.all().length > 0
            ? ` If you just reconnected, your session id changed: call figma_status with no sessionId to get the live id, then retry with the SAME transactionId and check get_job_status first.`
            : ` No plugin sessions are known at all: open the plugin in the target file first, then check get_job_status with your transactionId before retrying with the SAME transactionId.`;
        throw new Error(
          `Unknown plugin session: ${sessionId}.${hint}${candidates ? `\nConnected sessions:\n${candidates}` : ""}`,
        );
      }
      if (!found.reachable) throw new Error(`Plugin session ${sessionId} exists but is not connected. Reconnect the plugin, then use get_job_status with your transactionId before retrying — the ledger survives the disconnect.`);
      return found;
    }

    const live = this.all().filter((s) => s.reachable);
    if (live.length === 0) {
      throw new Error(
        "No Figma Design Agent plugin is connected. Open the plugin in the target Figma file and keep it running.",
      );
    }
    if (live.length === 1) return live[0]!;

    throw new Error(
      `Multiple Figma files have the plugin open, so the target is ambiguous. Pass an explicit sessionId. Open sessions:\n${live
        .map((s) => `  ${s.id}  ${s.describe()}`)
        .join("\n")}`,
    );
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      s.send({ type: "disconnect", reason: "The Design Agent server is shutting down." });
      s.dispose("The Design Agent server shut down.");
      s.socket.close(1001, "server shutdown");
    }
    this.sessions.clear();
  }
}


