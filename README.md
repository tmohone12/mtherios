# MythEngine

Independent development working copy for the MythEngine overhaul.

- [Complete implementation plan](docs/mythengine-overhaul-plan-2026-09-21.md) — requirements, architecture, source owners, phased delivery, migrations, and acceptance gates.
- [Feature brief](<AGENTS READ THIS/NEWFEATURES.md>) — the supplied product reference.
- [Copy manifest](docs/evidence/mythengine-overhaul/working-copy-manifest.json) — source commit, file hashes, exclusions, and preserved development changes.

**Current status:** Phases 0–3 are implemented and live-verified. The content workspace now lists retained document, custom-type, built-in-type and canonical-record revisions, reviews concrete diffs, and restores approved historical content as a new revision. Type layout clearing also requires a revision-bound review. See the [Phase 3 completion report](docs/mythengine-phase3-complete-2026-09-22.md). Phase 4 (GM context modes and visibility) is next; Phases 4–12 remain planned. Three inherited prompt-budget test failures remain documented in the completion report.

Working directory: `E:\DEV\Projects\MythEngine`. Branch: `codex/mythengine-overhaul`. The original Mtherios checkout remains unchanged. The feature inventory below describes inherited functionality, not completion of the overhaul.

A terminal-run interactive fiction engine with a SvelteKit frontend and a full AI-driven living world simulation. The local Node process owns the app runtime, backend canon, Qdrant wiki search, and the syncable data root; the browser is the client.

## What It Does

MythEngine is an AI-powered narrative engine where every action updates a living world. Characters remember conversations, factions pursue goals, seasons change, and the story adapts to player choices through a multi-layered context and memory system.

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
- Snapshot imports rebuild search/vault projections without advancing factions or the plot; full-database record conflicts roll back the import instead of silently skipping data.
- Message deletion is transcript-only, not a world-state rewind. Restore a saved context checkpoint when earlier canon is needed.
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

## AI roles and tools

| Area | Purpose |
|---------|---------|
| GameMaster | Main story generation; World State, recall, actor decisions, and simulation are bounded tools/jobs |
| Memory & Context | Completed-turn extraction, chapter/arc/saga memory, lore management, and entry refinement |
| Player Guidance | Optional suggestions based on recent player-visible actions and narration |
| Authoring Assistant | Project and game authoring, including bounded batch helpers |
| Image Generation | Scene and character imagery |

Each task can inherit the GameMaster provider/model or retain an explicit specialist override. Jev can be configured for bounded NPC and faction decisions; it does not write story prose.

## Supported Providers

OpenRouter, NanoGPT, Chutes, Pollinations, Ollama, LM Studio, llama.cpp, NVIDIA NIM, OpenAI, Anthropic, Google, xAI, Groq, ZhiPu, DeepSeek, Mistral, and any OpenAI-compatible endpoint.

## Getting Started

On Windows, [Start.bat](Start.bat) offers separate startup choices for local Kev-9B decisions and Ollama/local embeddings. Press Enter at both prompts to leave local AI off and avoid loading these models. To start without prompts and with both off, run `pwsh -NoProfile -File .\start.ps1 -NoPrompt`. Add `-LocalKev` or `-LocalEmbeddings` to opt in explicitly. Direct Node startup supports `--local-kev` and `--local-embeddings`; both are off by default. With local embeddings off, exact wiki search remains available and stored vectors are retained.

```sh
# Install the pinned dependencies
npm ci

# Inspect the resolved targets without starting services
npm run app:config
npm run backend:config

# Start the separate database/vector services and migrate
npm run backend:up
npm run backend:migrate

# Build and run MythEngine at http://127.0.0.1:5174
npm run build
npm run app:start

# Or start development mode, including services/migrations
npm run app:dev
```

`npm run app:dev` starts the MythEngine Compose services, runs database migrations, initializes `data/`, and launches the frontend. Jobs and automatic wiki indexing/linting are disabled by default; enable them deliberately after configuring providers for the intended database. `npm run dev` starts Vite alone. `backend:down` stops only the MythEngine Compose project and retains its volumes.

Runtime defaults live in [mythengine.config.example.json](mythengine.config.example.json). Copy it to `mythengine.config.json` to customize them. Precedence is explicit CLI options, `MYTHENGINE_*`, legacy `MTHERIOS_*`/generic environment settings, the selected config file, then defaults. The new config filename wins over the old one; files are never merged. Original local service targets and paths outside this checkout are rejected unless `MYTHENGINE_ALLOW_SHARED_RUNTIME=true` is deliberately set. `app:config` reports effective targets without credentials.

Defaults: app `127.0.0.1:5174`, PostgreSQL `127.0.0.1:5433` (database/user `mythengine`), Qdrant `127.0.0.1:6335` (gRPC `6336`), collection `mythengine_wiki`, and data under this checkout. No campaign data or provider credentials are copied. Chapter cadence remains 20 completed turns per chapter and 10 chapters per arc. Backend memory embeddings remain disabled until configured.

New MCP integrations use `npm run app:mcp` and `mythengine_*` tools. Existing `mtherios_*` tools remain equivalent aliases without a removal date. Legacy save payloads, storage IDs, `.mtherios` vault manifests and the migration ledger remain readable; new story downloads use `.mythengine.json`. Browser storage is isolated by the new port, while compatibility database/key names are retained. Build provenance is recorded in `build/mythengine-build.json` and checked before production startup.

### iPhone / PWA access

`http://127.0.0.1:5174` is local to the device that opens it, so that address on an iPhone does not reach the PC. Keep MythEngine private: use a private HTTPS route such as Tailscale Serve to the local app, open that HTTPS URL in iPhone Safari, then choose **Share → Add to Home Screen**. HTTPS is required for service-worker offline support outside localhost.

The development server binds to `127.0.0.1` by default. LAN binding is opt-in with `MYTHENGINE_HOST=0.0.0.0`; only use it on a trusted network with firewall rules you understand. The installed app can reopen cached screens and locally available story/lore data, and Dexie drafts remain local. Narrative turns still require the terminal backend and are never queued or replayed offline.

## Generation Benchmark

With the app server running, benchmark terminal-owned generation jobs:

```sh
npm run bench:generation -- --story-id <server-story-id> --mode jobs --limit 10
```

Use `--mode world-sim` to force a manual terminal world tick, or `--mode turn --player-text "..."` to time a representative `/api/turn` request. The benchmark prints total duration, per-phase job timings when the endpoint returns them, model/API call count when API-call logs are available, and job completion counts. Structured phase logs are emitted as JSON unless `MYTHENGINE_GENERATION_TIMING=off`; bounded backend generation concurrency defaults to 4 and can be changed with `MYTHENGINE_GENERATION_CONCURRENCY`.

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full codebase documentation including data flows, type definitions, service internals, and design decisions.

See [docs/local-wiki-core.md](docs/local-wiki-core.md) for the terminal-first Obsidian + Qdrant wiki workflow.
