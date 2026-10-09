/**
 * Review workflows (spec §8, §9, §10, §19).
 *
 * Three tools that connect the pieces the system already has into the loop the
 * spec asks for: plan → compose → create → render → judge → review → fix.
 *
 * - `score_design` turns a compiled program into per-dimension 0-10 scores with
 *   evidence. It answers "is this a 6 or a 9" before presentation, deterministically.
 * - `refine_screen` runs the fix loop server-side: review, apply
 *   high-confidence fixes, re-review, up to a bounded iteration count. The model
 *   judges renders between iterations; the tool does the mechanical part.
 * - `diff_design` answers "what changed visually" structurally: two inspect
 *   snapshots in, a compact delta out. No pixel heatmap is claimed, because none
 *   is computed — layout delta, movement, density, colour and text changes are.
 */
import { z } from "zod";
import { executeRuntime } from "../runtime/interpreter";
import { inferComposition } from "../runtime/layout";
import { canvasSize } from "../../../shared/ir";
import { runRules } from "./rules";
import { scoreDesign } from "./score";
import { critiqueVisual } from "./critique";
import { evaluateQualityGate } from "./quality";
import { evaluateGenericity } from "../design/quality/genericity";
import { extendCritique } from "../design/quality/visual-critic";
import { planRepairs } from "../design/quality/repair-planner";
import { evaluateFinalGate } from "../design/quality/final-gate";
import { makeFindings, trackFindings } from "../design/quality/visual-findings";
import { guardMutation } from "../plan/gate";
import type { Session } from "../sessions";
import type { Finding, MetricsReport, ReviewReport } from "../../../shared/protocol";

/* -------------------------------------------------------------------------- */
/* score_design                                                                */
/* -------------------------------------------------------------------------- */

export const ScoreArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    program: z.unknown().optional().describe("The declarative program to score. Compiled and scored without touching Figma."),
    nodeId: z.string().max(200).optional().describe("Live Figma node id to score (native builds). Measured geometry is scored with the same dimensions as a program."),
  })
  .strict()
  .refine((a) => a.program !== undefined || a.nodeId !== undefined, {
    message: "score_design needs a program or a nodeId.",
  });

/**
 * Scores live Figma geometry with the same dimensions as a program.
 *
 * Native builds have no program to compile, so the boxes, texts and fills are
 * measured from collect_metrics instead of synthesised. Region roles are
 * inferred from layer names (rail/status, topology/field/map, attention/
 * inspector) and reported in the result, so an inference the model disagrees
 * with can be argued with rather than obeyed.
 */
export function scoreLive(metrics: MetricsReport): {
  report: ReturnType<typeof scoreDesign>;
  regions: Array<{ id: string; role: string }>;
  composition: string;
  canvasW: number;
  canvasH: number;
} {
  const nodes = (metrics.nodes ?? []).filter((n) => n.visible !== false);
  const target = nodes.find((n) => n.id === metrics.target) ?? nodes.find((n) => n.type === "FRAME") ?? nodes[0];
  const canvasW = target && target.w > 0 ? Math.round(target.w) : 1440;
  const canvasH = target && target.h > 0 ? Math.round(target.h) : 900;
  const ox = target ? target.x : 0;
  const oy = target ? target.y : 0;

  const boxes = new Map<string, { id: string; x: number; y: number; w: number; h: number }>();
  for (const n of nodes) {
    if (n.w <= 0 || n.h <= 0) continue;
    boxes.set(n.id, { id: n.id, x: n.x - ox, y: n.y - oy, w: n.w, h: n.h });
  }

  const operations = [] as Array<Record<string, unknown>>;
  for (const n of nodes) {
    if (n.type === "TEXT" && n.text && n.text.content.trim().length > 0) {
      operations.push({
        type: "createText",
        parent: n.parentId ?? undefined,
        content: n.text.content,
        fontSize: n.text.size ?? 16,
        family: n.text.family ?? "Inter",
        ...(n.text.color ? { fill: n.text.color } : {}),
      });
    } else if (n.type === "FRAME" || n.type === "RECTANGLE" || n.type === "ELLIPSE") {
      operations.push({
        type: "createFrame",
        id: n.id,
        ...(n.fill ? { fill: n.fill } : {}),
        ...(n.stroke ? { stroke: n.stroke.hex, strokeWeight: n.stroke.weight } : {}),
      });
    }
  }

  const roleFor = (name: string): string => {
    const s = name.toLowerCase();
    if (/status-strip|status-rail|^rail$|live-rail/.test(s)) return "status-rail";
    if (/topology|field|\bmap\b|hero|primary-visual|center|cluster-field/.test(s)) return "primary-visual";
    if (/attention|inspector|detail|right|rail-right/.test(s)) return "inspector";
    if (/nav|sidebar|^rail|instrument-rail/.test(s)) return "navigation";
    if (/header|strip|eyebrow-top/.test(s)) return "header";
    return "content";
  };

  const targetId = target?.id;
  const children = nodes
    .filter((n) => n.parentId === targetId && (n.type === "FRAME" || n.type === "GROUP") && n.w * n.h > 0)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, 5);
  const regions = children.map((c) => ({ id: c.id, role: roleFor(c.name) }));

  const names = children.map((c) => c.name.toLowerCase()).join(" ");
  const composition = /topology|map|field|spatial|diagram/.test(names) ? "spatial" : /status|rail|instrument|signal/.test(names) ? "instrument" : "canvas";

  const focal = regions.find((r) => r.role === "primary-visual")?.id;
  const report = scoreDesign({
    boxes: boxes as never,
    operations: operations as never,
    regions,
    composition,
    canvasW,
    canvasH,
    ...(focal !== undefined ? { focal } : {}),
  });
  return { report, regions, composition, canvasW, canvasH };
}

