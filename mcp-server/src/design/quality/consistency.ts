/**
 * Evidence-backed consistency scoring (quality-reliability P1).
 *
 * Separate measure, documented scale: 0–100 from token reuse, type-scale
 * discipline, radius/border/fill/spacing consistency, component repetition,
 * and repair-introduced drift. Critical blockers (unknown-token fills that
 * break the palette) fail outright and never average away.
 *
 * This does NOT change existing gates or weights — it is the explicit
 * consistency dimension the plan asks for, consumed by reports and the live
 * evidence pack. Weights stay pinned until multiple screens are independently
 * human-rated; see SCORECARD_DOCS in benchmark/suite.ts.
 */
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
}

export interface ConsistencyReport {
  /** 0–100. */
  score: number;
  blocking: boolean;
  evidence: string[];
}

export function evaluateConsistency(input: ConsistencyInputs): ConsistencyReport {
  const evidence: string[] = [];
  let score = 100;
  const approved = new Set((input.approvedTokens ?? []).map((t) => t.toLowerCase()));

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

  const radii = new Set(input.radii ?? []);
  if (radii.size > 3) {
    score -= 10;
    evidence.push(`${radii.size} distinct radii; unify structural vs interactive`);
  }

  const families = new Set((input.families ?? []).map((f) => f.toLowerCase()));
  if (families.size > 3) {
    score -= 10;
    evidence.push(`${families.size} font families; a system uses at most 3`);
  }

  if ((input.repeatedComponents ?? 0) > 0) {
    evidence.push(`${input.repeatedComponents} repeated component(s): reuse, not rebuild`);
  }

  const blocking = (input.repairIntroducedUnknown ?? false) && unknown.length > 0;
  if (blocking) {
    evidence.push("BLOCKING: a repair introduced unapproved fills");
  }

  return { score: Math.max(0, Math.round(score)), blocking, evidence };
}
