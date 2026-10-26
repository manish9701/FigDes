/**
 * Design memory and the do-not-drift layer (spec §27, §28, §29).
 *
 * ## Why this exists
 *
 * ChatGPT's conversation memory is the wrong tool for design decisions. It is
 * per-conversation, it is prose, and it cannot be inspected or corrected. The
 * spec asks for something different and better: **design memory** — durable,
 * structured, per-project notes about what worked, checked into the repo and
 * readable by the runtime.
 *
 * Two kinds of memory, deliberately separated:
 *
 * 1. **Observations** — what a human or the agent learned about how this project
 *    should look. "Topology screens perform better as large spatial diagrams."
 *    These are subjective and evolve.
 *
 * 2. **Rules** — product truths that are objectively checkable (spec §29).
 *    "Devices auto-discover, so a manual connect-device wizard contradicts the
 *    product." These are deterministic and are *enforced*, not suggested.
 *
 * The split matters because conflating them is how rule sets become
 * unenforceable: a subjective preference reported as FAIL trains the user to
 * ignore FAIL.
 *
 * `DesignGuard` is the layer that reads both and produces PASS / WARNING / FAIL.
 * It is deliberately conservative about what counts as a failure: a false FAIL
 * gets ignored, and once ignored the whole layer is ignored.
 */
import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* Observations                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One durable note about how this project should look.
 *
 * `scope` controls where it applies. `project` notes are injected into every
 * program; `screen` notes only when that screen is being built. Screen-scoped
 * knowledge is what keeps "the inspector is dark on this screen" from silently
 * becoming a global rule.
 */
export const MemoryNoteSchema = z
  .object({
    id: z.string().min(1).max(120),
    /** Free text, but a single assertion. "Avoid X", "Y works well". */
    note: z.string().min(3).max(500),
    scope: z.enum(["project", "screen", "composition"]).default("project"),
    /** Screen id this applies to, when scope is 'screen'. */
    screen: z.string().max(120).optional(),
    /** Composition this applies to, when scope is 'composition'. */
    composition: z.string().max(60).optional(),
    tags: z.array(z.string().max(40)).max(8).default([]),
    /** ISO timestamp. */
    recordedAt: z.string().max(40).default(""),
    /**
     * Provenance (blueprint §12). Optional so every note recorded before this
     * field existed keeps parsing: where the note came from, which revision it
     * was judged against, and who stands behind it.
     */
    provenance: z
      .object({
        source: z.string().max(200).optional(),
        sessionId: z.string().max(200).optional(),
        frameId: z.string().max(200).optional(),
        revisionId: z.string().max(200).optional(),
        reviewer: z.string().max(200).optional(),
      })
      .strict()
      .optional(),
    /** 0–1: how much to trust this note. Absent means unrated, not certain. */
    confidence: z.number().min(0).max(1).optional(),
    /** ISO timestamp after which this note must be re-confirmed. */
    validUntil: z.string().max(40).optional(),
    /** Id of the note that replaces this one, when superseded. */
    supersededBy: z.string().min(1).max(120).optional(),
  })
  .strict();

export type MemoryNote = z.infer<typeof MemoryNoteSchema>;

/* -------------------------------------------------------------------------- */
/* Product rules                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The evidence kinds a rule can be checked against.
 *
 * These map onto things the server can actually measure or count. A rule whose
 * evidence is not in this list cannot be enforced, and would be decoration.
 */
export type RuleEvidence =
  /** A text node matching this pattern. */
  | { kind: "forbiddenText"; pattern: string; flags?: string }
  /** A count of component instances of a given semantic type. */
  | { kind: "maxInstances"; component: string; max: number }
  /** Total count of instances of a semantic type. */
  | { kind: "maxComponents"; component: string; max: number }
  /** A layout composition that must not be the primary one. */
  | { kind: "forbidComposition"; composition: string }
  /** A count of nodes matching a layer-name pattern. */
  | { kind: "maxNodes"; namePattern: string; max: number }
  /** A count of text nodes matching a pattern. */
  | { kind: "maxTexts"; pattern: string; max: number }
  /** A boolean assertion about measured evidence, e.g. `metricCards >= 3`. */
  | { kind: "assert"; metric: string; op: "<" | "<=" | ">" | ">=" | "==" | "!="; value: number }
  /**
   * A conditional assertion: when the premise holds, the conclusion must hold.
   *
   * This is what makes rules like "a topology with nodes must have edges"
   * checkable without failing screens that have no topology at all. Without it,
   * every such rule would either false-positive on unrelated screens or be
   * declared unmeasurable.
   */
  | { kind: "implies"; ifMetric: string; ifOp: "<" | "<=" | ">" | ">=" | "==" | "!="; ifValue: number; thenMetric: string; thenOp: "<" | "<=" | ">" | ">=" | "==" | "!="; thenValue: number }
  /** Always checked by hand; reported so a human decides. */
  | { kind: "manual"; question: string };

/**
 * Zod mirror of `RuleEvidence`.
 *
 * `z.lazy` is required because the type is a recursive-free union that refers
 * back to itself through the discriminated-union helper. Kept as a schema rather
 * than trusting `as` so a malformed rule file is rejected on load instead of
 * throwing at evaluation time.
 */
