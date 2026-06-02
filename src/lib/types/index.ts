// Core entity types for Aventura
export type StoryMode = 'adventure' | 'creative-writing'
export type POV = 'first' | 'second' | 'third'
export type Tense = 'past' | 'present'

// Visual descriptors for character appearance (used for image generation)
export interface VisualDescriptors {
  face?: string // Skin tone, facial features, expression, age indicators
  hair?: string // Color, length, style, texture
  eyes?: string // Color, shape, notable features
  build?: string // Height, body type, posture
  clothing?: string // Full outfit description
  accessories?: string // Jewelry, weapons, bags, distinctive items
  distinguishing?: string // Scars, tattoos, birthmarks
}

// Time tracking for story progression
export interface TimeTracker {
  years: number
  days: number
  hours: number
  minutes: number
}

/**
 * A persistent meter (sanity, morality, reputation, hunger, etc.).
 * Created on first reference by the GM via update_world_state, mutated
 * over time, and shown in the HUD when visible. The GM sees current
 * values in the state snapshot so it can reason about them.
 */
export interface Meter {
  name: string
  value: number
  max: number
  visible: boolean
}

export interface Story {
  id: string
  title: string
  description: string | null
  genre: string | null
  templateId: string | null
  mode: StoryMode
  createdAt: number
  updatedAt: number
  settings: StorySettings | null
  memoryConfig: MemoryConfig | null
  retryState: PersistentRetryState | null
  styleReviewState: PersistentStyleReviewState | null
  timeTracker: TimeTracker | null
  currentBranchId: string | null // Active branch (null = main branch for legacy stories)
  currentBgImage: string | null
  headerPrompt: string | null // Per-story preamble: tone, rules, and narrative guidelines
  /** Compact public/social reputation note for the protagonist; injected as its own prompt section. */
  playerReputation?: string | null
  /** Backend canonical story id. When set, IndexedDB is an offline cache for this story. */
  serverStoryId?: string | null
  /** Last backend version applied to the local cache. */
  serverVersion?: number | null
  /** Sync mode/status for backend-backed memory. */
  syncStatus?: 'local-only' | 'syncing' | 'synced' | 'conflict' | 'offline' | null
  lastWorldSimDay: number | null // Total in-world days when world sim last ran
  /** @deprecated CompactionService retired — `update_world_state` tool covers this. Field kept for back-compat with existing IndexedDB rows; not written by current code. */
  compactedLore: string | null
  /** @deprecated See compactedLore. */
  compactedLoreHistory: string[] | null
  meters: Meter[] | null // Hidden/visible numeric tracks (sanity, morality, reputation...)
}

export interface SyncOutboxOp {
  id: string
  storyId: string
  serverStoryId: string | null
  type: 'create_entry' | 'delete_entry' | 'turn_command' | 'state_correction' | 'pin_memory' | 'merge_memory' | 'archive_memory' | 'import_bundle'
  payload: Record<string, unknown>
  localVersion: number
  status: 'pending' | 'pushing' | 'applied' | 'rejected' | 'needs_repair'
  error: string | null
  repairPayload?: unknown
  repairReason?: string | null
  repairCreatedAt?: number | null
  createdAt: number
  updatedAt: number
}

// Persistent retry state - lightweight version saved to database
export type ActionInputType = 'do' | 'say' | 'think' | 'story' | 'free'

export interface PersistentRetryState {
  timestamp: number
  // The next entry position before user action was added (max position + 1)
  // On retry, delete entries from this position onward
  entryCountBeforeAction: number
  // The user's input data
  userActionContent: string
  rawInput: string
  actionType: ActionInputType
  wasRawActionChoice: boolean
  // Entity IDs that existed before the action - on restore, delete any not in these lists
  characterIds: string[]
  locationIds: string[]
  itemIds: string[]
  storyBeatIds: string[]
  embeddedImageIds?: string[] // Added in v1.4.0 for image generation
  characterSnapshots?: PersistentCharacterSnapshot[] // Added in v1.4.1 for retry state restoration
  // Story time snapshot captured before the user action (optional for backwards compatibility)
  timeTracker?: TimeTracker | null
  // Lorebook activation data for stickiness preservation (optional for backwards compatibility)
  activationData?: Record<string, number>
  storyPosition?: number
}

export interface PersistentCharacterSnapshot {
  id: string
  traits: string[]
  status: 'active' | 'inactive' | 'deceased'
  relationship: string | null
  visualDescriptors: VisualDescriptors
  portrait: string | null // Data URL (data:image/...) or legacy base64
}

// Persistent style review state - saved per-story for style analysis tracking
export interface PersistentPhraseAnalysis {
  phrase: string
  frequency: number
  severity: 'low' | 'medium' | 'high'
  alternatives: string[]
  contexts: string[]
}

export interface PersistentStyleReviewResult {
  phrases: PersistentPhraseAnalysis[]
  overallAssessment: string
  reviewedEntryCount: number
  timestamp: number
}

export interface PersistentStyleReviewState {
  messagesSinceLastReview: number
  lastReview: PersistentStyleReviewResult | null
}

export interface MemoryConfig {
  tokenThreshold: number // Token count before triggering summarization (default: 16000)
  chapterBuffer: number // Recent messages protected from chapter end (default: 10)
  autoSummarize: boolean // Enable auto-summarization
  enableRetrieval: boolean // Enable memory retrieval
  maxChaptersPerRetrieval: number // Max chapters to retrieve per query
}

export interface StorySettings {
  model?: string
  temperature?: number
  maxTokens?: number
  pov?: POV
  tense?: Tense
  tone?: string
  themes?: string[]
  visualProseMode?: boolean // Enable HTML/CSS visual output mode
  imageGenerationMode?: 'none' | 'agentic' | 'inline' // Image generation strategy
  backgroundImagesEnabled?: boolean
  referenceMode?: boolean
}

