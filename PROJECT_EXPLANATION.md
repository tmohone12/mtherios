# Project Explanation: Mtherios

## What This Project Is

Mtherios is a browser-based AI interactive fiction engine. It lets a player create and continue stories where the world reacts to their actions: characters remember events, locations and items change, factions move in the background, and the narrative can be guided by lorebook entries, world state, summaries, and AI-generated suggestions.

The project is built as a SvelteKit single-page web app. It runs primarily in the browser and stores data locally in IndexedDB through Dexie, so it does not require a custom backend server for normal use. AI calls are made through OpenAI-compatible providers configured by the user.

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
- Dexie.js and IndexedDB for local persistence.
- Zod for AI response schema validation.
- Vitest for unit tests.
- OpenAI-compatible APIs for narrative generation, world simulation, embeddings, image generation, and supporting AI services.

The important npm scripts are:

```sh
npm run dev
npm run build
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

## Local-First Design

Mtherios is designed to run without a project-specific backend. Story data, settings, lore, images, embeddings, and world state are stored locally in IndexedDB. This makes the app portable and private by default, while still relying on external AI providers when generation is requested.

## How To Run It

Install dependencies and start the development server:

```sh
npm install
npm run dev
```

For validation:

```sh
npm run check
npm run test
npm run build
```

## Short Summary

Mtherios is a local-first SvelteKit app for AI-driven interactive fiction. Its main idea is that a story should not be only a chat transcript: it should become a persistent simulated world with memory, lore, factions, relationships, time, consequences, and player agency.
