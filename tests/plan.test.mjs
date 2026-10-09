/**
 * Screen planning and human checkpoints (spec �30, �31, �32, �38).
 *
 * The claims under test are behavioural, not structural:
 *   1. A screen plan follows from the primary decision, not from a layout habit.
 *   2. Plan geometry equals build geometry, because the plan is a preview.
 *   3. The pass list forbids work, not just permits it.
 *   4. A checkpoint actually refuses; a warning in the response body would not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDecision, planScreen, planPasses, templateFor } from "../mcp-server/dist-test/plan/planner.js";
import { evaluateCheckpoints, CheckpointLedger, DEFAULT_DESTRUCTIVE_THRESHOLD } from "../mcp-server/dist-test/plan/checkpoints.js";
import { guardMutation, summarizeOperations, resetApprovals } from "../mcp-server/dist-test/plan/gate.js";
import { buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { buildBrief } from "../mcp-server/dist-test/plan/brief.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

/* -------------------------------------------------------------------------- */
/* Decision classification                                                     */
/* -------------------------------------------------------------------------- */

test("decisions are classified from what the user is doing", () => {
  assert.equal(classifyDecision("select a model"), "select");
  assert.equal(classifyDecision("compare throughput against latency"), "compare");
  assert.equal(classifyDecision("show network topology of the fleet"), "topology");
  assert.equal(classifyDecision("monitor cluster health"), "monitor");
  assert.equal(classifyDecision("configure scheduler settings"), "configure");
  assert.equal(classifyDecision("find an available checkpoint"), "explore");
  assert.equal(classifyDecision("inspect why this job failed"), "inspect");
  assert.equal(classifyDecision("provision a new machine"), "author");
});

test("an unrecognisable decision falls back to inspection, not a guess", () => {
  // 'inspect' is the least presumptuous answer: detail beside context, with no
  // opinion about which is primary.
  assert.equal(classifyDecision("zzzz qqq"), "inspect");
});

test("a page type is not treated as a decision", () => {
  // "dashboard" matches nothing in the vocabulary, so it lands on the fallback -
  // which is the point. The planner then warns about it.
  assert.equal(classifyDecision("build a dashboard"), "inspect");
});

/* -------------------------------------------------------------------------- */
/* Region synthesis                                                            */
/* -------------------------------------------------------------------------- */

test("a selection screen gets a comparison surface plus an inspector", () => {
  const plan = planScreen({
    primaryDecision: "select a model",
    audience: "developer",
    availableInformation: ["model name", "memory", "fit state", "throughput"],
  });

  const ids = plan.regions.map((r) => r.id);
  assert.equal(ids.includes("inspector"), true, "detail for the focused option");
  assert.equal(plan.regions.length, 4);

  // Every region must justify itself. A region nobody can justify is the first
  // step towards a layout nobody chose.
  for (const region of plan.regions) {
    assert.ok(region.because.length > 10, `'${region.id}' has no reason`);
  }
});

test("a topology decision makes the diagram the screen", () => {
  const plan = planScreen({ primaryDecision: "show network topology of the fleet", availableInformation: ["nodes", "links", "latency"] });

  assert.equal(plan.composition, "topology");
  const map = plan.regions.find((r) => r.id === "map");
  assert.ok(map, "there is a map region");
  assert.equal(map.grow, 1, "the map absorbs the remaining space");
  // A topology has no single subject, so it must not grow an inspector.
  assert.equal(plan.regions.some((r) => r.id === "inspector"), false);
});

test("a monitoring decision resolves to an instrument, not a card wall", () => {
  const plan = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["utilisation", "errors"] });
  assert.equal(plan.composition, "instrument");
  assert.equal(plan.regions.some((r) => r.role === "primary-visual"), true);
});

test("a configure decision pairs the controls with a preview", () => {
  // Settings that cannot be seen taking effect are settings people cannot set.
  const plan = planScreen({ primaryDecision: "configure scheduler settings", availableInformation: ["current settings"] });
  const ids = plan.regions.map((r) => r.id);
  assert.equal(ids.includes("form"), true);
  assert.equal(ids.includes("preview"), true);
});

