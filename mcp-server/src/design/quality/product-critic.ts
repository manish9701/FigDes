/**
 * Product critic (blueprint §7.3).
 *
 * Until now "product fit" in this repository was an alias for the composition
 * score — the same number wearing two hats — which meant a screen could score
 * well on composition while failing every question a product owner would ask.
 * This is the independent evaluator the blueprint asks for.
 *
 * It answers nine questions about the *screen as a product surface*:
 * can the primary action be identified, is the required information present and
 * ordered, are consequences clear, is the language domain-appropriate, are
 * states legible, is there enough content to decide, does it solve the stated
 * workflow, are metrics interpretable (units + context + freshness), and does
 * the screen distinguish facts from estimates and recommendations?
 *
 * Every check produces evidence-bound `DesignFinding`s. A check that cannot be
 * measured returns PENDING rather than guessing — see §7.4's `notChecked`
 * discipline, applied here too.
 */
import { makeFinding, type DesignFinding } from "./finding";

export interface ProductAction {
  label: string;
  /** Visual/prominence rank: how strongly the screen foregrounds this action. */
  prominence: "primary" | "secondary" | "tertiary";
  consequence?: string;
  destructive?: boolean;
  /** True when the screen states what happens, or confirms before acting. */
  explainsConsequence?: boolean;
}

export interface ProductMetric {
  label: string;
  value?: string;
  unit?: string;
  /** e.g. "last 15 min", "24h", "since 09:00". */
  timeRange?: string;
  /** e.g. "updated 12s ago", "stale". */
  freshness?: string;
}

export interface ProductClaim {
  text: string;
  kind: "fact" | "estimate" | "recommendation" | "mock";
}

export interface ProductCriticInput {
  /** Revision this screen is being judged at. Bound into every finding. */
  revisionId: string;
  /** What the screen must let the user do (from the brief). */
  screenGoal?: string;
  actions?: ProductAction[];
  /** Content the decision requires, in priority order. */
  requiredContent?: Array<{ id: string; label: string; priority: "critical" | "important" | "secondary" | "optional" }>;
  /** Content actually rendered, in reading order. */
  presentContent?: Array<{ id: string; label: string }>;
  metrics?: ProductMetric[];
  /** States the screen actually represents. */
  states?: string[];
  /** States the task genuinely requires (empty, error, stale, disconnected…). */
  requiredStates?: string[];
  /** Domain vocabulary that must appear for the labels to read as this product. */
  domainVocabulary?: string[];
  claims?: ProductClaim[];
  /** True only when a real telemetry/data source is connected. */
  liveDataConnected?: boolean;
  /** Terms that would imply live data (device discovery, live usage…). */
  liveImplyingTerms?: string[];
  /** Labels as rendered, for domain-language checking. */
  renderedLabels?: string[];
}

export interface ProductCriticReport {
  findings: DesignFinding[];
  /** Checks that actually ran. */
  checked: string[];
  /** Checks that could not be measured from what was supplied. */
  notChecked: string[];
  summary: string;
}

