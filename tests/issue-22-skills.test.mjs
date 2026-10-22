/**
 * Issue #22 phase 1 — the Design Skills and Visual Intelligence layer.
 *
 * Three classes of test, matching the issue's acceptance criteria:
 *
 * 1. **Skill format and registry** — the spec validates, rejects, and
 *    registers exactly the four initial skills.
 * 2. **Skill behaviour** — each skill's decisions are observable (style
 *    tokens, archetype contracts, numerals, exclusions, findings) from the
 *    same briefs used in the fixtures.
 * 3. **Contract: no silent dead intent fields** — every field of the
 *    runtime's own `VisualIntentSchema` is either mapped to a named consumer
 *    with a described effect or explicitly marked unsupported with a reason;
 *    and the compiled fields demonstrably change the rendering.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  defaultSkillRegistry,
  computeSignals,
  compileVisualIntent,
  intentFieldLedger,
} from "../mcp-server/dist-test/design/skills/intent-compiler.js";
import { VisualIntentSchema } from "../mcp-server/dist-test/design/skills/intent-compiler.js";
import {
  validateSkillSpec,
  SkillRegistry,
} from "../mcp-server/dist-test/design/skills/registry.js";
import { directionVocabulary } from "../mcp-server/dist-test/design/skills/direction.js";
import { reviewPlan, toPipelineFinding } from "../mcp-server/dist-test/design/skills/anti-generic.js";
import { resolveStyleTokens } from "../mcp-server/dist-test/runtime/visual-presets.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";

/* -------------------------------------------------------------------------- */
/* Brief fixtures                                                              */
/* -------------------------------------------------------------------------- */

const MONITORING_BRIEF = {
  screen: "Cluster health",
  product: "fenek-clusters",
  purpose: "watch the cluster and intervene when a node is under pressure",
  primaryDecision: "intervene or let the run continue",
  primaryAction: "drain the node",
  availableInformation: [
    "throughput",
    "latency p99",
    "error rate",
    "node pressure",
    "queue depth",
    "shard health",
    "recent interventions",
  ],
  dataMode: "demo",
  designSystemConstraints: ["Use the existing EXO token ramp"],
  visualDirection: "premium technical",
  antiGoals: ["no generic SaaS card walls"],
  states: ["degraded", "recovering"],
  existingPatterns: ["instrument strip"],
  audience: "operator",
};

const FORM_BRIEF = {
  screen: "Rate limits",
  purpose: "tune throughput guards",
  primaryDecision: "configure rate limits",
  primaryAction: "save limits",
  availableInformation: ["requests per minute", "burst allowance", "scope"],
  dataMode: "demo",
  desiredComposition: undefined,
};

// A normalized brief as the skills see it after the compiler's defensive defaults.
function monitorBrief() {
  return {
    id: "b1",
    screen: "Cluster health",
    product: "fenek-clusters",
    purpose: "watch the cluster and intervene when a node is under pressure",
    primaryDecision: "intervene or let the run continue",
    primaryAction: "drain the node",
    secondaryActions: [],
    requiredInformation: ["throughput", "latency p99", "error rate", "node pressure", "queue depth", "shard health"],
    optionalInformation: ["recent interventions"],
    values: {},
    data: { mode: "demo", notes: "demo cluster", illustrative: true },
    interactions: [],
    viewport: { width: 1440, height: 900 },
    responsive: [],
    designSystemConstraints: ["Use the existing EXO token ramp"],
    references: { observations: [], assumptions: [] },
    visualDirection: "premium technical",
    antiGoals: ["no generic SaaS card walls"],
    states: ["degraded", "recovering"],
    scope: { create: [], edit: [], leaveUntouched: [] },
    existingPatterns: ["instrument strip"],
    audience: "operator",
    archetype: null,
    desiredComposition: undefined,
  };
}

/* -------------------------------------------------------------------------- */
/* 1. Skill format and registry                                                */
/* -------------------------------------------------------------------------- */

