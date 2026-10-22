/**
 * Type and spacing criteria, applied to compiled evidence (issue #22 §4,
 * phase 2 — the deterministic half of the visual critique).
 *
 * The `type-and-space` skill declares four acceptance criteria (see
 * `design/skills/type-space.ts`): no label below 11px, uppercase reserved for
 * eyebrows, one spacing rhythm between sibling regions, and sane column
 * lengths. Their full proof point is a rendered screenshot — but three of the
 * four are decided *before* a node exists, in the compiled operations and the
 * resolved plan, and catching a declared criterion failing at compile time is
 * cheaper than catching it after render.
 *
 * These checks are structural critiques of pre-render evidence. They are
 * reported as findings for the caller — never auto-applied as repairs, because
 * two gaps between sibling regions may be exactly what the direction asked
 * for; what cannot happen is two gaps **without a stated reason**. The
 * rendered-screenshot half of the loop (capture → critique → repair →
 * re-render) runs live and is documented as out of scope for offline tests.
 */
import type { PipelineFinding } from "../../pipeline/contracts";

/** The floor the skill declares; nothing measurable may claim less. */
export const MIN_LABEL_PX = 11;

export interface TypeCriterionResult {
  id: string;
  /** Which declared criterion this is (matches the skill's qualityChecks ids). */
  criterion: "readable-labels" | "uppercase-in-check" | "one-rhythm" | "column-length-sane";
  status: "pass" | "fail" | "not-evaluated";
  detail: string;
}

export interface TypeCriteriaAudit {
  findings: PipelineFinding[];
  criteria: TypeCriterionResult[];
}

/** Words of digits-and-letters; an isolated ampersand or hyphen is allowed inside. */
function isShouty(token: string): boolean {
  return /^[A-Z0-9&./-]{3,}$/.test(token) && /[A-Z]/.test(token);
}

function finding(input: {
  ruleId: string;
  criterion: TypeCriterionResult["criterion"];
  summary: string;
  why: string;
  detail: string;
  severity: PipelineFinding["severity"];
  confidence: number;
  fix: string;
  nodeIds: string[];
}): PipelineFinding {
  return {
    id: `${input.ruleId}`,
    stage: "program" as const,
    severity: input.severity,
    confidence: input.confidence,
    rule: input.ruleId,
    nodeIds: input.nodeIds,
    summary: input.summary,
    why: input.why,
    evidence: { kind: "plan", detail: input.detail },
    fix: input.fix,
    automatable: false,
  };
}

/**
 * Audits the compiled program and the resolved plan against the declared
 * criteria. `ops` are the pipeline's compiled operations (top-level fields,
 * as the trace records them). `regions` are the plan's regions carrying their
 * gaps. Both halves are optional individually; a criterion whose evidence is
 * absent is reported as not-evaluated rather than as a pass.
 */
