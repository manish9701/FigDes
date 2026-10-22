/**
 * The design decision record (issue #22 §7, phase "offline runner").
 *
 * §7: "Preserve context: the original brief, the design system constraints
 * discovered, and the chosen direction are all preserved as a design decision
 * record for review, so that if the design generation needs to be repaired or
 * resumed, the previous design intent is not lost."
 *
 * A repair pass that cannot load *why* the screen looks the way it does will
 * redesign it by accident. The record is durable evidence: the brief and its
 * hard constraints, the selected direction and its rationale, the skills that
 * drove it and why, what was discovered along the way, which alternatives were
 * rejected, what still stands unresolved — and every repair attempt — in one
 * versioned document that can be persisted next to a run and loaded before a
 * resume. `resumeDrift` is the guard: on resume, the compiled intent is
 * compared to the recorded one, and a change in manner (style/density) without
 * a new brief is named as drift instead of silently taking effect.
 */
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { SkillDecision } from "./skills/contracts";
import type { OfflineCaseBrief } from "./benchmark/offline-briefs";

export const DECISION_RECORD_SCHEMA = "figdes-decision-record-v1";

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

export interface DecisionDirection {
  /** The composition family the alternatives engine steered to, when it did. */
  composition: string | null;
  /** Why this direction, in one sentence a reviewer can audit. */
  rationale: string;
  /** The compiled intent's style manner, when the direction skill set one. */
  intentStyle: string | null;
  /** The compiled intent's density, when the density skill set one. */
  intentDensity: string | null;
}

export interface DecisionSkillsUsed {
  /** `direction` / `composition` / `type-and-space` / `anti-generic` … */
  id: string;
  /** The reason, quoted from the skill's own decisions. */
  why: string;
}

export interface DesignDecisionRecord {
  schema: string;
  /** The benchmark case id when the record was produced by the runner. */
  caseId: string | null;
  recordedAt: string;
  brief: {
    screen: string;
    product: string | null;
    purpose: string;
    primaryDecision: string;
    primaryAction: string | null;
    requiredInformation: string[];
    optionalInformation: string[];
    viewport: { width: number; height: number };
    visualDirection: string | null;
  };
  /** The brief's hard constraints — antiGoals plus every hard skill decision. */
  constraints: string[];
  direction: DecisionDirection;
  skills: DecisionSkillsUsed[];
  /** Design-system and brief discoveries surfaced while planning. */
  discoveries: string[];
  rejectedAlternatives: Array<{ family: string; reason: string; total?: number }>;
  /** Findings that still stand: structural, type-criteria and anti-generic. */
  outstandingIssues: Array<{ rule: string; summary: string; severity: string }>;
  /** One entry per repair pass, resolved or not — attempts are never erased. */
  repairAttempts: Array<{
    findingIds: string[];
    result: string;
    mutations: Array<{ kind: string; description: string }>;
    notes: string[];
  }>;
}

/* -------------------------------------------------------------------------- */
/* Building                                                                    */
/* -------------------------------------------------------------------------- */

/** The narrow, structural subset the record freezes from a pipeline run. */
export interface DecisionRecordInput {
  caseId?: string | null;
  brief: {
    screen: string;
    product?: string | null;
    purpose: string;
    primaryDecision: string;
    primaryAction?: string | null;
    requiredInformation: string[];
    optionalInformation?: string[];
    viewport?: { width: number; height: number };
    visualDirection?: string | null;
    antiGoals?: string[];
  };
  /** Intent the direction committed to — the drift guard compares this on resume. */
  intent?: Record<string, unknown> | null;
  /** The composition the alternatives engine steered to, when it did. */
  steeredComposition?: string | null;
  /** Why the direction was taken: the engine's provenance or the plan's own. */
  directionRationale?: string | null;
  /** The skill decisions, grouped here into "skill used, and why". */
  decisions?: SkillDecision[];
  /** Notes and assumptions surfaced while planning. */
  discoveries?: string[];
  /** Alternatives the engine scored but did not select. */
  rejectedAlternatives?: Array<{ family: string; reason: string; total?: number }>;
  /** Findings that still stand after the run. */
  outstandingIssues?: Array<{ rule: string; summary: string; severity: string }>;
  /** Repair traces, in the narrow `repair-history.ts` shape. */
  repairs?: Array<{
    findingIds: string[];
    result: string;
    mutations: Array<{ kind: string; description: string }>;
    notes?: string[];
  }>;
  /** Injectable clock, so a test can pin the recorded time. */
  now?: () => string;
}

