/**
 * Repair Planner (spec §17).
 *
 * Generates *small, targeted* changes — never "regenerate entire screen".
 * Priorities: P0 broken/unusable, P1 hierarchy/composition, P2 readability/
 * typography, P3 spacing/rhythm, P4 visual polish. Never polish a screen whose
 * hierarchy is broken: P1 sorts before P4, always.
 */
import type { GenericityReport } from "./genericity";

export type RepairPriority = "P0" | "P1" | "P2" | "P3" | "P4";

export interface RepairInstruction {
  priority: RepairPriority;
  title: string;
  detail: string;
  verification: string;
}

const ORDER: Record<RepairPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 };

export function planRepairs(input: {
  genericity?: GenericityReport | null;
  watchList?: string[];
  blockingIssues?: string[];
  structuralFindings?: Array<{ rule: string; severity: string }>;
  /**
   * Token context for token-aware repairs (quality-reliability P0).
   * `approved` names the fills/tokens repairs may use; anything outside
   * approved+existing must be confirmed, never silently introduced — that is
   * how contrast fixes quietly degraded consistency (live: repair tints).
   */
  tokens?: { approved: string[]; existing?: string[] };
}): RepairInstruction[] {
  const out: RepairInstruction[] = [];
  const approved = new Set((input.tokens?.approved ?? []).map((t) => t.toLowerCase()));
  const known = new Set([...approved, ...(input.tokens?.existing ?? []).map((t) => String(t).toLowerCase())]);

  const tokenGuidance = (detail: string): string => {
    if (approved.size === 0) return detail;
    return `${detail} Reuse an approved token (${[...approved].slice(0, 8).join(", ")}) for any fill change; do not introduce a new hue.`;
  };

  const needsTokenCheck = (text: string): boolean =>
    /contrast|fill|colour|color|tint|readab|typograph/i.test(text);

  for (const f of input.structuralFindings ?? []) {
    if (f.severity === "critical") {
      out.push({ priority: "P0", title: `Fix ${f.rule}`, detail: `Resolve the '${f.rule}' breakage first; nothing else matters until structure holds.`, verification: `review_design shows no '${f.rule}' finding.` });
    }
  }
  for (const issue of input.blockingIssues ?? []) {
    const detail = needsTokenCheck(issue) ? tokenGuidance(`Blocking quality issue: ${issue}`) : `Blocking quality issue: ${issue}`;
    out.push({ priority: "P1", title: issue.slice(0, 120), detail, verification: "critique_visual no longer reports this as blocking." });
  }
  for (const repair of input.genericity?.repairs ?? []) {
    out.push({ priority: "P1", title: repair.slice(0, 120), detail: `Genericity repair (score ${input.genericity?.score ?? "?"}): ${repair}`, verification: "evaluateGenericity score drops below 70." });
  }
  for (const watch of input.watchList ?? []) {
    const lower = watch.toLowerCase();
    const priority: RepairPriority =
      /contrast|readab|typograph|font|label/i.test(lower) ? "P2"
      : /spacing|whitespace|density|rhythm|balance/i.test(lower) ? "P3"
      : /hierarchy|focal|composition|card|template/i.test(lower) ? "P1"
      : "P4";
    const detail = needsTokenCheck(watch) ? tokenGuidance(watch) : watch;
    // Contrast fixes are where new tints leak in: verify the whole frame, not
    // just the relabeled node, and confirm every changed fill is approved.
    const verification = needsTokenCheck(watch) && known.size > 0
      ? "Re-render and confirm the watch item clears; whole-frame consistency holds with no fill outside the approved set."
      : "Re-render and confirm the watch item clears.";
    out.push({ priority, title: watch.slice(0, 120), detail, verification });
  }
  // Unknown-token introduction: any repair text naming a hex outside the known
  // set gets an explicit confirmation step rather than silent permission.
  for (const r of out) {
    const hexes = r.detail.match(/#[0-9a-f]{3,8}/gi) ?? [];
    if (hexes.some((h) => !known.has(h.toLowerCase())) && known.size > 0) {
      r.verification += " Confirm each named fill is an approved token.";
    }
  }
  const seen = new Set<string>();
  return out
    .filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true)))
    .sort((a, b) => ORDER[a.priority] - ORDER[b.priority])
    .slice(0, 8);
}
