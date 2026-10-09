# Agent harness tool-boundary diagnostics — 2026-09-07

## Slice 6 increment

The existing bounded GM-tool loop now carries a compact evidence receipt through the existing turn receipt path. Each observed tool records the source IDs that survived the result-size cap, an omission reason when the result was narrowed or truncated, and a failure reason when the call failed. The raw tool result is still kept out of the persisted user-facing receipt.

The loop also checks the request abort signal before starting initial and follow-up calls, after bounded tool completion, and before another planning round. The existing per-tool deadline remains in place; the signal is passed through the run-tool boundary so adapters can cancel their underlying work when supported. No new tool runner or write-capable command was added.

The streaming turn route now races bounded engine reads against the disconnected request signal, and the turn path checks cancellation immediately before canonical persistence. A provider response that finishes after the client has cancelled is therefore not committed as a new turn.

## Verification

- `npm test -- --run src/lib/server/turn/orchestrator.test.ts src/lib/contracts/memory.test.ts`: 64 passed.
- `npm run check`: 0 errors, 0 warnings.
- Full suite: 130 files / 1,265 tests passed after the cancellation boundary change.
- Production build: passed; only the existing dynamic-import and large-client-chunk warnings remain.
- The bounded world-search test now proves eight returned source IDs and an explicit four-result omission reason; cancellation coverage proves a pre-aborted request does not start a tool.

## Boundary

This closes receipt-level source/omission diagnostics and caller-side cancellation checks. The underlying engine command adapter still determines whether a specific database or wiki operation can abort in-flight; the loop deadline prevents a stalled operation from holding the turn forever, while adapters receive the signal for cooperative cancellation. A provider-backed completed turn remains outside this offline verification slice.
