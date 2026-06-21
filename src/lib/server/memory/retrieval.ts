import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { memoryNodes, entityAliases, entities, npcBeliefs, storyEvents } from '$lib/server/db/schema';
import { getDb } from '$lib/server/db/client';
import {
	memoryRetrieveRequestSchema,
	retrievedMemoryPacketSchema,
	type MemoryNode,
	type MemoryRetrieveRequest,
	type RetrievedMemoryPacket,
} from '$lib/contracts/memory';
import {
	embedMemoryText,
	memoryEmbeddingConfig,
	validateMemoryEmbeddingVector,
} from '$lib/server/memory/embeddings';
import { buildMemoryPacket, normalizeLookup, scoreMemoryNode } from './ranking';

type MemoryNodeRow = typeof memoryNodes.$inferSelect;
type NpcBeliefRow = typeof npcBeliefs.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function toMemoryNode(row: MemoryNodeRow): MemoryNode {
	return {
		id: row.id,
		storyId: row.storyId,
		type: row.type as MemoryNode['type'],
		title: row.title,
		content: row.content,
		summary: row.summary ?? null,
		keywords: asStringArray(row.keywords),
		entityIds: asStringArray(row.entityIds),
		factionIds: asStringArray(row.factionIds),
		threadIds: asStringArray(row.threadIds),
		locationId: row.locationId ?? null,
		visibility: row.visibility as MemoryNode['visibility'],
		importance: row.importance,
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: asStringArray(row.sourceEventIds),
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		metadata: row.metadata,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function beliefToMemoryNode(row: NpcBeliefRow): MemoryNode {
	return {
		id: row.id,
		storyId: row.storyId,
		type: 'npc_belief',
		title: 'NPC belief',
		content: row.belief,
		summary: row.belief,
		keywords: [],
		entityIds: [row.believerEntityId, row.subjectEntityId].filter((id): id is string => Boolean(id)),
		factionIds: [],
		threadIds: [],
		locationId: null,
		visibility: row.visibility as MemoryNode['visibility'],
		importance: row.confidence,
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: [...asStringArray(row.sourceEventIds), ...asStringArray(row.evidenceEventIds)],
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function eventToMemoryNode(row: StoryEventRow): MemoryNode {
	return {
		id: `event_memory_${row.id}`,
		storyId: row.storyId,
		type: row.type === 'faction_move' ? 'faction' : row.type === 'agreement' ? 'plot_ledger' : 'episodic',
		title: row.title,
		content: row.body,
		summary: row.body,
		keywords: [row.type],
		entityIds: [...asStringArray(row.actorEntityIds), ...asStringArray(row.targetEntityIds)],
		factionIds: [],
		threadIds: asStringArray(row.threadIds),
		locationId: row.locationId ?? null,
		visibility: row.visibility as MemoryNode['visibility'],
		importance: row.type === 'promise' || row.type === 'betrayal' || row.type === 'agreement' ? 0.85 : 0.65,
		sourceEntryIds: asStringArray(row.sourceEntryIds),
		sourceEventIds: [row.id],
		sourcePatchIds: asStringArray(row.sourcePatchIds),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function dedupe(nodes: MemoryNode[]): MemoryNode[] {
	const byId = new Map<string, MemoryNode>();
	for (const node of nodes) {
		const existing = byId.get(node.id);
		if (!existing || (node.score ?? 0) > (existing.score ?? 0)) byId.set(node.id, node);
	}
	return [...byId.values()];
}

async function expandSceneEntities(request: MemoryRetrieveRequest): Promise<string[]> {
	const db = getDb();
	const query = normalizeLookup(request.query);
	if (!query) return request.sceneEntityIds;

	const aliasRows = await db
		.select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
		.from(entityAliases)
		.where(and(
			eq(entityAliases.storyId, request.storyId),
			ilike(entityAliases.normalizedAlias, `%${query}%`),
		))
		.limit(12);

	const entityRows = await db
		.select({ id: entities.id, name: entities.name })
		.from(entities)
		.where(and(
			eq(entities.storyId, request.storyId),
			ilike(entities.name, `%${request.query}%`),
		))
		.limit(12);

	return [...new Set([
		...request.sceneEntityIds,
		...aliasRows.map((row) => row.entityId),
		...entityRows.map((row) => row.id),
	])];
}

async function candidateNodes(request: MemoryRetrieveRequest): Promise<MemoryNode[]> {
	const db = getDb();
	const sceneEntityIds = await expandSceneEntities(request);
	const sourceTypeFilter = request.sourceTypes?.length
		? inArray(memoryNodes.type, request.sourceTypes)
		: undefined;
	const visibilityFilter = request.includeSecret
		? undefined
		: or(eq(memoryNodes.visibility, 'public'), eq(memoryNodes.visibility, 'player_known'));

	const baseFilters = [
		eq(memoryNodes.storyId, request.storyId),
		visibilityFilter,
		sourceTypeFilter,
	].filter(Boolean);
	const expandedRequest = { ...request, sceneEntityIds };

	const broad = await db
		.select()
		.from(memoryNodes)
		.where(and(...baseFilters))
		.orderBy(desc(memoryNodes.importance), desc(memoryNodes.updatedAt))
		.limit(180);

	const textMatches = request.query.trim()
		? await db
			.select()
			.from(memoryNodes)
			.where(and(
				...baseFilters,
				or(
					ilike(memoryNodes.title, `%${request.query}%`),
					ilike(memoryNodes.content, `%${request.query}%`),
					sql`to_tsvector('english', coalesce(${memoryNodes.title}, '') || ' ' || coalesce(${memoryNodes.content}, '') || ' ' || coalesce(${memoryNodes.summary}, '')) @@ plainto_tsquery('english', ${request.query})`,
				),
			))
			.limit(80)
		: [];

	const vectorMatches = request.query.trim()
		? await vectorCandidateNodes(request, baseFilters)
		: [];

	const beliefRows = sceneEntityIds.length > 0
		? await db
			.select()
			.from(npcBeliefs)
			.where(and(
				eq(npcBeliefs.storyId, request.storyId),
				inArray(npcBeliefs.believerEntityId, sceneEntityIds),
				request.includeSecret ? undefined : or(eq(npcBeliefs.visibility, 'public'), eq(npcBeliefs.visibility, 'player_known')),
			))
			.limit(40)
		: [];

	const eventRows = request.query.trim()
		? await db
			.select()
			.from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, request.storyId),
				request.includeSecret ? undefined : or(eq(storyEvents.visibility, 'public'), eq(storyEvents.visibility, 'player_known')),
				or(
					ilike(storyEvents.title, `%${request.query}%`),
					ilike(storyEvents.body, `%${request.query}%`),
					sql`to_tsvector('english', coalesce(${storyEvents.title}, '') || ' ' || coalesce(${storyEvents.body}, '')) @@ plainto_tsquery('english', ${request.query})`,
				),
			))
			.limit(80)
		: await db
			.select()
			.from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, request.storyId),
				request.includeSecret ? undefined : or(eq(storyEvents.visibility, 'public'), eq(storyEvents.visibility, 'player_known')),
			))
			.orderBy(desc(storyEvents.updatedAt))
			.limit(40);

	const nodes = [
		...broad.map(toMemoryNode),
		...textMatches.map(toMemoryNode),
		...vectorMatches,
		...beliefRows.map(beliefToMemoryNode),
		...eventRows.map(eventToMemoryNode),
	].map((node) => ({
		...node,
		score: Math.max(node.score ?? 0, scoreMemoryNode(node, expandedRequest)),
	}));

	return dedupe(nodes);
}

