/**
 * Plugin iframe — the ONLY context with network access.
 *
 * Figma's plugin main thread does not expose fetch/WebSocket, so this file
 * owns the socket to the Design Agent server and bridges every document
 * operation to the main thread over postMessage (SPEC §8: the plugin must
 * survive reconnects, so the socket here is backed by exponential backoff).
 *
 * Handshake:
 *   socket open -> ask main thread for document identity -> send `register`
 *   server      -> `welcome` { sessionId }
 *   thereafter  -> server sends `request`, we relay and reply with `result`
 */
import type {
  ClientMessage,
  MainToUi,
  PanelSummary,
  RegisterMessage,
  ServerMessage,
  StateMessage,
  StatusResult,
  UiToMain,
} from "../../shared/protocol";

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
/** Default budget for fast reads. Long builds get their own (see timeoutFor). */
const REQUEST_TIMEOUT_MS = 60000;
/** Builds routinely exceed 60s (fonts + hundreds of ops); timing out first and
 * committing late is the "blank, then everything pops at once" bug. */
const LONG_BUILD_TIMEOUT_MS = 300000;
const HEARTBEAT_MS = 5000;

/** Long builds get a 5-minute budget; everything else keeps the 60s one so a
 * dead main thread still fails fast instead of hanging the MCP call. */
function timeoutFor(tool: string): number {
  switch (tool) {
    case "create_design":
    case "modify_design":
    case "update_component":
    case "native_design":
      return LONG_BUILD_TIMEOUT_MS;
    case "render_node":
      return 120000;
    default:
      return REQUEST_TIMEOUT_MS;
  }
}

interface StatusPayload extends StatusResult {
  pageId?: string;
  selection?: Array<{ id: string; type: string; name: string }>;
}

let ws: WebSocket | null = null;
let config: { url: string; secret?: string; pluginVersion: string } | null = null;
let attempts = 0;
let reconnectTimer: number | undefined;
let heartbeatTimer: number | undefined;
let haltReconnect = false;
let registered = false;
/** Last known document status: heartbeat sends this without main-thread round trips. */
let lastStatus: StatusPayload | null = null;

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();

/* -------------------------------------------------------------------------- */
/* DOM                                                                        */
/* -------------------------------------------------------------------------- */

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

const dot = el<HTMLSpanElement>("dot");
const connTextEl = el<HTMLSpanElement>("conn-text");
const latestEl = el<HTMLDivElement>("latest");
const fileEl = el<HTMLSpanElement>("file");
const pageEl = el<HTMLSpanElement>("page");
const versionEl = el<HTMLSpanElement>("version");

const logEl = el<HTMLDivElement>("log");
const urlInput = el<HTMLInputElement>("url");
const secretInput = el<HTMLInputElement>("secret");
const saveBtn = el<HTMLButtonElement>("save");
const saveStatusEl = el<HTMLDivElement>("save-status");
const progressEl = el<HTMLDivElement>("progress");
const progressBarEl = el<HTMLDivElement>("progress-bar");
const progressLabelEl = el<HTMLDivElement>("progress-label");
const activityEl = el<HTMLDivElement>("activity");
const previewEl = el<HTMLImageElement>("preview");

type Status = "connected" | "connecting" | "disconnected" | "error";

function setState(status: Status): void {
  dot.className = `dot ${status}`;
  connTextEl.textContent =
    status === "connected"
      ? "Connected"
      : status === "connecting"
        ? "Connecting…"
        : status === "disconnected"
          ? "Disconnected"
          : "Error";
  connTextEl.className = status;
  connTextEl.id = "conn-text";
}

/** Apply-button feedback: instant "Saved" cue plus connection outcome. */
function setSaveBusy(busy: boolean): void {
  saveBtn.disabled = busy;
  saveBtn.textContent = busy ? "Applying…" : "Apply";
}

function setSaveStatus(kind: "ok" | "err" | "info", message: string): void {
  saveStatusEl.textContent = message;
  saveStatusEl.className = `note${kind === "ok" ? " ok" : kind === "err" ? " err" : ""}`;
}

