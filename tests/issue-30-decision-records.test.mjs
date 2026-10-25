/**
 * Issue #30 — decision-record disk persistence.
 *
 * The design decision record (issue #22 §7) existed only as a benchmark
 * artifact: the pipeline never persisted one and no repair/resume path read
 * one back, so a restarted session lost the recorded brief, direction,
 * skills and discoveries and redesigned from scratch. These tests cover the
 * wire:
 *
 *   1. the pipeline's persist hook writes one record per file at the final
 *      report stage, atomically (no temp files left in the store);
 *   2. a restarted session (fresh load, same file identity) regains the
 *      record on the read-back path — including on a blocked re-entry, where
 *      the recorded context matters as much;
 *   3. a fileKey never persisted reads back clean null — no throw — and a
 *      corrupt record degrades to a problem note without being rewritten;
 *   4. a persistence failure is a note on the payload, never a build failure;
 *   5. the store is bounded (the store.ts overwrite semantics it reuses):
 *      one record per fileKey, the newest run wins, never grows.
 *
 * Entirely offline: mode "plan", no registry, no network, no live Figma.
 * The store is repointed at a fresh temp directory for every test via the
 * store's own env override (DESIGN_AGENT_DECISION_RECORD_DIR), which is read
 * at call time — so the override is set before the pipeline runs, not before
 * the module import.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { designPipelineTool } from "../mcp-server/dist-test/pipeline/tools.js";
import { OFFLINE_BRIEFS } from "../mcp-server/dist-test/design/benchmark/offline-briefs.js";
import {
  DECISION_RECORD_DIR_ENV,
  decisionRecordStoreDir,
  loadDecisionRecord,
  loadDecisionRecordForFile,
  persistDecisionRecordForFile,
} from "../mcp-server/dist-test/design/decision-record.js";

const TOPOLOGY_CASE = OFFLINE_BRIEFS.find((f) => f.caseId === "exo-compute-topology");
const MODEL_DETAIL_CASE = OFFLINE_BRIEFS.find((f) => f.caseId === "exo-model-detail");

/** An offline session with a file identity. Plan mode only measures text, and a failed measure is recorded, never fatal. */
function sessionFor(fileKey, fileName = "Issue 30.figma") {
  return {
    fileKey,
    fileName,
    request: async () => {
      throw new Error("offline test: no plugin");
    },
  };
}

