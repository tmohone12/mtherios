# Plan: Single Source of Truth for Entities

## Context

The codebase keeps **two parallel records** for every entity:

| "Story-level" table     | "Lorebook" Entry rows               |
|-------------------------|-------------------------------------|
| `Character`             | `Entry { type: 'character', state: CharacterEntryState }` |
| `Location`              | `Entry { type: 'location', state: LocationEntryState }`   |
| `Item`                  | `Entry { type: 'item',     state: ItemEntryState }`       |

The two are kept in sync by hand: the orchestrator's `executor.ts` writes to both, the wiki exporter reads both, the wiki importer writes only to the lorebook (and breaks live tracking as a result), and the UI reads `story.characters` / `story.locations` / `story.items` while the prompt assembly reads `story.lorebookEntries`. Whenever a change touches one but not the other — and there are several today — they drift.

This is the dual-table problem flagged in the architecture review. It's the root of:

- Wiki imports producing stories with lore but no live tracking (`wikiImport.ts` writes lorebook only)
- Agreement party-name lookups missing aliases (Character has no aliases; the Entry does)
- Auto-create logic in `executor.ts` having to write twice and de-dupe the second by name
- Lorebook `CharacterEntryState.isPresent` drifting from `Character.metadata.lastSeenLocation` (mitigated by `syncLorebookPresence` but still a two-write contract)
- Two type definitions for "what is a character" that don't quite agree (e.g. `Character.relationship: string | null` vs `CharacterEntryState.relationship: { level, status, history }`)

The fix is to designate the **lorebook Entry as the canonical record** and demote `Character` / `Location` / `Item` to derived views (or remove them). Every entity-related concern — display, search, world sim, wiki, retry, branching — stops needing to know which table to consult.

## Why this is the largest refactor on the roadmap

Touches every UI component that reads `story.characters` / `story.locations` / `story.items` directly, every classifier path, the wiki export/import (both already lorebook-aware but reference the dual tables in places), the database schema, and the test surface. Cross-cutting; one PR's worth of changes spread across ~20 files. **Stage it.**

## Approach — four phases, each independently mergeable

### Phase A — Read adapters (additive, zero risk)

Define adapters that derive `Character` / `Location` / `Item` shapes from `lorebookEntries`. Both representations exist side-by-side; nothing breaks; consumers can opt into the new path one at a time.

New file: `src/lib/services/entityViews.ts`

```typescript
import type { Entry, Character, Location, Item, CharacterEntryState, LocationEntryState, ItemEntryState } from '$lib/types';

export function characterFromEntry(e: Entry, storyId: string): Character {
  const state = e.state as CharacterEntryState;
  return {
    id: e.id,
    storyId,
    branchId: e.branchId,
    name: e.name,
    description: e.description ?? null,
    traits: [],                                          // derive from state if we add it; placeholder for now
    relationship: state.relationship?.status ?? null,
    status: state.isPresent ? 'active' : 'inactive',
    metadata: { lastSeenLocation: state.lastSeenLocation },
    visualDescriptors: {},
    portrait: null,
  };
}

export function locationFromEntry(e: Entry, storyId: string): Location { /* similar */ }
export function itemFromEntry(e: Entry, storyId: string): Item { /* similar */ }
```

Audit `Character` / `Location` / `Item` types against `CharacterEntryState` / `LocationEntryState` / `ItemEntryState` and decide which fields stay on the Entry.state and which need to be added. Some fields may have no Entry equivalent today (`Character.traits`, `Character.visualDescriptors`, `Character.portrait`). Add them to `CharacterEntryState` so the adapter is lossless:

```typescript
export interface CharacterEntryState extends BaseEntryState {
  type: 'character';
  // ... existing fields ...
  // NEW (migrated from Character row):
  traits?: string[];
  visualDescriptors?: VisualDescriptors;
  portrait?: string | null;
}
```

Phase A ships independently. Both tables still authoritative; adapters available for opt-in use.

### Phase B — Flip writers (orchestrator + classifier paths)