function appendLog(level: string, message: string): void {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const line = document.createElement("div");
  if (level === "warn") line.className = "warn";
  if (level === "error") line.className = "error";
  line.textContent = `${ts}  ${message}`;
  logEl.prepend(line);
  while (logEl.childElementCount > 60) logEl.lastElementChild?.remove();
  // Always-visible latest line on top: one message, no need to open the log.
  latestEl.textContent = message;
  latestEl.className = level === "error" ? "err" : "";
  latestEl.id = "latest";
}

function toMain(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, "*");
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Renders the panel header from a summary.
 *
 * Deliberately minimal: file, page and version. Everything else the agent needs
 * lives in ChatGPT's tool calls, not in this 340px window.
 */
function render(summary: PanelSummary): void {
  fileEl.textContent = summary.fileName;
  pageEl.textContent = summary.pageName;
  versionEl.textContent = `v${summary.pluginVersion}`;
}

/**
 * Shows build progress while a transaction lands.
 *
 * The bar is the only animation in the panel, and it exists for one reason: a
 * large program used to apply inside a single synchronous run, so the screen
 * appeared all at once with no warning. Now regions land one after another and
 * this narrates. Terminal phases (done/failed) stay visible for a few seconds
 * so a fast build still reads as finished instead of flashing and vanishing.
 */
let progressHideTimer: number | undefined;
function renderProgress(msg: Extract<MainToUi, { kind: "progress" }>): void {
  if (progressHideTimer !== undefined) {
    window.clearTimeout(progressHideTimer);
    progressHideTimer = undefined;
  }
  const terminal = msg.phase === "done" || msg.phase === "failed";
  progressEl.style.visibility = "visible";
  progressLabelEl.style.visibility = "visible";

  const ratio = msg.total > 0 ? Math.min(1, msg.done / msg.total) : 0;
  progressBarEl.style.width = terminal && msg.phase === "done" ? "100%" : `${Math.round(ratio * 100)}%`;
  progressLabelEl.textContent =
    msg.phase === "failed"
      ? `Failed - ${msg.label}`
      : msg.phase === "done"
        ? msg.total > 0
          ? `Done ${msg.total}/${msg.total} - ${msg.label}`
          : `Done - ${msg.label}`
        : msg.total > 0
          ? `${msg.done}/${msg.total} - ${msg.label}`
          : msg.label;

  // Forward upstream so the server can extend its timeout instead of firing
  // on silence mid-build (the timeout-then-late-commit race behind the
  // "blank page, then everything pops at once" report).
  try {
    send({
      type: "progress",
      transactionId: msg.transactionId,
      done: msg.done,
      total: msg.total,
      label: msg.label,
      phase: msg.phase,
      at: Date.now(),
    });
  } catch {
    /* best-effort: panel display matters more than the upstream copy */
  }

  if (terminal) {
    progressHideTimer = window.setTimeout(() => {
      progressEl.style.visibility = "hidden";
      progressLabelEl.style.visibility = "hidden";
    }, 4000);
  }
}

/**
 * Renders a server notification: agent activity or a render preview.
 *
 * Text is assigned, never interpolated into HTML: activity lines describe
 * tool calls, and tool output is untrusted the same way layer names are.
 */
function renderNotify(msg: Extract<ServerMessage, { type: "notify" }>): void {
  if (msg.kind === "activity") {
    activityEl.textContent = msg.text;
    return;
  }

  previewEl.src = `data:${msg.mimeType};base64,${msg.data}`;
  previewEl.alt = msg.label;
  previewEl.title = msg.label;
  previewEl.style.display = "";
}

/* -------------------------------------------------------------------------- */
/* Main-thread request bridge                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Main-thread round trip. Only used for the bootstrap `figma_status` call, so
 * the tool is typed rather than cast — an unknown tool name must not be able
 * to reach the dispatch table in code.ts.
 */
function request(tool: "figma_status", payload: unknown = {}): Promise<unknown> {
  const requestId = `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Timed out waiting for the plugin main thread (${tool}).`));
    }, REQUEST_TIMEOUT_MS);

    pending.set(requestId, { resolve, reject, timer });
    toMain({ kind: "request", requestId, tool, payload });
  });
}

function settle(requestId: string, ok: boolean, data?: unknown, error?: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  window.clearTimeout(entry.timer);
  pending.delete(requestId);
  if (ok) entry.resolve(data);
  else entry.reject(new Error(error ?? "Plugin reported an unknown error."));
}

