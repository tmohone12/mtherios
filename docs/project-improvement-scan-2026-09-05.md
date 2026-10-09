**Mtherios improvement scan — September 5, 2026**

Read-only review of the current working tree, live runtime, browser controls, and existing benchmarks. No application source, provider settings, or story canon changed. The memory benchmark created and removed its own disposable database and wrote a new result file. Findings below are recommendations, not completed fixes.

The app and Qdrant are available. The queue has no ready, running, retrying, or delayed jobs; five historical extraction jobs remain failed. Volantis has stale vault/Qdrant projections, while several seed/older stories have missing projections. These are separate from current narration availability.

The refreshed 32-case memory benchmark retained **23 of 27 expected answers (85.2%)**, both with local-hash embeddings and with embeddings disabled. It reported zero forbidden-result or budget violations. This measures retrieval and packet rendering on synthetic fixtures, not narrator accuracy. [Current benchmark result](/E:/DEV/Projects/mtherios-master/evals/memory/results/2026-09-05T23-05-32-426Z.json).

1. **P1 — Repair backend story export and make backups consistent.**

   The frontend accepts only export version 1, while the backend emits version 3. The existing test fixture still returns version 1. A read-only reproduction of the validation function rejects the current backend format. Separately, export reads the story and 23 related tables without a shared snapshot, so concurrent writes can produce an inconsistent bundle; that concurrency consequence is inferred from the read pattern.

   Use the current shared export contract and one read-only repeatable-read transaction. Acceptance: export a backend-bound fixture, import the resulting bundle, compare canonical counts/IDs/relationships, and verify consistency during an interleaved write. [Frontend validation](/E:/DEV/Projects/mtherios-master/src/lib/services/storySync.ts:210), [backend export](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/canonical.ts:2667), [schema version](/E:/DEV/Projects/mtherios-master/src/lib/server/db/worldDatabaseSchema.ts:1).

2. **P1 — Reject oversized legacy imports before any writes.**

   The legacy import path silently slices transcript entries to a configured limit, defaulting to 20,000. This is specific to legacy imports; it is not a claim about the full world-database importer. A large campaign can appear imported while its transcript tail is absent.

   Validate the complete count before inserting the story or entries, and return a clear error containing the actual count and limit. Add batching only when complete large imports are needed. Acceptance: a limit-plus-one fixture produces no partial imported story. [Silent slice](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/canonical.ts:2524), [default limit](/E:/DEV/Projects/mtherios-master/src/lib/server/env.ts:39).

3. **P1 — Make older evidence reachable and preserve the answer in the final packet.**

   The current benchmark reproduced four misses: two facts outside the latest 200 transcript entries, one paraphrased tunnel query, and a vault combination that was retrieved but clipped from its document. Durable extracted memory can preserve older facts, but transcript-only evidence beyond this window remains unreachable through this path.

   Add indexed, bounded full-history evidence search; select query-relevant passages before shortening a memory. Preserve semantic strength or evaluate hybrid ranking before changing embedding providers. The September 4 semantic experiment found the right vector neighbor but still lost it in final ranking; that experiment was not rerun with paid embeddings today. Acceptance: retain all four missing answers on the unchanged fixture without weakening visibility or token limits. [Transcript boundary](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/retrieval.ts:407), [vector score conversion](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/retrieval.ts:471), [packet body limit](/E:/DEV/Projects/mtherios-master/src/lib/server/memory/ranking.ts:9), [benchmark methodology and semantic experiment](/E:/DEV/Projects/mtherios-master/evals/memory/README.md).

4. **P1 — Finish the handoff of knowledge, promises, and relationship reasons.**

   Three remaining omissions were reproduced with isolated renderer probes. A conversation belief appends what the NPC learned after a potentially long prefix, then rendering clips the entire belief to 160 characters. Agreements are an unordered first 80 at loading and first eight at rendering, so a present NPC's ninth oath disappears. Relationship reasons are stored with sources but render only as status and level.

   Prioritize the learned statement inside each belief, rank unresolved agreements by participants/action/timing, and retain one relevant relationship-history reason in the existing bounded character recall. Acceptance: a long conversation preserves its learned secret, an old relevant oath outranks unrelated recent obligations, and earned trust retains its reason. [Belief assembly](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/patchValidator.ts:1459), [belief and obligation rendering](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/promptPacket.ts:1364), [relationship rendering](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/promptPacket.ts:373).

