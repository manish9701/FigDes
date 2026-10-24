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
import { verifyRepairs } from "./verdict";
import { scoreDesign } from "./score";
import { critiqueVisual } from "./critique";
import { evaluateQualityGate } from "./quality";
import { evaluateGenericity } from "../design/quality/genericity";
import { evaluateConsistency } from "../design/quality/consistency";
import { extendCritique } from "../design/quality/visual-critic";
import { planRepairs } from "../design/quality/repair-planner";
import { evaluateFinalGate, compatibilityOfBuilds } from "../design/quality/final-gate";
import { SERVER_BUILD } from "../../../shared/protocol";
import { makeFindings, trackFindings } from "../design/quality/visual-findings";
import { contentRevision } from "../design/quality/revision";
import { analyzeScreenshot } from "../design/quality/screenshot-qa";
import { evaluateAccessibility, accessibilityInputFromMetrics } from "../design/quality/accessibility";
import { guardMutation } from "../plan/gate";
import { dispatchTransaction } from "../transaction";
import type { Session, SessionRegistry } from "../sessions";
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

/**
 * Whether the model's own visual observations report a defect.
 *
 * The naive version scanned the raw text for defect words, and turned praise
 * into a FAIL: "not a generic card wall", "nothing broken", "no overlap" all
 * NAME the absence of a defect — measured live on the issue-22 loop, a
 * critique returned FAIL + FAIL with zero blocking issues and every dimension
 * PASS because its observations praised the screen in exactly that shape.
 * Negated spans are stripped before the scan (a bounded window, so a real
 * defect later in the sentence survives), and whole words are matched so
 * "badging" or "standard" cannot trigger.
 */
const NEGATED_SPAN = /\b(?:no|not|never|without|isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t|can'?t|cannot|zero|none|nothing|free of|lacks?|absent)\b[^,;.!?]*/gi;
const DEFECT_WORD = /\b(?:fails?|failed|failing|broken|broke|wrong|generic|templated|template-y|clip\w*|cut off|overflow\w*|overlapping?|spill\w*|unreadable|crowded|cramped|wall)\b/gi;

export function observationFails(observation: Record<string, unknown> | null | undefined): boolean {
  if (!observation || typeof observation !== "object") return false;
  const text = Object.values(observation)
    .filter((v): v is string => typeof v === "string")
    .join(" ");
  if (text.trim().length === 0) return false;
  return text.replace(NEGATED_SPAN, " ").match(DEFECT_WORD) !== null;
}

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
    // No coordinate shift: metrics x/y are already parent-relative (see
    // metrics.ts boxOf — it reads node.x/node.y, which Figma reports against
    // the parent). Subtracting the target offset again pushed every child
    // into negative space and made balanced rows read as "100% one side".
    const boxes = new Map(nodes.map((n) => [n.id, { id: n.id, x: n.x, y: n.y, w: n.w, h: n.h }]));
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
    const observationFail = observationFails(observation);

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

    /**
     * Render-revision binding on the emitted findings (checklist #23b).
     *
     * These findings exist only because of the screenshot; their proof is the
     * image. Binding each one to the content revision this run measured (and
     * marked stale:false at emit time) means a later reader can tell whether
     * an old screenshot is being used to certify work done after it — the
     * failure mode where a stale image silently vouches for a newer revision.
     * Unlocalized findings (no measured nodes under the area) state that
     * explicitly rather than shipping an empty nodeIds array that reads as
     * "affects nothing".
     */
    const renderRevision = contentRevision({ nodes: nodes.map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]) }, "render");
    const emittedFindings = findings.map((f) => ({
      ...f,
      renderRevision,
      stale: false as const,
      ...(f.nodeIds.length === 0 ? { targetsHint: "targets: unknown, re-inspect" } : {}),
      nextStep: {
        tool: "modify_design",
        needs: "nodeIds",
        ...(f.nodeIds.length > 0
          ? { detail: `Repair from the finding's nodeIds (${f.nodeIds.slice(0, 4).join(", ")}), then re-render.` }
          : { detail: "No measured nodes under this area — inspect first, do not guess." }),
      },
    }));

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
        findings: emittedFindings,
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

/**
 * What happened to one finding, stated rather than implied.
 *
 * Issue #11: the loop "applied 12 contrast fixes but skipped 22 other findings
 * because no operation was available. It must distinguish a completed operation
 * from verified quality convergence." A single `applied: 12` figure cannot carry
 * that — it reads as "the screen is fixed" when 22 findings are untouched, and a
 * reader has no way to tell which is which.
 */
export type Disposition =
  /** An operation was applied and the finding is gone on re-measurement. */
  | "fixed"
  /** An operation was applied and the finding is still there. */
  | "fix-did-not-resolve"
  /** High-confidence, but the rule proposes no operation. Needs a human or a better rule. */
  | "not-auto-fixable"
  /** Held back by preserve[], the approval gate, or a failed transaction. */
  | "blocked"
  /** Below the auto-apply confidence threshold; a judgement call. */
  | "needs-human";

interface RefineSkip {
  rule: string;
  /** Why this finding could not be repaired automatically. */
  reason: string;
}

