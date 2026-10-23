/**
 * Deployment decisions (planner deploy classification).
 *
 * The EXO brief "Choose a model deployment that fits the discovered compute
 * cluster." used to classify as a generic `select` and plan a bare option
 * list: no automatic placement recommendation, no requires-vs-available fit,
 * no launch action. These tests pin the fix:
 *   1. deployment wording classifies `deploy`, checked before `select`;
 *   2. the deploy plan carries the automatic placement recommendation and the
 *      archetype's priority items as required information;
 *   3. deploy plans express the deployment runtime states;
 *   4. action/state intent reaches the plan;
 *   5. none of the existing classifications moved.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDecision, planScreen, archetypeFor, resolveArchetype } from "../mcp-server/dist-test/plan/planner.js";
import { buildPlan } from "../mcp-server/dist-test/plan/tools.js";
import { classifyInformation } from "../mcp-server/dist-test/design/composition/derive.js";
import { OFFLINE_BRIEFS, EXO_DEPLOYMENT_BRIEFS } from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";
import { BENCHMARKS, EXO_DEPLOYMENT_CASES } from "../mcp-server/dist-test/design/benchmark/suite.js";

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

test("a deployment decision classifies deploy, not select", () => {
  assert.equal(classifyDecision("Choose a model deployment that fits the discovered compute cluster."), "deploy");
  assert.equal(classifyDecision("roll out the new shard layout"), "deploy");
  assert.equal(classifyDecision("launch the model on the cluster"), "deploy", "launch counts when the object is fleet infrastructure");
  assert.equal(classifyDecision("ship the model to the fleet"), "deploy");
});

test("bare launch/ship without fleet infrastructure is not a deployment", () => {
  assert.equal(classifyDecision("launch the marketing site"), "inspect");
  assert.equal(classifyDecision("ship the report"), "inspect");
});

test("the deployment decision gets the deployment-fit template and shell", () => {
  const plan = planScreen({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    availableInformation: ["candidate models", "cluster memory", "machine health"],
  });
  assert.equal(plan.template.name, "deployment-fit");
  const ids = plan.regions.map((r) => r.id);
  assert.deepEqual(ids, ["nav", "header", "candidates", "placement"]);

  // The automatic placement recommendation is stated in a region's reason,
  // never left to be inferred.
  const placement = plan.regions.find((r) => r.id === "placement");
  assert.match(placement.because, /automatic placement/i);
  assert.match(placement.because, /required vs available memory/i);
  assert.match(placement.because, /fit verdict/i);
  assert.match(placement.because, /dragging shards by hand/i, "the shell states placement is recommended, never dragged");
  for (const region of plan.regions) {
    assert.ok(region.because.length > 10, `'${region.id}' has no reason`);
  }
});

/* -------------------------------------------------------------------------- */
/* Archetype priority becomes plan material                                    */
/* -------------------------------------------------------------------------- */

test("the deploy decision infers the model-fit archetype deterministically", () => {
  const inferred = resolveArchetype("Choose a model deployment that fits the discovered compute cluster.");
  assert.equal(inferred?.name, "model-fit");
  assert.deepEqual(inferred, archetypeFor("model-fit"));

  // A deployment decision about the cluster itself is the deployment screen.
  assert.equal(resolveArchetype("confirm the rollout to the cluster")?.name, "deployment");
  // Non-deploy decisions infer nothing.
  assert.equal(resolveArchetype("select a model"), undefined);
});

test("model-fit priority items surface as required information", () => {
  const plan = planScreen({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    availableInformation: ["candidate models", "cluster memory"],
  });
  // Inferred archetype: the four model-fit priorities join the stated items.
  for (const priority of ["fit verdict", "requires vs available", "recommended config", "run action"]) {
    assert.ok(plan.requiredInformation.includes(priority), `'${priority}' must be required information`);
  }
  assert.ok(plan.requiredInformation.includes("candidate models"), "stated information stays first");
  assert.equal(plan.archetype.name, "model-fit");

  // Explicit archetype resolves the same way.
  const explicit = planScreen({
    primaryDecision: "select a model",
    archetype: "model-fit",
    availableInformation: [],
  });
  assert.ok(explicit.requiredInformation.includes("fit verdict"));
});

test("buildPlan echoes the archetype and required information", () => {
  const out = buildPlan({ archetype: "model-fit", availableInformation: ["a"] });
  assert.equal(out.archetype.name, "model-fit");
  for (const priority of ["fit verdict", "requires vs available", "recommended config", "run action"]) {
    assert.ok(out.requiredInformation.includes(priority), `'${priority}' must be in the response`);
  }
  assert.ok(
    out.warnings.some((w) => /manual shard dragging/.test(w)),
    "anti-patterns must still surface as warnings",
  );
});

/* -------------------------------------------------------------------------- */
/* Runtime states                                                              */
/* -------------------------------------------------------------------------- */