export interface StoryEntry {
  id: string
  storyId: string
  type: 'user_action' | 'narration' | 'system' | 'retry'
  content: string
  parentId: string | null
  position: number
  createdAt: number
  metadata: EntryMetadata | null
  branchId: string | null // Branch this entry belongs to (null = main branch for legacy)
  reasoning?: string // In-memory only reasoning (chain of thought)
  // Translation fields
  translatedContent?: string | null // Translated text for display
  translationLanguage?: string | null // Language code of translation
  originalInput?: string | null // Original user input before translation (for user_action type)
  // Phase 1: World state delta tracking
  worldStateDelta?: WorldStateDelta | null // World state changes caused by this entry's classification
  // Persisted action suggestions/choices for time-travel restore
  suggestedActions?: string | null // JSON blob: ActionChoice[] or Suggestion[] depending on story mode
}

export interface EntryMetadata {
  tokenCount?: number
  model?: string
  generationTime?: number
  source?: string
  // Story time tracking - captures in-story time at entry creation and after classification
  timeStart?: TimeTracker // Story time when this entry began
  timeEnd?: TimeTracker // Story time after classification applied time progression
  // Translation fields (for backwards compatibility, also stored in columns)
  originalInput?: string // For translateInput: original user text before translation to English
}

export interface Character {
  id: string
  storyId: string
  name: string
  description: string | null
  relationship: string | null
  traits: string[]
  visualDescriptors: VisualDescriptors // Visual appearance details for image generation
  portrait: string | null // Data URL (data:image/...) for reference in image generation
  status: 'active' | 'inactive' | 'deceased'
  metadata: Record<string, unknown> | null
  branchId: string | null // Branch this character belongs to (null = main/inherited)
  overridesId?: string | null // COW: ID of the parent entity this row overrides (null = original)
  deleted?: boolean // COD: tombstone — entity is deleted on this branch (COW only)
  // Translation fields
  translatedName?: string | null
  translatedDescription?: string | null
  translatedRelationship?: string | null
  translatedTraits?: string[] | null
  translatedVisualDescriptors?: VisualDescriptors | null
  translationLanguage?: string | null
}

// ===== Character Vault Types =====

export type VaultCharacterSource = 'manual' | 'import' | 'story'

/**
 * A reusable character template stored in the global vault.
 * Characters are copied to stories, not linked.
 */
export interface VaultCharacter {
  id: string
  name: string
  description: string | null

  // Common fields (same as Character)
  traits: string[]
  visualDescriptors: VisualDescriptors
  portrait: string | null // Data URL

  // Organization
  tags: string[]
  favorite: boolean

  // Provenance
  source: VaultCharacterSource
  originalStoryId: string | null // If saved from a story
  metadata: Record<string, unknown> | null

  createdAt: number
  updatedAt: number
}

// ===== Lorebook Vault Types =====

export type VaultLorebookSource = 'import' | 'story' | 'manual'

export interface VaultLorebookMetadata {
  format: 'aventura' | 'sillytavern' | 'unknown'
  totalEntries: number
  entryBreakdown: Record<EntryType, number>
  [key: string]: unknown
}

/**
 * A reusable lorebook stored in the global vault.
 * Contains processed ImportedEntry[] that can be copied to stories.
 */
export interface VaultLorebook {
  id: string
  name: string
  description: string | null

  // Processed entries (from LorebookImportResult)
  entries: VaultLorebookEntry[]

  // Organization
  tags: string[]
  favorite: boolean

  // Provenance
  source: VaultLorebookSource
  originalFilename: string | null
  originalStoryId: string | null

  // Metadata
  metadata: VaultLorebookMetadata | null

  createdAt: number
  updatedAt: number
}

/**
 * A lorebook entry stored in the vault.
 * Similar to ImportedEntry but without originalData for cleaner storage.
 */
export interface VaultLorebookEntry {
  name: string
  type: EntryType
  description: string
  keywords: string[]
  aliases: string[]
  injectionMode: EntryInjectionMode
  priority: number
}

// ===== Scenario Vault Types =====

export type VaultScenarioSource = 'import' | 'wizard' | 'manual'

export interface VaultScenarioNpc {
  name: string
  role: string
  description: string
  relationship: string
  traits: string[]
}

export interface VaultScenarioMetadata {
  cardVersion?: string
  sourceUrl?: string
  importing?: boolean
  hasFirstMessage?: boolean
  alternateGreetingsCount?: number
  npcCount?: number
  linkedLorebookId?: string // ID of auto-imported lorebook from embedded character_book
  [key: string]: unknown
}

/**
 * A reusable scenario stored in the global vault.
 * Contains setting, NPCs, and opening scene data extracted from character cards.
 */
export interface VaultScenario {
  id: string
  name: string
  description: string | null // Summary/preview of the scenario

  // Core content (from CardImportResult)
  settingSeed: string
  npcs: VaultScenarioNpc[]
  primaryCharacterName: string

  // Opening scene data
  firstMessage: string | null
  alternateGreetings: string[]

  // Organization
  tags: string[]
  favorite: boolean

  // Provenance
  source: VaultScenarioSource
  originalFilename: string | null

  // Metadata
  metadata: VaultScenarioMetadata | null

  createdAt: number
  updatedAt: number
}

export interface Location {
  id: string
  storyId: string
  name: string
  description: string | null
  visited: boolean
  current: boolean
  /** @deprecated Rich connection data lives in LocationEntryState.connections (lorebook). This field is unused. */
  connections: string[]
  metadata: Record<string, unknown> | null
  branchId: string | null // Branch this location belongs to (null = main/inherited)
  overridesId?: string | null // COW: ID of the parent entity this row overrides (null = original)
  deleted?: boolean // COD: tombstone — entity is deleted on this branch (COW only)
  // Translation fields
  translatedName?: string | null
  translatedDescription?: string | null
  translationLanguage?: string | null
}

