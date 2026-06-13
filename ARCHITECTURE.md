# MTHERIOS ARCHITECTURE & CODEBASE DOCUMENTATION

This is a comprehensive reference document for the entire Mtherios interactive fiction engine. Mtherios is being refactored into a terminal-process-owned local app: a Node/SvelteKit process owns runtime config, backend canon, the syncable data root, Qdrant-backed wiki search, and API routes, while the browser frontend becomes the client.

---

## TERMINAL APP PROCESS

**Entry points:** `server.js`, `Start.bat`, `start.ps1`, `scripts/mtheriosd.mjs`

**What it does:** Starts the real local app process. In development, `npm run app:dev` brings up Postgres and Qdrant, runs migrations, initializes `data/`, sets runtime environment, then launches Vite as a child. In production, `npm run app:start` serves the built SvelteKit adapter output.

**Runtime config:** `mtherios.config.json` if present, otherwise defaults from `mtherios.config.example.json` and environment variables.

**Data root:** `MTHERIOS_DATA_ROOT` defaults to `./data`. It contains vaults, exports, uploads, and logs. This folder is the practical sync boundary for multi-device use.

**Wiki APIs:** `/api/wiki/status`, `/api/wiki/story-vault`, `/api/wiki/story-vault/status`, `/api/wiki/index`, `/api/wiki/search`, and `/api/wiki/follow` wrap the terminal `scripts/wiki-core` tools. `/api/wiki/story-vault` materializes backend story canon into an Obsidian-style vault under `data/vaults/stories/<storyId>` and writes `.mtherios/story-vault.json` with the source server version. Backend-bound wiki search, follow, and index requests ensure that generated vault exists and is fresh before reading it. `/api/wiki/index` can rebuild a story-specific Qdrant collection from that markdown and updates the same manifest when the index is fresh. Qdrant is treated as a rebuildable index over Obsidian markdown, not canon. The GM `search_wiki` tool now prefers this terminal API with wikilink/backlink neighborhoods and falls back to the browser lorebook cache only when the terminal wiki is unavailable or empty.

**Story APIs:** `/api/stories` lists and creates server-owned stories; `/api/stories/:id` deletes backend canon, removes the generated story vault, and best-effort deletes the story-specific Qdrant collection; `/api/stories/:id/bootstrap` returns canonical story state for frontend hydration.

**Job APIs:** `/api/app/jobs/run` drains due backend jobs from the server-side `backend_jobs` outbox, `/api/app/jobs/world-sim` enqueues and immediately runs a manual backend world tick for a backend-bound story, and `/api/app/jobs/wiki` enqueues the same story-vault sync job the daemon uses after canon changes. `scripts/mtheriosd.mjs` polls the run endpoint by default, so memory-node projection, story-vault materialization, and retryable background work are owned by the terminal process rather than the browser. The current processor materializes event memory nodes, deterministic chapter checkpoints, chapter-scoped faction pressure, chapter-scoped world-tick events, arc rollups, saga rollups, generated Obsidian story vaults, and optional memory-node embeddings from canonical Postgres rows. Turn projection no longer queues world/faction simulation jobs every turn; those updates are tied to chapter creation. Turn projection, IndexedDB import, sync operations, and direct backend-canon edits all queue story-vault sync jobs so `.mtherios/story-vault.json` tracks the latest server version once the worker drains. Qdrant auto-indexing for story vault jobs is controlled by `MTHERIOS_WIKI_AUTO_INDEX` / `wikiAutoIndexStoryVaults`; richer AI summarization remains a follow-up worker.

**Current migration state:** The old browser/IndexedDB path still exists for compatibility, but the frontend story catalog now refreshes from the terminal process, new/imported stories are backend-bound by default when the server is reachable, and backend-bound turns use `/api/turn`, `/api/sync/*`, and `/api/memory/retrieve`. For backend-bound stories, Dexie is being narrowed into cache plus offline command queue: queued `turn_command`/entry repair ops are pushed before projection pulls or new backend turns, and server `sync_ops` IDs make retries idempotent. Future work should keep moving large-story ownership toward the terminal process and backend canon.

### Canon Schema Lock (DB-first projection boundary)

- `Postgres` is the canonical source of truth for character/location/faction/world records. `stories`, `story_entries`, `entities`, `entity_aliases`, `relationships`, `factions`, `state_patches`, `facts`, `source_refs`, `patch_proposals`, and `continuity_warnings` are persistent, durable records owned by the terminal process.
- Stable IDs live in row IDs (`id`, `story_id`, record IDs in related tables). Frontmatter/markdown pages are generated projections, not identity boundaries.
- Durable updates flow as: write/update a canonical row with `source_ids`/`source_refs` provenance, then project the story vault and optional search indexes.
- Entity and record changes are expected to include explicit evidence links (`source_entry_ids`, `source_event_ids`, `source_patch_ids`, `source_refs`) rather than implicit narrative inference.
- Import/export (`worldDatabase`) must preserve or map IDs and row payloads so identity is stable across bundles.

---

### FILE 1: `src/lib/stores/story.svelte.ts`

**What it does:** Central reactive store managing the active story state including entries, characters, locations, items, lorebook entries, and world state. Handles conversation history building, system prompt construction, and context statistics.

**Exports:**
- `story` (singleton StoryStore instance)
- `StoryStore` (class)

**Key internal functions:**
- `loadStory(storyId)` - Loads story and all related data from IndexedDB in parallel
- `addEntry(type, content, reasoning)` - Creates a new story entry (user action, narration, system, retry)
- `addCharacter(name, description, relationship)` - Creates a new character
- `updateCharacterFromClassification(name, updates)` - Merges classifier updates into a character
- `updatePresence(characterNames, locationName)` - Sets lastSeenLocation for present characters
- `clearPresenceForCharacters(characterNames)` - Removes lastSeenLocation (departed/dead)
- `addOrUpdateLocation(name, description, current)` - Creates or updates a location; ensures only one location is current
- `addOrUpdateItem(name, description, quantity, equipped, location)` - Creates or updates an item
- `buildSystemPrompt(contextBlock)` - Constructs the full system prompt for narrative generation with role rules, genre instructions, and assembled context
- `buildConversationMessages()` - Builds alternating user/assistant messages from entries, scaled to 60% of model context window
- `buildUserPrompt(currentAction)` - Wraps user action for generation
- `getContextStats(tierUsage)` - Reports system, context, history, and total token estimates

**Reads:** Database (getStory, getStoryEntries, getCharacters, getLocations, getItems, getLorebookEntries, etc.), settings (narrativeSettings, contextBudget), ContextAssembler (getModelContextWindow)

**Writes:** Database (createStoryEntry, createCharacter, updateCharacter, createLocation, updateLocation, createItem, updateItem, updateStory), story entries added to this.entries array, characters/locations/items updates merged into reactive state

**Connections:** Called by StoryView component during generation pipeline; called by ActionInput for action submission. Reads from settings store. Provides entries/characters/locations to ClassifierService, MemoryService, WorldSimulationService, other AI services.

**Notable patterns:**
- POV/tense/mode-adaptive system prompts with role tags ({{user}}, {{char}}, {{world}})
- Character classification merges (trait deduplication with Set)
- Location current-exclusivity logic (only one location can be current at a time)
- Conversation history token budget: 60% of model context window, 2/3 of user budget
- Inherited entries logic: entries on null branchId are "main branch" (legacy stories)

---

### FILE 2: `src/lib/stores/settings.svelte.ts`

**What it does:** Persistent settings store loaded from IndexedDB on init. Manages API profiles, narrative generation settings, per-service model/temp/maxTokens overrides, UI settings, translation settings, context budget.