/** The recorded style manner — the string the drift guard compares. */
function styleManner(intent: Record<string, unknown> | null | undefined): string | null {
  const style = intent?.["style"];
  if (style === null || style === undefined) return null;
  if (typeof style === "string") return style;
  if (typeof style === "object") {
    const manner = (style as Record<string, unknown>)["manner"];
    if (typeof manner === "string") return manner;
  }
  return null;
}

function densityOf(intent: Record<string, unknown> | null | undefined): string | null {
  const density = intent?.["density"];
  return typeof density === "string" ? density : null;
}

/** Groups the skill decisions into "skill used, and why" entries. */
export function skillsFromDecisions(decisions: SkillDecision[] | undefined): DecisionSkillsUsed[] {
  if (!decisions || decisions.length === 0) return [];
  const bySkill = new Map<string, string[]>();
  for (const d of decisions) {
    const whys = bySkill.get(d.skill) ?? [];
    whys.push(`${d.key}: ${d.why}`);
    bySkill.set(d.skill, whys);
  }
  return [...bySkill.entries()].map(([id, whys]) => ({ id, why: whys.join("; ") }));
}

export function buildDecisionRecord(input: DecisionRecordInput): DesignDecisionRecord {
  return {
    schema: DECISION_RECORD_SCHEMA,
    caseId: input.caseId ?? null,
    recordedAt: (input.now ?? (() => new Date().toISOString()))(),
    brief: {
      screen: input.brief.screen,
      product: input.brief.product ?? null,
      purpose: input.brief.purpose,
      primaryDecision: input.brief.primaryDecision,
      primaryAction: input.brief.primaryAction ?? null,
      requiredInformation: [...input.brief.requiredInformation],
      optionalInformation: [...(input.brief.optionalInformation ?? [])],
      viewport: { ...(input.brief.viewport ?? { width: 1440, height: 900 }) },
      visualDirection: input.brief.visualDirection ?? null,
    },
    constraints: [...(input.brief.antiGoals ?? [])],
    direction: {
      composition: input.steeredComposition ?? null,
      rationale: input.directionRationale ?? "The plan composed freely; no composition was steered.",
      intentStyle: styleManner(input.intent),
      intentDensity: densityOf(input.intent),
    },
    skills: skillsFromDecisions(input.decisions),
    discoveries: [...(input.discoveries ?? [])],
    rejectedAlternatives: [...(input.rejectedAlternatives ?? [])],
    outstandingIssues: [...(input.outstandingIssues ?? [])],
    repairAttempts: (input.repairs ?? []).map((r) => ({
      findingIds: [...r.findingIds],
      result: r.result,
      mutations: r.mutations.map((m) => ({ kind: m.kind, description: m.description })),
      notes: [...(r.notes ?? [])],
    })),
  };
}

/** Builds a record from a benchmark fixture + the evidence the plan left behind. */
export function recordForOfflineCase(
  fixture: OfflineCaseBrief,
  pieces: {
    intent?: Record<string, unknown> | null;
    steeredComposition?: string | null;
    directionRationale?: string | null;
    decisions?: SkillDecision[];
    discoveries?: string[];
    rejectedAlternatives?: Array<{ family: string; reason: string; total?: number }>;
    outstandingIssues?: Array<{ rule: string; summary: string; severity: string }>;
    now?: () => string;
  },
): DesignDecisionRecord {
  return buildDecisionRecord({
    caseId: fixture.caseId,
    brief: { ...fixture.brief, antiGoals: fixture.brief.antiGoals },
    ...pieces,
  });
}

/* -------------------------------------------------------------------------- */
/* Serialization and persistence                                               */
/* -------------------------------------------------------------------------- */

