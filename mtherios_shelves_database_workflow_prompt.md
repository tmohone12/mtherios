# Mtherios Shelves + Story Database Builder Implementation Prompt

Use this prompt/spec to implement the discussed Mtherios restructuring and onboarding workflow. The goal is to make Mtherios open to named **Shelves**, where each shelf has one shared main database/canon and multiple playable stories inside it. Also add a practical non-MCP workflow for creating story/world databases from SillyTavern lorebooks, seed JSON, Markdown notes, pasted notes, and full Mtherios exports.

This is written for a coding agent working in the `tmohone12/mtherios` repo on `master`.

---

## 0. North Star

Mtherios should stop treating a Story as both the world container and the playable run.

Implement this mental model:

```txt
Mtherios
  └─ Shelf
      ├─ Shelf Database / Shared Canon
      ├─ Sources
      │   ├─ SillyTavern lorebooks
      │   ├─ Mtherios seed packs
      │   ├─ Markdown notes
      │   ├─ pasted notes
      │   └─ character cards
      └─ Stories
          ├─ Story Run A
          ├─ Story Run B
          └─ Story Run C
```

A **Shelf** is a named world/campaign/workspace.
A **Shelf Database** is the shared canon for that shelf.
A **Story** is a playable run inside the shelf.
A **Story Overlay** contains story-specific changes that should not automatically mutate the shared shelf canon.

The app should open to the **Shelf Library**, not a flat story list.

---

## 1. Top-Level Goals

Implement these connected features:

1. Real shelves as first-class database records.
2. Shelf-first main screen.
3. Shelf dashboard with stories, database, sources, jobs, and settings tabs.
4. Story creation inside a shelf.
5. Shelf-owned database/canon with multiple stories using it.
6. Story overlays for story-specific facts and world changes.
7. Story Database Builder workflow that does not require MCP.
8. SillyTavern lorebook import as one input source, not the final storage model.
9. Onboarding changed from “create story” to “create shelf/database, then first story.”
10. Frontend stability improvements around generation state, error handling, and mobile navigation.

---

## 2. Existing Repo Context To Verify Before Editing

Before changing code, inspect these likely relevant files. Paths may shift, so verify before patching.

```txt
src/routes/+page.svelte
src/routes/+layout.svelte
src/lib/components/layout/AppShell.svelte
src/lib/components/library/LibraryPanel.svelte
src/lib/components/wizard/OnboardingWizard.svelte
src/lib/components/lorebook/LorebookImport.svelte
src/lib/services/lorebookImporter.ts
src/lib/stores/app.svelte.ts
src/lib/stores/story.svelte.ts
src/lib/server/db/schema.ts
src/lib/server/db/worldDatabaseSchema.ts
src/lib/contracts/worldDatabase.ts
src/lib/contracts/memory.ts
src/routes/api/stories/+server.ts
src/routes/api/database/import/+server.ts
src/app.css
```

Known architectural intent:

```txt
Terminal/Postgres database = source of truth.
Generated Markdown/Obsidian vault = projection.
Qdrant index = rebuildable search/index layer.
Browser/frontend = control surface, not canonical database owner.
```

Do not make generated Markdown vault files editable canon. Use Markdown only as an import/seed source unless an explicit canon-editing route is implemented.

---

## 3. Product Language

Use these user-facing terms consistently:

```txt
Shelf
  A named world or campaign space.

Shelf Database
  Shared canon for this shelf.

Story
  A playable run inside this shelf.

Story Overlay
  Changes unique to one story.

Sources
  Imported lorebooks, notes, seed files, character cards, and database exports.

Promoted Canon
  Story discoveries intentionally saved back into the shelf database.
```

Avoid showing users low-level terms first:

```txt
Postgres
Qdrant
pgvector
source refs
memory nodes
migrations
```

Those belong in advanced status/details panels.

---

## 4. Data Model: Shelves First

### 4.1 Add `shelves` table

Add a first-class `shelves` table.

Suggested shape:

```ts
export const shelves = pgTable('shelves', {
  id: text('id').primaryKey(),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),
  genre: text('genre'),
  coverImageUrl: text('cover_image_url'),

  settings: jsonb('settings')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),

  metadata: jsonb('metadata')
    .$type<Record<string, unknown>>()
    .notNull()
    .default({}),

  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),

  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow()
}, (table) => ({
  nameIdx: index('shelves_name_idx').on(table.name),
  slugIdx: index('shelves_slug_idx').on(table.slug),
  updatedAtIdx: index('shelves_updated_at_idx').on(table.updatedAt)
}));
```

Ensure unique slugs if the existing style supports it.

### 4.2 Add `shelfId` to `stories`

Current stories appear to be doing two jobs: world container and playable run. Add shelf ownership.

Suggested shape:

```ts
shelfId: text('shelf_id')
  .notNull()
  .references(() => shelves.id, { onDelete: 'cascade' }),

role: text('role')
  .notNull()
  .default('playable'),

timelineMode: text('timeline_mode')
  .notNull()
  .default('overlay'),
```

Recommended values:

```txt
role:
  playable
  template
  archive
  test

timelineMode:
  overlay  - story has private changes over shelf canon. Default.
  shared   - story can write directly to shared shelf canon.
  fork     - story started from shelf canon but has diverged.
```

Add indexes:

