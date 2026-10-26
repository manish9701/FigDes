/**
 * Project design profiles (GitHub issue #27) — cross-project isolation.
 *
 * The contract under test:
 *   1. Product rules are per-project data. Recording a rule for project A must
 *      be invisible to project B, and recording a profile for B must move
 *      nothing in A (tested in both directions).
 *   2. A project with NO profile plans and guards under general,
 *      domain-neutral defaults: no product states, no product placement
 *      vocabulary, no inferred product archetypes, and a guard run that says
 *      INDETERMINATE with a finding naming the missing profile — never a PASS
 *      borrowed from another product.
 *   3. The product-specific checks still fire when their profile IS active:
 *      explicit `profile: "exo"` makes the EXO truth set veto what it has
 *      always vetoed (the three-card metric wall), and a recorded profile
 *      reaches the guard the same way via project memory.
 *   4. Artefacts are product-agnostic first-class inputs: an editorial page
 *      plans a reading rhythm, a landing page plans a narrative — neither can
 *      fall back to an admin-console shell.
 *
 * All fixtures are offline: no Figma. The memory directory is a fresh temp
 * dir per process, set BEFORE the dist-test modules load (the store binds the
 * directory at import time).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DESIGN_AGENT_MEMORY_DIR = mkdtempSync(join(tmpdir(), "project-profile-test-"));

const { projectMemoryTool, designGuardTool } = await import("../mcp-server/dist-test/memory/tools.js");
const { buildPlan } = await import("../mcp-server/dist-test/plan/tools.js");
const { planScreen, resolveArchetype } = await import("../mcp-server/dist-test/plan/planner.js");

const PROJECT_A = "team-planner";
const PROJECT_B = "beyond-cloud";

const read = async (project) => projectMemoryTool(null, { project });

/* -------------------------------------------------------------------------- */
/* 1. Cross-project isolation                                                  */
/* -------------------------------------------------------------------------- */

test("a rule recorded for project A lives in project A only", async () => {
  const recorded = await projectMemoryTool(null, {
    project: PROJECT_A,
    action: "record",
    rule: {
      id: "illustrations.annotate-readings",
      severity: "warn",
      rule: "A gauge reading shown without its unit of measure is not a readable instrument.",
      therefore: "Pairs the value with its arrow-affecting unit or calls the ambiguous gauge out.",
    },
  });
  assert.equal(recorded.status, "ok");
  assert.ok(recorded.ruleRecorded, "the rule records");

  const a = await read(PROJECT_A);
  assert.equal(a.ruleCount, 1);
  assert.equal(a.rules[0].id, "illustrations.annotate-readings");
});

test("project B reads zero rules: A's rule never crossed the boundary", async () => {
  const b = await read(PROJECT_B);
  assert.equal(b.ruleCount, 0, "project B must not start with another project's rules");
  assert.ok(!b.rules.some((r) => r.id.startsWith("illustrations.")), "A's project rule absent from B's memory file");
  assert.equal(b.profile, null, "B records no profile");
});

test("the reverse direction: B's profile record leaves A untouched", async () => {
  // B explicitly becomes an EXO-profile project. That choice lives in B's
  // memory file alone.
  const recorded = await projectMemoryTool(null, {
    project: PROJECT_B,
    action: "record",
    profile: { product: "exo", domain: "an unrelated tenant that opted into EXO's profile" },
  });
  assert.equal(recorded.profileRecorded.product, "exo");

  const a = await read(PROJECT_A);
  assert.equal(a.profile, null, "recording B's profile cannot push a profile into A");
  assert.equal(a.ruleCount, 1, "A keeps exactly its own recorded rule");

  const b = await read(PROJECT_B);
  assert.equal(b.profile.product, "exo");
  assert.equal(b.ruleCount, 0, "a profile declares which rules apply; it is not itself a stored rule");
});

test("the recorded profile activates the product rules for B, and A stays neutral", async () => {
  // A program that violates an EXO product truth.
  const program = {
    canvas: { name: "Card wall", width: 1440, height: 900, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "metric", id: "m1", parent: "main", args: { label: "GPUs", value: "8" } },
      { fn: "metric", id: "m2", parent: "main", args: { label: "Memory", value: "1.8 TB" } },
      { fn: "metric", id: "m3", parent: "main", args: { label: "Throughput", value: "42" } },
    ],
  };

  const bGuard = await designGuardTool(null, { project: PROJECT_B, program });
  assert.equal(bGuard.rulesSource.product, "exo", "B's recorded profile names the product");
  assert.equal(bGuard.activeProfile.source, "memory", "resolved from what B recorded");
  assert.ok(bGuard.activeProfile.rulesChecked > 0, "the profile's truths are active for B");
  assert.equal(bGuard.verdict, "FAIL", "the metric wall fails the product truth it must not violate");
  assert.ok(
    bGuard.findings.some((f) => f.rule === "exo.no-generic-saas" && f.verdict === "FAIL"),
    "the same EXO check that always ran still runs under a recorded profile",
  );

  const aGuard = await designGuardTool(null, { project: PROJECT_A, program });
  assert.equal(aGuard.rulesSource.product, null, "A resolved no profile");
  assert.ok(!aGuard.findings.some((f) => f.rule.startsWith("exo.")), "no product rule fired");
  assert.equal(aGuard.activeProfile.rulesChecked, 1, "A's active set: exactly its own recorded rule");
});

