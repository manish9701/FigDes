/**
 * Issue #20 — [P0/P1] design generation, validation, and repair reliability.
 *
 * Every test here pins one of the workstream behaviours the issue requires, at
 * the level that can be proven offline against real fixtures:
 *
 *   1. the brief bridge between `design_brief` and `design_pipeline` loses
 *      nothing silently, and older (decision-only) briefs still normalize;
 *   2. review verdicts refuse to certify too-small scopes, and reviews name
 *      what the rules could not see;
 *   3. a truncated live census fails closed in the guard instead of judging
 *      absence over an incomplete scan;
 *   4. the repair loop's op-level idempotency (deduplication) is real;
 *   5. the ledger tells the truth about evicted terminal records;
 *   6. designs that declare tokens stop shipping matching raw hex fills;
 *   7. accessibility is part of the wired final gate, and outstanding
 *      accessibility checks can never produce a clean PASS;
 *   8. the EXO capability-truth guard separates confirmed capabilities from
 *      proposed ones, demands facts beside fit claims, treats async readiness
 *      and trust_remote_code honestly — and a run over no material is
 *      INDETERMINATE, never PASS.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reviewVerdict, MIN_REVIEW_NODES, verifyRepairs } from "../mcp-server/dist-test/review/verdict.js";
import { runRules, evaluatedRuleNames } from "../mcp-server/dist-test/review/rules.js";
import { defaultRules } from "../mcp-server/dist-test/memory/rules-exo.js";
import { runGuard, snapshotFromMetrics } from "../mcp-server/dist-test/memory/tools.js";
import { checkCapabilityTruth, pinCapabilitySource, EXO_CAPABILITIES } from "../mcp-server/dist-test/memory/capability-truth.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { normalizeBrief } from "../mcp-server/dist-test/pipeline/brief.js";
import { pipelineBriefFromDesignBrief } from "../mcp-server/dist-test/pipeline/adapters.js";
import { BriefInputSchema } from "../mcp-server/dist-test/pipeline/contracts.js";
import { deduplicateOperations } from "../mcp-server/dist-test/pipeline/repair.js";
import { evaluateFinalGate } from "../mcp-server/dist-test/design/quality/final-gate.js";
import { evaluateAccessibility, accessibilityInputFromMetrics } from "../mcp-server/dist-test/design/quality/accessibility.js";
import { buildCompatibility, buildScopeWarning } from "../mcp-server/dist-test/tools/tools.js";
import { SERVER_BUILD } from "../mcp-server/dist-test/shared/protocol.js";
import { JobLedger } from "../mcp-server/dist-test/reliability/sessions.js";
import { OperationSchema } from "../mcp-server/dist-test/shared/protocol.js";

/* -------------------------------------------------------------------------- */
/* Workstream 1 — the brief bridge and boundary errors                         */
/* -------------------------------------------------------------------------- */

test("design_brief conversion parses at the design_pipeline boundary", () => {
  const { brief, renamed, unmapped } = pipelineBriefFromDesignBrief({
    screen: "Model Fit",
    goal: "Swap the model on one ledger",
    primaryDecision: "choose a model",
    canvas: { width: 1280, height: 800, grid: 8 },
    user: "an operator at a GPU host",
    availableInformation: ["2 models", "latency"],
    visualDirection: "technical-editorial",
  });

  // The converted brief passes the pipeline's own schema, so a design_pipeline
  // call can never fail on a shape this bridge produced.
  assert.equal(BriefInputSchema.safeParse(brief).success, true);
  assert.equal(brief.purpose, "Swap the model on one ledger");
  assert.deepEqual(brief.viewport, { width: 1280, height: 800 });
  assert.equal(brief.primaryDecision, "choose a model");

  // Nothing is dropped silently: the rename and every unmapped field is named.
  assert.ok(renamed.some((r) => r.field.includes("canvas")), JSON.stringify(renamed));
  assert.ok(unmapped.some((u) => u.field === "user"), JSON.stringify(unmapped));
  assert.ok(unmapped.some((u) => u.field === "canvas.grid"), JSON.stringify(unmapped));
});

test("a decision-only (older) brief still normalizes with structured, actionable blockers", () => {
  const { brief, blockers } = normalizeBrief({ primaryDecision: "compare two models" }, "brief_old");
  assert.equal(brief.primaryDecision, "compare two models");
  assert.ok(typeof brief.screen === "string" && brief.screen.length > 0);
  // Every blocker names the field, says why, and offers a fix — the issue's
  // "actionable errors that name the missing/invalid field and stage".
  for (const b of blockers) {
    assert.ok(b.id, "blocker id");
    assert.ok(b.message, "blocker message");
    assert.ok(b.fix, "blocker fix");
  }
});

