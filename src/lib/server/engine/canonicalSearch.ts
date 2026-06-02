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

const INDEXABLE_TYPES = [
	'transcript',
	'entities',
	'factions',
	'factionMemberships',
	'factionResources',
	'factionGoals',
	'agreements',
	'threads',
	'events',
	'patches',
	'memoryNodes',
	'chapters',
	'arcs',
];

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

function recordText(type: string, row: JsonRecord): string {
	const parts = [
		`Record type: ${type}`,
		`Title: ${recordTitle(type, row)}`,
		firstString(row, ['body', 'content', 'summary', 'description', 'scene_outcome', 'goal', 'terms']),
		typeof row.status === 'string' ? `Status: ${row.status}` : '',
		typeof row.visibility === 'string' ? `Visibility: ${row.visibility}` : '',
		JSON.stringify(row.metadata ?? row.state ?? {}),
	];
	return parts.filter(Boolean).join('\n\n').replace(/\s+\n/g, '\n').trim();
}

function sourceRefs(row: JsonRecord) {
	return {
		sourceEntryIds: asStringArray(row.source_entry_ids ?? row.sourceEntryIds),
		sourceEventIds: asStringArray(row.source_event_ids ?? row.sourceEventIds),
		sourcePatchIds: asStringArray(row.source_patch_ids ?? row.sourcePatchIds),
	};
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

async function loadRows(storyId: string, type: string): Promise<JsonRecord[]> {
	const spec = WORLD_RECORD_TYPES[type];
	if (!spec) return [];
	const filters = [
		sql`${sql.raw(q(spec.storyColumn))} = ${storyId}`,
		...Object.entries(spec.fixedFilters ?? {}).map(([column, value]) => sql`${sql.raw(q(column))} = ${value}`),
	];
	return getDb().execute(sql`
		select *
		from ${sql.raw(q(spec.table))}
		where ${sql.join(filters, sql` and `)}
		order by ${sql.raw(q(spec.updatedColumn ?? spec.idColumn))} desc
		limit 2000
	`) as Promise<JsonRecord[]>;
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
		id: `search_${input.storyId}_${input.type}_${input.recordId}_${input.collection}`.replace(/[^a-zA-Z0-9_:-]+/g, '_').slice(0, 220),
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
		metadata: input.metadata ?? {},
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
			metadata: input.metadata ?? {},
			updatedAt: now,
		},
	});
}

export async function indexCanonicalRecords(input: {
	storyId: string;
	recordTypes?: string[];
	recreate?: boolean;
}) {
	const config = memoryEmbeddingConfig();
	const collection = canonicalSearchCollection(input.storyId);
	const selectedTypes = (input.recordTypes?.length ? input.recordTypes : INDEXABLE_TYPES)
		.filter((type) => INDEXABLE_TYPES.includes(type));
	if (!config) {
		let skipped = 0;
		for (const type of selectedTypes) {
			for (const row of await loadRows(input.storyId, type)) {
				const recordId = String(row.id ?? '');
				if (!recordId) continue;
				const text = recordText(type, row);
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
	for (const type of selectedTypes) {
		for (const row of await loadRows(input.storyId, type)) {
			const recordId = String(row.id ?? '');
			if (!recordId) continue;
			const text = recordText(type, row);
			const contentHash = hashText(text);
			const pointId = uuidFromHash(hashText(`${input.storyId}:${type}:${recordId}`));
			const refs = sourceRefs(row);
			try {
				const vector = validateMemoryEmbeddingVector(await embedMemoryText(text, config), config.dimensions);
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
	return { indexed, failed, collection, model: config.model };
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
							recordType: payload.recordType,
							recordId: payload.recordId,
							title: payload.title,
							payload,
						};
					})
					.filter((row) => !input.type || row.recordType === input.type);
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