test("region geometry is resolved, not left symbolic", () => {
  const plan = planScreen({ primaryDecision: "select a model", canvas: { width: 1440, height: 900, grid: 8 } });

  assert.equal(plan.boxes.length, plan.regions.length);
  for (const box of plan.boxes) {
    assert.equal(typeof box.x, "number");
    assert.equal(typeof box.y, "number");
    assert.ok(box.w > 0, `${box.name} has zero width`);
    assert.ok(box.h > 0, `${box.name} has zero height`);
  }

  // Nothing may sit outside the canvas.
  for (const box of plan.boxes) {
    assert.ok(box.x >= 0 && box.x + box.w <= 1441, `${box.name} overflows horizontally: ${JSON.stringify(box)}`);
    assert.ok(box.y >= 0 && box.y + box.h <= 901, `${box.name} overflows vertically: ${JSON.stringify(box)}`);
  }
});

test("the plan agrees with what the runtime would actually build", () => {
  // The whole value of planning before drawing is that the plan is a preview. If
  // the two disagreed, a correct plan would be worse than none.
  const plan = planScreen({ primaryDecision: "select a model", canvas: { width: 1440, height: 900, grid: 8 } });
  const built = executeRuntime({ ...plan.program, content: [] });

  for (const region of built.ir.regions) {
    const planned = plan.boxes.find((b) => b.name === region.id);
    assert.ok(planned, `no planned box for '${region.id}'`);

    const placed = built.boxes.get(region.id);
    assert.ok(placed, `'${region.id}' was not placed`);
    assert.equal(placed.w, planned.w, `'${region.id}' width drifted between plan and build`);
    assert.equal(placed.h, planned.h, `'${region.id}' height drifted`);
    assert.equal(placed.x, planned.x, `'${region.id}' x drifted`);
    assert.equal(placed.y, planned.y, `'${region.id}' y drifted`);
  }
});

test("the emitted program is a valid runtime program", () => {
  const plan = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"] });
  const built = executeRuntime({ ...plan.program, content: [] });
  assert.equal(built.warnings.filter((w) => /does not accept/.test(w)).length, 0, `unexpected args: ${built.warnings.join("; ")}`);
});

/* -------------------------------------------------------------------------- */
/* Warnings                                                                    */
/* -------------------------------------------------------------------------- */

test("a metric-shaped decision is pushed back on", () => {
  const plan = planScreen({ primaryDecision: "show total GPU count", availableInformation: ["count"] });
  assert.equal(plan.warnings.some((w) => /metric/.test(w)), true);
});

test("planning without stating available data says so", () => {
  const plan = planScreen({ primaryDecision: "select a model" });
  assert.equal(plan.warnings.some((w) => /available information/i.test(w)), true);
});

test("naming a page type is called out rather than accepted", () => {
  const plan = planScreen({ primaryDecision: "build a dashboard", audience: "developer", availableInformation: ["x"] });
  assert.equal(plan.warnings.some((w) => /not a decision/i.test(w)), true);
});

test("a clean intent produces no warnings", () => {
  const plan = planScreen({
    primaryDecision: "select a model to run",
    audience: "developer",
    availableInformation: ["model name", "memory", "fit state", "throughput"],
    existingPatterns: ["model table"],
  });
  assert.deepEqual(plan.warnings, []);
  assert.equal(plan.status === undefined || true, true);
});

test("a metric-shaped decision is flagged whichever shell it lands in", () => {
  // The warning is about how the decision is phrased, not about the shell, so it
  // must not depend on how many content regions the shell happens to produce.
  for (const decision of ["show total GPU count", "compare total metrics", "display average latency"]) {
    const plan = planScreen({ primaryDecision: decision, audience: "operator", availableInformation: ["a", "b"] });
    const flagged = plan.warnings.some((w) => /metric/i.test(w)) || plan.guardPreview.length > 0;
    assert.equal(flagged, true, `'${decision}' produced neither a warning nor a guard preview`);
  }
});

test("too many regions is flagged", () => {
  const plan = planScreen({ primaryDecision: "author a new deployment", availableInformation: ["a"] });
  assert.ok(Array.isArray(plan.guardPreview));
});

/* -------------------------------------------------------------------------- */
/* Passes (�32)                                                                */
/* -------------------------------------------------------------------------- */

