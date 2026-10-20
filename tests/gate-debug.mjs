import { runGauntlet } from "./issue-17-gauntlet.mjs";
const results = await runGauntlet();
for (const r of results) if (r.status !== "PASS") console.log(`${r.id} ${r.status}: ${r.detail}`);
