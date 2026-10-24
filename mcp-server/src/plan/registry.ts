/**
 * The plan registry (issue #29).
 *
 * ## Why a registry
 *
 * The design-intelligence gates used to trust what the *calling model*
 * asserted about its own provenance: `fromPlan:true` or
 * `intelligenceApplied:true` in the args was accepted as proof that design
 * intelligence ran. That is self-report, not provenance — a weaker client
 * that skipped plan_screen set the flag and sailed through, and every gate
 * downstream saw "applied".
 *
 * This module is the fix: the server itself remembers every plan it issues.
 * `plan_screen` (and any other planning tool) registers the plan here and
 * stamps the returned `planId` on the payload and into its program skeleton,
 * so the id travels with the build even when the model only copies the
 * program across. Build tools then treat provenance as something that must
 * RESOLVE — a `planId` that matches nothing the server issued is precisely
 * what a model invents when it skipped plan_screen, so it fails closed.
 *
 * In-memory and bounded, like the approval ledger: plans live for the
 * session, old ones fall off, and tests can start from a clean registry.
 */

import { createHash } from "node:crypto";

export interface RegisteredPlan {
  planId: string;
  /** The file the plan was issued for, when the planning tool had a session. */
  fileKey: string | null;
  fileName: string | null;
  /** The primary decision the plan classified. */
  primaryDecision: string;
  issuedAt: number;
  /** Digest of the issued program skeleton, for audit comparison. */
  programHash: string;
  /**
   * The issued program skeleton itself (issue #30, workflow contract).
   *
   * A planId used to prove only that A plan ran; the build got nothing from it
   * and the caller had to re-state every region, style and constraint — the
   * exact "context loss" the workflow handoff was blamed for. Now the
   * registration retains the issued skeleton, so a build that carries ONLY the
   * planId can inherit the plan for real instead of wearing it as a badge.
   */
  program: unknown;
  /** The whole plan payload the planning tool returned, when it had one. */
  plan: unknown;
}

const MAX_PLANS = 200;

/**
 * The store is process-global, not module-global.
 *
 * The server is built two ways: one bundle from src/index.ts (the real
 * server), and per-area bundles under dist-test for the test suites. A
 * module-level Map would be duplicated per bundle, and then a plan
 * registered by the plan bundle would resolve to nothing in the tools
 * bundle — the gate would fail closed for planned builds, the exact inverse
 * of its purpose. A symbol-keyed global keeps one registry per process
 * whichever bundle imports this module.
 */
const REGISTRY_KEY = Symbol.for("figdes.planRegistry");
const store = globalThis as { [REGISTRY_KEY]?: Map<string, RegisteredPlan> };
const issued: Map<string, RegisteredPlan> = (store[REGISTRY_KEY] ??= new Map());
let seq = 0;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether an inlined value has the shape a real `plan_screen` payload has.
 *
 * Every payload buildPlan returns carries a `program` record (the build
 * skeleton) and an `intelligence` record whose `applied` is true (the
 * classification receipt). A bare object like `{ decision: "show status" }`
 * — what a model improvises when it skipped plan_screen — does not pass,
 * so "an inline plan" can no longer stand in for "a plan ran".
 */
export function isPlanShaped(plan: unknown): boolean {
  if (!isRecord(plan)) return false;
  return (
    isRecord(plan["program"]) &&
    isRecord(plan["intelligence"]) &&
    plan["intelligence"]["applied"] === true
  );
}

function hashProgram(program: unknown): string {
  try {
    return createHash("sha1").update(JSON.stringify(program ?? null)).digest("hex");
  } catch {
    return "unhashable";
  }
}

/**
 * Registers a plan the server just issued and returns its registration.
 * The returned `planId` is unguessable and stamped on the plan_screen
 * payload; build tools accept it as the build's provenance.
 */
export function registerPlan(
  payload: { fileKey?: string | null; fileName?: string | null; primaryDecision?: string; program?: unknown; plan?: unknown } = {},
): RegisteredPlan {
  seq += 1;
  const plan: RegisteredPlan = {
    planId: `plan-${Date.now().toString(36)}-${seq.toString(36).padStart(3, "0")}-${Math.random().toString(36).slice(2, 6)}`,
    fileKey: payload.fileKey ?? null,
    fileName: payload.fileName ?? null,
    primaryDecision: payload.primaryDecision ?? "",
    issuedAt: Date.now(),
    programHash: hashProgram(payload.program),
    program: payload.program ?? null,
    plan: payload.plan ?? null,
  };
  issued.set(plan.planId, plan);
  // Bounded: drop the oldest quarter when over capacity so a long-lived
  // server cannot grow without bound.
  if (issued.size > MAX_PLANS) {
    const oldest = [...issued.values()]
      .sort((a, b) => a.issuedAt - b.issuedAt)
      .slice(0, Math.floor(MAX_PLANS / 4));
    for (const p of oldest) issued.delete(p.planId);
  }
  return plan;
}

/**
 * Resolves a plan reference to a plan the server actually issued.
 *
 * When both sides know the file, they must agree: a plan issued for one
 * file does not prove provenance for a build in another. Returns null for
 * every invented id — fail closed.
 */
export function resolvePlan(planId: string, fileKey?: string | null): RegisteredPlan | null {
  const plan = issued.get(planId);
  if (!plan) return null;
  if (fileKey !== undefined && fileKey !== null && plan.fileKey !== null && plan.fileKey !== fileKey) {
    return null;
  }
  return plan;
}

/** How many plans the registry currently holds (for figma_status/metrics). */
export function planRegistrySize(): number {
  return issued.size;
}

/** Exposed so tests can start from a clean registry. */
export function resetPlanRegistry(): void {
  issued.clear();
  seq = 0;
}
