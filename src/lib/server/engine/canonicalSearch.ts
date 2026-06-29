import { createHash } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { searchIndexRecords } from '$lib/server/db/schema';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import {
	embedMemoryText,
	memoryEmbeddingConfig,
	validateMemoryEmbeddingVector,
} from '$lib/server/memory/embeddings';
import { WORLD_RECORD_TYPES, listWorldRecords } from './worldRecords';

type JsonRecord = Record<string, unknown>;

export const INDEXABLE_TYPES = [
	'transcript',
	'entities',
	'factions',
	'factionMemberships',
	'factionResources',
	'factionGoals',
	'factionProjects',
	'agreements',
	'threads',
	'events',
	'patches',
	'chapters',
	'arcs',
	'sagas',
];
const EMBEDDING_TEXT_LIMIT = 2400;
const SEARCH_PAYLOAD_VERSION = 2;
const ENTITY_SECTION_TYPES: Record<string, string> = {
	characters: 'character',
	locations: 'location',
	items: 'item',
};

function nowIso(): string {
	return new Date().toISOString();
}

function q(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

function safeSegment(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'story';
}

export function canonicalSearchCollection(storyId: string): string {
	const config = getMtheriosAppConfig();
	return `${config.qdrantCollection}_${safeSegment(storyId).replace(/-/g, '_')}`;
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function uuidFromHash(hash: string): string {
	const clean = hash.padEnd(32, '0').slice(0, 32);
	return `${clean.slice(0, 8)}-${clean.slice(8, 12)}-4${clean.slice(13, 16)}-a${clean.slice(17, 20)}-${clean.slice(20, 32)}`;
}

function asStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function firstString(row: JsonRecord, keys: string[]): string {
	for (const key of keys) {
		const value = row[key];
		if (typeof value === 'string' && value.trim()) return value.trim();
	}
	return '';
}

function recordTitle(type: string, row: JsonRecord): string {
	return firstString(row, ['title', 'name', 'goal', 'terms', 'description', 'type'])
		|| `${type}/${String(row.id ?? row.record_id ?? 'record')}`;
}

function indexTypeFor(type: string): string {
	return ENTITY_SECTION_TYPES[type] ? 'entities' : type;
}

function semanticResultMatchesType(row: JsonRecord, type?: string | null): boolean {
	if (!type) return true;
	const payload = asRecord(row.payload);
	const indexedRecordType = typeof payload.recordType === 'string' ? payload.recordType : row.recordType;
	if (indexedRecordType !== indexTypeFor(type)) return false;
	const entityType = ENTITY_SECTION_TYPES[type];
	if (!entityType) return true;
	return payload.entityType == null || payload.entityType === entityType;
}

function sectionTypeForSemanticPayload(payload: JsonRecord, requestedType?: string | null): string {
	if (requestedType && WORLD_RECORD_TYPES[requestedType]) return requestedType;
	const recordType = typeof payload.recordType === 'string' ? payload.recordType : '';
	if (recordType === 'entities') {
		const entityType = typeof payload.entityType === 'string' ? payload.entityType : '';
		const section = Object.entries(ENTITY_SECTION_TYPES).find(([, type]) => type === entityType)?.[0];
		return section ?? recordType;
	}
	return recordType;
}

function compactList(value: unknown): string {
	return asStringArray(value).map((item) => item.trim()).filter(Boolean).join('; ');
}

function compactMergedList(...values: unknown[]): string {
	return [...new Set(values.flatMap((value) => asStringArray(value).map((item) => item.trim()).filter(Boolean)))].join('; ');
}

function characterString(state: JsonRecord, metadata: JsonRecord, keys: string[]): string {
	return firstString(state, keys) || firstString(metadata, keys);
}

function relationshipText(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	const relationship = asRecord(value);
	const status = typeof relationship.status === 'string' ? relationship.status.trim() : '';
	const level = typeof relationship.level === 'number' ? `level ${relationship.level}` : '';
	return [status, level].filter(Boolean).join(', ');
}

function characterSearchLines(row: JsonRecord): string[] {
	if (row.type !== 'character') return [];
	const state = asRecord(row.state);
	const metadata = asRecord(row.metadata);
	const stateEventMemory = asRecord(state.eventMemory ?? state.npcEventMemory);
	const metadataEventMemory = asRecord(metadata.eventMemory ?? metadata.npcEventMemory);
	const aliases = compactMergedList(state.aliases, metadata.aliases);
	const factionTags = compactMergedList(
		state.factionTags,
		state.faction_tags,
		metadata.factionTags,
		metadata.faction_tags,
	);
	const memoryDid = compactMergedList(metadataEventMemory.did, stateEventMemory.did);
	const memorySaw = compactMergedList(metadataEventMemory.saw, stateEventMemory.saw);
	const memoryKnew = compactMergedList(metadataEventMemory.knew, stateEventMemory.knew);
	const memoryKnows = compactMergedList(metadataEventMemory.knows, stateEventMemory.knows);
	const pressures = compactMergedList(state.pressures, metadata.pressures);
	const characterStatus = characterString(state, metadata, ['status']);
	const location = characterString(state, metadata, ['currentLocation', 'location']);
	const action = characterString(state, metadata, ['currentAction']);
	const emotion = characterString(state, metadata, ['emotionalState']);
	const relationship = relationshipText(state.relationship) || relationshipText(metadata.relationship);
	const appearance = characterString(state, metadata, ['appearance']);
	const background = characterString(state, metadata, ['background', 'bio']);
	const speechStyle = characterString(state, metadata, ['speechStyle', 'voice']);
	return [
		aliases ? `Aliases: ${aliases}` : '',
		typeof state.present === 'boolean' ? `Presence: ${state.present ? 'present' : 'not visible'}` : '',
		characterStatus ? `Character status: ${characterStatus}` : '',
		location ? `Current location: ${location}` : '',
		action ? `Current action: ${action}` : '',
		emotion ? `Emotional state: ${emotion}` : '',
		relationship ? `Relationship: ${relationship}` : '',
		appearance ? `Appearance: ${appearance}` : '',
		background ? `Background: ${background}` : '',
		compactMergedList(state.goals, metadata.goals) ? `Goals: ${compactMergedList(state.goals, metadata.goals)}` : '',
		speechStyle ? `Speech style: ${speechStyle}` : '',
		pressures ? `Pressures: ${pressures}` : '',
		factionTags ? `Faction tags: ${factionTags}` : '',
		memoryDid ? `Memory did: ${memoryDid}` : '',
		memorySaw ? `Memory saw: ${memorySaw}` : '',
		memoryKnew ? `Memory knew: ${memoryKnew}` : '',
		memoryKnows ? `Memory knows: ${memoryKnows}` : '',
	].filter(Boolean);
}

export function attachEntityAliasesForCanonicalSearch(rows: JsonRecord[], aliases: JsonRecord[]): JsonRecord[] {
	const byEntity = new Map<string, string[]>();
	for (const alias of aliases) {
		const entityId = String(alias.entity_id ?? alias.entityId ?? '');
		const value = typeof alias.alias === 'string' ? alias.alias.trim() : '';
		if (!entityId || !value) continue;
		const list = byEntity.get(entityId) ?? [];
		list.push(value);
		byEntity.set(entityId, list);
	}
	return rows.map((row) => {
		const recordId = String(row.id ?? '');
		const aliasesForEntity = byEntity.get(recordId);
		if (!aliasesForEntity?.length) return row;
		const state = asRecord(row.state);
		return {
			...row,
			state: {
				...state,
				aliases: [...new Set([...asStringArray(state.aliases), ...aliasesForEntity])],
			},
		};
	});
}

export function canonicalSearchRecordText(type: string, row: JsonRecord): string {
	const parts = [
		`Record type: ${type}`,
		`Title: ${recordTitle(type, row)}`,
		firstString(row, ['body', 'content', 'summary', 'description', 'scene_outcome', 'goal', 'terms', 'statement', 'details']),
		firstString(row, ['warningType', 'warning_type', 'proposalType', 'proposal_type', 'sourceType', 'source_type', 'targetTable', 'target_table', 'rationale', 'notes']),
		typeof row.status === 'string' ? `Status: ${row.status}` : '',
		typeof row.visibility === 'string' ? `Visibility: ${row.visibility}` : '',
		...characterSearchLines(row),
		`State: ${JSON.stringify(row.state ?? {})}`,
		`Metadata: ${JSON.stringify(row.metadata ?? {})}`,
	];
	return parts.filter(Boolean).join('\n\n').replace(/\s+\n/g, '\n').trim();
}

export function canonicalSearchEmbeddingText(text: string): string {
	if (text.length <= EMBEDDING_TEXT_LIMIT) return text;
	const marker = '\n\n[truncated for search indexing]';
	return `${text.slice(0, EMBEDDING_TEXT_LIMIT - marker.length).trimEnd()}${marker}`;
}

function sourceRefs(row: JsonRecord) {
	return {
		sourceEntryIds: asStringArray(row.source_entry_ids ?? row.sourceEntryIds),
		sourceEventIds: asStringArray(row.source_event_ids ?? row.sourceEventIds),
		sourcePatchIds: asStringArray(row.source_patch_ids ?? row.sourcePatchIds),
	};
}

function searchIndexRecordId(storyId: string, type: string, recordId: string, collection: string): string {
	return `search_${storyId}_${type}_${recordId}_${collection}`.replace(/[^a-zA-Z0-9_:-]+/g, '_').slice(0, 220);
}

async function qdrantRequest(path: string, init: RequestInit & { allow404?: boolean } = {}) {
	const config = getMtheriosAppConfig();
	const response = await fetch(`${config.qdrantUrl.replace(/\/$/, '')}${path}`, {
		...init,
		headers: {
			...(init.body ? { 'Content-Type': 'application/json' } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	if (response.status === 404 && init.allow404) return null;
	if (!response.ok) throw new Error(`Qdrant request failed (${response.status}): ${text.slice(0, 500)}`);
	return text ? JSON.parse(text) as JsonRecord : null;
}

async function ensureCollection(collection: string, dimensions: number, recreate = false): Promise<void> {
	if (recreate) {
		await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, { method: 'DELETE', allow404: true });
	}
	const current = await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, { allow404: true });
	if (current) return;
	await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, {
		method: 'PUT',
		body: JSON.stringify({
			vectors: {
				size: dimensions,
				distance: 'Cosine',
			},
		}),
	});
}

async function upsertPoint(collection: string, point: JsonRecord): Promise<void> {
	await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
		method: 'PUT',
		body: JSON.stringify({ points: [point] }),
	});
}

async function searchPoints(collection: string, vector: number[], limit: number): Promise<JsonRecord[]> {
	const data = await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points/search`, {
		method: 'POST',
		body: JSON.stringify({
			vector,
			limit,
			with_payload: true,
			with_vector: false,
		}),
		allow404: true,
	});
	return Array.isArray(data?.result) ? data.result as JsonRecord[] : [];
}

async function loadRows(storyId: string, type: string, recordId?: string | null): Promise<JsonRecord[]> {
	const spec = WORLD_RECORD_TYPES[type];
	if (!spec) return [];
	const requestedRecordId = recordId?.trim() ?? '';
	const filters = [
		sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`,
		...Object.entries(spec.fixedFilters ?? {}).map(([column, value]) => sql`${sql.raw(q(column))} = ${value}`),
	];
	if (requestedRecordId) filters.push(sql`${sql.raw(q(spec.idColumn))} = ${requestedRecordId}`);
	const rows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.join(filters, sql` and `)}
		order by ${sql.raw(q(spec.updatedColumn ?? spec.idColumn))} desc
		limit 2000
	`) as JsonRecord[];
	const filteredRows = requestedRecordId
		? rows.filter((row) => String(row[spec.idColumn] ?? row.id ?? '') === requestedRecordId)
		: rows;
	if (type !== 'entities' || filteredRows.length === 0) return filteredRows;
	const entityIds = filteredRows.map((row) => String(row.id ?? '')).filter(Boolean);
	if (!entityIds.length) return filteredRows;
	const aliasFilters = [
		sql`"story_id" = ${storyId}`,
		sql`"entity_id" in (${sql.join(entityIds.map((id) => sql`${id}`), sql`, `)})`,
	];
	const aliasRows = await getDb().execute(sql`
		select "entity_id", "alias"
		from "entity_aliases"
		where ${sql.join(aliasFilters, sql` and `)}
		limit 5000
	`) as JsonRecord[];
	return attachEntityAliasesForCanonicalSearch(filteredRows, aliasRows);
}

async function upsertIndexRow(input: {
	storyId: string;
	type: string;
	recordId: string;
	collection: string;
	contentHash: string;
	pointId: string | null;
	model: string | null;
	status: string;
	error?: string | null;
	sourceEntryIds?: string[];
	sourceEventIds?: string[];
	sourcePatchIds?: string[];
	metadata?: JsonRecord;
}) {
	const now = nowIso();
	await getDb().insert(searchIndexRecords).values({
		id: searchIndexRecordId(input.storyId, input.type, input.recordId, input.collection),
		storyId: input.storyId,
		recordType: input.type,
		recordId: input.recordId,
		qdrantPointId: input.pointId,
		collection: input.collection,
		contentHash: input.contentHash,
		model: input.model,
		status: input.status,
		error: input.error ?? null,
		indexedAt: input.status === 'indexed' ? now : null,
		sourceEntryIds: input.sourceEntryIds ?? [],
		sourceEventIds: input.sourceEventIds ?? [],
		sourcePatchIds: input.sourcePatchIds ?? [],
		metadata: { payloadVersion: SEARCH_PAYLOAD_VERSION, ...(input.metadata ?? {}) },
		createdAt: now,
		updatedAt: now,
	}).onConflictDoUpdate({
		target: searchIndexRecords.id,
		set: {
			qdrantPointId: input.pointId,
			contentHash: input.contentHash,
			model: input.model,
			status: input.status,
			error: input.error ?? null,
			indexedAt: input.status === 'indexed' ? now : null,
			sourceEntryIds: input.sourceEntryIds ?? [],
			sourceEventIds: input.sourceEventIds ?? [],
			sourcePatchIds: input.sourcePatchIds ?? [],
			metadata: { payloadVersion: SEARCH_PAYLOAD_VERSION, ...(input.metadata ?? {}) },
			updatedAt: now,
		},
	});
}

async function hasFreshIndexRow(input: {
	storyId: string;
	type: string;
	recordId: string;
	collection: string;
	contentHash: string;
	model: string;
}) {
	const [existing] = await getDb()
		.select({
			contentHash: searchIndexRecords.contentHash,
			model: searchIndexRecords.model,
			status: searchIndexRecords.status,
			qdrantPointId: searchIndexRecords.qdrantPointId,
			metadata: searchIndexRecords.metadata,
		})
		.from(searchIndexRecords)
		.where(eq(searchIndexRecords.id, searchIndexRecordId(input.storyId, input.type, input.recordId, input.collection)))
		.limit(1);
	return existing?.status === 'indexed'
		&& existing.contentHash === input.contentHash
		&& existing.model === input.model
		&& asRecord(existing.metadata).payloadVersion === SEARCH_PAYLOAD_VERSION
		&& typeof existing.qdrantPointId === 'string'
		&& existing.qdrantPointId.length > 0;
}

export async function indexCanonicalRecords(input: {
	storyId: string;
	recordTypes?: string[];
	recordId?: string | null;
	recreate?: boolean;
	maxRecords?: number;
}) {
	const config = memoryEmbeddingConfig();
	const collection = canonicalSearchCollection(input.storyId);
	const selectedTypes = (input.recordTypes?.length ? input.recordTypes : INDEXABLE_TYPES)
		.filter((type) => INDEXABLE_TYPES.includes(type));
	if (!config) {
		let skipped = 0;
		for (const type of selectedTypes) {
			for (const row of await loadRows(input.storyId, type, input.recordId)) {
				const recordId = String(row.id ?? '');
				if (!recordId) continue;
				const text = canonicalSearchRecordText(type, row);
				const refs = sourceRefs(row);
				await upsertIndexRow({
					storyId: input.storyId,
					type,
					recordId,
					collection,
					contentHash: hashText(text),
					pointId: null,
					model: null,
					status: 'skipped',
					error: 'Memory embeddings are not configured.',
					...refs,
				});
				skipped += 1;
			}
		}
		return { indexed: 0, skipped, collection, reason: 'embeddings_not_configured' };
	}

	await ensureCollection(collection, config.dimensions, input.recreate === true);
	let indexed = 0;
	let failed = 0;
	let skipped = 0;
	let processed = 0;
	const maxRecords = Math.max(1, Math.trunc(input.maxRecords ?? 40));
	for (const type of selectedTypes) {
		for (const row of await loadRows(input.storyId, type, input.recordId)) {
			const recordId = String(row.id ?? '');
			if (!recordId) continue;
			const text = canonicalSearchRecordText(type, row);
			const contentHash = hashText(text);
			const pointId = uuidFromHash(hashText(`${input.storyId}:${type}:${recordId}`));
			const refs = sourceRefs(row);
			if (!input.recreate && await hasFreshIndexRow({
				storyId: input.storyId,
				type,
				recordId,
				collection,
				contentHash,
				model: config.model,
			})) {
				skipped += 1;
				continue;
			}
			if (processed >= maxRecords) {
				return { indexed, failed, skipped, partial: true, collection, model: config.model };
			}
			processed += 1;
			try {
				const vector = validateMemoryEmbeddingVector(
					await embedMemoryText(canonicalSearchEmbeddingText(text), config),
					config.dimensions,
				);
				await upsertPoint(collection, {
					id: pointId,
					vector,
					payload: {
						kind: 'canonical_record',
						storyId: input.storyId,
						recordType: type,
						recordId,
						title: recordTitle(type, row),
						text: text.slice(0, 2400),
						visibility: row.visibility ?? row.secrecy ?? 'player_known',
						sourceEntryIds: refs.sourceEntryIds,
						sourceEventIds: refs.sourceEventIds,
						sourcePatchIds: refs.sourcePatchIds,
						status: row.status ?? null,
						entityType: row.type ?? null,
						position: row.position ?? null,
						updatedAt: row.updated_at ?? row.updatedAt ?? null,
					},
				});
				await upsertIndexRow({
					storyId: input.storyId,
					type,
					recordId,
					collection,
					contentHash,
					pointId,
					model: config.model,
					status: 'indexed',
					...refs,
				});
				indexed += 1;
			} catch (error) {
				await upsertIndexRow({
					storyId: input.storyId,
					type,
					recordId,
					collection,
					contentHash,
					pointId,
					model: config.model,
					status: 'failed',
					error: error instanceof Error ? error.message : String(error),
					...refs,
				});
				failed += 1;
			}
		}
	}
	return { indexed, failed, skipped, partial: false, collection, model: config.model };
}

export async function searchCanonicalWorld(input: {
	storyId: string;
	query: string;
	type?: string | null;
	limit?: number;
	includeSemantic?: boolean;
}) {
	const limit = Math.max(1, Math.min(50, Math.trunc(input.limit ?? 12)));
	const query = input.query.trim();
	const types = input.type && WORLD_RECORD_TYPES[input.type]
		? [input.type]
		: INDEXABLE_TYPES;
	const keywordResults: JsonRecord[] = [];
	for (const type of types) {
		const page = await listWorldRecords(input.storyId, { type, q: query, limit: Math.max(3, Math.ceil(limit / 2)) });
		for (const record of page.records) {
			keywordResults.push({
				source: 'keyword',
				score: 0.55,
				recordType: type,
				recordId: record.id,
				title: recordTitle(type, record),
				record,
			});
		}
		if (keywordResults.length >= limit) break;
	}

	let semanticResults: JsonRecord[] = [];
	if (query && input.includeSemantic !== false) {
		const config = memoryEmbeddingConfig();
		if (config) {
			try {
				const vector = validateMemoryEmbeddingVector(await embedMemoryText(query, config), config.dimensions);
				semanticResults = (await searchPoints(canonicalSearchCollection(input.storyId), vector, limit))
					.map((row) => {
						const payload = row.payload && typeof row.payload === 'object' ? row.payload as JsonRecord : {};
						return {
							source: 'semantic',
							score: row.score ?? 0,
							recordType: sectionTypeForSemanticPayload(payload, input.type),
							recordId: payload.recordId,
							title: payload.title,
							payload,
						};
					})
					.filter((row) => semanticResultMatchesType(row, input.type));
			} catch {
				semanticResults = [];
			}
		}
	}

	const byKey = new Map<string, JsonRecord>();
	for (const row of [...semanticResults, ...keywordResults]) {
		const key = `${row.recordType}:${row.recordId}`;
		const existing = byKey.get(key);
		if (!existing || Number(row.score ?? 0) > Number(existing.score ?? 0)) byKey.set(key, row);
	}
	return {
		storyId: input.storyId,
		query,
		results: [...byKey.values()]
			.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
			.slice(0, limit),
	};
}

export async function searchIndexStatus(storyId: string) {
	return getDb()
		.select()
		.from(searchIndexRecords)
		.where(eq(searchIndexRecords.storyId, storyId))
		.orderBy(searchIndexRecords.updatedAt);
}
