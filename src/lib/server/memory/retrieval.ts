import { and, desc, eq, getTableColumns, ilike, inArray, isNull, ne, not, or, sql, type SQLWrapper } from 'drizzle-orm';
import { agreements, memoryNodes, entityAliases, entities, factions, npcBeliefs, stories, storyEntries, storyEvents } from '$lib/server/db/schema';
import { isCurrentAgreement } from '$lib/contracts/agreements';
import { getDb } from '$lib/server/db/client';
import { englishTsQuery } from '$lib/server/db/textSearch';
import { isNarrativeTimelineEvent, storyEventNarrativeCanonCondition } from '$lib/server/events/timeline';
import { isWorldSimEligibleFaction } from '$lib/services/ai/context/factionEligibility';
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
import { isNarrativeCommandInput, NARRATIVE_COMMAND_PATTERN, NARRATIVE_CONTROL_PREFIX_PATTERN } from '$lib/services/ai/context/controlInput';
import { buildMemoryPacket, isOocControlText, lookupMentioned, MEMORY_REVISION_KEYS, MEMORY_SUPERSESSION_KEYS, memoryQueryTokens, normalizeLookup, relevantMemoryExcerpt, scoreMemoryNode } from './ranking';
import { retrieveMemorySource } from './retrievalSource';

type MemoryNodeRow = typeof memoryNodes.$inferSelect;
type NpcBeliefRow = typeof npcBeliefs.$inferSelect;
type StoryEventRow = typeof storyEvents.$inferSelect;
type TranscriptEntryRow = Pick<typeof storyEntries.$inferSelect, 'id' | 'storyId' | 'type' | 'content' | 'position' | 'createdAt' | 'updatedAt'> & {
	parentId?: string | null;
	metadata?: Record<string, unknown> | null;
	matchedQueryTokens?: string[];
};
type EntityLookup = { entityId: string; label: string };

const TRANSCRIPT_RECALL_ENTRY_LIMIT = 200;
const TRANSCRIPT_SEARCH_LIMIT = 80;
const TRANSCRIPT_EXCERPT_CHAR_LIMIT = 1_400;
const GENERATED_FACTION_MEMORY_SOURCE_TYPES = new Set([
	'terminal_faction_pressure_job',
	'terminal_world_sim_tick',
	'terminal_world_sim_signal',
]);
const REVISION_QUERY_PATTERN = /\b(?:after|before|earlier|old|previous|current|replaced|replace|correction|corrected|withdrawn|instead|now|valid)\b/i;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

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
		metadata: { believerEntityId: row.believerEntityId, confidence: row.confidence },
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

export function agreementToMemoryNode(row: typeof agreements.$inferSelect): MemoryNode {
	return {
		id: `agreement_memory_${row.id}`, storyId: row.storyId, type: 'plot_ledger',
		title: `${row.category}: ${row.parties.join(' + ')}`, content: row.terms, summary: row.terms,
		keywords: row.parties, entityIds: [], factionIds: [], threadIds: [], locationId: null,
		visibility: row.secrecy === 'secret' ? 'secret' : row.secrecy === 'public' ? 'public' : 'player_known',
		importance: 0.9, sourceEntryIds: row.sourceEntryIds, sourceEventIds: row.sourceEventIds, sourcePatchIds: row.sourcePatchIds,
		metadata: { recordKind: 'agreement', agreementId: row.id, agreementStatus: row.status, temporalState: isCurrentAgreement(row) ? 'current' : 'historical' },
		createdAt: row.createdAt, updatedAt: row.updatedAt,
	};
}