```ts
shelfIdx: index('stories_shelf_idx').on(table.shelfId),
shelfUpdatedIdx: index('stories_shelf_updated_idx').on(table.shelfId, table.updatedAt)
```

### 4.3 Migration plan

Implement a safe migration:

```txt
1. Create shelves table.
2. Add nullable stories.shelf_id.
3. Create a default shelf named "Mtherios Lore Shelf" or "Default Shelf".
4. Backfill all existing stories into that shelf.
5. Make stories.shelf_id non-null after backfill.
6. Add indexes.
```

Existing users should see all current stories under one default shelf after upgrade.

### 4.4 Long-term canon scoping

For canon/world database tables, move toward this pattern:

```ts
shelfId: text('shelf_id')
  .notNull()
  .references(() => shelves.id, { onDelete: 'cascade' }),

storyId: text('story_id')
  .references(() => stories.id, { onDelete: 'cascade' })
```

Meaning:

```txt
storyId = null
  shared shelf canon

storyId = some story id
  story-specific overlay canon
```

Query pattern:

```sql
SELECT *
FROM facts
WHERE shelf_id = :shelfId
  AND (story_id IS NULL OR story_id = :storyId);
```

This allows one shelf database to support multiple story runs without one run poisoning every other story.

### 4.5 Scope values

If useful, add explicit scope fields to canon rows:

```txt
shared
story_overlay
archived
source_only
```

But do not duplicate meaning unnecessarily if `storyId = null` is enough.

---

## 5. API Design

Add shelf APIs.

```txt
GET    /api/shelves
POST   /api/shelves

GET    /api/shelves/:shelfId
PATCH  /api/shelves/:shelfId
DELETE /api/shelves/:shelfId

GET    /api/shelves/:shelfId/stories
POST   /api/shelves/:shelfId/stories

GET    /api/shelves/:shelfId/database
GET    /api/shelves/:shelfId/sources
GET    /api/shelves/:shelfId/jobs
```

Keep existing story APIs for compatibility, but make them shelf-aware:

```txt
GET /api/stories?shelfId=...
POST /api/stories with shelfId required unless migration/backward compatibility path applies
```

Recommended create story payload:

```ts
type CreateStoryRequest = {
  shelfId: string;
  title: string;
  description?: string;
  genre?: string;
  mode?: 'adventure' | 'creative-writing';
  protagonist?: {
    name?: string;
    description?: string;
  };
  openingScene?: string;
  timelineMode?: 'overlay' | 'shared' | 'fork';
  settings?: Record<string, unknown>;
};
```

Recommended create shelf payload:

```ts
type CreateShelfRequest = {
  name: string;
  description?: string;
  genre?: string;
  tags?: string[];
  coverImageUrl?: string;
  settings?: Record<string, unknown>;
};
```

---

## 6. Main Screen: Shelf Library

The app should open to a Shelf Library.

### 6.1 Shelf Library UI

Replace the current fake/hard-coded shelf section in the library panel with real shelf cards.

Main screen copy:

```txt
Your Shelves

A shelf is a world database with one or more stories inside it.
Create a shelf for each setting, campaign, or reusable canon.
```

Shelf card should show:

```txt
Shelf name
Description
Genre / tags
Story count
Canon record count
Source count
Last opened
Database health
Qdrant/wiki sync status
Open Shelf button
New Story button
More menu: Rename, Export, Archive/Delete
```

Example:

```txt
Glassmarket
Political fantasy
4 stories · 182 canon records · 12 sources
Last opened today
Database healthy · Qdrant indexed · Vault synced

[Open Shelf] [New Story]
```

### 6.2 New component structure

Create or refactor toward:

```txt
src/lib/components/library/
  LibraryPanel.svelte
  ShelfLibrary.svelte
  ShelfCard.svelte
  ShelfDashboard.svelte
  ShelfHeader.svelte
  ShelfStoriesTab.svelte
  ShelfDatabaseTab.svelte
  ShelfSourcesTab.svelte
  ShelfJobsTab.svelte
  ShelfSettingsTab.svelte
```

`LibraryPanel.svelte` should become a small state router:

```svelte
{#if app.currentShelfId}
  <ShelfDashboard shelfId={app.currentShelfId} />
{:else}
  <ShelfLibrary />
{/if}
```

---

## 7. Shelf Dashboard

When a shelf opens, show a dashboard.

```txt
Glassmarket
[Stories] [Database] [Sources] [Timeline] [Jobs] [Settings]
```

### 7.1 Stories tab

```txt
Stories in Glassmarket

[+ New Story]

Vaeron’s Debt
  Last played: Today
  Turn 84
  Overlay facts: 37
  Status: Active

Mira’s Coup
  Last played: July 1
  Turn 22
  Overlay facts: 12
  Status: Draft
```

Story cards should show:

```txt
Title
Description/opening scene teaser
Current turn
Current location/time if available
Last opened
Overlay fact count
Status
Open button
More menu: Rename, Duplicate, Archive, Export, Delete
```

### 7.2 Database tab

This is the shelf shared canon browser.

```txt
Shelf Canon

[Search canon...]

Characters  Locations  Factions  Items  Facts  Relationships  Threads
```

Use visual distinctions:

```txt
Shared shelf canon     = shelf/shared icon
Story overlay canon    = story/branch icon
Imported source record = source/document icon
Secret canon           = locked/secret icon
```

