#!/usr/bin/env node
/**
 * One-command launcher.
 *
 *   npm start
 *
 * Starts the server, opens a public HTTPS tunnel, waits for the real public
 * address, prints it prominently, copies it to the clipboard, and writes it to
 * .tools/current-url.txt.
 *
 * Why this exists: cloudflared prints the address to stderr inside a box that
 * scrolls past instantly. This reads it out of the log file instead, so you
 * always see it.
 *
* Flags:
 *   --no-tunnel        run the server only (for MCP Inspector / local use)
 *   --provider=NAME    cloudflared (default) | tailscale | ngrok
 *
 * Provider notes:
 *   cloudflared  free, no account, but the hostname changes every launch
 *   tailscale    free on every plan, stable <device>.<tailnet>.ts.net hostname
 *   ngrok        free account includes one permanent dev domain
 *
 * Only tailscale and ngrok give an address that survives a restart.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const toolsDir = resolve(root, ".tools");

const args = process.argv.slice(2);
const withTunnel = !args.includes("--no-tunnel");
const provider = (args.find((a) => a.startsWith("--provider="))?.split("=")[1] ?? process.env.TUNNEL_PROVIDER ?? "cloudflared").toLowerCase();

const PORT = process.env.PORT ?? "8787";
const HOST = process.env.HOST ?? "127.0.0.1";
const ORIGIN = `http://${HOST}:${PORT}`;

/* -------------------------------------------------------------------------- */
/* Endpoint pinning                                                            */
/* -------------------------------------------------------------------------- */

/**
 * When a provider gives out a stable hostname, write it to a known file so the
 * next `npm start` reuses the same address.
 *
 * This is what removes "paste a new link into ChatGPT every time". Once a
 * stable hostname exists, it is read back automatically; nothing else is
 * needed on subsequent runs.
 */
const endpointFile = resolve(toolsDir, "endpoint.txt");