function eventToMemoryNode(row: StoryEventRow): MemoryNode {
	const correctionSourceEntryIds = row.type === 'correction' ? asStringArray(row.sourceEntryIds) : [];
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
		metadata: {
			...row.metadata,
			eventType: row.type,
			status: row.status,
			createdTurn: row.createdTurn,
			occurredTurn: row.occurredTurn,
			scheduledTurn: row.scheduledTurn,
			...(row.type === 'correction' ? {
				isCorrection: true,
				supersessionMarker: true,
				supersedesEntryIds: [
					...asStringArray(row.metadata.supersedesEntryIds),
					...correctionSourceEntryIds,
				],
			} : {}),
		},
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function retrievalIdentity(node: MemoryNode): string {
	const [eventId] = node.sourceEventIds;
	if (node.sourceEventIds.length === 1
		&& (node.id === `mem_event_${eventId}` || node.id === `event_memory_${eventId}`)) {
		return `event_projection:${node.storyId}:${eventId}`;
	}
	return `node:${node.id}`;
}

export function dedupeMemoryCandidates(nodes: MemoryNode[]): MemoryNode[] {
	const byIdentity = new Map<string, MemoryNode>();
	for (const node of nodes) {
		const identity = retrievalIdentity(node);
		const existing = byIdentity.get(identity);
		if (!existing) {
			byIdentity.set(identity, node);
			continue;
		}
		if (identity.startsWith('event_projection:')) {
			const live = node.id.startsWith('event_memory_') ? node : existing;
			byIdentity.set(identity, { ...live, score: Math.max(existing.score ?? 0, node.score ?? 0) });
		} else if ((node.score ?? 0) > (existing.score ?? 0)) {
			byIdentity.set(identity, node);
		}
	}
	return [...byIdentity.values()];
}

function generatedFactionIdsForMemory(node: MemoryNode): string[] {
	const metadata = record(node.metadata);
	if (!GENERATED_FACTION_MEMORY_SOURCE_TYPES.has(String(metadata.sourceType ?? '').trim())) return [];
	return [...new Set([
		...node.factionIds,
		typeof metadata.factionId === 'string' ? metadata.factionId : '',
	].filter(id => id.startsWith('faction_tag_')))];
}

export function filterIneligibleGeneratedFactionMemories(
	nodes: MemoryNode[],
	factionRows: Array<Pick<typeof factions.$inferSelect, 'id' | 'metadata'>>,
): MemoryNode[] {
	const eligibleIds = new Set(factionRows
		.filter(row => row.id.startsWith('faction_tag_') && isWorldSimEligibleFaction(row))
		.map(row => row.id));
	return nodes.filter(node => {
		const generatedFactionIds = generatedFactionIdsForMemory(node);
		return generatedFactionIds.length === 0 || generatedFactionIds.every(id => eligibleIds.has(id));
	});
}

function transcriptExcerpt(value: string, queryTokens: string[]): string {
	const blocks = value.split(/\r?\n\s*\r?\n/).map(block => block.trim()).filter(Boolean);
	const ranked = blocks.map((block, index) => {
		const words = normalizeLookup(block).split(/\s+/);
		return { block, index, hits: queryTokens.filter(token => words.some(word => word === token
			|| (Math.min(word.length, token.length) >= 5 && (word.startsWith(token) || token.startsWith(word))))).length };
	}).sort((a, b) => b.hits - a.hits || b.block.length - a.block.length || a.index - b.index);
	return relevantMemoryExcerpt(ranked[0]?.hits ? ranked[0].block : value, queryTokens, TRANSCRIPT_EXCERPT_CHAR_LIMIT);
}

function isNonCanonTranscriptEntry(entry: TranscriptEntryRow): boolean {
	return entry.metadata?.nonCanon === true
		|| entry.metadata?.non_canon === true
		|| String(entry.metadata?.actionType ?? entry.metadata?.action_type ?? '').toLowerCase() === 'ooc'
		|| String(entry.metadata?.narrativeMode ?? entry.metadata?.narrative_mode ?? '').toLowerCase() === 'ooc'
		|| isOocControlText(entry.content);
}

function isPairedControlEntry(entry: TranscriptEntryRow): boolean {
	return entry.metadata?.nonCanon === true
		|| entry.metadata?.non_canon === true
		|| String(entry.metadata?.actionType ?? entry.metadata?.action_type ?? '').toLowerCase() === 'ooc'
		|| String(entry.metadata?.narrativeMode ?? entry.metadata?.narrative_mode ?? '').toLowerCase() === 'ooc'
		|| (!isNarrativeCommandInput(entry.content) && isOocControlText(entry.content));
}

function transcriptMatchedQueryTokens(content: string, queryTokens: string[]): string[] {
	const words = normalizeLookup(content).split(/\s+/).filter(Boolean);
	return queryTokens.filter((token) => words.some((word) => word === token
		|| (Math.min(word.length, token.length) >= 5 && word.slice(0, 5) === token.slice(0, 5))));
}

async function expandSceneEntities(request: MemoryRetrieveRequest): Promise<{ sceneEntityIds: string[]; entityLookups: EntityLookup[]; scratchEntityIds: string[] }> {
	const db = getDb();
	const knownSceneIds = [...request.sceneEntityIds, ...request.presentNpcIds];
	if (!request.query.trim()) return { sceneEntityIds: [...new Set(knownSceneIds)], entityLookups: [], scratchEntityIds: [] };

	// ponytail: bounded story-local scan; add normalized entity-name indexing only if this becomes measurable.
	const [aliasRows, entityRows] = await Promise.all([
		db.select({ entityId: entityAliases.entityId, alias: entityAliases.alias })
			.from(entityAliases)
			.where(eq(entityAliases.storyId, request.storyId))
			.limit(500),
		db.select({ id: entities.id, name: entities.name, metadata: entities.metadata, state: entities.state })
			.from(entities)
			.where(eq(entities.storyId, request.storyId))
			.limit(240),
	]);

	const entityLookups = [
		...aliasRows.map((row) => ({ entityId: row.entityId, label: row.alias })),
		...entityRows.map((row) => ({ entityId: row.id, label: row.name })),
	];
	const scratchEntityIds = entityRows.filter((row) => {
		const metadata = row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata) ? row.metadata : {};
		const state = row.state && typeof row.state === 'object' && !Array.isArray(row.state) ? row.state : {};
		return metadata.scratchSeed === true || state.scratchSeed === true || row.id.startsWith('veil_scratch_');
	}).map((row) => row.id);
	return {
		// A name in the player's question is a retrieval lookup, not evidence that
		// the named actor occupies the current scene. Callers supply trusted scene
		// and present-NPC ids separately. Conflating the two gave every memory for
		// an off-screen sovereign the much stronger scene-entity boost.
		sceneEntityIds: [...new Set(knownSceneIds)],
		entityLookups,
		scratchEntityIds,
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
	const controlUserEntries = entries.filter((entry) => entry.type === 'user_action' && isPairedControlEntry(entry));
	const controlUserIds = new Set(controlUserEntries.map((entry) => entry.id));
	const controlUserPositions = new Set(controlUserEntries
		.map((entry) => entry.position));
	const seenNarration = new Set<string>();

	// Recent dialogue and bounded full-history matches share the same canon filter.
	const candidates = entries.flatMap((entry): MemoryNode[] => {
		if (entry.type !== 'user_action' && entry.type !== 'narration') return [];
		if (entry.storyId !== request.storyId) return [];
		const visibility = entry.metadata?.visibility === 'secret' || entry.metadata?.secrecy === 'secret' ? 'secret' : 'player_known';
		if (visibility === 'secret' && !request.includeSecret) return [];
		if (isNonCanonTranscriptEntry(entry)
			|| (entry.type === 'narration' && ((entry.parentId && controlUserIds.has(entry.parentId))
				|| controlUserPositions.has(entry.position - 1)))) return [];
		const content = ` ${normalizeLookup(entry.content)} `;
		if (entry.type === 'narration') {
			if (seenNarration.has(content)) return [];
			seenNarration.add(content);
		}
		const keywords = [...new Set([
			...queryTokens.filter((token) => content.includes(` ${token} `)),
			...(entry.matchedQueryTokens ?? []).filter((token) => queryTokens.includes(token)),
		])];
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
			visibility,
			importance: 0.45,
			sourceEntryIds: [entry.id],
			sourceEventIds: [],
			sourcePatchIds: [],
			metadata: {
				...(entry.metadata ?? {}),
				sourcePosition: entry.position,
				retrieval: { source: 'transcript', position: entry.position },
			},
			createdAt: entry.createdAt,
			updatedAt: entry.updatedAt,
		}];
	});
	const lexicalMatches = candidates.filter((node) => node.keywords.length > 0);
	return lexicalMatches.length > 0 ? lexicalMatches : candidates;
}