No exact colors are required, but the difference must be visible.

### 7.3 Sources tab

Sources are import inputs and evidence, not necessarily canon themselves.

```txt
Sources

[Import SillyTavern Lorebook]
[Import Character Card]
[Import Markdown Seed]
[Paste Notes]
[Import Mtherios Seed]
[Import Full Shelf Database]

glassmarket_lorebook.json
  84 entries
  Imported into shelf canon
  3 warnings

campaign_notes.md
  14 extracted records
  Review needed
```

### 7.4 Jobs tab

Show backend health without scaring nontechnical users.

```txt
Shelf Jobs

Vault sync: complete
Qdrant index: complete
Database migration: current
Background jobs: 0 running
Last source import: successful
```

Detailed/advanced drawer can show:

```txt
Terminal process reachable
Postgres reachable
Migration version
Qdrant reachable
Indexed pages
Last index time
Provider validation status
```

### 7.5 Settings tab

Settings should include:

```txt
Shelf name
Description
Genre/tags
Default provider profile
Default model settings
Default story mode
Default timeline mode
Import/export options
Danger zone: archive/delete shelf
```

---

## 8. App State Changes

Update the app store to track shelves.

Suggested state:

```ts
class AppStore {
  currentShelfId = $state<string | null>(null);
  currentStoryId = $state<string | null>(null);

  openShelf(shelfId: string) {
    this.currentShelfId = shelfId;
    this.currentStoryId = null;
    this.saveLastShelfId(shelfId);
  }

  closeShelf() {
    this.currentShelfId = null;
    this.currentStoryId = null;
  }

  startNewShelf() {
    this.currentShelfId = null;
    this.currentStoryId = null;
    this.showWizard = true;
    this.wizardMode = 'new-shelf';
  }

  startNewStoryInShelf(shelfId = this.currentShelfId) {
    if (!shelfId) {
      this.startNewShelf();
      return;
    }

    this.currentShelfId = shelfId;
    this.currentStoryId = null;
    this.showWizard = true;
    this.wizardMode = 'new-story';
  }

  openStory(storyId: string, shelfId: string) {
    this.currentShelfId = shelfId;
    this.currentStoryId = storyId;
    this.saveLastShelfId(shelfId);
    this.saveLastStoryId(storyId);
  }
}
```

Persist:

```txt
lastShelfId
lastStoryId
lastOpenedAt
```

Initial route logic:

```txt
currentShelfId = null, currentStoryId = null
  -> Shelf Library

currentShelfId exists, currentStoryId = null
  -> Shelf Dashboard

currentShelfId exists, currentStoryId exists
  -> Story View

wizard open
  -> New Shelf or New Story wizard
```

---

## 9. Story Database Builder Workflow

The user currently lacks an easy way to create databases outside MCP. Add a browser-based workflow.

### 9.1 Product concept

Call the feature one of:

```txt
Story Seed Builder
Story Database Builder
World Bible Builder
```

Recommended name: **Story Database Builder** for clarity.

Core rule:

```txt
Source material becomes draft canon first. Nothing writes to the shelf database until the user approves the review screen.
```

### 9.2 Creation sources

Support:

```txt
Blank Shelf
SillyTavern Lorebook JSON
Character Card, including embedded character_book if present
Pasted Notes
Markdown Seed
Mtherios Seed JSON
Full Mtherios Database/Shelf Export
```

### 9.3 Source Inbox

Every import goes into a temporary Source Inbox before canon creation.

Preview card example:

```txt
Source: glassmarket_lorebook.json
Detected: SillyTavern lorebook
Entries: 84
Characters: 21
Locations: 13
Factions: 8
Concepts: 31
Warnings: 4
```

Actions:

```txt
Preview
Deselect entries
Edit source label
Remove source
Continue to Canon Review
```

### 9.4 Compile Draft Canon

Mtherios converts sources into proposals.

Review groups:

```txt
Cast
Places
Factions
Items
Concepts
Events
Relationships
Threads
Secrets
```

Each proposal card:

```txt
Confirm
Edit
Merge duplicate
Mark secret
Mark player-known
Delete
View source evidence
```

### 9.5 Review relationships/factions

Optional beginner/advanced split:

Beginner mode shows only obvious records:

```txt
Characters
Locations
Factions
Threads
```

Advanced mode shows:

```txt
Relationships
Faction goals
Agreements
Facts
Source references
Memory nodes
Visibility/confidence
```

### 9.6 Opening scene

Before creating the first story, ask:

```txt
Story title
Starting location
Present characters
Player/protagonist
Immediate problem
Tone
POV
Tense
Timeline mode: overlay/shared/fork
```

Default timeline mode: `overlay`.

### 9.7 Build step

Final button:

```txt
Create Shelf Database
```

Final copy:

```txt
This creates terminal-owned canon, queues the generated wiki, and opens your first story.
```

Build operation should:

```txt
1. Create shelf.
2. Insert raw source/evidence records.
3. Insert shared shelf canon records.
4. Insert entities, aliases, factions, relationships, facts, threads, memory nodes.
5. Create first story inside shelf.
6. Insert opening scene/story metadata.
7. Queue vault/wiki projection.
8. Queue optional Qdrant indexing.
9. Open the story.
```