test("the four phase-1 skills are registered with valid specs", () => {
  const registry = defaultSkillRegistry();
  assert.equal(registry.size(), 4);
  for (const id of ["brief-art-direction", "composition-strategy", "type-and-space", "anti-generic-review"]) {
    assert.ok(registry.has(id), `${id} registered`);
    const spec = registry.get(id).spec;
    assert.ok(spec.purpose.length >= 20);
    assert.ok(spec.decisionRules.length >= 1);
    assert.ok(spec.qualityChecks.length >= 1, `${id} has measurable acceptance criteria`);
    assert.ok(spec.examples.length >= 1 && spec.counterexamples.length >= 1, `${id} carries example and counterexample`);
    assert.ok(spec.fixtures.length >= 1, `${id} names its regression fixtures`);
    for (const output of spec.outputs) {
      assert.ok(output.consumedBy.length >= 1, `${id} output ${output.field} names a consumer`);
    }
  }
});

test("the registry rejects an invalid spec naming the broken field", () => {
  const registry = new SkillRegistry();
  assert.throws(
    () => registry.register({
      spec: { id: "broken-skill", version: "v1", name: "Broken", purpose: "too short" },
      apply: () => ({ skill: "broken-skill", decisions: [], notes: [] }),
    }),
    /Invalid skill spec: .*purpose/,
  );
});

test("the registry rejects duplicate ids and specs whose outputs name no consumer", () => {
  const base = defaultSkillRegistry().get("type-and-space");
  const registry = new SkillRegistry();
  registry.register(base);
  assert.throws(() => registry.register({ spec: base.spec, apply: () => ({ skill: base.spec.id, decisions: [], notes: [] }) }), /Duplicate skill id 'type-and-space'/);

  const deadSpec = structuredClone(base.spec);
  deadSpec.outputs = [{ field: "x", description: "d", consumedBy: [] }];
  assert.throws(() => registry.register({ spec: deadSpec, apply: base.apply }), /Invalid skill spec/);
});

/* -------------------------------------------------------------------------- */
/* 2. Selection is contextual, with recorded reasons                           */
/* -------------------------------------------------------------------------- */

test("a rich monitoring brief fires content, readout and direction signals", () => {
  const facts = computeSignals(monitorBrief());
  for (const s of ["stated-direction", "content-inventory", "data-readouts", "many-regions", "design-system-context"]) {
    assert.ok(facts.signals.includes(s), `${s} fired: ${facts.signals.join(", ")}`);
  }
  assert.ok(facts.why["stated-direction"].includes("premium technical"), "each signal says why");
});

test("a bare brief selects no skills but records a skip reason for each", () => {
  const honest = { ...monitorBrief(), visualDirection: null, designSystemConstraints: [], requiredInformation: [], optionalInformation: [], states: [], interactions: [], audience: "general" };
  const art = compileVisualIntent(honest);
  assert.deepEqual(art.selection.selected, []);
  assert.equal(art.selection.skipped.length, 3, "the three compile-phase skills are all skipped with reasons (the anti-generic skill is review-phase and not part of this selection)");
  for (const skip of art.selection.skipped) {
    assert.ok(skip.reason.length > 20, `skip reason for ${skip.id}: ${skip.reason}`);
  }
  assert.ok(!art.selection.skipped.some((s) => s.id === "anti-generic-review"), "review-phase skill absent from compile selection");
  assert.deepEqual(art.intent, {}, "no intent fields without decisions");
});

/* -------------------------------------------------------------------------- */
/* 3. Brief interpretation and art direction                                   */
/* -------------------------------------------------------------------------- */

test("'premium technical' compiles to its observable tokens and canonical fields", () => {
  const art = compileVisualIntent(monitorBrief());
  assert.ok(art.intent.style.includes("generous"), "premium → generous");
  assert.ok(art.intent.style.includes("calm-technical"), "technical → calm-technical");
  assert.equal(art.intent.rhythm, "generous");
  assert.equal(art.intent.depth, "subtle");
  assert.equal(art.intent.contrast, "restrained");
  // The compiled style resolves with no contradiction warning at the runtime.
  assert.deepEqual(resolveStyleTokens(art.intent.style).warnings, [], "clean resolution");
});

