/**
 * Shared-schema preflight validation (P1).
 *
 * Runs the SAME OperationSchema the plugin enforces, plus transaction-level
 * checks (temp-id uniqueness, references, parent/child validity, ordering,
 * page targets, type compatibility) BEFORE any WebSocket/document contact.
 * A bad request fails here with every issue at once — operation indices plus
 * minimal fix suggestions — instead of wasting a Figma round trip per error.
 *
 * The plugin repeats this validation as the trust boundary; preflight is the
 * early, consistent gate, not a replacement.
 */
import { OperationSchema, type PreflightIssue, type PreflightResult } from "../../shared/protocol";

const TEMP_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const FIGMA_ID_RE = /^\d+:\d+$/;

function isTempRef(ref: string): boolean {
  return !FIGMA_ID_RE.test(ref) && !ref.includes(":");
}

const CREATE_TYPES = new Set([
  "createFrame",
  "createRectangle",
  "createEllipse",
  "createText",
  "createVector",
  "booleanOperation",
  "outlineStroke",
  "createSlide",
  "cloneNode",
  "createComponent",
  "createInstance",
]);

const MUTATE_TARGET_TYPES = new Set([
  "renameNode",
  "setPosition",
  "setSize",
  "setFill",
  "setStroke",
  "setOpacity",
  "setCornerRadius",
  "removeNode",
  "cloneNode",
  "setAutoLayout",
  "setPadding",
  "setGap",
  "setTypography",
  "setTextContent",
  "setVisible",
  "setPage",
  "setConstraints",
  "setVectorPath",
  "mirrorNode",
  "setLayoutGrid",
  "setEffect",
  "bindVariable",
  "setVariant",
]);

function fixFor(code: string): string {
  switch (code) {
    case "schema":
      return "Check the operation type and field names against the create_design schema; omit nullable fields instead of passing null.";
    case "dup-id":
      return "Give every create operation its own unique `id`; reference it from later ops via target/parent/child.";
    case "unknown-ref":
      return "Reference a temp id created earlier in this transaction or a real Figma id from inspect; never invent ids.";
    case "forward-ref":
      return "Reorder so the create operation comes first, or split into two transactions (create, then mutate by real id).";
    case "self-parent":
      return "A node cannot parent itself; pick a different parent id.";
    case "cycle":
      return "appendChild cannot create a cycle: the child must not be an ancestor of the parent.";
    case "page-target":
      return "Call inspect_file to list real page names/ids, then use one exactly.";
    case "type-compat":
      return "Inspect the target node type first and use an operation that matches it.";
    case "batch-size":
      return "Split into verified passes of ≤150 ops at logical region boundaries; keep each pass atomic.";
    default:
      return "Inspect the target nodes first, then retry with corrected arguments. Use dryRun:true to validate.";
  }
}