Qdrant/vault failures should not fail database creation. They should create retryable warnings/jobs.

---

## 10. Seed Formats

Do not make users author full world database JSON. That format is too database-shaped. Add friendly seed formats.

### 10.1 `.mtherios.seed.json`

Create a contract file:

```txt
src/lib/contracts/worldSeed.ts
```

Suggested schema:

```ts
import { z } from 'zod';

export const worldSeedEntitySchema = z.object({
  id: z.string().optional(),
  type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  visibility: z.enum(['public', 'player_known', 'secret']).default('player_known'),
  description: z.string().default(''),
  secrets: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  state: z.record(z.string(), z.unknown()).default({})
});

export const worldSeedSchema = z.object({
  version: z.literal(1),
  shelf: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    genre: z.string().optional(),
    tags: z.array(z.string()).default([])
  }),
  story: z.object({
    title: z.string().min(1),
    genre: z.string().optional(),
    mode: z.enum(['adventure', 'creative-writing']).default('adventure'),
    description: z.string().optional(),
    openingScene: z.string().optional(),
    timelineMode: z.enum(['overlay', 'shared', 'fork']).default('overlay')
  }).optional(),
  protagonist: worldSeedEntitySchema.optional(),
  entities: z.array(worldSeedEntitySchema).default([]),
  relationships: z.array(z.object({
    source: z.string(),
    target: z.string(),
    type: z.string().default('related-to'),
    label: z.string().optional(),
    strength: z.number().min(0).max(1).default(0.5),
    visibility: z.enum(['public', 'player_known', 'secret']).default('player_known')
  })).default([]),
  threads: z.array(z.object({
    description: z.string().min(1),
    significance: z.enum(['minor', 'moderate', 'major']).default('moderate')
  })).default([]),
  rawSources: z.array(z.object({
    id: z.string(),
    title: z.string(),
    sourceType: z.string(),
    content: z.string()
  })).default([])
});

export type WorldSeed = z.infer<typeof worldSeedSchema>;
```

Example:

```json
{
  "version": 1,
  "shelf": {
    "name": "Glassmarket",
    "description": "A debt-haunted bridge city full of contracts and candlelit courts.",
    "genre": "political fantasy",
    "tags": ["contracts", "bridges", "factions"]
  },
  "story": {
    "title": "Vaeron's Debt",
    "mode": "adventure",
    "openingScene": "The protagonist arrives at the Ledger Bridge during a toll riot.",
    "timelineMode": "overlay"
  },
  "entities": [
    {
      "id": "char_vaeron_ash",
      "type": "character",
      "name": "Vaeron Ash",
      "aliases": ["Vaeron", "the debt courier"],
      "visibility": "player_known",
      "description": "A former courier bound by an old House Sythar contract.",
      "secrets": ["The debt marker is keyed to his blood."]
    },
    {
      "id": "faction_house_sythar",
      "type": "faction",
      "name": "House Sythar",
      "aliases": ["Sythar", "the Silver House"],
      "visibility": "player_known",
      "description": "A creditor house that controls bridge tolls and debt ledgers."
    }
  ],
  "relationships": [
    {
      "source": "char_vaeron_ash",
      "target": "faction_house_sythar",
      "type": "debt",
      "label": "Vaeron owes House Sythar",
      "strength": 0.9,
      "visibility": "player_known"
    }
  ],
  "threads": [
    {
      "description": "Who truly owns Vaeron's debt marker?",
      "significance": "major"
    }
  ]
}
```

### 10.2 Markdown seed format

Support `.mtherios.seed.md`.

Example:

```md
---
mtheriosSeed: 1
shelf: Glassmarket
title: Vaeron's Debt
genre: political fantasy
mode: adventure
openingScene: The protagonist arrives at the Ledger Bridge during a toll riot.
---

# Characters

## Vaeron Ash [character]
Aliases: Vaeron, the debt courier
Visibility: player_known
Present at start: true

A disgraced courier carrying a debt marker nobody wants named aloud.

Secret:
The debt marker is keyed to his blood.

## Mira Solen [character]
Aliases: Mira
Visibility: player_known

A toll clerk who knows which ledgers were burned.

Secret:
Mira reports to the Candle Court.

# Factions

## House Sythar [faction]
Aliases: Sythar, the Silver House
Resources: wealth 80, influence 70, morale 50
Goal: Control the Ledger Bridge.
Secret Goal: Buy the Dockside Union from within.

# Places

## Ledger Bridge [location]
Visibility: player_known

The bridge where all debts become public record.

# Threads

- Who owns Vaeron's debt marker?
- Why did the toll records vanish?
```

Parser rules:

```txt
# Characters -> default type character
# Factions -> default type faction
# Places / Locations -> default type location
# Items -> default type item
# Threads -> story threads
## Name [type] -> explicit type override
Aliases: comma-separated aliases
Visibility: public/player_known/secret
Secret: following paragraph or line becomes secrets[]
Unknown sections -> memory nodes or review warnings
```

---

## 11. Server-Side Compiler

Do not let the browser be the final canon writer. Browser can preview and edit a draft, but server validates and writes.

Add:

```txt
src/lib/server/db/worldSeedCompiler.ts
src/routes/api/database/seed/preview/+server.ts
src/routes/api/database/seed/import/+server.ts
```

### 11.1 Preview endpoint