export async function scoreDesignTool(rawArgs: unknown, registry?: { resolve: (id?: string) => Session }): Promise<unknown> {
  const args = ScoreArgs.parse(rawArgs);
  if (args.program !== undefined) {
    const result = executeRuntime(args.program);

    const report = scoreDesign({
      boxes: result.boxes,
      operations: result.operations as never,
      regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
      composition: inferComposition(result.ir.regions),
      canvasW: canvasSize(result.ir.canvas.width, 1440),
      canvasH: canvasSize(result.ir.canvas.height, 900),
      ...(result.ir.visualIntent?.focal !== undefined ? { focal: result.ir.visualIntent.focal } : {}),
    });

    return {
      status: "ok",
      source: "program",
      overall: report.overall,
      dimensions: report.dimensions,
      weakSpots: report.weakSpots,
      /**
       * The spec's definition of done (§19), evaluated against what can be known
       * offline. Structural QA and visual review need the live file, so they are
       * listed as remaining rather than assumed.
       */
      doneChecklist: {
        "primary decision obvious": report.dimensions.find((d) => d.dimension === "Composition")!.score >= 7,
        "intentional hierarchy": report.dimensions.find((d) => d.dimension === "Hierarchy")!.score >= 7,
        "no weak spots below 6": report.weakSpots.length === 0,
        "structural QA (review_design on the live file)": false,
        "rendered and visually reviewed": false,
      },
      warnings: result.warnings,
      violations: result.violations,
    };
  }

  if (!registry) {
    throw new Error("score_design with nodeId needs a connected Figma plugin: pass a program to score offline, or connect the plugin.");
  }
  const session = registry.resolve(args.sessionId);
  const raw = (await session.request("collect_metrics", { target: args.nodeId })) as MetricsReport;
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as MetricsReport).nodes)) {
    throw new Error("The Figma plugin returned no measurements. Close and re-run the plugin, then retry.");
  }
  const { report, regions, composition, canvasW, canvasH } = scoreLive(raw as MetricsReport);
  return {
    status: "ok",
    source: "live",
    overall: report.overall,
    dimensions: report.dimensions,
    weakSpots: report.weakSpots,
    regions,
    composition,
    canvas: { width: canvasW, height: canvasH },
    measuredNodes: (raw as MetricsReport).nodeCount,
    note: "Roles inferred from layer names; composition inferred from region names. Disagree with an inference? Rename the layer and re-run.",
  };
}

/* -------------------------------------------------------------------------- */
/* critique_visual                                                           */
/* -------------------------------------------------------------------------- */

export const CritiqueArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    program: z.unknown().optional().describe("The declarative program to critique aesthetically. Compiled and judged without touching Figma."),
    nodeId: z.string().max(200).optional().describe("Figma node id to critique if evaluating live nodes natively instead of a program."),
    visionCriticObservations: z.object({
      focalPoint: z.string(),
      hierarchy: z.string(),
      balance: z.string(),
      templateFeel: z.string(),
    }).optional().describe("Provide your own visual observations based on the screenshot, to merge with structural critique."),
    visualFindings: z
      .array(
        z
          .object({
            area: z.string().max(120).describe("Where in the image: a canvas zone (top-left, center, bottom-right…), a region id, or 'focal'."),
            defect: z.string().min(3).max(500).describe("The specific defect you see, in your own words."),
            severity: z.enum(["critical", "major", "minor"]).optional().describe("critical blocks done; major must fix this pass; minor is polish. Default major."),
          })
          .strict(),
      )
      .max(20)
      .optional()
      .describe("Defects you saw in the render. Each is localized to measured node ids and returned with a repair that cites it. Re-report after fixing to verify."),
    priorFindings: z
      .array(
        z
          .object({
            id: z.string().max(64).describe("Finding id from a previous critique (vf-*)."),
            defect: z.string().max(500).optional(),
            area: z.string().max(120).optional(),
          })
          .strict(),
      )
      .max(30)
      .optional()
      .describe("Findings from the previous render. Returned as resolved / persisting / introduced — but only when visualFindings re-reports the current image too."),
    renderReviewed: z.boolean().optional().describe("Set true after you have rendered and visually judged the result. Composition-led work stays at REVIEW until this is set."),
  })
  .strict();

