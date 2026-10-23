/**
 * The MCP surface.
 *
 * Six V1 tools (SPEC §10). High-level on purpose — the model gets design
 * intent, not hundreds of thin wrappers over figma.* (SPEC §10, §15).
 *
 * `operations` is advertised to clients as a permissive array of allowlisted
 * objects with a long-form description, then validated strictly against the
 * zod discriminated union in shared/protocol.ts before anything reaches the
 * plugin. The loose client schema exists for readability; the strict schema is
 * what actually enforces.
 */
import { z } from "zod";
import {
  OPERATION_TYPES,
  SERVER_BUILD,
  type MetricsReport,
  type ReviewReport,
  type ToolName,
  type PluginToolName,
  type TransactionResult,
  type ReviewVerdict,
  type StatusResult,
} from "../../shared/protocol";
import { SessionRegistry, type Session, TransactionTimeoutError, SessionDisconnectedError } from "./sessions";
import { runRules, summarise, evaluatedRuleCount, evaluatedRuleNames, type RuleSet } from "./review/rules";
import { reviewVerdict, MIN_REVIEW_NODES } from "./review/verdict";
import { CompileArgs, RuntimeArgs, compileIrTool, runRuntimeTool, runtimeCatalogue } from "./runtime/tools";
import { renderDesign } from "./render-tool";
import { DesignGuardArgs, ProjectMemoryArgs, designGuardTool, projectMemoryTool } from "./memory/tools";
import { PlanScreenArgs, planScreenTool } from "./plan/tools";
import { DesignBriefArgs, designBriefTool } from "./plan/brief";
import { DesignPipelineArgs, designPipelineTool } from "./pipeline/tools";
import { projectKey } from "./memory/store";
import { saveSnapshot, listSnapshots, getSnapshot } from "./snapshots/store";
import { guardMutation, resolveExistingResources } from "./plan/gate";
import { exoSeedOperations, exoSeedCounts } from "./tokens/exo";
import { ScoreArgs, CritiqueArgs, RefineArgs, DiffArgs, FinalQaArgs, scoreDesignTool, critiqueVisualTool, refineScreenTool, diffDesignTool, finalQaTool } from "./review/workflow";
import { clients } from "./clients/registry";
import { exportCode } from "./code/export";
import { UseFigmaArgs, InspectVisualArgs, ReadContextArgs, figdesUseFigmaHandler, figdesInspectVisualHandler, figdesReadContextHandler } from "./native/use-figma";
import { validateTransaction } from "./preflight";
import { assertTransaction, dispatchTransaction } from "./transaction";
import { EditScreenArgs, editScreenTool } from "./review/edit-screen";
import {
  recordDuplicateRetry,
  recordPreflightCatch,
  recordRollback,
  recordToolCall,
  recordTransaction,
  snapshot as metricsSnapshot,
} from "./metrics";
import { randomUUID } from "node:crypto";

/* -------------------------------------------------------------------------- */
/* Shared arg fragments                                                        */
/* -------------------------------------------------------------------------- */

const SessionArg = z.string().max(200).optional().describe("Target a specific open plugin session. Optional when only one is connected.");

const OPERATION_GUIDE = [
  "Structured design operations. This is an allowlisted schema, NOT JavaScript — there is no eval path.",
  "The whole list is applied as a single undoable transaction; if any operation fails, the document is rolled back.",
  "",
  "Give a create operation an `id` to mint a transaction-local reference, then address that node from later",
  "operations via target / parent / child. Real Figma ids (e.g. \"12:34\") also work, so a design can be built",
  "across several tool calls.",
  "",
  "Per-type fields:",
  "  createFrame      id? name? parent? x? y? width height layoutMode? padding? itemSpacing? primaryAxisAlignItems? counterAxisAlignItems? clipsContent? fill? opacity? cornerRadius? visible?",
  "  createRectangle  id? name? parent? x? y? width height fill? stroke? strokeWeight? opacity? cornerRadius? visible?",
  "  createEllipse    id? name? parent? x? y? width height fill? stroke? strokeWeight? opacity? visible?",
  "  createText       id? name? parent? x? y? content family? style? fontSize? lineHeight? letterSpacing? textAlignHorizontal? textAlignVertical? width? fill? opacity? visible?",
  "  renameNode       target name",
  "  setPosition      target x? y?",
  "  setSize          target width? height? ignoreAutoLayout?",
  "  setFill          target fill            fill: \"#RRGGBB\" | \"#RRGGBBAA\" | \"rgb(r,g,b)\" | [{color,opacity?}] | [] to clear",
  "  setStroke        target color weight? align? dashPattern?",
  "  setOpacity       target opacity         0..1",
  "  setCornerRadius  target radius          number or {topLeft,topRight,bottomRight,bottomLeft}",
  "  appendChild      parent child index?",
  "  removeNode       target",
  "  cloneNode        target id? name? parent? x? y?",
  "  setAutoLayout    target mode itemSpacing? padding? primaryAxisAlignItems? counterAxisAlignItems? layoutWrap?",
  "  setPadding       target padding         number or {top,right,bottom,left}",
  "  setGap           target gap",
  "  setTypography    target family? style? fontSize? lineHeight? letterSpacing? textAlignHorizontal? textAlignVertical?",
  "  setTextContent   target content",
  "  setTextStyle     target style          style = an existing local text style, by name (\"EXO/Nav\") or id; create it first",
  "  setVisible       target visible",
  "  setPage          target page?          page = page id or name; defaults to the current page",
  "",
  "Example — a sidebar + content dashboard shell:",
  JSON.stringify(
    {
      operations: [
        { type: "createFrame", id: "root", name: "Dashboard", width: 1440, height: 900, fill: "#F7F5EF" },
        { type: "setAutoLayout", target: "root", mode: "HORIZONTAL", itemSpacing: 0, counterAxisAlignItems: "STRETCH" },
        {
          type: "createFrame",
          id: "sidebar",
          parent: "root",
          name: "Sidebar",
          width: 240,
          height: 900,
          fill: "#111111",
          layoutMode: "VERTICAL",
          padding: 24,
          itemSpacing: 12,
        },
        { type: "createText", parent: "sidebar", name: "Logo", content: "EXO Labs", fill: "#FFFFFF", fontSize: 20 },
      ],
    },
    null,
    2,
  ),
].join("\n");

/**
 * Deliberately loose: only `type` is constrained here. Every other field is
 * re-validated by OperationSchema on the plugin side, which is the real
 * allowlist (SPEC §19).
 */
const OperationItem = z
  .object({
    type: z.enum(OPERATION_TYPES).describe("Operation type. Anything outside this list is rejected."),
    id: z.string().max(64).optional().describe("Transaction-local id for a created node."),
    target: z.string().max(200).optional().describe("A transaction-local id or a Figma node id."),
    parent: z.string().max(200).optional(),
    child: z.string().max(200).optional(),
    name: z.string().max(500).optional(),
    content: z.string().max(20000).optional(),
  })
  .passthrough();

const OperationsArg = z.array(OperationItem).min(1).max(2000).describe(OPERATION_GUIDE);

const NoArgs = z.object({}).strict();

const StatusArgs = z.object({ sessionId: SessionArg }).strict();

const InspectArgs = z
  .object({
    sessionId: SessionArg,
    depth: z.number().int().min(0).max(8).optional().describe("Levels of children to include. Default 4."),
    includeText: z.boolean().optional().describe("Include text content for TEXT nodes. Default true."),
    budget: z.number().int().min(1).max(2000).optional().describe("Max nodes to serialize. Default 400."),
  })
  .strict();

const FileArgs = z
  .object({
    sessionId: SessionArg,
    depth: z.number().int().min(0).max(6).optional().describe("Depth used for top-level frames. Default 1."),
    includeText: z.boolean().optional(),
    budget: z.number().int().min(1).max(2000).optional().describe("Max nodes to serialize. Default 250."),
  })
  .strict();

const CreateArgs = z
  .object({
    description: z.string().max(1000).optional().describe("Short human-readable intent, kept in the audit trail."),
    operations: OperationsArg,
    dryRun: z.boolean().optional().describe("Validate the plan and return the operation trace without modifying the document."),
    /**
     * Records that a human approved a change this tool previously refused.
     *
     * Required only after a `needs-approval` result. Single-use: it covers that one
     * change, not the rest of the session.
     */
    approved: z.boolean().optional().describe("Set only after the user has approved a refused change."),
    reason: z.string().max(400).optional().describe("The user's stated reason, kept in the audit trail."),
    transactionId: z.string().max(200).optional(),
    sessionId: SessionArg,
    /**
     * Plan provenance (issue #26): the plan_screen plan this build comes from,
     * or any marker that design intelligence ran on it. Raw operations bypass
     * ALL design intelligence, so a non-dry-run dispatch without provenance
     * needs an explicit approved+reason justification instead.
     */
    plan: z.unknown().optional().describe("plan_screen program provenance: the plan this build executes. Absent means raw operations."),
    planId: z.string().max(200).optional().describe("Reference to the plan_screen plan this build executes, when the plan itself is not inlined."),
    intelligenceApplied: z.boolean().optional().describe("Set when design intelligence (plan_screen plan or declared visualIntent.style) ran on this build."),
    /**
     * Pre-build score/guard evidence (issue #26): weak spots from score_design
     * and the verdict from design_guard for the design about to be built. A
     * FAIL verdict or critical weak spots refuse the dispatch at the
     * transaction edge unless waived with approved:true plus a reason.
     */
    scoreGuard: z
      .object({
        scoreWeakSpots: z.array(z.unknown()).optional(),
        guardVerdict: z.string().max(32).optional(),
        approved: z.boolean().optional(),
        reason: z.string().max(400).optional(),
      })
      .strict()
      .optional()
      .describe("score_design / design_guard evidence for this build. FAIL or critical weak spots block dispatch unless waived."),
  })
  .strict();

const ModifyArgs = CreateArgs.extend({
  targets: z
    .array(z.string().max(200))
    .max(50)
    .optional()
    .describe("Figma node ids this transaction is intended to affect, for the audit trail."),
});

/* -------------------------------------------------------------------------- */
/* Render + component args                                                     */
/* -------------------------------------------------------------------------- */

export const RenderArgs = z
  .object({
    sessionId: SessionArg,
    nodeId: z.string().max(200).describe("Figma node id to render. Get one from inspect_selection, inspect_file or create_design."),
    maxWidth: z
      .number()
      .int()
      .min(128)
      .max(2048)
      .optional()
      .describe("Output width in pixels, clamped to 2048. Default 1024. Token cost scales with area, so this is the main context lever."),
    detail: z
      .enum(["low", "high"])
      .optional()
      .describe("'low' halves token cost and is enough for layout, balance and hierarchy. 'high' (default) for reading fine text."),
    format: z.enum(["png", "jpg"]).optional().describe("png (default) is best for flat UI. jpg is smaller for gradients and imagery."),
  })
  .strict();

const FindComponentArgs = z
  .object({
    sessionId: SessionArg,
    query: z.string().max(200).optional().describe('What you are looking for, e.g. "StatusRow" or "device card". Omit to list everything.'),
    limit: z.number().int().min(1).max(100).optional().describe("Max results. Default 25."),
  })
  .strict();

