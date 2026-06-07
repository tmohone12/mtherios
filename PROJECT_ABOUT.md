# Mtherios Project About

Last updated: June 6, 2026

## What Mtherios Is Becoming

Mtherios is being refactored into a terminal-owned text RPG engine with a browser control surface.

The important architecture change is authority. The Node terminal process should own campaign storage, API calls, AI orchestration, prompt assembly, cache, event scheduling, and canonical state. The Svelte frontend should stop acting like the game engine. Its job is to show the current projection, send player commands, display streamed progress, and keep a small local cache or offline queue.

This is still a text RPG. Characters still need personality, appearance, relationships, voice, goals, and memory. The refactor is not about making the story thinner. It is about making the long campaign cheaper to run, easier to query, and less likely to collapse under a giant browser-side story blob.

## Target Runtime Shape

```text
API gateway / SSE stream / future WebSocket
        |
        v
CLI and shell commands
        |
        v
AI orchestrator
        |
        +--> DM / Narrator Agent
        +--> Rules Referee Agent
        +--> State Scribe Agent
        +--> Lorekeeper Agent
        +--> Faction Simulator Agent
        +--> NPC Memory Agent
        +--> Continuity Auditor Agent
        |
        v
Campaign database and vault
        |
        +--> Event log
        +--> Current state snapshots
        +--> Lore graph
        +--> Vector memory index
        +--> Rules packs
        +--> Character sheets
        +--> Timers, clocks, and schedules
```

The frontend should use the same backend command surface as the CLI and shell tools. There should not be a separate browser-only turn engine.

## Storage Model

The long-campaign storage target is hybrid Markdown plus database.

Postgres remains the query, index, lock, and snapshot layer. Markdown becomes the durable campaign vault layer:

- raw append-only turn and event evidence
- character pages
- faction pages
- lore pages
- rules pages
- schedules and clocks
- chapter, arc, and saga summaries
- manifest hashes and source metadata

Raw evidence should be append-only. Derived pages can be maintained and rewritten from canonical state. Qdrant and other vector stores are indexes over the source material, not canon.

## Event-Based World Memory

The campaign should move away from loading huge memory blocks every turn.

The engine should store events on a timeline and let agents query the relevant slice. Events can be tied to NPCs, factions, places, lore objects, and clocks. They can have in-world delays, such as a faction alliance forming two turns after a marriage negotiation.

This lets the world feel alive without forcing every old transcript entry into the prompt. NPC memory should come from tagged events, derived character pages, and selected recent context, not from one giant story history.

## Prompt And Generation Efficiency

The first cache layer is app-level prompt and context caching.

Cacheable segments include:

- stable system prompts
- rules packs
- tool schemas
- character sheets
- faction briefs
- lore briefs
- retrieved Markdown chunks
- retrieved memory packets
- tool outputs

Invalidation should be based on source file hashes, record versions, and dependency lists. Provider prompt-cache hints can be used when available, but the engine should not depend on any one provider's runtime KV cache.

The practical generation-speed goal is smaller prompt assembly, fewer redundant retrievals, cache hit diagnostics, and bounded state projections. True local model KV/session management is a later layer after this app-level cache is stable.

## Frontend Role

The Svelte app is becoming a control surface.

It should load:

- story summary
- current state projection
- recent transcript page
- counts and status metadata
- cache and engine diagnostics

It should not require all entries to be loaded into `this.entries` before the player can use the app. Transcript browsing should be paged or virtualized from backend projections. Dexie should remain as a UI cache and offline command queue, not the owner of backend-bound story canon.

## Current Refactor State

Recent backend-focused work has added or expanded:

- shared engine command gateway at `/api/engine/command`
- engine SSE stream at `/api/engine/stream`
- campaign projection endpoints
- campaign vault read/write services
- prompt segment cache with hit, miss, token, and invalidation stats
- backend turn routing through the shared command surface
- raw turn evidence append hooks
- timeline and NPC event-link helpers
- orchestrator role definitions for the future sub-agent split
- bounded frontend transcript windows for backend-bound stories
- CLI-facing engine commands under `scripts/app-engine.mjs`
- MCP-facing engine tools under `scripts/mtherios-mcp.mjs`

This has mostly been backend work by design. The frontend is being changed only where it must stop owning large campaign state or where it needs to display backend projections.

## Transitional Risks

The codebase still contains older browser-first paths. Some of them are retained for compatibility with local-only stories. The main risk is accidentally letting those paths keep acting as the primary engine for backend-bound campaigns.

Known transition pressure points:

- stale frontend sync status can make the UI look disconnected after backend recovery
- initial engine stream projection can be bulky if transcript row metadata is too large
- old Dexie-owned story loading code still exists for local-only stories
- full multi-agent orchestration is scaffolded but not complete
- true provider/runtime KV cache management is deferred

## Direction

The next milestones should keep pulling authority into the terminal engine:

1. Keep `/api/engine/command` as the shared control surface for frontend, CLI, shell, and MCP.
2. Make `turn.submit` produce raw Markdown evidence, indexed events, current snapshots, and bounded projection changes.
3. Shrink streamed projection payloads so the frontend receives summaries and pages, not bulky history.
4. Move NPC and faction continuity toward tagged event queries and maintained Markdown pages.
5. Add generation-speed diagnostics to every turn: selected segments, cache hits, cache misses, prompt tokens, response tokens, and slow service timings.
6. Only after the app-level cache is stable, add provider-specific prompt cache hints and local model KV/session management.

