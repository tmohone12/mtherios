# Node Event Timeline Engine Design

Date: 2026-06-02
Status: draft for user review

## Purpose

Mtherios should move from a memory-heavy browser-assisted game loop to a terminal-owned Node game engine. The browser is a frontend and control surface. The terminal process owns API calls, provider settings, canon writes, world creation, delayed events, NPC updates, background jobs, and server storage.

The central design change is that canonical world memory becomes event-based. The game master queries a compact timeline of events, NPC links, faction links, places, threads, and due proposals instead of stuffing a large undifferentiated memory packet into every turn.

## Evidence From Current Code

The current repo already has the right outer shell:

- `server.js` starts the terminal app process through `scripts/mtheriosd.mjs`.
- `scripts/mtheriosd.mjs` initializes the data root, runtime env, Postgres/Qdrant settings, and backend job worker.
- `/api/turn` routes into `src/lib/server/turn/orchestrator.ts`.
- Postgres already stores `stories`, `story_entries`, `entities`, `factions`, `npc_beliefs`, `story_events`, `memory_nodes`, `backend_jobs`, and API call logs.
- `src/lib/server/jobs/processor.ts` already projects events into memory nodes, updates faction pressure, creates chapter checkpoints, rolls up arcs, runs world ticks, and syncs story vaults.

SillyTavern's useful architecture signal is ownership, not a framework mandate. SillyTavern runs a Node server, registers API routers for characters/chats/world info/provider generation, and optionally loads server plugins under `/api/plugins/<id>`. Mtherios should borrow the server-owned endpoint model while keeping the current SvelteKit route shell for the first phase.

## Recommended Runtime Architecture

Keep the current SvelteKit HTTP route shell in phase one. Move game authority into server-only Node modules under `src/lib/server` and the terminal app process.

```text
UI -> terminal API -> game engine -> Postgres canon -> projections
```

Rules:

- The UI renders, inspects, edits through APIs, and queues offline commands when needed.
- The UI does not own canon, provider calls, memory assembly, event scheduling, NPC updates, or world creation.
- Browser services become API clients or UI helpers.
- Server modules own provider calls, structured validation, timeline queries, delayed events, event-linked NPC memory, world creation, and projections.
- Postgres is canon. Transcript entries are evidence. Memory nodes, generated wiki vaults, and Qdrant are projections.

Alternatives considered:

1. Keep SvelteKit shell and move game logic server-side. This is recommended because the repo is already halfway there and it lets the event model improve first.
2. Replace the API shell with a plain Express server. This is closer to SillyTavern but spends the first phase replacing routing before improving the living-world model.
3. Run a separate Express game server beside SvelteKit. This isolates the engine but adds runtime complexity and duplicate API edges.

## Canon Timeline Model

Events become the primary world-history object. `memory_nodes` stop being the thing the GM depends on and become a derived retrieval/search projection.

Proposed event shape:

```text
event {
  id
  storyId
  type
  title
  body
  status: planned | due | committed | cancelled | expired
  visibility: public | player_known | secret | gm_only
  createdTurn
  occurredTurn
  scheduledTurn
  worldTime
  actorNpcIds
  targetNpcIds
  factionIds
  locationIds
  threadIds
  sourceEntryIds
  sourceEventIds
  sourcePatchIds
  consequences
  memoryImpact
  metadata
}
```

Turn-first time is the initial model:

- Every story has `currentTurn`.
- Every event can have `createdTurn`, `occurredTurn`, and `scheduledTurn`.
- Optional world calendar fields remain available for day/hour/season.
- A request like "fires in two turns" becomes `scheduledTurn = currentTurn + 2`.

Delayed events:

- Low-impact events can auto-commit when due, such as weather shifts, travel progress, rumor spread, faction pressure, and background preparation.
- High-impact events become due proposals first, such as marriages, wars, deaths, betrayals, major reveals, faction mergers, and irreversible NPC turns.
- The GM can query due proposals and decide whether to surface them in narration.
- The validator commits the final canon event after narration or explicit acceptance.

## GM Timeline Queries

The turn engine should build a compact GM brief by querying specific slices:

```text
What is due this turn?
What recently happened near this location?
What events involve present NPCs?
What does this NPC know, suspect, or falsely believe?
What hidden pressures involve this faction?
What open proposals are waiting for narration or approval?
What unresolved events are tied to this thread?
```

This replaces a large prompt packet with a typed, bounded event packet.

The GM brief should contain:

- Current scene and player action.
- Due events and due proposals.
- Present NPC briefs derived from event links.
- Relevant visible timeline facts.
- Relevant hidden GM-only pressures.
- Open threads and nearby faction pressures.
- Strict rules and guardrails.

## NPC Event Memory

NPC memory is derived from event links, not from long summaries.