type VisionVerdict = "PASS" | "WATCH" | "FAIL";

function visionVerdictFor(text: string | undefined): VisionVerdict {
  // Strip negated defect mentions ("no card wall", "no template markers")
  // before keyword matching, or every clean render would FAIL itself.
  const s = (text ?? "")
    .replace(/no\s+[a-z-]*(card wall|template|generic|glow|gradient|decorative|card-wall)/gi, "")
    .toUpperCase();
  if (/FAIL|GENERIC|CARD WALL|THREE-CARD|TEMPLATE|SIDEBAR[-\s]?HEADER[-\s]?CARDS|GLOW|GRADIENT-HEAVY|DECORATIVE/.test(s)) return "FAIL";
  if (/WATCH|WEAK|FLAT|UNCLEAR|CROWDED|IMBALANC/.test(s)) return "WATCH";
  if (/PASS|CLEAR|STRONG|RESTRAINED|SPATIAL|OPEN SURFACE/.test(s)) return "PASS";
  return "WATCH";
}

export async function critiqueVisualTool(rawArgs: unknown, registry?: any): Promise<unknown> {
  const args = CritiqueArgs.parse(rawArgs);
  if (args.program) {
    const result = executeRuntime(args.program);

    const composition = inferComposition(result.ir.regions);
    const report = critiqueVisual({
      boxes: result.boxes,
      operations: result.operations as never,
      regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
      composition,
      canvasW: canvasSize(result.ir.canvas.width, 1440),
      canvasH: canvasSize(result.ir.canvas.height, 900),
      links: result.ir.links,
      ...(result.ir.visualIntent?.focal !== undefined ? { focal: result.ir.visualIntent.focal } : {}),
    });

    const gate = evaluateQualityGate(
      { verdict: report.verdict, dimensions: report.dimensions },
      {
        compositionLed: ["topology", "spatial", "diagram", "instrument"].includes(composition),
        renderReviewed: args.renderReviewed ?? false,
      },
    );

    // Design intelligence (§14, §16, §17): genericity as a first-class gate,
    // the four authorship dimensions, and a prioritized repair plan. Additive:
    // every existing field keeps its shape.
    const genericity = evaluateGenericity({
      boxes: result.boxes,
      operations: result.operations as never,
      regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
      composition,
    });
    const extended = extendCritique({
      measured: { verdict: report.verdict, dimensions: report.dimensions },
      boxes: result.boxes,
      operations: result.operations as never,
      regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role })),
      composition,
      links: result.ir.links,
      ...(result.ir.visualIntent?.focal !== undefined ? { focal: result.ir.visualIntent.focal } : {}),
    });
    const repairs = planRepairs({
      genericity,
      watchList: extended.watchList,
      blockingIssues: gate.blockingIssues,
    });

    return {
      status: "ok",
      source: "program",
      verdict: extended.verdict,
      dimensions: extended.dimensions,
      watchList: extended.watchList,
      qualityGate: gate,
      blockingIssues: gate.blockingIssues,
      repairPlan: gate.repairPlan,
      genericity: { score: genericity.score, blocking: genericity.blocking, findings: genericity.findings },
      prioritizedRepairs: repairs,
      renderRequired: gate.renderRequired,
      warnings: result.warnings,
      violations: result.violations,
      visionMerge: args.visionCriticObservations || null
    };
  } else if (args.nodeId) {
    if (!registry) {
      // Offline fallback: no plugin to measure, so the render IS the
      // measurement. Vision observations become dimensions; the quality gate
      // is evaluated over them exactly as on the program path. Without
      // observations there is nothing to judge, so the gate stays at REVIEW
      // with a render required. A connected plugin takes the live measured
      // path below instead.
      const obs = args.visionCriticObservations;
      const dimensions = [
        { dimension: "Focal clarity", verdict: visionVerdictFor(obs?.focalPoint), evidence: obs?.focalPoint ?? "no focal observation provided" },
        { dimension: "Hierarchy", verdict: visionVerdictFor(obs?.hierarchy), evidence: obs?.hierarchy ?? "no hierarchy observation provided" },
        { dimension: "Visual balance", verdict: visionVerdictFor(obs?.balance), evidence: obs?.balance ?? "no balance observation provided" },
        { dimension: "Template feel", verdict: visionVerdictFor(obs?.templateFeel), evidence: obs?.templateFeel ?? "no template observation provided" },
      ] as Array<{ dimension: string; verdict: "PASS" | "WATCH" | "FAIL"; evidence: string }>;
      const verdict = (dimensions.some((d) => d.verdict === "FAIL") ? "FAIL" : dimensions.some((d) => d.verdict === "WATCH") ? "WATCH" : "PASS") as VisionVerdict;
      const compositionLed = obs ? /TOPOLOGY|SPATIAL|DIAGRAM|INSTRUMENT|COMPOSITION|FIELD|MAP/.test(`${obs.focalPoint} ${obs.hierarchy} ${obs.balance} ${obs.templateFeel}`.toUpperCase()) : true;
      const gate = evaluateQualityGate({ verdict, dimensions }, { compositionLed, renderReviewed: args.renderReviewed ?? false });
      return {
        status: "ok",
        source: "live",
        verdict,
        dimensions,
        watchList: dimensions.filter((d) => d.verdict !== "PASS").map((d) => `${d.dimension} (${d.verdict}): ${d.evidence}`),
        qualityGate: gate,
        blockingIssues: gate.blockingIssues,
        repairPlan: gate.repairPlan,
        renderRequired: gate.renderRequired,
        visionMerge: obs || null,
        nodeId: args.nodeId ?? null,
        howToProceed: gate.status === "FAIL"
          ? "Fix every blockingIssue, re-render, and re-run critique_visual with renderReviewed:true once you have judged the image."
          : gate.status === "REVIEW"
            ? "Render at low detail, judge the image yourself, then re-run with renderReviewed:true and visionCriticObservations from what you saw."
            : "Quality gate PASS. Confirm with review_design (no high-confidence findings) and design_guard (no FAIL).",
      };
    }
    const session = registry.resolve(args.sessionId);

    const [raw, rendered] = await Promise.all([
      session.request("collect_metrics", { target: args.nodeId, maxNodes: 3000, depth: 20 }),
      session.request("render_node", { nodeId: args.nodeId, maxWidth: 1024, detail: "low" }, 120_000),
    ]);

    const report = raw as MetricsReport;
    if (!report || !Array.isArray(report.nodes) || report.nodes.length === 0) {
      throw new Error("critique_visual could not measure the live node. Inspect the node and retry.");
    }

    // Project live Figma measurements into the same deterministic aesthetic critic
    // used for programs. This closes the old gap where native screens always got
    // a generic WATCH regardless of their actual structure.
    const nodes = report.nodes.filter((n) => n.visible && n.w > 0 && n.h > 0);
    const root = nodes.find((n) => n.id === report.target) ?? nodes.find((n) => n.type === "FRAME") ?? nodes[0] ?? report.nodes[0]!;
    // Boxes are measured relative to the target: page-absolute coordinates
    // would judge balance and position against the wrong origin.
    const boxes = new Map(nodes.map((n) => [n.id, { id: n.id, x: n.x - root.x, y: n.y - root.y, w: n.w, h: n.h }]));
    // Regions are the target's own children. Two inflations made every live
    // screen read as fragmented: page siblings (parentId === root.parentId)
    // counted as regions of this screen, and loose TEXT nodes counted as
    // regions instead of content.
    const children = nodes.filter((n) => n.parentId === root.id && n.id !== root.id);
    const structural = (children.length > 0 ? children : nodes.filter((n) => n.depth === 1 && n.id !== root.id))
      .filter((n) => n.type !== "TEXT");
    // The screen frame is never its own focal point. Prefer a semantically
    // named candidate, then fall back to area — the old largest-box rule
    // picked the root and manufactured a focal FAIL against its own child.
    const semantic = structural.find((n) => /focal|hero|primary-visual|primary|subject/i.test(n.name));
    const focal = semantic ?? [...structural]
      .sort((a, b) => (b.w * b.h) - (a.w * a.h))[0];
    const regions = structural.map((n) => ({
      id: n.id,
      role: n.id === focal?.id ? "primary-visual" : "content",
    }));

    const operations = nodes.map((n) => ({
      type: n.type === "TEXT" ? "createText" : n.type === "VECTOR" ? "createVector" : "createFrame",
      id: n.id,
      parent: n.parentId ?? undefined,
      width: n.w,
      height: n.h,
      fill: n.fill,
      stroke: n.stroke?.hex,
      strokeWeight: n.stroke?.weight,
      cornerRadius: n.radius,
      family: n.text?.family,
      fontSize: n.text?.size ?? undefined,
      content: n.text?.content ?? undefined,
    })) as never;

    const visual = critiqueVisual({
      boxes,
      operations,
      regions,
      composition: "native-live",
      canvasW: root.w,
      canvasH: root.h,
      ...(focal ? { focal: focal.id } : {}),
    });

    const observation = args.visionCriticObservations;
    const observationFail =
      !!observation &&
      Object.values(observation).some((value) => /fail|bad|weak|poor|generic|wrong|broken/i.test(value));

    // Genericity on live nodes: the same first-class gate as on programs, so a
    // native card wall cannot pass by skipping the program path.
    const liveGenericity = evaluateGenericity({
      boxes,
      operations,
      regions,
      composition: "native-live",
    });

    // Image-grounded findings: defects the reviewer saw, localized to measured
    // node ids, each with a repair that cites it. Verification needs both
    // sides: prior findings plus a fresh report of the current image.
    const regionsForFindings = structural.map((n) => ({ id: n.id, nodeId: n.id }));
    const findingInputs = args.visualFindings ?? [];
    const findings = findingInputs.length > 0
      ? makeFindings({
          findings: findingInputs,
          nodes: nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, w: n.w, h: n.h, parentId: n.parentId })),
          regions: regionsForFindings,
          ...(focal ? { focalId: focal.id } : {}),
          canvasW: root.w,
          canvasH: root.h,
        })
      : [];
    const resolution = args.priorFindings && args.priorFindings.length > 0 && findings.length > 0
      ? trackFindings(args.priorFindings.map((p) => ({ id: p.id })), findings.map((f) => ({ id: f.id })))
      : null;
    const resolutionNote = args.priorFindings && args.priorFindings.length > 0 && findings.length === 0
      ? "Prior findings were supplied but the current image was not re-reported: pass visualFindings from what you see now to verify resolution."
      : null;

    const structuralBlocking = [...visual.qualityGate.blockingIssues];
    if (liveGenericity.blocking) {
      structuralBlocking.push(`Genericity: ${liveGenericity.score}/100 exceeds 70 — ${liveGenericity.findings.map((f) => f.id).join(", ")}. ${liveGenericity.repairs[0] ?? ""}`);
    }
    for (const f of findings) {
      if (f.severity === "critical") structuralBlocking.push(`[${f.id}] ${f.area}: ${f.defect}`);
    }

    const qualityGate = {
      ...visual.qualityGate,
      status: observationFail || structuralBlocking.length > visual.qualityGate.blockingIssues.length ? "FAIL" : observation ? visual.qualityGate.status : "REVIEW",
      blockingIssues: structuralBlocking,
      renderRequired: !observation,
      reason: observation
        ? visual.qualityGate.reason
        : "Native output has been structurally critiqued and rendered. Make the visual judgement from the screenshot, then re-run critique_visual with visionCriticObservations.",
    };

    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: JSON.stringify({
        status: "ok",
        verdict: qualityGate.status === "FAIL" ? "FAIL" : visual.verdict,
        qualityGate,
        dimensions: visual.dimensions,
        watchList: visual.watchList,
        genericity: { score: liveGenericity.score, blocking: liveGenericity.blocking, findings: liveGenericity.findings },
        findings,
        resolution,
        ...(resolutionNote ? { resolutionNote } : {}),
        liveEvidence: {
          nodes: report.nodeCount,
          truncated: report.truncated,
          components: report.nodes.filter((n) => n.type === "INSTANCE").length,
          textLayers: report.nodes.filter((n) => n.type === "TEXT").length,
          roundedSurfaces: report.nodes.filter((n) => (n.radius ?? 0) > 0).length,
          filledSurfaces: report.nodes.filter((n) => Boolean(n.fill)).length,
        },
        visionMerge: observation || null,
        nextStep: observation || findings.length > 0
          ? "Fix each finding via its nodeIds with modify_design, re-render, then re-run critique_visual with priorFindings plus fresh visualFindings to verify resolution."
          : "Judge the screenshot for focal clarity, hierarchy, rhythm, density, balance and template feel; report what you see as visualFindings (area + defect) and run critique_visual again.",
      }, null, 2),
    }];

    const image = rendered as { data?: string; width?: number; height?: number };
    if (image?.data) {
      content.push({ type: "image", data: image.data, mimeType: "image/png" });
    }

    return { content };
  } else {
    throw new Error("critique_visual needs either program or nodeId.");
  }
}

