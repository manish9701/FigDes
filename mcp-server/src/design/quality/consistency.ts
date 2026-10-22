/**
 * Evidence-backed consistency scoring (quality-reliability P1).
 *
 * Separate measure, documented scale: 0–100 from token reuse, type-scale
 * discipline, radius/border/fill/spacing consistency, component repetition,
 * and repair-introduced drift. Critical blockers (unknown-token fills that
 * break the palette) fail outright and never average away.
 *
 * Issue #23 §5 adds the blocking/warning rules around tokens: a one-off
 * colour — a fill matching no discovered token that perceptually
 * near-duplicates a colour already in use — blocks; near-duplicate tokens
 * (same emphasis role, values within a step of each other) warn with
 * consolidation operations; stroke and spacing join radius and family as
 * measured dimensions. When no token system is discovered, the token-driven
 * checks report `notEvaluated` rather than failing.
 *
 * This does NOT change existing gates or weights — it is the explicit
 * consistency dimension the plan asks for, consumed by reports and the live
 * evidence pack. Weights stay pinned until multiple screens are independently
 * human-rated; see SCORECARD_DOCS in benchmark/suite.ts.
 */
import { makeFinding, type DesignFinding } from "./finding";
import { parseHex } from "../../../../shared/contrast";

/** The discovered token/design-system state the token-driven checks read. */
export interface ConsistencyTokenSystem {
  /** Token colours, with the semantic (emphasis) role each one serves. */
  colors?: Array<{ name: string; role?: string; value: string }>;
  radii?: number[];
  spacing?: number[];
  strokeWidths?: number[];
  typeSizes?: number[];
}

export interface ConsistencyInputs {
  /** Fills observed on the screen (hex, lowercased or not). */
  fills: string[];
  /** Approved token fills; anything else is unapproved. */
  approvedTokens?: string[];
  /** Corner radii observed. */
  radii?: number[];
  /** Font families observed. */
  families?: string[];
  /** True when a repair pass introduced fills outside the approved set. */
  repairIntroducedUnknown?: boolean;
  /** Repeated component/instance count (reuse signal). */
  repeatedComponents?: number;
  /** Stroke weights observed on the screen. */
  strokes?: number[];
  /** Spacing values observed between elements. */
  spacingSteps?: number[];
  /**
   * The discovered token system (issue #23 §5). Present (or a non-empty
   * approved set) ⇒ the one-off-colour and near-duplicate-token checks run;
   * absent ⇒ `tokenCheck: "not-evaluated"` — no token system, no verdict.
   */
  tokenSystem?: ConsistencyTokenSystem | null;
  /** The revision the fills were measured on, for revision-bound evidence. */
  revisionId?: string;
}

export interface ConsistencyReport {
  /** 0–100. */
  score: number;
  blocking: boolean;
  evidence: string[];
  /** The blocking/warning rules of issue #23 §5, in the canonical shape. */
  findings: DesignFinding[];
  /** Whether the token-driven checks were evaluated at all. */
  tokenCheck: "evaluated" | "not-evaluated";
}

/** Redmean colour distance, normalised to ~0..1; small = perceptually close. */
export function colourDistance(a: string, b: string): number | null {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return null;
  const ar = ca.r * 255;
  const ag = ca.g * 255;
  const ab = ca.b * 255;
  const br = cb.r * 255;
  const bg = cb.g * 255;
  const bb = cb.b * 255;
  const rMean = (ar + br) / 2 / 255;
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return Math.sqrt((2 + rMean) * dr * dr + 4 * dg * dg + (3 - rMean) * db * db) / 765;
}

/**
 * One-off threshold: ~Δ22 on the widest channel pair, i.e. near-clones of a
 * colour already in use fire; genuinely different hues do not.
 */
export const ONE_OFF_MAX_DISTANCE = 0.04;
/** Near-duplicate token deltas: two tokens inside these deltas should consolidate. */
export const NEAR_DUPLICATE_RADIUS_PX = 1;
export const NEAR_DUPLICATE_SPACING_PX = 2;
export const NEAR_DUPLICATE_STROKE_PX = 0.5;
export const NEAR_DUPLICATE_TYPE_PX = 1;

function nearPairs(values: number[], maxDelta: number): Array<[number, number]> {
  const sorted = [...values].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b - a > maxDelta) break;
      out.push([a, b]);
    }
  }
  return out;
}

