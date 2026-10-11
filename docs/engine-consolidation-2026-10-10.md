# Engine consolidation — 2026-10-10

Status: stages 1–7 implemented on branch `worktree-engine-consolidation` (worktree under `.claude/worktrees/engine-consolidation`, based on `6c2323d`). This is a dated working record: the checklist tracks the requested seven-stage consolidation, and each stage section records what was implemented and the evidence for it. [ARCHITECTURE.md](../ARCHITECTURE.md) owns the current system description; this file does not.

Verification used disposable PostgreSQL databases on the local server (`mythengine_consolidation_test`, `mythengine_summary_repair_recovery_20261010`, `mythengine_summary_repair_recovery_2026101002` and its `_operator` twin, `mythengine_faction_repair_consolidation_20261010`), migrated from `drizzle/`. The live `mythengine` database, the running app on port 5173, campaign data and saved settings were not touched. No provider request was made.

## Checklist

- [x] Stage 1 — chapter commit and enrichment separated; follow-ups are durable, chapter-keyed jobs
- [x] Stage 1 — execution map (tasks, profiles, processes, reachable legacy paths)
- [x] Stage 2 — task registry, single settings resolver, four primary roles (server, migration, browser sync, roles panel)
- [x] Stage 3 — prompt presets and character contract
- [x] Stage 4 — Decisions correctness
- [x] Stage 5 — unified chapter lifecycle (window ledger, runner convergence, reconciliation, historical rebuild)
- [x] Stage 6 — World Clock (numeric clock, auditable changes, proposals, interruption, calendar rollover)
- [x] Stage 7 — retire superseded paths, split, before/after evidence, full verification (browser-only path and legacy branch deletion remain; see Unfinished work)

## Execution map at `6c2323d` (Stage 1 trace)

Terms: a **task** is one operation that may call a model (persisted under its legacy service ID); a **model profile** is a provider connection plus model and generation defaults; a **deployed process** is the running Node server (`server.js`), whose job worker is off unless `jobWorker` is enabled, and the browser, which still runs some tasks directly.

Interactive turn (backend-bound story): `ActionInput.svelte` → `agent.run.start` → `agentRuns.ts` `advancePi` (default `gmPiRuntime`). The Pi run uses the `narrative` profile with GM tools; with no tool calls its reply is the draft and narration reuses it, so a simple turn makes **one GameMaster request**. Then `processServerTurn` may add: Decisions (0–2 actors × 2 requests, only on social-stakes/offer regex and when the `actorDecision` row is enabled), adaptive research (`activeRecall`, off unless enabled), a roll continuation (one request when a roll marker appears), the dialogue pass (off by default). Classification is deferred for browser turns: one `extract_turn_state` classifier request (plus one repair on invalid output; 2–5 jobs can share one batched request). The legacy planner path (`gmPiRuntime=false`) adds a classifier-profile planner request per round. Browser **suggestions** run after every adventure turn unless disabled (a third request by default when enabled).

Per completed non-OOC turn the server enqueues: `refresh_scene_checkpoint`, `extract_turn_state` (deferred mode), `continuity_audit` (a model call only when `continuityReview` is enabled), `plan_plot_brain` (self-throttled to every 8 turns), projection jobs (`create_memory_nodes_from_events`, `update_faction_pressure`, `index_canonical_records`, `summarize_chapter` — a chapter only at 20 completed turns), `sync_story_vault` every 5th revision, and `evaluate_world_sim_tick` on every 5th turn **or whenever the world-time string changes** (the narrator header usually changes it, so this is close to every turn).

Chapters/arcs: `summarize_chapter` → `createChapterCheckpoint` → `summaryGeneration.ts` (`memory` → `classifier` → `narrative` implicit chain; arcs prefix `arcCondensation`). The separate chapter-only runner (`chapterSummaryRunner.ts`, gated per story by `chapterRunnerEnabled`) uses `summaryRecovery.ts` with a pinned NanoGPT route and its own ledger. Character updates: `characterUpdate` (falls back to `classifier` when no row). World planning: `strategicWorldBrain` (`plotBrain/planner.ts`, `factions/workflow.ts`). Indexing: `embed_memory_nodes`, `index_canonical_records`, `sync_story_vault`.

Settings: browser `SERVICE_DEFINITIONS` (`settings.svelte.ts`) and `terminalSettings.ts` write one full `llm_service_settings` row per service; inheritance exists only in the browser and is persisted as copies (`syncInheritedGameMasterTools`; `refreshTerminalLlmSettings` turns every row into an explicit browser override). The server resolver inserts an **enabled** row from environment defaults whenever a missing service is resolved, including `actorDecision` (checked on every planner round), which then passes the raw `enabled === true` gate and runs automatic actor decisions on a non-Decisions model.

Reachable legacy paths: the browser-only turn path for stories without `serverStoryId` (failed backend create/import, demoted bindings), with its own prompt, browser classifier, IndexedDB chapter/arc/saga summaries and `timeTracker`; the legacy GM planner (`gmPiRuntime=false`); the chapter-only recovery runner; `activeRecall` (adaptive research); retired rows `worldSimulation`/`styleReviewer` still in the table. World time is written by parsing the narrator header in `patchValidator.ts` (inline and deferred); `advanceStoryTurn` is reachable only through the explicit `timeline.advance` command.

## Pre-existing failures (baseline at `6c2323d`, before any change)

`npx vitest run`: 8 files / 9 tests failed, 2390 passed, 276 skipped.

| Test | Failure |
| --- | --- |
| `factions/decisionMatrix.test.ts`, `factions/decisionOrder.test.ts` | candidate/probability assertions |
| `factions/negotiationPrototype.test.ts` | sandbox snapshot assertion |
| `engine/appStoryCli.test.ts` | pending-question CLI output |
| `engine/sourceFiles.test.ts` (2) | local folder registration / stale mount |
| `memory/sceneCheckpoint.test.ts` | dialogue budget source IDs |
| `turn/arcSelectionTrace.test.ts` | missing `../recovery-source-fixture.json` (path relative to checkout) |
| `routes/api/legacyGatewayRoutes.test.ts` | manual job control envelope |