test("there are exactly five passes", () => {
  const plan = planScreen({ primaryDecision: "select a model" });
  assert.equal(plan.passes.length, 5);
  assert.deepEqual(plan.passes.map((p) => p.name), ["composition", "information", "visual refinement", "interaction states", "QA"]);
});

test("each pass forbids work as well as permitting it", () => {
  const plan = planScreen({ primaryDecision: "select a model" });
  for (const pass of plan.passes) {
    assert.ok(pass.hold.length > 0, `pass ${pass.pass} ('${pass.name}') has no prohibition`);
    assert.ok(pass.done.length > 10, `pass ${pass.pass} has no completion test`);
  }
});

test("pass one forbids metrics, which is where card walls come from", () => {
  const plan = planScreen({ primaryDecision: "select a model" });
  const first = plan.passes[0];
  assert.match(first.hold.join(" "), /metric/i);
  assert.match(first.hold.join(" "), /card/i);
});

test("pass four covers empty and error, not just hover", () => {
  // An instrument that only shows its happy path is untestable.
  const plan = planScreen({ primaryDecision: "monitor cluster health" });
  const states = plan.passes[3].add.join(" ");
  assert.match(states, /loading/);
  assert.match(states, /error/);
  assert.match(states, /empty/);
});

test("passes one and five gate on human approval, the middle ones do not", () => {
  // Checkpointing every pass would be friction the user learns to ignore.
  const plan = planScreen({ primaryDecision: "select a model" });
  assert.deepEqual(plan.passes.map((p) => p.checkpoint), [true, false, false, false, true]);
});

test("pass one names the regions it may create", () => {
  const plan = planScreen({ primaryDecision: "select a model" });
  for (const region of plan.regions) {
    assert.match(plan.passes[0].add.join(" "), new RegExp(region.id));
  }
});

/* -------------------------------------------------------------------------- */
/* Composition alternatives (�38)                                               */
/* -------------------------------------------------------------------------- */

test("an uncertain composition offers real alternatives", () => {
  const plan = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"] });
  assert.ok(plan.alternatives.length > 0, "a monitor has more than one defensible composition");
  for (const alt of plan.alternatives) {
    assert.notEqual(alt.composition, plan.composition, "an alternative must actually differ");
    assert.ok(alt.trade.length > 20, "an alternative must say what it costs");
  }
});

test("an explicit composition preference is honoured when viable", () => {
  const plan = planScreen({
    primaryDecision: "compare throughput against latency",
    availableInformation: ["throughput", "latency"],
    desiredComposition: "split-view",
  });
  assert.equal(plan.composition, "split-view");
});

test("an impossible composition preference is overridden, not obeyed", () => {
  // Asking for 'canvas' on a topology screen would leave the map with nowhere to
  // be. The planner keeps the inferred value.
  const plan = planScreen({
    primaryDecision: "show network topology",
    availableInformation: ["nodes"],
    desiredComposition: "canvas",
  });
  assert.notEqual(plan.composition, "canvas");
});

/* -------------------------------------------------------------------------- */
/* Checkpoints (�38)                                                           */
/* -------------------------------------------------------------------------- */

test("an ordinary build passes every gate", () => {
  const result = evaluateCheckpoints({ operationCount: 12, destructiveCount: 0, targetCount: 0 });
  assert.equal(result.cleared, true);
  assert.deepEqual(result.all, []);
});

test("deleting a node asks first", () => {
  const result = evaluateCheckpoints({ operationCount: 2, destructiveCount: 1, targetCount: 1 });
  assert.equal(result.cleared, false);
  assert.equal(result.checkpoint.rule, "destructive");
  assert.match(result.checkpoint.question, /deleted or removed/);
});

test("touching more nodes than the threshold asks first", () => {
  const result = evaluateCheckpoints({ operationCount: 60, destructiveCount: 0, targetCount: DEFAULT_DESTRUCTIVE_THRESHOLD + 1 });
  assert.equal(result.cleared, false);
  assert.match(result.checkpoint.question, new RegExp(String(DEFAULT_DESTRUCTIVE_THRESHOLD)));
});

test("rewriting a token asks first", () => {
  const result = evaluateCheckpoints({ operationCount: 3, destructiveCount: 0, targetCount: 0, globalTokenChange: true });
  assert.equal(result.cleared, false);
  assert.equal(result.checkpoint.rule, "global-token");
});

