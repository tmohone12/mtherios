# About Mtherios

Mtherios is a local-first AI text RPG engine with a browser frontend and terminal-owned backend.

It is built for long campaigns where characters remember, factions act, secrets stay bounded, and the world can keep moving without loading the entire transcript into every model call.

## What The User Experiences

The player opens the app, chooses a story, types an action, and receives narration. They can inspect lore, world state, memories, jobs, settings, and diagnostics.

The desired experience is simple:

- play a text RPG
- keep continuity
- preserve agency
- make the world feel alive
- avoid giant prompt bloat

## What The System Is Doing

Behind the UI, Mtherios turns play into durable state:

```text
player action
  -> narration
  -> evidence
  -> proposed structured changes
  -> validated backend canon
  -> generated projections and search indexes
```

The backend tracks:

- characters
- locations
- factions
- facts
- events
- relationships
- memories
- chapters, arcs, sagas
- jobs and projections

## Technology

- SvelteKit / Svelte 5 frontend
- Node terminal app process
- TypeScript
- Zod contracts
- Drizzle ORM
- Postgres / pgvector
- Qdrant for wiki search
- Dexie / IndexedDB as browser cache
- Vitest
- OpenAI-compatible model providers

## Current Product Direction

The main work is moving Mtherios from a browser-heavy interactive fiction app into a terminal-owned engine.

Near-term priorities:

1. One canonical server prompt compiler
2. Real model-provider cache telemetry
3. Replay evaluation harness
4. Scene-aware context loading
5. Cheaper background/small-model workers
6. Better inspector surfaces for prompt, context, cache, and canon changes

## Why This Exists

Long AI campaigns usually fail because the system loses track of truth. Mtherios exists to make truth queryable.

The core belief:

```text
transcript = evidence
backend database = canon
markdown vault = readable projection
search index = rebuildable helper
browser storage = cache
```

## What To Avoid

Avoid:

- adding another independent generation path
- letting the browser own backend-bound story truth
- treating markdown or Qdrant as canon
- expanding prompts before measuring context
- writing canon from raw model output
- adding background agents into the critical turn path without need

## Success

Success is a campaign that can run for months, where:

- NPCs remember only what they learned
- factions act from resources and pressure
- secrets remain secret until revealed
- the narrator stays grounded
- the backend can explain every included context item
- state changes are reviewable and source-linked

Mtherios should feel like a persistent world with an engine under it.
