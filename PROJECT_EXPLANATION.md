# Project Explanation: Mtherios

## What This Project Is

Mtherios is a terminal-run AI interactive fiction engine with a browser frontend. It lets a player create and continue stories where the world reacts to their actions: characters remember events, locations and items change, factions move in the background, and the narrative can be guided by lorebook entries, world state, summaries, and AI-generated suggestions.

The project is built around a local Node app process started by `server.js`. That process initializes the data root, owns server environment, serves the SvelteKit frontend, exposes backend canon APIs, and brokers terminal-side wiki operations. IndexedDB remains as a browser cache and compatibility layer, while the story catalog, backend-bound turns, and large-world canon are moving to the server-owned local process plus a syncable data root.

## Main User Experience

The application opens into the Mtherios shell with panels for the story library, lorebook, world state, and settings. A user can create or open a story, enter actions, and receive generated narration. The story interface supports different action types such as doing, saying, thinking, story direction, or free-form input.

As the story progresses, the app keeps track of:

- Story entries, including player actions and AI narration.
- Characters, locations, and items.
- Lorebook entries for characters, factions, places, concepts, items, and events.
- Conversation memory and relationships.
- Agreements, rumors, faction actions, schemes, plot threads, chapters, and arcs.
- Optional generated images attached to story entries.

## Technology Stack

- SvelteKit and Svelte 5 for the frontend.
- TypeScript for application logic and types.
- TailwindCSS for styling.
- Node/SvelteKit adapter for the terminal app process.
- Postgres/pgvector for backend-bound canonical story state.
- Qdrant for local semantic wiki search.
- Dexie.js and IndexedDB for browser cache/offline compatibility.
- Zod for AI response schema validation.
- Vitest for unit tests.
- OpenAI-compatible APIs for narrative generation, world simulation, embeddings, image generation, and supporting AI services.

The important npm scripts are:

```sh
npm run dev
npm run app:dev
npm run build
npm run app:start
npm run check
npm run test
```

## Codebase Structure

The root documentation already includes deeper technical notes in `README.md`, `ARCHITECTURE.md`, and several planning documents. The main application code lives under `src/`.

- `src/routes/` contains the SvelteKit route entry points.
- `src/lib/components/` contains UI components for layout, story play, lorebook management, settings, onboarding, library, and world state.
- `src/lib/stores/` contains Svelte stores for global app state, active story state, and settings.
- `src/lib/services/` contains persistence, import/export, synchronization, AI services, and background processing.
- `src/lib/types/` defines the core domain types used across the app.
- `src/lib/utils/` contains small utilities such as dice rolling, UUIDs, tokens, and wikilinks.
- `src/lib/data/seeds/` contains seed data for an ASOIAF-style lorebook and factions.

## Core Data Model

The main persistent objects are defined in `src/lib/types/index.ts` and stored in IndexedDB by `src/lib/services/database.ts`.

At the center is a `Story`, which has settings, metadata, time tracking, branch information, optional meters, and links to many related records. A story is made of ordered `StoryEntry` records. Entries can represent player actions, narration, system notes, or retry markers.

The world is represented by related records such as:

- `Character`
- `Location`
- `Item`
- `Entry` for lorebook records
- `Chapter` and `Arc` for summarized long-term memory
- `Agreement`, `RumorRecord`, `FactionActionRecord`, `Scheme`, and `StoryThread` for living-world state
- `ConversationMemoryEntry` and `EntryRelationship` for social and lore relationships

The database schema is versioned in Dexie and has grown through several migrations, adding procedural memory, embeddings, relationships, world events, agreements, rumors, schemes, and story threads.

## State Management

The active story is managed by `src/lib/stores/story.svelte.ts`. This store loads all story-related records, keeps the UI reactive, updates entities after world-state changes, builds prompts, prepares snapshots for AI generation, and maintains context statistics.

The global app store in `src/lib/stores/app.svelte.ts` tracks onboarding, the current story ID, the wizard state, and high-level navigation.

The settings store in `src/lib/stores/settings.svelte.ts` persists user settings, API profiles, model choices, UI preferences, per-service AI configuration, translation options, and context limits.

## AI Architecture

