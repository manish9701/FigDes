/**
 * The MCP client the live scripts share, and the reconcile step that makes a
 * retry safe.
 *
 * ## Why the reconcile step exists
 *
 * A live build can outlive the server's patience: the Figma main thread keeps
 * working after the server stops waiting, so a timed-out transaction may still
 * commit. Retrying it with a new id would draw the screen twice; retrying with
 * the same id is refused until the ledger settles.
 *
 * So the client's job, after a timeout, is to *wait for the truth*: poll the
 * job ledger until it reaches a terminal state, and hand back the nodes the
 * transaction created. That turns "outcome unknown" from a dead end into a
 * wait.
 */
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MCP = process.env.FIGDES_MCP_URL ?? "https://figdes.onrender.com/mcp";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The repository HEAD as a 12-char short SHA, or null when git is unavailable
 * (a shallow checkout without git, a tarball). A null HEAD means "cannot
 * verify" — the integrity helpers treat that as blocked, never as a match.
 */
export function repoHead12() {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return head.slice(0, 12);
  } catch {
    return null;
  }
}

/** The 12-char SHA a build stamp names (the stamp may carry a `-dirty` marker). */
const shortSha = (build) => (typeof build === "string" && build.length > 0 ? (build.split("-")[0] ?? null) : null);

/** A build stamp that names a real build, or null for missing/"unknown" ones. */
const named = (build) => (typeof build === "string" && build.length > 0 && build !== "unknown" ? build : null);

let rpcId = 0;

export async function rpc(method, params) {
  const res = await fetch(MCP, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2024-11-05",
      "user-agent": "opencode/live-gauntlet",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const text = await res.text();
  const json = JSON.parse(text);
  if (json.error) throw new Error(`RPC ${method}: ${JSON.stringify(json.error).slice(0, 300)}`);
  return json.result;
}

export async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  if (result.isError) throw new Error(`tool ${name}: ${JSON.stringify(result.content).slice(0, 600)}`);
  const text = result.content?.find((b) => b.type === "text")?.text;
  let data;
  try {
    data = text ? JSON.parse(text) : (result.structuredContent ?? null);
  } catch {
    data = { note: text, structuredContent: result.structuredContent ?? null };
  }
  return { data, blocks: result.content ?? [] };
}

/** The states a transaction can settle to. */
const TERMINAL = new Set(["committed", "rolled-back", "partial-rollback", "failed"]);

/**
 * Waits for a transaction to settle, and returns what it produced.
 *
 * A timed-out build is reconciled by the late result the plugin eventually
 * sends, or by a same-id resume. Both paths end in a terminal state, and the
 * caller gets the created nodes either way — so a retry never has to guess
 * whether the first attempt landed.
 */
