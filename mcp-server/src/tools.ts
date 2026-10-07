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
  type MetricsReport,
  type ReviewReport,
  type ToolName,
  type PluginToolName,
  type TransactionResult,
} from "../../shared/protocol";
import { SessionRegistry, type Session } from "./sessions";
import { runRules, summarise, type RuleSet } from "./review/rules";
import { CompileArgs, RuntimeArgs, compileIrTool, runRuntimeTool, runtimeCatalogue } from "./runtime/tools";
import { renderDesign } from "./render-tool";
import { DesignGuardArgs, ProjectMemoryArgs, designGuardTool, projectMemoryTool } from "./memory/tools";
import { PlanScreenArgs, planScreenTool } from "./plan/tools";
import { DesignBriefArgs, designBriefTool } from "./plan/brief";
import { projectKey } from "./memory/store";
import { saveSnapshot, listSnapshots, getSnapshot } from "./snapshots/store";
import { guardMutation, resolveExistingResources } from "./plan/gate";
import { exoSeedOperations, exoSeedCounts } from "./tokens/exo";
import { ScoreArgs, CritiqueArgs, RefineArgs, DiffArgs, FinalQaArgs, scoreDesignTool, critiqueVisualTool, refineScreenTool, diffDesignTool, finalQaTool } from "./review/workflow";
import { exportCode } from "./code/export";
import { UseFigmaArgs, InspectVisualArgs, figdesUseFigmaHandler, figdesInspectVisualHandler } from "./native/use-figma";

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
      .describe("Semantic role: primaryAction, activeNavigation, navigation, heroTitle, topologyMap, statusBadge, searchField."),
    name: z.string().max(200).optional().describe("Substring of the layer name."),
    text: z.string().max(500).optional().describe("Substring of text content."),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

