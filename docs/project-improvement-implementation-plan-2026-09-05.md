**Mtherios implementation plan — September 5, 2026**

Status: implementation completed September 5, 2026, with acceptance evidence and remaining validation limits in the [implementation results](/E:/DEV/Projects/mtherios-master/docs/project-improvement-implementation-results-2026-09-05.md). The optional paid semantic comparison and automated browser import acceptance are not claimed as completed. Based on the [ten-item improvement scan](/E:/DEV/Projects/mtherios-master/docs/project-improvement-scan-2026-09-05.md). The recent UI and character-creation fixes and unrelated working-tree changes were preserved.

The outcome is a campaign that survives export/import intact, carries character knowledge and relationships across scenes, supplies the Director with actual faction state, and explains which evidence reached the model. Implement this through the existing canonical database, prompt compiler, retrieval services, jobs, and review controls.

Checked items below record implemented work. The original acceptance gates are retained as specifications; consult the results document for the checks actually executed, browser limitations, and the bounded live NPC scan result.

| Order | Deliverable | Audit findings | Completion evidence |
| --- | --- | --- | --- |
| 1 | Reliable campaign export and import | 1, 2 | Real current-format round trip; consistent concurrent export; oversized import writes nothing |
| 2 | Executable replay foundation | 8 | A real isolated turn produces a scored result and an intentional defect makes the command fail |
| 3 | Scene and chapter-to-arc continuity | 4, 6 | Learned facts, relevant promises, and relationship reasons survive transitions and rollups |
| 4 | Full-history retrieval and answer preservation | 3 | The three structural benchmark misses pass; semantic ranking is evaluated separately |
| 5 | Faithful faction input for the Director | 5 | Canonical allies, treaties, resources, active goals, and relevant recent moves survive selection |
| 6 | Accurate context receipts and failed-job recovery | 7, 9 | UI matches the final request; one failed job can be retried without duplicate effects |
| 7 | Source-backed recurring NPC coverage | 10 | Reviewed evidence creates or enriches the exact character, persists after reload, and reaches narration |

**Preparation and execution rules**

- [x] Record the starting branch, dirty-file inventory, live provider routing, applied/pending Director state, and current checks. Keep the scan's benchmark artifact as the comparison baseline. Live status is a moving snapshot: at planning time the app was healthy and processing queued work; the audit's empty queue is not a permanent assumption.
- [x] Add focused regression cases alongside each fix. Reuse existing fixtures and the disposable-database approach in `scripts/bench-memory.mjs`; never point replay/import fixtures at the active campaign database.
- [x] Before database migrations or campaign repair, take and verify a database backup through the existing database tooling. Until milestone 1 passes, the affected browser export is not the backup mechanism.
- [x] Keep current provider settings and prompt budgets as the baseline. Paid model comparisons are a separate, explicit evaluation mode. Do not solve missing context by increasing all limits.
- [x] Ship small, independently reviewable changes. No broad staging or reverting of the current dirty tree. Update completion evidence here when implementation actually passes its gates.

**1. Reliable campaign persistence**

Changes:

- [x] Align `storySync` with the current export contract in the existing browser-safe `contracts/worldDatabase.ts`; re-export its version from the server schema module rather than importing server database code into Svelte. Accept explicitly supported legacy formats through their existing compatibility path, validate current version-3 bundles, and reject unknown/malformed formats with a useful error. Preserve canonical payload fields during validation and display download failures in Library.
- [x] Run every read composing a story export through the same transaction with `isolationLevel: 'repeatable read'` and `accessMode: 'read only'`, supported by the installed Drizzle driver. Helpers must receive that transaction rather than silently call the global database connection. Preserve the existing bundle shape and compatibility fields.
- [x] Check the full legacy transcript count against `importEntryLimit` before creating the story, related records, or jobs. Replace silent slicing with a clear count/limit error. Keep the complete world-database importer as the separate supported path; large legacy batching is outside this fix.

