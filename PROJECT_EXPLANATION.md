# Project Explanation: Mtherios

## What This Project Is

Mtherios is an AI-driven interactive fiction and living-world simulation app.
The player writes actions, the AI narrates the result, and the app turns those
results into durable world state: characters, locations, items, factions,
relationships, promises, debts, rumors, plot threads, memories, and player
resources.

The important idea is that a story is not just a chat transcript. The
transcript is evidence. The app extracts structured facts from that evidence
and uses those facts to keep the world coherent over long play.

## The Core Mental Model

Think of Mtherios as three layers working together:

1. The play surface: the user writes, reads narration, opens drawers, edits
   lore, and manages the story.
2. The world model: code stores structured facts about the world, including
   entities, factions, agreements, memories, and player ledger notes.
3. The AI layer: prompts, retrieval, tools, and validators ask models to
   narrate, summarize, extract state, and suggest future motion.

For local-only stories, IndexedDB is the working store. For backend-backed
stories, the backend database is the canonical truth, while IndexedDB acts as a
local/offline cache.

The intended canon pattern is:

```text
transcript evidence -> AI proposes structured changes -> code validates and merges -> durable canon
```

That means a line of narration can become a real record: a new NPC, a changed
location, a broken oath, a faction membership, a rumor, a faction goal, or a
ledger change.

## What The Player Experiences

The app opens into a SvelteKit interface where the player can create or open a
story, type an action, and receive generated narration. The player can also
inspect and edit world state through story controls, the lorebook, the world
drawer, settings, and import/export tools.

The story UI supports several action styles:

- Do: physical action.
- Say: dialogue.
- Think: private thought.
- Story: direct authorial instruction.
- Free-form: raw input without prefixing.

As the story continues, Mtherios tracks:

- The ordered transcript of player actions and narration.
- Characters, locations, and items.
- Lorebook/wiki entries for characters, factions, places, items, concepts, and events.
- Conversations and what NPCs learned.
- Relationships between entities.
- Agreements, promises, debts, oaths, marriages, treaties, and bargains.
- Faction resources, goals, membership, standings, and off-screen moves.
- Rumors, schemes, story threads, world events, chapters, and arcs.
- Player-facing resources through the player ledger.
- Optional generated images attached to story entries.

## Technology Stack

The project is a SvelteKit app written in TypeScript.

Main technologies:

- SvelteKit and Svelte 5 for the app and UI.
- TypeScript for domain logic.
- TailwindCSS for styling.
- Dexie.js and IndexedDB for browser persistence.
- Drizzle ORM and Postgres for the optional backend canon path.
- Zod for validating AI/tool payloads.
- Vitest for tests.
- OpenAI-compatible and provider-specific AI SDKs for model calls.

Important npm scripts:

```sh
npm run dev
npm run dev:backend
npm run check
npm run test
npm run build
npm run backend:up
npm run backend:migrate
npm run backend:health
```

## Local-First And Backend-Backed Modes

Mtherios can run as a local-first browser app. In that mode, story data lives in
IndexedDB and API provider settings are configured by the user in the app.

The newer backend path adds a server-side canon store. It is useful for longer
stories because it can keep structured state, memory nodes, source links, and
sync changes in a more authoritative place.

In backend-backed mode:

- The browser sends a turn request to `/api/turn`.
- The backend writes the player entry.
- The backend retrieves relevant memory.
- The backend builds the server prompt.
- The model narrates.
- A structured extractor proposes world-state updates.
- The validator writes state patches, entities, events, memory nodes, and other canon records.
- The browser mirrors the returned entries and sync metadata back into IndexedDB.

In plain language: the backend is truth, the transcript is evidence, and code is
the referee that decides what gets merged into canon.

## AI Turn Flow

A normal local generation turn works roughly like this:

1. The player submits an action in `ActionInput.svelte`.
2. The story store builds a structured snapshot of the current world.
3. Prompt sections are assembled and budgeted.
4. The narrative model streams narration.
5. Inline tools or a follow-up classifier extract world-state changes.
6. The executor merges those changes into IndexedDB.
7. Background jobs may summarize chapters, update procedural memory, generate
   plot momentum, run world simulation, or prepare embeddings.

A backend generation turn follows a similar shape, but the server owns the
canonical write path through the turn orchestrator and patch validator.

## Prompt And Memory Design

Prompt construction is a major part of the project. The app tries to give the
model enough context to stay coherent without dumping the entire story every
turn.

Important prompt inputs include:

- Current scene: location, present characters, equipped items, time, meters.
- Player reputation and player ledger.
- Relevant factions and faction pressure.
- Retrieved lorebook/wiki context.
- Conversation memory and actor belief limits.
- Agreements and obligations.
- Open plot ledger, threads, schemes, and world events.
- Selected chapter/arc memory.
- Backend memory packets when available.
- Procedural narrative rules.

The app uses token budgeting to keep these sections bounded. This matters
because long stories can accumulate far more context than a model should see at
once.

## Living World Systems

The living world is the part that makes the app more than a chat frontend.

Key systems:

- Factions: goals, resources, territories, known members, player standing, and inter-faction relations.
- Agreements: active and past commitments such as promises, oaths, debts, treaties, bargains, and marriages.
- Player ledger: user-editable material state such as coin, income, assets, holdings, debts, payroll, claims, stores, ships, paid troops, and recurring expenses.
- Rumors: uncertain information that can travel through the world.
- Schemes: plans by NPCs or factions that can progress over time.
- Story threads: open narrative problems or opportunities.
- World events: source-linked consequences from previous turns.
- Chapters and arcs: summarized long-term memory.
- Procedural rules: learned narrative patterns and anti-patterns.

These records are meant to be queryable and durable, not just prose the model
has to remember.

## Lorebook And Wiki Layer

The lorebook stores reusable world knowledge. Entries can represent:

- Characters
- Locations
- Items
- Factions
- Concepts
- Events

Entries can have aliases, keywords, hidden information, injection settings, and
type-specific mutable state. The retrieval layer can pull relevant entries into
the prompt so the model sees only the lore that matters for the current turn.

The server path also has a compact wiki context step, so durable lorebook facts
can help backend narration without requiring the prompt to include the whole
wiki.

## Data Model

The main domain types live in `src/lib/types/index.ts`.

Important local records include:

- `Story`
- `StoryEntry`
- `Character`
- `Location`
- `Item`
- `Entry` for lorebook records
- `EntryRelationship`
- `ConversationMemoryEntry`
- `WorldEvent`
- `Agreement`
- `RumorRecord`
- `FactionActionRecord`
- `Scheme`
- `StoryThread`
- `Chapter`
- `Arc`
- `ProceduralRule`
- `EmbeddedImage`

The browser database is managed by `src/lib/services/database.ts`.

The backend database schema lives in `src/lib/server/db/schema.ts` and includes
server-side tables for stories, entries, entities, aliases, factions,
relationships, agreements, threads, events, beliefs, memory nodes, state
patches, and sync operations.

## Codebase Map

Top-level docs:

- `README.md`: quick feature and setup overview.
- `ARCHITECTURE.md`: broad technical reference.
- `PROJECT_EXPLANATION.md`: this plain-language project guide.
- `SCHEME_SERVICE_SPEC.md`: details for the scheme system.

Main app folders:

- `src/routes/`: SvelteKit pages and API routes.
- `src/lib/components/`: UI components.
- `src/lib/stores/`: reactive stores for app, settings, and story state.
- `src/lib/services/`: persistence, AI services, import/export, sync, and background work.
- `src/lib/services/ai/`: model-facing services, tool schemas, retrieval, memory, generation, and world simulation.
- `src/lib/server/`: backend database, routes, memory, sync, and turn processing.
- `src/lib/types/`: shared domain types.
- `src/lib/utils/`: helper utilities.
- `src/lib/data/seeds/`: bundled seed packs.
- `docs/`: planning and implementation notes.

## Important Files

- `src/lib/stores/story.svelte.ts`: the central local story store. It loads
  story data, builds snapshots, assembles prompts, applies updates, and manages
  local world state.
- `src/lib/components/story/ActionInput.svelte`: player input and generation
  orchestration from the UI.
- `src/lib/components/story/StoryView.svelte`: main play surface and story
  controls.
- `src/lib/components/story/WorldDrawer.svelte`: inspectable world-state panel.
- `src/lib/services/ai/tools/schemas.ts`: structured tool schemas for world
  updates.
- `src/lib/services/ai/tools/executor.ts`: applies local tool output to the
  browser database.
- `src/lib/services/ai/context/ContextBudgetService.ts`: budgets prompt
  sections.
- `src/lib/services/ai/context/storyMemorySelector.ts`: selects chapter/arc
  memory for prompts.
- `src/lib/server/turn/orchestrator.ts`: backend turn pipeline.
- `src/lib/server/turn/promptPacket.ts`: backend server prompt construction.
- `src/lib/server/turn/patchValidator.ts`: validates and merges structured
  backend world-state updates.
- `src/lib/server/memory/retrieval.ts`: backend memory retrieval.
- `src/lib/server/memory/canonical.ts`: backend import, sync, and canonical
  story operations.
- `src/lib/server/db/schema.ts`: backend database schema.

## How To Run It

Install dependencies:

```sh
npm install
```

Run the local app:

```sh
npm run dev
```

Run with the backend database path:

```sh
npm run backend:up
npm run backend:migrate
npm run dev:backend
```

Validate the project:

```sh
npm run check
npm run test
npm run build
```

## What To Know Before Changing It

- The story store is large and central. Read the nearby prompt and snapshot
  code before patching it.
- Do not treat transcript text as the only source of truth. Durable state should
  go into typed records when possible.
- Keep prompt additions budgeted. Every always-on section becomes recurring
  token cost.
- AI tool output is untrusted input. Validate and merge it through schemas and
  helper logic.
- Backend-backed stories should preserve the pattern: backend truth, transcript
  evidence, code validates and merges.
- Avoid committing local story artifacts, prompt scratch files, API keys, or
  provider secrets.

## Short Summary

Mtherios is a SvelteKit interactive fiction engine that turns AI narration into
a persistent simulated world. Its goal is long-form play where memory, lore,
factions, obligations, resources, relationships, and consequences survive
beyond the current prompt window.