test("a project whose key names the product seeds that product's truth set", async () => {
  // Key seeding mirrors defaultNotes: 'exo...' IS an exo project as far as
  // the built-in seeds go; an unrelated key seeds nothing.
  const exoKeyed = await read("exo-inventory");
  assert.ok(exoKeyed.ruleCount > 0, "an exo-keyed fresh project opens with its product's rules");
  assert.equal(exoKeyed.profile?.product, "exo");
  const unrelated = await read("inventory");
  assert.equal(unrelated.ruleCount, 0, "an unrelated key seeds nothing");
});

/* -------------------------------------------------------------------------- */
/* 2. Guard honesty when nothing product-specific is active                    */
/* -------------------------------------------------------------------------- */

test("the guard never reports PASS when zero product rules were active", async () => {
  const guard = await designGuardTool(null, {
    project: "no-profile-project",
    program: {
      canvas: { name: "Clean", width: 1440, height: 900, grid: 8 },
      regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
      content: [{ fn: "text", id: "t", parent: "main", args: { text: "Compute", role: "title" } }],
    },
  });

  assert.equal(guard.verdict, "INDETERMINATE", `zero rules cannot read as approval, got ${guard.verdict}`);
  assert.equal(guard.status, "indeterminate", "nothing checked is not a success status");
  const profileFinding = guard.findings.find((f) => f.rule === "profile");
  assert.ok(profileFinding, "the finding names WHY nothing product-specific ran");
  assert.match(profileFinding.nextStep, /profile/);
  assert.equal(guard.activeProfile.source, "none");
  assert.equal(guard.stats.rulesChecked, 0, "zero rules ran, so zero rules are counted");
});

/* -------------------------------------------------------------------------- */
/* 3. The planner under a general project — no product vocabulary leaks        */
/* -------------------------------------------------------------------------- */

test("a general plan takes no product states and no product archetype", () => {
  const plan = planScreen({ primaryDecision: "show network topology", availableInformation: ["nodes"] });

  assert.equal(plan.profile.product, null, "the plan echoes the resolved profile: none");
  assert.equal(plan.profile.ruleCount, 0, "no product rules active for previews");
  assert.ok(!plan.archetype, "archetype inference needs a profile that declares it");
  for (const state of plan.artDirection.interactionStates) {
    assert.ok(!/^model /.test(state) && !/cluster degraded/.test(state), `no product lifecycle state multiplied in: '${state}'`);
  }

  const out = buildPlan({ primaryDecision: "show network topology", availableInformation: ["nodes"] });
  assert.equal(out.designContext.product, "", "a general context carries no product identity");
  assert.doesNotMatch(out.designContext.brief, /EXO/, "EXO's taste does not travel with a general project");
  assert.doesNotMatch(out.designContext.brief, /exo\./, "no product anti-pattern ids either");
});

test("a general deploy plan uses neutral placement vocabulary", () => {
  const plan = planScreen({
    primaryDecision: "roll out the pricing update",
    availableInformation: ["affected plans", "change review"],
  });
  assert.equal(plan.intent.decisionKind, "deploy");
  assert.equal(plan.profile.product, null);

  const placement = plan.regions.find((r) => r.id === "placement");
  assert.ok(placement, "the deploy structure survives — it is a decision shell, not product owned");
  assert.doesNotMatch(placement.because, /shards?/i, "EXO fleet vocabulary does not enter a general project");
  assert.match(placement.because, /what is required against what is available/, "the structural content is still stated");
  for (const principle of plan.artDirection?.compositionPrinciples ?? []) {
    assert.doesNotMatch(principle, /shards?/i, "composition principles are product-neutral under no profile");
  }
});

test("the EXO profile still plans ITS deploy screen", () => {
  const plan = planScreen({
    primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
    availableInformation: ["candidate models", "cluster memory", "machine health"],
    product: "exo",
  });

  assert.equal(plan.profile.product, "exo");
  assert.equal(plan.archetype?.name, "model-fit", "the archetype's inference is profile-scoped, and the profile is active");
  const placement = plan.regions.find((r) => r.id === "placement");
  assert.match(placement.because, /automatic placement|placement is recommended automatically/i, "the placement carry-on still reads as it always did");
  assert.ok(
    plan.artDirection.interactionStates.includes("model fitting"),
    "product runtime states apply under the product's profile",
  );
});

