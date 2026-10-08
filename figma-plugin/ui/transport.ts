/**
 * The UI-side wire transport (plugin iframe <-> MCP server).
 *
 * ## Why this is a separate module
 *
 * This logic used to live inside `ui.ts` alongside the DOM. That made it
 * impossible to test: `ui.ts` needs `window`, `document` and `parent.postMessage`,
 * none of which exist under Node. So the translation between the *server's* JSON-RPC
 * frames and the *main thread's* postMessage protocol had no test coverage at all.
 *
 * That is precisely the seam where bugs hide. The first full end-to-end run — the
 * real plugin bundle over a real socket against the real server — failed with
 * "the Figma plugin disconnected while executing a command", because nothing
 * outside a browser had ever executed this translation.
 *
 * So it is extracted here, DOM-free and dependency-injected. `ui.ts` supplies real
 * DOM callbacks; the end-to-end test supplies none. Both exercise the same code,
 * which means the test cannot pass while the real UI is broken.
 *
 * The protocol it implements, in full:
 *
 *   socket open    -> ask main for document identity -> send `register`
 *   server welcome -> tell main `connected`, start the heartbeat
 *   server request -> relay to main as `{kind:"request"}`, reply as `result`
 *   main response  -> settle the pending promise
 *   heartbeat      -> poll main for state, send `state` upstream
 */
import type { ClientMessage, MainToUi, ServerMessage, StatusResult, UiToMain } from "../../shared/protocol";

/** The slice of the WebSocket API this module uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface TransportOptions {
  /** Full WebSocket URL including the secret query parameter. */
  url: string;
  /**
   * The shared secret, presented again in the `register` frame.
   *
   * The URL query authenticates the WebSocket upgrade; the register frame is a
   * second, independent confirmation that the holder of the socket also holds the
   * secret. Both are required, so the secret travels in both places.
   */
  secret?: string;
  /** Creates the socket. Injected so tests can supply a `ws` client. */
  createSocket: (url: string) => SocketLike;
  /** Delivers a message to the plugin's main thread. */
  postToMain: (msg: UiToMain) => void;
  /** Human-readable log line for the panel. */
  log?: (level: "info" | "warn" | "error", message: string) => void;
  /** Panel connection state changed. */
  onState?: (state: "connecting" | "connected" | "disconnected") => void;
  /** A `disconnect` frame arrived, or the server sent a fatal error. */
  onFatal?: (reason: string) => void;

  /** How long the main thread gets to answer one request. */
  requestTimeoutMs?: number;
  /** How often to poll state. 0 disables the heartbeat. */
  heartbeatMs?: number;

  /** Called once the server has accepted the registration. */
  onRegistered?: (sessionId: string) => void;
  /**
   * Called for every server notification (agent activity, render previews).
   * Defaults to logging, so headless transports record the stream for free.
   */
  onNotify?: (msg: Extract<ServerMessage, { type: "notify" }>) => void;
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 60000;
/** Long builds (fonts + hundreds of ops) need minutes, not seconds. */
export const LONG_BUILD_TIMEOUT_MS = 300000;
export const DEFAULT_HEARTBEAT_MS = 5000;

/** Per-tool budget: builds get 5 minutes so the server never times out first
 * and commits late (the "blank, then everything pops at once" race). */
export function timeoutForTool(tool: string): number {
  switch (tool) {
    case "create_design":
    case "modify_design":
    case "update_component":
    case "native_design":
    case "execute_figma_script":
      return LONG_BUILD_TIMEOUT_MS;
    case "render_node":
      return 120000;
    default:
      return DEFAULT_REQUEST_TIMEOUT_MS;
  }
}