/** Repoints the record store at a fresh temp directory; restores the env and removes the dir afterwards. */
async function withStoreDir(run) {
  const dir = await mkdtemp(join(tmpdir(), "figdes-decision-"));
  const prev = process.env[DECISION_RECORD_DIR_ENV];
  process.env[DECISION_RECORD_DIR_ENV] = dir;
  try {
    assert.equal(decisionRecordStoreDir(), dir, "the env override must repoint the store before any write");
    await run(dir);
  } finally {
    if (prev === undefined) delete process.env[DECISION_RECORD_DIR_ENV];
    else process.env[DECISION_RECORD_DIR_ENV] = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

describe("decision-record disk persistence (issue #30)", () => {
  test("the persist hook writes one record per file at the final stage, and a restarted session regains it", async () => {
    await withStoreDir(async (dir) => {
      // First run — nothing on disk yet, and the payload says so.
      const first = await designPipelineTool(sessionFor("Issue30RoundTripKeyA1"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
      });
      assert.equal(first.status, "planned");
      assert.equal(first.decisionRecord, null);
      assert.match(first.decisionRecordNote, /No decision record on disk/);
      assert.equal(first.decisionRecordDrift, undefined, "no record at entry means no drift check was possible");
      assert.ok(first.decisionRecordPersisted, "the persist hook must persist when the run has a file identity");
      assert.ok(first.decisionRecordPersisted.endsWith("issue30roundtripkeya1.json"), `persisted path: ${first.decisionRecordPersisted}`);
      assert.match(first.decisionRecordPersistNote, /persisted/);

      // The document on disk: the frozen schema, the run's screen, the skills that ran.
      const stored = JSON.parse(await readFile(join(dir, "issue30roundtripkeya1.json"), "utf8"));
      assert.equal(stored.schema, "figdes-decision-record-v1");
      assert.equal(stored.brief.screen, TOPOLOGY_CASE.brief.screen);
      assert.ok(stored.skills.length > 0, `skills frozen into the record: ${JSON.stringify(stored.skills)}`);

      // Temp-then-rename, not partial writes: the store holds only the record.
      assert.deepEqual(await readdir(dir), ["issue30roundtripkeya1.json"], "no temp files left behind");

      // A "restart": a fresh session object with the same file identity means a
      // fresh load — the store is disk, there is no in-memory cache to lean on.
      const second = await designPipelineTool(sessionFor("Issue30RoundTripKeyA1"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
      });
      assert.equal(second.status, "planned");
      assert.ok(second.decisionRecord, "a restarted session must regain the record on the read-back path");
      assert.equal(second.decisionRecord.schema, "figdes-decision-record-v1");
      assert.equal(second.decisionRecord.brief.primaryDecision, TOPOLOGY_CASE.brief.primaryDecision);
      assert.ok(second.decisionRecord.skills.length > 0, "the frozen skills travel with the record");
      assert.ok(second.decisionRecord.direction.rationale.length > 0, "the recorded direction carries its rationale");
      assert.match(second.decisionRecordNote, /loaded from/);
      assert.ok(Array.isArray(second.decisionRecordDrift?.reasons), "the resume-drift check ran for the same screen");
      assert.equal(second.decisionRecordDrift.drifted, false, `same brief must not drift: ${JSON.stringify(second.decisionRecordDrift)}`);
    });
  });

  test("a repair/resume re-entry with a broken brief still regains the record (the read-back is not gated)", async () => {
    await withStoreDir(async () => {
      const session = sessionFor("Issue30RepairKeyB2");
      const seeded = await designPipelineTool(session, null, { brief: TOPOLOGY_CASE.brief, mode: "plan" });
      assert.ok(seeded.decisionRecordPersisted, "the seed run persists before the resume");

      // The resume arrives with a contradictory brief. Nothing is persisted on a
      // blocked re-entry (there is no complete context to freeze), but the
      // read-back hands the recorded context over all the same.
      const resumed = await designPipelineTool(session, null, {
        brief: { screen: "Nothing", visualDirection: "dark", antiGoals: ["no dark surfaces"] },
        mode: "plan",
      });
      assert.equal(resumed.status, "blocked");
      assert.ok(resumed.decisionRecord, "the re-entry regains the record even when the brief blocks");
      assert.equal(resumed.decisionRecord.brief.screen, TOPOLOGY_CASE.brief.screen);
      assert.match(resumed.decisionRecordNote, /loaded from/);
    });
  });

  test("a fileKey never persisted reads back null — no throw — and a corrupt record degrades without being rewritten", async () => {
    await withStoreDir(async (dir) => {
      const absent = await loadDecisionRecordForFile("never-persisted-30");
      assert.equal(absent.record, null);
      assert.equal(absent.problem, undefined, `an absent record is the ordinary case, not a problem: ${absent.problem}`);
      assert.equal(await loadDecisionRecord(dir), null, "the base loader agrees with the wrapper");

      // A record that does not parse: null plus a problem note, file untouched.
      const corruptPath = join(dir, "corrupt-key-30.json");
      await writeFile(corruptPath, "{not json", "utf8");
      const corrupt = await loadDecisionRecordForFile("corrupt-key-30");
      assert.equal(corrupt.record, null);
      assert.match(String(corrupt.problem), /could not be parsed/);
      assert.equal(await readFile(corruptPath, "utf8"), "{not json", "a corrupt record is never rewritten by a read");
    });
  });

  test("persistence failure is a note on the payload, never a build failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "figdes-decision-fail-"));
    const prev = process.env[DECISION_RECORD_DIR_ENV];
    // Point the store at an ordinary FILE: everything written underneath it fails.
    const blocker = join(dir, "blocker.json");
    await writeFile(blocker, "a file where a directory must be", "utf8");
    process.env[DECISION_RECORD_DIR_ENV] = blocker;
    try {
      const direct = await persistDecisionRecordForFile("blocked-key-fail-30", {
        schema: "figdes-decision-record-v1",
        caseId: null,
        recordedAt: "2026-05-14T00:00:00.000Z",
        brief: {
          screen: "X",
          product: null,
          purpose: "p",
          primaryDecision: "d",
          primaryAction: null,
          requiredInformation: [],
          optionalInformation: [],
          viewport: { width: 1440, height: 900 },
          visualDirection: null,
        },
        constraints: [],
        direction: { composition: null, rationale: "r", intentStyle: null, intentDensity: null },
        skills: [],
        discoveries: [],
        rejectedAlternatives: [],
        outstandingIssues: [],
        repairAttempts: [],
      });
      assert.equal(direct.file, null);
      assert.ok(String(direct.problem).length > 0, "the failure is surfaced as a note, not thrown");

      const out = await designPipelineTool(sessionFor("Issue30FailKeyC3"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
      });
      assert.equal(out.status, "planned", "the build survived the persistence failure");
      assert.equal(out.decisionRecordPersisted, null, "nothing was persisted");
      assert.match(out.decisionRecordPersistNote, /could not be persisted/);
      assert.match(out.decisionRecordNote, /No decision record on disk/, `read-back note: ${out.decisionRecordNote}`);
    } finally {
      if (prev === undefined) delete process.env[DECISION_RECORD_DIR_ENV];
      else process.env[DECISION_RECORD_DIR_ENV] = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the store is bounded: one record per fileKey, the newest run wins (the store.ts semantics it reuses)", async () => {
    await withStoreDir(async (dir) => {
      const session = sessionFor("Issue30BoundedKeyD4");
      const runA = await designPipelineTool(session, null, { brief: TOPOLOGY_CASE.brief, mode: "plan" });
      assert.ok(runA.decisionRecordPersisted, "the first run persists");
      const runB = await designPipelineTool(session, null, { brief: MODEL_DETAIL_CASE.brief, mode: "plan" });
      assert.ok(runB.decisionRecordPersisted, "the second run persists over the first");

      const files = await readdir(dir);
      assert.deepEqual(
        files,
        ["issue30boundedkeyd4.json"],
        `one file per key — the store never grows unbounded: ${files.join(",")}`,
      );

      const loaded = await loadDecisionRecordForFile("issue30boundedkeyd4");
      assert.equal(loaded.record.brief.screen, MODEL_DETAIL_CASE.brief.screen, "the newest run's record is the one on disk");
    });
  });

  test("a caseId the caller passes is carried into the record instead of a hardcoded null", async () => {
    await withStoreDir(async (dir) => {
      const run = await designPipelineTool(sessionFor("Issue30CaseIdKeyC3"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
        caseId: "exo-compute-topology",
      });
      assert.equal(run.status, "planned");

      const stored = JSON.parse(await readFile(join(dir, "issue30caseidkeyc3.json"), "utf8"));
      assert.equal(stored.caseId, "exo-compute-topology", "the named case identity rides the record");
    });
  });

  test("an unnamed run still records caseId: null — an identity nobody gave is not invented", async () => {
    await withStoreDir(async (dir) => {
      const run = await designPipelineTool(sessionFor("Issue30NoCaseKeyE5"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
      });
      assert.equal(run.status, "planned");

      const stored = JSON.parse(await readFile(join(dir, "issue30nocasekeye5.json"), "utf8"));
      assert.equal(stored.caseId, null);
    });
  });

  test("caseId survives the frozen-schema round-trip load", async () => {
    await withStoreDir(async () => {
      await designPipelineTool(sessionFor("Issue30RoundTripCaseF6"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
        caseId: "exo-model-detail",
      });
      // A restart: the same file identity reads the record back through the
      // frozen schema — the case identity must survive it.
      const second = await designPipelineTool(sessionFor("Issue30RoundTripCaseF6"), null, {
        brief: TOPOLOGY_CASE.brief,
        mode: "plan",
      });
      assert.ok(second.decisionRecord, "the record is regained");
      assert.equal(second.decisionRecord.caseId, "exo-model-detail", "the case identity survives the frozen schema");
    });
  });
});
