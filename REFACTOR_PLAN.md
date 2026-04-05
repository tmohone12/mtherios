# Mtherios Refactor: Framework → Game Master Orchestrator

## Overview

Replace the 18-service post-generation pipeline with a single Game Master (GM) that uses **tool calls** for all state mutations. The narrator becomes the orchestrator — it generates prose AND manages world state in one inference pass.

**Token savings:** ~3-5x per turn (from ~15-30k across 16 calls → ~5-10k in 1-2 calls)

**Backwards compatibility:** All existing IndexedDB data (Dexie) is untouched. No schema migration needed. Old stories load and play identically — the GM just uses tools instead of a separate pipeline.

---

## Architecture: Before vs After

### BEFORE (Current)
```
User Action
  → ContextAssembler.assemble() (builds 5-tier context block)
  → streamNarrative() (narrator generates prose)
  → GenerationPipeline.runPostGeneration() (15 sequential/parallel AI calls):
      Phase 1: ClassifierService → world state sync → lorebook sync
                MicroFactionSimService (if faction signals)
      Phase 2: MemoryService → chapter/arc → WorldSimulationService
                LoreManagementService → ProceduralMemoryService
      Phase 3: ActionChoicesService → StyleReviewerService
                ImageGenerationService → SuggestionsService
```

### AFTER (Orchestrator)
```
User Action
  → buildGMContext() (lightweight state summary, ~200-500 tokens)
  → streamNarrativeWithTools() (GM generates prose + calls tools inline)
      Tools available during generation:
        update_characters, update_locations, update_items
        advance_time, save_memory, query_lore
      Post-generation (still separate, cheap):
        action_choices (optional), image_gen (optional)
```

---

## Chunk 1: Tool Schema & GM System Prompt

### 1.1 Define Tool Schemas

Create `src/lib/services/ai/tools/schemas.ts`:

```typescript
// These are the tools the GM can call during narrative generation.
// They replace: ClassifierService, MemoryService, WorldSimulationService,
// LoreManagementService, MicroFactionSimService, and parts of ContextAssembler.

export const GM_TOOLS = [
  {
    type: "function",
    function: {
      name: "update_world_state",
      description: "Update characters, locations, items, and time after narrating. Call this ONCE at the end of every response.",
      parameters: {
        type: "object",
        properties: {
          characters: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                status: { type: "string", enum: ["active", "departed", "deceased", "inactive"] },
                description: { type: "string" },
                relationship: { type: "string" },
                traits: { type: "array", items: { type: "string" } },
                present: { type: "boolean" }
              },
              required: ["name"]
            }
          },
          locations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                current: { type: "boolean" },
                region: { type: "string" },
                connections: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      targetName: { type: "string" },
                      direction: { type: "string" },
                      travelTimeMinutes: { type: "number" }
                    }
                  }
                }
              },
              required: ["name"]
            }
          },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                quantity: { type: "number" },
                equipped: { type: "boolean" },
                location: { type: "string" }
              },
              required: ["name"]
            }
          },
          time_delta: { type: "string", description: "How much time passed, e.g. 'a few minutes', 'several hours', 'a day'" },
          mood: { type: "string", description: "Scene mood: tense, calm, mysterious, joyful, etc." },
          conversations: {
            type: "array",
            description: "NPC conversations that occurred — what was revealed, learned, emotional shifts",
            items: {
              type: "object",
              properties: {
                npcName: { type: "string" },
                topicSummary: { type: "string" },
                playerRevealed: { type: "array", items: { type: "string" } },
                npcLearned: { type: "array", items: { type: "string" } },
                emotionalShift: { type: "string" }
              },
              required: ["npcName", "topicSummary"]
            }
          },
          relationships: {
            type: "array",
            description: "Relationship changes between entities",
            items: {
              type: "object",
              properties: {
                sourceName: { type: "string" },
                targetName: { type: "string" },
                type: { type: "string" },
                label: { type: "string" },
                strength: { type: "number", minimum: -100, maximum: 100 },
                bidirectional: { type: "boolean" }
              },
              required: ["sourceName", "targetName", "type"]
            }
          },
          story_beats: {
            type: "array",
            description: "Significant plot events that just occurred",
            items: {
              type: "object",
              properties: {
                title: { type: "string" },
                description: { type: "string" },
                significance: { type: "string", enum: ["minor", "moderate", "major", "critical"] }
              },
              required: ["title"]
            }
          }
        }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_lore",
      description: "Search the lorebook for relevant entries. Use BEFORE narrating when you need to check facts about characters, locations, factions, or world lore.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Semantic search query" },
          type_filter: { type: "string", enum: ["character", "location", "item", "faction", "concept", "event"] }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_lore_entry",
      description: "Create a new lorebook entry for a newly introduced entity (character, location, faction, etc.)",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          type: { type: "string", enum: ["character", "location", "item", "faction", "concept", "event"] },
          description: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
          hidden_info: { type: "string", description: "GM-only info the player shouldn't see yet" }
        },
        required: ["name", "type", "description"]
      }
    }
  }
];
```

