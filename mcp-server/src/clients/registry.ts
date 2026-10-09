/**
 * Named MCP client connections + who-is-doing-what (points: names, concurrency).
 *
 * The MCP transport is stateless (a fresh server per HTTP request), so there
 * is no persistent "connection" object for an agent client. What survives
 * across requests is (a) the client identity from the MCP `initialize`
 * handshake (`clientInfo.name/version`, e.g. ChatGPT, Claude Code) and
 * (b) this registry. One process-wide singleton: every stateless transport
 * reports into the same place, which is exactly what makes concurrent clients
 * visible to each other.
 *
 * Honesty rules:
 * - Names come from what the client *reported*, prettified, never invented.
 *   Unknown names display as-is (capitalized), with the raw string kept.
 * - Clients are grouped by reported name. Two ChatGPT tabs are one "ChatGPT"
 *   entry with a call count — the protocol gives us nothing to tell them
 *   apart in stateless mode, and pretending otherwise would be a lie.
 * - The activity log is a bounded ring (latest 50). It is evidence of what
 *   ran, not a replay log.
 */
import type { ClientActivity, ClientConnection } from "../../../shared/protocol";

export interface ActiveCall {
  tool: string;
  target: string;
  startedAt: number;
}

interface Entry {
  key: string;
  display: string;
  reported: string;
  version: string;
  firstSeen: number;
  lastSeen: number;
  /** Last touch order; breaks wall-clock ties in snapshots. */
  seq: number;
  calls: number;
  errors: number;
  lastTool: string;
  lastTarget: string;
  lastStatus: string;
  active: Map<string, ActiveCall>;
}

const MAX_CLIENTS = 20;
const MAX_ACTIVITY = 50;

/** Known clientInfo names → display names. Everything else is prettified raw. */
const KNOWN: Record<string, string> = {
  chatgpt: "ChatGPT",
  "chatgpt-connector": "ChatGPT",
  "claude-code": "Claude Code",
  anthropic: "Claude",
  cursor: "Cursor",
  antigravity: "Antigravity",
  windsurf: "Windsurf",
  cline: "Cline",
  goose: "Goose",
  "mcp-inspector": "MCP Inspector",
  opencode: "OpenCode",
  "claude": "Claude",
};

/** "claude-code" → "Claude Code"; "" → "Unknown client". */
export function friendlyClientName(raw: string | undefined | null): string {
  const clean = (raw ?? "").trim().toLowerCase().replace(/[_]+/g, "-");
  if (!clean) return "Unknown client";
  if (KNOWN[clean]) return KNOWN[clean]!;
  return clean
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Registry key: grouped by reported name, so tabs share one entry honestly. */
export function clientKey(raw: string | undefined | null): string {
  const clean = (raw ?? "").trim().toLowerCase();
  return clean || "unknown";
}

export class ClientRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly log: ClientActivity[] = [];
  private calls = 0;
  /** Monotonic touch order: wall-clock ties (same ms) still sort deterministically. */
  private seq = 0;

  seen(rawName: string | undefined | null, version?: string): Entry {
    const key = clientKey(rawName);
    const now = Date.now();
    const entry = this.entries.get(key) ?? {
      key,
      display: friendlyClientName(rawName),
      reported: (rawName ?? "").trim() || "unknown",
      version: "",
      firstSeen: now,
      lastSeen: 0,
      seq: 0,
      calls: 0,
      errors: 0,
      lastTool: "",
      lastTarget: "",
      lastStatus: "",
      active: new Map<string, ActiveCall>(),
    };
    entry.lastSeen = now;
    entry.seq = ++this.seq;
    if (version) entry.version = version;
    // A reconnecting client may report a prettier (or rawer) name; the
    // display follows the latest report, the key stays stable.
    entry.display = friendlyClientName(rawName);
    entry.reported = (rawName ?? "").trim() || "unknown";
    this.entries.set(key, entry);
    while (this.entries.size > MAX_CLIENTS) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]!;
      if (oldest.active.size > 0) break;
      this.entries.delete(oldest.key);
    }
    return entry;
  }

  start(rawName: string | undefined | null, callId: string, tool: string, target: string, version?: string): void {
    const entry = this.seen(rawName, version);
    entry.active.set(callId, { tool, target, startedAt: Date.now() });
    entry.lastSeen = Date.now();
    entry.seq = ++this.seq;
  }

  finish(callId: string, status: "ok" | "error", detail = ""): void {
    for (const entry of this.entries.values()) {
      const call = entry.active.get(callId);
      if (!call) continue;
      entry.active.delete(callId);
      entry.calls += 1;
      entry.lastSeen = Date.now();
      entry.seq = ++this.seq;
      entry.lastTool = call.tool;
      entry.lastTarget = call.target;
      entry.lastStatus = status;
      if (status === "error") entry.errors += 1;
      this.calls += 1;
      this.log.push({ at: Date.now(), client: entry.display, tool: call.tool, target: call.target, status, ...(detail ? { detail } : {}) });
      while (this.log.length > MAX_ACTIVITY) this.log.shift();
      return;
    }
    // A finish with no start is a bookkeeping bug, not a log entry. Drop it
    // rather than recording a call that never began.
  }

  /** Connections, most-recent first, with live in-flight work attached. */
  snapshot(): { connections: ClientConnection[]; activity: ClientActivity[]; totalCalls: number } {
    const now = Date.now();
    const connections = [...this.entries.values()]
      .sort((a, b) => b.seq - a.seq || b.lastSeen - a.lastSeen)
      .map((e) => ({
        key: e.key,
        display: e.display,
        reported: e.reported,
        version: e.version,
        firstSeen: e.firstSeen,
        lastSeen: e.lastSeen,
        lastSeenAgoMs: now - e.lastSeen,
        calls: e.calls,
        errors: e.errors,
        lastTool: e.lastTool,
        lastTarget: e.lastTarget,
        lastStatus: e.lastStatus,
        active: [...e.active.values()].map((c) => ({ tool: c.tool, target: c.target, forMs: now - c.startedAt })),
      }));
    return { connections, activity: [...this.log].reverse(), totalCalls: this.calls };
  }
}

/**
 * Process-wide singleton. The MCP transport mints a fresh server per request,
 * so per-instance state would make every client invisible to the rest. One
 * registry for the process is what lets figma_status show *all* connections.
 */
export const clients = new ClientRegistry();