export interface FindingDisposition {
  rule: string;
  disposition: Disposition;
  /** The nodes the finding is about. */
  targets: string[];
  /** What was proposed, in the author's terms. */
  proposedChange: string | null;
  /** Why it was or was not applied. */
  reason: string;
  /** The measurements that triggered the finding. */
  before: Record<string, unknown> | null;
  /** The measurements after the repair ran, when it was applied. */
  after: Record<string, unknown> | null;
  confidence: Finding["confidence"];
}

/** One-line summary of what an operation would do, for a human to judge. */
function describeChange(f: Finding): string | null {
  const ops = f.suggestedOperations ?? [];
  if (ops.length === 0) return null;
  return ops
    .map((op) => {
      const o = op as unknown as Record<string, unknown>;
      const target = String(o.target ?? o.id ?? "?");
      switch (o.type) {
        case "setFill":
          return `set ${target} fill to ${String(o.fill)}`;
        case "setCornerRadius":
          return `set ${target} radius to ${String(o.radius)}px`;
        case "setTextStyle":
          return `set ${target} to ${String(o.fontSize ?? o.size)}px`;
        case "setOpacity":
          return `set ${target} opacity to ${String(o.opacity)}`;
        case "renameNode":
          return `rename ${target}`;
        default:
          return `${String(o.type)} on ${target}`;
      }
    })
    .join("; ");
}

/**
 * Why a high-confidence finding produced no fix.
 *
 * A bare list of rule names told the reader nothing actionable: hard stress test
 * #10 reported eight skipped contrast findings with no indication that the rule
 * simply had no `suggestedOperations`, which is a repairable gap rather than a
 * judgement call. Every skip now names its cause so the next step is obvious.
 */
function skipReason(f: Finding, preserve: Set<string>): string {
  if (preserve.has(f.rule)) return `rule '${f.rule}' is in preserve[]`;
  if (f.nodeIds.some((id) => preserve.has(id))) return "touches a node in preserve[]";
  if ((f.suggestedOperations?.length ?? 0) === 0) return `rule '${f.rule}' proposes no operation — fix it by hand`;
  return `confidence '${f.confidence}' is below the auto-apply threshold`;
}

/** Stable identity for a finding across re-measurements. */
const findingKey = (f: Finding): string => `${f.rule}:${[...f.nodeIds].sort().join(",")}`;

/**
 * The measurements worth carrying from one measurement of a finding.
 *
 * Kept small on purpose: the point is to show whether the number that triggered
 * the finding moved, not to mirror the whole evidence object twice.
 */
function evidenceSnapshot(f: Finding): Record<string, unknown> {
  const e = (f.evidence ?? {}) as Record<string, unknown>;
  const keep = ["ratio", "required", "size", "minimum", "role", "spills", "overlaps", "majorityRadius", "distance"];
  const out: Record<string, unknown> = {};
  for (const key of keep) if (e[key] !== undefined) out[key] = e[key];
  return out;
}

interface RefineIteration {
  iteration: number;
  highConfidenceFindings: number;
  appliedFixes: number;
  appliedRules: string[];
  skipped: RefineSkip[];
  remainingHigh: number;
  /** What this iteration observed, recorded so the accounting matches the trace. */
  observed: string;
  /** Findings verified gone on the re-measurement that followed this iteration. */
  verified: number;
}

