# Implementation results — September 5, 2026

The seven code milestones in the [implementation plan](project-improvement-implementation-plan-2026-09-05.md) are implemented through the existing canonical database, turn pipeline, retrieval, Director, jobs and review surfaces. No new dependency or provider setting was added. The existing dirty tree and recent UI work were preserved; no commit or publish was performed.

## Changes and evidence

| Milestone | Result | Verification |
| --- | --- | --- |
| Campaign persistence | Browser-safe version-3 validation, supported version-1 compatibility, useful rejection errors, one read-only repeatable-read export snapshot, legacy oversize rejection before writes. | Real disposable PostgreSQL preserve/remap round trips, concurrent writer export, and limit-plus-one zero-write rejection. Explicit null event turns survive import. Client tests cover current, legacy, malformed, unsupported and backend-rejected files. |
| Executable replay | The CLI runs the actual turn pipeline, captures provider-bound messages, observes persisted canon and checks idempotent repeats. Private narrator context and output disclosures are scored separately. | Three scenarios pass normally and with a roll continuation: letter transfer, a returning character after 240 intervening scenes, and a corrected false report. Intentional missing-fact, secret-leak and wrong-state mutations fail their required gates. |
| Character continuity | Learned statements precede incidental recap; relevant promises are selected before the bounded database cap; character recall carries relationship reasons; arc metadata and rendering retain structured chapter knowledge and relationship changes with provenance. | Existing prompt budgets remain passing. Database regression retains five old relevant obligations behind 95 newer distractors. A restored-copy review of 428 chapters and 51 arcs found no structured source chapters requiring a historical arc rebuild, so no live summaries or character sheets were rewritten. |
| Older evidence | Full-history PostgreSQL search supplements recent dialogue; source/control filtering happens before the candidate cap. Query-relevant excerpts preserve answers from original content. Vector match strength survives ranking. | Unchanged benchmark improves answer retention from 23/27 to 26/27 in both local-hash and embeddings-disabled modes, with zero forbidden-result or budget violations. Restored-campaign regressions cover stemming, old public evidence behind secret distractors, and paired OOC controls. |
| Faction fidelity | Director input preserves canonical allies, typed relationships, explicit zero resources, normalized members and active goals. Linked factions and relevant moves compete before caps; current consequences and agreements take budget priority. | Command/formatter regressions cover factions beyond old caps, peaceful allies, completed goals, normalized resource updates and tight budgets. Existing quiet/pending-frame/player-agency lifecycle tests pass. The live Director remained quiet/retired; no new frame was requested or applied. |
| Context and recovery | Receipts reconcile loaded, selected, fully sent, partially sent and omitted records after budgeting. Receipts persist with narration, restore on reload and distinguish primary and roll requests. Failed jobs have a filtered recovery view and atomic version-checked retry. | Actual captured replay requests match their receipt summaries. Browser streaming/reload showed the recorded 2.3K-token primary request. A fixture retry preserved payload and failure history and moved the job out of the failed list. Concurrent, stale, wrong-story and unsafe-handler retry tests pass. |
| Recurring NPCs | Candidates accumulate deduplicated evidence. “Find from chapters” scans up to 12 saved chapter digests. “Build from story” drafts quoted supported fields without placeholders; review creates or updates the exact character. Approval locks and revalidates sources, control parents and the current target. | 196 focused tests and five disposable-database gates pass. The browser created Neris with a real source quotation, selected the saved record in a three-character roster, and database inspection confirmed the biography and source ID. Reload, remapped export/import, next-turn context, stale target/source rejection and repeated scanning are covered by real persistence tests. |

## Controls to use

- **World lore → NPC Candidates → Find from chapters** finds names in stored chapter digests. **Build from story** prepares supported additions for inspection; **Create character** or **Update character** saves canon after review. Empty source candidates cannot be approved. Rejected candidates remain rejected.
- **GM tools → Technical → What reached the narrator** shows the last saved request and retained records. The Settings context view uses the same receipt. Older turns without receipts are labelled rather than reconstructed as fact.
- **World lore → Advanced → Jobs** opens the failed-job list. Retry is enabled only for handlers verified safe to resume: extraction, event-memory creation, retrieval projection rebuild and memory embedding. Payloads and partial extraction receipts are retained.
- **Library → Export / Import story** uses the supported bundle validator and canonical persistence paths.

## Measured retrieval result

