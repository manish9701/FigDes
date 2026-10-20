/**
 * Stage 7 — targeted repair (issue #16, §Stage 7).
 *
 * ## Repair, not regeneration
 *
 * The expensive failure mode in this system is regenerating a whole screen to
 * fix one local defect: the good parts move, the parts nobody was looking at
 * change, and the user has to re-check everything. So a repair here is always
 * **targeted**: it names the nodes it will touch, and it refuses to run when
 * it cannot name them.
 *
 * Three properties make a repair safe to run twice:
 *
 * 1. **It names its targets.** An operation without a node id is not a repair,
 *    it is a rewrite, and it is refused.
 * 2. **It is bounded.** The budget is a number of instructions, and running out
 *    of budget is reported as running out of budget — never as convergence.
 * 3. **It is idempotent.** A repair that sets a property to the value it
 *    already holds is a no-op, so a retried repair does not move anything.
 */
import type { PipelineFinding } from "./contracts";

/** One repair, ready to apply. */
export interface RepairInstruction {
  findingId: string;
  title: string;
  /** Why this repair, and what it should change. */
  detail: string;
  /** The nodes this repair touches. Never empty. */
  targetIds: string[];
  /** The operations to apply. */
  operations: Array<Record<string, unknown>>;
  /** Whether the pipeline may apply it without asking. */
  automatable: boolean;
  /** What should be true afterwards. */
  expectedEffect: string;
}

export interface RepairPlan {
  instructions: RepairInstruction[];
  /** Findings that were not repaired, and why. */
  skipped: Array<{ findingId: string; why: string }>;
  /** The budget that was applied. */
  budget: number;
}

/** A finding that carries its own operations (the review rules do). */
export interface FindingWithOperations extends PipelineFinding {
  suggestedOperations?: Array<Record<string, unknown>>;
}

/**
 * Turns findings into repairs.
 *
 * The order is the issue's order: the primary task first, then hierarchy and
 * composition, then overlap and clipping, then readability, then density, then
 * consistency, then polish. A screen with a missing primary action and a
 * 2px misalignment does not need the misalignment fixed first.
 */
const SEVERITY_ORDER: Record<PipelineFinding["severity"], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};

export function planRepairs(
  findings: Array<PipelineFinding | FindingWithOperations>,
  options: { budget?: number; allowAutomated?: boolean } = {},
): RepairPlan {
  const budget = options.budget ?? 3;
  const allowAutomated = options.allowAutomated ?? true;

  const ordered = [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return a.id.localeCompare(b.id);
  });

  const instructions: RepairInstruction[] = [];
  const skipped: Array<{ findingId: string; why: string }> = [];

  for (const finding of ordered) {
    if (instructions.length >= budget) {
      skipped.push({ findingId: finding.id, why: `The repair budget of ${budget} instruction(s) was reached.` });
      continue;
    }
    if (!finding.automatable && !allowAutomated) {
      skipped.push({ findingId: finding.id, why: "The repair needs a human decision, and automated repairs are disabled." });
      continue;
    }

    const operations = (finding as FindingWithOperations).suggestedOperations ?? [];
    if (operations.length === 0) {
      skipped.push({ findingId: finding.id, why: "No targeted operation is available for this finding; it needs a human decision." });
      continue;
    }

    // A repair that touches no named node is a rewrite, not a repair.
    const targetIds = [
      ...new Set(
        operations
          .map((op) => (typeof op["target"] === "string" ? (op["target"] as string) : undefined))
          .filter((id): id is string => typeof id === "string" && id.length > 0),
      ),
    ];
    if (targetIds.length === 0) {
      skipped.push({ findingId: finding.id, why: "The proposed operations do not name a target node, so they are not a targeted repair." });
      continue;
    }

    instructions.push({
      findingId: finding.id,
      title: finding.summary,
      detail: `${finding.why} ${finding.fix}`,
      targetIds,
      operations,
      automatable: finding.automatable,
      expectedEffect: finding.fix,
    });
  }

  return { instructions, skipped, budget };
}

/**
 * Drops operations that would change nothing.
 *
 * Idempotency at the operation level: a repair that re-applies a value the
 * node already has is not a repair, it is a no-op that still costs a
 * transaction and still moves the node's place in the undo history.
 */
export function deduplicateOperations(operations: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const out: Array<Record<string, unknown>> = [];
  for (const op of operations) {
    const key = JSON.stringify(op, Object.keys(op).sort());
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(op);
  }
  return out;
}
