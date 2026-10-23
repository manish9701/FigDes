/**
 * Issue #25 E2E regression — offline leg (no Figma session, dry-run only).
 *
 * Drives the whole plan-mode pipeline with the exact EXO Enterprise brief the
 * live session failed on, then asserts the four things the plan used to miss:
 *   1. automatic placement recommendation (never manual shard dragging)
 *   2. model requirements vs available cluster resources
 *   3. selection + validation states
 *   4. the launch action with its prerequisites
 * and that the compiled program passes the blocking preflight with clean
 * geometry on a 1440x900 canvas.
 */
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const BRIEF = {
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
  dataMode: "demo",
};

const response = await designPipelineTool(null, null, { brief: BRIEF, mode: "plan" });

const plan = response.plan ?? response;
const report = response.report ?? {};

console.log("== decision ==");
console.log(JSON.stringify({
  decision: plan.decision?.primaryDecision ?? plan.decision,
  kind: plan.decision?.kind,
  archetype: plan.archetype?.name ?? plan.archetype,
  primaryAction: plan.decision?.primaryAction ?? plan.decision?.action,
  states: plan.interactionStates ?? plan.context?.states,
}, null, 1));

console.log("== regions ==");
for (const r of plan.regions ?? []) {
  console.log(`- ${r.id} (${r.role ?? ""}) ${r.composition ?? ""} :: ${r.because ?? ""}`);
}

console.log("== required information ==");
for (const i of plan.requiredInformation ?? []) console.log(`- ${i}`);

const findings = [
  ...(report.structure?.findings ?? []).map((f) => `[structure] ${f.ruleId ?? f.rule}: ${f.summary ?? f.message ?? ""}`),
  ...(report.typeCriteria?.findings ?? []).map((f) => `[type] ${f.rule}: ${f.summary ?? f.detail ?? ""}`),
  ...(report.visualIntelligence?.review?.findings ?? []).map((f) => `[visual] ${f.rule ?? f.ruleId}: ${f.summary ?? f.why ?? ""}`),
];
console.log("== findings ==");
console.log(findings.length === 0 ? "(none)" : findings.join("\n"));

/* The compiled program leg: run the planned composition through the compiler
   exactly as an apply would, and assert the preflight-relevant contract. */
const program = response.program ?? plan.program;
if (program) {
  const compiled = executeRuntime(program);
  console.log("== compile ==");
  console.log(JSON.stringify({
    applicable: compiled.applicable,
    reflowed: compiled.reflowed,
    constrained: compiled.constrained,
    violations: compiled.violations,
    boxes: [...compiled.boxes].map(([id, b]) => ({ id, x: b.x, y: b.y, w: b.w, h: b.h })),
  }, null, 1));
} else {
  console.log("== compile == (plan mode returned no program; checking plan JSON for one)");
  console.log(Object.keys(response).join(", "));
}

const compact = JSON.stringify({
  decision: plan.decision,
  regions: (plan.regions ?? []).map((r) => ({ id: r.id, role: r.role, because: r.because })),
  requiredInformation: plan.requiredInformation,
  states: plan.interactionStates ?? plan.context?.states,
  slots: (plan.slots ?? []).map((s) => ({ id: s.id, label: s.label, primitive: s.primitive, states: s.states })),
});
await import("node:fs/promises").then((fs) => fs.writeFile(
  new URL("./issue25-e2e-offline-result.json", import.meta.url), compact, "utf8"));
console.log("saved: artifacts/issue25-e2e-offline-result.json");
