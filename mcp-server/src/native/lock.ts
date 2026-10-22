/**
 * Per-session native execution lock (spec §36).
 *
 * Native scripts are stateful against a single Figma document: each one opens a
 * transaction, mutates, then commits or rolls back. If two scripts run at once
 * on the same session, their transactions interleave — script B's commit can
 * seal script A's half-built state, and A's rollback can undo B's work. The
 * document-level transaction state cannot tell them apart.
 *
 * So native execution is serialized per session: calls queue behind each other
 * and run strictly one at a time. Different sessions (different files) still run
 * concurrently, because they share no document.
 *
 * The queue is keyed by session id and self-cleaning: an entry is dropped once
 * its chain drains, so the map does not grow without bound.
 */

const chains = new Map<string, Promise<unknown>>();

export function withSessionLock<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const previous = chains.get(sessionId) ?? Promise.resolve();

  // Run whether the previous task resolved or rejected: one failed script must
  // not deadlock the queue for every later call.
  const run = previous.then(task, task);

  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(sessionId, settled);
  // Drop the entry once this is the tail of the chain, so the map stays small.
  settled.then(() => {
    if (chains.get(sessionId) === settled) chains.delete(sessionId);
  });

  return run;
}

/** Test/introspection helper: sessions with a queued or running native task. */
export function lockedSessions(): string[] {
  return [...chains.keys()];
}

/* -------------------------------------------------------------------------- */
/* Document-keyed advisory write lock                                          */
/* -------------------------------------------------------------------------- */

/**
 * Cross-session coordination for one Figma *document* (checkpoint checklist #21).
 *
 * The per-session lock above guarantees only that one session's scripts do not
 * interleave *with each other*. Two different plugin sessions bound to the SAME
 * file share no document, so they were free to run mutating scripts
 * concurrently — and clobber each other's half-built trees, exactly the
 * interleaving that session lock exists to prevent.
 *
 * Policy: **fail fast, fail loud.** Queuing here would mean one session's
 * transaction holding another session's tool call for up to minutes (native
 * builds legitimately run 300s), with no way to notice a wedged holder. That
 * matches the transaction timeout semantics nowhere; this codebase prefers
 * explicit, structured errors that name the obstacle and the recovery step, so a caller can decide to wait. The error names the holder session, the
 * document and how long it has been held.
 *
 * No queue means nothing to leak: the lock is released in a `finally` around the
 * held task, so a timeout (`TransactionTimeoutError`) or a disconnect
 * (`SessionDisconnectedError`) both free the document immediately.
 */

/** Minimal shape of a bound session: what `Session` already exposes post-register. */
export interface DocumentBoundSession {
  id: string;
  fileKey: string | null;
  fileName: string;
}

/**
 * Document identity, from what session metadata already exposes.
 *
 * `fileKey` is preferred because it survives a rename; the file name is the
 * fallback (dev-mode files report a null key). Same derivation as
 * `memory/store.ts#projectKey`, but no path is built from it, so it stays an
 * opaque in-memory key. An entirely unidentifiable file ("Unknown file", null
 * key) degrades to the shared "unknown" key *deliberately*: two
 * unidentifiable documents serialising is a spurious busy error a retry can
 * get past; two unidentifiable documents clobbering is unbounded corruption.
 */
export function documentKeyFor(session: { fileKey: string | null; fileName: string }): string {
  const raw = ((session.fileKey ?? "") as string).trim() || (session.fileName ?? "").trim() || "unknown";
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "unknown";
}

export class DocumentLockBusyError extends Error {
  readonly isDocumentLockBusy = true;
  constructor(
    message: string,
    readonly documentKey: string,
    readonly holder: { sessionId: string; fileName: string; heldMs: number },
  ) {
    super(message);
    this.name = "DocumentLockBusyError";
  }
}

interface DocumentLockHolder {
  sessionId: string;
  fileName: string;
  acquiredAt: number;
  /** Re-entrancy depth within one session (the session lock serialises these). */
  depth: number;
}

const documentLocks = new Map<string, DocumentLockHolder>();

/**
 * Runs `task` while holding the document's advisory write lock.
 *
 * Another session writing the same document rejects with a structured
 * `DocumentLockBusyError` naming the holder; the same session re-entering
 * (already serialized by `withSessionLock`) is allowed and counted. Release
 * happens in a `finally`, so every exit path — success, timeout, disconnect —
 * frees the document for the next session.
 */
export function withDocumentLock<T>(session: DocumentBoundSession, task: () => Promise<T>): Promise<T> {
  const key = documentKeyFor(session);
  const existing = documentLocks.get(key);
  if (existing && existing.sessionId !== session.id) {
    const heldMs = Date.now() - existing.acquiredAt;
    return Promise.reject(
      new DocumentLockBusyError(
        `Document "${existing.fileName}" (${key}) is locked for mutation by session ${existing.sessionId} ` +
          `(held ${Math.round(heldMs / 1000)}s). Concurrent writes to the same Figma document clobber each other, ` +
          `so the request was refused before dispatching — nothing was sent. ` +
          `Wait for the other session's transaction to settle (get_job_status on its transactionId), or work in a different document, then retry.`,
        key,
        { sessionId: existing.sessionId, fileName: existing.fileName, heldMs },
      ),
    );
  }

  const holder: DocumentLockHolder = existing ?? { sessionId: session.id, fileName: session.fileName, acquiredAt: Date.now(), depth: 0 };
  holder.depth += 1;
  documentLocks.set(key, holder);

  return task().finally(() => {
    holder.depth -= 1;
    if (holder.depth === 0 && documentLocks.get(key) === holder) documentLocks.delete(key);
  });
}

/** Test/introspection helper: documents currently held, with their holder and hold time. */
export function heldDocumentLocks(): Array<{ documentKey: string; sessionId: string; fileName: string; heldMs: number }> {
  return [...documentLocks.entries()].map(([documentKey, h]) => ({
    documentKey,
    sessionId: h.sessionId,
    fileName: h.fileName,
    heldMs: Date.now() - h.acquiredAt,
  }));
}
