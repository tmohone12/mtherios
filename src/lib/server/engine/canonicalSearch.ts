import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { withQdrantCollectionLock } from '../../../../scripts/wiki-core/lib/collection-lock.mjs';
import { getDb } from '$lib/server/db/client';
import { searchIndexRecords } from '$lib/server/db/schema';
import { getMtheriosAppConfig } from '$lib/server/app/config';
import { isNarrativeCommandInput, isNarrativeControlInput } from '$lib/services/ai/context/controlInput';
import {
	embedMemoryText,
	memoryEmbeddingConfig,
	validateMemoryEmbeddingVector,
} from '$lib/server/memory/embeddings';
import { WORLD_RECORD_TYPES, listWorldRecords } from './worldRecords';
import { storyScopedCollection } from '$lib/server/wiki/storyIdentity';

type JsonRecord = Record<string, unknown>;

export const INDEXABLE_TYPES = [
	'transcript',
	'entities',
	'relationships',
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
const LOAD_PAGE_SIZE = 500;
const SEARCH_PAYLOAD_VERSION = 2;
const SEARCH_INDEX_ID_LIMIT = 220;
const SEARCH_INDEX_ID_HASH_LENGTH = 16;
const PAIRED_CONTROL_RESPONSE_KEY = '__mtheriosPairedControlResponse';
const ENTITY_SECTION_TYPES: Record<string, string> = {
	characters: 'character',
	locations: 'location',
	items: 'item',
	concepts: 'concept',
};
const UNUSABLE_STATUSES: Record<string, ReadonlySet<string>> = {
	entities: new Set(['inactive', 'archived']),
	events: new Set(['cancelled']),
	agreements: new Set(['archived', 'deleted']),
	patches: new Set(['rejected']),
	threads: new Set(['closed']),
};

function nowIso(): string {
	return new Date().toISOString();
}

function q(identifier: string): string {
	return `"${identifier.replace(/"/g, '""')}"`;
}

export function canonicalSearchCollection(storyId: string): string {
	const config = getMtheriosAppConfig();
	return storyScopedCollection(config.qdrantCollection, storyId);
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
	return firstString(row, ['title', 'name', 'goal', 'project', 'belief', 'terms', 'description', 'label', 'type'])
		|| `${type}/${String(row.id ?? row.record_id ?? 'record')}`;
}

function indexTypeFor(type: string): string {
	return ENTITY_SECTION_TYPES[type] ? 'entities' : type;
}

export function canonicalSearchRecordIsUsable(type: string, row: JsonRecord): boolean {
	const metadata = asRecord(row.metadata);
	if (metadata.playerDeleted === true) return false;
	const actionType = firstString(metadata, ['actionType', 'action_type']) || firstString(row, ['actionType', 'action_type']);
	const narrativeMode = firstString(metadata, ['narrativeMode', 'narrative_mode']) || firstString(row, ['narrativeMode', 'narrative_mode']);
	const mergedInto = firstString(metadata, ['mergedInto', 'merged_into']) || firstString(row, ['mergedInto', 'merged_into']);
	const status = firstString(row, ['status']).toLowerCase();
	if (metadata.nonCanon === true || metadata.non_canon === true || row.nonCanon === true || row.non_canon === true) return false;
	if (row[PAIRED_CONTROL_RESPONSE_KEY] === true) return false;
	if (actionType.toLowerCase() === 'ooc' || narrativeMode.toLowerCase() === 'ooc') return false;
	if (['transcript', 'memoryNodes'].includes(indexTypeFor(type))
		&& ['content', 'summary', 'title'].some((key) => typeof row[key] === 'string'
			&& (isNarrativeControlInput(row[key] as string) || isNarrativeCommandInput(row[key] as string)))) return false;
	if (mergedInto || status === 'merged') return false;
	return !UNUSABLE_STATUSES[indexTypeFor(type)]?.has(status);
}

function isTranscriptControlRecord(row: JsonRecord): boolean {
	const metadata = asRecord(row.metadata);
	const actionType = firstString(metadata, ['actionType', 'action_type']) || firstString(row, ['actionType', 'action_type']);
	const narrativeMode = firstString(metadata, ['narrativeMode', 'narrative_mode']) || firstString(row, ['narrativeMode', 'narrative_mode']);
	return metadata.nonCanon === true
		|| metadata.non_canon === true
		|| row.nonCanon === true
		|| row.non_canon === true
		|| actionType.toLowerCase() === 'ooc'
		|| narrativeMode.toLowerCase() === 'ooc'
		|| isNarrativeControlInput(firstString(row, ['content']));
}

export function markPairedTranscriptControlResponses(rows: JsonRecord[], parentRows: JsonRecord[]): JsonRecord[] {
	const controlParentIds = new Set(parentRows
		.filter(isTranscriptControlRecord)
		.map((row) => String(row.id ?? ''))
		.filter(Boolean));
	if (controlParentIds.size === 0) return rows;
	return rows.map((row) => String(row.type ?? '') === 'narration'
		&& controlParentIds.has(firstString(row, ['parent_id', 'parentId']))
		? { ...row, [PAIRED_CONTROL_RESPONSE_KEY]: true }
		: row);
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
	const relationshipLines = type === 'relationships' ? [
		`Source entity: ${String(row.source_entity_id ?? row.sourceEntityId ?? '')}`,
		`Target entity: ${String(row.target_entity_id ?? row.targetEntityId ?? '')}`,
		`Relationship type: ${String(row.type ?? '')}`,
		typeof row.label === 'string' && row.label.trim() ? `Relationship label: ${row.label.trim()}` : '',
		typeof row.strength === 'number' ? `Relationship strength: ${row.strength}` : '',
	] : [];
	const parts = [
		`Record type: ${type}`,
		`Title: ${recordTitle(type, row)}`,
		firstString(row, ['body', 'content', 'summary', 'description', 'scene_outcome', 'goal', 'terms', 'statement', 'details']),
		firstString(row, ['warningType', 'warning_type', 'proposalType', 'proposal_type', 'sourceType', 'source_type', 'targetTable', 'target_table', 'rationale', 'notes']),
		typeof row.status === 'string' ? `Status: ${row.status}` : '',
		typeof row.visibility === 'string' ? `Visibility: ${row.visibility}` : '',
		...relationshipLines,
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

function normalizedSearchIndexRecordId(storyId: string, type: string, recordId: string, collection: string): string {
	return `search_${storyId}_${type}_${recordId}_${collection}`.replace(/[^a-zA-Z0-9_:-]+/g, '_');
}

export function canonicalSearchIndexRecordId(storyId: string, type: string, recordId: string, collection: string): string {
	const normalized = normalizedSearchIndexRecordId(storyId, type, recordId, collection);
	if (normalized.length <= SEARCH_INDEX_ID_LIMIT) return normalized;
	const suffix = `_${hashText(normalized).slice(0, SEARCH_INDEX_ID_HASH_LENGTH)}`;
	return `${normalized.slice(0, SEARCH_INDEX_ID_LIMIT - suffix.length)}${suffix}`;
}

function legacySearchIndexRecordId(storyId: string, type: string, recordId: string, collection: string): string {
	return normalizedSearchIndexRecordId(storyId, type, recordId, collection).slice(0, SEARCH_INDEX_ID_LIMIT);
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

async function ensureCanonicalSearchCollectionUnlocked(
	collection: string,
	dimensions: number,
): Promise<boolean> {
	const current = await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, { allow404: true });
	if (current) return false;
	await qdrantRequest(`/collections/${encodeURIComponent(collection)}`, {
		method: 'PUT',
		body: JSON.stringify({
			vectors: {
				size: dimensions,
				distance: 'Cosine',
			},
		}),
	});
	return true;
}

export async function ensureCanonicalSearchCollection(collection: string, dimensions: number): Promise<boolean> {
	const config = getMtheriosAppConfig();
	return withQdrantCollectionLock(
		{ url: config.qdrantUrl, collection },
		() => ensureCanonicalSearchCollectionUnlocked(collection, dimensions),
	);
}

async function upsertPoint(collection: string, point: JsonRecord): Promise<void> {
	await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points?wait=true`, {
		method: 'PUT',
		body: JSON.stringify({ points: [point] }),
	});
}

async function searchPoints(
	collection: string,
	vector: number[],
	limit: number,
	storyId: string,
	type?: string | null,
): Promise<JsonRecord[]> {
	const must: JsonRecord[] = [
		{ key: 'kind', match: { value: 'canonical_record' } },
		{ key: 'storyId', match: { value: storyId } },
	];
	if (type) {
		must.push({ key: 'recordType', match: { value: indexTypeFor(type) } });
		if (ENTITY_SECTION_TYPES[type]) must.push({ key: 'entityType', match: { value: ENTITY_SECTION_TYPES[type] } });
	}
	const data = await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points/search`, {
		method: 'POST',
		body: JSON.stringify({
			vector,
				limit,
				with_payload: true,
				with_vector: false,
				filter: { must },
		}),
		allow404: true,
	});
	if (!data) throw new Error(`Canonical semantic index is missing: ${collection}`);
	return Array.isArray(data?.result) ? data.result as JsonRecord[] : [];
}

async function deleteCanonicalPoints(
	collection: string,
	storyId: string,
	recordTypes: string[],
	recordId?: string | null,
): Promise<void> {
	for (const recordType of recordTypes) {
		const must: JsonRecord[] = [
			{ key: 'kind', match: { value: 'canonical_record' } },
			{ key: 'storyId', match: { value: storyId } },
			{ key: 'recordType', match: { value: recordType } },
		];
		if (recordId) must.push({ key: 'recordId', match: { value: recordId } });
		await qdrantRequest(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
			method: 'POST',
			body: JSON.stringify({ filter: { must } }),
			allow404: true,
		});
	}
}

async function retireCanonicalRecord(input: {
	storyId: string;
	type: string;
	recordId: string;
	collection: string;
	deletePoint: boolean;
}): Promise<void> {
	await getDb().delete(searchIndexRecords).where(and(
		eq(searchIndexRecords.storyId, input.storyId),
		eq(searchIndexRecords.recordType, input.type),
		eq(searchIndexRecords.recordId, input.recordId),
		eq(searchIndexRecords.collection, input.collection),
	));
	if (input.deletePoint) {
		await deleteCanonicalPoints(input.collection, input.storyId, [indexTypeFor(input.type)], input.recordId);
	}
}

async function* loadRows(storyId: string, type: string, recordId?: string | null): AsyncGenerator<JsonRecord> {
	const spec = WORLD_RECORD_TYPES[type];
	if (!spec) return;
	const requestedRecordId = recordId?.trim() ?? '';
	const filters = [
		sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`,
		...Object.entries(spec.fixedFilters ?? {}).map(([column, value]) => sql`${sql.raw(q(column))} = ${value}`),
	];
	if (requestedRecordId) filters.push(sql`${sql.raw(q(spec.idColumn))} = ${requestedRecordId}`);
	let offset = 0;
	while (true) {
		const rows = await getDb().execute(sql`
			select *
			from ${sql.raw(q(spec.table))}
			where ${sql.join(filters, sql` and `)}
			order by ${sql.raw(q(spec.updatedColumn ?? spec.idColumn))} desc, ${sql.raw(q(spec.idColumn))} desc
			limit ${LOAD_PAGE_SIZE}
			offset ${offset}
		`) as JsonRecord[];
		let page = requestedRecordId
			? rows.filter((row) => String(row[spec.idColumn] ?? row.id ?? '') === requestedRecordId)
			: rows;
		page = await markTranscriptControlPairs(storyId, type, page);
		if (type === 'entities' && page.length > 0) {
			const entityIds = page.map((row) => String(row.id ?? '')).filter(Boolean);
			if (entityIds.length > 0) {
				const aliasRows = await getDb().execute(sql`
					select "entity_id", "alias"
					from "entity_aliases"
					where "story_id" = ${storyId}
						and "entity_id" in (${sql.join(entityIds.map((id) => sql`${id}`), sql`, `)})
				`) as JsonRecord[];
				page = attachEntityAliasesForCanonicalSearch(page, aliasRows);
			}
		}
		for (const row of page) yield row;
		if (requestedRecordId || rows.length < LOAD_PAGE_SIZE) return;
		offset += rows.length;
	}
}

async function markTranscriptControlPairs(storyId: string, type: string, rows: JsonRecord[]): Promise<JsonRecord[]> {
	if (type !== 'transcript' || rows.length === 0) return rows;
	const parentIds = [...new Set(rows
		.filter((row) => String(row.type ?? '') === 'narration')
		.map((row) => firstString(row, ['parent_id', 'parentId']))
		.filter(Boolean))];
	if (parentIds.length === 0) return rows;
	const parentRows = await getDb().execute(sql`
		select *
		from "story_entries"
		where "story_id" = ${storyId}
			and "id" in (${sql.join(parentIds.map((id) => sql`${id}`), sql`, `)})
	`) as JsonRecord[];
	return markPairedTranscriptControlResponses(rows, parentRows);
}

async function liveCanonicalRecordIsUsable(storyId: string, type: string, recordId: string): Promise<boolean> {
	const spec = WORLD_RECORD_TYPES[type];
	if (!spec) return false;
	const filters = [
		sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`,
		sql`${sql.raw(q(spec.idColumn))} = ${recordId}`,
		...Object.entries(spec.fixedFilters ?? {}).map(([column, value]) => sql`${sql.raw(q(column))} = ${value}`),
	];
	const rows = await getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.join(filters, sql` and `)}
		limit 1
	`) as JsonRecord[];
	const [row] = await markTranscriptControlPairs(storyId, type, rows);
	return Boolean(row && canonicalSearchRecordIsUsable(type, row));
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
	const recordId = canonicalSearchIndexRecordId(input.storyId, input.type, input.recordId, input.collection);
	const legacyId = legacySearchIndexRecordId(input.storyId, input.type, input.recordId, input.collection);
	if (legacyId !== recordId) {
		await getDb().delete(searchIndexRecords).where(eq(searchIndexRecords.id, legacyId));
	}
	await getDb().insert(searchIndexRecords).values({
		id: recordId,
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
		.where(eq(searchIndexRecords.id, canonicalSearchIndexRecordId(input.storyId, input.type, input.recordId, input.collection)))
		.limit(1);
	return existing?.status === 'indexed'
		&& existing.contentHash === input.contentHash
		&& existing.model === input.model
		&& asRecord(existing.metadata).payloadVersion === SEARCH_PAYLOAD_VERSION
		&& typeof existing.qdrantPointId === 'string'
		&& existing.qdrantPointId.length > 0;
}

type IndexCanonicalRecordsInput = {
	storyId: string;
	recordTypes?: string[];
	recordId?: string | null;
	recreate?: boolean;
	maxRecords?: number;
};

export async function indexCanonicalRecords(input: IndexCanonicalRecordsInput) {
	const config = memoryEmbeddingConfig();
	const collection = canonicalSearchCollection(input.storyId);
	const selectedTypes = [...new Set((input.recordTypes?.length ? input.recordTypes : INDEXABLE_TYPES)
		.filter((type) => INDEXABLE_TYPES.includes(type)))];
	const recreateWholeCollection = input.recreate === true
		&& !input.recordId
		&& selectedTypes.length === INDEXABLE_TYPES.length;
	const collectionLockRequired = Boolean(config || input.recordId);
	const run = () => indexCanonicalRecordsUnlocked(
		input,
		config,
		collection,
		selectedTypes,
		recreateWholeCollection,
		collectionLockRequired,
	);
	if (!collectionLockRequired) return run();

	const appConfig = getMtheriosAppConfig();
	return withQdrantCollectionLock({ url: appConfig.qdrantUrl, collection }, run);
}

async function indexCanonicalRecordsUnlocked(
	input: IndexCanonicalRecordsInput,
	config: ReturnType<typeof memoryEmbeddingConfig>,
	collection: string,
	selectedTypes: string[],
	recreateWholeCollection: boolean,
	collectionLockHeld: boolean,
) {
	if (!config) {
		let skipped = 0;
		let retired = 0;
		for (const type of selectedTypes) {
			let foundTarget = false;
			for await (const row of loadRows(input.storyId, type, input.recordId)) {
				foundTarget = true;
				const recordId = String(row.id ?? '');
				if (!recordId) continue;
				if (!canonicalSearchRecordIsUsable(type, row)) {
					await retireCanonicalRecord({
						storyId: input.storyId,
						type,
						recordId,
						collection,
						deletePoint: Boolean(input.recordId),
					});
					retired += 1;
					continue;
				}
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
			if (input.recordId && !foundTarget) {
				await retireCanonicalRecord({
					storyId: input.storyId,
					type,
					recordId: input.recordId,
					collection,
					deletePoint: true,
				});
				retired += 1;
			}
		}
		return { indexed: 0, skipped, retired, collection, reason: 'embeddings_not_configured' };
	}

	// The story collection also owns wiki chunks, so a full canonical rebuild must
	// ensure the collection and filter-delete canonical points instead of dropping it.
	const collectionReset = collectionLockHeld
		? await ensureCanonicalSearchCollectionUnlocked(collection, config.dimensions)
		: await ensureCanonicalSearchCollection(collection, config.dimensions);
	if (collectionReset || input.recreate) {
		if (input.recreate && !collectionReset) {
			await deleteCanonicalPoints(collection, input.storyId, selectedTypes, input.recordId);
		}
		const markerFilters = [
			eq(searchIndexRecords.storyId, input.storyId),
			eq(searchIndexRecords.collection, collection),
		];
		if (!collectionReset && input.recordId) markerFilters.push(eq(searchIndexRecords.recordId, input.recordId));
		if (!collectionReset && !recreateWholeCollection) markerFilters.push(inArray(searchIndexRecords.recordType, selectedTypes));
		await getDb().delete(searchIndexRecords).where(and(...markerFilters));
	}
	let indexed = 0;
	let failed = 0;
	let skipped = 0;
	let retired = 0;
	let processed = 0;
	const maxRecords = Math.max(1, Math.trunc(input.maxRecords ?? 40));
	for (const type of selectedTypes) {
		let foundTarget = false;
		for await (const row of loadRows(input.storyId, type, input.recordId)) {
			foundTarget = true;
			const recordId = String(row.id ?? '');
			if (!recordId) continue;
			if (!canonicalSearchRecordIsUsable(type, row)) {
				await retireCanonicalRecord({
					storyId: input.storyId,
					type,
					recordId,
					collection,
					deletePoint: true,
				});
				retired += 1;
				continue;
			}
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
				return { indexed, failed, skipped, retired, partial: true, collection, model: config.model };
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
		if (input.recordId && !foundTarget) {
			await retireCanonicalRecord({
				storyId: input.storyId,
				type,
				recordId: input.recordId,
				collection,
				deletePoint: true,
			});
			retired += 1;
		}
	}
	return { indexed, failed, skipped, retired, partial: false, collection, model: config.model };
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
	const warnings: string[] = [];
	const keywordPages = await Promise.all(types.map(async (type) => {
		const page = await listWorldRecords(input.storyId, { type, q: query, limit: Math.max(3, Math.ceil(limit / 2)) });
		return {
			type,
			page: { ...page, records: await markTranscriptControlPairs(input.storyId, type, page.records) },
		};
	}));
	const longestKeywordPage = Math.max(0, ...keywordPages.map(({ page }) => page.records.length));
	for (let recordIndex = 0; recordIndex < longestKeywordPage && keywordResults.length < limit; recordIndex += 1) {
		for (const { type, page } of keywordPages) {
			const record = page.records[recordIndex];
			if (!record || !canonicalSearchRecordIsUsable(type, record)) continue;
			keywordResults.push({
				source: 'keyword',
				score: 0.55,
				recordType: type,
				recordId: record.id,
				title: recordTitle(type, record),
				record,
			});
			if (keywordResults.length >= limit) break;
		}
	}

	let semanticResults: JsonRecord[] = [];
	if (query && input.includeSemantic !== false) {
		const config = memoryEmbeddingConfig();
		if (config) {
			try {
				const vector = validateMemoryEmbeddingVector(await embedMemoryText(query, config), config.dimensions);
				const semanticCandidateLimit = Math.min(50, Math.max(limit, limit * 3));
				const candidates = (await searchPoints(canonicalSearchCollection(input.storyId), vector, semanticCandidateLimit, input.storyId, input.type))
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
					.filter((row) => typeof row.recordId === 'string' && row.recordId.trim().length > 0)
					.filter((row) => typeof row.recordType === 'string' && Boolean(WORLD_RECORD_TYPES[row.recordType]))
					.filter((row) => semanticResultMatchesType(row, input.type));
				const live = await Promise.all(candidates.map((row) => liveCanonicalRecordIsUsable(
					input.storyId,
					String(row.recordType),
					String(row.recordId),
				)));
				semanticResults = candidates.filter((_, index) => live[index]);
				const staleCount = candidates.length - semanticResults.length;
				if (staleCount > 0) warnings.push(`Ignored ${staleCount} deleted or stale semantic result${staleCount === 1 ? '' : 's'}.`);
			} catch (error) {
				semanticResults = [];
				warnings.push(`Semantic search unavailable: ${error instanceof Error ? error.message : String(error)}`);
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
		warnings,
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