```txt
POST /api/database/seed/preview
```

Input:

```ts
{
  sourceType: 'sillytavern_lorebook' | 'character_card' | 'markdown_seed' | 'mtherios_seed_json' | 'pasted_notes';
  content: string;
  fileName?: string;
  options?: Record<string, unknown>;
}
```

Output:

```ts
{
  ok: true;
  seedDraft: WorldSeed;
  summary: {
    entities: number;
    characters: number;
    locations: number;
    factions: number;
    relationships: number;
    threads: number;
    sources: number;
  };
  warnings: Array<{
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
    sourceId?: string;
  }>;
}
```

### 11.2 Import endpoint

```txt
POST /api/database/seed/import
```

Input:

```ts
{
  seed: WorldSeed;
  options: {
    createFirstStory?: boolean;
    syncWiki?: boolean;
    indexQdrant?: boolean;
    preserveIds?: boolean;
  };
}
```

Output:

```ts
{
  ok: true;
  shelfId: string;
  storyId?: string;
  jobs: Array<{ id: string; type: string; status: string }>;
  warnings: Array<{ code: string; message: string }>;
}
```

### 11.3 Compiler shape

```ts
export function compileWorldSeedToBundle(seed: WorldSeed) {
  const now = new Date().toISOString();
  const shelfId = makeStableId('shelf', seed.shelf.name);
  const storyId = seed.story ? makeStableId('story', `${seed.shelf.name}:${seed.story.title}`) : null;

  return {
    schemaVersion: 1,
    exportedAt: now,
    source: 'mtherios-world-seed',
    shelf: {
      id: shelfId,
      name: seed.shelf.name,
      description: seed.shelf.description ?? null,
      genre: seed.shelf.genre ?? null,
      settings: {},
      metadata: {
        tags: seed.shelf.tags ?? [],
        createdFromSeed: true
      },
      createdAt: now,
      updatedAt: now
    },
    story: storyId && seed.story ? {
      id: storyId,
      shelfId,
      title: seed.story.title,
      description: seed.story.description ?? null,
      genre: seed.story.genre ?? seed.shelf.genre ?? null,
      mode: seed.story.mode,
      timelineMode: seed.story.timelineMode ?? 'overlay',
      currentTurn: 0,
      metadata: {
        openingScene: seed.story.openingScene ?? null,
        startWorkflow: {
          sourceMode: 'world_seed',
          sourceCount: seed.rawSources.length,
          requiresCanonReview: false,
          startingSceneReady: Boolean(seed.story.openingScene)
        }
      },
      createdAt: now,
      updatedAt: now
    } : null,
    worldDatabase: {
      sourceEntries: buildSourceEntries(seed, shelfId, storyId, now),
      entities: buildEntities(seed, shelfId, null, now),
      entityAliases: buildAliases(seed, shelfId, null, now),
      relationships: buildRelationships(seed, shelfId, null, now),
      factions: buildFactions(seed, shelfId, null, now),
      storyThreads: buildThreads(seed, shelfId, storyId, now),
      facts: buildFacts(seed, shelfId, null, now),
      memoryNodes: buildMemoryNodes(seed, shelfId, null, now),
      sourceRefs: buildSourceRefs(seed, shelfId, now)
    }
  };
}
```

Adapt this to the existing `worldDatabase` bundle contract instead of forcing a parallel format if the repo already has one.

---

## 12. SillyTavern Lorebook Mapping

Existing lorebook import should become a source type in Story Database Builder.

Workflow:

```txt
SillyTavern lorebook
  -> parse entries
  -> infer type
  -> create draft canon proposals
  -> user review
  -> compile to shelf database
  -> import into terminal/Postgres canon
```

Mapping:

```txt
SillyTavern comment
  -> entity.name or memoryNode.title

SillyTavern content
  -> entity.description
  -> memoryNode.content
  -> fact.statement if extractable

key + keysecondary
  -> entityAliases
  -> memoryNode.keywords

constant = true
  -> high importance memoryNode
  -> metadata.injectionMode = "always"

disable = true
  -> skip by default, or import as inactive

order
  -> priority metadata

entry inferred as character
  -> entities row with type character

entry inferred as faction
  -> entities row + factions row

entry inferred as location
  -> entities row with type location

entry inferred as item
  -> entities row with type item

entry inferred as event
  -> storyEvents row or memoryNode, depending on review

unclassified entry
  -> concept/memoryNode plus review warning
```

Do not discard original lorebook data. Store raw imported source entries and link generated records back to source evidence where possible.

---

## 13. Onboarding Refactor

Current wizard appears to be index-based. Refactor to named steps.

### 13.1 Step IDs

```ts
type OnboardingStepId =
  | 'runtime'
  | 'provider'
  | 'creation-path'
  | 'shelf-basics'
  | 'source-inbox'
  | 'canon-review'
  | 'build-shelf-database'
  | 'first-story'
  | 'complete';
```

Recommended rendering pattern:

```svelte
<svelte:component
  this={currentStep.component}
  bind:draft
  onNext={next}
  onBack={back}
/>
```

### 13.2 New onboarding order

```txt
1. Runtime Check
2. Provider Setup
3. Create or Choose Shelf
4. Shelf Basics
5. Source Inbox
6. Canon Review
7. Build Shelf Database
8. First Story Setup
9. Begin Story
```

