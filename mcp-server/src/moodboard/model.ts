/**
 * Moodboards and scoped visual references (issue #11, Part C).
 *
 * ## The product decision this module encodes
 *
 * Moodboards are **opt-in, scoped context**. Not a permanently-active injection.
 * The issue is explicit about why, and the reasoning holds:
 *
 *  - Keeping every saved moodboard in context burns tokens on every turn.
 *  - Irrelevant visual signals become relevant-looking signals, and a reference
 *    from one task leaks into an unrelated screen.
 *  - A context full of everything is a context where nothing can be attributed:
 *    when the agent picks a layout, "why this?" has no answer.
 *
 * So there are three separate stores with different lifetimes:
 *
 *  1. **Reference library** — saved moodboards and their source frames. Durable,
 *     but *inactive*. Nothing here enters a prompt unless it is attached.
 *  2. **Visual brief** — observations extracted from a moodboard, each carrying
 *     its evidence reference and a confidence. Editable and explicitly approved.
 *     An observation is a claim about an image, not a rule about the product.
 *  3. **Approved profile** — the small, distilled set of rules the user has
 *     approved. This is the only thing injected by default, and it is meant to
 *     stay small enough to read.
 *
 * Plus **task attachments**, which are scoped, expiring, and recorded, so a later
 * reader can say which references influenced a screen.
 *
 * ## What is deliberately absent
 *
 * There is no automatic merging of a moodboard into the project profile. The
 * issue requires explicit approval, and an automatic merge is exactly how a
 * saved image becomes an unarguable rule about a product it has never seen.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                  */
/* -------------------------------------------------------------------------- */

/** How strongly an attached reference should influence the result. */
export const InfluenceSchema = z.enum(["subtle", "balanced", "strong"]);
export type Influence = z.infer<typeof InfluenceSchema>;

/** Where a reference applies. The narrowest scope wins when scopes overlap. */
export const ScopeSchema = z.enum(["project", "screen", "components", "task"]);
export type Scope = z.infer<typeof ScopeSchema>;

/** Which aspects of the design a reference speaks to. */
export const ReferenceRoleSchema = z.enum(["visual-style", "layout", "typography", "interaction", "data-visualization", "component-pattern"]);
export type ReferenceRole = z.infer<typeof ReferenceRoleSchema>;