export interface Item {
  id: string
  storyId: string
  name: string
  description: string | null
  quantity: number
  equipped: boolean
  location: string
  metadata: Record<string, unknown> | null
  branchId: string | null // Branch this item belongs to (null = main/inherited)
  overridesId?: string | null // COW: ID of the parent entity this row overrides (null = original)
  deleted?: boolean // COD: tombstone — entity is deleted on this branch (COW only)
  // Translation fields
  translatedName?: string | null
  translatedDescription?: string | null
  translationLanguage?: string | null
}

export interface StoryBeat {
  id: string
  storyId: string
  title: string
  description: string | null
  type: 'milestone' | 'quest' | 'revelation' | 'event' | 'plot_point'
  significance?: 'minor' | 'moderate' | 'major' | 'critical' | null
  status: 'pending' | 'active' | 'completed' | 'failed'
  triggeredAt: number | null
  resolvedAt?: number | null
  metadata: Record<string, unknown> | null
  branchId: string | null // Branch this beat belongs to (null = main/inherited)
  overridesId?: string | null // COW: ID of the parent entity this row overrides (null = original)
  deleted?: boolean // COD: tombstone — entity is deleted on this branch (COW only)
  // Translation fields
  translatedTitle?: string | null
  translatedDescription?: string | null
  translationLanguage?: string | null
}

export interface TemplateInitialState {
  protagonist?: Partial<Character>
  startingLocation?: Partial<Location>
}

// Chapter for memory system
export interface Chapter {
  id: string
  storyId: string
  number: number
  title: string | null

  // Boundaries
  startEntryId: string
  endEntryId: string
  entryCount: number

  // Content
  summary: string

  // Story time span covered by this chapter
  startTime: TimeTracker | null
  endTime: TimeTracker | null

  // Retrieval optimization metadata
  keywords: string[]
  characters: string[] // Character names mentioned
  locations: string[] // Location names mentioned
  plotThreads: string[]
  emotionalTone: string | null

  branchId: string | null // Branch this chapter belongs to (null = main branch for legacy)
  /** Pinned chapters are never consumed by arcs — they stay in the Recent tier permanently
   *  as persistent grounding context (lore bibles, timelines, reference material). */
  pinned?: boolean

  createdAt: number
}

// StoryThread — structured plot thread with lifecycle
export interface StoryThread {
  id: string
  storyId: string
  description: string
  status: 'open' | 'imminent' | 'stalled' | 'closed' | 'abandoned'
  significance: 'minor' | 'moderate' | 'major' | 'critical'
  sourceArcId: string | null
  sourceChapterId: string | null
  createdAt: number
  updatedAt: number
  closedAt: number | null
  closureReason: string | null
  relatedFactionIds: string[]
  relatedCharacterNames: string[]
}

// Arc — condensed summary of multiple chapters
export interface Arc {
  id: string
  storyId: string
  arcNumber: number
  title: string
  summary: string
  keyPlotPoints: string[]
  characterArcs: Array<{ name: string; development: string }>
  unresolvedThreads: string[] // DEPRECATED: migrate to threadIds
  threadIds: string[]
  resolvedThreadIds: string[]
  emotionalProgression: string
  chapterIds: string[] // IDs of chapters condensed into this arc
  chapterRange: string // e.g. "1-5"
  branchId: string | null
  createdAt: number
}

// Saga - condensed summary of multiple arcs
export interface Saga {
  id: string
  storyId: string
  sagaNumber: number
  title: string
  summary: string
  arcIds: string[]
  arcRange: string // e.g. "Arcs 1-10"
  keyFactionShifts: string[]
  majorPowerChanges: string[]
  lingeringThreads: string[]
  overallTone: string
  branchId: string | null
  createdAt: number
}

// Checkpoint for save/restore functionality
export interface Checkpoint {
  id: string
  storyId: string
  name: string

  // Snapshot boundaries
  lastEntryId: string
  lastEntryPreview: string | null
  entryCount: number

  // Deep copy of state
  entriesSnapshot: StoryEntry[]
  charactersSnapshot: Character[]
  locationsSnapshot: Location[]
  itemsSnapshot: Item[]
  storyBeatsSnapshot: StoryBeat[]
  chaptersSnapshot: Chapter[]
  // Optional: undefined means "preserve current time" on restore (for backward compatibility)
  timeTrackerSnapshot?: TimeTracker | null
  // Optional: undefined means "preserve current lorebook" on restore (for backward compatibility)
  lorebookEntriesSnapshot?: Entry[]

  createdAt: number
}

// Branch for story branching/alternate timeline support
export interface Branch {
  id: string
  storyId: string
  name: string
  parentBranchId: string | null // NULL for main branch
  forkEntryId: string // Entry where this branch diverges from parent
  checkpointId: string | null // Checkpoint for world state restoration
  createdAt: number
  snapshotComplete?: boolean // When true, branch has its own complete entity set (no lineage resolution needed)
}

// ===== Entry/Lorebook System (per design doc section 3.2) =====

export type EntryType = 'character' | 'location' | 'item' | 'faction' | 'concept' | 'event'
export type EntryInjectionMode = 'always' | 'keyword' | 'never'
export type EntryCreator = 'user' | 'ai' | 'import' | 'forge'

/**
 * Entry - Unified lorebook and tracker system.
 * Combines static descriptions with dynamic state tracking.
 * Per design doc section 3.2.1
 */
export interface Entry {
  id: string
  storyId: string
  name: string
  type: EntryType

  // Static content
  description: string
  hiddenInfo: string | null // Info protagonist doesn't know yet
  aliases: string[]

  // Dynamic state (type-specific)
  state: EntryState

