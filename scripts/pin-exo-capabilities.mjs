#!/usr/bin/env node
/**
 * Pins the EXO capability source of truth (issue #20, workstream 8).
 *
 * The capability-truth guard stays conservative — every consequential claim
 * must carry visible uncertainty — until a target EXO build has been verified
 * against actual product behaviour. This script is the mechanical act of
 * pinning *after* that verification happened; it is deliberately a
 * human-driven command, not something an agent runs to make a screen pass.
 *
 * The pin is a checked-in manifest (`docs/exo-capabilities.json` by default,
 * `DESIGN_AGENT_EXO_CAPABILITIES` to override) that the guard loads at boot —
 * so it survives restarts and redeploys, and a reviewer can trace every
 * capability claim to a named build.
 *
 * Usage:
 *   node scripts/pin-exo-capabilities.mjs --build exo-2026.10-r48215 \
 *        --by "manish (manual EXO verification)" \
 *        --evidence "Screens verified against exo@<commit> device discovery, placement, model profiles"
 */
import { writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.env.DESIGN_AGENT_EXO_CAPABILITIES ?? resolve(root, "docs", "exo-capabilities.json");

const argv = process.argv.slice(2);
const argValue = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : undefined;
};

const build = argValue("--build");
if (!build || build.trim().length === 0) {
  console.error("Usage: pin-exo-capabilities.mjs --build <exo-build-id> [--by <who>] [--evidence <what was verified>]");
  console.error("Refusing to pin nothing: pinning an empty build id looks like having pinned something.");
  process.exit(1);
}
if (existsSync(file)) {
  const existing = JSON.parse((await import("node:fs")).readFileSync(file, "utf8"));
  if (existing.build && existing.build !== build.trim()) {
    console.log(`Re-pinning from ${existing.build} to ${build.trim()} — the previous verification is replaced, not accumulated.`);
  }
}

const manifest = {
  version: 1,
  build: build.trim(),
  verifiedAt: argValue("--at") ?? new Date().toISOString(),
  verifiedBy: argValue("--by") ?? "unrecorded",
  evidence: argValue("--evidence") ?? "unrecorded",
};

mkdirSync(dirname(file), { recursive: true });
const temp = `${file}.tmp`;
writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
renameSync(temp, file);
console.log(`Pinned the EXO capability source of truth to ${manifest.build}.`);
console.log(`  verified ${manifest.verifiedAt} by ${manifest.verifiedBy}`);
console.log(`  evidence: ${manifest.evidence}`);
console.log(`  manifest: ${file}`);
console.log("The capability guard loads this at boot; capability claims are now traceable to this build.");
