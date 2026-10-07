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
import type { ClientMessage } from "../../shared/protocol";
import { createMcpHandler } from "./mcp";
import { SessionRegistry } from "./sessions";
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
    "access-control-allow-headers": "content-type,authorization,x-api-key,mcp-session-id,mcp-protocol-version,last-event-id",
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
    res.end(
      JSON.stringify(
        {
          ok: true,
          sessions: registry.alive().map((s) => s.status()),
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
        console.log(`[ws] registered ${session.id} → "${session.fileName}" / "${session.pageName}"`);
        session.send({ type: "welcome", sessionId: session.id, heartbeatMs: 5000 });
        break;
      }

      case "state":
        session.applyState(msg);
        break;

      case "result":
        session.settleResult(msg);
        break;

      default:
        console.warn(`[ws] unexpected frame type from ${session.id}: ${(msg as { type: string }).type}`);
    }
  });

  ws.on("error", (err) => console.error(`[ws] ${session.id} error:`, err.message));
});

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