  // Mode-specific state (optional)
  adventureState: AdventureEntryState | null
  creativeState: CreativeEntryState | null

  // Injection rules
  injection: EntryInjection

  // Metadata
  firstMentioned: string | null // Entry ID where first mentioned
  lastMentioned: string | null // Entry ID where last mentioned
  mentionCount: number
  createdBy: EntryCreator
  createdAt: number
  updatedAt: number

  // Lore management settings
  loreManagementBlacklisted: boolean // If true, hidden from AI lore management

  // Branch support
  branchId: string | null // Branch this entry belongs to (null = main/inherited)
  overridesId?: string | null // COW: ID of the parent entity this row overrides (null = original)
  deleted?: boolean // COD: tombstone — entity is deleted on this branch (COW only)
}

export interface EntryInjection {
  mode: EntryInjectionMode
  keywords: string[]
  priority: number // Higher = inject first
}

// Base entry state (common fields)
export interface BaseEntryState {
  type: EntryType
}

// Character-specific state (per design doc section 3.2.2)
export interface CharacterEntryState extends BaseEntryState {
  type: 'character'
  isPresent: boolean
  lastSeenLocation: string | null
  currentDisposition: string | null
  relationship: {
    level: number // -100 to 100
    status: string
    history: RelationshipChange[]
  }
  knownFacts: string[]
  revealedSecrets: string[]
  // Conversation memory
  conversationTopics?: string[]
  lastConversationAt?: number | null
  personalOpinion?: string | null
  // Character enrichment (populated by lore management)
  bio?: string | null
  motivations?: string[] | null
  personality?: string | null
  // Active pressures — circumstances tightening around this NPC that they
  // will act on even when the player isn't watching. Short sentences.
  // Examples: "being courted by a wealthy older merchant", "father has gambling debts",
  // "wants revenge for a slain brother", "running out of coin".
  pressures?: string[]
}

export interface RelationshipChange {
  description: string
  entryId: string
  timestamp: number
}

// Location-specific state
export interface LocationConnection {
  targetLocationId: string
  targetLocationName: string
  direction: string | null
  travelTime: number
  description: string | null
  blocked: boolean
  blockedReason: string | null
}

export interface LocationEntryState extends BaseEntryState {
  type: 'location'
  isCurrentLocation: boolean
  visitCount: number
  changes: { description: string; entryId: string }[]
  presentCharacters: string[]
  presentItems: string[]
  connections?: LocationConnection[]
  region?: string | null
  terrain?: string | null
}

// Item-specific state
export interface ItemEntryState extends BaseEntryState {
  type: 'item'
  inInventory: boolean
  currentLocation: string | null // Entry ID or 'inventory'
  condition: string | null
  uses: { action: string; result: string; entryId: string }[]
}

/**
 * Inter-faction relation. `standing` is the fast-moving current temperature;
 * `affinity` is the slower-moving "trust" — a brittle alliance has high
 * standing but low affinity. `history` is a capped log of recent shifts that
 * F5 (loop closure) reads back into the worldsim AI's context.
 *
 * Stored values may also still be plain `number` from pre-F4 stories — code
 * that reads `interFactionRelations[name]` MUST normalize through `getRel()`
 * (see WorldSimulationService / story.svelte.ts).
 */
export interface FactionRelation {
  standing: number // -100..100, fast-moving
  affinity: number // -100..100, slow-moving "trust"
  history?: { event: string; delta: number; chapter: number }[] // capped at last 5
}

// Faction-specific state
export interface FactionEntryState extends BaseEntryState {
  type: 'faction'
  playerStanding: number // -100 to 100
  status: 'allied' | 'neutral' | 'hostile' | 'unknown'
  knownMembers: string[] // Entry IDs of known members
  // Extended faction simulation fields (optional for backward compatibility)
  goals?: FactionGoal[]
  resources?: FactionResources
  disposition?: 'aggressive' | 'defensive' | 'scheming' | 'neutral' | 'desperate'
  /**
   * factionName → relation. Pre-F4 stories store a `number` (legacy standing-only).
   * Post-F4 writes always emit `FactionRelation`. Use `normalizeRelation()` to read.
   */
  interFactionRelations?: Record<string, FactionRelation | number>
  territory?: string[] // Region/location names this faction controls
  lastActionChapter?: number // Chapter number when faction last acted (for cadence tracking)
}

// Faction goal tracking
export interface FactionGoal {
  description: string
  priority: number // 1-10, higher = more important
  progress: number // 0-100, percentage toward completion
  type: 'military' | 'diplomatic' | 'economic' | 'intelligence' | 'survival' | 'expansion'
  deadline?: string // Narrative deadline (e.g., "before winter", "when the king dies")
}

// Faction resource tracking
export interface FactionResources {
  military: number    // 0-100 relative strength
  wealth: number      // 0-100 relative wealth
  influence: number   // 0-100 political influence / soft power
  information: number // 0-100 spy network / intelligence capability
  morale: number      // 0-100 internal cohesion / loyalty
}

// Concept-specific state (lore concepts, magic systems, etc.)
export interface ConceptEntryState extends BaseEntryState {
  type: 'concept'
  revealed: boolean
  comprehensionLevel: 'unknown' | 'basic' | 'intermediate' | 'advanced'
  relatedEntries: string[] // Entry IDs
}

// Event-specific state
export interface EventEntryState extends BaseEntryState {
  type: 'event'
  occurred: boolean
  occurredAt: number | null
  witnesses: string[] // Entry IDs
  consequences: string[]
}

export type EntryState =
  | CharacterEntryState
  | LocationEntryState
  | ItemEntryState
  | FactionEntryState
  | ConceptEntryState
  | EventEntryState

// Adventure mode specific state
export interface AdventureEntryState {
  discovered: boolean
  interactedWith: boolean
  notes: string[] // Player notes
}