function transcriptControlCondition(row: { metadata: SQLWrapper; content: SQLWrapper }, includeCommands: boolean) {
	return or(
		sql`coalesce(${row.metadata}->>'nonCanon', 'false') = 'true'`,
		sql`coalesce(${row.metadata}->>'non_canon', 'false') = 'true'`,
		sql`lower(coalesce(${row.metadata}->>'actionType', ${row.metadata}->>'action_type', '')) = 'ooc'`,
		sql`lower(coalesce(${row.metadata}->>'narrativeMode', ${row.metadata}->>'narrative_mode', '')) = 'ooc'`,
		sql`${row.content} ~* ${NARRATIVE_CONTROL_PREFIX_PATTERN.source}`,
		includeCommands ? sql`${row.content} ~* ${NARRATIVE_COMMAND_PATTERN.source}` : undefined,
	)!;
}

async function transcriptRecallRows(request: MemoryRetrieveRequest): Promise<TranscriptEntryRow[]> {
	const db = getDb();
	const controlParents = await db.select({ id: storyEntries.id, position: storyEntries.position }).from(storyEntries).where(and(
		eq(storyEntries.storyId, request.storyId),
		eq(storyEntries.type, 'user_action'),
		transcriptControlCondition(storyEntries, false),
	));
	const controlParentIds = controlParents.map((row) => row.id);
	const controlNarrationPositions = controlParents.map((row) => row.position + 1);
	const filters = [
		eq(storyEntries.storyId, request.storyId),
		inArray(storyEntries.type, ['user_action', 'narration']),
		not(transcriptControlCondition(storyEntries, true)),
		request.includeSecret ? undefined : sql`coalesce(${storyEntries.metadata}->>'visibility', '') <> 'secret' and coalesce(${storyEntries.metadata}->>'secrecy', '') <> 'secret'`,
	];
	const nonControlParentFilters = [
		controlParentIds.length ? or(isNull(storyEntries.parentId), not(inArray(storyEntries.parentId, controlParentIds))) : undefined,
		controlNarrationPositions.length ? not(inArray(storyEntries.position, controlNarrationPositions)) : undefined,
	].filter(Boolean);
	if (nonControlParentFilters.length > 0) {
		filters.push(or(ne(storyEntries.type, 'narration'), and(...nonControlParentFilters)));
	}
	// Tokens are normalized alphanumerics; OR allows partial action/name matches.
	const queryTokens = memoryQueryTokens(request.query);
	const query = englishTsQuery(queryTokens.join(' | '));
	// The stored projection avoids rebuilding the same tsvector for every ranked
	// historical match. It is derived from content and intentionally omitted from
	// world-database exports; the canonical transcript remains the source of truth.
	const document = sql`content_search_vector`;
	const [recent, matches] = await Promise.all([
		db.select().from(storyEntries).where(and(...filters))
			.orderBy(desc(storyEntries.position)).limit(TRANSCRIPT_RECALL_ENTRY_LIMIT),
		(async () => {
			const rows = await db.select().from(storyEntries).where(and(...filters, sql`${document} @@ ${query}`))
				.orderBy(desc(sql`ts_rank_cd(${document}, ${query})`), desc(storyEntries.position)).limit(TRANSCRIPT_SEARCH_LIMIT);
			// PostgreSQL has already established the FTS match. Reconstruct only
			// the tokens present in each row so unrelated question words do not
			// receive a false keyword boost.
			return rows.map((row) => ({ ...row, matchedQueryTokens: transcriptMatchedQueryTokens(row.content, queryTokens) }));
		})(),
	]);
	const selected = [...new Map([...recent, ...matches].map(row => [row.id, row])).values()];
	const parentIds = selected.flatMap(row => row.type === 'narration' && row.parentId ? [row.parentId] : []);
	const parentPositions = selected.filter(row => row.type === 'narration').map(row => row.position - 1);
	// Sparse matches must still bring their control parent, including legacy rows
	// whose relationship is recorded only by adjacent transcript positions.
	const parents = parentIds.length || parentPositions.length ? await db.select().from(storyEntries).where(and(
		eq(storyEntries.storyId, request.storyId),
		eq(storyEntries.type, 'user_action'),
		or(parentIds.length ? inArray(storyEntries.id, parentIds) : undefined,
			parentPositions.length ? inArray(storyEntries.position, parentPositions) : undefined),
	)) : [];
	return [...new Map([...parents, ...selected].map(row => [row.id, row])).values()]
		.sort((a, b) => b.position - a.position);
}

