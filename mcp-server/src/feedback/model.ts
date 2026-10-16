/**
 * Tags, change requests and feedback history (issue #11, Part D).
 *
 * ## The durability problem this solves
 *
 * A change request says "make these three buttons consistent" or "change this
 * screen but preserve this component's styling". Between making the request and
 * the work being reviewed days later, the file moves: layers get renamed,
 * re-ordered, replaced, deleted.
 *
 * A request that stores *names* becomes wrong silently — it applies to whatever
 * happens to be called "Primary Button" now, which may be a different thing, or
 * nothing. So:
 *
 *  - Targets are stored as **node ids**, with names captured separately as a
 *    human-readable label that is allowed to go stale.
 *  - A target that no longer resolves is reported as **needs-re-resolution**
 *    rather than substituted. The issue is explicit: "ask the user to re-resolve
 *    it rather than modifying a similar-looking node", and picking the nearest
 *    match by name is exactly the failure being refused.
 *  - Every applied change keeps a before/after revision so the history supports
 *    real comparison rather than an assertion that something changed.
 *
 * Status is an explicit state machine. "Applied" means a transaction committed
 * *and* verification ran — never that operations were merely dispatched.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

export const RequestStatusSchema = z.enum(["proposed", "approved", "applied", "rejected", "needs-re-resolution", "failed"]);
export type RequestStatus = z.infer<typeof RequestStatusSchema>;

export const ChangeKindSchema = z.enum(["edit", "restyle", "consistency", "accessibility", "layout", "content", "custom"]);
export type ChangeKind = z.infer<typeof ChangeKindSchema>;

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * One node the request is about.
 *
 * `nodeId` is the identity. `name` and `kind` are labels for the reader and are
 * expected to drift; `resolved` is recomputed on every read rather than stored,
 * so a stale "true" cannot outlive the rename that invalidated it.
 */
export const TargetSchema = z
  .object({
    nodeId: z.string().min(1).max(200),
    /** Captured at request time for readability. May go stale; never used to resolve. */
    name: z.string().max(300).default(""),
    nodeType: z.string().max(40).default(""),
    /** The component this instance came from, when it is one. */
    instanceOf: z.string().max(200).optional(),
  })
  .strict();
export type Target = z.infer<typeof TargetSchema>;

/* -------------------------------------------------------------------------- */
/* Constraints                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Something the change must not do.
 *
 * First-class rather than free text, because "do not change the topology" is the
 * constraint most likely to be violated by an edit that is otherwise reasonable,
 * and a structured constraint can be checked against the diff while a sentence
 * cannot.
 */
export const ConstraintSchema = z
  .object({
    id: z.string().min(1).max(80),
    /** What must hold. */
    description: z.string().min(3).max(300),
    /** Nodes the constraint protects. Empty means "the whole target set". */
    protectNodeIds: z.array(z.string().max(200)).max(200).default([]),
    /** Property the constraint is about, e.g. `fill`, `text`, `visible`. */
    property: z.string().max(60).optional(),
    /** Whether a violation blocks the change. Defaults to true. */
    blocking: z.boolean().default(true),
  })
  .strict();
export type Constraint = z.infer<typeof ConstraintSchema>;

/* -------------------------------------------------------------------------- */
/* Change request                                                              */
/* -------------------------------------------------------------------------- */

