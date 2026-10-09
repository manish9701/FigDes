/**
 * Revision-bound evidence spine (blueprint §9, §16).
 *
 * The blueprint's hardest rule is "verify the exact final revision": a
 * screenshot only proves the state it depicted, and any mutation afterwards
 * invalidates that proof. The repository already *compares* revisions in
 * `final-gate.ts`, but nothing ever computed one, so the comparison was dead
 * code in practice.
 *
 * This module supplies the missing primitives:
 *
 *   1. `contentRevision` — deterministic fingerprint of a program/IR/operation
 *      list. Stable across key ordering, sensitive to every value.
 *   2. `EVALUATOR_VERSION` — bumps whenever a critic/rule changes meaning, so a
 *      cached or reused result can never outlive the evaluator that made it.
 *   3. `RenderEvidence` — the full freshness record the blueprint requires
 *      (file, frame, viewport, revision, timestamp, evaluator version, token
 *      snapshot, artifact hashes).
 *   4. `evaluateFreshness` — turns that record into an explicit dimension
 *      status. Pending evidence stays PENDING; it never becomes a pass.
 *
 * Pure and dependency-free so it is usable from the offline planner, the
 * live loop and the test harness alike.
 */

/**
 * Version of the critique/QA semantics in this build. Bump when a rule,
 * weight or severity meaning changes. Anything cached or compared across
 * versions must be discarded.
 */
export const EVALUATOR_VERSION = "figdes-evaluator-1";

/* -------------------------------------------------------------------------- */
/* Content fingerprint                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Canonical JSON: object keys sorted, undefined dropped, functions rejected.
 * Two structurally equal payloads always produce the same string, which is
 * what makes the fingerprint a *content* identity rather than a code identity.
 */
export function canonicalize(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "number") return Number.isFinite(v as number) ? JSON.stringify(v) : `"[nonfinite:${String(v)}]"`;
    if (t === "string" || t === "boolean") return JSON.stringify(v);
    if (t === "undefined" || t === "function" || t === "symbol") return "null";
    if (Array.isArray(v)) return `[${v.map(walk).join(",")}]`;
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '"[circular]"';
    seen.add(obj);
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const key of keys) {
      if (obj[key] === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${walk(obj[key])}`);
    }
    seen.delete(obj);
    return `{${parts.join(",")}}`;
  };
  return walk(value);
}

/** 128-bit FNV-1a over the canonical form. No crypto dependency. */
export function hashContent(text: string): string {
  const prime = 0x01000193;
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, prime) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/** Deterministic revision id for any design payload (program, IR, ops, tree). */
export function contentRevision(payload: unknown, prefix = "rev"): string {
  return `${prefix}-${hashContent(canonicalize(payload))}`;
}

/* -------------------------------------------------------------------------- */
/* Render evidence                                                              */
/* -------------------------------------------------------------------------- */

export interface RenderEvidenceRecord {
  /** Figma file identity — which document this proof belongs to. */
  fileKey?: string;
  fileName?: string;
  pageId?: string;
  /** Exact frame that was rendered. */
  frameId: string;
  viewport: { width: number; height: number };
  /** Native (unscaled) size actually rendered. */
  nativeSize?: { width: number; height: number };
  /** Content fingerprint of what was rendered. */
  revisionId: string;
  renderedAt: number;
  evaluatorVersion: string;
  /** Design-system / token snapshot in force, when known. */
  tokenSnapshot?: string;
  /** Digest of the exported screenshot, so the image is identifiable. */
  screenshotHash?: string;
  screenshotReference?: string;
  /** Operator/model that inspected the image. Absent means nobody looked. */
  inspectedBy?: string;
}

/** True when every element of the record a freshness claim depends on exists. */
export function isCompleteEvidence(e: RenderEvidenceRecord | null | undefined): e is RenderEvidenceRecord {
  if (!e) return false;
  return (
    typeof e.frameId === "string" && e.frameId.length > 0 &&
    typeof e.revisionId === "string" && e.revisionId.length > 0 &&
    typeof e.renderedAt === "number" && Number.isFinite(e.renderedAt) &&
    typeof e.evaluatorVersion === "string" && e.evaluatorVersion.length > 0 &&
    !!e.viewport && Number.isFinite(e.viewport.width) && Number.isFinite(e.viewport.height)
  );
}

export type FreshnessStatus = "PASS" | "FAIL" | "PENDING";

export interface FreshnessVerdict {
  status: FreshnessStatus;
  reasons: string[];
  /** Things a reader should know were never captured. */
  limitations: string[];
}

/**
 * Freshness policy (blueprint §9):
 * - no evidence at all            → PENDING (never FAIL-by-omission, never PASS)
 * - incomplete evidence           → FAIL (a proof you cannot reconstruct)
 * - evidence revision ≠ judged revision → FAIL (stale screenshot)
 * - evaluator version drift       → FAIL (the rules changed under the evidence)
 * - otherwise                     → PASS, with optional soft limitations
 */
export function evaluateFreshness(input: {
  evidence?: RenderEvidenceRecord | null;
  /** Revision the gate is judging right now. */
  expectedRevision?: string | null;
  /** Mutations applied after the last render. Any entry ⇒ not the final state. */
  postRenderMutations?: string[];
}): FreshnessVerdict {
  const limitations: string[] = [];
  if (!input.evidence) {
    return {
      status: "PENDING",
      reasons: ["No render evidence: the final revision has not been rendered or inspected."],
      limitations: ["Screenshot, viewport and frame identity are all unverified."],
    };
  }
  const reasons: string[] = [];
  const e = input.evidence;
  if (!e.frameId) reasons.push("Render evidence carries no frame identity.");
  if (!e.viewport || !Number.isFinite(e.viewport.width) || !Number.isFinite(e.viewport.height)) {
    reasons.push("Render evidence carries no viewport.");
  }
  if (!e.revisionId) reasons.push("Render evidence carries no content revision.");
  if (typeof e.renderedAt !== "number" || !Number.isFinite(e.renderedAt)) {
    reasons.push("Render evidence carries no timestamp.");
  }
  if (reasons.length > 0) {
    return { status: "FAIL", reasons, limitations };
  }
  if (e.evaluatorVersion !== EVALUATOR_VERSION) {
    reasons.push(
      `Evaluator version drift: evidence was produced by "${e.evaluatorVersion}", this build is "${EVALUATOR_VERSION}". Re-render.`,
    );
  }
  const expected = input.expectedRevision;
  if (expected !== undefined && expected !== null && expected !== "" && e.revisionId !== expected) {
    reasons.push(`Stale screenshot: evidence revision "${e.revisionId}" does not match the judged revision "${expected}".`);
  }
  const mutations = input.postRenderMutations ?? [];
  if (mutations.length > 0) {
    reasons.push(
      `${mutations.length} mutation(s) applied after the last render (${mutations.slice(0, 3).join("; ")}${mutations.length > 3 ? "; …" : ""}). The screenshot no longer depicts the final revision.`,
    );
  }
  if (reasons.length > 0) return { status: "FAIL", reasons, limitations };

  if (!e.screenshotHash) limitations.push("Screenshot has no content hash; the image cannot be proven identical to the one reviewed.");
  if (!e.fileKey) limitations.push("No Figma file identity attached to the render evidence.");
  if (!e.inspectedBy) limitations.push("Nobody is recorded as having inspected the rendered image.");
  if (!e.tokenSnapshot) limitations.push("No design-system token snapshot recorded for this render.");
  return { status: "PASS", reasons: [`Fresh: revision ${e.revisionId} rendered ${new Date(e.renderedAt).toISOString()} and not mutated since.`], limitations };
}