Proposed link shape:

```text
npc_event_link {
  id
  storyId
  npcId
  eventId
  relation: actor | target | witness | heard_about | inferred | affected
  knowledge: known | suspected | false_belief | secret
  learnedTurn
  confidence
  sourceNpcId
  sourceEntryIds
  metadata
}
```

NPC state should keep stable, queryable fields:

```text
npc {
  id
  storyId
  name
  role
  factionIds
  locationId
  status
  publicProfile
  privateProfile
  goals
  fears
  loyalties
  secrets
  disposition
  relationships
  knowledgeState
}
```

Validation rule: if an NPC belief, relationship, disposition, or loyalty changes, the update must cite an event or source entry. If no evidence exists, the change should remain a proposal or warning rather than canon.

## World Creation

World creation should produce a server-owned database, not a prompt blob.

Input shape:

```text
world_blueprint {
  title
  genre
  tone
  calendar
  rules
  seedPrompt
  desiredFactions
  desiredNpcs
  desiredLocations
  startingSituation
}
```

Creation flow:

```text
create world
-> create factions, locations, NPCs, and relationships
-> seed initial public events
-> seed hidden plans and scheduled events
-> create first scene
-> set currentTurn = 0
```

The result should be an importable/exportable world database bundle and an immediately playable first scene.

## Service Conversion

Server engine services:

- Turn engine.
- Provider/API call service.
- Event scheduler.
- GM event query service.
- World creation service.
- NPC state updater.
- Faction/world tick planner.
- Validation and patch service.
- Projection/index jobs.

Frontend client services:

- Call terminal APIs.
- Render story, world database, and timeline.
- Show settings and API-call logs.
- Queue offline commands if needed.

`WorldSimulationService` should become a server-side planner that creates planned events, due proposals, and low-risk committed world ticks. It should not directly rewrite large memory prompts. `backendMemory.ts`, `story.svelte.ts`, and browser AI services should become API clients or compatibility surfaces over the server engine.

## Turn Data Flow

Old flow:

```text
recent transcript + lore + memory packet + world state -> giant prompt -> narrator
```

New flow:

```text
player action
-> persist action
-> advance server turn clock
-> query due events
-> query scene events
-> query NPC/faction/location event links
-> build compact GM brief
-> narrate
-> extract and validate state changes
-> commit events, NPC links, faction changes, and state patches
-> update projections
```

## Migration Phases

### Phase 1: Server-Owned Event Timeline

Add the new timeline schema, event query service, delayed event scheduler, NPC-event links, and server `currentTurn`. Keep existing routes working, but make `/api/turn` build prompts from event queries instead of large memory packets.

### Phase 2: Service Conversion

Move browser AI/world services into server engine modules. Browser services become thin API clients. Provider settings, provider calls, and API logs stay server-side.

### Phase 3: World Creation

Add a world creation API that creates factions, locations, NPCs, initial relationships, seed events, hidden plans, and the first playable scene.

### Phase 4: Memory Demotion

Keep `memory_nodes`, generated wiki vaults, and Qdrant as projections. They can help search and admin inspection, but they do not decide canon and are not required in every turn prompt.

### Phase 5: Optional Express Split

If SvelteKit becomes a bottleneck, move to a SillyTavern-style Express server and serve Svelte as static assets. This is not required for the first working refactor.

## Risk Controls

- No silent high-impact canon commits.
- Every due event has a status and visibility.
- Every NPC belief or attitude change cites an event or source entry.
- Memory projections can be rebuilt from events.
- Prompt packets have explicit section and token limits.
- Server tests cover scheduling, due-event queries, NPC event links, and turn prompt assembly.
- Existing backend-bound stories migrate through compatibility fields instead of being discarded.
- Existing `story_events` can be migrated into the richer timeline with default status and turn fields.

## First Implementation Target

The first implementation plan should focus on a narrow but meaningful slice:

1. Add timeline/event-link schema fields and migrations.
2. Add a server event query service.
3. Add delayed-event scheduling and due-event promotion.
4. Change `/api/turn` prompt assembly to use a compact GM brief from event queries.
5. Add focused tests for scheduling, due queries, NPC event links, and prompt packet size.

This target moves the app toward the requested end state without replacing the entire web server first.

## Review Questions

The current defaults are:

- Phase one keeps SvelteKit as the API shell.
- The terminal Node process owns all game-engine authority.
- Time is turn-first with optional world calendar fields.
- Due events use a hybrid canon model: low-risk auto-commit, high-impact proposals.
- NPC memory is event-linked and evidence-backed.
- Memory nodes, wiki, and Qdrant are projections.

These defaults should be changed before implementation only if the project needs a hard Express migration first, pure auto-commit world simulation, or hidden events that cannot exist until revealed.