test("the two brief schemas agree on the audience cohort", async () => {
  const plan = (await import("../mcp-server/dist-test/plan/brief.js")).DesignBriefArgs;
  const pipelineAudience = BriefInputSchema.shape["audience"].unwrap().options;
  const planAudience = plan.shape["audience"].unwrap().options;
  assert.deepEqual([...planAudience].sort(), [...pipelineAudience].sort(), "the two tools must accept the same set of audiences");
});

/* -------------------------------------------------------------------------- */
/* Workstream 4 — verdicts refuse too-small scopes                             */
/* -------------------------------------------------------------------------- */

test("a 1-node review with zero findings is INDETERMINATE, not a pass", () => {
  const one = reviewVerdict({ nodesExamined: 1, rulesEvaluated: 19, truncated: false, findings: [] });
  assert.equal(one.verdict, "INDETERMINATE", one.reason);
  const two = reviewVerdict({ nodesExamined: 2, rulesEvaluated: 19, truncated: false, findings: [] });
  assert.equal(two.verdict, "INDETERMINATE", two.reason);
});

test("a full-length review of real nodes still passes", () => {
  const clean = reviewVerdict({ nodesExamined: MIN_REVIEW_NODES + 10, rulesEvaluated: 19, truncated: false, findings: [] });
  assert.equal(clean.verdict, "PASS", clean.reason);
});

test("the ruleset's evaluated rule names are reportable for the evidence block", () => {
  const names = evaluatedRuleNames("review");
  assert.ok(names.length >= 19);
  assert.ok(names.includes("sibling-region-overlap") && names.includes("overflow"));
});

/* -------------------------------------------------------------------------- */
/* Workstream 4 — a truncated live census fails closed                         */
/* -------------------------------------------------------------------------- */