const FindNodeArgs = z
  .object({
    sessionId: SessionArg,
    screen: z.string().max(200).optional().describe("Page or top-level frame name to search inside."),
    role: z
      .string()
      .max(60)
      .optional()
      .describe("Semantic role: primaryAction, secondaryAction, activeNavigation, navigation, footerNavigation, heroTitle, sectionHeading, metaLabel, topologyMap, statusBadge, searchField, textInput, toggle, dropdownSelector, dataRow, metric, avatar, iconButton, emptyState, errorState, successState, loadingIndicator, tableHeader, chipTag, breadcrumb, paginationControl, cardContainer."),
    name: z.string().max(200).optional().describe("Substring of the layer name."),
    text: z.string().max(500).optional().describe("Substring of text content."),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const SetVariantArgs = z
  .object({
    sessionId: SessionArg,
    instanceId: z.string().max(200).describe("Figma id of the instance. Resolve it with find_node first."),
    variant: z.string().max(200).optional().describe("Variant name, exact or as Property=Value pairs."),
    properties: z
      .record(z.string())
      .optional()
      .describe("TEXT property overrides, e.g. { Label: 'Deploy' }. At least one of variant/properties is required."),
  })
  .strict();

const UpdateComponentArgs = z
  .object({
    sessionId: SessionArg,
    componentId: z.string().max(200).describe("Component or component-set id. Validated as a master before anything runs."),
    operations: OperationsArg,
    description: z.string().max(1000).optional(),
    dryRun: z.boolean().optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
  })
  .strict();

const CreateComponentSetArgs = z
  .object({
    sessionId: SessionArg,
    name: z.string().min(1).max(200).describe("Name for the new component set."),
    members: z.array(z.string().min(1).max(200)).min(2).max(50).describe("Component ids, or frame/group ids to promote first."),
    parent: z.string().max(200).optional(),
    description: z.string().max(1000).optional(),
  })
  .strict();

const SeedExoArgs = z
  .object({
    sessionId: SessionArg,
    description: z.string().max(1000).optional(),
    dryRun: z.boolean().optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
    themes: z.array(z.string().max(40)).max(8).optional().describe("Extra modes, e.g. ['dark']."),
  })
  .strict();

const ExportArgs = z
  .object({
    sessionId: SessionArg,
    target: z.string().max(200).optional().describe("Figma node id to export. Defaults to the current selection."),
    componentName: z.string().max(120).optional().describe("Component name for the root. Defaults to the frame name."),
    maxNodes: z.number().int().min(10).max(2000).optional().describe("Max nodes converted. Default 500."),
  })
  .strict();

const SnapshotArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    project: z.string().max(200).optional().describe("Which project. Defaults to the connected file."),
    action: z.enum(["save", "list", "get"]).optional().describe("Save a version (default), list versions, or fetch one."),
    screen: z.string().max(200).optional().describe("Screen name. Required by save."),
    composition: z.string().max(60).optional(),
    overall: z.number().min(0).max(10).optional().describe("Score from score_design."),
    findings: z.number().int().min(0).optional().describe("Open finding count from review_design."),
    note: z.string().max(500).optional(),
    program: z.unknown().optional().describe("The program that built this version. Enables rebuild-restore."),
    version: z.number().int().min(1).optional().describe("Version to fetch with action:get."),
  })
  .strict();

const MigrateArgs = z
  .object({
    sessionId: SessionArg,
    target: z.string().max(200).optional().describe("Subtree to sweep. Defaults to the current selection."),
    dryRun: z.boolean().optional().describe("Report matches without changing anything. Use this first."),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
  })
  .strict();

const AuditComponentsArgs = z
  .object({
    sessionId: SessionArg,
  })
  .strict();

