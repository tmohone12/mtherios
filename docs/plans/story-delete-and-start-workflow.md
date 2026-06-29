# Safe Story Delete and Story Start Workflow Plan

> **For Hermes:** Use test-driven-development for implementation slices. Keep changes tightly scoped and do not touch unrelated dirty files.

**Goal:** Make story deletion safer and more explicit, and begin replacing the vague blank/lorebook start path with a structured Story Seed workflow.

**Architecture:** Postgres remains canonical. Browser IndexedDB is cache/control-surface state. Delete commands must report whether canon, artifacts, and local cache were handled. Story creation should carry structured start-workflow metadata so later seed/canonization steps know whether the story began blank, from lorebook/source notes, character card, import, or transcript.

**Tech Stack:** SvelteKit/Svelte 5, TypeScript, Zod, Drizzle/Postgres, Dexie/IndexedDB, Vitest.

---

## Slice 1: Safe delete command contract

**Objective:** Teach `story.delete` to accept explicit options and return a detailed report without changing canon authority.

**Files:**
- Modify: `src/lib/contracts/memory.ts`
- Modify: `src/lib/server/engine/command.ts`
- Modify: `src/lib/server/memory/canonical.ts`
- Test: `src/lib/server/engine/command.test.ts`

**Behavior:**
- `story.delete` accepts `{ mode?: 'archive' | 'purge', exportBeforeDelete?: boolean }`.
- Default remains purge/hard-delete for backward compatibility.
- Projection changes include `mode`, `canonDeleted`, `artifactCleanup`, and warning count.
- Handler receives parsed delete options so lower layers can evolve from hard-delete to archive.

## Slice 2: Safer control-surface delete client

**Objective:** Ensure browser-side deletion is explicit and local cleanup only follows successful backend delete.

**Files:**
- Modify: `src/lib/services/serverStories.ts`
- Test: `src/lib/services/serverStories.test.ts`

**Behavior:**
- `deleteStoryEverywhere(story, options)` sends explicit delete args.
- Supports `mode` and `exportBeforeDelete` option shape.
- Does not delete local cache if backend delete fails.
- Returns the backend delete report for UI/reporting.

## Slice 3: Story start workflow metadata

**Objective:** Add a small, durable Story Seed marker to story creation without building the full UI yet.

**Files:**
- Modify: `src/lib/contracts/memory.ts`
- Modify: `src/lib/server/memory/canonical.ts`
- Modify: `src/lib/services/serverStories.ts`
- Test: `src/lib/server/engine/command.test.ts`
- Test: `src/lib/services/serverStories.test.ts`

**Behavior:**
- Story creation accepts `startWorkflow` metadata.
- Supported source modes: `blank`, `lorebook`, `character_card`, `import`, `transcript`, `source_notes`.
- Backend story metadata preserves the starting workflow marker.
- Canon is not created from lorebook text automatically; this only records starting intent/source shape.

## Slice 4: Future workflow after this patch

**Objective:** Plan the next deeper story-start implementation.

**Next work:**
- Add a `StorySeed` review screen.
- Convert source files into evidence entries/source refs.
- Generate AI patch proposals for entities/factions/facts instead of direct canon writes.
- Add first-scene readiness checklist.
- Sync wiki/search projections after approved seed import.