test("contradicting manner words are resolved with a note, never silently", () => {
  const brief = monitorBrief();
  brief.visualDirection = "premium dense";
  const art = compileVisualIntent(brief);
  const tension = [...art.notes];
  assert.ok(
    tension.some((n) => n.includes("pull against each other") || n.includes("contradict")),
    `tension note recorded: ${art.notes.join(" | ")}`,
  );
  // The surviving style still resolves cleanly (the runtime would drop ALL style otherwise).
  if (art.intent.style !== undefined) {
    assert.deepEqual(resolveStyleTokens(art.intent.style).warnings.filter((w) => w.includes("opposite directions")), []);
  }
});

test("'not playful' is an exclusion, not an ignored adverb", () => {
  const brief = monitorBrief();
  brief.visualDirection = "premium technical, not playful";
  const art = compileVisualIntent(brief);
  if (art.intent.style !== undefined) {
    assert.ok(!art.intent.style.includes("gallery-warm"), "playful manner withheld");
  }
  const exclusion = art.decisions.find((d) => d.key === "direction-exclusion: playful");
  assert.ok(exclusion, "the exclusion is a recorded decision");
  assert.equal(exclusion.hard, true, "an exclusion is a hard constraint");
});

test("untranslatable words are named untranslated, not dropped", () => {
  const brief = monitorBrief();
  brief.visualDirection = "premium luxurious";
  const art = compileVisualIntent(brief);
  assert.ok(art.notes.some((n) => n.includes("Untranslated manner word") && n.includes("luxurious")));
});

