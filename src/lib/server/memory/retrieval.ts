import { and, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { memoryNodes, entityAliases, entities, npcBeliefs, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
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
import { buildMemoryPacket, lookupMentioned, memoryQueryTokens, normalizeLookup, scoreMemoryNode } from './ranking';

type MemoryNodeRow = typeof memoryNodes.$inferSelect;
type NpcBeliefRow = typeof npcBeliefs.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;
type TranscriptEntryRow = Pick<typeof storyEntries.$inferSelect, 'id' | 'storyId' | 'type' | 'content' | 'position' | 'createdAt' | 'updatedAt'>;
type EntityLookup = { entityId: string; label: string };

const TRANSCRIPT_RECALL_ENTRY_LIMIT = 200;
const TRANSCRIPT_EXCERPT_CHAR_LIMIT = 1_400;

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

function transcriptExcerpt(value: string, queryTokens: string[]): string {
	const blocks = value.split(/\r?\n\s*\r?\n/).map((block) => block.replace(/\s+/g, ' ').trim()).filter(Boolean);
	const best = blocks
		.map((block, index) => {
			const blockTokens = memoryQueryTokens(block, 120);
			const hits = queryTokens.filter((queryToken) => blockTokens.some((blockToken) => blockToken === queryToken
				|| (Math.min(blockToken.length, queryToken.length) >= 5 && (blockToken.startsWith(queryToken) || queryToken.startsWith(blockToken))))).length;
			return { block, index, hits };
		})
		.sort((a, b) => (b.hits - a.hits) || (b.block.length - a.block.length) || (a.index - b.index))[0]?.block ?? value.replace(/\s+/g, ' ').trim();
	if (best.length <= TRANSCRIPT_EXCERPT_CHAR_LIMIT) return best;
	const positions = queryTokens.map((token) => best.toLowerCase().indexOf(token)).filter((position) => position >= 0).sort((a, b) => a - b);
	const center = positions[Math.floor(positions.length / 2)] ?? 0;
	const start = Math.max(0, Math.min(best.length - TRANSCRIPT_EXCERPT_CHAR_LIMIT, center - Math.floor(TRANSCRIPT_EXCERPT_CHAR_LIMIT / 3)));
	return `${start ? '... ' : ''}${best.slice(start, start + TRANSCRIPT_EXCERPT_CHAR_LIMIT).trim()}${start + TRANSCRIPT_EXCERPT_CHAR_LIMIT < best.length ? ' ...' : ''}`;
}

async function expandSceneEntities(request: MemoryRetrieveRequest): Promise<{ sceneEntityIds: string[]; entityLookups: EntityLookup[] }> {
	const db = getDb();
	const knownSceneIds = [...request.sceneEntityIds, ...request.presentNpcIds];
	if (!request.query.trim()) return { sceneEntityIds: [...new Set(knownSceneIds)], entityLookups: [] };

	// ponytail: bounded story-local scan; add normalized entity-name indexing only if this becomes measurable.
	const [aliasRows, entityRows] = await Promise.all([
		db.select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
			.from(entityAliases)
			.where(eq(entityAliases.storyId, request.storyId))
			.limit(500),
		db.select({ id: entities.id, name: entities.name })
			.from(entities)
			.where(eq(entities.storyId, request.storyId))
			.limit(240),
	]);

	const entityLookups = [
		...aliasRows.map((row) => ({ entityId: row.entityId, label: row.alias })),
		...entityRows.map((row) => ({ entityId: row.id, label: row.name })),
	];
	return {
		sceneEntityIds: [...new Set([
			...knownSceneIds,
			...entityLookups.filter((row) => lookupMentioned(request.query, row.label)).map((row) => row.entityId),
		])],
		entityLookups,
	};
}

export function transcriptMemoryCandidates(
	entries: TranscriptEntryRow[],
	request: MemoryRetrieveRequest,
	entityLookups: EntityLookup[],
): MemoryNode[] {
	const queryTokens = memoryQueryTokens(request.query);
	if (queryTokens.length === 0) return [];
	const sceneEntityIds = new Set(request.sceneEntityIds);
	const normalizedLookups = entityLookups
		.map((row) => ({ ...row, label: normalizeLookup(row.label) }))
		.filter((row) => row.label.length >= 3);

	// ponytail: scan at most 200 dialogue entries (100 exchanges); add transcript FTS only if this is measured slow.
	const candidates = entries.flatMap((entry): MemoryNode[] => {
		if (entry.type !== 'user_action' && entry.type !== 'narration') return [];
		const content = ` ${normalizeLookup(entry.content)} `;
		const keywords = queryTokens.filter((token) => content.includes(` ${token} `));
		const entityIds = [...new Set(normalizedLookups
			.filter((row) => content.includes(` ${row.label} `))
			.map((row) => row.entityId))];
		if (keywords.length === 0 && !entityIds.some((id) => sceneEntityIds.has(id))) return [];
		return [{
			id: `transcript_${entry.id}`,
			storyId: entry.storyId,
			type: 'episodic',
			title: entry.type === 'user_action' ? 'Earlier player action' : 'Earlier narration',
			content: transcriptExcerpt(entry.content, queryTokens),
			summary: null,
			keywords,
			entityIds,
			factionIds: [],
			threadIds: [],
			locationId: null,
			visibility: 'player_known',
			importance: 0.45,
			sourceEntryIds: [entry.id],
			sourceEventIds: [],
			sourcePatchIds: [],
			metadata: { retrieval: { source: 'transcript', position: entry.position } },
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
		}];
	});
	const lexicalMatches = candidates.filter((node) => node.keywords.length > 0);
	return lexicalMatches.length > 0 ? lexicalMatches : candidates;
}

async function candidateNodes(request: MemoryRetrieveRequest): Promise<{ nodes: MemoryNode[]; request: MemoryRetrieveRequest }> {
	const db = getDb();
	const { sceneEntityIds, entityLookups } = await expandSceneEntities(request);
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

	const transcriptRows = request.query.trim() && (!request.sourceTypes || request.sourceTypes.includes('episodic'))
		? await db
			.select()
			.from(storyEntries)
			.where(and(
				eq(storyEntries.storyId, request.storyId),
				inArray(storyEntries.type, ['user_action', 'narration']),
			))
			.orderBy(desc(storyEntries.position))
			.limit(TRANSCRIPT_RECALL_ENTRY_LIMIT)
		: [];

	const nodes = [
		...broad.map(toMemoryNode),
		...textMatches.map(toMemoryNode),
		...vectorMatches,
		...beliefRows.map(beliefToMemoryNode),
		...eventRows.map(eventToMemoryNode),
		...transcriptMemoryCandidates(transcriptRows, expandedRequest, entityLookups),
	].map((node) => ({
		...node,
		score: Math.max(node.score ?? 0, scoreMemoryNode(node, expandedRequest)),
	}));

	return { nodes: dedupe(nodes), request: expandedRequest };
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
	const [story] = request.currentTurn === undefined
		? await getDb().select({ currentTurn: stories.currentTurn }).from(stories).where(eq(stories.id, request.storyId)).limit(1)
		: [];
	const rankedRequest = { ...request, currentTurn: request.currentTurn ?? story?.currentTurn };
	const { nodes, request: expandedRequest } = await candidateNodes(rankedRequest);
	const packet = buildMemoryPacket(nodes, expandedRequest);
	return retrievedMemoryPacketSchema.parse({
		storyId: request.storyId,
		query: request.query,
		...packet,
	});
}