**Exports:**
- `settings` (singleton SettingsStore)
- `SERVICE_DEFINITIONS` (record mapping service IDs to label, description, profile grouping, default temp/maxTokens)
- `SERVICE_PROFILES` (array of profile definitions grouping services by configuration tier)
- `ServiceConfig`, `ServiceProfile`, `NarrativeSettings`, `ClassifierSettings`, `SystemServicesSettings` (types)

**Key internal functions:**
- `init()` - Loads all settings from IndexedDB via getAllSettings()
- `saveProfiles()`, `saveNarrativeSettings()`, `saveUISettings()`, `saveServiceConfigs()`, `saveProfileModels()`, `saveContextBudget()` - Persistence functions
- `getServiceConfig(serviceId)` - Returns effective config: per-service override or profile model or empty (provider default)
- `setServiceConfig(serviceId, config)` - Updates per-service override
- `getProfileModel(profileId)`, `setProfileModel(profileId, model)` - Profile-level model selection
- `setActiveProfile(profileId)` - Switches active API profile, resets narrative model to provider default
- `addProfile(profile)`, `removeProfile(profileId)` - Profile management

**Reads:** Database (getSetting, setSetting, getAllSettings)

**Writes:** Database (setSetting for each setting category)

**Connections:** Used by BaseAIService to get model/temp/maxTokens. Used by ActionInput to build generation options. Used by ContextAssembler for model context window lookup.

**Notable patterns:**
- Dual-layer model selection: per-service override > profile model > provider default
- 13 AI services (narrative, classifier, suggestions, actionChoices, memory, styleReviewer, loreManagement, agenticRetrieval, interactiveVault, imageGeneration, worldSimulation, arcCondensation, proceduralMemory)
- Services grouped into 7 profiles (Narrative, World State, Player Guidance, Memory & Context, Lorebook, Style Review, Image Generation)
- Default configs defined in SERVICE_DEFINITIONS with sensible temp/maxTokens per service
- Context budget: 0 = auto (60% of model context), or explicit token limit

---

### FILE 3: `src/lib/stores/app.svelte.ts`

**What it does:** Global app state including onboarding completion, current story selection, wizard visibility, loading state.

**Exports:**
- `app` (singleton AppStore)

**Key internal functions:**
- `init()` - Loads onboarding flag and last story ID from IndexedDB
- `startNewStory()` - Shows wizard
- `completeOnboarding(storyId)` - Marks onboarding done, sets current story, hides wizard
- `openStory(storyId)`, `closeStory()` - Story selection

**Reads:** Database (getSetting)

**Writes:** App state (onboardingComplete, currentStoryId, showWizard, loading)

**Connections:** Used by +layout.svelte to control rendering flow. Syncs with story store when currentStoryId changes.

---

### FILE 4: `src/lib/types/index.ts`

**Complete type reference:**

**Story Management:**
- `StoryMode = 'adventure' | 'creative-writing'` - Play mode
- `POV = 'first' | 'second' | 'third'` - Point of view
- `Tense = 'past' | 'present'` - Narrative tense
- `ActionInputType = 'do' | 'say' | 'think' | 'story' | 'free'` - Action types
- `Story` - Main story record with id, title, description, genre, mode, settings (POV/tense/tone), memoryConfig, retryState, styleReviewState, timeTracker, currentBranchId, headerPrompt
- `StorySettings` - Per-story overrides: model, temperature, maxTokens, pov, tense, tone, themes, visualProseMode, imageGenerationMode, backgroundImagesEnabled, referenceMode
- `StoryEntry` - Log entry (user_action|narration|system|retry) with content, type, position, createdAt, metadata, branchId, reasoning, translatedContent, worldStateDelta, suggestedActions
- `EntryMetadata` - tokenCount, model, generationTime, source, timeStart, timeEnd, originalInput

**Characters & Appearance:**
- `VisualDescriptors` - face, hair, eyes, build, clothing, accessories, distinguishing
- `Character` - id, storyId, name, description, relationship, traits, visualDescriptors, portrait, status (active|inactive|deceased), metadata, branchId
- `VaultCharacter` - Reusable character with tags, favorite, source (manual|import|story), originalStoryId, createdAt, updatedAt

**Locations & Items:**
- `Location` - id, storyId, name, description, visited, current, connections, metadata, branchId
- `Item` - id, storyId, name, description, quantity, equipped, location, metadata, branchId

**Story Beats (Quests/Milestones):**
- `StoryBeat` - id, storyId, title, description, type (milestone|quest|revelation|event|plot_point), status (pending|active|completed|failed), triggeredAt, resolvedAt, metadata, branchId

**Memory System:**
- `TimeTracker` - years, days, hours, minutes (in-story time)
- `MemoryConfig` - tokenThreshold (16000), chapterBuffer (10), autoSummarize, enableRetrieval, maxChaptersPerRetrieval
- `Chapter` - id, storyId, number, title, startEntryId, endEntryId, entryCount, summary, startTime, endTime, keywords, characters (names), locations (names), plotThreads, emotionalTone, branchId, createdAt
- `Arc` - id, storyId, arcNumber, title, summary, keyPlotPoints, characterArcs, unresolvedThreads, emotionalProgression, chapterIds, chapterRange, branchId, createdAt

**Lorebook (Entry) System:**
- `EntryType = 'character' | 'location' | 'item' | 'faction' | 'concept' | 'event'`
- `EntryInjectionMode = 'always' | 'keyword' | 'never'`
- `EntryCreator = 'user' | 'ai' | 'import' | 'forge'`
- `Entry` - Full lorebook entry with name, type, description, hiddenInfo, aliases, state (union of entry-type-specific states), injection (keywords, priority, mode), firstMentioned, lastMentioned, mentionCount, createdBy, loreManagementBlacklisted, branchId

**Entry State Types (Mutable):**
- `CharacterEntryState` - isPresent, lastSeenLocation, currentDisposition, relationship (level -100 to 100, status, history), knownFacts, revealedSecrets, conversationTopics, lastConversationAt, personalOpinion
- `LocationEntryState` - isCurrentLocation, visitCount, changes, presentCharacters, presentItems, connections (targetLocationId, direction, travelTime, description, blocked), region, terrain
- `ItemEntryState` - inInventory, currentLocation, condition, uses (action, result, entryId)
- `FactionEntryState` - playerStanding (-100 to 100), status (allied|neutral|hostile|unknown), knownMembers, goals (FactionGoal[]), resources (FactionResources), disposition, interFactionRelations (factionName → standing), territory, lastActionChapter
- `FactionGoal` - description, priority (1-10), progress (0-100), type (military|diplomatic|economic|intelligence|survival|expansion), deadline
- `FactionResources` - military, wealth, influence, information, morale (all 0-100)
- `ConceptEntryState` - revealed, comprehensionLevel (unknown|basic|intermediate|advanced), relatedEntries
- `EventEntryState` - occurred, occurredAt, witnesses, consequences

**Vault Systems (Reusable Assets):**
- `VaultLorebookEntry`, `VaultLorebook` - Reusable lorebook with tags, favorite, source, metadata
- `VaultScenarioNpc` - name, role, description, relationship, traits
- `VaultScenario` - Reusable scenario with settingSeed, npcs, primaryCharacterName, firstMessage, alternateGreetings
- `VaultTag` - id, name, type (character|lorebook|scenario), color, createdAt

