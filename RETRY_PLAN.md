# Plan: Snapshot-based Retry / Undo

## Context

`PersistentRetryState` exists in `src/lib/types/index.ts:64-86` but the feature is **entirely unimplemented** — there is no capture, no UI button, and no restore logic anywhere in the codebase. As more world state was added (Living World Wiki phases 1-4 introduced agreements, rumors, faction actions, world events, meters), the retry surface area kept growing without anyone hooking it up.

The goal is to let the player undo their last action — rolling back the prose, the world-state deltas the orchestrator wrote, and any background side effects that fired (rumor aging, world sim ticks, chapter creation, etc.). "Snapshot diff" — capture an inventory of what existed before the action, then on retry delete anything new and restore mutable Story-level state.

## Out of scope

- Multi-step undo (only the immediately preceding action)
- Branching from a retry point (existing branch system is separate)
- Automatic retry on errors (retry is user-initiated only)

## Approach

### Part 1 — Extend `PersistentRetryState`

Current shape covers `entryCountBeforeAction`, `characterIds`, `locationIds`, `itemIds`, `storyBeatIds`, `embeddedImageIds`, `characterSnapshots`, `timeTracker`, `activationData`, `storyPosition`. Missing: agreements, rumors, faction actions, world events, meters, lorebook entries created during the action, lastWorldSimDay, entry relationships.

Add to `src/lib/types/index.ts:64-86`:

```typescript
export interface PersistentRetryState {
  // ── existing ──
  timestamp: number;
  entryCountBeforeAction: number;
  userActionContent: string;
  rawInput: string;
  actionType: ActionInputType;
  wasRawActionChoice: boolean;

  // ── existing ID lists ──
  characterIds: string[];
  locationIds: string[];
  itemIds: string[];
  storyBeatIds: string[];
  embeddedImageIds?: string[];

  // ── NEW: Living World ID lists ──
  agreementIds: string[];
  rumorIds: string[];
  factionActionIds: string[];
  worldEventIds: string[];
  lorebookEntryIds: string[];
  entryRelationshipIds: string[];

  // ── existing snapshots ──
  characterSnapshots?: PersistentCharacterSnapshot[];

  // ── NEW: per-row snapshots for restorable mutable state ──
  agreementSnapshots?: AgreementSnapshot[];      // status, terms, secrecy, consequences, resolvedChapterNumber
  rumorSnapshots?: RumorSnapshot[];              // status (spreading→mature→stale aging is reversible)

  // ── existing Story-level mutable ──
  timeTracker?: TimeTracker | null;

  // ── NEW: more Story-level mutable state ──
  lastWorldSimDay?: number | null;
  meters?: Meter[] | null;                        // full snapshot of the meters array
  lastWorldSimResult?: unknown | null;            // the in-memory worldSim result (so plot injection rolls back)

  // ── existing ──
  activationData?: Record<string, number>;
  storyPosition?: number;
}
```

### Part 2 — Capture (`story.svelte.ts` → new method)

Add `captureRetryState(rawInput, actionType, wasRawActionChoice)` to `StoryStore`:

```typescript
captureRetryState(rawInput: string, actionType: ActionInputType, wasRawActionChoice: boolean) {
  if (!this.currentStory) return;
  const state: PersistentRetryState = {
    timestamp: Date.now(),
    entryCountBeforeAction: this.entries.length,
    userActionContent: rawInput,
    rawInput,
    actionType,
    wasRawActionChoice,
    characterIds: this.characters.map(c => c.id),
    locationIds: this.locations.map(l => l.id),
    itemIds: this.items.map(i => i.id),
    storyBeatIds: [], // populate by querying getStoryBeats
    embeddedImageIds: this.images.map(i => i.id),
    agreementIds: this.agreements.map(a => a.id),
    rumorIds: this.rumors.map(r => r.id),
    factionActionIds: this.factionActions.map(fa => fa.id),
    worldEventIds: this.worldEvents.map(e => e.id),
    lorebookEntryIds: this.lorebookEntries.map(e => e.id),
    entryRelationshipIds: this.entryRelationships.map(r => r.id),
    characterSnapshots: this.characters.map(c => ({
      id: c.id, traits: c.traits, status: c.status,
      relationship: c.relationship, visualDescriptors: c.visualDescriptors, portrait: c.portrait,
    })),
    agreementSnapshots: this.agreements.map(a => ({
      id: a.id, status: a.status, terms: a.terms, secrecy: a.secrecy,
      consequences: a.consequences, resolvedChapterNumber: a.resolvedChapterNumber,
    })),
    rumorSnapshots: this.rumors.map(r => ({ id: r.id, status: r.status })),
    timeTracker: this.currentStory.timeTracker,
    lastWorldSimDay: this.currentStory.lastWorldSimDay,
    meters: this.currentStory.meters ? [...this.currentStory.meters] : null,
    lastWorldSimResult: this.lastWorldSimResult,
  };
  await updateStory(this.currentStory.id, { retryState: state });
  this.currentStory = { ...this.currentStory, retryState: state };
}
```

Hook into `ActionInput.svelte` **before** the `story.addEntry('user_action', content)` call — so the captured state reflects the world *before* the user's action took effect.

### Part 3 — Restore (`story.svelte.ts` → new method)