// Creative writing mode specific state
export interface CreativeEntryState {
  arc: {
    want: string | null // External goal (for characters)
    need: string | null // Internal growth
    flaw: string | null // What holds them back
    currentState: string | null
  } | null
  thematicRole: string | null
  symbolism: string | null
}

// Entry preview for listings (lighter than full Entry)
export interface EntryPreview {
  id: string
  name: string
  type: EntryType
  description: string
  aliases: string[]
}

// ===== Lore Management System (per design doc section 3.4) =====

export type LoreChangeType = 'create' | 'update' | 'merge' | 'delete' | 'complete'

export interface LoreChange {
  type: LoreChangeType
  entry?: Entry
  previous?: Partial<Entry>
  mergedFrom?: string[]
  summary?: string
}

export interface LoreManagementResult {
  changes: LoreChange[]
  summary: string
  sessionId: string
}

// ===== Agentic Session Tracking =====

export interface AgenticSession {
  id: string
  type: 'lore-management' | 'agentic-retrieval'
  storyId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  startedAt: number
  completedAt: number | null
  messageCount: number
  // Session is stored separately, not persisted to DB
}

// UI State types
export type ActivePanel =
  | 'story'
  | 'library'
  | 'settings'
  | 'templates'
  | 'lorebook'
  | 'memory'
  | 'vault'
  | 'gallery'
export type SidebarTab = 'characters' | 'locations' | 'inventory' | 'quests' | 'time' | 'branches'

export interface UIState {
  activePanel: ActivePanel
  sidebarTab: SidebarTab
  sidebarOpen: boolean
  settingsModalOpen: boolean
}

// Provider types matching Vercel AI SDK providers
export type ProviderType =
  | 'openrouter' // @openrouter/ai-sdk-provider
  | 'nanogpt' // OpenAI-compatible at nano-gpt.com
  | 'chutes' // @chutes-ai/ai-sdk-provider
  | 'pollinations' // ai-sdk-pollinations
  | 'ollama' // @ai-sdk/openai-compatible (local)
  | 'lmstudio' // @ai-sdk/openai (local, default localhost:1234)
  | 'llamacpp' // @ai-sdk/openai (local, default localhost:8080)
  | 'nvidia-nim' // @ai-sdk/openai (NVIDIA NIM)
  | 'openai-compatible' // @ai-sdk/openai (requires custom baseUrl)
  | 'openai' // @ai-sdk/openai
  | 'anthropic' // @ai-sdk/anthropic
  | 'google' // @ai-sdk/google
  | 'xai' // @ai-sdk/xai (Grok)
  | 'groq' // @ai-sdk/groq
  | 'zhipu' // zhipu-ai-provider (Z.AI/GLM)
  | 'deepseek' // @ai-sdk/deepseek
  | 'mistral' // @ai-sdk/mistral
  | 'google-ai-studio' // OpenAI-compatible at generativelanguage.googleapis.com
  | 'google-vertex' // OpenAI-compatible at Vertex AI endpoint
  | 'google-agent-platform' // OpenAI-compatible Gemini Enterprise Agent Platform via ADC proxy
  | 'anthropic-proxy' // Local proxy for Claude subscription users
  | 'kimi' // Moonshot AI — Kimi K2 family, OpenAI-compatible

// API Profile for saving OpenAI-compatible endpoint configurations
export interface APIProfile {
  id: string // UUID
  name: string // User-friendly name (e.g., "Local LLM", "OpenRouter")
  providerType: ProviderType // Explicit provider selection (determines SDK provider)
  baseUrl?: string // Optional custom base URL (works for all providers)
  apiKey: string // API key for this endpoint
  terminalApiKeyRef?: string | null // Env/config key reference the terminal process should resolve
  customModels: string[] // Manually added models
  fetchedModels: string[] // Auto-fetched from /models endpoint
  reasoningModels: string[] // Models that support reasoning (fetched from API capabilities)
  hiddenModels: string[] // Models hidden from selection lists
  favoriteModels: string[] // Models shown at the top of selection lists
  createdAt: number // Timestamp
}

// API Settings
export interface APISettings {
  // Legacy fields - kept for backwards compatibility during migration
  openaiApiURL: string
  openaiApiKey: string | null
  // Saved profiles
  profiles: APIProfile[]
  activeProfileId: string | null // ID of profile being edited in API tab (UI state only)
  // Main narrative generation settings
  mainNarrativeProfileId: string // Profile used for main story generation
  defaultProfileId?: string // Global default profile used as fallback
  defaultModel: string
  temperature: number
  maxTokens: number
  reasoningEffort: ReasoningEffort // Reasoning effort for the main narrative model
  manualBody: string // Manual request body JSON for the main narrative model
  enableThinking: boolean // Legacy toggle for reasoning (backward compatibility)
  llmTimeoutMs: number // Request timeout in milliseconds (default: 360000 = 6 minutes)
  useNativeTimeout: boolean // If true, pass timeout to API's native timeout parameter (modern SDK-compatible endpoints)
}

export type ReasoningEffort = 'off' | 'low' | 'medium' | 'high'

// Mtherios: single theme, no theme registry needed
export type ThemeId = 'mtherios'

export type FontSource = 'default' | 'system' | 'google'