Update `src/lib/services/ai/tools/executor.ts` so `handleWorldStateUpdate`:
- For NEW entities: writes only a `lorebookEntries` row via `createLorebookEntry`. Skips `addCharacter` / `addLocation` / `addItem`.
- For EXISTING entities: writes only via `updateLorebookEntry` patching `Entry.state`. Skips `updateCharacter` / etc.

`syncLorebookPresence` (`story.svelte.ts`) becomes the *only* write path; the `Character.metadata.lastSeenLocation` write is removed.

Similarly update:
- `wikiImport.ts` is already lorebook-only — no change beyond confirming the new fields populate
- Manual UI editors (e.g. `CharacterPanel.svelte` if one exists) — flip to writing lorebook
- `OnboardingWizard.svelte` initial-character creation — flip to lorebook

Existing readers still hit `story.characters` / `story.locations` / `story.items`, so the in-memory arrays must keep getting populated. During Phase B, populate them by **deriving from lorebookEntries on every update** rather than from their own DB tables. Effectively the old tables become write-only no-ops.

### Phase C — Flip readers

Remove the `story.characters` / `story.locations` / `story.items` `$state` arrays. Replace with `$derived`:

```typescript
get characters(): Character[] {
  return this.lorebookEntries
    .filter(e => e.type === 'character')
    .map(e => characterFromEntry(e, this.currentStory!.id));
}
get locations(): Location[] { /* ... */ }
get items(): Item[] { /* ... */ }
```

Now there's only one mutation surface (`lorebookEntries`) and one read surface that derives from it.

Audit + update every UI component that reads these arrays:
- `WorldDrawer.svelte` (reads all three, plus `presenceMap`, `currentLocation`, `activeChars`)
- `ContextWindow.svelte`, `WorldPanel.svelte`
- `CharacterPanel.svelte`, `LocationPanel.svelte`, `ItemPanel.svelte` (if these exist)
- `ActionInput.svelte` (reads protagonist via `story.protagonist` getter)
- `StoryView.svelte`, `Library*` components

`story.protagonist` getter switches to filtering lorebookEntries for `type: 'character'` with `state.relationship?.status === 'self'` (or similar — needs a marker for "this is the player").

### Phase D — Schema migration + removal

New IndexedDB schema version. Migration:
1. For every row in `characters` / `locations` / `items` that doesn't have a corresponding `lorebookEntries` row by name+type, copy it into `lorebookEntries`.
2. Drop the `characters` / `locations` / `items` stores.

Update `src/lib/services/database.ts` to remove the dropped stores, their CRUD helpers, and their type imports.

Update `src/lib/services/storySync.ts` (`exportStory` / `importStoryFromJson`) — the JSON export schema currently includes `characters`, `locations`, `items` as separate arrays. Mark them deprecated; old exports import as a one-time backfill into lorebookEntries; new exports omit them.

## Critical files

| File | Phase | Change |
|------|-------|--------|
| `src/lib/types/index.ts` | A | Extend `CharacterEntryState` / `LocationEntryState` / `ItemEntryState` with the fields currently on Character/Location/Item. Mark old types deprecated. |
| `src/lib/services/entityViews.ts` | A | NEW — adapters from Entry to Character/Location/Item shape. |
| `src/lib/services/ai/tools/executor.ts` | B | `handleWorldStateUpdate` writes lorebook only. Remove dual-write. Auto-create logic collapses to one path. |
| `src/lib/services/ai/tools/helpers.ts` | B | `makeLoreEntry` extended to populate the new state fields. |
| `src/lib/stores/story.svelte.ts` | B+C | Phase B: keep `characters/locations/items` populated by deriving from lorebookEntries. Phase C: remove the `$state` arrays, replace with `$derived`. Update `protagonist` getter. Remove `syncLorebookPresence`'s Character-table write. |
| `src/lib/components/story/WorldDrawer.svelte` | C | Continues working via `$derived` getters. Verify presenceMap, activeChars, currentLocation still resolve. |
| `src/lib/components/story/ActionInput.svelte` | C | Still calls `story.protagonist`; just confirm it works through the derived path. |
| `src/lib/components/wizard/OnboardingWizard.svelte` | B | Initial character creation flips to lorebook. |
| `src/lib/services/wikiImport.ts` | B | Already lorebook-only — verify state field population matches new schema. |
| `src/lib/services/wikiExport.ts` | C | Reads `data.lorebookEntries` already, but enrichment uses `getCharacters()`-style queries — switch to lorebook reads. |
| `src/lib/services/storySync.ts` | D | Export schema deprecation. Import handles old format as backfill. |
| `src/lib/services/database.ts` | D | New schema version, remove `characters` / `locations` / `items` stores. |

