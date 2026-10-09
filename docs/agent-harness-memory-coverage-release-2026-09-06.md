# Agent harness memory coverage slice — 2026-09-06

Implemented the first measurable coverage increment from Slice 2 of the harness plan.

## Delivered

- Derive extraction coverage from eligible transcript pairs and their actual `extract_turn_state` job receipts.
- Report `current`, `updating`, or `attention` without treating a high completed-job count as full coverage.
- Detect missing jobs, failed jobs, queued/running work, and completed jobs whose saved source payload no longer matches edited transcript text.
- Report the last contiguous covered position and the oldest unresolved source position/reason.
- Surface the result in the existing Memory processing control surface; optional vector/wiki freshness remains separate.
- Keep the implementation derived from existing entries and jobs, with no migration or duplicate canon ledger.
- Add `jobs.recoverMemory`, which queues one missing extraction source through the existing idempotent outbox path by default.
- Add source-content fingerprints to extraction payloads and apply receipts so an edited source cannot reuse an old successful apply receipt; unchanged jobs remain idempotent.
- Keep failed jobs visible for manual review; automatic repetition of exhausted or deterministic failures remains disabled.

## Verification

- Focused coverage/processor/runtime tests: 4 files, 103 tests passed.
- `npm test`: 130 files, 1,257 tests passed.
- `npm run check`: 0 errors, 0 warnings.
- `npm run build`: passed; isolated production build completed with existing chunk-size and dynamic-import warnings.
- `git diff --check`: no whitespace errors in the touched files.

## Known boundary

The running terminal process remains PID 37292 from before the preview and coverage changes. The new coverage response and `turn.preview` command are not claimed active on port 5173 until an approved restart path exists. Automatic retry policy and optional index freshness remain subsequent Slice 2 work.
