/**
 * Plugin session registry.
 *
 * SPEC §33: every plugin connection gets a session id, commands are scoped to
 * an active session, and if more than one Figma file is open we never guess the
 * target — the tool call fails and lists the candidates instead.
 */
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  ResultMessage,
  ServerMessage,
  StatusResult,
  PluginToolName,
} from "../../shared/protocol";

const REQUEST_TIMEOUT_MS = 60_000;
const STALE_AFTER_MS = 60_000;

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  tool: PluginToolName;
}

export class Session {
  readonly id = `session_${randomUUID()}`;
  readonly connectedAt = Date.now();
  lastSeen = Date.now();

  fileKey: string | null = null;
  fileName = "Unknown file";
  pageId = "";
  pageName = "";
  selection: Array<{ id: string; type: string; name: string }> = [];
  pluginVersion = "unknown";
  editorType = "figma";

  private readonly pending = new Map<string, Pending>();
  private closed = false;

  constructor(readonly socket: WebSocket) {
    // One listener for the whole session, not one per request. Attaching a
    // `close` listener inside request() made the socket accumulate listeners
    // until Node warned about a leak after ten tool calls.
    socket.on("close", () => {
      this.failAllPending("The Figma plugin disconnected while executing a command.");
    });
    socket.on("error", () => {
      this.failAllPending("The connection to the Figma plugin failed.");
    });
  }

  get alive(): boolean {
    return !this.closed && this.socket.readyState === this.socket.OPEN && Date.now() - this.lastSeen < STALE_AFTER_MS;
  }

  send(msg: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(msg));
  }

  register(msg: Extract<ClientMessage, { type: "register" }>): void {
    this.fileKey = msg.fileKey;
    this.fileName = msg.fileName || "Unknown file";
    this.pageId = msg.pageId;
    this.pageName = msg.pageName;
    this.selection = msg.selection ?? [];
    this.pluginVersion = msg.pluginVersion;
    this.lastSeen = Date.now();
  }

  applyState(msg: Extract<ClientMessage, { type: "state" }>): void {
    this.pageId = msg.pageId;
    this.pageName = msg.pageName;
    this.selection = msg.selection ?? [];
    this.editorType = msg.editorType;
    this.lastSeen = msg.at ?? Date.now();
  }

  /** Dispatch a tool to the plugin and await its result. */
  request(tool: PluginToolName, payload: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.alive) {
      return Promise.reject(new Error(`Plugin session ${this.id} is not connected.`));
    }

    const requestId = `r_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`The Figma plugin did not respond to ${tool} within ${timeoutMs}ms. Is the plugin still open?`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, tool });
      this.send({ type: "request", requestId, tool, payload });
    });
  }

  settleResult(msg: ResultMessage): void {
    const entry = this.pending.get(msg.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(msg.requestId);
    if (msg.ok) entry.resolve(msg.data);
    else entry.reject(new Error(msg.error ?? "The Figma plugin reported an unknown error."));
  }

  failAllPending(reason: string): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  dispose(reason: string): void {
    this.closed = true;
    this.failAllPending(reason);
  }

  status(): StatusResult {
    return {
      connected: this.alive,
      sessionId: this.id,
      fileName: this.fileName,
      fileKey: this.fileKey,
      pageId: this.pageId,
      pageName: this.pageName,
      selectionCount: this.selection.length,
      pluginVersion: this.pluginVersion,
      lastSeen: this.lastSeen,
    };
  }

  describe(): string {
    return `${this.fileName} — page "${this.pageName || "?"}" — ${this.pluginVersion}`;
  }
}

/* -------------------------------------------------------------------------- */

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private readonly wsToSession = new WeakMap<WebSocket, Session>();

  add(socket: WebSocket): Session {
    const session = new Session(socket);
    this.sessions.set(session.id, session);
    this.wsToSession.set(socket, session);

    socket.on("close", () => {
      session.dispose("The Figma plugin closed the connection.");
      this.sessions.delete(session.id);
    });

    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  forSocket(socket: WebSocket): Session | undefined {
    return this.wsToSession.get(socket);
  }

  all(): Session[] {
    return [...this.sessions.values()];
  }

  alive(): Session[] {
    return this.all().filter((s) => s.alive);
  }

  /** SPEC §33: never guess the target when multiple files are open. */
  resolve(sessionId?: string): Session {
    if (sessionId) {
      const found = this.sessions.get(sessionId);
      if (!found) throw new Error(`Unknown plugin session: ${sessionId}`);
      if (!found.alive) throw new Error(`Plugin session ${sessionId} exists but is not connected.`);
      return found;
    }

    const live = this.alive();
    if (live.length === 0) {
      throw new Error(
        "No Figma Design Agent plugin is connected. Open the plugin in the target Figma file and keep it running.",
      );
    }
    if (live.length === 1) return live[0]!;

    throw new Error(
      `Multiple Figma files have the plugin open, so the target is ambiguous. Pass an explicit sessionId. Open sessions:\n${live
        .map((s) => `  ${s.id}  ${s.describe()}`)
        .join("\n")}`,
    );
  }

  shutdown(): void {
    for (const s of this.sessions.values()) {
      s.send({ type: "disconnect", reason: "The Design Agent server is shutting down." });
      s.dispose("The Design Agent server shut down.");
      s.socket.close(1001, "server shutdown");
    }
    this.sessions.clear();
  }
}
