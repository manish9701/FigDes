/**
 * Issue #22 — the benchmark as a *gate* (issue #22 §6, offline runner).
 *
 * The frozen baseline at `artifacts/benchmark/issue22-baseline-v1.json` is the
 * pinned reference: nine benchmark briefs, run through the full plan-mode
 * pipeline by `scripts/run-issue22-benchmark.mjs`. These tests hold the gate up
 * the same way the runner does — the runner and the tests must never measure a
 * case two ways — and cover the persistence half (run artifacts, decision
 * record round-trips, resume drift) that the report promises.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { OFFLINE_BRIEFS, OFFLINE_VIEWPORT, evidenceFromResponse } from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";
import {
  scoreOfflineEvidence,
  parseBaseline,
  runRegressionGate,
  BASELINE_SCHEMA,
} from "../mcp-server/dist-test/design/benchmark/regression.js";
import { BENCHMARKS } from "../mcp-server/dist-test/design/benchmark/suite.js";
import {
  buildDecisionRecord,
  serializeDecisionRecord,
  parseDecisionRecord,
  persistDecisionRecord,
  loadDecisionRecord,
  resumeDrift,
} from "../mcp-server/dist-test/design/decision-record.js";
import {
  persistRunArtifact,
  loadRunArtifact,
  parseRunArtifact,
  freezeBaseline,
  loadFrozenBaseline,
  renderFromDataUrl,
  RUN_ARTIFACT_SCHEMA,
} from "../mcp-server/dist-test/design/benchmark/artifacts.js";

const repoRoot = resolve(import.meta.dirname, "..");
const baselinePath = join(repoRoot, "artifacts/benchmark/issue22-baseline-v1.json");

/* -------------------------------------------------------------------------- */

test("the nine offline briefs are the versioned suite's nine cases, one to one", () => {
  const suiteIds = BENCHMARKS.map((b) => b.id);
  const briefIds = OFFLINE_BRIEFS.map((b) => b.caseId);
  assert.deepEqual([...briefIds].sort(), [...suiteIds].sort(), `brief/suite drift: briefs ${briefIds.join(",")} vs suite ${suiteIds.join(",")}`);
  // A fixture without its full pipeline brief cannot be reproduced; the brief
  // is the reproduction contract.
  for (const fixture of OFFLINE_BRIEFS) {
    assert.ok(fixture.brief.screen.length > 0, `${fixture.caseId}: screen`);
    assert.ok(fixture.brief.primaryDecision.length > 0, `${fixture.caseId}: the decision must be stated`);
    assert.ok(fixture.brief.requiredInformation.length >= 4, `${fixture.caseId}: at least 4 required items`);
    assert.deepEqual(fixture.brief.viewport, OFFLINE_VIEWPORT, `${fixture.caseId}: shared v1 viewport`);
  }
});

/** The frozen baseline, parsed once. It is committed; its absence is a message, not a mystery. */
function readBaseline() {
  try {
    return parseBaseline(readFileSync(baselinePath, "utf8"));
  } catch (cause) {
    throw new Error(
      `the committed baseline is missing or malformed at ${baselinePath} (run "npm run benchmark:issue22" to re-freeze it) — gate assertions need it: ${String(cause)}`,
    );
  }
}

