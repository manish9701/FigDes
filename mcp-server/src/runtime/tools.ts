/**
 * Exposes the runtime and IR compiler as MCP tools.
 *
 * Deliberately not a `program` string. The model sends structured calls naming
 * built-in primitives; see `runtime/interpreter.ts` for why there is no eval
 * path anywhere in this system.
 */
import { z } from "zod";
import { executeRuntime, PRIMITIVE_NAMES, RUNTIME_PRIMITIVES } from "./interpreter";
import { compileIR } from "./compile";
import { DesignIRSchema } from "../../../shared/ir";
import { guardMutation, resolveExistingResources } from "../plan/gate";
import type { Session } from "../sessions";

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const RUNTIME_GUIDE = [
  "Declarative design program. This is JSON naming built-in primitives, NOT code.",
  "There is no eval path: nothing here is executed as JavaScript.",
  "",
  "Structure:",
  "  canvas   { name?, width?, height?, grid?, newPage?, fill?, deck? }",
  "           deck:true makes every region a 1920x1080 slide (Figma Slides). One program, one deck.",
  "  regions  [ { fn, id?, args } ]   top-level areas, in order (slides in deck mode)",
  "  content  [ { fn, id?, parent?, args } ]   anything inside a region",
  "  templates [ { name, parameters?, body: [content calls] } ]   reusable drawable patterns",
  "            Built in: page-header, field-row, action-row, section, empty-state, error-state.",
  "            A program template with the same name replaces the built-in silently.",
  "",
  "Visual intent - how the screen should be SEEN, not what it contains:",
  "  visualIntent { style?, composition?, density?: airy|calm|balanced|dense, focal?,",
  "                 visualWeight?: { region: 0-1 }, depth?, rhythm?, alignment?, contrast? }",
  "              density rescales the spacing system; visualWeight becomes growth;",
  "              the focal region absorbs slack first. Omit it freely: every field",
  "              has a neutral default and omission degrades to current behaviour.",
  "",
  "Reusable patterns:",
  "  define a template once in 'templates', then stamp it with",
  "  { fn: 'template', id?, parent?, args: { name, values? } }.",
  "  Bodies accept text, shape, vector, semantic components and connectors only;",
  "  no nested templates, regions, variables or styles. Use {{name}} placeholders.",
  "",
  "Region primitives:",
  "  navigation  a side or top rail. width: 240 gives a side rail; omit for a full-width band.",
  "  hero        the primary visual region. Set grow: 2 to make it absorb slack.",
  "  header      a band above the content.",
  "  inspector   a side detail panel.",
  "  frame       a generic region.",
  "",
  "Content primitives:",
  "  text         args: { text, role?, size?, weight?, fill?, maxWidth?, letterSpacing? }",
  "                role: eyebrow | title | subtitle | body | label | value | caption | code",
  "                letterSpacing spaces a wordmark out; tracked capitals are what make it a wordmark.",
  "  metric       args: { label, value, delta?, surface?, radius? }  expands to label+value+delta",
  "  statusPill   args: { label, surface?, color? }",
  "  deviceNode   args: { label, memory?, surface? }",
  "  navItem      args: { label, color?, surface? }",
  "  button       args: { label, surface?, color? }",
  "  panel        args: { title, surface?, radius? }",
  "  sectionHeader args: { title }",
  "  divider      args: { color? }",
  "  modelRow     args: { title }",
  "  shape        args: { shape: rect|ellipse|line|polygon|star, fill?, stroke?, radius? }",
  "                polygon/star take sides, innerRatio (star), rotation. Vertices are computed,",
  "                so a hexagon reads as a hexagon.",
  "  logoMark     args: { mark: ring|orbit|chevron|hex|bars|prism|wave|grid, size?, color?, surface?, strokeWeight? }",
  "                A deterministic geometric mark on a shared optical grid. Pair it with a text",
  "                wordmark (caps + letterSpacing) for a complete logo. Never hand-write mark geometry.",
  "  vector       args: { path, stroke?, strokeWeight? }   absolute M/L/H/V/C/Q/Z only",
  "  topologyMap  args: { title }",
  "  template     args: { name, values? }   stamps a user-defined template from 'templates'",
  "  connector    args: { from, to, routing?: straight|orthogonal|curved, label?, arrowEnd?, arrowStart?, curvature?, dashPattern? }",
  "              Connects two node ids. Geometry is solved from the placed boxes,",
  "              so the line lands on the nodes it names rather than at a guessed coordinate.",
  "  variable     args: { name, type?: color|number|string|boolean, color?|value?, values?, collection?, scopes? }",
  "              Creates a real Figma variable. values accepts { mode: value } for light/dark.",
  "              Prefer tokens over hex everywhere: write fill:'exo/surface' instead of a literal",
  "              and the compiler binds the node to the variable automatically. Run seed_exo_system",
  "              once per file so the canonical set exists before you reference it.",
  "  paintStyle   args: { name, color, opacity? }",
  "  textStyle    args: { name, size, weight?, family?, lineHeight?, letterSpacing?, fill? }",
  "",
  "Region args:",
  "  width/height  a number, 'fill' (share leftover space) or 'hug'",
  "  grow          0-10, weights how a 'fill' region absorbs slack",
  "  layout        flow (default) | grid | tree | cluster | masonry | timeline | radial | force | topology",
  "                tree/masonry/timeline/cluster compute the geometry for you. 'topology'",
  "                picks tree when links exist and cluster otherwise. Omitting layout picks",
  "                the algorithm from the region's composition.",
  "  columns       column count for grid and masonry",
  "",
  "Relations - relationships instead of coordinates:",
  "  relations  [ { id, rightOf?, below?, alignTo?, width?, height?, gap?, top?, left?, right?, bottom?, inset? } ]",
  "              rightOf: 'inspector', gap: 24, width: 320 places a panel beside another.",
  "              alignTo: start|center|end|stretch|top|middle|bottom|baseline",
  "              width/height: 'fill' spans to the parent edge. Applied after layout, in",
  "              dependency order, so chains resolve regardless of the order you write them.",
  "",
  "Links - topology edges for tree/force layouts and for connectors:",
  "  links      [ { from, to, label? } ]",
  "",
  "Example - a topology map with connectors, a cluster and a design token:",
  JSON.stringify(
    {
      canvas: { name: "EXO Topology", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "hero", id: "map", args: { width: "fill", height: "fill", composition: "topology", layout: "topology" } }],
      links: [
        { from: "hub", to: "n1", label: "8us" },
        { from: "hub", to: "n2" },
        { from: "n1", to: "n3" },
      ],
      content: [
        { fn: "variable", id: "tok-surface", args: { name: "surface", color: "#FFFDF9" } },
        { fn: "deviceNode", id: "hub", parent: "map", args: { label: "hub-01", memory: "1.8 TB" } },
        { fn: "deviceNode", id: "n1", parent: "map", args: { label: "node-01" } },
        { fn: "deviceNode", id: "n2", parent: "map", args: { label: "node-02" } },
        { fn: "deviceNode", id: "n3", parent: "map", args: { label: "node-03" } },
        { fn: "connector", id: "c1", parent: "map", args: { from: "hub", to: "n1", label: "8us" } },
        { fn: "connector", id: "c2", parent: "map", args: { from: "hub", to: "n2" } },
        { fn: "connector", id: "c3", parent: "map", args: { from: "n1", to: "n3" } },
      ],
    },
    null,
    2,
  ),
].join("\n");

