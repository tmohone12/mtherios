# Browser engine retirement and polish — 2026-10-10

Status: implemented on branch `cleanup/retire-browser-engine` (worktree `.claude/worktrees/cleanup`), based on `680819c` (tree-identical to `3af18e7`, the prior review's base). Not merged or deployed. This is a dated working record; [ARCHITECTURE.md](../ARCHITECTURE.md) owns the current system description.

No `mtherios-server-cleanup.patch` was present in the checkout, so none was applied. The live app (port 5173), the live `mythengine` database and saved settings were not touched. No paid provider was called.

## Resulting execution flow

- **Narrative turn:** [ActionInput.svelte](../src/lib/components/story/ActionInput.svelte) → `story.prepareBackendAgentTurn()` (flushes queued edits, refuses on sync conflict) → `agent.run.start` (`wait: false`) → the composer follows the run through `/api/engine/run-stream` and a 2-second poll, answers questions/rolls with `agent.run.respond`, stops it with `agent.run.cancel`, and on completion applies the server's turn response. [actionInput.ts](../src/lib/components/story/actionInput.ts) owns the start/recovery decision (`startServerTurn`) and the draft-restore decision (`failedDraftRestoreTarget`).
- **Browser-only save** (no `serverStoryId`): transcript and exports stay available; the composer keeps the draft and offers "Import and continue" (`story.importCurrentStoryToServer()` → existing `importLocalStoryToBackend`), then loads the server copy.
- **Chapters, arcs, sagas:** server jobs only. The World drawer's "Write arc now" control appears only when `selectArcRollupBatches` finds the next 10 consecutive uncovered chapters and runs `jobs.rollupArc`; sagas come from the job the arc transaction queues.
- **Context display:** the last recorded server receipt (labelled as recorded) beside the next-turn budget setting; "Preview context" runs `turn.preview`. No browser prompt estimate.
- **Remaining browser model calls** (optional, never write a turn): player suggestions and story setup assistance (Declare Plan was removed in the second follow-up).

## Inventory

### Removed (unused or superseded)

| Removed | Why it was dead or superseded |
| --- | --- |
| `ActionInput.svelte` local branch: streamed narration, inline tool calls, tool-only continuation, roll continuation, post-narration classifier, background jobs | Reached only for stories without `serverStoryId`; replaced by import-before-play |
| `services/ai/background/runner.ts` (browser chapter/arc/saga/lore jobs) | Called only by the local branch |
| `services/ai/tools/executor.ts`, `generate-with-tools.ts`, `inline-extractor.ts`; `GM_TOOLS`, wiki/roll tool schemas, executor-only helpers | Browser tool application and classifier; the server validates `worldStateUpdateSchema` (kept) |
| `services/ai/generation/MemoryService.ts`, `SagaCondensationService.ts`, `ArcCondensationService.ts`; `lorebook/LoreManagementService.ts`, `EntryRefinementService.ts`; schemas `memory`, `saga`, `arc`, `lorebook`, `entryRefinement` | Browser summarizers/lore management; `EntryRefinementService` had no caller at all |
| `services/ai/embeddings/EmbeddingService.ts`, `retrieval/EntryRetrievalService.ts`, `context/ContextBudgetService.ts`; IndexedDB embedding-cache accessors | Browser semantic retrieval and prompt budgeting for the local prompt |
| `sdk/generate.ts` `streamNarrative`, `continueAfterTools`; DeepSeek roleplay injection | Browser narrator transport; `generateNarrative` stays for the remaining helpers (`generateStructuredWithTools` went with Declare Plan, below) |
| `story.svelte.ts` prompt/snapshot/classifier builders (`buildSystemPrompt`, `buildStateSnapshot`, `buildOrchestratorSystemBlocks`, `serializeSnapshotForClassifier`, `buildConversationMessages`, `buildUserPrompt`, all `#section*`), local estimate fields, turn-only mutators, test-only `submitBackendTurn` | 4,252 → ~2,420 lines; only the local branch and the context estimate read them |
| Client `processBackendTurn`, `retrieveBackendMemory`; canonical write wrappers used only by the executor/runner (`saveCanonicalLocation`, `Item`, `Saga`, `ConversationMemory`, `WorldEvent`, `FactionActions`, `Rumors`, `Schemes`) | Second, test-only submission path; executor/runner write path |
| `SchemeService.injectSchemes`, `buildMtheriosSummaryInstruction`, unused war-doctrine blocks, `ai/core/config` constants | Browser prompt/summarizer text |
| `components/canon/CanonRepairCockpit.svelte` + `services/canonRepair.ts`, `components/memory/ChapterRunnerPanel.svelte`, `ai/image/ImageGenerationService.ts`, `services/terminalWiki.ts`, `server/memory/continuity.ts` | Never mounted/imported (or test-only); server canon repair, image jobs, the chapter-runner route and wiki routes remain |
| WorldDrawer "Analyze N chapters → Arc" (browser condensation after **3** chapters, written as a canonical arc), "sim in Nd" countdown (browser 7-day constant), "~N / 200K" local estimate | Contradicted the worker (10 consecutive chapters; faction ticks every 5 turns); replaced by the server job / recorded receipt |
| ContextWindow local estimate and browser "auto" budget; Settings dials for the browser engine (prompt cap, message/history scans, local chapter/lore/NPC-memory limits, summarizer context); "Show word count" (read nowhere); image mode "Agentic" (behaved exactly like "Inline") | Stale controls; stored keys are left in saved settings and ignored |

Client JS in the production build fell from 3.95 MB to 1.70 MB, mostly because the browser no longer bundles the tokenizer tables.

### Consolidated

- One browser submission path (`agent.run.*`); the `/api/turn` routes stay for CLI/evals.
- Manual arc control uses the worker's selector and job; worker-created arcs/sagas now refresh the browser projection (`shouldRefreshCampaignProjection` handles `rollup_arc`/`rollup_saga`).
- One import entry point (`story.importCurrentStoryToServer`) for the composer and the memory panel when the open story is selected.

### Compatibility retained

| Retained | Reason |
| --- | --- |
| `chapterThreshold`/`postChapterBuffer`/`chaptersPerArc` wire keys (client context, MCP schemas, `jobs.rollupArc` arg) | Public command/MCP inputs with `additionalProperties: false`; values are fixed or ignored (arc arg no longer copied into new job payloads) |
| `/api/turn`, `/api/turn/stream` | Used by `scripts/eval-turns.mjs` and CLI paths |
| `turn_command` sync-op type | Server records turns with it; older browser outboxes may hold one (shown as a repair item) |
| Dexie tables incl. `embeddingCache`; `conversationMemories` mirror; `timeTracker`/`meters` fields | Existing browser databases and local exports |
| Legacy agent-run branches in `agentRuns.ts` | Persisted legacy runs stay readable/resumable |
| `worldsim` schema, `saga.*`/`arc.*` record commands, client saga wrappers | Old snapshots, CLI/MCP record edits |
| Hidden "detached" saves (`syncStatus: 'local-only'` after the server copy was deleted) | Deliberate and tested in `refreshStoryCatalog`: server deletion must stick; never-bound saves stay visible |

## Intentional behaviour changes

- A browser-only save can no longer be played locally; the composer asks to import it first and keeps the draft.
- If an accepted run later fails or is stopped, its move returns to the composer (previously lost unless the start request itself failed). A failed `/plan` or invalid `/roll` keeps the text and shows the error in the composer; plan failures are no longer written to the transcript.
- Post-turn suggestions and automatic scene images now run when a run started from the composer completes (they effectively never ran for server turns, because completion arrived after the composer had cleared its "generating" flag).
- The ContextWindow budget slider can select Auto again.

## Test baseline

Baseline at `680819c` in this worktree: 2,452 passed, **9 failed** (8 files), 297 skipped — the same set the consolidation report recorded. After: **2,371 passed, 0 failed, 297 skipped**.

| Failure | Cause | Fix |
| --- | --- | --- |
| `decisionMatrix`, `decisionOrder` | Depended on the machine's Kev opt-in | Opt in per test via the environment (as `jev.test.ts` does) |
| `sceneCheckpoint` (12k → 4k dialogue) | Obsolete assertion: a token-only allowance has no turn cap and the whole 6.8k-token fixture fits, so the opening is kept verbatim | Assert that; the 4k case still keeps the promise only as a checkpoint note and context records stay identical |
| `arcSelectionTrace` | Read a live-campaign fixture from outside the repo (absent) and wrote a file outside the repo | Self-contained synthetic fixture with the same assertions; no writes |
| `legacyGatewayRoutes` | Expectation predated the `scope` argument (contract default `all`) | Expect `scope: 'all'`, add a `faction` pass-through case |
| `negotiationPrototype`, `appStoryCli` | CRLF checkout (`core.autocrlf`): line split and a CRLF shebang | `\r?\n` split; `.gitattributes` pins `scripts/**/*.mjs` to LF |
| `sourceFiles` (2) | Fixture under a dot-folder worktree path (unmountable by design) | Fixture under the nearest mountable ancestor |

Removed tests: 53 in 15 deleted test files and 46 in kept files, all exercising deleted code (browser runner, executor, summarizers, prompt builders and their schemas/helpers) or the test-only `/api/turn/stream` client. Added: 16 (draft restoration, turn start/recovery/story switch/failure, import-before-play, arc/saga refresh) plus updated wiring checks.

## Verification

- `svelte-check`: 0 errors, 0 warnings. `npm run build`: succeeds. `git diff --check`: clean. Links in the updated docs resolve.
- Reference audit: an import-graph reachability scan finds no imports of deleted modules; non-app modules are test fixtures/support and operator scripts only.
- Rendered and runtime checks on the worktree build against a disposable database (`mythengine_cleanup_20261010`, port 5199, jobs off, local AI off, provider keys removed from the process environment; dropped afterwards). A local fake OpenAI-compatible endpoint stood in for the GameMaster/Classifier:
  - browser-only save: transcript readable, Send/Plan disabled with explanation, draft kept; "Import and continue" bound it, kept the draft, and did not advance turn or world time;
  - missing model configuration: run failed with "Model configuration needed…", nothing written to the transcript, draft returned;
  - completed turn: one GameMaster request, action + narration committed once, receipt shown;
  - cancellation: Stop cancelled the run, aborted the provider request, added nothing, returned the draft;
  - reload mid-turn: the composer recovered the running run and showed the narration once when it completed;
  - arc control: shown only for chapters 1–10; the job's configuration failure was shown and no arc was written;
  - job retry: failed `extract_turn_state` retried via `jobs.retry`, re-ran, and its prose output was rejected at validation (nothing applied); `rollup_arc` is reported as not manually retryable;
  - export → import as a copy: remapped ID, same 7 entries and 10 chapters, turn and world time unchanged, no jobs queued for the copy.

## Follow-up on the same branch

A second pass resolved four of the original follow-ups and removed further dead code:

- **Retry after configuration failures.** `summarize_chapter` and `rollup_arc` can be retried manually when their recorded failure is a missing model configuration, which is raised before any request or write (the chapter window records `needs_configuration` and reuses its frozen inputs). Other failures of those types still need review. `rollup_saga` joined the replay-safe list: it builds a deterministic summary of covered arcs and upserts it under a stable saga ID with its memory node in one transaction, recomputing coverage first.
- **Chapter edits keep the stored account.** `chapter.upsert` keeps the stored bracketed account when the incoming summary equals its condensed display form, so a title, tone or pin edit no longer replaces it; an edited summary still replaces it. The chapter memory node and character-reference proposals now receive the full account in that case.
- **Arc record commands validate coverage.** `arc.create`/`arc.upsert` accept a new or changed chapter set only when every chapter is saved in the story, listed once, and in no other arc; an edit that leaves the chapter set unchanged is not re-checked. The memory panel now shows "Not saved: …" when a chapter or arc save is rejected instead of failing silently.
- **Wording.** User-facing "terminal" and "Pi" labels in Settings, Agent Tools, the prompts panel and the app navigation now say "story server", "server sync" and "recoverable runtime"; "subagent" was dropped from the settings groups. Diagnostics panels and server error text keep their technical names.
- **Retired tasks.** The model-task registry marks `sagaCondensation`, `loreManagement` and `entryRefinement` retired (their only implementations were the removed browser services); the settings groups and prompt list no longer offer them, and saved values still migrate.
- **Dead code.** A compiler unused-locals pass removed 13 unreferenced functions and their types from `jobs/processor.ts` (an old faction-tag sync, dynastic pairing, world-tick text and memory helpers, an unused projection check; about 450 lines), the GM-authority/economy imports `promptPacket.ts` no longer uses (now owned by `narrativePreset.ts`), and smaller unused imports and locals. The only remaining unused local in non-test code is in an operator benchmark script.

Verification after this pass: `svelte-check` 0/0; production build succeeds; 2,375 tests passed, 0 failed, 297 skipped (4 new tests).

## Second follow-up (2026-10-11): world time and Declare Plan

**Correction.** The first follow-up listed "header time waits for extraction". That was wrong: `processServerTurn` applies the header's time and location at commit even when extraction is deferred. The runtime check saw no movement because the fake endpoint wrote an unlabelled header (`[Day 3 | 09:42 | Harbor]`), which the header parser read as time `Day 3` with no clock time.

**Why time stopped in the live campaign** (read-only queries against the live database; nothing was changed):

- The Veil narrator stopped writing the header line at 2026-10-11 01:47. With no header there is no proposal, so the clock stayed at `Day Eighth Moon 11, 301 AC | 09:50`.
- The fallback, the classifier's `time_delta`, runs in background extraction. The live config has `jobWorker: false`; no job has completed since 2026-10-08 00:27 and 5,792 are queued.

**Fix.**

- Headers are read by content, not field position, so unlabelled headers carry their time and place.
- When a saved turn has no usable header, the server writes one before saving: a new `sceneHeader` model task (Classifier role, one request, temperature 0.1) gets the previous header, the clock label, the location, the player action and up to 6,000 characters of the passage, and returns one line. The line is used only when it starts and ends with brackets and has a clock-readable time that the world clock accepts (no rewind or oversized jump). Any other result, a request error or a missing Classifier profile leaves the narration unchanged and adds a turn warning; a cancelled turn still cancels. OOC, thought and parallel-POV turns, and stories without a time label, make no request. The clock then advances through the existing commit path (`turn:<assistant entry>`, so repeats cannot re-advance).
- The task can be switched off in the model-task settings; it costs one Classifier request only on turns whose narration has no header.

**Declare Plan removed.** The `/plan` command, the Declare Plan dialog and both Plan buttons are gone, with `SchemeService` (player-plan structuring), its schema, `saveCanonicalScheme`, the browser `generateStructuredWithTools` call and its DeepSeek detection, `parseJsonFromText` and an unused war-scheme prompt block. A typed `/plan …` is now sent as an ordinary action. Existing scheme records, including older player schemes, stay readable and editable.

Verification after this pass: `svelte-check` 0/0; production build succeeds; 2,366 tests passed, 0 failed, 297 skipped (8 new scene-header tests; removed tests covered only the deleted plan, DeepSeek-detection and JSON-extraction code). Runtime check on the worktree build against a disposable database (`mythengine_timecheck_20261011`, port 5199, jobs off, extraction deferred as the browser sends it, a local fake endpoint as GameMaster and Classifier; dropped afterwards), clock set to `Day 3 | 09:42`:

- headerless narration: one scene-header request; header prepended; clock 09:42 → 10:05 (`turn:<entry>`, proposer `gm_header`), entry metadata `sceneHeader`;
- a second headerless turn: 10:05 → 10:30;
- a written header earlier than the clock: narration unchanged, warning `header_time_earlier_than_clock`, clock unchanged;
- narration with its own header: no scene-header request, clock 10:30 → 11:15;
- an OOC turn: no scene-header request, clock unchanged;
- Settings → model tasks lists "Scene header" (Classifier, ready, enabled).

## Further work (prioritized)

1. ~~The live job worker is off.~~ Replaced by turn jobs; see [turn-jobs-2026-10-11.md](turn-jobs-2026-10-11.md).
2. Unused per-table CRUD helpers in `services/database.ts` and command wrappers in `serverStories.ts` predate this work; trim with the IndexedDB compatibility review.