```typescript
async restoreFromRetryState(): Promise<{ ok: boolean; reason?: string }> {
  if (!this.currentStory) return { ok: false, reason: 'no story' };
  if (this.isStreaming) return { ok: false, reason: 'narrator is currently streaming' };
  const rs = this.currentStory.retryState;
  if (!rs) return { ok: false, reason: 'no retry state' };

  // 1. Delete entries from position onward
  await deleteStoryEntriesFromPosition(this.currentStory.id, rs.entryCountBeforeAction);

  // 2. Delete anything new since (id-list-based)
  const cleanup = (current: { id: string }[], allowedIds: string[]) => {
    const allowed = new Set(allowedIds);
    return current.filter(x => !allowed.has(x.id));
  };
  const charsToDelete = cleanup(this.characters, rs.characterIds);
  for (const c of charsToDelete) await deleteCharacter(c.id);
  // ...same pattern for locations, items, storyBeats, agreements, rumors,
  //    factionActions, worldEvents, lorebookEntries, entryRelationships

  // 3. Restore mutable Story-level state
  await updateStory(this.currentStory.id, {
    timeTracker: rs.timeTracker ?? null,
    lastWorldSimDay: rs.lastWorldSimDay ?? null,
    meters: rs.meters ?? null,
    retryState: null, // consume — retry only goes back one step
  });
  this.lastWorldSimResult = rs.lastWorldSimResult ?? null;

  // 4. Restore character snapshots (traits, status, relationship, etc.)
  if (rs.characterSnapshots) {
    for (const snap of rs.characterSnapshots) {
      await updateCharacter(snap.id, {
        traits: snap.traits, status: snap.status,
        relationship: snap.relationship,
        visualDescriptors: snap.visualDescriptors, portrait: snap.portrait,
      });
    }
  }

  // 5. Restore per-row snapshots for living-world rows that survived
  if (rs.agreementSnapshots) {
    for (const snap of rs.agreementSnapshots) {
      await updateAgreement(snap.id, {
        status: snap.status, terms: snap.terms, secrecy: snap.secrecy,
        consequences: snap.consequences, resolvedChapterNumber: snap.resolvedChapterNumber,
      });
    }
  }
  if (rs.rumorSnapshots) {
    for (const snap of rs.rumorSnapshots) await updateRumor(snap.id, { status: snap.status });
  }

  // 6. Reload from DB so reactive state matches truth
  await this.loadStory(this.currentStory.id);
  return { ok: true };
}
```

### Part 4 — UI button

Add a "Retry" button in `StoryView.svelte` (or wherever the latest narration entry is rendered). Use `RotateCcw` from `lucide-svelte`. Conditions:
- Only visible when `story.currentStory?.retryState != null`
- Disabled while streaming
- Confirmation dialog: "Discard the last narration and try again?"
- On click: `await story.restoreFromRetryState()` → toast on success/failure

Optionally surface as a keyboard shortcut (e.g., `Ctrl+Z` when not in an input field).

### Part 5 — Database helpers

Add to `src/lib/services/database.ts`:
- `bulkDeleteCharacters(ids: string[])`, similar for each table — currently only single-row delete exists for some
- `deleteStoryEntriesFromPosition(storyId, fromPosition)` already exists at line 243; reuse

Wrap each table's bulk-delete in a single Dexie transaction per table for atomicity.

## Critical files

- `src/lib/types/index.ts` — extend `PersistentRetryState`, add `AgreementSnapshot` + `RumorSnapshot` types
- `src/lib/stores/story.svelte.ts` — add `captureRetryState()` + `restoreFromRetryState()`
- `src/lib/components/story/ActionInput.svelte` — call `captureRetryState()` before `addEntry('user_action', ...)`
- `src/lib/components/story/StoryView.svelte` — add Retry button
- `src/lib/services/database.ts` — add bulk-delete helpers per table

## Reused helpers (don't reimplement)

- `deleteStoryEntriesFromPosition` (`database.ts:243`)
- `updateStory`, `updateCharacter`, `updateLocation`, `updateItem`, `updateAgreement`, `updateRumor` (all in `database.ts`)
- `loadStory()` (`story.svelte.ts:57`) for the post-restore refresh
- `PersistentCharacterSnapshot` type (already exists at `types/index.ts:88`)

## Edge cases to handle

1. **Streaming in progress** — refuse retry; tell user to wait or abort.
2. **Multiple retries** — only one step back. After restore, `retryState` is consumed (`null`). User must take a new action to capture a new snapshot.
3. **Background jobs that fired between the action and the retry click** — chapter summarizer, arc condenser, lore management. These create rows that retry would delete. Acceptable, but log it.
4. **World sim that ran during the action** — its outputs (faction actions, rumors) live in the ID lists and get deleted on retry. `lastWorldSimDay` is reset, so the next time-tick will re-fire the sim. Correct.
5. **Schema migration** — existing Story rows have `retryState: null`. New fields on `PersistentRetryState` are optional, so old null values stay valid.

## Verification

1. Take an action that touches every state type: introduces a character, moves to a new location, picks up an item, advances time enough to fire world sim, creates an agreement, accumulates rumor staleness. Retry. Confirm:
   - Narration entry gone
   - New character/location/item gone
   - Time tracker reset
   - Agreement gone
   - Rumors back to pre-action status
   - Meters back to pre-action values
   - World-sim result reverted; `lastWorldSimDay` reset
2. Take an action, retry, take another action, retry — verify second retry rolls back the second action only.
3. Retry while streaming — verify it's blocked.
4. Retry with no captured state (e.g., immediately after loading a story that didn't have retryState) — verify graceful no-op.

## Approximate scope

- ~250-400 lines of new code
- 1 schema field addition (no migration needed, all optional)
- 1 new UI button
- Single focused PR
