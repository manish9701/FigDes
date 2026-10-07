/**
 * Manual end-to-end verification against a live Figma plugin.
 *
 * Run the server (npm start), open the FigDes plugin in a Figma file, then:
 *   node test-native.mjs
 *
 * This exercises the native path the way the MCP server does: a script is sent
 * to figdes_use_figma and runs inside one rollback-safe transaction.
 */
const PORT = process.env.PORT || 8787;
const BASE = `http://127.0.0.1:${PORT}/mcp`;

async function callTool(name, args) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  const data = JSON.parse(text);
  if (data.error) throw new Error(data.error.message);
  if (data.result.isError) throw new Error(data.result.content?.[0]?.text ?? "tool error");
  const content = data.result.content;
  if (!content || content.length === 0) return null;
  const txt = content[0]?.text;
  if (txt) {
    try {
      return JSON.parse(txt);
    } catch {
      return txt;
    }
  }
  return content;
}

const check = (label, ok, detail = "") => {
  if (ok) console.log(`  ok   ${label}`);
  else console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  return ok;
};

async function run() {
  const results = [];

  console.log("figma_status");
  let status;
  try {
    status = await callTool("figma_status", {});
  } catch (e) {
    if (String(e.message).includes("fetch failed")) {
      console.error("The server is not running on port 8787. Start it with `npm start`.");
      process.exit(1);
    }
    throw e;
  }
  const sessionId = status?.sessionId ?? status?.session;
  if (!sessionId) {
    console.error("No active Figma session. Open the FigDes plugin in Figma first.");
    process.exit(1);
  }
  console.log(`  connected: ${status.fileName ?? "?"} (${sessionId})`);

  console.log("\nread context (scope: file)");
  const fileInfo = await callTool("figdes_read_context", { sessionId, scope: "file" });
  results.push(check("file metadata", Boolean(fileInfo?.data?.fileName), JSON.stringify(fileInfo).slice(0, 160)));

  console.log("\nnative build (one script, one transaction)");
  const build = await callTool("figdes_use_figma", {
    sessionId,
    script: `
      const frame = await fig.createFrame({ name: "Native Test Frame", width: 480, height: 360, fill: "#FFFFFF" });
      const title = await fig.createText({ parent: frame.id, name: "Title", content: "Hello Native", x: 24, y: 24, fontSize: 28, fill: "#111111" });
      const dot = await fig.createEllipse({ parent: frame.id, name: "Dot", x: 24, y: 80, width: 64, height: 64, fill: "#0D99FF" });
      const comp = await fig.createComponent({ name: "Native Button", width: 120, height: 40 });
      const inst = await fig.createInstance({ componentId: comp.id, parent: frame.id, x: 24, y: 160 });
      return { frame: frame.id, title: title.id, dot: dot.id, component: comp.id, instance: inst.id, frameBounds: frame.absoluteBoundingBox };
    `,
  });
  results.push(check("native script committed", build?.status === "success", JSON.stringify(build?.error ?? {})));
  const ids = build?.result ?? {};
  results.push(check("created nodes have ids", Boolean(ids.frame && ids.title && ids.dot)));
  results.push(check("rich node state returned", Boolean(ids.frameBounds), JSON.stringify(ids.frameBounds)));

  console.log("\nnative rollback on a script error");
  const rolled = await callTool("figdes_use_figma", {
    sessionId,
    script: `await fig.createFrame({ width: 10, height: 10 }); await fig.getNode("9999:9999");`,
  });
  results.push(check("failed script reports failure", rolled?.status === "failed"));
  results.push(check("failure is rolled back", rolled?.rolledBack === true, JSON.stringify(rolled?.rollback ?? {})));
  results.push(check("failure is classified", Boolean(rolled?.error?.code), JSON.stringify(rolled?.error ?? {})));

  console.log("\nvisual inspection (inspect -> render)");
  const visual = await callTool("figdes_inspect_visual", { sessionId, target: ids.frame });
  const visualText = visual?.[0]?.text ? JSON.parse(visual[0].text) : null;
  results.push(check("visual report returned", Boolean(visualText)));
  results.push(check("render status reported", Boolean(visualText?.renderStatus), visualText?.renderStatus));

  console.log("\ncompare_visuals (render -> compare)");
  const cmp = await callTool("compare_visuals", { sessionId, beforeNodeId: ids.frame, afterNodeId: ids.frame });
  const cmpText = cmp?.[0]?.text ? JSON.parse(cmp[0].text) : null;
  results.push(check("comparison returned", Boolean(cmpText)));
  results.push(check("no fabricated verdict", cmpText?.judgement?.includes("does not fabricate") === true));

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed.`);
  if (passed !== results.length) process.exitCode = 1;
}

run().catch((err) => {
  console.error("\nTest failed:", err.message);
  process.exit(1);
});