/* -------------------------------------------------------------------------- */
/* refine_screen                                                               */
/* -------------------------------------------------------------------------- */

export const RefineArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Build this program first, then refine what it made. */
    program: z.unknown().optional(),
    /** Otherwise refine the current selection (or nodeId). */
    nodeId: z.string().max(200).optional(),
    /** What the iterations should optimise for. Reported back each round. */
    visualGoals: z.array(z.string().max(200)).max(10).optional(),
    /** Node ids or rule names the loop must not touch. */
    preserve: z.array(z.string().max(200)).max(50).default([]),
    /** Hard bound. A loop without one is a loop that can run forever. */
    maxIterations: z.number().int().min(1).max(5).default(3),
    description: z.string().max(1000).optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();

interface RefineIteration {
  iteration: number;
  highConfidenceFindings: number;
  appliedFixes: number;
  appliedRules: string[];
  skipped: string[];
  remainingHigh: number;
}

export async function refineScreenTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = RefineArgs.parse(rawArgs);
  const goals = args.visualGoals ?? [];
  const preserve = new Set(args.preserve);
  const compositionLed = goals.some((g) => /topology|spatial|visual|composition|hierarchy|runtime|instrument/i.test(g));
  const iterations: RefineIteration[] = [];

  if (!session) {
    throw new Error("refine_screen needs a connected Figma plugin: it reviews and fixes the live document.");
  }

  let target: Record<string, unknown> = {};
  if (args.nodeId) target = { nodeId: args.nodeId };

  // Optional build phase: the program lands first, then the loop polishes it.
  if (args.program !== undefined) {
    if (compositionLed) {
      return {
        status: "native-review-required",
        message: "Composition-led refinement cannot silently rebuild through the semantic runtime. Build the native composition first, then use refine_screen for structural fixes and render_design for visual judgement.",
        visualGoals: goals,
      };
    }
    const { runRuntimeTool } = await import("../runtime/tools");
    await runRuntimeTool(session, { program: args.program, description: args.description ?? "refine_screen build phase" });
  }

  let converged = false;
  for (let i = 1; i <= args.maxIterations; i++) {
    const raw = (await session.request("collect_metrics", target)) as MetricsReport;
    const findings = runRules(raw, "review").filter((f) => f.confidence === "high");

    // Preserve list applies to node ids and to rule names: either skips a fix.
    const actionable = findings.filter(
      (f) => !preserve.has(f.rule) && f.suggestedOperations && f.suggestedOperations.length > 0 && !f.nodeIds.some((id) => preserve.has(id)),
    );
    const skipped = findings.filter((f) => !actionable.includes(f)).map((f) => f.rule);

    if (actionable.length === 0) {
      iterations.push({ iteration: i, highConfidenceFindings: findings.length, appliedFixes: 0, appliedRules: [], skipped, remainingHigh: findings.length });
      converged = findings.length === 0;
      break;
    }

    const operations = actionable.flatMap((f) => f.suggestedOperations ?? []);
    const gate = guardMutation({
      operations: operations as Array<Record<string, unknown>>,
      approved: args.approved,
      reason: args.reason,
    });
    if (gate) {
      return {
        status: "needs-approval",
        iterations,
        question: gate.question,
        ifApproved: gate.ifApproved,
        instead: gate.instead,
        howToProceed: "Nothing further was changed. Re-send with approved:true to let the loop apply these fixes.",
      };
    }

    const applied = (await session.request("modify_design", {
      description: `refine_screen iteration ${i}: ${actionable.map((f) => f.rule).join(", ")}`,
      operations,
    })) as { status?: string; error?: { message?: string } };

    if (applied.status !== "success") {
      iterations.push({
        iteration: i,
        highConfidenceFindings: findings.length,
        appliedFixes: 0,
        appliedRules: [],
        skipped,
        remainingHigh: findings.length,
      });
      return {
        status: "fix-failed",
        iterations,
        error: applied.error?.message ?? "the fix transaction failed",
        howToProceed: "Inspect the target and fix by hand, or narrow preserve[] and retry.",
      };
    }

    iterations.push({
      iteration: i,
      highConfidenceFindings: findings.length,
      appliedFixes: operations.length,
      appliedRules: actionable.map((f) => f.rule),
      skipped,
      remainingHigh: -1,
    });

    if (i === args.maxIterations) break;

    // Re-review to see what is left; the next iteration decides from evidence.
    const recheck = (await session.request("collect_metrics", target)) as MetricsReport;
    const remaining = runRules(recheck, "review").filter((f) => f.confidence === "high").length;
    iterations[iterations.length - 1]!.remainingHigh = remaining;
    if (remaining === 0) {
      converged = true;
      break;
    }
  }

  return {
    status: converged ? "converged" : "budget-exhausted",
    iterations,
    visualGoals: goals,
    howToProceed: converged
      ? (compositionLed
        ? "No high-confidence structural findings remain. Run a successful low-detail render and judge the image before design_guard."
        : "No high-confidence findings remain. Render at low detail to judge hierarchy, then run design_guard before calling it done.")
      : `Still ${iterations[iterations.length - 1]?.remainingHigh ?? "?"} high-confidence finding(s) after ${args.maxIterations} iteration(s). Widen maxIterations (max 5) or fix the rest by hand.`,
  };
}