Five measured repetitions per case, 32 fixed cases including 27 positive recall cases. Report: [final memory benchmark](../evals/memory/results/2026-09-06T01-51-12-327Z.json).

| Metric | Local hash | Embeddings disabled |
| --- | ---: | ---: |
| Answers retained | 26/27 | 26/27 |
| Forbidden results / budget violations | 0 / 0 | 0 / 0 |
| Warm p50 | 44.475 ms | 34.783 ms |
| Warm p95 | 65.721 ms | 46.582 ms |

These synthetic retrieval figures do not measure model obedience or universal campaign recall. The remaining tunnel paraphrase needs semantic understanding. The ranking regression preserves a known strong vector match, but no paid semantic rerun was made and 27/27 is not claimed.

On a verified restored database containing 10,310 transcript entries, 4,482 entities and 8,458 memories, index creation took 2.294 seconds and produced a 4,232 KiB index. Production query plans used the GIN and story/parent indexes. Single-term full-history searches measured approximately 108–343 ms; a long action query took 696 ms. Full retrieval on that restored campaign took 0.87–1.79 seconds. These campaign-scale measurements are distinct from the small synthetic benchmark.

## Release and live rollout

- Full suite: **125 files, 1,208 tests passed**. Later NPC changes were covered by the final **196-test** focused run and five real persistence gates; later replay changes passed normal and roll execution plus scorer tests.
- Final typecheck: **0 errors, 0 warnings**. Production build: **passed**, including adapter-node output. Nonblocking mixed static/dynamic import warnings and client chunks over 500 kB remain.
- Normal replay report: [three scenarios](../evals/replay/results/2026-09-06T01-55-29-674Z.json). Roll replay report: [three roll scenarios](../evals/replay/results/2026-09-06T01-56-25-036Z.json).
- Native PostgreSQL backup was verified and restored before migration. Only the pending additive migration `0017_story_entry_full_text_search.sql` was applied live; previously applied migrations were skipped.
- Final live status at approximately 10:05 PM EDT: app and PostgreSQL responding, Qdrant healthy, queue processing (65 ready, two running). The five historical extraction failures remain untouched. Existing wiki projection freshness gaps and unavailable optional Ollama remain visible. Saved local-hash/provider settings were retained.
- The live Veil scan examined eight stored chapters (five with named tags). Its seven qualifying references concern two existing characters: Aurion Belaerys in chapters 58, 59, 61, 62 and 63, and Mei-Lin in 62 and 63. Shared source evidence resolves them to the existing canonical IDs, so the scan created no duplicate proposals. Bu Gai and Vaeron did not meet the recurrence/substance threshold. Chapters 60, 64 and 65 had no named tags. Existing sheets were not rewritten.

## Validation limits and artifacts

Browser acceptance passed character draft/create/selection, streamed narration, restored receipts, one failed-job retry and the live Find from chapters control. The Library export action was exercised and the real export response was saved, but an automated file-chooser import stalled in the in-app browser. Therefore browser current/legacy/malformed/unsupported import acceptance remains incomplete; the corresponding client and real persistence tests passed.

Historical character coverage still depends on the saved chapter evidence and the user's review decisions. The live legacy tags omit some names present in chapter prose; the bounded finder does not extract new names from unstructured prose. Its empty result is therefore not a claim that every historical NPC already has a sheet. Unsupported appearance or biography details remain unknown. Source quotations prove provenance; reviewers must still check whom the quotation describes. No real model quality comparison was run.

Evidence and the exact pre-implementation source snapshot are in `.cache-backups/improvement-implementation-20260905-210911/`: `starting-status.txt`, `changed-source-files.txt`, `mtherios-before-improvements.dump`, `retrieval-restore-verification.json`, `arc-character-history-preview.json`, `live-prompt-after.json`, `live-npc-candidates.json` and the release logs. These contain campaign data and are local artifacts, not publishing inputs.

Repeatable verification scripts: `scripts/test-campaign-persistence.mjs`, `scripts/test-character-source-persistence.mjs`, `scripts/eval-turns.mjs`, and the disposable browser fixture `scripts/serve-improvement-fixture.mjs`.

The final browser fixture database and temporary directory were removed. All disposable UI databases are stopped. One earlier temporary directory, `C:\Users\Raijin\AppData\Local\Temp\mtherios-ui-fixture-51yvfB`, remains because automatic approval review rejected its cleanup with “blocked by policy.”
