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
  /**
   * How the snapshot was obtained, and whether the target actually resolved.
   *
   * `live defect (hard stress test #10): design_guard(inspect:true)` reported
   * `nodes: 0` / `textNodes: 0` for a 751-node page and still returned PASS for
   * 13 rules, because every rule passes on absence. The emptiness has to be a
   * first-class fact of the snapshot so the verdict can refuse to be PASS.
   */
  source?: "program" | "live";
  /** Set by the producer when the requested target could not be resolved. */
  resolved?: boolean;
  /** Why resolution failed, when it did. Shown verbatim in the finding. */
  unresolvedReason?: string;
  /**
   * Exactly what was inspected, so the verdict can be read with its scope.
   *
   * A guard run over a single text layer is not a weaker check on a screen, it is
   * a check on a different and much smaller thing. Reporting that alongside the
   * verdict is the difference between "the guard approved this" and "the guard
   * approved this one layer".
   */
  scope?: GuardScope;
}

/** What a guard run actually looked at. */
export interface GuardScope {
  /** Node id, when there was one. */
  id?: string;
  name?: string;
  type?: string;
  /** How many nodes the inspection walked. */
  nodeCount: number;
  textCount: number;
  /** True when the target is a container that can stand for a screen. */
  screenLevel: boolean;
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
  if (findings.some((f) => f.verdict === "INDETERMINATE")) return "INDETERMINATE";
  return "PASS";
}

/**
 * Whether a snapshot carries anything a rule could have been measured against.
 *
 * "Never fail on absence" (above) is the right default for a screen that
 * genuinely contains no forbidden copy. It is the wrong default for a target
 * that resolved to nothing at all: there is no screen, so there is no absence
 * to observe. This is the single distinction the whole guard hinges on, so it
 * is one predicate rather than a rule-by-rule judgement.
 */
export function snapshotHasEvidence(snapshot: GuardSnapshot): boolean {
  if (snapshot.resolved === false) return false;
  if ((snapshot.nodeNames?.length ?? 0) > 0) return true;
  if ((snapshot.texts?.length ?? 0) > 0) return true;
  if ((snapshot.components?.length ?? 0) > 0) return true;
  if (snapshot.composition !== undefined) return true;
  // Metrics alone are evidence only when something was actually counted. A
  // snapshot carrying `nodes: 0, textNodes: 0` is the empty case, not a screen
  // whose rules all pass.
  return Object.values(snapshot.metrics ?? {}).some((v) => Number.isFinite(v) && v > 0);
}

/**
 * Node types that can stand for a screen.
 *
 * A guard run over a leaf has not checked a design; it has checked that one text
 * layer contains no forbidden word. The live retest found this: after editing the
 * 86-node homepage frame, `design_guard(inspect:true)` resolved the *current
 * selection* — a single text node — and returned PASS for all 13 rules, which
 * read as the whole homepage being validated when nothing of the sort happened.
 */
const SCREEN_LEVEL_TYPES = new Set(["FRAME", "COMPONENT", "COMPONENT_SET", "INSTANCE", "PAGE", "DOCUMENT", "SECTION", "GROUP", "SLIDE"]);

/**
 * A snapshot too small or too narrow to certify a screen.
 *
 * Two ways to get here, and both produce INDETERMINATE rather than PASS:
 *  - the target is a leaf (text, vector, rectangle), so it is not a design;
 *  - the target is a container but holds almost nothing, so passing every rule is
 *    an artefact of there being nothing to contradict.
 *
 * The threshold is deliberately low. It exists to catch the "one text node"
 * accident, not to second-guess a legitimately sparse screen.
 */
const MIN_SCREEN_NODES = 3;