### 1.2 GM System Prompt Changes

The current `buildSystemPrompt()` in `story.svelte.ts` stays mostly the same. Changes:

1. **Remove** the injected context block from ContextAssembler (the 5-tier assembly)
2. **Add** a lightweight state summary (~200 tokens) instead
3. **Add** tool usage instructions to the GM prompt

New addition to system prompt (replaces the `contextBlock` parameter):

```
## World State (current)
Location: {currentLocation.name} — {currentLocation.description}
Characters present: {presentChars.map(c => c.name + ': ' + c.description).join('; ')}
Inventory: {equippedItems.map(i => i.name).join(', ')}
Time: Day {tracker.days}, {tracker.hours}:{tracker.minutes}

## Your Tools
After generating your narrative response, you MUST call `update_world_state` to record any changes.
Before narrating about lore-heavy topics, call `query_lore` to check your facts.
When introducing new named entities, call `create_lore_entry` to register them.
```

### 1.3 Files Changed
- **NEW:** `src/lib/services/ai/tools/schemas.ts`
- **EDIT:** `src/lib/stores/story.svelte.ts` → `buildSystemPrompt()` (add tool instructions, simplify context)
- **EDIT:** `src/lib/stores/story.svelte.ts` → new method `buildStateSnapshot()` (lightweight)

---

## Chunk 2: Tool-Calling Generation Layer

### 2.1 Streaming with Tool Calls

Create `src/lib/services/ai/tools/generate-with-tools.ts`:

The key challenge: **streaming text + tool calls**. Two approaches:

**Option A (Recommended): Sequential — narrate first, tools second**
The GM streams prose normally. After the stream completes, it makes a second non-streaming call with the full narrative asking "now update the world state." This is simpler, works with all providers, and keeps streaming UX intact.

**Option B: Native tool use during streaming**
Anthropic and OpenAI support tool_use blocks mid-stream. More complex to parse, provider-specific, but truly single-pass.

**Recommendation: Start with Option A**, migrate to Option B later. Option A already saves ~80% of the token overhead because:
- The update_world_state call replaces 15 separate service calls with 1
- The "update" prompt is tiny (~500 tokens) vs the current classifier prompt (~2000 tokens)

```typescript
// Option A: Two-phase generation
export async function generateWithWorldUpdate(
  systemPrompt: string,
  userPrompt: string,
  messages: ChatMessage[],
  narrative: string, // the completed streamed narrative
  stateSnapshot: string, // current world state
): Promise<WorldStateUpdate> {
  // Phase 2: Ask GM to emit world state changes as structured JSON
  const updatePrompt = `You just narrated the following scene:

---
${narrative}
---

Current world state:
${stateSnapshot}

Now call update_world_state with ALL changes from this scene. Include:
- Character status changes (who appeared, departed, died)
- Location changes (where is the player now)
- Item changes (picked up, used, dropped)
- Time progression
- Any conversations that occurred
- Any significant story beats

Be thorough — anything not recorded here is forgotten.`;

  // Single structured call — replaces 15 pipeline calls
  const result = await generateStructuredWithTools(updatePrompt, GM_TOOLS);
  return result;
}
```

### 2.2 Tool Execution Layer

Create `src/lib/services/ai/tools/executor.ts`:

```typescript
// Routes tool calls to the appropriate store/database mutations.
// This is where GenerationPipeline's logic lives now — but as
// direct function calls, not AI inference.

export async function executeToolCall(
  name: string,
  args: Record<string, any>,
): Promise<string> {
  switch (name) {
    case 'update_world_state':
      return handleWorldStateUpdate(args);
    case 'query_lore':
      return handleQueryLore(args);
    case 'create_lore_entry':
      return handleCreateLoreEntry(args);
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function handleWorldStateUpdate(args: WorldStateUpdate): Promise<string> {
  // This replaces:
  // - ClassifierService.classify()
  // - Pipeline.syncClassifierToLorebook()
  // - Pipeline.syncClassifierRelationships()
  // - Pipeline.syncLocationConnections()
  // - Pipeline.syncConversationMemory()
  // - Pipeline.applyTimeProgression()
  // - Pipeline.evaluateConsequences()

  // Characters
  for (const char of args.characters ?? []) {
    // Same logic as Pipeline.runClassifier() character persistence
    await story.updateOrCreateCharacter(char);
    await autoCreateLorebookEntry(char.name, 'character', char.description);
  }

  // Locations
  for (const loc of args.locations ?? []) {
    await story.addOrUpdateLocation(loc.name, loc.description, loc.current);
    await autoCreateLorebookEntry(loc.name, 'location', loc.description);
    if (loc.connections) await syncLocationConnections(loc);
  }

  // Items
  for (const item of args.items ?? []) {
    await story.addOrUpdateItem(item.name, item.description, item.quantity, item.equipped, item.location);
    await autoCreateLorebookEntry(item.name, 'item', item.description);
  }

  // Time
  if (args.time_delta) {
    await applyTimeProgression(args.time_delta);
    await maybeRunWorldSim(); // fires every N in-world days, same as before
  }

  // Conversations
  for (const conv of args.conversations ?? []) {
    await syncConversationMemory(conv);
  }

  // Relationships
  for (const rel of args.relationships ?? []) {
    await syncRelationship(rel);
  }

  // Story beats
  for (const beat of args.story_beats ?? []) {
    await createStoryBeat(beat);
  }

  // Consequences (death → faction hostility, etc.)
  await evaluateConsequences(args.characters ?? []);

  return JSON.stringify({ success: true });
}

async function handleQueryLore(args: { query: string; type_filter?: string }): Promise<string> {
  // Uses EmbeddingService for semantic search (kept from current system)
  const results = await ai.embeddings.search(args.query, 5);
  // Filter by type if specified
  const filtered = args.type_filter
    ? results.filter(r => r.metadata?.type === args.type_filter)
    : results;
  return JSON.stringify(filtered.map(r => ({
    name: r.name,
    type: r.type,
    description: r.description,
    state: r.state
  })));
}
```

### 2.3 Files Changed
- **NEW:** `src/lib/services/ai/tools/generate-with-tools.ts`
- **NEW:** `src/lib/services/ai/tools/executor.ts`
- **EDIT:** `src/lib/services/ai/sdk/generate.ts` → add tool call support to both streaming and non-streaming paths

---

## Chunk 3: Rewire ActionInput (The Main Flow)

### 3.1 Current Flow (ActionInput.svelte)
```
handleSubmit()
  → contextAssembler.assemble()        // expensive
  → story.buildSystemPrompt(contextBlock)
  → story.buildConversationMessages()
  → streamNarrative()                   // stream prose
  → story.addEntry('narration', text)
  → onStreamEnd(text)

StoryView receives onStreamEnd → runs pipeline.runPostGeneration(text)
```

### 3.2 New Flow
```
handleSubmit()
  → story.buildStateSnapshot()          // cheap (~200 tokens)
  → story.buildSystemPrompt()           // no contextBlock param needed
  → story.buildConversationMessages()
  → streamNarrative()                   // stream prose (unchanged)
  → story.addEntry('narration', text)
  → executeWorldUpdate(text, snapshot)  // single structured call
  → onStreamEnd(text)

StoryView receives onStreamEnd → only runs optional enrichment (choices, images)
```

### 3.3 Changes to ActionInput.svelte

Replace the `ai.contextAssembler.assemble()` call with `story.buildStateSnapshot()`. Remove the pipeline trigger from StoryView's `onStreamEnd` handler (or reduce it to optional enrichment only).

### 3.4 Changes to StoryView.svelte

