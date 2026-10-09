# Agreement and scheme editors — 2026-09-14

Player & world → Threads now contains canonical agreement and scheme editors, including optional history and secret-record views.

- Agreements: terms, parties, category, status, visibility and consequences.
- Schemes: goal, trigger, status, visibility, pressure, current stage, stage labels/hooks/completion, and validated advanced stage/condition JSON.
- Same story-version guard and state-patch audit as thread/Director editing. Unrelated identity, ownership, branch, source and metadata fields are preserved.
- A scheme edit updates its stored memory record and linked thread atomically, cancelling stale linked future pressure. Resolved/foiled/abandoned schemes close their thread; explicit editing can reopen them. Automatic scheme upserts cannot overwrite a manually closed scheme record.
- Agreement edits preserve completed events and invalidate explicitly linked Director cards. Only active/contested agreements remain current obligations. These are record edits, not a historical transcript rewrite.

Verification:

- 97 focused tests passed; Svelte/TypeScript check had zero errors/warnings; build passed.
- Extended `scripts/verify-plot-editor.mjs` passed live API/PostgreSQL checks for agreement/scheme edits, array validation, stage bounds, secrecy, stale saves, linked thread state, and preserved metadata, alongside the original thread/Director checks.
- Browser verification on a worker-disabled preview: Veil agreement form opened without saving; a disposable campaign's scheme goal/status and agreement terms were edited and saved. The UI showed saved values; PostgreSQL independently confirmed both and the scheme thread's closed status.
- The exact disposable campaign was deleted after verification. No existing campaign records were edited for testing.

## Recoverable deletion follow-up

- Added confirmation-based Delete and a Show deleted records / Restore flow for both record kinds. Deleted agreements are not confused with annulled or fulfilled agreements; deleted schemes retain their canonical payload for recovery.
- Deleted records are filtered from bootstrap and current retrieval, including live checks for stale canonical semantic hits. Explicitly linked applied/pending Director cards are removed, their threads closed, and scheduled/due events cancelled. Restore retains the original status and does not restart cancelled events. Scene checkpoints are invalidated; vault/index refresh jobs are queued transactionally.
- 135 focused tests across plot editing, Director planning, canonical sync, retrieval, patch validation and canonical search passed. Svelte/TypeScript: zero errors/warnings. Production build passed with existing chunk warnings; whitespace check passed.
- Extended API/PostgreSQL script passed on preview and production: both delete/restore paths, stale/deleted edit rejection, bootstrap and memory-retrieve exclusion, linked Director card removal, event cancellation, and preserved committed history.
- Browser verification deleted and restored both records in the disposable campaign, confirming disappearance, deleted-record visibility, and restored original statuses. Exact fixture removed after independent database confirmation; preview process stopped.
- Production runtime restarted at an idle worker boundary, PID 34120. Health succeeded and stderr was empty. No existing campaign record was edited or deleted for verification.
- Limitation: deleting one record does not semantically purge copies in old transcript, chapter/arc summaries, character descriptions, or unrelated world facts. Those require their own source-linked correction.