/* -------------------------------------------------------------------------- */
/* final_qa                                                                  */
/* -------------------------------------------------------------------------- */

export const FinalQaArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Score and guard this program offline. */
    program: z.unknown().optional(),
    /** Also review the live selection (or nodeId) for the technical checks. */
    target: z.record(z.unknown()).optional(),
    nodeId: z.string().max(200).optional(),
    project: z.string().max(200).optional(),
  })
  .strict();

interface ChecklistItem {
  area: "PRODUCT" | "COMPOSITION" | "SYSTEM" | "VISUAL" | "TECHNICAL";
  check: string;
  pass: boolean | null;
  detail: string;
}

/**
 * The §33 quality gate: one checklist, five areas, one verdict.
 *
 * Each item is measured or explicitly marked unmeasurable — never guessed. A
 * null pass means "needs the live file", which is itself the instruction. The
 * generation fails (verdict FAIL) only on measured critical misses; everything
 * else is a warning or a pending live check.
 */
export async function finalQaTool(session: Session | null, rawArgs: unknown): Promise<unknown> {
  const args = FinalQaArgs.parse(rawArgs);
  const items: ChecklistItem[] = [];

  if (args.program !== undefined) {
    const scored = (await scoreDesignTool({ program: args.program })) as {
      overall: number;
      dimensions: Array<{ dimension: string; score: number }>;
      weakSpots: string[];
    };
    const dimension = (name: string): number => scored.dimensions.find((d) => d.dimension === name)?.score ?? 0;

    items.push(
      { area: "PRODUCT", check: "primary user decision is obvious", pass: dimension("Composition") >= 7, detail: `composition ${dimension("Composition")}/10` },
      { area: "COMPOSITION", check: "one dominant focal point", pass: dimension("Focus") >= 6, detail: `focus ${dimension("Focus")}/10` },
      { area: "COMPOSITION", check: "visual hierarchy is intentional", pass: dimension("Hierarchy") >= 7, detail: `hierarchy ${dimension("Hierarchy")}/10` },
      { area: "COMPOSITION", check: "whitespace is intentional", pass: dimension("Information density") >= 6, detail: `density ${dimension("Information density")}/10` },
      { area: "SYSTEM", check: "type scale consistent", pass: dimension("Visual consistency") >= 6, detail: `consistency ${dimension("Visual consistency")}/10` },
      { area: "VISUAL", check: "supporting content does not compete", pass: dimension("Hierarchy") >= 7 && dimension("Focus") >= 6, detail: "hierarchy and focus agree" },
      { area: "VISUAL", check: "screen does not feel template-generated", pass: null, detail: "needs human eyes: does any region feel stamped?" },
    );

    const guarded = (await import("../memory/tools").then((m) =>
      m.designGuardTool(session, { ...(args.project !== undefined ? { project: args.project } : {}), program: args.program }),
    )) as { verdict?: string; findings?: Array<{ verdict?: string; rule?: string }> };
    const failed = (guarded.findings ?? []).filter((f) => f.verdict === "FAIL");
    items.push({
      area: "PRODUCT",
      check: "no product-truth violations",
      pass: failed.length === 0,
      detail: failed.length === 0 ? `guard: ${guarded.verdict ?? "PASS"}` : `failing rules: ${failed.map((f) => f.rule).join(", ")}`,
    });

    // Final visual-quality gate (§18): eight scored dimensions with the
    // Phase 9 thresholds. Additive: the checklist above keeps its shape.
    const runtime = executeRuntime(args.program);
    const resolvedComposition = inferComposition(runtime.ir.regions);
    const genericity = evaluateGenericity({
      boxes: runtime.boxes,
      operations: runtime.operations as never,
      regions: runtime.ir.regions.map((r) => ({ id: r.id, role: r.role })),
      composition: resolvedComposition,
    });
    const finalGate = evaluateFinalGate({
      scores: {
        hierarchy: dimension("Hierarchy") * 10,
        composition: dimension("Composition") * 10,
        typography: dimension("Visual consistency") * 10,
        readability: dimension("Accessibility") * 10,
        density: dimension("Information density") * 10,
        distinctiveness: dimension("Focus") * 10,
        productFit: dimension("Composition") * 10,
      },
      genericity,
      blockingIssues: failed.map((f) => String(f.rule ?? "guard")),
    });
    items.push({
      area: "VISUAL",
      check: "final visual-quality gate",
      pass: finalGate.status === "FAIL" ? false : finalGate.status === "REVIEW" ? null : true,
      detail: `final-gate ${finalGate.status}: ${finalGate.reason}`,
    });
  }

  if (session && (args.target !== undefined || args.nodeId !== undefined)) {
    // The plugin's collect_metrics scopes on `target` (a node id string).
    // Passing { nodeId } is silently ignored and scans the whole file, which
    // is how a scoped review with 0 highs became a file-wide FAIL. Normalise
    // both shapes to { target } here.
    const targetArg = args.nodeId !== undefined
      ? { target: args.nodeId }
      : typeof (args.target as Record<string, unknown> | undefined)?.["nodeId"] === "string"
        ? { target: (args.target as Record<string, unknown>)["nodeId"] as string }
        : (args.target as Record<string, unknown>);
    const raw = (await session.request("collect_metrics", targetArg)) as MetricsReport;
    const findings = runRules(raw, "review");
    const high = findings.filter((f) => f.confidence === "high");
    const cardWall = findings.some((f) => f.rule === "card-wall");
    items.push(
      { area: "TECHNICAL", check: "no overflow or broken structure", pass: high.length === 0, detail: high.length === 0 ? `no high-confidence findings in ${raw.scope} (${raw.nodeCount} nodes)` : `${high.length} high-confidence in ${raw.scope}: ${high.map((f) => f.rule).join(", ")}` },
      { area: "COMPOSITION", check: "no accidental card wall", pass: !cardWall, detail: cardWall ? "card-wall rule fired" : "no card wall detected" },
      { area: "TECHNICAL", check: "render succeeds", pass: null, detail: "render the selection at low detail to confirm" },
    );
  } else {
    items.push(
      { area: "TECHNICAL", check: "no overflow or broken structure", pass: null, detail: "needs the live file: run review_design" },
      { area: "TECHNICAL", check: "render succeeds", pass: null, detail: "needs the live file: render at low detail" },
    );
  }

  const failed = items.filter((i) => i.pass === false);
  const pending = items.filter((i) => i.pass === null);

  return {
    status: "ok",
    verdict: failed.length > 0 ? "FAIL" : "PASS WITH LIVE CHECKS PENDING",
    checklist: items,
    failed: failed.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    pendingLiveChecks: pending.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    howToProceed:
      failed.length > 0
        ? "Fix every failed item, then re-run. A screen that misses critical criteria is not finished."
        : "Clear the pending live checks (review_design, one low-detail render, design_guard with inspect:true), then call it done.",
  };
}