### 13.3 Creation Path screen

Ask:

```txt
What do you want to do?

Create a new shelf
Import a shelf database
Open an existing shelf
Create a new story in an existing shelf
```

### 13.4 Source choice screen

For new shelf:

```txt
How do you want to build this shelf database?

Start blank
Import SillyTavern lorebook
Import character card
Paste notes
Import Markdown seed
Import Mtherios seed JSON
Import full Mtherios database/shelf export
```

### 13.5 Canon Review screen

Show summary:

```txt
21 Characters
13 Locations
8 Factions
31 Concepts
6 Threads
4 Possible Duplicates
3 Secret/Player-known conflicts
```

Actions:

```txt
Approve all safe
Edit selected
Merge duplicates
Mark secrets
Delete rejected
Download seed pack
Back to sources
Create Shelf Database
```

### 13.6 First Story screen

Ask:

```txt
Story title
Opening scene
Starting location
Present characters
Protagonist/party
Tone
POV
Tense
Timeline mode
```

Default copy:

```txt
This story will use the shelf database. By default, new events are saved to this story only. You can promote important changes back to the shelf later.
```

### 13.7 Final button copy

```txt
Create Shelf Database & Begin Story
```

---

## 14. Builder Outside Onboarding

The builder should not only live inside onboarding.

Add one of these entry points:

```txt
Library -> New -> Story Database
System -> Database Builder
Shelf Dashboard -> Sources -> Import Source
```

Persistent builder capabilities:

```txt
Save draft locally
Export .mtherios.seed.json
Import .mtherios.seed.json
Import SillyTavern lorebook
Import Markdown seed
Compile to shelf database
Add sources to existing shelf
Create first story after import
```

---

## 15. Story Overlay + Promote To Shelf

Default behavior:

```txt
Gameplay/world updates go into Story Overlay.
Shared shelf canon does not change automatically.
```

Add review actions:

```txt
Promote to Shelf Canon
Keep Story-Only
Hide from Other Stories
Copy to Another Story
Move to Story Overlay
Archive
```

After a story turn, background world updates can summarize:

```txt
New story-only facts: 5
Possible shelf canon updates: 2

[Review] [Promote All Safe] [Ignore]
```

Do not implement aggressive auto-promotion at first. Use explicit user approval.

---

## 16. Import/Export Separation

Add clear import/export types.

### 16.1 Export types

```txt
Export Shelf
  Exports shelf, main database, sources, settings, and optionally all stories.

Export Story
  Exports one playable story and its overlay.

Export Database
  Exports only the shared shelf canon.

Export Seed Pack
  Exports friendly .mtherios.seed.json draft/source format.
```

### 16.2 Import types

```txt
Import Shelf
  Creates a whole shelf.

Import Story into Shelf
  Adds one story to an existing shelf.

Import Sources into Shelf
  Adds lorebooks, notes, seed material, or character cards to the shelf database review queue.

Import Database into Shelf
  Replaces or merges shared shelf canon depending on user choice.
```

Add preview before destructive import.

---

## 17. Frontend Stability Improvements

### 17.1 Refactor large components

Known large components from prior review:

```txt
WorldDrawer.svelte
ActionInput.svelte
StoryView.svelte
```

Target structure:

```txt
src/lib/components/story/
  StoryView.svelte
  StoryTranscript.svelte
  StoryEntry.svelte
  StreamingEntry.svelte
  StoryToolbar.svelte

  action/
    ActionInput.svelte
    ActionTypeTabs.svelte
    DiceRollPanel.svelte
    PlanModal.svelte
    GenerationStatus.svelte

  world-drawer/
    WorldDrawer.svelte
    WorldDrawerShell.svelte
    CharactersTab.svelte
    LocationsTab.svelte
    ItemsTab.svelte
    QuestsTab.svelte
    FactionsTab.svelte
    WorldSearch.svelte
    WorldDrawerModel.ts
```

Rule:

```txt
Svelte components render.
Stores/models/services decide.
Async orchestration should not live inside giant UI components.
```

### 17.2 Turn/generation state machine

Move generation orchestration out of `ActionInput.svelte` into a dedicated runner/store.

Suggested type:

```ts
type TurnPhase =
  | 'idle'
  | 'validating-input'
  | 'assembling-context'
  | 'streaming'
  | 'applying-tools'
  | 'updating-world'
  | 'running-background-jobs'
  | 'done'
  | 'cancelled'
  | 'failed';
```

Run state:

```ts
type TurnRun = {
  runId: string;
  shelfId: string;
  storyId: string;
  phase: TurnPhase;
  startedAt: number;
  abortController: AbortController;
  partialText: string;
  errors: TurnError[];
  warnings: TurnWarning[];
};
```

UI should show useful phases:

```txt
Streaming narration
Updating story overlay
Running background jobs
Vault sync queued
Qdrant index retry needed
```

### 17.3 Non-critical jobs must be recoverable

Post-generation jobs like classifier, choices, style review, image generation, chapter checks, world simulation, arc condensation, and indexing should not permanently block story play.

Use `Promise.allSettled` for non-critical jobs. Display retry cards:

```txt
Narration saved.
World update failed. Retry
Image generation skipped. Retry
Style review timed out. Ignore
Chapter summary queued.
```

### 17.4 Error boundaries