export async function refineScreenTool(session: Session | null, rawArgs: unknown, registry?: SessionRegistry): Promise<unknown> {
  const args = RefineArgs.parse(rawArgs);
  const goals = args.visualGoals ?? [];
  const preserve = new Set(args.preserve);
  const compositionLed = goals.some((g) => /topology|spatial|visual|composition|hierarchy|runtime|instrument/i.test(g));
  const iterations: RefineIteration[] = [];

  if (!session) {
    throw new Error("refine_screen needs a connected Figma plugin: it reviews and fixes the live document.");
  }

  // The plugin's collect_metrics scopes on `target` (a node id string).
  // Passing { nodeId } is silently ignored, so the refinement loop would
  // measure the current selection or the whole page instead of the node the
  // caller named — the same defect final_qa had, fixed twice and missed here.
  // Normalise to { target } so the loop reviews exactly the request.
  let target: Record<string, unknown> = {};
  if (args.nodeId) target = { target: args.nodeId };

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
    // Issue #29: the build phase is a full design_runtime dispatch, so it runs
    // under the same provenance gate. An approved+reason from the refine call
    // covers the build (single-use, counted), and a refusal comes back as the
    // tool's own result — the loop stops before polishing a screen that was
    // never built.
    const built = (await runRuntimeTool(session, {
      program: args.program,
      description: args.description ?? "refine_screen build phase",
      ...(args.approved !== undefined ? { approved: args.approved } : {}),
      ...(args.reason !== undefined ? { reason: args.reason } : {}),
    })) as Record<string, unknown>;
    if (built?.["status"] === "needs-approval") return built;
  }

  let converged = false;
  const dispositions = new Map<string, FindingDisposition>();
  // The last iteration's findings, kept so the verdict can be computed from
  // the measurements rather than from the loop's own bookkeeping.
  type LoopFinding = ReturnType<typeof runRules>[number];
  let lastFindings: LoopFinding[] = [];
  let lastActionable: LoopFinding[] = [];
  let lastAfter = new Map<string, LoopFinding>();

  for (let i = 1; i <= args.maxIterations; i++) {
    const raw = (await session.request("collect_metrics", target)) as MetricsReport;
    const allFindings = runRules(raw, "review");
    const findings = allFindings.filter((f) => f.confidence === "high");
    lastFindings = findings;

    // Preserve list applies to node ids and to rule names: either skips a fix.
    const actionable = findings.filter(
      (f) => !preserve.has(f.rule) && f.suggestedOperations && f.suggestedOperations.length > 0 && !f.nodeIds.some((id) => preserve.has(id)),
    );
    lastActionable = actionable;
    const skipped: RefineSkip[] = findings.filter((f) => !actionable.includes(f)).map((f) => ({ rule: f.rule, reason: skipReason(f, preserve) }));

    // Every high-confidence finding gets a disposition, including the ones a
    // previous iteration already fixed — those are what makes "converged" a claim
    // rather than an assertion.
    for (const f of actionable) {
      dispositions.set(findingKey(f), {
        rule: f.rule,
        disposition: "blocked",
        targets: f.nodeIds,
        proposedChange: describeChange(f),
        reason: "queued for this iteration",
        before: evidenceSnapshot(f),
        after: null,
        confidence: f.confidence,
      });
    }
    for (const f of findings.filter((f) => !actionable.includes(f))) {
      const key = findingKey(f);
      if (dispositions.has(key)) continue;
      dispositions.set(key, {
        rule: f.rule,
        disposition: preserve.has(f.rule) || f.nodeIds.some((id) => preserve.has(id)) ? "blocked" : (f.suggestedOperations?.length ?? 0) === 0 ? "not-auto-fixable" : "needs-human",
        targets: f.nodeIds,
        proposedChange: describeChange(f),
        reason: skipReason(f, preserve),
        before: evidenceSnapshot(f),
        after: null,
        confidence: f.confidence,
      });
    }

    if (actionable.length === 0) {
      iterations.push({
        iteration: i,
        highConfidenceFindings: findings.length,
        appliedFixes: 0,
        appliedRules: [],
        skipped,
        remainingHigh: findings.length,
        verified: 0,
        observed: `${findings.length} high-confidence finding(s), none with an applicable fix`,
      });
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
        dispositions: [...dispositions.values()],
        question: gate.question,
        ifApproved: gate.ifApproved,
        instead: gate.instead,
        howToProceed: "Nothing further was changed. Re-send with approved:true to let the loop apply these fixes.",
      };
    }

    let applied: { status?: string; error?: { message?: string } };
    // Issue #23 close-out: the loop's fix transactions mutate the document, so
    // they go through the tracked dispatcher (blocking preflight, job ledger,
    // document lock, transaction-call idempotency) like every other mutating
    // path.
    // Issue #26: the registry-less fallback is gone. Dispatching straight to
    // the socket bypasses the ledger, so a retried fix duplicates work and a
    // timed-out one leaves nothing to reconcile against. Without a registry
    // the loop refuses instead of sending blind.
    const fixDescription = `refine_screen iteration ${i}: ${actionable.map((f) => f.rule).join(", ")}`;
    if (registry) {
      try {
        applied = await dispatchTransaction(registry, session, "modify_design", {
          description: fixDescription,
          operations: operations as unknown[],
        });
      } catch (err) {
        // The dispatcher throws on refusals and unknown outcomes instead of
        // returning a failed payload; funnel that into the same failed shape
        // the loop already reports, naming the obstacle verbatim.
        applied = { status: "failed", error: { message: err instanceof Error ? err.message : String(err) } };
      }
    } else {
      applied = {
        status: "failed",
        error: {
          message:
            "Refused: refine_screen fixes dispatch through the tracked transaction dispatcher (job ledger with same-id idempotency). No registry was threaded, so nothing was sent blind. Re-invoke with a connected registry/session so the fix lands in the ledger.",
        },
      };
    }

    if (applied.status !== "success") {
      for (const key of actionable.map(findingKey)) {
        const d = dispositions.get(key);
        if (d) {
          d.disposition = "blocked";
          d.reason = `the fix transaction failed: ${applied.error?.message ?? "no error detail"}`;
        }
      }
      iterations.push({
        iteration: i,
        highConfidenceFindings: findings.length,
        appliedFixes: 0,
        appliedRules: [],
        skipped,
        remainingHigh: findings.length,
        verified: 0,
        observed: `the fix transaction failed: ${applied.error?.message ?? "no error detail"}`,
      });
      return {
        status: "fix-failed",
        iterations,
        dispositions: [...dispositions.values()],
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
      verified: 0,
      observed: `${actionable.length} fix(es) committed, re-measuring`,
    });

    // Re-measure and check each fix individually. "The operations executed" is
    // not "the finding is gone": a setFill on the wrong node, or a node the
    // client cannot read back, both execute cleanly and fix nothing. Only a
    // re-measurement can tell them apart, so it is not optional.
    let recheck: MetricsReport | null = null;
    let recheckError: string | null = null;
    try {
      recheck = (await session.request("collect_metrics", target)) as MetricsReport;
    } catch (err) {
      recheckError = err instanceof Error ? err.message : String(err);
    }
    if (recheck === null) {
      // The loop cannot see the result. Say so, rather than reporting the
      // fixes as applied and the screen as improved.
      for (const f of actionable) {
        const d = dispositions.get(findingKey(f));
        if (!d) continue;
        d.disposition = "blocked";
        d.reason = `the re-check could not run, so the repair cannot be verified: ${recheckError ?? "no reason recorded"}`;
      }
      iterations.push({
        iteration: i,
        highConfidenceFindings: findings.length,
        appliedFixes: operations.length,
        appliedRules: actionable.map((f) => f.rule),
        skipped,
        remainingHigh: -1,
        verified: 0,
        observed: `the re-check could not run: ${recheckError ?? "no reason recorded"}`,
      });
      return {
        status: "fix-failed",
        iterations,
        dispositions: [...dispositions.values()],
        error: `the re-check could not run: ${recheckError ?? "no reason recorded"}`,
        verdict: "INDETERMINATE",
        verdictReason: "The repairs were applied but the screen could not be re-measured, so nothing about it has been verified.",
        howToProceed: "Re-read the target and re-run the loop; the repairs are in the file.",
      };
    }
    const after = new Map(runRules(recheck, "review").map((f) => [findingKey(f), f]));
    lastAfter = after;
    let verified = 0;

    for (const f of actionable) {
      const d = dispositions.get(findingKey(f));
      if (!d) continue;
      const still = after.get(findingKey(f));
      if (still) {
        d.disposition = "fix-did-not-resolve";
        d.after = evidenceSnapshot(still);
        d.reason = "the operation was applied but the finding is still reported on re-measurement";
      } else {
        d.disposition = "fixed";
        // The before/after pair, even when the "after" is an absence. A
        // repair that cannot be shown to have changed anything is not a
        // verified repair.
        d.after = { gone: true, remeasured: true };
        d.reason = "applied and no longer reported on re-measurement";
        verified += 1;
      }
    }

    iterations[iterations.length - 1]!.verified = verified;
    const remaining = [...after.values()].filter((f) => f.confidence === "high").length;
    iterations[iterations.length - 1]!.remainingHigh = remaining;

    if (i === args.maxIterations) break;
    if (remaining === 0) {
      converged = true;
      break;
    }
  }

  const ran = iterations.length;
  const last = iterations[iterations.length - 1];
  const outstanding = last?.remainingHigh ?? 0;
  const blocked = last?.skipped ?? [];
  const all = [...dispositions.values()];

  // Overflow is the one class the issue calls out by name: a screen whose
  // geometry is broken is not converged, whatever its contrast count says.
  const stillOverflowing = all.filter((d) => d.disposition !== "fixed" && d.rule === "overflow");
  const structuralOutstanding = stillOverflowing.length + all.filter((d) => d.disposition === "fix-did-not-resolve").length;
  if (structuralOutstanding > 0) converged = false;

  const counts: Record<string, number> = {};
  for (const d of all) counts[d.disposition] = (counts[d.disposition] ?? 0) + 1;

  /**
   * The loop's own verdict.
   *
   * `converged` says the loop stopped; this says whether the screen is
   * actually better, and it is computed from the measurements rather than
   * from the loop's own bookkeeping. A repair that introduced a new finding,
   * or a repaired finding that is still reported, is a FAIL — and a loop that
   * could not re-measure is INDETERMINATE, never a pass.
   */
  const verification = verifyRepairs({
    before: lastFindings.map((f) => ({
      key: findingKey(f),
      rule: f.rule,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      nodeIds: [...f.nodeIds],
      evidence: { ...(f.evidence as Record<string, unknown>) },
    })),
    after: [...lastAfter.values()].map((f) => ({
      key: findingKey(f),
      rule: f.rule,
      severity: f.severity,
      confidence: f.confidence,
      title: f.title,
      nodeIds: [...f.nodeIds],
      evidence: { ...(f.evidence as Record<string, unknown>) },
    })),
    applied: lastActionable.map((f) => ({ key: findingKey(f), rule: f.rule, targets: [...f.nodeIds] })),
    recheck: "ran",
    notAutoFixable: counts["not-auto-fixable"] ?? 0,
    blocked: counts["blocked"] ?? 0,
  });

  return {
    status: converged ? "converged" : "budget-exhausted",
    verdict: verification.verdict,
    verdictReason: verification.reason,
    verification: {
      fixed: verification.fixed.length,
      unresolved: verification.unresolved,
      regressions: verification.regressions,
      evidence: verification.evidence,
      measured: verification.measured,
    },
    iterations,
    visualGoals: goals,
    /**
     * One line per finding: what it was, what was done, and what was measured
     * afterwards. This is the artefact that makes the loop auditable — a caller
     * can tell "fixed and verified" from "could not be fixed" without re-running
     * anything.
     */
    dispositions: all,
    dispositionCounts: counts,
    // The summary counts iterations that actually ran, not the budget. The old
    // message interpolated `maxIterations`, so a loop that broke after one
    // unfixable review reported "after 3 iterations" — hard stress test #10 saw
    // exactly one visible iteration described as three.
    summary: {
      iterationsRun: ran,
      iterationBudget: args.maxIterations,
      highConfidenceRemaining: outstanding,
      skippedFixes: blocked.length,
      fixed: counts["fixed"] ?? 0,
      unresolvedStructural: structuralOutstanding,
    },
    ...(stillOverflowing.length > 0
      ? {
          unresolvedOverflow: stillOverflowing.map((d) => ({ rule: d.rule, targets: d.targets, reason: d.reason })),
          note: "Overflow is still reported. This screen is not converged, regardless of how many contrast findings were fixed.",
        }
      : {}),
    ...(blocked.length > 0
      ? {
          whyNothingWasApplied: blocked.map((s) => `${s.rule}: ${s.reason}`),
          howToApplyThoseFixes:
            "Each skipped finding names its cause. A finding with no proposed operation has to be fixed by hand, or the rule has to be taught to propose one.",
        }
      : {}),
    /**
     * Issue #26 (GitHub) — the composition-escalation gate: when the loop ends
     * with findings it could not resolve (fix applied but the defect stayed,
     * or overflow still reported), the screen's shape is the suspect. The
     * result says so explicitly: return to composition exploration instead of
     * another cosmetic pass.
     */
    ...(structuralOutstanding > 0
      ? {
          compositionReviewRequired: {
            required: true,
            unresolved: structuralOutstanding,
            instruction:
              "Focused repairs did not resolve these finding(s), which means the screen's composition — not its spacing or typography — is the defect. " +
              "Stop cosmetic patching: re-run plan_screen (or design_pipeline) for this screen and compare structural variants before rebuilding.",
          },
        }
      : {}),
    howToProceed: converged
      ? (compositionLed
        ? "No high-confidence structural findings remain. Run a successful low-detail render and judge the image before design_guard."
        : "No high-confidence findings remain. Render at low detail to judge hierarchy, then run design_guard before calling it done.")
      : blocked.length > 0 && outstanding === blocked.length
        ? `Stopped after ${ran} iteration(s): all ${outstanding} remaining finding(s) were skipped rather than fixed (${blocked.length} skipped). Nothing further will change by re-running — read whyNothingWasApplied and either fix by hand or widen the rules.`
        : `Still ${outstanding} high-confidence finding(s) after ${ran} iteration(s). Widen maxIterations (max ${args.maxIterations + 2 > 5 ? 5 : args.maxIterations + 2}) or fix the rest by hand.`,
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
    /**
     * The transaction that produced the screen under judgement (issue #25).
     * Optional: the final-gate stamp is more truthful when it names the
     * transaction the verdict certifies, and the caller may know it.
     */
    transactionId: z.string().max(200).optional(),
  })
  .strict();