export async function settleTransaction(transactionId, { timeoutMs = 360000, pollMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { data: job } = await tool("get_job_status", { transactionId });
    last = job?.job ?? null;
    if (last === null) return { state: "unknown", job: null, createdIds: [] };
    if (TERMINAL.has(last.state)) {
      return { state: last.state, job: last, createdIds: last.createdIds ?? [] };
    }
    if (last.state === "timed-out") {
      // The ledger is waiting for the late result. A same-id resume asks the
      // server to reconcile it now.
      const resumed = await tool("resume_job", { transactionId });
      if (resumed.data?.status === "already-committed") {
        const result = resumed.data?.result ?? {};
        return { state: "committed", job: last, createdIds: result.createdNodes?.map((n) => n.figmaNodeId) ?? [] };
      }
      // Otherwise the resume re-dispatched or is still waiting; keep polling.
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return { state: last?.state ?? "unknown", job: last, createdIds: last?.createdIds ?? [] };
}

/* -------------------------------------------------------------------------- */
/* Build/version integrity (issue #25)                                          */
/*                                                                              */
/* A live run is only evidence about the code it ran against. These helpers     */
/* make the scripts refuse — loudly, at startup — to measure anything when the  */
/* server and plugin builds are not both present, not the same commit, or not   */
/* this repository's HEAD.                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Whether ONE measured record's build stamps tie it to this repository.
 *
 * A record matches when both stamps are present (not missing, not "unknown"),
 * the two name the same commit, and that commit is `repoHead` (a 12-char
 * comparison, so a `-dirty` marker still matches). Anything else is a
 * mismatch, and the reasons say which.
 *
 * Pure: no I/O, so the live benchmark and the release gate — and their tests —
 * use exactly one implementation.
 *
 * @returns {{ ok: boolean, reasons: string[] }} `ok` is true only when every
 *   stamp is present and names `repoHead`.
 */
export function caseBuildStamps({ serverBuild, pluginBuild, repoHead, compatibility } = {}) {
  const reasons = [];
  const server = named(serverBuild);
  const plugin = named(pluginBuild);
  if (!server) reasons.push(`the server build stamp is missing or 'unknown' (${serverBuild ?? "absent"})`);
  if (!plugin) reasons.push(`the plugin build stamp is missing or 'unknown' (${pluginBuild ?? "absent"})`);
  const serverSha = shortSha(server);
  const pluginSha = shortSha(plugin);
  if (serverSha !== null && pluginSha !== null && pluginSha !== serverSha) {
    reasons.push(`the server build '${serverBuild}' and the plugin build '${pluginBuild}' are not the same commit`);
  }
  const head = typeof repoHead === "string" && repoHead.length > 0 ? repoHead.slice(0, 12) : null;
  if (head) {
    for (const [key, sha, stamp] of [["serverBuild", serverSha, serverBuild], ["pluginBuild", pluginSha, pluginBuild]]) {
      if (sha === null) continue; // already reported as missing/unknown
      if (sha !== head) reasons.push(`the ${key} '${stamp}' does not name this repository's HEAD (${head})`);
    }
  }
  if (compatibility !== undefined && compatibility !== null && compatibility !== "same-commit") {
    reasons.push(`the build pair reports '${compatibility}', not 'same-commit'`);
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * The release gate's `build-integrity` group (issue #25), as a pure function
 * so the gate and its tests share one implementation.
 *
 * @param {{ report: object | null, native: object | null }} evidence the parsed
 *   `artifacts/design-benchmark/live-report.json` and `live/native-check.json`
 *   records; null (or absent) means the evidence does not exist.
 * @param {{ repoHead: string | null }} context the repository HEAD (12 chars).
 * @returns {{ status: "PASS" | "FAIL" | "BLOCKED", exitCode: number, detail: string, extra: object }}
 *   - PASS — evidence exists and every record's stamps are present, the same
 *     commit, and equal to HEAD;
 *   - FAIL — evidence exists but names a different commit, a missing or
 *     "unknown" build, or a stale stamp;
 *   - BLOCKED — there is no evidence at all (or HEAD is unreadable), so
 *     nothing was verified. A BLOCKED build-integrity group is never a pass.
 */
export function evaluateBuildIntegrityEvidence(evidence, { repoHead } = {}) {
  const head = typeof repoHead === "string" && repoHead.length > 0 ? repoHead : null;
  if (!head) {
    return {
      status: "BLOCKED",
      exitCode: 1,
      detail: "the repository HEAD could not be read, so no build stamp can be tied to a commit — the build-integrity group is BLOCKED, never PASS",
      extra: { checked: 0, repoHead: null, problems: [] },
    };
  }
  const report = evidence?.report ?? null;
  const native = evidence?.native ?? null;
  const reportCases = Array.isArray(report?.cases) ? report.cases.filter((c) => c && typeof c.caseId === "string") : [];
  const hasNative = Boolean(native && typeof native === "object" && native.caseId === "native-path-check");
  if (reportCases.length === 0 && !hasNative) {
    return {
      status: "BLOCKED",
      exitCode: 1,
      detail: "no live build evidence exists (neither the live benchmark report nor the native check names a build) — run the live cases against a connected plugin first; a BLOCKED build-integrity group can never be a passing release",
      extra: { checked: 0, repoHead: head, problems: [] },
    };
  }

  const problems = [];
  for (const c of reportCases) {
    const verdict = caseBuildStamps({
      serverBuild: c.build?.serverBuild,
      pluginBuild: c.build?.pluginBuild,
      repoHead: head,
    });
    if (!verdict.ok) problems.push(`${c.caseId}: ${verdict.reasons.join("; ")}`);
  }
  if (hasNative) {
    const nativeVerdict = caseBuildStamps({
      serverBuild: native.serverBuild,
      pluginBuild: native.pluginBuild,
      repoHead: head,
    });
    if (!nativeVerdict.ok) problems.push(`${native.caseId}: ${nativeVerdict.reasons.join("; ")}`);
  }

  // The headline stamps: whichever record actually names builds — the native
  // record, else the first case — so a native record from a pre-stamp run does
  // not mask the stamps its sibling cases carry.
  const namedStamps = (b) =>
    b && [b.serverBuild, b.pluginBuild].some((s) => typeof s === "string" && s.length > 0 && s !== "unknown") ? b : null;
  const stamps =
    namedStamps(native) ??
    (reportCases.find((c) => namedStamps(c.build))?.build ?? null) ??
    (hasNative ? native : (reportCases[0]?.build ?? null));
  const head12 = head.slice(0, 12);
  const shas = [shortSha(stamps?.serverBuild ?? null), shortSha(stamps?.pluginBuild ?? null)].filter((s) => s !== null);
  let compatibility;
  if (shas.length === 0) compatibility = "unverifiable";
  else if (shas.length === 2 && shas[0] === shas[1] && shas[0] === head12) compatibility = "same-commit";
  else compatibility = "different-commit";

  const checked = reportCases.length + (hasNative ? 1 : 0);
  return {
    status: problems.length > 0 ? "FAIL" : "PASS",
    exitCode: problems.length > 0 ? 1 : 0,
    detail:
      problems.length > 0
        ? `build integrity FAILS for ${problems.length} of ${checked} live evidence record(s): ${problems.slice(0, 3).join(" | ")}${problems.length > 3 ? "; …" : ""}`
        : `all ${checked} live evidence record(s) carry server and plugin build stamps that name this repository's HEAD (${head12})`,
    extra: {
      serverBuild: stamps?.serverBuild ?? "unknown",
      pluginBuild: stamps?.pluginBuild ?? "unknown",
      compatibility,
      repoHead: head12,
      checked,
      problems,
    },
  };
}

/**
 * The startup gate for the live scripts (issue #25): refuses to run unless the
 * server and plugin builds are present, the same commit, and that commit is
 * this repository's HEAD.
 *
 * Contract, chosen once and used by both callers: on any failure it prints a
 * clear blocker message and **exits 1**; on success it returns
 * `{ serverBuild, pluginBuild, compatibility, repoHead }` for the caller to
 * record next to whatever the run produces.
 *
 * @returns {Promise<{ serverBuild: string, pluginBuild: string, compatibility: string, repoHead: string }>}
 */
export async function assertBuildIntegrity() {
  let status = null;
  try {
    status = (await tool("figma_status", {})).data;
  } catch (err) {
    console.error(`BUILD INTEGRITY BLOCKED: figma_status could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const serverBuild = named(status?.serverBuild ?? status?.builds?.server);
  const pluginBuild = named(status?.build ?? status?.builds?.plugin);
  const compatibility =
    status?.builds?.compatibility ??
    (serverBuild === null || pluginBuild === null
      ? "unverifiable"
      : shortSha(serverBuild) === shortSha(pluginBuild)
        ? "same-commit"
        : "different-commit");
  const head = repoHead12();
  const reasons = caseBuildStamps({ serverBuild, pluginBuild, repoHead: head, compatibility }).reasons;
  const problems = [
    ...(status?.connected ? [] : ["no Figma plugin is connected — open the Design Agent panel in the target file"]),
    ...reasons,
  ];
  if (problems.length > 0) {
    console.error(
      [
        "",
        "BUILD INTEGRITY BLOCKED — this live run would not describe this repository:",
        ...problems.map((p) => `  - ${p}`),
        `  expected: both build stamps present, 'same-commit', and a 12-char stamp equal to HEAD ${head ?? "???"}`,
        `  (server build ${serverBuild ?? "absent"}, plugin build ${pluginBuild ?? "absent"})`,
        "",
        "Fix: rebuild and redeploy the server, and reload the plugin (close and reopen the Figma panel so it loads the fresh bundle), then re-run.",
        "",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`build integrity OK: server ${serverBuild}, plugin ${pluginBuild}, same commit ${head}`);
  return { serverBuild, pluginBuild, compatibility, repoHead: head };
}

export { MCP };
