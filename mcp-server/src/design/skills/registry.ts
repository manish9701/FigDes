/**
 * The skill registry (issue #22, phase 1).
 *
 * ## Why a registry
 *
 * Skills are discoverable by the selector and auditable by tests only if they
 * live in one place and each one has passed validation on the way in. A skill
 * whose spec does not validate, duplicates an id, or declares an output without
 * a consumer is a documentation error that would otherwise be found in an
 * argument — so the registry rejects it at registration time with the reason.
 */
import {
  SkillSpecSchema,
  type SkillEntry,
  type SkillInput,
  type SkillOutput,
  type SkillSpec,
} from "./contracts";

/**
 * Validates a skill spec, returning the typed spec.
 *
 * @throws {Error} naming the failing field when the spec is not valid, so the
 * author sees exactly which declaration is missing or shapeless.
 */
export function validateSkillSpec(spec: unknown): SkillSpec {
  const parsed = SkillSpecSchema.safeParse(spec);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid skill spec: ${issues}`);
  }
  return parsed.data;
}

/** Registers one skill, validating its spec first. */
export class SkillRegistry {
  private readonly entries = new Map<string, SkillEntry>();

  register(entry: SkillEntry): void {
    const spec = validateSkillSpec(entry.spec);
    if (this.entries.has(spec.id)) {
      throw new Error(`Duplicate skill id '${spec.id}'`);
    }
    this.entries.set(spec.id, entry);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get(id: string): SkillEntry | undefined {
    return this.entries.get(id);
  }

  list(): SkillEntry[] {
    return [...this.entries.values()];
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }
}

/** Creates a registry and registers the given skills (in order). */
export function createSkillRegistry(...entries: SkillEntry[]): SkillRegistry {
  const registry = new SkillRegistry();
  for (const entry of entries) registry.register(entry);
  return registry;
}

/**
 * Runs one skill against an input, catching and reporting a skill bug as a
 * note instead of a thrown error reaching the caller. A skill that fails is a
 * defect in the skill, not in the screen — but the pipeline carrying on with a
 * named, visible gap is better than a generation dying on prose.
 */
export function applySkill(
  entry: SkillEntry,
  input: SkillInput,
): SkillOutput {
  try {
    return entry.apply(input);
  } catch (error) {
    return {
      skill: entry.spec.id,
      decisions: [],
      notes: [`Skill '${entry.spec.id}' failed to run: ${(error as Error).message}. Its decisions were not applied.`],
    };
  }
}