async function vectorCandidateNodes(
	request: MemoryRetrieveRequest,
	baseFilters: Array<ReturnType<typeof eq> | ReturnType<typeof or> | undefined>,
): Promise<MemoryNode[]> {
	const config = memoryEmbeddingConfig();
	if (!config) return [];
	try {
		const queryVector = validateMemoryEmbeddingVector(await embedMemoryText(request.query, config), config.dimensions);
		const vectorLiteral = `[${queryVector.join(',')}]`;
		const rows = await getDb()
			.select()
			.from(memoryNodes)
			.where(and(
				...baseFilters,
				sql`${memoryNodes.embedding} is not null`,
			))
			.orderBy(sql`${memoryNodes.embedding} <=> ${vectorLiteral}::vector`)
			.limit(80);
		return rows.map((row, index) => ({
			...toMemoryNode(row),
			metadata: {
				...row.metadata,
				retrieval: {
					...(typeof row.metadata.retrieval === 'object' && row.metadata.retrieval !== null && !Array.isArray(row.metadata.retrieval) ? row.metadata.retrieval : {}),
					vectorScore: Math.max(0.2, 0.95 - (index * 0.006)),
				},
			},
		}));
	} catch (error) {
		console.warn('[BackendMemory] Vector retrieval unavailable; using text/ranking fallback:', error);
		return [];
	}
}

export async function retrieveMemoryPacket(input: unknown): Promise<RetrievedMemoryPacket> {
	const request = memoryRetrieveRequestSchema.parse(input);
	const nodes = await candidateNodes(request);
	const packet = buildMemoryPacket(nodes, request);
	return retrievedMemoryPacketSchema.parse({
		storyId: request.storyId,
		query: request.query,
		...packet,
	});
}
