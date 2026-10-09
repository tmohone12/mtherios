import { importCanonicalWorkspace } from '$lib/server/engine/canonicalContent';
import { importContentSnapshot, previewContentImportConflicts } from '$lib/server/engine/content';
import { importStoryImageCards } from '$lib/server/engine/storyImageCards';
import { remapPortraitAssetUrls } from '$lib/server/engine/portraitAssetPortability';
import { importImageAsset } from '$lib/server/engine/imageAssets';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	arcs,
	chapters,
	continuityWarnings,
	entities,
	locationMaps,
	locationMapRevisions,
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
import { locationMapAssetExportSchema, TERMINAL_WORLD_DATABASE_SCHEMA_VERSION, worldDatabaseImportRequestSchema } from '$lib/contracts/worldDatabase';
import { locationMapBodySchema, type LocationMapBody } from '$lib/contracts/locationMap';
import { agentSettingsDocumentSchema } from '$lib/contracts/agentTools';
import { projectImageStyleSchema } from '$lib/contracts/imageStyle';
import { remapImportedRecordIds } from './importIds';
import { locationKindSchema, locationLoreSchema } from '$lib/contracts/locationLore';
import { isEffectiveContainment } from '$lib/server/memory/locationLore';
import { validateLocationParent } from '$lib/server/engine/locationRecords';

type JsonRecord = Record<string, unknown>;

interface WorldDatabaseTables {
	canonicalContent: JsonRecord[];
	story: JsonRecord;
	entries: JsonRecord[];
	entities: JsonRecord[];
	locationMaps: JsonRecord[];
	locationMapRevisions: JsonRecord[];
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
		locationMaps: asArray(source.locationMaps),
		locationMapRevisions: asArray(source.locationMapRevisions),
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
		canonicalContent: asArray(source.canonicalContent),
	};
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
	const settings = asRecord(row.settings);
	const portableSettings: JsonRecord = {};
	if (settings.agentTools !== undefined) portableSettings.agentTools = agentSettingsDocumentSchema.parse(settings.agentTools);
	if (settings.imageStyle !== undefined) portableSettings.imageStyle = projectImageStyleSchema.parse(settings.imageStyle);
	return {
		id: asString(row.id, 'shelf_default'),
		name,
		slug: asString(row.slug, name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'default_shelf'),
		description: asNullableString(row.description),
		genre: asNullableString(row.genre) ?? fallbackGenre,
		coverImageUrl: asNullableString(row.coverImageUrl),
		settings: portableSettings,
		metadata: asRecord(row.metadata),
		serverVersion: asNumber(row.serverVersion, 1),
		createdAt: asString(row.createdAt, importedAt),
		updatedAt: asString(row.updatedAt, importedAt),
	};
}

async function resolveImportShelf(
	db: ReturnType<typeof getDb>,
	shelfRow: typeof shelves.$inferInsert,
	options: { preserveIds: boolean; sourceProjectId?: string; destinationProjectId?: string },
	storySourceProjectId: string,
): Promise<{ shelfId: string; insertShelfRow: typeof shelves.$inferInsert | null }> {
	if (options.destinationProjectId) {
		if (!options.sourceProjectId || options.sourceProjectId !== shelfRow.id || options.sourceProjectId !== storySourceProjectId)
			throw new Error('Project merge requires the explicit source project ID from this bundle.');
		const [destination] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.id, options.destinationProjectId)).limit(1);
		if (!destination) throw new Error('Selected destination project was not found.');
		return { shelfId: destination.id, insertShelfRow: null };
	}
	if (options.sourceProjectId) throw new Error('A source project ID requires a selected destination project.');
	const [byId] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.id, shelfRow.id)).limit(1);
	if (byId && options.preserveIds) throw new Error('Project ID already exists. Select it explicitly as the destination to merge, or import with preserveIds=false.');
	const [bySlug] = await db.select({ id: shelves.id }).from(shelves).where(eq(shelves.slug, shelfRow.slug)).limit(1);
	const shelfId = options.preserveIds ? shelfRow.id : id('shelf');
	const slug = !options.preserveIds || bySlug ? `${shelfRow.slug.slice(0, 120)}_import_${globalThis.crypto.randomUUID().slice(0, 8)}` : shelfRow.slug;
	return { shelfId, insertShelfRow: { ...shelfRow, id: shelfId, slug } };
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

