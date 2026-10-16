/**
 * Regenerates the pinned tool-name array in `tests/smoke.mjs`.
 *
 * Run via `npm run pin:tools` after adding or removing a tool.
 *
 * The array is generated from `TOOLS`, not `TOOL_NAMES`: the latter also carries
 * plugin-side request names such as `native_design`, which is dispatched to the
 * plugin and never advertised as an MCP tool. Pinning the wrong set produces a
 * list that is permanently wrong in a way that reads as a server bug.
 *
 * This script exists because the pinned list drifted silently — `audit_components`
 * went missing from it and the test kept passing against whatever was there. A
 * hand-maintained mirror of a registry is a liability; a generated one that a
 * script can refresh is not.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { TOOLS } from "../mcp-server/dist-test/tools/tools.js";

const names = TOOLS.map((t) => t.name).sort();
const p = "tests/smoke.mjs";
const text = readFileSync(p, "utf8");

const marker = text.indexOf("server advertises the full tool surface");
if (marker < 0) throw new Error("marker not found");

const open = text.indexOf("[", marker);
const close = text.indexOf("]", open);
if (open < 0 || close < 0) throw new Error("array bounds not found");

const body = names.map((n) => `        "${n}",`).join("\n");
writeFileSync(p, text.slice(0, open + 1) + "\n" + body + "\n      " + text.slice(close));
console.log(`pinned ${names.length} registered MCP tools`);