export const RuntimeArgs = z
  .object({
    sessionId: z.string().max(200).optional(),
    program: z.unknown().describe("The declarative program. See the tool description for the schema."),
    /** Validate and return the compiled operations without touching Figma. */
    dryRun: z.boolean().optional().describe("Compile and report, but create nothing. Use this first."),
    description: z.string().max(1000).optional(),
    /** Records that a human approved a change this tool previously refused. */
    approved: z.boolean().optional(),
    reason: z.string().max(400).optional(),
    transactionId: z.string().max(200).optional(),
    /**
     * Split a large build into sequential per-chunk transactions instead of one
     * giant one (FigDes §30). Each chunk commits separately with its own
     * rollback, temp ids remap across chunks, and a failure stops the build
     * with per-chunk results instead of losing everything. The tradeoff is real
     * and stated: chunked builds take one undo per chunk, not one undo total.
     */
    chunked: z.boolean().optional().describe("Build in sequential chunked transactions. For large programs."),
  })
  .strict();

export const CompileArgs = z.object({ ir: DesignIRSchema, dryRun: z.boolean().optional() }).strict();

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

/** The primitive catalogue, so the model can discover what exists. */
export function runtimeCatalogue() {
  return PRIMITIVE_NAMES.map((name) => ({
    name,
    kind: RUNTIME_PRIMITIVES[name].kind,
    description: RUNTIME_PRIMITIVES[name].description,
  }));
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

export async function runRuntimeTool(session: Session | null, args: unknown): Promise<unknown> {
  const parsed = RuntimeArgs.parse(args);
  const { program, dryRun, description, transactionId, approved, reason, chunked } = parsed;

  const result = executeRuntime(program);

  // Surface anything that was dropped before it can be mistaken for success.
  if (result.warnings.length > 0) {
    console.log(`[runtime] ${result.warnings.length} warning(s): ${result.warnings.join("; ")}`);
  }

  const payload = {
    status: result.violations.length > 0 ? "completed-with-violations" : "completed",
    dryRun: dryRun ?? false,
    stats: result.stats,
    regions: result.ir.regions.map((r) => ({ id: r.id, role: r.role, width: r.width, height: r.height, grow: r.grow, layout: r.layout })),
    /**
     * Which algorithm each region actually used, and how many boxes a relation
     * moved.
     *
     * Returned because "I asked for a tree layout" is not the same claim as "a
     * tree layout ran". If the shell layout claimed the region, the model should
     * see that rather than assume the program was understood.
     */
    algorithms: result.algorithms,
    constrained: result.constrained,
    reflowed: result.reflowed,
    /** What the visual intent changed, so taste is visible rather than silent. */
    intentNotes: result.intentNotes,
    violations: result.violations,
    warnings: result.warnings,
    operations: result.operations,
  };

  // A dry run compiles and validates entirely inside the server, so it must not
  // require a live plugin connection. That makes it useful while designing a
  // screen with Figma closed.
  if (dryRun) return payload;

  if (!session) {
    throw new Error(
      "A live Figma plugin is required to build. Open the Design Agent plugin in Figma, or pass dryRun=true to compile without connecting.",
    );
  }

  // The same checkpoint gate as the low-level mutating tools, applied to the
  // compiled operations rather than to whatever the caller wrote. Going through
  // the runtime must not be a way around it.
  const existing = await resolveExistingResources(session, result.operations as Array<Record<string, unknown>>);
  const gate = guardMutation({
    operations: result.operations as Array<Record<string, unknown>>,
    approved,
    reason,
    dryRun: dryRun ?? false,
    ...(existing !== undefined ? { existing } : {}),
  });
  if (gate) return { ...payload, ...gate };

  if (chunked === true) {
    const built = await runChunked(session, result.operations, description);
    return {
      ...payload,
      chunked: true,
      status: built.completed ? payload.status : "completed-with-failed-chunks",
      chunks: built.chunks,
    };
  }

  const transaction = await session.request("create_design", {
    description: description ?? "Design runtime execution",
    operations: result.operations,
    transactionId,
  });

  return { ...payload, transaction };
}

/** Operations per chunk. Small enough to stay well under node caps, large enough to keep chunks few. */
const CHUNK_SIZE = 60;

/** Operation fields that can hold node references needing cross-chunk remap. */
const REF_KEYS = new Set(["parent", "target", "child"]);

/**
 * Builds a program chunk by chunk, remapping ids across chunk boundaries.
 *
 * Each chunk is its own transaction with its own rollback: a failure stops the
 * build and reports per-chunk results, so a 400-op deck does not lose 399 good
 * nodes to one bad operation. Temp ids are stable within a program run, which
 * makes retries idempotent in the only sense that matters here: re-running the
 * same program rebuilds the same structure rather than a different one.
 */
export async function runChunked(
  session: Session,
  operations: unknown[],
  description: string | undefined,
): Promise<{ chunks: Array<{ index: number; operations: number; status: string; createdNodes: unknown[]; error?: string }>; completed: boolean }> {
  const chunks: Array<{ index: number; operations: number; status: string; createdNodes: unknown[]; error?: string }> = [];
  const remap = new Map<string, string>();

  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && remap.has(value)) return remap.get(value)!;
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        out[key] = REF_KEYS.has(key) ? rewrite(entry) : entry;
      }
      return out;
    }
    return value;
  };

  for (let i = 0; i < operations.length; i += CHUNK_SIZE) {
    const slice = (operations.slice(i, i + CHUNK_SIZE) as Array<Record<string, unknown>>).map(
      (op) => rewrite(op) as Record<string, unknown>,
    );
    const result = (await session.request("create_design", {
      description: `${description ?? "Design runtime execution"} (chunk ${chunks.length + 1})`,
      operations: slice,
    })) as { status?: string; createdNodes?: Array<{ temporaryId?: string; figmaNodeId?: string }>; error?: { message?: string } };

    if (result.status === "success") {
      for (const created of result.createdNodes ?? []) {
        if (created.temporaryId && created.figmaNodeId) remap.set(created.temporaryId, created.figmaNodeId);
      }
      chunks.push({ index: chunks.length, operations: slice.length, status: "success", createdNodes: result.createdNodes ?? [] });
    } else {
      chunks.push({
        index: chunks.length,
        operations: slice.length,
        status: "failed",
        createdNodes: [],
        error: result.error?.message ?? "chunk failed",
      });
      return { chunks, completed: false };
    }
  }

  return { chunks, completed: true };
}

export function compileIrTool(args: unknown): unknown {
  const parsed = CompileArgs.parse(args);
  const compiled = compileIR(parsed.ir);

  return {
    status: compiled.violations.length > 0 ? "completed-with-violations" : "completed",
    dryRun: parsed.dryRun ?? true,
    stats: compiled.stats,
    regions: compiled.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h })),
    violations: compiled.violations,
    operations: compiled.operations,
  };
}

export { RUNTIME_GUIDE };