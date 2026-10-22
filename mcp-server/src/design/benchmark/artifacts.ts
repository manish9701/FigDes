/**
 * Run artifacts and the frozen baseline on disk (issue #22 §4 step 11, §6).
 *
 * §4 step 11: "Persist benchmark artifacts (screenshots, QA output) for
 * debugging and regression." A run that leaves no artifact behind cannot be
 * debugged, cannot be reproduced, and cannot become a baseline; this module
 * is the disk half of the report — the library half (`regression.ts`,
 * `offline-briefs.ts`) already defines what the artifacts contain.
 *
 * Every write is explicit about what it refuses to do: a frozen baseline is
 * never silently overwritten, and a run artifact carries the case's brief,
 * config and evidence together so a case can be reproduced end to end.
 */
import { z } from "zod";
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { BenchmarkResult } from "./suite";
import type { BaselineDocument, OfflineCaseEvidence } from "./regression";
import { parseBaseline, serializeBaseline } from "./regression";
import type { OfflineBrief } from "./offline-briefs";
import type { DesignDecisionRecord } from "../decision-record";
import { DECISION_RECORD_SCHEMA } from "../decision-record";

export const RUN_ARTIFACT_SCHEMA = "figdes-benchmark-run-v1";
export const BASELINE_PATH = "issue22-baseline-v1.json";

/* -------------------------------------------------------------------------- */
/* The run artifact                                                            */
/* -------------------------------------------------------------------------- */

export interface RunArtifact {
  schema: string;
  /** Stable id for the artifact directory, e.g. `2026-05-14_exo-compute-topology`. */
  runId: string;
  caseId: string;
  brief: OfflineBrief;
  /** The recorded pipeline configuration of the run. */
  config: { mode: "plan" | "build"; render: boolean; repairBudget: number; maxRounds: number };
  evidence: OfflineCaseEvidence;
  result: BenchmarkResult;
  decisionRecord: DesignDecisionRecord | null;
  /**
   * Render evidence when one exists. The data URL itself is written beside
   * `run.json` as an image file, never re-embedded in JSON; the artifact
   * records only what the render proved (`note`, `revisionId`, `file`).
   */
  render: { dataUrl?: string; revisionId: string | null; note: string | null } | null;
}

const RenderInfoSchema = z
  .object({
    revisionId: z.string().nullable(),
    note: z.string().nullable(),
    /** Image file persisted beside run.json, when a render proved one. */
    file: z.string().nullable().optional(),
  })
  .strict();

const RunArtifactSchema = z
  .object({
    schema: z.literal(RUN_ARTIFACT_SCHEMA),
    runId: z.string().min(1),
    caseId: z.string().min(1),
    brief: z.object({ screen: z.string().min(1), product: z.string(), purpose: z.string().min(1) }).passthrough(),
    config: z
      .object({
        mode: z.enum(["plan", "build"]),
        render: z.boolean(),
        repairBudget: z.number().int().min(0).max(5),
        maxRounds: z.number().int().min(1).max(3),
      })
      .strict(),
    evidence: z.any().refine((v) => v !== null && typeof v === "object", "evidence object required"),
    result: z.any().refine((v) => v !== null && typeof v === "object", "result object required"),
    decisionRecord: z
      .object({ schema: z.literal(DECISION_RECORD_SCHEMA) })
      .passthrough()
      .nullable(),
    render: RenderInfoSchema.nullable(),
  })
  .strict();

export function serializeRunArtifact(artifact: RunArtifact): string {
  if (artifact.schema !== RUN_ARTIFACT_SCHEMA) {
    throw new Error(`refused: run artifact schema must be "${RUN_ARTIFACT_SCHEMA}", got "${artifact.schema}"`);
  }
  return JSON.stringify(artifact, null, 2);
}

/**
 * Decodes a `data:image/...;base64,...` URL into bytes. A render whose URL is
 * not a recognized base64 data URL is refused, not guessed at.
 */
