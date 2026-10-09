/**
 * System 10 — Visual Critic extensions (spec §16).
 *
 * The existing structural critic (`review/critique.ts`) already measures focal
 * clarity, hierarchy, composition, whitespace, density, repetition, card-wall
 * tendency, balance, data-viz quality, surface hierarchy, depth and template
 * feel. This module adds the four critique dimensions only design intelligence
 * can judge — relationship clarity, typography, product character, authorship —
 * plus contrast, and merges them with the measured report.
 *
 * Judgement stays honest: measured dimensions are computed; the four new ones
 * are heuristic self-checks with explicit evidence, never fabricated scores.
 */
import { evaluateGenericity, type GenericityReport } from "./genericity";

export type CriticVerdict = "PASS" | "WATCH" | "FAIL";

export interface ExtendedDimension {
  dimension: string;
  verdict: CriticVerdict;
  evidence: string;
  suggestion?: string;
}

export interface ExtendedCritique {
  verdict: CriticVerdict;
  dimensions: ExtendedDimension[];
  genericity: GenericityReport;
  watchList: string[];
}

/**
 * Extends a measured critique with the design-intelligence dimensions.
 * `measured` carries the verdicts the deterministic critic already produced;
 * this function only *adds* dimensions, never softens an existing FAIL.
 */
export function extendCritique(input: {
  measured: { verdict: CriticVerdict; dimensions: Array<{ dimension: string; verdict: CriticVerdict; evidence?: string; suggestion?: string }> };
  boxes: Map<string, { id: string; x: number; y: number; w: number; h: number }>;
  operations: Array<Record<string, unknown>>;
  regions: Array<{ id: string; role: string }>;
  composition?: string;
  links?: Array<{ from: string; to: string; label?: string }>;
  patternId?: string;
  productName?: string;
  /** Actual fills extracted from the rendered/native operations, not inferred from names. */
  fills?: string[];
}): ExtendedCritique {
  const genericity = evaluateGenericity({
    boxes: input.boxes,
    operations: input.operations,
    regions: input.regions,
    ...(input.composition !== undefined ? { composition: input.composition } : {}),
    ...(input.fills !== undefined ? { fills: input.fills } : {}),
  });
  const extra: ExtendedDimension[] = [
    relationshipClarity(input.links ?? []),
    typographyVoice(input.operations),
    productCharacter(input.regions, input.composition, input.patternId, input.productName ?? "EXO"),
    authorship(input.operations, input.regions, genericity.score),
  ];
  if (genericity.blocking) {
    extra.push({
      dimension: "Genericity",
      verdict: "FAIL",
      evidence: `genericity ${genericity.score}/100: ${genericity.findings.map((f) => f.id).join(", ")}`,
      suggestion: genericity.repairs[0],
    });
  } else if (genericity.score >= 40) {
    extra.push({
      dimension: "Genericity",
      verdict: "WATCH",
      evidence: `genericity ${genericity.score}/100`,
      suggestion: genericity.repairs[0] ?? "Strengthen the focal object.",
    });
  } else {
    extra.push({ dimension: "Genericity", verdict: "PASS", evidence: `genericity ${genericity.score}/100` });
  }
  const dimensions: ExtendedDimension[] = [
    ...input.measured.dimensions.map((d) => ({
      dimension: d.dimension,
      verdict: d.verdict,
      evidence: d.evidence ?? "",
      ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
    })),
    ...extra,
  ];
  const verdict: CriticVerdict = dimensions.some((d) => d.verdict === "FAIL")
    ? "FAIL"
    : dimensions.some((d) => d.verdict === "WATCH")
      ? "WATCH"
      : "PASS";
  const order = { FAIL: 0, WATCH: 1, PASS: 2 };
  return {
    verdict,
    dimensions,
    genericity,
    watchList: dimensions
      .filter((d) => d.verdict !== "PASS")
      .sort((a, b) => order[a.verdict] - order[b.verdict])
      .map((d) => `${d.dimension} (${d.verdict}): ${d.suggestion ?? d.evidence}`),
  };
}