**Tier 2: Relationships & Memory:**
- `RelationshipType = 'member-of' | 'leader-of' | 'allied-with' | 'enemy-of' | 'located-in' | 'part-of' | 'created-by' | 'triggered-by' | 'knows-about' | 'owns' | 'serves' | 'related-to'`
- `EntryRelationship` - id, storyId, sourceEntryId, targetEntryId, type, label, strength (0-100), bidirectional, metadata, createdAt, updatedAt
- `ConversationMemoryEntry` - id, storyId, npcEntryId, npcName, storyEntryId, storyPosition, topic, playerSaid, npcLearned (what NPC learned), emotionalImpact, importance (trivial|minor|significant|critical), createdAt
- `WorldEvent` - id, storyId, name, description, triggerEntryId, triggerPosition, sourceEntityId, type (death|hostility_change|territory_change|alliance_formed|alliance_broken|item_destroyed|location_blocked|secret_revealed|custom), severity (minor|moderate|major|catastrophic), consequences (Consequence[]), appliedAt, createdAt
- `Consequence` - id, description, status (pending|applied|expired|reversed), targetEntityId, targetEntityName, effectType (relationship_change|faction_status_change|location_blocked|location_unblocked|npc_status_change|rumor_spread|custom), effectPayload, delay, appliedAt

**Procedural Memory (CASS-inspired):**
- `RuleCategory = 'character_behavior' | 'world_rule' | 'narrative_pattern' | 'player_preference' | 'anti_pattern' | 'lore_connection'`
- `RuleMaturity = 'candidate' | 'established' | 'proven' | 'deprecated'`
- `RuleScope = 'global' | 'story' | 'arc' | 'chapter'`
- `ProceduralRule` - id, storyId, content, category, scope, type (rule|anti_pattern), maturity, helpfulCount, harmfulCount, effectiveScore (0-1), sourceChapterIds, sourceArcIds, relatedEntryIds, embedding (vector), tags, createdAt, updatedAt, lastReinforcedAt
- `EmbeddingCacheEntry` - id, sourceId, sourceType (lorebook|chapter|arc|rule|query), contentHash, vector, model, createdAt

**World State Delta Tracking (Phase 1 - Undo support):**
- `WorldStateDelta` - Stores before-state snapshots (CharacterBeforeState[], LocationBeforeState[], ItemBeforeState[], StoryBeatBeforeState[], currentLocationId, timeTracker) and created entity IDs
- `CharacterBeforeState`, `LocationBeforeState`, `ItemBeforeState`, `StoryBeatBeforeState` - Snapshots for rollback

**Retry System:**
- `PersistentRetryState` - Stores state for time-travel restore: entryCountBeforeAction, userActionContent, rawInput, actionType, characterIds, locationIds, itemIds, storyBeatIds, characterSnapshots (PersistentCharacterSnapshot[]), timeTracker, activationData (for lorebook stickiness)
- `PersistentCharacterSnapshot` - id, traits, status, relationship, visualDescriptors, portrait

**Style Review:**
- `PersistentPhraseAnalysis` - phrase, frequency, severity (low|medium|high), alternatives, contexts
- `PersistentStyleReviewResult` - phrases, overallAssessment, reviewedEntryCount, timestamp
- `PersistentStyleReviewState` - messagesSinceLastReview, lastReview

**Branching:**
- `Branch` - id, storyId, name, parentBranchId (null=main), forkEntryId, checkpointId, createdAt, snapshotComplete
- `Checkpoint` - id, storyId, name, lastEntryId, lastEntryPreview, entryCount, entriesSnapshot, charactersSnapshot, locationsSnapshot, itemsSnapshot, storyBeatsSnapshot, chaptersSnapshot, timeTrackerSnapshot, lorebookEntriesSnapshot, createdAt

**API & Provider:**
- `ProviderType = 'openrouter' | 'nanogpt' | 'chutes' | 'pollinations' | 'ollama' | 'lmstudio' | 'llamacpp' | 'nvidia-nim' | 'openai-compatible' | 'openai' | 'anthropic' | 'google' | 'xai' | 'groq' | 'zhipu' | 'deepseek' | 'mistral'`
- `ReasoningEffort = 'off' | 'low' | 'medium' | 'high'`
- `APIProfile` - id, name, providerType, baseUrl, apiKey, customModels, fetchedModels, reasoningModels, hiddenModels, favoriteModels, createdAt

**UI & Settings:**
- `UISettings` - theme (mtherios), fontSize, fontFamily, fontSource, showWordCount, autoSave, spellcheckEnabled, debugMode, disableSuggestions, disableActionPrefixes, showReasoning, sidebarWidth, autoScroll, showScrollToTop, showScrollToBottom
- `TranslationSettings` - enabled, sourceLanguage, targetLanguage, translateNarration, translateUserInput, translateWorldState
- `ExperimentalFeatures` - stateTracking, rollbackOnDelete, lightweightBranches, autoSnapshotInterval, backgroundGeneration, generationNotifications, notificationPreview

**Images:**
- `EmbeddedImageStatus = 'pending' | 'generating' | 'complete' | 'failed'`
- `EmbeddedImage` - id, storyId, entryId, sourceText, prompt, styleId, model, imageData (base64), width, height, status, errorMessage, createdAt, generationMode (analyzed|inline)
- `InlineImageTag` - originalTag, startIndex, endIndex, prompt, characters, imageId, status

---

### FILE 5: `src/lib/services/database.ts`

**What it does:** IndexedDB wrapper using Dexie.js. Provides CRUD operations for all story data, with support for branching and versioning.

**Database Schema (v7):**
- `stories` (id, title, createdAt, updatedAt)
- `storyEntries` (id, storyId, position, type, [storyId+position], [storyId+branchId+position])
- `characters` (id, storyId, name, [storyId+name])
- `locations` (id, storyId, name, [storyId+name])
- `items` (id, storyId, name, [storyId+name])
- `storyBeats` (id, storyId, type, status)
- `chapters` (id, storyId, number, [storyId+number])
- `lorebookEntries` (id, storyId, name, type, [storyId+type])
- `embeddedImages` (id, storyId, entryId, status, [storyId+entryId])
- `appSettings` (key)
- `arcs` (id, storyId, arcNumber, [storyId+arcNumber])
- `proceduralRules` (id, storyId, category, maturity, [storyId+category], [storyId+maturity])
- `embeddingCache` (id, sourceId, sourceType, [sourceType+sourceId])
- `entryRelationships` (id, storyId, sourceEntryId, targetEntryId, type, [storyId+sourceEntryId], [storyId+targetEntryId])
- `conversationMemory` (id, storyId, npcEntryId, storyPosition, [storyId+npcEntryId], [storyId+storyPosition])
- `worldEvents` (id, storyId, triggerPosition, type, [storyId+triggerPosition])

**Exports:**
- Story CRUD: `createStory`, `getStory`, `getAllStories`, `updateStory`, `deleteStory` (cascading delete of all related data)
- StoryEntry CRUD: `createStoryEntry`, `getStoryEntries`, `updateStoryEntry`, `deleteStoryEntry`, `deleteStoryEntriesFromPosition`
- Character/Location/Item/StoryBeat/Chapter/Arc/Lorebook CRUD (standard pattern)
- EmbeddedImages CRUD: `createEmbeddedImage`, `getEmbeddedImages`, `getEntryImages`, `updateEmbeddedImage`, `deleteEmbeddedImage`
- ProceduralRules CRUD: `createProceduralRule`, `getProceduralRules`, `getProceduralRulesByCategory`, `updateProceduralRule`, `deleteProceduralRule`, `bulkPutProceduralRules`
- Embedding Cache CRUD: `getEmbedding`, `putEmbedding`, `getEmbeddingsByType`, `deleteEmbedding`, `deleteEmbeddingsBySource`
- Settings: `getSetting`, `setSetting`, `deleteSetting`, `getAllSettings`
- Relationships (Tier 2): `createEntryRelationship`, `getEntryRelationships`, `getRelationshipsForEntry`, `updateEntryRelationship`, `deleteEntryRelationship`
- Conversation Memory (Tier 2): `createConversationMemory`, `getConversationMemory`, `getNpcConversationMemory`
- World Events (Tier 2): `createWorldEvent`, `getWorldEvents`, `updateWorldEvent`
- Utility: `debugDatabaseStatus`

