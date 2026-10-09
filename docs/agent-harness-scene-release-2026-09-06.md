# Scene continuity release — September 6, 2026

The narrator can now receive source-linked excerpts from earlier in the primary scene, beyond its recent-dialogue window. The checkpoint is a rebuildable transcript projection in `stories.metadata.sceneCheckpoint`. It does not change canonical facts or remove exact dialogue.

## Behavior

- A durable `refresh_scene_checkpoint` job is queued with each completed primary turn. Transcript creation/deletion, imports, and manual checkpoint restores also queue a refresh. Failed refresh jobs support the existing manual retry flow.
- The worker reads at most 600 recent narrative entries and stops at the latest primary location/header or branch boundary. OOC/control passages, private thoughts and their responses, parallel POV, secret passages, and explicitly invalidated/superseded evidence are excluded.
- It retains at most 128 exact sentence excerpts, each at most 420 characters. Selection favors commitments, questions and ending beats, with ordinary excerpts spread through the source window. It examines the middle of passages as well as their beginning and end.
- The compiler selects only excerpts older than the first retained dialogue entry, with at most 24 excerpts and a 6,500-character excerpt allowance. The existing final context/model budgets still apply. Primary-scene checkpoints are omitted for parallel POV requests.
- Current participants, actor knowledge and active obligations continue to come from the existing canonical context. Quotes are explicitly historical: a quoted question may already be answered, and a quoted promise may no longer apply. Current canon and later dialogue take precedence.
- The context receipt shows checkpoint coverage, exact source entry IDs and excerpts, and whether each selected excerpt was sent, partially sent, or omitted by the final budget. Find it under **GM tools → Technical → Context Receipt → What reached the narrator → Scene continuity**.

## Consistency and cost

Checkpoint validation hashes transcript identity, position, content, branch, parent and relevant visibility/control metadata. Source edits, deletions, secrecy changes and remapped IDs invalidate a stale projection. Receipt-only updates do not. The validation query is bounded to 601 rows; an additional inserted row also changes the fingerprint.

Workers read the latest evidence under a story row lock, regardless of the age of the queued job. They merge only the checkpoint metadata key. A late job cannot install its old payload as the current scene. Missing or invalid checkpoints leave normal recent dialogue and existing retrieval available; direct external source edits rebuild on the next queued refresh.

No new dependency, database table, migration, model call, or embedding call was introduced. Worker reads exclude large prompt receipts and generation diagnostics.

This is selective extractive memory, not a complete semantic scene summary or a guarantee that every fact survives compression. Location boundaries use available narration headers and canonical location identity; an unmarked transition cannot be reliably inferred. The bounded checkpoint supplements existing chapter, arc and long-term retrieval paths. Automatic synthesis of unresolved questions or reconciled beliefs is outside this release.

## Validation

- 129 test files, 1,247 tests passed; Svelte check reported zero errors and warnings.
- Production build passed in an isolated workspace with its own copy of installed dependencies. An initial cross-drive dependency junction failed in Rollup's Windows path handling; the independent dependency copy resolved that validation issue.
- Disposable PostgreSQL acceptance: a promise in the middle of an early passage survives 150+ turns and a fresh Node process, while all 200 recent entries remain intact. Tests cover receipt updates, text edits, secrecy, deletion, remapped import and an old queued job running after a scene transition.
- Browser acceptance on disposable data: the receipt displayed the older promise, its source ID and a 240-entry checkpoint range. Nine excerpts were sent alongside all 200 recent entries. Desktop and 390 × 844 layouts were checked; no browser console errors were recorded. The fixture and its database were removed afterward.

## Runtime handoff

Source changes and validation artifacts are local; nothing was committed. Pre-change source and logs are under `.cache-backups/harness-scene-slice-20260906/`. The validated production output is saved there as `production-build/`. Automatic approval review also blocked cleanup of the isolated build workspace with “blocked by policy,” so that workspace remains at the path recorded in `build-workspace.txt`.

The existing port 5173 process is still PID 37292. Its root and status endpoints return 200, while `/api/health` returns 500. Automatic approval review rejected stopping/restarting this process during the preceding release with only “blocked by policy.” This release did not retry that blocked action or replace files under the running production build. Activation still requires stopping the old process, installing/rebuilding the production output, and restarting.
