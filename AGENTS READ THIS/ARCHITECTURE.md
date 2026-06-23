# Mtherios Architecture

Mtherios is a SvelteKit app served by a terminal Node process. The terminal process owns backend canon, model routing, jobs, generated markdown vaults, and local service integrations. The browser renders and controls the system.

## Runtime Shape

```text
Browser UI
  -> SvelteKit API routes
  -> terminal Node runtime
  -> Postgres backend canon
  -> generated markdown vaults
  -> Qdrant / pgvector indexes
  -> frontend projection
```

The browser should not duplicate the engine. It sends commands, receives streams/projections, and exposes controls.

## Main Layers

### Frontend Control Surface

Main paths:

- `src/lib/components/`
- `src/lib/stores/`
- `src/routes/`

Responsibilities:

- story library and play UI
- settings and model controls
- projection display
- diagnostics and repair surfaces
- local cache/offline compatibility

Do not make the frontend the source of canon for backend-bound stories.

### API And Engine Routes

Important routes:

- `/api/turn`
- `/api/engine/command`
- `/api/engine/stream`
- `/api/stories/*`
- `/api/wiki/*`
- `/api/jobs/*`
- `/api/small-brain/run`

Routes should be thin: validate input, call server service, return JSON.

### Backend Canon

Main schema:

- `src/lib/server/db/schema.ts`

Important tables:

- `stories`
- `story_entries`
- `entities`
- `relationships`
- `factions`
- `facts`
- `story_events`
- `memory_nodes`
- `patch_proposals`
- `source_refs`
- `continuity_warnings`
- `backend_jobs`

Canonical writes need source IDs and validation. Generated markdown and indexes can be rebuilt from these rows.

### AI Runtime

Important paths:

- `src/lib/server/turn/provider.ts`
- `src/lib/server/turn/orchestrator.ts`
- `src/lib/server/turn/promptPacket.ts`
- `src/lib/server/engine/llmSettings.ts`
- `src/lib/services/ai/sdk/`

Current direction:

- server-owned generation path for backend-bound stories
- strict schemas for structured output
- provider capability detection
- prompt caching telemetry
- replay evaluation harness

### Small Brain Service

Path:

- `src/lib/server/engine/smallBrain.ts`
- `src/routes/api/small-brain/run/+server.ts`

Role:

- cheap context gathering
- canon proposal drafting
- world intent drafts

It is proposal-only. It never writes canon directly.

### Jobs And Projections

Important paths:

- `src/lib/server/jobs/`
- `scripts/wiki-core/`
- `scripts/app-*.mjs`

Jobs handle work that should not block the player turn:

- story vault sync
- memory node projection
- chapter/arc/saga rollups
- wiki indexing
- optional embeddings
- faction/world updates

## Storage Model

```text
Postgres = authority
Markdown vault = readable projection
Qdrant / pgvector = rebuildable search index
IndexedDB = browser cache and compatibility
```

This distinction is non-negotiable for long campaigns.

## Prompt Architecture Direction

The current prompt layer should evolve into a section compiler:

```text
engine static
genre static
story static
turn dynamic
```

Each section should carry:

- ID
- lane
- priority
- token budget
- content hash
- source IDs
- inclusion/skipping reason

Stable sections go first. Dynamic player action and recent scene data go last.

## Evaluation Direction

Keep unit prompt tests, but add replay evaluation:

- continuity scenarios
- NPC knowledge leakage tests
- retrieval recall checks
- state patch precision checks
- prompt injection cases
- cost/latency/cache metrics

Evaluation belongs under server/test scripts, not in the frontend.

## Change Guidance

When adding a new engine feature:

1. Add or reuse a strict contract.
2. Keep the route thin.
3. Put logic in a server service.
4. Source-link durable outputs.
5. Return proposals/warnings before canon writes.
6. Add focused tests.
7. Expose settings if runtime behavior depends on them.

When in doubt, make the backend explain what it used and why.