Gates:

- Export a seeded backend story through the real export service and import its result into an isolated database. Compare canon, transcript ordering, references, and relationships. Test both preserved IDs in a separate target and remapped IDs when importing a separate copy; compare remapped relationships using the returned mapping.
- Interleave a writer between export reads and verify that the bundle describes one committed database snapshot, without dangling references or mixed story versions.
- Test legacy entries at the limit and at limit plus one. The rejected case leaves no imported story, entries, or queued jobs; the client displays failure rather than a synced success.
- Verify Library export/download/import in the browser using the fixture story. Cover current, supported legacy, malformed, and unsupported-version bundles.

Primary paths: [storySync](/E:/DEV/Projects/mtherios-master/src/lib/services/storySync.ts), [canonical import/export](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/canonical.ts), [world database importer](/E:/DEV/Projects/mtherios-master/src/lib/server/db/worldDatabaseImport.ts). Extend their existing tests. No new database schema is expected for these fixes.

Limit of this slice: the oversized-count guard guarantees zero writes for that rejection. It does not make later legacy-import failures atomic. A complete legacy rollback improvement would require passing one transaction through its identity/memory/version helpers and queuing projections after commit; track that separately from this immediate truncation fix and the existing full-database importer.

**2. Make one replay execute the real turn pipeline**

- [x] Wire `scripts/eval-turns.mjs` to the existing parser and scorer in `replayRunner.ts`. Remove the duplicate validation-only path.
- [x] Resolve `storyFixture` into isolated seeded state, supply deterministic responses at the existing provider boundary, execute the real preparation, validation, and commit paths, and collect actual context and persisted state. Mock provider output and external projections, not the orchestrator or patch validator. Derive included facts from the final provider-bound request and compare actual canonical writes, rather than trusting fixture-supplied result IDs or a returned patch alone. Deterministic responses prove pipeline behavior; model obedience requires separate model evaluation.
- [x] Drain only fixture-owned dependent jobs when a scenario needs deferred extraction or rollup. Give every run stable fixture IDs, a bounded execution limit, and cleanup on failure.
- [x] Distinguish facts available to the narrator from knowledge an NPC can act on and secrets revealed in player-visible output. The current scorer merges included and revealed IDs; adjust its assertions so narrator-private context is not automatically scored as an NPC leak.
- [x] Write a machine-readable result with source/fixture hashes and metrics, and exit nonzero on any required assertion failure. Unknown cost remains unknown; deterministic runs and live-provider comparisons must be labelled separately.

First gate: the letter-delivery scenario must execute, verify the actual resulting state, and fail when its expected transfer is absent. A deliberate forbidden disclosure must fail too. Add the remaining scenarios as milestones 3–7 land; finishing a general evaluation platform is not a dependency for fixing exports.

Primary paths: [CLI](/E:/DEV/Projects/mtherios-master/scripts/eval-turns.mjs), [existing replay scorer](/E:/DEV/Projects/mtherios-master/src/lib/server/evals/replayRunner.ts), [current scenario](/E:/DEV/Projects/mtherios-master/evals/scenarios/state-extraction.jsonl).

**3. Preserve character continuity through scenes and arcs**

- [x] Render the actual learned/disclosed statement before incidental conversation topic text. Read old belief records compatibly; preserve source links, confidence, and who knows the fact. Keep the current belief budget.
- [x] Select unresolved agreements by current participants, action relevance, due state, and recency with deterministic tie-breaking. Apply the limit after relevance selection. Replace the arbitrary first-80 load with a bounded relevant database query and fallback, so an old relevant promise can compete.
- [x] Carry one relevant relationship-history reason into the existing bounded character recall. Preserve direction and participants: who trusts whom, why, and from which source. Current canonical relationship state wins over older evidence.
- [x] Carry chapter `relationshipChanges` and `npcKnowledgeChanges` into existing arc character-development metadata. Preserve actor/source identity, superseding corrections, and knowledge boundaries. Update `renderArcMemory` too: it currently reads summary/open threads without rendering `metadata.characterArcs`, so storage-only repair will not fix recall. Existing JSON metadata and source fields should suffice without a database migration.
- [x] Preview affected derived summaries on a restored copy before regeneration. Completed preview found no eligible structured source chapters and no required historical arc rebuild; no live rollup or character-sheet rewrite was applied.