5. **P1 — Preserve actual faction state through the Plot Director.**

   The Director mapper replaces linked faction state with standing 0, status unknown, and pressure-derived disposition. It omits inter-faction relationships and normalized membership/resource updates even though its formatter consumes those fields. Its mixed-entity limit of 120 can exclude linked faction lore; selecting 40 factions also removes other factions' recent actions. Completed goals can be presented as current objectives. Under a tight prompt budget, late sections containing recent actions and agreements can disappear first.

   Preserve canonical state, overlay normalized data, explicitly load linked faction entities, and rank relevant factions before capping their dossiers. Separate event eligibility from dossier selection. Filter current goals by status and place current consequences ahead of bulk historical dossiers. Acceptance: a peaceful ally with an explicit treaty stays peaceful and allied in the Director input; a relevant faction beyond the old cap retains its recent move; completed goals stay completed. The background simulator already loads normalized faction data, and current pending/quiet-frame guards remain intact. [Director mapper](/E:/DEV/Projects/mtherios-master/src/lib/server/engine/serviceCommands.ts:247), [loader](/E:/DEV/Projects/mtherios-master/src/lib/server/engine/serviceCommands.ts:608), [consumer and truncation](/E:/DEV/Projects/mtherios-master/src/lib/services/ai/context/strategicWorldBrainInput.ts:121).

6. **P2 — Preserve structured character changes when chapters become arcs.**

   Arc aggregation does not explicitly carry chapter relationship changes and NPC knowledge changes into its output. Once older chapters covered by an arc leave the narrator prompt, those details survive only if duplicated in summary prose or another memory record.

   Incorporate the existing structured fields into bounded arc character-development memory with source links. Acceptance: a chapter whose only record of a learned fact or relationship change is its structured field retains that fact after arc compression. [Arc aggregation](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/processor.ts:3759), [covered chapter selection](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/promptPacket.ts:1009).

7. **P2 — Make context diagnostics describe what was actually sent.**

   The context receipt counts loaded transcript rows and takes up to 20 loaded faction IDs, rather than deriving those fields from the final rendered prompt. The browser currently shows 192 recent entries and 20 faction sheets in that receipt; these labels are not proof that all those records reached the model. Settings also retains a separate context estimate built from browser-side prompt paths.

   Generate one receipt from final compiled sections, distinguishing loaded, selected, rendered, and omitted records, with reasons and token costs. Reuse it in the existing Technical and Settings surfaces. Acceptance: a deliberately omitted faction never appears under sent faction sheets, and browser totals match the actual request. [Receipt assembly](/E:/DEV/Projects/mtherios-master/src/lib/server/turn/orchestrator.ts:2636), [Settings estimate](/E:/DEV/Projects/mtherios-master/src/lib/components/story/ContextWindow.svelte:45).

8. **P2 — Turn replay fixtures into executable behavioral tests.**

   Running `npm run eval:turns` validates one scenario file. The script only checks three required string fields; it does not execute the turn or check expected state, forbidden knowledge, or cost. The retrieval benchmark is useful but explicitly does not measure narration, extraction, or canon-update quality.

   Extend this runner to execute isolated fixtures through the real pipeline, with deterministic provider responses by default and opt-in model comparisons. Start with returning NPCs, fulfilled promises, false reports corrected later, faction allies, and export/import round trips. Acceptance: deliberately removing a required fact or leaking a forbidden secret makes the relevant replay fail. [Replay runner](/E:/DEV/Projects/mtherios-master/scripts/eval-turns.mjs:15), [current scenario](/E:/DEV/Projects/mtherios-master/evals/scenarios/state-extraction.jsonl:1).

9. **P2 — Add a visible recovery path for exhausted jobs.**

   Exhausted jobs become failed, and both automatic and manual claiming exclude that status. The runtime currently has five such historical extraction failures. Correcting the original provider problem does not itself make these jobs eligible again.

   Add a guarded retry command and UI action that preserve payload/error history and refuse running jobs. Acceptance: an exhausted idempotent job can be retried after its cause is fixed, without duplicating canonical writes. [Failure transition](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/outbox.ts:480), [manual claiming](/E:/DEV/Projects/mtherios-master/src/lib/server/jobs/processor.ts:4883).

10. **Product/data priority — Build out recurring NPC records with source review.**

    Veil currently has five canonical character records, confirmed by the live API and browser. A stronger character-creation workflow helps future records, but existing recurring participants still need their identities, motivations, relationships, knowledge boundaries, and faction ties captured from evidence. This is a coverage improvement, not permission to invent missing details or merge ambiguous characters automatically.

    Use the existing candidate/review and character-drafting paths to identify recurring participants, show supporting passages, and create or enrich the exact selected record. Acceptance: each important recurring actor has a source-backed sheet and appears in the appropriate scene context without leaking private knowledge.

Recommended sequence: fix export/import correctness; implement current-actor memory selection and full-history retrieval; repair Director faction input; then use executable replays and accurate receipts to measure the remaining work. Existing services and schemas cover these changes; no new autonomous agent subsystem is required.
