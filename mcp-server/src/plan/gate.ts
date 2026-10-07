/**
 * The checkpoint gate, applied to mutating tools (spec §38).
 *
 * Two pieces:
 *
 * 1. `guardMutation` inspects an operation list *before* it is sent to Figma and
 *    returns a refusal when a gate fires. Refusing server-side rather than
 *    warning matters: a warning in the response body is something the model can
 *    reason its way past, and the whole point is that it cannot.
 *
 * 2. A single-use approval ledger, so the user's "yes" covers one specific change
 *    rather than the rest of the conversation.
 *
 * `dryRun` bypasses the gate deliberately. A dry run creates nothing, so asking
 * for permission to do nothing is pure friction — and dry runs are exactly how a
 * model should find out whether a change is destructive *before* asking.
 */
import { evaluateCheckpoints, CheckpointLedger, type ChangeShape } from "./checkpoints";

/** Shared across requests; keyed per change so approvals do not leak. */
const ledger = new CheckpointLedger();

/** Operation types that delete or discard. */
const DESTRUCTIVE = new Set(["removeNode", "removeNodes", "deleteNode"]);

/**
 * Operation types that define a shared, file-wide resource.
 *
 * Not gated on their own. Defining a token that does not exist yet is how a design
 * system gets built, and blocking it would make token support unusable. Only
 * *redefining* one that is already used elsewhere is the global change §38 asks
 * about, so the gate compares declared names against the ones already in the file.
 */
const SHARED_RESOURCE = new Set(["createVariable", "createTextStyle", "createPaintStyle"]);

/** Which resource kind each shared-resource operation defines. */
function resourceKind(type: string): "variable" | "textStyle" | "paintStyle" | undefined {
  if (type === "createVariable") return "variable";
  if (type === "createTextStyle") return "textStyle";
  if (type === "createPaintStyle") return "paintStyle";
  return undefined;
}

/** What the file already has, by name. */
export interface ExistingResources {
  variables?: Iterable<string>;
  textStyles?: Iterable<string>;
  paintStyles?: Iterable<string>;
}

export interface GuardInput {
  operations: Array<Record<string, unknown>>;
  /** Human approval, passed through from the tool args. */
  approved?: boolean;
  reason?: string;
  /** A dry run creates nothing and so needs no permission. */
  dryRun?: boolean;
  /** What the file already defines, so token creation is not mistaken for a change. */
  existing?: ExistingResources;
}

/**
 * Summarises an operation list into the shape the gates care about.
 *
 * Exported because it is the part worth asserting on: a gate that fires for the
 * wrong reason teaches the user to approve without reading.
 *
 * `existing` is what the file already contains. When it is supplied, a
 * shared-resource operation only counts as a global change if it *redefines* an
 * existing name; when it is absent the operation is assumed new, because refusing
 * every token creation would be a worse failure than missing one redefinition.
 */
export function summarizeOperations(operations: Array<Record<string, unknown>>, existing?: ExistingResources): ChangeShape {
  let destructiveCount = 0;
  let globalTokenChange = false;
  const targets = new Set<string>();

  const sets: Record<"variable" | "textStyle" | "paintStyle", Set<string> | undefined> = {
    variable: existing?.variables ? new Set(existing.variables) : undefined,
    textStyle: existing?.textStyles ? new Set(existing.textStyles) : undefined,
    paintStyle: existing?.paintStyles ? new Set(existing.paintStyles) : undefined,
  };

  for (const op of operations) {
    const type = typeof op.type === "string" ? op.type : "";

    if (DESTRUCTIVE.has(type)) destructiveCount += 1;

    if (SHARED_RESOURCE.has(type)) {
      const kind = resourceKind(type);
      const name = typeof op.name === "string" ? op.name : undefined;
      const known = kind ? sets[kind] : undefined;
      // No `known` means the caller could not tell us what exists; treat it as new.
      if (known && name !== undefined && known.has(name)) globalTokenChange = true;
    }

    for (const key of ["target", "parent", "child"]) {
      const value = op[key];
      if (typeof value === "string" && /^\d+:\d+$/.test(value)) targets.add(value);
    }
  }

  return {
    operationCount: operations.length,
    destructiveCount,
    // Only real Figma ids count. Transaction-local ids are created by this very
    // change, so counting them would inflate the blast radius of every build.
    targetCount: targets.size,
    globalTokenChange,
  };
}