export function auditTypeCriteria(input: {
  ops?: Array<Record<string, unknown>>;
  regions?: Array<{ id: string; gap?: number }>;
}): TypeCriteriaAudit {
  const findings: PipelineFinding[] = [];
  const criteria: TypeCriterionResult[] = [];

  const textOps = (input.ops ?? []).filter((op) => String(op["type"] ?? "") === "createText");
  /** Interpreted ops and protocol ops carry fields at different depths; take both. */
  const readField = (op: Record<string, unknown>, key: string): unknown =>
    op[key] !== undefined ? op[key] : (op["args"] as Record<string, unknown> | undefined)?.[key];

  const regionsWithGaps = input.regions === undefined ? [] : input.regions.filter((r) => r.gap !== undefined);
  const gaps = new Map<number, string[]>();
  for (const region of regionsWithGaps) {
    const gap = region.gap ?? 0;
    // A zero gap means "single item / vertical stack collapse", not a rhythm
    // step, so only real gaps count.
    if (gap <= 0) continue;
    const list = gaps.get(gap) ?? [];
    list.push(region.id);
    gaps.set(gap, list);
  }
  const distinctGaps = [...gaps.keys()].sort((a, b) => a - b);

  /* --- one-rhythm (spacing criterion) -------------------------------------- */

  if (regionsWithGaps.length >= 3 && distinctGaps.length === 2) {
    // Two gaps can be a rhythm step plus its half-step for a deliberate
    // sub-group — legal only when stated. One region carrying the odd gap
    // out names exactly who to ask.
    const odd = distinctGaps[distinctGaps.length - 1]!;
    const oddRegions = gaps.get(odd)!;
    findings.push(
      finding({
        ruleId: "type.space.one-rhythm",
        criterion: "one-rhythm",
        severity: "medium",
        confidence: 0.75,
        summary: `Two sibling-region gaps on one screen: ${distinctGaps.join("px and ")}px. ${oddRegions.length} region(s) ('${oddRegions.slice(0, 3).join("', '")}') break the first gap's rhythm.`,
        why: `The type-and-space skill declares one spacing rhythm between sibling regions; two different gaps need a stated reason, and none is recorded here (issue #22, skill C, "spacing-on-rhythm").`,
        detail: `region gaps: ${distinctGaps.map((g) => `${g}px × ${gaps.get(g)!.length}`).join(", ")} across ${regionsWithGaps.length} regions.`,
        fix: "Either respace the odd regions to the screen's primary gap, or record the reason the rhythm breaks (a deliberate hierarchy step) in the region's why.",
        nodeIds: oddRegions,
      }),
    );
    criteria.push({
      id: "one-rhythm",
      criterion: "one-rhythm",
      status: "fail",
      detail: `${distinctGaps.length} distinct sibling-region gaps (>=2 regions per gap) across ${regionsWithGaps.length} regions.`,
    });
  } else if (distinctGaps.length > 2) {
    findings.push(
      finding({
        ruleId: "type.space.one-rhythm",
        criterion: "one-rhythm",
        severity: "high",
        confidence: 0.8,
        summary: `${distinctGaps.length} different sibling-region gaps (${distinctGaps.join(", ")}px): the spacing rhythm has collapsed.`,
        why: `Three or more gap values between sibling regions is not a rhythm; it is per-region improvisation, which reads as careless even when every region is individually tidy.`,
        detail: `region gaps: ${distinctGaps.map((g) => `${g}px × ${gaps.get(g)!.length}`).join(", ")}.`,
        fix: "Respace to the compiled rhythm step, or state a reason per break.",
        nodeIds: distinctGaps.flatMap((g) => gaps.get(g) ?? []),
      }),
    );
    criteria.push({
      id: "one-rhythm",
      criterion: "one-rhythm",
      status: "fail",
      detail: `${distinctGaps.length} distinct gaps across ${regionsWithGaps.length} regions.`,
    });
  } else if (distinctGaps.length >= 1) {
    criteria.push({
      id: "one-rhythm",
      criterion: "one-rhythm",
      status: "pass",
      detail: `${distinctGaps.length} gap value across ${regionsWithGaps.length} regions with gaps — one rhythm.`,
    });
  } else {
    criteria.push({ id: "one-rhythm", criterion: "one-rhythm", status: "not-evaluated", detail: "No region gap evidence in the plan." });
  }

  /* --- readable-labels (accessibility criterion) ---------------------------- */

  if (textOps.length > 0) {
    const tiny = textOps
      .map((op) => ({ id: String(readField(op, "id") ?? "?"), size: Number(readField(op, "fontSize") ?? NaN), content: String(readField(op, "content") ?? "") }))
      .filter((op) => Number.isFinite(op.size) && op.size < MIN_LABEL_PX);
    if (tiny.length > 0) {
      findings.push(
        finding({
          ruleId: "type.space.readable-labels",
          criterion: "readable-labels",
          severity: "high",
          confidence: 0.85,
          summary: `${tiny.length} text node(s) planned below the ${MIN_LABEL_PX}px floor: ${tiny.slice(0, 3).map((t) => `'${t.content.slice(0, 24)}${t.content.length > 24 ? "…" : ""}'@${t.size}px`).join(", ")}.`,
          why: `The type-and-space skill declares "no label renders below ${MIN_LABEL_PX}px"; tiny labels are the most common spacing-discipline failure and the cheapest to gate before render.`,
          detail: `compiled font sizes: ${tiny.map((t) => `${t.id}=${t.size}px`).join(", ")}.`,
          fix: `Raise the compiled size to the ${MIN_LABEL_PX}px floor (ramp caption role) — a live screenshot re-render must confirm it.`,
          nodeIds: tiny.map((t) => t.id),
        }),
      );
      criteria.push({
        id: "readable-labels",
        criterion: "readable-labels",
        status: "fail",
        detail: `${tiny.length} planned text node(s) below ${MIN_LABEL_PX}px.`,
      });
    } else {
      criteria.push({
        id: "readable-labels",
        criterion: "readable-labels",
        status: "pass",
        detail: `all ${textOps.length} planned text node(s) at >= ${MIN_LABEL_PX}px.`,
      });
    }
  } else {
    criteria.push({ id: "readable-labels", criterion: "readable-labels", status: "not-evaluated", detail: "No compiled text operations to measure." });
  }

  /* --- uppercase-in-check (typography criterion) ---------------------------- */

  if (textOps.length > 0) {
    const shoutyRuns: Array<{ id: string; content: string }> = [];
    for (const op of textOps) {
      const content = String(readField(op, "content") ?? "");
      const tokens = content.split(/\s+/);
      let run = 0;
      let runStart = 0;
      for (let i = 0; i < tokens.length; i++) {
        if (isShouty(tokens[i]!)) {
          if (run === 0) runStart = i;
          run++;
        } else if (run > 0) {
          if (run >= 4) shoutyRuns.push({ id: String(readField(op, "id") ?? "?"), content: tokens.slice(runStart, i).join(" ") });
          run = 0;
        }
      }
      if (run >= 4) shoutyRuns.push({ id: String(readField(op, "id") ?? "?"), content: tokens.slice(runStart).join(" ") });
    }
    if (shoutyRuns.length > 0) {
      const total = shoutyRuns.reduce((n, r) => n + r.content.split(/\s+/).length, 0);
      findings.push(
        finding({
          ruleId: "type.space.uppercase-in-check",
          criterion: "uppercase-in-check",
          severity: "medium",
          confidence: 0.7,
          summary: `${shoutyRuns.length} uppercase run(s) spanning ${total} word(s) in planned text — uppercase is reserved for eyebrows, not sentence-length metadata.`,
          why: `The type-and-space skill declares the uppercase budget: sentence-length metadata in caps reads as shouting and harms scanning (issue #22, skill C, "uppercase-budget").`,
          detail: `${shoutyRuns.slice(0, 3).map((r) => `${r.id}:"${r.content.slice(0, 48)}"`).join(", ")}${shoutyRuns.length > 3 ? "; …" : ""}.`,
          fix: "Set the metadata in sentence case; keep caps only for the eyebrow role.",
          nodeIds: shoutyRuns.map((r) => r.id),
        }),
      );
      criteria.push({
        id: "uppercase-in-check",
        criterion: "uppercase-in-check",
        status: "fail",
        detail: `${shoutyRuns.length} shouty run(s) in planned text.`,
      });
    } else {
      criteria.push({
        id: "uppercase-in-check",
        criterion: "uppercase-in-check",
        status: "pass",
        detail: `no uppercase run of 4+ words across ${textOps.length} planned text node(s).`,
      });
    }
  } else {
    criteria.push({ id: "uppercase-in-check", criterion: "uppercase-in-check", status: "not-evaluated", detail: "No compiled text operations to inspect." });
  }

  // column-length-sane is decided per rendered/columned text and is genuinely a
  // post-render measurement here (text widths depend on plugin measurement);
  // declared as such instead of half-checked.
  criteria.push({
    id: "column-length-sane",
    criterion: "column-length-sane",
    status: "not-evaluated",
    detail: "Line length needs rendered text measurement — evaluated by the live critique pass, not at compile time.",
  });

  return { findings, criteria };
}