const RecordSchema = z
  .object({
    schema: z.literal(DECISION_RECORD_SCHEMA),
    caseId: z.string().nullable(),
    recordedAt: z.string().min(1),
    brief: z
      .object({
        screen: z.string().min(1),
        product: z.string().nullable(),
        purpose: z.string().min(1),
        primaryDecision: z.string().min(1),
        primaryAction: z.string().nullable(),
        requiredInformation: z.array(z.string()),
        optionalInformation: z.array(z.string()),
        viewport: z.object({ width: z.number().positive(), height: z.number().positive() }),
        visualDirection: z.string().nullable(),
      })
      .strict(),
    constraints: z.array(z.string()),
    direction: z
      .object({
        composition: z.string().nullable(),
        rationale: z.string().min(1),
        intentStyle: z.string().nullable(),
        intentDensity: z.string().nullable(),
      })
      .strict(),
    skills: z.array(z.object({ id: z.string().min(1), why: z.string().min(1) }).strict()),
    discoveries: z.array(z.string()),
    rejectedAlternatives: z.array(z.object({ family: z.string(), reason: z.string(), total: z.number().optional() }).strict()),
    outstandingIssues: z.array(z.object({ rule: z.string(), summary: z.string(), severity: z.string() }).strict()),
    repairAttempts: z
      .array(
        z
          .object({
            findingIds: z.array(z.string()),
            result: z.string(),
            mutations: z.array(z.object({ kind: z.string(), description: z.string() }).strict()),
            notes: z.array(z.string()),
          })
          .strict(),
      ),
  })
  .strict();

export type ParsedDecisionRecord = z.infer<typeof RecordSchema>;

export function serializeDecisionRecord(record: DesignDecisionRecord): string {
  if (record.schema !== DECISION_RECORD_SCHEMA) {
    throw new Error(`refused: decision record schema must be "${DECISION_RECORD_SCHEMA}", got "${record.schema}"`);
  }
  return JSON.stringify(record, null, 2);
}

/** Parses and validates a record; a record that fails its own schema is refused. */
export function parseDecisionRecord(json: string): ParsedDecisionRecord {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("refused: decision record is not valid JSON");
  }
  const parsed = RecordSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refused: not a ${DECISION_RECORD_SCHEMA} document — ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

/** Writes the record as `<root>/decision-record.json` (or `<root>/<caseId>.json`). */
export async function persistDecisionRecord(root: string, record: DesignDecisionRecord, caseId?: string): Promise<string> {
  const file = resolve(root, caseId && caseId !== record.caseId ? `${caseId}.json` : record.caseId ? `${record.caseId}.json` : "decision-record.json");
  await mkdir(resolve(root), { recursive: true });
  await writeFile(file, serializeDecisionRecord(record), "utf8");
  return file;
}

/** Loads the record persisted next to a run; null when nothing was recorded. */
export async function loadDecisionRecord(root: string, caseId?: string): Promise<ParsedDecisionRecord | null> {
  const file = resolve(root, caseId ? `${caseId}.json` : "decision-record.json");
  let json: string;
  try {
    json = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseDecisionRecord(json);
}

/* -------------------------------------------------------------------------- */
/* The resume drift guard                                                      */
/* -------------------------------------------------------------------------- */

export interface ResumeDrift {
  drifted: boolean;
  reasons: string[];
}

/**
 * Compares a record's recorded direction against the intent a resume produced.
 * Only *manner* fields are compared — style and density are the art direction;
 * geometry may change freely on repair. Drift is a diff, not an error: the
 * caller decides whether the change was intentional or must be corrected.
 */
export function resumeDrift(record: ParsedDecisionRecord, currentIntent: Record<string, unknown> | null | undefined): ResumeDrift {
  const reasons: string[] = [];
  const style = styleManner(currentIntent);
  if ((record.direction.intentStyle ?? null) !== (style ?? null)) {
    reasons.push(`style drifted: recorded '${record.direction.intentStyle ?? "none"}', resume compiled '${style ?? "none"}'`);
  }
  const density = densityOf(currentIntent);
  if ((record.direction.intentDensity ?? null) !== (density ?? null)) {
    reasons.push(`density drifted: recorded '${record.direction.intentDensity ?? "none"}', resume compiled '${density ?? "none"}'`);
  }
  return { drifted: reasons.length > 0, reasons };
}
