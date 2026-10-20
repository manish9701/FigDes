/**
 * `design_pipeline` — the intent → plan → build → verify loop (issue #16).
 *
 * ## Why one tool
 *
 * The pieces existed: `design_brief` wrote down the why, `plan_screen` worked
 * out the where, `design_runtime` built it, `review_design` and
 * `critique_visual` checked it. What did not exist was the *link* between
 * them, and the link is what makes the difference between a screen and a
 * collection of nodes that happen to be on the same canvas.
 *
 * The link is a trace: brief → plan → operations → node ids → checks →
 * repairs → render. Every stage writes into it, and the final report is built
 * from the trace rather than from what the last call happened to return. That
 * is the only way "verified" can mean something.
 *
 * ## The order the stages run in, and why it is that order
 *
 *   1. **Normalize the brief.** A contradictory brief is refused here, before
 *      anything is created. G11's requirement, literally.
 *   2. **Plan the composition.** Regions with bounds, hierarchy, content and
 *      constraints — reviewable before it exists.
 *   3. **Build the program.** Semantic primitives, auto-layout containers
 *      where they are safe, explicit text widths, no invented numbers.
 *   4. **Verify the structure.** Against the *resolved geometry*, not the
 *      operation log.
 *   5. **Apply.** One tracked transaction, one id, one undo.
 *   6. **Verify the live screen.** Read the file back, run the rules, render.
 *   7. **Repair.** Targeted, bounded, idempotent — never a regeneration.
 *   8. **Report.** Six buckets, honestly filled.
 */
import { z } from "zod";
import type { MetricsReport, TransactionResult } from "../../../shared/protocol";
import { runRules } from "../review/rules";
import { verifyRepairs } from "../review/verdict";
import { loadMemory, projectKey } from "../memory/store";
import { runGuard, snapshotFromMetrics } from "../memory/tools";
import { contentRevision } from "../design/quality/revision";
import { guardMutation, resolveExistingResources } from "../plan/gate";
import { dispatchTransaction } from "../transaction";
import { executeRuntime } from "../runtime/interpreter";
import { measureProgramText } from "../runtime/measure";
import { reuseAdvisory, placeRootInFreeCanvas } from "../runtime/tools";
import type { Session, SessionRegistry } from "../sessions";
import { BriefInputSchema } from "./contracts";
import { normalizeBrief } from "./brief";
import { buildCompositionPlan } from "./plan";
import { buildProgram, applyMeasuredWidths } from "./program";
import { verifyLive, verifyPlan, type CompiledProgram, type LiveEvidence } from "./verify";
import { planRepairs } from "./repair";
import { buildReport } from "./report";
import type { PipelineCheck, PipelineFinding, PipelineTrace } from "./contracts";

export const DesignPipelineArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** The brief. Everything the pipeline needs to know about the screen. */
    brief: BriefInputSchema,
    /**
     * `plan` stops before Figma: the brief is normalized, the composition is
     * planned, the program is compiled and verified, and nothing is created.
     * `build` goes all the way.
     */
    mode: z.enum(["plan", "build"]).optional().describe("'plan' creates nothing; 'build' applies to Figma. Default 'build'."),
    /** Compile and verify without touching Figma, even in build mode. */
    dryRun: z.boolean().optional(),
    description: z.string().max(1000).optional(),
    /** The transaction id. Reuse it to retry safely: a retry never duplicates. */
    transactionId: z.string().max(200).optional(),
    /** Records that a human approved a change the pipeline refused. */
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    /** Render the built frame and read it back. Default true. */
    render: z.boolean().optional(),
    /** How many targeted repairs may be applied. Default 2, 0 disables. */
    repairBudget: z.number().int().min(0).max(5).optional(),
    /** How many rounds of build → verify → repair → rebuild. Default 1. */
    maxRounds: z.number().int().min(1).max(3).optional(),
  })
  .strict();

/** The trace, built as the pipeline runs. */
function newTrace(briefId: string, planId: string): PipelineTrace {
  return {
    briefId,
    planId,
    stages: [],
    operations: [],
    nodeIds: [],
    checks: [],
    findings: [],
    repairs: [],
    render: null,
  };
}

function stage(trace: PipelineTrace, name: string, detail: string, ids: string[] = []): void {
  trace.stages.push({ stage: name, at: Date.now(), detail, ids });
}