## Reused helpers (don't reimplement)

- `Entry`, `CharacterEntryState`, `LocationEntryState`, `ItemEntryState` types — extend, don't duplicate.
- `makeLoreEntry` (`helpers.ts:59`) — extend its arg surface.
- `createLorebookEntry`, `updateLorebookEntry`, `getLorebookEntries`, `deleteLorebookEntry` — already exist.
- `toObsidianLinks` / `renderWiki` — already lorebook-aware.

## Concerns / risks

1. **Type debt**: `Character.relationship: string` vs `CharacterEntryState.relationship: { level, status, history }`. The adapter has to choose a representation; deciding what to store on the Entry needs care so old data round-trips. Spec the merged type explicitly before Phase A.
2. **`Character.relationship === 'self'`** is the only marker today for "this is the protagonist." If we move characters into lorebook entries, we need a corresponding marker. Options: a dedicated `isProtagonist: true` field on `CharacterEntryState`, or a `Story.protagonistEntryId` column. Latter is cleaner — protagonist becomes a single foreign key on Story.
3. **Branching**: `branchId` works the same on lorebookEntries as it does on Character/Location/Item. No special handling.
4. **Performance**: deriving `characters` / `locations` / `items` from `lorebookEntries` every tick is a filter + map. With thousands of entries this could matter. Mitigation: memoize with `$derived.by` keyed on `lorebookEntries` reference identity — Svelte 5 already only re-runs derived when deps change.
5. **External code reading `Story.characters` shape**: any third-party tools or saved JSON files in the wild expect the old export format. Phase D's `storySync.ts` change should keep accepting old exports for a release or two (read-only backfill).
6. **Tests**: any tests that mock the dual-table state need to be flipped. Audit early.

## Verification per phase

**Phase A (adapters):**
- Unit test: build a synthetic lorebook entry, run through the adapter, confirm field-by-field correctness.
- Verify `story.characters` and `entityViews.characterFromEntry(...)` produce identical shapes for an existing story.

**Phase B (writers):**
- Take a turn that introduces a new character — confirm only `lorebookEntries` got a write, `characters` table stayed empty.
- Take a turn that updates an existing character (relationship change) — confirm only `lorebookEntries` was patched.
- Wiki import a story — confirm narrator's `## Characters` section sees imported characters.

**Phase C (readers):**
- Open a populated story — `WorldDrawer` shows the same data as before.
- Take a full turn — narration prompt's `## Characters` section sees live state.
- Verify protagonist resolution still works (whichever marker we chose).

**Phase D (migration):**
- Open a story that pre-dates the migration — old characters/locations/items are copied into lorebookEntries cleanly, no duplicates by name.
- Export → new format. Import old format → backfilled. Round-trip with new export → identical.
- Drop the old IndexedDB stores; verify schema migration runs cleanly on existing user databases.

## Approximate scope

- Phase A: ~150 lines, isolated, low risk. Half-day.
- Phase B: ~300 lines across executor + store + wiki paths. ~1-2 days.
- Phase C: ~500 lines mostly UI audits + small replacements. ~2-3 days.
- Phase D: ~200 lines + schema migration + careful test. Half-day, but high risk; do it last.

**Total: roughly a week of focused work, four PRs.** Each phase is independently shippable and reviewable.

## Order recommendation

Do **#4 (retry) first** so the snapshot capture covers the new lorebook-canonical state model in Phase B+. Otherwise the retry plan needs revision mid-stream.
