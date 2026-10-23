/**
 * Issue #25 live-pipeline geometry reproduction.
 * The live plan-mode run (audience operator + visualDirection technical-editorial)
 * reported: placement spills past the canvas bottom at (290,736) 360x184, while
 * the plan said (272,686) 360x306. Trace where the two geometries diverge.
 */
import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { executeRuntime } from "../mcp-server/dist-test/runtime/interpreter.js";

const BRIEF = {
  product: "EXO",
  screen: "Issue 25 E2E · Deployment fit",
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
};

const r = await designPipelineTool(null, null, { brief: BRIEF, mode: "plan" });
const plan = r.plan;
console.log("== plan regions (planned geometry) ==");
for (const g of plan.regions) console.log(JSON.stringify({ id: g.id, x: g.x, y: g.y, w: g.w, h: g.h, grow: g.grow, height: g.height, width: g.width }));

console.log("== program regions ==");
const program = r.program;
if (!program) { console.log("no program:", Object.keys(r).join(",")); process.exit(0); }
for (const g of program.regions ?? []) console.log(JSON.stringify(g));

const compiled = executeRuntime(program);
console.log("== compiled boxes ==");
for (const [id, b] of compiled.boxes) console.log(id, `x:${b.x}`, `y:${b.y}`, `w:${b.w}`, `h:${b.h}`, `height:${b.height}`);
console.log("applicable:", compiled.applicable, "reflowed:", compiled.reflowed, "constrained:", compiled.constrained);
for (const v of compiled.violations) console.log("V:", v.rule, "|", v.message.slice(0, 160));

console.log("== structure findings (pipeline) ==");
const checks = r.report?.structurallyVerified?.checks ?? [];
for (const c of checks.filter(c => c.status !== "pass")) console.log(`[${c.status}] ${c.id}: ${c.detail}`);
