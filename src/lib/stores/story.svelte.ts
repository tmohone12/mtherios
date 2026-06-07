/**
 * Story Store — Mtherios
 * Manages the active story: entries, characters, locations, items, lorebook.
 */

import {
	getStory, countStoryEntries, getRecentStoryEntries, getStoryEntriesBeforePosition, getLastStoryEntryPosition, getCharacters, getLocations, getItems,
	getLorebookEntries, createStoryEntry, putStoryEntry, deleteStoryEntry, deleteStoryEntriesFromPosition,
	updateStory,
	putLorebookEntry, putCharacter, putLocation, putItem,
	getEntryRelationships, getConversationMemory, getWorldEvents,
	getChapters, getStoryBeats, getArcs,
	getEmbeddedImages, getEmbeddedImagesForEntryIds, createEmbeddedImage, deleteEmbeddedImage,
	createAgreement, updateAgreement, getAgreements, putAgreement,
	getFactionActions, getRumors, putConversationMemory, bulkPutFactionActions, bulkPutRumors, bulkPutSchemes,
	getSchemes, getStoryThreads,
	putChapter, putArc, putSaga, putWorldEvent, putStoryThread,
	getSyncOpsForStory, updateSyncOp, deleteSyncOp,
} from '$lib/services/database';
import {
	patchCanonicalLorebookEntry,
	saveCanonicalCharacter,
	saveCanonicalItem,
	saveCanonicalLocation,
	saveCanonicalWorldEvent,
} from '$lib/services/canonicalWrites';
import { uuid } from '$lib/utils/uuid';
import { countTokens } from '$lib/utils/tokens';
import { normalizeRelation } from '$lib/services/ai/tools/helpers';
import { buildEconomyScaleBlock } from '$lib/services/ai/context/economyScale';
import type { Story, StoryEntry, Character, Location, Item, Entry, EntryRelationship, ConversationMemoryEntry, WorldEvent, FactionEntryState, CharacterEntryState, LocationEntryState, ItemEntryState, ConceptEntryState, EventEntryState, EmbeddedImage, Agreement, AgreementCategory, AgreementSecrecy, FactionActionRecord, RumorRecord, Arc, Saga, Chapter, StoryBeat, Scheme, StoryThread, ProceduralRule } from '$lib/types';
import { injectSchemes } from '$lib/services/ai/scheme/SchemeService';
import type { WorldSimulationResult, PlotMomentum } from '$lib/services/ai/sdk/schemas/worldsim';
import type { SeasonEffect } from '$lib/services/ai/generation/WorldSimulationService';

const INITIAL_TRANSCRIPT_LOAD_LIMIT = 80;
const OLDER_TRANSCRIPT_PAGE_SIZE = 80;

/**
 * Structured world-state snapshot assembled before narration.
 * Replaces the old freeform string-based context block — each section
 * helper of buildSystemPrompt can pull typed data directly.
 */
/** Display-only rumor shape — matches both stored RumorRecord and fresh WorldSim output. */
export interface RumorDisplay {
	content: string;
	truthfulness: number;
	spreadRadius: 'local' | 'regional' | 'continental';
	sourceType: string;
	originRegion: string;
}

export interface StateSnapshot {
	arcs: Arc[];
	chapters: Chapter[];
	storyBeats: StoryBeat[];
	currentLocation: Location | null;
	presentCharacters: Character[];
	equippedItems: Item[];
	activeAgreements: Agreement[];
	recentWorldEvents: WorldEvent[];
	reachableRumors: RumorDisplay[];
	factionActions: FactionActionRecord[];
	/** Top ~6 factions worth showing the narrator (scored by player-standing magnitude + recent activity). */
	relevantFactions: Entry[];
	/** Semantically retrieved lorebook entries relevant to recent narration, already de-duped against
	 *  presentCharacters and relevantFactions so the narrator doesn't see the same NPC/faction twice. */
	retrievedEntries: Entry[];
	/** Compact chapter memories retrieved for the current action. */
	retrievedChapters: Chapter[];
	/** Why the episodic memories were selected, for debugging / future UI surfacing. */
	retrievedChapterReason: string | null;
	/** Learned narrative rules selected for this turn. */
	proceduralRules: ProceduralRule[];
	/** Conversation facts selected for present or referenced NPCs. */
	relevantConversationMemories: ConversationMemoryEntry[];
	/** Backend-built compact memory packet. Preferred over ad hoc local retrieval when present. */
	backendMemoryPacket: string | null;
	backendMemoryIds: string[];
	backendMemoryDebug: string[];
	worldSim: (WorldSimulationResult & { seasonEffect?: SeasonEffect }) | null;
	threads: StoryThread[];
}

function emptySnapshot(): StateSnapshot {
	return {
		arcs: [],
		chapters: [],
		storyBeats: [],
		currentLocation: null,
		presentCharacters: [],
		equippedItems: [],
		activeAgreements: [],
		recentWorldEvents: [],
		reachableRumors: [],
		factionActions: [],
		relevantFactions: [],
		retrievedEntries: [],
		retrievedChapters: [],
		retrievedChapterReason: null,
		proceduralRules: [],
		relevantConversationMemories: [],
		backendMemoryPacket: null,
		backendMemoryIds: [],
		backendMemoryDebug: [],
		worldSim: null,
		threads: [],
	};
}
import type { ChatMessage } from '$lib/services/ai/sdk/generate';
import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
import {
	budgetPromptSections,
	getDynamicPromptBudget,
	type PromptSection,
} from '$lib/services/ai/context/ContextBudgetService';
import { processBackendTurn, pullBackendChanges, pushPendingBackendOps, queueBackendSyncOp, retrieveBackendMemory } from '$lib/services/backendMemory';
import { openEngineEventStream, type EngineStreamEvent, type EngineStreamSubscription } from '$lib/services/engineStream';
import { cacheBackendStoryFromBootstrap, fetchBackendStoryBootstrap, fetchBackendStoryEntriesPage, fetchBackendStoryProjection } from '$lib/services/serverStories';
import { settings } from '$lib/stores/settings.svelte';
import type { BootstrapResponse, SyncChange, TurnPerformanceSummary, TurnRequest, TurnResponse } from '$lib/contracts/memory';
import type { CampaignProjection } from '$lib/contracts/engine';
import {
	DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
	DEFAULT_PROMPT_ENTRY_WINDOW,
	mergeControlSurfaceEntryWindow,
	mergePromptEntryWindow,
	removePromptEntriesById,
	removePromptEntriesFromPosition,
	sortPromptEntries,
} from './promptEntries';

interface EngineStreamStatus {
	connected: boolean;
	lastEventType: string | null;
	lastEventAt: string | null;
	error: string | null;
	refreshPending: boolean;
}

/**
 * Strip leading type-prefixes (e.g. "Lore: ", "Item: ", "House: ", "General Lore: ")
 * from entry display names. Imports often bake these into the `name` field so
 * the entry shows up as "### Lore: Ancient Empire  (Concept)" — the type tag
 * already says (Concept), so the prefix is redundant clutter for the narrator.
 *
 * Matches only when the prefix is followed by ":\s+" so legitimate names like
 * "House Alder" (no colon) are untouched.
 */
const TYPE_PREFIX_RE = /^(?:lore|item|character|house|group|organization|organisation|faction|location|concept|event|general lore|general history)\s*:\s+/i;
function stripTypePrefix(name: string): string {
	return name?.replace(TYPE_PREFIX_RE, '') ?? name;
}

const MEMORY_STOPWORDS = new Set([
	'the', 'and', 'that', 'this', 'with', 'from', 'have', 'what', 'when', 'where',
	'there', 'their', 'about', 'into', 'then', 'than', 'they', 'them', 'your',
	'you', 'for', 'are', 'was', 'were', 'will', 'would', 'could', 'should',
	'after', 'before', 'again', 'just', 'like', 'tell', 'ask', 'said', 'says',
]);

function memoryTokens(text: string, max = 48): string[] {
	return [...new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9'_-]+/i)
			.map(t => t.trim())
			.filter(t => t.length > 2 && !MEMORY_STOPWORDS.has(t)),
	)].slice(0, max);
}

function memoryHitScore(tokens: string[], text: string, weight = 1): number {
	if (!text || tokens.length === 0) return 0;
	const lower = text.toLowerCase();
	let score = 0;
	for (const token of tokens) {
		if (lower.includes(token)) score += weight;
	}
	return score;
}

function compactMemoryText(text: string, maxChars = 360): string {
	const clean = (text ?? '').replace(/\s+/g, ' ').trim();
	if (clean.length <= maxChars) return clean;
	return clean.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
}

type JsonRecord = Record<string, unknown>;

