/**
 * Design Agent server — one process, one port, two transports (SPEC §8, §23).
 *
 *   POST/GET/DELETE /mcp   Streamable HTTP, consumed by ChatGPT
 *   GET      /ws           WebSocket,   consumed by the Figma plugin iframe
 *   GET      /health       Liveness + connected plugin sessions
 *
 * Collapsing the spec's separate `relay/` into this process is deliberate: two
 * processes and two ports for V1 buys nothing and doubles the failure modes.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import { URL } from "node:url";
import { SERVER_BUILD, type ClientMessage } from "../../shared/protocol";
import { createMcpHandler } from "./mcp";
import { SessionRegistry } from "./sessions";
import { clients } from "./clients/registry";
import { checkHttpAuth, checkWsAuth, confirmRegisteredSecret, loadAuthConfig, type AuthConfig } from "./security";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1";

/* -------------------------------------------------------------------------- */
/* CORS — needed for browser-based MCP clients and the Inspector               */
/* -------------------------------------------------------------------------- */

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "https://chatgpt.com,https://chat.openai.com,http://localhost:6274")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function corsHeaders(origin: string | undefined): Record<string, string> {
  const allow = !origin || ALLOWED_ORIGINS.includes(origin) || origin.startsWith("http://localhost");
  return {
    "access-control-allow-origin": allow ? origin ?? "*" : "null",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers":
      "content-type,authorization,x-api-key,mcp-session-id,mcp-protocol-version,last-event-id,x-mcp-client-name,x-mcp-client-version,x-client-name,x-client-version,x-agent-name",
    "access-control-expose-headers": "mcp-session-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                   */
/* -------------------------------------------------------------------------- */

let auth: AuthConfig;
try {
  auth = loadAuthConfig();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const registry = new SessionRegistry();
const mcp = createMcpHandler(registry);
// The job ledger survives a *process* restart only when persistence is
// configured (DESIGN_AGENT_JOB_DIR); say which mode this boot is in, because
// "the ledger is in memory" is exactly the assumption a restart breaks.
if (registry.jobs.persistenceFile) {
  console.log(`job-ledger: restart persistence ON -> ${registry.jobs.persistenceFile}`);
} else {
  console.log("job-ledger: restart persistence OFF (in-memory only; set DESIGN_AGENT_JOB_DIR to enable).");
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                        */
/* -------------------------------------------------------------------------- */

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const origin = req.headers.origin;
  for (const [k, v] of Object.entries(corsHeaders(origin))) res.setHeader(k, v);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    const { connections, totalCalls } = clients.snapshot();
    res.end(
      JSON.stringify(
        {
          ok: true,
          // Which build is answering. A live measurement has to be able to
          // name it, because the deployment is not the repository until it is
          // redeployed.
          build: SERVER_BUILD,
          sessions: registry.connected().map((s) => s.status()),
          mcpClients: connections.map((c) => ({
            display: c.display,
            calls: c.calls,
            active: c.active,
            lastTool: c.lastTool,
            lastTarget: c.lastTarget,
          })),
          totalToolCalls: totalCalls,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (url.pathname === "/mcp") {
    const verdict = checkHttpAuth(req, auth);
    if (!verdict.ok) {
      res.writeHead(verdict.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: verdict.error }, id: null }));
      return;
    }
    void mcp.handle(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Not found", routes: ["/mcp", "/ws", "/health"] }));
});

/* -------------------------------------------------------------------------- */
/* WebSocket (plugin transport)                                                */
/* -------------------------------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const verdict = checkWsAuth(url, auth);
  if (!verdict.ok) {
    socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws: WebSocket) => {
  const session = registry.add(ws);
  console.log(`[ws] plugin connected (${session.id}) — waiting for register frame`);

  // Transport keepalive: ping proves the socket is alive even when the Figma
  // main thread is wedged and heartbeat messages stall. Pongs refresh the
  // session (markPong); a socket silent beyond grace is terminated so a
  // half-open connection fails fast instead of looking connected forever.
  ws.on("pong", () => session.markPong());

  // A plugin that opens a socket but never registers is a half-open session.
  const registrationGuard = setTimeout(() => {
    if (session.fileName === "Unknown file") {
      console.warn(`[ws] ${session.id} never registered; closing.`);
      ws.close(4002, "registration timeout");
    }
  }, 10_000);

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      ws.send(JSON.stringify({ type: "disconnect", reason: "malformed frame" }));
      ws.close(4003, "malformed frame");
      return;
    }

    session.lastSeen = Date.now();

    switch (msg.type) {
      case "register": {
        if (!confirmRegisteredSecret(msg.secret, auth)) {
          console.warn(`[ws] ${session.id} failed the register secret check.`);
          ws.close(4403, "invalid secret");
          return;
        }
        clearTimeout(registrationGuard);
        session.register(msg);
        const linked = registry.linkGeneration(session);
        console.log(`[ws] registered ${session.id} → "${session.fileName}" / "${session.pageName}"${linked.reboundFrom ? ` (rebound from ${linked.reboundFrom} in ${linked.readyMs}ms)` : ""}`);
        session.send({ type: "welcome", sessionId: session.id, heartbeatMs: 5000, ...(clients.latest() ? { mcpClient: clients.latest()! } : {}) });
        break;
      }

      case "state":
        session.applyState(msg);
        break;

      case "result": {
        const late = session.settleResult(msg);
        if (late?.late) {
          // Late-result reconciliation: the server already told the caller
          // "timed out, outcome unknown". The plugin's real answer just
          // arrived — bind it to the ledger so get_job_status tells the truth
          // instead of leaving the job stuck at timed-out forever.
          const data = late.data as { status?: string; transactionId?: string; createdNodes?: Array<{ figmaNodeId: string }>; rollbackStatus?: string; rolledBack?: boolean } | undefined;
          const transactionId = late.transactionId ?? data?.transactionId;
          const commitNote = late.ok ? "late commit" : `late failure: ${late.error ?? "unknown"}`;
          if (transactionId) {
            const existing = registry.jobs.get(transactionId);
            if (existing) {
              // Bind to the attempt this frame's request belonged to, so a
              // result that lost the race against a re-dispatch is recorded
              // rather than applied over the newer outcome.
              const boundRequest = registry.jobs.byRequestId(late.requestId);
              const attempt = boundRequest?.attempt ?? (boundRequest && boundRequest.transactionId === transactionId ? boundRequest.attempt : undefined);
              const settle = (
                state: Parameters<typeof registry.jobs.completeLate>[0]["state"],
                extra: Record<string, unknown>,
              ): void => {
                const out = registry.jobs.completeLate({ transactionId, attempt, state, extra, result: late.data });
                if (!out.applied) console.warn(`[ws] ${session.id} ignored late result for ${transactionId}: ${out.reason}`);
              };
              if (late.ok && data?.status === "success") {
                settle("committed", {
                  done: existing.operationCount,
                  label: `${commitNote} reconciled after timeout`,
                  createdIds: data?.createdNodes?.map((n) => n.figmaNodeId),
                  error: undefined,
                });
              } else if (!late.ok || data?.status === "failed") {
                const rb = data?.rollbackStatus ?? (data && (data as { rolledBack?: boolean }).rolledBack ? "full" : undefined);
                settle(
                  rb === "full" ? "rolled-back" : rb === "partial" ? "partial-rollback" : "failed",
                  { error: (data as { error?: { message?: string } } | undefined)?.error?.message ?? late.error ?? "late failure", label: `${commitNote} reconciled after timeout` },
                );
              } else {
                registry.jobs.update(transactionId, { label: `${commitNote} (unrecognised shape)` });
              }
              console.log(`[ws] ${session.id} late result reconciled ${transactionId}: ok=${late.ok} (was timed-out)`);
            } else {
              // No ledger record (server restart, or unknown id): keep the
              // result retrievable under the transaction id so a same-id retry
              // stays idempotent instead of duplicating nodes.
              console.log(`[ws] ${session.id} late result for unknown transaction ${transactionId ?? late.requestId}: ok=${late.ok}`);
            }
          } else {
            const byReq = registry.jobs.byRequestId(late.requestId);
            if (byReq) {
              registry.jobs.update(byReq.transactionId, { label: `${commitNote} (by request id)` });
              console.log(`[ws] ${session.id} late result reconciled by request ${late.requestId}: ok=${late.ok}`);
            } else {
              console.log(`[ws] ${session.id} late result for unknown request ${late.requestId}: ok=${late.ok}`);
            }
          }
        }
        break;
      }

      case "progress": {
        // Upstream build heartbeat: extends the request timeout (sliding
        // window) so long builds log instead of timing out mid-apply.
        session.touchProgress(msg.requestId, msg.done, msg.total, msg.label);
        if (msg.transactionId) {
          registry.jobs.update(msg.transactionId, { state: "applying", done: msg.done, label: msg.label, sessionId: session.id });
        }
        if (msg.phase === "failed") {
          console.log(`[ws] ${session.id} build ${msg.phase}: ${msg.done}/${msg.total} ${msg.label}`);
        }
        break;
      }

      default:
        console.warn(`[ws] unexpected frame type from ${session.id}: ${(msg as { type: string }).type}`);
    }
  });

  ws.on("error", (err) => console.error(`[ws] ${session.id} error:`, err.message));
});

/* -------------------------------------------------------------------------- */
/* Transport keepalive                                                          */
/* -------------------------------------------------------------------------- */

const PING_MS = 25_000;
const SILENT_KILL_MS = 90_000;

const keepalive = setInterval(() => {
  for (const session of registry.all()) {
    if (!session.reachable) continue;
    const quietFor = Date.now() - Math.max(session.lastSeen, session.lastPongAt);
    if (quietFor > SILENT_KILL_MS) {
      console.warn(`[ws] ${session.id} silent for ${Math.round(quietFor / 1000)}s; terminating half-open socket.`);
      try {
        session.socket.terminate();
      } catch {
        /* already gone */
      }
      continue;
    }
    try {
      session.socket.ping();
    } catch {
      /* send-side failure surfaces at request time */
    }
  }
}, PING_MS);
// Keep-alive must not hold the process open on its own.
(keepalive as unknown as { unref?: () => void }).unref?.();

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A plugin-side crash used to surface as a vague "failing internally" on the
 * ChatGPT side because nothing logged it here. These handlers make sure any
 * escaping error is recorded with a stack.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandled rejection:", reason instanceof Error ? (reason.stack ?? reason.message) : reason);
});

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaught exception:", err.stack ?? err.message);
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * When the server sits behind a fixed public hostname (a named Cloudflare
 * tunnel, an ngrok reserved domain, or a real deployment) the plugin can dial
 * that address directly instead of going through a per-session quick tunnel.
 *
 * The value is baked into the plugin at build time, which is what removes the
 * "paste a new link into ChatGPT on every restart" problem.
 */
const PUBLIC_URL = process.env.DESIGN_AGENT_PUBLIC_URL?.trim().replace(/\/+$/, "");

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Figma Design Agent");
  console.log(`  MCP    http://${HOST}:${PORT}/mcp`);
  console.log(`  Plugin ws://${HOST}:${PORT}/ws`);
  console.log(`  Health http://${HOST}:${PORT}/health`);
  console.log(`  Auth   /mcp ${auth.mcpSecret ? "bearer secret" : "OPEN"} | /ws ${auth.pluginSecret ? "secret required" : "OPEN"}`);
  if (PUBLIC_URL) {
    console.log("");
    console.log(`  Fixed public endpoint: ${PUBLIC_URL}/mcp`);
    console.log("  Set the same value as DESIGN_AGENT_PUBLIC_URL when building the plugin");
    console.log("  (npm run build:plugin) so the plugin skips the local tunnel entirely.");
  }
  console.log("");
});

function shutdown(signal: string): void {
  console.log(`\n[server] ${signal} — shutting down`);
  registry.shutdown();
  void mcp.close().finally(() => {
    wss.close();
    server.close(() => process.exit(0));
    (setTimeout(() => process.exit(0), 2000) as unknown as NodeJS.Timeout).unref();
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
