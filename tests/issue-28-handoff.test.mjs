/**
 * Issue #28 — the composition handoff.
 *
 * plan_screen resolves a composition model; the runtime resolves geometry.
 * The build is measured against the plan, and a build that comes out as a
 * *different* composition is refused — not shipped silently.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";
import { deriveCompositionContract, verifyCompositionHandoff } from "../mcp-server/dist-test/runtime/handoff.js";
import { planScreenTool } from "../mcp-server/dist-test/plan/tools.js";

const decision = {
  primaryDecision: "Choose the model to deploy onto the discovered cluster",
  availableInformation: ["model size", "cluster memory", "placement recommendation"],
};

test("a faithful build passes the handoff", async () => {
  const plan = await planScreenTool(null, decision);
  assert.ok(plan.compositionContract, "plan_screen carries the composition contract");
  const built = executeRuntime(plan.program);
  assert.equal(built.compositionHandoff?.status, "pass");
  assert.equal(built.applicable, true);
});

test("dropping a planned region fails the handoff and refuses the build", async () => {
  const plan = await planScreenTool(null, decision);
  const program = structuredClone(plan.program);
  program.regions = program.regions.filter((r) => r.id !== "placement");
  const built = executeRuntime(program);
  assert.equal(built.compositionHandoff?.status, "fail");
  assert.equal(built.applicable, false);
  const missing = built.compositionHandoff.findings.find((f) => f.rule === "region-missing");
  assert.ok(missing && missing.severity === "blocking");
  assert.ok(built.inapplicableReasons.some((r) => r.includes("placement")));
});

test("moving the inspector above the content breaks arrangement", async () => {
  const plan = await planScreenTool(null, decision);
  const program = structuredClone(plan.program);
  const idx = program.regions.findIndex((r) => r.id === "placement");
  const [moved] = program.regions.splice(idx, 1);
  program.regions.splice(1, 0, moved);
  const built = executeRuntime(program);
  assert.equal(built.compositionHandoff?.status, "fail");
  assert.equal(built.applicable, false);
  assert.ok(built.compositionHandoff.findings.some((f) => f.rule === "arrangement-changed" && f.severity === "blocking"));
});

test("the inspector taking the canvas breaks hierarchy", async () => {
  const plan = await planScreenTool(null, decision);
  const program = structuredClone(plan.program);
  for (const r of program.regions) {
    if (r.id === "placement") { r.args.width = "fill"; r.args.grow = 3; }
    if (r.id === "candidates") { r.args.width = 360; r.args.grow = 0; }
  }
  const built = executeRuntime(program);
  assert.equal(built.compositionHandoff?.status, "fail");
  assert.ok(built.compositionHandoff.findings.some((f) => f.rule === "hierarchy-inverted"));
});

test("legitimate content growth keeps the composition", async () => {
  const plan = await planScreenTool(null, decision);
  const program = structuredClone(plan.program);
  program.content = [
    { fn: "text", id: "t1", parent: "candidates", args: { text: "A very long row of candidate deployments that needs to wrap several times over", role: "body" } },
    { fn: "text", id: "t2", parent: "header", args: { text: "Choose the model to deploy", role: "title" } },
  ];
  const built = executeRuntime(program);
  assert.notEqual(built.compositionHandoff?.status, "fail");
  assert.equal(built.applicable, true);
});

test("a raw program with no plan reports unchecked, not pass", () => {
  const built = executeRuntime({
    canvas: { width: 1440, height: 900 },
    regions: [{ fn: "frame", id: "a", args: { width: "fill", height: "fill" } }],
  });
  assert.equal(built.compositionHandoff?.status, "unchecked");
  assert.equal(built.applicable, true);
});

test("content placed in the wrong region breaks containment", () => {
  const contract = deriveCompositionContract({
    canvas: { width: 1440, height: 900 },
    regions: [{ id: "content", role: "content", bounds: { x: 272, y: 104, w: 800, h: 400 } }],
    hierarchy: [{ rank: 1, id: "content" }],
    focal: { id: "content" },
    content: [{ id: "t1", regionId: "content" }],
    source: "test",
  });
  assert.ok(contract);
  const resolved = {
    canvas: { width: 1440, height: 900 },
    regions: [{ id: "content", role: "content", composition: "table", x: 272, y: 104, w: 800, h: 400 }],
    content: [{ id: "t1", parent: "nav", x: 0, y: 0, w: 100, h: 20 }],
  };
  const receipt = verifyCompositionHandoff(contract, resolved);
  assert.equal(receipt.status, "fail");
  assert.ok(receipt.findings.some((f) => f.rule === "containment-broken" && f.severity === "blocking"));
});