const RuleEvidenceSchema: z.ZodType<RuleEvidence> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("forbiddenText"), pattern: z.string().min(1).max(200), flags: z.string().max(20).optional() }).strict(),
    z.object({ kind: z.literal("maxInstances"), component: z.string().min(1).max(60), max: z.number().int().min(0).max(200) }).strict(),
    z.object({ kind: z.literal("maxComponents"), component: z.string().min(1).max(60), max: z.number().int().min(0).max(200) }).strict(),
    z.object({ kind: z.literal("forbidComposition"), composition: z.string().min(1).max(60) }).strict(),
    z.object({ kind: z.literal("maxNodes"), namePattern: z.string().min(1).max(200), max: z.number().int().min(0).max(10000) }).strict(),
    z.object({ kind: z.literal("maxTexts"), pattern: z.string().min(1).max(200), max: z.number().int().min(0).max(2000) }).strict(),
    z
      .object({
        kind: z.literal("assert"),
        metric: z.string().min(1).max(80),
        op: z.enum(["<", "<=", ">", ">=", "==", "!="]),
        value: z.number(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("implies"),
        ifMetric: z.string().min(1).max(80),
        ifOp: z.enum(["<", "<=", ">", ">=", "==", "!=",]),
        ifValue: z.number(),
        thenMetric: z.string().min(1).max(80),
        thenOp: z.enum(["<", "<=", ">", ">=", "==", "!="]),
        thenValue: z.number(),
      })
      .strict(),
    z.object({ kind: z.literal("manual"), question: z.string().min(3).max(300) }).strict(),
  ]),
) as z.ZodType<RuleEvidence>;

/**
 * One product truth and what it forbids (spec §29).
 *
 * `therefore` is the consequence, kept as text because it is what a human reads
 * when the rule fires. `severity` separates "this is wrong" from "this is worth
 * noticing", which is the difference between a FAIL and a WARNING.
 */
export const ProductRuleSchema = z
  .object({
    id: z.string().min(1).max(80),
    /** The truth. */
    rule: z.string().min(3).max(400),
    /** What must not be designed because of it. */
    therefore: z.string().min(3).max(400),
    severity: z.enum(["fail", "warn"]).default("fail"),
    evidence: z.array(RuleEvidenceSchema).max(12).default([]),
    /** Optional counter-examples: what a PASS looks like. */
    passesWhen: z.array(z.string().max(200)).max(6).default([]),
  })
  .strict();

export type ProductRule = z.infer<typeof ProductRuleSchema>;

/**
 * The project design profile, in the project's own words (GitHub issue #27).
 *
 * This is the boundary between reusable design intelligence and one product's
 * facts: identity, typical artefacts, anti-goals and visual direction. It does
 * NOT carry acceptance rules — those are `ProductRule`s in the same memory
 * file, scoped to the project either way.
 */
export const ProjectProfileRefSchema = z
  .object({
    /** The product this project designs, matching a registered profile id. */
    product: z.string().min(1).max(80),
    /** What the product is, in the project's own words. */
    domain: z.string().max(160).optional(),
    /** Who designs it for. */
    audience: z.string().max(160).optional(),
    /** The artefact types this project typically produces ("product-ui", "editorial"...). */
    artefactTypes: z.array(z.string().max(40)).max(8).default([]),
    /** Explicit anti-goals, in the project's own words. */
    antiGoals: z.array(z.string().max(200)).max(8).default([]),
    /** The project's stated visual direction, when it has one. */
    visualDirection: z.string().max(160).optional(),
  })
  .strict();

export type ProjectProfileRef = z.infer<typeof ProjectProfileRefSchema>;

/* -------------------------------------------------------------------------- */
/* Guard verdicts                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Guard verdicts.
 *
 * `INDETERMINATE` is not a softer PASS — it is the verdict for "the guard had
 * nothing to look at". A snapshot that resolved to zero nodes cannot satisfy a
 * forbidden-text rule by absence in any meaningful sense, because absence here
 * means the target was never found rather than the copy being absent. Live
 * defect: `design_guard(inspect:true)` returned PASS for 13 rules while its own
 * snapshot reported `nodes: 0` on a page holding 751 nodes.
 */
export const VerdictSchema = z.enum(["PASS", "WARNING", "FAIL", "INDETERMINATE"]);

export type Verdict = z.infer<typeof VerdictSchema>;

export interface GuardFinding {
  verdict: Verdict;
  /** Rule id, or `memory:<id>` for an observation. */
  rule: string;
  message: string;
  /** What was actually measured, so the verdict is falsifiable. */
  evidence?: string;
  /** What to do instead. */
  nextStep?: string;
}

/**
 * The stored shape for one project.
 *
 * `rules` defaults to an EMPTY list rather than the built-in EXO set
 * (GitHub issue #27): seeding one project's product truths into every new
 * project is exactly the cross-project leak the profile boundary exists to
 * prevent. A project with no rules and no profile plans and guards under
 * general, domain-neutral defaults; EXO's truths arrive through the exo
 * profile when the project resolves to it. A guard run with no product rules
 * active reports INDETERMINATE, never a whispered approval.
 */
export const ProjectMemorySchema = z
  .object({
    version: z.literal(1).default(1),
    project: z.string().min(1).max(200),
    /** Figma file key when there is one; the file name otherwise. */
    fileKey: z.string().max(200).nullable().default(null),
    notes: z.array(MemoryNoteSchema).max(300).default([]),
    rules: z.array(ProductRuleSchema).max(100).default([]),
    /** The project's design profile, when one is recorded or seeded. */
    profile: ProjectProfileRefSchema.optional(),
    updatedAt: z.string().max(40).default(""),
  })
  .strict();

export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;