function readPinnedEndpoint() {
  try {
    const value = readFileSync(endpointFile, "utf8").trim();
    return /^https:\/\/[a-z0-9.-]+$/i.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function pinEndpoint(url) {
  // Never store a quick-tunnel address: it changes every launch, so pinning it
  // would just be a stale value that fails on the next run.
  if (/\.trycloudflare\.com$/i.test(url)) return false;
  try {
    mkdirSync(toolsDir, { recursive: true });
    writeFileSync(endpointFile, `${url}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}

function reportPinned(url) {
  out();
  out(`  ${green("Stable endpoint detected:")} ${cyan(url)}`);
  out(dim(`  Saved to .tools/endpoint.txt - it will be reused on every start.`));
  out(dim(`  To stop using it, delete that file.`));
}

/* -------------------------------------------------------------------------- */
/* Tunnel providers                                                            */
/* -------------------------------------------------------------------------- */

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

const out = (line = "") => process.stdout.write(`${line}\n`);
const rule = () => out(dim("-".repeat(64)));

function banner(title) {
  out();
  rule();
  out(`  ${bold(title)}`);
  rule();
}

/* -------------------------------------------------------------------------- */
/* Preflight                                                                   */
/* -------------------------------------------------------------------------- */

function findCloudflared() {
  const local = resolve(toolsDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  if (existsSync(local)) return local;
  return "cloudflared"; // rely on PATH
}

function tunnelCommand() {
  if (provider === "ngrok") {
    return {
      bin: "ngrok",
      // A free account always has one permanent dev domain, so the URL never
      // changes between restarts. '--url https://' selects that domain.
      argv: ["http", PORT, "--url", "https://"],
      urlFrom: (text) => text.match(/url=(https:\/\/[^\s"\\]+)/)?.[1] ?? null,
      label: "ngrok",
      hint: "ngrok's dev domain is permanent. Set DESIGN_AGENT_PUBLIC_URL to it once and rebuild the plugin to skip the tunnel entirely.",
    };
  }

  if (provider === "tailscale") {
    return {
      bin: "tailscale",
      // Funnel is free on every plan and gives a stable <device>.<tailnet>.ts.net
      // name that never changes. --yes suppresses the interactive prompt so a
      // non-interactive launch cannot hang on a prompt nobody can see.
      argv: ["funnel", "--yes", PORT],
      urlFrom: (text) => text.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.ts\.net/)?.[0] ?? null,
      label: "Tailscale Funnel",
      hint: "This hostname is permanent. Set DESIGN_AGENT_PUBLIC_URL to it once and rebuild the plugin to skip the tunnel entirely.",
    };
  }

  const logfile = resolve(toolsDir, "tunnel.log");
  try {
    unlinkSync(logfile);
  } catch {
    /* first run */
  }

  return {
    bin: findCloudflared(),
    argv: ["tunnel", "--url", ORIGIN, "--no-autoupdate", "--logfile", logfile],
    urlFrom: (text) => text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0] ?? null,
    label: "cloudflared",
    hint: "This address changes every launch. Try --provider=tailscale or --provider=ngrok for a permanent one.",
  };
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

async function portInUse() {
  try {
    const res = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Starts the server. With `tee`, everything it prints is also appended to
 * .tools/server.log.
 *
 * This exists because the server logs which tool ChatGPT called and what failed.
 * Without the tee, that output only exists in a terminal window, so a failure
 * reported as "failing internally" could not be diagnosed after the fact.
 */
function startServer({ tee = false } = {}) {
  const child = spawn(process.execPath, [resolve(root, "mcp-server/dist/index.js")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  if (tee) {
    mkdirSync(toolsDir, { recursive: true });
    const logPath = resolve(toolsDir, "server.log");
    try {
      unlinkSync(logPath);
    } catch {
      /* first run */
    }
    writeFileSync(logPath, `--- ${new Date().toISOString()} ---\n`, "utf8");

    const stream = createWriteStream(logPath, { flags: "a" });
    const stamp = (chunk) => `[${new Date().toISOString().slice(11, 23)}] ${chunk}`;
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      s.setEncoding("utf8");
      s.on("data", (chunk) => {
        process.stdout.write(chunk);
        stream.write(stamp(chunk));
      });
    }
    child.on("close", () => stream.end());
  } else {
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  }

  return child;
}

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await portInUse()) return true;
    await sleep(250);
  }
  return false;
}

function startTunnel(tunnel) {
  return spawn(tunnel.bin, tunnel.argv, {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
  });
}

async function waitForUrl(tunnel, child, timeoutMs = 60000) {
  const logfile = resolve(toolsDir, "tunnel.log");
  const deadline = Date.now() + timeoutMs;
  let buffered = "";

  const consume = (chunk) => {
    buffered += chunk.toString();
    const found = tunnel.urlFrom(buffered);
    if (found) buffered = found; // keep only the match so we stop rescanning
    return found ?? null;
  };

  if (child.stdout) child.stdout.on("data", consume);
  if (child.stderr) child.stderr.on("data", consume);

  while (Date.now() < deadline) {
    const fromStream = tunnel.urlFrom(buffered);
    if (fromStream) return fromStream;

    if (existsSync(logfile)) {
      try {
        const text = readFileSync(logfile, "utf8");
        const found = tunnel.urlFrom(text);
        if (found) return found;
      } catch {
        /* being written right now */
      }
    }
    await sleep(500);
  }
  return null;
}

function copyToClipboard(text) {
  const attempts = {
    win32: [["powershell", "-NoProfile", "-Command", `Set-Clipboard -Value '${text}'`]],
    darwin: [["pbcopy"]],
    linux: [["wl-copy"], ["xclip", "-selection", "clipboard"]],
  };

  const candidates = attempts[process.platform] ?? [];
  for (const [bin, argv] of candidates) {
    try {
      const child = spawn(bin, argv, { stdio: ["pipe", "ignore", "ignore"] });
      child.stdin.write(text);
      child.stdin.end();
      return true;
    } catch {
      /* try the next one */
    }
  }
  return false;
}

function writeUrlFile(url) {
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(resolve(toolsDir, "current-url.txt"), `${url}\n`, "utf8");
}

/* -------------------------------------------------------------------------- */
/* Main                                                                        */
/* -------------------------------------------------------------------------- */

let shuttingDown = false;
const children = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  out();
  out(dim("Shutting down..."));
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 250);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function main() {
  banner("Figma Design Agent");

  /* server */
  if (await portInUse()) {
    out(`  ${yellow("Server already running")} on ${ORIGIN} - reusing it.`);
  } else {
    if (!existsSync(resolve(root, "mcp-server/dist/index.js"))) {
      out(`  ${dim("No build found, building...")}`);
      await new Promise((res, rej) => {
        const build = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
        build.on("exit", (c) => (c === 0 ? res() : rej(new Error(`build failed (${c})`))));
      });
    }

out(`  Starting server on ${ORIGIN}...`);
    const server = startServer({ tee: true });
    children.push(server);
    server.on("exit", (code) => {
      if (!shuttingDown) {
        out(`  ${red("Server exited unexpectedly")} (code ${code}).`);
        shutdown(1);
      }
    });

    if (!(await waitForHealth())) {
      out(`  ${red("Server did not become healthy in time. See the log above.")}`);
      shutdown(1);
      return;
    }
    out(`  ${green("Server ready")} ${dim(`${ORIGIN}/mcp`)}`);
  }

  if (!withTunnel) {
    out();
    out(`  ${bold("Local only.")} Use this address in MCP Inspector:`);
    out(`  ${cyan(`${ORIGIN}/mcp`)}`);
    out();
    out(dim("  Ctrl+C to stop."));
    return;
  }

/* tunnel */
  const tunnel = tunnelCommand();
  out();

  // A pinned stable hostname means we do not need a tunnel at all: the plugin
  // can dial that address directly. This is what removes "paste a new link
  // into ChatGPT every time" after the very first run.
  const pinned = readPinnedEndpoint();
  if (pinned) {
    finish(pinned);
    return;
  }

  out(`  Opening a ${bold(tunnel.label)} tunnel ${dim("(this takes 10-25s)")}`);

  const tunnelChild = startTunnel(tunnel);
  children.push(tunnelChild);
  tunnelChild.on("exit", (code) => {
    if (!shuttingDown) {
      out(`  ${red(`${tunnel.label} exited`)} (code ${code}).`);
      shutdown(1);
    }
  });

  const url = await waitForUrl(tunnel, tunnelChild);
if (!url) {
    out(`  ${red("Could not read the public address.")}`);
    out(`  Provider: ${tunnel.label} (${tunnel.bin})`);
    out();
    out("  Things to check:");
    if (provider === "cloudflared") {
      out(`   - is cloudflared installed? Put cloudflared.exe in ${dim(".tools/")} or on PATH`);
    } else if (provider === "tailscale") {
      out(`   - is the Tailscale CLI installed and signed in? Run: tailscale status`);
      out(`   - Funnel must be enabled for your tailnet in the Tailscale admin console`);
      out(`   - this account's tailnet policy must allow the funnel node attribute`);
    } else {
      out(`   - is ngrok installed and authenticated? Run: ngrok config check`);
      out(`   - free accounts only expose their assigned dev domain`);
    }
    const tail = readFileSafe(resolve(toolsDir, "tunnel.log"));
    if (tail !== "(no log)") out(dim(`\n  Last tunnel output:\n${tail}`));
    shutdown(1);
    return;
  }

finish(url);
}

/**
 * Single place that announces a usable endpoint, so the pinned and freshly
 * tunnelled paths cannot drift apart in wording or behaviour.
 */
function finish(url) {
  const mcpUrl = `${url}/mcp`;
  writeUrlFile(mcpUrl);
  const copied = copyToClipboard(mcpUrl);
  const isQuick = /\.trycloudflare\.com$/i.test(url);
  const pinnedNow = !isQuick && pinEndpoint(url);

  banner(isQuick ? "YOUR CHATGPT ADDRESS (changes each start)" : "YOUR CHATGPT ADDRESS (stable)");
  out();
  out(`  ${bold(green(mcpUrl))}`);
  out();
  out(dim(`  Copied to your clipboard.`));
  out(dim(`  Saved to .tools/current-url.txt`));
  out(dim(`  Paste it into ChatGPT > Plugins > + > Connection URL`));
  out(dim(`  (include the /mcp path - ChatGPT does not add it for you)`));
  out();

  if (isQuick) {
    out(`  ${yellow("This address changes every start.")} To set it up once instead:`);
    out(dim(`    npm start -- --provider=tailscale   free, stable *.ts.net hostname`));
    out(dim(`    npm start -- --provider=ngrok      free, stable *.ngrok-free.dev hostname`));
    out(dim(`  Once a stable address is found it is saved to .tools/endpoint.txt`));
    out(dim(`  and reused automatically, so you only paste into ChatGPT once.`));
  } else if (pinnedNow) {
    out(`  ${green("Saved.")} This address will be reused on every start -`);
    out(dim(`  you will not need to paste a new link into ChatGPT again.`));
  }

  out();
  rule();
  out(dim(`  Plugin: open Figma > Plugins > Development > Design Agent`));
  out(dim(`  Local MCP (Inspector): ${ORIGIN}/mcp`));
  rule();
  out();
  out(dim("  Leave this window open. Ctrl+C stops everything."));
  out(dim("  Server log: .tools/server.log  (needed if anything misbehaves)"));
  out();
  void copied;
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8").split("\n").slice(-6).join("\n");
  } catch {
    return "(no log)";
  }
}

main().catch((err) => {
  out(`${red("Launcher failed:")} ${err instanceof Error ? err.message : String(err)}`);
  shutdown(1);
});

// Keep the event loop alive; the server and tunnel hold it otherwise.
setInterval(() => {}, 1 << 30);