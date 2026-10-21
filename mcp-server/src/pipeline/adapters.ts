/**
 * The bridge between the two brief schemas (issue #20, workstream 1).
 *
 * `design_brief` (plan/brief.ts) and `design_pipeline` (pipeline/contracts.ts)
 * grew independently and their shapes diverge: `goal` is called `purpose`,
 * `canvas{width,height,grid}` is called `viewport{width,height}`, the free-text
 * `user` became a structured `audience`, and several plan-side fields have no
 * pipeline counterpart. Nothing bridged them, so a caller that copied the
 * brief tool's output into the pipeline tool lost fields silently — and a
 * schema that loses fields silently is exactly the defect the issue names.
 *
 * The adapter converts one into the other and *inventories* what it could not
 * carry: every dropped or renamed field is reported, so loss is always
 * documented loss. It validates with the pipeline's own schema, so the result
 * is guaranteed to parse at the next boundary.
 */
import { z } from "zod";
import type { DesignBriefArgs } from "../plan/brief";
import { BriefInputSchema } from "./contracts";

export type PipelineBrief = z.infer<typeof BriefInputSchema>;

/** A field that genuinely has no pipeline counterpart, with the reason. */
export interface UnmappedField {
  field: string;
  reason: string;
}

/**
 * Converts `design_brief` arguments into `design_pipeline` brief input.
 *
 * Throws when the pipeline schema rejects the conversion — a boundary error
 * that names the field, not a silent drop.
 */
export type DesignBriefArgsShape = z.infer<typeof DesignBriefArgs>;

export function pipelineBriefFromDesignBrief(args: DesignBriefArgsShape | Record<string, unknown>): { brief: PipelineBrief; renamed: UnmappedField[]; unmapped: UnmappedField[] } {
  const a = args as DesignBriefArgsShape;
  const renamed: UnmappedField[] = [];
  const unmapped: UnmappedField[] = [];

  const brief: Record<string, unknown> = {};

  if (a.screen !== undefined) brief.screen = a.screen;
  if (a.goal !== undefined) {
    brief.purpose = a.goal;
    renamed.push({ field: "goal → purpose", reason: "the pipeline names the user's task 'purpose'; semantics are identical." });
  }
  if (a.primaryDecision !== undefined) brief.primaryDecision = a.primaryDecision;
  if (a.availableInformation !== undefined) brief.availableInformation = a.availableInformation;
  if (a.existingPatterns !== undefined) brief.existingPatterns = a.existingPatterns;
  if (a.visualDirection !== undefined) brief.visualDirection = a.visualDirection;
  if (a.audience !== undefined) {
    brief.audience = a.audience;
  } else if (a.user !== undefined) {
    // The free-text `user` has no pipeline counterpart; the structured
    // `audience` enum is what the pipeline reads, and guessing a cohort from
    // prose would be an invention, not an adaptation.
    unmapped.push({ field: "user", reason: "the pipeline reads the structured `audience` enum instead; pass `audience` explicitly." });
  }
  if (a.canvas !== undefined) {
    const viewport: Record<string, number> = {
      width: a.canvas.width ?? 1440,
      height: a.canvas.height ?? 900,
    };
    brief.viewport = viewport;
    if (a.canvas.width !== undefined && a.canvas.height !== undefined) {
      renamed.push({ field: "canvas{width,height} → viewport{width,height}", reason: "the grid unit is a planner-only concept; the pipeline works in absolute pixels." });
    }
    if (a.canvas.grid !== undefined) {
      unmapped.push({ field: "canvas.grid", reason: "the pipeline's layout engine does not take a snap grid; spacing it computed from the scale, not snapped." });
    }
  }

  const parsed = BriefInputSchema.parse(brief);
  return { brief: parsed, renamed, unmapped };
}