Gates: a long conversation still includes what the NPC learned; a relevant ninth promise outranks unrelated obligations; earned trust keeps its reason; a source-backed knowledge/relationship change survives chapter suppression after arc creation. Add return-after-several-scenes and corrected-false-report replays. Unknown or narrator-only information must not become knowledge shared by all NPCs. Run the existing prompt-budget harness unchanged.

Primary paths: [turn context](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/context.ts), [prompt packet](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/promptPacket.ts), [patch validator](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/patchValidator.ts), [rollup jobs](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/processor.ts).

**4. Retrieve older evidence and keep the relevant passage**

- [x] Add a story-scoped indexed full-history transcript search alongside the small recent-dialogue window. Reuse existing usability/visibility rules for entries and paired control responses. Retrieve bounded candidates and relevant neighboring text; never load an entire campaign into the prompt.
- [x] Prefer PostgreSQL full-text search with a matching GIN index on the existing transcript content. Check the actual query plan and names/aliases/short-token behavior. Use the next available additive migration rather than editing applied migrations. The current migration runner wraps SQL in a transaction, so index creation must respect that behavior; measure lock/build time on a restored dataset before scheduling the live migration.
- [x] Select query-relevant passages before applying the memory body cutoff. Inspect original content even when a short summary exists: the current `memoryBody` preference for summary can lose the answer before truncation. Preserve original source IDs and surrounding meaning, use whole-word boundaries, and keep the overall memory token cap. Fallback to the existing deterministic excerpt when there is no useful match.
- [x] Evaluate calibrated vector similarity against hybrid ranking using the same fixtures and saved semantic evidence. Stop converting meaningful distance gaps into nearly identical rank bonuses. Keep recency and importance from overwhelming a strong content match, and apply visibility filters before any result can enter context.

Gates: both old-transcript cases and the answer-at-tail case pass in local-hash and embeddings-disabled modes. Add independent long-history, alias, correction, secret, and distractor cases rather than tuning to the benchmark's exact sentences. The unchanged benchmark starts at 23/27 answers retained; recovering these three structural misses should reach at least 26/27 in those modes. Evaluate the tunnel paraphrase separately: hash embeddings cannot be assumed to understand synonyms. A semantic ranking regression must retain the known strong match, and an optional real semantic run should target 27/27 on this fixture without presenting that as universal recall accuracy.

Report answer retention in the final request, forbidden-result violations, token usage, and repeated latency measurements. Test the search plan at campaign scale with embeddings unavailable. Preserve deterministic fallback and avoid provider switches as part of this milestone.

Primary paths: [retrieval](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/retrieval.ts), [ranking/excerpts](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/ranking.ts), [canonical search rules](/E:/DEV/Projects/mtherios-master/src/lib/server/engine/canonicalSearch.ts), [benchmark](/E:/DEV/Projects/mtherios-master/evals/memory/README.md).

**5. Supply the Director with faithful faction state**

- [x] Preserve linked canonical state; overlay current normalized membership, resource, goal, and relationship records where those are authoritative. Apply defaults only for missing values. Pressure must not silently become disposition, and zero must remain a valid explicit value.
- [x] Fetch linked faction entities explicitly instead of relying on the mixed-entity alphabetical page. Rank dossiers using scene participants/location, active projects, relevant recent moves, and current-frame references before the cap.
- [x] Keep the eligible faction set separate from the smaller dossier set so relevant recent actions survive even when the faction has no full dossier. Preserve retired/noncanonical exclusions and source IDs.
- [x] Filter current goals by supported active statuses before capping them; legacy state must not resurrect completed or cancelled normalized goals.
- [x] Allocate space to current actions, agreements, and consequences before bulk historical dossiers, while preserving final output instructions and existing total budgets.