test("the direction vocabulary contains no token the runtime rejects", () => {
  for (const [word, tokens] of Object.entries(directionVocabulary())) {
    const resolved = resolveStyleTokens(tokens.join(","));
    assert.deepEqual(
      resolved.warnings.filter((w) => w.includes("opposite directions")),
      [],
      `word '${word}' has no internal contradiction`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* 4. Composition strategy                                                     */
/* -------------------------------------------------------------------------- */

test("configure → form-led, monitor → workspace; each with reasons and rejections", () => {
  const form = compileVisualIntent(monitorBrief()); // control: same registry, different brief below
  void form;
  const registry = defaultSkillRegistry();
  const configureBrief = monitorBrief();
  configureBrief.primaryDecision = "configure rate limits";
  const artForm = compileVisualIntent(configureBrief, { registry });
  const formDecision = artForm.decisions.find((d) => d.key === "archetype");
  assert.ok(formDecision, "archetype decision present");
  assert.equal(formDecision.value, "form-led");
  assert.ok(artForm.decisions.some((d) => d.key.startsWith("rejected:")), "rejections recorded");

  const monitorArt = compileVisualIntent(monitorBrief(), { registry });
  const monitorDecision = monitorArt.decisions.find((d) => d.key === "archetype");
  assert.equal(monitorDecision.value, "workspace");
});

test("a caller-specified composition is a hard decision the skills defer to", () => {
  const brief = monitorBrief();
  brief.desiredComposition = "canvas";
  const art = compileVisualIntent(brief);
  const arch = art.decisions.find((d) => d.key === "archetype");
  assert.equal(arch.value, "canvas");
  assert.equal(arch.hard, true);
});

/* -------------------------------------------------------------------------- */
/* 5. Typography and spacing                                                   */
/* -------------------------------------------------------------------------- */

test("numeric readouts compile tabular numerals into the style", () => {
  const art = compileVisualIntent(monitorBrief());
  assert.ok(art.intent.style.includes("tabular"), "numerals folded into style");
  const numeral = art.decisions.find((d) => d.key === "visual-intent.numerals");
  assert.ok(numeral && numeral.why.includes("numeric readout"), "reason names the evidence");
});

/* -------------------------------------------------------------------------- */
/* 6. Contract: every canonical intent field is wired or explicitly unsupported */
/* -------------------------------------------------------------------------- */

test("the intent consumer ledger covers every VisualIntentSchema field exactly", () => {
  const schemaFields = Object.keys(VisualIntentSchema.shape);
  const ledger = intentFieldLedger();
  assert.deepEqual(
    new Set(schemaFields),
    new Set(Object.keys(ledger)),
    `schema fields ${schemaFields.join(", ")} vs ledger ${Object.keys(ledger).join(", ")}`,
  );
  for (const [field, entry] of Object.entries(ledger)) {
    if (entry.status === "consumed") {
      assert.ok(entry.consumer && entry.consumer.length > 10, `${field} names its consumer`);
      assert.ok(entry.effect && entry.effect.length > 10, `${field} describes its effect`);
    } else {
      assert.ok(entry.reason && entry.reason.length > 20, `${field} (unsupported) states why`);
    }
  }
});

test("the compiled intent is always the runtime's own schema, and never sets the unsupported composition field", () => {
  for (const brief of [monitorBrief(), { ...monitorBrief(), visualDirection: "minimal" }, { ...monitorBrief(), visualDirection: "editorial playful" }]) {
    const art = compileVisualIntent(brief);
    const parsed = VisualIntentSchema.safeParse(art.intent);
    assert.ok(parsed.success, `intent valid for direction '${brief.visualDirection}': ${JSON.stringify(art.intent)}`);
    assert.equal(art.intent.composition, undefined, "the unsupported field is never written");
  }
});

test("compiled density defers to a style that already implies one (instrument manner)", () => {
  const brief = monitorBrief();
  brief.visualDirection = "instrument";
  const art = compileVisualIntent(brief);
  assert.ok(art.intent.density === undefined, `density deferred to style: ${JSON.stringify(art.intent)}`);
  assert.ok(art.notes.some((n) => n.includes("already imply")), "the deferral is recorded");
});

/* -------------------------------------------------------------------------- */
/* 7. Anti-generic review over plans                                           */
/* -------------------------------------------------------------------------- */

function planForReview(overrides = {}) {
  return {
    id: "p1",
    composition: "editorial",
    regions: [
      { id: "a", role: "content", composition: "editorial", sizing: { width: 500, height: 300 }, grow: 0 },
      { id: "b", role: "content", composition: "editorial", sizing: { width: 500, height: 300 }, grow: 0 },
      { id: "c", role: "content", composition: "editorial", sizing: { width: 500, height: 300 }, grow: 0 },
    ],
    content: [],
    focal: null,
    ...overrides,
  };
}

test("an even card grid and a missing focal are found, with evidence and repairs", () => {
  const { findings } = reviewPlan(planForReview());
  const rules = findings.map((f) => f.rule);
  assert.ok(rules.includes("even-card-grid"), `rules: ${rules.join(", ")}`);
  assert.ok(rules.includes("no-focal"));
  const grid = findings.find((f) => f.rule === "even-card-grid");
  assert.ok(grid.evidence.includes("'a'") && grid.evidence.includes("'c'"), "evidence names the regions");
  assert.ok(grid.repair.length > 20);
  // None of the findings is auto-applied; severity is honest.
  assert.ok(findings.every((f) => f.severity === "serious" || f.severity === "minor"));
});

test("an asymmetric plan with a focal passes the anti-generic review", () => {
  const clean = planForReview({
    regions: [
      { id: "a", role: "content", composition: "editorial", sizing: { width: 900, height: 400 }, grow: 2 },
      { id: "b", role: "content", composition: "instrument", sizing: { width: 260, height: 400 }, grow: 0 },
      { id: "c", role: "content", composition: "table", sizing: { width: 1160, height: 180 }, grow: 0 },
    ],
    content: [],
    focal: { id: "a", why: "the payload" },
  });
  const { findings } = reviewPlan(clean);
  assert.deepEqual(findings.map((f) => f.rule), []);
});

test("metric shouting is flagged when many signal slots compete", () => {
  const shouting = planForReview({
    content: ["m1", "m2", "m3", "m4", "m5"].map((m) => ({ id: m, kind: "signal", label: m })),
    focal: { id: "a", why: "x" },
  });
  const { findings } = reviewPlan(shouting);
  assert.ok(findings.some((f) => f.rule === "metric-shouting"));
});

test("skill findings convert into the pipeline finding flow without fabrication", () => {
  const { findings } = reviewPlan(planForReview());
  const pipelineFinding = toPipelineFinding(findings[0].rule, findings[0], ["a", "b", "c"]);
  assert.equal(pipelineFinding.stage, "plan");
  assert.ok(pipelineFinding.severity === "high" || pipelineFinding.severity === "low" || pipelineFinding.severity === "critical");
  assert.ok(pipelineFinding.confidence > 0.4 && pipelineFinding.confidence <= 1);
  assert.equal(pipelineFinding.automatable, false, "findings are never silently repaired");
});

/* -------------------------------------------------------------------------- */
/* 8. The compiled intent actually changes the rendering                       */
/* -------------------------------------------------------------------------- */

/** Program cache primed before the render-effect test runs (the pipeline tool is async, executeRuntime is not). */
const programCache = new Map();

/** What visual-intent fields the program actually carried, per direction. */
const programIntentCache = new Map();

async function primePrograms(directions) {
  if (programCache.size === 0) {
    for (const direction of directions) {
      const result = await designPipelineTool(null, null, { brief: { ...MONITORING_BRIEF, visualDirection: direction }, mode: "plan" });
      programCache.set(direction, result.program);
      programIntentCache.set(direction, result.program.visualIntent);
    }
  }
}

test("compiled rhythm and density provably shift the rendered geometry", async () => {
  await primePrograms(["editorial", "instrument"]);

  // The two programs carry different compiled manners.
  const generousIntent = programIntentCache.get("editorial");
  const denseIntent = programIntentCache.get("instrument");
  assert.equal(generousIntent.rhythm, "generous", `editorial compiles rhythm generous: ${JSON.stringify(generousIntent)}`);
  assert.ok(denseIntent.style.includes("instrument"), `instrument manner carried: ${JSON.stringify(denseIntent)}`);

  const renderedGenerous = executeRuntime(programCache.get("editorial"));
  const renderedCramped = executeRuntime(programCache.get("instrument"));
  let differs = false;
  let detail = "";
  for (const [id, box] of renderedGenerous.boxes) {
    const other = renderedCramped.boxes.get(id);
    if (other === undefined) continue;
    if (Math.abs(box.x - other.x) > 0 || Math.abs(box.y - other.y) > 0) {
      differs = true;
      detail = `${id}: editorial (${box.x},${box.y}) vs instrument (${other.x},${other.y})`;
      break;
    }
  }
  assert.ok(differs, `compiled manner moved content; traceable render effect missing. ${detail}`);
});

/* -------------------------------------------------------------------------- */
/* 9. Pipeline integration: the skills ride the existing flow                  */
/* -------------------------------------------------------------------------- */

test("the pipeline applies skills, carries the intent on the plan and the program, and merges focal", async () => {
  const result = await designPipelineTool(null, null, { brief: MONITORING_BRIEF, mode: "plan" });
  assert.equal(result.status, "planned");

  const stages = result.trace.stages.map((s) => s.stage);
  assert.ok(stages.includes("skills"), `skills stage ran: ${stages.join(" | ")}`);
  assert.ok(stages.includes("visual-review"), "anti-generic review ran");

  const vi = result.visualIntelligence;
  assert.ok(vi.selection.selected.includes("brief-art-direction"));
  assert.ok(vi.selection.selected.includes("composition-strategy"));
  assert.ok(vi.decisions.length > 0);
  assert.ok(vi.intent.style !== undefined);

  // The plan states the manner next to the composition.
  assert.deepEqual(result.plan.visualIntent, vi.intent);
  // The program's visualIntent keeps the planner's focal/weights and adds the compiled fields.
  assert.ok(result.program.visualIntent.style === vi.intent.style);
  assert.ok(result.program.visualIntent.focal !== undefined, "planner focal preserved");
  assert.ok(result.program.visualIntent.rhythm === vi.intent.rhythm);

  assert.ok(result.plan.focal !== null, "a focal exists for a multi-region monitoring plan");
});

test("the pipeline is unchanged for a brief with no direction and no inventory (no silent skill effects)", async () => {
  const result = await designPipelineTool(null, null, {
    brief: { screen: "Solo", purpose: "one decision", primaryDecision: "select a shard", dataMode: "demo" },
    mode: "plan",
  });
  assert.equal(result.status, "planned");
  const skillsStage = result.trace.stages.find((s) => s.stage === "skills");
  assert.ok(skillsStage, "the stage always records itself");
  assert.ok(
    result.visualIntelligence.selection.skipped.length > 0,
    "every non-selected skill carries its reason",
  );
  for (const skip of result.visualIntelligence.selection.skipped) {
    assert.ok(skip.reason.length > 20);
  }
});

/* -------------------------------------------------------------------------- */
/* 10. Regression fixtures pinned by the fixtures specs declare                 */
/* -------------------------------------------------------------------------- */

test("fixture: issue-22-premium-direction (premium monitoring brief compiles premium domain tokens)", () => {
  const art = compileVisualIntent(monitorBrief());
  const style = art.intent.style;
  assert.ok(style === "generous,restrained,open,tabular,calm-technical", `pinned compiled style: ${style}`);
});

test("fixture: issue-22-premium-tension (minimal+dense resolves with a note, dense holds)", () => {
  const brief = monitorBrief();
  brief.visualDirection = "minimal dense";
  const art = compileVisualIntent(brief);
  // minimal expands to calm+quiet+open; calm+dense is a runtime contradiction pair.
  assert.ok(art.notes.some((n) => n.includes("'dense'")), `tension recorded: ${art.notes.join(" | ")}`);
  if (art.intent.style !== undefined) {
    assert.deepEqual(
      resolveStyleTokens(art.intent.style).warnings.filter((w) => w.includes("opposite directions")),
      [],
      "no contradiction survives into the compiled style",
    );
  }
});

test("fixture: issue-22-composition-strategy-briefs (task vocabulary maps to the right archetypes)", () => {
  const registry = defaultSkillRegistry();
  const cases = [
    ["configure rate limits", "form-led"],
    ["which machines to compare", "split-view"],
  ];
  for (const [decision, expected] of cases) {
    const brief = monitorBrief();
    brief.primaryDecision = decision;
    const art = compileVisualIntent(brief, { registry });
    const arch = art.decisions.find((d) => d.key === "archetype");
    assert.equal(arch.value, expected, `'${decision}' → ${expected}, got ${arch.value}`);
  }
});

test("fixture: issue-22-type-space-briefs (no readouts → loose alignment; three readouts → strong)", () => {
  const registry = defaultSkillRegistry();
  const looseBrief = { ...monitorBrief(), primaryDecision: "select a shard", requiredInformation: ["a headline", "an intro paragraph", "one narrative line"], visualDirection: "editorial" };
  const loose = compileVisualIntent(looseBrief, { registry });
  assert.equal(loose.intent.alignment, "loose");
  const strongBrief = { ...monitorBrief(), primaryDecision: "select a shard", requiredInformation: ["throughput", "latency p99", "error rate"], visualDirection: "editorial" };
  const strong = compileVisualIntent(strongBrief, { registry });
  assert.equal(strong.intent.alignment, "strong");
});