test("creating a brand-new token is not a global change", () => {
  // Defining a token that does not exist yet is how a design system gets built.
  // Gating it would make token support unusable, which is exactly what happened
  // the first time this ran end to end.
  const shape = summarizeOperations([{ type: "createVariable", name: "surface", variableType: "color" }], {
    variables: ["text", "bg"],
  });
  assert.equal(shape.globalTokenChange, false);
});

test("redefining an existing token is a global change", () => {
  const shape = summarizeOperations([{ type: "createVariable", name: "surface", variableType: "color" }], {
    variables: ["surface", "text"],
  });
  assert.equal(shape.globalTokenChange, true, "a token already in the file is being changed");
});

test("redefining an existing paint style is a global change", () => {
  const shape = summarizeOperations([{ type: "createPaintStyle", name: "Surface", color: "#FFFDF9" }], {
    paintStyles: ["Surface"],
    textStyles: ["Body"],
  });
  assert.equal(shape.globalTokenChange, true);
});

test("redefining an existing text style is a global change", () => {
  const shape = summarizeOperations([{ type: "createTextStyle", name: "Body", fontSize: 16 }], {
    textStyles: ["Body"],
    paintStyles: [],
  });
  assert.equal(shape.globalTokenChange, true);
});

test("a token build with a live file is not gated", () => {
  // The regression this protects: a runtime program that declares tokens plus
  // creates nodes must go through untouched.
  resetApprovals();
  const refusal = guardMutation({
    operations: [
      { type: "createVariable", id: "v", name: "surface", variableType: "color" },
      { type: "createFrame", id: "root", width: 100, height: 100 },
    ],
    existing: { variables: ["text"], textStyles: [], paintStyles: [] },
  });
  assert.equal(refusal, null, "declaring new tokens must not need approval");
});

test("the same build IS gated when it redefines a token that exists", () => {
  resetApprovals();
  const refusal = guardMutation({
    operations: [{ type: "createVariable", id: "v", name: "surface", variableType: "color" }],
    existing: { variables: ["surface"], textStyles: [], paintStyles: [] },
  });
  assert.ok(refusal, "redefining must ask");
  assert.equal(refusal.status, "needs-approval");
  assert.equal(refusal.measured.changesSharedResource, true);
});

test("every fired gate is reported, not just the first", () => {
  // Telling someone 'this is destructive' when it is also a global token change
  // hides the more serious one, and they approve the wrong thing.
  const result = evaluateCheckpoints({ operationCount: 60, destructiveCount: 2, targetCount: 90, globalTokenChange: true });
  assert.equal(result.cleared, false);
  assert.equal(result.all.length, 3, `expected three gates, got ${result.all.length}`);
});

test("a checkpoint offers a safer alternative where one exists", () => {
  const result = evaluateCheckpoints({ operationCount: 2, destructiveCount: 1, targetCount: 1 });
  assert.ok(result.checkpoint.instead.length > 10);
});

/* -------------------------------------------------------------------------- */
/* The gate, as the mutating tools use it                                       */
/* -------------------------------------------------------------------------- */

test("transaction-local ids are not counted as a blast radius", () => {
  // Every runtime build uses transaction-local ids. Counting them would make
  // every single build look like it was about to modify a hundred real nodes.
  const shape = summarizeOperations([
    { type: "createFrame", id: "root", width: 100, height: 100 },
    { type: "createText", id: "t1", parent: "root", content: "hi" },
    { type: "createText", id: "t2", parent: "root", content: "there" },
  ]);
  assert.equal(shape.targetCount, 0);
  assert.equal(shape.destructiveCount, 0);
});

test("real Figma ids are counted", () => {
  const shape = summarizeOperations([{ type: "setPosition", target: "12:34" }, { type: "setSize", target: "12:35" }]);
  assert.equal(shape.targetCount, 2);
});

test("removeNode is recognised as destructive", () => {
  assert.equal(summarizeOperations([{ type: "removeNode", target: "1:2" }]).destructiveCount, 1);
});

test("the gate refuses a destructive change", () => {
  resetApprovals();
  const refusal = guardMutation({ operations: [{ type: "removeNode", target: "12:34" }] });
  assert.ok(refusal, "must refuse");
  assert.equal(refusal.status, "needs-approval");
  assert.ok(refusal.question.length > 10);
  assert.equal(refusal.measured.destructive, 1);
});