AI services are exposed through singleton instances from `src/lib/services/ai/index.ts`. The services cover narrative support, memory, suggestions, action choices, style review, lore management, image generation, world simulation, arc condensation, procedural memory, embeddings, and wiki linting.

The current architecture has moved some older classifier and pipeline responsibilities into an orchestrator/tool approach. Tool schemas in `src/lib/services/ai/tools/schemas.ts` define structured updates such as characters, locations, items, conversations, relationships, story beats, meters, agreements, and lorebook entries.

In practice, a generation turn works roughly like this:

1. The player submits an action.
2. The story store builds a system prompt and conversation history from current state.
3. The AI generates narration.
4. Structured tool output updates the world state.
5. The app saves narration, world updates, suggestions, memory, and related records.
6. Background services can summarize chapters, condense arcs, run world simulation, update procedural memory, or prepare embeddings.

## Lorebook And Living World

The lorebook system is one of the central features. Lorebook entries can be imported, manually edited, refined by AI, retrieved for context, and used to keep the story grounded. Entries support types such as character, location, item, faction, concept, and event.

The living-world layer expands this beyond simple notes. It tracks faction resources, faction actions, rumors, agreements, schemes, story threads, relationships, and events. These records help the app maintain continuity and let off-screen world activity influence future narration.

The wiki export turns that state into an Obsidian-compatible knowledge base rather than a flat dump. Exported vaults now separate immutable raw transcript sources under `raw/` from the compiled wiki pages, include an `AGENTS.md` maintainer schema for future LLM sessions, and generate `index.md`, `log.md`, `synthesis.md`, arc pages, source trails, relationship tables, agreements, rumors, and meters. The intent is that the LLM can keep the wiki maintained over time while the raw source layer remains the evidence record.

The first terminal-side wiki core lives under `scripts/wiki-core/`. It can materialize a backend-bound story into an Obsidian-style markdown vault under `data/vaults/stories/<storyId>`, index that generated vault into a story-specific Qdrant collection through a local embedding endpoint, then support semantic search plus exact search, wikilink traversal, and backlink traversal. Each generated story vault includes `.mtherios/story-vault.json`, which records the backend `serverVersion` used to generate the markdown and, after indexing, the Qdrant collection/version that is fresh. Server routes under `/api/wiki/*` wrap these tools so the frontend and future agents can use the same terminal-owned search brain. A `sync_story_vault` backend job is queued after turn/import projection so the markdown lore vault follows backend canon without the browser manually exporting a zip; search, follow, and index requests also self-heal missing or stale generated vaults before reading. Full Qdrant re-indexing can be enabled with `wikiAutoIndexStoryVaults`, but defaults off to avoid expensive whole-vault embedding work on every turn. Deleting a backend-bound story deletes backend canon first, then cleans up the generated vault and attempts to remove the story-specific Qdrant collection. The GM `search_wiki` tool now tries that terminal wiki first and includes linked/backlinked page neighborhoods in tool results, falling back to the browser lorebook cache only when the terminal wiki is unavailable or has no matching pages. Backend story memory has a separate optional embedding worker for Postgres `memory_nodes`; it is disabled until a matching-dimension embedding provider is configured. The same terminal job loop also updates faction pressure from canonical events, converts high-pressure factions into deterministic world-tick events, and writes compact faction memory nodes for retrieval.

## Local-First Design

Mtherios is being refactored from browser-first local storage into a terminal-owned local app. The data root can live in a synced folder, Postgres holds canonical large-story state, generated Obsidian markdown holds durable lore projections, and Qdrant is a rebuildable semantic index. The frontend now refreshes its story list from `/api/stories`, deletes backend-bound stories through the terminal process, and imports new or transferred stories into backend canon by default. IndexedDB remains useful as a frontend cache and offline command queue, but it is no longer the intended ceiling for large worlds. When a backend-bound story reconnects, queued commands are pushed before projection pulls or new backend turns, and server sync operation IDs make retries safe.

## How To Run It

Install dependencies and start the development server:

```sh
npm install
npm run app:dev
```

For validation:

```sh
npm run check
npm run test
npm run build
```

## Short Summary

Mtherios is a local-first SvelteKit app for AI-driven interactive fiction. Its main idea is that a story should not be only a chat transcript: it should become a persistent simulated world with memory, lore, factions, relationships, time, consequences, and player agency.