interface Pending {
  resolve: (data: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface Transport {
  /** Sends an upstream frame. Returns false when the socket is not open. */
  send(payload: ClientMessage): boolean;
  /** Asks the main thread for something and awaits its reply. */
  request<T = unknown>(kind: string, extra?: Record<string, unknown>): Promise<T>;
  /** Feeds a main-thread message into the transport. */
  acceptFromMain(msg: MainToUi): void;
  /** Starts connecting. Safe to call once. */
  start(): void;
  /** Closes the socket and stops the heartbeat. */
  close(code?: number, reason?: string): void;
  isRegistered(): boolean;
  /** Test hook: rejects every in-flight request. */
  failAllPending(reason: string): void;
}

/**
 * Builds the transport.
 *
 * Kept as a factory rather than a class so the state is obvious in one place and
 * the timers are captured per instance, which matters because a test may create
 * several.
 */
export function createTransport(options: TransportOptions): Transport {
  const {
    url,
    secret,
    createSocket,
    postToMain,
    log = () => {},
    onState = () => {},
    onFatal = () => {},
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    onRegistered = () => {},
    onNotify = (msg) => log("info", msg.kind === "activity" ? msg.text : `preview: ${msg.label}`),
  } = options;

  let socket: SocketLike | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let registered = false;
  let stopped = false;
  const pending = new Map<string, Pending>();

  const setState = (state: "connecting" | "connected" | "disconnected"): void => onState(state);

  const send = (payload: ClientMessage): boolean => {
    if (!socket) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      log("error", `Send failed: ${(error as Error).message}`);
      return false;
    }
  };

  const settle = (requestId: string, ok: boolean, data?: unknown, error?: string): void => {
    const entry = pending.get(requestId);
    if (!entry) return;
    pending.delete(requestId);
    clearTimeout(entry.timer);
    if (ok) entry.resolve(data);
    else entry.reject(new Error(error ?? "unknown plugin error"));
  };

  /** Asks the main thread for something. Rejects if it does not answer in time. */
  const request = <T,>(kind: string, extra: Record<string, unknown> = {}): Promise<T> => {
    const requestId = `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`The plugin did not answer '${kind}' within ${requestTimeoutMs}ms.`));
      }, requestTimeoutMs);

      pending.set(requestId, { resolve: resolve as (data: unknown) => void, reject, timer });
      postToMain({ kind: "request", requestId, tool: kind, payload: extra } as unknown as UiToMain);
    });
  };

  const stopHeartbeat = (): void => {
    if (heartbeat !== undefined) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  const startHeartbeat = (): void => {
    stopHeartbeat();
    if (heartbeatMs <= 0) return;

    heartbeat = setInterval(() => {
      void request<StatusResult>("figma_status")
        .then((status) => {
          send({
            type: "state",
            pageId: status.pageId ?? "",
            pageName: status.pageName ?? "",
            selection: status.selection ?? [],
            // The plugin cannot tell a Figma editor from Figma Dev Mode, so the
            // editor type is a constant here rather than something invented.
            editorType: "figma",
            at: Date.now(),
          });
        })
        .catch(() => {
          // Best-effort by design: a missed heartbeat is not an error, and the
          // server's own request/response path is the liveness signal that matters.
        });
    }, heartbeatMs);

    // Never hold the Node process open for a heartbeat.
    if (typeof (heartbeat as unknown as { unref?: () => void }).unref === "function") {
      (heartbeat as unknown as { unref: () => void }).unref();
    }
  };

  /** Routes a server frame. */
  const route = (msg: ServerMessage): void => {
    switch (msg.type) {
      case "welcome": {
        registered = true;
        setState("connected");
        postToMain({ kind: "connected", status: "connected", sessionId: msg.sessionId } as UiToMain);
        log("info", `Registered - session ${msg.sessionId}`);
        onRegistered(msg.sessionId);
        startHeartbeat();
        break;
      }

      case "request": {
        const requestId = msg.requestId;
        // Per-tool budget: a global 20s/60s timeout fires mid-build while the
        // main thread is still applying ops, producing a failure on ChatGPT's
        // side followed by a late commit ("blank, then everything pops").
        const budget = Math.max(requestTimeoutMs, timeoutForTool(msg.tool));
        pending.set(requestId, {
          resolve: (data) => {
            send({ type: "result", requestId, ok: true, data });
          },
          reject: (err) => {
            send({ type: "result", requestId, ok: false, error: err.message });
          },
          // A timeout the main thread never answers must still produce a `result`,
          // or the server waits forever and the MCP call hangs rather than failing.
          timer: setTimeout(() => {
            pending.delete(requestId);
            send({
              type: "result",
              requestId,
              ok: false,
              error: `Plugin timed out after ${budget}ms executing ${msg.tool}.`,
            });
          }, budget),
        });

        postToMain({ kind: "request", requestId, tool: msg.tool, payload: msg.payload } as unknown as UiToMain);
        break;
      }

      case "disconnect": {
        log("warn", `Server requested disconnect: ${msg.reason}`);
        stopped = true;
        stopHeartbeat();
        socket?.close(1000, msg.reason);
        setState("disconnected");
        onFatal(msg.reason);
        break;
      }

      case "notify": {
        // One-way by contract: nothing to answer, just surface. The callback
        // defaults to the log so a headless transport still records the stream.
        onNotify(msg);
        break;
      }
    }
  };

  /** Feeds a main-thread message into the transport. */
  const acceptFromMain = (msg: MainToUi): void => {
    if (!msg) return;
    if (msg.kind === "response") {
      settle(msg.requestId, msg.ok, msg.data, msg.error);
      return;
    }
    if (msg.kind === "progress") {
      // Upstream build heartbeat: lets the server extend its timeout and log
      // the build instead of failing on silence mid-transaction.
      send({
        type: "progress",
        transactionId: msg.transactionId,
        done: msg.done,
        total: msg.total,
        label: msg.label,
        phase: msg.phase,
        at: Date.now(),
      });
      return;
    }
    // `ready` is the main thread announcing itself; nothing to translate, the
    // caller starts the socket once it has the server config.
  };

  /**
   * Reads document identity from the main thread and registers.
   *
   * Registration carries identity only. Never a Figma OAuth or access token --
   * that boundary is deliberate and lives here, so it is one line to audit.
   */
  const bootstrapAndRegister = async (): Promise<void> => {
    let status: StatusResult;
    try {
      status = await request<StatusResult>("figma_status");
    } catch (error) {
      log("error", `Could not read document state: ${(error as Error).message}`);
      return;
    }

    send({
      type: "register",
      fileKey: status.fileKey ?? null,
      fileName: status.fileName ?? "Figma file",
      pageId: status.pageId ?? "",
      pageName: status.pageName ?? "",
      selection: status.selection ?? [],
      pluginVersion: status.pluginVersion ?? "0.0.0",
      // The register frame re-presents the secret as an independent check that
      // whoever opened this socket also holds it.
      ...(secret !== undefined ? { secret } : {}),
    });
  };

  const start = (): void => {
    stopped = false;
    setState("connecting");

    socket = createSocket(url);
    socket.onopen = () => {
      void bootstrapAndRegister();
    };

    socket.onmessage = (event) => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        log("warn", "Dropped a non-JSON frame from the server.");
        return;
      }
      if (!parsed || typeof parsed.type !== "string") {
        log("warn", "Dropped a frame with no type.");
        return;
      }
      route(parsed);
    };

    socket.onerror = () => {
      log("error", "WebSocket error.");
      setState("disconnected");
    };

    socket.onclose = (event) => {
      stopHeartbeat();
      setState("disconnected");
      const code = (event as { code?: number }).code;
      if (code === 4403) {
        log("error", "Server rejected the secret.");
        onFatal("invalid secret");
        return;
      }
      if (stopped) return;
      log("warn", `Disconnected (${code ?? "no code"}).`);
    };
  };

  const close = (code = 1000, reason = "closed"): void => {
    stopped = true;
    stopHeartbeat();
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
    socket?.close(code, reason);
    socket = null;
    registered = false;
  };

  const failAllPending = (reason: string): void => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    pending.clear();
  };

  return {
    send,
    request: request as Transport["request"],
    acceptFromMain,
    start,
    close,
    isRegistered: () => registered,
    failAllPending,
  };
}