# Mtherios

A browser-based interactive fiction engine with a full AI-driven living world simulation. Built with SvelteKit, IndexedDB, and OpenAI-compatible APIs.

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

- **Frontend:** SvelteKit, Svelte 5, TailwindCSS
- **Storage:** IndexedDB via Dexie.js (no server required)
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

# Start development server
npm run dev

# Build for production
npm run build
```

Runs entirely in the browser. No backend server required -- just configure an API provider and start writing.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codebase documentation including data flows, type definitions, service internals, and design decisions.
