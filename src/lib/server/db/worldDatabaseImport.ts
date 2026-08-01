import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	arcs,
	chapters,
	continuityWarnings,
	entities,
	entityAliases,
	factionGoals,
	factionMemberships,
	factionProjects,
	factionResources,
	factions,
	patchProposals,
	sourceRefs,
	memoryNodes,
	facts,
	npcBeliefs,
	npcEventLinks,
	relationships,
	sagas,
	statePatches,
	shelves,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
} from '$lib/server/db/schema';
import { enqueueImportProjectionJobs, enqueueStoryVaultSyncJob } from '$lib/server/jobs/outbox';
import { deleteStoryVaultArtifacts } from '$lib/server/wiki/storyVault';
import { memoryImportanceSchema, memoryNodeTypeSchema } from '$lib/contracts/memory';
import { worldDatabaseImportRequestSchema } from '$lib/contracts/worldDatabase';

type JsonRecord = Record<string, unknown>;

interface WorldDatabaseTables {
	story: JsonRecord;
	entries: JsonRecord[];
	entities: JsonRecord[];
	entityAliases: JsonRecord[];
	relationships: JsonRecord[];
	factions: JsonRecord[];
	factionMemberships: JsonRecord[];
	factionResources: JsonRecord[];
	factionGoals: JsonRecord[];
	factionProjects: JsonRecord[];
	npcBeliefs: JsonRecord[];
	agreements: JsonRecord[];
	threads: JsonRecord[];
	events: JsonRecord[];
	npcEventLinks: JsonRecord[];
	facts: JsonRecord[];
	sourceRefs: JsonRecord[];
	patchProposals: JsonRecord[];
	continuityWarnings: JsonRecord[];
	statePatches: JsonRecord[];
	memoryNodes: JsonRecord[];
	chapters: JsonRecord[];
	arcs: JsonRecord[];
	sagas: JsonRecord[];
}

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'world'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function asArray(value: unknown): JsonRecord[] {
	return Array.isArray(value) ? value.map(asRecord) : [];
}

function asString(value: unknown, fallback = ''): string {
	return typeof value === 'string' && value.length > 0 ? value : fallback;
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
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
}

function firstValue(row: JsonRecord, keys: string[]): unknown {
	for (const key of keys) {
		if (row[key] != null) return row[key];
	}
	return undefined;
}

function normalizeEnum(value: unknown, fallback: string, allowed: Set<string>, aliases: Record<string, string> = {}): string {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return fallback;
	const normalized = aliases[raw.toLowerCase()] ?? raw;
	return allowed.has(normalized) ? normalized : fallback;
}

const storyModes = new Set(['adventure', 'creative-writing']);
const storyModeAliases: Record<string, string> = {
	terminal_core_first: 'adventure',
	terminal: 'adventure',
	roleplay: 'adventure',
	rp: 'adventure',
};

const visibilityValues = new Set(['public', 'player_known', 'secret']);
const visibilityAliases: Record<string, string> = {
	gm: 'secret',
	gm_only: 'secret',
	hidden: 'secret',
	private: 'secret',
	confidential: 'secret',
	known: 'player_known',
	player: 'player_known',
	player_visible: 'player_known',
};

const eventStatusValues = new Set(['proposed', 'scheduled', 'due', 'committed', 'cancelled']);
const eventStatusAliases: Record<string, string> = {
	active: 'committed',
	done: 'committed',
	resolved: 'committed',
	merged: 'committed',
};

const patchStatusValues = new Set(['proposed', 'applied', 'rejected', 'needs_repair']);
const patchStatusAliases: Record<string, string> = {
	active: 'applied',
	committed: 'applied',
	merged: 'applied',
};

const continuityLevelValues = new Set(['info', 'warning', 'error']);
const continuityLevelAliases: Record<string, string> = {
	low: 'info',
	medium: 'warning',
	high: 'warning',
	critical: 'error',
};
const continuityStatusValues = new Set(['open', 'resolved', 'dismissed']);

