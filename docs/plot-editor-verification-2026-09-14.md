# Thread and Plot Director editing — 2026-09-14

Implemented in the existing Player & world sheet:

- Threads: edit description/significance/status; mark closed; confirm recoverable deletion; show history and reopen.
- Director: edit applied guidance or a fresh pending draft separately; edit summaries, plot titles/loglines, lifecycle and spotlight; remove cards; validated full-frame JSON for other fields; retire pressure using the existing five-turn quiet command.
- `plot.edit` requires the current story version and exact frame/story identity. State patches retain before/after audit evidence.
- Thread edits remove stale linked cards and cancel scheduled/due linked events. Applied Director edits cancel old future Director beats without replaying its write plan. Completed events and unrelated metadata remain intact.
- Player-closed threads resist chapter and reconciliation reopening. Closed bindings are suppressed in subsequent persisted frames. Closed/abandoned/resolved plot-ledger memories are excluded from retrieval; historical narrative evidence is preserved.

## Verification

- 138 tests across 10 focused suites passed (editing, command routing, projections, Director reconciliation/planning, chapter threads, retrieval, canonical sync, turn context and prompt rendering).
- `npm run check`: zero errors and warnings.
- `npm run build`: passed; existing bundler chunk warnings remain.
- `node scripts/verify-plot-editor.mjs`: real API and PostgreSQL checks passed for edit/close/delete/restore, stale and cross-story rejection, future-only cancellation, applied/pending separation, freshness and audit preservation. Its exact disposable campaign was removed afterward. No existing campaign records were edited for verification.
- Live browser: Veil → Player & world → Threads displayed edit/close/delete controls; Mark closed opened a preselected Closed editor. Cancelled without saving. Director editing showed saved summaries, plot fields, lifecycle and spotlight controls. Narrow-panel screenshot checked. Cancelled without saving.
- Runtime restarted at `http://127.0.0.1:5173`, PID 27084, workspace data root. Existing memory-job failures/backlog were not repaired by this task.

## Scope

These controls manage canonical story threads and Director guidance. The related schemes/agreements section remains distinct. Deletion is not a transcript purge or historical-canon rewind. Automatic generation can still propose genuinely new plots; the identity guard blocks manually closed thread bindings, not every semantically similar idea a model might invent.