test("product rules veto exactly where they did — no live gate drift", () => {
  // plan.test.mjs pins this inside the EXO suite; here it is depot-checked for
  // a key-less caller: previewRules compile from the resolved rule set only.
  const out = buildPlan({
    primaryDecision: "select a model",
    availableInformation: ["a"],
    profile: "exo",
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
  assert.ok(out.guardPreview.some((g) => g.rule === "exo.no-generic-saas"), "the exo veto fires under its profile");

  const neutral = buildPlan({
    primaryDecision: "select a model",
    availableInformation: ["a"],
    artDirection: { ...out.decision, rejectGenericDashboard: true, compositionType: "field dominates" },
  });
  assert.ok(
    !(neutral.guardPreview ?? []).some((g) => g.rule?.startsWith?.("exo.")),
    "no product veto on a project with no profile",
  );
});

test("the artefact type, not the product, decides the general composition", () => {
  const editorial = buildPlan({ primaryDecision: "launch a deep-dive article", artefact: "editorial" });
  assert.equal(editorial.artefact?.type, "editorial");
  assert.equal(editorial.template.name, "editorial-rhythm");
  const ids = editorial.regions.map((r) => r.id);
  assert.ok(ids.includes("column") && ids.includes("masthead"), "an editorial page plans a reading rhythm, not an admin shell");

  const landing = buildPlan({ primaryDecision: "show what the product does", artefact: "landing" });
  assert.equal(landing.template.name, "landing-narrative");

  const identity = buildPlan({ primaryDecision: "explore the mark", artefact: "identity" });
  assert.equal(identity.template.name, "identity-exploration");
  assert.equal(typeof identity.decision.kind, "string", "the decision still classifies — but the artefact owns the screen");
});

test("archetype inference is undefined for a deploy decision with no profile", () => {
  assert.equal(resolveArchetype("Choose a model deployment that fits the discovered compute cluster."), undefined);
});

/* -------------------------------------------------------------------------- */
/* 7. The pipeline's own profile channel — the end-to-end proof                  */
/* -------------------------------------------------------------------------- */

/**
 * The planner and guard lanes isolate profiles (tests 1–5); this lane proves
 * the full pipeline does too. The same EXO brief runs twice: once WITH the
 * explicit `profile` channel (the final guard must count product rules) and
 * once WITHOUT it (the display name "EXO Labs" is descriptive text now, so
 * the run plans general and the final guard must honestly report zero rules).
 * Everything the stub session is not explicitly handed throws, so the lane
 * can never reach the check by accident.
 */
test("the pipeline's final guard counts product rules only under a resolved profile", async () => {
  const { designPipelineTool } = await import("../mcp-server/dist-test/pipeline/tools.js");
  const { JobLedger } = await import("../mcp-server/dist-test/reliability/sessions.js");

  const metrics = {
    truncated: false,
    nodes: [
      { id: "1:1", x: 0, y: 0, w: 1440, h: 900, name: "Fleet Overview", type: "FRAME" },
      { id: "1:2", x: 24, y: 120, w: 320, h: 48, name: "Cluster A", type: "TEXT", text: { content: "Cluster A" } },
      { id: "1:3", x: 24, y: 180, w: 320, h: 24, name: "Health", type: "TEXT", text: { content: "Degraded" } },
    ],
  };

  const touched = [];
  const session = {
    id: "s27",
    fileKey: "k27",
    fileName: "ProjectProfile.figma",
    notify() {},
    requestIdFor() {
      return "req_27";
    },
    async request(tool /* , payload */) {
      touched.push(tool);
      if (tool === "measure_text") return {};
      if (tool === "extract_design_system") return {};
      if (tool === "create_design") {
        return { status: "success", transactionId: "txn_27", dryRun: false, createdNodes: [{ temporaryId: "root", figmaNodeId: "1:1" }], applied: [] };
      }
      if (tool === "collect_metrics") return metrics;
      throw new Error(`must not contact Figma tool '${tool}' on the profile lane`);
    },
  };
  const registry = { jobs: new JobLedger() };

  const briefLeg = (briefExtra) => ({
    brief: {
      product: "EXO Labs",
      screen: "Fleet Overview",
      purpose: "See the health of the fleet and decide where to intervene",
      primaryDecision: "monitor fleet health and decide where to intervene",
      primaryAction: "Open cluster",
      requiredInformation: ["cluster health", "GPU memory"],
      visualDirection: "technical-instrument",
      ...briefExtra,
    },
  });

  const guardOf = (result) => result.trace?.checks?.find((c) => c.id === "product-guard-final");

  const withProfile = await designPipelineTool(session, registry, briefLeg({ profile: "exo" }));
  const guardedCheck = guardOf(withProfile);
  assert.ok(guardedCheck, `an EXO-profile run must reach its final guard; trace stages ran: ${(withProfile.trace?.stages ?? []).map((s) => s.stage).join(", ")}`);
  assert.match(guardedCheck.detail, /\b[1-9]\d* rule/, `the profile resolves rules: ${guardedCheck.detail}`);

  const withoutProfile = await designPipelineTool(session, registry, briefLeg({}));
  const generalCheck = guardOf(withoutProfile);
  assert.ok(generalCheck, "a general run still records its final guard");
  assert.match(generalCheck.detail, /\b0 rule/, `the unresolved display name stays general: ${generalCheck.detail}`);
});