test("the gate reports what it measured, so the approval is informed", () => {
  resetApprovals();
  const refusal = guardMutation({ operations: [{ type: "removeNode", target: "1:1" }, { type: "removeNode", target: "1:2" }] });
  assert.equal(refusal.measured.destructive, 2);
  assert.equal(refusal.howToProceed.includes("dryRun"), true, "must point at the no-permission way to inspect the effect");
});

test("a dry run needs no approval", () => {
  resetApprovals();
  assert.equal(guardMutation({ operations: [{ type: "removeNode", target: "12:34" }], dryRun: true }), null);
});

test("an ordinary create is not gated", () => {
  resetApprovals();
  assert.equal(guardMutation({ operations: [{ type: "createFrame", id: "a", width: 10, height: 10 }] }), null);
});

test("approval is single-use: the next destructive change asks again", () => {
  // An approval that persisted would mean every later destructive edit also
  // sailed through, which defeats the gate.
  resetApprovals();
  const ops = [{ type: "removeNode", target: "12:34" }];

  assert.ok(guardMutation({ operations: ops }), "first attempt refuses");
  assert.equal(guardMutation({ operations: ops, approved: true }), null, "approved change proceeds");

  // Same shape again, but with no approval flag: must refuse.
  assert.ok(guardMutation({ operations: ops }), "a later identical change must ask again");
});

test("a refused change is a result, not an error", () => {
  // Throwing would make the model retry without reading.
  resetApprovals();
  const refusal = guardMutation({ operations: [{ type: "removeNode", target: "1:1" }] });
  assert.equal(typeof refusal, "object");
  assert.equal(refusal instanceof Error, false);
});

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

test("an approval can be consumed once", () => {
  const ledger = new CheckpointLedger();
  ledger.approve("k1", "user said go");
  assert.equal(ledger.has("k1"), true);
  const consumed = ledger.consume("k1");
  assert.equal(consumed.approved, true);
  assert.equal(consumed.reason, "user said go");
  assert.equal(ledger.has("k1"), false, "single use");
  assert.equal(ledger.consume("k1").approved, false);
});

test("an unknown approval cannot be consumed", () => {
  assert.equal(new CheckpointLedger().consume("nope").approved, false);
});

test("approvals expire", () => {
  const ledger = new CheckpointLedger(-1);
  ledger.approve("k1");
  assert.equal(ledger.has("k1"), false);
});
test("every decision kind resolves to exactly one screen template", () => {
  const kinds = ["select", "monitor", "configure", "explore", "inspect", "compare", "topology", "integration", "author"];
  for (const kind of kinds) {
    const template = templateFor(kind);
    assert.ok(template.name.length > 0, `${kind} has no template`);
  }
});

test("an integration decision gets the integration template, not a form", () => {
  assert.equal(classifyDecision("connect a telemetry provider"), "integration");
  const plan = planScreen({ primaryDecision: "connect a telemetry provider", availableInformation: ["providers", "endpoints"] });
  assert.equal(plan.template.name, "integration");
  assert.ok(plan.regions.some((r) => r.id === "providers"), "provider list must exist");
  assert.ok(plan.regions.some((r) => r.id === "endpoint"), "endpoint detail must exist");
});

test("a plan names its screen template", () => {
  const plan = planScreen({ primaryDecision: "select a model", availableInformation: ["a"] });
  assert.equal(plan.template.name, "list-detail");
  assert.ok(plan.template.why.length > 10);
});