const NOISE = new Set(["the", "and", "for", "with", "this", "that", "from", "your", "a", "an", "of", "to", "in", "on", "at", "is", "are", "be"]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !NOISE.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function ev(revisionId: string, reference: string, details: string) {
  return [{ type: "requirement" as const, revisionId, reference, details }];
}

/**
 * Checks 1, 2, 6 and 8 live here because they share the same inputs: if the
 * content inventory is unknown the honest answer is PENDING, not "fine".
 */
export function evaluateProductCritic(input: ProductCriticInput): ProductCriticReport {
  const findings: DesignFinding[] = [];
  const checked: string[] = [];
  const notChecked: string[] = [];
  const rev = input.revisionId;

  /* -- 1. Can the user identify the primary task and action? ---------------- */
  if (!input.actions || input.actions.length === 0) {
    notChecked.push("primary-action-identification: no actions were supplied");
  } else {
    checked.push("primary-action-identification");
    const primary = input.actions.filter((a) => a.prominence === "primary");
    if (primary.length === 0) {
      const top = input.actions[0];
      findings.push(
        makeFinding({
          ruleId: "product.primary-action-missing",
          category: "product",
          severity: "high",
          confidence: 0.75,
          summary: "No action is presented as the primary one",
          rationale: `A screen exists to enable a job, so exactly one action should read as the way to do it. Actions found: ${input.actions.map((a) => a.label).join(", ") || "none"}. Without a primary action the user cannot tell what the screen is for.`,
          evidence: ev(rev, top ? top.label : "actions", `${input.actions.length} action(s), 0 marked primary`),
          suggestedFix: "Promote one action to primary prominence and demote or group the rest as secondary.",
          verification: "Re-render and confirm exactly one action reads as primary and matches the brief's primary task.",
        }),
      );
    } else if (primary.length > 1) {
      findings.push(
        makeFinding({
          ruleId: "product.primary-action-ambiguous",
          category: "product",
          severity: "medium",
          confidence: 0.7,
          summary: `${primary.length} competing primary actions`,
          rationale: `Competing primaries (${primary.map((a) => a.label).join(", ")}) split attention; the screen's job becomes guesswork.`,
          evidence: ev(rev, primary.map((a) => a.label).join(", "), `${primary.length} primary actions`),
          suggestedFix: "Keep one primary; move the rest into a secondary group.",
          verification: "Re-render and confirm a single dominant action.",
        }),
      );
    }
  }

  /* -- 2. Is the required information present and ordered correctly? -------- */
  if (!input.requiredContent || input.requiredContent.length === 0) {
    notChecked.push("required-information-present: no content inventory was supplied");
  } else if (!input.presentContent) {
    notChecked.push("required-information-present: no rendered content list was supplied");
  } else {
    checked.push("required-information-present");
    const present = new Map(input.presentContent.map((c) => [c.id, c.label]));
    const missing = input.requiredContent.filter((c) => !present.has(c.id) && c.priority === "critical");
    if (missing.length > 0) {
      findings.push(
        makeFinding({
          ruleId: "product.required-content-missing",
          category: "product",
          severity: "critical",
          confidence: 0.85,
          summary: `Critical content missing: ${missing.map((m) => m.label).join(", ")}`,
          rationale: "The brief marks this content critical to the decision, and it is not on the screen. The user cannot complete the task without it.",
          evidence: ev(rev, missing.map((m) => m.id).join(","), `missing ${missing.length} of ${input.requiredContent.length} critical items`),
          suggestedFix: `Add the missing critical region(s): ${missing.map((m) => m.label).join(", ")}.`,
          verification: "Re-render and confirm every critical inventory item is present.",
        }),
      );
    }
    // Ordering: critical content must appear before supporting content.
    const order = input.presentContent.map((c) => c.id);
    const firstOptional = order.findIndex((id) => input.requiredContent!.find((c) => c.id === id)?.priority === "optional");
    const lastCritical = order.map((id) => input.requiredContent!.find((c) => c.id === id)?.priority).lastIndexOf("critical");
    if (firstOptional !== -1 && lastCritical > firstOptional) {
      findings.push(
        makeFinding({
          ruleId: "product.information-order-wrong",
          category: "product",
          severity: "medium",
          confidence: 0.65,
          summary: "Optional content precedes critical content",
          rationale: "Reading order puts lower-priority material ahead of what the decision requires, so hierarchy does not match importance.",
          evidence: ev(rev, "reading-order", `optional at position ${firstOptional + 1}, last critical at ${lastCritical + 1}`),
          suggestedFix: "Reorder so critical content is encountered first.",
          verification: "Confirm the rendered reading order matches the brief's priority order.",
        }),
      );
    }
  }

  /* -- 3. Are the consequences of primary actions clear? -------------------- */
  if (!input.actions || input.actions.length === 0) {
    notChecked.push("action-consequence-clarity: no actions were supplied");
  } else {
    checked.push("action-consequence-clarity");
    for (const action of input.actions) {
      if (action.prominence !== "primary") continue;
      const explains = action.explainsConsequence === true || (action.consequence !== undefined && action.consequence.trim().length > 0);
      if (!explains) {
        const severity = action.destructive ? "critical" : "medium";
        findings.push(
          makeFinding({
            ruleId: action.destructive ? "product.destructive-action-unconfirmed" : "product.consequence-unclear",
            category: "product",
            severity,
            confidence: 0.7,
            summary: `Primary action "${action.label}" does not state its consequence`,
            rationale: action.destructive
              ? "A destructive primary action with no stated consequence invites irreversible mistakes."
              : "The user cannot predict what the screen's main action will do before committing to it.",
            evidence: ev(rev, action.label, action.destructive ? "destructive, no consequence text, no confirmation" : "primary, no consequence text"),
            suggestedFix: action.destructive
              ? "Add a confirmation step that names what will be destroyed or changed."
              : "Label the outcome, or show a confirmation preview of what changes.",
            verification: "Re-render and confirm the consequence is stated before the action commits.",
          }),
        );
      }
    }
  }

  /* -- 4. Do labels use domain-appropriate language? ------------------------ */
  if (!input.domainVocabulary || input.domainVocabulary.length === 0 || !input.renderedLabels) {
    notChecked.push("domain-language: no vocabulary or rendered labels supplied");
  } else {
    checked.push("domain-language");
    const used = new Set<string>();
    for (const label of input.renderedLabels) for (const w of words(label)) used.add(w);
    const overlap = input.domainVocabulary.filter((term) => words(term).size > 0 && [...words(term)].some((w) => used.has(w)));
    if (overlap.length === 0) {
      findings.push(
        makeFinding({
          ruleId: "product.language-off-domain",
          category: "product",
          severity: "medium",
          confidence: 0.55,
          summary: "None of the product's domain terms appear on screen",
          rationale: `The screen belongs to a product whose vocabulary includes ${input.domainVocabulary.slice(0, 5).join(", ")}, yet none of it is used. Labels read as generic filler rather than as this product.`,
          evidence: ev(rev, "vocabulary", `expected ${input.domainVocabulary.length} term(s), matched 0`),
          suggestedFix: "Use the product's own nouns for the entities on screen.",
          verification: "Re-render and confirm the domain terms appear in the labels.",
        }),
      );
    }
  }

  /* -- 5. Are system states and failures understandable? -------------------- */
  if (!input.requiredStates) {
    notChecked.push("system-states: no required-state list was supplied");
  } else {
    checked.push("system-states");
    const present = new Set((input.states ?? []).map((s) => s.toLowerCase()));
    const missing = input.requiredStates.filter((s) => !present.has(s.toLowerCase()));
    if (missing.length > 0) {
      const severity = missing.some((s) => /error|fail|critical|down/.test(s)) ? "high" : "medium";
      findings.push(
        makeFinding({
          ruleId: "product.state-missing",
          category: "product",
          severity,
          confidence: 0.75,
          summary: `Required states not represented: ${missing.join(", ")}`,
          rationale: "A screen that only shows the happy path misleads exactly when the user needs it most. These states are part of the task, not decoration.",
          evidence: ev(rev, missing.join(","), `represented: ${[...present].join(", ") || "none"}`),
          suggestedFix: `Represent ${missing.slice(0, 4).join(", ")} — at minimum as a documented variant of the affected component.`,
          verification: "Confirm the state variants exist in the Figma file, not only in a note.",
        }),
      );
    }
  }

  /* -- 7. Does the screen solve the requested workflow? ---------------------- */
  if (!input.screenGoal) {
    notChecked.push("workflow-fit: no screen goal was supplied");
  } else {
    checked.push("workflow-fit");
    const goalWords = words(input.screenGoal);
    const screenWords = new Set<string>();
    for (const label of input.renderedLabels ?? []) for (const w of words(label)) screenWords.add(w);
    const labelOverlap = jaccard(goalWords, screenWords);
    if (labelOverlap < 0.08 && (input.renderedLabels ?? []).length > 0) {
      findings.push(
        makeFinding({
          ruleId: "product.workflow-unaddressed",
          category: "product",
          severity: "medium",
          confidence: 0.5,
          summary: "Screen language barely overlaps the stated goal",
          rationale: `The brief asks the screen to "${input.screenGoal}", but the rendered labels share almost no vocabulary with it (${labelOverlap.toFixed(2)} Jaccard). This is a signal the screen drifted toward a template rather than the task.`,
          evidence: ev(rev, input.screenGoal, `label/goal vocabulary overlap ${labelOverlap.toFixed(2)}`),
          suggestedFix: "Re-check the composition against the goal, or reword labels in the task's own language.",
          verification: "Re-render and confirm the labels speak the goal's vocabulary.",
        }),
      );
    }
  }

  /* -- 8. Are metrics interpretable (units, context, freshness)? ----------- */
  if (!input.metrics) {
    notChecked.push("metric-interpretability: no metrics were supplied");
  } else if (input.metrics.length === 0) {
    checked.push("metric-interpretability");
    notChecked.push("metric-interpretability: the screen shows numbers outside any instrumented metric model");
  } else {
    checked.push("metric-interpretability");
    for (const metric of input.metrics) {
      const bare = /\d/.test(metric.value ?? "");
      if (!bare) continue;
      const gaps: string[] = [];
      if (!metric.unit || metric.unit.trim().length === 0) gaps.push("no unit");
      if (!metric.timeRange) gaps.push("no time range");
      if (!metric.freshness) gaps.push("no freshness");
      if (gaps.length > 0) {
        findings.push(
          makeFinding({
            ruleId: "product.metric-uninterpretable",
            category: "product",
            severity: gaps.length === 3 ? "high" : "medium",
            confidence: 0.8,
            summary: `Metric "${metric.label}" is uninterpretable (${gaps.join(", ")})`,
            rationale: "A number without units, a window and a freshness marker cannot be judged, so it is decoration rather than evidence.",
            evidence: ev(rev, metric.label, `value="${metric.value ?? ""}" ${gaps.join("; ")}`),
            suggestedFix: `Show unit, time range and an "updated …" marker for ${metric.label}.`,
            verification: "Confirm the rendered label carries unit, window and freshness.",
          }),
        );
      }
    }
  }

  /* -- 9. Facts vs estimates vs recommendations (and §9 live-data honesty) -- */
  if (!input.claims) {
    notChecked.push("claim-typing: no claim annotations were supplied");
  } else {
    checked.push("claim-typing");
    const untyped = input.claims.filter((c) => !["fact", "estimate", "recommendation", "mock"].includes(c.kind));
    if (untyped.length > 0) {
      findings.push(
        makeFinding({
          ruleId: "product.claim-untyped",
          category: "product",
          severity: "medium",
          confidence: 0.6,
          summary: `${untyped.length} claim(s) do not say whether they are fact, estimate or recommendation`,
          rationale: "Presenting an inference as an observation is how a design misleads its user. Recommendations in particular must explain their criteria.",
          evidence: ev(rev, untyped.map((c) => c.text).join(", ").slice(0, 120), `${untyped.length} untyped claim(s)`),
          suggestedFix: "Label recommendations and estimates visibly, and state the criteria behind any recommendation.",
          verification: "Confirm every recommendation names its basis.",
        }),
      );
    }
  }

  if (input.liveDataConnected === false) {
    checked.push("live-data-honesty");
    const labels = (input.renderedLabels ?? []).join(" ").toLowerCase();
    const leaks = (input.liveImplyingTerms ?? []).filter((t) => labels.includes(t.toLowerCase()));
    if (leaks.length > 0) {
      findings.push(
        makeFinding({
          ruleId: "product.claims-live-data-without-source",
          category: "product",
          severity: "critical",
          confidence: 0.8,
          summary: `Screen implies live data (${leaks.join(", ")}) with no connected source`,
          rationale: "No data source is connected to this design. Labelling placeholder values as live discovery or live telemetry misrepresents what exists.",
          evidence: ev(rev, leaks.join(","), `liveDataConnected=false; terms found in rendered labels`),
          suggestedFix: "Mark illustrative values as sample/demo data, or remove the live-sounding wording.",
          verification: "Confirm every value that is not live is visibly labelled as such.",
        }),
      );
    }
  } else if (input.liveDataConnected === undefined) {
    notChecked.push("live-data-honesty: live-data provenance not declared");
  } else {
    checked.push("live-data-honesty");
  }

  const blocking = findings.filter((f) => f.severity === "critical").length;
  const summary =
    findings.length === 0
      ? checked.length === 0
        ? "Nothing could be evaluated: no product facts were supplied."
        : `${checked.length} product check(s) passed; ${notChecked.length} not evaluable from the supplied facts.`
      : `${findings.length} product finding(s) (${blocking} critical) across ${new Set(findings.map((f) => f.ruleId)).size} rule(s); ${notChecked.length} check(s) not evaluable.`;

  return { findings, checked, notChecked, summary };
}
