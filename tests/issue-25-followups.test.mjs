/**
 * Issue #25 Phase B follow-ups — three defects from the live stress pass,
 * each fixed at the layer that owns it:
 *
 *   1. THE STATE PILL CONTRADICTED THE BRIEF'S VALUE. The EXO Labs "Cluster
 *      Routing" brief declares states ["ready","degraded","offline"] and a
 *      required-information value { "cluster health": "Degraded" }. The
 *      rendered screen showed ONE pill labelled "ready" in a reddish tone —
 *      the state strip's first state, expanded by the runtime's
 *      interaction-state expansion (interpreter.ts) whose statusPill table
 *      skips 'ready'/'degraded' as unrecognized and carries the strip's base
 *      label onto the one survivor ('offline' → error tone) — while the
 *      brief's actual value "Degraded" never appeared. The pipeline now
 *      builds the CURRENT status as the value pill: the statusPill call
 *      carries the value in its label with the matching tone from the
 *      emitter's own vocabulary, and a value-less state strip is labelled by
 *      its SET of states so the first state never stands in for the value.
 *      The strip's per-state expansion itself is runtime-side (interpreter.ts
 *      state tables) — the program's note names that remaining concern.
 *
 *   2. VALUE-LESS INSTRUMENTS RENDERED BLANK DASHES. metric/memoryBudget/
 *      fitGauge/timelineEvent slots whose value is null (illustrative) used
 *      to render "—" readouts — a readout with no reading is noise. Now the
 *      instrument is omitted (noted), except when the emptiness itself is the
 *      state (validation gates with no value yet) or the information is
 *      required — those keep a label-only variant, and the note says which.
 *
 *   3. ONE-RHYTHM SPACING COLLAPSE. The deployment-fit plan stacked 8/16/24px
 *      sibling gaps across four regions (chrome defaulted to the raw grid,
 *      content kept shell-declared 16/24px) — the type.space.one-rhythm
 *      criterion failed HIGH. The planner now derives every sibling gap from
 *      ONE rhythm step (grid × 2) at the source, and the criterion treats a
 *      region whose reason text states a spacing rationale as a documented
 *      exception — never an unexplained gap.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { planScreen } from "../mcp-server/dist-test/plan/planner.js";
import { auditTypeCriteria } from "../mcp-server/dist-test/design/quality/type-criteria.js";

/** The exact EXO Labs "Cluster Routing" stress brief (scripts/run-live-stress-case.mjs). */
const STRESS_BRIEF = {
  product: "EXO Labs",
  screen: "Cluster Routing",
  purpose: "Route a model across the cluster and see which node is the weak link",
  primaryDecision: "inspect the cluster routing and find the node that cannot take the model",
  primaryAction: "Route model",
  requiredInformation: [
    "node topology", "device-hub", "device-01", "device-02", "device-03",
    "cluster health", "GPU memory", "model throughput", "shard balance",
    "cold start time", "disk pressure", "recent deploys",
  ],
  optionalInformation: ["audit log"],
  dataMode: "demo",
  visualDirection: "technical-instrument",
  antiGoals: ["a wall of identical metric cards", "a dark panel carrying the whole identity"],
  interactions: [
    { from: "device-hub", to: "device-01", kind: "open" },
    { from: "device-hub", to: "device-02", kind: "open" },
    { from: "device-01", to: "device-03", kind: "open" },
  ],
  states: ["ready", "degraded", "offline"],
  viewport: { width: 1600, height: 1100 },
  values: { "cluster health": "Degraded" },
};

/* -------------------------------------------------------------------------- */
/* 1. the current status is the value pill, with the emitter's matching tone   */
/* -------------------------------------------------------------------------- */