function normalizeStoryMode(value: unknown): string {
	return normalizeEnum(value, 'adventure', storyModes, storyModeAliases);
}

function normalizeVisibility(value: unknown, fallback = 'player_known'): string {
	return normalizeEnum(value, fallback, visibilityValues, visibilityAliases);
}

function normalizeEventStatus(value: unknown): string {
	return normalizeEnum(value, 'committed', eventStatusValues, eventStatusAliases);
}

function normalizePatchStatus(value: unknown): string {
	return normalizeEnum(value, 'proposed', patchStatusValues, patchStatusAliases);
}

function normalizeContinuityLevel(value: unknown): string {
	return normalizeEnum(value, 'warning', continuityLevelValues, continuityLevelAliases);
}

function normalizeContinuityStatus(value: unknown): string {
	return normalizeEnum(value, 'open', continuityStatusValues);
}

function normalizeAlias(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function asJsonArray(value: unknown): Array<Record<string, unknown>> {
	return Array.isArray(value) ? value.map(asRecord) : [];
}

function cleanEmbedding(value: unknown): number[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const numbers = value.map(Number).filter((item) => Number.isFinite(item));
	return numbers.length > 0 ? numbers : undefined;
}

function sourceTables(rawBundle: JsonRecord): JsonRecord {
	const explicit = asRecord(rawBundle.worldDatabase);
	if (Object.keys(explicit).length > 0) return explicit;
	const compat = asRecord(rawBundle.backendCanon);
	if (Object.keys(compat).length > 0) return compat;
	return rawBundle;
}

function normalizeTables(rawBundle: JsonRecord): WorldDatabaseTables {
	const source = sourceTables(rawBundle);
	const story = asRecord(source.story);
	const storiesList = asArray(source.stories);
	const resolvedStory = Object.keys(story).length > 0 ? story : storiesList[0];
	if (!resolvedStory?.id && !resolvedStory?.title) {
		throw new Error('World database import requires a story row in worldDatabase.story.');
	}

	return {
		story: resolvedStory,
		entries: asArray(source.entries ?? source.storyEntries),
		entities: asArray(source.entities),
		entityAliases: asArray(source.entityAliases),
		relationships: asArray(source.relationships),
		factions: asArray(source.factions),
		factionMemberships: asArray(source.factionMemberships),
		factionResources: asArray(source.factionResources),
		factionGoals: asArray(source.factionGoals),
		factionProjects: asArray(source.factionProjects),
		npcBeliefs: asArray(source.npcBeliefs),
		agreements: asArray(source.agreements),
		threads: asArray(source.threads ?? source.storyThreads),
		events: asArray(source.events ?? source.storyEvents),
		npcEventLinks: asArray(source.npcEventLinks ?? source.npc_event_links),
		facts: asArray(source.facts),
		sourceRefs: asArray(source.sourceRefs),
		patchProposals: asArray(source.patchProposals),
		continuityWarnings: asArray(source.continuityWarnings),
		statePatches: asArray(source.statePatches),
		memoryNodes: asArray(source.memoryNodes),
		chapters: asArray(source.chapters),
		arcs: asArray(source.arcs),
		sagas: asArray(source.sagas),
	};
}

function remapTables(tables: WorldDatabaseTables): WorldDatabaseTables {
	const originalStoryId = asString(tables.story.id);
	const targetStoryId = id('story');
	const idMap = new Map<string, string>();
	if (originalStoryId) idMap.set(originalStoryId, targetStoryId);

	const mapId = (value: string): string => {
		const clean = value.trim();
		if (!clean) return value;
		const existing = idMap.get(clean);
		if (existing) return existing;
		const mapped = id('import');
		idMap.set(clean, mapped);
		return mapped;
	};

	const remap = (value: unknown, key = ''): unknown => {
		if (Array.isArray(value)) {
			if (isIdListKey(key)) return value.map((item) => typeof item === 'string' ? mapId(item) : remap(item, key));
			return value.map((item) => remap(item));
		}
		if (!value || typeof value !== 'object') return value;
		const output: JsonRecord = {};
		for (const [childKey, childValue] of Object.entries(value as JsonRecord)) {
			if (childKey === 'storyId') {
				output[childKey] = targetStoryId;
			} else if (childKey === 'clientStoryId') {
				output[childKey] = null;
			} else if (isIdListKey(childKey)) {
				output[childKey] = Array.isArray(childValue)
					? childValue.map((item) => typeof item === 'string' ? mapId(item) : remap(item, childKey))
					: childValue;
			} else if (isIdKey(childKey)) {
				output[childKey] = typeof childValue === 'string'
					? mapId(childValue)
					: childValue == null
						? null
						: remap(childValue, childKey);
			} else {
				output[childKey] = remap(childValue, childKey);
			}
		}
		return output;
	};

	return remap(tables) as WorldDatabaseTables;
}

function isIdKey(key: string): boolean {
	return key === 'id' || key.endsWith('Id');
}

function isIdListKey(key: string): boolean {
	return key.endsWith('Ids');
}

function storyValue(row: JsonRecord, importedAt: string): typeof stories.$inferInsert {
	return {
		id: asString(row.id, id('story')),
		shelfId: asString(row.shelfId, 'shelf_default'),
		clientStoryId: asNullableString(row.clientStoryId),
		title: asString(row.title, 'Imported World Database'),
		description: asNullableString(row.description),
		genre: asNullableString(row.genre),
		mode: normalizeStoryMode(row.mode),
		role: asString(row.role, 'playable'),
		timelineMode: asString(row.timelineMode, 'overlay'),
		settings: row.settings == null ? null : asRecord(row.settings),
		headerPrompt: asNullableString(row.headerPrompt),
		currentLocationId: asNullableString(row.currentLocationId),
		currentTurn: asNumber(row.currentTurn, 0),
		currentWorldTime: asNullableString(row.currentWorldTime),
		metadata: {
			...asRecord(row.metadata),
			importedFrom: 'terminal_world_database',
			importedAt,
		},
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: importedAt,
	};
}

function shelfValue(row: JsonRecord, importedAt: string, fallbackGenre: string | null): typeof shelves.$inferInsert {
	const name = asString(row.name, 'Default Shelf');
	return {
		id: asString(row.id, 'shelf_default'),
		name,
		slug: asString(row.slug, name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default_shelf'),
		description: asNullableString(row.description),
		genre: asNullableString(row.genre) ?? fallbackGenre,
		coverImageUrl: asNullableString(row.coverImageUrl),
		settings: asRecord(row.settings),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

async function resolveImportShelf(
	db: ReturnType<typeof getDb>,
	shelfRow: typeof shelves.$inferInsert,
): Promise<{ shelfId: string; insertShelfRow: typeof shelves.$inferInsert | null }> {
	const [byId] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.id, shelfRow.id)).limit(1);
	if (byId) return { shelfId: byId.id, insertShelfRow: null };
	const [bySlug] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.slug, shelfRow.slug)).limit(1);
	if (bySlug) return { shelfId: bySlug.id, insertShelfRow: null };
	return { shelfId: shelfRow.id, insertShelfRow: shelfRow };
}