The DB-backed recovery suites (`summaryRecovery`, `chapterSummaryRunner`, `routes/api/app/chapters`) pass when run one file at a time against the recovery database; run together they share fixtures and interfere. `summaryRecoveryOperator.test.ts` requires its own operator database name and was not run.

## Stage 1 — chapter completion boundary

Finding verified at `6c2323d`: `createChapterCheckpoint` committed the chapter, memory node and arc job, then ran thread reconciliation, character proposals, faction pressure, Director enqueue and the character continuity refresh inline. Any later throw failed the `summarize_chapter` job; a retry then found the boundary advanced and returned `chapter_threshold_not_met`, so the failed consumer's work was silently dropped. The unit test `chapterLifecycle.test.ts` asserted that rejection.

Implemented:

- One transaction now allocates the story revision, builds the thread plan, writes the chapter (with a write-once `metadata.completion` receipt naming its follow-up job IDs), the campaign-fact review, the chapter memory node, and all consumer jobs. A superseded attempt rolls back and consumes no revision.
- Consumers are durable jobs keyed by chapter ID and commit revision (`enqueueChapterFollowUpJobs`). The revision matters because user chapter deletion and summary rebuild delete chapters, and regeneration reuses the stable chapter ID; the old `arc-rollup-<chapterId>` key would have collided with the earlier completed row and silently skipped the new chapter's arc rollup. Consumers: `rollup_arc` (key unchanged), `chapter_threads`, `chapter_characters`, `update_faction_pressure` (only with source events — the old path scanned the latest 200 campaign events when a chapter had none), `embed_memory_nodes`, `sync_story_vault`.
- A consumer validates the chapter ID, revision and projection fingerprint and skips a missing or rebuilt chapter. Thread updates carry the snapshot thread revision and event `threadIds`, so a later edit is reported as stale rather than overwritten; the thread receipt and Director enqueue commit in the thread transaction.
- Arc rollup queues its saga rollup and Director review inside the arc transaction.
- Job failures are recorded and classified by the database's reason. Drizzle's `Failed query: … params: …` wrapper previously hid deadlocks/timeouts, making them permanent failures and storing bound parameter values in `lastError`.
- `chapter_threads`, `chapter_characters` and `update_faction_pressure` are manually retryable.

Evidence: `chapterCommit.integration.test.ts` (disposable PostgreSQL) runs a real `summarize_chapter` job through the job runner, injects a story-scoped database fault into thread reconciliation, and shows the chapter, memory node and summary job remain complete while only `chapter_threads` fails; after the fault is removed, a manual retry applies the thread plan once, queues one Director review, leaves the completed character job untouched, makes no second summary request, and the boundary does not advance. A second test shows a thread edited after the snapshot is kept. Unit tests cover the single-transaction commit shape, receipt reuse and stale-revision skips. Full unit suite after Stage 1: the same 9 pre-existing failures, 2395 passed.

## Stage 2 — model roles and one resolver

Implemented:

- [modelTasks.ts](../src/lib/contracts/modelTasks.ts): shared role and task registry (22 active tasks, 2 retired) used by the server and the settings UI; the browser's `SERVICE_DEFINITIONS` take their enablement defaults from it. Three new tasks name operations that previously borrowed the `classifier` ID: `gmToolPlanner`, `nameGeneration`, `sceneImagePrompt` (they inherit the Classifier role, so effective settings are unchanged).
- Migration `0054_model_roles.sql`: `model_profiles`, `model_roles`, `model_task_overrides`, and a frozen-catalog data migration. Rows auto-created by the old resolver for optional tasks (`metadata.source = terminal_default`) and retired IDs are not migrated. Profiles are deduplicated by connection, model, context and sampling; temperature/output size stay task parameters. A task inherits when its connection matches its role and stores only parameter, enablement, prompt-override and operational-metadata (`dialogueMode`, `batchBudget`, `agentBudget`) differences. Summaries is seeded from `memory`, else the classifier, else the GameMaster — the previous run-time chain, now recorded explicitly.
- [modelSettings.ts](../src/lib/server/engine/modelSettings.ts): read-only resolver with provenance, revision-checked save, and a legacy adapter that stores inherited-equal values as inheritance and never edits a shared profile from a per-task patch. [llmSettings.ts](../src/lib/server/engine/llmSettings.ts) is a facade; no code path inserts or enables settings by resolving them. Direct reads of `llm_service_settings` (prepared-turn freshness, Decisions gate, continuity audit gate, image profile checks, agent settings, embedding revision, faction model revision) now use the resolver or new tables.
- Implicit cross-role fallbacks removed: classifier→GameMaster (turn and deferred extraction), summaries chain, smallBrain→classifier, characterUpdate→classifier. Explicit fallback profiles per role/task, bounded by the task request budget, replace them.
- Browser: `syncInheritedGameMasterTools` removed; inherited tasks send parameters only; a refresh keeps inherited rows inherited (`effectiveModel` cached for browser-run tools). [ModelRolesPanel.svelte](../src/lib/components/settings/ModelRolesPanel.svelte) exposes the four primary roles, profile editing, the Decisions switch (only with a supported decision model) and per-task inherit/override and enablement.
- Receipts: GM turn receipts carry `modelTasks` (task, role, source, profile ID and revision, model, enabled source, overridden parameters, limits, settings revision, status/reason). Pre-dispatch budgeting of the full serialized request (messages, tool definitions, schema) against the context window was already enforced in `provider.ts`; prompt-section priority trimming with omission receipts already exists in `promptPacket.ts`/`promptReceipt.ts`. Not changed: OpenAI-compatible narration that omits `max_tokens` reserves only the 512-token framing margin at the provider backstop; the orchestrator budget reserves output before allocating dynamic context.

