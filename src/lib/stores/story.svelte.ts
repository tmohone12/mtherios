/**
 * Story Store — Mtherios
 * Holds the selected story's projection: entries, characters, locations, items, lorebook.
 * Server-bound stories mirror the server; turns, extraction and summaries are server work.
 */

import { AGREEMENT_STATUSES as AGREEMENT_STATUS_VALUES } from '$lib/contracts/agreements';
import { readCampaignState } from '$lib/contracts/campaignState';
import { automaticCharacterUpdate } from '$lib/contracts/automaticCharacterUpdate';
import {
	getStory, countStoryEntries, getRecentStoryEntries, getStoryEntriesBeforePosition, getLastStoryEntryPosition, getCharacters, getLocations, getItems,
	getLorebookEntries, createStoryEntry, putStoryEntry, deleteStoryEntry, deleteStoryEntriesFromPosition,
	updateStory,
	putLorebookEntry, putCharacter, putLocation, putItem,
	getEntryRelationships, getConversationMemory, getWorldEvents,
	getChapters, getArcs, getSagas,
	getEmbeddedImagesForEntryIds, deleteEmbeddedImage,
	getAgreements, putAgreement,
	getFactionActions, getRumors, putConversationMemory, bulkPutFactionActions, bulkPutRumors, bulkPutSchemes,
	getSchemes,
	putChapter, putArc, putSaga, putWorldEvent, putStoryThread, deleteChapter, deleteArc, deleteSaga,
	getSyncOpsForStory, updateSyncOp, deleteSyncOp,
} from '$lib/services/database';
import {
	patchCanonicalLorebookEntry,
	saveCanonicalCharacter,
} from '$lib/services/canonicalWrites';
import { uuid } from '$lib/utils/uuid';
import type { PlayerSheet } from '$lib/utils/playerSheet';
import { playerCapabilitiesSchema, readPlayerCapabilities, type PlayerCapabilities } from '$lib/contracts/playerCapabilities';
import { readableMemorySummary } from '$lib/services/ai/context/mtheriosSummaryFormat';
import type { Story, StoryEntry, Character, Location, Item, Entry, EntryRelationship, ConversationMemoryEntry, WorldEvent, FactionEntryState, CharacterEntryState, LocationEntryState, ItemEntryState, EmbeddedImage, Agreement, FactionActionRecord, RumorRecord, Arc, Saga, Chapter, Scheme, StoryThread } from '$lib/types';
import { projectionReconciliationPlan } from './backendProjectionSync';
import { latestStoredContextReceipt } from '$lib/services/backendTurnContext';
import { importLocalStoryToBackend, pullBackendChanges, pushPendingBackendOps, queueBackendSyncOp } from '$lib/services/backendMemory';
import { openEngineEventStream, type EngineStreamEvent, type EngineStreamSubscription } from '$lib/services/engineStream';
import { cacheBackendStoryFromBootstrap, fetchBackendStoryBootstrap, fetchBackendStoryEntriesPage, fetchBackendStoryProjection, isRetryableEngineCommandFailure, resolveBackendStoryBootstrap } from '$lib/services/serverStories';
import type { BootstrapResponse, SyncChange, TurnContextReceipt, TurnPerformanceSummary, TurnResponse } from '$lib/contracts/memory';
import type { CampaignProjection } from '$lib/contracts/engine';
import {
	DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
	mergeControlSurfaceEntryWindow,
	mergePromptEntryWindow,
	removePromptEntriesById,
	removePromptEntriesFromPosition,
	sortPromptEntries,
} from './promptEntries';

const INITIAL_TRANSCRIPT_LOAD_LIMIT = 80;
const OLDER_TRANSCRIPT_PAGE_SIZE = 80;

interface EngineStreamStatus {
	connected: boolean;
	lastEventType: string | null;
	lastEventAt: string | null;
	error: string | null;
	refreshPending: boolean;
}

export interface GmActivityDisplay {
	stage: 'planning' | 'tool' | 'narrating';
	label: string;
	command: string | null;
	round: number;
}

type JsonRecord = Record<string, unknown>;

const ENTRY_TYPES = new Set(['character', 'location', 'item', 'faction', 'concept', 'event']);
const ENTRY_CREATORS = new Set(['user', 'ai', 'import', 'forge']);
const INJECTION_MODES = new Set(['always', 'keyword', 'never']);
const AGREEMENT_CATEGORIES = new Set(['treaty', 'pact', 'alliance', 'oath', 'debt', 'promise', 'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity']);
const AGREEMENT_STATUSES: ReadonlySet<string> = new Set(AGREEMENT_STATUS_VALUES);
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

function isMissingBackendStoryError(error: unknown): boolean {
	const message = errorMessage(error).toLowerCase();
	return message.includes('story not found') || message.includes('story could not be resolved');
}

