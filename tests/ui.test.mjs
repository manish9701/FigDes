/**
 * Figma UI bundle invariants.
 *
 * The iframe script looks its elements up at module top level, so one wrong id
 * throws before anything runs and the panel sits on "Loading..." with only the
 * watchdog message to show for it. That is exactly what happened with #chips:
 * the script asked for an id the HTML never defined.
 *
 * These checks run against sources, not dist, so they work without a Figma
 * build and fail with the missing id named.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const uiTs = readFileSync(new URL("../figma-plugin/ui/ui.ts", import.meta.url), "utf8");
const html = readFileSync(new URL("../figma-plugin/ui/index.html", import.meta.url), "utf8");

function idsInJs(source) {
  const found = new Set();
  for (const match of source.matchAll(/\bel\s*<\s*[^>]*>\s*\(\s*"([^"]+)"\s*\)/g)) found.add(match[1]);
  for (const match of source.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) found.add(match[1]);
  return found;
}

function idsInHtml(source) {
  const found = new Set();
  for (const match of source.matchAll(/\sid="([^"]+)"/g)) found.add(match[1]);
  return found;
}

test("every element the UI script addresses exists in the HTML", () => {
  const wanted = idsInJs(uiTs);
  const present = idsInHtml(html);

  assert.ok(wanted.size > 0, "expected to find at least one element lookup in ui.ts");
  for (const id of wanted) {
    assert.equal(present.has(id), true, `ui.ts addresses #${id}, but index.html has no element with that id`);
  }
});

test("the HTML keeps the single bundle placeholder the build inlines", () => {
  const placeholders = html.match(/<script\s+src="\.\/ui\.js"><\/script>/g) ?? [];
  assert.equal(placeholders.length, 1, "index.html must contain exactly one <script src=\"./ui.js\"></script> placeholder");
});

test("the panel stays minimal: no agent-action widgets", () => {
  // The panel is a status light, not a workbench. Selection readouts, context
  // copy buttons and design-system dashboards were tried and removed: ChatGPT
  // already has that data through its tools, so duplicating it here only added
  // code paths that could break the one thing the panel must do - connect.
  for (const id of ["copy-context", "copy-ids", "context", "context-line", "actions-note", "selection", "swatches", "contrast", "refresh", "session"]) {
    assert.equal(html.includes(`id="${id}"`), false, `index.html must not define #${id}`);
    assert.equal(uiTs.includes(`"${id}"`), false, `ui.ts must not reference #${id}`);
  }
});

test("the progress indicator is wired end to end", () => {
  // The one exception to minimalism: a slim bar that narrates a landing build.
  // Without it a large program applies silently and the screen appears all at
  // once; these three ids are the whole feature.
  for (const id of ["progress", "progress-bar", "progress-label"]) {
    assert.equal(html.includes(`id="${id}"`), true, `index.html must define #${id}`);
    assert.equal(uiTs.includes(`"${id}"`), true, `ui.ts must address #${id}`);
  }
});
