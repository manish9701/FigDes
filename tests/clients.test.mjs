/**
 * Unit tests for named MCP client connections and activity.
 *
 * Names come from the client's own handshake, prettified, never invented.
 * Concurrent clients share one process-wide registry, so figma_status can
 * show who is working on what.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientRegistry, friendlyClientName, clientKey } from "../mcp-server/dist-test/clients/registry.js";

test("known clients get friendly names, unknown names display raw", () => {
  assert.equal(friendlyClientName("ChatGPT"), "ChatGPT");
  assert.equal(friendlyClientName("claude-code"), "Claude Code");
  assert.equal(friendlyClientName("cursor"), "Cursor");
  assert.equal(friendlyClientName("my-custom-agent"), "My Custom Agent");
  assert.equal(friendlyClientName(""), "Unknown client");
  assert.equal(friendlyClientName(undefined), "Unknown client");
});

test("keys group by reported name, lowercased", () => {
  assert.equal(clientKey("ChatGPT"), "chatgpt");
  assert.equal(clientKey(""), "unknown");
});

test("first sighting registers the connection with no calls yet", () => {
  const r = new ClientRegistry();
  const entry = r.seen("ChatGPT", "1.0");
  assert.equal(entry.display, "ChatGPT");
  assert.equal(entry.reported, "ChatGPT");
  assert.equal(entry.version, "1.0");
  assert.equal(entry.calls, 0);
  const snap = r.snapshot();
  assert.equal(snap.connections.length, 1);
  assert.equal(snap.totalCalls, 0);
});

test("start/finish tracks in-flight work and the last call", () => {
  const r = new ClientRegistry();
  r.start("ChatGPT", "c1", "review_design", "Exo Labs");
  r.start("ChatGPT", "c2", "render_design", "Exo Labs");
  let snap = r.snapshot();
  assert.equal(snap.connections[0].active.length, 2);
  assert.deepEqual(
    snap.connections[0].active.map((a) => a.tool).sort(),
    ["render_design", "review_design"],
  );
  r.finish("c1", "ok", "3 findings");
  snap = r.snapshot();
  assert.equal(snap.connections[0].active.length, 1);
  assert.equal(snap.connections[0].calls, 1);
  assert.equal(snap.connections[0].lastTool, "review_design");
  assert.equal(snap.connections[0].lastStatus, "ok");
  assert.equal(snap.totalCalls, 1);
  assert.equal(snap.activity[0].client, "ChatGPT");
  assert.equal(snap.activity[0].detail, "3 findings");
});

test("errors count separately from calls", () => {
  const r = new ClientRegistry();
  r.start("Cursor", "c1", "create_design", "—");
  r.finish("c1", "error", "boom");
  const snap = r.snapshot();
  assert.equal(snap.connections[0].calls, 1);
  assert.equal(snap.connections[0].errors, 1);
  assert.equal(snap.activity[0].status, "error");
});

test("activity is a bounded ring, newest first", () => {
  const r = new ClientRegistry();
  for (let i = 0; i < 60; i++) {
    r.start("ChatGPT", `c${i}`, "figma_status", "—");
    r.finish(`c${i}`, "ok");
  }
  const snap = r.snapshot();
  assert.equal(snap.activity.length, 50);
  assert.equal(snap.connections[0].calls, 60);
  assert.ok(snap.activity[0].at >= snap.activity[49].at, "newest first");
});

test("a finish with no start records nothing", () => {
  const r = new ClientRegistry();
  r.finish("ghost", "ok");
  const snap = r.snapshot();
  assert.equal(snap.connections.length, 0);
  assert.equal(snap.activity.length, 0);
  assert.equal(snap.totalCalls, 0);
});

test("concurrent clients sort most-recent first with independent activity", () => {
  const r = new ClientRegistry();
  r.start("ChatGPT", "c1", "plan_screen", "Exo Labs");
  r.finish("c1", "ok");
  r.start("Claude Code", "c2", "review_design", "Other File");
  const snap = r.snapshot();
  assert.equal(snap.connections.length, 2);
  assert.equal(snap.connections[0].display, "Claude Code");
  assert.equal(snap.connections[0].active.length, 1);
  assert.equal(snap.connections[0].active[0].target, "Other File");
  assert.equal(snap.connections[1].display, "ChatGPT");
  assert.equal(snap.connections[1].active.length, 0);
});