export function scopeIsTooNarrow(snapshot: GuardSnapshot): string | null {
  const scope = snapshot.scope;
  if (!scope) return null;

  if (scope.type !== undefined && !SCREEN_LEVEL_TYPES.has(scope.type.toUpperCase())) {
    return `The selection is a ${scope.type}${scope.name ? ` named "${scope.name}"` : ""}, not a screen or frame. A product rule cannot be evaluated against a single layer.`;
  }
  if (scope.nodeCount > 0 && scope.nodeCount < MIN_SCREEN_NODES) {
    return `The selection contains ${scope.nodeCount} node${scope.nodeCount === 1 ? "" : "s"}, which is not enough to evaluate a screen. Select the frame you want checked.`;
  }
  if (scope.screenLevel === false) {
    return "The inspected target is not a screen-level container.";
  }
  return null;
}

/** Human-readable explanation used as the INDETERMINATE finding's evidence. */
function emptyEvidence(snapshot: GuardSnapshot): string {
  if (snapshot.unresolvedReason) return snapshot.unresolvedReason;
  const m = snapshot.metrics ?? {};
  return [
    `source=${snapshot.source ?? "unknown"}`,
    `nodes=${m.nodes ?? (snapshot.nodeNames?.length ?? 0)}`,
    `textNodes=${m.textNodes ?? (snapshot.texts?.length ?? 0)}`,
    `components=${snapshot.components?.length ?? 0}`,
    `composition=${snapshot.composition ?? "unknown"}`,
  ].join(" ");
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
/**
 * What a guard run should do about the target it was given.
 *
 * Pure, so the decision can be tested without a Figma file: a node id is used
 * directly, a name that matches nothing is a miss, and a name that matches
 * several frames is an *ambiguity* — a question, not a coin toss. A verdict
 * about the wrong screen is worse than no verdict.
 */
export type GuardTargetDecision =
  | { kind: "use-id"; id: string }
  | { kind: "ambiguous"; message: string; candidates: string[] }
  | { kind: "not-found"; message: string };

export function decideGuardTarget(
  target: string,
  matches: Array<{ id?: string; name?: string; type?: string }>,
): GuardTargetDecision {
  if (/^\d+:\d+$/.test(target)) return { kind: "use-id", id: target };
  if (matches.length === 0) {
    return { kind: "not-found", message: `No frame in the file matches '${target}'.` };
  }
  if (matches.length > 1) {
    return {
      kind: "ambiguous",
      message: `'${target}' matches ${matches.length} nodes, so the screen to check is ambiguous.`,
      candidates: matches.map((m) => `${m.id ?? "?"} "${m.name ?? ""}"`),
    };
  }
  const only = matches[0]!;
  return { kind: "use-id", id: only.id ?? "" };
}

export function runGuard(rules: ProductRule[], snapshot: GuardSnapshot): GuardResult {
  // An empty snapshot short-circuits before any rule runs. Every rule here
  // passes on absence, so a guard with nothing to measure reports PASS for all
  // of them — which reads as "the guard approved this design" when in truth
  // nothing was inspected. Hard stress test #10 found exactly that: PASS for 13
  // rules against `nodes: 0` on a page of 751.
  if (!snapshotHasEvidence(snapshot)) {
    const evidence = emptyEvidence(snapshot);
    return {
      verdict: "INDETERMINATE",
      findings: [
        {
          verdict: "INDETERMINATE",
          rule: "snapshot",
          message:
            "The guard had nothing to measure, so no rule was evaluated. This is not a pass: resolve the target first, then re-run.",
          evidence,
          nextStep:
            "Select the frame to check (or pass a program), confirm it is not inside a locked/hidden layer, and re-run design_guard. An empty result must never be read as approval.",
        },
      ],
      stats: { rulesChecked: 0, passed: 0, warnings: 0, failures: 0, manual: 0 },
    };
  }

  // Non-empty is not the same as screen-level. One text layer contains no
  // forbidden copy, so every rule passes — and reading that as "the design is
  // approved" is precisely the selection-scope false pass the live retest hit.
  const tooNarrow = scopeIsTooNarrow(snapshot);
  if (tooNarrow !== null) {
    return {
      verdict: "INDETERMINATE",
      findings: [
        {
          verdict: "INDETERMINATE",
          rule: "scope",
          message: `${tooNarrow} ${snapshot.scope?.nodeCount ?? 0} node(s) were walked, so no rule was evaluated against a design.`,
          evidence: emptyEvidence(snapshot),
          nextStep:
            "Select the frame you want checked, then re-run design_guard(inspect:true). A verdict about one layer is not a verdict about the screen.",
        },
      ],
      stats: { rulesChecked: 0, passed: 0, warnings: 0, failures: 0, manual: 0 },
    };
  }

  const findings: GuardFinding[] = [];
  let passed = 0;
  let warnings = 0;
  let failures = 0;
  let manual = 0;
  let indeterminate = 0;

  for (const rule of rules) {
    const checkable = rule.evidence.filter((e) => e.kind !== "manual");
    const manualOnly = rule.evidence.filter((e) => e.kind === "manual");

    if (checkable.length === 0) {
      // Nothing machine-checkable. Surface the question; do not pretend to pass.
      //
      // This used to push `verdict: "PASS"` and count the rule in `passed`. Five
      // of the thirteen EXO product truths are manual-only — primary-action-
      // dominant, selected-unambiguous, model-fit-context, technical-typography
      // and developer-apis — so a run over a real program returned a top-level
      // PASS on the strength of eight structural checks while having evaluated
      // none of the five that actually encode design judgement. The manual count
      // was buried in `stats.manual`, underneath a verdict that read as approval.
      //
      // This file's own header says judgement is "surfaced as a `manual`
      // question, never asserted", and then asserted PASS. A rule nobody checked
      // is INDETERMINATE, which is the verdict that exists for exactly this: the
      // difference between "the guard approved this" and "the guard looked and
      // could not conclude".
      if (manualOnly.length > 0) {
        manual += manualOnly.length;
        findings.push({
          verdict: "INDETERMINATE",
          rule: rule.id,
          message: `needs a human judgement: ${rule.therefore}`,
          evidence: manualOnly.map((m) => (m.kind === "manual" ? m.question : "")).join(" | "),
        });
      }
      continue;
    }

    const outcomes = checkable.map((e) => evaluate(e, snapshot));
    const breaches = outcomes.filter((o) => o.verdict === "FAIL");
    const unevaluated = outcomes.filter((o) => o.manual).length + manualOnly.length;
    if (unevaluated > 0) manual += unevaluated;

    // A rule with machine-checkable evidence that all held is still only PARTLY
    // checked when any of its own checks came back manual. Calling that PASS
    // makes the count of manual evaluations decorative — it is the reason the
    // EXO guard could report a clean run while deferring five of thirteen
    // truths. INDETERMINATE outranks PASS for the same reason FAIL outranks it.
    const verdict: Verdict =
      breaches.length > 0
        ? rule.severity === "fail"
          ? "FAIL"
          : "WARNING"
        : unevaluated > 0
          ? "INDETERMINATE"
          : "PASS";

    if (verdict === "FAIL") failures += 1;
    else if (verdict === "WARNING") warnings += 1;
    else if (verdict === "INDETERMINATE") indeterminate += 1;
    else passed += 1;

    findings.push({
      verdict,
      rule: rule.id,
      message:
        breaches.length > 0
          ? `contradicts: ${rule.therefore}`
          : unevaluated > 0
            ? `consistent with: ${rule.rule}, but ${unevaluated} of its own checks need a human judgement`
            : `consistent with: ${rule.rule}`,
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

  /* ------------------------------------------------------------------ */
  /* Task-legibility metrics                                             */
  /* ------------------------------------------------------------------ */
  //
  // These three exist because `primary-action-dominant`, `technical-typography`
  // and `selected-unambiguous` were all manual-only, so five of the thirteen EXO
  // truths were reported PASS without ever being evaluated. Each is decidable
  // from the program, so leaving them unevaluated was not caution — it was a gap
  // dressed up as one.

  /** How a component claims to be the one thing the user is meant to do. */
  const claimsPrimary = (props: Record<string, unknown>): boolean =>
    props.primary === true ||
    props.variant === "primary" ||
    props.emphasis === "primary" ||
    props.role === "primaryAction";

  const dominantActions = ir.content.filter(
    (n) => n.kind === "component" && n.props && claimsPrimary(n.props),
  ).length;

  /**
   * Strings the product truth names: identifiers, latencies, hashes, addresses.
   *
   * Kept to exactly the four the rule states. An earlier version also matched
   * byte quantities, which is not what `exo.technical-typography` says — and a
   * check that enforces more than the rule it claims to enforce is the same
   * drift the rule exists to prevent, just with better manners. It fired on the
   * project's own example dashboard (`value: "1.8 TB"`) and the placement map's
   * "Requires 480 GB", both of which are defensible display values set in a
   * proportional face.
   *
   * Byte alignment stays available as an author choice through
   * `valueStyle: "technical"`, which is where a designer asks for it.
   *
   * The hash pattern needs a digit, so ordinary words are not mistaken for hex.
   */
  const MACHINE_DATA = [
    /\b\d{1,3}(?:\.\d{1,3}){3}\b/, //                                   10.0.0.14
    /\b\d+(?:\.\d+)?\s?(?:ms|µs|us|ns)\b/, //                          240ms
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    /\b(?=[0-9a-f]{8,}\b)(?=[a-f0-9]*\d)[a-f0-9]{8,}\b/i,
  ];
  const looksMachine = (s: string): boolean => MACHINE_DATA.some((re) => re.test(s));

  /** A face that sets digits and identifiers on a fixed pitch. */
  const isMonoFace = (s: string | undefined): boolean =>
    typeof s === "string" && /mono|menlo|consolas|courier|jetbrains|code/i.test(s);

  let machineDataInProportionalFace = 0;
  for (const node of ir.content) {
    if (node.kind === "text") {
      const spec = node as { text?: string; role?: string; family?: string };
      if (!spec.text || !looksMachine(spec.text)) continue;
      if (spec.role === "code" || isMonoFace(spec.family)) continue;
      machineDataInProportionalFace += 1;
      continue;
    }
    if (node.kind !== "component") continue;
    const props = (node.props ?? {}) as Record<string, unknown>;
    // A metric card marks its value technical to opt into the mono face.
    if (props.valueStyle === "technical" || isMonoFace(props.family as string | undefined)) continue;
    for (const key of ["value", "label"]) {
      const v = props[key];
      if (typeof v === "string" && looksMachine(v)) {
        machineDataInProportionalFace += 1;
        break;
      }
    }
  }

  /**
   * A selected item that differs from its neighbours only in colour.
   *
   * Fails the user twice: a glance cannot find it, and anyone who cannot
   * separate the hues cannot see it at all. Selection has to survive being
   * greyscale, which means something other than fill has to move too.
   */
  let ambiguousSelections = 0;
  const SELECTABLE = new Set(["navItem", "modelRow", "deviceNode", "tab"]);
  const NON_COLOUR_SIGNAL = ["indicator", "icon", "marker", "badge", "stateLabel", "check", "caret"];
  for (const node of ir.content) {
    if (node.kind !== "component" || !node.type || !SELECTABLE.has(node.type)) continue;
    const props = (node.props ?? {}) as Record<string, unknown>;
    const state = typeof props.state === "string" ? props.state.toLowerCase() : props.active === true ? "active" : "";
    if (state !== "active" && state !== "selected") continue;
    // The navItem emitter raises the label to weight 600 when a nav item is
    // active, so an active nav item differs by more than its fill and is not a
    // colour-only selection. Reading the program rather than the emitted result,
    // that guarantee is invisible here — it is a property of the component, not
    // of anything the program wrote — so it is accounted for explicitly rather
    // than by trusting every future emitter to do the same thing.
    if (node.type === "navItem") continue;
    const carriesSignal = NON_COLOUR_SIGNAL.some((k) => props[k] !== undefined) || typeof props.weight === "number";
    if (!carriesSignal) ambiguousSelections += 1;
  }

  return {
    composition: resolved.composition,
    source: "program",
    resolved: ir.regions.length > 0,
    ...(ir.regions.length === 0 ? { unresolvedReason: "the program declared no regions, so there is nothing to guard" } : {}),
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
      dominantActions,
      machineDataInProportionalFace,
      ambiguousSelections,
    },
  };
}