Add:

```txt
src/routes/+error.svelte
src/hooks.client.ts
src/lib/components/system/ErrorPanel.svelte
src/lib/stores/errorLog.svelte.ts
```

Major panels should fail locally, not blank the app:

```svelte
<PanelBoundary name="World Drawer">
  <WorldDrawer />
</PanelBoundary>
```

If Svelte does not provide an exact boundary pattern, implement a lightweight wrapper/store-driven fallback.

### 17.5 Runtime health/status bar

Add a header/status pill:

```txt
Engine online
DB online
Qdrant indexed
3 jobs running
1 sync warning
```

Click opens diagnostics:

```txt
Runtime
  Node process reachable
  Current data root
  Last successful sync

Database
  Postgres reachable
  Migration version
  Pending writes

Qdrant
  Reachable
  Indexed pages
  Last index time

AI Providers
  Narrative model valid
  Classifier model valid
  Image model valid
```

### 17.6 Mobile System bottom sheet

Current mobile System should not only open settings. Add a bottom sheet:

```txt
System
  Settings
  Database Viewer
  Canon Repair
  Engine Core
  Terminal Sync
  Sync Status
  Logs
```

### 17.7 Virtualization/performance

Add virtualization or incremental rendering for:

```txt
Story transcript
World drawer entity lists
Shelf database record lists
Source inbox entries
Lorebook entries
Vault assets
Logs
Generation traces
```

Cache safe Markdown/HTML rendering by:

```txt
entryId + contentHash
```

All AI/lore/story HTML must go through one sanitizer/render utility.

---

## 18. Appearance and Settings

Borrow SillyTavern’s customization philosophy, not legacy structure.

Add appearance settings:

```txt
Theme: Mtherios / Plain Dark / Parchment / High Contrast
Density: Cozy / Compact
Story width: Narrow / Medium / Wide
Font size
Font family
Reduce motion
Disable grain/glow effects
Show/hide dice panels
Show/hide world update summaries
```

Layout settings:

```txt
Writer mode
Visual novel mode
Pin world drawer
Split view: story + world
Mobile input position
```

Add settings modes:

```txt
Beginner
  Provider
  Model
  Temperature
  Theme
  Save/export

Advanced
  Per-service models
  Context budgets
  Lore retrieval
  Memory settings
  Style reviewer

Expert
  Raw prompts
  Token windows
  Tool-call behavior
  Qdrant/index settings
  Job queues
  Debug traces
```

Add settings search.

---

## 19. Tests

Add or extend test scripts:

```json
{
  "scripts": {
    "lint": "eslint .",
    "typecheck": "npm run check",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "test:ci": "npm run typecheck && npm run test:unit && npm run test:e2e && npm run build"
  }
}
```

Add Playwright smoke flows:

```txt
1. App loads to Shelf Library.
2. Existing stories appear under migrated Default Shelf.
3. User creates a new shelf.
4. User imports a SillyTavern lorebook into Source Inbox.
5. Canon Review shows detected characters/locations/factions.
6. User creates shelf database and first story.
7. User opens shelf dashboard and sees story inside shelf.
8. User creates second story in same shelf.
9. Story overlay facts do not appear as shared canon until promoted.
10. Streaming generation can be stopped.
11. Reload after story generation does not corrupt shelf/story state.
12. Backend unavailable shows useful runtime error.
13. Mobile nav can reach Shelf Library, Shelf Dashboard, Story, System tools.
14. Import malformed seed file shows reviewable error, not blank screen.
15. Qdrant unavailable does not block shelf database creation.
```

Unit tests:

```txt
worldSeedSchema validates good seed JSON.
worldSeedSchema rejects missing shelf name.
Markdown seed parser extracts entities/threads/secrets.
SillyTavern lorebook importer maps entries to seed proposals.
Seed compiler creates shelf + story + shared canon records.
Story overlay query returns shared + story rows.
Promote-to-shelf copies/moves overlay facts correctly.
Migration backfills old stories into default shelf.
```

---

## 20. Implementation Phases

### Phase 1: Make shelves real, minimal disruption

```txt
1. Add shelves table.
2. Add shelfId to stories.
3. Backfill existing stories into default shelf.
4. Add /api/shelves endpoints.
5. Add shelf-aware story list/create.
6. Replace hard-coded shelf block with real ShelfLibrary.
7. Add ShelfDashboard with Stories tab.
8. Make New Story require/select shelf.
```

Acceptance criteria:

```txt
App opens to Shelf Library.
Existing stories are visible under Default Shelf.
User can create shelf.
User can create story inside shelf.
Opening a story preserves current shelf context.
No data loss from existing stories.
```

### Phase 2: Database Builder MVP

```txt
1. Add worldSeed.ts contract.
2. Add seed preview/import endpoints.
3. Reuse existing lorebookImporter for SillyTavern JSON.
4. Add Source Inbox UI.
5. Add Canon Review UI.
6. Compile approved lorebook entries to shelf database records.
7. Create first story from build step.
8. Add Download Seed Pack.
```

Acceptance criteria:

```txt
User can import SillyTavern lorebook without MCP.
Entries are previewed before writing.
User can approve/edit/delete proposals.
Import creates shelf database and first story.
Original source evidence is retained.
Qdrant/wiki failures are warnings, not hard failures.
```

