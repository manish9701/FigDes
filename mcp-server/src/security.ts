/**
 * Authentication for both transports (SPEC 32).
 *
 * Two independent secrets, because the two clients have very different abilities:
 *
 *   /mcp    ChatGPT. Custom MCP connectors accept only "no auth" or OAuth 
 *            they CANNOT send an arbitrary bearer token. So DESIGN_AGENT_SECRET
 *            is optional here, and in the ChatGPT setup you leave it unset and
 *            rely on an unguessable, short-lived HTTPS tunnel as the boundary.
 *
 *   /ws     our own plugin iframe, which we control and CAN authenticate. Use
 *            PLUGIN_SECRET to keep document-write access locked even while /mcp
 *            is open to the tunnel.
 *
 * Figma OAuth/access tokens are never involved anywhere in this system.
 */
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";

export interface AuthConfig {
  /** Guards POST /mcp. Optional; unset means open. */
  mcpSecret: string | undefined;
  /** Guards GET /ws. Falls back to mcpSecret. */
  pluginSecret: string | undefined;
  production: boolean;
}

export function loadAuthConfig(): AuthConfig {
  const mcpSecret = process.env.DESIGN_AGENT_SECRET?.trim() || undefined;
  const pluginSecret = process.env.PLUGIN_SECRET?.trim() || mcpSecret;
  const production = process.env.NODE_ENV === "production";

  if (production && !mcpSecret) {
    console.warn(
      "[security] NODE_ENV=production but DESIGN_AGENT_SECRET is unset  /mcp will be unauthenticated. Put it behind an authenticated proxy or set PLUGIN_SECRET at minimum.",
    );
  }
  if (!mcpSecret) {
    console.warn("[security] DESIGN_AGENT_SECRET unset - /mcp is open. Fine behind a private tunnel, unsafe on a public host.");
  }
  if (!pluginSecret) {
    console.warn("[security] PLUGIN_SECRET unset - /ws is open, so anything that can reach this port can drive the Figma document.");
  }

  return { mcpSecret, pluginSecret, production };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export type Verdict = { ok: true } | { ok: false; status: number; error: string };

function bearerFrom(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string" && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string") return apiKey.trim();
  return undefined;
}

export function checkHttpAuth(req: IncomingMessage, cfg: AuthConfig): Verdict {
  if (!cfg.mcpSecret) return { ok: true };

  const presented = bearerFrom(req);
  if (!presented) {
    return { ok: false, status: 401, error: "Missing Authorization: Bearer <DESIGN_AGENT_SECRET> header." };
  }
  if (!safeEqual(presented, cfg.mcpSecret)) {
    return { ok: false, status: 403, error: "Invalid Design Agent secret." };
  }
  return { ok: true };
}

export type WsVerdict = { ok: true } | { ok: false; code: number; reason: string };

/**
 * WebSocket auth. Browsers cannot set headers on a WebSocket handshake, so the
 * plugin sends the secret as a query parameter on /ws and repeats it in the
 * `register` frame.
 */
export function checkWsAuth(url: URL, cfg: AuthConfig): WsVerdict {
  if (!cfg.pluginSecret) return { ok: true };

  const presented = url.searchParams.get("secret") ?? "";
  if (!presented) {
    return { ok: false, code: 4401, reason: "Missing secret query parameter." };
  }
  if (!safeEqual(presented, cfg.pluginSecret)) {
    return { ok: false, code: 4403, reason: "Invalid plugin secret." };
  }
  return { ok: true };
}

/** Confirms the secret the plugin repeats in its register frame. */
export function confirmRegisteredSecret(presented: string | undefined, cfg: AuthConfig): boolean {
  if (!cfg.pluginSecret) return true;
  if (!presented) return false;
  return safeEqual(presented, cfg.pluginSecret);
}