The `handlePipelineResults()` function shrinks dramatically. Instead of receiving a full `PipelineResult` with classifier data, it only handles:
- Action choices (if enabled) — still a separate small call
- Image generation (if enabled) — still a separate call
- Style review (if enabled) — still a separate call

These 3 are genuinely separate concerns that benefit from isolation.

### 3.5 Files Changed
- **EDIT:** `src/lib/components/story/ActionInput.svelte` → new generation flow
- **EDIT:** `src/lib/components/story/StoryView.svelte` → simplified post-generation

---

## Chunk 4: Chapter/Arc/Memory (Background Processes)

These are NOT per-turn. They fire on thresholds (every 20 entries, every 5 chapters, every N in-world days). They stay as separate calls but are simplified:

### 4.1 Chapter Creation
**Stays as-is** but moves from `GenerationPipeline` to a standalone service:
- `src/lib/services/ai/background/ChapterService.ts`
- Triggered by entry count threshold (same logic)
- Uses `MemoryService.analyzeForChapter()` + `MemoryService.summarizeChapter()` (these two calls are worth keeping — they're infrequent)

### 4.2 Arc Condensation
**Stays as-is** — fires every 5 unchaptered chapters.
- Moves to `src/lib/services/ai/background/ArcService.ts`

### 4.3 World Simulation
**Stays as-is** — fires every N in-world days.
- Moves to `src/lib/services/ai/background/WorldSimService.ts`
- Already triggered by `applyTimeProgression()` in the executor

### 4.4 Procedural Memory (CASS)
**Stays as-is** — fires after arc creation.
- Moves to `src/lib/services/ai/background/ProceduralMemoryService.ts`

### 4.5 Background Runner
Create `src/lib/services/ai/background/runner.ts`:

```typescript
// Replaces the Phase 2 section of GenerationPipeline.
// Called after every world state update, checks thresholds, fires background jobs.

export async function runBackgroundJobs(): Promise<string[]> {
  const errors: string[] = [];

  // Chapter check (every 20 entries outside a chapter)
  try { await maybeCreateChapter(); } catch (e) { errors.push(`Chapter: ${e}`); }

  // World sim is triggered by time advancement in the executor

  return errors;
}
```

### 4.6 Files Changed
- **NEW:** `src/lib/services/ai/background/runner.ts`
- **MOVE:** chapter/arc/worldsim/procedural logic from `GenerationPipeline.ts` → individual files in `background/`
- **DELETE:** `src/lib/services/ai/pipeline/GenerationPipeline.ts` (eventually)

---

## Chunk 5: Deprecate Old Services

### 5.1 Services to DELETE
| Service | Replaced By |
|---------|-------------|
| `ClassifierService` | `update_world_state` tool call |
| `BaseAIService` | Direct `generateNarrative()` calls where still needed |
| `GenerationPipeline` | Tool executor + background runner |
| `ContextAssembler` | `buildStateSnapshot()` on story store |
| `AgenticRetrievalService` | `query_lore` tool call |
| `LoreRAGService` | `query_lore` tool call |
| `SuggestionsService` | Optional — can become a simple tool |
| `MicroFactionSimService` | Folded into `update_world_state` consequence logic |

### 5.2 Services to KEEP (moved to background/)
| Service | Reason |
|---------|--------|
| `MemoryService` | Chapter summarization — infrequent, high value |
| `ArcCondensationService` | Arc creation — infrequent |
| `WorldSimulationService` | World tick — infrequent, complex |
| `ProceduralMemoryService` | CASS reflection — infrequent |
| `EmbeddingService` | Powers `query_lore` tool |
| `CompactionService` | Manual/button-triggered, not per-turn |

### 5.3 Services to KEEP (optional enrichment)
| Service | Reason |
|---------|--------|
| `ActionChoicesService` | UI enrichment — user can disable |
| `StyleReviewerService` | UI enrichment — user can disable |
| `ImageGenerationService` | UI enrichment — user can disable |
| `LoreManagementService` | Periodic lore cleanup — infrequent |

### 5.4 Cleanup of `ai` singleton
The `ai` object in `index.ts` shrinks from 18 lazy singletons to ~8.

---

## Chunk 6: Backwards Compatibility

### 6.1 Database Schema — NO CHANGES
- Dexie version stays at current (7)
- All tables unchanged: stories, storyEntries, characters, locations, items, chapters, arcs, lorebookEntries, etc.
- The tool executor writes to the same tables using the same functions (`createCharacter`, `updateLocation`, etc.)

### 6.2 Story Type — NO CHANGES
- `Story` interface unchanged
- `StoryEntry` types unchanged (`user_action`, `narration`, `system`)
- `Character`, `Location`, `Item` — unchanged
- All lorebook types — unchanged

### 6.3 Settings — MINIMAL CHANGES
- Service configs for deleted services become no-ops (their `enabled` flag is ignored)
- Add a new setting: `generationMode: 'orchestrator' | 'pipeline'` (default: `'orchestrator'`)
- If set to `'pipeline'`, use the old flow (for fallback during migration)

### 6.4 Import/Export
- `storySync.ts` — NO CHANGES (exports raw DB data)
- Imported stories work identically — data shape is the same

### 6.5 Migration Path
1. Ship with `generationMode: 'orchestrator'` as default
2. Keep pipeline code behind the `'pipeline'` flag for 1-2 releases
3. Delete pipeline code after confirming orchestrator stability

---

## Chunk 7: Provider Compatibility

### 7.1 Tool Call Support
Not all providers support tool calls equally:

| Provider | Tool Support | Strategy |
|----------|-------------|----------|
| OpenAI | Full | Native tool_use |
| Anthropic | Full | Native tool_use |
| OpenRouter | Full (proxied) | Native tool_use |
| Local (Ollama) | Partial | Fallback to Option A (structured JSON) |
| Other OpenAI-compat | Varies | Fallback to structured JSON prompt |

### 7.2 Fallback for Non-Tool Providers
For providers without tool call support, the `update_world_state` becomes a structured JSON prompt appended after narrative generation (like Option A). The executor parses the JSON and executes the same mutations.

This means the system works with ANY provider — tool calls when available, structured JSON when not.

---

## Implementation Order

| Phase | Chunk | What | Risk | Effort |
|-------|-------|------|------|--------|
| 1 | 1 | Tool schemas + GM prompt changes | Low | Small |
| 2 | 2 | Tool execution layer | Medium | Medium |
| 3 | 3 | Rewire ActionInput + StoryView | Medium | Medium |
| 4 | 4 | Extract background services | Low | Medium |
| 5 | 6.3 | Add generationMode toggle | Low | Small |
| 6 | 5 | Delete old services | Low | Small |
| 7 | 7 | Provider fallback layer | Medium | Medium |

**Total estimated effort:** 2-3 focused sessions.
**Risk mitigation:** The `generationMode` toggle means you can ship incrementally and fall back.

---

## Token Budget Comparison (Per Turn)

### Current Pipeline
| Component | Tokens |
|-----------|--------|
| System prompt (narrator) | ~2,500 |
| Context assembly (5 tiers) | ~4,000-8,000 |
| Conversation history | ~3,000-6,000 |
| Narrator output | ~500-1,500 |
| Classifier call (system + prompt + output) | ~3,000 |
| Memory/chapter analysis | ~2,000 (when triggered) |
| World sim | ~3,000 (when triggered) |
| Action choices | ~1,500 |
| Style review | ~1,500 |
| Lorebook sync | ~1,000 |
| **Total per turn** | **~15,000-30,000** |

### Orchestrator
| Component | Tokens |
|-----------|--------|
| System prompt (narrator + tool defs) | ~2,000 |
| State snapshot | ~200-500 |
| Conversation history | ~3,000-6,000 |
| Narrator output | ~500-1,500 |
| World state update call | ~1,000-2,000 |
| Action choices (optional) | ~1,500 |
| **Total per turn** | **~7,000-12,000** |

**Savings: 50-65% per turn.** Over a 100-turn story: ~1M-2M tokens saved.

---

## What Stays Exactly The Same
- All UI components (StoryView, WorldDrawer, LorebookPanel, etc.)
- Database layer (Dexie, all tables)
- Type system (all interfaces in types/index.ts)
- Story import/export
- Dice roll system
- Embedding service
- Settings UI (service configs become simpler)
- Retry mechanism
- Branch system

## What Changes
- How narrative generation triggers state updates (pipeline → tool call)
- System prompt structure (assembled context → state snapshot)
- The `ai` singleton (fewer services)
- ActionInput's `handleSubmit()` flow
- StoryView's post-generation handler
