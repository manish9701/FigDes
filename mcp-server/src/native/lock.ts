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
