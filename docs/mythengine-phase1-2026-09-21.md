# MythEngine Phase 1: shared mutation and agent foundations

Date: 2026-09-21. Implemented in `E:\DEV\Projects\MythEngine`, branch `codex/mythengine-overhaul`. [Overhaul plan](mythengine-overhaul-plan-2026-09-21.md).

## Implemented behavior

Canonical explorer edits now require the revision returned by a read. Versioned records use `expectedVersion`; operational rows without a server version use `expectedUpdatedAt`. The check runs under the row lock before any mutation. Engine failures expose `errorDetails.code` and revision details; the legacy record API uses HTTP 409 for stale writes and 428 for missing revisions. The UI and both MCP naming aliases pass these arguments. Older clients must read and supply a revision; the server does not silently manufacture one.

Object updates merge nested keys by default, preserving omitted fields. Arrays and explicit null replace where the field contract permits them. The full-record JSON editor explicitly uses `jsonMode: replace` for the top-level fields actually changed, guarded by its loaded revision. Capability-list omission and `[]` clearing retain their established meanings. Unknown fields, duplicate aliases, invalid JSON shapes and cross-game references fail before changes. Character/location/item adapters enforce their type during detail reads and edits.

Canonical changes, prior values, before/after audit snapshots, provenance and projection jobs commit in one transaction. Each index job is tied to the committed revision, so an already-running previous job cannot suppress a new edit. Public local gateway writes are labeled `client` and schema-validated rather than falsely claiming human review. Caller payloads cannot supply actor authority. Trusted future GM/Assistant writes remain disabled until the scoped tool dispatcher is implemented.

The new agent contracts define roles, tool names, GM context modes and versioned preferences. The shared permission policy keeps Research read-only, restricts batch helpers to assigned targets/references, disallows nested spawning, and keeps GM dice independent of player-roll requests. Tool advertising and execution use the same policy function when the dispatcher is connected; no new model tool loop is enabled in this phase.

Settings → **Agent Tools** now exposes project defaults and game overrides, their resolved values and inheritance. Research/Names/Player Rolls default on for new projects; GM Questions and images default off. Assistant questions and helpers default on. Automatic covers remain a separate project-wide switch. Existing ambiguous Research-off choices and legacy image choices survive migration. Save uses an independent settings revision and rejects stale changes. Assistant and Batch Authoring have separate model profile controls and require explicitly saved server profiles; no default paid profile is silently provisioned for them.

Background jobs now carry a required project ID and optional game ID. Foreign keys enforce matching ownership. Existing campaign jobs still require a game; the first project-only job, `validate_agent_settings`, checks persisted preferences and records a project validation receipt without inventing a story. Preference saves enqueue it atomically. Project status/run/retry commands are explicitly scoped. Existing workers and retry/lease behavior are reused; jobs remain disabled by default in this development runtime.

## Storage and compatibility

- `0021_agent_settings_defaults.sql` preserves existing versioned documents and unrelated settings, with conservative legacy defaults.
- `0022_project_job_scope.sql` backfills job projects from their stories, adds ownership constraints and permits only the implemented project-only job type without a story.
- Existing story/shelf `settings` fields carry preferences through their existing export/import paths. Agent settings are edited through `settings.agent.save`; generic shelf updates preserve the reserved settings document.
- Existing canonical IDs, migration ledger, save discriminators and old MCP names remain unchanged. Revision arguments are a deliberate write-contract tightening.
- Audit snapshots cover this generic editor path. They are foundations for Phase 3, not a claim of complete item/type history across every writer or an enabled restore UI.
- Project moves with dependent jobs are constrained by ownership; dependency-aware content migration is still part of the content work. No game is silently moved with cross-project job references.

## Validation

The broad suite passed 1,496 of 1,500 tests before the final fixture update. Three failures were the already-confirmed inherited prompt-budget tests. The fourth was an editor test expecting the previous request shape; it now verifies the loaded revision and explicit replacement mode. The final focused run passed **180 tests in eight files**, including that regression, job enqueue/retry, summary rebuild, role/settings policy and mutation validation. Type checking finished with **0 errors / 0 warnings**. The production build passed.

Live disposable fixtures proved:

1. New defaults, preserved legacy off, game override, clearing an override and project/game isolation.
2. A project-only job completed, retried and reported status with zero games.
3. Concurrent writes from the same revision yielded exactly one success and one conflict.
4. Nested state edits preserved biography and sibling stats; foreign evidence and wrong adapters failed.
5. A forced failure while queuing the second projection job rolled back the record, story version, audit rows and the first queued job.
6. Audit rows retained caller classification and prior/new snapshots without claiming human approval.
7. Database constraints rejected cross-project jobs and game-less campaign work.

All disposable projects/games/records were removed after the checks. A separate temporary-table migration probe proved existing job backfill, preserved explicit documents, retained unrelated fields and legacy image choices; those tables were dropped at transaction completion. In the browser, GM Questions was changed, saved, checked against the server, retained after a full reload and restored to its original inherited-off choice. Only its two validation jobs were then completed.

The live artifact has source SHA-256 `5fefc31d5e4c01accb5d39424c98aef4151d822939bbb91370c3cfedd008acb1` and artifact SHA-256 `3812266f31c9563f9ea38e411ce4c58fd52c22b6ad9f884f9c831c1ed52f885e`, PID 58128 at qualification. Original Mtherios remained PID 39068 on port 5173. No model request was sent. Browser provider displays are not proof of a configured/qualified server generation path.

[Live and migration evidence](evidence/mythengine-overhaul/phase1-live-verification.json). Logs and the pre-migration database backup are local to the clone under `data/`. The broad regression report is `data/logs/phase1-tests.json`; check/build logs are alongside it.

## Writer coverage for the next phases

| Owner | Phase 1 status / follow-through |
| --- | --- |
| `engine/worldRecords.ts`, gateway, record HTTP compatibility, MCP, WorldExplorer | Revision checks, typed fields/references, partial semantics, audit snapshots and atomic outbox implemented |
| `engine/locationRecords.ts`, player capabilities, plot/commitment owners | Existing domain semantics retained; full regression suite exercised their tests |
| `memory/canonical.ts`, `db/worldDatabaseImport.ts` | Canonical creation/import remain owners; content envelopes and full history must be added at creation/import cutover |
| `engine/characterDrafts.ts`, `jobs/processor.ts`, `turn/orchestrator.ts` | Existing automatic/proposal writers remain; Phase 3 must capture complete versions for every editable-domain write |
| Project content/types, maps/covers/templates | Not implemented yet; their creation transaction must establish identity and baseline history |

The next phase is the canonical project content/type workspace. Tool dispatch, Assistant conversations, generalized dice/questions, batch helpers, images, maps and complete history remain planned; saved preferences do not enable those unfinished features.