export function renderFromDataUrl(dataUrl: string): { bytes: Buffer; ext: string } | null {
  const match = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(dataUrl);
  if (!match || match[2] === undefined || match[1] === undefined) return null;
  return { bytes: Buffer.from(match[2], "base64"), ext: match[1] };
}

/** Strips the data URL from the render info for JSON storage. */
function renderJson(render: RunArtifact["render"], root: string): z.infer<typeof RenderInfoSchema> | null {
  if (!render) return null;
  const decoded = render.dataUrl ? renderFromDataUrl(render.dataUrl) : null;
  return {
    revisionId: render.revisionId ?? null,
    note: render.note ?? null,
    ...(decoded !== null ? { file: `render.${decoded.ext}` } : {}),
  };
}

/**
 * Persists a run artifact to `<root>/<runId>/` as `run.json`, plus `render.png`
 * (or `.jpeg`) when the artifact carries a decodable data URL. A render that
 * cannot be decoded is recorded as `render-decode-refused.txt` — evidence of a
 * broken render path, never silently omitted. Returns the files written.
 */
export async function persistRunArtifact(root: string, artifact: RunArtifact): Promise<string[]> {
  const dir = resolve(root, artifact.runId);
  await mkdir(dir, { recursive: true });
  const files: string[] = [];
  const runFile = resolve(dir, "run.json");
  const { render, ...rest } = artifact;
  await writeFile(runFile, JSON.stringify({ ...rest, render: renderJson(render, root) }, null, 2), "utf8");
  files.push(runFile);
  if (render?.dataUrl) {
    const decoded = renderFromDataUrl(render.dataUrl);
    if (decoded === null) {
      const refused = resolve(dir, "render-decode-refused.txt");
      await writeFile(refused, render.dataUrl.slice(0, 512), "utf8");
      files.push(refused);
    } else {
      const renderFile = resolve(dir, `render.${decoded.ext}`);
      await writeFile(renderFile, decoded.bytes);
      files.push(renderFile);
    }
  }
  return files;
}

/** Loads one run artifact; null when absent, refused when malformed. */
export async function loadRunArtifact(root: string, runId: string): Promise<RunArtifact | null> {
  const file = resolve(root, runId, "run.json");
  let json: string;
  try {
    json = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return parseRunArtifact(json);
}

export function parseRunArtifact(json: string): RunArtifact {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error("refused: run artifact is not valid JSON");
  }
  const parsed = RunArtifactSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `refused: not a ${RUN_ARTIFACT_SCHEMA} artifact — ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data as unknown as RunArtifact;
}

/* -------------------------------------------------------------------------- */
/* The frozen baseline                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Writes the baseline to `<root>/<BASELINE_PATH>`. A baseline exists to be the
 * fixed reference a candidate is *gated against*; overwriting it on every run
 * would quietly move the bar. The freeze therefore refuses to replace an
 * existing baseline unless `force: true` is explicit in the calling context.
 */
export async function freezeBaseline(root: string, document: BaselineDocument, force: boolean): Promise<string> {
  const file = resolve(root, BASELINE_PATH);
  let exists = false;
  try {
    exists = (await stat(file)).isFile();
  } catch {
    exists = false;
  }
  if (exists && !force) {
    const recorded = parseBaseline(await readFile(file, "utf8"));
    throw new Error(
      `refused: a frozen baseline already exists at ${file} (suite '${recorded.suite}', recorded ${recorded.recordedAt}). Re-freeze requires force and a deliberate reason.`,
    );
  }
  await mkdir(root, { recursive: true });
  await writeFile(file, serializeBaseline(document), "utf8");
  return file;
}

/** Loads the frozen baseline from `<root>/<BASELINE_PATH>`; null when absent. */
export async function loadFrozenBaseline(root: string): Promise<{ doc: BaselineDocument; path: string } | null> {
  const file = resolve(root, BASELINE_PATH);
  let json: string;
  try {
    json = await readFile(file, "utf8");
  } catch {
    return null;
  }
  return { doc: parseBaseline(json), path: file };
}