export function evaluateConsistency(input: ConsistencyInputs): ConsistencyReport {
  const evidence: string[] = [];
  const findings: DesignFinding[] = [];
  let score = 100;
  const approved = new Set((input.approvedTokens ?? []).map((t) => t.toLowerCase()));
  const tokenColors = (input.tokenSystem?.colors ?? []).map((c) => ({ ...c, value: c.value.toLowerCase() }));
  const revisionId = input.revisionId ?? "";

  /** Either channel carrying colours means a token system was discovered. */
  const tokenCheck: ConsistencyReport["tokenCheck"] =
    approved.size > 0 || input.tokenSystem ? "evaluated" : "not-evaluated";

  const distinct = new Set(input.fills.map((f) => f.toLowerCase()));
  if (distinct.size > 12) {
    score -= 20;
    evidence.push(`${distinct.size} distinct fills: rainbow, not a palette`);
  } else if (distinct.size > 8) {
    score -= 10;
    evidence.push(`${distinct.size} distinct fills; consolidate toward tokens`);
  } else {
    evidence.push(`${distinct.size} distinct fills within budget`);
  }

  const unknown = [...distinct].filter((f) => approved.size > 0 && !approved.has(f));
  if (approved.size > 0 && unknown.length > 0) {
    score -= Math.min(25, unknown.length * 5);
    evidence.push(`${unknown.length} fill(s) outside the approved set: ${unknown.slice(0, 6).join(", ")}`);
  }

  /* -- One-off colour (issue #23 §5, blocking) ------------------------------ */
  // An explicit fill that matches no discovered token and perceptually
  // near-duplicates a colour already in use is a one-off: the design already
  // owns that colour as a token, so the hardcoded copy blocks. Near-matching
  // another *unapproved* in-use colour names no canonical side, so it stays
  // with the existing unapproved-fill penalty instead of a veto.
  const oneOffs: string[] = [];
  if (tokenCheck === "evaluated") {
    const tokenValues = new Set<string>([...approved, ...tokenColors.map((c) => c.value)]);
    const unapproved = [...distinct].filter((f) => !tokenValues.has(f));
    for (const f of unapproved) {
      let nearest: { colour: string; distance: number; isToken: boolean } | null = null;
      for (const ref of [...distinct, ...tokenValues]) {
        if (ref === f) continue;
        const d = colourDistance(f, ref);
        if (d === null || d > ONE_OFF_MAX_DISTANCE) continue;
        if (!nearest || d < nearest.distance) nearest = { colour: ref, distance: d, isToken: tokenValues.has(ref) };
      }
      if (nearest && nearest.isToken) oneOffs.push(f);
    }
  }
  if (oneOffs.length > 0) {
    score -= 15;
    evidence.push(`BLOCKING: ${oneOffs.length} one-off fill(s) near-duplicating a token colour: ${oneOffs.slice(0, 6).join(", ")}`);
    findings.push(
      makeFinding({
        ruleId: "consistency.one-off-color",
        category: "consistency",
        severity: "critical",
        confidence: 0.85,
        summary: `${oneOffs.length} one-off fill(s) (${oneOffs.slice(0, 4).join(", ")}) within a perceptual step of an approved token colour`,
        rationale:
          "A fill that matches no discovered token but near-duplicates a colour the design already tokenises is a one-off: the palette owns this colour, so a hardcoded copy blocks. No token system was discovered would have meant not-evaluated — one was, so this is a verdict.",
        evidence: [
          { type: "token", revisionId, reference: oneOffs[0]!, details: `one-off fills: ${oneOffs.join(", ")}; redmean distance ≤ ${ONE_OFF_MAX_DISTANCE} to a token colour` },
        ],
        suggestedFix: "Bind the fill to the token variable it duplicates instead of a raw hex value.",
        verification: "Re-run the consistency scan on the updated fills; the one-off must no longer appear.",
      }),
    );
  }

  if (tokenCheck === "not-evaluated") {
    evidence.push("token consistency not evaluated: no token system was discovered, so the one-off/near-duplicate checks did not run");
  }

  /* -- Near-duplicate tokens (issue #23 §5, warns + consolidation ops) ------- */
  const duplicateEvidence: string[] = [];
  const duplicateOps: Array<Record<string, unknown>> = [];
  if (input.tokenSystem) {
    const byRole = new Map<string, Array<{ name: string; value: string }>>();
    for (const c of tokenColors) {
      const role = c.role ?? "unroled";
      const list = byRole.get(role) ?? [];
      list.push(c);
      byRole.set(role, list);
    }
    for (const [role, entries] of byRole) {
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i]!;
          const b = entries[j]!;
          const d = colourDistance(a.value, b.value);
          if (d === null || d > ONE_OFF_MAX_DISTANCE) continue;
          duplicateEvidence.push(`colour role '${role}': ${a.name} ≈ ${b.name} (distance ${d.toFixed(3)})`);
          duplicateOps.push({ op: "consolidate-token", variable: b.name, into: a.name, basis: `same role '${role}', colour distance ${d.toFixed(3)}` });
        }
      }
    }
    const scalarChecks: Array<{ label: string; values: number[]; delta: number; unit: string }> = [
      { label: "radius", values: input.tokenSystem.radii ?? [], delta: NEAR_DUPLICATE_RADIUS_PX, unit: "px" },
      { label: "spacing", values: input.tokenSystem.spacing ?? [], delta: NEAR_DUPLICATE_SPACING_PX, unit: "px" },
      { label: "stroke", values: input.tokenSystem.strokeWidths ?? [], delta: NEAR_DUPLICATE_STROKE_PX, unit: "px" },
      { label: "type size", values: input.tokenSystem.typeSizes ?? [], delta: NEAR_DUPLICATE_TYPE_PX, unit: "px" },
    ];
    for (const check of scalarChecks) {
      for (const [a, b] of nearPairs(check.values, check.delta)) {
        if (a === b) continue;
        duplicateEvidence.push(`${check.label}: ${a}${check.unit} ≈ ${b}${check.unit} (delta ${b - a}${check.unit})`);
        duplicateOps.push({ op: "consolidate-token", values: [a, b], into: a, basis: `${check.label} steps within ${check.delta}${check.unit}` });
      }
    }
  }
  if (duplicateEvidence.length > 0) {
    score -= 5;
    evidence.push(`${duplicateEvidence.length} near-duplicate token step(s) to consolidate`);
    findings.push(
      makeFinding({
        ruleId: "consistency.near-duplicate-token",
        category: "consistency",
        severity: "medium",
        confidence: 0.8,
        summary: `${duplicateEvidence.length} near-duplicate token step(s): ${duplicateEvidence.slice(0, 3).join("; ")}`,
        rationale:
          "Two tokens serving the same emphasis role within a step of each other split the system's vocabulary — consumers pick either copy and the palette drifts. This warns with consolidation operations; it does not block, because both values are already system-owned.",
        evidence: [{ type: "token", revisionId, reference: "token-system", details: duplicateEvidence.slice(0, 8).join("; ") }],
        suggestedOperations: duplicateOps,
        suggestedFix: "Consolidate each near-duplicate token into its sibling so one name carries the value.",
        verification: "Re-discover the token system after consolidation; the near-duplicate pair must be gone.",
      }),
    );
  }

  /* -- Radius / stroke / spacing / typography dimensions --------------------- */
  const radii = new Set(input.radii ?? []);
  if (radii.size > 3) {
    score -= 10;
    evidence.push(`${radii.size} distinct radii; unify structural vs interactive`);
  }

  const strokes = new Set(input.strokes ?? []);
  if (strokes.size > 3) {
    score -= 10;
    evidence.push(`${strokes.size} distinct stroke weights; a system draws borders from a step, not ad hoc`);
  }

  const spacingSteps = new Set(input.spacingSteps ?? []);
  const spacingScale = input.tokenSystem?.spacing ?? [];
  if (spacingSteps.size > 0 && spacingScale.length > 0) {
    const offScale = [...spacingSteps].filter((s) => !spacingScale.some((step) => Math.abs(step - s) <= NEAR_DUPLICATE_SPACING_PX));
    if (offScale.length > 0) {
      score -= Math.min(10, offScale.length * 2);
      evidence.push(`${offScale.length} spacing value(s) off the discovered scale: ${offScale.slice(0, 6).map((s) => `${s}px`).join(", ")}`);
    }
  } else if (spacingSteps.size > 4) {
    score -= 10;
    evidence.push(`${spacingSteps.size} distinct spacing steps; tighten to one rhythm`);
  }

  const families = new Set((input.families ?? []).map((f) => f.toLowerCase()));
  if (families.size > 3) {
    score -= 10;
    evidence.push(`${families.size} font families; a system uses at most 3`);
  }

  if ((input.repeatedComponents ?? 0) > 0) {
    evidence.push(`${input.repeatedComponents} repeated component(s): reuse, not rebuild`);
  }

  const blocking = ((input.repairIntroducedUnknown ?? false) && unknown.length > 0) || oneOffs.length > 0;
  if ((input.repairIntroducedUnknown ?? false) && unknown.length > 0) {
    evidence.push("BLOCKING: a repair introduced unapproved fills");
  }

  return { score: Math.max(0, Math.round(score)), blocking, evidence, findings, tokenCheck };
}