async function candidateNodes(request: MemoryRetrieveRequest): Promise<{ nodes: MemoryNode[]; request: MemoryRetrieveRequest; debug: string[] }> {
	const db = getDb();
	const hadQuery = Boolean(request.query.trim());
	const searchRequest = { ...request, query: memoryQueryTokens(request.query).join(' ') };
	const { sceneEntityIds, entityLookups, scratchEntityIds } = await expandSceneEntities(searchRequest);
	const scratchEntityIdSet = new Set(scratchEntityIds);
	const sourceTypeFilter = request.sourceTypes?.length
		? inArray(memoryNodes.type, request.sourceTypes)
		: undefined;
	const visibilityFilter = request.includeSecret
		? undefined
		: or(eq(memoryNodes.visibility, 'public'), eq(memoryNodes.visibility, 'player_known'));

	const baseFilters = [
		eq(memoryNodes.storyId, request.storyId),
		sql`coalesce(${memoryNodes.metadata}->>'playerDeleted', 'false') != 'true'`,
		// A rebuilt/vector-backed plot ledger must not resurrect a manually closed thread.
		sql`not (${memoryNodes.type} = 'plot_ledger' and exists (
			select 1 from story_threads t where t.story_id = ${request.storyId}
			and t.status in ('closed', 'abandoned', 'resolved') and ${memoryNodes.threadIds} ? t.id
		))`,
		visibilityFilter,
		sourceTypeFilter,
	].filter(Boolean);
	const expandedRequest = { ...searchRequest, sceneEntityIds };
	const debug: string[] = [];
	const revisionQuery = REVISION_QUERY_PATTERN.test(request.query);
	// Match any meaningful term; score term coverage before the candidate cap.
	const lexicalQuery = englishTsQuery(memoryQueryTokens(request.query).join(' | '));
	const lexicalDocument = sql`setweight(to_tsvector('english', coalesce(${memoryNodes.title}, '')), 'A') || to_tsvector('english', coalesce(${memoryNodes.content}, '') || ' ' || coalesce(${memoryNodes.summary}, ''))`;

	const [broad, textMatches, vectorMatches, beliefRows, eventRows, transcriptRows, agreementRows, revisionRows] = await Promise.all([
		retrieveMemorySource('Canonical memory', () => db
		.select()
		.from(memoryNodes)
		.where(and(...baseFilters))
		.orderBy(desc(memoryNodes.importance), desc(memoryNodes.updatedAt))
		.limit(180), debug),

		retrieveMemorySource('Lexical memory', async () => searchRequest.query
		? await db
			.select()
			.from(memoryNodes)
			.where(and(
				...baseFilters,
				or(
					ilike(memoryNodes.title, `%${searchRequest.query}%`),
					ilike(memoryNodes.content, `%${searchRequest.query}%`),
					sql`(${lexicalDocument}) @@ ${lexicalQuery}`,
				),
			))
			.orderBy(desc(sql`ts_rank_cd((${lexicalDocument}), ${lexicalQuery})`), desc(memoryNodes.importance), memoryNodes.id)
			.limit(80)
		: [], debug),

		retrieveMemorySource('Vector memory', async signal => searchRequest.query && request.includeSemantic !== false
		? await vectorCandidateNodes(searchRequest, baseFilters, signal)
		: [], debug, 1_200),

		retrieveMemorySource('Character beliefs', async () => sceneEntityIds.length > 0
		? await db
			.select()
			.from(npcBeliefs)
			.where(and(
				eq(npcBeliefs.storyId, request.storyId),
				inArray(npcBeliefs.believerEntityId, sceneEntityIds),
				request.includeSecret ? undefined : or(eq(npcBeliefs.visibility, 'public'), eq(npcBeliefs.visibility, 'player_known')),
			))
			.limit(40)
		: [], debug),

		retrieveMemorySource('Timeline memory', async () => searchRequest.query
		? await db
			.select()
			.from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, request.storyId),
				storyEventNarrativeCanonCondition(),
				request.includeSecret ? undefined : or(eq(storyEvents.visibility, 'public'), eq(storyEvents.visibility, 'player_known')),
				or(
					eq(storyEvents.type, 'correction'),
					ilike(storyEvents.title, `%${searchRequest.query}%`),
					ilike(storyEvents.body, `%${searchRequest.query}%`),
					sql`to_tsvector('english', coalesce(${storyEvents.title}, '') || ' ' || coalesce(${storyEvents.body}, '')) @@ ${englishTsQuery(searchRequest.query, 'plain')}`,
				),
			))
			.limit(80)
		: hadQuery ? [] : await db
			.select()
			.from(storyEvents)
			.where(and(
				eq(storyEvents.storyId, request.storyId),
				storyEventNarrativeCanonCondition(),
				request.includeSecret ? undefined : or(eq(storyEvents.visibility, 'public'), eq(storyEvents.visibility, 'player_known')),
			))
			.orderBy(desc(storyEvents.updatedAt))
			.limit(40), debug),

		retrieveMemorySource('Transcript recall', async () => searchRequest.query && (!request.sourceTypes || request.sourceTypes.includes('episodic'))
		? await transcriptRecallRows(searchRequest)
		: [], debug),

		retrieveMemorySource('Agreement memory', async () => (!request.sourceTypes || request.sourceTypes.includes('plot_ledger'))
			? await db.select().from(agreements).where(and(
				eq(agreements.storyId, request.storyId), ne(agreements.status, 'deleted'), request.includeSecret ? undefined : ne(agreements.secrecy, 'secret'),
				searchRequest.query ? sql`to_tsvector('english', ${agreements.terms} || ' ' || ${agreements.parties}::text)
					@@ ${englishTsQuery(memoryQueryTokens(searchRequest.query).join(' | '))}` : undefined,
			)).orderBy(desc(agreements.updatedAt)).limit(40) : [], debug),

		retrieveMemorySource('Revision memory', async () => revisionQuery
			? await db.select().from(memoryNodes).where(and(
				...baseFilters,
				or(
					sql`${memoryNodes.metadata} ? 'supersedesId'`,
					sql`${memoryNodes.metadata} ? 'supersedesIds'`,
					sql`${memoryNodes.metadata} ? 'replacesId'`,
					sql`${memoryNodes.metadata} ? 'replacesIds'`,
					sql`${memoryNodes.metadata} ? 'correctionKey'`,
					sql`${memoryNodes.metadata} ? 'supersessionKey'`,
				),
			)).orderBy(desc(memoryNodes.updatedAt), desc(memoryNodes.importance)).limit(80)
			: [], debug),
	]);

	const rawNodes = [
		...broad.map(toMemoryNode),
		...textMatches.map(toMemoryNode),
		...vectorMatches,
		...beliefRows.map(beliefToMemoryNode),
		...eventRows.filter(isNarrativeTimelineEvent).map(eventToMemoryNode),
		...transcriptMemoryCandidates(transcriptRows, expandedRequest, entityLookups),
		...agreementRows.map(agreementToMemoryNode),
		...revisionRows.map(toMemoryNode),
	];
	// Corrections are dependencies, not optional search hits. Follow explicit links
	// even when the correction has no query words or falls outside the broad cap.
	// Never guess semantic equivalence or rewrite the underlying historical evidence.
	const knownIds = new Set(rawNodes.map(node => node.id));
	const initialCount = knownIds.size;
	let frontier = rawNodes;
	for (let round = 0; frontier.length; round++) {
		if (round === 4) throw new Error('Memory correction chain exceeds the safe retrieval limit.');
		const corrections = await db.select().from(memoryNodes).where(and(
			...baseFilters,
			memoryCorrectionCondition(frontier),
		)).orderBy(desc(memoryNodes.updatedAt), memoryNodes.id).limit(1001);
		if (corrections.length > 1000) throw new Error('Too many linked memory corrections to resolve safely.');
		frontier = corrections.filter(row => !knownIds.has(row.id)).map(toMemoryNode);
		for (const node of frontier) knownIds.add(node.id);
		rawNodes.push(...frontier);
	}
	if (knownIds.size > initialCount) debug.push(`Resolved ${knownIds.size - initialCount} linked memory revision(s) before ranking.`);
	const generatedFactionIds = [...new Set(rawNodes.flatMap(generatedFactionIdsForMemory))];
	const generatedFactionRows = generatedFactionIds.length > 0
		? await db.select({ id: factions.id, metadata: factions.metadata })
			.from(factions)
			.where(and(eq(factions.storyId, request.storyId), inArray(factions.id, generatedFactionIds)))
			.limit(generatedFactionIds.length)
		: [];
	const nodes = filterIneligibleGeneratedFactionMemories(rawNodes, generatedFactionRows).map((node) => {
		const scratchEntityMatch = node.entityIds.length > 0 && node.entityIds.every((id) => scratchEntityIdSet.has(id));
		const metadata: Record<string, unknown> = node.metadata && typeof node.metadata === 'object' && !Array.isArray(node.metadata)
			? node.metadata as Record<string, unknown>
			: {};
		const retrieval = metadata.retrieval && typeof metadata.retrieval === 'object' && !Array.isArray(metadata.retrieval)
			? metadata.retrieval as Record<string, unknown>
			: {};
		const rankedNode = scratchEntityMatch ? {
			...node,
			metadata: { ...metadata, retrieval: { ...retrieval, scratchEntityMatch: true } },
		} : node;
		return {
			...rankedNode,
			score: Math.max(rankedNode.score ?? 0, scoreMemoryNode(rankedNode, expandedRequest)),
		};
	});

	return { nodes: dedupeMemoryCandidates(nodes), request: expandedRequest, debug };
}

