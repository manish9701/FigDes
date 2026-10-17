# Issue #14 — transaction reliability under timeout

Code under test: **`51273e7`** (`Issue #14: stop a transport timeout from stranding the
transaction it abandoned`)
Baseline it was compared against: **`c517926`**

## Scope of this pass

Issue #14 is a master checklist covering compiler correctness, visual QA, design
quality and product workflows. The issue's most recent comment adds one focused
block of new evidence: three large `modify_design` transactions timing out
mid-apply, with reconciliation required and a warning that a late commit was
still possible.

That block is what this pass addresses. The A–C checklist items were already
landed in earlier commits (`7d1e2cc`, `bad6991`, `1e2c15c`, `ae2c15c`,
`5d4ca2d`, `6b8980e`, `ffe4952`, `83b90f2`, `25b7bcc`, `c517926`) and are not
re-litigated here. The D-level product workflows remain open, as the issue itself
says they must not be marked complete.

## The finding

The reported symptom — "large transactions time out mid-apply" — is real, but the
guard is not the cause. Four defects in the timeout path each reported a state
that had never been verified.

| ID | Defect | Consequence |
| --- | --- | --- |
| **T01** | The iframe transport runs its own timer. On expiry it sent `ok:false` with an error string, which the server read as a plugin refusal. | Rejected with a plain `Error`, not `TransactionTimeoutError`; the request binding was dropped. Reaching `timed-out` depended entirely on a prose regex in `tools.ts`. |
| **T02** | Consequence of T01. | The plugin's definitive answer — the commit, or the verified rollback — matched no pending request and no timeout binding, and was **discarded as an unknown request**. The ledger sat at `timed-out` forever and `dispatchTransaction` refused every same-id retry. |
| **T03** | `touchProgress`'s re-arm was correct but had no key: progress frames carried no `requestId`, so it returned on its first line. | The documented sliding window silently did nothing. A build that was demonstrably advancing was still killed at the absolute budget. |
| **T04** | `execute_figma_script` declares `timeoutMs` and the server waits `timeoutMs + 5s`; the iframe capped every build at 300s regardless. | A script asking for the maximum always lost the race — deterministically, not unluckily. |

Two further honesty defects on the plugin side:

| ID | Defect | Consequence |
| --- | --- | --- |
| **P05** | A cancel arriving *after* a transaction finished armed a flag nothing would ever consume. | The very same-id retry the server recommends aborted at operation 0 with "cancelled". The only safe recovery path was locked out. |
| **P06** | `removeCreated` recorded a node as removed straight from `remove()`, without reading it back. | An unverified removal could be reported as `rollbackStatus: "full"` — a clean rollback the code never confirmed. |

T02 is the one that best explains the reviewer's session log. "Rollback or
reconciliation was required and late commits may be possible" is exactly the state
the system was in: a job it could never resolve, because the only frame carrying
the answer was thrown away.

## Reproduction, before the fix

Run against `c517926`. 5 of 6 defect probes fail; the sixth is the re-arm
mechanism itself, which worked and was simply never given a key — which is why
the frame-level test exists alongside it.

```
D1: a transport timeout must stay a timeout                          FAIL  (plain Error)
D2: the definitive late result must not be discarded                 FAIL  (dropped)
D3: progress carrying a requestId must extend the window             pass  (re-arm was correct)
D4: progress must name its request                                   FAIL  (no requestId)
D5: a late cancel must not poison the recommended same-id retry      FAIL  (retry aborted)
D6: an unverified removal must not report a full rollback            FAIL  (reported "full")
```

## The fix

- `shared/protocol.ts` — `ResultMessage.transportTimeout` marks a
  transport-originated timeout structurally instead of by wording.
  `MainToUi` progress carries `requestId`.
- `figma-plugin/ui/transport.ts` — emits the marker; forwards `requestId` on
  progress; `budgetForBuild` honours a build's own declared budget (clamped) so
  the transport can no longer preempt the server's wait.
- `figma-plugin/src/code.ts` — one `progressReporter`; every build frame names
  its request.
- `mcp-server/src/sessions.ts` — a transport timeout is recognised (by marker,
  or by the sentinel text for an **already-deployed older panel**, which is the
  version skew the reviewer's live session is actually running), keeps the
  reconciliation binding, and rejects with `TransactionTimeoutError`. Every
  stop-waiting path now shares `rememberTimedOut`, so the binding cannot be
  forgotten. The sliding window requires **strictly advancing** progress and is
  bounded at 4× the budget, so it cannot become a hang in place of a timeout.
- `figma-plugin/src/operations.ts` — settled-transaction tracking so a late
  cancel cannot poison a retry; removal is read back before being counted as
  rolled back.

## Results

```
tests/issue-14-transaction-reliability.test.mjs     21 tests, 21 pass, 0 fail
npm test (full suite)                               25 suites, 836 tests, 836 pass, 0 fail
npm run typecheck                                   clean
```

The full suite includes `test:e2e`, which drives the real `dist/code.js` bundle
over a real WebSocket against the real server — the evidence that the protocol
change is wire-compatible end to end.

Coverage against the acceptance criteria:

| Criterion | Status |
| --- | --- |
| No duplicate or partial application after timeout/retry races | Covered — same-id retry after a rolled-back transaction and after a late cancel (T02, P05); cache idempotency unchanged and re-asserted |
| Every transaction ends in a definitive, truthful state | Covered — the three outcomes (committed / rolled-back / partial-rollback) reconcile from the late frame; a real plugin refusal is still a plain failure, not laundered into a timeout |
| Rollback completeness is verified, not assumed | Covered — P06; an unverified removal downgrades `full` to `partial` and names the survivor |
| Representative large batches within a documented budget, or fail safely | Covered offline at 15 / 40 / 128 operations, each committing atomically with a verified full rollback on mid-batch failure. Budgets are now per-tool and payload-declared, with a documented 4× sliding ceiling |
| Regression tests for late completion, rollback, retry/idempotency, large batches | Covered — 21 cases |

## What this does NOT prove

Stated plainly, because the issue's own criteria require it:

- **No live verification was performed.** There is no connected Figma session in
  this environment, so the deployed-plugin workflow (guard → build → apply →
  reconciliation → review → render) and the ~15/40/100+ operation live batches
  against a disposable frame still need a human to run them and record the
  transaction ids and renders. Everything above is offline.
- The batch sizes in the automated tests are **synthetic mock-`figma` runs**, not
  Figma-main-thread timing. They prove the state machine and the rollback
  arithmetic, not real apply latency.
- Passing unit tests are not proof of live plugin reliability. The reviewer's
  point stands, and the live re-run is the remaining work.

## Reproducing

```
npm run pretest
npm run test:issue14      # the 21 transaction-reliability cases
npm test                  # full suite
```

Against the baseline, to see the failures: check out `c517926`, keep the test
file, and run `npm run build:test && npm run test:issue14`. Note that the
transport-level cases import symbols that do not exist at `c517926`; the
server-side and plugin-side cases run unchanged and are the ones that fail.