describe("the state pill carries the brief's value, not the first declared state", () => {
  test("a statusPill slot with a value emits the value in its label with the matching tone", async () => {
    const res = await designPipelineTool(null, null, { brief: STRESS_BRIEF, mode: "plan" });
    const pills = res.program.content.filter((c) => c.fn === "statusPill");
    assert.ok(pills.length > 0, `statusPill calls in the program: ${res.program.content.map((c) => c.fn).join(", ")}`);

    const valuePill = pills.find((c) => String(c.args.label).includes("Degraded"));
    assert.ok(valuePill, `a statusPill must carry the brief's value "Degraded"; pills: ${JSON.stringify(pills.map((p) => p.args))}`);
    // 'Degraded' maps to the emitter's warning pair — either as the
    // canonical 'warning' tone or as the exact synonym 'degraded' (both
    // resolve to #B26A001A in the emitter's tone table); never the first
    // state's success tone.
    assert.ok(
      valuePill.args.tone === "warning" || valuePill.args.tone === "degraded",
      `'Degraded' maps to the emitter's warning tone, got '${valuePill.args.tone}'`,
    );

    // And the pill still names the information it answers.
    assert.match(String(valuePill.args.label), /cluster health/);
  });

  test("the compiled pill renders the emitter's warning colours, never the 'ready' first-state tone", async () => {
    const { executeRuntime } = await import("../mcp-server/dist-test/runtime/interpreter.js");
    const res = await designPipelineTool(null, null, { brief: STRESS_BRIEF, mode: "plan" });
    const valuePill = res.program.content.find((c) => c.fn === "statusPill" && String(c.args.label).includes("Degraded"));
    assert.ok(valuePill, "the value pill exists in the program");

    const compiled = executeRuntime(res.program, {});
    const frame = compiled.operations.find((op) => op.type === "createFrame" && op.id === valuePill.id);
    assert.ok(frame, `the pill compiled to a frame: ${compiled.operations.map((o) => `${o.type}:${o.id}`).join(", ")}`);
    // The emitter's tone table: warning bg #B26A001A, success (the 'ready'
    // first-state tone) bg #2D7A4D1A — the pill must carry the former.
    assert.equal(frame.fill, "#B26A001A", `pill fill: ${frame.fill}`);
    assert.notEqual(frame.fill, "#2D7A4D1A", "the pill must not render in the 'ready'/success tone");

    const label = compiled.operations.find((op) => op.type === "createText" && op.parent === valuePill.id);
    assert.ok(label, "the pill carries its label as text");
    assert.match(String(label.content), /Degraded/);
  });

  test("no statusPill stands in with the first declared state as the current value", async () => {
    const res = await designPipelineTool(null, null, { brief: STRESS_BRIEF, mode: "plan" });
    const pills = res.program.content.filter((c) => c.fn === "statusPill");
    // The value-less state strip is labelled by its SET of states, never by
    // its first entry ("ready") standing in as the screen's current status.
    for (const pill of pills) {
      assert.notEqual(String(pill.args.label), "ready", `a pill still stands in with the first state: ${JSON.stringify(pill.args)}`);
    }
    const strip = pills.find((c) => c.args.states !== undefined);
    assert.ok(strip, "the declared states still travel as the state strip");
    assert.deepEqual(strip.args.states, ["ready", "degraded", "offline"]);
    assert.match(String(strip.args.label), /States — ready · degraded · offline/);
  });

  test("the remaining strip concern is named in the program notes, not silently left", async () => {
    const res = await designPipelineTool(null, null, { brief: STRESS_BRIEF, mode: "plan" });
    assert.ok(
      (res.programNotes ?? []).some((n) => /REMAINING CONCERN/.test(n) && /state strip/i.test(n)),
      `the strip's runtime-side limitation must be named in the notes: ${JSON.stringify(res.programNotes ?? [])}`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* 2. value-less instruments do not render blank dashes                        */
/* -------------------------------------------------------------------------- */

describe("an illustrative slot with no value emits no empty instrument", () => {
  const brief = {
    product: "EXO Labs",
    screen: "Device Detail",
    purpose: "understand one machine and decide whether to intervene",
    primaryDecision: "diagnose this device",
    requiredInformation: ["GPU memory"],
    optionalInformation: ["API errors", "validation gates and deploy history"],
    dataMode: "demo",
    viewport: { width: 1440, height: 900 },
  };

  test("optional illustrative instruments are omitted, and required ones keep a label-only variant", async () => {
    const res = await designPipelineTool(null, null, { brief, mode: "plan" });
    const calls = res.program.content;

    // No instrument renders the value-that-does-not-exist.
    for (const call of calls) {
      const value = call.args?.value;
      assert.notEqual(value, "—", `an empty instrument slipped through: ${JSON.stringify(call)}`);
    }
    // A metric-shaped call with a dash value must not exist at all.
    assert.equal(calls.filter((c) => c.fn === "metric").length, 0, "no metric card with a placeholder dash");

    // The REQUIRED information stays as its label (label-only variant), so
    // the screen still names where the answer lands.
    const labelled = calls.filter((c) => c.fn === "text" && c.args?.text === "GPU memory");
    assert.ok(labelled.length > 0, `required information kept as label-only text: ${JSON.stringify(calls.map((c) => `${c.fn}:${c.args?.text ?? c.args?.label ?? ""}`))}`);

    // The optional illustrative instrument is simply gone.
    assert.ok(
      !calls.some((c) => String(c.args?.label ?? c.args?.text ?? "").includes("API errors") && c.fn !== "text"),
      "the optional value-less instrument was omitted, not rendered empty",
    );
  });

  test("the decision is noted, saying which variant and why", async () => {
    const res = await designPipelineTool(null, null, { brief, mode: "plan" });
    const notes = res.programNotes ?? [];
    assert.ok(
      notes.some((n) => /API errors/.test(n) && /omitted/.test(n) && /no reading/.test(n)),
      `the omission is noted: ${JSON.stringify(notes)}`,
    );
    assert.ok(
      notes.some((n) => /GPU memory/.test(n) && /label-only/.test(n)),
      `the label-only variant is noted: ${JSON.stringify(notes)}`,
    );
    assert.ok(
      notes.some((n) => /validation gates and deploy history/.test(n) && /emptiness itself is the state/.test(n) && /label-only/.test(n)),
      `the emptiness-is-state exception is noted and says which: ${JSON.stringify(notes)}`,
    );
  });

  test("slots with real values are untouched", async () => {
    const res = await designPipelineTool(null, null, {
      brief: {
        ...brief,
        values: { "GPU memory": "512 GB", "API errors": "0" },
      },
      mode: "plan",
    });
    const gpu = res.program.content.find((c) => c.fn === "metric" && String(c.args.label).includes("GPU memory"));
    assert.ok(gpu, "a valued slot still emits its instrument");
    assert.equal(gpu.args.value, "512 GB");
  });
});

/* -------------------------------------------------------------------------- */
/* 3. one rhythm step between sibling regions                                   */
/* -------------------------------------------------------------------------- */

describe("one-rhythm: the plan carries one gap value by default, exceptions only when stated", () => {
  test("the deployment-fit plan defaults every sibling region to one rhythm step", () => {
    const plan = planScreen({
      primaryDecision: "Choose a model deployment that fits the discovered compute cluster.",
      primaryAction: "Launch deployment",
      availableInformation: ["candidate models", "cluster memory"],
    });
    assert.ok(plan.regions.length >= 4, "the deployment shell has four regions");
    const gaps = [...new Set(plan.regions.map((r) => r.gap))];
    assert.equal(gaps.length, 1, `sibling-region gaps must be ONE rhythm step, got: ${plan.regions.map((r) => `${r.id}=${r.gap}`).join(", ")}`);
    assert.equal(gaps[0], 16, "the step is the grid rhythm (8px grid × 2)");
    assert.ok(
      plan.derivation.appliedGuidance.some((g) => /one rhythm step/.test(g)),
      "the rhythm decision is recorded in the derivation",
    );
  });

  test("a region whose reason states a spacing rationale is a documented exception", () => {
    const audit = auditTypeCriteria({
      regions: [
        { id: "a", gap: 16 },
        { id: "b", gap: 16 },
        { id: "c", gap: 32, why: "the diagram breathes: a generous rhythm opens the field from its support band" },
      ],
    });
    const rhythm = audit.criteria.find((c) => c.criterion === "one-rhythm");
    assert.equal(rhythm?.status, "pass", `stated spacing reason exempts the region: ${JSON.stringify(audit.criteria)}`);
    assert.match(rhythm.detail, /exempt/);
    assert.equal(audit.findings.filter((f) => f.rule === "type.space.one-rhythm").length, 0, "no finding when the exception is documented");
  });

  test("an unstated odd gap still fails the criterion", () => {
    const twoGap = auditTypeCriteria({
      regions: [{ id: "a", gap: 16 }, { id: "b", gap: 16 }, { id: "c", gap: 24 }],
    });
    assert.equal(twoGap.criteria.find((c) => c.criterion === "one-rhythm")?.status, "fail");
    const finding = twoGap.findings.find((f) => f.rule === "type.space.one-rhythm");
    assert.ok(finding, "the odd gap without a stated reason is reported");
    assert.equal(finding.severity, "medium");

    const collapsed = auditTypeCriteria({
      regions: [{ id: "a", gap: 8 }, { id: "b", gap: 12 }, { id: "c", gap: 16 }, { id: "d", gap: 32 }],
    });
    assert.equal(
      collapsed.findings.find((f) => f.rule === "type.space.one-rhythm")?.severity,
      "high",
      "three or more unexplained gaps still fail high",
    );
  });
});