/**
 * The labels the program carries, lower-cased, so the verifier can ask
 * "is this information on the screen?" without guessing at node names.
 */
function programLabels(program: { content: Array<{ args: Record<string, unknown> }> }): string[] {
  const labels: string[] = [];
  for (const call of program.content) {
    for (const key of ["text", "label", "title", "value", "date"]) {
      const v = call.args[key];
      if (typeof v === "string" && v.length > 0) labels.push(v);
    }
  }
  return labels;
}

export async function designPipelineTool(
  session: Session | null,
  registry: SessionRegistry,
  rawArgs: unknown,
): Promise<unknown> {
  const args = DesignPipelineArgs.parse(rawArgs);
  const mode = args.mode ?? "build";
  const dryRun = args.dryRun === true;

  /* --- stage 1: the brief ------------------------------------------------ */

  const briefId = `brief_${Date.now().toString(36)}`;
  const { brief, assumptions, clarifications, blockers } = normalizeBrief(args.brief, briefId);
  const trace = newTrace(briefId, `plan_${Date.now().toString(36)}`);
  stage(trace, "brief", `Normalized the brief: ${brief.screen}.`, [briefId]);

  const blocking = blockers.filter((b) => b.severity === "blocking");
  if (blocking.length > 0) {
    // Nothing is created. The brief is contradictory, and a screen built from
    // a contradictory brief is a screen that is wrong in a way nobody can
    // point at afterwards.
    stage(trace, "brief-blocked", `${blocking.length} blocking contradiction(s) in the brief.`);
    return {
      status: "blocked",
      stage: "brief",
      brief,
      blockers,
      clarifications,
      assumptions,
      whatToFix: blocking.map((b) => `${b.message} → ${b.fix}`),
      note: "Nothing was created in Figma: the brief contradicts itself, and building it would place content the brief does not allow.",
      trace,
    };
  }

  /* --- stage 2: the plan ------------------------------------------------- */

  const plan = buildCompositionPlan(brief, trace.planId);
  stage(
    trace,
    "plan",
    `Planned ${plan.regions.length} region(s) and ${plan.content.length} content slot(s) for '${plan.canvas.name}'.`,
    plan.regions.map((r) => r.id),
  );

  /* --- stage 3 + 4: the program and the offline verification -------------- */

  const built = buildProgram(brief, plan);
  // Two passes, and the first one is for the *widths*: the column a text lands
  // in depends on the region's size, and the region's size depends on the
  // content's heights. So the first compile resolves the widths, the plugin
  // measures the text at them, and the second compile lays the screen out with
  // the heights Figma will really produce.
  const firstPass = executeRuntime(built.program) as unknown as CompiledProgram;
  const widths = new Map<string, number>();
  for (const [id, box] of firstPass.boxes) widths.set(id, box.w);
  const measured = await measureProgramText(session, built.program, widths);
  const refined = applyMeasuredWidths(built.program, firstPass.boxes);
  const compiled = (
    measured.metrics.size > 0 ? executeRuntime(refined.program, { textMetrics: measured.metrics }) : executeRuntime(refined.program)
  ) as unknown as CompiledProgram;
  const program = refined.measured > 0 ? refined.program : built.program;
  const operations = compiled.operations as Array<Record<string, unknown>>;
  trace.operations = operations.map((op) => ({
    type: String(op["type"] ?? "?"),
    ...(typeof op["id"] === "string" ? { id: op["id"] } : {}),
    ...(typeof op["parent"] === "string" ? { parent: op["parent"] } : {}),
  }));
  stage(
    trace,
    "program",
    `Compiled ${operations.length} operation(s) from ${program.regions.length} region(s); ${refined.measured} text width(s) set from the resolved layout; ${measured.measured} text height(s) measured by the plugin.`,
  );
  if (measured.failed.length > 0) {
    stage(trace, "measure", `${measured.failed.length} text measurement(s) failed: ${measured.failed.slice(0, 3).map((f) => `${f.id} (${f.reason})`).join("; ")}`);
  }

  const structure = verifyPlan(plan, brief, compiled, programLabels(program));

  // Repeated surfaces are the visible symptom of a component that should have
  // been a component. The runtime does not create instances, so the pipeline
  // reports the duplication instead of quietly shipping drifting copies.
  const reuse = reuseAdvisory(operations as Array<Record<string, unknown>>);
  trace.checks.push(...structure.checks);
  trace.findings.push(...structure.findings);
  stage(trace, "verify-structure", `Structure verified: ${structure.status} (${structure.checks.length} check(s)).`);

  const common = {
    brief,
    plan,
    program,
    programNotes: built.notes,
    ...(reuse.length > 0 ? { reuse } : {}),
    assumptions,
    clarifications,
    blockers,
    structure: {
      status: structure.status,
      checks: structure.checks,
      findings: structure.findings,
    },
  };

  if (mode === "plan" || dryRun) {
    const report = buildReport({
      planned: true,
      applied: false,
      operations: operations.length,
      nodeIds: [],
      transactionId: null,
      structure: { status: structure.status, checks: structure.checks, detail: `${structure.checks.length} structural check(s) ran against the resolved geometry.` },
      live: null,
      visual: { status: "not-run", detail: "No render was produced: nothing was built.", renderRevision: null },
      repairs: [],
      findings: structure.findings,
      blocked: [{ check: "live-structure", why: "Nothing was applied to Figma." }],
      trace,
    });
    return {
      ...common,
      status: "planned",
      dryRun: true,
      report,
      note: "Nothing was created in Figma. The plan, the program and the structural verification are ready to review.",
      trace,
    };
  }

  if (!session) {
    throw new Error(
      "A live Figma plugin is required to build. Open the Design Agent plugin in Figma, or use mode:'plan' to produce and verify the composition without connecting.",
    );
  }

  /* --- stage 5: apply ---------------------------------------------------- */

  const existing = await resolveExistingResources(session, operations);
  const gate = guardMutation({
    operations,
    approved: args.approved,
    reason: args.reason,
    dryRun,
    ...(existing !== undefined ? { existing } : {}),
  });
  if (gate) {
    stage(trace, "apply-refused", "The checkpoint gate refused the build; nothing was created.");
    return { ...common, status: "refused", gate, report: null, trace };
  }

  if (!compiled.applicable) {
    stage(trace, "apply-refused", "The program does not resolve to a buildable screen; nothing was created.");
    return {
      ...common,
      status: "blocked",
      problems: compiled.inapplicableReasons,
      note: "Nothing was created: the resolved geometry is not what the program asked for.",
      trace,
    };
  }

  // The compiler puts the root at the origin, so a screen built twice lands
  // on top of the first one. Ask the file where there is room.
  const placement = await placeRootInFreeCanvas(session, operations, {
    width: plan.canvas.width,
    height: plan.canvas.height,
  });
  if (placement !== null) stage(trace, "placement", `Placed the screen at (${placement.x}, ${placement.y}).`);

  const transactionId = args.transactionId ?? `pipe_${Date.now().toString(36)}`;
  const transaction = (await dispatchTransaction(registry, session, "create_design", {
    description: args.description ?? `Design pipeline: ${brief.screen}`,
    operations,
    transactionId,
  })) as TransactionResult;

  const createdNodes = transaction.status === "success" ? transaction.createdNodes : [];
  const nodeIds = createdNodes.map((n) => n.figmaNodeId).filter((id): id is string => typeof id === "string");
  trace.nodeIds = nodeIds;
  stage(trace, "apply", `Applied ${operations.length} operation(s); ${nodeIds.length} node(s) created.`, nodeIds);

  /* --- stage 6: verify the live screen ----------------------------------- */

  const rootNodeId = createdNodes.find((n) => n.temporaryId === "root")?.figmaNodeId ?? nodeIds[0] ?? null;
  const live = await verifyLiveScreen(session, plan, {
    createdNodes,
    rootNodeId,
    render: args.render !== false,
  });
  trace.checks.push(...live.checks);
  trace.findings.push(...live.findings);
  if (live.render !== null) trace.render = live.render;
  stage(trace, "verify-live", `Live verification: ${live.status} (${live.checks.length} check(s)).`);

  /* --- stage 7: targeted repairs ----------------------------------------- */

  const repairs: PipelineTrace["repairs"] = [];
  const budget = args.repairBudget ?? 2;
  // The findings as they were *before* the repair, so the pass can be checked
  // against them afterwards.
  const liveBeforeRepair = live.findings;
  let repairVerification: ReturnType<typeof verifyRepairs> | null = null;
  if (budget > 0) {
    const planOfRepairs = planRepairs(live.findings, { budget });
    for (const instruction of planOfRepairs.instructions) {
      if (!instruction.automatable) {
        repairs.push({ findingId: instruction.findingId, operations: instruction.operations.length, result: "skipped", detail: "The repair needs a human decision." });
        continue;
      }
      try {
        await dispatchTransaction(registry, session, "modify_design", {
          description: `Design pipeline repair: ${instruction.title}`,
          operations: instruction.operations,
          transactionId: `${transactionId}_fix_${instruction.findingId}`,
          targets: instruction.targetIds,
        });
        repairs.push({ findingId: instruction.findingId, operations: instruction.operations.length, result: "applied", detail: instruction.expectedEffect });
      } catch (err) {
        repairs.push({
          findingId: instruction.findingId,
          operations: instruction.operations.length,
          result: "failed",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
    for (const skipped of planOfRepairs.skipped) {
      repairs.push({ findingId: skipped.findingId, operations: 0, result: "skipped", detail: skipped.why });
    }
    trace.repairs.push(...repairs);
    stage(trace, "repair", `${repairs.filter((r) => r.result === "applied").length} repair(s) applied, ${repairs.filter((r) => r.result !== "applied").length} not.`);

    // A repair changes the screen, so the render taken before it no longer
    // certifies it. The screen is measured and rendered again, and the new
    // revision is what the visual bucket is bound to — a render of the screen
    // as it was *before* the fix is not evidence that the fix held.
    if (repairs.some((r) => r.result === "applied")) {
      const after = await verifyLiveScreen(session, plan, {
        createdNodes,
        rootNodeId,
        render: args.render !== false,
      });
      live.checks = [
        ...live.checks.filter((c) => c.id !== "render-freshness" && c.id !== "nodes-created" && c.id !== "live-structure" && c.id !== "review-rules"),
        ...after.checks,
      ];
      live.findings = [...live.findings, ...after.findings];
      live.status = after.status;
      live.detail = `${after.checks.length} live check(s) ran against the repaired screen.`;
      live.visual = after.visual;
      live.blocked = after.blocked;
      if (after.render !== null) trace.render = after.render;

      /**
       * The repair pass verifies itself.
       *
       * A committed repair is not a fixed defect: the operation may have hit
       * the wrong node, the measurement may not have changed, and a repair can
       * introduce a new finding. So the pass is compared against the re-measure
       * and given a verdict of its own.
       */
      const before = liveBeforeRepair.map((f) => ({
        key: `${f.rule ?? f.id}::${[...f.nodeIds].sort().join(",")}`,
        rule: f.rule ?? f.id,
        severity: f.severity,
        confidence: String(f.confidence),
        title: f.summary,
        nodeIds: [...f.nodeIds],
        evidence: { detail: f.evidence.detail },
      }));
      const afterFindings = after.findings.map((f) => ({
        key: `${f.rule ?? f.id}::${[...f.nodeIds].sort().join(",")}`,
        rule: f.rule ?? f.id,
        severity: f.severity,
        confidence: String(f.confidence),
        title: f.summary,
        nodeIds: [...f.nodeIds],
        evidence: { detail: f.evidence.detail },
      }));
      const applied = repairs
        .filter((r) => r.result === "applied")
        .map((r) => {
          const finding = liveBeforeRepair.find((f) => f.id === r.findingId);
          return {
            key: `${finding?.rule ?? finding?.id ?? r.findingId}::${[...(finding?.nodeIds ?? [])].sort().join(",")}`,
            rule: finding?.rule ?? r.findingId,
            targets: [...(finding?.nodeIds ?? [])],
          };
        });
      repairVerification = verifyRepairs({
        before,
        after: afterFindings,
        applied,
        recheck: "ran",
        notAutoFixable: repairs.filter((r) => r.result === "skipped").length,
        blocked: repairs.filter((r) => r.result === "failed").length,
      });
      stage(trace, "verify-repaired", `The repair pass verified itself: ${repairVerification.verdict}.`);
    }
  }

  /* --- the guard, after the final repair ---------------------------------- */

  // The guard's verdict is about the screen as it *is*, not as it was planned.
  // So it runs last: a repair can move a screen off a product truth, and a
  // guard verdict recorded before the repair is a verdict about a screen that
  // no longer exists.
  let finalGuard: { verdict: string; rulesChecked: number; failures: number; warnings: number; manual: number } | null = null;
  const finalMetrics = live.metrics ?? null;
  if (finalMetrics !== null) {
    try {
      const { memory } = loadMemory(projectKey(session.fileKey ?? undefined, session.fileName ?? undefined));
      const guarded = runGuard(memory.rules, snapshotFromMetrics(finalMetrics, rootNodeId ?? undefined));
      finalGuard = {
        verdict: guarded.verdict,
        rulesChecked: guarded.stats?.rulesChecked ?? 0,
        failures: guarded.stats?.failures ?? 0,
        warnings: guarded.stats?.warnings ?? 0,
        manual: guarded.stats?.manual ?? 0,
      };
    } catch (err) {
      stage(trace, "guard", `The final guard could not run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (finalGuard !== null) {
    const guardCheck = {
      id: "product-guard-final",
      question: "Does the repaired screen pass the product's own rules?",
      status: (finalGuard.verdict === "PASS" ? "pass" : finalGuard.verdict === "FAIL" ? "fail" : "review") as PipelineCheck["status"],
      detail: `${finalGuard.verdict}: ${finalGuard.rulesChecked} rule(s) checked, ${finalGuard.failures} failure(s), ${finalGuard.manual} needing judgement.`,
      nodeIds: [],
    };
    live.checks.push(guardCheck);
    trace.checks.push(guardCheck);
    stage(trace, "guard", `The final guard: ${finalGuard.verdict} over ${finalGuard.rulesChecked} rule(s).`);
  }

  /* --- stage 8: the report ----------------------------------------------- */

  const remaining = live.findings.filter(
    (f) => !repairs.some((r) => r.findingId === f.id && r.result === "applied"),
  );
  const report = buildReport({
    planned: true,
    applied: transaction.status === "success",
    operations: operations.length,
    nodeIds,
    transactionId,
    structure: { status: structure.status, checks: structure.checks, detail: `${structure.checks.length} structural check(s) ran against the resolved geometry.` },
    live: { status: live.status, checks: live.checks, detail: live.detail },
    visual: live.visual,
    repairs,
    ...(repairVerification !== null
      ? {
          repairVerification: {
            verdict: repairVerification.verdict,
            reason: repairVerification.reason,
            fixed: repairVerification.fixed,
            unresolved: repairVerification.unresolved,
            regressions: repairVerification.regressions,
          },
        }
      : {}),
    findings: remaining,
    blocked: live.blocked,
    trace,
  });

  return {
    ...common,
    status: report.status,
    applied: transaction.status === "success",
    transactionId,
    nodeIds,
    report,
    note:
      "Generated and applied is not the same as verified: read report.structurallyVerified, report.visuallyReviewed and report.remainingFindings before calling this screen done.",
    trace,
  };
}

/**
 * Reads the built screen back and checks it.
 *
 * Three sources, in increasing cost: the metrics of the built frame, the
 * review rules over those metrics, and a render. Each one can fail on its
 * own, and each failure is reported as its own state.
 */
async function verifyLiveScreen(
  session: Session,
  plan: ReturnType<typeof buildCompositionPlan>,
  evidence: { createdNodes: Array<{ temporaryId?: string; figmaNodeId?: string }>; rootNodeId: string | null; render: boolean },
): Promise<{
  checks: PipelineCheck[];
  findings: PipelineFinding[];
  status: "pass" | "fail" | "review" | "indeterminate";
  detail: string;
  visual: { status: "pass" | "fail" | "review" | "indeterminate" | "not-run"; detail: string; renderRevision: string | null };
  blocked: Array<{ check: string; why: string }>;
  render: { revisionId: string | null; nodeId: string | null; detail: "low" | "high" | null; at: number } | null;
  metrics: MetricsReport | null;
}> {
  const checks: PipelineCheck[] = [];
  const findings: PipelineFinding[] = [];
  const blocked: Array<{ check: string; why: string }> = [];

  let metrics: MetricsReport | null = null;
  if (evidence.rootNodeId !== null) {
    try {
      metrics = (await session.request("collect_metrics", { target: evidence.rootNodeId })) as MetricsReport;
    } catch {
      metrics = null;
    }
  }

  let ruleFindings: LiveEvidence["ruleFindings"];
  if (metrics !== null) {
    try {
      ruleFindings = runRules(metrics, "review").map((f) => ({
        rule: f.rule,
        confidence: f.confidence,
        severity: f.severity,
        message: f.title,
        nodeIds: f.nodeIds,
        ...(f.guidance !== undefined ? { fix: f.guidance } : {}),
        ...(f.suggestedOperations !== undefined && f.suggestedOperations.length > 0 ? { suggestedOperations: f.suggestedOperations } : {}),
      }));
    } catch {
      ruleFindings = undefined;
    }
  }

  let render: { revisionId: string | null; nodeId: string | null; detail: "low" | "high" | null; at: number } | null = null;
  // The render is bound to the revision of the screen it was taken of. The
  // plugin's render result carries no revision of its own, so the pipeline
  // fingerprints the measured state and binds the render to that. A render
  // that is not of the current revision cannot certify the current revision.
  const currentRevision =
    metrics !== null
      ? contentRevision(
          {
            target: evidence.rootNodeId,
            nodes: metrics.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]),
          },
          "rev",
        )
      : null;
  if (evidence.render && evidence.rootNodeId !== null) {
    try {
      const result = (await session.request("render_node", { nodeId: evidence.rootNodeId, maxWidth: 1024, detail: "low" })) as {
        data?: string;
        nodeId?: string;
      };
      if (typeof result?.data === "string" && result.data.length > 0) {
        render = {
          revisionId: currentRevision,
          nodeId: typeof result.nodeId === "string" ? result.nodeId : evidence.rootNodeId,
          detail: "low",
          at: Date.now(),
        };
      }
    } catch {
      render = null;
    }
  }

  const live = verifyLive(plan, {
    createdNodes: evidence.createdNodes,
    rootNodeId: evidence.rootNodeId,
    metrics,
    render,
    currentRevision,
    ruleFindings,
  });

  /**
   * Does the created screen have the size the plan promised?
   *
   * The dry run and the screen Figma builds are two different claims about the
   * same thing, and the difference between them is invisible until somebody
   * looks. So they are compared: the root frame's size in the file against the
   * canvas the plan asked for.
   */
  if (metrics !== null && metrics.nodes.length > 0) {
    const root = metrics.nodes[0]!;
    const expected = plan.canvas;
    const dw = Math.abs(Math.round(root.w) - expected.width);
    const dh = Math.abs(Math.round(root.h) - expected.height);
    const agrees = dw <= 1 && dh <= 1;
    live.checks.push({
      id: "geometry-agreement",
      question: "Is the created screen the size the plan promised?",
      status: agrees ? "pass" : "fail",
      detail: agrees
        ? `The frame in the file is ${Math.round(root.w)}x${Math.round(root.h)}, as planned.`
        : `The frame in the file is ${Math.round(root.w)}x${Math.round(root.h)}; the plan asked for ${expected.width}x${expected.height}.`,
      nodeIds: [root.id],
    });
    if (!agrees) {
      live.findings.push({
        id: "geometry-disagreement",
        stage: "live",
        severity: "high",
        confidence: 0.9,
        nodeIds: [root.id],
        summary: `The created screen is ${Math.round(root.w)}x${Math.round(root.h)}, not the ${expected.width}x${expected.height} the plan promised.`,
        why: "A dry run and the screen that was built are two claims about the same screen. When they disagree, one of them is describing something that was never built.",
        evidence: { kind: "geometry", detail: `file ${Math.round(root.w)}x${Math.round(root.h)} vs plan ${expected.width}x${expected.height}` },
        fix: "Measure the text with the plugin before compiling, so the layout is resolved from real numbers.",
        automatable: false,
      });
    }
  }
  checks.push(...live.checks);
  findings.push(...live.findings);

  if (metrics === null) {
    blocked.push({ check: "live-structure", why: "The built frame could not be measured." });
  }
  if (render === null) {
    blocked.push({ check: "visual-review", why: "The built frame could not be rendered." });
  }

  const visualStatus: "pass" | "fail" | "review" | "indeterminate" | "not-run" =
    render === null ? "indeterminate" : live.findings.some((f) => f.stage === "visual" && (f.severity === "critical" || f.severity === "high")) ? "fail" : "review";

  return {
    checks,
    findings,
    status: live.status,
    detail: `${live.checks.length} live check(s) ran against the built screen.`,
    visual: {
      status: visualStatus,
      detail:
        render === null
          ? "The screen was not rendered, so it was never looked at."
          : "A low-detail render of the built frame was produced and returned with the pipeline result for review.",
      renderRevision: render?.revisionId ?? null,
    },
    blocked,
    render,
    metrics,
  };
}