const SetVariantArgs = z
  .object({
    sessionId: SessionArg,
    instanceId: z.string().max(200).describe("Figma id of the instance. Resolve it with find_node first."),
    variant: z.string().max(200).describe("Variant name, exact or as Property=Value pairs."),
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

const ReviewArgs = z
  .object({
    sessionId: SessionArg,
    target: z.string().max(200).optional().describe("Figma node id to review. Omit to review the current selection."),
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
 * A failed transaction is thrown as an MCP tool error rather than returned as a
 * successful payload. Returning `{status:"failed"}` as a *success* invites the
 * model to gloss over it and report the design as done.
 */
function assertTransaction(result: TransactionResult): TransactionResult {
  if (result.status === "failed") {
    const { operation, opType, message, hint, rolledBackNote } = result.error;
    const where = operation >= 0 ? `operation #${operation} (${opType})` : "the plan";
    throw new Error(
      `Figma rejected the transaction at ${where}: ${message}\n` +
        `Document state: ${rolledBackNote}\n` +
        `Next step: ${hint}`,
    );
  }
  return result;
}

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

  return {
    scope: raw.scope,
    reviewedNodes: raw.nodeCount,
    truncated,
    summary,
    autoFixable: findings.filter((f) => f.confidence === "high" && f.suggestedOperations?.length).length,
    findings,
    scan: raw.scan,
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

export const CompareVisualsArgs = z.object({
  sessionId: z.string().max(200).optional(),
  beforeNodeId: z.string().describe("The node ID of the previous state"),
  afterNodeId: z.string().describe("The node ID of the new state"),
  focalOnly: z.boolean().optional().describe("Only compare focal regions"),
});

export const TOOLS: ToolDefinition[] = [
  {
    name: "figma_status",
    title: "Figma connection status",
    description:
      "Check whether a Figma Design Agent plugin is connected, and which file/page/selection it is attached to. Call this first — if connected is false, nothing else will work.",
    inputSchema: StatusArgs,
    handler: async (args, registry) => {
      const { sessionId } = StatusArgs.parse(args ?? {});
      try {
        const session = registry.resolve(sessionId);
        return { ...session.status(), connected: true };
      } catch (err) {
        if (registry.alive().length === 0) return DISCONNECTED;
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
      "Resolve a node from intent: a screen name, a semantic role (primaryAction, activeNavigation, navigation, heroTitle, topologyMap, statusBadge, searchField), a layer-name substring, or a text-content substring. Returns real Figma ids with the reason each matched, so a surprising result is inspectable. Use this before modify_design instead of reusing ids from older transactions - stale ids are how the wrong subtree gets edited.",
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
      "Change which variant of a component set an instance shows, by variant name (exact or Property=Value pairs). Use this instead of deleting an instance and placing a new one - the position, overrides and layer order survive.",
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

      return viaPlugin(session, "update_component", rest);
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

      const result = (await session.request("create_design", {
        description: "Seed the canonical exo token set",
        operations,
        dryRun: parsed.dryRun ?? false,
        transactionId: parsed.transactionId,
      })) as TransactionResult;
      return { ...assertTransaction(result), seeded: counts };
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
      const { sessionId, ruleset, minConfidence, limit, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return reviewSession(session, rest, ruleset ?? "review", minConfidence ?? "low", limit ?? 60);
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
      const { sessionId, ruleset, minConfidence, limit, ...rest } = parsed;
      const session = registry.resolve(sessionId);
      return reviewSession(session, rest, ruleset ?? "audit", minConfidence ?? "low", limit ?? 60);
    },
  },

  {
    name: "design_runtime",
    title: "Build a design from semantic primitives",
    description:
      "PREFERRED over create_design for building screens. Send a declarative program of regions (navigation, hero, header, inspector) and semantic content (metric, statusPill, deviceNode, navItem, panel, button, text, shape, vector) instead of hand-placing dozens of primitives. The layout engine computes all coordinates and the typography scale is applied for you, so you state intent rather than geometry. This is structured JSON naming built-in primitives, NOT code: there is no eval path and code will be rejected. Pass dryRun=true first.",
    inputSchema: RuntimeArgs,
    handler: async (args, registry) => {
      const parsed = RuntimeArgs.parse(args);
      const { sessionId, dryRun, ...rest } = parsed;

      // Resolved lazily so a dry run works with Figma closed.
      const session = dryRun === true && !sessionId ? null : registry.resolve(sessionId);
      return runRuntimeTool(session, { ...rest, dryRun });
    },
  },

  {
    name: "runtime_primitives",
    title: "List the design runtime primitives",
    description:
      "List every primitive design_runtime accepts, with its kind and description. Call this if you are unsure what vocabulary is available before writing a program.",
    inputSchema: z.object({}).strict(),
    handler: async () => ({
      note: "These are the complete vocabulary. There is no eval path; nothing is executed as code.",
      primitives: runtimeCatalogue(),
    }),
  },

  {
    name: "score_design",
    title: "Score a design before claiming it is done",
    description:
      "Score a declarative program on composition, hierarchy, density, alignment, consistency and accessibility, 0-10 each with the measured evidence and what would move each number. Deterministic and free: the same program always scores the same. Use it after design_runtime and before presenting anything - a weak spot below 6 is a fix list, not a failure.",
    inputSchema: ScoreArgs,
    handler: async (args) => scoreDesignTool(args),
  },

  {
    name: "critique_visual",
    title: "Judge whether a design is good, not just correct",
    description:
      "The aesthetic critic: evaluate a program on focal clarity, hierarchy, composition, whitespace, density, repetition, card-wall tendency, visual balance, data-visualization quality, surface hierarchy, depth, and template feel. Verdicts are PASS / WATCH / FAIL with measured evidence - never arbitrary scores. Structural issues (overflow, contrast, naming) belong to review_design and are NOT mixed in here. Deterministic and free: run it alongside score_design before presenting anything.",
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
      return refineScreenTool(registry.resolve(parsed.sessionId), parsed);
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

      const result = (await session.request("create_design", {
        description: `Migrate ${operations.length} fills to variables`,
        operations,
      })) as TransactionResult;
      return { ...assertTransaction(result), matches };
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

      const result = (await session.request("create_design", {
        description: parsed.description ?? `Prototype flow: ${operations.length} link(s)`,
        operations,
        dryRun: parsed.dryRun ?? false,
        transactionId: parsed.transactionId,
      })) as TransactionResult;
      return assertTransaction(result);
    },
  },

  {
    name: "compile_ir",
    title: "Compile a Design IR to operations",
    description:
      "Compile a Design IR (canvas, regions with semantic roles, content) into Figma operations without touching the document. Use this to validate a layout or inspect the resolved geometry. Lower level than design_runtime: prefer design_runtime unless you need explicit control over regions.",
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
      "The do-not-drift layer. Checks a design against the project's product truths (spec: devices auto-discover, placement is automatic, chat is not primary, avoid generic SaaS card walls) and returns PASS / WARNING / FAIL with the measured evidence for each. Pass a program to check a design before building it, or inspect:true to check what is currently in the file. Read-only and free. Only machine-checkable evidence can produce a FAIL; anything needing judgement is returned as a question for a human rather than guessed at.",
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
      "Start here for any new screen. States the primary decision the user makes, infers the composition that follows from it, and returns a 2D composition model with real geometry, an ordered region list where each region says why it exists, the art director's decisions (focal, hierarchy, strategies, states, risks), a five-pass build plan, full structural variants to compare, and a preview of which product rules the plan will trip. Accepts an archetype ('model-fit', 'topology'...) that presets objective, decision and anti-patterns. Creates nothing, so a wrong composition costs one message instead of an undo. A page type is not a decision: 'dashboard' or 'overview' will be pushed back on, because page types are what produce generic layouts.",
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
    name: "figdes_use_figma",
    title: "Native Execution Tool",
    description: "Execute controlled JavaScript against the native FigDes Figma API. Supports native creation, inspection, geometry, paint, typography, vectors, auto layout, constraints, components, variants, variables, styles, masks and undo-safe script transactions. It does not expose the raw global figma object. All fig.* calls are asynchronous and must be awaited.",
    inputSchema: UseFigmaArgs,
    handler: async (args, registry) => {
      const parsed = UseFigmaArgs.parse(args ?? {});
      return figdesUseFigmaHandler(registry.resolve(parsed.sessionId), parsed);
    }
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
    description: "Render two Figma nodes and return structural deltas plus both screenshots. The tool never claims that one version is visually better automatically; use the images and measured deltas for the judgement.",
    inputSchema: CompareVisualsArgs,
    handler: async (args, registry) => {
      const parsed = CompareVisualsArgs.parse(args);
      const session = registry.resolve(parsed.sessionId);

      const [beforeMetrics, afterMetrics] = await Promise.all([
        session.request("collect_metrics", { target: parsed.beforeNodeId }),
        session.request("collect_metrics", { target: parsed.afterNodeId }),
      ]) as [MetricsReport, MetricsReport];

      const render = async (nodeId: string) => {
        try {
          return await session.request("render_node", {
            nodeId,
            maxWidth: 1024,
            detail: "low",
          }) as any;
        } catch {
          return null;
        }
      };

      const [beforeRender, afterRender] = await Promise.all([
        render(parsed.beforeNodeId),
        render(parsed.afterNodeId),
      ]);

      const summarize = (report: MetricsReport) => ({
        nodes: report.nodeCount,
        truncated: report.truncated,
        frames: report.nodes.filter((n) => n.type === "FRAME").length,
        instances: report.nodes.filter((n) => n.type === "INSTANCE").length,
        texts: report.nodes.filter((n) => n.type === "TEXT").length,
        visibleArea: report.nodes
          .filter((n) => n.visible)
          .reduce((sum, n) => sum + n.w * n.h, 0),
        filledSurfaces: report.nodes.filter((n) => Boolean(n.fill)).length,
        roundedSurfaces: report.nodes.filter((n) => (n.radius ?? 0) > 0).length,
      });

      const before = summarize(beforeMetrics);
      const after = summarize(afterMetrics);

      const delta = {
        nodes: after.nodes - before.nodes,
        frames: after.frames - before.frames,
        instances: after.instances - before.instances,
        texts: after.texts - before.texts,
        visibleArea: after.visibleArea - before.visibleArea,
        filledSurfaces: after.filledSurfaces - before.filledSurfaces,
        roundedSurfaces: after.roundedSurfaces - before.roundedSurfaces,
      };

      const content: any[] = [{
        type: "text",
        text: JSON.stringify({
          status: "comparison-ready",
          before,
          after,
          delta,
          judgement: "Human/model visual judgement is required. The tool intentionally does not fabricate an improved=true result.",
          focalOnly: parsed.focalOnly ?? false,
        }, null, 2),
      }];

      if (beforeRender?.data) {
        content.push({
          type: "text",
          text: "BEFORE screenshot",
        });
        content.push({ type: "image", data: beforeRender.data, mimeType: "image/png" });
      }
      if (afterRender?.data) {
        content.push({
          type: "text",
          text: "AFTER screenshot",
        });
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

      const result = (await session.request("create_design", {
        description: parsed.description ?? `Slide: ${parsed.title ?? parsed.name ?? "untitled"}`,
        operations,
        dryRun: parsed.dryRun ?? false,
        transactionId: parsed.transactionId,
      })) as TransactionResult;
      return assertTransaction(result);
    },
  },

  {
    name: "create_design",
    title: "Create a design in Figma (low level)",
    description:
      "Create real native Figma nodes (frames, rectangles, ellipses, text, auto layout) from a structured operation list. Applied as one undoable transaction. Set dryRun=true first for anything large.",
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

      const result = (await session.request("create_design", {
        description: parsed.description,
        operations: parsed.operations,
        dryRun: parsed.dryRun ?? false,
        transactionId: parsed.transactionId,
      })) as TransactionResult;
      return assertTransaction(result);
    },
  },

  {
    name: "modify_design",
    title: "Modify existing Figma nodes",
    description:
      "Change existing nodes by id: rename, resize, reposition, restyle, restructure with auto layout, or remove. Always inspect first and address nodes by their real Figma id.",
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

      const result = (await session.request("modify_design", {
        targets: parsed.targets,
        description: parsed.description,
        operations: parsed.operations,
        dryRun: parsed.dryRun ?? false,
        transactionId: parsed.transactionId,
      })) as TransactionResult;
      return assertTransaction(result);
    },
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