### Phase 3: Seed formats and persistent builder

```txt
1. Add .mtherios.seed.json import/export.
2. Add Markdown seed parser.
3. Add builder route or modal outside onboarding.
4. Add save draft locally.
5. Add import sources into existing shelf.
```

Acceptance criteria:

```txt
User can create a shelf database from seed JSON.
User can create a shelf database from Markdown.
User can export a seed pack.
User can resume an unfinished builder draft after refresh.
User can add sources to an existing shelf.
```

### Phase 4: Story overlays and promote/demote

```txt
1. Add shelfId/storyId scoping to canon tables.
2. Make storyId null mean shared shelf canon.
3. Make storyId set mean story overlay.
4. Update queries to return shared + current story overlay.
5. Add Promote to Shelf Canon.
6. Add Keep Story-Only.
7. Add overlay counts to story cards.
```

Acceptance criteria:

```txt
Two stories in one shelf can diverge safely.
A fact created in one story does not appear in another until promoted.
User can promote selected story facts to shelf canon.
Shelf Database tab distinguishes shared canon from story overlay.
```

### Phase 5: Frontend stability and polish

```txt
1. Refactor WorldDrawer/ActionInput/StoryView.
2. Add turn state machine.
3. Add error boundaries/panel fallbacks.
4. Add runtime health/status panel.
5. Add mobile System bottom sheet.
6. Add virtualization for large lists.
7. Add settings search and appearance/layout presets.
8. Add Playwright tests.
```

Acceptance criteria:

```txt
Generation state is visible and recoverable.
Non-critical jobs fail as retry cards.
App does not blank-screen when a panel fails.
Mobile can reach all major system tools.
Long lists remain responsive.
CI covers main shelf/onboarding/story flows.
```

---

## 21. UX Copy To Use

### Shelf Library intro

```txt
Your Shelves

A shelf is a world database with one or more stories inside it.
Create a shelf for each setting, campaign, or reusable canon.
```

### New shelf intro

```txt
Build your world

Mtherios can start from a blank page, an old SillyTavern lorebook, a character card, notes, Markdown, or a full Mtherios database export.

Imported material becomes draft canon first. You can review it before the story begins.
```

### Lorebook import copy

```txt
Import a SillyTavern lorebook

We will read the lorebook, detect characters, places, factions, items, concepts, and events, then turn them into a Mtherios shelf database.

Nothing is written until you approve the review screen.
```

### New story copy

```txt
Create Story in {shelfName}

This story will use the {shelfName} shelf database. By default, new events are saved to this story only. You can promote important changes back to the shelf later.
```

### Final build copy

```txt
Create Shelf Database & Begin Story

This creates terminal-owned canon, queues the generated wiki, and opens your first scene.
```

### Runtime/Qdrant warning copy

```txt
The shelf database was created successfully, but the search index needs a retry. Story play can continue.
```

---

## 22. Safety Rules For Data Integrity

```txt
Never require MCP for ordinary shelf/story/database creation.
Never require Qdrant to create or open a shelf.
Never write imported source material straight to canon without preview, unless the user explicitly chooses fast import.
Never mutate shared shelf canon from story play without explicit promotion or shared timeline mode.
Always preserve original source evidence for imported records.
Always show preview before destructive import/export/replace operations.
Always support rollback/export before replacing a shelf database.
Always keep existing story data during migration.
```

---

## 23. Developer Checklist

Before committing:

```txt
[ ] Existing app boots.
[ ] Migration creates default shelf for old stories.
[ ] Shelf Library loads.
[ ] Shelf Dashboard loads.
[ ] Create shelf works.
[ ] Create story inside shelf works.
[ ] Existing story opens from shelf.
[ ] SillyTavern lorebook preview works.
[ ] Canon Review prevents accidental write.
[ ] Create Shelf Database works.
[ ] Qdrant offline path is non-fatal.
[ ] Vault/wiki sync failures become retryable warnings.
[ ] Story overlay model is not confused with shared shelf canon.
[ ] Mobile nav reaches System tools.
[ ] Error boundary prevents blank-screen failure.
[ ] Unit tests pass.
[ ] E2E smoke tests pass.
[ ] Build passes.
```

---

## 24. What Not To Do

```txt
Do not copy SillyTavern UI wholesale.
Do not turn lorebooks into the final storage layer.
Do not make generated Obsidian Markdown the source of truth.
Do not require users to hand-author full database bundles.
Do not hide shelf/story distinction behind one overloaded Story object.
Do not allow one test story to mutate the shared shelf canon by accident.
Do not ship this without migration and import tests.
```

---

## 25. Desired End State

When finished, the user experience should feel like this:

```txt
Open Mtherios
  -> see named Shelves

Open Glassmarket shelf
  -> see shared database, sources, stories, jobs, settings

Import old SillyTavern lorebook
  -> preview source
  -> review draft canon
  -> create/update shelf database

Create Vaeron's Debt story
  -> story uses Glassmarket shelf database
  -> new events are story-only by default
  -> promote important discoveries back to shelf canon when desired

Create Mira's Coup story
  -> starts from same shelf database
  -> can diverge safely from Vaeron's Debt
```

Mtherios should feel like a library with rooms, not a sack of scrolls. Shelves hold worlds. Stories live inside them. Databases become understandable because the UI finally matches the architecture.