Migration check against a copy of the live settings rows (disposable DB): 10 profiles, 6 roles, 12 task overrides; Classifier and Summaries share one profile; `narrative` keeps its 13,156-character prompt override; `suggestions` keeps `enabled: false` and `reasoningEffort: high`; `dialogue` keeps its own model and `dialogueMode`; `actorDecision`, `assistant`, `batchAuthoring`, `activeRecall` and `continuityReview` keep their saved `enabled: true`. **Review before activation:** `continuityReview` and `activeRecall` are enabled in the live rows; they may have been enabled by the old auto-create bug and then echoed back by browser sync rather than by an explicit choice. Both are preserved as saved; disable them in Settings → AI Services → Model roles if they were not intended.

Evidence: `modelSettings.test.ts` (8 resolver/adapter tests), `modelSettings.integration.test.ts` (disposable PostgreSQL: a shared-profile edit reaches every inheriting task after save and reload while the explicit override is unchanged and a stale revision is rejected; resolving seven absent optional tasks writes no row in any settings table; the migration run in a scratch schema against fixture rows). Rendered check: the worktree app on port 5199 against the disposable DB showed the migrated roles and 22 tasks with sources and reasons; switching Lore Master research to "Inherit role" saved `profile_id = null` (revision 2) while `characterUpdate` and the legacy table were unchanged. `svelte-check`: 0 errors, 0 warnings. Unit suite: the 9 pre-existing failures only (2403 passed); tests that encoded implicit fallbacks or copy-on-sync were rewritten to the new contract.

## Stage 3 — narrative presets and the character contract

Presets ([promptPresets.ts](../src/lib/contracts/promptPresets.ts), [narrativePreset.ts](../src/lib/server/turn/narrativePreset.ts), [promptPresets.ts (server)](../src/lib/server/engine/promptPresets.ts), migration `0055_prompt_presets.sql`):

- A preset is an ordered list of editable style **text** sections and locked **engine** blocks (authority, source priority, turn workflow/boundary, NPC agency/knowledge, secrets rule, turn header, dice contract, feudal scale blocks). `npcAgency`, `turnWorkflow` and `turnBoundary` must stay enabled, plus one authority block. Text sections may use six validated variables (`story.title`, `story.genre`, `story.tone`, `story.preamble`, `story.genrePackLabel`, `story.genrePack`); nothing is evaluated, unknown variables are rejected, and a section built only from empty variables is omitted. Migrated free text is stored as a literal section (the live override contains a `{{` sequence).
- Revisions are immutable. A story's choice lives in `story_prompt_presets` (not browser-synced story settings); a story without one uses the default preset's designated `default_revision`, which changes only by an explicit "make default". Saving a revision never changes a pinned campaign; the UI offers "Apply revision N to this story". Selection does not touch global settings or other stories.
- Migration: `narrative-builtin` revision 1 (frozen copy of the built-in composition; a unit test fails if the TypeScript built-in drifts from it) and, when a global GameMaster override existed, `narrative-migrated-override` revision 1 as the default, reproducing `override + IMMUTABLE CORE GM AUTHORITY` exactly. The legacy `narrative` task prompt override is no longer applied once preset storage exists (it stays in the database for rollback).
- Turns compile the story's revision in `prepareServerTurnContext`; the prepared-turn cache is invalidated when the selection changes; GM receipts record `promptPreset` (preset, revision, content hash, story/default source). Commands: `prompts.presets.list|get|save|duplicate|select|setDefault|export|import|preview` (preview returns per-section token counts, sources and omission reasons). [NarrativePresetsEditor.svelte](../src/lib/components/settings/NarrativePresetsEditor.svelte) replaces the narrative override editor in Settings → Prompts.

Character contract ([characterContext.ts](../src/lib/server/turn/characterContext.ts)):

- `CharacterCardV1` with explicit legacy-alias adapters (`speechStyle`/`voice`, `bio`/`background`, `personality`/descriptors, `goals`/`goal`/`motivations`, `eventMemory`/`npcEventMemory`, state vs metadata, `originalState`) and a provenance map; stored records are not modified. Knowledge buckets stay separate: actor-known facts, the character's own did/saw/knew memories, and GM-only timeline links. Beliefs remain separate `npc_beliefs` rows.
- Rendering keeps the previous card vocabulary, relevance ranking and scene-card budget (1,400/1,800 characters), so non-addressed cards and crowded scenes stay comparable. Intentional changes: the player-addressed character gets an `addressed` card (4,200 characters; personality and voice up to 1,200/900 characters instead of 140/100, mannerisms and dialogue examples); sections are dropped whole by priority and named in an `[Omitted for context budget: …]` line instead of cutting text mid-field; dialogue speaker cards use an **actor view** without GM-only links.
- Leaks fixed: (1) secret GM timeline links (any `npc_event_links` role, including *target*) were rendered on an NPC's card, and that card was reused as the dialogue pass's speaker card; (2) the chapter character refresh wrote events in which an NPC was only a target into its `saw` memory, including secret events and private-thought turns.
- Identity protection is unchanged and was verified: `boundCharacterIdentity` strips identity, personality and voice fields from routine extraction and records reviewable conflicts.

