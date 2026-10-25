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
 *
 * Issue #30 wires the pipeline itself to both edges: the persist hook fires
 * at the pipeline's final report stage, and every re-entry reads the record
 * back for the file before working (see the pipeline store section below).
 */
import { z } from "zod";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

/**
 * The pipeline's decision-record store (issue #30).
 *
 * A record the pipeline never writes, and a repair path that never reads one
 * back, is not durable — until issue #30 the record existed only as a
 * benchmark artifact. This is the disk contract the pipeline's persist hook
 * (final report stage) and read-back consumer (every re-entry) sit on,
 * following the conventions the durable stores here already follow
 * (`memory/store.ts`, `snapshots/store.ts`):
 *
 * - the directory is overridable the way DESIGN_AGENT_MEMORY_DIR and
 *   DESIGN_AGENT_SNAPSHOT_DIR are, so tests stay hermetic and the store can
 *   be repointed per run;
 * - writes are temp-then-rename: a rename is atomic on NTFS and POSIX, so a
 *   crash mid-write leaves the previous record intact rather than a
 *   truncated file that fails to parse on the next load;
 * - the filename key is guarded. A file identity may be anything, and a key
 *   that names a path is a key that writes outside the store — the same
 *   belt-and-braces guard memory/store.ts's `pathFor` applies.
 */
export const DECISION_RECORD_DIR_ENV = "DESIGN_AGENT_DECISION_RECORD_DIR";

/**
 * Where runs persist decision records, resolved at call time (not import
 * time) so an orchestrator or a test can repoint the store for its own run —
 * the same override contract DESIGN_AGENT_MEMORY_DIR gives project memory.
 *
 * The default is `<cwd>/artifacts/decision-records/`: under the artifacts
 * path the benchmark's records already live in, but NOT inside the
 * benchmark's committed `artifacts/benchmark/decision-records/` directory —
 * those `<caseId>.json` files are a committed fixture the issue-22 runner
 * and gate own, and runtime records overwriting them would rewrite history
 * nobody re-froze.
 */
export function decisionRecordStoreDir(): string {
  const override = process.env[DECISION_RECORD_DIR_ENV];
  if (typeof override === "string" && override.trim().length > 0) return resolve(override.trim());
  return resolve(process.cwd(), "artifacts", "decision-records");
}

/** A record's key must be slug-safe before it becomes a filename. */
function assertRecordKey(key: string | undefined): void {
  if (key !== undefined && !/^[A-Za-z0-9._-]+$/.test(key)) {
    throw new Error(`refused: decision record key '${key}' is not filename-safe`);
  }
}

/** Writes the record as `<root>/decision-record.json` (or `<root>/<key>.json`), atomically. */
export async function persistDecisionRecord(root: string, record: DesignDecisionRecord, caseId?: string): Promise<string> {
  const key = caseId ?? record.caseId ?? "decision-record";
  assertRecordKey(key);
  const file = resolve(root, `${key}.json`);
  await mkdir(resolve(root), { recursive: true });
  const temp = `${file}.tmp`;
  await writeFile(temp, serializeDecisionRecord(record), "utf8");
  await rename(temp, file);
  return file;
}

/** Loads the record persisted next to a run; null when nothing was recorded. */
export async function loadDecisionRecord(root: string, caseId?: string): Promise<ParsedDecisionRecord | null> {
  assertRecordKey(caseId);
  const file = resolve(root, caseId ? `${caseId}.json` : "decision-record.json");
  let json: string;
  try {
    json = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseDecisionRecord(json);
}

/**
 * Reads the record the pipeline persisted for a file's identity (issue #30)
 * — the read-back half of the repair/resume path. Never throws: a missing
 * file is the ordinary no-record case, and a corrupt one degrades to a
 * problem note the way memory/store.ts's loadMemory degrades, because
 * refusing to repair because of a stray comma is the wrong trade.
 */
export async function loadDecisionRecordForFile(
  fileKey: string,
): Promise<{ record: ParsedDecisionRecord | null; dir: string; file: string; problem?: string }> {
  const dir = decisionRecordStoreDir();
  const file = resolve(dir, `${fileKey}.json`);
  try {
    assertRecordKey(fileKey);
  } catch (err) {
    return { record: null, dir, file, problem: err instanceof Error ? err.message : String(err) };
  }
  let json: string;
  try {
    json = await readFile(file, "utf8");
  } catch {
    return { record: null, dir, file }; // absent is the expected no-record case
  }
  try {
    return { record: parseDecisionRecord(json), dir, file };
  } catch (err) {
    return {
      record: null,
      dir,
      file,
      problem: `The decision record at ${file} could not be parsed (${err instanceof Error ? err.message : String(err)}); it was left untouched, and this run starts from the brief alone.`,
    };
  }
}

/**
 * Persists the pipeline's record for a file's identity (issue #30) — the
 * hook half. Best effort by contract: a persistence problem comes back as a
 * note on the payload, never as a throw, because a durable note must not
 * fail the build that produced it.
 */
export async function persistDecisionRecordForFile(
  fileKey: string,
  record: DesignDecisionRecord,
): Promise<{ file: string | null; problem?: string }> {
  const dir = decisionRecordStoreDir();
  try {
    assertRecordKey(fileKey);
    const file = await persistDecisionRecord(dir, record, fileKey);
    return { file };
  } catch (err) {
    return { file: null, problem: err instanceof Error ? err.message : String(err) };
  }
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