export const DiffArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    /** Earlier snapshot: an inspect_selection-shaped node tree. */
    before: z.record(z.unknown()),
    /** Later snapshot, same shape. */
    after: z.record(z.unknown()),
  })
  .strict();

interface FlatNode {
  id: string;
  type: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill?: string;
  texts: string[];
}

/** Flattens an inspect-shaped tree into id-keyed nodes. */
function flattenSnapshot(root: unknown): Map<string, FlatNode> {
  const out = new Map<string, FlatNode>();

  const walk = (node: unknown): string[] => {
    if (!node || typeof node !== "object") return [];
    const n = node as Record<string, unknown>;
    const kids = Array.isArray(n.children) ? n.children : [];
    const childTexts = kids.flatMap(walk);

    const id = typeof n.id === "string" ? n.id : "";
    if (id) {
      const own = typeof n.content === "string" ? [n.content] : typeof n.text === "string" ? [n.text] : [];
      out.set(id, {
        id,
        type: typeof n.type === "string" ? n.type : "?",
        name: typeof n.name === "string" ? n.name : "",
        x: typeof n.x === "number" ? n.x : 0,
        y: typeof n.y === "number" ? n.y : 0,
        w: typeof n.w === "number" ? n.w : (typeof n.width === "number" ? n.width : 0),
        h: typeof n.h === "number" ? n.h : (typeof n.height === "number" ? n.height : 0),
        ...(typeof n.background === "string" ? { fill: n.background } : {}),
        texts: [...own, ...childTexts],
      });
    }
    return id ? out.get(id)!.texts : childTexts;
  };

  if (root && typeof root === "object") {
    const r = root as Record<string, unknown>;
    // Accept either a bare node, {selection:[...]}, or {nodes:[...]}.
    const seeds: unknown[] = Array.isArray(r.selection) ? r.selection : Array.isArray(r.nodes) ? r.nodes : [root];
    for (const seed of seeds) walk(seed);
  }
  return out;
}