test("deploy plans carry the deployment runtime states", () => {
  const plan = planScreen({ primaryDecision: "Choose a model deployment that fits the discovered compute cluster." });
  const states = plan.artDirection.interactionStates;
  for (const state of [
    "model downloading",
    "model preparing",
    "model fitting",
    "model loading",
    "device unavailable",
    "cluster degraded",
    "validating",
    "ready to launch",
    "selected",
    "focused",
    "empty",
    "error",
  ]) {
    assert.ok(states.includes(state), `'${state}' must be an interaction state for deploy`);
  }
});

/* -------------------------------------------------------------------------- */
/* Action and state intent                                                     */
/* -------------------------------------------------------------------------- */

test("primaryAction intent earns an action region and reaches the response", () => {
  const plan = planScreen({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    primaryAction: "Launch deployment",
    availableInformation: ["candidate models", "cluster memory"],
  });
  const action = plan.regions.find((r) => r.id === "action");
  assert.ok(action, "the commit step needs a region of its own");
  assert.match(action.because, /Launch deployment/);
  assert.match(action.because, /primary action/i);

  const out = buildPlan({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    primaryAction: "Launch deployment",
    states: ["selected", "validating", "cluster degraded"],
    availableInformation: ["candidate models", "cluster memory"],
  });
  assert.equal(out.decision.primaryAction, "Launch deployment");
  assert.deepEqual(out.context.states, ["selected", "validating", "cluster degraded"]);

  // Caller-declared states merge into the interaction states.
  for (const state of ["validating", "cluster degraded"]) {
    assert.ok(out.artDirection.interactionStates.includes(state));
  }
});

test("the plan-completeness signal names an absent primary action, and stays quiet when present", () => {
  const withoutAction = buildPlan({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    availableInformation: ["candidate models"],
  });
  assert.ok(
    withoutAction.warnings.some((w) => /plan-completeness:deploy/.test(w) && /no primary action/.test(w)),
    "a deploy plan without a primary action must say so",
  );

  const withAction = buildPlan({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    primaryAction: "Launch deployment",
    availableInformation: ["candidate models"],
  });
  assert.deepEqual(
    withAction.warnings.filter((w) => w.startsWith("plan-completeness:deploy")),
    [],
    "a complete deploy plan raises no completeness finding",
  );
});

/* -------------------------------------------------------------------------- */
/* The offline regression brief                                                */
/* -------------------------------------------------------------------------- */

test("the exo-deployment-fit offline brief plans cleanly", () => {
  const fixture = EXO_DEPLOYMENT_BRIEFS.find((c) => c.caseId === "exo-deployment-fit");
  assert.ok(fixture, "the brief exists");
  assert.equal(fixture.brief.primaryDecision, "Choose a model deployment that fits the discovered compute cluster.");
  assert.equal(fixture.brief.primaryAction, "Launch deployment");

  const plan = planScreen({
    primaryDecision: fixture.brief.primaryDecision,
    goal: fixture.brief.purpose,
    audience: "operator",
    availableInformation: fixture.brief.requiredInformation,
    visualDirection: fixture.brief.visualDirection,
    states: fixture.brief.states,
    primaryAction: fixture.brief.primaryAction,
  });
  assert.equal(plan.intent.decisionKind, "deploy");

  // No unknown-classified information drift: every required item classifies.
  assert.deepEqual(plan.derivation.unclassified, []);
  const kinds = classifyInformation(fixture.brief.requiredInformation);
  assert.equal(kinds.filter((k) => k.kind === "unknown").length, 0);

  // The brief's required information is in the plan, with the archetype's
  // priorities appended.
  for (const item of fixture.brief.requiredInformation) {
    assert.ok(plan.requiredInformation.includes(item), `'${item}' must be required information`);
  }
  assert.ok(plan.archetype.name, "model-fit");
});

test("the offline brief case stays in sync with its suite case", () => {  const briefIds = EXO_DEPLOYMENT_BRIEFS.map((c) => c.caseId);
  const suiteIds = EXO_DEPLOYMENT_CASES.map((c) => c.id);
  assert.deepEqual(
    briefIds.filter((id) => !suiteIds.includes(id)),
    [],
    "every deployment brief needs a suite case",
  );
  assert.deepEqual(
    suiteIds.filter((id) => !briefIds.includes(id)),
    [],
    "every deployment suite case needs a brief",
  );
  const suiteCase = EXO_DEPLOYMENT_CASES[0];
  assert.equal(suiteCase.decisionKind, "deploy");

  // The frozen v1 lists are untouched.
  assert.equal(OFFLINE_BRIEFS.length, 9);
  assert.equal(BENCHMARKS.length, 9);
  assert.ok(!OFFLINE_BRIEFS.some((c) => c.caseId === "exo-deployment-fit"), "the frozen lists stay frozen");
});

/* -------------------------------------------------------------------------- */
/* The pipeline path                                                           */
/* -------------------------------------------------------------------------- */

