# Mtherios

A terminal-run interactive fiction engine with a SvelteKit frontend and a full AI-driven living world simulation. The local Node process owns the app runtime, backend canon, Qdrant wiki search, and the syncable data root; the browser is the client.

## What It Does

Mtherios is an AI-powered narrative engine where every action updates a living world. Characters remember conversations, factions pursue goals, seasons change, and the story adapts to player choices through a multi-layered context and memory system.

## Key Features

### Narrative Generation
- Streaming AI narration with 16+ provider support (OpenRouter, OpenAI, Anthropic, Google, Ollama, LM Studio, and more)
- POV (first/second/third person), tense (past/present), and tone-adaptive system prompts
- Style review catches POV breaks, tense shifts, repetition, and pacing issues
- Full D&D dice integration with advantage/disadvantage, critical hits, and DC checks

### Living World Simulation
- **Classifier** extracts world state changes from every narration (characters, locations, items, relationships, conversations)
- **Faction simulation** with goals, resources (military/wealth/influence/information/morale), inter-faction relations, and territory
- **World simulation** runs every 2 chapters with plot injection, rumors, and faction actions
- **Season system** with deterministic effects on military, travel, and food supply
- **Time tracking** for in-story time progression

### Memory & Context
- **5-tier context assembly** scaled to model context window (8K to 1M tokens):
  - Scene (current location, present characters, equipped items)
  - Recent (uncovered chapter summaries)
  - World (arc summaries, unresolved threads, plot injection)
  - Procedural (CASS-inspired narrative rules with decay scoring)
  - Retrieved (AI-driven agentic retrieval with iterative search)
- **Chapter summarization** with automatic boundary detection
- **Arc condensation** groups chapters into higher-level narrative arcs
- **Conversation memory** tracks what NPCs learn from player interactions

### Lorebook System
- Auto-discovery of entities from narrative (characters, locations, items, factions, concepts, events)
- Keyword-based and always-on injection modes with priority scoring
- Mutable entity state (faction resources, character relationships, location connections)
- SillyTavern lorebook import support
- Relationship graph tracking connections between entities
- Agent-maintained Obsidian wiki export with immutable raw transcript sources, a maintainer schema, source trails, index/log pages, arcs, synthesis, relationships, rumors, meters, and agreements
- Terminal wiki-core scripts and server APIs for materializing backend story canon into versioned Obsidian vaults, indexing vaults into Qdrant, semantic searching, and following Obsidian links/backlinks
- Server-owned story catalog: the frontend refreshes stories from the terminal process, deletes backend-bound stories and their generated vault/index artifacts through `/api/stories/:id`, and binds new/imported stories into backend canon by default

### Player Experience
- Action types: Do, Say, Think, Story, Free-form
- Shorthand commands (`l` look, `i` inventory, `n/s/e/w` movement, `x` examine)
- Contextual action suggestions and branching choice cards
- World state drawer (characters, locations, items, quests)
- Story branching with checkpoints and rollback
- Scene image generation

### Vault (Reusable Assets)
- Save and reuse characters, lorebooks, and scenarios across stories
- Import/export with tagging and favorites

## Tech Stack

- **App process:** Node/SvelteKit adapter started by `server.js`
- **Frontend:** SvelteKit, Svelte 5, TailwindCSS
- **Local canon:** Postgres/pgvector via Docker for backend-bound stories
- **Browser cache:** IndexedDB via Dexie.js for local/offline compatibility
- **Lore search:** Obsidian markdown vaults indexed into Qdrant
- **AI:** OpenAI-compatible chat completions API with Zod schema validation
- **Architecture:** Singleton service registry, reactive stores ($state/$derived/$effect), per-service model/temperature/token configuration

## AI Services (13 total)

| Service | Purpose |
|---------|---------|
| Narrative | Main story generation (streaming) |
| Classifier | World state extraction from narration |
| Memory | Chapter summarization and retrieval decisions |
| Suggestions | Contextual action suggestions |
| Action Choices | Branching decision points |
| Style Reviewer | Narrative quality checks |
| World Simulation | Living world plot injection and faction simulation |
| Arc Condensation | Chapter-to-arc summarization |
| Procedural Memory | CASS-inspired narrative pattern learning |
| Entry Retrieval | Keyword-based lorebook retrieval |
| Agentic Retrieval | AI-driven iterative context search |
| Lore Management | Lorebook entry discovery and curation |
| Image Generation | Scene image creation |

Each service supports independent model, temperature, max token, and system prompt overrides.

## Supported Providers

OpenRouter, NanoGPT, Chutes, Pollinations, Ollama, LM Studio, llama.cpp, NVIDIA NIM, OpenAI, Anthropic, Google, xAI, Groq, ZhiPu, DeepSeek, Mistral, and any OpenAI-compatible endpoint.

## Getting Started

```sh
# Install dependencies
npm install

# Start the terminal-owned app process in development
npm run app:dev

# Or on Windows
Start.bat

# Build for production
npm run build

# Run the built terminal-owned app
npm run app:start
```

`npm run app:dev` starts Postgres and Qdrant, runs database migrations, initializes `data/`, launches the frontend as a child process, and drains server-side background jobs from the terminal process. Those jobs now create deterministic chapter checkpoints and arc rollups from backend canon, update faction pressure from canonical events, convert high-pressure factions into terminal-owned world tick events, materialize backend stories into generated Obsidian vaults, then project the results into memory nodes for retrieval. `npm run dev` still exists for quick frontend work, but it is no longer the preferred way to run the whole system.

Runtime defaults live in [mtherios.config.example.json](mtherios.config.example.json). Copy it to `mtherios.config.json` when you want to change ports, the syncable data root, Qdrant URL, the default Obsidian vault path, wiki embedding model, story-vault auto-indexing, terminal memory cadence (`chapterThreshold`, `postChapterBuffer`, `chaptersPerArc`), or backend memory embeddings. Backend memory embeddings are disabled until `memoryEmbeddingProvider` and `memoryEmbeddingModel` are set, and the model must produce the configured `memoryEmbeddingDimensions` for the Postgres `memory_nodes.embedding` column.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codebase documentation including data flows, type definitions, service internals, and design decisions.

See [docs/local-wiki-core.md](docs/local-wiki-core.md) for the terminal-first Obsidian + Qdrant wiki workflow.
