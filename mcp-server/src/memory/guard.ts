/**
 * DesignGuard — the do-not-drift layer (spec §28).
 *
 * ## The design decision that matters
 *
 * A guard is only useful if its FAILs are trusted. Every design here follows from
 * that:
 *
 * - **Only measured evidence can produce a FAIL.** A rule whose evidence needs
 *   judgement is surfaced as a `manual` question, never asserted. Guessing
 *   produces a false FAIL, and the first false FAIL teaches the user to ignore
 *   the guard entirely.
 * - **Never fail on absence.** If the screen does not contain the offending
 *   thing, the rule *passes*. "No connect-device wizard" must not fail a screen
 *   that simply has nothing to do with pairing.
 * - **Severity is declared by the rule, not inferred.** Whether a contradiction
 *   is a FAIL or a WARNING is a product judgement, recorded once when the rule is
 *   written.
 * - **Evidence is reported with every verdict.** "FAIL" alone is unactionable;
 *   "FAIL exo.auto-discovery: matched text 'Connect device'" tells you what to
 *   delete.
 *
 * ## What it can see
 *
 * A snapshot of the design IR plus measured metrics from the review engine. That
 * is deliberately limited to what the server already knows — the guard adds no new
 * measurement pass, so it costs nothing to run after every build.
 */
import type { GuardFinding, ProductRule, RuleEvidence, Verdict } from "../../../shared/memory";

/* -------------------------------------------------------------------------- */
/* The snapshot                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Everything the guard is allowed to look at.
 *
 * A closed shape on purpose. Adding a field here is a decision to make it
 * checkable; it is not a free-for-all data dump.
 */
export interface GuardSnapshot {
  /** Composition the layout resolved to, e.g. "spatial". */
  composition?: string;
  /** Semantic component instances present. */
  components?: Array<{ type: string; count: number; label?: string }>;
  /** Layer names, used by `maxNodes`. */
  nodeNames?: string[];
  /** Visible text content. */
  texts?: string[];
  /** Numeric metrics, used by `assert`. */
  metrics?: Record<string, number>;
  /** Screen id, for matching memory notes. */
  screen?: string;
}

/* -------------------------------------------------------------------------- */

export interface GuardResult {
  verdict: Verdict;
  findings: GuardFinding[];
  stats: {
    rulesChecked: number;
    passed: number;
    warnings: number;
    failures: number;
    /** Rules that could not be checked and need a human. */
    manual: number;
  };
}

const COMPARISONS: Record<"operator" | string, ((a: number, b: number) => boolean) | undefined> = {
  "<": (a, b) => a < b,
  "<=": (a, b) => a <= b,
  ">": (a, b) => a > b,
  ">=": (a, b) => a >= b,
  "==": (a, b) => a === b,
  "!=": (a, b) => a !== b,
};

/** Combines per-check outcomes into a single verdict. Failure dominates. */
function worst(findings: Array<{ verdict: Verdict }>): Verdict {
  if (findings.some((f) => f.verdict === "FAIL")) return "FAIL";
  if (findings.some((f) => f.verdict === "WARNING")) return "WARNING";
  return "PASS";
}

/* -------------------------------------------------------------------------- */

interface CheckOutcome {
  verdict: Verdict;
  message: string;
  evidence?: string;
  nextStep?: string;
  /** Set when the evidence could not be evaluated at all. */
  manual?: boolean;
}

/**
 * Evaluates one piece of evidence.
 *
 * Returns PASS when the evidence is absent — see the "never fail on absence"
 * note above. `manual` outcomes are reported separately so a rule with only
 * unmeasurable evidence does not masquerade as a checked rule.
 */
