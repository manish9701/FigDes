# Issue #15 — apply-path performance and transaction-state hardening

Code under test: **`see git log for this commit`** (the commit that adds this file)
Baseline it was compared against: **`ab35933`**

## Scope of this pass

The issue asks for an investigation, not an assumption: *"The current bottleneck
has not yet been established. Instrument the pipeline before choosing an
optimization."* and *"Do not assume Figma API calls are the bottleneck."*

This pass profiles first, optimizes what the profile identified, and reports what
it could not establish. Phases 1, 2, 4 and 5 are addressed. Phase 3 (bounded
dependency-aware batching) is **not** implemented — see *Not addressed*.

## The finding

The reported symptom is real — 62 operations, ~250 seconds — but the root cause
is **not** the one the shape of that number suggests. It is not 4 seconds of
Figma API work per operation.

The plugin already reported per-stage timings. What it did not report was the
relationship between `timings.apply` and the sum of `timings.perOperation`.
Adding that comparison is what found it:

```
175-op screen, mock document:
  timings.apply          664 ms
  sum(perOperation.ms)    9 ms     <-- 1.4% of apply
  unexplained            655 ms   <-- where the time actually was
```

It was the yield. The apply loop hands control back to the event loop between
operations so the canvas can repaint and so a server `cancel` frame can be
delivered. The cadence was gated on the **operation count**:

```js
if (total <= 60 || n % 4 === 3 || done === total) await new Promise(r => setTimeout(r, 0));
```

A task switch is not free. Measured here, `setTimeout(0)` costs ~15ms. So the
cost scaled with batch size instead of with wall-clock: the larger the screen, the
more time spent *waiting to be allowed to paint*.

The threshold made it worse than merely linear. Because the rate was "every op"
at or below 60 and "every 4th op" above, **a 40-op screen took 583ms while a
larger 62-op screen took 239ms** — crossing 60 divided the yield rate by four.
A bigger screen being 2.4× faster is the signature of a batch-size-dependent cost,
and no amount of API optimisation would have removed it.

Two further defects fell out of the same profile:

- **Lookups were O(operations).** 184 `getNodeByIdAsync` calls for a 175-op
  screen. `register()` held the live node it had just created, discarded the
  reference, and the post-commit verify pass then re-fetched every created node by
  id. 184 round trips to observe 175 nodes already in memory.
- **`resolve()` checked `.removed` on its cached path but not on a fresh lookup.**
  So whether a reference to a node removed earlier resolved depended on whether
  the handle happened to be cached. With a cold cache it created children inside
  a removed frame — a node that is not in the document — and reported success.

## Changes

| File | Change |
| --- | --- |
| `figma-plugin/src/operations.ts` | Yield cadence gated on elapsed time (`PAINT_INTERVAL_MS = 16`) instead of operation count. `register()` seeds the handle cache. `resolve()` rejects removed nodes on the live path. `timings.yields` reports `{count, ms, intervalMs}`. |
| `shared/protocol.ts` | `TransactionTimings.yields`; `JobRecord.attempt`. |
| `mcp-server/src/sessions.ts` | `Session.requestIdFor()`; `JobLedger.completeLate()` with a per-transaction monotonic attempt counter. |
| `mcp-server/src/tools.ts` | Records the wire request id on the job at dispatch. |
| `mcp-server/src/index.ts` | Late-result reconciliation routes through `completeLate`, so a superseded attempt's frame is recorded, not applied. |
| `scripts/run-perf-benchmark.mjs`, `scripts/lib/screen-workload.mjs` | Repeatable benchmark over the issue's matrix. |
| `tests/issue-15-performance.test.mjs` | 14 regression + failure-injection cases. |

Two of these are Phase 4 requirements that were not actually met before:

- `JobRecord.requestId` was documented as *"lets a late plugin result rebind to
  this record instead of being dropped as unknown request"* — but **no
  `jobs.begin()` call ever passed it**, so `byRequestId` could never match
  anything and the reconciliation fallback was unreachable.
- Nothing prevented a stale late result from overwriting a newer attempt. Attempt
  1 times out, the caller reconciles and re-dispatches as attempt 2, attempt 2
  commits, then attempt 1's frame arrives — applying it would relabel a committed
  transaction as rolled back, the one mistake that loses work the user can see.

