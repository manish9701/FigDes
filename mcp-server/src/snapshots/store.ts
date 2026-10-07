/**
 * Persistent design checkpoints (FigDes §31).
 *
 * ## What a snapshot is and is not
 *
 * A snapshot records a version of a screen: its program, composition, score
 * and findings, timestamped. It enables V1/V2/V3 comparison without relying on
 * anyone's memory of what V1 looked like.
 *
 * It is not Figma version history and does not pretend to be: restoring means
 * rebuilding from the stored program (idempotent by construction), not rolling
 * back the document. The document's own history remains Figma's job.
 *
 * Stored as JSON beside the project, like memory, for the same reasons: human-
 * readable, diffable, and impossible to lose to a crashed write (temp file
 * plus rename, same as the memory store).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

export const SnapshotEntrySchema = z
  .object({
    version: z.number().int().min(1),
    at: z.string(),
    screen: z.string().min(1).max(200),
    composition: z.string().max(60).optional(),
    overall: z.number().min(0).max(10).optional(),
    findings: z.number().int().min(0).optional(),
    note: z.string().max(500).optional(),
    /** The program that built this version. Rebuild, don't reminisce. */
    program: z.unknown().optional(),
  })
  .strict();

export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

const SnapshotFileSchema = z.object({
  version: z.literal(1).default(1),
  project: z.string(),
  updatedAt: z.string(),
  snapshots: z.array(SnapshotEntrySchema).max(100).default([]),
});

export const SNAPSHOT_DIR = resolve(process.env.DESIGN_AGENT_SNAPSHOT_DIR ?? process.cwd(), process.env.DESIGN_AGENT_SNAPSHOT_DIR ? "" : ".snapshots");

function pathFor(key: string): string {
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`Refusing to use an unsafe project key: ${key}`);
  return join(SNAPSHOT_DIR, `${key}.json`);
}

function load(key: string): { project: string; updatedAt: string; snapshots: SnapshotEntry[] } {
  const file = pathFor(key);
  if (!existsSync(file)) {
    return { project: key, updatedAt: new Date().toISOString(), snapshots: [] };
  }
  try {
    const parsed = SnapshotFileSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    if (parsed.success) return { project: parsed.data.project, updatedAt: parsed.data.updatedAt, snapshots: parsed.data.snapshots };
  } catch {
    /* fall through to empty */
  }
  return { project: key, updatedAt: new Date().toISOString(), snapshots: [] };
}

function save(key: string, data: { project: string; updatedAt: string; snapshots: SnapshotEntry[] }): string {
  const file = pathFor(key);
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...data, version: 1 }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
  return file;
}

export interface SaveSnapshotInput {
  screen: string;
  composition?: string;
  overall?: number;
  findings?: number;
  note?: string;
  program?: unknown;
}

/** Records a new version. Versions count up per project and are never reused. */
export function saveSnapshot(key: string, input: SaveSnapshotInput): { entry: SnapshotEntry; file: string } {
  const current = load(key);
  const version = current.snapshots.length > 0 ? Math.max(...current.snapshots.map((s) => s.version)) + 1 : 1;
  const parsed = SnapshotEntrySchema.parse({
    version,
    at: new Date().toISOString(),
    screen: input.screen,
    ...(input.composition !== undefined ? { composition: input.composition } : {}),
    ...(input.overall !== undefined ? { overall: input.overall } : {}),
    ...(input.findings !== undefined ? { findings: input.findings } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.program !== undefined ? { program: input.program } : {}),
  });

  const next = [...current.snapshots, parsed].slice(-100);
  const file = save(key, { project: key, updatedAt: new Date().toISOString(), snapshots: next });
  return { entry: parsed, file };
}

/** Lists versions newest-first, without programs (those are fetched per version). */
export function listSnapshots(key: string): Array<Omit<SnapshotEntry, "program"> & { hasProgram: boolean }> {
  return load(key)
    .snapshots.slice()
    .reverse()
    .map(({ program: _program, ...rest }) => ({ ...rest, hasProgram: _program !== undefined }));
}

/** Fetches one version in full, including its program. */
export function getSnapshot(key: string, version: number): SnapshotEntry | null {
  return load(key).snapshots.find((s) => s.version === version) ?? null;
}