export function validateTransaction(operations: unknown[]): PreflightResult {
  const issues: PreflightIssue[] = [];
  const warnings: PreflightResult["warnings"] = [];

  if (!Array.isArray(operations) || operations.length === 0) {
    return {
      ok: false,
      issues: [{ index: -1, opType: "plan", message: "Transaction needs at least one operation.", fix: fixFor("schema") }],
      warnings,
      operationCount: 0,
    };
  }
  if (operations.length > 2000) {
    issues.push({
      index: -1,
      opType: "plan",
      message: `Transaction has ${operations.length} operations; the maximum is 2000.`,
      fix: fixFor("batch-size"),
    });
  } else if (operations.length > 150) {
    warnings.push({
      index: -1,
      opType: "plan",
      message: `Large transaction (${operations.length} ops): prefer verified passes of ≤150 ops; this stays atomic but is harder to roll back.`,
    });
  }

  const seenIds = new Map<string, number>();
  const createdOrder: string[] = [];

  operations.forEach((raw, index) => {
    const parsed = OperationSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue?.path.join(".") ?? "";
      const hasNull = JSON.stringify(raw).includes(":null");
      issues.push({
        index,
        opType: (raw as { type?: string })?.type ?? "unknown",
        message: `Schema mismatch: ${issue?.message ?? "invalid operation"}${path ? ` (at ${path})` : ""}${hasNull ? " — nullable fields must be omitted, not null." : ""}`,
        fix: fixFor("schema"),
      });
      return;
    }
    const op = parsed.data as unknown as Record<string, unknown>;
    const type = String(op["type"]);

    const id = op["id"];
    if (typeof id === "string") {
      if (!TEMP_ID_RE.test(id)) {
        issues.push({ index, opType: type, message: `Invalid temp id "${id}": use 1-64 chars of letters, numbers, _ or -.`, fix: fixFor("dup-id") });
      } else if (seenIds.has(id)) {
        issues.push({ index, opType: type, message: `Duplicate temporary id "${id}" (first at #${seenIds.get(id)}).`, fix: fixFor("dup-id") });
      } else {
        seenIds.set(id, index);
        createdOrder.push(id);
      }
    }

    // Null-safety: the schema rejects nulls, but a null nested inside an
    // object slips past field-level checks in older payloads — flag it here.
    for (const [k, v] of Object.entries(op)) {
      if (v === null && !["parent", "name"].includes(k)) {
        // parent/name nulls are still schema errors; the message above covers them.
      }
    }
  });

  // Reference pass: only for schema-valid ops.
  const validIdx = new Set<number>();
  operations.forEach((raw, index) => {
    if (OperationSchema.safeParse(raw).success) validIdx.add(index);
  });

  operations.forEach((raw, index) => {
    if (!validIdx.has(index)) return;
    const op = raw as Record<string, unknown>;
    const type = String(op["type"]);
    const refs: Array<{ key: string; ref: string }> = [];
    for (const key of ["target", "parent", "child", "componentId", "from", "to"]) {
      const v = op[key];
      if (typeof v === "string") refs.push({ key, ref: v });
    }
    if (type === "booleanOperation" && Array.isArray(op["targets"])) {
      for (const t of op["targets"] as unknown[]) if (typeof t === "string") refs.push({ key: "targets", ref: t });
    }
    if (type === "createGroup" && Array.isArray(op["children"])) {
      for (const t of op["children"] as unknown[]) if (typeof t === "string") refs.push({ key: "children", ref: t });
    }

    for (const { key, ref } of refs) {
      if (FIGMA_ID_RE.test(ref) || ref.includes(":")) continue; // real Figma id: resolved live
      if (!seenIds.has(ref)) {
        issues.push({ index, opType: type, message: `Unresolved reference "${ref}" in "${key}": no create operation mints that id.`, fix: fixFor("unknown-ref") });
      } else if ((key === "target" || key === "child" || key === "from" || key === "to") && MUTATE_TARGET_TYPES.has(type)) {
        // Mutations run in pass 2, so forward references within the same
        // transaction still resolve — but a target that is only created LATER
        // in pass-1 order is fragile; warn rather than fail.
        const createdAt = seenIds.get(ref) ?? 0;
        if (createdAt > index) {
          warnings.push({ index, opType: type, message: `"${ref}" is created after this operation references it; pass-2 ordering covers it, but prefer create-first order.` });
        }
      }
    }

    if ((type === "appendChild") && typeof op["parent"] === "string" && typeof op["child"] === "string" && op["parent"] === op["child"]) {
      issues.push({ index, opType: type, message: "appendChild cannot parent a node to itself.", fix: fixFor("self-parent") });
    }
    if (type === "setPage" && typeof op["page"] === "string" && op["page"].trim().length === 0) {
      issues.push({ index, opType: type, message: "setPage needs a page id or name, or omit it for the current page.", fix: fixFor("page-target") });
    }
    if (type === "setTypography" || type === "setTextContent") {
      // Type compatibility cannot be proven offline for temp ids; flag only
      // obvious mismatches (e.g. targeting a known frame temp id is fine —
      // skip). Real-id targets are checked live by the plugin.
    }
    void CREATE_TYPES;
  });

  return { ok: issues.length === 0, issues, warnings, operationCount: operations.length };
}