export interface UISettings {
  theme: ThemeId
  fontSize: 'small' | 'medium' | 'large'
  fontFamily: string
  fontSource: FontSource
  showWordCount: boolean
  autoSave: boolean
  spellcheckEnabled: boolean
  debugMode: boolean
  disableSuggestions: boolean
  disableActionPrefixes: boolean
  showReasoning: boolean
  sidebarWidth: number
  autoScroll: boolean
  showScrollToTop: boolean
  showScrollToBottom: boolean
  imageGenerationMode: 'none' | 'inline' | 'agentic'
  imageStyle: string
  imageCustomStyle?: string
  imageSize: string
  imageModel?: string
  imageProfileId?: string
  imageCharacterPrompt?: string
  // Memory settings
  maxMessages: number
  maxHistoryEntries: number
  chapterThreshold: number
  postChapterBuffer: number
  maxPrevChaptersInSummary: number
  chaptersPerArc: number
  retrievedChapterLimit: number
  retrievedLoreEntryLimit: number
  conversationMemoryLimit: number
  proceduralMemoryLimit: number
  backendMemoryTokenBudget: number
  snapshotTokenCap: number // 0 = unlimited (context window is the limit)
  /** Route online turns through the terminal world database when the story is bound to a server story id. */
  serverAuthoritativeTurns?: boolean
}

export interface UpdateSettings {
  autoCheck: boolean // Check for updates on startup
  autoDownload: boolean // Automatically download updates
  checkInterval: number // Hours between update checks (0 = only on startup)
  lastChecked: number | null // Timestamp of last check
}

// ===== Image Provider & Profile System =====

export type ImageProviderType =
  | 'nanogpt'
  | 'openai'
  | 'openrouter'
  | 'chutes'
  | 'pollinations'
  | 'google'
  | 'zhipu'
  | 'comfyui'

export interface ImageProfile {
  id: string
  name: string
  providerType: ImageProviderType
  apiKey: string
  baseUrl?: string
  model: string
  providerOptions: Record<string, unknown>
  createdAt: number
}

// ===== Image Generation System =====

export type EmbeddedImageStatus = 'pending' | 'generating' | 'complete' | 'failed'

export interface EmbeddedImage {
  id: string
  storyId: string
  entryId: string
  sourceText: string // Text matched in narrative (case-insensitive)
  prompt: string // Full generation prompt
  styleId: string // Image style template used
  model: string // Image model used
  imageData: string // Base64 encoded image
  width?: number
  height?: number
  status: EmbeddedImageStatus
  errorMessage?: string
  createdAt: number
  generationMode?: 'analyzed' | 'inline' // How image was triggered (analyzed = LLM scene analysis, inline = <pic> tag)
}

// ===== Inline Image Generation System =====

/**
 * Parsed <pic> tag from narrative content.
 * Used for inline image generation mode where AI embeds image tags directly in narrative.
 */
export interface InlineImageTag {
  /** Full original tag text (e.g., '<pic prompt="..." characters="..."></pic>') */
  originalTag: string
  /** Start position in content */
  startIndex: number
  /** End position in content */
  endIndex: number
  /** Image generation prompt */
  prompt: string
  /** Character names for portrait reference */
  characters: string[]
  /** Generated image ID (assigned during processing) */
  imageId?: string
  /** Processing status */
  status: 'pending' | 'generating' | 'complete' | 'failed'
}

export type ImageSize = '512x512' | '1024x1024' | '2048x2048'

export interface ImageGenerationSettings {
  enabled: boolean // Toggle for image generation (default: false)
  profileId: string | null // API profile to use for image generation
  model: string // Image model (default: 'z-image-turbo')
  styleId: string // Selected image style template
  portraitStyleId?: string // Character portrait style template
  size: ImageSize // Regular image size
  referenceSize?: ImageSize // Reference image size
  portraitSize?: ImageSize // Portrait image size
  maxImagesPerMessage: number // Max images to generate per narrative (default: 2)

  // Prompt analysis model settings (for identifying imageable scenes)
  promptProfileId: string | null // API profile for prompt analysis
  promptModel: string
  promptTemperature: number
  promptMaxTokens: number
  reasoningEffort: ReasoningEffort
  manualBody: string
}

export interface GenerationPreset {
  id: string
  name: string
  description: string | null
  profileId: string | null // API profile to use (null = use main narrative profile)
  model: string
  temperature: number
  maxTokens: number
  reasoningEffort: ReasoningEffort
  manualBody: string
}

// ===== Translation System Types =====

/**
 * Translation settings for multi-language support.
 * English prompts for LLM quality, translated display for user experience.
 */
export interface TranslationSettings {
  enabled: boolean
  sourceLanguage: string // 'auto' or ISO code (user's language)
  targetLanguage: string // ISO code (display language)
  translateNarration: boolean // Translate AI responses after generation
  translateUserInput: boolean // Translate user input to English for prompts
  translateWorldState: boolean // Translate world state UI elements
}

// ===== Experimental Features =====

export interface ExperimentalFeatures {
  /** Phase 1: Record world state deltas on story entries after classification */
  stateTracking: boolean
  /** Phase 2: Undo world state changes when deleting entries (cascade rollback) */
  rollbackOnDelete: boolean
  /** Phase 3: Copy-on-write branches instead of full entity duplication */
  lightweightBranches: boolean
  /** Number of entries between automatic world state snapshots (for fast rollback) */
  autoSnapshotInterval: number
  /** Android: Keep generation alive when app is backgrounded or screen is locked */
  backgroundGeneration: boolean
  /** Android: Send OS notification when generation completes while app is backgrounded */
  generationNotifications: boolean
  /** Android: Include preview of generated text in the completion notification */
  notificationPreview: boolean
}

// ===== World State Delta Tracking (Phase 1) =====

/** Snapshot of a character's mutable fields before a classification update */
export interface CharacterBeforeState {
  id: string
  name: string
  status: string
  relationship: string | null
  traits: string[]
  visualDescriptors: VisualDescriptors
  /** Metadata snapshot for rollback (includes runtimeVars from pack runtime variables) */
  metadata?: Record<string, unknown> | null
}

/** Snapshot of a location's mutable fields before a classification update */
export interface LocationBeforeState {
  id: string
  name: string
  visited: boolean
  current: boolean
  description: string | null
  /** Metadata snapshot for rollback (includes runtimeVars from pack runtime variables) */
  metadata?: Record<string, unknown> | null
}