function assertUniqueEntryPositions(rows: JsonRecord[]): void {
	const firstIndexByPosition = new Map<number, number>();
	for (const [index, row] of rows.entries()) {
		const position = asNumber(row.position, index);
		const firstIndex = firstIndexByPosition.get(position);
		if (firstIndex != null) {
			throw new Error(
				`World database import contains duplicate story entry position ${position} `
				+ `(entries ${firstIndex} and ${index}). Repair the export before importing it.`,
			);
		}
		firstIndexByPosition.set(position, index);
	}
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
		: row.occurredTurn !== null && status === 'committed'
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

export function validateImportedLocationLore(tables: Pick<WorldDatabaseTables, 'entities' | 'relationships' | 'facts'>, storyId: string, turn: number): void {
	const places = tables.entities.map(row => ({ id: asString(row.id), storyId, type: asString(row.type), status: asString(row.status, 'active') }));
	const locations = new Set(places.filter(place => place.type === 'location').map(place => place.id));
	for (const row of tables.entities) {
		if (row.type === 'location' && asRecord(row.state).locationKind !== undefined) locationKindSchema.parse(asRecord(row.state).locationKind);
	}
	const edges = tables.relationships.map(row => ({ id: asString(row.id), storyId,
		sourceEntityId: asString(firstValue(row, ['sourceEntityId', 'subjectEntityId'])), targetEntityId: asString(firstValue(row, ['targetEntityId', 'objectEntityId'])),
		type: asString(row.type), bidirectional: asBoolean(row.bidirectional), metadata: asRecord(row.metadata) }));
	const physical = edges.filter(edge => edge.type === 'part-of' && (locations.has(edge.sourceEntityId) || locations.has(edge.targetEntityId)));
	if (physical.some(edge => edge.bidirectional)) throw new Error('Imported physical containment must be directional.');
	const active = physical.filter(edge => isEffectiveContainment(edge, turn));
	for (const edge of active) {
		if (active.filter(other => other.sourceEntityId === edge.sourceEntityId).length !== 1) throw new Error('Imported location has multiple active physical parents.');
		validateLocationParent({ storyId, childId: edge.sourceEntityId, parentId: edge.targetEntityId, turn, places, relationships: physical });
	}
	for (const row of tables.facts) {
		const metadata = asRecord(row.metadata);
		if (metadata.locationLore === undefined) continue;
		const lore = locationLoreSchema.parse(metadata.locationLore);
		if (!locations.has(asString(row.subjectEntityId))) throw new Error('Imported location lore must be owned by a location.');
		for (const key of ['validFromTurn', 'validToTurn']) if (metadata[key] != null && (!Number.isInteger(metadata[key]) || Number(metadata[key]) < 0)) throw new Error(`Invalid location lore ${key}.`);
		if (metadata.validFromTurn != null && metadata.validToTurn != null && Number(metadata.validToTurn) < Number(metadata.validFromTurn)) throw new Error('Imported location lore has reversed validity dates.');
		for (const id of lore.exceptionToFactIds) {
			const target = tables.facts.find(fact => fact.id === id);
			const targetLore = locationLoreSchema.safeParse(asRecord(target?.metadata).locationLore);
			if (!target || !locations.has(asString(target.subjectEntityId)) || !targetLore.success || targetLore.data.scope !== 'descendants') throw new Error('Imported exception references a missing or unscoped location rule.');
			const seen = new Set<string>([asString(row.subjectEntityId)]);
			let ancestor = asString(row.subjectEntityId);
			let matched = false;
			while (ancestor) {
				const parents = physical.filter(edge => edge.sourceEntityId === ancestor && isEffectiveContainment(edge, Number(metadata.validFromTurn ?? turn)));
				if (parents.length !== 1) break;
				ancestor = parents[0].targetEntityId;
				if (seen.has(ancestor)) break;
				seen.add(ancestor);
				if (ancestor === target.subjectEntityId) { matched = true; break; }
			}
			if (!matched) throw new Error('Imported local exception must reference a rule owned by an ancestor at its effective turn.');
		}
	}
}

function validateImportedMaps(tables: WorldDatabaseTables, assetIds: Set<string>): void {
	const entityById = new Map(tables.entities.map(row => [asString(row.id), row]));
	const maps = new Map<string, { revision: number; map: LocationMapBody }>();
	const checkMap = (value: unknown) => {
		const map = locationMapBodySchema.parse(value);
		if (map.backgroundAssetId && !assetIds.has(map.backgroundAssetId)) throw new Error('Imported map background is missing from the bundle.');
		for (const object of [...map.regions, ...map.pins]) if (object.locationId) {
			const target = entityById.get(object.locationId);
			if (!target || target.type !== 'location') throw new Error('Imported map has an invalid location link.');
			if (object.visibility === 'public' && !['public', 'player_known'].includes(asString(target.visibility))) throw new Error('Imported public map reveals a hidden location.');
		}
		for (const object of map.tokens) if (object.entityId) {
			const target = entityById.get(object.entityId);
			if (!target) throw new Error('Imported map has an invalid token link.');
			if (object.visibility === 'public' && !['public', 'player_known'].includes(asString(target.visibility))) throw new Error('Imported public map reveals a hidden entity.');
		}
		return map;
	};
	for (const row of tables.locationMaps) {
		const locationId = asString(row.locationId);
		if (maps.has(locationId) || entityById.get(locationId)?.type !== 'location') throw new Error('Imported map owner must be a unique location in this game.');
		const revision = Number(row.revision);
		if (!Number.isInteger(revision) || revision < 1) throw new Error('Invalid imported map revision.');
		maps.set(locationId, { revision, map: checkMap(row.map) });
	}
	const history = new Map<string, Set<number>>();
	for (const row of tables.locationMapRevisions) {
		const locationId = asString(row.locationId);
		const current = maps.get(locationId);
		const revision = Number(row.revision);
		if (!current || !Number.isInteger(revision) || revision < 1 || revision > current.revision) throw new Error('Invalid imported map history.');
		const seen = history.get(locationId) ?? new Set<number>();
		if (seen.has(revision)) throw new Error('Duplicate imported map revision.');
		seen.add(revision); history.set(locationId, seen);
		const snapshot = checkMap(row.snapshot);
		if (revision === current.revision && JSON.stringify(snapshot) !== JSON.stringify(current.map)) throw new Error('Imported current map differs from its latest revision.');
	}
	for (const [locationId, current] of maps) if (!history.get(locationId)?.has(current.revision)) throw new Error('Imported map is missing its latest revision.');
}

function validateImportVersion(bundle: Record<string, unknown>) {
	const formatVersions = [bundle.schemaVersion, bundle.version].filter((value): value is number => typeof value === 'number');
	if (formatVersions.some((version) => !Number.isInteger(version) || version < 1 || version > TERMINAL_WORLD_DATABASE_SCHEMA_VERSION))
		throw new Error(`Unsupported world database bundle version; this build supports up to ${TERMINAL_WORLD_DATABASE_SCHEMA_VERSION}. Update MythEngine before importing.`);
	if (formatVersions.length === 2 && formatVersions[0] !== formatVersions[1])
		throw new Error('World database bundle version and schemaVersion disagree.');
}

export async function previewWorldDatabaseImport(input: unknown) {
	const request = worldDatabaseImportRequestSchema.parse(input);
	validateImportVersion(request.bundle);
	const tables = normalizeTables(request.bundle);
	const story = asRecord(tables.story);
	const sourceProjectId = asString(story.shelfId);
	const sourceShelf = asRecord(request.bundle.shelf);
	const shelfId = asString(sourceShelf.id, sourceProjectId);
	if (!sourceProjectId || !shelfId || sourceProjectId !== shelfId) throw new Error('Bundle project identity does not match its game.');
	const destinationProjectId = request.options.destinationProjectId;
	if (request.options.sourceProjectId && !destinationProjectId) throw new Error('A source project ID requires a selected destination project.');
	if (destinationProjectId && request.options.sourceProjectId !== sourceProjectId)
		throw new Error('Project merge requires the explicit source project ID from this bundle.');
	return getDb().transaction(async tx => {
		const conflicts: Array<{ kind: string; message: string; sourceId: string; destinationId?: string }> = [];
		let destinationProjectName: string | null = null;
		let content = null as Awaited<ReturnType<typeof previewContentImportConflicts>> | null;
		if (destinationProjectId) {
			const [destination] = await tx.execute(sql`select id,name from shelves where id=${destinationProjectId}`);
			if (!destination) throw new Error('Selected destination project was not found.');
			destinationProjectName = String(destination.name);
			if (request.bundle.authoredContent)
				content = await previewContentImportConflicts(tx, destinationProjectId, request.bundle.authoredContent);
			if (content) conflicts.push(...content.conflicts);
		} else if (request.options.preserveIds) {
			const [occupied] = await tx.execute(sql`select id from shelves where id=${sourceProjectId}`);
			if (occupied) conflicts.push({ kind: 'project', message: 'Project ID already exists. Import a copy or select this project explicitly for a merge.', sourceId: sourceProjectId, destinationId: String(occupied.id) });
		}
		if (request.options.preserveIds) {
			const storyId = asString(story.id);
			const [occupied] = await tx.execute(sql`select id from stories where id=${storyId}`);
			if (occupied && !request.options.replaceExisting) conflicts.push({ kind: 'story', message: 'Game ID already exists. Import a copy or resolve the existing game first.', sourceId: storyId, destinationId: String(occupied.id) });
		}
		return {
			ready: conflicts.length === 0, mode: destinationProjectId ? 'merge' as const : 'copy' as const,
			sourceProjectId, sourceProjectName: asString(sourceShelf.name, sourceProjectId),
			destinationProjectId: destinationProjectId ?? null, destinationProjectName,
			storyTitle: asString(story.title, 'Imported game'),
			content: content
				? { typeCount: content.typeCount, itemCount: content.itemCount, reusedTypes: content.reusedTypes, newTypes: content.newTypes }
				: request.bundle.authoredContent
					? { typeCount: request.bundle.authoredContent.types.length, itemCount: request.bundle.authoredContent.items.length,
						reusedTypes: 0, newTypes: request.bundle.authoredContent.types.length }
					: null,
			conflicts,
		};
	}, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

export async function importWorldDatabaseBundle(input: unknown) {
	const request = worldDatabaseImportRequestSchema.parse(input);
	validateImportVersion(request.bundle);
	const importedAt = nowIso();
	let tables = normalizeTables(request.bundle);
  const originalStory = asRecord(tables.story);
  const portraitSourceGameId = asString(originalStory.id);
  const portraitSourceProjectId = asString(originalStory.shelfId);
  const originalCanonical=tables.canonicalContent;
	if (!request.options.preserveIds) tables = remapImportedRecordIds(tables);
	assertUniqueEntryPositions(tables.entries);
	const storyRow = storyValue(tables.story, importedAt);
	const storyId = storyRow.id;
	validateImportedLocationLore(tables, storyId, storyRow.currentTurn ?? 0);
	const bundleRecord = asRecord(request.bundle);
	const mapAssets = (request.bundle.locationMapAssets ?? []).map(asset => locationMapAssetExportSchema.parse(asset));
	if (new Set(mapAssets.map(asset => asset.id)).size !== mapAssets.length) throw new Error('Duplicate map background asset in bundle.');
	const portraitAssets = (request.bundle.portraitAssets ?? []).map(asset => locationMapAssetExportSchema.parse(asset));
	if (new Set(portraitAssets.map(asset => asset.id)).size !== portraitAssets.length) throw new Error('Duplicate portrait asset in bundle.');
	validateImportedMaps(tables, new Set(mapAssets.map(asset => asset.id)));
	const shelfSource = asRecord(bundleRecord.shelf);
	const shelfRow = Object.keys(shelfSource).length > 0
		? shelfValue(shelfSource, importedAt, storyRow.genre ?? null)
		: shelfValue({ id: storyRow.shelfId, name: storyRow.shelfId === 'shelf_default' ? 'Default Shelf' : 'Imported Shelf' }, importedAt, storyRow.genre ?? null);
	const sourceProjectId = asString(tables.story.shelfId, shelfRow.id);
	if (sourceProjectId !== shelfRow.id) throw new Error('Bundle project identity does not match its game.');
	const counts: Record<string, number> = {};
	const db = getDb();
	const resolvedShelf = await resolveImportShelf(db, shelfRow, request.options, sourceProjectId);
	storyRow.shelfId = resolvedShelf.shelfId;

	const [existing] = await db.select({ id: stories.id, serverVersion: stories.serverVersion, shelfId: stories.shelfId }).from(stories).where(eq(stories.id, storyId)).limit(1);
	if (existing && !request.options.replaceExisting) {
		throw new Error(`World database ${storyId} already exists. Pass replaceExisting=true or import with preserveIds=false.`);
	}
	if (existing && existing.shelfId !== resolvedShelf.shelfId) throw new Error('Replacement game belongs to a different project. Select its project explicitly before replacing it.');
	if (existing && request.options.replaceExisting) {
		// A replacement can carry the same exported version as the live story. Force
		// a new source revision so prepared contexts and dependent projections cannot
		// survive the destructive replacement.
		storyRow.serverVersion = Math.max(storyRow.serverVersion ?? 1, existing.serverVersion + 1);
	}
	const replacedAssetKeys: string[] = [];

	const createdAssetKeys: string[] = [];
	let skippedContentTypeHistory: string[] = [];
	try { await db.transaction(async (tx) => {
		if (resolvedShelf.insertShelfRow) {
			await tx.insert(shelves).values(resolvedShelf.insertShelfRow);
			increment(counts, 'shelves', 1);
		}

    // Follow authoring's project -> record lock order, including replacement imports.
    await tx.execute(sql`select id from shelves where id in (${resolvedShelf.shelfId},${existing?.shelfId??resolvedShelf.shelfId}) order by id for update`);
    if(existing&&request.options.replaceExisting){
      await tx.execute(sql`select id from stories where id=${storyId} for update`);
      replacedAssetKeys.push(...(await tx.execute(sql`select storage_key from assets where game_id=${storyId} for update`)).map(row=>String(row.storage_key)));
      await tx.delete(stories).where(eq(stories.id,storyId));
    }
		await tx.insert(stories).values(storyRow);
		increment(counts, 'stories', 1);
		if (request.bundle.portraitAssets !== undefined) {
			const portraitIds = new Map<string, string>();
			for (const asset of portraitAssets) portraitIds.set(asset.id, await importImageAsset(tx, {
				projectId: resolvedShelf.shelfId, gameId: storyId, mediaType: asset.mediaType,
				sha256: asset.sha256, bytesBase64: asset.bytesBase64, visibility: 'public', createdKeys: createdAssetKeys,
			}));
			tables = remapPortraitAssetUrls(tables,
				{ projectId: portraitSourceProjectId, gameId: portraitSourceGameId },
				{ projectId: resolvedShelf.shelfId, gameId: storyId }, portraitIds);
			increment(counts, 'portraitAssets', portraitIds.size);
		}

		// A snapshot import is all-or-nothing. Conflicts must roll back, not silently drop canon.
		for (const [index, row] of tables.entries.entries()) {
			await tx.insert(storyEntries).values(entryValue(row, storyId, importedAt, index));
		}
		increment(counts, 'entries', tables.entries.length);

		for (const row of tables.entities) await tx.insert(entities).values(entityValue(row, storyId, importedAt));
		increment(counts, 'entities', tables.entities.length);
		const mapAssetIds = new Map<string, string>();
		for (const asset of mapAssets) mapAssetIds.set(asset.id, await importImageAsset(tx, { projectId: resolvedShelf.shelfId, gameId: storyId,
			mediaType: asset.mediaType, sha256: asset.sha256, bytesBase64: asset.bytesBase64,
			visibility: 'public', createdKeys: createdAssetKeys }));
		const remapMap = (value: unknown) => {
			const map = locationMapBodySchema.parse(value);
			return { ...map, backgroundAssetId: map.backgroundAssetId ? mapAssetIds.get(map.backgroundAssetId) ?? null : null };
		};
		for (const row of tables.locationMaps) await tx.insert(locationMaps).values({ locationId: asString(row.locationId), storyId,
			revision: Number(row.revision), map: remapMap(row.map), createdAt: asString(row.createdAt, importedAt), updatedAt: importedAt });
		for (const row of tables.locationMapRevisions) await tx.insert(locationMapRevisions).values({ locationId: asString(row.locationId),
			revision: Number(row.revision), snapshot: remapMap(row.snapshot), actor: asRecord(row.actor),
			reason: asString(row.reason, 'Imported map revision.'), createdAt: asString(row.createdAt, importedAt) });
		increment(counts, 'locationMaps', tables.locationMaps.length);
		increment(counts, 'locationMapRevisions', tables.locationMapRevisions.length);

		for (const row of tables.entityAliases) await tx.insert(entityAliases).values(aliasValue(row, storyId, importedAt));
		increment(counts, 'entityAliases', tables.entityAliases.length);

		for (const row of tables.relationships) await tx.insert(relationships).values(relationshipValue(row, storyId, importedAt));
		increment(counts, 'relationships', tables.relationships.length);

		for (const row of tables.factions) await tx.insert(factions).values(factionValue(row, storyId, importedAt));
		increment(counts, 'factions', tables.factions.length);

		for (const row of tables.factionMemberships) await tx.insert(factionMemberships).values(membershipValue(row, storyId, importedAt));
		increment(counts, 'factionMemberships', tables.factionMemberships.length);

		for (const row of tables.factionResources) await tx.insert(factionResources).values(resourceValue(row, storyId, importedAt));
		increment(counts, 'factionResources', tables.factionResources.length);

		for (const row of tables.factionGoals) await tx.insert(factionGoals).values(goalValue(row, storyId, importedAt));
		increment(counts, 'factionGoals', tables.factionGoals.length);

		for (const row of tables.factionProjects) await tx.insert(factionProjects).values(projectValue(row, storyId, importedAt));
		increment(counts, 'factionProjects', tables.factionProjects.length);

		for (const row of tables.npcBeliefs) await tx.insert(npcBeliefs).values(beliefValue(row, storyId, importedAt));
		increment(counts, 'npcBeliefs', tables.npcBeliefs.length);

		for (const row of tables.agreements) await tx.insert(agreements).values(agreementValue(row, storyId, importedAt));
		increment(counts, 'agreements', tables.agreements.length);

		for (const row of tables.threads) await tx.insert(storyThreads).values(threadValue(row, storyId, importedAt));
		increment(counts, 'threads', tables.threads.length);

		for (const row of tables.events) await tx.insert(storyEvents).values(eventValue(row, storyId, importedAt));
		increment(counts, 'events', tables.events.length);

		for (const row of tables.npcEventLinks) await tx.insert(npcEventLinks).values(npcEventLinkValue(row, storyId, importedAt));
		increment(counts, 'npcEventLinks', tables.npcEventLinks.length);

		for (const row of tables.statePatches) await tx.insert(statePatches).values(patchValue(row, storyId, importedAt));
		increment(counts, 'statePatches', tables.statePatches.length);

		for (const row of tables.facts) await tx.insert(facts).values(factValue(row, storyId, importedAt));
		increment(counts, 'facts', tables.facts.length);

		for (const row of tables.sourceRefs) await tx.insert(sourceRefs).values(sourceRefValue(row, storyId, importedAt));
		increment(counts, 'sourceRefs', tables.sourceRefs.length);

		for (const row of tables.patchProposals) await tx.insert(patchProposals).values(patchProposalValue(row, storyId, importedAt));
		increment(counts, 'patchProposals', tables.patchProposals.length);

		for (const row of tables.continuityWarnings) await tx.insert(continuityWarnings).values(continuityWarningValue(row, storyId, importedAt));
		increment(counts, 'continuityWarnings', tables.continuityWarnings.length);

		for (const row of tables.memoryNodes) await tx.insert(memoryNodes).values(memoryValue(row, storyId, importedAt));
		increment(counts, 'memoryNodes', tables.memoryNodes.length);

		for (const row of tables.chapters) await tx.insert(chapters).values(chapterValue(row, storyId, importedAt));
		increment(counts, 'chapters', tables.chapters.length);

		for (const row of tables.arcs) await tx.insert(arcs).values(arcValue(row, storyId, importedAt));
		increment(counts, 'arcs', tables.arcs.length);

		for (const row of tables.sagas) await tx.insert(sagas).values(sagaValue(row, storyId, importedAt));
		increment(counts, 'sagas', tables.sagas.length);
		await importCanonicalWorkspace(tx,resolvedShelf.shelfId,storyId,tables.canonicalContent);
    if (request.bundle.authoredContent !== undefined) {
      const content = await importContentSnapshot(tx, { projectId: resolvedShelf.shelfId, gameId: storyId }, request.bundle.authoredContent,new Map(originalCanonical.map((row,index)=>[String(row.kind)+'/'+String(row.recordId),String(tables.canonicalContent[index].recordId)])),createdAssetKeys);
      increment(counts, 'contentItems', Object.keys(content.itemIds).length);
      increment(counts, 'contentTypes', Object.keys(content.typeIds).length);
      skippedContentTypeHistory = content.skippedTypeHistory.filter(id => content.typeIds[id] !== id);
    }
		if (request.bundle.storyImages !== undefined)
			increment(counts, 'storyImages', await importStoryImageCards(tx, { projectId: resolvedShelf.shelfId, gameId: storyId, cards: request.bundle.storyImages, createdAssetKeys }));
	}); } catch (error) { const { cleanupImportedImageAssets } = await import('$lib/server/engine/imageAssets'); await cleanupImportedImageAssets(createdAssetKeys); throw error; }
	if (replacedAssetKeys.length) { const { cleanupImportedImageAssets } = await import('$lib/server/engine/imageAssets'); await cleanupImportedImageAssets(replacedAssetKeys); }

	const warnings: string[] = [];
	if (skippedContentTypeHistory.length)
		warnings.push(`Source history for ${skippedContentTypeHistory.length} content type(s) was not merged into compatible existing destination types: ${skippedContentTypeHistory.join(', ')}.`);
	if (existing && request.options.replaceExisting) {
		try {
			const cleanup = await deleteStoryVaultArtifacts(storyId);
			if (cleanup.qdrantError) {
				const warning = `Imported replacement committed, but old generated wiki artifacts could not be fully deleted: ${cleanup.qdrantError}`;
				warnings.push(warning);
				console.warn(`[WorldDatabaseImport] ${warning}`);
			}
		} catch (error) {
			const warning = `Imported replacement committed, but old generated wiki artifacts could not be deleted: ${error instanceof Error ? error.message : String(error)}`;
			warnings.push(warning);
			console.warn(`[WorldDatabaseImport] ${warning}`);
		}
	}

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
		projectId: resolvedShelf.shelfId,
		serverVersion: storyRow.serverVersion ?? 1,
		counts,
		jobIds,
		warnings,
		importedAt,
	};
}