function failAllPending(reason: string): void {
  for (const [, p] of pending) {
    window.clearTimeout(p.timer);
    p.reject(new Error(reason));
  }
  pending.clear();
}

/* -------------------------------------------------------------------------- */
/* Socket                                                                     */
/* -------------------------------------------------------------------------- */

function httpToWs(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, "")
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
}

/**
 * The server URL may carry a secret as a query param, e.g.
 *   http://127.0.0.1:8787?secret=hunter2
 * which keeps the panel to a single field. Only the server cares about it, so
 * it is split back out before the socket URL is built.
 */
function splitSecret(input: string): { base: string; secret: string | undefined } {
  const q = input.indexOf("?");
  if (q === -1) return { base: input.trim(), secret: undefined };
  const base = input.slice(0, q).trim();
  const secret = new URLSearchParams(input.slice(q + 1)).get("secret") ?? undefined;
  return { base, secret: secret || undefined };
}

function connect(): void {
  if (!config) return;
  if (haltReconnect) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  const { base, secret } = splitSecret(config.url);
  const wsUrl = secret ? `${httpToWs(base)}/ws?secret=${encodeURIComponent(secret)}` : `${httpToWs(base)}/ws`;
  setState("connecting");
  appendLog(
    "info",
    attempts === 0
      ? `Opening socket -> ${httpToWs(base)}/ws`
      : `Reconnecting (attempt ${attempts}) -> ${httpToWs(base)}/ws`,
  );

  let socket: WebSocket;
  try {
    socket = new WebSocket(wsUrl);
  } catch (err) {
    appendLog("error", `Could not open ${wsUrl}: ${String(err)}`);
    scheduleReconnect();
    return;
  }
  ws = socket;

  // A socket stuck in CONNECTING (no open, error or close) would otherwise
  // wedge connect() forever: every later call returns early on the stale
  // CONNECTING check while nothing ever connects.
  const connectingTimer = window.setTimeout(() => {
    if (ws === socket && socket.readyState === WebSocket.CONNECTING) {
      appendLog("warn", "Connection attempt stalled — retrying with a fresh socket.");
      try {
        socket.close(1000, "connect-timeout");
      } catch {
        /* close is best-effort; onclose reschedules */
      }
      if (ws === socket) {
        ws = null;
        scheduleReconnect();
      }
    }
  }, 15000);

  // Every handler below is a no-op once this socket has been superseded. Without
  // this guard a stale socket's late onclose nulls out `ws`, which points at the
  // replacement socket — and every subsequent send() silently no-ops, so the
  // plugin never registers and never turns green.
  const isCurrent = () => ws === socket;

  socket.onopen = () => {
    window.clearTimeout(connectingTimer);
    if (!isCurrent()) {
      socket.close(1000, "superseded");
      return;
    }
    attempts = 0;
    appendLog("info", "Socket open, registering…");
    void bootstrapAndRegister();
  };

  socket.onmessage = (ev: MessageEvent<string>) => {
    if (!isCurrent()) return;
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data) as ServerMessage;
    } catch {
      appendLog("error", "Received a malformed frame from the server.");
      return;
    }
    route(msg);
  };

  socket.onerror = () => {
    if (!isCurrent()) return;
    setState("error");
    appendLog("error", "Socket error. Is the Design Agent server running?");
    if (saveBtn.disabled) setSaveStatus("err", "✗ Could not reach server – check the URL, then Apply.");
  };

  socket.onclose = (ev: CloseEvent) => {
    window.clearTimeout(connectingTimer);
    if (!isCurrent()) return;
    ws = null;
    registered = false;
    stopHeartbeat();
    failAllPending(ev.reason || "socket closed");

    // 4401/4403 are auth failures from the server. Retrying cannot help, so
    // stop instead of hammering it and leave the reason on screen.
    if (ev.code === 4401 || ev.code === 4403) {
      setState("error");
      appendLog("error", `${ev.reason} Check PLUGIN_SECRET in the field above, then Apply.`);
      setSaveBusy(false);
      setSaveStatus("err", "✗ Wrong secret – check PLUGIN_SECRET, then Apply.");
      return;
    }
    if (ev.code === 4002) {
      setState("error");
      appendLog("error", "Connected but never registered. Close and re-run the plugin in Figma.");
      setSaveBusy(false);
      setSaveStatus("err", "✗ Server rejected registration – re-open the plugin.");
      return;
    }

    setState("connecting");
    appendLog("warn", `Socket closed (code ${ev.code}). Retrying…`);
    if (saveBtn.disabled) setSaveStatus("info", "Connecting… (retrying)");
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  attempts += 1;
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempts - 1), RECONNECT_MAX_MS);
  reconnectTimer = window.setTimeout(connect, delay);
}