const ENTRY_TYPES = new Set(['character', 'location', 'item', 'faction', 'concept', 'event']);
const ENTRY_CREATORS = new Set(['user', 'ai', 'import', 'forge']);
const INJECTION_MODES = new Set(['always', 'keyword', 'never']);
const AGREEMENT_CATEGORIES = new Set(['treaty', 'pact', 'alliance', 'oath', 'debt', 'promise', 'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity']);
const AGREEMENT_STATUSES = new Set(['active', 'broken', 'fulfilled', 'expired', 'contested']);
const AGREEMENT_SECRECY = new Set(['public', 'known', 'secret']);
const THREAD_STATUSES = new Set(['open', 'imminent', 'stalled', 'closed', 'abandoned']);
const THREAD_SIGNIFICANCE = new Set(['minor', 'moderate', 'major', 'critical']);
const CONVERSATION_IMPORTANCE = new Set(['trivial', 'minor', 'significant', 'critical']);
const FACTION_ACTION_URGENCY = new Set(['low', 'medium', 'high', 'critical']);
const FACTION_ACTION_STATUS = new Set(['active', 'resolved', 'superseded']);
const RUMOR_SPREAD_RADIUS = new Set(['local', 'regional', 'continental']);
const RUMOR_STATUS = new Set(['spreading', 'mature', 'stale', 'debunked']);
const SCHEME_OWNER_TYPES = new Set(['faction', 'character', 'player']);
const SCHEME_STATUSES = new Set(['incubating', 'active', 'climaxing', 'resolved', 'foiled', 'abandoned']);
const SCHEME_SECRECY = new Set(['secret', 'rumored', 'known']);
const SCHEME_STAGE_CONDITIONS = new Set(['time', 'player-location', 'player-act', 'prerequisite']);
const WORLD_EVENT_TYPES = new Set(['death', 'hostility_change', 'territory_change', 'alliance_formed', 'alliance_broken', 'item_destroyed', 'location_blocked', 'secret_revealed', 'custom']);
const WORLD_EVENT_SEVERITY = new Set(['minor', 'moderate', 'major', 'catastrophic']);
const CONSEQUENCE_STATUSES = new Set(['pending', 'applied', 'expired', 'reversed']);
const CONSEQUENCE_EFFECT_TYPES = new Set(['relationship_change', 'faction_status_change', 'location_blocked', 'location_unblocked', 'npc_status_change', 'rumor_spread', 'custom']);

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown, fallback = 0): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asArray<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function emptyEngineStreamStatus(): EngineStreamStatus {
	return {
		connected: false,
		lastEventType: null,
		lastEventAt: null,
		error: null,
		refreshPending: false,
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asTime(value: unknown, fallback = Date.now()): number {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function enumValue<T extends string>(allowed: Set<string>, value: unknown, fallback: T): T {
	const raw = asString(value);
	return allowed.has(raw) ? raw as T : fallback;
}

function upsertById<T extends { id: string }>(items: T[], item: T): T[] {
	return items.some((existing) => existing.id === item.id)
		? items.map((existing) => existing.id === item.id ? item : existing)
		: [...items, item];
}

function removeById<T extends { id: string }>(items: T[], id: string): T[] {
	return items.filter((item) => item.id !== id);
}

function legacyRecord(row: JsonRecord): JsonRecord {
	return asRecord(asRecord(row.metadata).legacyRecord);
}

function unprefixId(value: string, prefix: string): string {
	return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}

function entityType(value: unknown): Entry['type'] {
	return typeof value === 'string' && ENTRY_TYPES.has(value) ? value as Entry['type'] : 'concept';
}

function entityStatus(value: unknown): Character['status'] {
	return value === 'inactive' || value === 'deceased' ? value : 'active';
}

function defaultEntryState(type: Entry['type'], state: JsonRecord): Entry['state'] {
	switch (type) {
		case 'character':
			return {
				type,
				isPresent: asBoolean(state.isPresent),
				lastSeenLocation: asNullableString(state.lastSeenLocation),
				currentDisposition: asNullableString(state.currentDisposition),
				relationship: {
					level: asNumber(asRecord(state.relationship).level, 0),
					status: asString(asRecord(state.relationship).status, 'unknown'),
					history: Array.isArray(asRecord(state.relationship).history) ? asRecord(state.relationship).history as CharacterEntryState['relationship']['history'] : [],
				},
				knownFacts: asStringArray(state.knownFacts),
				revealedSecrets: asStringArray(state.revealedSecrets),
				pressures: asStringArray(state.pressures),
			};
		case 'location':
			return {
				type,
				isCurrentLocation: asBoolean(state.isCurrentLocation),
				visitCount: asNumber(state.visitCount, 0),
				changes: Array.isArray(state.changes) ? state.changes as LocationEntryState['changes'] : [],
				presentCharacters: asStringArray(state.presentCharacters),
				presentItems: asStringArray(state.presentItems),
				connections: Array.isArray(state.connections) ? state.connections as LocationEntryState['connections'] : [],
				region: asNullableString(state.region),
				terrain: asNullableString(state.terrain),
			};
		case 'item':
			return {
				type,
				inInventory: asBoolean(state.inInventory),
				currentLocation: asNullableString(state.currentLocation),
				condition: asNullableString(state.condition),
				uses: Array.isArray(state.uses) ? state.uses as ItemEntryState['uses'] : [],
			};
		case 'faction':
			return {
				type,
				playerStanding: asNumber(state.playerStanding, 0),
				status: state.status === 'allied' || state.status === 'neutral' || state.status === 'hostile' || state.status === 'unknown' ? state.status : 'unknown',
				knownMembers: asStringArray(state.knownMembers),
				goals: Array.isArray(state.goals) ? state.goals as FactionEntryState['goals'] : [],
				resources: asRecord(state.resources) as unknown as FactionEntryState['resources'],
				territory: asStringArray(state.territory ?? state.territories),
			};
		case 'event':
			return {
				type,
				occurred: asBoolean(state.occurred),
				occurredAt: typeof state.occurredAt === 'number' ? state.occurredAt : null,
				witnesses: asStringArray(state.witnesses),
				consequences: asStringArray(state.consequences),
			};
		default:
			return {
				type: 'concept',
				revealed: asBoolean(state.revealed),
				comprehensionLevel: state.comprehensionLevel === 'basic' || state.comprehensionLevel === 'intermediate' || state.comprehensionLevel === 'advanced' ? state.comprehensionLevel : 'unknown',
				relatedEntries: asStringArray(state.relatedEntries),
			};
	}
}

function retrieveChaptersForAction(
	chapters: Chapter[],
	recentEntries: StoryEntry[],
	currentAction: string,
	maxChapters = 3,
): { chapters: Chapter[]; reason: string | null } {
	if (!currentAction.trim() || chapters.length === 0) return { chapters: [], reason: null };

	const recentText = recentEntries.slice(-4).map(e => e.content).join(' ');
	const tokens = memoryTokens(`${currentAction} ${recentText}`);
	if (tokens.length === 0) return { chapters: [], reason: null };

	const sorted = [...chapters].sort((a, b) => a.number - b.number);
	const recentChapterIds = new Set(sorted.slice(-2).map(c => c.id));
	const memoryCue = /\b(remember|promis|oath|debt|betray|secret|again|last time|before|who was|where was|agreement|deal|alliance|marriage|betroth|thread|rumor|scheme)\b/i.test(currentAction);

	const scored = sorted.map(chapter => {
		let score = 0;
		score += memoryHitScore(tokens, chapter.title ?? '', 4);
		score += memoryHitScore(tokens, chapter.keywords?.join(' ') ?? '', 5);
		score += memoryHitScore(tokens, chapter.characters?.join(' ') ?? '', 4);
		score += memoryHitScore(tokens, chapter.locations?.join(' ') ?? '', 4);
		score += memoryHitScore(tokens, chapter.plotThreads?.join(' ') ?? '', 5);
		score += memoryHitScore(tokens, chapter.summary ?? '', 1);
		if (memoryCue && score > 0) score += 3;
		if (recentChapterIds.has(chapter.id)) score *= 0.35;
		return { chapter, score };
	});

	const selected = scored
		.filter(s => s.score >= (memoryCue ? 3 : 5))
		.sort((a, b) => b.score - a.score || b.chapter.number - a.chapter.number)
		.slice(0, maxChapters)
		.map(s => s.chapter);

	return {
		chapters: selected,
		reason: selected.length > 0 ? `Matched ${selected.length} chapter(s) to the current action.` : null,
	};
}

function selectConversationMemories(
	memories: ConversationMemoryEntry[],
	presentCharacters: Character[],
	currentAction: string,
	maxMemories = 6,
): ConversationMemoryEntry[] {
	if (memories.length === 0) return [];
	const tokens = memoryTokens(currentAction);
	const presentNames = new Set(presentCharacters.map(c => c.name.toLowerCase()));
	const actionLower = currentAction.toLowerCase();

	const scored = memories.map(memory => {
		let score = 0;
		const npc = memory.npcName.toLowerCase();
		if (presentNames.has(npc)) score += 10;
		if (actionLower.includes(npc)) score += 12;
		score += memoryHitScore(tokens, memory.topic, 3);
		score += memoryHitScore(tokens, memory.playerSaid, 2);
		score += memoryHitScore(tokens, memory.npcLearned.join(' '), 3);
		score += memoryHitScore(tokens, memory.emotionalImpact ?? '', 2);
		if (memory.importance === 'critical') score += 6;
		else if (memory.importance === 'significant') score += 4;
		return { memory, score };
	});

	return scored
		.filter(s => s.score > 0)
		.sort((a, b) => b.score - a.score || b.memory.storyPosition - a.memory.storyPosition)
		.slice(0, maxMemories)
		.map(s => s.memory);
}

class StoryStore {
	currentStory = $state<Story | null>(null);
	entries = $state<StoryEntry[]>([]);
	promptEntries = $state<StoryEntry[]>([]);
	entryCount = $state(0);
	campaignProjection = $state<CampaignProjection | null>(null);
	engineStreamStatus = $state<EngineStreamStatus>(emptyEngineStreamStatus());
	oldestLoadedEntryPosition = $state<number | null>(null);
	loadingOlderEntries = $state(false);
	characters = $state<Character[]>([]);
	locations = $state<Location[]>([]);
	items = $state<Item[]>([]);
	lorebookEntries = $state<Entry[]>([]);
	entryRelationships = $state<EntryRelationship[]>([]);
	conversationMemories = $state<ConversationMemoryEntry[]>([]);
	worldEvents = $state<WorldEvent[]>([]);
	agreements = $state<Agreement[]>([]);
	factionActions = $state<FactionActionRecord[]>([]);
	rumors = $state<RumorRecord[]>([]);
	schemes = $state<Scheme[]>([]);
	images = $state<EmbeddedImage[]>([]);
	loading = $state(false);
	hydratingWorld = $state(false);
	worldHydrationError = $state<string | null>(null);
	private _entryLock: Promise<void> = Promise.resolve();
	private _loadGeneration = 0;
	private _engineStream: EngineStreamSubscription | null = null;
	private _engineProjectionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private _engineProjectionRefreshInFlight = false;
	lastWorldSimResult = $state<import('$lib/services/ai/sdk/schemas/worldsim').WorldSimulationResult & { seasonEffect?: import('$lib/services/ai/generation/WorldSimulationService').SeasonEffect } | null>(null);
	/** Last generated plot momentum — read from lastWorldSimResult.plotMomentum */
	get lastPlotMomentum(): PlotMomentum | null {
		return this.lastWorldSimResult?.plotMomentum ?? null;
	}
	/** Last known tier usage (updated each generation) */
	lastTierUsage = $state<Record<string, number> | null>(null);
	lastPromptSectionUsage = $state<Record<string, number> | null>(null);
	/** Last known total context tokens sent to API */
	lastContextTotal = $state<number>(0);
	lastTurnPerformance = $state<TurnPerformanceSummary | null>(null);
	/** Entry index floor for conversation history — set when a chapter is created to prevent context rot.
	 *  buildConversationMessages() won't include entries before this index. */
	chatHistoryFloor = $state<number>(0);

	// ── Derived ──
	get storyMode() { return this.currentStory?.mode ?? 'adventure'; }
	get pov() { return this.currentStory?.settings?.pov ?? 'second'; }
	get tense() { return this.currentStory?.settings?.tense ?? 'present'; }
	get hasOlderEntries() {
		return this.currentStory !== null
			&& this.oldestLoadedEntryPosition !== null
			&& this.entries.length < this.entryCount;
	}
	get protagonist(): Character | undefined {
		return this.characters.find(c => c.relationship === 'self');
	}

	async loadStory(storyId: string) {
		const generation = ++this._loadGeneration;
		this.disconnectEngineStream();
		this.loading = true;
		this.hydratingWorld = false;
		this.worldHydrationError = null;
		try {
			let s = await getStory(storyId);
			if (!s) {
				try {
					const bootstrap = await fetchBackendStoryBootstrap(storyId);
					s = await cacheBackendStoryFromBootstrap(bootstrap);
					if (this._loadGeneration !== generation) return;
					await this.applyBackendBootstrap(s, bootstrap, generation);
					return;
				} catch {
					throw new Error('Story not found');
				}
			}

			if (s.serverStoryId) {
				try {
					await pushPendingBackendOps(s);
					const bootstrap = await fetchBackendStoryBootstrap(s.serverStoryId);
					const cachedStory = await cacheBackendStoryFromBootstrap(bootstrap);
					if (this._loadGeneration !== generation) return;
					await this.applyBackendBootstrap(cachedStory, bootstrap, generation);
					return;
				} catch (error) {
					console.warn('[Story] terminal runtime unavailable; refusing cached story fallback:', error);
					await this.applyTerminalRuntimeUnavailable(s, generation, error);
					return;
				}
			}

			this.currentStory = s;
			this.resetLoadedCollections();
			const branchId = s.currentBranchId ?? null;
			const [entryCount, entries, characters, locations, items] = await Promise.all([
				countStoryEntries(storyId, branchId),
				getRecentStoryEntries(storyId, INITIAL_TRANSCRIPT_LOAD_LIMIT, branchId),
				getCharacters(storyId),
				getLocations(storyId),
				getItems(storyId),
			]);
			if (this._loadGeneration !== generation || this.currentStory?.id !== storyId) return;
			this.entryCount = entryCount;
			this.entries = entries;
			this.promptEntries = mergePromptEntryWindow([], entries);
			this.oldestLoadedEntryPosition = entries[0]?.position ?? null;
			this.characters = characters;
			this.locations = locations;
			this.items = items;
			this.chatHistoryFloor = 0;

			this.loadImagesForEntries(storyId, entries.map((entry) => entry.id), generation)
				.catch(e => console.warn('[Story] visible image load failed:', e));
			this.hydrateWorldData(storyId, branchId, generation)
				.catch(e => console.warn('[Story] world hydration failed:', e));
		} finally {
			if (this._loadGeneration === generation) this.loading = false;
		}
	}

	private async applyTerminalRuntimeUnavailable(story: Story, generation: number, error: unknown): Promise<void> {
		const storyId = story.id;
		this.currentStory = { ...story, syncStatus: 'offline' };
		this.resetLoadedCollections();
		const message = error instanceof Error ? error.message : String(error);
		this.worldHydrationError = `Terminal agent runtime required. ${message}`;
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			error: this.worldHydrationError,
		};
		this.hydratingWorld = false;
		await updateStory(storyId, { syncStatus: 'offline', updatedAt: Date.now() }).catch(() => undefined);
		if (!this.isCurrentLoad(storyId, generation)) return;
		this.chatHistoryFloor = 0;
	}

	private resetLoadedCollections(): void {
		this.entries = [];
		this.promptEntries = [];
		this.entryCount = 0;
		this.campaignProjection = null;
		this.engineStreamStatus = emptyEngineStreamStatus();
		this.oldestLoadedEntryPosition = null;
		this.images = [];
		this.characters = [];
		this.locations = [];
		this.items = [];
		this.lorebookEntries = [];
		this.entryRelationships = [];
		this.conversationMemories = [];
		this.worldEvents = [];
		this.agreements = [];
		this.factionActions = [];
		this.rumors = [];
		this.schemes = [];
		this.lastWorldSimResult = null;
		this.lastTierUsage = null;
		this.lastPromptSectionUsage = null;
		this.lastContextTotal = 0;
		this.lastTurnPerformance = null;
		this.chatHistoryFloor = 0;
	}

	private isCurrentLoad(storyId: string, generation: number): boolean {
		return this._loadGeneration === generation && this.currentStory?.id === storyId;
	}

	private async applyBackendBootstrap(localStory: Story, bootstrap: BootstrapResponse, generation: number): Promise<void> {
		const serverStoryId = asString(bootstrap.story.id, localStory.serverStoryId ?? localStory.id);
		this.currentStory = {
			...localStory,
			serverStoryId,
			serverVersion: bootstrap.serverVersion,
			syncStatus: 'synced',
		};
		this.resetLoadedCollections();
		this.hydratingWorld = true;
		this.worldHydrationError = null;

		try {
			this.campaignProjection = bootstrap.projection ?? null;
			const projectionEntryRows = bootstrap.projection?.entries?.length ? bootstrap.projection.entries : bootstrap.entries;
			const entries = projectionEntryRows
				.map((row) => this.serverEntryToLocal(row))
				.filter((entry): entry is StoryEntry => Boolean(entry));
			for (const entry of entries) await putStoryEntry(entry);
			if (!this.isCurrentLoad(localStory.id, generation)) return;

			this.entries = sortPromptEntries(entries);
			this.promptEntries = mergePromptEntryWindow([], this.entries);
			this.entryCount = Math.max(bootstrap.projection?.counts.entries ?? bootstrap.entryCount, this.entries.length);
			this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;

			const storyRow = asRecord(bootstrap.story);
			const currentLocationId = asNullableString(storyRow.currentLocationId);
			const entityRows = bootstrap.entities.map(asRecord);
			this.lorebookEntries = entityRows
				.map((row) => this.serverEntityToLorebookEntry(row))
				.filter((entry): entry is Entry => Boolean(entry));
			this.characters = entityRows
				.map((row) => this.serverEntityToCharacter(row))
				.filter((character): character is Character => Boolean(character));
			this.locations = entityRows
				.map((row) => this.serverEntityToLocation(row, currentLocationId))
				.filter((location): location is Location => Boolean(location));
			this.items = entityRows
				.map((row) => this.serverEntityToItem(row))
				.filter((item): item is Item => Boolean(item));
			this.agreements = bootstrap.agreements
				.map((row) => this.serverAgreementToLocal(row))
				.filter((agreement): agreement is Agreement => Boolean(agreement));
			this.worldEvents = bootstrap.recentEvents.map((row) => this.serverEventToLocal(row));
			const memoryRows = bootstrap.memoryNodes.map((row) => asRecord(row));
			const beliefRows = bootstrap.npcBeliefs.map((row) => asRecord(row));
			const conversationById = new Map<string, ConversationMemoryEntry>();
			for (const memory of memoryRows
				.map((row) => this.serverMemoryNodeToConversation(row))
				.filter((memory): memory is ConversationMemoryEntry => Boolean(memory))) {
				conversationById.set(memory.id, memory);
			}
			for (const memory of beliefRows
				.map((row) => this.serverNpcBeliefToConversation(row))
				.filter((memory): memory is ConversationMemoryEntry => Boolean(memory))) {
				conversationById.set(memory.id, memory);
			}
			this.conversationMemories = [...conversationById.values()].sort((a, b) => a.createdAt - b.createdAt);
			this.factionActions = memoryRows
				.map((row) => this.serverMemoryNodeToFactionAction(row))
				.filter((action): action is FactionActionRecord => Boolean(action))
				.sort((a, b) => a.createdAt - b.createdAt);
			this.rumors = memoryRows
				.map((row) => this.serverMemoryNodeToRumor(row))
				.filter((rumor): rumor is RumorRecord => Boolean(rumor))
				.sort((a, b) => a.createdAt - b.createdAt);
			this.schemes = memoryRows
				.map((row) => this.serverMemoryNodeToScheme(row))
				.filter((scheme): scheme is Scheme => Boolean(scheme))
				.sort((a, b) => a.createdAt - b.createdAt);
			this.entryRelationships = [];
			await Promise.all([
				...this.lorebookEntries.map((entry) => putLorebookEntry(entry)),
				...this.characters.map((character) => putCharacter(character)),
				...this.locations.map((location) => putLocation(location)),
				...this.items.map((item) => putItem(item)),
				...this.agreements.map((agreement) => putAgreement(agreement)),
				...this.worldEvents.map((event) => putWorldEvent(event)),
				...this.conversationMemories.map((memory) => putConversationMemory(memory)),
				bulkPutFactionActions(this.factionActions),
				bulkPutRumors(this.rumors),
				bulkPutSchemes(this.schemes),
			]);

			const localThreads = bootstrap.threads
				.map((row) => this.serverThreadToLocal(row))
				.filter((thread): thread is StoryThread => Boolean(thread));
			for (const thread of localThreads) await putStoryThread(thread);

			const localChapters = bootstrap.chapters
				.map((row) => this.serverChapterToLocal(asRecord(row)))
				.filter((chapter): chapter is Chapter => Boolean(chapter));
			for (const chapter of localChapters) await putChapter(chapter);

			const localArcs = bootstrap.arcs
				.map((row) => this.serverArcToLocal(asRecord(row)))
				.filter((arc): arc is Arc => Boolean(arc));
			for (const arc of localArcs) await putArc(arc);

			const localSagas = bootstrap.sagas
				.map((row) => this.serverSagaToLocal(asRecord(row)))
				.filter((saga): saga is Saga => Boolean(saga));
			for (const saga of localSagas) await putSaga(saga);

			await updateStory(localStory.id, {
				serverStoryId,
				serverVersion: bootstrap.serverVersion,
				syncStatus: 'synced',
			});
			if (!this.isCurrentLoad(localStory.id, generation)) return;

			this.loadImagesForEntries(localStory.id, entries.map((entry) => entry.id), generation)
				.catch(e => console.warn('[Story] visible image load failed:', e));
			globalThis.setTimeout(() => {
				if (!this.isCurrentLoad(localStory.id, generation)) return;
				this.preEmbedLorebook().catch(e => console.warn('[Story] preEmbedLorebook failed:', e));
			}, 500);
		} catch (error) {
			if (this.isCurrentLoad(localStory.id, generation)) {
				this.worldHydrationError = error instanceof Error ? error.message : String(error);
				console.warn('[Story] backend bootstrap hydration failed:', error);
			}
		} finally {
			if (this.isCurrentLoad(localStory.id, generation)) {
				this.hydratingWorld = false;
				this.connectEngineStream(localStory.id, serverStoryId, generation);
			}
		}
	}

	private async applyCampaignProjection(projection: CampaignProjection): Promise<void> {
		if (!this.currentStory?.serverStoryId || this.currentStory.serverStoryId !== asString(projection.story.id, this.currentStory.serverStoryId)) {
			return;
		}
		this.campaignProjection = projection;
		const entries = projection.entries
			.map((row) => this.serverEntryToLocal(row))
			.filter((entry): entry is StoryEntry => Boolean(entry));
		for (const entry of entries) await putStoryEntry(entry);
		this.entries = mergeControlSurfaceEntryWindow(this.entries, entries, {
			limit: DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
			anchor: 'newest',
		});
		this.promptEntries = mergePromptEntryWindow(this.promptEntries, entries);
		this.entryCount = Math.max(projection.counts.entries, this.entries.length);
		this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;
		const serverVersion = asNumber(projection.story.serverVersion, this.currentStory.serverVersion ?? 1);
		this.currentStory = {
			...this.currentStory,
			serverVersion,
			syncStatus: 'synced',
		};
		await updateStory(this.currentStory.id, {
			serverVersion,
			syncStatus: 'synced',
		});
	}

	async refreshCampaignProjection(limit = INITIAL_TRANSCRIPT_LOAD_LIMIT): Promise<CampaignProjection | null> {
		const current = this.currentStory;
		if (!current?.serverStoryId) return null;
		const projection = await fetchBackendStoryProjection(current.serverStoryId, limit);
		if (this.currentStory?.id !== current.id) return null;
		await this.applyCampaignProjection(projection);
		return projection;
	}

	private connectEngineStream(localStoryId: string, serverStoryId: string, generation: number): void {
		if (!this.isCurrentLoad(localStoryId, generation)) return;
		this.disconnectEngineStream();
		try {
			this._engineStream = openEngineEventStream({
				storyId: serverStoryId,
				replay: 25,
				onEvent: (event) => this.recordEngineStreamEvent(event, localStoryId, generation),
				onProjection: (projection) => {
					if (!this.isCurrentLoad(localStoryId, generation)) return;
					void this.applyCampaignProjection(projection).catch((error) => {
						this.recordEngineStreamError(error, localStoryId, generation);
					});
				},
				onCacheStatus: (cache) => {
					if (!this.isCurrentLoad(localStoryId, generation) || !this.campaignProjection) return;
					this.campaignProjection = { ...this.campaignProjection, cache };
				},
				onTurnPerformance: (performance) => {
					if (!this.isCurrentLoad(localStoryId, generation)) return;
					this.lastTurnPerformance = performance;
				},
				onRefreshRequested: () => this.queueEngineProjectionRefresh(localStoryId, generation),
				onError: (error) => this.recordEngineStreamError(error, localStoryId, generation),
			});
			this.engineStreamStatus = {
				...this.engineStreamStatus,
				connected: true,
				error: null,
			};
		} catch (error) {
			this.recordEngineStreamError(error, localStoryId, generation);
		}
	}

	private disconnectEngineStream(): void {
		if (this._engineProjectionRefreshTimer) {
			clearTimeout(this._engineProjectionRefreshTimer);
			this._engineProjectionRefreshTimer = null;
		}
		this._engineProjectionRefreshInFlight = false;
		this._engineStream?.close();
		this._engineStream = null;
		this.engineStreamStatus = emptyEngineStreamStatus();
	}

	private recordEngineStreamEvent(event: EngineStreamEvent, localStoryId: string, generation: number): void {
		if (!this.isCurrentLoad(localStoryId, generation)) return;
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			connected: event.type !== 'engine.error',
			lastEventType: event.type,
			lastEventAt: event.createdAt || new Date().toISOString(),
			error: event.type === 'engine.error' ? asString(event.data.error, 'Backend engine stream error.') : this.engineStreamStatus.error,
		};
	}

	private recordEngineStreamError(error: unknown, localStoryId: string, generation: number): void {
		if (!this.isCurrentLoad(localStoryId, generation)) return;
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			connected: false,
			error: errorMessage(error),
		};
	}

	private queueEngineProjectionRefresh(localStoryId: string, generation: number): void {
		if (!this.isCurrentLoad(localStoryId, generation)) return;
		this.engineStreamStatus = { ...this.engineStreamStatus, refreshPending: true };
		if (this._engineProjectionRefreshTimer) return;
		this._engineProjectionRefreshTimer = setTimeout(() => {
			this._engineProjectionRefreshTimer = null;
			if (!this.isCurrentLoad(localStoryId, generation) || this._engineProjectionRefreshInFlight) return;
			this._engineProjectionRefreshInFlight = true;
			void this.refreshCampaignProjection(INITIAL_TRANSCRIPT_LOAD_LIMIT)
				.catch((error) => this.recordEngineStreamError(error, localStoryId, generation))
				.finally(() => {
					this._engineProjectionRefreshInFlight = false;
					if (this.isCurrentLoad(localStoryId, generation)) {
						this.engineStreamStatus = { ...this.engineStreamStatus, refreshPending: false };
					}
				});
		}, 200);
	}

	private serverEntityToLorebookEntry(row: JsonRecord): Entry | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		const name = asString(row.name).trim();
		if (!id || !name) return null;
		const type = entityType(row.type);
		const state = asRecord(row.state);
		const metadata = asRecord(row.metadata);
		const sourceEntryIds = asStringArray(row.sourceEntryIds);
		const localInjection = asRecord(metadata.localInjection);
		const injectionMode = INJECTION_MODES.has(asString(localInjection.mode)) ? asString(localInjection.mode) as Entry['injection']['mode'] : 'keyword';
		const injectionKeywords = asStringArray(localInjection.keywords);
		const createdBy = ENTRY_CREATORS.has(asString(metadata.localCreatedBy)) ? asString(metadata.localCreatedBy) as Entry['createdBy'] : metadata.originalTable === 'lorebookEntries' ? 'import' : 'ai';
		return {
			id,
			storyId: this.currentStory.id,
			name,
			type,
			description: asString(row.description),
			hiddenInfo: asNullableString(state.hiddenInfo),
			aliases: asStringArray(metadata.localAliases),
			state: defaultEntryState(type, state),
			adventureState: metadata.localAdventureState && typeof metadata.localAdventureState === 'object' && !Array.isArray(metadata.localAdventureState)
				? metadata.localAdventureState as Entry['adventureState']
				: null,
			creativeState: metadata.localCreativeState && typeof metadata.localCreativeState === 'object' && !Array.isArray(metadata.localCreativeState)
				? metadata.localCreativeState as Entry['creativeState']
				: null,
			injection: {
				mode: injectionMode,
				keywords: injectionKeywords.length > 0
					? injectionKeywords
					: [...new Set([name, ...name.split(/\s+/)].map(part => part.trim()).filter(part => part.length > 2))].slice(0, 8),
				priority: asNumber(localInjection.priority, metadata.originalTable === 'lorebookEntries' ? 100 : 50),
			},
			firstMentioned: sourceEntryIds[0] ?? null,
			lastMentioned: sourceEntryIds[sourceEntryIds.length - 1] ?? null,
			mentionCount: asNumber(metadata.localMentionCount, sourceEntryIds.length),
			createdBy,
			createdAt: asTime(row.createdAt),
			updatedAt: asTime(row.updatedAt),
			loreManagementBlacklisted: asBoolean(metadata.loreManagementBlacklisted),
			branchId: null,
		};
	}

	private serverEntityToCharacter(row: JsonRecord): Character | null {
		if (!this.currentStory || row.type !== 'character') return null;
		const id = asString(row.id);
		const name = asString(row.name).trim();
		if (!id || !name) return null;
		const state = asRecord(row.state);
		const relationship = asRecord(state.relationship);
		return {
			id,
			storyId: this.currentStory.id,
			name,
			description: asNullableString(row.description),
			relationship: asNullableString(state.relationship) ?? asNullableString(relationship.status) ?? asNullableString(state.currentDisposition),
			traits: asStringArray(state.traits),
			visualDescriptors: asRecord(state.visualDescriptors) as Character['visualDescriptors'],
			portrait: asNullableString(state.portrait),
			status: entityStatus(row.status),
			metadata: asRecord(row.metadata),
			branchId: null,
		};
	}

	private serverEntityToLocation(row: JsonRecord, currentLocationId: string | null): Location | null {
		if (!this.currentStory || row.type !== 'location') return null;
		const id = asString(row.id);
		const name = asString(row.name).trim();
		if (!id || !name) return null;
		const state = asRecord(row.state);
		const legacyConnections = asStringArray(state.legacyConnections);
		const current = currentLocationId === id || asBoolean(state.isCurrentLocation);
		return {
			id,
			storyId: this.currentStory.id,
			name,
			description: asNullableString(row.description),
			visited: current || asNumber(state.visitCount, 0) > 0 || asBoolean(state.visited),
			current,
			connections: legacyConnections.length > 0 ? legacyConnections : asStringArray(state.connections),
			metadata: asRecord(row.metadata),
			branchId: null,
		};
	}

	private serverEntityToItem(row: JsonRecord): Item | null {
		if (!this.currentStory || row.type !== 'item') return null;
		const id = asString(row.id);
		const name = asString(row.name).trim();
		if (!id || !name) return null;
		const state = asRecord(row.state);
		return {
			id,
			storyId: this.currentStory.id,
			name,
			description: asNullableString(row.description),
			quantity: Math.max(1, asNumber(state.quantity, 1)),
			equipped: asBoolean(state.equipped) || asBoolean(state.inInventory),
			location: asString(state.currentLocation, asBoolean(state.inInventory) ? 'inventory' : ''),
			metadata: asRecord(row.metadata),
			branchId: null,
		};
	}

	private serverAgreementToLocal(row: JsonRecord): Agreement | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		const terms = asString(row.terms).trim();
		if (!id || !terms) return null;
		const category = AGREEMENT_CATEGORIES.has(asString(row.category)) ? asString(row.category) as Agreement['category'] : 'pact';
		const status = AGREEMENT_STATUSES.has(asString(row.status)) ? asString(row.status) as Agreement['status'] : 'active';
		const secrecy = AGREEMENT_SECRECY.has(asString(row.secrecy)) ? asString(row.secrecy) as Agreement['secrecy'] : 'known';
		return {
			id,
			storyId: this.currentStory.id,
			parties: asStringArray(row.parties),
			category,
			terms,
			status,
			secrecy,
			createdChapterNumber: null,
			resolvedChapterNumber: null,
			consequences: asStringArray(row.consequences),
			metadata: asRecord(row.metadata),
			createdAt: asTime(row.createdAt),
			updatedAt: asTime(row.updatedAt),
		};
	}

	private serverThreadToLocal(row: JsonRecord): StoryThread | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		const description = asString(row.description).trim();
		if (!id || !description) return null;
		const status = THREAD_STATUSES.has(asString(row.status)) ? asString(row.status) as StoryThread['status'] : 'open';
		const significance = THREAD_SIGNIFICANCE.has(asString(row.significance)) ? asString(row.significance) as StoryThread['significance'] : 'moderate';
		const sourceEventIds = asStringArray(row.sourceEventIds);
		return {
			id,
			storyId: this.currentStory.id,
			description,
			status,
			significance,
			sourceArcId: null,
			sourceChapterId: sourceEventIds[0] ?? null,
			createdAt: asTime(row.createdAt),
			updatedAt: asTime(row.updatedAt),
			closedAt: row.closedAt ? asTime(row.closedAt) : null,
			closureReason: asNullableString(row.closureReason),
			relatedFactionIds: asStringArray(row.relatedFactionIds),
			relatedCharacterNames: asStringArray(row.relatedEntityIds),
		};
	}

	private serverChapterToLocal(row: JsonRecord): Chapter | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		if (!id) return null;
		const metadata = asRecord(row.metadata);
		const sourceEntryIds = asStringArray(row.sourceEntryIds);
		return {
			id,
			storyId: this.currentStory.id,
			number: asNumber(row.number, 0),
			title: asNullableString(row.title),
			startEntryId: sourceEntryIds[0] ?? asString(row.startEntryId),
			endEntryId: sourceEntryIds[sourceEntryIds.length - 1] ?? asString(row.endEntryId),
			entryCount: asNumber(metadata.entryCount, sourceEntryIds.length),
			summary: asString(row.sceneOutcome, asString(row.summary)).trim(),
			startTime: null,
			endTime: null,
			keywords: asStringArray(metadata.legacyKeywords ?? row.keywords),
			characters: asStringArray(metadata.legacyCharacters ?? row.characters),
			locations: asStringArray(metadata.legacyLocations ?? row.locations),
			plotThreads: asStringArray(row.openThreads ?? metadata.openThreads),
			emotionalTone: asNullableString(metadata.emotionalTone ?? row.emotionalTone),
			branchId: asNullableString(row.branchId ?? metadata.branchId),
			pinned: asBoolean(metadata.pinned),
			createdAt: asTime(row.createdAt),
		};
	}

	private serverArcToLocal(row: JsonRecord): Arc | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		if (!id) return null;
		const metadata = asRecord(row.metadata);
		const arcNumber = asNumber(row.number ?? row.arcNumber, 1);
		const openThreadIds = asStringArray(row.openThreadIds ?? row.threadIds);
		const characterArcs = Array.isArray(metadata.characterArcs)
			? metadata.characterArcs
				.map(asRecord)
				.map((item) => ({
					name: asString(item.name).trim(),
					development: asString(item.development).trim(),
				}))
				.filter((item) => item.name)
			: [];
		return {
			id,
			storyId: this.currentStory.id,
			arcNumber,
			title: asString(row.title, `Arc ${arcNumber}`),
			summary: asString(row.summary).trim(),
			keyPlotPoints: asStringArray(metadata.keyPlotPoints ?? row.keyPlotPoints),
			characterArcs,
			unresolvedThreads: asStringArray(metadata.unresolvedThreads ?? openThreadIds),
			threadIds: openThreadIds,
			resolvedThreadIds: asStringArray(metadata.resolvedThreadIds),
			emotionalProgression: asString(metadata.emotionalProgression ?? row.emotionalProgression),
			chapterIds: asStringArray(row.chapterIds),
			chapterRange: asString(metadata.legacyRange, String(arcNumber)),
			branchId: asNullableString(row.branchId ?? metadata.branchId),
			createdAt: asTime(row.createdAt),
		};
	}

	private serverSagaToLocal(row: JsonRecord): Saga | null {
		if (!this.currentStory) return null;
		const id = asString(row.id);
		if (!id) return null;
		const metadata = asRecord(row.metadata);
		const sagaNumber = asNumber(row.number ?? row.sagaNumber, 1);
		return {
			id,
			storyId: this.currentStory.id,
			sagaNumber,
			title: asString(row.title, `Saga ${sagaNumber}`),
			summary: asString(row.summary).trim(),
			arcIds: asStringArray(row.arcIds),
			arcRange: asString(row.arcRange ?? metadata.legacyRange, `Arcs ${sagaNumber}`),
			keyFactionShifts: asStringArray(row.keyFactionShifts),
			majorPowerChanges: asStringArray(row.majorPowerChanges),
			lingeringThreads: asStringArray(row.lingeringThreads),
			overallTone: asString(row.overallTone),
			branchId: asNullableString(row.branchId ?? metadata.branchId),
			createdAt: asTime(row.createdAt),
		};
	}

	private serverEventToLocal(row: BootstrapResponse['recentEvents'][number]): WorldEvent {
		const metadata = asRecord(row.metadata);
		const legacy = asRecord(metadata.legacyRecord);
		const legacyType = asString(legacy.type);
		const type = WORLD_EVENT_TYPES.has(legacyType)
			? legacyType as WorldEvent['type']
			: row.type === 'death'
			? 'death'
			: row.type === 'relationship_shift'
				? 'hostility_change'
				: row.type === 'faction_move'
					? 'territory_change'
					: row.type === 'reveal'
						? 'secret_revealed'
						: 'custom';
		const createdAt = asTime(row.createdAt);
		return {
			id: row.id,
			storyId: this.currentStory?.id ?? row.storyId,
			name: asString(legacy.name, row.title),
			description: asString(legacy.description, row.body),
			triggerEntryId: asString(legacy.triggerEntryId, row.sourceEntryIds[0] ?? ''),
			triggerPosition: asNumber(legacy.triggerPosition, asNumber(metadata.triggerPosition, 0)),
			sourceEntityId: asNullableString(legacy.sourceEntityId) ?? row.actorEntityIds[0] ?? null,
			type,
			severity: enumValue(WORLD_EVENT_SEVERITY, legacy.severity ?? metadata.severity, 'moderate'),
			consequences: asArray<JsonRecord>(legacy.consequences).map((consequence) => this.serverConsequenceToLocal(consequence)),
			appliedAt: legacy.appliedAt == null ? createdAt : asTime(legacy.appliedAt, createdAt),
			createdAt: asTime(legacy.createdAt, createdAt),
		};
	}

	private serverConsequenceToLocal(row: JsonRecord): WorldEvent['consequences'][number] {
		return {
			id: asString(row.id, uuid()),
			description: asString(row.description),
			status: enumValue(CONSEQUENCE_STATUSES, row.status, 'pending'),
			targetEntityId: asNullableString(row.targetEntityId),
			targetEntityName: asString(row.targetEntityName),
			effectType: enumValue(CONSEQUENCE_EFFECT_TYPES, row.effectType, 'custom'),
			effectPayload: asRecord(row.effectPayload),
			delay: asNumber(row.delay, 0),
			appliedAt: row.appliedAt == null ? null : asTime(row.appliedAt),
		};
	}

	private serverMemoryNodeToConversation(row: JsonRecord): ConversationMemoryEntry | null {
		const metadata = asRecord(row.metadata);
		if (asString(metadata.sourceType) !== 'conversation_memory_import') return null;
		const legacy = legacyRecord(row);
		const nodeId = asString(row.id);
		const id = asString(legacy.id) || unprefixId(nodeId, 'mem_conversation_');
		const npcEntryId = asString(legacy.npcEntryId) || asStringArray(row.entityIds)[0] || '';
		const npcName = asString(legacy.npcName)
			|| this.lorebookEntries.find((entry) => entry.id === npcEntryId)?.name
			|| asString(row.title).replace(/^Conversation memory:\s*/i, '')
			|| 'Unknown NPC';
		if (!id) return null;
		return {
			id,
			storyId: this.currentStory?.id ?? asString(row.storyId),
			npcEntryId,
			npcName,
			storyEntryId: asString(legacy.storyEntryId) || asStringArray(row.sourceEntryIds)[0] || '',
			storyPosition: asNumber(legacy.storyPosition, 0),
			topic: asString(legacy.topic) || asString(row.title, 'Conversation memory'),
			playerSaid: asString(legacy.playerSaid),
			npcLearned: asStringArray(legacy.npcLearned),
			emotionalImpact: asNullableString(legacy.emotionalImpact),
			importance: enumValue(CONVERSATION_IMPORTANCE, legacy.importance, 'minor'),
			createdAt: asTime(legacy.createdAt, asTime(row.createdAt)),
		};
	}

	private serverNpcBeliefToConversation(row: JsonRecord): ConversationMemoryEntry | null {
		const id = asString(row.id);
		const npcEntryId = asString(row.believerEntityId);
		const belief = asString(row.belief).trim();
		if (!id || !npcEntryId || !belief) return null;
		const npcName = this.lorebookEntries.find((entry) => entry.id === npcEntryId)?.name ?? 'Unknown NPC';
		const lines = belief.split('\n').map((line) => line.trim()).filter(Boolean);
		const playerLine = lines.find((line) => line.toLowerCase().startsWith('player revealed:'));
		const learnedLine = lines.find((line) => line.toLowerCase().startsWith('npc learned:'));
		const emotionalLine = lines.find((line) => line.toLowerCase().startsWith('emotional shift:'));
		const sourceEntryId = asStringArray(row.sourceEntryIds)[0] ?? '';
		const sourceEntry = this.entries.find((entry) => entry.id === sourceEntryId);
		const confidence = asNumber(row.confidence, 0.5);
		return {
			id,
			storyId: this.currentStory?.id ?? asString(row.storyId),
			npcEntryId,
			npcName,
			storyEntryId: sourceEntryId,
			storyPosition: sourceEntry?.position ?? 0,
			topic: lines[0] ?? 'NPC belief',
			playerSaid: playerLine?.replace(/^player revealed:\s*/i, '') ?? '',
			npcLearned: learnedLine
				? learnedLine.replace(/^npc learned:\s*/i, '').split(';').map((item) => item.trim()).filter(Boolean)
				: [belief],
			emotionalImpact: emotionalLine?.replace(/^emotional shift:\s*/i, '') ?? null,
			importance: confidence >= 0.85 ? 'critical' : confidence >= 0.65 ? 'significant' : 'minor',
			createdAt: asTime(row.createdAt),
		};
	}

	private serverMemoryNodeToFactionAction(row: JsonRecord): FactionActionRecord | null {
		const metadata = asRecord(row.metadata);
		const sourceType = asString(metadata.sourceType);
		if (sourceType === 'terminal_faction_pressure_job') {
			const id = asString(row.id);
			if (!id) return null;
			const pressure = asNumber(metadata.pressure, Math.round(asNumber(row.importance, 0.55) * 100));
			return {
				id,
				storyId: this.currentStory?.id ?? asString(row.storyId),
				factionName: this.memoryNodeFactionName(row, metadata),
				action: asString(row.content) || asString(row.summary) || asString(row.title),
				actionType: 'pressure',
				target: null,
				motivation: `Pressure ${Math.max(0, Math.min(100, pressure))}/100`,
				consequences: asString(row.content).split('\n')
					.map((line) => line.replace(/^-\s*/, '').trim())
					.filter((line) => line.startsWith('+'))
					.slice(0, 3),
				urgency: this.pressureUrgency(pressure),
				affectedRegions: [],
				chapterNumber: null,
				status: 'active',
				createdAt: asTime(row.updatedAt, asTime(row.createdAt)),
			};
		}
		if (sourceType === 'terminal_world_sim_tick') {
			const id = unprefixId(asString(row.id), 'mem_world_tick_') || asString(row.id);
			if (!id) return null;
			const pressure = asNumber(metadata.pressure, 70);
			return {
				id,
				storyId: this.currentStory?.id ?? asString(row.storyId),
				factionName: this.memoryNodeFactionName(row, metadata),
				action: asString(row.content) || asString(row.summary) || asString(row.title),
				actionType: 'world_tick',
				target: null,
				motivation: `Terminal world tick at pressure ${Math.max(0, Math.min(100, pressure))}/100`,
				consequences: asStringArray(row.sourceEventIds).map((eventId) => `Canonical event ${eventId}`).slice(0, 1),
				urgency: this.pressureUrgency(pressure),
				affectedRegions: [],
				chapterNumber: null,
				status: 'active',
				createdAt: asTime(row.updatedAt, asTime(row.createdAt)),
			};
		}
		if (sourceType !== 'faction_action_import') return null;
		const legacy = legacyRecord(row);
		const id = asString(legacy.id) || unprefixId(asString(row.id), 'mem_faction_action_');
		if (!id) return null;
		return {
			id,
			storyId: this.currentStory?.id ?? asString(row.storyId),
			factionName: asString(legacy.factionName) || asStringArray(row.factionIds)[0] || 'Faction',
			action: asString(legacy.action) || asString(row.content),
			actionType: asString(legacy.actionType) || asStringArray(row.keywords)[1] || 'custom',
			target: asNullableString(legacy.target),
			motivation: asNullableString(legacy.motivation),
			consequences: asStringArray(legacy.consequences),
			urgency: enumValue(FACTION_ACTION_URGENCY, legacy.urgency, 'medium'),
			affectedRegions: asStringArray(legacy.affectedRegions),
			chapterNumber: legacy.chapterNumber == null ? null : asNumber(legacy.chapterNumber, 0),
			status: enumValue(FACTION_ACTION_STATUS, legacy.status, 'active'),
			createdAt: asTime(legacy.createdAt, asTime(row.createdAt)),
		};
	}

	private memoryNodeFactionName(row: JsonRecord, metadata: JsonRecord): string {
		const metadataName = asString(metadata.factionName).trim();
		if (metadataName) return metadataName;
		const factionId = asString(metadata.factionId) || asStringArray(row.factionIds)[0] || asStringArray(row.entityIds)[0];
		const entryName = factionId ? this.lorebookEntries.find((entry) => entry.id === factionId)?.name : '';
		if (entryName) return entryName;
		const title = asString(row.title).trim();
		const pressureTitle = title.match(/^(.*?)\s+pressure$/i)?.[1]?.trim();
		if (pressureTitle) return pressureTitle;
		const worldTickTitle = title.match(/^(.*?)\s+converts\s+pressure/i)?.[1]?.trim();
		if (worldTickTitle) return worldTickTitle;
		return factionId || 'Faction';
	}

	private pressureUrgency(pressure: number): FactionActionRecord['urgency'] {
		if (pressure >= 90) return 'critical';
		if (pressure >= 78) return 'high';
		if (pressure >= 55) return 'medium';
		return 'low';
	}

	private serverMemoryNodeToRumor(row: JsonRecord): RumorRecord | null {
		const metadata = asRecord(row.metadata);
		if (asString(metadata.sourceType) !== 'rumor_import') return null;
		const legacy = legacyRecord(row);
		const id = asString(legacy.id) || unprefixId(asString(row.id), 'mem_rumor_');
		if (!id) return null;
		return {
			id,
			storyId: this.currentStory?.id ?? asString(row.storyId),
			content: asString(legacy.content) || asString(row.content),
			truthfulness: Math.max(0, Math.min(1, asNumber(legacy.truthfulness, asNumber(row.importance, 0.5)))),
			originRegion: asString(legacy.originRegion, 'unknown'),
			spreadRadius: enumValue(RUMOR_SPREAD_RADIUS, legacy.spreadRadius, 'local'),
			sourceType: asString(legacy.sourceType, 'gossip'),
			relatedFaction: asNullableString(legacy.relatedFaction),
			chapterNumber: legacy.chapterNumber == null ? null : asNumber(legacy.chapterNumber, 0),
			staleAfterChapters: asNumber(legacy.staleAfterChapters, 5),
			status: enumValue(RUMOR_STATUS, legacy.status, 'spreading'),
			createdAt: asTime(legacy.createdAt, asTime(row.createdAt)),
		};
	}

	private serverMemoryNodeToScheme(row: JsonRecord): Scheme | null {
		const metadata = asRecord(row.metadata);
		if (asString(metadata.sourceType) !== 'scheme_import') return null;
		const legacy = legacyRecord(row);
		const id = asString(legacy.id) || asStringArray(row.threadIds)[0] || unprefixId(asString(row.id), 'mem_scheme_');
		if (!id) return null;
		const stageRows = asArray<JsonRecord>(legacy.stages);
		const stages = stageRows.length > 0
			? stageRows.map((stage, index) => this.serverSchemeStageToLocal(stage, index))
			: [this.serverSchemeStageToLocal({ label: 'Unfolding pressure', hook: asString(row.summary) || asString(row.content) }, 0)];
		const pressure = Math.max(0, Math.min(100, asNumber(legacy.pressure, Math.round(asNumber(row.importance, 0.45) * 100))));
		return {
			id,
			storyId: this.currentStory?.id ?? asString(row.storyId),
			ownerType: enumValue(SCHEME_OWNER_TYPES, legacy.ownerType, 'character'),
			ownerEntryId: asNullableString(legacy.ownerEntryId),
			ownerName: asString(legacy.ownerName) || asStringArray(row.keywords)[0] || 'Unknown actor',
			goal: asString(legacy.goal) || asString(row.title).replace(/^Scheme:\s*/i, '') || asString(row.summary, id),
			trigger: asString(legacy.trigger),
			triggerChapter: legacy.triggerChapter == null ? null : asNumber(legacy.triggerChapter, 0),
			triggerEntryId: asNullableString(legacy.triggerEntryId) ?? asStringArray(row.sourceEntryIds)[0] ?? null,
			stages,
			currentStageIndex: Math.max(0, Math.min(stages.length - 1, asNumber(legacy.currentStageIndex, 0))),
			pressure,
			status: enumValue(SCHEME_STATUSES, legacy.status, 'active'),
			secrecy: enumValue(SCHEME_SECRECY, legacy.secrecy, 'known'),
			nextTickAtDay: legacy.nextTickAtDay == null ? null : asNumber(legacy.nextTickAtDay, 0),
			branchId: asNullableString(legacy.branchId),
			createdAt: asTime(legacy.createdAt, asTime(row.createdAt)),
			updatedAt: asTime(legacy.updatedAt, asTime(row.updatedAt)),
		};
	}

	private serverSchemeStageToLocal(row: JsonRecord, index: number): Scheme['stages'][number] {
		return {
			index: asNumber(row.index, index),
			label: asString(row.label, `Stage ${index + 1}`),
			hook: asString(row.hook),
			condition: enumValue(SCHEME_STAGE_CONDITIONS, row.condition, 'prerequisite'),
			conditionPayload: asRecord(row.conditionPayload ?? row.condition_payload),
			completed: asBoolean(row.completed),
			completedAt: row.completedAt == null ? null : asTime(row.completedAt),
		};
	}

	private async loadImagesForEntries(storyId: string, entryIds: string[], generation: number): Promise<void> {
		if (entryIds.length === 0) return;
		const images = await getEmbeddedImagesForEntryIds(storyId, entryIds);
		if (!this.isCurrentLoad(storyId, generation)) return;
		const imageById = new Map(this.images.map((image) => [image.id, image]));
		for (const image of images) imageById.set(image.id, image);
		this.images = [...imageById.values()];
	}

	private async hydrateWorldData(storyId: string, _branchId: string | null, generation: number): Promise<void> {
		if (!this.isCurrentLoad(storyId, generation)) return;
		this.hydratingWorld = true;
		this.worldHydrationError = null;
		try {
			const lorebookEntries = await getLorebookEntries(storyId);
			if (!this.isCurrentLoad(storyId, generation)) return;
			this.lorebookEntries = lorebookEntries;

			const entryRelationships = await getEntryRelationships(storyId);
			if (!this.isCurrentLoad(storyId, generation)) return;
			this.entryRelationships = entryRelationships;

			const conversationMemories = await getConversationMemory(storyId);
			if (!this.isCurrentLoad(storyId, generation)) return;
			this.conversationMemories = conversationMemories;

			const [worldEvents, agreements] = await Promise.all([
				getWorldEvents(storyId),
				getAgreements(storyId),
			]);
			if (!this.isCurrentLoad(storyId, generation)) return;
			this.worldEvents = worldEvents;
			this.agreements = agreements;

			const [factionActions, rumors, schemes] = await Promise.all([
				getFactionActions(storyId),
				getRumors(storyId),
				getSchemes(storyId),
			]);
			if (!this.isCurrentLoad(storyId, generation)) return;
			this.factionActions = factionActions;
			this.rumors = rumors;
			this.schemes = schemes;

			globalThis.setTimeout(() => {
				if (!this.isCurrentLoad(storyId, generation)) return;
				this.preEmbedLorebook().catch(e => console.warn('[Story] preEmbedLorebook failed:', e));
				this.preEmbedChapters().catch(e => console.warn('[Story] preEmbedChapters failed:', e));
			}, 500);
		} catch (e) {
			if (this.isCurrentLoad(storyId, generation)) {
				this.worldHydrationError = e instanceof Error ? e.message : String(e);
				console.warn('[Story] world hydration failed:', e);
			}
		} finally {
			if (this.isCurrentLoad(storyId, generation)) this.hydratingWorld = false;
		}
	}

	async loadOlderEntries(limit = OLDER_TRANSCRIPT_PAGE_SIZE): Promise<void> {
		if (!this.currentStory || this.loadingOlderEntries || this.oldestLoadedEntryPosition == null) return;
		const storyId = this.currentStory.id;
		const serverStoryId = this.currentStory.serverStoryId ?? null;
		const beforePosition = this.oldestLoadedEntryPosition;
		const branchId = this.currentStory.currentBranchId ?? null;
		this.loadingOlderEntries = true;
		try {
			let older: StoryEntry[] = [];
			let backendEntryCount: number | null = null;
			let backendHasMore: boolean | null = null;

			if (serverStoryId) {
				try {
					const page = await fetchBackendStoryEntriesPage(serverStoryId, {
						beforePosition,
						limit,
						branchId,
					});
					if (!this.currentStory || this.currentStory.id !== storyId) return;

					older = page.entries
						.map((row) => this.serverEntryToLocal(asRecord(row)))
						.filter((entry): entry is StoryEntry => Boolean(entry));
					for (const entry of older) await putStoryEntry(entry);
					backendEntryCount = page.entryCount;
					backendHasMore = page.hasMore;
					this.currentStory = {
						...this.currentStory,
						serverVersion: page.serverVersion,
						syncStatus: 'synced',
					};
					await updateStory(storyId, {
						serverVersion: page.serverVersion,
						syncStatus: 'synced',
						updatedAt: Date.now(),
					});
				} catch (error) {
					console.warn('[Story] backend transcript page unavailable; using local cache:', error);
				}
			}

			if (older.length === 0 && backendEntryCount === null) {
				older = await getStoryEntriesBeforePosition(
					storyId,
					beforePosition,
					limit,
					branchId,
				);
			}
			if (!this.currentStory || this.currentStory.id !== storyId) return;

			if (older.length === 0) {
				if (backendEntryCount !== null) {
					this.entryCount = Math.max(backendEntryCount, this.entries.length);
					if (backendHasMore === false) this.oldestLoadedEntryPosition = null;
				} else {
					this.entryCount = this.entries.length;
				}
				return;
			}
			if (serverStoryId) {
				this.entries = mergeControlSurfaceEntryWindow(this.entries, older, {
					limit: DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
					anchor: 'oldest',
				});
			} else {
				const byId = new Map<string, StoryEntry>();
				for (const entry of [...older, ...this.entries]) byId.set(entry.id, entry);
				this.entries = sortPromptEntries([...byId.values()]);
			}
			this.oldestLoadedEntryPosition = backendHasMore === false ? null : this.entries[0]?.position ?? null;
			if (backendEntryCount !== null) {
				this.entryCount = Math.max(backendEntryCount, this.entries.length);
			}

			const olderImages = await getEmbeddedImagesForEntryIds(storyId, older.map((entry) => entry.id));
			if (olderImages.length > 0) {
				const imageById = new Map(this.images.map((image) => [image.id, image]));
				for (const image of olderImages) imageById.set(image.id, image);
				this.images = [...imageById.values()];
			}
		} finally {
			this.loadingOlderEntries = false;
		}
	}

	/**
	 * Pre-embed all lorebook entries for semantic search.
	 * Uses content hashing — reopening a story with unchanged entries is free.
	 */
	async preEmbedLorebook(): Promise<void> {
		if (!this.currentStory || this.lorebookEntries.length === 0) return;
		const { ai } = await import('$lib/services/ai');
		const items = this.lorebookEntries.map(e => ({
			text: `${e.name}: ${e.description}`,
			sourceId: e.id,
			sourceType: 'lorebook' as const,
		}));
		await ai.embeddings.embedMany(items);
	}

	/**
	 * Pre-embed all chapter summaries for semantic retrieval.
	 */
	async preEmbedChapters(): Promise<void> {
		if (!this.currentStory) return;
		const chapters = await getChapters(this.currentStory.id);
		if (chapters.length === 0) return;
		const { ai } = await import('$lib/services/ai');
		const items = chapters.map(c => ({
			text: `${c.title ?? 'Chapter ' + c.number}: ${c.summary}`,
			sourceId: c.id,
			sourceType: 'chapter' as const,
		}));
		await ai.embeddings.embedMany(items);
	}

	async addEntry(type: StoryEntry['type'], content: string, reasoning?: string): Promise<StoryEntry> {
		if (!this.currentStory) throw new Error('No story loaded');

		// Serialize entry creation to prevent position collision from concurrent calls
		const previous = this._entryLock;
		let releaseLock!: () => void;
		this._entryLock = new Promise(r => { releaseLock = r; });
		await previous;

		try {
			const lastLoadedPosition = this.entries.reduce((max, e) => Math.max(max, e.position), -1);
			const lastPersistedPosition = lastLoadedPosition >= 0
				? lastLoadedPosition
				: await getLastStoryEntryPosition(this.currentStory.id, this.currentStory.currentBranchId ?? null);
			const entry: StoryEntry = {
				id: uuid(),
				storyId: this.currentStory.id,
				type,
				content,
				parentId: null,
				position: lastPersistedPosition + 1,
				createdAt: Date.now(),
				metadata: null,
				branchId: this.currentStory.currentBranchId ?? null,
				reasoning,
			};
			await createStoryEntry(entry);
			this.entries = this.currentStory.serverStoryId
				? mergeControlSurfaceEntryWindow(this.entries, [entry], {
					limit: DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
					anchor: 'newest',
				})
				: [...this.entries, entry];
			this.promptEntries = mergePromptEntryWindow(this.promptEntries, [entry]);
			this.entryCount = Math.max(this.entryCount + 1, this.entries.length);
			await updateStory(this.currentStory.id, { updatedAt: Date.now() });
			if (this.currentStory.serverStoryId) {
				try {
					await queueBackendSyncOp(this.currentStory, 'create_entry', { entry });
					const sync = await pushPendingBackendOps(this.currentStory);
					if (sync) {
						await this.applyBackendSyncChanges(sync.changes);
						this.currentStory = {
							...this.currentStory,
							serverVersion: sync.serverVersion,
							syncStatus: sync.syncStatus,
						};
					}
				} catch (e) {
					console.warn('[Story] backend entry sync failed:', e);
					this.currentStory = { ...this.currentStory, syncStatus: 'offline' };
				}
			}
			return entry;
		} finally {
			releaseLock();
		}
	}

	private serverEntryToLocal(row: Record<string, unknown>): StoryEntry | null {
		if (!this.currentStory) return null;
		const id = typeof row.id === 'string' ? row.id : null;
		const type = row.type === 'user_action' || row.type === 'narration' || row.type === 'system' || row.type === 'retry'
			? row.type
			: null;
		const content = typeof row.content === 'string' ? row.content : null;
		if (!id || !type || content == null) return null;
		const createdAt = typeof row.createdAt === 'string'
			? Date.parse(row.createdAt)
			: typeof row.createdAt === 'number'
				? row.createdAt
				: Date.now();
		return {
			id,
			storyId: this.currentStory.id,
			type,
			content,
			parentId: typeof row.parentId === 'string' ? row.parentId : null,
			position: typeof row.position === 'number' ? row.position : this.entries.length,
			createdAt: Number.isFinite(createdAt) ? createdAt : Date.now(),
			metadata: row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
				? row.metadata as StoryEntry['metadata']
				: null,
			branchId: typeof row.branchId === 'string' ? row.branchId : null,
		};
	}

	async mirrorBackendEntries(rows: Array<Record<string, unknown>>): Promise<StoryEntry[]> {
		if (!this.currentStory || rows.length === 0) return [];
		const entries = rows
			.map((row) => this.serverEntryToLocal(row))
			.filter((entry): entry is StoryEntry => Boolean(entry));
		if (entries.length === 0) return [];

		for (const entry of entries) await putStoryEntry(entry);
		if (this.currentStory.serverStoryId) {
			this.entries = mergeControlSurfaceEntryWindow(this.entries, entries, {
				limit: DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
				anchor: 'newest',
			});
		} else {
			const byId = new Map(this.entries.map((entry) => [entry.id, entry]));
			for (const entry of entries) byId.set(entry.id, entry);
			this.entries = sortPromptEntries([...byId.values()]);
		}
		this.promptEntries = mergePromptEntryWindow(this.promptEntries, entries);
		this.entryCount = Math.max(this.entryCount, this.entries.length);
		this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;
		await updateStory(this.currentStory.id, { updatedAt: Date.now() });
		return entries;
	}

	private async applyBackendEntityChange(row: JsonRecord): Promise<void> {
		if (!this.currentStory) return;
		const id = asString(row.id);
		if (!id) return;
		const currentLocationId = this.locations.find((location) => location.current)?.id ?? null;

		const entry = this.serverEntityToLorebookEntry(row);
		if (entry) {
			await putLorebookEntry(entry);
			this.upsertProjectedLoreEntry(entry);
		}

		const character = this.serverEntityToCharacter(row);
		if (character) {
			await putCharacter(character);
			this.characters = upsertById(this.characters, character);
		} else {
			this.characters = removeById(this.characters, id);
		}

		const location = this.serverEntityToLocation(row, currentLocationId);
		if (location) {
			await putLocation(location);
			this.locations = upsertById(this.locations, location);
		} else {
			this.locations = removeById(this.locations, id);
		}

		const item = this.serverEntityToItem(row);
		if (item) {
			await putItem(item);
			this.items = upsertById(this.items, item);
		} else {
			this.items = removeById(this.items, id);
		}
	}

	private async applyBackendMemoryNodeChange(row: JsonRecord): Promise<void> {
		const conversation = this.serverMemoryNodeToConversation(row);
		if (conversation) {
			await putConversationMemory(conversation);
			this.conversationMemories = upsertById(this.conversationMemories, conversation)
				.sort((a, b) => a.createdAt - b.createdAt);
		}

		const action = this.serverMemoryNodeToFactionAction(row);
		if (action) {
			await bulkPutFactionActions([action]);
			this.factionActions = upsertById(this.factionActions, action)
				.sort((a, b) => a.createdAt - b.createdAt);
		}

		const rumor = this.serverMemoryNodeToRumor(row);
		if (rumor) {
			await bulkPutRumors([rumor]);
			this.rumors = upsertById(this.rumors, rumor)
				.sort((a, b) => a.createdAt - b.createdAt);
		}

		const scheme = this.serverMemoryNodeToScheme(row);
		if (scheme) {
			await bulkPutSchemes([scheme]);
			this.schemes = upsertById(this.schemes, scheme)
				.sort((a, b) => a.createdAt - b.createdAt);
		}
	}

	private async applyBackendSyncChanges(changes: SyncChange[]): Promise<void> {
		if (!this.currentStory || changes.length === 0) return;

		const entryRows = changes
			.filter((change) => change.op === 'upsert' && change.table === 'story_entries')
			.map((change) => asRecord(change.row));
		await this.mirrorBackendEntries(entryRows);

		for (const change of changes) {
			if (change.op !== 'upsert') continue;
			const row = asRecord(change.row);
			if (Object.keys(row).length === 0) continue;

			if (change.table === 'entities') {
				await this.applyBackendEntityChange(row);
			} else if (change.table === 'agreements') {
				const agreement = this.serverAgreementToLocal(row);
				if (agreement) {
					await putAgreement(agreement);
					this.agreements = upsertById(this.agreements, agreement)
						.sort((a, b) => a.createdAt - b.createdAt);
				}
			} else if (change.table === 'story_threads') {
				const thread = this.serverThreadToLocal(row);
				if (thread) await putStoryThread(thread);
			} else if (change.table === 'npc_beliefs') {
				const memory = this.serverNpcBeliefToConversation(row);
				if (memory) {
					await putConversationMemory(memory);
					this.conversationMemories = upsertById(this.conversationMemories, memory)
						.sort((a, b) => a.createdAt - b.createdAt);
				}
			} else if (change.table === 'story_events') {
				const event = this.serverEventToLocal(row as BootstrapResponse['recentEvents'][number]);
				await putWorldEvent(event);
				this.worldEvents = upsertById(this.worldEvents, event)
					.sort((a, b) => a.createdAt - b.createdAt);
			} else if (change.table === 'memory_nodes') {
				await this.applyBackendMemoryNodeChange(row);
			} else if (change.table === 'chapters') {
				const chapter = this.serverChapterToLocal(row);
				if (chapter) await putChapter(chapter);
			} else if (change.table === 'arcs') {
				const arc = this.serverArcToLocal(row);
				if (arc) await putArc(arc);
			} else if (change.table === 'sagas') {
				const saga = this.serverSagaToLocal(row);
				if (saga) await putSaga(saga);
			} else if (change.table === 'stories') {
				const title = asString(row.title, this.currentStory.title);
				this.currentStory = {
					...this.currentStory,
					title,
					description: asNullableString(row.description),
					genre: asNullableString(row.genre),
					headerPrompt: asNullableString(row.headerPrompt),
				};
			}
		}

		if (!this.currentStory) return;
		const serverVersion = changes.reduce((max, change) => Math.max(max, change.version), this.currentStory.serverVersion ?? 0);
		this.currentStory = { ...this.currentStory, serverVersion, syncStatus: 'synced' };
		await updateStory(this.currentStory.id, {
			title: this.currentStory.title,
			description: this.currentStory.description,
			genre: this.currentStory.genre,
			headerPrompt: this.currentStory.headerPrompt,
			serverVersion,
			syncStatus: 'synced',
		});
	}

	private async flushBackendOutbox(current: Story): Promise<boolean> {
		if (!current.serverStoryId) return true;
		const sync = await pushPendingBackendOps(current);
		if (!sync) return true;
		if (this.currentStory?.id !== current.id) return false;
		if (sync.syncStatus === 'offline') {
			this.currentStory = { ...this.currentStory, syncStatus: 'offline' };
			await updateStory(current.id, { syncStatus: 'offline' });
			return false;
		}
		if (sync.changes.length > 0) await this.applyBackendSyncChanges(sync.changes);
		if (this.currentStory?.id !== current.id) return false;
		this.currentStory = {
			...this.currentStory,
			serverVersion: sync.serverVersion,
			syncStatus: sync.syncStatus,
		};
		await updateStory(current.id, {
			serverVersion: sync.serverVersion,
			syncStatus: sync.syncStatus,
		});
		return sync.syncStatus !== 'conflict';
	}

	async retryBackendSyncRepair(opId: string): Promise<void> {
		const current = this.currentStory;
		if (!current?.serverStoryId) return;
		await updateSyncOp(opId, {
			status: 'pending',
			error: null,
			repairPayload: null,
			repairReason: null,
			repairCreatedAt: null,
		});
		if (this.currentStory?.id !== current.id) return;
		this.currentStory = { ...this.currentStory, syncStatus: 'syncing' };
		await updateStory(current.id, { syncStatus: 'syncing' });
		await this.pullBackendProjection();
	}

	async discardBackendSyncRepair(opId: string): Promise<void> {
		const current = this.currentStory;
		if (!current?.serverStoryId) return;
		const rows = await getSyncOpsForStory(current.id);
		await deleteSyncOp(opId);
		const remaining = rows.filter((op) => op.id !== opId);
		if (this.currentStory?.id !== current.id) return;
		const hasRepair = remaining.some((op) => op.status === 'needs_repair' || op.status === 'rejected');
		const hasPending = remaining.some((op) => op.status === 'pending' || op.status === 'pushing');
		const syncStatus: Story['syncStatus'] = hasRepair ? 'conflict' : hasPending ? 'syncing' : 'synced';
		this.currentStory = { ...this.currentStory, syncStatus };
		await updateStory(current.id, { syncStatus });
	}

	async pullBackendProjection(): Promise<void> {
		const current = this.currentStory;
		if (!current?.serverStoryId) return;
		try {
			const flushed = await this.flushBackendOutbox(current);
			if (!flushed || this.currentStory?.id !== current.id) return;
			const refreshed = this.currentStory ?? current;
			const result = await pullBackendChanges(refreshed);
			if (!result || this.currentStory?.id !== current.id) return;
			await this.applyBackendSyncChanges(result.changes);
			if (!this.currentStory || this.currentStory.id !== current.id) return;
			const serverStoryId = refreshed.serverStoryId;
			if (serverStoryId) {
				try {
					const projection = await fetchBackendStoryProjection(serverStoryId, INITIAL_TRANSCRIPT_LOAD_LIMIT);
					if (this.currentStory?.id === current.id) await this.applyCampaignProjection(projection);
				} catch (error) {
					console.warn('[Story] backend campaign projection unavailable; continuing with sync changes:', error);
				}
			}
			if (!this.currentStory || this.currentStory.id !== current.id) return;
			const serverVersion = Math.max(result.serverVersion, this.currentStory.serverVersion ?? 0);
			this.currentStory = { ...this.currentStory, serverVersion, syncStatus: 'synced' };
			await updateStory(this.currentStory.id, {
				serverVersion,
				syncStatus: 'synced',
			});
		} catch (error) {
			console.warn('[Story] backend pull sync failed:', error);
			if (this.currentStory?.id === current.id) {
				this.currentStory = { ...this.currentStory, syncStatus: 'offline' };
				await updateStory(current.id, { syncStatus: 'offline' });
			}
		}
	}

	async submitBackendTurn(request: Omit<TurnRequest, 'storyId' | 'localVersion'>): Promise<TurnResponse> {
		if (!this.currentStory?.serverStoryId) throw new Error('Story is not bound to the terminal world database.');
		const current = this.currentStory;
		const flushed = await this.flushBackendOutbox(current);
		if (!flushed || !this.currentStory || this.currentStory.id !== current.id) {
			throw new Error('Pending backend commands could not be synced before this turn.');
		}
		if (this.currentStory.syncStatus === 'conflict') {
			throw new Error('Resolve backend sync conflicts before submitting another backend turn.');
		}
		const response = await processBackendTurn({
			...request,
			storyId: this.currentStory.serverStoryId,
			localVersion: this.currentStory.serverVersion ?? 0,
		});
		await this.mirrorBackendEntries(response.entries);
		await this.applyBackendSyncChanges(response.syncChanges);
		this.lastTurnPerformance = response.performance;
		this.currentStory = {
			...this.currentStory,
			serverVersion: response.serverVersion,
			syncStatus: response.warnings.length > 0 ? 'syncing' : 'synced',
		};
		await updateStory(this.currentStory.id, {
			serverVersion: response.serverVersion,
			syncStatus: this.currentStory.syncStatus,
			updatedAt: Date.now(),
		});
		return response;
	}

	async deleteEntry(id: string): Promise<void> {
		if (!this.currentStory) return;
		const target = this.entries.find((entry) => entry.id === id);
		if (!target) return;
		await deleteStoryEntry(id);
		this.entries = this.entries.filter((entry) => entry.id !== id);
		this.promptEntries = removePromptEntriesById(this.promptEntries, new Set([id]));
		this.entryCount = Math.max(0, this.entryCount - 1);
		this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;
		await updateStory(this.currentStory.id, { updatedAt: Date.now() });
		if (this.currentStory.serverStoryId) {
			await queueBackendSyncOp(this.currentStory, 'delete_entry', {
				entryId: id,
				reason: 'Player deleted a poisoned context message.',
			});
			try {
				const sync = await pushPendingBackendOps(this.currentStory);
				if (sync) {
					await this.applyBackendSyncChanges(sync.changes);
					this.currentStory = { ...this.currentStory, serverVersion: sync.serverVersion, syncStatus: sync.syncStatus };
				}
			} catch (e) {
				console.warn('[Story] backend delete sync failed:', e);
			}
		}
	}

	async deleteEntriesFromPosition(position: number): Promise<void> {
		if (!this.currentStory) return;
		const removed = this.entries.filter((entry) => entry.position >= position);
		if (removed.length === 0) return;
		await deleteStoryEntriesFromPosition(this.currentStory.id, position);
		this.entries = this.entries.filter((entry) => entry.position < position);
		this.promptEntries = removePromptEntriesFromPosition(this.promptEntries, position);
		this.entryCount = await countStoryEntries(this.currentStory.id, this.currentStory.currentBranchId ?? null);
		this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;
		await updateStory(this.currentStory.id, { updatedAt: Date.now() });
		if (this.currentStory.serverStoryId) {
			await queueBackendSyncOp(this.currentStory, 'delete_entry', {
				fromPosition: position,
				entryIds: removed.map((entry) => entry.id),
				reason: 'Player deleted poisoned context from this point onward.',
			});
			try {
				const sync = await pushPendingBackendOps(this.currentStory);
				if (sync) {
					await this.applyBackendSyncChanges(sync.changes);
					this.currentStory = { ...this.currentStory, serverVersion: sync.serverVersion, syncStatus: sync.syncStatus };
				}
			} catch (e) {
				console.warn('[Story] backend range delete sync failed:', e);
			}
		}
	}

	private applyCanonicalVersion(serverVersion: number | null): void {
		if (serverVersion !== null && this.currentStory) {
			this.currentStory = { ...this.currentStory, serverVersion, syncStatus: 'synced' };
		}
	}

	private upsertProjectedLoreEntry(entry: Entry): void {
		this.lorebookEntries = this.lorebookEntries.some((existing) => existing.id === entry.id)
			? this.lorebookEntries.map((existing) => existing.id === entry.id ? entry : existing)
			: [...this.lorebookEntries, entry];
	}

	async addCharacter(name: string, description?: string, relationship?: string): Promise<Character> {
		if (!this.currentStory) throw new Error('No story loaded');
		const char: Character = {
			id: uuid(),
			storyId: this.currentStory.id,
			branchId: this.currentStory.currentBranchId ?? null,
			name,
			description: description ?? null,
			traits: [],
			relationship: relationship ?? 'neutral',
			status: 'active',
			metadata: null,
			visualDescriptors: {},
			portrait: null,
		};
		const result = await saveCanonicalCharacter(char, 'create');
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.characters = [...this.characters, char];
		return char;
	}

	async updateCharacterFromClassification(name: string, updates: { description?: string | null; relationship?: string | null; status?: string; traits?: string[] }) {
		const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
		if (!char) return;
		const merged: Partial<Character> = {};
		if (updates.description && updates.description !== char.description) merged.description = updates.description;
		if (updates.relationship && updates.relationship !== char.relationship) merged.relationship = updates.relationship;
		if (updates.status && updates.status !== char.status) {
			// Map classifier transient signals onto the persistent Character.status enum:
			//   'departed'  → 'inactive'  (alive but off-screen — should NOT match "present" filters)
			//   'unknown'   → preserve existing status
			//   everything else → pass through
			if (updates.status === 'unknown') {
				// preserve existing status
			} else if (updates.status === 'departed') {
				merged.status = 'inactive';
			} else {
				merged.status = updates.status as Character['status'];
			}
		}
		if (updates.traits && updates.traits.length > 0) {
			// Merge traits, don't replace
			const newTraits = [...new Set([...char.traits, ...updates.traits])];
			if (newTraits.length !== char.traits.length) merged.traits = newTraits;
		}
		if (Object.keys(merged).length === 0) return;
		const updated = { ...char, ...merged };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.characters = this.characters.map(c => c.id === char.id ? updated : c);
	}

	async updateCharacterDetails(id: string, updates: Partial<Pick<Character, 'name' | 'description' | 'traits' | 'status'>>): Promise<void> {
		const char = this.characters.find(c => c.id === id);
		if (!char) return;
		const clean: Partial<Character> = {};
		if (updates.name !== undefined) {
			const name = updates.name.trim();
			if (name && name !== char.name) clean.name = name;
		}
		if (updates.description !== undefined && updates.description !== char.description) {
			clean.description = updates.description?.trim() || null;
		}
		if (updates.traits !== undefined) {
			const traits = [...new Set(updates.traits.map(t => t.trim()).filter(Boolean))];
			if (traits.join('|') !== char.traits.join('|')) clean.traits = traits;
		}
		if (updates.status !== undefined && updates.status !== char.status) {
			clean.status = updates.status;
		}
		if (Object.keys(clean).length === 0) return;

		const updated = { ...char, ...clean };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.characters = this.characters.map(c => c.id === char.id ? updated : c);

		if (clean.name && char.relationship === 'self') {
			const oldName = char.name.toLowerCase();
			const target = this.lorebookEntries.find(e =>
				e.type === 'character' && (
					e.name.toLowerCase() === oldName ||
					(e.aliases ?? []).some(a => a.toLowerCase() === oldName)
				)
			);
			if (target) {
				const aliases = [...new Set([...(target.aliases ?? []), char.name])];
				const result = await patchCanonicalLorebookEntry(target.id, { name: clean.name, aliases, updatedAt: Date.now() });
				if (result.serverVersion && this.currentStory) {
					this.currentStory = { ...this.currentStory, serverVersion: result.serverVersion, syncStatus: 'synced' };
				}
				this.lorebookEntries = this.lorebookEntries.map(e =>
					e.id === target.id ? { ...e, name: clean.name!, aliases, updatedAt: Date.now() } : e
				);
			}
		}
	}

	async saveProtagonist(updates: { name: string; description?: string | null; traits?: string[] }): Promise<void> {
		const name = updates.name.trim();
		if (!this.currentStory || !name) return;
		const existing = this.protagonist;
		if (!existing) {
			const char = await this.addCharacter(name, updates.description ?? undefined, 'self');
			if (updates.traits?.length) {
				await this.updateCharacterDetails(char.id, { traits: updates.traits });
			}
			return;
		}
		await this.updateCharacterDetails(existing.id, {
			name,
			description: updates.description ?? null,
			traits: updates.traits ?? existing.traits,
		});
	}

	/**
	 * Sync presence onto the matching character lorebook Entry's state.
	 * Without this the lorebook's CharacterEntryState.isPresent / lastSeenLocation
	 * drift from the live Character.metadata.lastSeenLocation forever.
	 */
	private async syncLorebookPresence(charName: string, isPresent: boolean, locationName: string | null) {
		// Match by canonical name OR alias — the classifier emits names as they
		// appeared in prose ("Lord Stark") but the canonical entry might be
		// "Eddard Stark" with "Lord Stark" listed in aliases. Without alias
		// matching, the lookup silently misses and isPresent never updates.
		const needle = charName.toLowerCase();
		const target = this.lorebookEntries.find(e => {
			if (e.type !== 'character') return false;
			if (e.name?.toLowerCase() === needle) return true;
			return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
		});
		if (!target) return;
		const oldState = target.state as import('$lib/types').CharacterEntryState;
		const newState: import('$lib/types').CharacterEntryState = {
			...oldState,
			type: 'character',
			isPresent,
			lastSeenLocation: locationName,
		};
		const now = Date.now();
		try {
			const result = await patchCanonicalLorebookEntry(target.id, { state: newState, updatedAt: now });
			if (result.serverVersion && this.currentStory) {
				this.currentStory = { ...this.currentStory, serverVersion: result.serverVersion, syncStatus: 'synced' };
			}
			this.lorebookEntries = this.lorebookEntries.map(e =>
				e.id === target.id ? { ...e, state: newState, updatedAt: now } : e,
			);
		} catch (e) {
			console.warn(`[Story] syncLorebookPresence failed for ${charName}:`, e);
		}
	}

	/**
	 * Update character presence — set lastSeenLocation on the Character row AND
	 * the matching lorebook Entry's state, so the two never drift.
	 */
	async updatePresence(characterNames: string[], locationName: string) {
		for (const name of characterNames) {
			const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
			if (!char) continue;
			const meta = { ...(char.metadata ?? {}), lastSeenLocation: locationName };
			const updated = { ...char, metadata: meta };
			const result = await saveCanonicalCharacter(updated);
			this.applyCanonicalVersion(result.serverVersion);
			this.upsertProjectedLoreEntry(result.entry);
			this.characters = this.characters.map(c =>
				c.id === char.id ? updated : c
			);
			await this.syncLorebookPresence(char.name, true, locationName);
		}
	}

	/**
	 * Clear presence for characters who departed or died — removes lastSeenLocation
	 * from both the Character row and the lorebook Entry's state.
	 */
	async clearPresenceForCharacters(characterNames: string[]) {
		for (const name of characterNames) {
			const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
			if (!char) continue;
			const meta = { ...(char.metadata ?? {}) };
			delete meta.lastSeenLocation;
			const updated = { ...char, metadata: meta };
			const result = await saveCanonicalCharacter(updated);
			this.applyCanonicalVersion(result.serverVersion);
			this.upsertProjectedLoreEntry(result.entry);
			this.characters = this.characters.map(c =>
				c.id === char.id ? updated : c
			);
			await this.syncLorebookPresence(char.name, false, null);
		}
	}

	async clearPresence(characterId: string) {
		const char = this.characters.find(c => c.id === characterId);
		if (!char) return;
		const meta = { ...(char.metadata ?? {}) };
		delete meta.lastSeenLocation;
		const updated = { ...char, metadata: meta };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.characters = this.characters.map(c =>
			c.id === characterId ? updated : c
		);
		await this.syncLorebookPresence(char.name, false, null);
	}

	async addOrUpdateLocation(name: string, description?: string | null, current?: boolean): Promise<void> {
		if (!this.currentStory) return;

		// ── Step 1: clear `current` on every other location FIRST, so we never
		// have two rows with current=true at any persisted point in time. The
		// previous version forgot to await these and read stale memory state.
		if (current) {
			const targetName = name.toLowerCase();
			const stale = this.locations.filter(l => l.current && l.name.toLowerCase() !== targetName);
			for (const loc of stale) {
				const updated = { ...loc, current: false };
				const result = await saveCanonicalLocation(updated);
				this.applyCanonicalVersion(result.serverVersion);
				this.upsertProjectedLoreEntry(result.entry);
			}
			if (stale.length > 0) {
				const staleIds = new Set(stale.map(l => l.id));
				this.locations = this.locations.map(l => staleIds.has(l.id) ? { ...l, current: false } : l);
			}
		}

		// ── Step 2: upsert the target location ──
		const existing = this.locations.find(l => l.name.toLowerCase() === name.toLowerCase());
		if (existing) {
			const merged: Partial<Location> = {};
			if (description && description !== existing.description) merged.description = description;
			if (current !== undefined) merged.current = current;
			if (current) merged.visited = true;
			if (Object.keys(merged).length > 0) {
				const updated = { ...existing, ...merged };
				const result = await saveCanonicalLocation(updated);
				this.applyCanonicalVersion(result.serverVersion);
				this.upsertProjectedLoreEntry(result.entry);
				this.locations = this.locations.map(l => l.id === existing.id ? updated : l);
			}
		} else {
			const loc: Location = {
				id: uuid(),
				storyId: this.currentStory.id,
				branchId: this.currentStory.currentBranchId ?? null,
				name,
				description: description ?? null,
				visited: current ?? false,
				current: current ?? false,
				connections: [],
				metadata: null,
			};
			const result = await saveCanonicalLocation(loc, 'create');
			this.applyCanonicalVersion(result.serverVersion);
			this.upsertProjectedLoreEntry(result.entry);
			this.locations = [...this.locations, loc];
		}
	}

	async addOrUpdateItem(name: string, description?: string | null, quantity?: number, equipped?: boolean, location?: string): Promise<void> {
		if (!this.currentStory) return;
		const existing = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
		if (existing) {
			const merged: Partial<Item> = {};
			if (description && description !== existing.description) merged.description = description;
			if (quantity !== undefined && quantity !== existing.quantity) merged.quantity = quantity;
			if (equipped !== undefined && equipped !== existing.equipped) merged.equipped = equipped;
			if (location !== undefined && location !== existing.location) merged.location = location;
			if (Object.keys(merged).length > 0) {
				const updated = { ...existing, ...merged };
				const result = await saveCanonicalItem(updated);
				this.applyCanonicalVersion(result.serverVersion);
				this.upsertProjectedLoreEntry(result.entry);
				this.items = this.items.map(i => i.id === existing.id ? updated : i);
			}
		} else {
			const item: Item = {
				id: uuid(),
				storyId: this.currentStory.id,
				branchId: this.currentStory.currentBranchId ?? null,
				name,
				description: description ?? null,
				quantity: quantity ?? 1,
				equipped: equipped ?? false,
				location: location ?? '',
				metadata: null,
			};
			const result = await saveCanonicalItem(item, 'create');
			this.applyCanonicalVersion(result.serverVersion);
			this.upsertProjectedLoreEntry(result.entry);
			this.items = [...this.items, item];
		}
	}

	/**
	 * Build the full narrator system prompt.
	 *
	 * Sections, in order:
	 *   1. Header              — per-story preamble, role declaration, POV/tense
	 *   2. Instructions        — tone, style, agency, world posture, response rules
	 *   3. Tools               — what the world-update classifier will extract after narration
	 *   4. Characters          — current scene: protagonist + NPCs + equipped items + location/time/meters
	 *   5. Arcs                — condensed long-term story history
	 *   6. Chapters            — recent chapter summaries not yet condensed into arcs
	 *   7. Entry History       — brief preamble (actual turns flow as conversation messages)
	 *   8. Living World        — agreements, rumors, faction moves, world sim signals
	 *   9. Final Instructions  — closing directives + send-the-reply directive
	 *
	 * A caller that has pre-fetched a StateSnapshot (orchestrator path) passes
	 * it in so sections 4/5/6/8 can be populated. Callers using this for token
	 * estimation or previews can omit the argument.
	 */
	buildSystemPrompt(snapshot?: StateSnapshot): string {
		const s = this.currentStory;
		if (!s) return '';

		const mode = s.mode ?? 'adventure';
		const snap = snapshot ?? emptySnapshot();

		const parts: string[] = [];
		parts.push(this.#sectionHeader(s, mode));
		parts.push(this.#sectionInstructions(s, mode));
		// Token-estimation / preview path: default to the no-inline-tools variant
		// since that's the safe default (OpenRouter, OpenAI-compat). The orchestrator
		// turn path uses buildOrchestratorSystemBlocks which sets this explicitly.
		if (mode === 'adventure') parts.push(this.#sectionTools(false));
		const dynamic = this.#buildBudgetedDynamicPrompt(s, snap, mode);
		if (dynamic) parts.push(dynamic);

		let prompt = parts.filter(Boolean).join('\n\n');

		prompt = this.#resolveRoleTags(prompt, mode);

		return prompt;
	}

	#buildDynamicPromptSections(s: Story, snap: StateSnapshot, mode: string): PromptSection[] {
		const sections: PromptSection[] = [];
		const chars = this.#sectionCharacters(s, snap);
		if (chars) sections.push({ key: 'characters', text: chars });
		if (mode === 'adventure') {
			const playerReputation = this.#sectionPlayerReputation(s);
			if (playerReputation) sections.push({ key: 'playerReputation', text: playerReputation });
		}
		const factions = this.#sectionFactions(s, snap);
		if (factions) sections.push({ key: 'factions', text: factions });
		const lore = this.#sectionLorebook(snap);
		if (lore) sections.push({ key: 'lore', text: lore });
		const episodic = this.#sectionRetrievedEpisodicMemory(snap);
		if (episodic) sections.push({ key: 'episodicMemory', text: episodic });
		const conversations = this.#sectionConversationMemory(snap);
		if (conversations) sections.push({ key: 'conversationMemory', text: conversations });
		const arcs = this.#sectionArcs(snap);
		if (arcs) sections.push({ key: 'arcs', text: arcs });
		const chapters = this.#sectionChapters(snap);
		if (chapters) sections.push({ key: 'chapters', text: chapters });
		const chapterIntro = this.#sectionChapterIntro(snap);
		if (chapterIntro) sections.push({ key: 'chapterIntro', text: chapterIntro });
		sections.push({ key: 'entryHistory', text: this.#sectionEntryHistoryPreamble(mode) });
		const plotLedger = this.#sectionPlotLedger(snap);
		if (plotLedger) sections.push({ key: 'plotLedger', text: plotLedger });
		const procedural = this.#sectionProceduralMemory(snap);
		if (procedural) sections.push({ key: 'proceduralMemory', text: procedural });
		const lw = this.#sectionLivingWorld(snap);
		if (lw) sections.push({ key: 'livingWorld', text: lw });
		const schemes = this.#sectionSchemes();
		if (schemes) sections.push({ key: 'schemes', text: schemes });
		const pm = this.#sectionPlotMomentum();
		if (pm) sections.push({ key: 'plotMomentum', text: pm });
		const backendMemory = this.#sectionBackendMemory(snap);
		if (backendMemory) sections.push({ key: 'backendMemory', text: backendMemory });
		sections.push({ key: 'finalInstructions', text: this.#sectionFinalInstructions(mode) });
		return sections;
	}

	#buildBudgetedDynamicPrompt(s: Story, snap: StateSnapshot, mode: string): string {
		const model = settings.getServiceConfig('narrative').model || s.settings?.model || '';
		const totalBudget = getDynamicPromptBudget(
			getModelContextWindow(model),
			settings.contextBudget,
			mode,
			settings.uiSettings.snapshotTokenCap ?? 0,
		);
		const result = budgetPromptSections(
			this.#buildDynamicPromptSections(s, snap, mode),
			{ totalBudget },
		);
		this.lastPromptSectionUsage = result.usage;
		return result.text;
	}

	#resolveRoleTags(text: string, mode: string): string {
		if (mode !== 'adventure') return text;
		const userName = this.protagonist?.name ?? 'the player';
		return text
			.replace(/\{\{user\}\}/g, userName)
			.replace(/\{\{char\}\}/g, 'NPCs')
			.replace(/\{\{world\}\}/g, 'the world');
	}

	// ── Section 1: Header ───────────────────────────────────────────────────
	#sectionHeader(s: Story, mode: string): string {
		const pov = s.settings?.pov ?? 'second';
		const tense = s.settings?.tense ?? 'present';
		const tenseWord = tense === 'past' ? 'past' : 'present';
		const protagonist = this.protagonist;
		const parts: string[] = [];

		if (s.headerPrompt) parts.push(s.headerPrompt);

		if (mode === 'adventure') {
			const isThird = pov === 'third';
			const personLabel = isThird ? 'third person' : 'second person (you/your)';
			const userName = protagonist?.name ?? 'the player';

			parts.push(
				`## Role\n\n` +
				`You are the GM of a text-adventure simulation. You control the world, every NPC, and every consequence. The player controls one character. You NEVER speak, act, think, or decide for the protagonist. You stop when their input is needed.\n\n` +
				`Write in ${tenseWord} tense, ${personLabel} (for sensations the protagonist's body registers). For the world, NPCs, and environment, render at the protagonist's shoulder in 3rd-person limited — never inside another mind.\n\n` +
				`**{{user}}** = ${userName} — the player. You NEVER speak, act, think, or move for {{user}}.\n` +
				`**{{char}}** = all NPCs, controlled by you.\n` +
				`**{{world}}** = environment, time, physics, consequences.\n` +
				`Lines starting with ">" are player commands — interpret and narrate the result.\n\n` +
				`**EVERY RESPONSE BEGINS WITH THIS THREE-LINE HEADER:**\n\n` +
				`  # [Location, in full prose — General Area, Specific Room]\n` +
				`  ## [Time of day and date, using this story's calendar]\n` +
				`  ### [Weather and atmosphere — one short prose line]\n\n` +
				`Example:\n\n` +
				`  # Old Market District, Rain-Slick Alley\n` +
				`  ## Late afternoon, Day 12\n` +
				`  ### Cold rain, thin crowd, lantern smoke in the air\n\n` +
				`No exceptions. Header first. Prose after.`
			);
		} else {
			parts.push(`You are a skilled fiction writer. Write in ${tenseWord} tense, ${pov} person.`);
			if (protagonist) parts.push(`The main character is ${protagonist.name}. ${protagonist.description ?? ''}`);
			parts.push(`Write prose based on the author's directions.`);
		}

		if (s.genre) parts.push(`Genre: ${s.genre}`);
		if (s.description) parts.push(`Setting: ${s.description}`);

		return parts.join('\n\n');
	}

	// ── Section 2: Instructions ─────────────────────────────────────────────
	#sectionInstructions(s: Story, mode: string): string {
		const parts: string[] = ['## Instructions'];

		if (mode === 'adventure') {
			parts.push(`### Hard Rules\n\nThese six override everything. Re-read before generating:\n\n1. **NEVER write {{user}}'s dialogue, thoughts, decisions, or actions.** The player owns those.\n2. **EVERY TURN ADVANCES THE CLOCK.** The header H2 must show a new time, and the prose must state the time passed plainly ("five minutes later", "by morning", "a moment passes"). Frozen clock = dead world.\n3. **DEFAULT TO INCENTIVE-BASED FRICTION.** Powerful NPCs do not agree for free, but they can sincerely agree when the upside is high, trust is established, and the social risk is acceptable.\n4. **NO OMNISCIENT NPCs.** Each NPC knows only what they saw, heard, were told, found evidence for, or can plausibly infer after enough time.\n5. **NARRATE PROSE ONLY.** State changes are extracted from your text — make outcomes plain. Who moved, what was sworn, who took damage, what time passed, what changed.\n6. **STOP at the first moment {{user}}'s input is needed** — a question, a choice, or a held silence.`);

			parts.push(`### Dream Team — Internal Quality Checklist\n\nBefore writing, run a quick check across five specialists. NORA resolves disagreements.\n\n- **NORA (Continuity)** — Does the header advance? Is the clock moving? Are character states consistent with last turn? Am I respecting the POV lock and evidence rules?\n- **ANVIL (Psychology)** — Are NPCs reacting from their own emotional state, not plot convenience? Is there emotional inertia (no instant flips)? Are misunderstandings possible based on subjective bias?\n- **OPUS (Pacing)** — Does this beat end on a narrative hook (question, silence, sudden event) that demands player response? Did I let NPCs respond to the PC's action before stopping?\n- **JULIA (Prose)** — Is the opening anchored in place/weather/sound, not emotion? Is there concrete sensory texture? Am I showing, not telling?\n- **MIKI (Dialogue)** — Does spoken text sound like real imperfect speech? Under stress, does it fragment? Are there verbal tics, hesitations, or subtext that reveal character?`);

			parts.push(`### Header Rules\n\nUPDATE H1 the moment {{user}} moves to a new room, building, wilderness feature, vehicle, or district. Be specific enough that the player knows where they can act.\nUPDATE H2 every turn. Even a single beat moves time. Use clear diegetic time: "early morning, Day 12", "midnight, three hours later", or the setting's own calendar if the story header defines one.\nUPDATE H3 with immediate atmosphere only: weather, light, noise, crowd pressure, danger, or other scene conditions.\nThe H1/H2/H3 format itself is shown in the Role section — follow it exactly.`);

			parts.push(`### World\n\nUse the story's header, world description, lorebook, character state, faction dossiers, and recent memory as canon. If those sources conflict, prefer the most recent explicit in-story fact, then the user's header instructions, then older lore.\n\nDefault preset: A Song of Ice and Fire-style Known World political fantasy. Westeros supplies feudal houses, bannermen, wards, hostages, bastards, bloodlines, marriages, dowries, inheritance, guest right, oaths, ravens, maesters, septons, tourneys, trials, spies, sellswords, smallfolk, famine, debt, and reputation. Essos supplies free cities, merchant princes, magisters, triarchs, courtesans, sellsail fleets, banks, guilds, slave economies, red priests, black stone, old Valyrian ruins, and city-state rivalries. Braavos, Volantis, Pentos, Myr, Tyrosh, Lys, Norvos, Qohor, Lorath, Slaver's Bay, the Dothraki Sea, the Summer Isles, and other far places should shape customs and pressure when the lorebook or scene points there.\n\nDo not force Westeros as the center of every story beat. Do not hard-code a specific canon city, route, ruler, or timeline unless the story header or lorebook establishes it. Use the wider world's social rules, distances, cultures, religions, trade, debts, and rumors as pressure.\n\nWhen the player changes the world, keep the consequences alive. Factions spend resources, NPCs remember, rumors travel, promises bind, injuries linger, and time makes unattended problems worse.`);

			parts.push(`### Dragons And Public Reaction\n\nDragons are not treated like ordinary beasts. People react with awe, terror, religious dread, ambition, greed, disbelief, or political calculation depending on what they have seen, heard, and survived. Smallfolk may flee, pray, riot, hide children, spread wild rumors, or worship. Nobles and factions measure dragons as legitimacy, conquest, succession, hostage value, apocalyptic threat, or a weapon that changes every alliance.\n\nReactions are not uniform. Veterans, maesters, dragonkeepers, priests, rulers, soldiers, merchants, and peasants respond differently. Distance matters: a rumor of a dragon creates denial and gossip; a shadow overhead creates panic; burned fields create famine, hatred, refugees, and faction moves. If dragons appear, make the social, military, religious, and economic consequences visible.`);

			parts.push(`### NPC Knowledge Boundaries\n\nNPC knowledge is local, delayed, and fallible. NPCs cannot see through doors, walls, distance, crowds, darkness, disguises, or private rooms. They do not know what {{user}} did off-screen unless they witnessed it, overheard it, were told by someone who could know, found evidence, received a raven/message, or had time to infer it from visible consequences.\n\nWhen an NPC reacts to hidden or off-screen facts, the scene must imply the source: a witness, servant, spy, rumor, letter, blood trail, missing item, changed guard pattern, or similar evidence. If no source exists, the NPC must remain ignorant, suspicious without proof, wrong, late, or only partially informed.\n\nIntelligence varies. Some NPCs are observant, educated, paranoid, or well-informed; others are dull, drunk, panicked, distracted, superstitious, biased, illiterate, proud, or bad at reading people. Use mistakes, delays, bad assumptions, gossip distortion, and faction misinformation as normal play.`);

			parts.push(`### Known World Social Rules\n\nPower is personal, public, and regional. Bloodline, sex, legitimacy, religion, wealth, age, gender expectations, citizenship, freedom, debt, guild status, foreign birth, and rumor decide what people can safely want or say. Noble courtesy, merchant contracts, temple doctrine, bank ledgers, hostage customs, slave law, and guest right can all be weapons.\n\nWesteros is not Essos. A northern lord, a Dornish prince, an ironborn captain, a Braavosi banker, a Volantene triarch, a Pentoshi magister, a Lysene courtesan, a Qohorik smith, a red priest, and a Dothraki khalasar do not use the same social logic. Let region, faith, class, trade, and local law change how people speak, bargain, threaten, marry, punish, and remember insults.\n\nSexual politics matter as leverage and scandal. Affairs, secret lovers, brothels, coerced marriages, paternity doubts, bastardy, incest rumors, fertility pressure, forbidden desire, and in-world accusations of sexual deviancy can create blackmail, inheritance crises, religious condemnation, revenge, and faction moves. Treat "deviancy" as an in-world social accusation, not the narrator's moral judgment.\n\nSexual content involving minors is never part of play.\n\nRules of status matter every turn. A peasant cannot insult a lord without risk. A hostage smiles while measuring exits. A knight may choose oath over love. A septon may turn rumor into doctrine. A maester may hide knowledge behind service. A magister may buy what a lord would demand by blood. A banker may be more dangerous than a king. A bastard, freedman, exile, hostage, slave, sellsword, priest, or foreigner is never socially neutral.`);

			parts.push(buildEconomyScaleBlock());

			parts.push(`### Bayesian Social Logic\n\nBefore assigning betrayal, hidden motives, refusal, alliance, loyalty, or marriage, update the odds from evidence instead of defaulting to suspicion.\n\nStart with the NPC's baseline: personality, house culture, public reputation, current need, prior relationship, and known pressure. Then update with the scene evidence: {{user}}'s offer, leverage, kindness, threat, rank, resources, dragon power, debts, oaths, witnesses, and what the NPC can safely gain or lose.\n\nBetrayal or secret exploitation needs evidence: desperation, old grievance, low affinity, high upside, low detection risk, coercion, ideology, fear, or a stronger patron. Do not staple a hidden dagger onto every agreement.\n\nSincere agreement is common when expected value is positive: alliance improves survival, marriage raises status, trade increases wealth, loyalty protects kin, or public support costs less than rejection. If the deal is rational and the relationship is warm, let the "yes" land cleanly or with ordinary terms rather than automatic treachery.\n\nUse rough priors: strong ally/high trust = likely sincere; neutral but mutually beneficial = cautious bargain; hostile/low trust = demands proof; desperate or cornered = volatile. Show uncertainty through behavior, not narrator math.`);

			parts.push(`### Supernatural And Special Rules\n\nUse only the supernatural, technological, social, or mechanical rules established by the story header and lorebook. If a power, prophecy, species, machine, ritual, or hidden system is not established, do not introduce it as a shortcut.\n\nEscalate slowly. Foreshadow through evidence, cost, witnesses, and consequences before revealing major truths. A reveal that changes the world should create a new problem, not solve the scene for free.`);

			parts.push(`### Tone & Speech Register\n\nUse the tone from the story settings and header. Keep prose grounded, concrete, and playable. The player should always understand what changed, who is present, what is risky, and what they can respond to.\n\nNPC voices must be distinct and shaped by rank, house, region, faith, education, stress, motive, and relationship to {{user}}. Dialogue should sound spoken, not polished into exposition. Highborn NPCs speak with courtesy, implication, insult, and debt. Smallfolk speak with practical fear, gossip, hunger, superstition, or hard-earned bluntness. Under pressure, people interrupt themselves, evade, bargain, lie, or fall silent.\n\nFactions should appear as living institutions with members, resources, goals, territory, enemies, allies, and internal pressures. Mention those facts naturally through action and consequence, not encyclopedia paragraphs.`);

			parts.push(`### Text Adventure Style\n\nThis is not an interactive novel chapter. It is a playable text-adventure turn.\n\nWrite compact scene-forward narration: usually 1-3 paragraphs, shorter for routine actions, longer only when the action is dangerous or consequential. Lead with what the player can perceive and act on. Avoid summarizing the player's input back at them.\n\nEvery turn should answer: where are we, who is here, what changed, what pressure is rising, and what immediate opening exists for {{user}}. End at a decision point, a direct NPC prompt, a revealed obstacle, or a concrete sensory beat that invites action.\n\nDo not over-style the prose. Prefer precise nouns, active verbs, and clear consequences over literary flourish.`);

			parts.push(`### Friction Doctrine\n\nYou are not a wish-granting engine. The world does not bend toward {{user}}, but it also does not sabotage good prospects by reflex.\n\nWhen {{user}} asks for an alliance, favor, secret, confession, loyalty, discount, safe passage, forbidden item, or exception, choose the response that best fits the NPC's incentives and evidence. Use counter-demands, delay, partial concessions, suspicion, refusal, or later cost when the risk is real. Use clean acceptance when the bargain is advantageous, trust has been earned, witnesses make betrayal costly, or the offer solves the NPC's problem.\n\nA clean "yes" should not be free, but it can be rational. Marriage alliances, oaths, patronage, trade deals, and sworn service often happen because the prospects are good, not because someone is secretly waiting to betray the player.\n\nTrust is paid for across scenes through risk, leverage, proof, shared loss, cost, and consistent benefit. Major reveals are currency, not confetti. A reveal that changes everything should cost something and create new pressure.\n\n{{user}} should sometimes walk away empty-handed. Other times, previous investment should pay off as loyalty, access, protection, standing, or a genuine alliance. NPCs remember, factions react, debts come due, rumors spread, and private bargains can become public problems later.`);

			parts.push(`**Psychological Realism.** Emotional inertia — feelings do not flip instantly. An NPC who distrusted {{user}} last scene does not become a confidant without cause shown on the page. NPCs have subtext, contradictions, and stable quirks. Subjective bias: two NPCs witnessing the same PC action may interpret it differently. Misunderstandings are common because NPCs interpret {{user}} only through observable cues, never through authorial knowledge of intent.`);

			parts.push(`### Anti-Slop\n\nAvoid these patterns:\n1. Summarizing or approving {{user}}'s input before reacting.\n2. Writing {{user}}'s thoughts, dialogue, decisions, intent, or hidden emotions.\n3. Ending with vague prompts like "What do you do?" when a concrete in-world pressure could invite action instead.\n4. Repeating the same sensory detail every turn without a new reason.\n5. Turning NPC dialogue into lore exposition.\n6. Creating new lorebook names for entities already known under aliases or titles.\n\nReplace clinical emotion labels with visible action. Not "she is afraid" - show what her hands, voice, posture, or choices do. Keep the camera on observable evidence.`);

			parts.push(`### Craft\n\n**POV lock.** The player controls {{user}}. The narrator controls the world, NPCs, and consequences. Stay outside {{user}}'s thoughts and decisions. Sensory/somatic facts are allowed only when they are immediate and observable from the protagonist's body.\n\n**Scene separation.** A character in Scene B knows what happened in Scene A only if they were present, were told by a plausible source, found evidence, or inferred it from visible facts after enough time. Knowledge needs a source and travel time.\n\n**NPC state.** NPCs keep stable motives, fears, loyalties, grudges, and pressures. They do not flip from distrust to loyalty in one exchange unless the story shows a cost or cause.\n\n**Introduction protocol.** When a significant NPC, location, item, or faction appears for the first time, define it through action and one or two memorable specifics. Do not create a list or pause the scene for exposition.`);

			parts.push(`**Physical & Vocal Realism.** Bodies are fragile. Cold causes shivering, fear causes tremors, pain lingers, violence is clumsy and consequential. Raw vocalizations when words fail: pain ("GHH—", "AGH!", "Nnngh—"), exertion ("Hah— hah—", "Ngh—"), fear (gasp, shaky inhale, strangled "ah—"). The environment always matters — sounds, smells, temperature, lighting. Never write in a sensory vacuum.`);

			parts.push(`### Meters\n\nThe world may track visible or hidden meters. Never narrate meter values as numbers unless the player interface explicitly shows them. Render the behavior those values imply: suspicion, fatigue, reputation, hunger, morale, debt, danger, trust, or faction pressure.\n\nWhen a scene changes a meter, make the in-fiction reason clear enough for the extractor to record it.`);

			parts.push(`### Scene Dynamics\n\nMatch length to action weight: 1-2 sentences for routine, a paragraph for exploration, up to 3 for combat/drama. Conversation: let NPCs respond, then pause for {{user}}.\n\nNever end a response the moment {{user}} finishes their action. After the PC acts, let NPCs respond according to their current psychological state and priorities. Give them at least one beat of reaction before stopping.\n\nEvery response must end on a narrative hook that demands player response: a direct question, an unspoken silence that feels heavy, a sudden environmental shift, an NPC's unreadable expression, or a held breath. The player should feel compelled to type.`);
		} else {
			parts.push(`### Craft\nShow, never tell. Render scenes through specific sensory details, character actions, and environmental cues — not declarative statements. Ground abstract emotions in concrete experience: the quality of light, texture of air, the weight of silence. Trust readers to perceive depths without over-explanation.\n\nVary sentence rhythm deliberately. Short sentences for punch. Longer, flowing constructions to build atmosphere. Fragments for emphasis. Control tension through sentence length, paragraph breaks, and scene cuts.\n\nChoose the exact word, not its cousin — "trudged" vs "walked" vs "strode" each paint different worlds. Write fresh, unexpected imagery that illuminates rather than decorates. Embed subtext beneath dialogue and action; characters rarely say exactly what they mean.\n\nDialogue must sound like real speech: distinct voices, natural hesitations, interruptions, the music of how each character talks. No character should be interchangeable with another.`);

			if (s.genre) {
				const g = s.genre.toLowerCase();
				if (g.includes('literary') || g.includes('drama')) {
					parts.push(`This is literary fiction. Favor dense imagery, psychological complexity, and layered meaning. Let structure and prose style carry thematic weight.`);
				} else if (g.includes('horror') || g.includes('thriller') || g.includes('mystery')) {
					parts.push(`Build dread through implication, not declaration. Let the unseen carry more weight than the shown. Pacing is everything — draw out tension, then cut.`);
				} else if (g.includes('comedy') || g.includes('humor') || g.includes('satire')) {
					parts.push(`Humor lives in timing, specificity, and the gap between expectation and reality. Never signal that something is funny — just be funny.`);
				} else if (g.includes('romance')) {
					parts.push(`Tension lives in proximity, longing, and the unsaid. Physical chemistry is shown through involuntary reactions — breath catching, awareness of warmth, the charged distance between bodies.`);
				}
			}

			parts.push(`### Avoid\n- Purple prose that sacrifices clarity for flourish\n- Naming emotions directly ("she felt sad") instead of showing their physical manifestations\n- Clichéd phrases that deaden impact ("a chill ran down their spine", "time seemed to stop")\n- Over-explaining what readers can infer from context\n- Inconsistent voice or sudden unearned style shifts`);
			parts.push(`### Structure\n- Write 2-4 paragraphs per response\n- End at a moment that invites the next action\n- Stay consistent with established world facts`);
		}

		return parts.join('\n\n');
	}

	// ── Section 3: Tools ────────────────────────────────────────────────────
	// Two variants depending on whether inline tool calls are wired:
	//   - useInlineTools = true  → narrator calls tools directly (Anthropic native)
	//   - useInlineTools = false → a separate post-stream classifier extracts
	//       deltas from the prose (OpenAI-compat / OpenRouter / open-source models)
	#sectionTools(useInlineTools: boolean): string {
		if (useInlineTools) {
			return [
				'## Tools',
				'You have direct access to world-state tools. **At the end of every turn**, after writing your narration, call `update_world_state` with everything that changed in the scene. The state recorded there IS the canonical world — anything you do not record is forgotten.',
				'',
				'### When to call which tool',
				'- **search_wiki** - optional. Search the local lorebook/wiki for names, factions, places, items, customs, secrets, or prior facts before writing. Treat hidden_info as narrator-only; never reveal it verbatim unless the scene earns the reveal.',
				'- **brief_wiki** - optional. Get broader terminal wiki orientation when a scene touches several linked pages, a long-running mystery, wiki health, hubs, or maintenance context. Use search_wiki for one narrow lookup; use brief_wiki when the lore graph matters.',
				'- **update_world_state** — call ONCE at the end of each turn. Cover:',
				'  - **Location** (paramount): if the player moved this turn, emit a location with `current: true`. Only one location may be current. The previous current location is unset automatically.',
				'  - **Time** (paramount, NEVER skip when time passed): emit a `time_delta` whenever any time passes in the scene. Examples: "a few seconds" (a quick exchange), "5 minutes" (a short walk), "30 minutes" (a brief conversation), "3 hours" (a meal + travel), "1 day" (overnight rest), "a week" (training/travel montage). Numbers + units parse most reliably. **If you don\'t emit `time_delta`, the world clock freezes — factions stop acting, rumors stop spreading, the world becomes static.** The only time you may omit it is for a reaction beat that takes no in-world time (a single line of dialogue mid-action).',
				'  - **Characters**: status (`active` for present, `inactive` for alive but off-screen, `departed` for "left this turn", `deceased` for died this turn) and `present: true/false`. New traits, relationships, descriptions when revealed.',
				'  - **Lorebook entries**: create or deepen rich wiki entries for significant NPCs, factions, places, items, concepts, and events. Characters/locations/items alone are runtime state; use `lorebook_entries` for durable wiki memory.',
				'  - **Items**: picked up, dropped, equipped, quantity changes.',
				'  - **Conversations**: what NPCs revealed/learned, emotional shifts.',
				'  - **Relationships**: changes between entities.',
				'  - **Story beats**: significant plot events.',
				'  - **Meter changes**: sanity, reputation, hunger, suspicion — invent meters as the fiction calls for them, adjust existing ones with signed deltas.',
				'  - **Agreements**: treaties, oaths, debts, promises, marriages, bonds, contracts, vassalage, bargains-with-entities. action=create when sworn, break when violated, fulfill when paid, update to revise terms.',
				'',
				'### Tool-call format',
				'- Write your prose first, then call the tool. Do not write tool JSON in the prose itself — call the actual tool.',
				'- Be thorough but only include entities that actually changed or appeared in this scene.',
			].join('\n');
		}

		// Fallback: model writes prose only; a separate classifier extracts deltas.
		return [
			'## Tools & State Tracking',
			'State updates are extracted from your prose by a separate step — you do **not** emit JSON or call tools. To make extraction accurate:',
			'',
			'- **Name characters and locations explicitly** when they appear, change, or leave. Avoid vague pronouns at state-change moments.',
			'- **State time passage clearly** in prose ("an hour later", "by morning", "five minutes pass", "a moment passes"). Frozen clock = dead world.',
			'- **Show outcomes plainly** — items picked up, NPCs departing, oaths sworn or broken, injuries inflicted, meters shifting.',
			'- **Make significant new lore obvious**. The follow-up state tracker creates or deepens lorebook/wiki entries from explicit names, descriptions, secrets, relationships, and consequences.',
			'- Anything you don\'t make obvious in prose will be missed and forgotten by the world.',
			'',
			'### Dice Rolls',
			'',
			'When an outcome is genuinely uncertain, end your response with a roll marker:',
			'',
			'  {{roll:DICE:DC:ABILITY:DESCRIPTION}}',
			'',
			'DICE — D&D notation (1d20, 1d20+3). DC — standard difficulty (DC 10 easy / 15 moderate / 20 hard / 25 very hard). ABILITY — STR / DEX / CON / INT / WIS / CHA.',
			'',
			'STOP writing after the marker. Wait for {{user}} to supply the result. Most turns should have no roll — only call for one when failure is genuinely possible AND interesting.',
			'',
			'When {{user}}\'s next turn includes a roll result like "[Roll: 1d20+3 = 17 vs DC 14 — SUCCESS]", narrate the outcome accordingly: success crisp, failure costly, critical results escalated.',
		].join('\n');
	}

	// ── Section 4: Characters ───────────────────────────────────────────────
	#sectionCharacters(s: Story, snap: StateSnapshot): string {
		const lines: string[] = ['## Characters'];

		// Protagonist
		const protag = this.protagonist;
		if (protag) {
			lines.push('', `### Protagonist`);
			lines.push(`${protag.name}${protag.description ? ' — ' + protag.description : ''}`);
			if (protag.traits?.length) lines.push(`Traits: ${protag.traits.join(', ')}`);
		}

		// Current scene (location, time, meters, equipped items)
		const sceneLines: string[] = [];
		const currentLoc = snap.currentLocation ?? this.locations.find(l => l.current) ?? null;
		if (currentLoc) {
			sceneLines.push(`Location: ${currentLoc.name}${currentLoc.description ? ' — ' + currentLoc.description : ''}`);
		}
		const t = s.timeTracker;
		if (t) {
			const pad = (n: number) => String(n).padStart(2, '0');
			sceneLines.push(`Time: Day ${t.days}, ${pad(t.hours)}:${pad(t.minutes)}`);
		}
		const equipped = snap.equippedItems.length > 0 ? snap.equippedItems : this.items.filter(i => i.equipped);
		if (equipped.length > 0) {
			sceneLines.push(`Inventory: ${equipped.map(i => i.name).join(', ')}`);
		}
		if (s.meters && s.meters.length > 0) {
			sceneLines.push(`Meters: ${s.meters.map(m => `${m.name}: ${m.value}/${m.max}${m.visible ? '' : ' [hidden from player]'}`).join('; ')}`);
		}
		if (sceneLines.length > 0) {
			lines.push('', `### Current Scene`, ...sceneLines);
		}

		// Present NPCs — render rich state so the narrator has specifics
		// to be specific *about*. Without this, the adversarial directive
		// in Final Instructions has nothing to bite into and NPCs default
		// to generic-agreeable.
		const present = snap.presentCharacters.length > 0
			? snap.presentCharacters
			: this.characters.filter(c => c.status === 'active' && c.relationship !== 'self').slice(0, 6);
		if (present.length > 0) {
			lines.push('', `### Present`);
			lines.push('NPCs below carry their own pressures, knowledge, and grievances. They will act on these — refuse, lie, manipulate, or pursue private agendas — when it serves them. Reference what they know. Honor what they want. Do not flatten them into helpers.');
			lines.push('');
			const totalEntries = Math.max(this.entryCount, this.promptEntries.at(-1)?.position ?? this.entries.length);
			for (const c of present) {
				// Find the matching lorebook entry (canonical or alias) — that's
				// where the rich state lives. Falls back to the bare Character
				// row when no entry exists yet (early-game).
				const needle = c.name.toLowerCase();
				const lore = this.lorebookEntries.find(e => {
					if (e.type !== 'character' || (e as any).deleted) return false;
					if (e.name?.toLowerCase() === needle) return true;
					return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
				});
				const cs = lore?.state as CharacterEntryState | undefined;

				// Header: name, relationship word + numeric level if known
				const relWord = c.relationship && c.relationship !== 'neutral' ? c.relationship : null;
				const level = cs?.relationship?.level;
				const levelTag = (typeof level === 'number' && level !== 0)
					? ` ${level > 0 ? '+' : ''}${level}`
					: '';
				const relTag = relWord ? ` (${relWord}${levelTag})` : (levelTag ? ` (${levelTag.trim()})` : '');
				lines.push(`- **${c.name}**${relTag}`);

				// Description / bio
				const desc = (cs?.bio ?? c.description ?? '').toString().trim();
				if (desc) lines.push(`  ${desc.slice(0, 220)}`);

				// Traits — combine Character.traits + lore personality if present
				const traits = c.traits?.length ? c.traits : [];
				if (traits.length > 0 || cs?.personality) {
					const bits: string[] = [];
					if (traits.length > 0) bits.push(traits.slice(0, 6).join(', '));
					if (cs?.personality) bits.push(cs.personality.slice(0, 100));
					lines.push(`  Traits: ${bits.join(' · ')}`);
				}

				// Pressures — the off-screen drivers. Always render when present.
				if (cs?.pressures && cs.pressures.length > 0) {
					lines.push(`  Pressures: ${cs.pressures.slice(0, 4).map(p => p.trim()).filter(Boolean).join(' · ')}`);
				}

				// What they know about the player — the basis for grudges and leverage
				if (cs?.knownFacts && cs.knownFacts.length > 0) {
					lines.push(`  Knows about you: ${cs.knownFacts.slice(-4).join('; ')}`);
				}
				if (cs?.revealedSecrets && cs.revealedSecrets.length > 0) {
					lines.push(`  Holds secrets: ${cs.revealedSecrets.slice(-3).join('; ')}`);
				}

				// Their inner stance — the line that should color every word out of their mouth
				if (cs?.personalOpinion) {
					lines.push(`  Their view of you: "${cs.personalOpinion.slice(0, 140)}"`);
				}

				// Recency — "X turns ago" so the narrator can weigh how fresh the slight is
				if (typeof cs?.lastConversationAt === 'number' && totalEntries > 0) {
					const turnsAgo = Math.max(0, totalEntries - cs.lastConversationAt);
					if (turnsAgo > 0 && turnsAgo < 9999) {
						lines.push(`  Last spoke: ${turnsAgo} turn${turnsAgo === 1 ? '' : 's'} ago`);
					}
				}

				// Active motivations from enrichment, when present (separate axis from pressures)
				if (cs?.motivations && cs.motivations.length > 0) {
					lines.push(`  Wants: ${cs.motivations.slice(0, 3).join('; ')}`);
				}
			}
		}

		// Recent story beats — characterizing context. Bumped from 2 → 5 so
		// older slights remain visible to the narrator long enough to matter.
		const recentBeats = snap.storyBeats.filter(b => b.status === 'active').slice(-5);
		if (recentBeats.length > 0) {
			lines.push('', `### Recent Beats`, ...recentBeats.map(b => `- ${b.title}`));
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	// ── Section 4b: Factions ────────────────────────────────────────────────
	// Renders the top ~6 most relevant factions so the narrator can weave
	// political context into prose. Source = snap.relevantFactions (pre-scored
	// in buildStateSnapshot).
	#sectionPlayerReputation(s: Story): string {
		const reputation = s.playerReputation?.trim();

		return [
			'## Player Reputation',
			'',
			'Public reputation attached to {{user}}. Use this to shape how strangers, courts, smallfolk, faction agents, rumor networks, and rivals react before private trust is earned.',
			'',
			reputation ? compactMemoryText(reputation, 900) : 'No durable public reputation recorded yet. Establish one only when the fiction creates public consequences.',
			'',
			'Keep it fallible: reputation varies by region, faction, rank, rumor source, and communication delay. If public reputation changes, update player_reputation through world state.',
		].join('\n');
	}

	#sectionFactions(_s: Story, snap: StateSnapshot): string {
		const factions = snap.relevantFactions;
		if (!factions || factions.length === 0) return '';

		const lines: string[] = ['## Factions'];

		for (const f of factions) {
			const state = f.state as FactionEntryState | undefined;
			if (!state) continue;
			const standing = typeof state.playerStanding === 'number' ? state.playerStanding : 0;
			const sign = standing > 0 ? `+${standing}` : `${standing}`;
			const status = state.status ?? 'unknown';
			lines.push('', `### ${stripTypePrefix(f.name)}  (${status}, ${sign})`);

			// Description — the wiki content. Without this, a freshly-imported
			// faction with no state showed nothing usable to the narrator.
			const desc = (f.description ?? '').trim();
			if (desc) lines.push(desc);

			// Disposition + top unfinished goal on one line
			const dispGoal: string[] = [];
			if (state.disposition) dispGoal.push(`Disposition: ${state.disposition}.`);
			const topGoal = (state.goals ?? [])
				.filter(g => (g.progress ?? 0) < 100)
				.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
			if (topGoal) dispGoal.push(`Top goal: ${topGoal.description}.`);
			if (dispGoal.length > 0) lines.push(dispGoal.join(' '));

			if (state.resources) {
				const r = state.resources;
				lines.push(`Resources: military ${r.military}, wealth ${r.wealth}, influence ${r.influence}, information ${r.information}, morale ${r.morale}.`);
			}

			// Territory and known members — usable context for politics scenes
			if (state.territory && state.territory.length > 0) {
				lines.push(`Territory: ${state.territory.join(', ')}.`);
			}
			if (state.knownMembers && state.knownMembers.length > 0) {
				// knownMembers are normally entry IDs; legacy/imported entries may
				// contain display names, so preserve those as a fallback.
				const memberNames = state.knownMembers
					.map(id => this.lorebookEntries.find(e => e.id === id)?.name ?? id)
					.filter((n): n is string => !!n);
				if (memberNames.length > 0) lines.push(`Known members: ${memberNames.slice(0, 6).join(', ')}.`);
			}

			// Hidden GM lore — narrator-only, never quoted in prose
			if (f.hiddenInfo) lines.push(`[Hidden — narrator-only]: ${f.hiddenInfo}`);

			// Allies / foes from interFactionRelations. Normalizes both legacy
			// (number) and post-F4 (FactionRelation) forms.
			const rels = state.interFactionRelations ?? {};
			const allyEntries: Array<[string, number]> = [];
			const foeEntries: Array<[string, number]> = [];
			for (const [name, val] of Object.entries(rels)) {
				const standing = normalizeRelation(val).standing;
				if (standing >= 30) allyEntries.push([name, standing]);
				else if (standing <= -30) foeEntries.push([name, standing]);
			}
			allyEntries.sort((a, b) => b[1] - a[1]);
			foeEntries.sort((a, b) => a[1] - b[1]);
			const allies = allyEntries.slice(0, 2).map(([n, v]) => `${n} (+${v})`);
			const foes = foeEntries.slice(0, 2).map(([n, v]) => `${n} (${v})`);
			const relLine: string[] = [];
			if (allies.length > 0) relLine.push(`Allies: ${allies.join(', ')}.`);
			if (foes.length > 0) relLine.push(`Foes: ${foes.join(', ')}.`);
			if (relLine.length > 0) lines.push(relLine.join(' '));

			// Most recent action by this faction (truncated)
			const recent = snap.factionActions
				.filter(fa => fa.factionName.toLowerCase() === f.name.toLowerCase())
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
			if (recent) {
				const action = recent.action.length > 100 ? recent.action.slice(0, 97) + '…' : recent.action;
				lines.push(`Recent: ${action}`);
			}
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	// ── Section 4b: World Lore (retrieved lorebook entries) ─────────────────
	// Semantically-retrieved entries relevant to recent narration. De-duped
	// against presentCharacters + relevantFactions + protagonist in
	// buildStateSnapshot so nothing here is already rendered above.
	//
	// Entries are emitted with their FULL description / hidden info / bio —
	// no per-entry truncation. The wiki was designed to be crawled by the
	// narrator, so chopping mid-sentence defeats the purpose. Token budget
	// is bounded by the Memory settings retrieval limit in buildStateSnapshot
	// (the retrieval service already scores by relevance).
	#sectionLorebook(snap: StateSnapshot): string {
		const entries = snap.retrievedEntries;
		if (!entries || entries.length === 0) return '';

		const lines: string[] = [
			'## World Lore',
			'',
			'Background facts relevant to the current scene. Use them only when they serve the narrative — do not list them at the player. Hidden lore is for your reference only and must not appear verbatim in narration.',
		];

		for (const e of entries) {
			const typeLabel = e.type.charAt(0).toUpperCase() + e.type.slice(1);
			lines.push('', `### ${stripTypePrefix(e.name)}  (${typeLabel})`);

			const desc = (e.description ?? '').trim();
			if (desc) lines.push(desc);

			// Compact state hints per entry type — narrator-relevant flags only
			if (e.type === 'location') {
				const ls = e.state as LocationEntryState | undefined;
				const recent = ls?.changes?.slice(-2).map(c => c.description).filter(Boolean) ?? [];
				if (recent.length > 0) lines.push(`Recent changes: ${recent.join('; ')}`);
			} else if (e.type === 'item') {
				const is = e.state as ItemEntryState | undefined;
				if (is?.condition) lines.push(`Condition: ${is.condition}`);
			} else if (e.type === 'event') {
				const es = e.state as EventEntryState | undefined;
				if (es?.occurred) lines.push('Status: has already occurred');
			} else if (e.type === 'concept') {
				const cs = e.state as ConceptEntryState | undefined;
				if (cs?.comprehensionLevel && cs.comprehensionLevel !== 'unknown') {
					lines.push(`Player comprehension: ${cs.comprehensionLevel}`);
				}
			} else if (e.type === 'character') {
				// Off-screen NPCs only — present + protagonist were de-duped out.
				const cs = e.state as CharacterEntryState | undefined;
				if (cs?.bio && !desc.includes(cs.bio.slice(0, 30))) lines.push(`Bio: ${cs.bio}`);
				if (cs?.motivations?.length) lines.push(`Motivations: ${cs.motivations.join('; ')}`);
				if (cs?.personality) lines.push(`Personality: ${cs.personality}`);
			}

			if (e.hiddenInfo) lines.push(`[Hidden — narrator-only]: ${e.hiddenInfo}`);
		}

		return lines.join('\n');
	}

	#sectionRetrievedEpisodicMemory(snap: StateSnapshot): string {
		const chapters = snap.retrievedChapters;
		if (!chapters || chapters.length === 0) return '';

		const lines: string[] = [
			'## Retrieved Episodic Memory',
			'',
			'Past events matched to the current action. Use these facts for continuity; do not recap them unless the player asks.',
		];

		for (const ch of chapters) {
			lines.push('', `- **Ch.${ch.number}: ${ch.title ?? 'Untitled'}** — ${ch.summary}`);
			if (ch.plotThreads?.length) lines.push(`  Threads: ${ch.plotThreads.slice(0, 4).join('; ')}`);
			if (ch.characters?.length) lines.push(`  People: ${ch.characters.slice(0, 6).join(', ')}`);
			if (ch.locations?.length) lines.push(`  Places: ${ch.locations.slice(0, 4).join(', ')}`);
		}

		return lines.join('\n');
	}

	#sectionConversationMemory(snap: StateSnapshot): string {
		const memories = snap.relevantConversationMemories;
		if (!memories || memories.length === 0) return '';

		const lines: string[] = [
			'## Conversation Memory',
			'',
			'NPC-specific memory. These are things an NPC may know, resent, conceal, or use as leverage.',
		];

		for (const memory of memories) {
			const bits: string[] = [];
			if (memory.playerSaid) bits.push(`player revealed: ${compactMemoryText(memory.playerSaid, 120)}`);
			if (memory.npcLearned.length) bits.push(`NPC learned: ${memory.npcLearned.slice(-3).join('; ')}`);
			if (memory.emotionalImpact) bits.push(`impact: ${compactMemoryText(memory.emotionalImpact, 100)}`);
			lines.push(`- **${memory.npcName}** — ${compactMemoryText(memory.topic, 130)}${bits.length ? ` (${bits.join(' | ')})` : ''}`);
		}

		return lines.join('\n');
	}

	// ── Section 5: Arcs ─────────────────────────────────────────────────────
	#sectionBackendMemory(snap: StateSnapshot): string {
		if (!snap.backendMemoryPacket?.trim()) return '';
		const debug = snap.backendMemoryDebug.length
			? `\n\n[retrieval-debug: ${snap.backendMemoryDebug.join(' | ')}]`
			: '';
		return `${snap.backendMemoryPacket}${debug}`;
	}

	#sectionArcs(snap: StateSnapshot): string {
		const arcs = snap.arcs;
		if (arcs.length === 0) return '';

		const FULL_ARC_COUNT = 5;
		const out: string[] = ['## Arcs'];

		if (arcs.length > FULL_ARC_COUNT) {
			const older = arcs.slice(0, arcs.length - FULL_ARC_COUNT);
			out.push('', `### Earlier`);
			for (const arc of older) {
				out.push('', `**Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange})`);
				out.push(arc.summary);
				if (arc.keyPlotPoints?.length) out.push(`Key events: ${arc.keyPlotPoints.join('; ')}`);
				if (arc.characterArcs?.length) out.push(`Character development: ${arc.characterArcs.map(ca => `${ca.name}: ${ca.development}`).join('; ')}`);
			}
		}

		const recent = arcs.slice(-FULL_ARC_COUNT);
		out.push('', `### Recent`);
		for (const arc of recent) {
			out.push('', `**Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange})`);
			out.push(arc.summary);
			if (arc.keyPlotPoints?.length) out.push(`Key events: ${arc.keyPlotPoints.join('; ')}`);
			if (arc.characterArcs?.length) out.push(`Character development: ${arc.characterArcs.map(ca => `${ca.name}: ${ca.development}`).join('; ')}`);
		}

		const allThreads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);
		if (allThreads.length > 0) {
			out.push('', `**Open threads:** ${allThreads.join('; ')}`);
		}

		return out.join('\n');
	}

	// ── Section 6: Chapters ─────────────────────────────────────────────────
	#sectionChapters(snap: StateSnapshot): string {
		const chapters = snap.chapters;
		if (chapters.length === 0) return '';

		const sorted = [...chapters].sort((a, b) => a.number - b.number);
		const coveredIds = new Set(snap.arcs.flatMap(a => a.chapterIds));
		// Always include the last 2 chapters even if covered by an arc — recency matters
		// more than the small token cost, and arc summaries lose the per-chapter emotional tone.
		const recent = sorted.slice(-2);
		const recentIds = new Set(recent.map(c => c.id));
		const uncovered = sorted.filter(c => c.pinned || !coveredIds.has(c.id));
		const merged = [
			...recent,
			...uncovered.filter(c => !recentIds.has(c.id)),
		].sort((a, b) => a.number - b.number);
		if (merged.length === 0) return '';

		const out: string[] = ['## Chapters'];
		for (const ch of merged) {
			out.push('', `**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**`);
			out.push(ch.summary);
			if (ch.emotionalTone) out.push(`[Tone: ${ch.emotionalTone}]`);
			if (ch.plotThreads?.length) out.push(`[Threads: ${ch.plotThreads.join(', ')}]`);
			if (ch.characters?.length) out.push(`[Characters: ${ch.characters.join(', ')}]`);
			if (ch.locations?.length) out.push(`[Locations: ${ch.locations.join(', ')}]`);
		}
		return out.join('\n');
	}

	// ── Section 6b: Chapter Opening (transient — fires on a fresh chapter) ──
	// When a chapter has just been created (the latest entries sit just past the
	// last chapter's endEntryId), nudge the narrator to re-establish pacing and
	// acknowledge the prior chapter's tone. Lives in the dynamic block so it
	// disappears once the new chapter is a few entries deep.
	#sectionChapterIntro(snap: StateSnapshot): string {
		const chapters = snap.chapters;
		if (chapters.length === 0) return '';
		const sorted = [...chapters].sort((a, b) => a.number - b.number);
		const last = sorted[sorted.length - 1];
		const recentEntries = this.promptEntries.length > 0
			? this.promptEntries
			: this.entries.slice(-DEFAULT_PROMPT_ENTRY_WINDOW);
		const lastEndIdx = recentEntries.findIndex(e => e.id === last.endEntryId);
		if (lastEndIdx === -1) return '';
		// Entries authored AFTER the most-recent chapter ended.
		const entriesPast = recentEntries.length - 1 - lastEndIdx;
		if (entriesPast > 3) return '';

		const out: string[] = ['## Chapter Opening'];
		out.push(`A new chapter begins. The previous chapter, **Ch.${last.number}: ${last.title ?? 'Untitled'}**, has just closed.`);
		if (last.emotionalTone) out.push(`It ended on: ${last.emotionalTone}.`);
		if (last.summary) {
			// Last sentence of the prior summary as the "final beat" hook.
			const sentences = last.summary.split(/(?<=[.!?])\s+/).filter(Boolean);
			const finalBeat = sentences[sentences.length - 1] ?? last.summary.slice(-160);
			if (finalBeat && finalBeat.length <= 220) out.push(`Final beat: ${finalBeat}`);
		}
		// Diff against the chapter before that (if any) — what's changed?
		const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
		if (prev) {
			const prevChars = new Set((prev.characters ?? []).map(s => s.toLowerCase()));
			const lastChars = new Set((last.characters ?? []).map(s => s.toLowerCase()));
			const dropped = (prev.characters ?? []).filter(c => !lastChars.has(c.toLowerCase()));
			const introduced = (last.characters ?? []).filter(c => !prevChars.has(c.toLowerCase()));
			if (dropped.length) out.push(`Off-stage: ${dropped.slice(0, 6).join(', ')}.`);
			if (introduced.length) out.push(`Recently surfaced: ${introduced.slice(0, 6).join(', ')}.`);
			const prevLocs = new Set((prev.locations ?? []).map(s => s.toLowerCase()));
			const newLocs = (last.locations ?? []).filter(l => !prevLocs.has(l.toLowerCase()));
			if (newLocs.length) out.push(`New setting: ${newLocs.slice(0, 4).join(', ')}.`);
		}
		out.push(`Re-establish pacing and refresh the setting through sensory detail. If time has passed, show it implicitly — do not narrate the gap.`);
		return out.join('\n');
	}

	// ── Section 7: Entry History preamble ───────────────────────────────────
	#sectionEntryHistoryPreamble(mode: string): string {
		if (mode !== 'adventure') {
			return `## Entry History\nPrior prose follows as conversation turns. Continue from the most recent turn.`;
		}
		return `## Entry History\nThe most recent exchanges follow as conversation turns. Each {{user}} turn is their next action; each assistant turn is your prior narration. Continue seamlessly from the latest turn — do not recap what just happened.`;
	}

	#sectionPlotLedger(snap: StateSnapshot): string {
		const lines: string[] = ['## Plot Ledger'];
		const significanceRank = { critical: 4, major: 3, moderate: 2, minor: 1 } as const;
		const statusRank = { imminent: 4, open: 3, stalled: 2, closed: 1, abandoned: 0 } as const;

		const activeThreads = snap.threads
			.filter(t => t.status !== 'closed' && t.status !== 'abandoned')
			.sort((a, b) =>
				(statusRank[b.status] ?? 0) - (statusRank[a.status] ?? 0) ||
				(significanceRank[b.significance] ?? 0) - (significanceRank[a.significance] ?? 0) ||
				b.updatedAt - a.updatedAt
			)
			.slice(0, 8);
		if (activeThreads.length > 0) {
			lines.push('', '### Open Threads');
			for (const t of activeThreads) {
				lines.push(`- [${t.status}/${t.significance}] ${compactMemoryText(t.description, 180)}`);
			}
		}

		const importantAgreements = snap.activeAgreements
			.filter(a => ['oath', 'debt', 'promise', 'alliance', 'marriage', 'vassalage', 'bargain-with-entity'].includes(a.category))
			.slice(0, 8);
		if (importantAgreements.length > 0) {
			lines.push('', '### Binding Obligations');
			for (const a of importantAgreements) {
				const secrecy = a.secrecy === 'public' ? '' : `/${a.secrecy}`;
				lines.push(`- [${a.category}${secrecy}] ${a.parties.join(' <-> ')}: ${compactMemoryText(a.terms, 170)}`);
			}
		}

		const urgentMoves = snap.factionActions
			.filter(fa => fa.status === 'active' && (fa.urgency === 'critical' || fa.urgency === 'high'))
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
			.slice(0, 4);
		if (urgentMoves.length > 0) {
			lines.push('', '### Due Pressure');
			for (const fa of urgentMoves) {
				const target = fa.target ? ` -> ${fa.target}` : '';
				lines.push(`- [${fa.urgency}] ${fa.factionName}${target}: ${compactMemoryText(fa.action, 160)}`);
			}
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	#sectionProceduralMemory(snap: StateSnapshot): string {
		const rules = snap.proceduralRules;
		if (!rules || rules.length === 0) return '';

		const lines: string[] = [
			'## Narrative Rules',
			'',
			'Learned patterns for this story. Apply them quietly; never explain them to the player.',
		];

		const ruleLimit = settings.uiSettings.proceduralMemoryLimit ?? rules.length;
		for (const rule of rules.slice(0, ruleLimit)) {
			const verb = rule.type === 'anti_pattern' ? 'AVOID' : 'APPLY';
			const tag = rule.maturity === 'proven' ? '' : `/${rule.maturity}`;
			lines.push(`- [${verb}${tag}] ${compactMemoryText(rule.content, 180)}`);
		}

		return lines.join('\n');
	}

	// ── Section 8: Living World ─────────────────────────────────────────────
	#sectionLivingWorld(snap: StateSnapshot): string {
		const out: string[] = [];

		// Active agreements — cap at 12 for budget
		const active = snap.activeAgreements;
		if (active.length > 0) {
			out.push('### Active Agreements');
			for (const a of active.slice(0, 12)) {
				const secrecyTag = a.secrecy === 'secret' ? ' [secret]' : a.secrecy === 'known' ? ' [known to some]' : '';
				const terms = a.terms.length > 140 ? a.terms.slice(0, 137) + '…' : a.terms;
				out.push(`- (${a.category}${secrecyTag}) [id:${a.id.slice(0, 8)}] ${a.parties.join(' ↔ ')}: ${terms}`);
			}
			if (active.length > 12) out.push(`  (+${active.length - 12} more active agreements)`);
		}

		// Rumors (reachable from current location)
		if (snap.reachableRumors.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Rumors & Whispers');
			out.push('Weave these as NPC dialogue, tavern gossip, overheard conversation.');
			for (const rumor of snap.reachableRumors) {
				const tag = rumor.truthfulness >= 0.7 ? 'reliable'
					: rumor.truthfulness >= 0.4 ? 'uncertain' : 'dubious';
				out.push(`- (${tag}, via ${rumor.sourceType}) ${rumor.content}`);
			}
		}

		// Faction actions — recent high-urgency
		const urgentFactions = snap.factionActions
			.filter(fa => fa.status === 'active' && (fa.urgency === 'critical' || fa.urgency === 'high'))
			.slice(0, 6);
		if (urgentFactions.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Faction Moves');
			for (const fa of urgentFactions) {
				const target = fa.target ? ` → ${fa.target}` : '';
				out.push(`- (${fa.urgency}) ${fa.factionName}${target}: ${fa.action}`);
			}
		}

		// Recent world events (consequence system)
		if (snap.recentWorldEvents.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Recent World Events');
			for (const event of snap.recentWorldEvents) {
				out.push(`- ${event.name}: ${event.description}`);
				const applied = event.consequences.filter(c => c.status === 'applied');
				for (const c of applied) out.push(`  → ${c.description}`);
			}
		}

		// World simulation signals (narrative, plot injection, tension, season, plot seeds)
		const ws = snap.worldSim;
		if (ws) {
			const wsLines: string[] = [];
			if (ws.worldNarrative) wsLines.push(`[WORLD STATE] ${ws.worldNarrative}`);
			if (ws.plotInjection) {
				const pi = ws.plotInjection;
				const urgencyLabel = pi.urgency === 'immediate' ? 'WEAVE THIS INTO THE NEXT RESPONSE'
					: pi.urgency === 'emerging' ? 'INTRODUCE THIS SOON'
					: 'SUBTLY HINT AT THIS';
				wsLines.push(`[DM PLOT INJECTION — ${urgencyLabel}]`);
				wsLines.push(pi.prose);
				if (pi.narratorDirective) wsLines.push(`[How: ${pi.narratorDirective}]`);
			}
			if (ws.worldTension >= 7) {
				wsLines.push(`[WORLD TENSION: HIGH (${ws.worldTension}/10) — unease, nervous NPCs, doubled guards]`);
			} else if (ws.worldTension >= 4) {
				wsLines.push(`[WORLD TENSION: MODERATE (${ws.worldTension}/10) — undercurrents of unrest, hushed talk]`);
			}
			if (ws.seasonEffect?.narrativeNote) wsLines.push(`[SEASON] ${ws.seasonEffect.narrativeNote}`);
			if (ws.plotSeeds && ws.plotSeeds.length > 0) {
				wsLines.push('[FACTION PLOT SEEDS — plant subtly, do not force]');
				for (const seed of ws.plotSeeds) wsLines.push(`- ${seed}`);
			}
			if (wsLines.length > 0) {
				if (out.length > 0) out.push('');
				out.push('### World Pulse');
				out.push(...wsLines);
			}
		}

		if (out.length === 0) return '';
		return ['## Living World', '', ...out].join('\n');
	}

	// ── Section 8b: Active Schemes (antagonist + player plans) ──────────────
	#sectionSchemes(): string {
		return injectSchemes(this.schemes);
	}

	// ── Section 8c: Plot Momentum (dynamic, generated by WorldSimulationService) ─
	#sectionPlotMomentum(): string {
		const pm = this.lastPlotMomentum;
		if (!pm) return '';

		const nb = pm.next_beat;
		if (!nb) return '';

		const lines: string[] = ['## Plot Momentum', ''];
		lines.push('Use this as slow-burn pressure, not permission to force a twist. Most turns should deepen existing tension instead of changing the whole board.');
		lines.push('');

		const recommendedKey = nb.next_turn_strategy.recommended_path;
		const recommended = nb.critical_path[recommendedKey];
		if (recommended) {
			const flags: string[] = [];
			if (recommended.friction) flags.push('friction');
			if (recommended.action) flags.push('action');
			if (recommended.twist_from_existing_secret) flags.push('twist-candidate');
			if (recommended.downgraded_to_friction) flags.push('downgraded');
			if (['earned_reward', 'loyalty_payoff', 'opportunity'].includes(recommended.type)) flags.push('payoff');
			const flagStr = flags.length > 0 ? ` [${flags.join(', ')}]` : '';
			lines.push('**Recommended Pressure Beat:**');
			lines.push(`- ${recommendedKey.toUpperCase()} (${recommended.type})${flagStr}: ${recommended.description}`);
		}
		lines.push(`- Rationale: ${nb.next_turn_strategy.rationale}`);
		lines.push('- Pacing: favor setup, consequence, doubt, delay, visible cost, and earned payoff. Do not land a major reveal unless the player action directly triggers a prepared payoff.');
		lines.push('- Social prior: do not turn every good offer into betrayal. If alliance, loyalty, or marriage has strong expected value for the NPC, let sincere agreement be a live option.');
		lines.push('');

		const twistSeed = nb.critical_path.path_d;
		if (twistSeed && recommendedKey !== 'path_d' && twistSeed.type !== 'none') {
			lines.push('**Withheld Twist Seed:**');
			lines.push(`- Keep off-page for now: ${twistSeed.description}`);
			lines.push('- Foreshadow only through rumor, evidence, hesitation, cost, or changed behavior.');
			lines.push('');
		}

		// Revelation Budget
		lines.push('**Revelation Budget:**');
		if (nb.revelation_budget.major_reveals_stewing.length > 0) {
			for (const r of nb.revelation_budget.major_reveals_stewing) {
				lines.push(`- Hold back: ${r}`);
			}
		} else {
			lines.push('- (none stewing)');
		}
		lines.push(`- Notes: ${nb.revelation_budget.notes}`);
		lines.push('');

		// Faction Advisory
		const factions = Object.entries(nb.faction_advisory);
		if (factions.length > 0) {
			lines.push('**Faction Advisory:**');
			for (const [slug, f] of factions) {
				lines.push(`- ${slug} [${f.disposition}]: ${f.likely_next_move}`);
				if (f.notes) lines.push(`  ${f.notes}`);
			}
			lines.push('');
		}

		// Thread Awareness
		lines.push('**Thread Awareness:**');
		if (nb.thread_awareness.existing_threads.length > 0) {
			for (const t of nb.thread_awareness.existing_threads) {
				lines.push(`- Existing: ${t}`);
			}
		}
		if (nb.thread_awareness.imminent_threads.length > 0) {
			for (const t of nb.thread_awareness.imminent_threads) {
				lines.push(`- Imminent: ${t}`);
			}
		}
		lines.push(`- Alignment: ${nb.thread_awareness.branch_alignment}`);
		lines.push('');

		return lines.join('\n');
	}

	// ── Section 9: Final Instructions ───────────────────────────────────────
	#sectionFinalInstructions(mode: string): string {
		if (mode !== 'adventure') {
			return `## Final Instructions\nContinue the prose from the most recent turn. Begin immediately, in the established voice. No preamble.`;
		}
		const lines: string[] = ['## Final Instructions', ''];

		// Plot momentum is generated by WorldSimulationService and injected above.
		lines.push('Plot momentum guidance is provided in the section above. Read it before planning your next beat.');
		lines.push('');

		// Final reminder — last thing the model reads before generating.
		// Recency wins. Keep this terse.
		lines.push('═══ FINAL REMINDER ═══');
		lines.push('');
		lines.push('Before you write a single word:');
		lines.push('');
		lines.push("1. NEVER act for {{user}}. The player owns their voice, choices, and thoughts.");
		lines.push('2. ADVANCE THE CLOCK in the header. Even a minute. Even a held breath.');
		lines.push('3. DEFAULT TO FRICTION. NPCs have their own agendas. "Yes" is the rare answer.');
		lines.push('4. CHECK NPC KNOWLEDGE. No one knows off-screen facts without a source, line of sight, message, evidence, inference, and time.');
		lines.push('5. WRITE PROSE ONLY — state is extracted from your text. Outcomes plain.');
		lines.push("6. STOP when {{user}} must choose. End on a sensory beat, an unanswered question, or a held silence.");
		lines.push('');
		lines.push('Now write the next turn of narration. Begin immediately, in-character, no preamble.');
		return lines.join('\n');
	}

	/**
	 * Build a structured state snapshot for the orchestrator path.
	 * Pre-fetches arcs, chapters, story beats, agreements, world events, rumors, and
	 * faction actions so buildSystemPrompt can populate the Characters / Arcs /
	 * Chapters / Living World sections without re-querying.
	 */
	async buildStateSnapshot(currentAction = ''): Promise<StateSnapshot> {
		let s = this.currentStory;
		if (!s) return emptySnapshot();
		if (s.serverStoryId) {
			await this.pullBackendProjection().catch((error) => {
				console.warn('[Story] backend projection refresh failed:', error);
			});
			s = this.currentStory;
			if (!s) return emptySnapshot();
		}

		let arcs: Arc[] = [];
		let chapters: Chapter[] = [];
		let storyBeats: StoryBeat[] = [];
		let threads: StoryThread[] = [];
		try { arcs = await getArcs(s.id); } catch { /* leave empty */ }
		try { chapters = await getChapters(s.id); } catch { /* leave empty */ }
		try { storyBeats = await getStoryBeats(s.id); } catch { /* leave empty */ }
		try { threads = await getStoryThreads(s.id); } catch { /* leave empty */ }

		const currentLocation = this.locations.find(l => l.current) ?? null;
		const presentCharacters = this.characters
			.filter(c => c.status === 'active' && c.relationship !== 'self')
			.slice(0, 6);
		const equippedItems = this.items.filter(i => i.equipped);

		const activeAgreements = this.agreements.filter(a => a.status === 'active');

		const recentWorldEvents = this.worldEvents
			.filter(e => e.appliedAt != null)
			.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
			.slice(0, 5);

		// Rumors reachable from the current location — continental/regional always,
		// local only if origin matches current location name.
		const ws = this.lastWorldSimResult;
		const currentLocName = (currentLocation?.name ?? '').toLowerCase();
		const reachableRumors = (ws?.rumors ?? []).filter(rumor => {
			if (rumor.spreadRadius === 'continental' || rumor.spreadRadius === 'regional') return true;
			if (rumor.spreadRadius === 'local') {
				const origin = rumor.originRegion.toLowerCase();
				return currentLocName.includes(origin) || origin.includes(currentLocName);
			}
			return false;
		});

		// Faction roster — score and pick the most narratively-relevant ones.
		// Always include factions with |playerStanding| >= 50; fill remaining slots
		// by score until cap of 6.
		const FACTION_CAP = 6;
		const currentChapter = chapters.length > 0 ? Math.max(...chapters.map(c => c.number ?? 0)) : 0;
		const factionActionNames = new Set(this.factionActions.map(fa => fa.factionName.toLowerCase()));
		const factionEntries = this.lorebookEntries.filter(e => e.type === 'faction' && !e.deleted);
		const scored = factionEntries.map(f => {
			const state = f.state as FactionEntryState | undefined;
			const standing = state?.playerStanding ?? 0;
			let score = Math.abs(standing);
			if (state?.lastActionChapter != null && currentChapter - state.lastActionChapter <= 3) score += 25;
			if (state?.status === 'allied' || state?.status === 'hostile') score += 15;
			if (factionActionNames.has(f.name.toLowerCase())) score += 20;
			return { faction: f, score, force: Math.abs(standing) >= 50 };
		});
		const forced = scored.filter(s => s.force);
		const others = scored.filter(s => !s.force).sort((a, b) => b.score - a.score);
		const relevantFactions = [...forced, ...others.slice(0, Math.max(0, FACTION_CAP - forced.length))]
			.sort((a, b) => b.score - a.score)
			.slice(0, FACTION_CAP)
			.map(s => s.faction);

		const currentActionText = currentAction.trim();
		let backendMemoryPacket: string | null = null;
		let backendMemoryIds: string[] = [];
		let backendMemoryDebug: string[] = [];
		if (s.serverStoryId && currentActionText) {
			try {
				const packet = await retrieveBackendMemory({
					storyId: s.serverStoryId,
					query: currentActionText,
					sceneEntityIds: [
						...presentCharacters.map(c => c.id),
						...relevantFactions.map(f => f.id),
					],
					locationId: currentLocation?.id ?? null,
					threadIds: threads.filter(t => t.status !== 'closed').map(t => t.id),
					currentFactionId: relevantFactions[0]?.id ?? null,
					presentNpcIds: presentCharacters.map(c => c.id),
					includeSecret: false,
					tokenBudget: settings.uiSettings.backendMemoryTokenBudget || 1100,
				});
				if (packet?.packet) {
					backendMemoryPacket = packet.packet;
					backendMemoryIds = packet.nodes.map(node => node.id);
					backendMemoryDebug = packet.retrievalDebug;
				}
			} catch (e) {
				console.warn('[Story] backend memory retrieval failed:', e);
			}
		}

		// Semantically retrieve lorebook entries relevant to the current action and recent narrative.
		// Without this the narrator is blind to anything outside the current scene's
		// characters/factions — locations, items, concepts, off-screen NPCs etc.
		// Embeddings are pre-warmed by preEmbedLorebook() at story load.
		let retrievedEntries: Entry[] = [];
		try {
			const { ai } = await import('$lib/services/ai');
			const candidateEntries = this.lorebookEntries.filter(e => !e.deleted);
			const loreLimit = settings.uiSettings.retrievedLoreEntryLimit ?? 8;
			if (!backendMemoryPacket && loreLimit > 0 && candidateEntries.length > 0) {
				const result = await ai.entryRetrieval.retrieve(candidateEntries, this.promptEntries, Math.max(loreLimit, 1), currentActionText);
				const factionIds = new Set(relevantFactions.map(f => f.id));
				// Build the "already rendered" name set: present NPCs + the protagonist,
				// since the protagonist is dumped in the Header/Roles + Characters sections
				// and re-injecting them here is pure duplication.
				const presentNames = new Set(presentCharacters.map(c => c.name.toLowerCase()));
				const protagonistName = this.protagonist?.name?.toLowerCase();
				if (protagonistName) presentNames.add(protagonistName);
				retrievedEntries = result.entries
					.filter(e => !factionIds.has(e.id))
					.filter(e => {
						if (e.type !== 'character') return true;
						if (presentNames.has(e.name.toLowerCase())) return false;
						return !(e.aliases ?? []).some(a => presentNames.has(a.toLowerCase()));
					})
					.slice(0, loreLimit);
			}
		} catch (e) {
			console.warn('[Story] entryRetrieval failed:', e);
		}

		const episodic = backendMemoryPacket
			? { chapters: [], reason: 'Backend memory packet supplied episodic context.' }
			: retrieveChaptersForAction(chapters, this.promptEntries, currentActionText, settings.uiSettings.retrievedChapterLimit ?? 3);
		const relevantConversationMemories = selectConversationMemories(
			this.conversationMemories,
			presentCharacters,
			currentActionText,
			settings.uiSettings.conversationMemoryLimit ?? 6,
		);

		let proceduralRules: ProceduralRule[] = [];
		const proceduralLimit = settings.uiSettings.proceduralMemoryLimit ?? 8;
		if (currentActionText && proceduralLimit > 0 && settings.getServiceConfig('proceduralMemory').enabled) {
			try {
				const { ai } = await import('$lib/services/ai');
				const recentNarrative = this.promptEntries.slice(-8).map(e => e.content).join('\n');
				proceduralRules = await ai.proceduralMemory.getRelevantRules(
					s.id,
					currentActionText,
					recentNarrative,
					proceduralLimit,
				);
			} catch (e) {
				console.warn('[Story] procedural memory retrieval failed:', e);
			}
		}

		return {
			arcs,
			chapters,
			storyBeats,
			currentLocation,
			presentCharacters,
			equippedItems,
			activeAgreements,
			recentWorldEvents,
			reachableRumors,
			factionActions: this.factionActions,
			relevantFactions,
			retrievedEntries,
			retrievedChapters: episodic.chapters,
			retrievedChapterReason: episodic.reason,
			proceduralRules,
			relevantConversationMemories,
			backendMemoryPacket,
			backendMemoryIds,
			backendMemoryDebug,
			worldSim: ws,
			threads,
		};
	}

	/**
	 * Orchestrator entry point — pre-fetched snapshot drives sections 4/5/6/8.
	 */
	buildOrchestratorSystemPrompt(stateSnapshot: StateSnapshot): string {
		return this.buildSystemPrompt(stateSnapshot);
	}

	/**
	 * Same content as `buildSystemPrompt` but split into two halves so the
	 * stable head can be sent with an Anthropic prompt-cache breakpoint:
	 *
	 *   stable  = Header + Instructions + Tools         (~80% of turns are identical)
	 *   dynamic = Characters + Arcs + Chapters + Entry-History + Living-World + Final-Instructions
	 *
	 * Final Instructions stays in the `dynamic` block to preserve the
	 * "narrator reads directives last" ordering. We give up caching on it,
	 * but caching the front 60-70% of the prompt is the big cost win anyway.
	 */
	buildOrchestratorSystemBlocks(
		snapshot: StateSnapshot,
		opts: { useInlineTools?: boolean } = {},
	): { stable: string; dynamic: string } {
		const s = this.currentStory;
		if (!s) return { stable: '', dynamic: '' };

		const mode = s.mode ?? 'adventure';

		const stableParts: string[] = [];
		stableParts.push(this.#sectionHeader(s, mode));
		stableParts.push(this.#sectionInstructions(s, mode));
		if (mode === 'adventure') stableParts.push(this.#sectionTools(opts.useInlineTools ?? false));

		let stable = stableParts.filter(Boolean).join('\n\n');
		let dynamic = this.#buildBudgetedDynamicPrompt(s, snapshot, mode);

		// Resolve role tags in both halves
		stable = this.#resolveRoleTags(stable, mode);
		dynamic = this.#resolveRoleTags(dynamic, mode);

		return { stable, dynamic };
	}

	/**
	 * Flatten a StateSnapshot into the terse "current world state" text block
	 * the post-stream classifier (executeWorldUpdate) expects. Format matches
	 * what buildStateSnapshot used to emit before it became structured, so the
	 * classifier's existing prompt keeps working unchanged.
	 */
	serializeSnapshotForClassifier(snap: StateSnapshot): string {
		const s = this.currentStory;
		if (!s) return '';
		const lines: string[] = ['## World State (current)', ''];

		if (snap.currentLocation) {
			const l = snap.currentLocation;
			lines.push(`Location: ${l.name}${l.description ? ' — ' + l.description : ''}`);
		}
		if (snap.presentCharacters.length > 0) {
			const charList = snap.presentCharacters.map(c => {
				let label = c.name;
				if (c.relationship) label += ` (${c.relationship})`;
				return label;
			}).join('; ');
			lines.push(`Characters present: ${charList}`);
		}
		const protag = this.protagonist;
		if (protag) {
			lines.push(`Protagonist: ${protag.name}${protag.description ? ' — ' + protag.description : ''}`);
		}
		if (s.playerReputation?.trim()) {
			lines.push(`Player reputation: ${compactMemoryText(s.playerReputation, 240)}`);
		}
		if (snap.equippedItems.length > 0) {
			lines.push(`Inventory: ${snap.equippedItems.map(i => i.name).join(', ')}`);
		}
		if (s.timeTracker) {
			const t = s.timeTracker;
			const pad = (n: number) => String(n).padStart(2, '0');
			lines.push(`Time: Day ${t.days}, ${pad(t.hours)}:${pad(t.minutes)}`);
		}
		if (s.meters && s.meters.length > 0) {
			lines.push(`Meters: ${s.meters.map(m => `${m.name}: ${m.value}/${m.max}${m.visible ? '' : ' [hidden from player]'}`).join('; ')}`);
		}
		if (snap.activeAgreements.length > 0) {
			lines.push('Active agreements:');
			for (const a of snap.activeAgreements.slice(0, 12)) {
				const secrecyTag = a.secrecy === 'secret' ? ' [secret]' : a.secrecy === 'known' ? ' [known to some]' : '';
				const terms = a.terms.length > 140 ? a.terms.slice(0, 137) + '…' : a.terms;
				lines.push(`- (${a.category}${secrecyTag}) [id:${a.id.slice(0, 8)}] ${a.parties.join(' ↔ ')}: ${terms}`);
			}
			if (snap.activeAgreements.length > 12) lines.push(`  (+${snap.activeAgreements.length - 12} more active agreements)`);
		}
		const recentBeats = snap.storyBeats.filter(b => b.status === 'active').slice(-2);
		if (recentBeats.length > 0) {
			lines.push(`Recent events: ${recentBeats.map(b => b.title).join('; ')}`);
		}

		const result = lines.join('\n');
		const snapshotCap = settings.uiSettings.snapshotTokenCap || 0;
		if (snapshotCap > 0) {
			const maxChars = snapshotCap * 4;
			if (result.length > maxChars) return result.slice(0, maxChars);
		}
		return result;
	}

	/**
	 * Build conversation history as alternating user/assistant messages.
	 * Groups consecutive same-type entries and maps:
	 *   user_action → user message
	 *   narration   → assistant message
	 * System entries are folded into the next user message as context.
	 */
	buildConversationMessages(systemPromptTokens?: number): ChatMessage[] {
		// Dynamic budget: fill whatever space remains after system prompt + output reserve.
		// When context tiers are sparse (early story), history expands to use the freed space.
		const model = settings.getServiceConfig('narrative').model || '';
		const contextWindow = getModelContextWindow(model);
		const RESERVED = 4096 + 1000; // output + user prompt
		const available = contextWindow - RESERVED;

		let TOKEN_BUDGET: number;
		if (systemPromptTokens != null && systemPromptTokens > 0) {
			// Fill remaining space after system prompt, but cap at 60% to prevent context rot
			TOKEN_BUDGET = Math.min(
				Math.max(available - systemPromptTokens, Math.floor(contextWindow * 0.20)),
				Math.floor(contextWindow * 0.60),
			);
		} else {
			// Fallback: estimate (40% tiers + ~1500 base instructions)
			const userBudget = settings.contextBudget;
			TOKEN_BUDGET = userBudget > 0
				? Math.floor(Math.min(userBudget, contextWindow - 4096) * 2 / 3)
				: Math.floor(contextWindow * 0.60);
		}

		const maxHistoryEntries = settings.uiSettings.maxHistoryEntries || 250;
		const sourceEntries = this.promptEntries.length > 0 ? this.promptEntries : this.entries.slice(-DEFAULT_PROMPT_ENTRY_WINDOW);
		const historyFloor = Math.max(this.chatHistoryFloor, sourceEntries.length - maxHistoryEntries);

		let tokensSoFar = 0;
		const floor = Math.max(0, historyFloor);
		let startIdx = sourceEntries.length;

		for (let i = sourceEntries.length - 1; i >= floor; i--) {
			const tokens = countTokens(sourceEntries[i].content);
			if (tokensSoFar + tokens > TOKEN_BUDGET) break;
			tokensSoFar += tokens;
			startIdx = i;
		}

		const recentEntries = sourceEntries.slice(startIdx);
		const messages: ChatMessage[] = [];
		let pendingSystem = '';

		for (const entry of recentEntries) {
			if (entry.type === 'user_action') {
				const content = pendingSystem
					? `${pendingSystem}\n\n${entry.content}`
					: entry.content;
				pendingSystem = '';

				// Merge consecutive user messages
				const last = messages[messages.length - 1];
				if (last?.role === 'user') {
					last.content += '\n\n' + content;
				} else {
					messages.push({ role: 'user', content });
				}
			} else if (entry.type === 'narration') {
				// Flush any pending system text as a user message first
				if (pendingSystem) {
					messages.push({ role: 'user', content: pendingSystem });
					pendingSystem = '';
				}
				// Merge consecutive assistant messages
				const last = messages[messages.length - 1];
				if (last?.role === 'assistant') {
					last.content += '\n\n' + entry.content;
				} else {
					messages.push({ role: 'assistant', content: entry.content });
				}
			} else {
				// system entries — buffer for next user message
				pendingSystem += (pendingSystem ? '\n' : '') + `[System: ${entry.content}]`;
			}
		}

		// Flush trailing system text
		if (pendingSystem) {
			const last = messages[messages.length - 1];
			if (last?.role === 'user') {
				last.content += '\n\n' + pendingSystem;
			} else {
				messages.push({ role: 'user', content: pendingSystem });
			}
		}

		const maxMessages = settings.uiSettings.maxMessages || 250;
		if (messages.length > maxMessages) {
			return messages.slice(-maxMessages);
		}

		return messages;
	}

	/**
	 * Build the final user prompt for the current action.
	 * Conversation history is now sent as separate messages via buildConversationMessages().
	 */
	buildUserPrompt(currentAction: string): string {
		if (this.storyMode === 'adventure') {
			return currentAction;
		}
		return currentAction + '\n\nContinue the narrative:';
	}

	/**
	 * Calculate context usage statistics.
	 * Accepts optional tier usage from the budgeted prompt/runtime context path.
	 */
	getContextStats(tierUsage?: Record<string, number>): { system: number; context: number; recentEntries: number; conversationHistory: number; total: number; tiers?: Record<string, number> } {
		const systemTokens = countTokens(this.buildSystemPrompt());

		const historyMessages = this.buildConversationMessages();
		const historyTokens = historyMessages.reduce((sum, m) => sum + countTokens(m.content), 0);

		const contextTokens = tierUsage
			? Object.values(tierUsage).reduce((a, b) => a + b, 0)
			: 0;

		return {
			system: systemTokens,
			context: contextTokens,
			recentEntries: 0, // now tracked as conversationHistory
			conversationHistory: historyTokens,
			total: systemTokens + contextTokens + historyTokens,
			tiers: tierUsage,
		};
	}

	async updateTitle(title: string) {
		if (!this.currentStory) return;
		await updateStory(this.currentStory.id, { title, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, title };
	}

	async updateHeaderPrompt(headerPrompt: string | null) {
		if (!this.currentStory) return;
		const value = headerPrompt?.trim() || null;
		await updateStory(this.currentStory.id, { headerPrompt: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, headerPrompt: value };
	}

	async updateDescription(description: string | null) {
		if (!this.currentStory) return;
		const value = description?.trim() || null;
		await updateStory(this.currentStory.id, { description: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, description: value };
	}

	async updatePlayerReputation(playerReputation: string | null) {
		if (!this.currentStory) return;
		const value = playerReputation?.trim() || null;
		await updateStory(this.currentStory.id, { playerReputation: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, playerReputation: value };
	}

	/**
	 * Apply a batch of meter changes from update_world_state.
	 * Creates meters on first reference using the model-provided `initial`
	 * (defaults to 0 — low-is-bad meters like hunger/fatigue/suspicion are the
	 * common case; sanity/health-style meters MUST set initial=max). Then
	 * applies the delta on top, clamped into [0, max].
	 */
	async applyMeterChanges(changes: Array<{ name: string; delta: number; initial?: number; max?: number; visible?: boolean }>) {
		if (!this.currentStory || changes.length === 0) return;
		const meters = [...(this.currentStory.meters ?? [])];

		for (const change of changes) {
			if (!change.name) continue;
			const idx = meters.findIndex(m => m.name.toLowerCase() === change.name.toLowerCase());
			if (idx === -1) {
				const max = change.max && change.max > 0 ? change.max : 100;
				const base = change.initial ?? 0;
				meters.push({
					name: change.name,
					value: Math.max(0, Math.min(max, base + change.delta)),
					max,
					visible: change.visible ?? true,
				});
			} else {
				const m = meters[idx];
				const max = change.max && change.max > 0 ? change.max : m.max;
				meters[idx] = {
					...m,
					value: Math.max(0, Math.min(max, m.value + change.delta)),
					max,
					visible: change.visible ?? m.visible,
				};
			}
		}

		await updateStory(this.currentStory.id, { meters, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, meters };
	}

	async setMeterVisibility(name: string, visible: boolean) {
		if (!this.currentStory?.meters) return;
		const meters = this.currentStory.meters.map(m =>
			m.name.toLowerCase() === name.toLowerCase() ? { ...m, visible } : m,
		);
		await updateStory(this.currentStory.id, { meters, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, meters };
	}

	/**
	 * Apply a batch of agreement changes from update_world_state.
	 *
	 * Actions:
	 *   create    — insert a new Agreement row with status=active
	 *   update    — revise terms / parties / secrecy on an existing row
	 *   break     — mark status=broken, set resolvedChapterNumber, emit a
	 *               WorldEvent of type alliance_broken so the timeline picks it up
	 *   fulfill   — mark status=fulfilled + resolvedChapterNumber
	 *   expire    — mark status=expired + resolvedChapterNumber
	 *
	 * Identification for non-create actions: by id if supplied; otherwise
	 * falls back to a parties+category match on active agreements.
	 */
	async applyAgreementChanges(
		changes: Array<{
			action: 'create' | 'update' | 'break' | 'fulfill' | 'expire';
			id?: string | null;
			parties?: string[];
			category?: AgreementCategory;
			terms?: string | null;
			secrecy?: AgreementSecrecy;
			consequences?: string[];
			reason?: string | null;
		}>,
		currentChapterNumber: number | null = null,
	) {
		if (!this.currentStory || changes.length === 0) return;
		const now = Date.now();

		for (const change of changes) {
			if (change.action === 'create') {
				if (!change.terms || !change.category || !change.parties?.length) continue;
				const agreement: Agreement = {
					id: uuid(),
					storyId: this.currentStory.id,
					parties: change.parties,
					category: change.category,
					terms: change.terms,
					status: 'active',
					secrecy: change.secrecy ?? 'public',
					createdChapterNumber: currentChapterNumber,
					resolvedChapterNumber: null,
					consequences: change.consequences ?? [],
					metadata: change.reason ? { reason: change.reason } : null,
					createdAt: now,
					updatedAt: now,
				};
				await createAgreement(agreement);
				this.agreements = [...this.agreements, agreement];
				continue;
			}

			// Non-create: locate the target agreement.
			const target = this.findAgreement(change.id ?? null, change.parties, change.category);
			if (!target) continue;

			const patch: Partial<Agreement> = { updatedAt: now };

			if (change.action === 'update') {
				if (change.terms != null) patch.terms = change.terms;
				if (change.secrecy) patch.secrecy = change.secrecy;
				if (change.parties?.length) patch.parties = change.parties;
				if (change.consequences?.length) {
					patch.consequences = [...target.consequences, ...change.consequences];
				}
			} else {
				// break / fulfill / expire all move status + set resolvedChapterNumber.
				const statusMap = { break: 'broken', fulfill: 'fulfilled', expire: 'expired' } as const;
				patch.status = statusMap[change.action];
				patch.resolvedChapterNumber = currentChapterNumber;
				if (change.consequences?.length) {
					patch.consequences = [...target.consequences, ...change.consequences];
				}
				// Broken agreements leave a trace in the timeline.
				if (change.action === 'break') {
					const lastEntry = this.promptEntries[this.promptEntries.length - 1]
						?? this.entries[this.entries.length - 1];
					if (lastEntry) {
						const ev: WorldEvent = {
							id: uuid(),
							storyId: this.currentStory.id,
							name: `${target.category} broken: ${target.parties.join(' & ')}`,
							description: change.reason ?? `The ${target.category} between ${target.parties.join(' and ')} was broken.`,
							triggerEntryId: lastEntry.id,
							triggerPosition: lastEntry.position,
							sourceEntityId: null,
							type: 'alliance_broken',
							severity: target.category === 'marriage' || target.category === 'treaty' ? 'major' : 'moderate',
							consequences: [],
							appliedAt: now,
							createdAt: now,
						};
						this.applyCanonicalVersion(await saveCanonicalWorldEvent(ev));
						this.worldEvents = [...this.worldEvents, ev];
					}
				}
			}

			await updateAgreement(target.id, patch);
			this.agreements = this.agreements.map((a) => (a.id === target.id ? { ...a, ...patch } : a));
		}
	}

	/** Locate an agreement by id, or by parties+category fallback. */
	private findAgreement(
		id: string | null,
		parties: string[] | undefined,
		category: AgreementCategory | undefined,
	): Agreement | null {
		if (id) return this.agreements.find((a) => a.id === id) ?? null;
		if (!parties?.length || !category) return null;
		const partySet = new Set(parties.map((p) => p.toLowerCase()));
		return (
			this.agreements.find(
				(a) =>
					a.status === 'active' &&
					a.category === category &&
					a.parties.length === parties.length &&
					a.parties.every((p) => partySet.has(p.toLowerCase())),
			) ?? null
		);
	}

	/** Save a generated image to the database and local state. */
	async addImage(image: Omit<EmbeddedImage, 'createdAt'>): Promise<void> {
		await createEmbeddedImage(image);
		this.images = [...this.images, { ...image, createdAt: Date.now() }];
	}

	/** Remove a persisted image. */
	async removeImage(id: string): Promise<void> {
		await deleteEmbeddedImage(id);
		this.images = this.images.filter(i => i.id !== id);
	}

	/** Get the persisted image for a specific entry, if any. */
	getImageForEntry(entryId: string): EmbeddedImage | undefined {
		return this.images.find(i => i.entryId === entryId && i.status === 'complete');
	}

	clear() {
		this._loadGeneration++;
		this.disconnectEngineStream();
		this.currentStory = null;
		this.entries = [];
		this.promptEntries = [];
		this.entryCount = 0;
		this.campaignProjection = null;
		this.engineStreamStatus = emptyEngineStreamStatus();
		this.oldestLoadedEntryPosition = null;
		this.loadingOlderEntries = false;
		this.hydratingWorld = false;
		this.worldHydrationError = null;
		this.characters = [];
		this.locations = [];
		this.items = [];
		this.lorebookEntries = [];
		this.entryRelationships = [];
		this.conversationMemories = [];
		this.worldEvents = [];
		this.agreements = [];
		this.factionActions = [];
		this.rumors = [];
		this.schemes = [];
		this.images = [];
		this.lastWorldSimResult = null;
		this.lastTierUsage = null;
		this.lastPromptSectionUsage = null;
		this.lastContextTotal = 0;
		this.lastTurnPerformance = null;
		this.chatHistoryFloor = 0;
	}
}

export const story = new StoryStore();
