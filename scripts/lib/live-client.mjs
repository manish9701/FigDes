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
const MCP = process.env.FIGDES_MCP_URL ?? "https://figdes.onrender.com/mcp";

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

export { MCP };
