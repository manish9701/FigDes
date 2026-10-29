# Live session, 2026-10-29 — native writer verified, throughput hazards found

## The blocking issue is fixed and live-verified

`figdes_use_figma` mutating scripts — every one of which failed with
`proxy: inconsistent get` for the whole recorded history of the issue — now run
and commit reliably. Evidence from the live session:

- The exact regression probe (create + `fills` write + `cornerRadius` + font
  load + `children` traversal) succeeded on the fixed build: 3 nodes created,
  `SOLID` round-trip, transaction committed.
- A screen speaking only the `figdes` builder committed cleanly and read back
  node state in the same call.
- A full Overview screen (~50 nodes) was built through the native writer in
  ~2.5s, then repaired twice and re-rendered, ending with the product guard at
  0 failures / 0 warnings (5 manual-judgment items) and a successful render.

Root cause for the record: Figma's sandbox runs QuickJS and its dynamic-page
`figma` object is itself a JS proxy; any additional JS Proxy wrapping it trips
QuickJS's proxy-invariant checks. Wrappers around `figma` are unsound by
construction (commit `a3dd115` removes the last one; scripts get the raw API).

## Throughput hazard discovered: background-window throttling

Builds that ran in seconds earlier today crawled identically later. The
constant difference: whether the Figma window was focused/visible.

Measured during the session:
- Focused: full 1440x900 screen (~50 builder nodes) in 2.5s; ops at ~46ms.
- Occluded: awaited `figdes.text` calls took ~2s EACH; the pipeline's 31-op
  `create_design` transaction paced at ~2–3 minutes per op and hit its 300s
  wall at op ~20.
- The plugin stayed responsive to independent requests the whole time (~576ms)
  — the stall lives in the plugin's internal scheduling, not the transport.

Practical guidance until mitigated in code: keep the Figma window in the
foreground while builds run. The timeout behaviour was verified SAFE: the
timed-out transaction was marked `failed` with
`late failure: Plugin timed out after 300s` and its 20 applied ops were
requiringly rolled back (page ended with zero leftover children); user work
was untouched.

## Shipping in this change

1. **Font warmup + shared loads (builder).** Screen scripts ask for the same
   three styles repeatedly; loads are deduped through an in-flight promise map
   (`ensureFont`), and the script runner warms Inter Regular/Medium/Semi
   Bold/Bold + JetBrains Mono concurrently with every script.
2. **Honest mutation ledger on success.** The script runner now waits one
   short event-loop turn (~150ms) BEFORE committing, so Figma's batched
   `documentchange` events land in the ledger pre-commit: a successful script
   reports its real raw-API mutation count instead of mutations:0. The failure
   path already waited; both paths now count.
3. **The new primitives are real components.** `notice`, `emptyState`,
   `successState`, `errorState` joined the component registry: `asComponent`
   emits one deduped `exo/…` master per program and instances it
   (`setVariant` carries `Tone`), each with a state strip
   (`states: ["error", "success", …]`) exercising the same tone paths, and
   inline fallbacks drawing identical anatomy. `componentId` re-use is also
   accepted on `loadingState`, `codeBlock`, `copyField`, `keyValueList`.
   Hug extents now include each emitter's minimum-height floor so slim
   state-strip siblings do not trace as operation-trace violations.
4. All offline compile checks and the full test suite pass.
