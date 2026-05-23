import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import {
	agreements,
	arcs,
	chapters,
	entities,
	entityAliases,
	factions,
	factionGoals,
	factionMemberships,
	factionResources,
	memoryNodes,
	relationships,
	statePatches,
	stories,
	storyEntries,
	storyEvents,
	storyThreads,
	syncOps,
} from '$lib/server/db/schema';
import { getServerMemoryConfig } from '$lib/server/env';
import {
	createStoryRequestSchema,
	indexedDbImportRequestSchema,
	syncOperationSchema,
	type SyncChange,
	type SyncOperation,
} from '$lib/contracts/memory';
import { enqueueImportProjectionJobs } from '$lib/server/jobs/outbox';

type JsonRecord = Record<string, unknown>;

function nowIso(): string {
	return new Date().toISOString();
}

function id(prefix = 'srv'): string {
	return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

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

function asArray<T = unknown>(value: unknown): T[] {
	return Array.isArray(value) ? value as T[] : [];
}

function asStringArray(value: unknown): string[] {
	return asArray(value).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeAlias(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function sourceEntries(...values: unknown[]): string[] {
	return [...new Set(values.map(asNullableString).filter((value): value is string => Boolean(value)))];
}

function extractFactionResources(state: JsonRecord): JsonRecord {
	const resources = asRecord(state.resources);
	if (Object.keys(resources).length > 0) return resources;
	return {
		wealth: state.wealth ?? null,
		food: state.food ?? null,
		army: state.army ?? null,
		ships: state.ships ?? null,
		spies: state.spies ?? null,
		influence: state.influence ?? null,
	};
}

function extractFactionMembers(state: JsonRecord): string[] {
	return [
		...asStringArray(state.memberEntityIds),
		...asStringArray(state.members),
		...asStringArray(state.leaders),
	].filter(Boolean);
}

export async function bumpStoryVersion(storyId: string): Promise<number> {
	const db = getDb();
	const [row] = await db
		.update(stories)
		.set({
			serverVersion: sql`${stories.serverVersion} + 1`,
			updatedAt: nowIso(),
		})
		.where(eq(stories.id, storyId))
		.returning({ serverVersion: stories.serverVersion });
	return row?.serverVersion ?? 1;
}

export async function createBackendStory(input: unknown) {
	const request = createStoryRequestSchema.parse(input);
	const db = getDb();
	const createdAt = nowIso();
	const storyId = id('story');

	const [story] = await db.insert(stories).values({
		id: storyId,
		clientStoryId: request.clientStoryId ?? null,
		title: request.title,
		description: request.description ?? null,
		metadata: { playerReputation: request.playerReputation ?? null },
		createdAt,
		updatedAt: createdAt,
	}).returning();

	return {
		storyId: story.id,
		serverVersion: story.serverVersion,
		createdAt: story.createdAt,
	};
}

export async function getBootstrap(storyId: string) {
	const db = getDb();
	const [story] = await db.select().from(stories).where(eq(stories.id, storyId)).limit(1);
	if (!story) throw new Error(`Story not found: ${storyId}`);

	const [
		entriesRows,
		entityRows,
		factionRows,
		factionMembershipRows,
		factionResourceRows,
		factionGoalRows,
		agreementRows,
		threadRows,
		eventRows,
		patchRows,
		nodeRows,
	] = await Promise.all([
		db.select().from(storyEntries).where(eq(storyEntries.storyId, storyId)).orderBy(storyEntries.position).limit(80),
		db.select().from(entities).where(eq(entities.storyId, storyId)).limit(500),
		db.select().from(factions).where(eq(factions.storyId, storyId)).limit(200),
		db.select().from(factionMemberships).where(eq(factionMemberships.storyId, storyId)).limit(500),
		db.select().from(factionResources).where(eq(factionResources.storyId, storyId)).limit(500),
		db.select().from(factionGoals).where(eq(factionGoals.storyId, storyId)).limit(500),
		db.select().from(agreements).where(eq(agreements.storyId, storyId)).limit(200),
		db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId)).limit(200),
		db.select().from(storyEvents).where(eq(storyEvents.storyId, storyId)).orderBy(desc(storyEvents.createdAt)).limit(80),
		db.select().from(statePatches).where(eq(statePatches.storyId, storyId)).orderBy(desc(statePatches.createdAt)).limit(80),
		db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId)).orderBy(desc(memoryNodes.importance)).limit(80),
	]);

	return {
		story,
		serverVersion: story.serverVersion,
		entries: entriesRows,
		entities: entityRows,
		factions: factionRows,
		factionMemberships: factionMembershipRows,
		factionResources: factionResourceRows,
		factionGoals: factionGoalRows,
		agreements: agreementRows,
		threads: threadRows,
		recentEvents: eventRows,
		recentPatches: patchRows,
		memoryNodes: nodeRows.map((row) => ({ ...row, embedding: undefined })),
	};
}

