/**
 * Stage 6 — structural verification (issue #16, §Stage 6).
 *
 * ## The rule this module exists to enforce
 *
 * **A successful operation is not a verified screen.**
 *
 * The Figma plugin can report that it created sixty nodes and still have
 * produced a screen with a region outside the canvas, a metric that overflows
 * its card, a primary action that was never drawn, or a chart that landed in
 * the wrong place. Every one of those is a successful transaction. So
 * verification is a separate stage with its own checks, and it runs against the
 * *resolved geometry* rather than against the operation log.
 *
 * And when verification cannot see anything — an empty inspection, a stale
 * render, a scope that turned out to be ambiguous — the answer is
 * `indeterminate`, never `pass`. A check that did not run is not a check that
 * passed.
 */
import type { MetricsReport } from "../../../shared/protocol";
import type { CompositionPlan, NormalizedBrief, PipelineCheck, PipelineFinding } from "./contracts";

/** What the compiler produced, as far as verification cares. */
export interface CompiledProgram {
  ir: {
    canvas: { name: string; width: number; height: number; grid: number };
    regions: Array<{ id: string; role: string; width: unknown; height: unknown; grow: number; layout: string; children: string[] }>;
    content: Array<{ id: string; kind: string; type?: string; parent?: string; text?: string }>;
  };
  operations: unknown[];
  violations: Array<{ rule: string; message: string }>;
  applicable: boolean;
  inapplicableReasons: string[];
  boxes: Map<string, { id: string; x: number; y: number; w: number; h: number }>;
  productGuard?: { verdict: string; rulesChecked: number; failures: number; warnings: number; manual: number };
}

