# Backend Projection Maturity Plan

## Goal

Make the program more reliable by fixing backend contract bugs first, then make the frontend a more mature projection of backend truth. The browser should inspect, command, explain, and repair backend state; it should not invent a parallel model of the world.

## Scope Discipline

This plan deliberately starts small. The first coding slice should repair import/seed/shelf logic that can lose trust in the backend contract. Frontend polish comes after that, and only where it reveals real backend status or removes friction from existing flows.

Avoid building a full dashboard, canon cockpit, or shelf-level canon system in this pass. Those may be good later, but they are too broad for the first reliable slice.

## Backend Contract Bugs

### 1. Resolve world-seed relationship endpoints

Files:

- `src/lib/contracts/worldSeed.ts`
- `src/lib/contracts/worldSeed.test.ts`

Tests first:

- Add a failing test where seed entities use stable names and relationships reference those names.
- Add a failing test where relationship endpoints already use entity IDs.
- Add a failing test for an unknown relationship endpoint with a clear error.

Implementation:

- Build an entity lookup map while compiling seed entities.
- Resolve each `relationship.source` and `relationship.target` through the map before writing `sourceEntityId` and `targetEntityId`.
- Preserve explicit IDs when they already match known entity IDs.
- Throw a useful compile error before a database FK failure can happen.

Critique:

- This is a real bug, not UI taste. It should be first.
- Do not add fuzzy matching or aliases yet. Exact names and IDs are enough.

### 2. Make seed import rules honest

Files:

- `src/lib/contracts/worldSeed.ts`
- `src/lib/contracts/worldSeed.test.ts`
- `src/lib/server/engine/command.ts`
- `src/lib/components/library/LibraryPanel.svelte`

Tests first:

- Confirm preview can still parse source/shelf material.
- Confirm import rejects a seed without a first story using the same wording the UI teaches.
- Confirm import accepts a seed with `story.title`.

Implementation:

- Keep the backend rule: database seed import requires a first story unless we intentionally add shelf-only canon storage.
- Update UI copy so it says the user should create/import into a story's backend canon, not into an independent shelf database.
- Keep source-only preview useful, but make it clear that preview is not the same as import.

Critique:

- The tempting idea is to support true shelf-only canon immediately. That is likely schema and workflow work, not a bug fix.
- The mature move is contract honesty first: backend story canon remains the source of truth, and frontend wording stops promising a thing the backend does not store.

### 3. Fix shelf slug conflict during world database import

Files:

- `src/lib/server/db/worldDatabaseImport.ts`
- Add or extend the closest DB import test that already has a database harness.

Tests first:

- Import a world database whose shelf slug already exists but shelf ID differs.
- Verify the imported story points to the existing shelf row.
- Verify no dangling `story.shelfId` FK is created.

Implementation:

- Resolve the target shelf before inserting the story:
  - Prefer exact shelf ID if present and found.
  - Otherwise look up by slug.
  - Otherwise insert the shelf.
- Set `storyRow.shelfId` to the resolved shelf ID.
- Avoid `onConflictDoNothing()` when it leaves the story pointing at a non-existent shelf ID.

Critique:

- This is backend integrity work and belongs in the first slice.
- Keep it narrow. Do not redesign shelves or add merge UI here.

### 4. Preserve shelf metadata on partial updates

Files:

- `src/lib/server/memory/canonical.ts`
- Add or extend the closest canonical/shelf test.

Tests first:

- Create a shelf with metadata and tags.
- Patch only the name.
- Confirm metadata and tags are preserved.
- Patch metadata explicitly and confirm it changes only when requested.

Implementation:

- Treat omitted `metadata` as "leave existing metadata alone."
- Treat omitted `tags` as "leave existing tags alone."
- Only write replacement metadata/tags when those fields are present in the request.

Critique:

- This is a small correctness fix.
- Do not add a generic patch framework. The current function can handle this directly.

## Frontend Projection Improvements

### 5. Add a compact backend health projection

Files:

- Reuse the existing app-status API route if available.
- Start in `src/lib/components/library/LibraryPanel.svelte` or an existing shell/status component.

Tests first:

- Add a small formatter test if there is already a nearby frontend helper pattern.
- Otherwise verify with browser behavior after implementation.

Implementation:

- Show a compact status line for backend truth that matters to the current surface:
  - data path
  - Qdrant/Ollama status
  - wiki stale/missing state
  - failed job count when non-zero
- Provide a direct repair command only if an existing backend route already exists.
- Keep it compact. This is a projection of runtime truth, not a new dashboard.

Critique:

- A full "operations center" is attractive but premature.
- The frontend should expose the minimum backend truth needed to explain why canon/search/story behavior may be off.

### 6. Clean up accessibility warnings and icon-only controls

Files:

- `src/lib/components/wizard/OnboardingWizard.svelte`
- `src/lib/components/settings/SettingsModal.svelte` or the actual settings component path
- The story/topbar component that renders icon-only controls without accessible names

Tests first:

- Use `npm run check` as the warning gate.
- Use browser inspection for at least one main story screen and onboarding screen.

Implementation:

- Add `for`/`id` pairs to labels.
- Give step buttons and icon-only buttons stable accessible names via `aria-label` or existing tooltip/title patterns.
- Fix non-reactive state warnings without changing behavior.

Critique:

- This is polish, but it is not cosmetic. Mature frontend means the projection is legible to users and tools.
- Keep it warning-driven. Do not restyle the app in the same pass.

## Recommended Coding Order

1. Relationship endpoint resolver and tests.
2. Seed import honesty and UI copy.
3. Shelf slug conflict fix.
4. Metadata patch preservation.
5. Compact backend health projection.
6. Accessibility warning cleanup.

If time gets tight, stop after item 4. That leaves the backend more trustworthy without half-building a new interface.

## Verification

Run these before calling the work done:

- `npm test -- src/lib/contracts/worldSeed.test.ts`
- The closest targeted DB/canonical tests for shelf import and metadata patch behavior.
- `npm run check`
- `npm test`
- Direct seed import probes through `/api/engine/command`:
  - name-based relationships import successfully
  - missing-story seed fails with the intended message
  - failed relationship imports roll back cleanly
- Browser smoke test:
  - story view has no console errors
  - onboarding flow renders without accessibility warnings in `npm run check`
  - backend health projection reflects `npm run app:status`

## Self-Critique

The broad brainstorm had too much surface area. "Make the frontend mature" can easily turn into a big dashboard, a design refresh, and a new canon model all at once. That would be the wrong first move.

The most valuable first pass is not a visual overhaul. It is making backend contracts harder to misunderstand, then projecting those contracts in the UI with clearer labels, status, and repair affordances.

The riskiest idea is true shelf-level canon. It sounds aligned with "shelves as world databases," but the current backend appears story-owned. Adding real shelf canon should be a separate design decision with schema, import/export, and UI implications.

The best first coding slice is therefore boring in the good way: fix relationship IDs, fix shelf import integrity, preserve metadata, make import wording honest, and only then add a small runtime-health projection.