function send(payload: ClientMessage): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}

/* -------------------------------------------------------------------------- */
/* Handshake + heartbeat                                                       */
/* -------------------------------------------------------------------------- */

async function bootstrapAndRegister(): Promise<void> {
  let status: StatusPayload;
  try {
    status = (await request("figma_status")) as StatusPayload;
  } catch (err) {
    appendLog("error", `Could not read document state: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const register: RegisterMessage = {
    type: "register",
    // SPEC §9 / §32: identity only. Never a Figma OAuth or access token.
    fileKey: status.fileKey ?? null,
    fileName: status.fileName ?? figma_baseline_name(),
    pageId: status.pageId ?? "",
    pageName: status.pageName ?? "",
    selection: status.selection ?? [],
    pluginVersion: config?.pluginVersion ?? "0.0.0",
    secret: config?.secret || undefined,
  };
  lastStatus = status;

  send(register);

  // The server never answers a bad register secret with a frame — it just
  // closes. Time out locally so the panel says so instead of sitting silent.
  window.setTimeout(() => {
    if (haltReconnect) return;
    if (ws && ws.readyState === WebSocket.OPEN && !registered) {
      appendLog("error", "No response to registration. The server may be rejecting the secret — check the field above, or restart the server without one.");
    }
  }, 6000);
}

/** figma is not exposed to the iframe; used only as a last-resort fallback. */
function figma_baseline_name(): string {
  return "Untitled";
}

function startHeartbeat(): void {
  stopHeartbeat();
  let ticks = 0;
  heartbeatTimer = window.setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Socket-level liveness must not depend on the main thread: during long
    // builds the main thread is wedged and a round trip would stall, making a
    // healthy connection look dead server-side. Send the cached status every
    // tick; refresh the cache from the main thread every ~30s.
    ticks += 1;
    const cached = lastStatus;
    if (cached && ticks % 6 !== 0) {
      send({
        type: "state",
        pageId: cached.pageId ?? "",
        pageName: cached.pageName ?? "",
        selection: cached.selection ?? [],
        editorType: "figma",
        at: Date.now(),
      });
      return;
    }
    void request("figma_status")
      .then((raw) => {
        const s = raw as StatusPayload;
        lastStatus = s;
        const state: StateMessage = {
          type: "state",
          pageId: s.pageId ?? "",
          pageName: s.pageName ?? "",
          selection: s.selection ?? [],
          editorType: "figma",
          at: Date.now(),
        };
        send(state);
        if (s.fileName) {
          fileEl.textContent = s.fileName;
          pageEl.textContent = s.pageName ?? "";
        }
      })
      .catch(() => {
        /* heartbeat is best-effort */
      });
  }, HEARTBEAT_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== undefined) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound routing                                                            */
/* -------------------------------------------------------------------------- */

function route(msg: ServerMessage): void {
  switch (msg.type) {
    case "welcome": {
      registered = true;
      setState("connected");

      toMain({ kind: "connected", status: "connected", sessionId: msg.sessionId });
      appendLog("info", `Registered — session ${msg.sessionId}`);
      const justApplied = saveBtn.disabled;
      setSaveBusy(false);
      setSaveStatus("ok", justApplied ? "✓ Connected – settings saved." : "✓ Connected.");
      startHeartbeat();
      break;
    }

    case "request": {
      const requestId = msg.requestId;
      const budget = timeoutFor(msg.tool);
      pending.set(requestId, {
        resolve: (data) => {
          send({ type: "result", requestId, ok: true, data });
        },
        reject: (err) => {
          send({ type: "result", requestId, ok: false, error: err.message });
        },
        timer: window.setTimeout(() => {
          pending.delete(requestId);
          send({
            type: "result",
            requestId,
            ok: false,
            error: `Plugin timed out after ${budget}ms executing ${msg.tool}.`,
          });
        }, budget),
      });

      toMain({ kind: "request", requestId, tool: msg.tool, payload: msg.payload });
      break;
    }

    case "disconnect": {
      appendLog("warn", `Server requested disconnect: ${msg.reason}`);
      // Terminal: the server is going away, so do not auto-retry.
      haltReconnect = true;
      ws?.close(1000, msg.reason);
      setState("disconnected");
      break;
    }

    case "notify": {
      renderNotify(msg);
      break;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Main-thread messages                                                        */
/* -------------------------------------------------------------------------- */

window.addEventListener("message", (ev: MessageEvent<{ pluginMessage: MainToUi }>) => {
  const msg = ev.data?.pluginMessage;
  if (!msg) return;

  switch (msg.kind) {
    case "server-config": {
      const { base, secret } = splitSecret(msg.url);
      config = { url: base, secret: secret ?? msg.secret, pluginVersion: msg.pluginVersion };
      urlInput.value = base;
      secretInput.value = config.secret ?? "";
      versionEl.textContent = `v${msg.pluginVersion}`;
      appendLog("info", `Server config received: ${base}`);
      connect();
      break;
    }

case "panel-summary":
      render(msg.summary);
      break;

    case "progress":
      renderProgress(msg);
      break;

    case "response":
      settle(msg.requestId, msg.ok, msg.data, msg.error);
      break;

    case "log":
      appendLog(msg.level, msg.message);
      break;
  }
});

/* -------------------------------------------------------------------------- */
/* Controls                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Asks the main thread for a fresh summary. Sent on ready and after any
 * connection change; selection changes arrive on their own via
 * `selectionchange`.
 */
function refreshPanel(): void {
  toMain({ kind: "refresh-panel" });
}

el<HTMLButtonElement>("save").addEventListener("click", () => {
  if (!config) {
    appendLog("error", "No server config received yet from the plugin host.");
    setSaveStatus("err", "✗ Not ready yet – wait a second, then Apply.");
    return;
  }
  const raw = urlInput.value.trim();
  if (!raw) {
    appendLog("error", "Server URL is empty.");
    setSaveStatus("err", "✗ Server URL is empty.");
    return;
  }
  const { base, secret: querySecret } = splitSecret(raw);
  // The dedicated secret field is the primary source; ?secret= in the URL is
  // the legacy single-field style. Previously the field was never read, so a
  // server with PLUGIN_SECRET set could never connect (HTTP 401 -> code 1006).
  const fieldSecret = secretInput.value.trim() || undefined;
  const secret = querySecret ?? fieldSecret;

  const changed = base !== config.url || secret !== config.secret;
  config = { ...config, url: base, secret };
  toMain({ kind: "config", url: base, secret });

  setSaveBusy(true);
  setSaveStatus("info", "Saving… connecting…");

  // The connection header is independent of document state, but repaint anyway
  // so the panel never shows a stale file name after a switch.
  if (!changed) refreshPanel();
  appendLog("info", `Reconnecting to ${base}${secret ? " (secret set)" : " (no secret)"}…`);

  if (reconnectTimer !== undefined) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  attempts = 0;
  haltReconnect = false;
  registered = false;

  // Detach the old socket BEFORE closing it. Its onclose runs asynchronously,
  // after connect() has installed the replacement, so it would otherwise null
  // out `ws` and silently break every later send.
  const stale = ws;
  ws = null;
  stopHeartbeat();
  stale?.close(1000, "reconfigure");

  connect();
});

// Announce readiness so the main thread can flush queued config, then pull an
// initial summary so the panel is populated without waiting for a selection
// change.
toMain({ kind: "ready" });
refreshPanel();

// A sleeping laptop, a backgrounded tab or a proxy that severs idle sockets
// all look identical from here: the socket dies quietly. Reconnect the moment
// the environment signals it can, instead of waiting out the backoff.
window.addEventListener("online", () => {
  if (!ws || ws.readyState === WebSocket.CLOSED) {
    attempts = 0;
    connect();
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!ws || ws.readyState === WebSocket.CLOSED)) {
    attempts = 0;
    connect();
  }
});