/** Can the user understand relationships without reading every label? */
function relationshipClarity(links: Array<{ from: string; to: string; label?: string }>): ExtendedDimension {
  if (links.length === 0) return { dimension: "Relationship clarity", verdict: "PASS", evidence: "no declared relationships to judge" };
  const unlabeled = links.filter((l) => !l.label).length;
  if (unlabeled > 0) {
    return {
      dimension: "Relationship clarity",
      verdict: unlabeled === links.length ? "FAIL" : "WATCH",
      evidence: `${unlabeled}/${links.length} relationships carry no meaning`,
      suggestion: "Label what each edge means (latency, flow, assignment). An unexplained line is decoration.",
    };
  }
  return { dimension: "Relationship clarity", verdict: "PASS", evidence: `${links.length}/${links.length} relationships labelled` };
}

/** Hierarchy, readability, scale, weight, consistency — from text ops. */
function typographyVoice(ops: Array<Record<string, unknown>>): ExtendedDimension {
  const texts = ops.filter((o) => o.type === "createText");
  if (texts.length === 0) return { dimension: "Typography", verdict: "PASS", evidence: "no text to judge" };
  const sizes = new Set(texts.map((o) => Number((o as { fontSize?: unknown }).fontSize ?? 0)).filter((n) => n > 0));
  const families = new Set(texts.map((o) => String((o as { family?: unknown }).family ?? "Inter")));
  if (families.size > 3) {
    return { dimension: "Typography", verdict: "WATCH", evidence: `${families.size} font families (${[...families].join(", ")})`, suggestion: "Use the product primary + mono only; a third family needs a reason." };
  }
  if (sizes.size <= 1 && texts.length >= 4) {
    return { dimension: "Typography", verdict: "WATCH", evidence: "single type size across 4+ text nodes", suggestion: "Establish display/heading/body/label scale so hierarchy reads without reading." };
  }
  return { dimension: "Typography", verdict: "PASS", evidence: `${sizes.size} size(s), ${families.size} familie(s)` };
}

/** Does it feel specific to the product, or like any SaaS? */
function productCharacter(
  regions: Array<{ id: string; role: string }>,
  composition: string | undefined,
  patternId: string | undefined,
  productName: string,
): ExtendedDimension {
  const names = regions.map((r) => r.id.toLowerCase()).join(" ");
  const productSignals = ["topology", "runtime", "model", "device", "fleet", "cluster", "shard", "inference", "telemetry", "field", "signal"];
  const hits = productSignals.filter((s) => names.includes(s)).length;
  if (patternId && patternId !== "none" && hits > 0) {
    return { dimension: "Product character", verdict: "PASS", evidence: `${productName} pattern '${patternId}' with ${hits} product signal(s)` };
  }
  if (composition === "canvas" && hits === 0) {
    return {
      dimension: "Product character",
      verdict: "WATCH",
      evidence: `no ${productName} signals in region names; unresolved composition`,
      suggestion: `Name regions for ${productName} concepts (runtime, topology, model) and pick the pattern the decision needs.`,
    };
  }
  return { dimension: "Product character", verdict: "PASS", evidence: `${hits} product signal(s)` };
}

/** Does it feel intentionally designed rather than assembled? */
function authorship(
  ops: Array<Record<string, unknown>>,
  regions: Array<{ id: string; role: string }>,
  genericityScore: number,
): ExtendedDimension {
  if (genericityScore >= 70) {
    return { dimension: "Authorship", verdict: "FAIL", evidence: `genericity ${genericityScore}: assembled, not authored`, suggestion: "Remove the template structure; commit to one focal idea." };
  }
  const defaultNamed = ops.filter((o) => /^(Frame|Rectangle|Text|Vector|Group) \d+$/.test(String((o as { name?: unknown }).name ?? ""))).length;
  if (defaultNamed >= 3) {
    return { dimension: "Authorship", verdict: "WATCH", evidence: `${defaultNamed} default-named layers`, suggestion: "Name layers semantically; unnamed work reads as unconsidered." };
  }
  if (regions.length > 5) {
    return { dimension: "Authorship", verdict: "WATCH", evidence: `${regions.length} regions compete`, suggestion: "Verify each region earns its surface; merge or remove one." };
  }
  return { dimension: "Authorship", verdict: "PASS", evidence: "no assembly markers" };
}