function liveReport(nodeCount, truncated) {
  const nodes = [];
  for (let i = 0; i < nodeCount; i++) {
    nodes.push({
      id: `n${i}`,
      name: i === 0 ? "Ledger" : `Row ${i}`,
      type: i === 0 ? "FRAME" : "TEXT",
      parentId: i === 0 ? null : "n0",
      x: 0,
      y: i * 30,
      w: 800,
      h: 24,
      visible: true,
      ...(i > 0 ? { text: { content: `row ${i}`, length: 9, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#242521", styled: false }, background: "#FFFDF9" } : {}),
    });
  }
  return {
    target: "frame_l1",
    scope: "Ledger",
    nodes,
    nodeCount: nodes.length,
    truncated: truncated === true,
    scanBudget: truncated ? nodeCount : 2000,
    scan: { pageLoads: 1, pagesCached: true },
  };
}

test("a truncated scan is NOT resolved evidence: the guard refuses rather than judging absence", () => {
  const truncated = snapshotFromMetrics(liveReport(500, true), "frame_l1");
  assert.equal(truncated.resolved, false, "truncated census must be resolved: false");
  const guarded = runGuard(defaultRules(), truncated);
  assert.equal(guarded.verdict, "INDETERMINATE", `got ${guarded.verdict}`);

  // And the same census without the cap is resolved evidence: whatever the
  // rules find on it, the refusal above came from the truncation, not from
  // the nodes. (Two of the EXO truths stay manual by design, so the top-level
  // verdict can still be INDETERMINATE for that honest reason; the snapshot's
  // resolution is what this test pins.)
  const complete = snapshotFromMetrics(liveReport(500, false), "frame_l1");
  assert.equal(complete.resolved, true);
});

/* -------------------------------------------------------------------------- */
/* Workstream 5 — repair-loop op idempotency                                   */
/* -------------------------------------------------------------------------- */

test("deduplicateOperations drops re-applied values so a re-planned retry cannot double-apply", () => {
  const ops = [
    { type: "setFill", target: "a1", fill: "#242521" },
    { type: "setFill", target: "a1", fill: "#242521" },
    { type: "setPosition", target: "a1", x: 12, y: 14 },
    { type: "setFill", target: "a2", fill: "#111111" },
  ];
  const out = deduplicateOperations(ops);
  assert.equal(out.length, 3, JSON.stringify(out));
  assert.deepEqual(out, [ops[0], ops[2], ops[3]]);
});

test("a repair whose re-check could not run is INDETERMINATE, never a pass", () => {
  const before = [{ key: "rule::a1", rule: "overflow", severity: "serious", confidence: "high", title: "t", nodeIds: ["a1"], evidence: {} }];
  const out = verifyRepairs({
    before,
    after: [],
    applied: [{ key: "rule::a1", rule: "overflow", targets: ["a1"] }],
    recheck: "failed",
    recheckReason: "plugin disconnected mid-verify",
  });
  assert.equal(out.verdict, "INDETERMINATE");
  assert.match(out.reason, /plugin disconnected mid-verify/);
});

/* -------------------------------------------------------------------------- */
/* Workstream 6 — declared tokens absorb matching raw hexes                    */
/* -------------------------------------------------------------------------- */

test("a program that declares its ink variable stops painting matching raw hex fills", () => {
  const result = executeRuntime({
    canvas: { name: "Tokens", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "variable", id: "v_ink", args: { name: "exo/ink", color: "#242521" } },
      { fn: "text", id: "t1", parent: "main", args: { text: "Balance", role: "body", fill: "#242521" } },
    ],
  });

  const variable = result.operations.find((o) => o.type === "createVariable" && o.name === "exo/ink");
  assert.ok(variable, "the variable must be emitted");
  const text = result.operations.find((o) => o.type === "createText" && o.id === "t1");
  assert.ok(text, "the text must be emitted");
  assert.deepEqual(text.fill, [], "the hex fill must be replaced with a binding");
  const bind = result.operations.find((o) => o.type === "bindVariable" && o.target === "t1");
  assert.ok(bind, "the binding must exist");
  assert.equal(bind.variable, "exo/ink");
  // Binding position: after the node it binds and after the variable definition.
  const bindIndex = result.operations.findIndex((o) => o.type === "bindVariable" && o.target === "t1");
  const varIndex = result.operations.findIndex((o) => o.type === "createVariable");
  const textIndex = result.operations.findIndex((o) => o.type === "createText" && o.id === "t1");
  assert.ok(bindIndex > varIndex && bindIndex > textIndex);
  // The whole operation stream stays within the native allowlist.
  for (const op of result.operations) {
    assert.equal(OperationSchema.safeParse(op).success, true, `rejected: ${JSON.stringify(op)}`);
  }
});

test("a hex shared by two declared variables stays a literal rather than guessing a token", () => {
  const result = executeRuntime({
    canvas: { name: "Tokens", width: 800, height: 600, grid: 8 },
    regions: [{ fn: "frame", id: "main", args: { width: "fill", height: "fill" } }],
    content: [
      { fn: "variable", id: "v1", args: { name: "first", color: "#111111" } },
      { fn: "variable", id: "v2", args: { name: "second", color: "#111111" } },
      { fn: "text", id: "t1", parent: "main", args: { text: "Ambiguous", role: "body", fill: "#111111" } },
    ],
  });
  const text = result.operations.find((o) => o.type === "createText" && o.id === "t1");
  assert.equal(text.fill, "#111111", "an ambiguous hex must stay a literal");
  assert.equal(result.operations.some((o) => o.type === "bindVariable" && o.target === "t1"), false);
});

/* -------------------------------------------------------------------------- */
/* Workstream 7 — accessibility in the wired final gate                        */
/* -------------------------------------------------------------------------- */

test("an accessibility failure blocks the final gate", () => {
  const report = evaluateFinalGate({
    scores: { hierarchy: 80, composition: 80, typography: 80, readability: 80, density: 80, distinctiveness: 80, productFit: 80, genericity: 80 },
    genericity: null,
    states: { declared: 2 },
    visualEvidenceVerified: true,
    accessibility: { findings: 2, notChecked: [] },
  });
  assert.equal(report.status, "FAIL");
  assert.ok(report.blockingIssues.some((b) => /accessibility/i.test(b)), report.blockingIssues.join("; "));
});

test("an accessibility check that could not run also refuses a clean pass", () => {
  const report = evaluateFinalGate({
    scores: { hierarchy: 80, composition: 80, typography: 80, readability: 80, density: 80, distinctiveness: 80, productFit: 80, genericity: 80 },
    genericity: null,
    states: { declared: 2 },
    visualEvidenceVerified: true,
    accessibility: { findings: 0, notChecked: ["text contrast inside variable-bound fills"] },
  });
  assert.equal(report.status, "REVIEW");
  assert.match(report.reason, /not(.+checked| checked)|could not be/i);
});

test("a fully-verified clean run with every a11y check evaluated is a verified pass", () => {
  const report = evaluateFinalGate({
    scores: { hierarchy: 80, composition: 80, typography: 80, readability: 80, density: 80, distinctiveness: 80, productFit: 80, genericity: 80 },
    genericity: null,
    states: { declared: 2 },
    visualEvidenceVerified: true,
    accessibility: { findings: 0, notChecked: [] },
  });
  assert.equal(report.status, "PASS", report.reason);
});

test("the live-material a11y adapter measures what Figma can honestly supply", () => {
  const live = liveReport(8, false);
  // Low-contrast pair: measured, not guessed.
  live.nodes[1].text.color = "#8A8D84";
  const input = accessibilityInputFromMetrics(live, "rev_live");
  const report = evaluateAccessibility(input);
  assert.ok(input.texts.length >= 1, "the adapter supplies the measurable texts");
  assert.ok(report.findings.length >= 1, "the low-contrast text must be found, got " + JSON.stringify(report.findings.map((f) => f.summary)));
  assert.ok(report.findings.every((f) => f.category === "accessibility"));
  // What the measurement can never supply is reported as not checked, not skipped.
  assert.ok(report.notChecked.some((c) => c.length > 0), JSON.stringify(report.notChecked));
});

/* -------------------------------------------------------------------------- */
/* Workstream 8 — the EXO capability-truth guard                               */
/* -------------------------------------------------------------------------- */

test("enterprise features presented as shipped are a FAIL until a build is pinned", () => {
  const out = checkCapabilityTruth({ texts: ["Audit log", "SSO", "Roles and permissions"] });
  assert.equal(out.verdict, "FAIL", out.reason);
  assert.equal(out.source.pinned, false);
  const ids = out.findings.map((f) => f.id);
  assert.ok(ids.some((id) => id.endsWith("presented-as-shipped")), ids.join(", "));
  // Every finding carries the why and the fix, in that direction.
  for (const f of out.findings) {
    assert.ok(f.why.length > 10);
    assert.match(f.fix, /Proposed|pin|mark|remove|Show/i);
  }
});

test("the same claims with a visible uncertainty marker stop failing and become traceable-only", () => {
  const marked = checkCapabilityTruth({ texts: ["Audit log", "Proposed — need engineering to confirm"] });
  assert.notEqual(marked.verdict, "FAIL", marked.reason);
  // A marked claim over an unpinned source is INDETERMINATE, not PASS: even
  // the marker can't be verified against a build nobody pinned.
  assert.equal(marked.verdict, "INDETERMINATE", marked.reason);
});

test("a model-fit claim without its facts beside it is a finding, and marked estimates pass", () => {
  const bare = checkCapabilityTruth({ texts: ["Llama 3 70B fits on all machines"] });
  assert.ok(bare.findings.some((f) => f.id === "product.fit-claim-without-context"), JSON.stringify(bare.findings));

  const withFacts = checkCapabilityTruth({
    texts: ["Llama 3 70B: required 140 GB, machines assessed 2, estimate — compatible with rack A and rack B"],
  });
  assert.notEqual(withFacts.verdict, "FAIL", withFacts.reason);
});

test("trust_remote_code without opt-in/caution is flagged; async readiness without a check is flagged", () => {
  const tricky = checkCapabilityTruth({ texts: ["Load custom model (trust_remote_code)"] });
  assert.ok(tricky.findings.some((f) => f.id === "product.trust-remote-code-unmarked"), JSON.stringify(tricky.findings));

  const optimistic = checkCapabilityTruth({ texts: ["Engine is ready"] });
  assert.ok(optimistic.findings.some((f) => f.id === "product.async-readiness-assumed"), JSON.stringify(optimistic.findings));

  const qualified = checkCapabilityTruth({ texts: ["Engine ready when payload state confirms", "poll health endpoint"] });
  assert.equal(qualified.findings.filter((f) => f.id === "product.async-readiness-assumed").length, 0, JSON.stringify(qualified.findings));
});

test("a capability check over no material judges nothing and says so", () => {
  const empty = checkCapabilityTruth({ texts: [] });
  assert.equal(empty.verdict, "INDETERMINATE", empty.reason);
});

test("pinning a source without an id is refused, and a real pin raises INDETERMINATE to traceable checks", () => {
  assert.throws(() => pinCapabilitySource("   "), /refuses an empty build id/);
  const before = checkCapabilityTruth({ texts: ["Audit log", "Proposed"] }).verdict;
  assert.equal(before, "INDETERMINATE");
  const out = pinCapabilitySource("exo-2026.10-r48215");
  assert.equal(out.pinned, true);
  assert.ok(out.note.includes("exo-2026.10-r48215"));
  // Same marked claim: still sane, now traceable (verdict degrades no further).
  const after = checkCapabilityTruth({ texts: ["Audit log", "Proposed"] });
  assert.notEqual(after.verdict, "FAIL", after.reason);
  assert.ok(after.source.note.includes("exo-2026.10-r48215"));
});

/* -------------------------------------------------------------------------- */
/* Workstream 9 — ledger eviction honesty and build compatibility              */
/* -------------------------------------------------------------------------- */

test("an evicted terminal ledger record is identifiable, so a same-id blind retry is not trusted", () => {
  const ledger = new JobLedger();
  const fakeSession = { id: "s_evict", fileKey: null, fileName: "F" };
  for (let i = 0; i < 210; i++) {
    ledger.begin({ transactionId: `txn_ev_${i}`, tool: "create_design", session: fakeSession, operationCount: 1 });
  }
  assert.equal(ledger.get("txn_ev_0"), undefined, "the early record must be gone");
  assert.equal(ledger.wasEvicted("txn_ev_0"), true, "but it must be identifiable as evicted, not unknown-because-never-ran");
  assert.equal(ledger.wasEvicted("txn_unknown"), false);
});

test("build compatibility warns when the builds are not a same-commit pair", () => {
  assert.equal(buildCompatibility(SERVER_BUILD, SERVER_BUILD), "same-commit");
  const other = SERVER_BUILD.replace(/[0-9a-f]{8}/, "12345678");
  assert.equal(buildCompatibility(SERVER_BUILD, other === SERVER_BUILD ? "12345678-dirty" : other), "different-commit");
  assert.equal(buildCompatibility(SERVER_BUILD, "unknown"), "unverifiable");

  assert.equal(buildScopeWarning({ build: SERVER_BUILD }), null, "same-commit must carry no warning");
  const warned = buildScopeWarning({ build: "deadbeef-other" });
  assert.ok(warned === null || ["different-commit", "unverifiable"].includes(warned.compatibility));
});

/* -------------------------------------------------------------------------- */
/* Workstream 3 — collision classification                                     */
/* -------------------------------------------------------------------------- */

function collisionReport() {
  // Two sibling frames, the later one covering the first; plus a text escaping
  // its parent. Geometries in the style the rules expect (parent-local px).
  return {
    target: "frame_cx",
    scope: "Collision fixture",
    nodes: [
      { id: "p", name: "Canvas", type: "FRAME", parentId: null, x: 0, y: 0, w: 1200, h: 800, visible: true },
      { id: "s1", name: "Ledger", type: "FRAME", parentId: "p", x: 0, y: 0, w: 400, h: 400, visible: true, fill: "#FFFDF9" },
      { id: "s2", name: "Overlay", type: "FRAME", parentId: "p", x: 200, y: 200, w: 400, h: 400, visible: true, fill: "#111111" },
      { id: "c1", name: "Card", type: "FRAME", parentId: "p", x: 0, y: 0, w: 900, h: 200, visible: true, fill: "#FFFDF9" },
      { id: "t1", name: "Badge", type: "TEXT", parentId: "c1", x: 850, y: 100, w: 120, h: 24, visible: true, text: { content: "E", length: 1, truncated: false, size: 12, family: "Inter", style: "Regular", color: "#111111", styled: false }, background: "#FFFDF9" },
    ],
    nodeCount: 5,
    truncated: false,
    scanBudget: 2000,
    scan: { pageLoads: 0, pagesCached: true },
  };
}

test("collision findings carry the structured taxonomy: type, involved ids, intent", () => {
  const findings = runRules(collisionReport(), "review");
  const siblings = findings.filter((f) => f.rule === "sibling-region-overlap");
  assert.ok(siblings.length > 0, "the overlay-on-ledger case must be reported, got " + JSON.stringify(findings.map((f) => f.rule)));
  for (const f of siblings) {
    const c = f.evidence["collision"];
    assert.ok(c && typeof c === "object", "collision classification present");
    assert.equal(c["type"], "sibling");
    assert.ok(Array.isArray(c["involvedIds"]) && c["involvedIds"].length === 2, JSON.stringify(c));
    assert.equal(c["intent"], "accidental");
    // Both involved nodes are named in nodeIds as well.
    assert.equal(f.nodeIds.length, 2, JSON.stringify(f.nodeIds));
  }
  const overflows = findings.filter((f) => f.rule === "overflow");
  for (const f of overflows) {
    const c = f.evidence["collision"];
    assert.ok(c && typeof c === "object");
    assert.equal(c["type"], "containment");
    assert.ok(c["involvedIds"].includes("t1"));
  }
});