const PrototypeFlowArgs = z
  .object({
    sessionId: SessionArg,
    links: z
      .array(
        z
          .object({
            from: z.string().min(1).max(200).describe("Source frame id. Resolve with find_node."),
            to: z.string().min(1).max(200).describe("Destination frame id."),
            trigger: z.enum(["ON_CLICK", "ON_HOVER", "ON_PRESS"]).optional(),
            transition: z.enum(["none", "dissolve", "smart-animate"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
    description: z.string().max(1000).optional(),
    dryRun: z.boolean().optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
  })
  .strict();

export const CreateSlideArgs = z
  .object({
    sessionId: SessionArg,
    /** Slide title. Sized for the back of the room, not for a desktop frame. */
    title: z.string().max(500).optional(),
    titleColor: z.string().max(64).optional(),
    /** Supporting copy under the title. */
    body: z.string().max(5000).optional(),
    bodyColor: z.string().max(64).optional(),
    name: z.string().max(500).optional().describe("Slide name in the deck. Defaults to the title."),
    background: z.string().max(64).optional().describe("Slide background as a hex fill. A real fill, not a stacked rectangle."),
    notes: z.string().max(10000).optional().describe("Speaker notes."),
    skipped: z.boolean().optional(),
    row: z.number().int().min(0).max(1000).optional(),
    col: z.number().int().min(0).max(1000).optional(),
    description: z.string().max(1000).optional(),
    dryRun: z.boolean().optional(),
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
  })
  .strict();

const CreateComponentArgs = z
  .object({
    sessionId: SessionArg,
    name: z.string().min(1).max(200),
    description: z.string().max(1000).optional(),
    fromNode: z
      .string()
      .max(200)
      .optional()
      .describe("Existing frame or group to promote. Preferred: keeps the original geometry instead of rebuilding it."),
    width: z.number().int().min(1).max(20000).optional(),
    height: z.number().int().min(1).max(20000).optional(),
  })
  .strict();

const CreateInstanceArgs = z
  .object({
    sessionId: SessionArg,
    componentId: z.string().max(200).describe("Component id from find_component or inspect_design_system."),
    name: z.string().max(200).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    parent: z.string().max(200).optional().describe("Parent node id. Defaults to the current page."),
    properties: z
      .record(z.string())
      .optional()
      .describe("TEXT property overrides, e.g. { Label: 'Deploy' }. Unknown names are skipped, never fatal."),
  })
  .strict();

const UndoArgs = z.object({ sessionId: SessionArg }).strict();

/* -------------------------------------------------------------------------- */
/* Design intelligence args                                                     */
/* -------------------------------------------------------------------------- */

const DesignSystemArgs = z
  .object({
    sessionId: SessionArg,
    scope: z
      .enum(["page", "file"])
      .optional()
      .describe("'page' (default) scans the current page only. 'file' scans every page, which is slower but complete."),
    maxNodes: z.number().int().min(100).max(20000).optional().describe("Scan budget. Default 3000."),
    includeVariables: z.boolean().optional().describe("Include local variables. Default true."),
    includeStyles: z.boolean().optional().describe("Include paint/text/effect style counts. Default true."),
    maxPages: z.number().int().min(1).max(200).optional().describe("Cap on pages when scope is 'file'. Default 8."),
  })
  .strict();

const MetricsArgs = z
  .object({
    sessionId: SessionArg,
    target: z.string().max(200).optional().describe("Figma node id to measure. Omit to use the current selection."),
    maxNodes: z.number().int().min(20).max(5000).optional().describe("Scan budget. Default 2000."),
    depth: z.number().int().min(1).max(20).optional().describe("Maximum depth to walk. Default 12."),
    includeHidden: z.boolean().optional().describe("Include hidden layers. Default false."),
  })
  .strict();

export const ReviewArgs = z
  .object({
    sessionId: SessionArg,
    target: z.string().max(200).optional().describe("Figma node id to review. Omit to review the current selection."),
    /**
     * Alias for `target`.
     *
     * Models naturally pass `nodeId` (every other visual tool takes it). It was
     * silently dropped by strict parsing, so the review measured the selection
     * instead of the requested frame — wrong evidence behind a correct-looking
     * report. Accepting the alias closes the trap; `target` still wins.
     */
    nodeId: z.string().max(200).optional().describe("Alias for target."),
    maxNodes: z.number().int().min(20).max(5000).optional().describe("Scan budget. Default 2000."),
    depth: z.number().int().min(1).max(20).optional().describe("Maximum depth to walk. Default 12."),
    includeHidden: z.boolean().optional(),
    ruleset: z.enum(["review", "audit"]).optional().describe("'audit' adds structural/governance checks. Default 'review'."),
    minConfidence: z
      .enum(["high", "medium", "low"])
      .optional()
      .describe("Drop findings below this band. Default 'low' (keep everything)."),
    limit: z.number().int().min(1).max(400).optional().describe("Cap returned findings. Default 60."),
  })
  .strict();

/* -------------------------------------------------------------------------- */
/* Tool table                                                                  */
/* -------------------------------------------------------------------------- */

export interface ToolDefinition {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (args: unknown, registry: SessionRegistry) => Promise<unknown>;
}

const DISCONNECTED = {
  connected: false,
  message: "Open the Design Agent plugin in the target Figma file.",
};

/**
 * Whether the server and the plugin can be assumed to be the same code.
 *
 * "The same commit" is the only state that lets a live measurement be read as
 * a measurement of the repository. Anything else is stated rather than
 * assumed, because a build that cannot be named is a measurement about
 * something nobody can point at.
 */
export function buildCompatibility(serverBuild: string, pluginBuild: string | undefined): "same-commit" | "different-commit" | "unverifiable" {
  if (!pluginBuild || pluginBuild === "unknown") return "unverifiable";
  if (pluginBuild === serverBuild) return "same-commit";
  // The stamp is a short SHA, optionally with a dirtiness marker.
  const sha = (b: string) => b.split("-")[0] ?? b;
  return sha(serverBuild) === sha(pluginBuild) ? "same-commit" : "different-commit";
}

/**
 * The tools that measure or change a live design and therefore depend on the
 * plugin and server being the same code.
 *
 * Issue #20's compatibility requirement was only "reported" before: it lived
 * in `figma_status`, which a workflow never reads. Every workflow tool below
 * gets its result annotated with a build-compatibility warning when the two
 * builds are not a same-commit pair, so the finding travels with the work
 * instead of hiding in a separate tool's output.
 */
export const BUILD_DEPENDENT_TOOLS = new Set<string>([
  "inspect_selection",
  "inspect_file",
  "render_design",
  "review_design",
  "audit_design",
  "design_runtime",
  "score_design",
  "critique_visual",
  "refine_screen",
  "final_qa",
  "design_snapshot",
  "compile_ir",
  "design_guard",
  "design_pipeline",
  "figdes_use_figma",
  "figdes_inspect_visual",
  "compare_visuals",
  "create_design",
  "modify_design",
  "edit_screen",
]);

/**
 * The compatibility finding for the session a tool is about to touch, or null
 * when the build pair is the same commit.
 *
 * `unverifiable` is a warning too, not a silence: a plugin that reports no
 * build cannot be tied to a commit, which is exactly the state where a live
 * measurement describes code nobody can point at.
 */
export function buildScopeWarning(session: { build?: string } | null | undefined): { compatibility: "different-commit" | "unverifiable"; note: string } | null {
  const pluginBuild = typeof session?.build === "string" ? session.build : undefined;
  const compatibility = buildCompatibility(SERVER_BUILD, pluginBuild);
  if (compatibility === "same-commit") return null;
  const note =
    compatibility === "different-commit"
      ? `Build mismatch: the server is ${SERVER_BUILD} and the connected plugin reports ${pluginBuild}. Rules, schemas and layout behaviour can differ between the two — the measures below may not describe this repository's behaviour. Rebuild the plugin and reload it (close and reopen the panel) before trusting a verdict from this run.`
      : `Build unverifiable: the connected plugin did not report a build stamp, so this run cannot be tied to a commit. Rebuild the plugin and reload it (close and reopen the panel), then re-run this tool before relying on a verdict.`;
  return { compatibility, note };
}

/**
 * A failed transaction is thrown as an MCP tool error rather than returned as a
 * successful payload. Returning `{status:"failed"}` as a *success* invites the
 * model to gloss over it and report the design as done.
 *
 * The dispatcher itself lives in `transaction.ts`, so the semantic runtime and
 * the design pipeline go through the same ledger instead of reaching the
 * plugin directly.
 */
export { assertTransaction, dispatchTransaction };

/**
 * Pulls measurements from the plugin, runs the rule engine, and shapes the
 * result. The reviewer never mutates Figma (spec §31) — fixes travel back as
 * `suggestedOperations` for the model to pass to modify_design explicitly.
 */
async function reviewSession(
  session: Session,
  collectArgs: Record<string, unknown>,
  ruleset: "review" | "audit",
  minConfidence: "high" | "medium" | "low",
  limit: number,
): Promise<ReviewReport> {
  const raw = (await session.request("collect_metrics", collectArgs)) as MetricsReport;

  if (!raw || typeof raw !== "object") {
    throw new Error(
      "The Figma plugin returned nothing for collect_metrics. Close and re-run the Design Agent plugin in Figma, then retry.",
    );
  }
  if (raw.error) {
    throw new Error(`${raw.error} Nothing was changed.`);
  }

  let findings = runRules(raw, ruleset);

  const bands = { high: 0, medium: 1, low: 2 };
  findings = findings.filter((f) => bands[f.confidence] <= bands[minConfidence]);

  const totalBeforeLimit = findings.length;
  const truncated = raw.truncated || totalBeforeLimit > limit;
  if (truncated) findings = findings.slice(0, limit);

  const summary = summarise(findings);

  /**
   * The verdict, and what it was based on.
   *
   * "No findings" is not the same as "nothing was wrong": a scan that read no
   * nodes, or a scope too narrow to judge, produces no findings either. So the
   * report says how many rules were evaluated, how many nodes were examined,
   * and whether the scan was complete — and a result that could not judge
   * anything is INDETERMINATE rather than a pass.
   */
  const rulesEvaluated = evaluatedRuleCount(ruleset);
  const nodesExamined = raw.nodeCount;
  // "No explicit target" is part of the verdict's provenance: the report names
  // it rather than leaving a page-or-selection scan looking like a named one.
  const targetless = collectArgs.target === undefined;
  /**
   * Was a screen actually judged?
   *
   * "Some nodes came back" is not "a screen was checked": the live retest
   * produced a page-fallback scan and a one-layer selection, and both read as
   * screen-level evidence. A page scan is wider than one screen, and fewer
   * nodes than MIN_REVIEW_NODES cannot certify one — both say so instead of
   * setting scopeIsScreen: true.
   */
  const scopeName = typeof raw.scope === "string" ? raw.scope : "";
  const pageFallback = /current page/i.test(scopeName);
  const selectionOnly = /\ selected$|empty/i.test(scopeName) && scopeName.includes("selection");
  const scopeIsScreen = nodesExamined >= MIN_REVIEW_NODES && !pageFallback && !selectionOnly;
  /**
   * What the rules could not see, said in numbers rather than hardwired to zero.
   *
   * The engine never judges hidden layers or nodes the scan could not reach,
   * so "rulesSkipped: 0" is only true when the scan itself was complete. A
   * rule that crashed is a thrown error (never a silent skip), but hidden and
   * truncated nodes are a real skip with a real reason.
   */
  const hiddenNodes = raw.nodes.filter((n) => !n.visible).length;
  const truncatedNodes = raw.truncated ? Math.max(0, raw.scanBudget - raw.nodeCount) : 0;
  const skippedNodeCount = hiddenNodes + truncatedNodes;
  const skipReason =
    skippedNodeCount === 0
      ? null
      : [
          truncatedNodes > 0 ? `the scan budget cut off ${truncatedNodes} node(s)` : null,
          hiddenNodes > 0 ? `${hiddenNodes} hidden layer(s) outside the rules' scope` : null,
        ]
          .filter(Boolean)
          .join("; ");
  const judged = reviewVerdict({
    nodesExamined,
    rulesEvaluated,
    truncated: raw.truncated === true,
    findings: findings.map((f) => ({ severity: f.severity })),
  });
  const verdict = judged.verdict as ReviewVerdict;

  return {
    scope: raw.scope,
    /** The resolved target, so a reader can tell which frame/id produced this verdict. */
    target: raw.target ?? null,
    targetName: targetless ? null : raw.scope,
    reviewedNodes: raw.nodeCount,    truncated,
    summary,
    autoFixable: findings.filter((f) => f.confidence === "high" && f.suggestedOperations?.length).length,
    findings,
    scan: raw.scan,
    verdict,
    /**
     * What the verdict was based on, so a reader can tell "checked and clean"
     * from "nothing to check".
     */
    evidence: {
      nodesExamined,
      rulesEvaluated,
      rulesEvaluatedNames: evaluatedRuleNames(ruleset),
      /** The node materials the rules never saw. Zero only when the scan was complete. */
      rulesSkipped: skippedNodeCount,
      skipReason: skipReason ?? undefined,
      truncated: raw.truncated === true,
      scopeIsScreen,
      scopeIsNamedTarget: !targetless,
      reason: judged.reason,
    },
    ...(verdict === "INDETERMINATE"
      ? {
          howToProceed:
            "This is not a pass: the scan could not examine the screen. Resolve the target and re-run, and treat the result as unknown until it does.",
        }
      : {}),
  };
}

/**
 * Inspector-style tools share a failure path. When the plugin cannot answer,
 * say what actually happened rather than returning an empty structure, which
 * reads to the model as "nothing to do" instead of "something broke".
 */
/**
 * Inspector-style tools share a failure path. When the plugin cannot answer,
 * say what actually happened rather than returning an empty structure, which
 * reads to the model as "nothing to do" instead of "something broke".
 */
async function viaPlugin(
  session: Session,
  tool: PluginToolName,
  args: Record<string, unknown>,
): Promise<unknown> {
  const raw = (await session.request(tool, args)) as { error?: string } | null;

  if (raw === null || raw === undefined) {
    throw new Error(
      `The Figma plugin returned no data for ${tool}. Close and re-run the Design Agent plugin in Figma, then try again.`,
    );
  }
  if (typeof raw.error === "string" && raw.error.length > 0) {
    throw new Error(`The Figma plugin could not complete ${tool}: ${raw.error}`);
  }
  return raw;
}

/* -------------------------------------------------------------------------- */
/* Plan-provenance gate (issue #26)                                             */
/* -------------------------------------------------------------------------- */

/**
 * Whether the raw args carry plan_screen provenance or an explicit
 * design-intelligence signal.
 *
 * Accepted markers: an inlined `plan`, a `planId`/`planRef` reference, an
 * explicit `intelligenceApplied:true` / `fromPlan:true`, or a `program`
 * carrying a plan_screen plan or a declared visualIntent.style (the
 * design_runtime program channel). Anything else is raw operations.
 */
export function hasPlanProvenance(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  const r = raw as Record<string, unknown>;
  if (r["plan"] !== undefined && r["plan"] !== null) return true;
  if (typeof r["planId"] === "string" && (r["planId"] as string).length > 0) return true;
  if (typeof r["planRef"] === "string" && (r["planRef"] as string).length > 0) return true;
  if (r["fromPlan"] === true || r["intelligenceApplied"] === true) return true;
  const program = r["program"];
  if (program !== null && typeof program === "object" && !Array.isArray(program)) {
    const p = program as Record<string, unknown>;
    if (p["plan"] !== undefined && p["plan"] !== null) return true;
    const intent = p["visualIntent"];
    if (
      intent !== null &&
      typeof intent === "object" &&
      !Array.isArray(intent) &&
      typeof (intent as Record<string, unknown>)["style"] === "string" &&
      ((intent as Record<string, unknown>)["style"] as string).length > 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The refusal a raw mutating call gets: a `needs-approval` result, not an
 * error, so the model can answer it by re-sending with approved:true plus a
 * reason — the same single-use pattern as the checkpoint gate.
 */
export function planProvenanceRefusal(operationCount: number): Record<string, unknown> {
  return {
    status: "needs-approval",
    question:
      `This change carries no plan_screen provenance and no explicit design-intelligence signal, ` +
      `so it would bypass decision classification, composition hints and the build-time product guard. ` +
      `Is this raw build intentional?`,
    ifApproved: "The raw operations are dispatched as-is, without design intelligence.",
    instead:
      "Call plan_screen first (or design_pipeline for the whole loop) and build from its program — " +
      "or use design_runtime, which carries the plan channel natively — then run design_guard(inspect:true) on the result.",
    checkpoints: [{ gate: "plan-provenance", detail: "no plan, planId, or intelligence-applied signal on a mutating call" }],
    measured: { operations: operationCount },
    howToProceed:
      "Nothing has been changed. If the user confirms the raw build is intentional, call this tool again with " +
      "approved:true and a short reason. To see the effect first, call the same tool with dryRun:true - that needs no approval.",
  };
}

/**
 * Enforces the plan-provenance gate for raw mutating calls.
 *
 * Returns a refusal payload when the call must stop, or null when it may
 * proceed. Design-time inspection stays open: dryRun creates nothing and
 * needs no provenance, and readonly native scripts are inspection-only.
 */
export function requirePlanProvenance(
  rawArgs: unknown,
  opts: { approved?: boolean; reason?: string; dryRun?: boolean; readonly?: boolean; operations: unknown },
): Record<string, unknown> | null {
  if (opts.dryRun === true || opts.readonly === true) return null;
  if (hasPlanProvenance(rawArgs)) return null;
  if (opts.approved === true && typeof opts.reason === "string" && opts.reason.trim().length > 0) return null;
  const count = Array.isArray(opts.operations) ? opts.operations.length : 0;
  return planProvenanceRefusal(count);
}

/**
 * Merges a mutating call's score/guard evidence with its tool-level waiver.
 *
 * Without evidence there is nothing to waive, so nothing is threaded and the
 * dispatcher runs exactly as before. With evidence, the caller's
 * approved+reason covers the dispatch-edge score block for this dispatch only.
 */
export function scoreGuardForDispatch(parsed: {
  scoreGuard?: { scoreWeakSpots?: unknown[]; guardVerdict?: string; approved?: boolean; reason?: string };
  approved?: boolean;
  reason?: string;
}): { scoreWeakSpots?: unknown[]; guardVerdict?: string; approved?: boolean; reason?: string } | undefined {
  if (!parsed.scoreGuard) return undefined;
  return {
    ...parsed.scoreGuard,
    ...(parsed.approved !== undefined ? { approved: parsed.approved } : {}),
    ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
  };
}

export const CompareVisualsArgs = z.object({
  sessionId: z.string().max(200).optional(),
  beforeNodeId: z.string().describe("The node ID of the previous state"),
  afterNodeId: z.string().describe("The node ID of the new state"),
  focalOnly: z.boolean().optional().describe("Only compare focal regions"),
  priorFindings: z
    .array(z.object({ id: z.string().max(64) }).strict())
    .max(30)
    .optional()
    .describe("Finding ids (vf-*) reported on the before state. Returned as resolved / persisting against currentFindings."),
  currentFindings: z
    .array(z.object({ id: z.string().max(64) }).strict())
    .max(30)
    .optional()
    .describe("Finding ids reported on the after state. Both sides are needed: without a fresh report, nothing can be verified as resolved."),
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "figma_status",
    title: "Figma connection status",
    description:
      "Check whether a Figma Design Agent plugin is connected, and which file/page/selection it is attached to. Call this first — if connected is false, nothing else will work. Also lists every named MCP client connection (ChatGPT, Claude Code, …) with its in-flight tool calls, plus recent cross-client activity — this is how you see who is working on what when several agents share one server.",
    inputSchema: StatusArgs,
    handler: async (args, registry) => {
      const { sessionId } = StatusArgs.parse(args ?? {});
      const { connections, activity } = clients.snapshot();
      const recent = activity.slice(0, 10);
      const metrics = metricsSnapshot();
      const jobs = registry.jobs.recent(10);
      try {
        const session = registry.resolve(sessionId);
        const status = session.status();
        /**
         * The build is asked of the plugin, not read from a cache.
         *
         * The server learns a plugin's build from a register or a state frame,
         * and neither arrives until the plugin has something to say. So a
         * panel that was reopened minutes ago still reported the build of the
         * bundle it started with — which is the one thing a stale panel hides.
         * Asking costs one round trip and answers it for certain.
         */
        let liveBuild: string | null = null;
        try {
          const probed = (await Promise.race([
            session.request("figma_status", {}, 3000),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 3200)),
          ])) as StatusResult | null;
          if (probed && typeof probed.build === "string" && probed.build.length > 0) liveBuild = probed.build;
        } catch {
          liveBuild = null;
        }
        const build = liveBuild ?? status.build;
        /**
         * Reconcile the probed stamp into the session.
         *
         * The per-transaction build-compatibility annotation reads only
         * `session.build`, which frames fill — and a panel whose frames carry
         * no stamp (or registered before a reload) left every per-tx
         * annotation "unverifiable" while figma_status itself, via this probe,
         * showed same-commit. Recording the probed value heals the record with
         * no extra round trip; a later state frame overwrites it again.
         */
        if (liveBuild && session.build !== liveBuild) session.build = liveBuild;
        return {
          ...status,
          ...(liveBuild !== null ? { build: liveBuild } : {}),
          connected: true,
          sessionName: `${status.fileName} - ${status.pageName || "?"}`,
          /**
           * Which build is answering, and which build the plugin is running.
           *
           * A live measurement runs against two builds, and either can be
           * older than the repository: the server is deployed, and Figma loads
           * the plugin bundle once. A measurement that cannot name them
           * describes code that may no longer exist.
           */
          serverBuild: SERVER_BUILD,
          builds: {
            server: SERVER_BUILD,
            plugin: build ?? "unknown",
            /**
             * Whether the two can be assumed to be the same code.
             *
             * `same-commit` is the only state that lets a live measurement be
             * read as a measurement of the repository.
             */
            compatibility: buildCompatibility(SERVER_BUILD, build),
            buildSource: liveBuild !== null ? "live" : "cached",
            note:
              build && build !== "unknown"
                ? `Server build ${SERVER_BUILD}, plugin bundle build ${build}${liveBuild !== null ? "" : " (from the last frame the plugin sent)"}. If either does not match the repository HEAD, redeploy the server and reload the plugin (close and reopen it) before measuring.`
                : `Server build ${SERVER_BUILD}. The plugin did not report a build, so the plugin side cannot be tied to a commit: rebuild the plugin and close and reopen it in Figma.`,
          },
          // Spelled out where it cannot be missed. Figma loads the plugin bundle
          // once, when the panel opens, so a rebuild does not reach an open
          // session: live measurements taken against an old panel describe code
          // that is no longer in the repo. Check this before trusting a timing.
          pluginBuildNote:
            build && build !== "unknown"
              ? `Plugin bundle build ${build}${liveBuild !== null ? " (asked live)" : " (cached)"}. If this does not match the repository HEAD, reload the plugin (close and reopen it) before measuring — Figma does not hot-reload the bundle.`
              : "This panel did not report a build (older bundle, or built without the build stamp). Rebuild and reopen the plugin to get one; until then live timings cannot be tied to a commit.",
          clients: connections,
          activity: recent,
          metrics,
          recentJobs: jobs,
        };
      } catch (err) {
        if (registry.connected().length === 0) return { ...DISCONNECTED, clients: connections, activity: recent, metrics, recentJobs: jobs };
        throw err;
      }
    },
  },

  {
    name: "inspect_selection",
    title: "Inspect the current Figma selection",
    description:
      "Return a compact native node tree for whatever is currently selected in Figma. Run this before modify_design so operations address real node ids instead of guesses.",
    inputSchema: InspectArgs,
    handler: async (args, registry) => {
      const parsed = InspectArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "inspect_selection", rest);
    },
  },

  {
    name: "inspect_file",
    title: "Inspect Figma file structure",
    description:
      "Return file name, current page, page list, selection, top-level frames, and a node-type census. Output is depth- and budget-limited by design; inspect large files progressively.",
    inputSchema: FileArgs,
    handler: async (args, registry) => {
      const parsed = FileArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "inspect_file", rest);
    },
  },

  {
    name: "inspect_design_system",
    title: "Extract the design system from this file",
    description:
      "Return what this project already uses: colour palette, type ramp, spacing scale, corner radii, shadows, components, variables, styles, layout patterns and naming conventions, plus health signals such as hardcoded colours that already have a token. Run this BEFORE creating anything, so new work reuses the existing system instead of inventing a new one. Read-only.",
    inputSchema: DesignSystemArgs,
    handler: async (args, registry) => {
      const parsed = DesignSystemArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "extract_design_system", rest);
    },
  },

  {
    name: "collect_metrics",
    title: "Measure Figma nodes",
    description:
      "Return raw measurements for a node subtree: geometry, resolved colours, contrast-relevant backgrounds, text properties, layout settings. This is the data the reviewer reasons over. Prefer review_design unless you need the measurements themselves.",
    inputSchema: MetricsArgs,
    handler: async (args, registry) => {
      const parsed = MetricsArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "collect_metrics", rest);
    },
  },

{
    name: "render_design",
    title: "Render a frame to an image",
    description:
      "Export a Figma node as an image and return it so you can actually see the result. Use this after building something, to judge hierarchy, balance, density, alignment and whether the main relationship reads clearly - things node metadata cannot tell you. Context cost is real: roughly 1 token per 1500px^2 at high detail, half that at low detail. Use detail='low' for layout checks and high only when you need to read small text. Prefer review_design for structural defects; it costs nothing.",
    inputSchema: RenderArgs,
    handler: async (args, registry) => {
      const parsed = RenderArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return renderDesign(session, rest);
    },
  },

  {
    name: "find_component",
    title: "Find an existing component",
    description:
      "Search this file's components before building. If something like this already exists, use create_instance instead of assembling it from rectangles - that is the main way a design system drifts out of sync. Returns fuzzy matches ranked by relevance, with an instance count so you can tell which component is actually load-bearing.",
    inputSchema: FindComponentArgs,
    handler: async (args, registry) => {
      const parsed = FindComponentArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "find_components", rest);
    },
  },

  {
    name: "create_component",
    title: "Promote a frame to a component",
    description:
      "Turn an existing frame or group into a real Figma component, keeping its geometry. Use this when you have just built something worth reusing, so the next screen can instance it. Prefer fromNode over rebuilding the shape.",
    inputSchema: CreateComponentArgs,
    handler: async (args, registry) => {
      const parsed = CreateComponentArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "create_component", rest);
    },
  },

  {
    name: "create_instance",
    title: "Place an instance of a component",
    description:
      "Place an instance of an existing component, optionally inside a parent frame. Always call find_component or inspect_design_system first to get a real component id - never invent one.",
    inputSchema: CreateInstanceArgs,
    handler: async (args, registry) => {
      const parsed = CreateInstanceArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "create_instance", rest);
    },
  },

  {
    name: "find_node",
    title: "Find a node by what it is, not its id",
    description:
      "Resolve a node from intent: a screen name, a semantic role (primaryAction, secondaryAction, activeNavigation, navigation, footerNavigation, heroTitle, sectionHeading, metaLabel, topologyMap, statusBadge, searchField, textInput, toggle, dropdownSelector, dataRow, metric, avatar, iconButton, emptyState, errorState, successState, loadingIndicator, tableHeader, chipTag, breadcrumb, paginationControl, cardContainer), a layer-name substring, or a text-content substring. Returns real Figma ids with the reason each matched, so a surprising result is inspectable. Use this before modify_design instead of reusing ids from older transactions - stale ids are how the wrong subtree gets edited.",
    inputSchema: FindNodeArgs,
    handler: async (args, registry) => {
      const parsed = FindNodeArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "find_node", rest);
    },
  },

  {
    name: "set_variant",
    title: "Switch an instance to another variant",
    description:
      "Change which variant of a component set an instance shows, by variant name (exact or Property=Value pairs). May also carry TEXT properties to reword the copy without switching variants. Use this instead of deleting an instance and placing a new one - the position, overrides and layer order survive.",
    inputSchema: SetVariantArgs,
    handler: async (args, registry) => {
      const parsed = SetVariantArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "set_variant", rest);
    },
  },

  {
    name: "update_component",
    title: "Edit a component master",
    description:
      "Apply operations to a component master so every instance updates at once. The target is validated as a real component first - edits to instances belong on the master. Runs as one undoable transaction; pass dryRun=true first for anything large.",
    inputSchema: UpdateComponentArgs,
    handler: async (args, registry) => {
      const parsed = UpdateComponentArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);

      const gate = guardMutation({
        operations: (rest.operations ?? []) as Array<Record<string, unknown>>,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
      });
      if (gate) return gate;

      if ((rest as { dryRun?: boolean }).dryRun) {
        return viaPlugin(session, "update_component", rest);
      }
      const preflight = validateTransaction((rest.operations ?? []) as unknown[]);
      if (!preflight.ok) {
        recordPreflightCatch(preflight.issues.length);
        throw new Error(`Preflight rejected the component edit before contacting Figma: ${preflight.issues[0]?.message ?? "invalid"} Fix: ${preflight.issues[0]?.fix ?? ""}`);
      }
      const t0 = Date.now();
      const out = await viaPlugin(session, "update_component", rest);
      recordToolCall("update_component", Date.now() - t0, { ops: ((rest.operations ?? []) as unknown[]).length });
      return out;
    },
  },

  {
    name: "create_component_set",
    title: "Combine components into a variant set",
    description:
      "Turn two or more components (or plain frames, promoted with geometry intact) into one variant set. Prefer this over maintaining parallel one-off components - variants stay in sync and set_variant can switch between them.",
    inputSchema: CreateComponentSetArgs,
    handler: async (args, registry) => {
      const parsed = CreateComponentSetArgs.parse(args);
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return viaPlugin(session, "create_component_set", rest);
    },
  },

  {
    name: "seed_exo_system",
    title: "Create the canonical EXO token set",
    description:
      "Create the exo variable collection and text styles in one idempotent transaction: warm-neutral canvas/surface/text/muted/border, yellow action, green health, warning/error, dark runtime surfaces, the 4px spacing scale, small radii, and the display-to-technical type ramp. Pass themes:['dark'] for a Dark mode that inverts surfaces while intent colours hold. Re-running updates values in place instead of duplicating names. Run once per file before building screens, then reference tokens by name (exo/surface) instead of hardcoding hex - fills and strokes written as token names are bound automatically.",
    inputSchema: SeedExoArgs,
    handler: async (args, registry) => {
      const parsed = SeedExoArgs.parse(args ?? {});
      const session = registry.resolve(parsed.sessionId);
      const operations = exoSeedOperations({ ...(parsed.themes !== undefined ? { themes: parsed.themes } : {}) });
      const counts = exoSeedCounts();

      // Seeding redefines values file-wide when the names already exist, so it
      // goes through the same gate as any other global change.
      const existing = await resolveExistingResources(session, operations);
      const gate = guardMutation({
        operations,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
        ...(existing !== undefined ? { existing } : {}),
      });
      if (gate) return gate;

      if (parsed.dryRun) {
        const result = (await session.request("create_design", {
          description: "Seed the canonical exo token set",
          operations,
          dryRun: true,
          transactionId: parsed.transactionId,
        })) as TransactionResult;
        return { ...assertTransaction(result), seeded: counts };
      }
      const result = await dispatchTransaction(registry, session, "create_design", {
        description: "Seed the canonical exo token set",
        operations: operations as unknown[],
        transactionId: parsed.transactionId,
      });
      return { ...result, seeded: counts };
    },
  },

  {
    name: "review_design",
    title: "Review a design for defects",
    description:
      "Find concrete, measurable design problems in the current selection or a given node: text contrast below WCAG AA, children overflowing their frame, inconsistent corner radii, layers still named 'Frame 12', tap targets under 44px, geometry off the spacing grid, likely duplicate layers. Each finding carries the measured evidence and a confidence band (high/medium/low). High-confidence findings include ready-to-apply fix operations. Read-only: nothing is changed.",
    inputSchema: ReviewArgs,
    handler: async (args, registry) => {
      const parsed = ReviewArgs.parse(args ?? {});
      const { sessionId, ruleset, minConfidence, limit, nodeId, target, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return reviewSession(session, { ...rest, ...(target !== undefined ? { target } : nodeId !== undefined ? { target: nodeId } : {}) }, ruleset ?? "review", minConfidence ?? "low", limit ?? 60);
    },
  },

  {
    name: "audit_design",
    title: "Audit design-system governance",
    description:
      "The structural counterpart to review_design: finds design-system governance problems such as text not using styles, and frames whose children are mostly left with default names. Same evidence and confidence model as review_design.",
    inputSchema: ReviewArgs,
    handler: async (args, registry) => {
      const parsed = ReviewArgs.parse(args ?? {});
      const { sessionId, ruleset, minConfidence, limit, nodeId, target, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return reviewSession(session, { ...rest, ...(target !== undefined ? { target } : nodeId !== undefined ? { target: nodeId } : {}) }, ruleset ?? "audit", minConfidence ?? "low", limit ?? 60);
    },
  },

  {
    name: "design_runtime",
    title: "Build a design from semantic primitives",
    description:
      "MANDATORY FIRST STEP: call plan_screen (or design_pipeline for the whole loop) before this, and build from its program. A raw program with no plan and no visualIntent.style bypasses decision classification, composition hints and the guard preview — the result discloses intelligence-applied:false and falls back to auto art-direction. Use this for information-led screens. Do not use it as the primary builder when plan_screen.execution.nativeRequired=true. For composition-led screens, use figdes_use_figma for the shell and reserve this for reusable semantic content inside a Hybrid composition. Send a declarative program of regions (navigation, hero, header, inspector) and semantic content (metric, statusPill, deviceNode, navItem, panel, button, text, shape, vector) instead of hand-placing dozens of primitives. The layout engine computes all coordinates and the typography scale is applied for you, so you state intent rather than geometry. This is structured JSON naming built-in primitives, NOT code: there is no eval path and code will be rejected. The product guard runs on every build and applicabilityBasis says what the geometry stands on. Pass dryRun=true first.",
    inputSchema: RuntimeArgs,
    handler: async (args, registry) => {
      const parsed = RuntimeArgs.parse(args);
      const { sessionId, dryRun, ...rest } = parsed;

      // Resolved lazily so a dry run works with Figma closed.
      const session = dryRun === true && !sessionId ? null : registry.resolve(sessionId);
      return runRuntimeTool(session, { ...rest, dryRun }, registry);
    },
  },

  {
    name: "runtime_primitives",
    title: "List the design runtime primitives",
    description:
      "List every primitive design_runtime accepts: its kind, description, the exact arguments it takes (name, type, accepted values) and a worked example call. Call this before writing a program rather than guessing argument names — an unrecognised argument is rejected, and this is where the accepted set is defined.",
    inputSchema: z.object({}).strict(),
    handler: async () => ({
      note: "These are the complete vocabulary, and each entry carries the exact arguments it accepts. There is no eval path; nothing is executed as code.",
      primitives: runtimeCatalogue(),
    }),
  },

  {
    name: "score_design",
    title: "Score a design before claiming it is done",
    description:
      "Score a declarative program (or a live Figma node via nodeId) on composition, hierarchy, density, alignment, consistency and accessibility, 0-10 each with the measured evidence and what would move each number. Deterministic and free: the same input always scores the same. Use it after design_runtime (program) or a native build (nodeId) and before presenting anything - a weak spot below 6 is a fix list, not a failure.",
    inputSchema: ScoreArgs,
    handler: async (args, registry) => scoreDesignTool(args, registry),
  },

  {
    name: "critique_visual",
    title: "Judge whether a design is good, not just correct",
    description:
      "The aesthetic critic: evaluate a program (or a live Figma node via nodeId plus visionCriticObservations from the render) on focal clarity, hierarchy, composition, whitespace, density, repetition, card-wall tendency, visual balance, data-visualization quality, surface hierarchy, depth, and template feel. Returns verdict PASS / WATCH / FAIL plus the authoritative qualityGate (PASS / REVIEW / FAIL with blockingIssues, repairPlan and renderRequired). FAIL means repair before done; REVIEW means render and judge before done. Structural issues (overflow, contrast, naming) belong to review_design and are NOT mixed in here. Deterministic and free: run it alongside score_design before presenting anything. For the image-grounded loop: report what you see as visualFindings (area + defect + severity); each is localized to measured node ids with a repair that cites it. After fixing, re-run with priorFindings plus fresh visualFindings — the resolution (resolved / persisting / introduced) is the verification that the loop improved something.",
    inputSchema: CritiqueArgs,
    handler: async (args, registry) => critiqueVisualTool(args, registry),
  },

  {
    name: "refine_screen",
    title: "Run the review-fix loop to convergence",
    description:
      "The mechanical half of the refinement loop: reviews the live selection, applies high-confidence fixes, re-reviews, up to maxIterations (max 5). Optionally builds a program first, then polishes it. preserve[] lists node ids or rule names the loop must not touch. Judge renders yourself between iterations - the tool returns the trace, not images. Destructive fixes still ask approval first.",
    inputSchema: RefineArgs,
    handler: async (args, registry) => {
      const parsed = RefineArgs.parse(args ?? {});
      return refineScreenTool(registry.resolve(parsed.sessionId), parsed, registry);
    },
  },

  {
    name: "diff_design",
    title: "Compare two design snapshots structurally",
    description:
      "Answers 'what changed': pass two inspect_selection-shaped snapshots (before, after) and get added/removed/moved/resized/recolored/renamed/text-changed nodes plus an area delta. Structural, not pixels: no heatmap is claimed. Use it to verify a refinement did what it meant to and nothing else.",
    inputSchema: DiffArgs,
    handler: async (args) => diffDesignTool(args),
  },

  {
    name: "final_qa",
    title: "Run the ship checklist",
    description:
      "The quality gate before calling a screen done: PRODUCT (decision obvious, no product-truth violations), COMPOSITION (focal, hierarchy, whitespace, no card wall), SYSTEM (type scale), VISUAL (support vs compete), TECHNICAL (structure, render). Each item is measured or explicitly marked as needing the live file - never guessed. FAIL means fix and re-run; otherwise clear the pending live checks.",
    inputSchema: FinalQaArgs,
    handler: async (args, registry) => {
      const parsed = FinalQaArgs.parse(args ?? {});
      // Live checks need a session; the offline checklist does not. Resolve
      // lazily so final_qa on a program alone works with Figma closed.
      const session = parsed.target !== undefined || parsed.nodeId !== undefined ? registry.resolve(parsed.sessionId) : null;
      return finalQaTool(session, parsed);
    },
  },

  {
    name: "design_snapshot",
    title: "Save, list and fetch design checkpoints",
    description:
      "Persistent V1/V2/V3 checkpoints for a screen: program, composition, score and findings, timestamped. Compare versions without relying on memory; restore by rebuilding from the stored program (idempotent), not by rolling back the document - history remains Figma's job.",
    inputSchema: SnapshotArgs,
    handler: async (args, registry) => {
      const parsed = SnapshotArgs.parse(args ?? {});
      const session = parsed.sessionId ? registry.resolve(parsed.sessionId) : null;
      const key = parsed.project ? projectKey(parsed.project, parsed.project) : projectKey(session?.fileKey, session?.fileName);

      if (parsed.action === "list") {
        return { status: "ok", project: key, snapshots: listSnapshots(key) };
      }
      if (parsed.action === "get") {
        if (parsed.version === undefined) throw new Error("design_snapshot(action:'get') needs a version number.");
        const entry = getSnapshot(key, parsed.version);
        if (!entry) return { status: "not-found", project: key, version: parsed.version };
        return { status: "ok", project: key, snapshot: entry };
      }

      if (!parsed.screen) throw new Error("design_snapshot(action:'save') needs the screen name.");
      const { entry, file } = saveSnapshot(key, {
        screen: parsed.screen,
        ...(parsed.composition !== undefined ? { composition: parsed.composition } : {}),
        ...(parsed.overall !== undefined ? { overall: parsed.overall } : {}),
        ...(parsed.findings !== undefined ? { findings: parsed.findings } : {}),
        ...(parsed.note !== undefined ? { note: parsed.note } : {}),
        ...(parsed.program !== undefined ? { program: parsed.program } : {}),
      });
      return { status: "ok", action: "save", project: key, file, version: entry.version, at: entry.at };
    },
  },

  {
    name: "export_code",
    title: "Export a frame as React + Tailwind",
    description:
      "Convert the current selection (or a target node) into a React component with Tailwind classes: auto-layout becomes flex with gaps and padding, text becomes headed tags with sizes and weights, colours become CSS custom properties. Deterministic: the same frame always emits the same component. Static export only - no responsive behaviour, interactions or component boundaries claimed.",
    inputSchema: ExportArgs,
    handler: async (args, registry) => {
      const parsed = ExportArgs.parse(args ?? {});
      const { sessionId, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      const raw = (await session.request("collect_metrics", {
        ...(rest.target !== undefined ? { target: rest.target } : {}),
        ...(rest.maxNodes !== undefined ? { maxNodes: rest.maxNodes } : {}),
      })) as MetricsReport;
      if (!raw || typeof raw !== "object" || !Array.isArray(raw.nodes)) {
        throw new Error("The Figma plugin returned no measurements. Close and re-run the plugin, then retry.");
      }
      return exportCode(raw.nodes, {
        ...(rest.componentName !== undefined ? { componentName: rest.componentName } : {}),
        ...(rest.maxNodes !== undefined ? { maxNodes: rest.maxNodes } : {}),
      });
    },
  },

  {
    name: "migrate_to_tokens",
    title: "Bind hardcoded fills to matching variables",
    description:
      "Sweeps the selection (or a target subtree) for hardcoded fills and strokes whose hex exactly matches a local variable's default value, and binds them. Exact matches only: approximate colours are left alone, because binding the wrong token is worse than a literal. Large sweeps target many nodes and will ask approval first. Pass dryRun=true to see the matches without changing anything.",
    inputSchema: MigrateArgs,
    handler: async (args, registry) => {
      const parsed = MigrateArgs.parse(args ?? {});
      const session = registry.resolve(parsed.sessionId);

      const listed = (await session.request("list_variables", {})) as {
        variables?: Array<{ collection: string; name: string; type: string; value: string | number | boolean | null }>;
      };
      const byHex = new Map<string, string>();
      for (const v of listed.variables ?? []) {
        if (typeof v.value === "string" && /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(v.value)) {
          const key = v.value.toUpperCase();
          if (!byHex.has(key)) byHex.set(key, `${v.collection}/${v.name}`);
        }
      }

      const raw = (await session.request("collect_metrics", {
        ...(parsed.target !== undefined ? { target: parsed.target } : {}),
        maxNodes: 2000,
      })) as MetricsReport;
      if (!raw || !Array.isArray(raw.nodes)) {
        throw new Error("The Figma plugin returned no measurements. Close and re-run the plugin, then retry.");
      }

      const operations: Array<Record<string, unknown>> = [];
      const matches: Array<{ hex: string; variable: string; nodes: number }> = [];
      const seen = new Map<string, string[]>();
      for (const node of raw.nodes) {
        if (node.type === "PAGE" || node.type === "DOCUMENT") continue;
        const fills = typeof node.fill === "string" ? [{ hex: node.fill, field: "fills" as const }] : [];
        const strokes = node.stroke ? [{ hex: node.stroke.hex, field: "strokes" as const }] : [];
        for (const { hex, field } of [...fills, ...strokes]) {
          const variable = byHex.get(hex.toUpperCase());
          if (!variable) continue;
          operations.push({ type: "bindVariable", target: node.id, field, variable });
          const list = seen.get(variable) ?? [];
          list.push(node.id);
          seen.set(variable, list);
        }
        if (operations.length >= 200) break;
      }
      for (const [variable, ids] of seen) {
        const hex = [...byHex.entries()].find(([, v]) => v === variable)?.[0] ?? "?";
        matches.push({ hex, variable, nodes: ids.length });
      }
      matches.sort((a, b) => b.nodes - a.nodes);

      if (parsed.dryRun) {
        return { status: "ok", dryRun: true, matches, operations: operations.length };
      }
      if (operations.length === 0) {
        return { status: "ok", matches: [], operations: 0, note: "No hardcoded fill exactly matches a variable value. Nothing to migrate." };
      }

      const gate = guardMutation({
        operations,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: false,
      });
      if (gate) return gate;

      const result = await dispatchTransaction(registry, session, "create_design", {
        description: `Migrate ${operations.length} fills to variables`,
        operations: operations as unknown[],
      });
      return { ...result, matches };
    },
  },

  {
    name: "audit_components",
    title: "Audit component health: unused and duplicated",
    description:
      "Reports components with zero instances (candidates for deletion), near-duplicate components by name stem and size (candidates for merging into variant sets), and variant sets with a single variant. Read-only: nothing is changed, and every candidate carries the evidence for a human decision.",
    inputSchema: AuditComponentsArgs,
    handler: async (args, registry) => {
      const parsed = AuditComponentsArgs.parse(args ?? {});
      const session = registry.resolve(parsed.sessionId);
      const found = (await session.request("find_components", { limit: 200 })) as {
        matches: Array<{ component: { id: string; name: string; type: string; width: number; height: number; instanceCount: number }; reason: string }>;
        total: number;
        truncated: boolean;
      };

      const all = found.matches.map((m) => m.component);
      const unused = all
        .filter((c) => c.type === "COMPONENT" && c.instanceCount === 0)
        .map((c) => ({ id: c.id, name: c.name, width: c.width, height: c.height }));

      // Same stem (lowercased, trailing numbers and variant suffixes stripped)
      // plus same size: almost certainly the same component built twice.
      const stem = (name: string): string =>
        name
          .toLowerCase()
          .replace(/^(component\s+)?/, "")
          .replace(/[\s_\-]*(v\d+|copy|final|\d+|primary|secondary|default)$/g, "")
          .trim();
      const byStem = new Map<string, typeof all>();
      for (const c of all) {
        if (c.type !== "COMPONENT") continue;
        const key = `${stem(c.name)}|${c.width}x${c.height}`;
        const list = byStem.get(key) ?? [];
        list.push(c);
        byStem.set(key, list);
      }
      const duplicates = [...byStem.values()]
        .filter((group) => group.length > 1)
        .map((group) => ({ stem: stem(group[0]!.name), members: group.map((c) => ({ id: c.id, name: c.name, instances: c.instanceCount })) }));

      const singleVariantSets = all
        .filter((c) => c.type === "COMPONENT_SET")
        .map((c) => ({ id: c.id, name: c.name }));

      return {
        status: "ok",
        totals: { components: found.total, truncated: found.truncated },
        unused,
        duplicates,
        singleVariantSets,
        howToProceed:
          "Delete unused components with removeNode after confirming nothing references them. Merge duplicates with create_component_set, then point instances at the survivor with set_variant or re-instance.",
      };
    },
  },

  {
    name: "prototype_flow",
    title: "Link frames into a clickable flow",
    description:
      "Adds prototype navigate interactions between frames: each link connects a source frame to a destination on click (or hover), with an optional dissolve or smart-animate transition. Appends to existing reactions rather than replacing them. Run it after building the screens, so the deck can be clicked through instead of squinted at.",
    inputSchema: PrototypeFlowArgs,
    handler: async (args, registry) => {
      const parsed = PrototypeFlowArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const operations = parsed.links.map((link) => ({
        type: "prototypeLink",
        from: link.from,
        to: link.to,
        trigger: link.trigger ?? "ON_CLICK",
        transition: link.transition ?? "dissolve",
      }));

      const gate = guardMutation({
        operations: operations as Array<Record<string, unknown>>,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
      });
      if (gate) return gate;

      if (parsed.dryRun) {
        const result = (await session.request("create_design", {
          description: parsed.description ?? `Prototype flow: ${operations.length} link(s)`,
          operations,
          dryRun: true,
          transactionId: parsed.transactionId,
        })) as TransactionResult;
        return assertTransaction(result);
      }
      return dispatchTransaction(registry, session, "create_design", {
        description: parsed.description ?? `Prototype flow: ${operations.length} link(s)`,
        operations: operations as unknown[],
        transactionId: parsed.transactionId,
      });
    },
  },

  {
    name: "compile_ir",
    title: "Compile a Design IR to operations",
    description:
      "Compile a Design IR (canvas, regions with semantic roles, content) into Figma operations without touching the document. Use this to validate a layout or inspect the resolved geometry. Lower level than design_runtime — and raw IR bypasses plan intelligence (no decision classification, no composition hint, no plan channel), so the result discloses intelligence-applied:false with the fix named, and always runs the product guard. Prefer design_runtime with a plan_screen program unless you need explicit control over regions; run design_guard on the result before building.",
inputSchema: CompileArgs,
    handler: async (args) => compileIrTool(args),
  },

  {
    name: "project_memory",
    title: "Read and record durable project design memory",
    description:
      "Durable, structured notes about how this project should look — separate from conversation memory, stored as JSON next to the project so it can be read, diffed and corrected. Read it before designing anything non-trivial: it is where decisions like 'topology screens work better as large spatial diagrams' live. Record an observation only when the user states a preference or confirms a direction, never on your own initiative — a memory full of your own guesses stops being trusted. Recording the same id twice updates the note instead of adding a contradictory one.",
    inputSchema: ProjectMemoryArgs,
    handler: async (args, registry) => {
      const parsed = ProjectMemoryArgs.parse(args);
      return projectMemoryTool(registry.resolve(parsed.sessionId), parsed);
    },
  },

  {
    name: "design_guard",
    title: "Check a design against the project's product rules",
    description:
      "The do-not-drift layer. Checks a design against the project's product rules (spec: devices auto-discover, placement is automatic, chat is not primary, avoid generic SaaS card walls) and returns PASS / WARNING / FAIL with the measured evidence for each. design_runtime and design_pipeline already run this guard at build time — call it explicitly when building from raw operations (create_design, figdes_use_figma) or raw IR (compile_ir), where no build-time guard sees the work. Pass a program to check a design before building it, or inspect:true to check what is currently in the file. Read-only and free. Only machine-checkable evidence can produce a FAIL; anything needing judgement is returned as a question for a human rather than guessed at.",
    inputSchema: DesignGuardArgs,
    handler: async (args, registry) => {
      const parsed = DesignGuardArgs.parse(args);
      return designGuardTool(registry.resolve(parsed.sessionId), parsed);
    },
  },

{
    name: "plan_screen",
    title: "Plan a screen before drawing it",
    description:
      "MANDATORY FIRST STEP for any new screen — call this before design_runtime, compile_ir, create_design or figdes_use_figma. States the primary decision the user makes, infers the composition that follows from it, and returns a 2D composition model with real geometry, an ordered region list where each region says why it exists, the art director's decisions (focal, hierarchy, strategies, states, risks), a five-pass build plan, full structural variants to compare, and a preview of which product rules the plan will trip. Accepts an archetype ('model-fit', 'topology'...) that presets objective, decision and anti-patterns. Creates nothing, so a wrong composition costs one message instead of an undo. The result carries intelligence provenance (applied:true, decisionKind, compositionHintApplied) proving classification ran. A page type is not a decision: 'dashboard' or 'overview' will be pushed back on, because page types are what produce generic layouts.",
    inputSchema: PlanScreenArgs,
    handler: async (args, registry) => {
      const parsed = PlanScreenArgs.parse(args);
      return planScreenTool(registry.resolve(parsed.sessionId), parsed);
    },
  },

  {
    name: "design_brief",
    title: "Write the brief before the plan",
    description:
      "The step before plan_screen: user goal, primary decision, primary object, secondary information, visual hierarchy, focal point, screen template, composition candidates, component and visualization strategy, interaction states and design risks. Built on the same planner as plan_screen, so brief and plan can never disagree. Hand the decision, template and available information onward to plan_screen.",
    inputSchema: DesignBriefArgs,
    handler: async (args, registry) => {
      const parsed = DesignBriefArgs.parse(args);
      return designBriefTool(registry.resolve(parsed.sessionId), parsed);
    },
  },

  {
    name: "design_pipeline",
    title: "Turn a brief into a composed, verified Figma screen",
    description:
      "The enforced-intelligence loop in one call: normalize the brief, plan the composition, build it from semantic primitives, verify the resolved geometry, apply it as one tracked transaction, read the built screen back, run the review rules, render it, repair what can be repaired safely, and report what was generated, what was verified, what was repaired and what is still unverified. Skills, composition alternatives, the build-time product guard and the final guard always run — the report carries intelligence-applied:true. A brief that contradicts itself is refused before anything is created; a check that could not run is reported as unverified rather than as a pass. Pass mode:'plan' to get the plan, the program and the structural verification without touching Figma.",
    inputSchema: DesignPipelineArgs,
    handler: async (args, registry) => {
      const parsed = DesignPipelineArgs.parse(args);
      const session = parsed.mode === "plan" || parsed.dryRun === true ? null : registry.resolve(parsed.sessionId);
      return designPipelineTool(session, registry, parsed);
    },
  },

  {
    name: "figdes_use_figma",
    title: "Native Composition Execution",
    description:
      "Execute JavaScript directly in the Figma Plugin API context. This is the primary builder for composition-led screens, and it bypasses design intelligence entirely (no decision classification, no composition hints, no build-time product guard) — for new screens, plan first with plan_screen or design_pipeline and run design_guard(inspect:true) on the built frame afterwards. The script receives the real figma API plus a high-level figdes builder (stack/frame/text/rect/ellipse/vector/connect/instance) that handles font loading, auto-layout ordering, sizing and native geometry. Prefer figdes for construction and raw figma for advanced API work. Return rootId/createdNodeIds/mutatedNodeIds. Optional renderAfter='first-created' or 'explicit' turns the same call into a build + visual evidence checkpoint. Native writes are transactional and serialized per session; timeout is an execution watchdog that waits for an in-flight script to settle before rollback, preventing late mutations.",
    inputSchema: UseFigmaArgs,
    handler: async (args, registry) => {
      // Issue #26: the provenance markers (and the explicit approved+reason
      // justification) are declared on UseFigmaArgs so strict clients stop
      // stripping them before the gate can read them, but they still arrive on
      // the raw args beside the script and are stripped before the strict
      // parse of the script channel — both spellings reach the gate. dryRun
      // keeps the gate open and runs the script mutation-protected; readonly
      // scripts are inspection-only and open either way.
      const raw = ((args ?? {}) as Record<string, unknown>);
      const { plan, planId, planRef, fromPlan, intelligenceApplied, approved, reason, ...scriptArgs } = raw;
      void plan;
      void planId;
      void planRef;
      void fromPlan;
      void intelligenceApplied;
      void approved;
      void reason;
      const parsed = UseFigmaArgs.parse(scriptArgs);
      const provenanceGate = requirePlanProvenance(raw, {
        ...(typeof approved === "boolean" ? { approved } : {}),
        ...(typeof reason === "string" ? { reason } : {}),
        ...(parsed.readonly !== undefined ? { readonly: parsed.readonly } : {}),
        ...(parsed.dryRun === true ? { dryRun: true } : {}),
        operations: [{ type: "native-script" }],
      });
      if (provenanceGate) return provenanceGate;
      return figdesUseFigmaHandler(registry.resolve(parsed.sessionId), parsed);
    }
  },

  {
    name: "figdes_read_context",
    title: "Read the file before changing it",
    description:
      "The read/context layer: understand an existing Figma file before modifying it. scope 'file' returns robust file metadata (pages, selection, component/variable/style counts, library collections); 'design-system' returns file metadata plus top-level frames and a bounded design-system summary; 'libraries' returns enabled team-library variable collections; 'components' returns local components and component sets; 'node' returns one node's full state (geometry, layout, paints, styles, text, component info). Read-only: it never opens a transaction. Use it to reuse what already exists instead of rebuilding it.",
    inputSchema: ReadContextArgs,
    handler: async (args, registry) => {
      const parsed = ReadContextArgs.parse(args ?? {});
      return figdesReadContextHandler(registry.resolve(parsed.sessionId), parsed);
    },
  },

  {
    name: "figdes_inspect_visual",
    title: "Lightweight visual inspection",
    description: "Inspect a Figma node using structural metrics plus a rendered screenshot when a valid scene node is available. Returns heuristic focal candidates, text hierarchy, surface/card analysis and the image so the model can make the actual visual judgement.",
    inputSchema: InspectVisualArgs,
    handler: async (args, registry) => {
      const parsed = InspectVisualArgs.parse(args ?? {});
      return figdesInspectVisualHandler(registry.resolve(parsed.sessionId), parsed);
    }
  },

  {
    name: "compare_visuals",
    title: "Compare two visual states",
    description:
      "The compare step of the review loop (inspect -> render -> critique -> modify -> render -> compare). Defaults to low-detail thumbnails (region crops for local changes via the node ids); renders two nodes, returns both screenshots and measurable before/after structural evidence plus a machine-readable delta (new overlaps, moved nodes, changed tokens, text overflow, contrast change) with an explicit render status per side. It never claims one version is better automatically: the measured deltas are evidence, the judgement is yours. Failure states (missing node, failed render, empty image) are reported rather than silently skipped. Render budget and actual cost stay visible.",
    inputSchema: CompareVisualsArgs,
    handler: async (args, registry) => {
      const parsed = CompareVisualsArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const collect = async (nodeId: string): Promise<{ ok: boolean; report?: MetricsReport; error?: string }> => {
        try {
          return { ok: true, report: (await session.request("collect_metrics", { target: nodeId })) as MetricsReport };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const render = async (nodeId: string): Promise<{ ok: boolean; data?: string; error?: string; width?: number; height?: number; estimatedTokens?: number }> => {
        try {
          const res = (await session.request("render_node", { nodeId, maxWidth: 1024, detail: "low" })) as {
            data?: string;
            width?: number;
            height?: number;
            estimatedTokens?: number;
          };
          if (!res?.data) return { ok: false, error: "Render returned no image data." };
          return { ok: true, data: res.data, width: res.width, height: res.height, estimatedTokens: res.estimatedTokens };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      };

      const [beforeCollect, afterCollect, beforeRender, afterRender] = await Promise.all([
        collect(parsed.beforeNodeId),
        collect(parsed.afterNodeId),
        render(parsed.beforeNodeId),
        render(parsed.afterNodeId),
      ]);

      const summarize = (report: MetricsReport) => ({
        nodes: report.nodeCount,
        truncated: report.truncated,
        frames: report.nodes.filter((n) => n.type === "FRAME").length,
        instances: report.nodes.filter((n) => n.type === "INSTANCE").length,
        texts: report.nodes.filter((n) => n.type === "TEXT").length,
        visibleArea: report.nodes.filter((n) => n.visible).reduce((sum, n) => sum + n.w * n.h, 0),
        filledSurfaces: report.nodes.filter((n) => Boolean(n.fill)).length,
        roundedSurfaces: report.nodes.filter((n) => (n.radius ?? 0) > 0).length,
      });

      const before = beforeCollect.report ? summarize(beforeCollect.report) : null;
      const after = afterCollect.report ? summarize(afterCollect.report) : null;

      const delta =
        before && after
          ? {
              nodes: after.nodes - before.nodes,
              frames: after.frames - before.frames,
              instances: after.instances - before.instances,
              texts: after.texts - before.texts,
              visibleArea: after.visibleArea - before.visibleArea,
              filledSurfaces: after.filledSurfaces - before.filledSurfaces,
              roundedSurfaces: after.roundedSurfaces - before.roundedSurfaces,
            }
          : null;

      // Machine-readable visual delta (P2): overlaps, movement, token drift,
      // text overflow and contrast signals — computed from fresh metrics, not
      // guessed from pixels.
      const machineDelta = (() => {
        if (!beforeCollect.report || !afterCollect.report) return null;
        const b = new Map(beforeCollect.report.nodes.map((n) => [n.id, n]));
        const moved = afterCollect.report.nodes.filter((n) => {
          const prev = b.get(n.id);
          return prev && (Math.abs(n.x - prev.x) > 1 || Math.abs(n.y - prev.y) > 1);
        }).length;
        const fillsBefore = new Set(beforeCollect.report.nodes.map((n) => n.fill).filter(Boolean));
        const changedTokens = afterCollect.report.nodes.filter((n) => n.fill && !fillsBefore.has(n.fill)).length;
        const textOverflow = afterCollect.report.nodes.filter((n) => n.text?.truncated).length;
        // New overlaps: overflow-rule findings now that were absent before.
        const { runRules: rules } = { runRules } as unknown as { runRules: typeof runRules };
        void rules;
        let newOverlaps = 0;
        let contrastChange = 0;
        try {
          const beforeFindings = runRules(beforeCollect.report, "review");
          const afterFindings = runRules(afterCollect.report, "review");
          const beforeOverflow = new Set(beforeFindings.filter((f) => f.rule === "overflow").map((f) => f.nodeIds.join("+")));
          newOverlaps = afterFindings.filter((f) => f.rule === "overflow" && !beforeOverflow.has(f.nodeIds.join("+"))).length;
          const beforeContrast = beforeFindings.filter((f) => /contrast/i.test(f.rule)).length;
          const afterContrast = afterFindings.filter((f) => /contrast/i.test(f.rule)).length;
          contrastChange = afterContrast - beforeContrast;
        } catch {
          /* rules are best-effort evidence */
        }
        return { newOverlaps, movedNodes: moved, changedTokens, textOverflow, contrastChange };
      })();

      const failures: string[] = [];
      if (!beforeCollect.ok) failures.push(`before metrics failed: ${beforeCollect.error}`);
      if (!afterCollect.ok) failures.push(`after metrics failed: ${afterCollect.error}`);
      if (!beforeRender.ok) failures.push(`before render failed: ${beforeRender.error}`);
      if (!afterRender.ok) failures.push(`after render failed: ${afterRender.error}`);

      const nextActions: string[] = [];
      if (!beforeRender.ok || !afterRender.ok) {
        nextActions.push("Fix the render failure (node exists? is it a frame/component/instance?) before judging the change.");
      }
      if (delta) {
        if (delta.visibleArea === 0 && delta.nodes !== 0) {
          nextActions.push("Structure changed but visible area did not: confirm the change is actually visible, not just structural.");
        }
        if (delta.roundedSurfaces > 0 && after && after.roundedSurfaces >= after.filledSurfaces) {
          nextActions.push("The change added rounded surfaces: check whether it drifted toward a card wall.");
        }
      }
      if (machineDelta) {
        if (machineDelta.newOverlaps > 0) nextActions.push(`${machineDelta.newOverlaps} new overlap(s) appeared: fix geometry before calling it done.`);
        if (machineDelta.textOverflow > 0) nextActions.push(`${machineDelta.textOverflow} text node(s) truncate: widen the frame or shorten the copy.`);
        if (machineDelta.contrastChange > 0) nextActions.push("Contrast findings increased: re-check text against its composited background.");
      }
      if (nextActions.length === 0) nextActions.push("Compare the two images: does the intended focal point read more clearly after than before?");

      // Finding verification (point D): the repair loop must show its work.
      // Both sides are required — a resolution claimed without a fresh
      // after-report is a guess, not evidence.
      const { trackFindings } = await import("./design/quality/visual-findings");
      const resolution = parsed.priorFindings && parsed.currentFindings
        ? trackFindings(parsed.priorFindings, parsed.currentFindings)
        : null;
      if (parsed.priorFindings && !parsed.currentFindings) {
        nextActions.push("Prior findings were supplied without a fresh after-report: judge the AFTER image and pass currentFindings to verify resolution.");
      }

      const renderCost = {
        beforeTokens: beforeRender.estimatedTokens ?? 0,
        afterTokens: afterRender.estimatedTokens ?? 0,
        detail: "low" as const,
        note: "Low-detail thumbnails by default; re-render the affected region at high detail only for text-level questions.",
      };

      const content: any[] = [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: failures.length > 0 ? "comparison-partial" : "comparison-ready",
              before,
              after,
              delta,
              machineDelta,
              renderCost,
              resolution,
              renderStatus: { before: beforeRender.ok ? "ok" : "failed", after: afterRender.ok ? "ok" : "failed" },
              failures,
              nextActions,
              judgement:
                "Measured deltas are evidence, not a verdict. The tool intentionally does not fabricate improved=true; judge the two images yourself.",
              focalOnly: parsed.focalOnly ?? false,
            },
            null,
            2,
          ),
        },
      ];

      if (beforeRender.ok && beforeRender.data) {
        content.push({ type: "text", text: "BEFORE screenshot" });
        content.push({ type: "image", data: beforeRender.data, mimeType: "image/png" });
      }
      if (afterRender.ok && afterRender.data) {
        content.push({ type: "text", text: "AFTER screenshot" });
        content.push({ type: "image", data: afterRender.data, mimeType: "image/png" });
      }

      return { content };
    },
  },

  {
    name: "create_slide",
    title: "Create one slide in Figma Slides",
    description:
      "Create a single 1920x1080 slide with a title, optional body copy, background and speaker notes, in one transaction. Sizes are chosen for the back of the room: a title that reads at a glance, not desktop type scaled up. For a whole deck, use design_runtime with deck:true on the canvas instead - one region per slide. Refused loudly outside Figma Slides.",
    inputSchema: CreateSlideArgs,
    handler: async (args, registry) => {
      const parsed = CreateSlideArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const gate = guardMutation({
        operations: [{ type: "createSlide" }] as Array<Record<string, unknown>>,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
      });
      if (gate) return gate;

      const operations: Array<Record<string, unknown>> = [
        {
          type: "createSlide",
          id: "slide",
          ...(parsed.name !== undefined ? { name: parsed.name } : {}),
          ...(parsed.row !== undefined ? { row: parsed.row } : {}),
          ...(parsed.col !== undefined ? { col: parsed.col } : {}),
          ...(parsed.background !== undefined ? { background: parsed.background } : {}),
          ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
          ...(parsed.skipped !== undefined ? { skipped: parsed.skipped } : {}),
        },
      ];

      // Title block: one headline, generous margins, nothing else competing.
      // 160px margins on 1920 is the proportion that keeps a slide from reading
      // as a crowded desktop frame.
      if (parsed.title) {
        operations.push({
          type: "createText",
          parent: "slide",
          name: "Title",
          x: 160,
          y: 200,
          content: parsed.title,
          family: "Inter",
          weight: 700,
          fontSize: 120,
          fill: parsed.titleColor ?? "#111111",
          width: 1600,
        });
      }

      if (parsed.body) {
        operations.push({
          type: "createText",
          parent: "slide",
          name: "Body",
          x: 160,
          y: parsed.title ? 420 : 300,
          content: parsed.body,
          family: "Inter",
          weight: 400,
          fontSize: 48,
          fill: parsed.bodyColor ?? "#444444",
          width: 1200,
        });
      }

      // Issue #23 close-out: the slide build goes through the same tracked
      // dispatcher every mutating tool uses — validateTransaction (the template
      // ops still need the duplicate-id / dual-parent / stale-target checks),
      // the job ledger and the document lock. Going straight to the socket
      // skipped all three.
      const result = await dispatchTransaction(registry, session, "create_design", {
        description: parsed.description ?? `Slide: ${parsed.title ?? parsed.name ?? "untitled"}`,
        operations,
        dryRun: parsed.dryRun ?? false,
        ...(parsed.transactionId !== undefined ? { transactionId: parsed.transactionId } : {}),
      });
      return assertTransaction(result);
    },
  },

  {
    name: "create_design",
    title: "Create a design in Figma (low level)",
    description:
      "Create real native Figma nodes (frames, rectangles, ellipses, text, auto layout) from a structured operation list. Applied as one undoable transaction. Raw operations bypass ALL design intelligence (no decision classification, no composition plan, no build-time product guard) — for new screens, plan first with plan_screen or design_pipeline and prefer design_runtime; run design_guard(inspect:true) on the result afterwards. Set dryRun=true first for anything large.",
inputSchema: CreateArgs,
    handler: async (args, registry) => {
      const parsed = CreateArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const existing = await resolveExistingResources(session, parsed.operations as Array<Record<string, unknown>>);
      const gate = guardMutation({
        operations: parsed.operations as Array<Record<string, unknown>>,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
        ...(existing !== undefined ? { existing } : {}),
      });
      if (gate) return gate;

      // Issue #26: raw operations bypass ALL design intelligence. A non-dry-run
      // dispatch needs plan_screen provenance (or the intelligence-applied
      // signal) or an explicit approved+reason justification. Dry runs stay
      // open: design-time inspection must not need approval.
      const provenanceGate = requirePlanProvenance(args, {
        ...(parsed.approved !== undefined ? { approved: parsed.approved } : {}),
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
        operations: parsed.operations,
      });
      if (provenanceGate) return provenanceGate;

      if (parsed.dryRun) {
        // Dry runs validate without ledger noise: preflight + trace only.
        const preflight = validateTransaction(parsed.operations as unknown[]);
        if (!preflight.ok) {
          recordPreflightCatch(preflight.issues.length);
          throw new Error(
            `Preflight rejected the plan (${preflight.issues.length} issue(s)):\n` +
              preflight.issues.slice(0, 8).map((i) => `  #${i.index} (${i.opType}): ${i.message} Fix: ${i.fix}`).join("\n"),
          );
        }
        const result = (await session.request("create_design", {
          description: parsed.description,
          operations: parsed.operations,
          dryRun: true,
          transactionId: parsed.transactionId,
        })) as TransactionResult;
        return assertTransaction(result);
      }

      return dispatchTransaction(registry, session, "create_design", {
        description: parsed.description,
        operations: parsed.operations as unknown[],
        transactionId: parsed.transactionId,
        ...(scoreGuardForDispatch(parsed) !== undefined ? { scoreGuard: scoreGuardForDispatch(parsed) } : {}),
      });
    },
  },

  {
    name: "modify_design",
    title: "Modify existing Figma nodes",
    description:
      "Change existing nodes by id: rename, resize, reposition, restyle, restructure with auto layout, or remove. Always inspect first and address nodes by their real Figma id. Raw edits bypass design intelligence — re-run design_guard(inspect:true) on the affected frame afterwards.",
inputSchema: ModifyArgs,
    handler: async (args, registry) => {
      const parsed = ModifyArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const existing = await resolveExistingResources(session, parsed.operations as Array<Record<string, unknown>>);
      const gate = guardMutation({
        operations: parsed.operations as Array<Record<string, unknown>>,
        approved: parsed.approved,
        reason: parsed.reason,
        dryRun: parsed.dryRun ?? false,
        ...(existing !== undefined ? { existing } : {}),
      });
      if (gate) return gate;

      // Issue #26: same provenance gate as create_design — raw edits bypass
      // design intelligence, so they need a plan reference or an explicit
      // approved+reason justification. Dry runs stay open.
      const provenanceGate = requirePlanProvenance(args, {
        ...(parsed.approved !== undefined ? { approved: parsed.approved } : {}),
        ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
        ...(parsed.dryRun !== undefined ? { dryRun: parsed.dryRun } : {}),
        operations: parsed.operations,
      });
      if (provenanceGate) return provenanceGate;

      if (parsed.dryRun) {
        const preflight = validateTransaction(parsed.operations as unknown[]);
        if (!preflight.ok) {
          recordPreflightCatch(preflight.issues.length);
          throw new Error(
            `Preflight rejected the plan (${preflight.issues.length} issue(s)):\n` +
              preflight.issues.slice(0, 8).map((i) => `  #${i.index} (${i.opType}): ${i.message} Fix: ${i.fix}`).join("\n"),
          );
        }
        const result = (await session.request("modify_design", {
          targets: parsed.targets,
          description: parsed.description,
          operations: parsed.operations,
          dryRun: true,
          transactionId: parsed.transactionId,
        })) as TransactionResult;
        return assertTransaction(result);
      }

      return dispatchTransaction(registry, session, "modify_design", {
        targets: parsed.targets,
        description: parsed.description,
        operations: parsed.operations as unknown[],
        transactionId: parsed.transactionId,
        ...(scoreGuardForDispatch(parsed) !== undefined ? { scoreGuard: scoreGuardForDispatch(parsed) } : {}),
      });
    },
  },

  {
    name: "get_job_status",
    title: "Check a transaction's durable status",
    description:
      "Report the ledger state for a transactionId (queued, preflight, applying, verifying, committed, rolled-back, partial-rollback, failed, timed-out) with progress and final node ids. Call this after any reconnect or timeout before retrying — a retry must reuse the SAME transactionId and is idempotent, never a blind duplicate. timed-out means unknown outcome: the plugin may still commit late, and a late result reconciles automatically.",
    inputSchema: z.object({ transactionId: z.string().min(1).max(200), sessionId: SessionArg }).strict(),
    handler: async (args, registry) => {
      const parsed = (z.object({ transactionId: z.string().min(1).max(200), sessionId: SessionArg }).strict()).parse(args ?? {});
      const job = registry.jobs.get(parsed.transactionId);
      if (!job) {
        const evicted = registry.jobs.wasEvicted?.(parsed.transactionId) ?? false;
        return {
          status: "unknown",
          transactionId: parsed.transactionId,
          ...(evicted ? { evicted: true } : {}),
          howToProceed: evicted
            ? "This transaction ran and completed earlier, but the bounded ledger window evicted its record, so the same-id idempotency guarantee no longer holds: the result cache and history are gone. Inspect the target subtree for the expected nodes and confirm what landed before re-sending; if you re-send, the plugin-side dedupe is the remaining (bounded) guard."
            : "No ledger record for this id. It either predates this server run or never dispatched. Re-send with the SAME transactionId once; if it was already applied you will get a duplicate-safe result instead of duplicated nodes.",
          recentJobs: registry.jobs.recent(5),
        };
      }
      if (job.state === "timed-out") {
        const prior = registry.jobs.priorResult(parsed.transactionId);
        return {
          status: "ok",
          job,
          reconciledResult: prior ?? null,
          metrics: metricsSnapshot(),
          howToProceed:
            "Outcome unknown: the server stopped waiting but Figma may still commit late (a cancel was requested). Wait a beat, call get_job_status again — a late plugin answer reconciles automatically — inspect the target subtree for partial work, and only then resume with the SAME transactionId. Never mint a new id for the same edit.",
        };
      }
      return { status: "ok", job, metrics: metricsSnapshot() };
    },
  },

  {
    name: "resume_job",
    title: "Resume a transaction after reconnect",
    description:
      "Rebind a timed-out or disconnected transaction to the live session and report whether it committed, rolled back, or needs a safe idempotent retry. Never silently retargets across files: when multiple files are open you must pass an explicit sessionId.",
    inputSchema: z
      .object({
        transactionId: z.string().min(1).max(200),
        sessionId: SessionArg,
        operations: z.array(z.record(z.unknown())).max(2000).optional().describe("Only for a safe retry when the ledger says the job never committed. Reuses the same transactionId."),
        description: z.string().max(1000).optional(),
      })
      .strict(),
    handler: async (args, registry) => {
      const parsed = (
        z
          .object({
            transactionId: z.string().min(1).max(200),
            sessionId: SessionArg,
            operations: z.array(z.record(z.unknown())).max(2000).optional(),
            description: z.string().max(1000).optional(),
          })
          .strict()
      ).parse(args ?? {});
      const job = registry.jobs.get(parsed.transactionId);
      if (!job) {
        return {
          status: "unknown",
          transactionId: parsed.transactionId,
          howToProceed: "No ledger record. Pass operations with this transactionId once to dispatch it idempotently.",
        };
      }
      if (job.state === "committed") {
        const prior = registry.jobs.priorResult(parsed.transactionId);
        return { status: "already-committed", job, result: prior ?? null, howToProceed: "Do not retry: the work already landed. Inspect the created ids from the ledger." };
      }
      if (job.state === "timed-out") {
        if (!parsed.operations) {
          return {
            status: "needs-reconciliation",
            job,
            reconciledResult: registry.jobs.priorResult(parsed.transactionId) ?? null,
            howToProceed:
              "Outcome unknown: call get_job_status again (a late result reconciles automatically), inspect the target subtree for partial work, then pass operations with the SAME transactionId to retry only once you have confirmed what landed. The plugin dedupes by transactionId, so a same-id retry never duplicates a late commit.",
          };
        }
        const session = registry.resolve(parsed.sessionId ?? job.sessionId);
        return dispatchTransaction(registry, session, "modify_design", {
          description: parsed.description ?? `resume ${parsed.transactionId}`,
          operations: parsed.operations as unknown[],
          transactionId: parsed.transactionId,
        });
      }
      if (job.state === "rolled-back" || job.state === "partial-rollback" || job.state === "failed") {
        if (!parsed.operations) {
          return { status: "needs-retry-payload", job, howToProceed: "Pass operations with the SAME transactionId to retry safely; preflight runs before Figma is contacted." };
        }
        const session = registry.resolve(parsed.sessionId ?? job.sessionId);
        return dispatchTransaction(registry, session, "modify_design", {
          description: parsed.description ?? `resume ${parsed.transactionId}`,
          operations: parsed.operations as unknown[],
          transactionId: parsed.transactionId,
        });
      }
      // Still in flight (queued/preflight/applying/verifying): report, don't duplicate.
      return { status: "in-flight", job, howToProceed: "The job is still tracked as in-flight. Wait for progress, then call get_job_status again — do not dispatch a duplicate transaction." };
    },
  },

  {
    name: "edit_screen",
    title: "Edit a screen in one tracked pass",
    description:
      "The reliable edit loop in one call: discover the target subtree once, preflight the patch (Figma is never contacted on failure), commit as one ledger-tracked transaction with one id, render a low-detail thumbnail, review geometry/accessibility/token consistency, produce a machine-readable before/after delta, and run one targeted token-aware repair pass. One transaction id, one timeline, one diff. Final QA still needs your fresh render judgement.",
    inputSchema: EditScreenArgs,
    handler: async (args, registry) => editScreenTool(registry, args),
  },
  {
    name: "undo_last_operation",
    title: "Undo the last design transaction",
    description: "Revert the last committed create_design or modify_design transaction using Figma's native undo stack.",
    inputSchema: UndoArgs,
    handler: async (args, registry) => {
      const { sessionId } = UndoArgs.parse(args ?? {});
      const session = registry.resolve(sessionId);
      return session.request("undo_last_operation", {});
    },
  },
];

export const TOOL_MAP = new Map<ToolName, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

export { NoArgs };