async function insertEntityFromObject(
	storyId: string,
	table: string,
	item: JsonRecord,
	type: string,
	counts: Record<string, number>,
	skipped: Array<{ table: string; id?: string; reason: string }>,
): Promise<string | null> {
	const name = asString(item.name).trim();
	if (!name) {
		skipped.push({ table, id: asNullableString(item.id) ?? undefined, reason: 'Missing name.' });
		return null;
	}

	const entityId = asNullableString(item.id) ?? id('entity');
	const state = asRecord(item.state);
	const metadata = { originalTable: table, originalMetadata: item.metadata ?? null };
	const insertedAt = nowIso();
	await getDb().insert(entities).values({
		id: entityId,
		storyId,
		type,
		name,
		description: asNullableString(item.description),
		status: asString(item.status, 'active'),
		visibility: asString(item.visibility, 'player_known'),
		state,
		metadata,
		sourceEntryIds: sourceEntries(item.firstMentioned, item.lastMentioned),
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: entities.id,
		set: {
			name,
			description: asNullableString(item.description),
			updatedAt: insertedAt,
		},
	});

	const aliases = [...new Set([name, ...asStringArray(item.aliases)])]
		.map((alias) => ({ alias, normalizedAlias: normalizeAlias(alias) }))
		.filter((alias) => alias.normalizedAlias);
	for (const alias of aliases) {
		await getDb().insert(entityAliases).values({
			id: id('alias'),
			storyId,
			entityId,
			alias: alias.alias,
			normalizedAlias: alias.normalizedAlias,
			sourceEntryIds: sourceEntries(item.firstMentioned, item.lastMentioned),
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
	}

	counts.entities = (counts.entities ?? 0) + 1;
	return entityId;
}

async function importFactionFromEntry(storyId: string, entry: JsonRecord, entityId: string, counts: Record<string, number>) {
	const state = asRecord(entry.state);
	const insertedAt = nowIso();
	const factionId = `faction_${entityId}`;
	await getDb().insert(factions).values({
		id: factionId,
		storyId,
		entityId,
		name: asString(entry.name),
		goals: asStringArray(state.goals),
		resources: extractFactionResources(state),
		memberEntityIds: extractFactionMembers(state),
		territoryIds: asStringArray(state.territories ?? state.territoryIds),
		allies: asStringArray(state.allies),
		enemies: asStringArray(state.enemies),
		pressure: asNumber(state.pressure, 0),
		metadata: { originalState: state },
		sourceEntryIds: sourceEntries(entry.firstMentioned, entry.lastMentioned),
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: factions.id,
		set: {
			goals: asStringArray(state.goals),
			resources: extractFactionResources(state),
			memberEntityIds: extractFactionMembers(state),
			updatedAt: insertedAt,
		},
	});
	counts.factions = (counts.factions ?? 0) + 1;

	const sourceEntryIds = sourceEntries(entry.firstMentioned, entry.lastMentioned);
	for (const [idx, member] of extractFactionMembers(state).entries()) {
		await getDb().insert(factionMemberships).values({
			id: `${factionId}_member_${idx}`,
			storyId,
			factionId,
			entityId: null,
			role: idx === 0 ? 'leader-or-member' : 'member',
			rank: null,
			status: 'active',
			visibility: 'player_known',
			metadata: { memberNameOrId: member },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionMemberships = (counts.factionMemberships ?? 0) + 1;
	}

	for (const [kind, amount] of Object.entries(extractFactionResources(state))) {
		if (amount == null || amount === '') continue;
		await getDb().insert(factionResources).values({
			id: `${factionId}_resource_${normalizeAlias(kind)}`,
			storyId,
			factionId,
			kind,
			name: kind,
			amount: typeof amount === 'number' ? amount : null,
			status: 'available',
			locationId: null,
			visibility: 'player_known',
			metadata: { value: amount },
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionResources = (counts.factionResources ?? 0) + 1;
	}

	for (const [idx, goal] of asStringArray(state.goals).entries()) {
		await getDb().insert(factionGoals).values({
			id: `${factionId}_goal_${idx}`,
			storyId,
			factionId,
			goal,
			status: 'active',
			priority: 5,
			secrecy: 'player_known',
			metadata: {},
			sourceEntryIds,
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.factionGoals = (counts.factionGoals ?? 0) + 1;
	}
}

async function createMemoryNodeFromChapter(storyId: string, chapter: JsonRecord, counts: Record<string, number>) {
	const chapterId = asNullableString(chapter.id) ?? id('chapter');
	const insertedAt = nowIso();
	const sourceEntryIds = sourceEntries(chapter.startEntryId, chapter.endEntryId);
	const summary = asString(chapter.summary, asString(chapter.sceneOutcome));
	await getDb().insert(chapters).values({
		id: chapterId,
		storyId,
		number: asNumber(chapter.number, (counts.chapters ?? 0) + 1),
		title: asNullableString(chapter.title),
		sceneOutcome: summary,
		irreversibleChanges: asStringArray(chapter.irreversibleChanges),
		npcKnowledgeChanges: asArray<Record<string, unknown>>(chapter.npcKnowledgeChanges),
		promisesDebtsOaths: asStringArray(chapter.promisesDebtsOaths),
		discoveredClues: asStringArray(chapter.discoveredClues),
		relationshipChanges: asStringArray(chapter.relationshipChanges),
		factionChanges: asStringArray(chapter.factionChanges),
		openThreads: asStringArray(chapter.openThreads ?? chapter.plotThreads),
		sourceEntryIds,
		sourceEventIds: asStringArray(chapter.sourceEventIds),
		metadata: {
			legacyKeywords: asStringArray(chapter.keywords),
			legacyCharacters: asStringArray(chapter.characters),
			legacyLocations: asStringArray(chapter.locations),
		},
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.chapters = (counts.chapters ?? 0) + 1;

	await getDb().insert(memoryNodes).values({
		id: `mem_chapter_${chapterId}`,
		storyId,
		type: 'episodic',
		title: asString(chapter.title, `Chapter ${asNumber(chapter.number, counts.chapters)}`),
		content: summary,
		summary,
		keywords: asStringArray(chapter.keywords),
		entityIds: [],
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: 'player_known',
		importance: 0.65,
		sourceEntryIds,
		sourceEventIds: asStringArray(chapter.sourceEventIds),
		sourcePatchIds: [],
		metadata: { sourceType: 'chapter_import' },
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
}

async function createMemoryNodeFromThread(storyId: string, thread: JsonRecord, counts: Record<string, number>) {
	const threadId = asNullableString(thread.id) ?? id('thread');
	const insertedAt = nowIso();
	await getDb().insert(storyThreads).values({
		id: threadId,
		storyId,
		description: asString(thread.description),
		status: asString(thread.status, 'open'),
		significance: asString(thread.significance, 'moderate'),
		relatedFactionIds: asStringArray(thread.relatedFactionIds),
		relatedEntityIds: asStringArray(thread.relatedEntityIds ?? thread.relatedCharacterNames),
		sourceEntryIds: [],
		sourceEventIds: sourceEntries(thread.sourceEventIds, thread.sourceChapterId),
		sourcePatchIds: [],
		closedAt: asNullableString(thread.closedAt),
		closureReason: asNullableString(thread.closureReason),
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.threads = (counts.threads ?? 0) + 1;

	if (asString(thread.status, 'open') !== 'closed') {
		await getDb().insert(memoryNodes).values({
			id: `mem_thread_${threadId}`,
			storyId,
			type: 'plot_ledger',
			title: 'Open thread',
			content: asString(thread.description),
			summary: asString(thread.description),
			keywords: [],
			entityIds: asStringArray(thread.relatedEntityIds ?? thread.relatedCharacterNames),
			factionIds: asStringArray(thread.relatedFactionIds),
			threadIds: [threadId],
			locationId: null,
			visibility: 'player_known',
			importance: asString(thread.significance) === 'critical' ? 0.95 : 0.75,
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			metadata: { sourceType: 'thread_import' },
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.memoryNodes = (counts.memoryNodes ?? 0) + 1;
	}
}

export async function importIndexedDbBundle(input: unknown) {
	const request = indexedDbImportRequestSchema.parse(input);
	const { importEntryLimit } = getServerMemoryConfig();
	const bundle = request.bundle;
	const legacyStory = asRecord(bundle.story);
	const storyId = request.options.preserveIds && asNullableString(legacyStory.id)
		? asString(legacyStory.id)
		: id('story');
	const counts: Record<string, number> = {};
	const skipped: Array<{ table: string; id?: string; reason: string }> = [];
	const merged: Array<{ table: string; sourceId: string; targetId: string }> = [];
	const insertedAt = nowIso();

	await getDb().insert(stories).values({
		id: storyId,
		clientStoryId: asNullableString(legacyStory.id),
		title: asString(legacyStory.title, 'Imported Story'),
		description: asNullableString(legacyStory.description),
		genre: asNullableString(legacyStory.genre),
		mode: asString(legacyStory.mode, 'adventure'),
		settings: asRecord(legacyStory.settings),
		headerPrompt: asNullableString(legacyStory.headerPrompt),
		metadata: {
			importedFrom: 'indexeddb',
			importedAt: insertedAt,
			playerReputation: asNullableString(legacyStory.playerReputation),
		},
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoUpdate({
		target: stories.id,
		set: {
			title: asString(legacyStory.title, 'Imported Story'),
			description: asNullableString(legacyStory.description),
			updatedAt: insertedAt,
		},
	});
	counts.stories = 1;

	const entries = asArray<JsonRecord>(bundle.storyEntries).slice(0, importEntryLimit);
	for (const entry of entries) {
		const entryId = asNullableString(entry.id) ?? id('entry');
		await getDb().insert(storyEntries).values({
			id: entryId,
			storyId,
			type: asString(entry.type, 'system'),
			content: asString(entry.content),
			position: asNumber(entry.position, counts.entries ?? 0),
			parentId: asNullableString(entry.parentId),
			branchId: asNullableString(entry.branchId),
			metadata: asRecord(entry.metadata),
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.entries = (counts.entries ?? 0) + 1;
	}

	for (const character of asArray<JsonRecord>(bundle.characters)) {
		await insertEntityFromObject(storyId, 'characters', character, 'character', counts, skipped);
	}
	for (const location of asArray<JsonRecord>(bundle.locations)) {
		await insertEntityFromObject(storyId, 'locations', location, 'location', counts, skipped);
	}
	for (const item of asArray<JsonRecord>(bundle.items)) {
		await insertEntityFromObject(storyId, 'items', item, 'item', counts, skipped);
	}
	for (const entry of asArray<JsonRecord>(bundle.lorebookEntries)) {
		const type = asString(entry.type, 'concept');
		const entityId = await insertEntityFromObject(storyId, 'lorebookEntries', entry, type, counts, skipped);
		if (entityId && type === 'faction') await importFactionFromEntry(storyId, entry, entityId, counts);
	}

	for (const rel of asArray<JsonRecord>(bundle.entryRelationships)) {
		const relId = asNullableString(rel.id) ?? id('rel');
		await getDb().insert(relationships).values({
			id: relId,
			storyId,
			sourceEntityId: asString(rel.sourceEntryId),
			targetEntityId: asString(rel.targetEntryId),
			type: asString(rel.type, 'related-to'),
			label: asNullableString(rel.label),
			strength: asNumber(rel.strength, 0.5),
			bidirectional: Boolean(rel.bidirectional),
			metadata: asRecord(rel.metadata),
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.relationships = (counts.relationships ?? 0) + 1;
	}

	for (const agreement of asArray<JsonRecord>(bundle.agreements)) {
		const agreementId = asNullableString(agreement.id) ?? id('agreement');
		await getDb().insert(agreements).values({
			id: agreementId,
			storyId,
			parties: asStringArray(agreement.parties),
			category: asString(agreement.category, 'pact'),
			terms: asString(agreement.terms),
			status: asString(agreement.status, 'active'),
			secrecy: asString(agreement.secrecy, 'known'),
			consequences: asStringArray(agreement.consequences),
			sourceEntryIds: [],
			sourceEventIds: [],
			sourcePatchIds: [],
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.agreements = (counts.agreements ?? 0) + 1;
	}

	for (const chapter of asArray<JsonRecord>(bundle.chapters)) {
		await createMemoryNodeFromChapter(storyId, chapter, counts);
	}

	for (const arc of asArray<JsonRecord>(bundle.arcs)) {
		const arcId = asNullableString(arc.id) ?? id('arc');
		await getDb().insert(arcs).values({
			id: arcId,
			storyId,
			number: asNumber(arc.arcNumber ?? arc.number, (counts.arcs ?? 0) + 1),
			title: asString(arc.title, `Arc ${(counts.arcs ?? 0) + 1}`),
			summary: asString(arc.summary),
			chapterIds: asStringArray(arc.chapterIds),
			sourceEventIds: asStringArray(arc.sourceEventIds),
			openThreadIds: asStringArray(arc.threadIds ?? arc.unresolvedThreads),
			metadata: { legacyRange: arc.chapterRange ?? null, characterArcs: arc.characterArcs ?? [] },
			createdAt: insertedAt,
			updatedAt: insertedAt,
		}).onConflictDoNothing();
		counts.arcs = (counts.arcs ?? 0) + 1;
	}

	for (const thread of asArray<JsonRecord>(bundle.storyThreads)) {
		await createMemoryNodeFromThread(storyId, thread, counts);
	}

	const importEventId = id('event');
	await getDb().insert(storyEvents).values({
		id: importEventId,
		storyId,
		type: 'imported_memory',
		title: 'IndexedDB story imported',
		body: `Imported ${counts.entries ?? 0} entries, ${counts.entities ?? 0} entities, ${counts.chapters ?? 0} chapters, and ${counts.factions ?? 0} factions into backend canon.`,
		visibility: 'player_known',
		sourceEntryIds: entries.slice(0, 20).map((entry) => asString(entry.id)).filter(Boolean),
		sourcePatchIds: [],
		metadata: { counts },
		createdAt: insertedAt,
		updatedAt: insertedAt,
	}).onConflictDoNothing();
	counts.events = (counts.events ?? 0) + 1;

	const serverVersion = await bumpStoryVersion(storyId);
	try {
		const jobIds = await enqueueImportProjectionJobs({ storyId, counts, serverVersion });
		counts.backendJobsQueued = jobIds.length;
	} catch {
		counts.backendJobsQueued = 0;
	}
	return { storyId, serverVersion, counts, skipped, merged };
}

export async function exportBackendStory(storyId: string) {
	return getBootstrap(storyId);
}

export async function getSyncChanges(storyId: string, since: number): Promise<SyncChange[]> {
	const db = getDb();
	const tableSpecs = [
		{ name: 'stories', table: stories, idColumn: stories.id, storyColumn: stories.id },
		{ name: 'story_entries', table: storyEntries, idColumn: storyEntries.id, storyColumn: storyEntries.storyId },
		{ name: 'entities', table: entities, idColumn: entities.id, storyColumn: entities.storyId },
		{ name: 'factions', table: factions, idColumn: factions.id, storyColumn: factions.storyId },
		{ name: 'faction_memberships', table: factionMemberships, idColumn: factionMemberships.id, storyColumn: factionMemberships.storyId },
		{ name: 'faction_resources', table: factionResources, idColumn: factionResources.id, storyColumn: factionResources.storyId },
		{ name: 'faction_goals', table: factionGoals, idColumn: factionGoals.id, storyColumn: factionGoals.storyId },
		{ name: 'agreements', table: agreements, idColumn: agreements.id, storyColumn: agreements.storyId },
		{ name: 'story_threads', table: storyThreads, idColumn: storyThreads.id, storyColumn: storyThreads.storyId },
		{ name: 'story_events', table: storyEvents, idColumn: storyEvents.id, storyColumn: storyEvents.storyId },
		{ name: 'state_patches', table: statePatches, idColumn: statePatches.id, storyColumn: statePatches.storyId },
		{ name: 'memory_nodes', table: memoryNodes, idColumn: memoryNodes.id, storyColumn: memoryNodes.storyId },
	];

	const changes: SyncChange[] = [];
	for (const spec of tableSpecs) {
		const rows = await db
			.select()
			.from(spec.table as never)
			.where(and(eq(spec.storyColumn, storyId), gt((spec.table as typeof stories).serverVersion, since)))
			.limit(500);
		for (const row of rows as Array<JsonRecord & { id: string; serverVersion: number }>) {
			changes.push({
				table: spec.name,
				id: row.id,
				version: row.serverVersion,
				op: 'upsert',
				row: spec.name === 'memory_nodes' ? { ...row, embedding: undefined } : row,
			});
		}
	}
	return changes.sort((a, b) => a.version - b.version);
}

export async function applySyncOperation(raw: unknown): Promise<{ op: SyncOperation; eventIds: string[]; patchIds: string[] }> {
	const op = syncOperationSchema.parse(raw);
	const db = getDb();
	const createdAt = nowIso();
	const eventIds: string[] = [];
	const patchIds: string[] = [];

	await db.insert(syncOps).values({
		id: op.id,
		storyId: op.storyId,
		type: op.type,
		payload: op.payload,
		clientVersion: op.clientVersion,
		status: 'applied',
		createdAt,
	}).onConflictDoNothing();

	const serverVersion = await bumpStoryVersion(op.storyId);

	if (op.type === 'state_correction') {
		const patchId = id('patch');
		await db.insert(statePatches).values({
			id: patchId,
			storyId: op.storyId,
			operations: asArray<Record<string, unknown>>(op.payload.operations),
			reason: asString(op.payload.reason, 'Player correction'),
			status: 'needs_repair',
			validationWarnings: ['Queued for deterministic review before canon merge.'],
			sourceEntryIds: asStringArray(op.payload.sourceEntryIds),
			sourceEventIds: asStringArray(op.payload.sourceEventIds),
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		patchIds.push(patchId);

		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: op.storyId,
			type: 'correction',
			title: 'Player correction requested',
			body: asString(op.payload.reason, 'Player requested a memory correction.'),
			visibility: 'player_known',
			sourceEntryIds: asStringArray(op.payload.sourceEntryIds),
			sourcePatchIds: [patchId],
			metadata: { syncOpId: op.id },
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
	}

	if (op.type === 'create_entry') {
		const entry = asRecord(op.payload.entry);
		const entryId = asNullableString(entry.id) ?? id('entry');
		await db.insert(storyEntries).values({
			id: entryId,
			storyId: op.storyId,
			type: asString(entry.type, 'user_action'),
			content: asString(entry.content),
			position: asNumber(entry.position, Date.now()),
			parentId: asNullableString(entry.parentId),
			branchId: asNullableString(entry.branchId),
			metadata: asRecord(entry.metadata),
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		}).onConflictDoNothing();
	}

	if (op.type === 'delete_entry') {
		const entryIds = [
			...asStringArray(op.payload.entryIds),
			asNullableString(op.payload.entryId),
		].filter((value): value is string => Boolean(value));
		for (const entryId of entryIds) {
			await db.delete(storyEntries).where(and(eq(storyEntries.storyId, op.storyId), eq(storyEntries.id, entryId)));
		}
		const eventId = id('event');
		await db.insert(storyEvents).values({
			id: eventId,
			storyId: op.storyId,
			type: 'correction',
			title: 'Transcript context removed',
			body: asString(op.payload.reason, 'Player removed transcript context.'),
			visibility: 'player_known',
			sourceEntryIds: entryIds,
			sourcePatchIds: [],
			metadata: { syncOpId: op.id, fromPosition: op.payload.fromPosition ?? null },
			serverVersion,
			createdAt,
			updatedAt: createdAt,
		});
		eventIds.push(eventId);
	}

	return { op, eventIds, patchIds };
}