Gates: an established peaceful ally remains allied and peaceful; updated resources/memberships and inter-faction relationships reach the formatted input; a scene-relevant faction beyond the old caps retains lore and its recent action; completed goals stay completed. Include tight-budget tests for treaties and resolved moves. Pending-frame identity, explicit quiet frames, freshness, retirement, and player-agency tests remain passing. Inspect a built Director input before requesting a new frame; do not rewrite an applied frame simply because input formatting changed.

Primary paths: [Director loader/mapper](/E:/DEV/Projects/mtherios-master/src/lib/server/engine/serviceCommands.ts), [Director formatter](/E:/DEV/Projects/mtherios-master/src/lib/services/ai/context/strategicWorldBrainInput.ts), their existing command/formatter tests, and the Plot Brain lifecycle tests.

**6. Show actual context and make failed jobs recoverable**

Context receipts:

- [x] Extend existing prompt-section metadata with the actual selected record IDs. Current sections can list loaded records and synthetic recent-message IDs, so merely moving the existing trace call is insufficient.
- [x] Reconcile record metadata after the final context-budget pass and mode-specific prompt changes. Track fully retained, partially retained, and omitted records using render metadata/retained ranges rather than guessing IDs from prose. Count a partially retained record honestly; do not claim its full fact survived.
- [x] Extend the existing receipt contract with backward-compatible defaults and reuse it in Technical and Settings. Distinguish loaded/selected/sent counts; show omission reasons and token estimates from the actual request. Keep tokenizer estimates separate from provider-reported usage and last-turn usage separate from a new-turn preview.
- [x] Verify normal, tight-budget, OOC, and streaming paths, including reload and older saved receipts. A dropped faction or transcript row must not appear under sent records.

Failed-job recovery:

- [x] Add a validated, story-scoped `jobs.retry` command with `jobId` and `expectedUpdatedAt` to the existing engine/jobs path. Use an atomic failed-to-retry compare-and-set against the observed row version and refresh the UI after the transition. The generic `clientCommandId` is correlation, not persisted replay protection. Preserve original payload, failure history, and partial-progress metadata, especially `deferredExtractionApplyReceipt`; do not reuse an enqueue helper that resets these fields. Replenish the attempt budget explicitly and retain failure classification for the UI.
- [x] Establish which existing job handlers are idempotent before making them retryable. Preserve their original event/patch keys; reject running, completed, wrong-story, and stale requests. Repeated clicks or competing retries must enqueue at most one execution.
- [x] Add a failure-status filter to existing job listing so old failures are not hidden behind the newest page. Expose type, attempts, cause, and Retry in the existing World Explorer Jobs view; disable submission while pending and scope asynchronous results to the captured story/job. Test one retry before considering any bulk recovery. Do not automatically replay the five historical failures during deployment.

Gates: recorded context matches the final outgoing messages, including omissions; retrying a partially completed idempotent fixture job produces the missing result without duplicate canon, events, or projections. Invalid jobs retain a clear failure outcome.

Primary paths: [receipt assembly](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/orchestrator.ts), [receipt contract](/E:/DEV/Projects/mtherios-master/src/lib/contracts/memory.ts), [Settings context view](/E:/DEV/Projects/mtherios-master/src/lib/components/story/ContextWindow.svelte), [World Drawer](/E:/DEV/Projects/mtherios-master/src/lib/components/story/WorldDrawer.svelte), [outbox](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/outbox.ts), [job processor](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/processor.ts).

**7. Create and enrich recurring NPCs from reviewed evidence**

