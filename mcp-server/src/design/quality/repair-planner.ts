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
}): RepairInstruction[] {
  const out: RepairInstruction[] = [];

  for (const f of input.structuralFindings ?? []) {
    if (f.severity === "critical") {
      out.push({ priority: "P0", title: `Fix ${f.rule}`, detail: `Resolve the '${f.rule}' breakage first; nothing else matters until structure holds.`, verification: `review_design shows no '${f.rule}' finding.` });
    }
  }
  for (const issue of input.blockingIssues ?? []) {
    out.push({ priority: "P1", title: issue.slice(0, 120), detail: `Blocking quality issue: ${issue}`, verification: "critique_visual no longer reports this as blocking." });
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
    out.push({ priority, title: watch.slice(0, 120), detail: watch, verification: "Re-render and confirm the watch item clears." });
  }
  const seen = new Set<string>();
  return out
    .filter((r) => (seen.has(r.title) ? false : (seen.add(r.title), true)))
    .sort((a, b) => ORDER[a.priority] - ORDER[b.priority])
    .slice(0, 8);
}