**Reads:** Dexie tables

**Writes:** Dexie tables

**Connections:** Called by story store, AI services, StoryView component. Settings values read by settings store on init.

**Notable patterns:**
- Cascading delete: deleteStory removes all entries, characters, locations, items, beats, chapters, lore, images, arcs, sagas, rules, relationships, conversation memory, world events in a single transaction
- Compound indices for common queries (storyId+position, storyId+name, etc.)
- Version 4→5→6→7 migrations with upgrade hook (v4 clears lorebookEntries on upgrade to fix schema issues)
- Circular ref protection in createLorebookEntry: JSON.parse(JSON.stringify(entry)) sanitizes before insert

---

### FILE 6: `src/lib/services/ai/index.ts`

**What it does:** Singleton registry for all AI services. Lazy-initializes services on first access.

**Exports:**
- All AI service classes (MemoryService, SuggestionsService, ActionChoicesService, StyleReviewerService, EntryRetrievalService, LoreManagementService, EntryRefinementService, ImageGenerationService, WorldSimulationService, ArcCondensationService, SagaCondensationService, ProceduralMemoryService, EmbeddingService, WikiLintService)
- `ai` object with getters for each service (lazy-initializes on first access)

**Key structure:**
```typescript
export const ai = {
  get classifier() { return _classifier ??= new ClassifierService(); },
  get memory() { return _memory ??= new MemoryService(); },
  // ... 13 more services
};
```

**Reads:** Nothing directly

**Writes:** Caches service instances in module-level variables

**Connections:** Imported and used by StoryView component during generation pipeline to access specific services.

---

### FILE 7: `src/lib/services/ai/BaseAIService.ts`

**What it does:** Abstract base class for all AI services. Handles per-service configuration lookup, model selection, and structured generation via JSON mode.

**Exports:**
- `BaseAIService` (abstract class)

**Key internal functions:**
- `get serviceModel(): string` - Returns per-service model override or empty string
- `get serviceTemperature(): number` - Returns per-service temperature
- `get serviceMaxTokens(): number` - Returns per-service maxTokens
- `get promptOverride(): string` - Returns system prompt override (empty = use default)
- `get isEnabled(): boolean` - Returns if service is enabled
- `protected generateStructured<T>(schema, defaultSystem, prompt)` - Generates JSON, parses with Zod, returns typed result
- `protected generateText(defaultSystem, prompt)` - Generates plain text

**Reads:** settings store (getServiceConfig returns model/temp/maxTokens/systemPromptOverride/enabled)

**Writes:** Nothing

**Connections:** Subclassed by all 13 AI services. Calls generateNarrative from generate.ts.

