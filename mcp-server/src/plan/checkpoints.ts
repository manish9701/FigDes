/**
 * Human checkpoints (spec §38).
 *
 * ## Why a gate, not a warning
 *
 * §38 lists five situations where the system should pause. The temptation is to
 * implement these as warnings in the response text, which is what a
 * well-meaning implementation does and which achieves nothing: the model reads
 * the warning, decides it is probably fine, and proceeds. A gate has to be
 * *structural* — the tool refuses and names the one question the user must
 * answer.
 *
 * ## The cost this accepts
 *
 * Every gate is a round trip. That is real latency, and gratuitous gates are
 * worse than none: a user who is asked to approve trivial work stops reading the
 * approvals. So each rule below has to name a case where proceeding without
 * asking would be *expensive to undo*, not merely untidy.
 *
 * The default is to let work through. These five are the exceptions.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Thresholds                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many nodes a transaction may touch before asking.
 *
 * A number rather than a feeling. Below this, one undo covers the damage; above
 * it, the user has to reason about what a single undo is about to discard.
 */
export const DEFAULT_DESTRUCTIVE_THRESHOLD = 40;

/** What is being changed, as far as the gate can tell. */
export interface ChangeShape {
  /** Operations about to run. */
  operationCount?: number;
  /** How many of them delete or remove something. */
  destructiveCount?: number;
  /** How many distinct existing nodes are targeted. */
  targetCount?: number;
  /** Is a whole design-system token or style being rewritten? */
  globalTokenChange?: boolean;
  /** Is this an operation on a variable collection or style shared across the file? */
  changesSharedResource?: boolean;
}

export interface CheckpointRequest {
  rule: "destructive" | "global-token" | "shared-resource" | "composition-uncertain";
  question: string;
  /** What will happen if the user says yes. */
  ifApproved: string;
  /** What to do instead, when there is a safer option. */
  instead?: string;
}

export interface CheckpointResult {
  /** True when work may proceed. */
  cleared: boolean;
  checkpoint?: CheckpointRequest;
  /** Every rule that fired, so the user sees the full picture not just the first. */
  all: CheckpointRequest[];
}

/**
 * Evaluates the gates.
 *
 * Returns *all* fired rules rather than short-circuiting on the first: telling
 * someone "this is destructive" when it is also a global token change hides the
 * more serious of the two, and they approve the wrong thing.
 */
export function evaluateCheckpoints(shape: ChangeShape, opts: { destructiveThreshold?: number } = {}): CheckpointResult {
  const threshold = opts.destructiveThreshold ?? DEFAULT_DESTRUCTIVE_THRESHOLD;
  const all: CheckpointRequest[] = [];

  const destructive = shape.destructiveCount ?? 0;
  if (destructive > 0) {
    all.push({
      rule: "destructive",
      question: `${destructive} node(s) in this change will be deleted or removed. That is not reversible except by undo.`,
      ifApproved: "The nodes are removed, and one Figma undo reverses the whole transaction.",
      instead: "Consider modify_design to hide or move them instead, which is reversible without an undo.",
    });
  }

  const touched = shape.targetCount ?? 0;
  if (touched > threshold) {
    all.push({
      rule: "destructive",
      question: `This change targets ${touched} existing nodes, above the ${threshold} threshold. A single undo would discard all of it.`,
      ifApproved: `All ${touched} nodes are modified in one transaction.`,
      instead: "Split it into smaller transactions so a mistake costs less to reverse.",
    });
  }

  if (shape.globalTokenChange) {
    all.push({
      rule: "global-token",
      question: "This changes a design token or style used across the file. Every screen using it changes at once.",
      ifApproved: "The token's new value applies everywhere it is referenced, immediately.",
      instead: "Add a new token alongside the old one and migrate deliberately, if a gradual move is wanted.",
    });
  }

  if (shape.changesSharedResource) {
    all.push({
      rule: "shared-resource",
      question: "This modifies a variable collection or style that other screens may depend on.",
      ifApproved: "The shared resource changes for every consumer.",
      instead: "Inspect the consumers with inspect_design_system first and confirm the blast radius.",
    });
  }

  return all.length === 0 ? { cleared: true, all: [] } : { cleared: false, checkpoint: all[0], all };
}

/* -------------------------------------------------------------------------- */
/* Overriding                                                                  */
/* -------------------------------------------------------------------------- */

export const ConfirmArgs = z
  .object({
    /** The checkpoint the user approved. Must match, so a stale approval is rejected. */
    checkpoint: z.string().max(200).optional(),
    /**
     * Explicit human approval. Without this, `design_runtime` and `modify_design`
     * refuse when a gate fires.
     *
     * Recorded on the request so the audit log shows that a human, not the
     * model, chose to proceed.
     */
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();

/**
 * Tracks which checkpoints have been approved, per session.
 *
 * Bounded and single-use: an approval covers one specific change, not the rest of
 * the conversation. An approval that persisted would mean the second destructive
 * edit also sailed through, which defeats the gate entirely.
 */
export class CheckpointLedger {
  private readonly approved = new Map<string, { at: number; reason?: string }>();
  private readonly ttlMs: number;

  constructor(ttlMs = 10 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  /** A stable key for one change, so approving one edit does not approve the next. */
  static keyFor(parts: Array<string | number | boolean | undefined>): string {
    return parts.map((p) => String(p ?? "")).join("|");
  }

  approve(key: string, reason?: string): void {
    this.approved.set(key, { at: Date.now(), ...(reason !== undefined ? { reason } : {}) });
    this.prune();
  }

  /** Consumes an approval. Single-use by design. */
  consume(key: string): { approved: boolean; reason?: string } {
    this.prune();
    const hit = this.approved.get(key);
    if (!hit) return { approved: false };
    this.approved.delete(key);
    return { approved: true, ...(hit.reason !== undefined ? { reason: hit.reason } : {}) };
  }

  has(key: string): boolean {
    this.prune();
    return this.approved.has(key);
  }

  /** Drops a stored approval without consuming it. */
  forget(key: string): void {
    this.approved.delete(key);
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, entry] of this.approved) {
      if (entry.at < cutoff) this.approved.delete(key);
    }
  }
}