test("the pipeline threads archetype priority and states into the plan", async () => {
  const { normalizeBrief } = await import("../mcp-server/dist-test/pipeline/brief.js");
  const { buildCompositionPlan } = await import("../mcp-server/dist-test/pipeline/plan.js");
  const { brief } = normalizeBrief(
    {
      product: "fenek-clusters",
      screen: "Deployment fit",
      purpose: "choose the model deployment that fits the discovered compute cluster and launch it",
      primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
      primaryAction: "Launch deployment",
      requiredInformation: ["candidate models with their memory requirements", "cluster status"],
      states: ["selected", "validating", "cluster degraded"],
      archetype: "model-fit",
      viewport: { width: 1440, height: 900 },
    },
    "brief-test",
  );
  const plan = buildCompositionPlan(brief);

  // The deploy shell regions survive the pipeline intact.
  const ids = plan.regions.map((r) => r.id);
  assert.ok(ids.includes("candidates") && ids.includes("placement"), `deploy regions must survive: ${ids.join(", ")}`);

  // The primary action is an action slot in the header band (established equivalent).
  assert.ok(
    plan.content.some((s) => s.kind === "action" && s.label === "Launch deployment"),
    "the primary action must be planned content",
  );

  // Archetype priority items become planned, required content.
  for (const priority of ["fit verdict", "requires vs available", "recommended config", "run action"]) {
    const slot = plan.content.find((s) => s.label === priority);
    assert.ok(slot, `'${priority}' must be planned content`);
    assert.match(slot.because, /Required for the decision/, `'${priority}' must be planned as required information`);
  }

  // Caller-declared states merge into the plan's interaction states.
  for (const state of ["validating", "cluster degraded"]) {
    assert.ok(plan.artDirection.interactionStates.includes(state), `'${state}' must be an interaction state`);
  }
});

/* -------------------------------------------------------------------------- */
/* Regression: existing classifications do not move                            */
/* -------------------------------------------------------------------------- */

test("existing decisions still classify exactly as before", () => {
  assert.equal(classifyDecision("which pressured resource needs attention"), "topology");
  assert.equal(classifyDecision("does this model fit the device"), "inspect");
  assert.equal(classifyDecision("approve this policy"), "inspect");
  assert.equal(classifyDecision("select a model"), "select");
  assert.equal(classifyDecision("compare model run cost, latency, quality, and fit before choosing what to run"), "compare");
  assert.equal(classifyDecision("monitor cluster health"), "monitor");
  assert.equal(classifyDecision("provision a new machine"), "author");
  assert.equal(classifyDecision("which incident needs follow-up first"), "select");
});

test("the nine frozen offline briefs still classify exactly as before", () => {
  const expected = {
    "exo-compute-topology": "topology",
    "exo-model-detail": "inspect",
    "exo-runtime-monitoring": "monitor",
    "exo-configuration": "inspect",
    "exo-enterprise-workspace": "inspect",
    "generic-saas-dashboard": "topology",
    "data-heavy-workspace": "select",
    "spatial-relationship": "explore",
    "editorial-product-page": "inspect",
  };
  for (const fixture of OFFLINE_BRIEFS) {
    const kind = classifyDecision(fixture.brief.primaryDecision);
    assert.equal(kind, expected[fixture.caseId], `${fixture.caseId} classification must not move`);
  }
});

/* -------------------------------------------------------------------------- */
/* The live-pipeline geometry regression (issue #25, second leg)               */
/* -------------------------------------------------------------------------- */

test("the exact EXO brief plans clean geometry end-to-end in the pipeline", async () => {
  // The live plan-mode run produced the right deployment composition but the
  // compile refused: the header grew to fit its content, the fill regions
  // below slid down, and the canvas-fit pass refused to shrink fills — the
  // placement inspector spilled to (290,736) 184 tall on a 1440x900 canvas.
  // The pipeline leg must come back applicable with no failing checks.
  const { designPipelineTool } = await import("../mcp-server/dist-test/pipeline/tools.js");
  const response = await designPipelineTool(null, null, {
    brief: {
      product: "EXO",
      screen: "Deployment fit",
      purpose: "choose the model deployment that fits the discovered compute cluster and launch it",
      primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
      primaryAction: "Launch deployment",
      requiredInformation: [
        "the discovered machines and their memory",
        "memory each model requires",
        "the automatic placement recommendation",
        "the fit verdict for the selected model",
        "launch prerequisites and validation",
      ],
      states: ["selected", "validating", "cluster degraded", "launch disabled until validation passes"],
      audience: "operator",
      visualDirection: "technical-editorial",
      dataMode: "demo",
      viewport: { width: 1440, height: 900 },
    },
    mode: "plan",
  });
  const checks = response.report?.structurallyVerified?.checks ?? [];
  const failed = checks.filter((c) => c.status === "fail");
  assert.deepEqual(
    failed.map((c) => c.id),
    [],
    `no structural check may fail for the deployment brief, got: ${JSON.stringify(failed.map((c) => `${c.id}: ${c.detail}`))}`,
  );
  const applicable = checks.find((c) => c.id === "applicable");
  assert.ok(!applicable || applicable.status !== "fail", `the program must resolve to a buildable screen, got: ${JSON.stringify(applicable)}`);
  assert.equal(checks.find((c) => c.id === "compiled-geometry")?.status, "pass", "the compiled geometry must agree with the canvas");
});