**Notable patterns:**
- JSON markdown fence stripping (handles ```json prefix/suffix)
- System prompt override replaces default entirely (not appended)
- _service field tagged on options for API logging

---

### FILE 8: `src/lib/services/ai/sdk/generate.ts`

**What it does:** Lightweight OpenAI-compatible chat completion wrapper. Handles streaming and non-streaming requests, API logging, conversation history insertion.

**Exports:**
- `ChatMessage` type (role: 'user'|'assistant', content: string)
- `GenerateOptions` interface (system, prompt, messages, model, temperature, maxTokens, signal)
- `StreamChunk` interface (content, reasoning, done)
- `APILogEntry` interface (full request/response logging)
- `streamNarrative(options)` - Async generator yielding StreamChunks
- `generateNarrative(options)` - Non-streaming completion
- `getActiveProfile()` - Returns active APIProfile + baseUrl
- `getActiveModel()` - Returns active model with fallback chain
- API log functions: `getApiLog()`, `clearApiLog()`, `onApiLogChange(fn)`

**Key internal functions:**
- Both functions build messages array: [system, ...history, user prompt]
- Fetch to `${baseUrl}/chat/completions` with Authorization header
- Streaming: SSE parsing with data: JSON lines
- Non-streaming: response.json() → choices[0].message.content
- Error handling: logs full APILogEntry with error field on exception
- Token estimation: length/4 rule of thumb

**Reads:** Database (getSetting for profiles), settings (activeProfileId, narrativeModel)

**Writes:** API log (module-level _apiLog array)

**Connections:** Called by BaseAIService.generateStructured and generateText. Streaming used by ActionInput component.

**Notable patterns:**
- Bearer token auth from profile.apiKey
- Provider baseUrl override from profile.baseUrl or provider config
- Always-on API log for debugging (clears on page reload, listeners for reactive updates)
- Stream chunk parsing handles malformed SSE lines gracefully
- Messages array insertion of history between system and final user prompt

---

### FILE 9: `src/lib/services/ai/sdk/schemas/classifier.ts`

**Zod schemas for world state extraction:**
- `characterUpdateSchema` - name, description, relationship, status (active|inactive|departed|deceased|unknown), traits
- `locationConnectionSchema` - targetName, direction, travelTimeMinutes, description
- `locationUpdateSchema` - name, description, current, region, terrain, connections
- `itemUpdateSchema` - name, description, quantity, equipped, location
- `relationshipExtractionSchema` - sourceName, targetName, type (12 enum values), label, strength (0-100), bidirectional
- `conversationDetectionSchema` - npcName, topicSummary, playerRevealed, npcLearned, emotionalShift, importance (trivial|minor|significant|critical)
- `classificationResultSchema` - characters, locations, items, storyBeats (with significance), relationships, conversations, mood, timeProgression

**Type exports:** ClassificationResult, CharacterUpdate, LocationUpdate, ItemUpdate, RelationshipExtraction, ConversationDetection

---

### FILE 10: `src/lib/services/ai/generation/ClassifierService.ts`

**What it does:** Extracts world state changes from narrative text. Runs after each narration to keep characters, locations, items, and story beats in sync.

**Exports:**
- `ClassifierService` (extends BaseAIService)

**Key methods:**
- `classify(narrative, recentEntries, existingCharacters, existingLocations, existingItems, mode, pov, tense)` - Returns ClassificationResult

**System prompt construction:**
- Lists existing characters/locations/items
- Detailed rules for character updates (ONLY if changed, departure logic for "departed" status)
- Location update rules (set current: true only for END location, one location max)
- Item tracking (gained/lost/equipped/unequipped/used/discovered)
- Story beat capture (minor|moderate|major|critical)
- Relationship extraction rules
- Location connection discovery
- Conversation detection with importance levels

**Reads:** Story entries, characters, locations, items (from params)

**Writes:** Nothing directly (results used by StoryView component)

**Connections:** Called by StoryView.runClassifier after AI generation. Output merged into story.characters, story.locations, story.items, and used to update presence and lorebook.

**Notable patterns:**
- Rejects "do not re-list unchanged characters" instruction
- "Departed" status is transient classifier signal → persists as "active" (they're alive, just elsewhere)
- Trait merging: Set deduplication
- Three-character list for recent context (reduces token cost)

---

### FILE 11: `src/lib/services/ai/generation/MemoryService.ts`

**What it does:** Manages chapter summarization, chapter boundary detection, and retrieval decisions for long-form narrative memory.

**Exports:**
- `MemoryService` (extends BaseAIService)
- `DEFAULT_MEMORY_CONFIG` (tokenThreshold: 16000, chapterBuffer: 10, autoSummarize: true, enableRetrieval: true, maxChaptersPerRetrieval: 3)

**Key methods:**
- `summarizeChapter(entries, previousChapters, mode, pov, tense)` - Returns ChapterSummaryResult with title, summary, keywords, keyCharacters, keyLocations, emotionalTone
- `analyzeForChapter(entries, lastChapterEndIndex, tokensOutsideBuffer, mode, pov, tense)` - Returns ChapterAnalysis with shouldCreateChapter, optimalEndIndex, keywords, reason
- `decideRetrieval(userInput, recentNarrative, availableChapters)` - Returns RetrievalDecision with shouldRetrieve, relevantChapterIds, reason
- `buildRetrievedContextBlock(chapters, decision)` - Formats chapters as context block

**Reads:** Story entries, chapters (from params)

**Writes:** Nothing directly (results used by StoryView)

**Connections:** Called by StoryView.runChapterCheck during chapter boundary detection and memory management. Used to populate context for ContextAssembler.

**Notable patterns:**
- Chapter boundary detection: looks for scene transitions, time skips, resolution of dramatic sequences
- Retrieval decision: checks if current action references past characters/locations by name
- Summary focuses on WHAT CHANGED, not play-by-play
- Keywords designed for future retrieval (names, places, concepts, plot elements)

---

### FILE 12: `src/lib/services/ai/generation/WorldSimulationService.ts`

**What it does:** Unified living-world engine: chapter-scoped faction/world reaction plus the retained full/manual simulation path. Automatic simulation now runs once when a new chapter is created, using only the newly closed chapter, the last dozen transcript entries, and directly relevant factions.

**Exports:**
- `WorldSimulationService` (extends BaseAIService)
- `WORLD_SIM_CHAPTER_INTERVAL` = 1 (legacy/full-sim constant; automatic cadence is chapter-triggered)
- `SeasonEffect` interface (currentSeason, militaryModifier, travelModifier, foodPressure, narrativeNote)
- `calculateSeason(timeTracker)` - Deterministic season lookup based on day of year

**Key methods:**
- `simulateForNewChapter({ storyId, latestChapter, recentEntries, factionEntries })` - Lightweight LLM call for the new chapter trigger. Returns WorldSimulationResult with factionActions, rumors, worldNarrative/world-state delta, worldTension, plotSeeds, and threadUpdates.
- `simulate(chapters, arcs, recentEntries, factionEntries, timeTracker, mode, pov, tense)` - Full/manual WorldSimulationResult path retained for explicit world drawer ticks.
- `buildChapterWorldSimulationPrompt(...)` - Pure helper that builds the recent-only chapter prompt and filters relevant factions.

**Context sources:**
- Chapter automatic path: latest chapter summary + last 12 transcript entries + relevant faction lore entries only
- Manual/full path: arcs, uncovered chapters, tactical transcript, faction dossiers, schemes, agreements, events, and season context

**Faction reasoning:**
- Reads FactionEntryState.goals (priority, progress, deadline, type)
- Reads FactionResources (military, wealth, influence, information, morale)
- Reads interFactionRelations (faction name → standing -100 to 100)
- Outputs FactionActions (action, actionType, target, motivation, consequences, urgency, affectedRegions)

**Season effects (deterministic):**
- Spring/Summer/Autumn/Winter/Long Winter based on day of year
- Military/travel modifiers (e.g., Winter: 0.6 military, 0.5 travel)
- Food pressure (abundant/normal/scarce/famine)

**Reads:** Chapter automatic path reads the latest Chapter, recent StoryEntry rows, and faction lore entries. Full/manual path reads chapters, arcs, story entries, faction lorebook entries, agreements, threads, events, schemes, and time tracker.

**Writes:** The service returns structured results only. `background/runner.ts` persists chapter-triggered faction actions, rumors, and a compact world event; the manual executor path persists its own result.

**Connections:** Called by `runChapterCheck()` after `saveCanonicalChapter(chapter, 'create')`. The executor no longer calls world simulation from the time tick loop; the World drawer can still request a manual tick.

**Notable patterns:**
- Prompt adapts based on whether factions exist (faction section omitted if empty)
- Season calculation is deterministic in code, not LLM
- Arc block built once, shared between faction and plot reasoning
- Faction dossiers capped at MAX_FACTIONS_PER_TICK = 12 to prevent token explosion
- Output collected for SeasonEffect, stored in story.lastWorldSimResult for UI display
- Chapter prompts are intentionally recent-only to avoid fast character drift and overactive faction churn

---

### FILE 13: `src/lib/services/ai/generation/SuggestionsService.ts`

**What it does:** Generates contextual action suggestions based on current narrative state.

**Exports:**
- `SuggestionsService` (extends BaseAIService)

**Key methods:**
- `suggest(recentEntries, protagonist, mode, pov)` - Returns SuggestionsResult with suggestions (text, type, brief)

**Suggestion types:** action, dialogue, thought, direction

**Guidelines:**
- Exactly 3-4 suggestions
- Specific to current scene (reference actual characters/objects/details)
- Vary across suggestion types
- Escalate in boldness (at least one safe, one risky)
- Keep text to 5-12 words, brief to 2-4 words

**Reads:** Story entries, protagonist character (from params)

**Writes:** Nothing directly (displayed as chips in StoryView)

**Connections:** Called by StoryView.runSuggestions. Output rendered as ActionSuggestionChips that emit mtherios:inject-input event to ActionInput on click.

---

### FILE 14: `src/lib/services/ai/generation/ActionChoicesService.ts`

**What it does:** Generates meaningful branching choices for significant decision points (different from suggestions).

**Exports:**
- `ActionChoicesService` (extends BaseAIService)

**Key methods:**
- `generateChoices(recentEntries, protagonist, currentLocation, mode)` - Returns ActionChoicesResult with choices (text, type, risk, brief)

**Choice types:** bold, cautious, creative, social, investigate

**Risk levels:** low, medium, high

**Guidelines:**
- 2-4 choices (prefer 3)
- Each produces genuinely different narrative outcome
- Reflect current dramatic tension
- Include at least one choice player might not have thought of
- Vary risk levels (at least 2 different levels)
- Vary types (at least 2 different types)
- Text: 8-20 words, Brief: 2-5 words

**Reads:** Story entries, protagonist, current location (from params)

**Writes:** Nothing directly (rendered as ActionChoiceCards in StoryView)

**Connections:** Called by StoryView.runActionChoices. Output rendered as cards that emit mtherios:inject-input event to ActionInput.

---

### FILE 15: `src/lib/services/ai/generation/StyleReviewerService.ts`

**What it does:** Reviews AI-generated narrative for POV consistency, tense shifts, repetition, pacing, tone, character voice.

**Exports:**
- `StyleReviewerService` (extends BaseAIService)

**Key methods:**
- `review(narrative, pov, tense, tone, revise)` - Returns StyleReview with approved, issues, revisedText (optional), overallQuality

**Issue types:** pov_break, tense_shift, character_voice, repetition, pacing, tone_mismatch

**Severity:** minor, moderate, major

**Reads:** Generated narrative (from params)

**Writes:** Nothing directly (results displayed in StoryView)

**Connections:** Called by StoryView.runStyleReview post-generation. Output shown as style review warnings/suggestions.

**Notable patterns:**
- Flags only REAL issues, not stylistic preferences
- Dialogue exempt from POV/tense checks
- Overused filler words: "suddenly", "seemed to", "began to", "couldn't help but"
- "Approved" if zero moderate/major issues (minor alone doesn't block)

---

### FILE 16: `src/lib/services/ai/generation/ArcCondensationService.ts`

**What it does:** Condenses multiple chapters into higher-level arc summaries for context management.

**Exports:**
- `ArcCondensationService` (extends BaseAIService)
- `ARC_DEFAULTS` (chaptersPerArc: 5, maxArcSummaryTokens: 400)

**Key methods:**
- `getCondensableChapters(chapters, existingArcCount)` - Returns next batch of chapters ready for condensation
- `condense(chapters, arcNumber, mode, pov, tense)` - Returns ArcSummary with title, summary, keyPlotPoints, characterArcs, unresolvedThreads, emotionalProgression
- `buildArcContextBlock(arcs)` - Formats arcs as context block

**Reads:** Chapters (from params)

**Writes:** Nothing directly (results stored in DB as Arc records)

**Connections:** Called by StoryView during chapter check when chapters.length >= (arcCount + 1) * chaptersPerArc. Arcs used by ContextAssembler for world tier context.

---

### FILE 16b: `src/lib/services/ai/generation/SagaCondensationService.ts`

**What it does:** Condenses every 10 arcs into a saga summary, the highest compact memory layer above arcs. Sagas preserve durable faction shifts, major power changes, lingering threads, and the overall political/emotional tone.

**Exports:**
- `SagaCondensationService` (extends BaseAIService)
- `SAGA_DEFAULTS` (arcsPerSaga: 10, maxSagaSummaryTokens: 600)

**Key methods:**
- `getCondensableArcs(arcs, existingSagaCount)` - Returns the next 10 uncovered arcs for saga condensation
- `condense(arcs, sagaNumber, mode, pov, tense)` - Uses `generateStructured(sagaSummarySchema, ...)` and returns SagaSummary

**Storage:** Local IndexedDB has a `sagas` table. Backend canon has a `sagas` table and `/api/stories/:id/sagas` upsert routes. Saga summaries are also projected into `memory_nodes` as plot-ledger memory.

**Hierarchy:** Entries -> Chapters -> Arcs -> Sagas.

**Connections:** Called immediately after a new arc is created in `background/runner.ts`. It does not run as an independent per-turn check.

---

### FILE 17: `src/lib/services/ai/generation/WorldSimulationService.ts` (continued)

**System prompt construction:**
```
buildSystemPrompt() function (private):
- mode-specific opening (DM simulator for adventure, world reactor for creative)
- story context blocks (arc, chapter, all threads, character arcs)
- tactical context (recent entries)
- faction dossiers (if factions exist)
- season effect narrative notes
- response format: plotInjection + worldNarrative (both required)
- if factions: factionActions, rumors, worldTension, plotSeeds
```

**Notable patterns:**
- Prompt collapses gracefully when no factions: faction sections omitted entirely
- Faction dossier builder reads from Entry.state (type-safe FactionEntryState)
- Inter-faction relations filtered to only notable (abs(standing) >= 30)
- Tactical context truncated to 200 chars per entry to preserve tokens
- Territory list capped to show most important regions

---

### FILE 18: `src/lib/services/ai/retrieval/AgenticRetrievalService.ts`

**What it does:** Multi-step context retrieval using AI to determine what context is needed, retrieves it, and decides if more is needed (up to maxIterations).

**Exports:**
- `AgenticRetrievalService` (extends BaseAIService)
- `AgenticRetrievalResult` interface (lorebookEntries, chapterContext, iterations)

**Key methods:**
- `retrieve(userInput, recentEntries, allLoreEntries, chapters, maxIterations)` - Returns AgenticRetrievalResult

**Retrieval loop:**
1. Initial keyword retrieval using EntryRetrievalService
2. Ask AI: "do we have enough context?"
3. If no: generate search queries (max 3)
4. Search lore entries for matches (name, description, keywords)
5. Cap at 20 entries total
6. Repeat up to maxIterations (default 3)

**Reads:** User input, recent entries, all lore entries, chapters (from params)

**Writes:** Nothing directly (results used by ContextAssembler)

**Connections:** Called by ContextAssembler during pre-generation context assembly. Results merged into retrieved tier context.

**Notable patterns:**
- Uses EntryRetrievalService for initial keyword match
- AI-driven query generation focuses on: character names, location names, faction names, concept names, specific details
- Keyword search case-insensitive, matches entry.name, entry.description, entry.injection.keywords
- Hard cap at 20 entries to prevent context explosion
- Iterative refinement: better queries → better matches

---

### FILE 19: `src/lib/services/ai/retrieval/EntryRetrievalService.ts`

**What it does:** Simple keyword-based lorebook entry retrieval.

**Exports:**
- `EntryRetrievalService` (class)
- `RetrievalResult` interface (entries, contextBlock)

**Key methods:**
- `retrieve(allEntries, recentEntries, maxEntries)` - Scores entries by keyword hits, returns top N

**Scoring logic:**
- mode == 'never': skip
- mode == 'always': score = priority + 1000 (always included)
- mode == 'keyword': count keyword hits in recent text, score = hits * priority

**Reads:** All lorebook entries, recent story entries (from params)

**Writes:** Nothing directly (results used by AgenticRetrievalService)

**Connections:** Called by AgenticRetrievalService on first retrieval pass. Also called directly by ContextAssembler as fallback tier context.

---

### FILE 20: `src/lib/services/ai/context/ContextAssembler.ts`

**What it does:** Pre-generation context assembly with dynamic, model-aware token budgets. Assembles 5 tiers of context (scene, recent, world, procedural, retrieved) scaled to the model's context window.

**Exports:**
- `ContextAssembler` (class)
- `TierBudget`, `TierUsage` interfaces (token budgets/usage per tier)
- `AssembledContext` interface (contextBlock, tierUsage, totalTokens)
- `AssembleParams` interface (all required data for assembly)
- `getModelContextWindow(model)` - Returns model's context window from lookup table

**Key methods:**
- `assemble(params)` - Returns AssembledContext

**Tiers (in prompt order):**
1. **Scene** (10% budget) - Current location, present characters, equipped items
2. **Recent** (35% budget) - All uncovered chapter summaries
3. **World** (20% budget) - Arc summaries, unresolved threads, DM plot injection
4. **Procedural** (5% budget) - CASS-inspired narrative rules, decay-scored, relevance-matched
5. **Retrieved** (30% budget) - AI-selected chapters + agentic lore search

**Model context window lookup table:**
- OpenAI: gpt-4o (128k), gpt-4-turbo (128k), gpt-3.5-turbo (16k)
- Anthropic: claude-opus-4.5 (200k), claude-sonnet-4.5 (200k), claude-haiku-4.5 (200k)
- Google: gemini-3-pro (1M), gemini-2.5-flash (1M)
- Others: Grok (131k), Deepseek (64k), Mistral (128k)
- Heuristic fallbacks: claude → 200k, gpt-4o → 128k, gemini → 1M
- Default: 128k

**Budget computation:**
- Total = model context - RESERVED_FOR_OUTPUT (4096)
- Min floor: MIN_CONTEXT_BUDGET (8000)
- User override: contextBudget setting (0 = auto)
- Each tier gets TIER_RATIOS fraction (scene 10%, recent 35%, world 20%, procedural 5%, retrieved 30%)

**Reads:** Story data (entries, characters, locations, items, lore, relationships, world events), chapters, arcs, last world sim result, settings (narrativeSettings.model, contextBudget)

**Writes:** Nothing directly (returns assembled context block for system prompt)

**Connections:** Called by ActionInput during narrative generation. Results passed to buildSystemPrompt and used as context parameter.

**Notable patterns:**
- Token estimation: text.length / 4 (rough but fast)
- Truncation function: keeps text to budget * 4 characters, adds "..."
- Procedural rules retrieved by embedding similarity (not yet fully implemented)
- Retrieved tier uses AgenticRetrievalService for intelligent context selection
- Total assembled context is bounded but each tier includes full content available within its budget

---

### FILE 21: `src/lib/components/story/StoryView.svelte`

**What it does:** Main story view component managing narrative generation, post-gen services (classifier, action choices, style review, image generation), world drawer, header editor, export/delete.

**Key internal functions:**
- `handleStreamStart()` - Resets streaming state, clears service outputs
- `handleStreamChunk(text)` - Updates streamingContent, auto-scrolls
- `handleStreamEnd(fullText)` - Runs post-gen service jobs in parallel
- `runClassifier(narrative)` - Calls ai.classifier.classify, persists characters/locations/items, syncs to lorebook
- `runActionChoices()` - Calls ai.actionChoices.generateChoices, stores in actionChoices state
- `runStyleReview(fullText)` - Calls ai.styleReviewer.review, stores in styleReview state
- `runImageGeneration(fullText)` - Calls ai.imageGen (not fully shown)
- `runChapterCheck()` - Calls ai.memory.analyzeForChapter, creates chapter if needed
- `syncClassifierToLorebook(result)` - Creates/updates lorebook entries from classifier results
- `syncClassifierRelationships(result)` - Stores EntryRelationship records from classifier
- `applyTimeProgression(timeString)` - Updates story.currentStory.timeTracker
- World Drawer: displays characters/locations/items/quests from story state
- Export: downloads story as JSON
- Delete: removes story after confirmation

**Reads:** story store (entries, characters, locations, items, mode, pov, tense), settings (service configs), database (chapters, arcs)

**Writes:** story store (addEntry, addCharacter, updateCharacter, addOrUpdateLocation, addOrUpdateItem, updatePresence, clearPresenceForCharacters, updateHeaderPrompt), database (createChapter, createLorebookEntry, updateLorebookEntry, createEntryRelationship, createConversationMemory, createWorldEvent, updateWorldEvent)

**Connections:** Main page component. Imports ActionInput, ActionChoiceCards, WorldStateToast, WorldDrawer. Receives stream callbacks from ActionInput and stores generated text.

**Notable patterns:**
- Post-gen services run in parallel via Promise.allSettled
- Chapter check runs every story to detect chapter boundaries
- Classifier results merged into world state: characters updated, locations/items created
- Lorebook auto-discovery: every entity from classifier becomes an Entry
- Presence tracking: "departed" and "deceased" clear lastSeenLocation
- Time progression parsed from classifier output (e.g., "a few minutes", "several hours")

---

### FILE 22: `src/lib/components/story/ActionInput.svelte`

**What it does:** User input form with action type selector (do/say/think/story/free), shorthand commands, streaming generation, and dice roll handling.

**Key internal functions:**
- `buildActionContent(rawInput, type)` - Constructs action from raw input + type
- `buildSayContent(text, thirdPerson, name)` - Builds say action with verb based on punctuation (? → ask, ! → yell, default → say)
- `handlePlayerRoll(rawInput)` - Standalone /roll command (no AI)
- `handleAIRollContinuation(fullResponse, systemPrompt, conversationHistory)` - Executes roll after AI narration, continues generation

**Shorthand commands (Do mode):**
- `l` → look around
- `i` → check inventory
- `z` → wait
- `n/s/e/w` → go north/south/east/west
- `ne/nw/se/sw` → diagonal directions
- `u/d` → go up/down
- `x <thing>` → examine thing

**Special syntax:**
- `!` prefix → world event (not player action)
- `"` prefix in Do → force Say behavior
- `*` suffix → AI should continue/complete (wildcard)

**Generation flow:**
1. Validate input
2. Handle player /roll or build action content
3. Build system prompt via story.buildSystemPrompt
4. Build conversation history via story.buildConversationMessages
5. Stream via streamNarrative
6. Check for AI roll markers
7. Add entry to story
8. Emit streamEnd callback

**Reads:** story store (buildSystemPrompt, buildConversationMessages, protagonist, pov), ContextAssembler (pre-generation context), streamNarrative from generate.ts

**Writes:** story store (addEntry), AbortController for cancellation

**Connections:** Child of StoryView. Emits onStreamStart, onStreamChunk, onStreamEnd callbacks. Listens for mtherios:inject-input event from suggestion/choice chips.

**Notable patterns:**
- POV-based prefixes: second person "You", third person "name", first person "I"
- Wildcard completion: trailing * or , indicates AI should continue
- Dice roll parsing: parseRollMarker returns preText and marker, generates continuation
- Spellcheck disabled by default (interactive fiction often uses made-up words)

---

### FILE 23: `src/lib/services/lorebookImporter.ts`

**What it does:** Imports lorebooks from various formats (primarily SillyTavern character cards) into Mtherios Entry system.

**Exports:**
- `importLorebookEntry(entry)` - Converts SillyTavern entry to ImportedEntry
- `parseLorebookFile(file, format)` - Parses JSON file, returns LorebookImportResult
- `TYPE_KEYWORDS` - Heuristics for inferring entry type from content

**SillyTavern format:**
- Array of entries with uid, key (keywords), keysecondary, content (description)
- Fields: selective, selectiveLogic, order, position, disable, probability, depth, group, etc.

**Inference logic:**
- Looks for type keywords in content (case-insensitive)
- Fallback: character > location > item > faction > concept > event

**Result includes:**
- entries (ImportedEntry[])
- errors (entries that failed)
- warnings (potential issues)
- metadata (format, totalEntries, importedEntries, skippedEntries)

**Reads:** File contents (from params)

**Writes:** Nothing directly (results returned for UI to save)

**Connections:** Called by LorebookImport component. Results displayed and optionally saved to story via database.createLorebookEntry.

---

### FILE 24: `src/lib/utils/dice.ts`

**What it does:** Full D&D dice notation parser and roller with support for advantage/disadvantage and DC checks.

**Exports:**
- `DiceNotation` - count, sides, modifier, advantage, disadvantage
- `DiceResult` - notation, rolls[], natural, total, modifier, sides, advantage, disadvantage, discardedRoll
- `RollCheckResult` extends DiceResult - dc, success, ability, description, critical (success|failure|null)
- `parseDice(notation)` - Parse "1d20+3", "2d6 advantage", "1d20 dis"
- `rollDice(notation|DiceNotation)` - Execute roll, return result
- `rollCheck(notation, dc, ability, description)` - Roll check against DC, set critical on 1/20
- `formatRollText(result)` - Human-readable string with notation, total, modifiers, advantage/disadvantage flags
- `encodeDiceMarker(result)` - Inline marker: {{dice:notation|natural|total|dc|success|ability|description|crit-X}}
- `parseRollMarker(text)` - Extract {{roll:DICE:DC:ABILITY:DESCRIPTION}} from AI narration
- `parseRollCommand(rawInput)` - Extract /roll notation from user input

**Rolls:**
- Normal: sum all dice + modifier
- Advantage: roll 2d sides, take higher
- Disadvantage: roll 2d sides, take lower

**Critical hits:** Only on d20, roll 1 is always fail, roll 20 is always success

**Reads:** Nothing

**Writes:** Nothing (pure functions)

**Connections:** Used by ActionInput for player /roll command and AI roll continuation. Dice results embedded in narrative via encodeDiceMarker.

---

### FILE 25: `src/lib/utils/uuid.ts`

**What it does:** UUID generation that works on HTTP (non-secure contexts).

**Exports:**
- `uuid()` - Returns UUID v4 string

**Implementation:**
- Tries crypto.randomUUID() if available (HTTPS)
- Falls back to crypto.getRandomValues() with manual UUID v4 encoding (HTTP-compatible)

**Reads:** crypto global

**Writes:** Nothing

**Connections:** Used throughout codebase for generating IDs (stories, entries, characters, locations, items, etc.).

---

### FILE 26: `src/routes/+layout.svelte`

**What it does:** Root layout component initializing settings and app stores, managing navigation state (wizard, story loading, main app shell).

**Key logic:**
- onMount: Initialize settings store, then app store
- $effect: When currentStoryId changes, load story into story store (or clear if not found)
- Rendering:
  - app.loading → splash screen
  - app.showWizard → OnboardingWizard
  - currentStoryId && story.currentStory → StoryView
  - currentStoryId && story.loading → loading screen
  - else → AppShell (library/settings/templates)

**Reads:** app store (loading, showWizard, currentStoryId), story store (currentStory, loading)

**Writes:** app store (completion), story store (loadStory)

**Connections:** Imports OnboardingWizard, StoryView, AppShell, initializes stores on mount.

**Notable patterns:**
- Graceful error handling: if story.loadStory fails, clears currentStoryId
- Preload fonts from Google Fonts (Cinzel, Cormorant Garamond, JetBrains Mono)
- Mobile-optimized viewport and app status bar styling

---

## CRITICAL DATA FLOWS

### Generation Pipeline
1. **ActionInput** receives user action
2. Builds system prompt via `story.buildSystemPrompt()`
3. Builds conversation history via `story.buildConversationMessages()`
4. Calls `ContextAssembler.assemble()` to get pre-gen context
5. Inserts context into system prompt
6. Streams via `streamNarrative()` 
7. Adds entry to story via `story.addEntry('narration', fullText)`
8. **StoryView** receives full text, runs post-gen services in parallel:
   - **Classifier** extracts world state → creates/updates characters/locations/items/lore entries
   - **ActionChoices** generates branching choices
   - **StyleReviewer** checks narrative quality
   - **ImageGeneration** creates scene images
   - **ChapterCheck** detects chapter boundaries
   - **WorldSimulation** runs once if ChapterCheck creates a new chapter
   - **ArcCondensation** creates arcs when chapter threshold is met
   - **SagaCondensation** creates sagas when 10 arcs are ready
   - **LoreManagement** discovers/curates lore entries on chapter cadence

### Context Assembly (Pre-Generation)
1. **Scene Tier** - Current location + present characters + equipped items
2. **Recent Tier** - Uncovered chapter summaries (recent chapters not yet in an arc)
3. **World Tier** - Arc summaries, saga summaries, unresolved threads, and world sim signals
4. **Procedural Tier** - Retrieved narrative rules (CASS-inspired, decay-scored)
5. **Retrieved Tier** - AgenticRetrievalService loops with AI queries until satisfied or max iterations

### Memory Condensation Hierarchy
1. **Entries** - Raw transcript evidence and canonical turn records
2. **Chapters** - Scene/checkpoint summaries created only when enough post-buffer entries accumulate
3. **Arcs** - Multi-chapter condensation, usually 5 chapters per arc
4. **Sagas** - Multi-arc condensation, 10 arcs per saga

### World State Tracking
1. **Classifier** extracts characters, locations, items, story beats, relationships, conversations
2. Classifier results → create/update entities in database
3. **Entry (Lorebook)** records created automatically for discovered entities
4. **EntryRelationship** records track connections between entities
5. **ConversationMemoryEntry** records track NPC conversations
6. **WorldEvent** records track major consequences
7. **TimeTracker** updated via classifier's timeProgression field

---

## ARCHITECTURAL PATTERNS

**Reactive State Management:**
- Svelte 5 $state for all stores (story, settings, app)
- Changes auto-propagate to components via $derived, $effect
- No external state management library

**Service Architecture:**
- BaseAIService provides model lookup, config resolution, structured generation
- Each service extends BaseAIService, implements single responsibility
- Singleton registry pattern (ai.classifier, ai.memory, etc.)
- All services read from settings store for per-service overrides

**Database:**
- Dexie.js wrapper (IndexedDB)
- Compound indices for efficient queries
- Cascading deletes on story deletion
- Version migrations with upgrade hooks

**Narrative Generation:**
- OpenAI-compatible API (supports 16+ providers)
- Bearer token auth via profile.apiKey
- Streaming + non-streaming modes
- Always-on API log for debugging

**Context Management:**
- Model-aware token budgets (128k, 200k, 1M context windows)
- 5-tier context assembly with dynamic ratios
- Keyword-based + agentic retrieval
- Procedural rules with decay scoring

**World State:**
- Living world simulation once per newly created chapter, plus manual world drawer ticks
- Faction dynamics with goals/resources/disposition
- Season-based modifiers (deterministic)
- Rumors and plot injection

---

## NOTABLE TECHNICAL DECISIONS

1. **IndexedDB over SQLite:** Browser-native storage, works on mobile/web without native dependencies
2. **Streaming narratives:** Real-time text-to-speech compatible, better UX for long responses
3. **Post-gen services:** Classifier runs after narration to keep world state eventual-consistent
4. **Context assembly pre-gen:** All context prepared before streaming, more stable results
5. **Per-service overrides:** Fine-grained control over model/temp/tokens per AI service
6. **Procedural rules:** CASS-inspired decay-adjusted rules for narrative pattern detection
7. **Faction simulation:** Full simulation engine including goals/resources/relations, not just rumors
8. **Dice integration:** Full D&D support with advantage/disadvantage, critical hits, DC checks
9. **Time tracking:** Deterministic in-story time progression enables season/holiday effects
10. **Relationship graph:** Tier 2 system tracks connections between entities for query optimization
11. **Agent-maintained wiki export:** Obsidian exports are structured as a three-layer knowledge base: immutable `raw/` transcript sources, compiled wiki/synthesis pages, and an `AGENTS.md` maintainer schema that tells future LLM sessions how to ingest, query, lint, cite, and update the vault.
12. **Terminal wiki core:** `scripts/wiki-core/` provides the first terminal-first lore layer: materialize backend-bound stories into generated Obsidian vaults, index exported or generated vaults into Qdrant, use local embeddings for semantic search, and traverse Obsidian links/backlinks outside the browser sandbox.

---

## FILES NOT YET FULLY DOCUMENTED (from git status)

The following new/modified files exist but were not fully read due to token constraints:

- `.claude/` - Debug/configuration directory
- `src/lib/components/settings/PromptInspector.svelte` - Debug UI for inspecting prompts
- `src/lib/components/story/ContextWindow.svelte` - UI for context breakdown display
- `src/lib/services/ai/context/` - Additional context services
- `src/lib/services/ai/embeddings/EmbeddingService.ts` - Vector embeddings for retrieval
- `src/lib/services/ai/generation/WorldSimulationService.ts` (rest of file)
- `src/lib/services/ai/generation/ArcCondensationService.ts` (rest)
- `src/lib/services/ai/memory/ProceduralMemoryService.ts` - Procedural rule extraction/application
- `src/lib/services/ai/vault/InteractiveVaultService.ts` - Vault (reusable assets) management
- `src/lib/services/storySync.ts` - Export/import story JSON
- `src/lib/utils/` - Additional utilities

All core systems and data flows have been documented. The above files contain secondary features and detailed implementations of documented patterns.
