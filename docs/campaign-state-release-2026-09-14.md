# Campaign continuity brief — 2026-09-14

Implemented in the existing PostgreSQL story metadata and state-extraction path; no database migration, new model service, or historical turn replay.

- `stories.metadata.campaignState`: keyed current facts, milestones and open commitments with narration quote, entry ID and position. Same-topic updates require the expected previous entry ID and a newer source position. Canonical primary POV only; noncanon/OOC/parallel sources cannot update this shared brief.
- Sync extraction, deferred extraction and compact recovery receive existing topics. Campaign-only updates count as operations. Existing state patches retain the update history. The 32-topic ceiling rejects new topics with warnings rather than silently removing old milestones; manual consolidation is required at capacity.
- GM preparation includes the brief before history. Normal narration refuses a budget that would drop a required fact. Context selection receipts track individual topic retention and prompt traces include their actual source entries.
- Retrieval selection remains relevance-ranked; dated selected records render in story order. Undated records retain relevance order. This is not a comprehensive retrieval rewrite or index rebuild.
- Both world surfaces use `CampaignFacts.svelte`; the active path is **Player & world → Now**. The browser cache follows canonical story projection updates.

## Veil backfill

`scripts/seed-veil-campaign-state.mjs` defaults to dry run, checks persisted source scope and quotes, refuses to overwrite an existing brief, and writes through the canonical record API. Applied five anchors at story version 6213: Aurion/Aegon's public identity, rule of Volantis, annulled Yin betrothal (not a marriage), Mei-Lin's marriage to Shen Wei, and the Qarth dragonfire attack. This is a bounded backfill, not a complete reconstruction of the campaign.

## Verification

- 282 focused tests passed across 10 files, including merge chronology/replay/unsupported evidence, primary versus parallel scope, campaign-only extraction, recovery prompts, retrieval ordering, prompt retention and world-surface wiring.
- `npm run check`: zero errors and warnings. Production build passed; existing chunk/dynamic-import warnings remain. Scoped `git diff --check` passed.
- Final runtime: PID 16316, `node server.js`, `http://127.0.0.1:5173`, database health OK, no startup stderr.
- Actual `turn.preview`: `campaignState` loaded 5 / selected 5 / sent 5 / partial 0 / omitted 0. Inspection only, not a provider-sent request or new story turn.
- Browser confirmed all five bullets in the active world sheet and expanded Qarth's source quotation; layout inspected.
- Three pre-existing `promptHarness.test.ts` chapter/arc budgeting failures remain: retaining nine full uncovered chapters, omitting an oversized whole arc, and budgeting arc history while retaining recent covered detail. They were reproduced, not repaired in this change. Existing historical extraction/index backlog was not rebuilt.

Automatic extraction remains model-dependent and asynchronous in deferred mode. Tests verify validation/application; no paid classifier test or fictional campaign turn was submitted to demonstrate generation.