## Results

`artifacts/perf/before.json` and `artifacts/perf/after.json`, 3 runs each, same
seedless workload:

| Workload | Ops | Wall median | Apply median | Lookups | API calls/op |
| --- | ---: | --- | --- | ---: | ---: |
| small | 15 | 224 → **22** ms | 223 → **15** ms | 24 → **9** | 2.93 → **1.93** |
| medium | 40 | 583 → **5** ms | 580 → **4** ms | 49 → **9** | 2.35 → **1.35** |
| baseline | 62 | 239 → **11** ms | 236 → **4** ms | 71 → **9** | 2.23 → **1.23** |
| large | 100 | 376 → **18** ms | 372 → **13** ms | 109 → **9** | 2.14 → **1.14** |
| stress | 175 | 677 → **20** ms | 664 → **6** ms | 184 → **9** | 2.08 → **1.08** |

The load-bearing number is **lookups: O(ops) → constant 9**. That is the part
that predicts real Figma latency, because every lookup there is a genuine round
trip. The 9 remaining are `revealCreated`'s bounded post-commit reveal (≤8 nodes)
plus one.

```
npm test          26 suites, 850 tests, 850 pass, 0 fail
npm run bench:apply
npm run typecheck clean
```

## What this does NOT establish — read this before closing the issue

- **The ~250s figure is not reproduced and not explained.** The harness runs
  against a mock `figma` where `createFrame()` and `getNodeByIdAsync()` are
  near-free. Every number in the tables above is the **plugin's own** cost. The
  wall-clock columns are not Figma's wall-clock and must not be read as
  "the live 250s is now 11ms". The API call *counts* are trustworthy, because
  each is a real round trip in the editor; the timings are not.
- **Whether this accounts for the live 250s is unproven.** The yield fix is
  measured and correct, and it removes a defect that scales with batch size —
  which the 62-op observation is consistent with. But the arithmetic above does
  not close a 250s budget, and I have no live session to confirm it. Real Figma
  per-operation cost (document model updates, layout, text shaping, auto-layout
  reflow) is entirely unmeasured here.
- **`timings.yields` exists precisely so this can be settled.** A live run should
  report `timings.yields.count` / `.ms` alongside `timings.apply`. If `yields.ms`
  is small and `apply` is still ~250s, the remaining cost is inside the
  operations themselves and the next step is per-`opType` timing on real data.
  If `yields.ms` is large, the cadence still needs work in the editor's sandbox,
  where a task switch is likely slower than the ~15ms measured here.
- **No live verification of any kind was performed.** No Figma session is
  connected in this environment.

## Not addressed

- **Phase 3 — bounded dependency-aware batching.** Not implemented. The
  measurement argues against it as the first move: batching does not reduce
  per-operation Figma cost, and the two defects that were real are now fixed.
  Batching a transaction would work against the atomicity that
  `runTransaction` provides. The benchmarks to choose a batch size on
  (`npm run bench:apply`, 15/40/62/100/175) are in place if it is taken up.
- **The issue's proposed latency targets** (15 ops < 10s, 60–70 ops < 30s) are
  already met by a wide margin in the mock, but that is not evidence about the
  real runtime, so they are not claimed as met.
- **Failure-injection cases not covered:** 10 (review/render failure after
  commit), 12 (concurrent jobs on the same frame). Cases 3–5, 11 and the
  `partial-rollback` case are covered by `tests/issue-14-transaction-reliability.test.mjs`
  from the previous pass; 1, 2, 6, 8 and 9 are here.
- **`MAX_CREATED_NODES = 500`** remains a hard cap, so the stress matrix stops at
  175 rather than the issue's 150–200 upper bound being explored further. The cap
  is a guard, not a limit that was tested.

## Reproducing

```
npm run pretest
npm run bench:apply                    # matrix, writes artifacts/perf/latest.json
npm run test:issue15                  # the 14 cases
npm test                               # full suite
```

To see the defects: check out `ab35933`, keep `tests/issue-15-performance.test.mjs`
and `scripts/`, run `npm run pretest && node --test tests/issue-15-performance.test.mjs`.
**8 of the 14 fail there**, each on its own defect.