/** What an extracted observation is about. */
export const ObservationKindSchema = z.enum([
  "palette",
  "typography",
  "spacing",
  "grid",
  "density",
  "shape",
  "surface",
  "component-pattern",
  "anti-pattern",
]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

/**
 * Where a claim came from.
 *
 * The issue requires that "logs distinguish source observations from approved
 * rules and model inferences", and that "if previews or sources are inaccessible,
 * the user sees an explicit partial-analysis state". Both are enforceable only if
 * provenance is a field rather than a convention.
 */
export const ProvenanceSchema = z.enum(["measured", "observed", "inferred", "user-stated"]);
export type Provenance = "measured" | "observed" | "inferred" | "user-stated";

/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A saved source: a Figma frame, or an external image.
 *
 * Node ids rather than names, always. A name is a label a designer is free to
 * change; an id is the thing. The issue asks that "attaching a moodboard records
 * stable source IDs/URLs", and a name is not stable.
 */
export const MoodboardSourceSchema = z
  .object({
    kind: z.enum(["figma-node", "image-url", "local-image"]),
    /** Figma node id. Stable across rename and reorder. */
    nodeId: z.string().max(200).optional(),
    /** Page the node lives on, for re-resolution when the id is gone. */
    pageName: z.string().max(200).optional(),
    fileKey: z.string().max(200).nullish(),
    url: z.string().max(2000).optional(),
    /** A human label, and what the designer sees in the list. */
    label: z.string().max(200).default(""),
    /** The text a screen reader would get. Required for images. */
    alt: z.string().max(500).optional(),
    /**
     * Whether the source could actually be read.
     *
     * A source we cannot open is a real state, not an error to hide: the issue
     * asks for an explicit partial-analysis state rather than a pretended
     * analysis. Nothing downstream may claim to have seen an unreadable source.
     */
    readable: z.boolean().default(true),
    /** Why it could not be read. */
    unreadableReason: z.string().max(300).optional(),
  })
  .strict();
export type MoodboardSource = z.infer<typeof MoodboardSourceSchema>;

/**
 * One saved moodboard.
 *
 * A moodboard is a *container for sources*, not a set of rules. That separation
 * is the whole design: the container is durable and inactive, the rules derived
 * from it require approval.
 */
export const MoodboardSchema = z
  .object({
    id: z.string().min(1).max(80),
    project: z.string().max(200),
    title: z.string().min(1).max(200),
    sources: z.array(MoodboardSourceSchema).max(40),
    /** ISO timestamp. */
    createdAt: z.string().max(40).default(""),
    /** Free-text note about why this was saved. */
    intent: z.string().max(1000).optional(),
  })
  .strict();
export type Moodboard = z.infer<typeof MoodboardSchema>;

/* -------------------------------------------------------------------------- */
/* Visual brief                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One observation about a moodboard.
 *
 * `evidence` is what makes this reviewable rather than oracle: the frame and
 * region it was read from. An observation with no evidence is still allowed —
 * it may be a whole-image judgement — but it is marked `inferred` and cannot be
 * approved without the user seeing that distinction.
 */
export const ObservationSchema = z
  .object({
    id: z.string().min(1).max(80),
    moodboardId: z.string().min(1).max(80),
    kind: ObservationKindSchema,
    /** What was observed, in one sentence. */
    claim: z.string().min(3).max(400),
    /** How strongly the extraction believes it. */
    confidence: z.number().min(0).max(1),
    provenance: ProvenanceSchema,
    /** The source this came from, and where on it. */
    evidence: z
      .object({
        sourceNodeId: z.string().max(200).optional(),
        area: z.string().max(200).optional(),
        /** Measured values backing the claim, e.g. the fills it saw. */
        measurement: z.record(z.unknown()).optional(),
      })
      .strict()
      .optional(),
    /** Approved by the user? Only approved rules reach the project profile. */
    approved: z.boolean().default(false),
    /** The user edited the claim, so it is theirs rather than the model's. */
    editedByUser: z.boolean().default(false),
  })
  .strict();
export type Observation = z.infer<typeof ObservationSchema>;

/**
 * The analysable state of one moodboard.
 *
 * `partial` is the important field. When any source is unreadable, the brief is
 * marked partial and the reason is carried, so a consumer cannot mistake "we
 * analysed three of five frames" for "we analysed this moodboard".
 */
export const VisualBriefSchema = z
  .object({
    moodboardId: z.string().min(1).max(80),
    observations: z.array(ObservationSchema).max(200),
    /** True when at least one source could not be read. */
    partial: z.boolean().default(false),
    /** Sources that could not be read, and why. */
    unreadableSources: z.array(z.string().max(300)).max(40).default([]),
    analysedAt: z.string().max(40).default(""),
  })
  .strict();
export type VisualBrief = z.infer<typeof VisualBriefSchema>;

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A reference attached to one task.
 *
 * `taskId` is what makes task scope enforceable: attachments are looked up by
 * task, so a reference attached to one screen cannot appear in another's prompt
 * without something explicitly copying it across.
 */
export const AttachmentSchema = z
  .object({
    id: z.string().min(1).max(80),
    moodboardId: z.string().min(1).max(80),
    project: z.string().max(200),
    taskId: z.string().min(1).max(120),
    influence: InfluenceSchema.default("balanced"),
    scope: ScopeSchema.default("task"),
    /** Which aspects this reference speaks to. Empty means "all of them". */
    roles: z.array(ReferenceRoleSchema).max(6).default([]),
    /** Traits the agent must NOT carry over from this reference. */
    exclusions: z.array(z.string().max(200)).max(20).default([]),
    /** Nodes this reference is scoped to, when scope is components/screen. */
    targetNodeIds: z.array(z.string().max(200)).max(200).default([]),
    screenId: z.string().max(120).optional(),
    attachedAt: z.string().max(40).default(""),
    /**
     * Task-only attachments are dropped from active context when the task ends.
     * The moodboard stays in the library; only the attachment expires.
     */
    expiresAfterTask: z.boolean().default(true),
  })
  .strict();
export type Attachment = z.infer<typeof AttachmentSchema>;

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export const MoodboardFileSchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().max(200),
    moodboards: z.array(MoodboardSchema).max(500).default([]),
    briefs: z.array(VisualBriefSchema).max(500).default([]),
    attachments: z.array(AttachmentSchema).max(500).default([]),
    updatedAt: z.string().max(40).default(""),
  })
  .strict();
export type MoodboardFile = z.infer<typeof MoodboardFileSchema>;

/**
 * The distilled, approved rules. The only moodboard content that is ever
 * injected without an explicit attachment.
 *
 * Deliberately separate from `VisualBrief` and much smaller: a profile is meant
 * to fit in a paragraph. A profile that grows to the size of the library has
 * stopped being a profile and become the thing the design was avoiding.
 */
export const ProjectVisualProfileSchema = z
  .object({
    project: z.string().max(200),
    /** Approved observations, flattened to claim + evidence. */
    rules: z
      .array(
        z
          .object({
            observationId: z.string().max(80),
            moodboardId: z.string().max(80),
            kind: ObservationKindSchema,
            claim: z.string().max(400),
            evidence: z.string().max(300).optional(),
          })
          .strict(),
      )
      .max(60)
      .default([]),
    updatedAt: z.string().max(40).default(""),
  })
  .strict();
export type ProjectVisualProfile = z.infer<typeof ProjectVisualProfileSchema>;