describe("the gate against the committed baseline", async () => {
  const baseline = readBaseline();

  test("the committed baseline is a complete v1 freeze", () => {
    assert.equal(baseline.schema, BASELINE_SCHEMA);
    assert.equal(baseline.cases.length, OFFLINE_BRIEFS.length, "one frozen case per brief");
    for (const c of baseline.cases) {
      assert.ok(c.result.total > 0, `${c.caseId}: the frozen total must be positive`);
      assert.equal(c.config.mode, "plan");
      assert.equal(c.config.render, false, "the offline baseline renders nothing");
      assert.ok(c.evidence.typeCriteria !== null && c.evidence.typeCriteria.run, "the type-criteria audit ran on every frozen case");
    }
  });

  test("a fresh pipeline run of all nine cases passes the gate — no case may drop past the threshold", async () => {
    const candidate = [];
    for (const fixture of OFFLINE_BRIEFS) {
      const resp = await designPipelineTool(null, null, { brief: fixture.brief, mode: "plan" });
      assert.equal(resp.status, "planned", `${fixture.caseId} must plan, not ${resp.status}`);
      candidate.push(scoreOfflineEvidence(evidenceFromResponse(resp, fixture.caseId)).result);
    }
    const gate = runRegressionGate({ candidate, baseline });
    assert.notEqual(gate.verdict, "NOT_EVALUATED", `every baseline case must be reproduced: ${gate.missing.join(", ")}`);
    assert.equal(gate.verdict, "PASS", `gate: ${gate.reasons.join(" | ")}`);
    assert.equal(gate.missing.length, 0);
    assert.equal(gate.comparison.regressions.length, 0, `regressions: ${gate.comparison.regressions.join(", ")}`);
  });

  test("the offline score names its not-evaluated dimensions instead of padding the total", async () => {
    // One case is enough: this must hold structurally, not per case.
    const fixture = OFFLINE_BRIEFS[0];
    const resp = await designPipelineTool(null, null, { brief: fixture.brief, mode: "plan" });
    const { result, notEvaluated } = scoreOfflineEvidence(evidenceFromResponse(resp, fixture.caseId));
    assert.ok(notEvaluated.includes("productSpecificity"), "productSpecificity needs human judgement and must be named not-evaluated, never claimed");
    const register = result.notes.find((n) => n.startsWith("not evaluated offline"));
    assert.ok(register, "the not-evaluated register travels with the result");
    assert.ok(register.includes("productSpecificity") && register.includes("scored 0"), `register: ${register}`);
  });
});

/* -------------------------------------------------------------------------- */
/* The decision record (§7)                                                     */
/* -------------------------------------------------------------------------- */