- [x] Start from existing chapter character-reference candidates and the NPC Candidates review surface. When a pending candidate reappears, accumulate deduplicated source references and supporting passages instead of discarding the recurrence. Keep exact canonical IDs and ambiguous identities distinct. Preserve rejected candidates until the user explicitly reconsiders them; new evidence must not silently undo a rejection.
- [x] Add user-triggered source-only recovery within the existing character-drafting service, accepting a candidate proposal ID without first creating a placeholder entity. Reuse the NPC Candidates Sources disclosure and preview, extending its current `gm_character_draft` predicate for this operation. The current creative creation operation can invent a requested character; historical recovery must instead leave unsupported details unknown and retain source entry IDs/quotes for each proposed addition. Do not activate the intentionally disabled turn-level proposal queue as a shortcut.
- [x] Let the user inspect the current sheet, proposed fields, and evidence, then choose Create new or Update the exact existing character. Use the current validated write path. Replace the review handler's first-240-character identity lookup with complete targeted ID/name/alias resolution. Check for canonical edits made after drafting before applying changes. Preserve cleared fields, current state, biography history, and faction links; do not automatically merge lookalike names.
- [x] First run the whole flow on a restored fixture campaign. Then produce a bounded candidate list for the chosen live campaign through the existing review controls. Recurring NPC coverage is complete for the reviewed set when each accepted actor has a durable, source-backed record and appears in the appropriate scene context.

Gates: recurrence enriches one pending candidate without duplicate references; an alias resolves to the intended record or remains explicitly ambiguous; an unsupported appearance remains unknown; accepted fields survive reload, export/import, and next-turn context. Recheck the existing New → Preview → Create flow, double submission, stale drafts, failed saves, and successful persisted selection. A preview alone is never counted as a created character.

Primary paths: [chapter candidate jobs](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/processor.ts), [character drafts](/E:/DEV/Projects/mtherios-master/src/lib/server/engine/characterDrafts.ts), [World Explorer](/E:/DEV/Projects/mtherios-master/src/lib/components/database/WorldExplorer.svelte), [canonical writes](/E:/DEV/Projects/mtherios-master/src/lib/services/canonicalWrites.ts).

**Parallel work and integration order**

Milestone 1 and the small replay foundation can start together. Scene continuity and Director mapping can then run independently. Retrieval can proceed alongside them with a separate owner for database/index work. Context receipts should integrate after the affected selectors and budgets stabilize; their contract can be designed earlier for the replay results. NPC recovery depends on reliable persistence and the improved evidence selection. Failed-job retry can be implemented independently, but campaign recovery should wait for its idempotency gates.

Coordinate ownership of `promptPacket.ts`, `orchestrator.ts`, and `processor.ts`; these are shared integration points. Combine changes sequentially there rather than letting multiple agents edit the same functions. No database migration is expected outside the transcript index or a narrowly justified additive contract/storage change discovered during implementation.

**Release checks and completion**

Run focused existing tests for each changed service plus the new behavioral regressions. Use `npm run bench:memory -- 5` after retrieval changes and `npm run eval:turns` once it executes real scenarios. At integration, run `npm test`, `npm run check`, and `npm run build` once, then repeat only checks affected by subsequent changes. Verify browser workflows and inspect the actual narrator/Director request packets on fixture campaigns.

Run migrations first on an isolated restored database. Preserve original imports and compare a remapped copy. For any later live rollout, verify runtime health, queue progress, story versions, and projection freshness after the changed paths have executed. Roll back application changes independently if needed; the additive transcript index can remain. Restore canonical data only from a verified backup or an explicit, source-reviewed repair.

Close each milestone with its changed files, measured before/after result, and any unresolved limitation. The final acceptance set is: intact campaign round trips; promises and learned facts preserved across scenes/arcs; older evidence retrieved within existing budgets; faction canon preserved; real replay failures detectable; honest context diagnostics; recoverable jobs; and character creation proven by persisted records and subsequent use.
