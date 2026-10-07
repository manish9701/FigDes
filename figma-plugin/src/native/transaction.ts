/**
 * Explicit native transaction state (spec §17, §36).
 *
 * Why not rely on commitUndo()/triggerUndo() alone:
 *
 * `triggerUndo()` undoes *whatever Figma last recorded*, not necessarily the
 * transaction we think we are rolling back. If a native script times out, is
 * aborted, or two scripts interleave, a blind `triggerUndo()` can undo a
 * previous, unrelated operation — or undo twice and destroy work the user did
 * by hand.
 *
 * So the state is tracked here, explicitly, and every rollback is gated on:
 *   1. a transaction is actually open, and
 *   2. the id matches the one being rolled back, and
 *   3. at least one mutation landed inside it.
 *
 * When any of those is false the rollback is a no-op that says so, never a
 * silent undo of somebody else's change.
 */

export type NativeTransactionState = "idle" | "open" | "committed" | "rolled-back";

interface State {
  state: NativeTransactionState;
  transactionId: string | null;
  mutations: number;
}

const current: State = { state: "idle", transactionId: null, mutations: 0 };

export interface TransactionStatus {
  status: string;
  transactionId: string | null;
  state: NativeTransactionState;
  mutations: number;
  rolledBack?: boolean;
  reason?: string;
}

function safeCommitUndo(): void {
  try {
    figma.commitUndo();
  } catch {
    /* commitUndo is best-effort and unavailable outside Figma. */
  }
}

export function beginNativeTransaction(transactionId: string): TransactionStatus {
  if (current.state === "open") {
    throw new Error(
      `A native transaction (${current.transactionId}) is already open. Commit or roll it back before starting another.`,
    );
  }
  current.state = "open";
  current.transactionId = transactionId;
  current.mutations = 0;
  // Seal prior document state so everything this transaction does is one undo step.
  safeCommitUndo();
  return { status: "transaction-open", transactionId, state: current.state, mutations: 0 };
}

export function commitNativeTransaction(transactionId?: string): TransactionStatus {
  if (current.state !== "open") {
    throw new Error(`No open native transaction to commit (state: ${current.state}).`);
  }
  if (transactionId !== undefined && current.transactionId !== null && transactionId !== current.transactionId) {
    throw new Error(
      `Transaction id mismatch: cannot commit ${transactionId} while ${current.transactionId} is open.`,
    );
  }
  const mutations = current.mutations;
  safeCommitUndo();
  current.state = "committed";
  const id = current.transactionId;
  current.transactionId = null;
  current.mutations = 0;
  return { status: "transaction-committed", transactionId: id, state: current.state, mutations };
}

/**
 * Roll back the open transaction, and only the open transaction.
 *
 * A rollback for an unopened, already-committed, or mismatched transaction
 * returns `transaction-noop` instead of triggering an undo, because there is
 * nothing of ours to undo and an undo would hit somebody else's change.
 */
export function rollbackNativeTransaction(transactionId?: string): TransactionStatus {
  if (current.state !== "open") {
    return {
      status: "transaction-noop",
      transactionId: transactionId ?? null,
      state: current.state,
      mutations: 0,
      rolledBack: false,
      reason: `No open native transaction (state: ${current.state}); nothing was rolled back.`,
    };
  }
  if (transactionId !== undefined && current.transactionId !== null && transactionId !== current.transactionId) {
    return {
      status: "transaction-noop",
      transactionId: transactionId ?? null,
      state: current.state,
      mutations: current.mutations,
      rolledBack: false,
      reason: `Transaction id mismatch: refusing to roll back ${current.transactionId} for ${transactionId}.`,
    };
  }

  const hadMutations = current.mutations > 0;
  let rolledBack = false;
  if (hadMutations) {
    try {
      figma.triggerUndo();
      figma.commitUndo();
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
  }

  const mutations = current.mutations;
  const id = current.transactionId;
  current.state = "rolled-back";
  current.transactionId = null;
  current.mutations = 0;

  return {
    status: "transaction-rolled-back",
    transactionId: id,
    state: current.state,
    mutations,
    rolledBack,
    reason: hadMutations ? undefined : "The transaction made no changes, so there was nothing to undo.",
  };
}

/** Records a mutation that landed inside the open transaction. */
export function noteMutation(): void {
  if (current.state === "open") current.mutations += 1;
}

/**
 * Gate for a mutating call that names a transaction.
 *
 * After a rollback the state is closed, so a late in-flight call from an
 * aborted script is rejected here instead of mutating a document that was just
 * restored. Without this, a timed-out script could still land one more write
 * after the rollback, which is exactly the "silent mutation" the spec forbids.
 */
export function assertOpen(transactionId: string): void {
  if (current.state !== "open") {
    throw new Error(
      `Native transaction ${transactionId} is not open (state: ${current.state}). The script was aborted or already finished; no further mutations are accepted.`,
    );
  }
  if (current.transactionId !== null && current.transactionId !== transactionId) {
    throw new Error(
      `Native transaction ${transactionId} does not match the open transaction ${current.transactionId}.`,
    );
  }
}

export function nativeTransactionState(): State {
  return { ...current };
}