function entryValue(row: JsonRecord, storyId: string, importedAt: string, index: number): typeof storyEntries.$inferInsert {
	return {
		id: asString(row.id, id('entry')),
		storyId,
		type: asString(row.type, 'system'),
		content: asString(row.content),
		position: asNumber(row.position, index),
		parentId: asNullableString(row.parentId),
		branchId: asNullableString(row.branchId),
		metadata: row.metadata == null ? null : asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function entityValue(row: JsonRecord, storyId: string, importedAt: string): typeof entities.$inferInsert {
	return {
		id: asString(row.id, id('entity')),
		storyId,
		type: asString(row.type, 'concept'),
		name: asString(row.name, 'Unnamed Entity'),
		description: asNullableString(row.description),
		status: asString(row.status, 'active'),
		visibility: normalizeVisibility(row.visibility),
		state: asRecord(row.state),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function aliasValue(row: JsonRecord, storyId: string, importedAt: string): typeof entityAliases.$inferInsert {
	const alias = asString(row.alias);
	return {
		id: asString(row.id, id('alias')),
		storyId,
		entityId: asString(row.entityId),
		alias,
		normalizedAlias: normalizeAlias(alias),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function relationshipValue(row: JsonRecord, storyId: string, importedAt: string): typeof relationships.$inferInsert {
	return {
		id: asString(row.id, id('rel')),
		storyId,
		sourceEntityId: asString(firstValue(row, ['sourceEntityId', 'subjectEntityId'])),
		targetEntityId: asString(firstValue(row, ['targetEntityId', 'objectEntityId'])),
		type: asString(row.type, 'related-to'),
		label: asNullableString(row.label),
		strength: asNumber(row.strength, 0.5),
		bidirectional: asBoolean(row.bidirectional),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function factionValue(row: JsonRecord, storyId: string, importedAt: string): typeof factions.$inferInsert {
	return {
		id: asString(row.id, id('faction')),
		storyId,
		entityId: asNullableString(row.entityId),
		name: asString(row.name, 'Unnamed Faction'),
		goals: asStringArray(row.goals),
		resources: asRecord(row.resources),
		memberEntityIds: asStringArray(row.memberEntityIds),
		territoryIds: asStringArray(row.territoryIds),
		allies: asStringArray(row.allies),
		enemies: asStringArray(row.enemies),
		pressure: asNumber(row.pressure, 0),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function membershipValue(row: JsonRecord, storyId: string, importedAt: string): typeof factionMemberships.$inferInsert {
	return {
		id: asString(row.id, id('membership')),
		storyId,
		factionId: asString(row.factionId),
		entityId: asNullableString(row.entityId),
		role: asString(row.role, 'member'),
		rank: asNullableString(row.rank),
		status: asString(row.status, 'active'),
		visibility: normalizeVisibility(row.visibility),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function resourceValue(row: JsonRecord, storyId: string, importedAt: string): typeof factionResources.$inferInsert {
	return {
		id: asString(row.id, id('resource')),
		storyId,
		factionId: asString(row.factionId),
		kind: asString(row.kind, 'resource'),
		name: asString(row.name, asString(row.kind, 'resource')),
		amount: typeof row.amount === 'number' ? row.amount : null,
		status: asString(row.status, 'available'),
		locationId: asNullableString(row.locationId),
		visibility: normalizeVisibility(row.visibility),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function goalValue(row: JsonRecord, storyId: string, importedAt: string): typeof factionGoals.$inferInsert {
	return {
		id: asString(row.id, id('goal')),
		storyId,
		factionId: asString(row.factionId),
		goal: asString(row.goal),
		status: asString(row.status, 'active'),
		priority: asNumber(row.priority, 5),
		secrecy: asString(row.secrecy, 'player_known'),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function projectValue(row: JsonRecord, storyId: string, importedAt: string): typeof factionProjects.$inferInsert {
	return {
		id: asString(row.id, id('project')),
		storyId,
		factionId: asString(row.factionId),
		project: asString(row.project, asString(row.name, 'Faction project')),
		status: asString(row.status, 'planned'),
		progress: asNumber(row.progress, 0),
		priority: asNumber(row.priority, 5),
		dueTurn: typeof row.dueTurn === 'number' ? Math.trunc(row.dueTurn) : null,
		worldTime: asNullableString(row.worldTime),
		costs: asRecord(row.costs),
		gains: asRecord(row.gains),
		risks: asStringArray(row.risks),
		visibility: normalizeVisibility(row.visibility),
		metadata: asRecord(row.metadata),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function beliefValue(row: JsonRecord, storyId: string, importedAt: string): typeof npcBeliefs.$inferInsert {
	return {
		id: asString(row.id, id('belief')),
		storyId,
		believerEntityId: asString(firstValue(row, ['believerEntityId', 'entityId', 'npcEntityId'])),
		subjectEntityId: asNullableString(row.subjectEntityId),
		belief: asString(row.belief),
		confidence: asNumber(row.confidence, 0.5),
		visibility: normalizeVisibility(row.visibility, 'secret'),
		evidenceEventIds: asStringArray(row.evidenceEventIds),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function agreementValue(row: JsonRecord, storyId: string, importedAt: string): typeof agreements.$inferInsert {
	return {
		id: asString(row.id, id('agreement')),
		storyId,
		parties: asStringArray(row.parties),
		category: asString(row.category, 'pact'),
		terms: asString(row.terms),
		status: asString(row.status, 'active'),
		secrecy: asString(row.secrecy, 'known'),
		consequences: asStringArray(row.consequences),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function threadValue(row: JsonRecord, storyId: string, importedAt: string): typeof storyThreads.$inferInsert {
	return {
		id: asString(row.id, id('thread')),
		storyId,
		description: asString(row.description),
		status: asString(row.status, 'open'),
		significance: asString(row.significance, 'moderate'),
		relatedFactionIds: asStringArray(row.relatedFactionIds),
		relatedEntityIds: asStringArray(row.relatedEntityIds),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		closedAt: asNullableString(row.closedAt),
		closureReason: asNullableString(row.closureReason),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function eventValue(row: JsonRecord, storyId: string, importedAt: string): typeof storyEvents.$inferInsert {
	const status = normalizeEventStatus(row.status);
	const createdTurn = asNumber(row.createdTurn, 0);
	const occurredTurn = typeof row.occurredTurn === 'number' && Number.isFinite(row.occurredTurn)
		? row.occurredTurn
		: status === 'committed'
			? createdTurn
			: null;
	const locationId = asNullableString(row.locationId);
	const importedLocationIds = asStringArray(row.locationIds);
	const locationIds = importedLocationIds.length > 0 ? importedLocationIds : locationId ? [locationId] : [];

	return {
		id: asString(row.id, id('event')),
		storyId,
		type: asString(row.type, 'imported_memory'),
		status,
		title: asString(row.title, 'Imported Event'),
		body: asString(row.body),
		actorEntityIds: asStringArray(row.actorEntityIds),
		targetEntityIds: asStringArray(row.targetEntityIds),
		locationId,
		locationIds,
		factionIds: asStringArray(row.factionIds),
		threadIds: asStringArray(row.threadIds),
		visibility: normalizeVisibility(row.visibility),
		createdTurn,
		occurredTurn,
		scheduledTurn: typeof row.scheduledTurn === 'number' && Number.isFinite(row.scheduledTurn) ? row.scheduledTurn : null,
		worldTime: asNullableString(row.worldTime),
		memoryImpact: asRecord(row.memoryImpact),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function npcEventLinkValue(row: JsonRecord, storyId: string, importedAt: string): typeof npcEventLinks.$inferInsert {
	return {
		id: asString(row.id, id('npc_event_link')),
		storyId,
		eventId: asString(row.eventId),
		npcEntityId: asString(firstValue(row, ['npcEntityId', 'entityId'])),
		role: asString(row.role, 'affected'),
		visibility: normalizeVisibility(row.visibility),
		evidenceStrength: asNumber(row.evidenceStrength, 0.75),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function patchValue(row: JsonRecord, storyId: string, importedAt: string): typeof statePatches.$inferInsert {
	return {
		id: asString(row.id, id('patch')),
		storyId,
		operations: asJsonArray(row.operations),
		reason: asString(row.reason),
		status: normalizePatchStatus(row.status),
		validationWarnings: asStringArray(row.validationWarnings),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function factValue(row: JsonRecord, storyId: string, importedAt: string): typeof facts.$inferInsert {
	return {
		id: asString(row.id, id('fact')),
		storyId,
		type: asString(row.type, 'observation'),
		subjectEntityId: asNullableString(row.subjectEntityId),
		targetEntityId: asNullableString(row.targetEntityId),
		title: asString(row.title, 'Imported Fact'),
		statement: asString(row.statement),
		confidence: asNumber(row.confidence, 1),
		status: asString(row.status, 'active'),
		visibility: normalizeVisibility(row.visibility),
		firstSeenEntryId: asNullableString(row.firstSeenEntryId),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function sourceRefValue(row: JsonRecord, storyId: string, importedAt: string): typeof sourceRefs.$inferInsert {
	return {
		id: asString(row.id, id('sourceref')),
		storyId,
		sourceType: asString(row.sourceType),
		sourceId: asString(row.sourceId),
		targetTable: asString(row.targetTable),
		targetRecordId: asString(row.targetRecordId),
		targetRecordField: asNullableString(row.targetRecordField),
		sourceField: asNullableString(row.sourceField),
		confidence: asNumber(row.confidence, 1),
		rationale: asNullableString(row.rationale),
		notes: asNullableString(row.notes),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function patchProposalValue(row: JsonRecord, storyId: string, importedAt: string): typeof patchProposals.$inferInsert {
	return {
		id: asString(row.id, id('proposal')),
		storyId,
		proposalType: asString(row.proposalType),
		targetTable: asString(row.targetTable),
		targetRecordId: asString(row.targetRecordId),
		proposedBy: asString(row.proposedBy, 'llm'),
		operations: asJsonArray(row.operations),
		reason: asString(row.reason),
		suggestion: asString(row.suggestion),
		status: asString(row.status, 'pending'),
		decision: asNullableString(row.decision),
		validatedBy: asNullableString(row.validatedBy),
		affectedEntityIds: asStringArray(row.affectedEntityIds),
		confidence: asNumber(row.confidence, 0.75),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function continuityWarningValue(row: JsonRecord, storyId: string, importedAt: string): typeof continuityWarnings.$inferInsert {
	return {
		id: asString(row.id, id('warning')),
		storyId,
		warningType: asString(row.warningType),
		level: normalizeContinuityLevel(row.level),
		title: asString(row.title, 'Imported continuity warning'),
		status: normalizeContinuityStatus(row.status),
		details: asString(row.details),
		entityIds: asStringArray(row.entityIds),
		factionIds: asStringArray(row.factionIds),
		threadIds: asStringArray(row.threadIds),
		actorIds: asStringArray(row.actorIds),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		resolutionNotes: asNullableString(row.resolutionNotes),
		resolvedBy: asNullableString(row.resolvedBy),
		resolvedAt: asNullableString(row.resolvedAt),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function memoryValue(row: JsonRecord, storyId: string, importedAt: string): typeof memoryNodes.$inferInsert {
	const importedType = asString(row.type, 'canonical');
	const type = memoryNodeTypeSchema.parse(importedType);
	const metadata = asRecord(row.metadata);
	return {
		id: asString(row.id, id('memory')),
		storyId,
		type,
		title: asString(row.title, 'Imported Memory'),
		content: asString(row.content),
		summary: asNullableString(row.summary),
		keywords: asStringArray(row.keywords),
		entityIds: asStringArray(row.entityIds),
		factionIds: asStringArray(row.factionIds),
		threadIds: asStringArray(row.threadIds),
		locationId: asNullableString(row.locationId),
		visibility: normalizeVisibility(row.visibility),
		importance: memoryImportanceSchema.parse(row.importance),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		embedding: cleanEmbedding(row.embedding),
		metadata: type === importedType
			? metadata
			: { ...metadata, normalizedMemoryTypeFrom: importedType },
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function chapterValue(row: JsonRecord, storyId: string, importedAt: string): typeof chapters.$inferInsert {
	return {
		id: asString(row.id, id('chapter')),
		storyId,
		number: asNumber(row.number, 1),
		title: asNullableString(row.title),
		sceneOutcome: asString(row.sceneOutcome),
		irreversibleChanges: asStringArray(row.irreversibleChanges),
		npcKnowledgeChanges: asJsonArray(row.npcKnowledgeChanges),
		promisesDebtsOaths: asStringArray(row.promisesDebtsOaths),
		discoveredClues: asStringArray(row.discoveredClues),
		relationshipChanges: asStringArray(row.relationshipChanges),
		factionChanges: asStringArray(row.factionChanges),
		openThreads: asStringArray(row.openThreads),
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function arcValue(row: JsonRecord, storyId: string, importedAt: string): typeof arcs.$inferInsert {
	return {
		id: asString(row.id, id('arc')),
		storyId,
		number: asNumber(row.number, 1),
		title: asString(row.title, 'Imported Arc'),
		summary: asString(row.summary),
		chapterIds: asStringArray(row.chapterIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		openThreadIds: asStringArray(row.openThreadIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function sagaValue(row: JsonRecord, storyId: string, importedAt: string): typeof sagas.$inferInsert {
	return {
		id: asString(row.id, id('saga')),
		storyId,
		number: asNumber(row.number ?? row.sagaNumber, 1),
		title: asString(row.title, 'Imported Saga'),
		summary: asString(row.summary),
		arcIds: asStringArray(row.arcIds),
		keyFactionShifts: asStringArray(row.keyFactionShifts),
		majorPowerChanges: asStringArray(row.majorPowerChanges),
		lingeringThreads: asStringArray(row.lingeringThreads),
		overallTone: asString(row.overallTone),
		sourceEventIds: asStringArray(row.sourceEventIds),
		openThreadIds: asStringArray(row.openThreadIds),
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

function increment(counts: Record<string, number>, key: string, amount: number): void {
	if (amount <= 0) return;
	counts[key] = (counts[key] ?? 0) + amount;
}

export async function importWorldDatabaseBundle(input: unknown) {
	const request = worldDatabaseImportRequestSchema.parse(input);
	const importedAt = nowIso();
	let tables = normalizeTables(request.bundle);
	if (!request.options.preserveIds) tables = remapTables(tables);
	const storyRow = storyValue(tables.story, importedAt);
	const storyId = storyRow.id;
	const bundleRecord = asRecord(request.bundle);
	const shelfSource = asRecord(bundleRecord.shelf);
	const shelfRow = Object.keys(shelfSource).length > 0
		? shelfValue(shelfSource, importedAt, storyRow.genre ?? null)
		: shelfValue({ id: storyRow.shelfId, name: storyRow.shelfId === 'shelf_default' ? 'Default Shelf' : 'Imported Shelf' }, importedAt, storyRow.genre ?? null);
	const counts: Record<string, number> = {};
	const db = getDb();
	const resolvedShelf = await resolveImportShelf(db, shelfRow);
	storyRow.shelfId = resolvedShelf.shelfId;

	const [existing] = await db.select({ id: stories.id }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (existing && !request.options.replaceExisting) {
		throw new Error(`World database ${storyId} already exists. Pass replaceExisting=true or import with preserveIds=false.`);
	}
	if (existing && request.options.replaceExisting) {
		await db.delete(stories).where(eq(stories.id, storyId));
		try {
			await deleteStoryVaultArtifacts(storyId);
		} catch (error) {
			console.warn('[WorldDatabaseImport] Failed to delete old generated wiki artifacts:', error);
		}
	}

	await db.transaction(async (tx) => {
		if (resolvedShelf.insertShelfRow) {
			await tx.insert(shelves).values(resolvedShelf.insertShelfRow).onConflictDoNothing();
			increment(counts, 'shelves', 1);
		}

		await tx.insert(stories).values(storyRow);
		increment(counts, 'stories', 1);

		for (const [index, row] of tables.entries.entries()) {
			await tx.insert(storyEntries).values(entryValue(row, storyId, importedAt, index)).onConflictDoNothing();
		}
		increment(counts, 'entries', tables.entries.length);

		for (const row of tables.entities) await tx.insert(entities).values(entityValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'entities', tables.entities.length);

		for (const row of tables.entityAliases) await tx.insert(entityAliases).values(aliasValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'entityAliases', tables.entityAliases.length);

		for (const row of tables.relationships) await tx.insert(relationships).values(relationshipValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'relationships', tables.relationships.length);

		for (const row of tables.factions) await tx.insert(factions).values(factionValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'factions', tables.factions.length);

		for (const row of tables.factionMemberships) await tx.insert(factionMemberships).values(membershipValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'factionMemberships', tables.factionMemberships.length);

		for (const row of tables.factionResources) await tx.insert(factionResources).values(resourceValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'factionResources', tables.factionResources.length);

		for (const row of tables.factionGoals) await tx.insert(factionGoals).values(goalValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'factionGoals', tables.factionGoals.length);

		for (const row of tables.factionProjects) await tx.insert(factionProjects).values(projectValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'factionProjects', tables.factionProjects.length);

		for (const row of tables.npcBeliefs) await tx.insert(npcBeliefs).values(beliefValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'npcBeliefs', tables.npcBeliefs.length);

		for (const row of tables.agreements) await tx.insert(agreements).values(agreementValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'agreements', tables.agreements.length);

		for (const row of tables.threads) await tx.insert(storyThreads).values(threadValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'threads', tables.threads.length);

		for (const row of tables.events) await tx.insert(storyEvents).values(eventValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'events', tables.events.length);

		for (const row of tables.npcEventLinks) await tx.insert(npcEventLinks).values(npcEventLinkValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'npcEventLinks', tables.npcEventLinks.length);

		for (const row of tables.statePatches) await tx.insert(statePatches).values(patchValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'statePatches', tables.statePatches.length);

		for (const row of tables.facts) await tx.insert(facts).values(factValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'facts', tables.facts.length);

		for (const row of tables.sourceRefs) await tx.insert(sourceRefs).values(sourceRefValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'sourceRefs', tables.sourceRefs.length);

		for (const row of tables.patchProposals) await tx.insert(patchProposals).values(patchProposalValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'patchProposals', tables.patchProposals.length);

		for (const row of tables.continuityWarnings) await tx.insert(continuityWarnings).values(continuityWarningValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'continuityWarnings', tables.continuityWarnings.length);

		for (const row of tables.memoryNodes) await tx.insert(memoryNodes).values(memoryValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'memoryNodes', tables.memoryNodes.length);

		for (const row of tables.chapters) await tx.insert(chapters).values(chapterValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'chapters', tables.chapters.length);

		for (const row of tables.arcs) await tx.insert(arcs).values(arcValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'arcs', tables.arcs.length);

		for (const row of tables.sagas) await tx.insert(sagas).values(sagaValue(row, storyId, importedAt)).onConflictDoNothing();
		increment(counts, 'sagas', tables.sagas.length);
	});

	const jobIds: string[] = [];
	if (request.options.syncWiki) {
		try {
			jobIds.push(...await enqueueImportProjectionJobs({
				storyId,
				counts,
				serverVersion: storyRow.serverVersion ?? 1,
			}));
		} catch (error) {
			console.warn('[WorldDatabaseImport] Failed to queue import projection jobs:', error);
			try {
				jobIds.push(await enqueueStoryVaultSyncJob({
					storyId,
					serverVersion: storyRow.serverVersion ?? 1,
					reason: 'world-database-import',
					payload: { counts },
				}));
			} catch {
				// best effort projection queue
			}
		}
	}

	return {
		ok: true as const,
		storyId,
		serverVersion: storyRow.serverVersion ?? 1,
		counts,
		jobIds,
		importedAt,
	};
}