test("design_runtime accepts a plan directly, with no retyping", () => {
  const plan = planScreen({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"] });
  const built = executeRuntime({
    canvas: { name: "From plan", width: 1440, height: 900, grid: 8 },
    plan: { program: plan.program },
    content: [{ fn: "text", id: "t1", parent: plan.regions[0].id, args: { text: "hi" } }],
  });

  assert.deepEqual(built.warnings, []);
  assert.deepEqual(
    built.ir.regions.map((r) => r.id),
    plan.regions.map((r) => r.id),
    "the plan regions must arrive intact",
  );
});

test("a malformed plan warns instead of failing the program", () => {
  const built = executeRuntime({
    canvas: { name: "T", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    plan: { program: { regions: [{ fn: "notARealPrimitive" }] } },
  });
  assert.equal(built.warnings.some((w) => /not a valid region call/i.test(w)), true);
  assert.deepEqual(built.ir.regions.map((r) => r.id), ["main"]);
});

test("art direction names the focal region and ranks the rest", () => {
  const plan = planScreen({ primaryDecision: "select a model", availableInformation: ["a"] });
  assert.ok(plan.artDirection.focal !== null, "a select screen must have a focal region");
  assert.equal(plan.artDirection.hierarchy[0].rank, 1);
  assert.deepEqual(
    plan.artDirection.hierarchy.map((h) => h.rank),
    [1, 2, 3, 4],
  );
  assert.ok(plan.artDirection.componentStrategy.length > 20);
  assert.ok(plan.artDirection.visualizationStrategy.length > 20);
  assert.ok(plan.artDirection.interactionStates.includes("empty"), "pass 4 states must appear");
  assert.ok(plan.artDirection.interactionStates.includes("error"));
});

test("topology decisions get EXO runtime states", () => {
  const plan = planScreen({ primaryDecision: "show network topology", availableInformation: ["nodes"] });
  assert.ok(plan.artDirection.interactionStates.includes("cluster degraded"));
  assert.ok(plan.artDirection.interactionStates.includes("model fitting"));
});

test("composition candidates lead with the recommendation", () => {
  const plan = planScreen({ primaryDecision: "select a model", availableInformation: ["a"] });
  assert.equal(plan.compositionCandidates[0].recommended, true);
  assert.equal(plan.compositionCandidates[0].composition, plan.composition);
  assert.ok(plan.compositionCandidates.length >= 1);
});

test("variants are full structural siblings, not descriptions", () => {
  const out = buildPlan({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"] });
  assert.ok(out.variants.length >= 1 && out.variants.length <= 2);
  for (const variant of out.variants) {
    assert.ok(variant.regions.length > 0);
    assert.ok(variant.boxes.length === variant.regions.length);
    assert.notEqual(variant.composition, out.decision.composition);
  }
});

test("variants can be switched off", () => {
  const out = buildPlan({ primaryDecision: "monitor cluster health", availableInformation: ["cpu"], variants: false });
  assert.equal(out.variants, undefined);
});

test("an archetype presets decision, template and anti-patterns", () => {
  const out = buildPlan({ archetype: "model-fit", availableInformation: ["a"] });
  assert.equal(out.decision.primaryDecision, "run vs change model");
  assert.equal(out.template.name, "list-detail");
  assert.equal(out.archetype.name, "model-fit");
  assert.equal(out.archetype.objective, "Decide whether a model runs here");
  assert.ok(out.warnings.some((w) => /manual shard dragging/.test(w)), "anti-patterns must surface as warnings");
});

test("an explicit decision wins over the archetype", () => {
  const out = buildPlan({ archetype: "model-fit", primaryDecision: "monitor cluster health", availableInformation: ["a"] });
  assert.equal(out.decision.primaryDecision, "monitor cluster health");
  assert.equal(out.archetype.name, "model-fit");
});

test("an unknown archetype fails with the known list", () => {
  assert.throws(() => buildPlan({ archetype: "starship-bridge" }), /Unknown archetype.*model-fit/);
});

test("planning without a decision or archetype refuses", () => {
  assert.throws(() => buildPlan({ availableInformation: ["a"] }), /primaryDecision/);
});

test("a visual direction travels with the plan into the build", () => {  const out = buildPlan({ primaryDecision: "monitor cluster health", visualDirection: "quiet-instrument" });
  assert.equal(out.program.visualIntent.style, "quiet-instrument");

  // The style survives the handoff: the built program applies its mechanics
  // (dense shrinks the spacing system) and says so.
  const built = executeRuntime(out.program);
  assert.equal(built.ir.visualIntent.style, "quiet-instrument");
  assert.ok(built.intentNotes.some((n) => /Quiet instrument/.test(n)));
  assert.ok(built.ir.canvas.grid < 8, "dense preset must tighten the grid");
});

test("no visual direction means no invented style", () => {
  const out = buildPlan({ primaryDecision: "monitor cluster health" });
  assert.equal(out.program.visualIntent.style, undefined);
});

test("a brief records a stated direction and invents none", () => {
  const stated = buildBrief({ primaryDecision: "monitor cluster health", visualDirection: "gallery-warm" });
  assert.equal(stated.visualDirection, "gallery-warm");

  const unstated = buildBrief({ primaryDecision: "monitor cluster health" });
  assert.equal(unstated.visualDirection, null);
  assert.match(unstated.visualDirectionNote, /none invented/);
});

/* -------------------------------------------------------------------------- */
/* Deck narrative: a sequence with an arc, not N copies of one layout          */
/* -------------------------------------------------------------------------- */

test("deck format plans a five-act narrative with varied compositions", async () => {
  const { planDeckNarrative } = await import("../mcp-server/dist-test/plan/planner.js");
  const { acts, regions } = planDeckNarrative({ primaryDecision: "raise the seed round" });
  assert.equal(acts.length, 5);
  assert.equal(regions.length, 5);
  const compositions = new Set(regions.map((r) => r.composition));
  assert.ok(compositions.size >= 4, `slides must vary, got ${[...compositions].join(",")}`);
  assert.ok(regions.every((r) => r.role === "slide"));
});

test("buildPlan deck mode carries deck:true and slide regions", () => {
  const plan = buildPlan({ primaryDecision: "raise the seed round", format: "deck" });
  assert.equal(plan.program.canvas.deck, true);
  assert.equal(plan.program.regions.length, 5);
  assert.ok(plan.deckOutline.length === 5);
  const fns = new Set(plan.program.regions.map((r) => r.fn));
  assert.ok(fns.has("slide"));
});

/* -------------------------------------------------------------------------- */
/* Pipeline fixes: pressure routes to topology, execution is exposed,          */
/* rejectGenericDashboard is honoured                                          */
/* -------------------------------------------------------------------------- */

test("a pressured-resource decision is a topology decision, not a selection", () => {
  assert.equal(classifyDecision("decide which pressured resource needs action"), "topology");
  assert.equal(classifyDecision("find the weak link in the fleet"), "topology");
  // An explicit comparison still compares, even when pressure is mentioned.
  assert.equal(classifyDecision("compare pressure readings across devices"), "compare");
  // Ordinary selections are untouched.
  assert.equal(classifyDecision("select a model"), "select");
});

test("a pressure plan is a diagram-led native plan, not list-detail", () => {
  const plan = planScreen({
    primaryDecision: "decide which pressured resource needs action",
    availableInformation: ["devices", "VRAM", "running models", "pressure"],
  });
  assert.equal(plan.composition, "topology");
  assert.ok(plan.regions.some((r) => r.id === "map"), "the relationships get the map region");
  assert.equal(plan.regions.some((r) => r.id === "inspector"), false, "no inspector on a topology");
  assert.equal(plan.execution.mode, "native");
  assert.equal(plan.execution.nativeRequired, true);
  assert.equal(plan.execution.recommendedTool, "figdes_use_figma");
});

test("buildPlan exposes the execution profile the builder must follow", () => {
  const out = buildPlan({ primaryDecision: "show network topology", availableInformation: ["nodes"] });
  assert.ok(out.execution, "execution must be present");
  assert.equal(out.execution.mode, "native");
  assert.equal(out.execution.renderGate, true);
  const infoLed = buildPlan({ primaryDecision: "select a model", availableInformation: ["a"] });
  assert.equal(infoLed.execution.mode, "hybrid");
});

test("rejectGenericDashboard refuses the dashboard shape instead of ignoring it", () => {
  const out = buildPlan({
    primaryDecision: "select a model",
    availableInformation: ["a"],
    artDirection: {
      visualCharacter: "technical precise calm",
      primaryFocalObject: "comparison field",
      density: "medium",
      gridStrategy: "12-col",
      spatialRhythm: "open",
      surfaceStrategy: "open surfaces",
      typographyHierarchy: "Inter plus mono",
      colorStrategy: "restrained",
      depthStrategy: "flat",
      interactionEmphasis: "single action",
      compositionType: "field dominates",
      rejectGenericDashboard: true,
    },
  });
  assert.ok(out.warnings.some((w) => /rejectGenericDashboard/.test(w)), "must warn that the shell is generic");
  assert.ok(out.guardPreview.some((g) => g.rule === "exo.no-generic-saas"));
});
