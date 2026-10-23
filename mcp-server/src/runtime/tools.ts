/**
 * Exposes the runtime and IR compiler as MCP tools.
 *
 * Deliberately not a `program` string. The model sends structured calls naming
 * built-in primitives; see `runtime/interpreter.ts` for why there is no eval
 * path anywhere in this system.
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { executeRuntime, PRIMITIVE_NAMES, RUNTIME_PRIMITIVES, type RuntimeResult } from "./interpreter";
import { PRIMITIVE_ARGUMENTS, PRIMITIVE_EXAMPLES } from "./primitive-schema";
import { compileIR } from "./compile";
import { measureProgramText } from "./measure";
import { placeRootFrame } from "./placement";
import { inferArtDirection, isAutoStyleEligible } from "./visual-presets";
import { DesignIRSchema, canvasSize } from "../../../shared/ir";
import type { PreflightResult } from "../../../shared/protocol";
import { guardMutation, resolveExistingResources } from "../plan/gate";
import { dispatchTransaction, type ScoreGuardEvidence } from "../transaction";
import { scoreDesign } from "../review/score";
import { preflightCheckTag, validateTransaction } from "../preflight";
import { effectiveRules, loadMemory, projectKey } from "../memory/store";
import { runGuard, snapshotFromIR } from "../memory/guard";
import { defaultRules } from "../memory/rules-exo";
import { assessIRIntelligence, assessRuntimeIntelligence } from "../design/intelligence-gate";
import { inferComposition } from "./layout";
import type { PreflightContext } from "../preflight-blocking";
import type { Session, SessionRegistry } from "../sessions";

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
  "  style presets (one name or a comma list of directives):",
  "    calm-technical     generous whitespace, quiet labels, tabular numerals",
  "    technical-editorial  report-like: headline carries the decision",
  "    quiet-instrument   dense, strict grid, values first and mono",
  "    high-contrast-ops  bold emphasis for state that must be seen",
  "    gallery-warm       airy, centered, warm showcase surfaces",
  "    editorial-bold     oversized type, one message, warm air",
  "    dense-admin        tight rows, strict grid, quiet chrome",
  "    soft-modern        quiet surfaces; hierarchy from type, not borders",
  "    shorthands: compact, airy, minimal, editorial, instrument, warm.",
  "    Omitting style is fine — a curated direction is inferred from the",
  "    composition shape and reported as artDirection in the result.",
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
  "  button       args: { label, variant?: primary|secondary|destructive|quiet|loading|disabled, states? }",
  "  panel        args: { title, surface?, radius? }",
  "  sectionHeader args: { title, action?, subtitle? }",
  "  divider      args: { color?, orientation?: horizontal|vertical, strokeWeight? }  vertical swaps the axes; the 1px rect is the horizontal hairline only",
  "  modelRow     args: { title }",
  "  shape        args: { shape: rect|ellipse|line|polygon|star, fill?, stroke?, radius? }  line is a horizontal rule (a vector with tight stroke-sized bounds, not a rectangle)",
  "                polygon/star take sides, innerRatio (star), rotation. Vertices are computed,",
  "                so a hexagon reads as a hexagon.",
  "  logoMark     args: { mark: ring|orbit|chevron|hex|bars|prism|wave|grid|shield|bolt|lens|arc, size?, color?, surface?, strokeWeight? }",
  "                A deterministic geometric mark on a shared optical grid. Pair it with a text",
  "                wordmark (caps + letterSpacing) for a complete logo. Never hand-write mark geometry.",
  "  logoGrid     args: { size?, divisions?, color? }   construction guides + bounding square (hairline, dashed)",
  "  logoLockup   args: { mark, wordmark, color?, size? }   mark plus tracked-out caps, optically aligned",
  "  vector       args: { path, stroke?, strokeWeight?, fill?, windingRule?, strokeCap?, strokeJoin?, dashPattern? }",
  "                absolute M/L/H/V/C/Q/S/T/A/Z (relative normalised); beziers preserved, arcs flattened",
  "  vectorPlan   args: { steps: [{op silhouette|path|cutout|mirror|translate|snap, ...}] }",
  "                silhouette{mark,cx,cy,r} path{path} cutout{path} mirror{axis,center} translate{dx,dy} snap{grid}",
  "                Composes operands; boolean subtraction itself runs in Figma via booleanGroup.",
  "  booleanGroup args: { operation: union|subtract|intersect|exclude, targets: [id, id, ...] }",
  "                Native Figma boolean of already-emitted siblings. First target is the base for subtract.",
  "  flowNode     args: { label|title, detail|body?, surface?, color? }",
  "  decisionDiamond args: { label|title, color?, surface? }",
  "  timelineEvent args: { date, title|label, body|detail? }",
  "  chartBar     args: { title|label, values: [n...], labels?: [...], accent?, caption? }",
  "  chartLine    args: { title|label, values: [n...], accent?, caption? }   ordered series scaffold",
  "  chartPie     args: { title|label, values: [n...] | shares: [{label,value}], labels?: [...], caption? }",
  "  callout      args: { text|body|label, detail? }   annotation: same, quieter surface",
  "  sectionDivider args: { title|label }   quoteBlock args: { quote|text|body, author|caption? }",
  "  imageFrame   args: { alt?, caption?, src? }   placeholder with crop + caption",
  "  slideMaster  args: { title|name, background?, footer? }   reusable 1920x1080 master as a component",
  "  deckOutline  args: { title?, acts: [s...] }   narrative arc rendered as an inspectable list",
  "  stat         args: { value|number, label?, color? }   bullets args: { title?, items: [s...] }",
  "  slide        a full-bleed slide region (deck mode: one region, one slide, varied compositions)",
  "  stage        the focal artifact inside a slide   column: one column of a multi-column composition",
  "  topologyMap  args: { title, nodes?: [{ id, label?, memory?, health?, compute?, shard?, status?: selected|healthy|degraded|offline|pressured|warning }],",
  "                edges?: [{ from, to, latency?, bandwidth?, label?, meaning?, weight?: critical|major|minor }], selectedId? }",
  "              Nodes say what they are (status draws the state stroke; pressured draws amber).",
  "              Edges say why they exist (meaning joins the label) and how much they matter",
  "              (critical draws 3px, major 2px, minor 1px dashed). Unlabeled edges warn: an",
  "              unexplained line is decoration. Edge labels join the layout links, so the",
  "              graph arranges around what is actually connected.",
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
  "  gridColumns/gridGutter  e.g. { gridColumns: 12, gridGutter: 24 } puts a hidden",
  "                12-column alignment grid on the region frame (report SetGrid)",
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

/**
 * The primitive catalogue, so the model can discover what exists.
 *
 * Names and descriptions were not enough: hard stress test #10 found a model
 * guessing `vectorPlan`, `logoGrid` and `logoLockup` arguments and having each
 * guess rejected with no way to discover the right one. The accepted argument
 * schemas, their types and a worked example now travel with the name, so
 * discovery *is* the schema rather than a pointer to one.
 */