/**
 * Returns a refusal payload when a gate fires, or `null` when work may proceed.
 *
 * The refusal is a *result*, not an error. Throwing would make it look like a
 * failure of the tool rather than a deliberate pause, and the model would retry
 * without reading.
 */
export function guardMutation(input: GuardInput): Record<string, unknown> | null {
  if (input.dryRun) return null;

  const shape = summarizeOperations(input.operations, input.existing);
  const result = evaluateCheckpoints(shape);

  if (result.cleared) return null;

  const key = CheckpointLedger.keyFor([shape.operationCount, shape.destructiveCount, shape.targetCount, shape.globalTokenChange]);

  // An explicit approval authorises *this* call and nothing more.
  //
  // It deliberately does not write to the ledger. Recording it would let the
  // approval be consumed by the *next* change that happened to have the same
  // shape, which is precisely the leak that makes an approval persist across the
  // rest of the session. Any previously stored approval for this shape is dropped
  // so it cannot fire either.
  if (input.approved === true) {
    ledger.forget(key);
    return null;
  }

  // An approval recorded out of band (the user said "go ahead" in chat before the
  // model retried) may be consumed here. Single use by design.
  const consumed = ledger.consume(key);
  if (consumed.approved) return null;

  return {
    status: "needs-approval",
    /** The one question to put to the user. */
    question: result.checkpoint?.question,
    ifApproved: result.checkpoint?.ifApproved,
    instead: result.checkpoint?.instead,
    /** Every gate that fired, so nothing is hidden behind the first. */
    checkpoints: result.all,
    /** What the server measured, so the approval is informed. */
    measured: {
      operations: shape.operationCount ?? 0,
      destructive: shape.destructiveCount ?? 0,
      existingNodesTargeted: shape.targetCount ?? 0,
      changesSharedResource: shape.globalTokenChange ?? false,
    },
    howToProceed:
      "Nothing has been changed. If the user approves, call this tool again with approved:true and, if they give one, a short reason. " +
      "To see the full effect first, call the same tool with dryRun:true - that needs no approval.",
  };
}

/** Exposed so tests can start from a clean ledger. */
export function resetApprovals(): void {
  (ledger as unknown as { approved: Map<string, unknown> }).approved.clear();
}

/**
 * Asks the plugin which variables and styles already exist.
 *
 * Only called when the operation list actually defines a shared resource, so the
 * common build path pays nothing. The plugin caches this scan for 15s, so even the
 * rare path is cheap.
 *
 * A failure here is not fatal: the gate then assumes every name is new, which can
 * miss a redefinition but will never block a legitimate token creation.
 */
export async function resolveExistingResources(
  session: { request: (tool: "extract_design_system", payload: unknown) => Promise<unknown> } | null,
  operations: Array<Record<string, unknown>>,
): Promise<ExistingResources | undefined> {
  const declaresResource = operations.some((op) => typeof op.type === "string" && SHARED_RESOURCE.has(op.type));
  if (!declaresResource) return undefined;
  if (!session) return undefined;

  try {
    const report = (await session.request("extract_design_system", { includeVariables: true, includeStyles: true })) as {
      variables?: Array<{ name?: string }>;
      styleNames?: { paint?: string[]; text?: string[] };
    };

    return {
      variables: (report.variables ?? []).map((v) => v.name ?? "").filter(Boolean),
      paintStyles: report.styleNames?.paint ?? [],
      textStyles: report.styleNames?.text ?? [],
    };
  } catch {
    return undefined;
  }
}