function humanize(id: string): string {
  return id
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function findingId(rule: string, index: number): string {
  return `${rule}-${String(index + 1).padStart(2, "0")}`;
}

/**
 * Verifies the plan against the compiled program.
 *
 * This is the offline half: it can run without Figma, which is what makes it
 * usable as a pre-flight gate rather than a post-mortem.
 */
export function verifyPlan(
  plan: CompositionPlan,
  brief: NormalizedBrief,
  compiled: CompiledProgram,
  programLabels: string[],
): { checks: PipelineCheck[]; findings: PipelineFinding[]; status: "pass" | "fail" | "review" | "indeterminate" } {
  const checks: PipelineCheck[] = [];
  const findings: PipelineFinding[] = [];

  /* --- 1. the planned regions exist -------------------------------------- */

  const builtIds = new Set(compiled.ir.regions.map((r) => r.id));
  const missing = plan.regions.map((r) => r.id).filter((id) => !builtIds.has(id));
  checks.push({
    id: "regions-built",
    question: "Was every planned region built?",
    status: missing.length === 0 ? "pass" : "fail",
    detail:
      missing.length === 0
        ? `${plan.regions.length} region(s) built: ${plan.regions.map((r) => r.id).join(", ")}.`
        : `Not built: ${missing.join(", ")}.`,
    nodeIds: missing,
  });
  if (missing.length > 0) {
    findings.push({
      id: findingId("regions-missing", 0),
      stage: "structure",
      severity: "critical",
      confidence: 1,
      nodeIds: missing,
      summary: `The plan called for ${missing.length} region(s) the build did not create.`,
      why: "A region that is planned but not built is a hole in the composition: the screen will read as unfinished in exactly the place the plan promised content.",
      evidence: { kind: "plan", detail: `missing: ${missing.join(", ")}` },
      fix: "Re-run the build for the missing regions, or remove them from the plan.",
      automatable: true,
    });
  }

  /* --- 2. everything is on the canvas ------------------------------------ */

  const offscreen = plan.regions.filter(
    (r) => r.bounds.x < -1 || r.bounds.y < -1 || r.bounds.x + r.bounds.w > plan.canvas.width + 1 || r.bounds.y + r.bounds.h > plan.canvas.height + 1,
  );
  checks.push({
    id: "regions-on-canvas",
    question: "Is every region inside the canvas?",
    status: offscreen.length === 0 ? "pass" : "fail",
    detail:
      offscreen.length === 0
        ? `All ${plan.regions.length} region(s) are within the ${plan.canvas.width}x${plan.canvas.height} canvas.`
        : offscreen.map((r) => `${r.id} at (${Math.round(r.bounds.x)}, ${Math.round(r.bounds.y)}) ${Math.round(r.bounds.w)}x${Math.round(r.bounds.h)}`).join("; "),
    nodeIds: offscreen.map((r) => r.id),
  });
  for (const [i, r] of offscreen.entries()) {
    findings.push({
      id: findingId("region-off-canvas", i),
      stage: "structure",
      severity: "critical",
      confidence: 1,
      nodeIds: [r.id],
      summary: `Region '${r.id}' lies outside the canvas.`,
      why: "A region that is not on the canvas is not on the screen. The user cannot see it, however successful the transaction was.",
      evidence: { kind: "geometry", detail: `${r.id} at (${Math.round(r.bounds.x)}, ${Math.round(r.bounds.y)}) ${Math.round(r.bounds.w)}x${Math.round(r.bounds.h)} on a ${plan.canvas.width}x${plan.canvas.height} canvas` },
      fix: "Reduce the region's declared size or the number of regions so the shell fits the canvas.",
      automatable: false,
    });
  }

  /* --- 3. nothing is zero-sized ------------------------------------------ */

  const collapsed = plan.regions.filter((r) => r.bounds.w <= 0 || r.bounds.h <= 0);
  checks.push({
    id: "no-collapsed-regions",
    question: "Does every region have a real size?",
    status: collapsed.length === 0 ? "pass" : "fail",
    detail: collapsed.length === 0 ? "No region collapsed to zero." : collapsed.map((r) => r.id).join(", "),
    nodeIds: collapsed.map((r) => r.id),
  });
  for (const [i, r] of collapsed.entries()) {
    findings.push({
      id: findingId("region-collapsed", i),
      stage: "structure",
      severity: "high",
      confidence: 1,
      nodeIds: [r.id],
      summary: `Region '${r.id}' has no area.`,
      why: "A zero-sized region is either invisible or a sliver, and its content has nowhere to go.",
      evidence: { kind: "geometry", detail: `${r.id} is ${Math.round(r.bounds.w)}x${Math.round(r.bounds.h)}` },
      fix: "Give the region a size, or remove it.",
      automatable: false,
    });
  }

  /* --- 4. the content the brief required is on the screen ---------------- */

  const labels = programLabels.map((l) => l.toLowerCase());
  const missingItems = brief.requiredInformation.filter((item) => !labels.some((l) => l.includes(item.toLowerCase())));
  checks.push({
    id: "required-information-present",
    question: "Is every piece of required information on the screen?",
    status: missingItems.length === 0 ? "pass" : "fail",
    detail: missingItems.length === 0 ? `All ${brief.requiredInformation.length} required item(s) are present.` : `Missing: ${missingItems.join(", ")}.`,
    nodeIds: [],
  });
  for (const [i, item] of missingItems.entries()) {
    findings.push({
      id: findingId("required-information-missing", i),
      stage: "structure",
      severity: "high",
      confidence: 0.9,
      nodeIds: [],
      summary: `Required information '${item}' is not on the screen.`,
      why: "The brief says the screen cannot work without it. A screen that works without it is a different screen.",
      evidence: { kind: "brief", detail: `required: ${item}` },
      fix: `Add '${item}' to the plan's content, in the region that serves it.`,
      automatable: true,
    });
  }

  /* --- 5. the primary action is on the screen ---------------------------- */

  if (brief.primaryAction !== null) {
    const present = labels.some((l) => l.includes(brief.primaryAction!.toLowerCase()));
    checks.push({
      id: "primary-action-present",
      question: "Is the primary action on the screen?",
      status: present ? "pass" : "fail",
      detail: present ? `'${brief.primaryAction}' is present.` : `'${brief.primaryAction}' is not on the screen.`,
      nodeIds: [],
    });
    if (!present) {
      findings.push({
        id: "primary-action-missing",
        stage: "structure",
        severity: "critical",
        confidence: 0.9,
        nodeIds: [],
        summary: `The primary action '${brief.primaryAction}' was not built.`,
        why: "Without the action the screen is a report, and the user's task cannot be completed here.",
        evidence: { kind: "brief", detail: `primary action: ${brief.primaryAction}` },
        fix: "Add the action to the header region.",
        automatable: true,
      });
    }
  }

  /* --- 6. there is something to look at first ---------------------------- */

  checks.push({
    id: "focal-present",
    question: "Is there a first thing to look at?",
    status: plan.focal !== null ? "pass" : "review",
    detail:
      plan.focal !== null
        ? `The focal region is '${plan.focal.id}': ${plan.focal.why}`
        : "No region earns focal status, so the screen has no entry point for the eye.",
    nodeIds: plan.focal !== null ? [plan.focal.id] : [],
  });
  if (plan.focal === null) {
    findings.push({
      id: "focal-missing",
      stage: "plan",
      severity: "medium",
      confidence: 0.7,
      nodeIds: [],
      summary: "No region is marked as the focal point.",
      why: "A screen without a focal region reads as a set of equal panels, which is the shape the product rules forbid.",
      evidence: { kind: "plan", detail: "no focal region in the art direction" },
      fix: "Name the region that carries the primary task, and size it accordingly.",
      automatable: false,
    });
  }

  /* --- 7. the canvas is used, and not wasted ------------------------------ */

  const usage = plan.usage;
  const usageOk = usage.coverage >= 0.55 && usage.largestEmptyBand <= 0.25;
  checks.push({
    id: "canvas-usage",
    question: "Does the composition use the canvas it was given?",
    status: usageOk ? "pass" : "review",
    detail: `coverage ${Math.round(usage.coverage * 100)}%, largest empty band ${Math.round(usage.largestEmptyBand * 100)}%, focal share ${Math.round(usage.focalShare * 100)}%.`,
    nodeIds: [],
  });
  for (const [i, note] of usage.notes.entries()) {
    findings.push({
      id: findingId("canvas-usage", i),
      stage: "plan",
      severity: "medium",
      confidence: 0.6,
      nodeIds: [],
      summary: note,
      why: "Canvas that is neither used nor explained reads as an unfinished composition.",
      evidence: { kind: "geometry", detail: `coverage ${Math.round(usage.coverage * 100)}%, empty band ${Math.round(usage.largestEmptyBand * 100)}%` },
      fix: "Give the space to the primary region, or state that the emptiness is deliberate.",
      automatable: false,
    });
  }

  /* --- 8. the compiler's own geometry findings ---------------------------- */

  const geometryViolations = compiled.violations.filter((v) => v.rule !== "identity");
  checks.push({
    id: "compiled-geometry",
    question: "Does the resolved geometry agree with the program?",
    status: geometryViolations.length === 0 ? "pass" : "fail",
    detail: geometryViolations.length === 0 ? "No geometry violations." : geometryViolations.map((v) => `${v.rule}: ${v.message}`).join(" | "),
    nodeIds: [],
  });
  for (const [i, v] of geometryViolations.entries()) {
    findings.push({
      id: findingId(`violation-${v.rule}`, i),
      stage: "structure",
      severity: v.rule === "operation-trace" || v.rule === "connector" ? "high" : "medium",
      confidence: 0.8,
      nodeIds: [],
      summary: v.message,
      why: "The compiler measured this as a disagreement between what was asked for and what the geometry resolves to.",
      evidence: { kind: "rule", detail: `rule: ${v.rule}` },
      fix: "Adjust the program so the geometry resolves as intended.",
      automatable: false,
    });
  }

  /* --- 9. the auto-layout containers were really applied ------------------ */

  const autoRegions = plan.regions.filter((r) => r.autoLayout);
  const ops = compiled.operations as Array<Record<string, unknown>>;
  const autoApplied = autoRegions.filter((r) =>
    ops.some((o) => o["type"] === "createFrame" && o["id"] === r.id && o["layoutMode"] === "VERTICAL"),
  );
  const autoMissing = autoRegions.filter((r) => !autoApplied.includes(r));
  checks.push({
    id: "auto-layout-applied",
    question: "Were the auto-layout containers actually created as auto-layout frames?",
    status: autoMissing.length === 0 ? "pass" : "fail",
    detail:
      autoRegions.length === 0
        ? "This screen has no region whose content could be handed to Figma's own layout."
        : autoMissing.length === 0
          ? `${autoApplied.length} region(s) built as native auto-layout containers.`
          : `Not applied: ${autoMissing.map((r) => r.id).join(", ")}.`,
    nodeIds: autoMissing.map((r) => r.id),
  });
  for (const [i, r] of autoMissing.entries()) {
    findings.push({
      id: findingId("auto-layout-not-applied", i),
      stage: "structure",
      severity: "medium",
      confidence: 0.8,
      nodeIds: [r.id],
      summary: `Region '${r.id}' was planned as an auto-layout container but was built with absolute placement.`,
      why: "A container that is not a container cannot be re-laid-out by a designer, and the plan promised it would be.",
      evidence: { kind: "plan", detail: `region ${r.id} planned as auto-layout` },
      fix: "Remove the text from the region, or accept the absolute placement and update the plan.",
      automatable: false,
    });
  }

  /* --- 10. the plan and the build agree on the geometry ------------------- */

  // The plan is a preview, and a preview that lies about the numbers trains
  // the reader to distrust it. A region whose content needed more room than
  // the plan gave it grows in the build; that is a real difference between the
  // two, and it is reported rather than smoothed over.
  const drifted: string[] = [];
  for (const region of plan.regions) {
    const box = compiled.boxes.get(region.id);
    if (box === undefined) continue;
    const dw = Math.abs(Math.round(box.w) - Math.round(region.bounds.w));
    const dh = Math.abs(Math.round(box.h) - Math.round(region.bounds.h));
    if (dw > 4 || dh > 4) drifted.push(`${region.id}: planned ${Math.round(region.bounds.w)}x${Math.round(region.bounds.h)}, built ${Math.round(box.w)}x${Math.round(box.h)}`);
  }
  checks.push({
    id: "plan-matches-build",
    question: "Does the built geometry match the plan?",
    status: drifted.length === 0 ? "pass" : "review",
    detail: drifted.length === 0 ? "Every region resolved to the size the plan promised." : drifted.join("; "),
    nodeIds: [],
  });
  for (const [i, note] of drifted.entries()) {
    findings.push({
      id: findingId("plan-geometry-drift", i),
      stage: "plan",
      severity: "medium",
      confidence: 0.9,
      nodeIds: [],
      summary: `The build did not produce the geometry the plan promised: ${note}.`,
      why: "A region that had to grow to hold its content means the plan's share of the canvas was wrong, and every region below it moved.",
      evidence: { kind: "geometry", detail: note },
      fix: "Give the region the room its content needs, or reduce what it holds.",
      automatable: false,
    });
  }

  /* --- 11. the information that did not fit ------------------------------- */

  for (const [i, item] of plan.notPlaced.entries()) {
    findings.push({
      id: findingId("information-not-placed", i),
      stage: "plan",
      severity: item.why.includes("more than the canvas can hold") ? "high" : "info",
      confidence: 1,
      nodeIds: [],
      summary: `'${item.label}' is not on the screen.`,
      why: item.why,
      evidence: { kind: "plan", detail: item.why },
      fix: item.why.includes("more than the canvas can hold")
        ? "Reduce the number of regions or items, or ask for a larger viewport."
        : "Nothing to fix: supporting information was left out on purpose.",
      automatable: false,
    });
  }
  if (plan.notPlaced.length > 0) {
    checks.push({
      id: "information-placed",
      question: "Did everything the brief asked for fit on the screen?",
      status: plan.notPlaced.some((n) => n.why.includes("more than the canvas can hold")) ? "fail" : "review",
      detail:
        plan.notPlaced.length === 0
          ? "Everything the brief named is on the screen."
          : plan.notPlaced.map((n) => `${n.label} (${n.why})`).join("; "),
      nodeIds: [],
    });
  }

  /* --- 11. the content fills the region it was given ---------------------- */

  // A region that was given a thousand pixels and filled two hundred of them
  // is not a dense screen; it is a screen with a hole in it. The live render
  // of the stress frame is what made this worth measuring: every structural
  // check passed, and the screen was sixty percent empty.
  const underfilled: string[] = [];
  for (const region of plan.regions) {
    const box = compiled.boxes.get(region.id);
    if (box === undefined) continue;
    const children = compiled.ir.content.filter((c) => c.parent === region.id);
    if (children.length === 0) continue;
    let bottom = -Infinity;
    for (const child of children) {
      const childBox = compiled.boxes.get(child.id);
      if (childBox === undefined) continue;
      bottom = Math.max(bottom, childBox.y + childBox.h);
    }
    if (!Number.isFinite(bottom)) continue;
    const used = bottom - box.y;
    const ratio = box.h > 0 ? used / box.h : 1;
    if (ratio < 0.55) {
      underfilled.push(
        `${region.id} holds ${children.length} item(s) in ${Math.round(box.h)}px and fills ${Math.round(ratio * 100)}% of it`,
      );
    }
  }
  checks.push({
    id: "regions-filled",
    question: "Do the regions fill the space they were given?",
    status: underfilled.length === 0 ? "pass" : "review",
    detail:
      underfilled.length === 0
        ? "Every region with content fills the space it was given."
        : underfilled.join("; "),
    nodeIds: [],
  });
  for (const [i, note] of underfilled.entries()) {
    findings.push({
      id: findingId("region-underfilled", i),
      stage: "plan",
      severity: "medium",
      confidence: 0.85,
      nodeIds: [],
      summary: `A region is mostly empty: ${note}.`,
      why: "A region with a hole in it reads as an unfinished composition. Either the region is too big for its content, or the content was placed somewhere else.",
      evidence: { kind: "geometry", detail: note },
      fix: "Give the region the content it needs, or take the space back for the region that has the work on it.",
      automatable: false,
    });
  }

  /* --- 12. the guard's verdict is carried, not swallowed ------------------ */

  if (compiled.productGuard !== undefined) {
    const verdict = compiled.productGuard.verdict;
    checks.push({
      id: "product-guard",
      question: "Does the build pass the product's own rules?",
      status: verdict === "PASS" ? "pass" : verdict === "FAIL" ? "fail" : "review",
      detail: `${verdict}: ${compiled.productGuard.rulesChecked} rule(s) checked, ${compiled.productGuard.failures} failure(s), ${compiled.productGuard.manual} needing judgement.`,
      nodeIds: [],
    });
    if (verdict === "FAIL") {
      findings.push({
        id: "product-guard-fail",
        stage: "structure",
        severity: "high",
        confidence: 0.8,
        nodeIds: [],
        summary: "The product guard failed this build.",
        why: "The guard encodes the product truths a screen must not break. A build that fails it is off-product, whatever its geometry looks like.",
        evidence: { kind: "rule", detail: `${compiled.productGuard.failures} rule failure(s)` },
        fix: "Read the guard's findings and change the composition, not the wording.",
        automatable: false,
      });
    }
  }

  /* --- 13. the build is applicable at all -------------------------------- */

  if (!compiled.applicable) {
    checks.push({
      id: "applicable",
      question: "Does the program resolve to a buildable screen?",
      status: "indeterminate",
      detail: `Not applicable: ${compiled.inapplicableReasons.join("; ")}`,
      nodeIds: [],
    });
    findings.push({
      id: "not-applicable",
      stage: "structure",
      severity: "critical",
      confidence: 1,
      nodeIds: [],
      summary: "The program does not resolve to a buildable screen.",
      why: "The geometry is not what the program asked for, so nothing about this build can be verified.",
      evidence: { kind: "rule", detail: compiled.inapplicableReasons.join("; ") },
      fix: "Fix the geometry problems and build again.",
      automatable: false,
    });
  }

  const status = statusOf(checks, findings);
  return { checks, findings, status };
}

/** The live half: what the file actually contains after the build. */
export interface LiveEvidence {
  /** The nodes the transaction created. */
  createdNodes: Array<{ temporaryId?: string; figmaNodeId?: string }>;
  /** The id of the frame the build created, when it is known. */
  rootNodeId?: string | null;
  /** The metrics of the built frame, when they could be collected. */
  metrics?: MetricsReport | null;
  /** The render, if one was produced. */
  render?: { revisionId: string | null; at: number } | null;
  /** The revision the file is at now. */
  currentRevision?: string | null;
  /** Findings from the review rules, if the rules were run. */
  ruleFindings?: Array<{
    rule: string;
    confidence: string;
    severity: string;
    message: string;
    nodeIds?: string[];
    fix?: string;
    suggestedOperations?: Array<Record<string, unknown>>;
  }>;
}

export function verifyLive(
  plan: CompositionPlan,
  evidence: LiveEvidence,
): { checks: PipelineCheck[]; findings: PipelineFinding[]; status: "pass" | "fail" | "review" | "indeterminate" } {
  const checks: PipelineCheck[] = [];
  const findings: PipelineFinding[] = [];

  /* --- did anything get built at all? ------------------------------------ */

  const created = evidence.createdNodes.filter((n) => typeof n.figmaNodeId === "string");
  if (created.length === 0) {
    // Not "pass with nothing wrong": not pass at all. An empty inspection is
    // the exact state issue #16's G13 is about.
    checks.push({
      id: "nodes-created",
      question: "Did the build create any nodes?",
      status: "indeterminate",
      detail: "The transaction reported no created nodes, so there is nothing to inspect.",
      nodeIds: [],
    });
    findings.push({
      id: "no-nodes-created",
      stage: "live",
      severity: "critical",
      confidence: 1,
      nodeIds: [],
      summary: "The build created no nodes, so the screen cannot be verified.",
      why: "An empty inspection cannot be reported as a pass. Either the transaction did nothing, or its result was lost.",
      evidence: { kind: "rule", detail: "createdNodes is empty" },
      fix: "Check the transaction's job status, then rebuild with the same transaction id once the ledger has settled.",
      automatable: false,
    });
    return { checks, findings, status: "indeterminate" };
  }

  checks.push({
    id: "nodes-created",
    question: "Did the build create any nodes?",
    status: "pass",
    detail: `${created.length} node(s) created.`,
    nodeIds: created.map((n) => n.figmaNodeId!),
  });

  /* --- does the file contain the planned regions? ------------------------- */

  const metrics = evidence.metrics ?? null;
  if (metrics === null) {
    checks.push({
      id: "live-structure",
      question: "Does the file contain the planned regions?",
      status: "indeterminate",
      detail: "The live structure could not be inspected, so it was not verified.",
      nodeIds: [],
    });
    findings.push({
      id: "live-structure-unverified",
      stage: "live",
      severity: "medium",
      confidence: 0.8,
      nodeIds: [],
      summary: "The live structure was not inspected.",
      why: "The screen was built but its structure was never read back, so 'built' is all that can be claimed.",
      evidence: { kind: "rule", detail: "no metrics were collected" },
      fix: "Collect metrics for the built frame and verify again.",
      automatable: true,
    });
  } else {
    const liveNames = new Set(metrics.nodes.map((n) => n.name.toLowerCase()));
    const missing = plan.regions.filter((r) => !liveNames.has(humanize(r.id).toLowerCase()));
    checks.push({
      id: "live-structure",
      question: "Does the file contain the planned regions?",
      status: missing.length === 0 ? "pass" : "fail",
      detail:
        missing.length === 0
          ? `All ${plan.regions.length} planned region(s) are present in the file.`
          : `Not found in the file: ${missing.map((r) => r.id).join(", ")}.`,
      nodeIds: missing.map((r) => r.id),
    });
    for (const [i, r] of missing.entries()) {
      findings.push({
        id: findingId("live-region-missing", i),
        stage: "live",
        severity: "high",
        confidence: 0.85,
        nodeIds: [],
        summary: `Region '${r.id}' is in the plan but not in the file.`,
        why: "The build and the plan disagree. One of them is lying, and the screen is what the user sees.",
        evidence: { kind: "rule", detail: `missing live region: ${r.id}` },
        fix: "Rebuild the missing region, or correct the plan.",
        automatable: true,
      });
    }
  }

  /**
   * An incomplete census is incomplete evidence, even when everything
   * collected agrees with the plan. The absence rules judge what is *absent*
   * from the scan; a scan cut off at the cap has unscanned nodes that could
   * contradict every pass it reports, so the incompleteness is a state of its
   * own rather than a footnote (issue #20).
   */
  if (metrics !== null && metrics.truncated === true) {
    checks.push({
      id: "live-scan-complete",
      question: "Did the scan see the whole built screen?",
      status: "indeterminate",
      detail: `The scan capped at ${metrics.scanBudget} node(s) after reading ${metrics.nodeCount}; the rest of the screen was not examined.`,
      nodeIds: [],
    });
    findings.push({
      id: "live-scan-truncated",
      stage: "live",
      severity: "medium",
      confidence: 0.9,
      nodeIds: [],
      summary: "The live scan was truncated before the whole screen was read.",
      why: "A truncated census fails closed: rules that judge absence cannot certify what they never read, and reporting their passes as complete would be a false pass.",
      evidence: { kind: "rule", detail: `scan cap ${metrics.scanBudget}, read ${metrics.nodeCount}` },
      fix: "Inspect the screen in sections (per region) with a higher scan budget, and verify again.",
      automatable: true,
    });
  }

  /* --- the review rules --------------------------------------------------- */

  if (evidence.ruleFindings !== undefined) {
    const high = evidence.ruleFindings.filter((f) => f.severity === "critical" || f.severity === "serious");
    checks.push({
      id: "review-rules",
      question: "Does the built screen pass the review rules?",
      status: high.length === 0 ? (evidence.ruleFindings.length > 0 ? "review" : "pass") : "fail",
      detail: `${evidence.ruleFindings.length} finding(s), ${high.length} serious or worse.`,
      nodeIds: high.flatMap((f) => f.nodeIds ?? []),
    });
    for (const [i, f] of evidence.ruleFindings.entries()) {
      findings.push({
        id: findingId(`rule-${f.rule}`, i),
        stage: "live",
        rule: f.rule,
        severity: f.severity === "critical" ? "critical" : f.severity === "serious" ? "high" : "low",
        confidence: f.confidence === "high" ? 0.9 : f.confidence === "medium" ? 0.6 : 0.3,
        nodeIds: f.nodeIds ?? [],
        summary: f.message,
        why: "The review rules measure the built screen, not the plan.",
        evidence: { kind: "rule", detail: `rule: ${f.rule}` },
        fix: f.fix ?? "Follow the rule's guidance.",
        automatable: f.confidence === "high",
        ...(f.suggestedOperations !== undefined && f.suggestedOperations.length > 0 ? { suggestedOperations: f.suggestedOperations } : {}),
      });
    }
  }

  /**
   * The rules could not run is a state of its own, not an absence of checks.
   *
   * When `runRules` threw, `ruleFindings` stays undefined — and without this
   * branch the review-rules check simply does not exist in the result, so a
   * built screen whose rule engine crashed could still aggregate to "pass"
   * through the checks that did run (issue #20). The check is recorded as
   * INDETERMINATE, which the status aggregator can never read as clean.
   */
  else if (evidence.metrics !== null && evidence.metrics !== undefined) {
    checks.push({
      id: "review-rules",
      question: "Does the built screen pass the review rules?",
      status: "indeterminate",
      detail: "The rule engine could not run over the measured screen, so the structural review of the live build did not happen.",
      nodeIds: [],
    });
    findings.push({
      id: "review-rules-unverified",
      stage: "live",
      severity: "medium",
      confidence: 0.8,
      nodeIds: [],
      summary: "The review rules could not run over the built screen.",
      why: "A rule engine that crashed is not a rule engine that found nothing. Skipping the check silently would let an unchecked screen aggregate to a pass.",
      evidence: { kind: "rule", detail: "the rule engine could not run over the collected metrics" },
      fix: "Re-run the pipeline, or review the frame with design_guard / review_design before calling it done.",
      automatable: true,
    });
  }

  /* --- the render is fresh ------------------------------------------------ */

  if (evidence.render === null || evidence.render === undefined) {
    checks.push({
      id: "render-freshness",
      question: "Was the screen rendered and reviewed?",
      status: "indeterminate",
      detail: "No render was produced, so the screen was never looked at.",
      nodeIds: [],
    });
    findings.push({
      id: "render-missing",
      stage: "visual",
      severity: "medium",
      confidence: 1,
      nodeIds: [],
      summary: "The screen was never rendered.",
      why: "Structure can be correct and the screen can still look wrong. Without a render, visual review did not happen.",
      evidence: { kind: "rule", detail: "no render evidence" },
      fix: "Render the built frame and review it.",
      automatable: true,
    });
  } else if (evidence.currentRevision !== undefined && evidence.currentRevision !== null && evidence.render.revisionId !== evidence.currentRevision) {
    checks.push({
      id: "render-freshness",
      question: "Is the render of the current screen?",
      status: "fail",
      detail: `The render is of revision ${evidence.render.revisionId ?? "unknown"}, the file is at ${evidence.currentRevision}.`,
      nodeIds: [],
    });
    findings.push({
      id: "render-stale",
      stage: "visual",
      severity: "high",
      confidence: 1,
      nodeIds: [],
      summary: "The render is of an older revision of the screen.",
      why: "A stale screenshot certifies a screen that no longer exists. This is the one way a visual check can be confidently wrong.",
      evidence: { kind: "screenshot", detail: `render ${evidence.render.revisionId ?? "unknown"} vs current ${evidence.currentRevision}` },
      fix: "Render the current revision and review that.",
      automatable: true,
    });
  } else {
    checks.push({
      id: "render-freshness",
      question: "Is the render of the current screen?",
      status: "pass",
      detail: `The render is bound to revision ${evidence.render.revisionId ?? "unknown"}.`,
      nodeIds: [],
    });
  }

  const status = statusOf(checks, findings);
  return { checks, findings, status };
}

/**
 * The status of a set of checks.
 *
 * "fail" needs a check that failed. "review" is for something that is worth a
 * human's eye. "indeterminate" is for something that could not be checked at
 * all — and it is never dressed up as a pass.
 */
export function statusOf(
  checks: PipelineCheck[],
  findings: PipelineFinding[],
): "pass" | "fail" | "review" | "indeterminate" {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "indeterminate")) return "indeterminate";
  if (findings.some((f) => f.severity === "critical" || f.severity === "high")) return "fail";
  if (findings.length > 0 || checks.some((c) => c.status === "review")) return "review";
  return "pass";
}