export function runtimeCatalogue() {
  return PRIMITIVE_NAMES.map((name) => {
    const spec = RUNTIME_PRIMITIVES[name];
    const args = PRIMITIVE_ARGUMENTS[name] ?? [];
    const example = PRIMITIVE_EXAMPLES[name];
    return {
      name,
      kind: spec.kind,
      description: spec.description,
      args: args.map((a) => ({
        name: a.name,
        type: a.type,
        description: a.description,
        ...(a.values !== undefined && a.values.length > 0 ? { values: [...a.values] } : {}),
        ...(a.example !== undefined ? { example: a.example } : {}),
      })),
      ...(example ? { example } : {}),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Auto art direction (general-use quality lift).
 *
 * Most models omit `visualIntent`, and an unstated taste defaults to the
 * flattest possible output. Rather than leaving quality to per-call
 * improvisation, the tool boundary infers a curated style preset from the
 * program's composition shape and applies it when (and only when) the program
 * states no style of its own.
 *
 * Safety contract, by construction:
 * - only geometry-neutral presets are eligible (balanced density → grid
 *   unchanged; neutral warmth → white root fill unchanged; relaxed align →
 *   default snapping unchanged), so layout math is bit-identical;
 * - a program with a `plan` is skipped (the planner already art-directs);
 * - an explicit `visualIntent.style` always wins;
 * - the choice is deterministic, so the same program rebuilds identically.
 */
export function applyAutoArtDirection(program: unknown): { program: unknown; direction: ReturnType<typeof inferArtDirection> } {
  if (program === null || typeof program !== "object" || Array.isArray(program)) {
    return { program, direction: null };
  }
  const p = program as Record<string, unknown>;
  // A plan already carries the planner's art direction; never double-direct.
  if (p["plan"] !== undefined) return { program, direction: null };
  const intent = p["visualIntent"];
  if (intent !== null && typeof intent === "object" && !Array.isArray(intent)) {
    const declared = intent as Record<string, unknown>;
    if (typeof declared["style"] === "string" && declared["style"].length > 0) {
      return { program, direction: null };
    }
  }
  const regions = Array.isArray(p["regions"]) ? (p["regions"] as Array<Record<string, unknown>>) : [];
  const canvas = (p["canvas"] ?? {}) as Record<string, unknown>;
  const direction = inferArtDirection({
    deck: canvas["deck"] === true,
    regionFns: regions.map((r) => String(r["fn"] ?? "")),
    regionCount: regions.length,
  });
  if (!direction || !isAutoStyleEligible(direction.style)) {
    return { program, direction: null };
  }
  const base = intent !== null && typeof intent === "object" && !Array.isArray(intent) ? (intent as Record<string, unknown>) : {};
  return {
    program: { ...p, visualIntent: { ...base, style: direction.style } },
    direction,
  };
}

/** Detects repeated identical-size frames so the payload can advise component reuse. */
export function reuseAdvisory(operations: Array<Record<string, unknown>>): Array<string> {
  const frames = operations.filter(
    (o) => (o.type === "createFrame" || o.type === "createRectangle") && typeof o.id === "string",
  );
  const groups = new Map<string, number>();
  for (const f of frames) {
    const key = `${Math.round(Number(f.width ?? 0) / 4)}x${Math.round(Number(f.height ?? 0) / 4)}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const advisories: Array<string> = [];
  for (const [key, count] of groups) {
    if (count >= 3) {
      advisories.push(
        `${count} identical ${key.replace("x", "x")} surfaces: this is a component, not ${count} rectangles. ` +
          `Call find_component first (try role words like "button", "badge", "input", "nav" — aliases are expanded automatically); ` +
          `if a match exists, place it with create_instance (pass the TEXT label via properties, variant via setVariant) instead of rebuilding it. ` +
          `Only when nothing matches should you draw it once and promote it with create_component so the next screen can instance it.`,
      );
      break;
    }
  }
  return advisories;
}

/**
 * Assembles the PreflightContext the runtime build path dispatches with.
 *
 * Issue #23: the blocking preflight classes only run when the context carries
 * the evidence they need, and this path used to thread only the geometry trio
 * (planBoxes / overflow / sizing) — so `checkTextOverflow` silently no-oped
 * with no `textMeasurements` and `checkConnectors` no-oped with no
 * `connectors`, even though both pieces of evidence were already in hand:
 * the measured text metrics from `measureProgramText` and the routed
 * connectors on the compile result. Both are threaded here.
 *
 * Two fields have no source on this path and are deliberately omitted:
 * `geometryReasons` (nothing on the runtime path validates a deliberate
 * geometry difference — the compile's trace check must pass cleanly) and
 * `briefBlockers` (a `design_runtime` call carries no brief; a product-guard
 * failure already refuses the plan upstream through `applicable: false`).
 *
 * Regions that declare `overflow: "allow"` get the declaration itself recorded
 * as their reason: the compiler treats the declaration as an advisory finding,
 * so the dispatch gate would otherwise fail closed on a permission the program
 * explicitly stated — with a string naming the declaration, the preflight's
 * "allowed AND justified" path matches what the compile already decided.
 */
export function runtimePreflightContext(
  compiled: RuntimeResult,
  measuredMetrics?: Map<string, { width: number; height: number }>,
): PreflightContext {
  const overflowReasons: Record<string, string> = {};
  for (const r of compiled.ir.regions) {
    if (r.overflow === "allow") {
      overflowReasons[r.id] = `the program declared overflow:"allow" on region '${r.id}' — the overflow is deliberate and was reported, not hidden`;
    }
  }
  return {
    planBoxes: Object.fromEntries([...compiled.boxes].map(([id, box]) => [id, box])),
    overflow: Object.fromEntries(compiled.ir.regions.map((r) => [r.id, (r.overflow ?? "forbid") as "allow" | "clip" | "forbid"])),
    sizing: Object.fromEntries(
      compiled.ir.regions.map((r) => [r.id, { width: r.width as number | "fill" | "hug", height: r.height as number | "fill" | "hug" }]),
    ),
    ...(measuredMetrics !== undefined && measuredMetrics.size > 0 ? { textMeasurements: Object.fromEntries(measuredMetrics) } : {}),
    ...(compiled.connectorRoutes !== undefined && compiled.connectorRoutes.length > 0 ? { connectors: compiled.connectorRoutes } : {}),
    ...(Object.keys(overflowReasons).length > 0 ? { overflowReasons } : {}),
  };
}

export async function runRuntimeTool(
  session: Session | null,
  args: unknown,
  registry?: SessionRegistry,
): Promise<unknown> {
  const parsed = RuntimeArgs.parse(args);
  const { dryRun, description, transactionId, approved, reason, chunked } = parsed;

  const { program, direction } = applyAutoArtDirection(parsed.program);

  // Issue #24 — the intelligence gate. A program that carries no plan_screen
  // plan and declares no visualIntent.style bypasses decision classification,
  // composition hints and the guard preview. That bypass used to be silent;
  // now it is a first-class verdict on the payload (`intelligence.applied`)
  // with a warning naming the fix. The build still proceeds on the auto
  // art-direction fallback — disclosure, not a block.
  const intelligence = assessRuntimeIntelligence(parsed.program, {
    ...(direction !== null ? { autoStyle: direction.style } : {}),
  });

  // Measure the text before the layout is computed, so the screen is laid out
  // from the heights the renderer will really produce. The first compile
  // resolves the widths; the plugin measures at those widths; the second
  // compile uses the measurements. Without a plugin the estimates stand, and
  // the result says so.
  //
  // The second pass is also what unlocks native auto-layout for text: the
  // compiler only hands a text-holding region to Figma's own layout when every
  // text child carries a measurement (see compile.ts), so a measured recompile
  // that declines no container stands on the truth, not on the heuristic.
  // Checklist #14: a build is guarded against the merged rule set — built-in
  // EXO truths plus every rule recorded for this project via project_memory —
  // so a recorded rule is enforced during generation, not only at final review.
  const { memory: projectMemory } = loadMemory(projectKey(session?.fileKey ?? undefined, session?.fileName ?? undefined));
  const rules = effectiveRules(projectMemory);
  const firstPass = executeRuntime(program, { rules });
  let compiled = firstPass;
  let measuredCount = 0;
  // Hoisted so the dispatch-time preflight context can carry the measurements
  // even when the second pass did not run: no measurements means the check has
  // no evidence, which is different from measurements that say "fits".
  let measuredMetrics: Map<string, { width: number; height: number }> = new Map();
  if (session !== null) {
    const widths = new Map<string, number>();
    for (const [id, box] of firstPass.boxes) widths.set(id, box.w);
    // Issue #25 RC1: the first pass's operations are handed to the measurement
    // so text emitted by primitives (deviceNode labels, statusPills, connector
    // labels, metrics) is measured too — not just direct `fn:"text"` calls.
    const measured = await measureProgramText(session, program, widths, firstPass.operations as unknown[]);
    if (measured.metrics.size > 0) {
      measuredCount = measured.metrics.size;
      measuredMetrics = measured.metrics;
      compiled = executeRuntime(program, { textMetrics: measured.metrics, rules });
    }
  }

  // Surface anything that was dropped before it can be mistaken for success.
  if (compiled.warnings.length > 0) {
    console.log(`[runtime] ${compiled.warnings.length} warning(s): ${compiled.warnings.join("; ")}`);
  }

  const advisories = reuseAdvisory(compiled.operations as Array<Record<string, unknown>>);
  /**
   * What the applicability verdict stands on.
   *
   * When the plugin could not be asked (or answered empty) but the screen
   * carries text, the layout stands on character-count estimates — the SAME
   * program can compile to different geometry once real text heights arrive,
   * which is exactly how a dry run said "applicable" and the apply that
   * followed refused the same program for a spill the estimates could not see
   * (measured live on the issue-22 loop). Name the basis so a dry run never
   * reads as a guarantee it does not have.
   *
   * Issue #25: the requirement is counted from the FINAL compiled operations
   * (`createText` ops — including every primitive-emitted label), and the
   * basis says "measured" only when EVERY required text node was measured.
   * Previously one measured node out of N flipped the whole verdict to
   * "measured", and a component-only program (no raw text calls) was reported
   * "none-needed" while its labels laid out on estimates.
   */
  const requiredText = (compiled.operations as Array<Record<string, unknown>>).filter((op) => op["type"] === "createText").length;
  const measuredText = measuredCount;
  const applicabilityBasis = requiredText === 0 ? "none-needed" : measuredText >= requiredText ? "measured" : "estimates";
  const textUnmeasured = applicabilityBasis === "estimates";
  /**
   * Issue #25: the runtime's own composition verdict over the resolved
   * regions — computed once here and reused by the dispatch-edge scoring, so
   * the payload and the score can never disagree about what was built.
   */
  const appliedComposition = inferComposition(compiled.ir.regions);
  // Issue #26 — blocking-mode marking. A program with no plan and no declared
  // style still builds (raw exploration must work), but the payload says so:
  // intelligence.applied:false plus a first-pass-ineligible flag, top-level
  // and inside stats where metrics consumption reads it.
  const firstPassIneligible = !intelligence.applied;
  const payload = {
    // A plan whose geometry is not what was asked for is not "completed", and
    // it is emphatically not "applied". Three distinct states, because issue #11
    // found geometry landing off-canvas while the tool reported success.
    status: !compiled.applicable ? "not-applicable" : compiled.violations.length > 0 ? "completed-with-violations" : "completed",
    applicable: compiled.applicable,
    applicabilityBasis,
    ...(textUnmeasured
      ? {
          applicabilityWarning:
            `Layout resolved from text ESTIMATES: only ${measuredText} of ${requiredText} text nodes were measured ` +
            `(the measure_text round trip answered empty or failed, or the plugin was not connected). The apply path measures ` +
            `against the live plugin and may resolve different geometry — re-run with a responsive plugin before trusting ` +
            `this verdict, and expect the refusal reasons to change.`,
        }
      : {}),
    ...(compiled.applicable ? {} : { inapplicableReasons: compiled.inapplicableReasons }),
    dryRun: dryRun ?? false,
    stats: {
      ...compiled.stats,
      firstPassIneligible,
      /** Issue #25: how many text nodes the screen requires, from the compiled ops. */
      requiredTextNodes: requiredText,
      /** Issue #25: how many of those the plugin actually measured. */
      measuredTextNodes: measuredText,
    },
    regions: compiled.ir.regions.map((r) => ({ id: r.id, role: r.role, width: r.width, height: r.height, grow: r.grow, layout: r.layout })),
    /**
     * Which algorithm each region actually used, and how many boxes a relation
     * moved.
     *
     * Returned because "I asked for a tree layout" is not the same claim as "a
     * tree layout ran". If the shell layout claimed the region, the model should
     * see that rather than assume the program was understood.
     */
    algorithms: compiled.algorithms,
    constrained: compiled.constrained,
    reflowed: compiled.reflowed,
    /** What the visual intent changed, so taste is visible rather than silent. */
    intentNotes: compiled.intentNotes,
    /**
     * How many text nodes were measured by the plugin.
     *
     * The screen is laid out from the heights the renderer will really
     * produce, rather than from a character-count estimate. Zero means the
     * plugin could not be asked, and the layout used the estimate.
     */
    textMeasurements: measuredCount,
    /**
     * Issue #25 — the runtime's applied composition, exposed.
     *
     * This is what `inferComposition` resolves over the compiled regions — the
     * composition the runtime actually built, which may differ from what a
     * hint or a plan requested. Reported next to the hint receipt so
     * requested vs selected vs applied can be compared downstream.
     */
    appliedComposition,
    /**
     * Issue #25 — the measurement receipt, fail-closed.
     *
     * `verdict: "BLOCKED"` marks a build whose required text was not measured:
     * the geometry stands on estimates, so downstream acceptance must not read
     * this run as a verified pass. `applicable`/`status` keep their
     * geometry-only semantics — this marker is additive and lives beside them.
     */
    measurement: {
      required: requiredText,
      measured: measuredText,
      verdict: textUnmeasured ? ("BLOCKED" as const) : ("ok" as const),
    },
    ...(textUnmeasured
      ? {
          acceptance: "BLOCKED" as const,
          acceptanceReasons: [
            `text measurement unavailable: ${measuredText} of ${requiredText} text nodes measured (applicabilityBasis: "estimates") — the geometry stands on estimates, so acceptance is BLOCKED until the plugin measures the text.`,
          ],
        }
      : {}),
    /** The curated art direction applied when the program stated none. */
    ...(direction !== null ? { artDirection: direction } : {}),
    /** Component-reuse advisories measured from the compiled operations. */
    ...(advisories.length > 0 ? { reuse: advisories } : {}),
    violations: compiled.violations,
    warnings: [
      ...compiled.warnings,
      ...intelligence.warnings,
      // Issue #25: the fail-closed marker is also a warning, so a consumer
      // that reads only the warnings array still sees the block.
      ...(textUnmeasured
        ? [`text measurement unavailable: ${measuredText} of ${requiredText} text nodes measured; acceptance is BLOCKED (layout stands on estimates).`]
        : []),
    ],
    /**
     * Whether this build ran under design intelligence (issue #24).
     *
     * `applied: true` means the program carried a plan_screen plan or a
     * declared visualIntent.style. `false` means it ran on the auto
     * art-direction fallback (or none) — disclosed here and in `warnings`,
     * with the fix named. `applicabilityBasis` below says what the geometry
     * stands on; this says what the decisions stand on. A `false` here also
     * marks the build first-pass-ineligible (issue #26): raw exploration
     * still builds, but it never counts as a disciplined first pass.
     */
    intelligence,
    /** Issue #26: false exactly when the build ran without design intelligence. */
    firstPassIneligible,
    /**
     * What the product guard concluded about this build.
     *
     * Without it the gate is invisible on the way past: a build can come back
     * `applicable: true` having been checked against thirteen truths and found
     * two of them unevaluable, and the caller has no way to tell that from a
     * build that was fully checked. `verdict` here is INDETERMINATE whenever
     * anything was left to a human judgement, never PASS.
     */
    productGuard: compiled.productGuard,
    operations: compiled.operations,
  };

  // A dry run compiles and validates entirely inside the server, so it must not
  // require a live plugin connection. That makes it useful while designing a
  // screen with Figma closed.
  if (dryRun) return payload;

  // A non-applicable plan is refused before it reaches Figma. Building it would
  // draw regions outside the canvas and connectors to nowhere while reporting
  // success — the exact failure issue #11 opened with. The operations are in the
  // dry-run payload above, so the plan stays inspectable and repairable.
  if (!compiled.applicable) {
    return {
      ...payload,
      howToProceed:
        `This plan was not built: the resolved geometry is not what the program asked for (${compiled.inapplicableReasons.length} problem(s)). Fix the causes below, or re-run with dryRun:true to inspect the operations without committing.`,
      problems: compiled.inapplicableReasons,
    };
  }

  if (!session) {
    throw new Error(
      "A live Figma plugin is required to build. Open the Design Agent plugin in Figma, or pass dryRun=true to compile without connecting.",
    );
  }

  // Auto-placement: the compiler puts every root frame at the origin, so
  // consecutive screens pile onto the same spot. Before committing, ask the
  // file where free canvas is and shift the root there. Only the compiler's
  // own root (id "root" at 0,0) moves — explicit coordinates stay explicit.
  // A failed lookup never fails the build; it just builds at the origin.
  const placement = await placeRootInFreeCanvas(session, compiled.operations as Array<Record<string, unknown>>, {
    width: canvasSize(compiled.ir.canvas.width, 1440),
    height: canvasSize(compiled.ir.canvas.height, 900),
  });

  // The same checkpoint gate as the low-level mutating tools, applied to the
  // compiled operations rather than to whatever the caller wrote. Going through
  // the runtime must not be a way around it.
  const existing = await resolveExistingResources(session, compiled.operations as Array<Record<string, unknown>>);
  const gate = guardMutation({
    operations: compiled.operations as Array<Record<string, unknown>>,
    approved,
    reason,
    dryRun: dryRun ?? false,
    ...(existing !== undefined ? { existing } : {}),
  });
  if (gate) return { ...payload, ...gate };

  // Issue #23: the program's deterministic evidence (resolved geometry,
  // per-region overflow, sizing intents) is assembled ONCE, above the chunk
  // branch, and threaded to both dispatch paths — the chunked one, which runs
  // the blocking preflight over the WHOLE list before its first chunk, and the
  // single-transaction dispatcher, which runs it at the transaction edge.
  const preflightContext = runtimePreflightContext(compiled, measuredMetrics);

  // Issue #26: score/guard evidence for the dispatch edge, collected via the
  // score_design (scoreDesign) and design_guard (productGuard, already run by
  // the interpreter at build time) internals — never a new tool. Plain
  // dimension-name weak spots are advisory and never block; a FAIL verdict
  // (or explicitly critical spots) refuses the apply at the transaction edge
  // unless this call waives it with approved:true plus a reason.
  const scoreEvidence = scoreDesign({
    boxes: compiled.boxes,
    operations: compiled.operations as never,
    regions: compiled.ir.regions.map((r) => ({ id: r.id, role: r.role })),
    composition: appliedComposition,
    canvasW: canvasSize(compiled.ir.canvas.width, 1440),
    canvasH: canvasSize(compiled.ir.canvas.height, 900),
    ...(compiled.ir.visualIntent?.focal !== undefined ? { focal: compiled.ir.visualIntent.focal } : {}),
  });
  const dispatchScoreGuard: ScoreGuardEvidence = {
    scoreWeakSpots: scoreEvidence.weakSpots,
    ...(compiled.productGuard !== undefined ? { guardVerdict: compiled.productGuard.verdict } : {}),
    ...(approved !== undefined ? { approved } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  if (chunked === true || (chunked !== false && compiled.operations.length > CHUNK_SIZE * 2)) {
    // Auto-chunk large programs: a single 300-op transaction holds the socket
    // silent for a minute+ and risks losing everything to one bad op. Chunked
    // builds commit progressively (visible in the canvas as they land) with
    // per-chunk rollback. Explicit chunked:false still forces one transaction.
    // Issue #14 parity: each chunk now dispatches through the tracked
    // transaction dispatcher under its own stable per-chunk transactionId.
    // Issue #26: a chunked build without a registry has no ledger to hold the
    // chunks, so it is refused before anything is sent rather than dispatched
    // blind. Re-invoke with a registry, or compile with dryRun:true.
    if (!registry) {
      return {
        ...payload,
        ...(placement !== null ? { placement } : {}),
        status: "refused",
        refusedBy: "ledger",
        howToProceed:
          "Refused: chunked design_runtime builds dispatch each chunk through the tracked transaction dispatcher (job ledger with same-id idempotency). No registry was threaded, so nothing was sent. Re-invoke with a connected registry/session to build, or use dryRun:true to compile without one.",
        chunks: [],
        completed: false,
      };
    }
    const built = await runChunked(session, registry, compiled.operations, description, preflightContext, dispatchScoreGuard);
    // A blocking preflight verdict comes back as a structured refusal: nothing
    // built, no chunk sent, plan inspectable for repair.
    if (built.refusal !== undefined) {
      return { ...payload, ...built.refusal, ...(placement !== null ? { placement } : {}) };
    }
    return {
      ...payload,
      ...(placement !== null ? { placement } : {}),
      chunked: true,
      autoChunked: chunked !== true,
      status: built.completed ? payload.status : "completed-with-failed-chunks",
      chunks: built.chunks,
    };
  }

  // Issue #26: every mutating dispatch goes through the tracked dispatcher
  // with a registry, so the same-id idempotency and the ledger hold apply.
  // Without a registry there is no ledger to reconcile a retry against, so
  // the build is refused before anything is sent rather than dispatched
  // blind. Re-invoke with a connected registry/session, or dryRun to compile.
  if (!registry) {
    return {
      ...payload,
      ...(placement !== null ? { placement } : {}),
      status: "refused",
      refusedBy: "ledger",
      howToProceed:
        "Refused: design_runtime builds dispatch through the tracked transaction dispatcher (job ledger with same-id idempotency). No registry was threaded, so nothing was sent. Re-invoke with a connected registry/session to build, or use dryRun:true to compile without one.",
      problems: [],
    };
  }

  session.notify({ type: "notify", kind: "activity", text: `Building ${compiled.operations.length} ops…`, at: Date.now() });
  // The same tracked dispatcher the low-level tools use, so a retried runtime
  // build returns the prior result instead of drawing the screen twice, and a
  // timed-out one leaves a ledger record to reconcile against. Going straight
  // to the socket — which is what this did — meant neither was true.
  //
  // Issue #23: the dispatch carries the program's deterministic evidence
  // (resolved geometry, per-region overflow, sizing intents) so the blocking
  // preflight classes run with real data instead of silently skipping.
  //
  // Issue #26: the dispatch also carries the score/guard evidence collected
  // above, so a FAIL verdict (or critical weak spots) refuses the apply at
  // the transaction edge unless waived with approved:true plus a reason.
  const transaction = await dispatchTransaction(registry, session, "create_design", {
    description: description ?? "Design runtime execution",
    operations: compiled.operations,
    ...(transactionId !== undefined ? { transactionId } : {}),
    preflight: preflightContext,
    scoreGuard: dispatchScoreGuard,
  });

  return { ...payload, ...(placement !== null ? { placement } : {}), transaction };
}

/**
 * Moves the compiled root frame into free canvas.
 *
 * The compiler puts every root frame at the origin, so consecutive screens
 * pile onto the same spot. Before committing, the file is asked where there is
 * room and the root is shifted there.
 *
 * The subtlety is the coordinates: region frames, connectors and their labels
 * are emitted in page-absolute coordinates parented to the root, which is
 * correct only while the root sits at the origin. Moving the root without
 * converting them would offset everything twice, so root-parented ops become
 * root-relative here. Region-parented content already is.
 *
 * A failed lookup never fails the build; it just builds at the origin.
 */
export async function placeRootInFreeCanvas(
  session: Session,
  operations: Array<Record<string, unknown>>,
  canvas: { width: number; height: number },
): Promise<{ x: number; y: number; reason: string } | null> {
  const rootOp = operations.find(
    (op) => typeof op === "object" && op !== null && op.type === "createFrame" && op.id === "root",
  ) as Record<string, unknown> | undefined;
  if (rootOp === undefined) return null;
  // The compiler emits the root frame with no coordinates at all, so "at the
  // origin" is the *absence* of x/y rather than a zero. Checking for a literal
  // zero here meant the placement never ran: every screen landed at (0,0) and
  // piled on top of the previous one. The live evidence is what found it.
  const rootX = typeof rootOp.x === "number" ? rootOp.x : 0;
  const rootY = typeof rootOp.y === "number" ? rootOp.y : 0;
  if (rootX !== 0 || rootY !== 0) return null;

  let placed: { x: number; y: number; reason: string };
  try {
    const file = (await session.request("inspect_file", {})) as {
      topLevelFrames?: Array<{ x?: unknown; y?: unknown; width?: unknown; height?: unknown }>;
    };
    const existing = (file.topLevelFrames ?? [])
      .filter(
        (f): f is { x: number; y: number; width: number; height: number } =>
          typeof f.x === "number" && typeof f.y === "number" && typeof f.width === "number" && typeof f.height === "number",
      )
      .map((f) => ({ x: f.x, y: f.y, w: f.width, h: f.height }));
    placed = placeRootFrame(existing, canvasSize(canvas.width, 1440), canvasSize(canvas.height, 900));
  } catch {
    return { x: 0, y: 0, reason: "File listing failed; building at the origin." };
  }

  const dx = placed.x;
  const dy = placed.y;
  /**
   * Children are NOT touched.
   *
   * This loop used to subtract dx/dy from every op parented to "root" —
   * correct only while the compiler emitted page-absolute child coordinates.
   * Since issue #18's B08 the compiler emits parent-local ops (its documented
   * contract, enforced by the blocking operation-trace check), so subtracting
   * the frame's new page position pushed every region 10153px above its own
   * frame: fresh live builds rendered as blank canvas surfaces with the
   * content parked off-screen above — and only the review's low-confidence
   * overflow finding to show for it. Under the parent-local contract the
   * frame's children follow the frame; placement moves the root op alone.
   */
  rootOp.x = placed.x;
  rootOp.y = placed.y;
  void dx;
  void dy;
  return placed;
}

/** Operations per chunk. Small enough to stay well under node caps, large enough to keep chunks few. */
export const CHUNK_SIZE = 60;

/** Operation fields that can hold node references needing cross-chunk remap. */
const REF_KEYS = new Set(["parent", "target", "child"]);

/** The slice of the create_design result a chunk's bookkeeping needs. */
interface ChunkResult {
  status?: string;
  createdNodes?: Array<{ temporaryId?: string; figmaNodeId?: string }>;
  error?: { message?: string };
}

/**
 * The structured refusal a blocking preflight verdict becomes: a returned
 * result rather than an error, mirroring the not-applicable path — nothing was
 * created, and the problems say why (issue #23).
 */
export interface PreflightRefusal {
  status: "refused";
  /** The blocking check that spoke first, so the ledger/readout names it. */
  refusedBy: string;
  howToProceed: string;
  problems: string[];
}

function preflightRefusal(verdict: PreflightResult): PreflightRefusal {
  const first = verdict.issues[0]!;
  const tag = preflightCheckTag(first);
  return {
    status: "refused",
    refusedBy: tag,
    howToProceed:
      `Preflight rejected the plan before anything was built (${verdict.issues.length} issue(s), first check: ${tag}). ` +
      `Fix the problems and rebuild — the refusal holds for chunked and single-transaction builds alike.`,
    problems: verdict.issues.map((i) => `#${i.index} (${i.opType}): ${i.message} Fix: ${i.fix}`),
  };
}

/** A chunk result: per-chunk status, or the whole-list refusal built nothing. */
export type ChunkedBuild = {
  chunks: Array<{ index: number; operations: number; status: string; createdNodes: unknown[]; error?: string }>;
  completed: boolean;
  /** Present exactly when the blocking preflight refused the whole list; chunks stays empty. */
  refusal?: PreflightRefusal;
};

/**
 * Builds a program chunk by chunk, remapping ids across chunk boundaries.
 *
 * Each chunk is its own transaction with its own rollback: a failure stops the
 * build and reports per-chunk results, so a 400-op deck does not lose 399 good
 * nodes to one bad operation. Temp ids are stable within a program run, which
 * makes retries idempotent in the only sense that matters here: re-running the
 * same program rebuilds the same structure rather than a different one.
 *
 * Issue #23 — before the first chunk is sent, the blocking preflight runs over
 * the WHOLE compiled list with the caller's `preflight` evidence. Cross-chunk
 * duplicate ids and multi-parent assignments only exist once the lists are
 * read together, and refusing after three chunks committed is a partial
 * rollback by another name. This is the one program-level pass; the
 * per-chunk validation re-checks chunk-local structure only (see below), so a
 * refusal surfaces as `{refusal}` with zero dispatches rather than a rollback.
 *
 * Issue #14 parity — chunks dispatch through the tracked transaction
 * dispatcher, not the bare socket, so each chunk lands in the ledger.
 * The per-chunk transactionId is derived from a fingerprint of the whole
 * compiled list plus the chunk's slice number (`txn_<fp>_c2of4`): the same
 * program retried mints the same ids (so a settled chunk returns its prior
 * result instead of re-creating it), and a different program hashes
 * differently, so it can never inherit another build's chunks.
 *
 * The per-chunk preflight carries only the evidence a chunk can re-check
 * offline: brief blockers. The plan-geometry classes are page-absolute while a
 * chunk slice replays parent-locally, so handing them per chunk would refuse
 * valid chunks for drift they did not commit — those classes, and every
 * cross-chunk structural fact, were validated ONCE over the whole list above.
 */
export async function runChunked(
  session: Session,
  registry: SessionRegistry | null,
  operations: unknown[],
  description: string | undefined,
  preflight?: PreflightContext,
  scoreGuard?: ScoreGuardEvidence,
): Promise<ChunkedBuild> {
  const chunks: ChunkedBuild["chunks"] = [];

  // Issue #26: chunks dispatch through the tracked dispatcher, so a null
  // registry means no ledger to hold them. Refuse before anything is sent
  // rather than dispatching blind; the whole-list preflight below still runs
  // so the refusal names the geometric obstacle when there is one.
  if (!registry) {
    return {
      chunks,
      completed: false,
      refusal: {
        status: "refused",
        refusedBy: "ledger",
        howToProceed:
          "Refused: chunked builds dispatch each chunk through the tracked transaction dispatcher (job ledger with same-id idempotency). No registry was threaded, so nothing was sent. Re-invoke with a connected registry/session, or compile with dryRun:true.",
        problems: [],
      },
    };
  }

  const wholeList = validateTransaction(operations, preflight);
  if (!wholeList.ok) {
    return { chunks, completed: false, refusal: preflightRefusal(wholeList) };
  }

  const remap = new Map<string, string>();
  const runFingerprint = createHash("sha256").update(JSON.stringify(operations)).digest("hex").slice(0, 8);
  const chunkPreflight: PreflightContext = { briefBlockers: preflight?.briefBlockers };

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
    const chunkNo = chunks.length + 1;
    const chunkTotal = Math.ceil(operations.length / CHUNK_SIZE);
    const transactionId = `txn_${runFingerprint}_c${chunkNo}of${chunkTotal}`;
    session.notify({ type: "notify", kind: "activity", text: `Building chunk ${chunkNo}/${chunkTotal} (${slice.length} ops)…`, at: Date.now() });

    let result: ChunkResult;
    try {
      // Issue #26: the per-chunk dispatch carries the same score/guard
      // evidence as the single-transaction path, so a FAIL verdict (or
      // critical weak spots) refuses every chunk, not just the first.
      result = await dispatchTransaction(registry, session, "create_design", {
        description: `${description ?? "Design runtime execution"} (chunk ${chunkNo})`,
        operations: slice,
        transactionId,
        preflight: chunkPreflight,
        ...(scoreGuard !== undefined ? { scoreGuard } : {}),
      });
    } catch (err) {
      // The dispatcher refuses failed chunks by throwing; the chunked contract
      // records them instead. The build stops, the failing chunk carries the
      // message (a Figma rejection names its document state; a client-side
      // refusal names the check), chunks before it stay committed.
      chunks.push({
        index: chunks.length,
        operations: slice.length,
        status: "failed",
        createdNodes: [],
        error: err instanceof Error ? err.message : String(err),
      });
      return { chunks, completed: false };
    }

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

  // Issue #24 — the direct-compile bypass. `compile_ir` takes raw IR with no
  // plan channel, so a caller reaching it skips decision classification and
  // composition hints entirely. Two things are therefore unavoidable here
  // rather than opt-in: the intelligence verdict (disclosed, with the fix
  // named) and the product guard (run on every compile, reported on every
  // payload — the same truths the interpreter enforces at build time).
  const intelligence = assessIRIntelligence(parsed.ir);
  const guard = runGuard(defaultRules(), snapshotFromIR(parsed.ir, { composition: inferComposition(parsed.ir.regions) }));

  return {
    status: !compiled.applicable ? "not-applicable" : compiled.violations.length > 0 ? "completed-with-violations" : "completed",
    applicable: compiled.applicable,
    ...(compiled.applicable ? {} : { problems: compiled.inapplicableReasons }),
    dryRun: parsed.dryRun ?? true,
    stats: compiled.stats,
    regions: compiled.regions.map((r) => ({ id: r.id, x: r.x, y: r.y, w: r.w, h: r.h })),
    violations: compiled.violations,
    operations: compiled.operations,
    /** The intelligence bypass verdict: raw IR carries no plan, disclosed here. */
    intelligence,
    warnings: intelligence.warnings,
    /** The product guard, run on every compile — never opt-in. */
    productGuard: {
      verdict: guard.verdict,
      rulesChecked: guard.stats.rulesChecked,
      failures: guard.stats.failures,
      warnings: guard.stats.warnings,
      manual: guard.stats.manual,
    },
    howToProceed: compiled.applicable
      ? undefined
      : "The resolved geometry is not what the IR asked for. Fix the problems above — an inspector off the canvas, a connector that cannot resolve, or an operation whose position disagrees with its resolved box — then compile again.",
  };
}

export { RUNTIME_GUIDE };