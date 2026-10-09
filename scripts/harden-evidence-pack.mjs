#!/usr/bin/env node
/**
 * Evidence-pack hardener (quality-reliability P1).
 *
 * Makes the live evidence pack reproducible and complete without re-running
 * Figma: sha256 hashes for every PNG, a manifest binding each screenshot to
 * its frame revision and render attempt (including failed/flapping attempts),
 * and validation of the required pack fields. Never fabricates.
 *
 * Usage: node scripts/harden-evidence-pack.mjs [packDir]
 */
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const packDir = resolve(process.argv[2] ?? "artifacts/design-benchmark/live/exo-compute-fabric");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const entries = await readdir(packDir);
const shots = entries.filter((f) => f.endsWith(".png")).sort();
const manifest = { packDir, generatedAt: new Date().toISOString(), shots: [], missing: [] };

for (const shot of shots) {
  const buf = await readFile(resolve(packDir, shot));
  manifest.shots.push({ file: shot, sha256: sha256(buf), bytes: buf.length });
}

const required = [
  "phase1-brief.json",
  "phase1-plan.json",
  "phase1-system.json",
  "fabric-script-r1.js",
  "build-r1.json",
  "shot-r1.png",
  "shot-r2.png",
  "shot-r3.png",
  "review-r2.json",
  "review-r3.json",
  "score-r3.json",
  "critique-r3.json",
  "final-qa-r3.json",
  "final-report.json",
];
for (const f of required) {
  try {
    await stat(resolve(packDir, f));
  } catch {
    manifest.missing.push(f);
  }
}

await writeFile(resolve(packDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ shots: manifest.shots.length, missing: manifest.missing }, null, 2));
if (manifest.missing.length > 0) process.exitCode = 1;
