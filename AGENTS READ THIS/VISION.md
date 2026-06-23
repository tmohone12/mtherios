# Mtherios Vision

Mtherios is a local-first, terminal-owned text RPG engine for long campaigns. It should feel like a persistent world, not a chat wrapper with a large memory box.

The browser is the control surface. The terminal Node process owns canon, prompt assembly, model calls, jobs, indexes, and durable state.

## North Star

A campaign should run for thousands of turns while the world still makes sense.

The player types an action and receives vivid, grounded narration. Behind that moment, the engine should keep track of characters, factions, memories, secrets, clocks, promises, evidence, and consequences without stuffing the whole past into every prompt.

The final feeling:

```text
You are not chatting with a model.
You are playing inside a persistent world, and the machine under the table is quietly keeping score.
```

## Source Of Truth

Canon belongs in the backend.

- Transcript entries are evidence.
- Postgres backend canon is authoritative state.
- Generated markdown vaults are readable projections.
- Qdrant is a rebuildable search index.
- Browser IndexedDB is cache and compatibility, not the ceiling of the world.

Every durable claim should be source-linked. If an NPC learns a secret, a faction changes pressure, or a fact becomes true, the system should be able to explain where that came from.

## Current Strategic Direction

The intelligence layer should move away from one giant prompt path and toward a measured, inspectable runtime:

1. One canonical prompt compiler
2. Real provider caching and telemetry
3. Replay-based evaluation harness
4. Scene-aware context instead of blanket history
5. Fewer and cheaper secondary model calls

## Prompt Compiler Vision

Prompt construction should become section-based and budgeted:

```ts
type PromptLane = 'engine_static' | 'genre_static' | 'story_static' | 'turn_dynamic';

interface PromptSection {
  id: string;
  lane: PromptLane;
  priority: number;
  maxTokens: number;
  content: string;
  sourceIds: string[];
  contentHash: string;
}
```

The final prompt order should keep stable material first so provider caching can work:

1. Core engine rules
2. Tool and response schemas
3. Genre pack
4. Story bible and immutable canon
5. Current scene
6. Relevant characters and beliefs
7. Selected continuity facts
8. Recent dialogue
9. Player action

Genre-heavy instructions do not belong in the core engine. They should live in versioned packs such as `grimdark-feudal@2`, `mystery@1`, or `science-fiction@1`.

## Caching And Cost Vision

Caching should be measured, not hoped for.

The engine should track:

- input tokens
- cached input tokens
- cache write tokens
- output tokens
- reasoning tokens
- estimated cost
- time to first token
- total latency
- provider cache mode

Provider cache support should be capability-based:

```ts
type CacheMode =
  | 'openai_implicit'
  | 'anthropic_breakpoint'
  | 'gemini_explicit'
  | 'openrouter'
  | 'none';
```

Stable cache keys must not include turn IDs, player action text, timestamps, or random request IDs.

## Evaluation Vision

String tests are not enough. Mtherios needs replay scenarios that test story behavior.

Evaluation layers:

1. Deterministic prompt tests
2. Replay scenarios
3. Model comparison metrics
4. Failure testing

Replay scenarios should check continuity, NPC knowledge boundaries, state patch accuracy, retrieval recall, cost, latency, and cache-hit behavior.

## Context Vision

Context should be scene-first:

```text
current scene ids
  -> directly present entities
  -> active relationships, beliefs, goals
  -> open threads touching those entities
  -> relevant canon and memory
  -> small recent-dialogue window
```

Replace blanket history with:

- last two to four exchanges verbatim
- rolling current-scene summary
- retrieved anchor turns
- chapter or arc summaries only when relevant

Every included fact should have a reason, a source ID, and a token cost.

## Small Model Vision

Small models should do bounded support work, not own canon.

Good jobs for cheap models:

- context gathering
- prompt compression
- canon proposal drafting
- contradiction spotting
- NPC intent sketching
- wiki draft suggestions
- retrieval criticism when confidence is low

They return proposals. The backend validates, records, and exposes review surfaces.

## What Mtherios Is Not

Mtherios is not:

- a frontend-only Svelte app
- a SillyTavern clone
- one huge prompt pretending to be a game engine
- one giant JSON save file
- a system where browser IndexedDB owns the world

Use the browser well, but keep the soul of the system in the terminal runtime.