/** Snapshot of an item's mutable fields before a classification update */
export interface ItemBeforeState {
  id: string
  name: string
  quantity: number
  equipped: boolean
  location: string
  /** Metadata snapshot for rollback (includes runtimeVars from pack runtime variables) */
  metadata?: Record<string, unknown> | null
}

/** Snapshot of a story beat's mutable fields before a classification update */
export interface StoryBeatBeforeState {
  id: string
  title: string
  status: string
  description: string | null
  resolvedAt: number | null
  /** Metadata snapshot for rollback (includes runtimeVars from pack runtime variables) */
  metadata?: Record<string, unknown> | null
}

/**
 * Records the complete world state change caused by a single classification.
 * Stored as JSON on the story_entries.world_state_delta column.
 * Contains enough information to fully undo the classification's effects.
 */
export interface WorldStateDelta {
  /** The raw classification result that was applied (stored as-is for debugging/audit) */
  classificationResult: Record<string, unknown>

  /** Before-state of each entity that was UPDATED (for undo) */
  previousState: {
    characters: CharacterBeforeState[]
    locations: LocationBeforeState[]
    items: ItemBeforeState[]
    storyBeats: StoryBeatBeforeState[]
    /** ID of the location that was 'current' before this classification */
    currentLocationId: string | null
    /** Time tracker state before time progression was applied */
    timeTracker: TimeTracker | null
  }

  /** IDs of entities CREATED by this classification (undo = delete these) */
  createdEntities: {
    characterIds: string[]
    locationIds: string[]
    itemIds: string[]
    storyBeatIds: string[]
  }
}

/**
 * Periodic full snapshot of world state for fast rollback reconstruction.
 * Instead of replaying all deltas from the start, rollback can start from the
 * nearest snapshot and only replay/undo deltas from there.
 */
export interface WorldStateSnapshot {
  id: string
  storyId: string
  branchId: string | null
  entryId: string
  entryPosition: number
  charactersSnapshot: Character[]
  locationsSnapshot: Location[]
  itemsSnapshot: Item[]
  storyBeatsSnapshot: StoryBeat[]
  lorebookEntriesSnapshot?: Entry[]
  timeTrackerSnapshot: TimeTracker | null
  createdAt: number
}

// ===== Procedural Memory System (CASS-inspired) =====

export type RuleCategory =
	| 'character_behavior'  // "Kira betrays allies under pressure"
	| 'world_rule'          // "Magic fails in the Northern Wastes"
	| 'narrative_pattern'   // "Player prefers political intrigue"
	| 'player_preference'   // "Player dislikes exposition dumps"
	| 'anti_pattern'        // "Don't reuse the betrayal twist"
	| 'lore_connection'     // "The Sunstone is tied to the Eclipse Prophecy"

export type RuleMaturity = 'candidate' | 'established' | 'proven' | 'deprecated'
export type RuleScope = 'global' | 'story' | 'arc' | 'chapter'

export interface RuleFeedback {
	type: 'helpful' | 'harmful'
	entryId: string // Story entry where feedback occurred
	timestamp: number
}

/**
 * ProceduralRule — CASS PlaybookBullet equivalent for narrative.
 * Confidence-scored, decay-adjusted rules that evolve over time.
 */
export interface ProceduralRule {
	id: string
	storyId: string
	content: string
	category: RuleCategory
	scope: RuleScope
	type: 'rule' | 'anti_pattern'
	maturity: RuleMaturity

	// Scoring (CASS-inspired decay + feedback)
	helpfulCount: number
	harmfulCount: number
	effectiveScore: number // decay-adjusted composite score (0-1)

	// Provenance
	sourceChapterIds: string[]
	sourceArcIds: string[]
	relatedEntryIds: string[] // lorebook entry IDs this rule references

	// Embedding vector for semantic retrieval
	embedding: number[] | null

	tags: string[]
	createdAt: number
	updatedAt: number
	lastReinforcedAt: number // last time this rule got positive feedback
}

// ===== Embedding Cache =====

export interface EmbeddingCacheEntry {
	id: string
	sourceId: string // ID of the embedded entity
	sourceType: 'lorebook' | 'chapter' | 'arc' | 'rule' | 'query'
	contentHash: string // hash of embedded text (for invalidation)
	vector: number[]
	model: string
	createdAt: number
}

export type VaultType = 'character' | 'lorebook' | 'scenario'

export interface VaultTag {
  id: string
  name: string
  type: VaultType
  color: string
  createdAt: number
}

export interface VaultConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: string // JSON blob — AI SDK ModelMessage[]
  chatMessages: string // JSON blob — ChatMessage[] (UI display state with diff cards, images, reasoning)
  pendingChanges: string // JSON blob — VaultPendingChange[] (full list including status)
}

// ===== Tier 2: Relationship Graph =====

export type RelationshipType =
  | 'member-of' | 'leader-of' | 'allied-with' | 'enemy-of'
  | 'located-in' | 'part-of' | 'created-by' | 'triggered-by'
  | 'knows-about' | 'owns' | 'serves' | 'related-to'