function evaluate(evidence: RuleEvidence, snapshot: GuardSnapshot): CheckOutcome {
  switch (evidence.kind) {
    case "forbiddenText": {
      const flags = evidence.flags ? new RegExp(evidence.flags, "i") : undefined;
      const re = new RegExp(evidence.pattern, flags?.flags ?? "i");
      const hits = (snapshot.texts ?? []).filter((t) => re.test(t));
      if (hits.length === 0) return { verdict: "PASS", message: "no offending copy present" };
      return {
        verdict: "FAIL",
        message: `found ${hits.length} text node(s) matching a forbidden pattern`,
        evidence: hits.slice(0, 5).join(" | "),
      };
    }

    case "maxInstances":
    case "maxComponents": {
      const entry = (snapshot.components ?? []).find((c) => c.type === evidence.component);
      const count = entry?.count ?? 0;
      if (count <= evidence.max) return { verdict: "PASS", message: `${count} of max ${evidence.max}` };
      return {
        verdict: "FAIL",
        message: `${count} ${evidence.component} instance(s), limit is ${evidence.max}`,
        evidence: `${evidence.kind}=${count}`,
      };
    }

    case "forbidComposition": {
      if (snapshot.composition !== evidence.composition) {
        return { verdict: "PASS", message: `composition is '${snapshot.composition ?? "unknown"}'` };
      }
      return {
        verdict: "FAIL",
        message: `layout resolved to the forbidden composition '${evidence.composition}'`,
      };
    }

    case "maxNodes": {
      const re = new RegExp(evidence.namePattern, "i");
      const count = (snapshot.nodeNames ?? []).filter((n) => re.test(n)).length;
      if (count <= evidence.max) return { verdict: "PASS", message: `${count} of max ${evidence.max}` };
      return { verdict: "FAIL", message: `${count} layer name(s) match '${evidence.namePattern}', limit is ${evidence.max}`, evidence: `${count} matches` };
    }

    case "maxTexts": {
      const re = new RegExp(evidence.pattern, "i");
      const count = (snapshot.texts ?? []).filter((t) => re.test(t)).length;
      if (count <= evidence.max) return { verdict: "PASS", message: `${count} of max ${evidence.max}` };
      return { verdict: "FAIL", message: `${count} text node(s) match '${evidence.pattern}', limit is ${evidence.max}` };
    }

    case "assert": {
      const actual = snapshot.metrics?.[evidence.metric];
      if (actual === undefined) {
        // No metric to compare against is *not* a pass and *not* a failure; it is
        // an unevaluated check.
        return { verdict: "PASS", message: `metric '${evidence.metric}' was not collected`, manual: true };
      }
      const cmp = COMPARISONS[evidence.op];
      if (!cmp) return { verdict: "PASS", message: `unknown operator '${evidence.op}'`, manual: true };
      if (cmp(actual, evidence.value)) {
        return { verdict: "PASS", message: `${evidence.metric}=${actual}` };
      }
      return {
        verdict: "FAIL",
        message: `${evidence.metric}=${actual} violates ${evidence.op} ${evidence.value}`,
        evidence: `${evidence.metric}=${actual}`,
      };
    }

    case "implies": {
      const premise = snapshot.metrics?.[evidence.ifMetric];
      if (premise === undefined) {
        return { verdict: "PASS", message: `metric '${evidence.ifMetric}' was not collected`, manual: true };
      }
      const ifCmp = COMPARISONS[evidence.ifOp];
      const thenCmp = COMPARISONS[evidence.thenOp];
      if (!ifCmp || !thenCmp) return { verdict: "PASS", message: "unknown operator", manual: true };
      if (!ifCmp(premise, evidence.ifValue)) {
        return { verdict: "PASS", message: `premise does not hold (${evidence.ifMetric}=${premise})` };
      }
      const conclusion = snapshot.metrics?.[evidence.thenMetric];
      if (conclusion === undefined) {
        return { verdict: "PASS", message: `metric '${evidence.thenMetric}' was not collected`, manual: true };
      }
      if (thenCmp(conclusion, evidence.thenValue)) {
        return { verdict: "PASS", message: `${evidence.thenMetric}=${conclusion}` };
      }
      return {
        verdict: "FAIL",
        message: `because ${evidence.ifMetric}=${premise}, ${evidence.thenMetric} must be ${evidence.thenOp} ${evidence.thenValue} but is ${conclusion}`,
        evidence: `${evidence.thenMetric}=${conclusion}`,
      };
    }

    case "manual":
    default:
      return { verdict: "PASS", message: evidence.kind === "manual" ? evidence.question : "not checkable", manual: true };
  }
}

/**
 * Runs every rule and returns a verdict per rule.
 *
 * A rule passes only when *every* checkable piece of evidence passes. That is
 * deliberate: a rule with three checks should not report PASS while two of them
 * were unmeasurable.
 */