export function memoryCorrectionCondition(nodes: MemoryNode[]) {
	const ids = [...new Set(nodes.flatMap(node => [node.id, ...node.sourceEntryIds, ...node.sourceEventIds, ...node.sourcePatchIds]))];
	const targets = sql`array(select jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;
	const references = MEMORY_SUPERSESSION_KEYS.map(key => sql`(
		${memoryNodes.metadata}->>${key} = any(${targets})
		or (${memoryNodes.metadata}->${key}) ?| ${targets}
	)`);
	const topics = MEMORY_REVISION_KEYS.flatMap(key => {
		const values = [...new Set(nodes.flatMap(node => {
			const value = record(node.metadata)[key];
			return typeof value === 'string' && value.trim() ? [value.trim()] : [];
		}))];
		return values.length ? [sql`btrim(${memoryNodes.metadata}->>${key}) in (${sql.join(values.map(value => sql`${value}`), sql`, `)})`] : [];
	});
	return or(...references, ...topics);
}

async function vectorCandidateNodes(
	request: MemoryRetrieveRequest,
	baseFilters: Array<ReturnType<typeof eq> | ReturnType<typeof or> | undefined>,
	signal: AbortSignal,
): Promise<MemoryNode[]> {
	const config = memoryEmbeddingConfig();
	if (!config) return [];
	const queryVector = validateMemoryEmbeddingVector(await embedMemoryText(request.query, config, signal), config.dimensions);
	signal.throwIfAborted();
	const vectorLiteral = `[${queryVector.join(',')}]`;
	const distance = sql<number>`${memoryNodes.embedding} <=> ${vectorLiteral}::vector`;
	const rows = await getDb()
		.select({ ...getTableColumns(memoryNodes), cosineDistance: distance })
		.from(memoryNodes)
		.where(and(
			...baseFilters,
			sql`${memoryNodes.embedding} is not null`,
		))
		.orderBy(distance)
		.limit(80);
	return rows.map((row) => ({
		...toMemoryNode(row),
		metadata: {
			...row.metadata,
			retrieval: {
				...(typeof row.metadata.retrieval === 'object' && row.metadata.retrieval !== null && !Array.isArray(row.metadata.retrieval) ? row.metadata.retrieval : {}),
				vectorScore: Math.max(0, Math.min(1, 1 - Number(row.cosineDistance))),
				cosineDistance: Number(row.cosineDistance),
			},
		},
	}));
}

const inFlightRetrievals = new Map<string, Promise<RetrievedMemoryPacket>>();

export async function retrieveMemoryPacket(input: unknown): Promise<RetrievedMemoryPacket> {
	const request = memoryRetrieveRequestSchema.parse(input);
	const [story] = await getDb().select({
		currentTurn: stories.currentTurn,
		currentLocationId: stories.currentLocationId,
	}).from(stories).where(eq(stories.id, request.storyId)).limit(1);
	const rankedRequest = withAuthoritativeStoryAnchor(request, story ?? null);
	const key = JSON.stringify(rankedRequest);
	const active = inFlightRetrievals.get(key);
	if (active) return active;

	const task = (async () => {
		const { nodes, request: expandedRequest, debug } = await candidateNodes(rankedRequest);
		const packet = buildMemoryPacket(nodes, expandedRequest);
		return retrievedMemoryPacketSchema.parse({
			storyId: request.storyId,
			query: request.query,
			...packet,
			retrievalDebug: [...packet.retrievalDebug, ...debug.sort()],
		});
	})();
	inFlightRetrievals.set(key, task);
	try {
		return await task;
	} finally {
		if (inFlightRetrievals.get(key) === task) inFlightRetrievals.delete(key);
	}
}

export function withAuthoritativeStoryAnchor(
	request: MemoryRetrieveRequest,
	story: { currentTurn: number; currentLocationId: string | null } | null,
): MemoryRetrieveRequest {
	if (!story) return request;
	const staleClientLocationId = request.locationId && request.locationId !== story.currentLocationId
		? request.locationId
		: null;
	return {
		...request,
		currentTurn: request.currentTurn ?? story.currentTurn,
		locationId: story.currentLocationId,
		sceneEntityIds: [...new Set([
			...request.sceneEntityIds.filter((id) => id !== staleClientLocationId),
			...(story.currentLocationId ? [story.currentLocationId] : []),
		])],
	};
}