Evidence: `narrativePreset.test.ts` (19: byte-identical output to a frozen copy of the pre-preset builder for every genre pack, header variants and the override composition; validation; migration-copy guard), `promptPresets.integration.test.ts` (disposable PostgreSQL: per-story independence, explicit revision application, stale-revision rejection, unchanged model settings, preview, export/import; the migrated default reproduces the copied 13K-character live override composition exactly), `characterContext.test.ts` (addressed voice survives assembly; secret GM link absent from the speaker card but labelled for the narrator; target-only secret and private-thought events not remembered; omitted sections named; legacy aliases adapted with provenance without mutation), narrative preview route test. The 124 existing character/harness/dialogue tests pass unchanged. Rendered check (worktree app, disposable DB): the migrated preset showed 6 sections and 3,221 tokens; the built-in 20 sections with three locked engine rules and three omitted-empty sections (1,183 tokens). That check found and fixed a `structuredClone` on Svelte state proxies that prevented the editor (and the roles panel's profile editor) from opening. Unit suite: the 9 pre-existing failures only (2,428 passed); `svelte-check` 0 errors, 0 warnings.

## Stage 4 — Decisions

Provider documentation check (2026-10-10): OpenRouter's Decisions reference ([TypeScript SDK](https://openrouter.ai/docs/client-sdks/typescript/sdks/decisions/README.md)) defines `state` plus a map of `choice`/`noul`/`score` questions and says nothing about one question seeing another's answer; NanoGPT's documentation index does not document its decisions endpoint. Questions in one request are therefore treated as independent.

Implemented:

- Actor evidence ([gmTools.ts](../src/lib/server/engine/gmTools.ts) `buildActorDecisionView`): an actor knows committed events it took part in, events linked to it as `actor`/`witness`/`knower`/`witnessed`/`learned`/`shared`, and the evidence for its own beliefs. Being a target is no longer knowledge; scheduled/due events (plans) are excluded; only the actor's outgoing relationships are shown (incoming edges are other characters' private attitudes); a faction's `secret` agreements reach a member only if the member is a direct party. Authored knowledge (`knownFacts`, did/saw/knew memories) comes through the character contract as `personalKnowledge`.
- `loadActorDecisionData` replaces the 13 unbounded campaign-wide queries per actor with bounded actor queries (16 beliefs, 64 knowledge links, committed events by actor/link/belief evidence, the actor's memberships and factions, 16 outgoing relationships, 200 active agreements).
- One bounded action-choice request is the default immediate response (previously psychology then action: two requests). Psychology→action is an explicit mode (`decisionMode: psychology_then_action` on the Decisions task, switch in Model roles); an unusable psychology result now abstains without the second request.
- The turn's decision block is `decideTurnActorResponses` (out of `processServerTurn`): one settings resolution, a turn-wide request budget from the task (default 4), and the unreachable generic-LLM decision fallback removed (Decisions requires a supported decision model). A planner decision is not reused when the turn's evidence adds a cited offer the planner did not see.
- Planner `askJev` reuses a completed equivalent decision under another tool-call ID, keyed by actor, action hash, evidence hash, question/purpose/options, player interactions, task policy (`immediate_response_v1`, mode, profile revision) and model; interrupted-request receipts are unchanged.
- Receipts: each actor decision records `decision { mode, requestCount, transport (completed|failed|timed_out|not_sent|reused), validation (valid|invalid|not_checked), outcome (proposed|abstained|unavailable), choice, modelConfidence, applied: false }`. `modelConfidence` is the model's confidence in its choice, not a success probability. Decisions remain advisory: the only state changes downstream of a decision are the explicitly authored negotiation rules (offer/agreement records and a resource *reservation*, with fulfilment only through the project gate), which are domain application, not the decision itself.

Evidence: `gmTools.test.ts` (a secret plot targeting the actor, its own future plan, another character's private attitude and a faction-secret agreement stay out; the plot appears only with a `learned` link; authored facts come in), `jev.test.ts` (51; single request by default, psychology mode, abstention after unusable psychology with one request), `orchestrator.decisions.test.ts` (6; disabled Decisions makes no request and no actor read, one request per actor with separated transport/validation/outcome, psychology abstention, planner reuse with no request and no reuse when an offer changes the evidence, turn budget, schema-invalid response). Not automated: the planner's cross-call-ID reuse query (covered by type checks and code review only). Unit suite: the 9 pre-existing failures only (2,435 passed); `svelte-check` 0/0.

Intentional behaviour change: immediate NPC decisions cost one request per actor instead of two unless psychology mode is selected; the psychology field is then absent from those receipts.

## Stage 5 — one chapter window lifecycle

Findings at `6c2323d`: every `summarize_chapter` job recomputed its window from the last chapter and generated again; two scheduled jobs both bought the summary (the integration test asserted two calls) and one discarded it. The pre-commit source check compared full entry metadata, so a turn receipt written by extraction completing during generation (`gmTurnReceipt`) discarded a valid summary (`projection_sources_changed`) and the next turn's job bought it again. Events were captured before generation and only checked for removal, so the last turns' late extraction was silently left out of `sourceEventIds`. An interrupted provider call left the summary checkpoint `uncertain` with no reconciliation path, failing every later chapter job for the story. The chapter-only runner committed chapters with no embedding, vault or arc consumer, and carried incident-specific approval constants in the runner itself.

Implemented ([chapterWindows.ts](../src/lib/server/jobs/chapterWindows.ts), migration `0056_chapter_windows.sql`):

- Logical slot `chapter_windows` (story, primary scope, number) and revision-specific `chapter_window_attempts`: frozen source entry IDs, per-row transcript hashes (content, pairing, branch and eligibility metadata only) for the sources and every other row in range, and a fingerprint including scope/POV, `CHAPTER_PROJECTION_COMPILER` and `CHAPTER_SUMMARIZER_REVISION` (summary checkpoint version + policy + prompt template hash).
- States `waiting`, `ready`, `generating` (leased; a duplicate job returns `window_generating` with no request), `validated`, `committed` (inside the chapter transaction), `retryable_failure`, `needs_configuration`, `uncertain_dispatch`, `invalidated`; guarded transitions, committed/invalidated terminal.
- Restart: the exact summarizer inputs are frozen on first claim, so a reclaimed or later job repeats the identical request and the existing summary checkpoints return the saved result; a validated draft is committed with no request even after new turns arrive.
- Deliberate invalidation: a changed or deleted source, a changed ignored row in range, or a moved boundary invalidates the revision with the changed IDs; the next revision is frozen from the current transcript. Turn receipts do not invalidate.
- Classifier work: queued/running extraction for the window's turns holds the window in `waiting` (deferred re-check every 45 s, at most 8 times); failed/outdated extraction is recorded in `completion.extraction.gaps` and never blocks or consumes the window. Events are attached at commit from the frozen entries.
- Reconciliation: `chapters.windows.reconcile` (`redispatch` or `invalidate`, named reviewer) keeps the blocking summary checkpoints and their receipts, marks them retryable with the note, and returns the window to `ready`. `chapters.windows.status` reports the current window, recent revisions and contiguous summarized coverage with history gaps.
- Runner convergence: the runner records its manifest as a `reviewed` revision of the same slot inside its own transactions (validated → committed with the chapter; held → `uncertain_dispatch`/`retryable_failure`; reviewed backfill invalidates the obsolete revision). It defers while the live worker is generating that slot; the live worker defers to an open reviewed revision. The runner still writes no backend jobs (its protected-table assertion is unchanged); the lifecycle owner enqueues `rollup_arc`, `embed_memory_nodes` and `sync_story_vault` for runner chapters once.
- Historical rebuild records rebuilt chapters as committed `historical` revisions and invalidates open ones; no consumer job, no character/faction change, no clock change.
- Incident constants (`calls 4 / 153,697 input / 48,000 output / $0.043`, aggregate `$0.31 / 10 chapters / 60 min`, `$0.033` + `$0.010` allocation) moved to [summaryRecoveryIncidents.ts](../src/lib/server/jobs/summaryRecoveryIncidents.ts); `authorizeChapterReplacement` moved to [chapterReplacementRecovery.ts](../src/lib/server/jobs/chapterReplacementRecovery.ts) (re-exported by the operator CLI). Retained manifests validate unchanged.

Unchanged: the 20-turn pair counting and `selectNextChapterWindow`, paginated loading with the missing-parent safeguard, the projection fingerprint stored on chapters, the chapter commit transaction and its consumers, transcript evidence in prompts, and the two-exchange bridge across the boundary (memory windows are archival, not narrative chapter endings). Windows are not part of world-database snapshots; after an import the chapter table is authoritative and a stale open revision is invalidated by its boundary or source check.

Rollback: `drop table chapter_window_attempts; drop table chapter_windows;` with the previous `processor.ts`. Chapter rows, summary checkpoints and recovery ledgers are not modified by the migration.

Evidence (disposable PostgreSQL): `chapterWindows.integration.test.ts` (6: restart after a failed commit reuses the validated draft and the frozen sources after 5 new turns and a receipt update — one generation; a source edit invalidates revision 1 with the changed ID and commits revision 2 with the edit; pending extraction waits with a deferred job, then the late event joins the chapter; failed extraction is a recorded gap and coverage is contiguous; an uncertain dispatch holds, a later job does not redispatch, reconciliation requires a reviewer, keeps the checkpoint as failed/retryable and the next job commits; missing summarizer configuration → `needs_configuration`, then the identical frozen request), `chapterCommit.integration.test.ts` (5; competing jobs: one generation, one chapter, the duplicate returns `window_generating`), `chapterSummaryRunner.test.ts` (26 incl. 3 new: reviewed revision recorded with no runner job writes, runner defers to a generating live window without allocating, lifecycle owner enqueues only index/arc consumers once, live worker defers to a held reviewed window), `summaryRecovery*.test.ts` (43 + 3), `summaryRecoveryOperator.test.ts` (11, with the operator bundle rebuilt from this tree and then removed). Unit: `chapterWindows.test.ts` (12), `chapterLifecycle.test.ts` (11), `summaryRebuild.test.ts` (20; rebuild writes historical windows and no jobs), `chapterWindowsCommand.test.ts` (2).

## Stage 6 — World Clock

Findings at `6c2323d`: `stories.current_world_time` was whatever the narrator's first-line header said (`patchValidator.ts` `parseNarrationSceneAnchor`), so a header could move time backwards or jump arbitrarily; thought and other non-canon-scene turns applied it too. The classifier's `time_delta` ("how much time passed") never advanced time — it only filled an empty clock with its raw text (e.g. `Dawn after the fire`). Scheduled events were measured only in turns; event `world_time` was never compared with the clock. There was no record of time changes and no rollover beyond the narrator's own text.

Implemented ([worldClock.ts](../src/lib/server/events/worldClock.ts), migration `0057_world_clock.sql`):

- `world_clocks` (story, branch `primary`): minutes since 00:00 of the anchor day, calendar, anchor (`day-number`, `named-day`, `calendar-date`, `unanchored`), precision (`minute`, `approximate`, `day`, `unknown`), label, revision. `world_time_changes`: one row per source operation (`op_key` unique) with status, kind (`advance`/`anchor`/`set`), proposer (`gm_header`, `classifier`, `operator`, `external_label`), source entry and turn, requested/applied minutes, before/after minutes and labels, clock revision, and the events that interrupted it. Rejected proposals are recorded too.
- Conservative migration: no label is rewritten by SQL. A story's clock row is created from its label on its first recorded change. `Day 3 | 06:15` → day 3 at 06:15; `Day 1 | Noon` → approximate; `Day 0` → day precision (label keeps the `Day N` form the faction world-day gates read); named dates keep their text; free text (`Twilight of Ashes`) stays unanchored and shows elapsed time (`Twilight of Ashes (+1h)`) until the first usable header anchors it.
- Turn path: the header and `time_delta` are proposals (exact duration > header > estimate), applied in the turn transaction under `turn:<assistant entry>`; the deferred extraction of the same turn is a duplicate. Earlier header times are rejected with a warning (`header_time_earlier_than_clock`); header steps are capped at 7 days, stated durations at 366 days. A differently named day with no calendar counts as the next day only.
- Interruption: a wait stops at the first event whose `metadata.dueWorldMinutes` it reaches; those events become `due` (no `occurredTurn`). `timeline.schedule` accepts `delayWorldMinutes`.
- Calendar rollover: hours per day plus optional months/weekdays/era; `world.clock.configure` sets it (and/or an explicit time) with a named reviewer and records the change; `world.clock.status` returns the clock and recent changes.
- Display: `stories.current_world_time` stays the label every reader uses (prompt, GM brief, World Sheet, faction workflow); a header step that lands where it said keeps the narrator's wording. An externally changed label (import, checkpoint revert, record edit) re-anchors the clock on the next change, recorded as `external_label`.

Unchanged by design: `currentTurn` still increments once per applied non-OOC turn (turn sequence ≠ fictional time); turn-scheduled events and their promotion; faction world-time wakes (still on any label change, same dedupe key); faction world-day gates (still only exact `Day N` or ISO labels — narrated `Day 3 | 06:15` clocks remain gated as before; reading the clock there would start faction reviews that were held, a spend-relevant change left for a decision). There is no server-side narration regeneration; change rows keep the pre-turn values for one, and checkpoint revert restores the label (re-anchored on record). The browser-only path keeps its local `timeTracker` (Stage 7).

Intentional behaviour changes: a classifier-stated duration now advances the clock; `time_delta` text is never stored as the label; thought turns and earlier header times no longer move time; parallel-POV turns still tag their own events with their header time but never move the main clock.

Rollback: `drop table world_time_changes; drop table world_clocks;` with the previous `patchValidator.ts`; labels already written remain valid text labels.

Evidence: `worldClock.test.ts` (4: label parsing incl. day-only and calendar dates, rollover across day/month/year/weekday and a 30-hour day, duration parsing, header proposals incl. rejection of rewinds and oversized jumps, next-day assumption, calendar-date diffs, anchoring an unanchored clock); `worldClock.integration.test.ts` (4, disposable DB: a 10-minute wait with an event due after 3 minutes applies exactly 3 once, the event becomes due not occurred, and a repeat is a duplicate; a turn applies once, its delayed extraction and OOC/thought/POV turns change nothing, an earlier header is rejected; unanchored → anchored → external label re-anchor recorded; configured calendar rollover with operator record); `patchValidator.test.ts` (67; four expectations updated to the new semantics); `factions/workflow.integration.test.ts` (100, on `mythengine_faction_repair_consolidation_20261010`: the deferred `[Time: Noon | Day: 1]` turn still yields `Day 1 | Noon` and one world-time wake, deduped on reapply).

## Stage 7 — retirement, convergence and verification

Implemented:

- **Legacy GM planner runtime retired for new turns** ([agentRuns.ts](../src/lib/server/engine/agentRuns.ts)). Live evidence (read-only query of the `mythengine` database): no shelf or story overrides `gmPiRuntime`; 795 legacy-runtime runs exist, the last created 2026-10-05; none is running, awaiting input, committing, or a failed run still eligible for retry. Every new run now uses Pi; a saved `gmPiRuntime: false` is ignored (the key stays readable for saved documents); the toggle was removed from Settings → Agent Tools (rendered check on the worktree app: only the Assistant runtime remains, with "GM turns always use Pi"). Legacy run records stay readable and their guarded retry path is unchanged.
- **Oversized file split**: the chapter commit and its consumers moved from `processor.ts` (5,812 → 5,385 lines) to [chapterCheckpoint.ts](../src/lib/server/jobs/chapterCheckpoint.ts) (453 lines); `processor.ts` re-exports them, so callers, CLI and tests are unchanged. New Stage 2–6 logic went into its own owners (`modelSettings.ts`, `narrativePreset.ts`, `characterContext.ts`, `chapterWindows.ts`, `worldClock.ts`) rather than the large files.
- **Duplicate orchestration**: the chapter-only runner now shares the window lifecycle and consumers (Stage 5); implicit role fallbacks and resolver-side enablement were removed (Stage 2); the narrator header no longer writes the clock (Stage 6).
- **Test isolation**: the two settings integration suites mutate global rows; they now serialize through a PostgreSQL advisory lock, so the DB suites pass when run in parallel.

Browser/server convergence: the browser-only turn path still serves stories without a `serverStoryId`. The migration path already exists — the Chapters panel shows "Local-only. Import to use terminal memory retrieval and sync." with a bind action (`importLocalStoryToBackend` → `importStoryBundleToBackend`). Local-only stories live in the user's browser IndexedDB, which this session cannot enumerate or migrate, so the path is kept as a compatibility layer (see Unfinished work).

### Before/after prompt comparison

Method: the same fixture `TurnContext` scenarios (the character-context test fixture with a richly described NPC: an addressed turn, an ambient turn, and a plain turn) were built by `buildServerTurnPrompt` in a clean export of the baseline `6c2323d` and in this tree, with no database or provider. Result:

| Packet part | addressed | ambient | plain |
| --- | --- | --- | --- |
| narrator system prompt (5,906 chars) | identical | identical | identical |
| stable context (premise, history, chapter memory) | identical | identical | identical |
| dialogue messages | identical | identical | identical |
| character card in the turn context | changed | changed | changed |

The only differences are the character cards (Stage 3), all intended: the addressed NPC keeps its full personality text and gains `[Dialogue examples]`; empty `[Appearance]: .`, `[Goals]: .`, `[Affiliations]: .` and `[Voice]:` placeholder lines are no longer emitted (`[Personality]: .` is kept); scene (non-addressed) cards allow personality up to 260 characters where the baseline cut it at 140 — a change the Stage 3 summary above did not list. An earlier run with the prompt-harness fixture (no character cards rendered) was byte-identical in every part. Retrieval and ranking (`server/memory/*`) are not modified by this consolidation; recall inputs change only where intended (chapters now attach late-extracted events; addressed cards are fuller).

### Call counts per turn

| | Baseline `6c2323d` (defaults) | After (defaults) | After, with the copied live settings |
| --- | --- | --- | --- |
| GameMaster | 1 (Pi; draft reused when tool-free) | 1 | 1 |
| Classifier extraction | 1 deferred (+1 repair on invalid output); on failure retried **on the GameMaster profile** | 1 deferred (+1 repair); no cross-role fallback | 1 |
| Decisions | 0–2 actors × **2** requests whenever the old resolver had auto-created an enabled `actorDecision` row (it did on the first planner round) | 0 (off by default) | ≤1 per actor on social-stakes turns, turn budget 4 (saved task enabled; the Decisions role uses `typesafe/jev-1.13`); the same settings on the baseline cost 2 per actor |
| Adaptive research (`activeRecall`) | 0 (off) | 0 (off) | when triggered (saved row is enabled) |
| Continuity review | 0 (off) | 0 (off) | 1 per turn (saved row is enabled) |
| Suggestions (browser, after the turn) | 1 unless disabled | 1 unless disabled (interface setting, or disable the task) | 0 (saved task is disabled) |
| Dialogue pass | 0 (off) | 0 (off) | 0 (saved row keeps its own model but is not enabled) |

Server turn with defaults: **one GameMaster generation + one classifier extraction**, which meets the target; suggestions are a browser-side extra on by default. Periodic work is unchanged in cadence: chapter summary every 20 turns (now at most once per window, reused after restarts), arc every 10 chapters, plot brain every 8 turns, faction tick every 5 turns or on a world-time change. Evidence: `agentRuns.pi.test.ts` (a tool-free turn makes exactly one GameMaster request and reuses the draft), `orchestrator.decisions.test.ts`, `orchestrator.test.ts` (no classifier fallback), the Stage 2 migration check of the live rows.

### Verification (final tree)

- Unit suite (`npx vitest run`): 243 files passed, 2,452 tests passed, 297 skipped; **9 failures in 8 files, all pre-existing at `6c2323d`** (table above, unchanged).
- `npm run check`: 0 errors, 0 warnings. `npm run build`: succeeds (`MythEngine build f4c37d26650a / artifact b07786c29a21`, output in the ignored `build/`).
- DB-backed suites on disposable databases: chapter commit (5), chapter windows (6), World Clock (4), model settings (3), prompt presets (2) — 20/20 in parallel; chapter-only runner 26/26, summary recovery 40 (+1 skipped) and 3, recovery operator 11/11 (CLI bundle rebuilt from this tree, then removed), faction workflow 100/100.
- Rendered checks (worktree app on port 5199 against the disposable DB): Model roles panel and preset editor (Stages 2–3), Agent Tools after the runtime retirement (Stage 7).
- Not exercised: live provider requests (none were made), the running app on port 5173 and the live database (read-only queries only), browser-only stories.

## Final deliverables

### Ownership map

| Concern | Owner | Notes |
| --- | --- | --- |
| Task/role registry | [modelTasks.ts](../src/lib/contracts/modelTasks.ts) | 22 active tasks, 6 roles; shared by server and UI |
| Model settings resolution and save | [modelSettings.ts](../src/lib/server/engine/modelSettings.ts) | read-only resolution with provenance; revision-checked save; [llmSettings.ts](../src/lib/server/engine/llmSettings.ts) is the legacy facade |
| Narrator instructions | [narrativePreset.ts](../src/lib/server/turn/narrativePreset.ts), [promptPresets.ts](../src/lib/server/engine/promptPresets.ts) | immutable revisions, per-story selection |
| Character cards | [characterContext.ts](../src/lib/server/turn/characterContext.ts) | contract v1, narrator/actor views, tiers |
| Actor decisions | [jev.ts](../src/lib/server/turn/jev.ts), `decideTurnActorResponses` in [orchestrator.ts](../src/lib/server/turn/orchestrator.ts), actor views in [gmTools.ts](../src/lib/server/engine/gmTools.ts) | advisory only; one request by default |
| Chapter window lifecycle | [chapterWindows.ts](../src/lib/server/jobs/chapterWindows.ts) | live, reviewed and historical windows |
| Chapter commit and consumers | [chapterCheckpoint.ts](../src/lib/server/jobs/chapterCheckpoint.ts), [outbox.ts](../src/lib/server/jobs/outbox.ts) | one commit transaction; chapter-keyed consumer jobs |
| Reviewed chapter-only runner | [chapterSummaryRunner.ts](../src/lib/server/jobs/chapterSummaryRunner.ts) | launcher-gated; never writes backend jobs |
| Incident recovery tooling | [summaryRecoveryIncidents.ts](../src/lib/server/jobs/summaryRecoveryIncidents.ts), [chapterReplacementRecovery.ts](../src/lib/server/jobs/chapterReplacementRecovery.ts), operator CLI | local operator only |
| World time | [worldClock.ts](../src/lib/server/events/worldClock.ts) | only writer of fictional time; turn path in [patchValidator.ts](../src/lib/server/turn/patchValidator.ts) |
| World-time scheduling | [timeline.ts](../src/lib/server/events/timeline.ts) | `delayWorldMinutes` → `metadata.dueWorldMinutes` |
| GM run runtime | [agentRuns.ts](../src/lib/server/engine/agentRuns.ts) | Pi only for new turns |

### Keep / merge / retire inventory

| Path | Decision | State | Condition for removal |
| --- | --- | --- | --- |
| `llm_service_settings` table | keep (rollback source) | read only by migration 0054 | after the new tables run in production for a release |
| `settings.llm.*` commands, `llmSettings.ts`, AI Services per-service panel | keep as compatibility facade | writes through the legacy adapter as inheritance | when the browser settings store reads `settings.models.get` directly |
| Implicit classifier→GameMaster, summaries chain, smallBrain/characterUpdate fallbacks | retired | replaced by explicit fallback profiles | — |
| Resolver auto-creating enabled rows (`terminal_default`) | retired | not migrated | — |
| Browser `syncInheritedGameMasterTools` copy-on-sync | retired | — | — |
| `worldSimulation`, `styleReviewer` task IDs | retired | rows left in the legacy table | with the legacy table |
| Legacy narrative `systemPromptOverride` | merged into presets | kept in the database for rollback, ignored once presets exist | with the legacy table |
| Psychology→action two-request Decisions | kept as explicit mode | default is one request | — |
| Generic-LLM actor decision fallback | retired | — | — |
| Separate chapter-only runner | merged into the shared window lifecycle | still its own launcher-gated workflow | when no story enables `chapterRunnerEnabled` (live: disabled) |
| Incident replacement constants in the runner | moved to recovery tooling | retained receipts still validate | after the retained manifests are archived |
| Narrator header as clock writer | retired | the header is a proposal | — |
| `time_delta` as clock label | retired | it is a duration | — |
| Legacy GM planner runtime (`gmPiRuntime: false`) | retired for new turns | legacy branches in `agentRuns.ts` serve existing records only | delete the branches once legacy records are archived (live: 0 resumable) |
| `activeRecall` adaptive research | keep (optional, off by default) | saved enabled in live rows | the brief maps it to on-demand GM research; merging changes recall behaviour, so it needs a decision |
| Browser-only turn path, IndexedDB chapters, browser `timeTracker` | keep as compatibility | serves unbound stories | after local-only stories are bound to the server |

### Migrations, recovery and rollback

Apply in order with `node scripts/db-migrate.mjs` (each file runs in one transaction). All four are additive; none rewrites existing campaign rows.

| Migration | Adds | Data changes | Rollback |
| --- | --- | --- | --- |
| `0054_model_roles.sql` | `model_profiles`, `model_roles`, `model_task_overrides` | converts `llm_service_settings` (left unchanged) | `drop table model_task_overrides, model_roles, model_profiles;` and redeploy the previous code (it reads the legacy table) |
| `0055_prompt_presets.sql` | `prompt_presets`, `prompt_preset_revisions`, `story_prompt_presets` | built-in preset; migrated-override preset when a narrative override existed | `drop table story_prompt_presets, prompt_preset_revisions, prompt_presets;` (the override is still in `llm_service_settings`) |
| `0056_chapter_windows.sql` | `chapter_windows`, `chapter_window_attempts` | none | `drop table chapter_window_attempts, chapter_windows;` |
| `0057_world_clock.sql` | `world_clocks`, `world_time_changes` | none (clocks are created on the first recorded change) | `drop table world_time_changes, world_clocks;` (labels already written stay valid text) |

Before applying to the live database: take the usual backup; review the Stage 2 note on `continuityReview`/`activeRecall` being enabled in the saved rows; keep the job worker stopped until the new code is running, so no old-code worker resolves settings against the new tables. Recovery after a failed deploy: roll the code back first, then drop the new tables in reverse order (0057 → 0054).

### Operator instructions

- **Presets** — Settings → Prompts → Narrative: choose or duplicate a preset, edit text sections (engine rules are locked), check the preview's per-section token counts, save (creates a revision), then "Apply revision N to this story". The default preset's designated revision applies only to stories without a selection. CLI/MCP: `prompts.presets.*`.
- **Model roles** — Settings → AI Services → Model roles: set the GameMaster, Classifier and Summaries profiles; enable Decisions only with a supported decision model (psychology mode is a separate switch); per task choose "Inherit role" or an override. CLI/MCP: `settings.models.get` / `settings.models.save` (pass `expectedRevision`).
- **Chapter progress** — `chapters.windows.status` shows the next window (state, frozen sources, extraction gaps, failure), recent revisions and contiguous summarized coverage. A window in `uncertain_dispatch`, or a blocked failure, needs `chapters.windows.reconcile` with `decision: redispatch` (one new request for the same frozen inputs) or `invalidate` (refreeze from the current transcript), and a named `reviewedBy`. A failed chapter consumer is retried with `jobs.retry`.
- **World time** — `world.clock.status` shows the clock and its recent changes. `world.clock.configure` sets a calendar (`hoursPerDay`, `months` with day counts, `weekdays`, `era`) and/or an explicit current time (`label`), with `reviewedBy`. Schedule an event by world time with `timeline.schedule` `delayWorldMinutes`; a wait stops when it is reached and the event becomes due.

### Unfinished work

| Item | Files | Blocker / reason | Next step |
| --- | --- | --- | --- |
| Retire the browser-only turn path | `components/story/engineTurnRouting.ts`, `stores/story.svelte.ts`, `services/ai/*` | local-only stories live in the user's browser storage; this session cannot see or bind them | bind each local-only story (Chapters → Import), then remove the browser turn, chapter and `timeTracker` paths |
| Delete the legacy run branches | `engine/agentRuns.ts` (`isPiRun` branches, legacy advance/retry) | historical records still render through them | archive or convert the 795 legacy run records, then delete the branches and their tests |
| Merge `activeRecall` into on-demand GM research | `turn/orchestrator.ts`, `engine/smallBrain.ts`, `contracts/modelTasks.ts` | changes recall behaviour; enabled in the live rows | decide; then compare recall receipts on a fixture story before and after |
| World-day faction gates read the clock | `factions/intentions.ts` (`worldDay`), `factions/workflow.ts` | would start faction reviews held today (spend) | decide; then read `worldClockDayText` instead of parsing the label |
| Split `turn/orchestrator.ts` (5,346 lines) | `turn/orchestrator.ts` | its helpers are shared with many tests that mock the module path | extract `decideTurnActorResponses` and the classifier block behind re-exports, as done for `chapterCheckpoint.ts` |
| Live deployment | — | not requested; the live app and database were not touched | back up, migrate 0054–0057, deploy, verify one turn's receipt (`modelTasks`, `promptPreset`), the clock and chapter status |
| Planner cross-call Decisions reuse test | `engine/agentRuns.ts` | not automated | add a DB-backed test with two equivalent `askJev` calls |