export interface EntryRelationship {
  id: string
  storyId: string
  sourceEntryId: string
  targetEntryId: string
  type: RelationshipType
  label: string | null
  strength: number
  bidirectional: boolean
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

// ===== Tier 2: Conversation Memory =====

export interface ConversationMemoryEntry {
  id: string
  storyId: string
  npcEntryId: string
  npcName: string
  storyEntryId: string
  storyPosition: number
  topic: string
  playerSaid: string
  npcLearned: string[]
  emotionalImpact: string | null
  importance: 'trivial' | 'minor' | 'significant' | 'critical'
  createdAt: number
}

// ===== Tier 2: Event/Consequence System =====

export type ConsequenceStatus = 'pending' | 'applied' | 'expired' | 'reversed'

export interface WorldEvent {
  id: string
  storyId: string
  name: string
  description: string
  triggerEntryId: string
  triggerPosition: number
  sourceEntityId: string | null
  type: 'death' | 'hostility_change' | 'territory_change' | 'alliance_formed' |
        'alliance_broken' | 'item_destroyed' | 'location_blocked' | 'secret_revealed' | 'custom'
  severity: 'minor' | 'moderate' | 'major' | 'catastrophic'
  consequences: Consequence[]
  appliedAt: number | null
  createdAt: number
}

export interface Consequence {
  id: string
  description: string
  status: ConsequenceStatus
  targetEntityId: string | null
  targetEntityName: string
  effectType: 'relationship_change' | 'faction_status_change' | 'location_blocked' |
              'location_unblocked' | 'npc_status_change' | 'rumor_spread' | 'custom'
  effectPayload: Record<string, unknown>
  delay: number
  appliedAt: number | null
}

// ════════════════════════════════════════════════════════════════
// Living-World Persistence — Agreements + WorldSim records
// ════════════════════════════════════════════════════════════════

/**
 * AgreementCategory covers everything from "formal treaty between houses"
 * to "blood oath sworn to a god". One table, one enum — the category
 * disambiguates, UI + export can group on it.
 */
export type AgreementCategory =
  | 'treaty'    // formal agreement between factions
  | 'pact'      // general deal
  | 'alliance'  // mutual defense / cooperation
  | 'oath'      // sworn personal vow
  | 'debt'      // one party owes another
  | 'promise'   // less binding than oath
  | 'marriage'  // formal bond
  | 'bond'      // vassalage, knighthood, apprenticeship — long-term role tie
  | 'contract'  // written, often commercial
  | 'vassalage' // explicit subordinate/liege relationship
  | 'bargain-with-entity' // faustian / magical pact with a supernatural party

export type AgreementStatus = 'active' | 'broken' | 'fulfilled' | 'expired' | 'contested'

export type AgreementSecrecy = 'public' | 'known' | 'secret'

/**
 * Persistent record of a commitment between one or more parties.
 *
 * Parties are stored as display names (matching lorebook entry names or
 * freeform strings) so the record survives entity renames/merges; the
 * orchestrator resolves them by name on read.
 */
export interface Agreement {
  id: string
  storyId: string
  parties: string[]
  category: AgreementCategory
  terms: string // prose — what was agreed
  status: AgreementStatus
  secrecy: AgreementSecrecy
  createdChapterNumber: number | null // null if created before any chapter
  resolvedChapterNumber: number | null // chapter in which it broke/fulfilled/expired
  consequences: string[] // free-text narrative consequences
  metadata: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
}

/**
 * Persisted version of the in-memory FactionAction emitted by WorldSim.
 * Becomes queryable history instead of vanishing each turn.
 */
export interface FactionActionRecord {
  id: string
  storyId: string
  factionName: string
  action: string // one-line description of what the faction did
  actionType: string // military | diplomatic | economic | intelligence | internal | ...
  target: string | null // name of faction / character / region targeted
  motivation: string | null
  consequences: string[]
  urgency: 'low' | 'medium' | 'high' | 'critical'
  affectedRegions: string[]
  chapterNumber: number | null
  status: 'active' | 'resolved' | 'superseded'
  createdAt: number
}

/**
 * A staged plan owned by an antagonist faction/NPC or by the player.
 * Birthed by `update_world_state` story beats (antagonist schemes) or by
 * the player declaring intent via /plan or the Declare Plan modal.
 * Stages advance on the world clock (time conditions) or on player acts.
 * When a stage matures, its `hook` is injected into the narrator system
 * prompt — forcing weaker models to deliver the beat instead of vibing
 * past it.
 */
export interface Scheme {
  id: string
  storyId: string

  ownerType: 'faction' | 'character' | 'player'
  ownerEntryId: string | null // null for player schemes
  ownerName: string // display name for prompt injection

  goal: string
  trigger: string // what action birthed this scheme (free-text)
  triggerChapter: number | null
  triggerEntryId: string | null

  stages: SchemeStage[]
  currentStageIndex: number
  pressure: number // 0..100 — scales narrative intensity

  status: 'incubating' | 'active' | 'climaxing' | 'resolved' | 'foiled' | 'abandoned'
  secrecy: 'secret' | 'rumored' | 'known' // does the player know about it?

  /** In-world day when the current time-conditioned stage should advance. Null when not time-gated. */
  nextTickAtDay: number | null

  branchId: string | null // null = main branch
  createdAt: number
  updatedAt: number
}

export interface SchemeStage {
  index: number
  label: string // e.g. "gather allies", "forge the letter", "strike at feast"
  hook: string // narrative beat to inject when stage activates
  condition: 'time' | 'player-location' | 'player-act' | 'prerequisite'
  conditionPayload: Record<string, unknown> // shape depends on condition
  completed: boolean
  completedAt: number | null
}

/**
 * Persisted version of a Rumor emitted by WorldSim. Truthfulness is kept
 * as a continuous 0..1 value so the UI/export can render it flexibly
 * (reliable / uncertain / dubious bands).
 */
export interface RumorRecord {
  id: string
  storyId: string
  content: string
  truthfulness: number // 0..1
  originRegion: string
  spreadRadius: 'local' | 'regional' | 'continental'
  sourceType: string // "overheard" | "official" | "trader-gossip" | ...
  relatedFaction: string | null
  chapterNumber: number | null
  staleAfterChapters: number // how many chapters until the rumor goes stale
  status: 'spreading' | 'mature' | 'stale' | 'debunked'
  createdAt: number
}