describe("the design decision record", async () => {
  const planResp = await designPipelineTool(null, null, {
    brief: OFFLINE_BRIEFS.find((f) => f.caseId === "exo-compute-topology").brief,
    mode: "plan",
  });
  const record = buildDecisionRecord({
    caseId: "exo-compute-topology",
    brief: OFFLINE_BRIEFS.find((f) => f.caseId === "exo-compute-topology").brief,
    intent: planResp.visualIntelligence?.intent ?? null,
    steeredComposition: planResp.visualIntelligence?.alternatives?.steeredComposition ?? null,
    decisions: planResp.visualIntelligence?.decisions ?? [],
    discoveries: planResp.visualIntelligence?.notes ?? [],
    rejectedAlternatives: (planResp.visualIntelligence?.alternatives?.rejected ?? []).map((r) => ({ family: r.family, reason: r.reason })),
    outstandingIssues: (planResp.structure?.findings ?? []).map((f) => ({
      rule: f.ruleId ?? f.rule ?? "structure",
      summary: f.summary ?? "",
      severity: f.severity ?? "critical",
    })),
    now: () => "2026-05-14T00:00:00.000Z",
  });

  test("the record freezes what §7 demands be preserved", () => {
    assert.equal(record.schema, "figdes-decision-record-v1");
    assert.equal(record.recordedAt, "2026-05-14T00:00:00.000Z", "the recorded time is the tested clock");
    assert.equal(record.caseId, "exo-compute-topology");
    assert.equal(record.brief.primaryDecision, "which pressured resource needs attention");
    assert.equal(record.brief.viewport.width, 1440);
    assert.ok(record.direction.rationale.length > 0, "the direction carries a rationale");
    // The skills that ran, each with at least one reason.
    assert.ok(record.skills.length > 0, `skills used: ${record.skills.map((s) => s.id).join(", ")}`);
    for (const s of record.skills) assert.ok(s.why.length > 10, `${s.id}: why must be auditable, got "${s.why}"`);
    for (const r of record.rejectedAlternatives) assert.ok(r.reason.length > 10, `${r.family}: reason must be auditable, got "${r.reason}"`);
  });

  test("the record survives a strict round-trip", () => {
    const json = serializeDecisionRecord(record);
    const reparsed = parseDecisionRecord(json);
    assert.equal(reparsed.direction.composition, record.direction.composition);
    assert.deepEqual(reparsed.skills, record.skills);
    assert.deepEqual(reparsed.rejectedAlternatives, record.rejectedAlternatives);
    assert.deepEqual(reparsed.outstandingIssues, record.outstandingIssues);
    assert.throws(() => parseDecisionRecord(json.replace('"figdes-decision-record-v1"', '"someone-elses-record"')), /refused/, "a foreign schema is refused");
    assert.throws(() => parseDecisionRecord("{not json"), /refused/, "garbage is refused");
  });

  test("resume drift is named, not silent: a density change on resume raises it", () => {
    const currentIntent = planResp.visualIntelligence?.intent ?? {};
    const reparsed = parseDecisionRecord(JSON.stringify(record));
    const same = resumeDrift(reparsed, currentIntent);
    assert.equal(same.drifted, false, `same intent must not drift: ${same.reasons.join(" | ")}`);

    const restyled = { ...currentIntent, density: currentIntent.density === "dense" ? "airy" : "dense" };
    const drifted = resumeDrift(reparsed, restyled);
    assert.equal(drifted.drifted, true);
    assert.ok(drifted.reasons.some((r) => r.startsWith("density drifted:")), `reasons: ${drifted.reasons.join(" | ")}`);
  });

  test("the record persists next to the run and loads back; nothing recorded stays null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figdes-record-"));
    try {
      const file = await persistDecisionRecord(dir, record);
      assert.ok(file.endsWith("exo-compute-topology.json"), `file: ${file}`);
      const loaded = await loadDecisionRecord(dir, record.caseId);
      assert.equal(loaded.direction.composition, record.direction.composition);
      assert.equal(loaded.brief.primaryDecision, record.brief.primaryDecision);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const empty = await mkdtemp(join(tmpdir(), "figdes-empty-"));
    try {
      assert.equal(await loadDecisionRecord(empty), null);
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Run artifacts + the frozen baseline on disk                                  */
/* -------------------------------------------------------------------------- */

describe("run artifacts and the frozen baseline", async () => {
  const fixture = OFFLINE_BRIEFS.find((f) => f.caseId === "exo-model-detail");
  const pipelineResp = await designPipelineTool(null, null, { brief: fixture.brief, mode: "plan" });
  const evidence = evidenceFromResponse(pipelineResp, fixture.caseId);
  const { result } = scoreOfflineEvidence(evidence);
  const artifact = {
    schema: RUN_ARTIFACT_SCHEMA,
    runId: "test_exo-model-detail",
    caseId: fixture.caseId,
    brief: fixture.brief,
    config: { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 },
    evidence,
    result,
    decisionRecord: buildDecisionRecord({ caseId: fixture.caseId, brief: fixture.brief, now: () => "2026-05-14T00:00:00.000Z" }),
    render: null,
  };

  // The baseline-case-shaped brief: exactly the fields the v1 schema freezes.
  const frozenBrief = {
    screen: fixture.brief.screen,
    product: fixture.brief.product,
    purpose: fixture.brief.purpose,
    primaryDecision: fixture.brief.primaryDecision,
    primaryAction: fixture.brief.primaryAction,
    requiredInformation: [...fixture.brief.requiredInformation],
    optionalInformation: [...fixture.brief.optionalInformation],
    desiredComposition: null,
    viewport: { ...fixture.brief.viewport },
  };

  test("a run artifact persists with its evidence and loads back deep-equal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figdes-artifacts-"));
    try {
      const files = await persistRunArtifact(dir, artifact);
      assert.equal(files.length, 1, `no render → one file only: ${files.join(", ")}`);
      assert.ok(files[0].endsWith("run.json"));
      const loaded = await loadRunArtifact(dir, artifact.runId);
      assert.equal(loaded.caseId, artifact.caseId);
      assert.deepEqual(loaded.evidence, artifact.evidence);
      assert.deepEqual(loaded.result.dimensions, artifact.result.dimensions);
      assert.equal(loaded.decisionRecord.caseId, artifact.caseId);
      const raw = readFileSync(join(dir, artifact.runId, "run.json"));
      assert.ok(!raw.includes("dataUrl"), "the render data URL is never re-embedded in run.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("malformed run artifacts are refused", () => {
    assert.throws(() => parseRunArtifact("{not json"), /not valid JSON/, "garbage is refused");
    assert.throws(() => parseRunArtifact(JSON.stringify({ schema: "someone-elses-run", runId: "x" })), /refused/, "a foreign schema is refused");
  });

  test("a decodable render is persisted as an image file; an undecodable one is recorded, not dropped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figdes-render-"));
    try {
      const pngArtifact = {
        ...artifact,
        runId: "test_render",
        render: { dataUrl: "data:image/png;base64,AAAA", revisionId: "r1", note: "one black point" },
      };
      const files = await persistRunArtifact(dir, pngArtifact);
      const imageFile = files.find((f) => f.endsWith("render.png"));
      assert.ok(imageFile, `render.png must be written: ${files.join(", ")}`);
      const bytes = readFileSync(imageFile);
      assert.equal(bytes.length, 3, "AAAA decodes to 3 bytes");

      const badArtifact = {
        ...artifact,
        runId: "test_bad_render",
        render: { dataUrl: "data:image/png;not-really-base64!!", revisionId: "r1", note: null },
      };
      const files2 = await persistRunArtifact(dir, badArtifact);
      assert.ok(files2.some((f) => f.endsWith("render-decode-refused.txt")), `an undecodable render is recorded: ${files2.join(", ")}`);

      assert.deepEqual(renderFromDataUrl("data:image/png;base64,AAAA")?.bytes, Buffer.from("AAAA", "base64"));
      assert.equal(renderFromDataUrl("data:text/plain;base64,AAAA"), null, "non-image data URLs are not renders");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the frozen baseline refuses a silent overwrite and loads back as a gateable document", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figdes-baseline-"));
    try {
      const doc = {
        schema: BASELINE_SCHEMA,
        suite: "v1-offline-pipeline",
        recordedAt: "2026-05-14T00:00:00.000Z",
        cases: [
          {
            caseId: fixture.caseId,
            brief: frozenBrief,
            config: { mode: "plan", render: false, repairBudget: 2, maxRounds: 1 },
            evidence: artifact.evidence,
            result: artifact.result,
          },
        ],
      };
      const path = await freezeBaseline(dir, doc, false);
      assert.ok(path.endsWith("issue22-baseline-v1.json"));
      await assert.rejects(
        () => freezeBaseline(dir, { ...doc, recordedAt: "2026-06-01T00:00:00.000Z" }, false),
        /refused.*already exists/,
        "a frozen baseline is never quietly re-frozen",
      );
      const forced = await freezeBaseline(dir, { ...doc, recordedAt: "2026-06-01T00:00:00.000Z" }, true);
      assert.equal(forced, path, "an explicit force re-freezes in place");
      const loaded = await loadFrozenBaseline(dir);
      assert.equal(loaded.doc.suite, "v1-offline-pipeline");
      assert.equal(loaded.doc.cases[0].caseId, fixture.caseId);
      assert.equal(loaded.path, path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const empty = await mkdtemp(join(tmpdir(), "figdes-nobaseline-"));
    try {
      assert.equal(await loadFrozenBaseline(empty), null, "the gate never invents a reference to PASS against");
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});