function isTransientRuntimeEntry(entry: Pick<StoryEntry, 'type' | 'content'>): boolean {
	const content = entry.content.trim();
	return entry.type === 'system'
		&& (content.startsWith('Terminal agent runtime required:') || content.startsWith('Terminal turn failed:'));
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

class StoryStore {
	currentStory = $state<Story | null>(null);
	entries = $state<StoryEntry[]>([]);
	promptEntries = $state<StoryEntry[]>([]);
	entryCount = $state(0);
	campaignProjection = $state<CampaignProjection | null>(null);
	engineStreamStatus = $state<EngineStreamStatus>(emptyEngineStreamStatus());
	gmActivities = $state<GmActivityDisplay[]>([]);
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
	lastTurnPerformance = $state<TurnPerformanceSummary | null>(null);
	lastContextReceipt = $state<TurnContextReceipt | null>(null);

	// ── Derived ──
	get storyMode() { return this.currentStory?.mode ?? 'adventure'; }
	get pov() { return this.currentStory?.settings?.pov ?? 'first'; }
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
			if (this._loadGeneration !== generation) return;
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
					const bootstrap = await resolveBackendStoryBootstrap(s);
					const cachedStory = await cacheBackendStoryFromBootstrap(bootstrap, s.id);
					if (this._loadGeneration !== generation) return;
					await this.applyBackendBootstrap(cachedStory, bootstrap, generation);
					return;
				} catch (error) {
					if (this._loadGeneration !== generation) return;
					if (!isMissingBackendStoryError(error)) {
						if (isRetryableEngineCommandFailure(error)) {
							console.warn('[Story] terminal runtime unavailable; refusing cached story fallback:', error);
							await this.applyTerminalRuntimeUnavailable(s, generation, error);
						} else {
							console.warn('[Story] terminal story payload could not be loaded; refusing cached story fallback:', error);
							await this.applyTerminalStoryLoadFailure(s, generation, error);
						}
						return;
					}
					console.warn('[Story] terminal database binding missing; loading local story without stale backend id:', error);
					s = { ...s, serverStoryId: null, syncStatus: 'local-only' };
					await updateStory(storyId, { serverStoryId: null, syncStatus: 'local-only', updatedAt: Date.now() }).catch(() => undefined);
				}
			}

			if (this._loadGeneration !== generation) return;
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
	}

	private async applyTerminalStoryLoadFailure(story: Story, generation: number, error: unknown): Promise<void> {
		const storyId = story.id;
		this.currentStory = { ...story, syncStatus: 'conflict' };
		this.resetLoadedCollections();
		const validationFailure = error instanceof Error && error.name === 'ZodError';
		this.worldHydrationError = validationFailure
			? 'Story data failed validation. Repair or re-import the rejected database record.'
			: `Terminal story load failed. ${error instanceof Error ? error.message : String(error)}`;
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			error: this.worldHydrationError,
		};
		this.hydratingWorld = false;
		await updateStory(storyId, { syncStatus: 'conflict', updatedAt: Date.now() }).catch(() => undefined);
		if (!this.isCurrentLoad(storyId, generation)) return;
	}

	private resetLoadedCollections(): void {
		this.entries = [];
		this.promptEntries = [];
		this.entryCount = 0;
		this.campaignProjection = null;
		this.engineStreamStatus = emptyEngineStreamStatus();
		this.gmActivities = [];
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
		this.lastTurnPerformance = null;
		this.lastContextReceipt = null;
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
			this.lastContextReceipt = latestStoredContextReceipt(this.entries, serverStoryId);
			this.entryCount = Math.max(bootstrap.projection?.counts.entries ?? bootstrap.entryCount, this.entries.length);
			this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;

			const storyRow = asRecord(bootstrap.story);
			const currentLocationId = asNullableString(storyRow.currentLocationId);
			const entityRows = (bootstrap.projection?.entities?.length ? bootstrap.projection.entities : bootstrap.entities).map(asRecord);
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

			const localArcs = bootstrap.arcs
				.map((row) => this.serverArcToLocal(asRecord(row)))
				.filter((arc): arc is Arc => Boolean(arc));

			const localSagas = bootstrap.sagas
				.map((row) => this.serverSagaToLocal(asRecord(row)))
				.filter((saga): saga is Saga => Boolean(saga));
			// Bootstrap is the first visible projection after a reload. Reconcile it,
			// rather than only adding rows, so stale browser summaries cannot remain
			// visible after the terminal database rebuilds them for the GM.
			const [storedChapters, storedArcs, storedSagas] = await Promise.all([
				getChapters(localStory.id),
				getArcs(localStory.id),
				getSagas(localStory.id),
			]);
			const chapterPlan = projectionReconciliationPlan(
				storedChapters,
				localChapters,
				bootstrap.projection?.counts.chapters ?? localChapters.length,
			);
			const arcPlan = projectionReconciliationPlan(
				storedArcs,
				localArcs,
				bootstrap.projection?.counts.arcs ?? localArcs.length,
			);
			const sagaPlan = projectionReconciliationPlan(
				storedSagas,
				localSagas,
				bootstrap.projection?.counts.sagas ?? localSagas.length,
			);
			await Promise.all([
				...chapterPlan.deleteIds.map((id) => deleteChapter(id)),
				...arcPlan.deleteIds.map((id) => deleteArc(id)),
				...sagaPlan.deleteIds.map((id) => deleteSaga(id)),
				...chapterPlan.upserts.map((chapter) => putChapter(chapter)),
				...arcPlan.upserts.map((arc) => putArc(arc)),
				...sagaPlan.upserts.map((saga) => putSaga(saga)),
			]);

			await updateStory(localStory.id, {
				serverStoryId,
				serverVersion: bootstrap.serverVersion,
				syncStatus: 'synced',
			});
			if (!this.isCurrentLoad(localStory.id, generation)) return;

			this.loadImagesForEntries(localStory.id, entries.map((entry) => entry.id), generation)
				.catch(e => console.warn('[Story] visible image load failed:', e));
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
		this.lastContextReceipt = latestStoredContextReceipt(this.entries, this.currentStory.serverStoryId) ?? this.lastContextReceipt;
		this.oldestLoadedEntryPosition = this.entries[0]?.position ?? null;
		const storyRow = asRecord(projection.story);
		const currentLocationId = asNullableString(storyRow.currentLocationId);
		const entityRows = projection.entities.map(asRecord);
		if (entityRows.length > 0) {
			const projectedLoreEntries = entityRows
				.map((row) => this.serverEntityToLorebookEntry(row))
				.filter((entry): entry is Entry => Boolean(entry));
			const projectedCharacters = entityRows
				.map((row) => this.serverEntityToCharacter(row))
				.filter((character): character is Character => Boolean(character));
			const projectedLocations = entityRows
				.map((row) => this.serverEntityToLocation(row, currentLocationId))
				.filter((location): location is Location => Boolean(location));
			const projectedItems = entityRows
				.map((row) => this.serverEntityToItem(row))
				.filter((item): item is Item => Boolean(item));
			await Promise.all([
				...projectedLoreEntries.map((entry) => putLorebookEntry(entry)),
				...projectedCharacters.map((character) => putCharacter(character)),
				...projectedLocations.map((location) => putLocation(location)),
				...projectedItems.map((item) => putItem(item)),
			]);
			for (const entry of projectedLoreEntries) this.upsertProjectedLoreEntry(entry);
			for (const character of projectedCharacters) this.upsertProjectedCharacter(character.id, character);
			for (const location of projectedLocations) this.upsertProjectedLocation(location);
			for (const item of projectedItems) this.upsertProjectedItem(item);
		}
		const chapters = projection.chapters
			.map((row) => this.serverChapterToLocal(row))
			.filter((chapter): chapter is Chapter => Boolean(chapter));
		const arcs = projection.arcs
			.map((row) => this.serverArcToLocal(row))
			.filter((arc): arc is Arc => Boolean(arc));
		const sagas = projection.sagas
			.map((row) => this.serverSagaToLocal(row))
			.filter((saga): saga is Saga => Boolean(saga));
		const [localChapters, localArcs, localSagas] = await Promise.all([
			getChapters(this.currentStory.id),
			getArcs(this.currentStory.id),
			getSagas(this.currentStory.id),
		]);
		const chapterPlan = projectionReconciliationPlan(localChapters, chapters, projection.counts.chapters);
		const arcPlan = projectionReconciliationPlan(localArcs, arcs, projection.counts.arcs);
		const sagaPlan = projectionReconciliationPlan(localSagas, sagas, projection.counts.sagas);
		await Promise.all([
			...chapterPlan.deleteIds.map((id) => deleteChapter(id)),
			...arcPlan.deleteIds.map((id) => deleteArc(id)),
			...sagaPlan.deleteIds.map((id) => deleteSaga(id)),
			...chapterPlan.upserts.map((chapter) => putChapter(chapter)),
			...arcPlan.upserts.map((arc) => putArc(arc)),
			...sagaPlan.upserts.map((saga) => putSaga(saga)),
		]);
		const serverVersion = asNumber(projection.story.serverVersion, this.currentStory.serverVersion ?? 1);
		const projectedMetadata = asRecord(storyRow.metadata);
		const projectedSettings = storyRow.settings == null
			? null
			: asRecord(storyRow.settings) as Story['settings'];
		this.currentStory = {
			...this.currentStory,
			shelfId: asNullableString(storyRow.shelfId) ?? this.currentStory.shelfId,
			title: asString(storyRow.title, this.currentStory.title),
			description: asNullableString(storyRow.description),
			genre: asNullableString(storyRow.genre),
			mode: storyRow.mode === 'creative-writing' ? 'creative-writing' : 'adventure',
			settings: projectedSettings,
			headerPrompt: asNullableString(storyRow.headerPrompt),
			campaignState: readCampaignState(projectedMetadata),
			playerReputation: typeof projectedMetadata.playerReputation === 'string'
				? projectedMetadata.playerReputation
				: this.currentStory.playerReputation,
			updatedAt: asTime(storyRow.updatedAt, this.currentStory.updatedAt),
			serverVersion,
			syncStatus: 'synced',
		};
		this.worldHydrationError = null;
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			error: null,
		};
		await updateStory(this.currentStory.id, {
			shelfId: this.currentStory.shelfId,
			title: this.currentStory.title,
			description: this.currentStory.description,
			genre: this.currentStory.genre,
			mode: this.currentStory.mode,
			settings: this.currentStory.settings,
			headerPrompt: this.currentStory.headerPrompt,
			playerReputation: this.currentStory.playerReputation,
			campaignState: this.currentStory.campaignState,
			updatedAt: this.currentStory.updatedAt,
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

	/** Add newly published chapter IDs without reconciling or overwriting any local
	 * editor/outbox state, world projection, existing summary or sync cursor. */
	async refreshNewChapters(): Promise<void> {
		const current=this.currentStory;
		if(!current?.serverStoryId)return;
		const projection=await fetchBackendStoryProjection(current.serverStoryId,INITIAL_TRANSCRIPT_LOAD_LIMIT);
		if(this.currentStory?.id!==current.id)return;
		const localIds=new Set((await getChapters(current.id)).map(c=>c.id));
		for(const row of projection.chapters) {
			if(this.currentStory?.id!==current.id)return;
			const chapter=this.serverChapterToLocal(row);
			if(chapter&&!localIds.has(chapter.id))await putChapter(chapter);
		}
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
				onTurnContextReceipt: (receipt) => {
					if (!this.isCurrentLoad(localStoryId, generation)) return;
					this.lastContextReceipt = receipt;
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
		this.gmActivities = [];
	}

	private recordEngineStreamEvent(event: EngineStreamEvent, localStoryId: string, generation: number): void {
		if (!this.isCurrentLoad(localStoryId, generation)) return;
		if (event.type === 'gm.activity') {
			const stage = asString(event.data.stage);
			const label = asString(event.data.label);
			if ((stage === 'planning' || stage === 'tool' || stage === 'narrating') && label) {
				const normalizedStage: GmActivityDisplay['stage'] = stage;
				this.gmActivities = [...this.gmActivities, {
					stage: normalizedStage,
					label,
					command: asNullableString(event.data.command),
					round: Math.max(1, Math.trunc(asNumber(event.data.round, 1))),
				}].slice(-8);
			}
		}
		this.engineStreamStatus = {
			...this.engineStreamStatus,
			connected: event.type !== 'engine.error',
			lastEventType: event.type,
			lastEventAt: event.createdAt || new Date().toISOString(),
			error: event.type === 'engine.error' ? asString(event.data.error, 'Backend engine stream error.') : this.engineStreamStatus.error,
		};
	}

	beginGmActivity(): void {
		this.gmActivities = [{
			stage: 'planning',
			label: 'Preparing the turn context',
			command: null,
			round: 1,
		}];
	}

	clearGmActivity(): void {
		this.gmActivities = [];
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
			metadata,
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
		const relationshipStatus = asNullableString(state.relationship) ?? asNullableString(relationship.status);
		const rowMetadata = { ...asRecord(asRecord(row.metadata).originalMetadata), ...asRecord(row.metadata) };
		const isPlayer = ['self', 'player_character'].includes(relationshipStatus ?? '')
			|| state.isProtagonist === true || rowMetadata.isProtagonist === true || rowMetadata.playerCharacter === true;
		const metadata = {
			...asRecord(asRecord(row.metadata).originalMetadata),
			...asRecord(row.metadata),
			canonicalVisibility: asString(row.visibility),
			...(typeof state.present === 'boolean' ? { present: state.present } : {}),
			...(typeof state.isPresent === 'boolean' ? { isPresent: state.isPresent } : {}),
			...(typeof state.currentLocation === 'string' ? { currentLocation: state.currentLocation } : {}),
			...(typeof state.lastSeenLocation === 'string' ? { lastSeenLocation: state.lastSeenLocation } : {}),
			...(typeof state.location === 'string' ? { location: state.location } : {}),
			...(typeof state.playerPrompt === 'string' ? { playerPrompt: state.playerPrompt } : {}),
			...(Array.isArray(state.assets) ? { assets: state.assets } : {}),
			...(state.playerSheet && typeof state.playerSheet === 'object' && !Array.isArray(state.playerSheet) ? { playerSheet: state.playerSheet } : {}),
			...(Object.prototype.hasOwnProperty.call(state, 'playerCapabilities') ? { playerCapabilities: readPlayerCapabilities(state.playerCapabilities) } : {}),
			...(Array.isArray(state.aliases) ? { aliases: state.aliases } : {}),
			...(typeof state.partyMember === 'boolean' ? { partyMember: state.partyMember } : {}),
			...(Object.prototype.hasOwnProperty.call(state, 'partyRole') ? { partyRole: asNullableString(state.partyRole) } : {}),
			...(typeof state.currentDisposition === 'string' ? { currentDisposition: state.currentDisposition } : {}),
			...(typeof state.appearance === 'string' ? { appearance: state.appearance } : {}),
			...(typeof state.voice === 'string' ? { voice: state.voice } : {}),
			...(typeof state.personality === 'string' ? { personality: state.personality } : {}),
			...(typeof state.rank === 'string' ? { rank: state.rank } : {}),
			...(typeof state.role === 'string' ? { role: state.role } : {}),
			...(typeof state.visibilityNote === 'string' ? { visibilityNote: state.visibilityNote } : {}),
			...(typeof state.factionName === 'string' ? { factionName: state.factionName } : {}),
			...(typeof state.affinity === 'number' ? { affinity: state.affinity } : {}),
			...(Array.isArray(state.factionTags) ? { factionTags: state.factionTags } : {}),
			...(Array.isArray(state.motivations) ? { motivations: state.motivations } : {}),
			...(Array.isArray(state.knownFacts) ? { knownFacts: state.knownFacts } : {}),
			...(Array.isArray(state.pressures) ? { pressures: state.pressures } : {}),
			...(Array.isArray(state.mannerisms) ? { mannerisms: state.mannerisms } : {}),
		};
		return {
			id,
			storyId: this.currentStory.id,
			name,
			description: asNullableString(row.description),
			relationship: isPlayer ? 'self' : asNullableString(state.relationship) ?? asNullableString(state.currentDisposition) ?? asNullableString(relationship.status),
			traits: asStringArray(state.traits),
			visualDescriptors: asRecord(state.visualDescriptors) as Character['visualDescriptors'],
			portrait: asNullableString(state.portrait),
			status: entityStatus(row.status),
			metadata,
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
		const current = currentLocationId ? currentLocationId === id : asBoolean(state.isCurrentLocation ?? state.current);
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
		const statusValue = asString(row.status, 'active');
		if (!AGREEMENT_STATUSES.has(statusValue)) return null;
		const status = statusValue as Agreement['status'];
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
			sourceEntryIds,
			summary: readableMemorySummary(asString(row.sceneOutcome, asString(row.summary))),
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
		const startChapterNumber = asNumber(metadata.startChapterNumber, 0);
		const endChapterNumber = asNumber(metadata.endChapterNumber, 0);
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
			chapterRange: startChapterNumber > 0 && endChapterNumber >= startChapterNumber
				? `${startChapterNumber}-${endChapterNumber}`
				: asString(metadata.legacyRange),
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
			const urgencyValue = asString(metadata.urgency);
			const urgency: FactionActionRecord['urgency'] = ['low', 'medium', 'high', 'critical'].includes(urgencyValue)
				? urgencyValue as FactionActionRecord['urgency']
				: this.pressureUrgency(pressure);
			return {
				id,
				storyId: this.currentStory?.id ?? asString(row.storyId),
				factionName: this.memoryNodeFactionName(row, metadata),
				action: asString(metadata.action) || asString(row.content) || asString(row.summary) || asString(row.title),
				actionType: asString(metadata.actionType) || 'world_tick',
				target: asString(metadata.target) || null,
				motivation: asString(metadata.motivation) || `World tick at pressure ${Math.max(0, Math.min(100, pressure))}/100`,
				consequences: asStringArray(metadata.consequences).length > 0
					? asStringArray(metadata.consequences)
					: asStringArray(row.sourceEventIds).map((eventId) => `Canonical event ${eventId}`).slice(0, 1),
				urgency,
				affectedRegions: asStringArray(metadata.affectedRegions),
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
		if (asString(row.visibility) === 'secret') return null;
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

	async addEntry(type: StoryEntry['type'], content: string, reasoning?: string, expectedStoryId?: string): Promise<StoryEntry> {
		if (!this.currentStory) throw new Error('No story loaded');
		const current = this.currentStory;
		if (expectedStoryId && current.id !== expectedStoryId) throw new DOMException('Story changed before entry creation.', 'AbortError');

		// Serialize entry creation to prevent position collision from concurrent calls
		const previous = this._entryLock;
		let releaseLock!: () => void;
		this._entryLock = new Promise(r => { releaseLock = r; });
		await previous;

		try {
			if (this.currentStory?.id !== current.id) throw new DOMException('Story changed before entry creation.', 'AbortError');
			const loadedEntries = [...this.entries];
			const lastLoadedPosition = loadedEntries.reduce((max, e) => Math.max(max, e.position), -1);
			const lastPersistedPosition = lastLoadedPosition >= 0
				? lastLoadedPosition
				: await getLastStoryEntryPosition(current.id, current.currentBranchId ?? null);
			const entry: StoryEntry = {
				id: uuid(),
				storyId: current.id,
				type,
				content,
				parentId: null,
				position: lastPersistedPosition + 1,
				createdAt: Date.now(),
				metadata: null,
				branchId: current.currentBranchId ?? null,
				reasoning,
			};
			await createStoryEntry(entry);
			await updateStory(current.id, { updatedAt: Date.now() });
			if (this.currentStory?.id !== current.id) return entry;
			this.entries = current.serverStoryId
				? mergeControlSurfaceEntryWindow(this.entries, [entry], {
					limit: DEFAULT_CONTROL_SURFACE_ENTRY_WINDOW,
					anchor: 'newest',
				})
				: [...this.entries, entry];
			this.promptEntries = mergePromptEntryWindow(this.promptEntries, [entry]);
			this.entryCount = Math.max(this.entryCount + 1, this.entries.length);
			if (current.serverStoryId) {
				try {
					await queueBackendSyncOp(current, 'create_entry', { entry });
					const sync = await pushPendingBackendOps(current);
					if (sync && this.currentStory?.id === current.id) {
						await this.applyBackendSyncChanges(sync.changes);
						this.currentStory = {
							...this.currentStory,
							serverVersion: sync.serverVersion,
							syncStatus: sync.syncStatus,
						};
					}
				} catch (e) {
					console.warn('[Story] backend entry sync failed:', e);
					if (this.currentStory?.id === current.id) this.currentStory = { ...this.currentStory, syncStatus: 'offline' };
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
		const entry: StoryEntry = {
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
		if (isTransientRuntimeEntry(entry)) return null;
		return entry;
	}

	async mirrorBackendEntries(rows: Array<Record<string, unknown>>): Promise<StoryEntry[]> {
		if (!this.currentStory || rows.length === 0) return [];
		const entries = rows
			.map((row) => this.serverEntryToLocal(row))
			.filter((entry): entry is StoryEntry => Boolean(entry));
		if (entries.length === 0) return [];

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
		for (const entry of entries) await putStoryEntry(entry);
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
			if (['entities', 'story_events', 'memory_nodes'].includes(change.table) && asString(row.visibility) === 'secret') continue;
			if (change.table === 'agreements' && asString(row.secrecy) === 'secret') continue;
			if (change.table === 'story_events' && asString(row.status, 'committed') !== 'committed') continue;

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

	/** Bind the open browser-only save through the existing import, then load the server copy. */
	async importCurrentStoryToServer(): Promise<{ serverStoryId: string; serverVersion: number; counts: Record<string, number> }> {
		const current = this.currentStory;
		if (!current) throw new Error('No story loaded');
		const bound = current.serverStoryId?.trim();
		if (bound) return { serverStoryId: bound, serverVersion: current.serverVersion ?? 0, counts: {} };
		const result = await importLocalStoryToBackend(current.id);
		if (this.currentStory?.id === current.id) await this.loadStory(current.id);
		return result;
	}

	async prepareBackendAgentTurn(): Promise<Story> {
		if (!this.currentStory?.serverStoryId) throw new Error('Story is not bound to the terminal world database.');
		const current = this.currentStory;
		const flushed = await this.flushBackendOutbox(current);
		if (!flushed || !this.currentStory || this.currentStory.id !== current.id) {
			throw new Error('Pending backend commands could not be synced before this turn.');
		}
		if (this.currentStory.syncStatus === 'conflict') {
			throw new Error('Resolve backend sync conflicts before submitting another backend turn.');
		}
		return this.currentStory;
	}

	async applyBackendTurnResponse(response: TurnResponse, submittedStoryId: string): Promise<TurnResponse> {
		if (!this.currentStory || this.currentStory.id !== submittedStoryId) return response;
		const current = this.currentStory;
		try {
			await this.mirrorBackendEntries(response.entries);
			await this.applyBackendSyncChanges(response.syncChanges);
			this.lastTurnPerformance = response.performance;
			this.lastContextReceipt = response.contextReceipt;
			this.currentStory = {
				...this.currentStory,
				serverVersion: Math.max(response.serverVersion, this.currentStory.serverVersion ?? 0),
				syncStatus: 'synced',
			};
			await updateStory(this.currentStory.id, {
				serverVersion: Math.max(response.serverVersion, this.currentStory.serverVersion ?? 0),
				syncStatus: this.currentStory.syncStatus,
				updatedAt: Date.now(),
			});
			return response;
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn('[Story] backend turn succeeded but local hydration failed; refreshing projection:', error);
			this.lastTurnPerformance = response.performance;
			this.lastContextReceipt = response.contextReceipt;
			if (this.currentStory?.id === current.id) {
				this.currentStory = {
					...this.currentStory,
					serverVersion: Math.max(response.serverVersion, this.currentStory.serverVersion ?? 0),
					syncStatus: 'syncing',
				};
				queueMicrotask(() => void this.pullBackendProjection());
			}
			return {
				...response,
				warnings: [...response.warnings, `Local turn view will refresh from the backend: ${detail}`],
			};
		}
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

	private upsertProjectedCharacter(previousId: string, character: Character): void {
		const replaced = this.characters.some((existing) => existing.id === previousId || existing.id === character.id);
		this.characters = replaced
			? this.characters.map((existing) => (existing.id === previousId || existing.id === character.id) ? character : existing)
			: [...this.characters, character];
	}

	private upsertProjectedLocation(location: Location): void {
		this.locations = this.locations.some((existing) => existing.id === location.id)
			? this.locations.map((existing) => existing.id === location.id ? location : existing)
			: [...this.locations, location];
	}

	private upsertProjectedItem(item: Item): void {
		this.items = this.items.some((existing) => existing.id === item.id)
			? this.items.map((existing) => existing.id === item.id ? item : existing)
			: [...this.items, item];
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
		this.upsertProjectedCharacter(char.id, result.character);
		return result.character;
	}

	async createCharacter(input: {
		name: string;
		bio?: string | null;
		appearance?: string | null;
		personality?: string | null;
		rank?: string | null;
		currentDisposition?: string | null;
		affinity?: number | null;
		motivations?: string[];
		factionTags?: string[];
		knownFacts?: string[];
	}): Promise<Character> {
		if (!this.currentStory) throw new Error('No story loaded');
		const name = input.name.trim();
		if (!name) throw new Error('Name is required.');
		const bio = input.bio?.trim() || null;
		const disposition = input.currentDisposition?.trim() || 'neutral';
		const metadata = {
			bio,
			appearance: input.appearance?.trim() || null,
			personality: input.personality?.trim() || null,
			rank: input.rank?.trim() || null,
			currentDisposition: disposition,
			affinity: typeof input.affinity === 'number' ? input.affinity : 0,
			motivations: input.motivations ?? [],
			factionTags: input.factionTags ?? [],
			knownFacts: input.knownFacts ?? [],
			createdFrom: 'world_drawer_character_tab',
		};
		const char: Character = {
			id: uuid(),
			storyId: this.currentStory.id,
			branchId: this.currentStory.currentBranchId ?? null,
			name,
			description: bio,
			traits: [],
			relationship: disposition,
			status: 'active',
			metadata,
			visualDescriptors: input.appearance?.trim() ? { distinguishing: input.appearance.trim() } : {},
			portrait: null,
		};
		const result = await saveCanonicalCharacter(char, 'create');
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.upsertProjectedCharacter(char.id, result.character);
		return result.character;
	}

	async updateCharacterParty(id: string, updates: { member?: boolean; role?: string | null; portrait?: string | null }): Promise<void> {
		const char = this.characters.find(c => c.id === id);
		if (!char) return;
		const metadata = { ...(char.metadata ?? {}) };
		if (typeof updates.member === 'boolean') metadata.partyMember = updates.member;
		if (updates.role !== undefined) metadata.partyRole = updates.role?.trim() || null;
		const portrait = Object.prototype.hasOwnProperty.call(updates, 'portrait') ? updates.portrait?.trim() || null : char.portrait;
		const updated = { ...char, metadata, portrait };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.upsertProjectedCharacter(char.id, result.character);
	}

	async updateCharacterDetails(id: string, updates: Partial<Pick<Character, 'name' | 'description' | 'traits' | 'status' | 'relationship'>> & {
		appearance?: string | null;
		voice?: string | null;
		factionTags?: string[];
	}): Promise<void> {
		const char = this.characters.find(c => c.id === id);
		if (!char) return;
		const clean: Partial<Character> = {};
		const metadata = { ...(char.metadata ?? {}) };
		let metadataChanged = false;
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
		if (updates.relationship !== undefined) {
			const relationship = updates.relationship?.trim() || null;
			if (relationship !== char.relationship) clean.relationship = relationship;
			if (metadata.currentDisposition !== relationship) {
				metadata.currentDisposition = relationship;
				metadataChanged = true;
			}
		}
		for (const field of ['appearance', 'voice'] as const) {
			if (updates[field] === undefined) continue;
			const value = updates[field]?.trim() || null;
			if (metadata[field] !== value) {
				metadata[field] = value;
				metadataChanged = true;
			}
		}
		if (updates.factionTags !== undefined) {
			const factionTags = [...new Set(updates.factionTags.map(tag => tag.trim()).filter(Boolean))];
			const existingTags = Array.isArray(metadata.factionTags)
				? metadata.factionTags.filter((tag): tag is string => typeof tag === 'string')
				: [];
			if (factionTags.join('|') !== existingTags.join('|')) {
				metadata.factionTags = factionTags;
				metadataChanged = true;
			}
		}
		if (Object.keys(clean).length === 0 && !metadataChanged) return;

		const updated = { ...char, ...clean, ...(metadataChanged ? { metadata } : {}) };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.upsertProjectedCharacter(char.id, result.character);

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

	async saveProtagonist(updates: { name: string; description?: string | null; traits?: string[]; assets?: string[]; prompt?: string | null; playerSheet?: PlayerSheet; playerCapabilities?: PlayerCapabilities }): Promise<void> {
		const name = updates.name.trim();
		if (!this.currentStory || !name) return;
		const playerCapabilities = updates.playerCapabilities === undefined ? undefined : playerCapabilitiesSchema.parse(updates.playerCapabilities);
		const existing = this.protagonist;
		if (!existing) {
			const char = await this.addCharacter(name, updates.description ?? undefined, 'self');
			if (updates.traits?.length) {
				await this.updateCharacterDetails(char.id, { traits: updates.traits });
			}
			if (updates.assets !== undefined || updates.prompt !== undefined || updates.playerSheet !== undefined || playerCapabilities !== undefined) {
				const current = this.characters.find(c => c.id === char.id) ?? char;
				const metadata = {
					...(current.metadata ?? {}),
					...(updates.assets !== undefined ? { assets: updates.assets } : {}),
					...(updates.prompt !== undefined ? { playerPrompt: updates.prompt } : {}),
					...(updates.playerSheet !== undefined ? { playerSheet: updates.playerSheet } : {}),
					...(playerCapabilities !== undefined ? { playerCapabilities } : {}),
				};
				const updated = { ...current, metadata };
				const result = await saveCanonicalCharacter(updated);
				this.applyCanonicalVersion(result.serverVersion);
				this.upsertProjectedLoreEntry(result.entry);
				this.upsertProjectedCharacter(char.id, result.character);
			}
			return;
		}
		await this.updateCharacterDetails(existing.id, {
			name,
			...(updates.description !== undefined ? { description: updates.description } : {}),
			traits: updates.traits ?? existing.traits,
		});
		if (updates.assets !== undefined || updates.prompt !== undefined || updates.playerSheet !== undefined || playerCapabilities !== undefined) {
			const current = this.characters.find(c => c.id === existing.id) ?? existing;
			const originalMetadata = asRecord(current.metadata?.originalMetadata);
			const metadata = {
				...originalMetadata,
				...(current.metadata ?? {}),
				...(updates.assets !== undefined ? { assets: updates.assets } : {}),
				...(updates.prompt !== undefined ? { playerPrompt: updates.prompt } : {}),
				...(updates.playerSheet !== undefined ? { playerSheet: updates.playerSheet } : {}),
				...(playerCapabilities !== undefined ? { playerCapabilities } : {}),
			};
			const updated = { ...current, metadata };
			const result = await saveCanonicalCharacter(updated);
			this.applyCanonicalVersion(result.serverVersion);
			this.upsertProjectedLoreEntry(result.entry);
			this.upsertProjectedCharacter(existing.id, result.character);
		}
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
		const matches = this.lorebookEntries.filter(e => {
			if (e.type !== 'character') return false;
			if (e.name?.toLowerCase() === needle) return true;
			return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
		});
		const target = matches.length === 1 ? matches[0] : undefined;
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
			const result = await patchCanonicalLorebookEntry(target.id, { state: newState, metadata: { ...target.metadata, automaticCharacterUpdate: automaticCharacterUpdate(oldState as unknown as Record<string, unknown>, newState as unknown as Record<string, unknown>, this.entries.at(-1)?.id ? [this.entries.at(-1)!.id] : []) }, updatedAt: now });
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

	async clearPresence(characterId: string) {
		const char = this.characters.find(c => c.id === characterId);
		if (!char) return;
		const meta = { ...(char.metadata ?? {}) };
		delete meta.lastSeenLocation;
		const updated = { ...char, metadata: meta };
		const result = await saveCanonicalCharacter(updated);
		this.applyCanonicalVersion(result.serverVersion);
		this.upsertProjectedLoreEntry(result.entry);
		this.upsertProjectedCharacter(characterId, result.character);
		await this.syncLorebookPresence(char.name, false, null);
	}

	async updateStoryDetails(details: { title: string; headerPrompt: string; description: string }) {
		const current = this.currentStory;
		if (!current) return;
		const updates = {
			title: details.title.trim() || current.title,
			headerPrompt: details.headerPrompt.trim() || null,
			description: details.description.trim() || null,
		};
		await this.patchBackendStoryRecord(updates, 'Manual story controls update.');
		await updateStory(current.id, { ...updates, updatedAt: Date.now() });
		if (this.currentStory?.id === current.id) this.currentStory = { ...this.currentStory, ...updates };
	}

	async updatePlayerReputation(playerReputation: string | null) {
		if (!this.currentStory) return;
		const value = playerReputation?.trim() || null;
		await updateStory(this.currentStory.id, { playerReputation: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, playerReputation: value };
		const metadata = { playerReputation: value, playerReputationUpdatedBy: 'manual_edit', playerReputationUpdatedAt: new Date().toISOString() };
		await this.patchBackendStoryRecord({ metadata }, 'Manual protagonist reputation update.');
	}

	private async patchBackendStoryRecord(updates: Record<string, unknown>, reason: string): Promise<void> {
		const current = this.currentStory;
		const storyId = current?.serverStoryId;
		if (!current || !storyId) return;
		const normalizedUpdates = { ...updates };
		if (updates.metadata && typeof updates.metadata === 'object' && !Array.isArray(updates.metadata)) {
			const currentRecord = await fetch(`/api/records/stories/${encodeURIComponent(storyId)}`);
			const currentBody = await currentRecord.json().catch(() => ({}));
			if (currentRecord.ok) {
				const record = currentBody?.record && typeof currentBody.record === 'object' ? currentBody.record as Record<string, unknown> : {};
				const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
					? record.metadata as Record<string, unknown>
					: {};
				normalizedUpdates.metadata = { ...metadata, ...(updates.metadata as Record<string, unknown>) };
			}
		}
		const response = await fetch(`/api/records/stories/${encodeURIComponent(storyId)}`, {
			method: 'PATCH',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ updates: normalizedUpdates, reason }),
		});
		const body = await response.json().catch(() => ({}));
		if (!response.ok) {
			const message = typeof body.error === 'string' ? body.error : `Terminal story patch failed: ${response.status}`;
			if (this.currentStory?.id === current.id) this.currentStory = { ...this.currentStory, syncStatus: 'offline' };
			await updateStory(current.id, { syncStatus: 'offline' });
			throw new Error(message);
		}
		const serverVersion = typeof body.serverVersion === 'number' ? body.serverVersion : null;
		if (serverVersion && this.currentStory?.id === current.id) {
			this.currentStory = { ...this.currentStory, serverVersion, syncStatus: 'synced' };
			await updateStory(current.id, { serverVersion, syncStatus: 'synced' });
		}
	}

	/** Remove a persisted image. */
	async removeImage(id: string): Promise<void> {
		await deleteEmbeddedImage(id);
		this.images = this.images.filter(i => i.id !== id);
	}

	/** Get the persisted image for a specific entry, if any. */
	getImageForEntry(entryId: string): EmbeddedImage | undefined {
		return this.images
			.filter(image => image.entryId === entryId && image.status === 'complete')
			.sort((a, b) => b.createdAt - a.createdAt)[0];
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
		this.gmActivities = [];
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
		this.lastTurnPerformance = null;
		this.lastContextReceipt = null;
	}
}

export const story = new StoryStore();