export const ChangeRequestSchema = z
  .object({
    id: z.string().min(1).max(80),
    project: z.string().max(200),
    /** The user's words, kept verbatim. */
    request: z.string().min(3).max(2000),
    kind: ChangeKindSchema.default("edit"),
    targets: z.array(TargetSchema).min(1).max(200),
    constraints: z.array(ConstraintSchema).max(50).default([]),
    status: RequestStatusSchema.default("proposed"),
    /** The proposed plan, produced before anything is applied. */
    plan: z.string().max(4000).optional(),
    /** Proposed operations, reported before commit. */
    proposedOperations: z.array(z.record(z.unknown())).max(500).default([]),
    /** The transaction that applied the change. */
    transactionId: z.string().max(200).optional(),
    /** Revision hash before and after, for real comparison. */
    beforeRevision: z.string().max(120).optional(),
    afterRevision: z.string().max(120).optional(),
    beforeRender: z.string().max(500).optional(),
    afterRender: z.string().max(500).optional(),
    /** Nodes whose id no longer resolves. Re-resolve rather than substitute. */
    unresolvedTargets: z.array(z.string().max(200)).max(200).default([]),
    /** Findings before and after, when verification ran. */
    findingsBefore: z.number().int().min(0).max(10000).optional(),
    findingsAfter: z.number().int().min(0).max(10000).optional(),
    verified: z.boolean().default(false),
    notes: z.array(z.string().max(500)).max(50).default([]),
    createdAt: z.string().max(40).default(""),
    updatedAt: z.string().max(40).default(""),
  })
  .strict();
export type ChangeRequest = z.infer<typeof ChangeRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Tags                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A label on one or more screens/components.
 *
 * Separate from change requests so tagging can be used purely for grouping —
 * "everything tagged onboarding" — without implying work.
 */
export const TagSchema = z
  .object({
    id: z.string().min(1).max(80),
    project: z.string().max(200),
    tag: z.string().min(1).max(60),
    targets: z.array(TargetSchema).min(1).max(200),
    createdAt: z.string().max(40).default(""),
  })
  .strict();
export type Tag = z.infer<typeof TagSchema>;

/* -------------------------------------------------------------------------- */
/* File                                                                        */
/* -------------------------------------------------------------------------- */

export const FeedbackFileSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().max(200),
    tags: z.array(TagSchema).max(500).default([]),
    requests: z.array(ChangeRequestSchema).max(1000).default([]),
    updatedAt: z.string().max(40).default(""),
  })
  .strict();
export type FeedbackFile = z.infer<typeof FeedbackFileSchema>;

/* -------------------------------------------------------------------------- */
/* Status transitions                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Legal status moves.
 *
 * Enforced rather than documented, because the status is what a reader trusts
 * when deciding whether work is done. `applied` is reachable only from
 * `approved`, and `needs-re-resolution` only from a state that had targets — so
 * "applied" cannot mean "someone tried".
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  proposed: ["approved", "rejected"],
  approved: ["applied", "failed", "rejected", "needs-re-resolution"],
  applied: ["needs-re-resolution"],
  failed: ["approved", "rejected", "needs-re-resolution"],
  "needs-re-resolution": ["approved", "rejected"],
  rejected: ["approved"],
};

export function canTransition(from: RequestStatus, to: RequestStatus): boolean {
  return from === to || (TRANSITIONS[from] ?? []).includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: RequestStatus,
    readonly to: RequestStatus,
  ) {
    super(`A change request cannot move from '${from}' to '${to}'. Allowed: ${(TRANSITIONS[from] ?? []).join(", ") || "none"}.`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * Moves a request to a new status, refusing an illegal move.
 *
 * `applied` additionally requires that verification ran. This is the issue's
 * "Created successfully must be distinct from passed visual QA" turned into a
 * type-level rule: an unverified change cannot be recorded as applied.
 */
export function transition(request: ChangeRequest, to: RequestStatus, patch: Partial<ChangeRequest> = {}): ChangeRequest {
  if (!canTransition(request.status, to)) throw new IllegalTransitionError(request.status, to);
  if (to === "applied" && request.verified !== true && patch.verified !== true) {
    throw new Error(
      "A change request cannot be marked 'applied' without verification. Run the review and render first, then set verified:true. 'Applied' means the change was checked, not that operations were dispatched.",
    );
  }
  return {
    ...request,
    ...patch,
    status: to,
    updatedAt: new Date().toISOString(),
  };
}