export function diffDesignTool(rawArgs: unknown): unknown {
  const args = DiffArgs.parse(rawArgs);
  const before = flattenSnapshot(args.before);
  const after = flattenSnapshot(args.after);

  const added: string[] = [];
  const removed: string[] = [];
  const moved: Array<{ id: string; name: string; dx: number; dy: number }> = [];
  const resized: Array<{ id: string; name: string; from: string; to: string }> = [];
  const recolored: Array<{ id: string; name: string; from?: string; to?: string }> = [];
  const renamed: Array<{ id: string; from: string; to: string }> = [];
  const textChanged: Array<{ id: string; name: string }> = [];

  for (const [id, node] of after) {
    if (!before.has(id)) {
      added.push(`${node.type} "${node.name}" (${id})`);
    }
  }
  for (const [id, node] of before) {
    if (!after.has(id)) {
      removed.push(`${node.type} "${node.name}" (${id})`);
      continue;
    }
    const next = after.get(id)!;
    if (Math.abs(next.x - node.x) > 1 || Math.abs(next.y - node.y) > 1) {
      moved.push({ id, name: next.name, dx: Math.round(next.x - node.x), dy: Math.round(next.y - node.y) });
    }
    if (Math.abs(next.w - node.w) > 1 || Math.abs(next.h - node.h) > 1) {
      resized.push({ id, name: next.name, from: `${Math.round(node.w)}x${Math.round(node.h)}`, to: `${Math.round(next.w)}x${Math.round(next.h)}` });
    }
    if (node.fill !== next.fill && (node.fill !== undefined || next.fill !== undefined)) {
      recolored.push({ id, name: next.name, ...(node.fill !== undefined ? { from: node.fill } : {}), ...(next.fill !== undefined ? { to: next.fill } : {}) });
    }
    if (node.name !== next.name) renamed.push({ id, from: node.name, to: next.name });
    if (node.texts.join("|") !== next.texts.join("|")) textChanged.push({ id, name: next.name });
  }

  const density = (map: Map<string, FlatNode>): number => {
    let area = 0;
    for (const node of map.values()) area += Math.max(0, node.w) * Math.max(0, node.h);
    return Math.round(area);
  };

  return {
    status: "ok",
    summary: {
      added: added.length,
      removed: removed.length,
      moved: moved.length,
      resized: resized.length,
      recolored: recolored.length,
      renamed: renamed.length,
      textChanged: textChanged.length,
      areaDelta: density(after) - density(before),
    },
    added: added.slice(0, 20),
    removed: removed.slice(0, 20),
    moved: moved.slice(0, 20),
    resized: resized.slice(0, 20),
    recolored: recolored.slice(0, 20),
    renamed: renamed.slice(0, 20),
    textChanged: textChanged.slice(0, 20),
  };
}