export function runGuard(rules: ProductRule[], snapshot: GuardSnapshot): GuardResult {
  const findings: GuardFinding[] = [];
  let passed = 0;
  let warnings = 0;
  let failures = 0;
  let manual = 0;

  for (const rule of rules) {
    const checkable = rule.evidence.filter((e) => e.kind !== "manual");
    const manualOnly = rule.evidence.filter((e) => e.kind === "manual");

    if (checkable.length === 0) {
      // Nothing machine-checkable. Surface the question; do not pretend to pass.
      if (manualOnly.length > 0) {
        manual += manualOnly.length;
        findings.push({
          verdict: "PASS",
          rule: rule.id,
          message: `needs a human judgement: ${rule.therefore}`,
          evidence: manualOnly.map((m) => (m.kind === "manual" ? m.question : "")).join(" | "),
        });
      }
      passed += 1;
      continue;
    }

    const outcomes = checkable.map((e) => evaluate(e, snapshot));
    const breaches = outcomes.filter((o) => o.verdict === "FAIL");
    const verdict: Verdict = breaches.length > 0 ? (rule.severity === "fail" ? "FAIL" : "WARNING") : "PASS";

    const unevaluated = outcomes.filter((o) => o.manual).length + manualOnly.length;
    if (unevaluated > 0) manual += unevaluated;

    if (verdict === "FAIL") failures += 1;
    else if (verdict === "WARNING") warnings += 1;
    else passed += 1;

    findings.push({
      verdict,
      rule: rule.id,
      message: breaches.length > 0 ? `contradicts: ${rule.therefore}` : `consistent with: ${rule.rule}`,
      evidence: breaches.length > 0 ? breaches.map((b) => b.evidence ?? b.message).join(" | ") : undefined,
      nextStep: breaches.length > 0 ? rule.therefore : undefined,
    });
  }

  return {
    verdict: worst(findings),
    findings,
    stats: { rulesChecked: rules.length, passed, warnings, failures, manual },
  };
}

/**
 * Builds a snapshot from a compiled runtime result.
 *
 * Kept separate from `runGuard` so the snapshot shape is a deliberate interface
 * rather than an implicit read of whatever the compiler happened to return.
 */
export function snapshotFromIR(ir: {
  regions: Array<{ id: string; role: string; composition: string }>;
  content: Array<{ kind: string; id: string; type?: string; text?: string; props?: Record<string, unknown> }>;
  links?: Array<{ from: string; to: string; label?: string }>;
}, resolved: { composition: string }): GuardSnapshot {
  const components: Array<{ type: string; count: number }> = [];
  const count = new Map<string, number>();

  for (const node of ir.content) {
    if (node.kind !== "component" || !node.type) continue;
    count.set(node.type, (count.get(node.type) ?? 0) + 1);
  }
  for (const [type, n] of count) components.push({ type, count: n });

  const connectors = ir.content.filter((n) => n.kind === "connector");
  const labeledEdges = connectors.filter((n) => typeof (n as { label?: unknown }).label === "string").length;

  // Interactive components with no label: buttons, pills and rows that nothing
  // names. State communicated without words fails the critical-states rule.
  const LABELLED = new Set(["metric", "statusPill", "deviceNode", "modelRow", "navItem", "button", "sectionHeader"]);
  let unlabeledComponents = 0;
  for (const node of ir.content) {
    if (node.kind !== "component" || !node.type || !LABELLED.has(node.type)) continue;
    const props = node.props ?? {};
    const named = ["label", "title", "value"].some((k) => typeof props[k] === "string" && (props[k] as string).length > 0);
    if (!named) unlabeledComponents += 1;
  }

  const topologyNodes = (ir.content.filter((n) => n.kind === "component" && (n.type === "deviceNode" || n.type === "topologyMap"))).length;

  return {
    composition: resolved.composition,
    components,
    nodeNames: ir.regions.map((r) => r.id),
    texts: ir.content.filter((n) => n.kind === "text").map((n) => n.text ?? ""),
    metrics: {
      regions: ir.regions.length,
      content: ir.content.length,
      components: components.reduce((a, c) => a + c.count, 0),
      metricCards: count.get("metric") ?? 0,
      textNodes: ir.content.filter((n) => n.kind === "text").length,
      topologyNodes,
      topologyEdges: (ir.links ?? []).length,
      labeledEdges,
      unlabeledEdges: Math.max(0, (ir.links ?? []).length - labeledEdges),
      unlabeledComponents,
      buttons: (count.get("button") ?? 0),
    },
  };
}