interface ChecklistItem {
  area: "PRODUCT" | "COMPOSITION" | "SYSTEM" | "VISUAL" | "TECHNICAL" | "ACCESSIBILITY";
  check: string;
  pass: boolean | null;
  detail: string;
}

/**
 * Derives consistency inputs from compiled operations by scanning their
 * serialised form for fills, radii and font families. Shape-agnostic: it
 * works regardless of which op produced the value, because it reads values
 * rather than op types.
 */
function consistencyInputsFromProgram(operations: unknown[]): { fills: string[]; radii?: number[]; families?: string[] } {
  const json = JSON.stringify(operations ?? []);
  const fills = [...json.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0] ?? "").filter((s) => s.length > 0);
  const radii = [...json.matchAll(/"(?:radius|cornerRadius)"\s*:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
  const families = [...json.matchAll(/"family"\s*:\s*"([^"]{1,80})"/g)]
    .map((m) => m[1] ?? "")
    .filter((s) => s.length > 0);
  const out: { fills: string[]; radii?: number[]; families?: string[] } = { fills };
  if (radii.length > 0) out.radii = radii;
  if (families.length > 0) out.families = families;
  return out;
}

/**
 * Counts interaction-state signals in compiled operations.
 *
 * States in this system are expressed as non-default semantic variants
 * (`tone: healthy|warning|…`, `health: degraded|offline`, `variant:
 * loading|destructive`, `selected/disabled/pressured/active/skipped`) rather
 * than a dedicated op, so the count reads the same args the builders do.
 * Structural repetition of the SAME state (ten healthy pills) counts once per
 * distinct state name: evidence is variety, not volume.
 */
export function countStateSignals(operations: Array<Record<string, unknown>>): number {
  const STATE_KEYS = ["tone", "health", "variant", "state", "selected", "disabled", "active", "skipped"];
  const values = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const v of value) walk(v);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (STATE_KEYS.includes(k) && (typeof v === "string" || typeof v === "boolean") && v !== "" && v !== false) {
        values.add(`${k}=${String(v)}`);
      } else if (typeof v === "object" && v !== null) {
        walk(v);
      }
    }
  };
  walk(operations);
  return values.size;
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
  /**
   * The §18 final gate's own report (issue #25), hoisted so the return value
   * can carry it alongside the coarse checklist instead of discarding it.
   */
  let finalGate: ReturnType<typeof evaluateFinalGate> | null = null;

  /**
   * Issue #26 (GitHub) — live render evidence, collected once and bound.
   *
   * final_qa used to render the live target as a liveness probe and throw the
   * evidence away: the final gate's required render-evidence record was
   * derived `notEvaluated`, so the verdict could never be PASS even when the
   * render succeeded. Now the render is EVIDENCE: bound to the content
   * revision of the measured tree (a screenshot proves the state it depicts,
   * and nothing mutates in between), passed through the screenshot sanity
   * check, and fed into the final gate — a missing, failed or blank render
   * refuses visual approval instead of going unnoticed.
   */
  const targetSpecified = args.target !== undefined || args.nodeId !== undefined;
  let liveMetrics: MetricsReport | null = null;
  let liveRevision: string | null = null;
  let renderEvidence: {
    ok: boolean;
    inspected: boolean;
    analysis: { renderStatus: string; warnings: Array<{ code: string; message: string; confidence: number }> } | null;
    detail: string;
    width?: number;
    height?: number;
  } | null = null;
  let targetArg: Record<string, unknown> = {};
  if (session && targetSpecified) {
    // The plugin's collect_metrics scopes on `target` (a node id string).
    // Passing { nodeId } is silently ignored and scans the whole file, which
    // is how a scoped review with 0 highs became a file-wide FAIL. Normalise
    // both shapes to { target } here.
    targetArg = args.nodeId !== undefined
      ? { target: args.nodeId }
      : typeof (args.target as Record<string, unknown> | undefined)?.["nodeId"] === "string"
        ? { target: (args.target as Record<string, unknown>)["nodeId"] as string }
        : (args.target as Record<string, unknown>);
    try {
      liveMetrics = (await session.request("collect_metrics", targetArg)) as MetricsReport;
    } catch (err) {
      liveMetrics = null;
      renderEvidence = { ok: false, inspected: false, analysis: null, detail: `the live measurement failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (liveMetrics !== null) {
      // The revision is a fingerprint of the measured tree — the same binding
      // the pipeline uses, so evidence from either path is comparable.
      liveRevision = contentRevision(
        { target: targetArg.target, nodes: liveMetrics.nodes.map((n) => [n.id, n.x, n.y, n.w, n.h, n.fill, n.name]) },
        "rev",
      );
    }
    // The render, and its sanity check. A render that returns an image that
    // decodes to a blank canvas has not been LOOKED at: that inspection
    // failed, and the gate treats it exactly like a missing render.
    if (liveMetrics !== null) {
      try {
        const rendered = (await session.request(
          "render_node",
          { nodeId: targetArg.target as string, maxWidth: 1024, detail: "low" },
          120_000,
        )) as { data?: string; width?: number; height?: number };
        const gotImage = Boolean(rendered?.data);
        let analysis: { renderStatus: string; warnings: Array<{ code: string; message: string; confidence: number }> } | null = null;
        if (gotImage) {
          try {
            const bytes = new Uint8Array(Buffer.from(rendered.data as string, "base64"));
            analysis = analyzeScreenshot(bytes);
          } catch {
            analysis = null; // decode failure is a warning below, not a crash
          }
        }
        const sane = analysis !== null && analysis.renderStatus === "ok";
        const blankish = analysis !== null && (analysis.renderStatus === "suspect-blank" || analysis.renderStatus === "suspect-uniform");
        renderEvidence = {
          ok: gotImage,
          inspected: sane || blankish,
          analysis,
          detail: gotImage
            ? analysis !== null
              ? `render ${rendered.width}x${rendered.height}, sanity ${analysis.renderStatus}: ${analysis.warnings.map((w) => w.message).join("; ") || "no warnings"}`
              : `render completed at ${rendered.width}x${rendered.height} (sanity check could not decode the image)`
            : "the render returned no image",
          ...(rendered?.width !== undefined ? { width: rendered.width } : {}),
          ...(rendered?.height !== undefined ? { height: rendered.height } : {}),
        };
        // A blank/uniform render is not inspected evidence: the gate refuses
        // visual approval for it (a blank canvas proves nothing was built).
        if (blankish) renderEvidence.inspected = false;
      } catch (err) {
        renderEvidence = { ok: false, inspected: false, analysis: null, detail: `render failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
  }

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
    // An indeterminate guard checked nothing, so it cannot certify the screen.
    // Treating it as "no violations" is the exact substitution issue #10 caught
    // inside the guard itself, one level up.
    const indeterminate = guarded.verdict === "INDETERMINATE";
    const capabilityFailures = guarded.verdict === "FAIL" ? (((guarded as { capabilityTruth?: { findings?: Array<{ id?: string; message?: string; severity?: string }> } }).capabilityTruth?.findings ?? []).filter((f) => f.severity === "fail").map((f) => f.id ?? f.message ?? "capability claim")) : [];
    items.push({
      area: "PRODUCT",
      check: "no product-truth violations",
      pass: indeterminate ? null : failed.length === 0 && capabilityFailures.length === 0,
      detail: indeterminate
        ? `guard: INDETERMINATE — the guard measured nothing, so no product rule was evaluated. Re-run it against a resolvable target.`
        : failed.length === 0 && capabilityFailures.length === 0
          ? `guard: ${guarded.verdict ?? "PASS"}`
          : failed.length > 0
            ? `failing rules: ${failed.map((f) => f.rule ?? "capability").join(", ")}`
            : `capability claims presented without backing: ${capabilityFailures.join(", ")}`,
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
    // Consistency dimension (§7.5): measured from the compiled program's
    // fills, radii and font families. Previously exported but never called by
    // any tool; now a first-class checklist item and a gate blocker when a
    // repair introduced unapproved fills.
    const consistency = evaluateConsistency(consistencyInputsFromProgram(runtime.operations));
    const consistencyBlocking = consistency.blocking ? [`Consistency: ${consistency.evidence.find((e) => e.startsWith("BLOCKING")) ?? "unapproved fills"}`] : [];
    // States evidence (general-use quality lift): a screen with zero
    // interaction states reads as unfinished. Counted from the compiled
    // program's state-bearing args (tones, variants, health, selection,
    // disabled/loading), never guessed.
    const statesDeclared = countStateSignals(runtime.operations as Array<Record<string, unknown>>);

    // Accessibility is part of the release gate, not optional polish (issue #20,
    // workstream 7). When the live node tree is available it is measured with
    // the blueprint evaluator; offline, the gate receives an all-"not checked"
    // input so a clean PASS has to name what was skipped.
    let accessibility: { findings: number; notChecked: string[] } | null = null;
    let a11yItems: Array<{ area: ChecklistItem["area"]; check: string; pass: boolean | null; detail: string }> = [];
    if (liveMetrics !== null) {
      try {
        const a11yInput = accessibilityInputFromMetrics(liveMetrics, liveMetrics.target ?? "live");
        const a11yReport = evaluateAccessibility(a11yInput);
        accessibility = { findings: a11yReport.findings.length, notChecked: [...a11yReport.notChecked, "keyboard/focus behaviour: not verifiable from a static Figma design", "screen-reader semantics: not verifiable from a static Figma design"] };
        a11yItems = [
          {
            area: "ACCESSIBILITY",
            check: "WCAG contrast/target-size checks",
            pass: a11yReport.findings.length === 0 ? true : false,
            detail: a11yReport.summary,
          },
        ];
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        accessibility = { findings: 0, notChecked: [`the accessibility evaluation could not run on the measured tree: ${why}`] };
        a11yItems = [{ area: "ACCESSIBILITY", check: "WCAG contrast/target-size checks", pass: null, detail: `could not measure: ${why}` }];
      }
    } else if (session && targetSpecified && renderEvidence !== null) {
      const why = renderEvidence.detail;
      accessibility = { findings: 0, notChecked: [`the live measurement failed, so no accessibility check ran: ${why}`] };
      a11yItems = [{ area: "ACCESSIBILITY", check: "WCAG contrast/target-size checks", pass: null, detail: `could not measure: ${why}` }];
    } else {
      accessibility = { findings: 0, notChecked: ["no live measurement: nothing about accessibility was evaluated"] };
      a11yItems = [{ area: "ACCESSIBILITY", check: "WCAG contrast/target-size checks", pass: null, detail: "needs the live file: run final_qa against a target" }];
    }

    // Build provenance (issue #25): when a live session is attached, the gate
    // receives the pair actually measured, so a verdict measured while the
    // server and the plugin were different builds — or a pair that cannot be
    // tied to a commit — refuses PASS rather than standing as ordinary. An
    // offline, program-only run touches no live file and stays unaffected.
    const pluginBuild = session && typeof session.build === "string" ? session.build : undefined;
    // Issue #26 (GitHub): the render-evidence gate is fed for real. A render
    // that succeeded AND passed the screenshot sanity check is inspected
    // evidence, revision-bound to the tree it depicts; anything else refuses
    // visual approval instead of silently leaving the gate unevaluated.
    const renderVerified = renderEvidence !== null && renderEvidence.ok && renderEvidence.inspected;
    finalGate = evaluateFinalGate({
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
      blockingIssues: [...failed.map((f) => String(f.rule ?? "guard")), ...consistencyBlocking],
      states: { declared: statesDeclared },
      ...(accessibility !== null ? { accessibility } : {}),
      ...(pluginBuild !== undefined
        ? {
            buildCompatibility: compatibilityOfBuilds(SERVER_BUILD, pluginBuild),
            stamp: {
              pluginBuild,
              ...(args.transactionId !== undefined ? { transactionId: args.transactionId } : {}),
            },
          }
        : {}),
      ...(renderEvidence !== null
        ? {
            visualEvidenceVerified: renderVerified,
            // Revision binding: the evidence must depict the revision being
            // judged. final_qa mutates nothing between measuring and
            // rendering, so a successful render is bound to the measured
            // revision; a missing one has no revision to bind.
            expectedRevision: liveRevision ?? undefined,
            evidenceRevision: renderVerified ? liveRevision : null,
          }
        : {}),
    });
    items.push(
      { area: "SYSTEM", check: "design tokens consistent", pass: consistency.blocking ? false : consistency.score >= 70 ? true : null, detail: `consistency ${consistency.score}/100: ${consistency.evidence.slice(0, 2).join("; ")}` },
      {
        area: "COMPOSITION",
        check: "interaction states declared",
        pass: statesDeclared > 0 ? true : null,
        detail: statesDeclared > 0 ? `${statesDeclared} state signal(s) in the program` : "no states: add one hover, selected or non-default tone so the screen reads as finished",
      },
      ...a11yItems,
      {
      area: "VISUAL",
      check: "final visual-quality gate",
      pass: finalGate.status === "FAIL" ? false : finalGate.status === "REVIEW" ? null : true,
      detail: `final-gate ${finalGate.status}: ${finalGate.reason}`,
    });
  }

  if (session && targetSpecified) {
    // Issue #26 (GitHub): measured and rendered once above, consumed here —
    // the old code collected metrics and rendered a second time, paying two
    // extra round trips and leaving the evidence unbound.
    const reviewFindings = liveMetrics !== null ? runRules(liveMetrics, "review") : [];
    const high = reviewFindings.filter((f) => f.confidence === "high");
    const cardWall = reviewFindings.some((f) => f.rule === "card-wall");
    items.push(
      {
        area: "TECHNICAL",
        check: "no overflow or broken structure",
        pass: liveMetrics !== null ? high.length === 0 : false,
        detail:
          liveMetrics !== null
            ? high.length === 0
              ? `no high-confidence findings in ${liveMetrics.scope} (${liveMetrics.nodeCount} nodes)`
              : `${high.length} high-confidence in ${liveMetrics.scope}: ${high.map((f) => f.rule).join(", ")}`
            : (renderEvidence?.detail ?? "the live measurement failed"),
      },
      {
        area: "COMPOSITION",
        check: "no accidental card wall",
        pass: liveMetrics !== null ? !cardWall : false,
        detail: liveMetrics !== null ? (cardWall ? "card-wall rule fired" : "no card wall detected") : "not measured: the live measurement failed",
      },
      {
        area: "TECHNICAL",
        check: "render succeeds",
        pass: renderEvidence?.ok === true,
        detail: renderEvidence?.detail ?? "needs the live file: render at low detail",
      },
      // The screenshot sanity check, finally running in a live path: a render
      // that decodes to a near-blank or plain-fill image is reported, never
      // silently approved.
      {
        area: "VISUAL",
        check: "render is a screen, not a blank canvas",
        pass: renderEvidence === null ? null : renderEvidence.ok ? (renderEvidence.inspected ? true : null) : null,
        detail:
          renderEvidence === null
            ? "needs the live file"
            : renderEvidence.analysis !== null && renderEvidence.analysis.warnings.length > 0
              ? renderEvidence.analysis.warnings.map((w) => w.message).join("; ")
              : renderEvidence.ok
                ? "the render decodes to a varied image (screenshot sanity passed)"
                : "no image: the render failed",
      },
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
    verdict: failed.length > 0 ? "FAIL" : pending.length > 0 ? "PASS WITH LIVE CHECKS PENDING" : "PASS",
    /**
     * Issue #26 (GitHub): the render evidence, stated on the payload — the
     * revision it is bound to, whether it was inspected (sanity passed), and
     * what the sanity check saw. An approval should be traceable to the exact
     * image it was based on.
     */
    ...(renderEvidence !== null || liveRevision !== null
      ? {
          renderEvidence: {
            revision: liveRevision,
            rendered: renderEvidence?.ok === true,
            inspected: renderEvidence !== null && renderEvidence.ok && renderEvidence.inspected,
            detail: renderEvidence?.detail ?? null,
          },
        }
      : {}),
    /**
     * The truthful final gate (issue #25), no longer discarded: the verdict
     * that can never PASS on a skipped gate, every gate record, the
     * build/session stamp, and the reasons. Read these over the coarse
     * checklist verdict above — a build mismatch, an unstamped verdict or a
     * skipped gate refuses PASS here.
     */
    ...(finalGate !== null
      ? {
          finalGate: {
            verdict: finalGate.verdict,
            gates: finalGate.gates,
            stamp: finalGate.stamp,
            verdictReasons: finalGate.verdictReasons,
          },
        }
      : {}),
    checklist: items,
    failed: failed.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    pendingLiveChecks: pending.map((i) => `${i.area}: ${i.check} — ${i.detail}`),
    howToProceed:
      failed.length > 0
        ? "Fix every failed item, then re-run. A screen that misses critical criteria is not finished."
        : pending.length > 0
          ? "Clear the pending live checks (review_design, one low-detail render, design_guard with inspect:true), then call it done."
          : "Every check ran and passed. Call it done.",
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