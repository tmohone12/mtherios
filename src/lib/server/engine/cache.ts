import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { engineCacheEntries } from '$lib/server/db/schema';
import type {
	EngineCacheSegmentDiagnostics,
	EngineCacheStatus,
	EngineCacheStatusArgs,
} from '$lib/contracts/engine';

type JsonRecord = Record<string, unknown>;

export interface EngineCacheEntryRecord {
	id: string;
	storyId: string | null;
	cacheKey: string;
	kind: string;
	contentHash: string;
	value: string;
	tokenEstimate: number;
	hitCount: number;
	missCount: number;
	dependencyHashes: string[];
	metadata: JsonRecord;
	lastHitAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface EngineCacheRepository {
	read(id: string): Promise<EngineCacheEntryRecord | null>;
	write(entry: EngineCacheEntryRecord): Promise<EngineCacheEntryRecord>;
	listByStory(storyId?: string | null): Promise<EngineCacheEntryRecord[]>;
}

export interface BuildEngineCacheKeyInput {
	storyId?: string | null;
	kind: string;
	parts: unknown[];
}

export interface RecordEngineCacheSegmentInput {
	storyId?: string | null;
	kind: string;
	cacheKey: string;
	value: string;
	tokenEstimate?: number | null;
	dependencyHashes?: string[];
	metadata?: JsonRecord;
}

export interface RecordEngineCacheSegmentResult {
	hit: boolean;
	invalidated: boolean;
	entry: EngineCacheEntryRecord;
}

export interface ReadEngineCacheSegmentInput {
	storyId?: string | null;
	kind: string;
	cacheKey: string;
	dependencyHashes?: string[];
	touch?: boolean;
}

export interface PromptCacheSegment {
	kind: string;
	cacheKey?: string;
	value: string;
	tokenEstimate?: number | null;
	dependencyHashes?: string[];
	metadata?: JsonRecord;
}

export interface EngineCacheStatusOptions extends Partial<EngineCacheStatusArgs> {
	repository?: EngineCacheRepository;
}

function nowIso(): string {
	return new Date().toISOString();
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
	if (value && typeof value === 'object') {
		const entries = Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
		return `{${entries.join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

function cacheEntryId(storyId: string | null | undefined, kind: string, cacheKey: string): string {
	return `engine_cache_${hashText(`${storyId ?? 'global'}:${kind}:${cacheKey}`).slice(0, 32)}`;
}

function sameHashes(left: string[], right: string[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function estimateTokens(value: string): number {
	return Math.max(1, Math.ceil(value.length / 4));
}

function nonnegativeInteger(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

function readInvalidatedCount(metadata: JsonRecord): number {
	return nonnegativeInteger(metadata.engineInvalidatedCount ?? metadata.invalidatedCount);
}

function normalizeRow(row: typeof engineCacheEntries.$inferSelect): EngineCacheEntryRecord {
	return {
		id: row.id,
		storyId: row.storyId ?? null,
		cacheKey: row.cacheKey,
		kind: row.kind,
		contentHash: row.contentHash,
		value: row.value,
		tokenEstimate: row.tokenEstimate,
		hitCount: row.hitCount,
		missCount: row.missCount,
		dependencyHashes: Array.isArray(row.dependencyHashes) ? row.dependencyHashes : [],
		metadata: row.metadata ?? {},
		lastHitAt: row.lastHitAt ?? null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

class DbEngineCacheRepository implements EngineCacheRepository {
	async read(id: string): Promise<EngineCacheEntryRecord | null> {
		const [row] = await getDb().select().from(engineCacheEntries).where(eq(engineCacheEntries.id, id)).limit(1);
		return row ? normalizeRow(row) : null;
	}

	async write(entry: EngineCacheEntryRecord): Promise<EngineCacheEntryRecord> {
		const [row] = await getDb()
			.insert(engineCacheEntries)
			.values({
				id: entry.id,
				storyId: entry.storyId,
				cacheKey: entry.cacheKey,
				kind: entry.kind,
				contentHash: entry.contentHash,
				value: entry.value,
				tokenEstimate: entry.tokenEstimate,
				hitCount: entry.hitCount,
				missCount: entry.missCount,
				dependencyHashes: entry.dependencyHashes,
				metadata: entry.metadata,
				lastHitAt: entry.lastHitAt,
				createdAt: entry.createdAt,
				updatedAt: entry.updatedAt,
			})
			.onConflictDoUpdate({
				target: engineCacheEntries.id,
				set: {
					contentHash: entry.contentHash,
					value: entry.value,
					tokenEstimate: entry.tokenEstimate,
					hitCount: entry.hitCount,
					missCount: entry.missCount,
					dependencyHashes: entry.dependencyHashes,
					metadata: entry.metadata,
					lastHitAt: entry.lastHitAt,
					updatedAt: entry.updatedAt,
				},
			})
			.returning();
		return normalizeRow(row);
	}

	async listByStory(storyId?: string | null): Promise<EngineCacheEntryRecord[]> {
		const query = getDb().select().from(engineCacheEntries);
		const rows = storyId
			? await query.where(eq(engineCacheEntries.storyId, storyId))
			: await query.limit(1000);
		return rows.map(normalizeRow);
	}
}

export function createMemoryEngineCacheRepository(seed: EngineCacheEntryRecord[] = []): EngineCacheRepository {
	const records = new Map(seed.map((entry) => [entry.id, { ...entry }]));
	return {
		async read(id) {
			const entry = records.get(id);
			return entry ? { ...entry, dependencyHashes: [...entry.dependencyHashes], metadata: { ...entry.metadata } } : null;
		},
		async write(entry) {
			const next = { ...entry, dependencyHashes: [...entry.dependencyHashes], metadata: { ...entry.metadata } };
			records.set(entry.id, next);
			return { ...next, dependencyHashes: [...next.dependencyHashes], metadata: { ...next.metadata } };
		},
		async listByStory(storyId) {
			return [...records.values()]
				.filter((entry) => !storyId || entry.storyId === storyId)
				.map((entry) => ({ ...entry, dependencyHashes: [...entry.dependencyHashes], metadata: { ...entry.metadata } }));
		},
	};
}

export function buildEngineCacheKey(input: BuildEngineCacheKeyInput): string {
	return [
		'engine-cache',
		input.storyId ?? 'global',
		input.kind,
		hashText(stableJson(input.parts)),
	].join(':');
}

export function engineCacheDependencyHash(value: unknown): string {
	return hashText(stableJson(value));
}

export async function recordEngineCacheSegment(
	input: RecordEngineCacheSegmentInput,
	repository: EngineCacheRepository = new DbEngineCacheRepository(),
): Promise<RecordEngineCacheSegmentResult> {
	const storyId = input.storyId ?? null;
	const dependencyHashes = input.dependencyHashes ?? [];
	const id = cacheEntryId(storyId, input.kind, input.cacheKey);
	const contentHash = hashText(input.value);
	const timestamp = nowIso();
	const existing = await repository.read(id);
	const unchanged = Boolean(existing)
		&& existing?.contentHash === contentHash
		&& sameHashes(existing.dependencyHashes, dependencyHashes);
	const invalidated = Boolean(existing) && !unchanged;
	const previousMetadata = existing?.metadata ?? {};
	const nextMetadata: JsonRecord = {
		...previousMetadata,
		...(input.metadata ?? {}),
	};
	if (invalidated) {
		nextMetadata.engineInvalidatedCount = readInvalidatedCount(previousMetadata) + 1;
		nextMetadata.engineLastInvalidatedAt = timestamp;
	}

	const entry: EngineCacheEntryRecord = {
		id,
		storyId,
		cacheKey: input.cacheKey,
		kind: input.kind,
		contentHash,
		value: input.value,
		tokenEstimate: Math.max(0, Math.trunc(input.tokenEstimate ?? estimateTokens(input.value))),
		hitCount: unchanged ? (existing?.hitCount ?? 0) + 1 : (existing?.hitCount ?? 0),
		missCount: unchanged ? (existing?.missCount ?? 0) : (existing?.missCount ?? 0) + 1,
		dependencyHashes,
		metadata: nextMetadata,
		lastHitAt: unchanged ? timestamp : existing?.lastHitAt ?? null,
		createdAt: existing?.createdAt ?? timestamp,
		updatedAt: timestamp,
	};

	return {
		hit: unchanged,
		invalidated: Boolean(existing) && !unchanged,
		entry: await repository.write(entry),
	};
}

export async function readEngineCacheSegment(
	input: ReadEngineCacheSegmentInput,
	repository: EngineCacheRepository = new DbEngineCacheRepository(),
): Promise<EngineCacheEntryRecord | null> {
	const storyId = input.storyId ?? null;
	const id = cacheEntryId(storyId, input.kind, input.cacheKey);
	const existing = await repository.read(id);
	if (!existing) return null;
	if (input.dependencyHashes && !sameHashes(existing.dependencyHashes, input.dependencyHashes)) {
		return null;
	}
	if (input.touch === false) return existing;
	const timestamp = nowIso();
	return repository.write({
		...existing,
		hitCount: existing.hitCount + 1,
		lastHitAt: timestamp,
		updatedAt: timestamp,
	});
}

export async function recordPromptCacheSegments(options: {
	storyId: string;
	segments: PromptCacheSegment[];
	repository?: EngineCacheRepository;
}): Promise<{ hitCount: number; missCount: number; segments: RecordEngineCacheSegmentResult[] }> {
	const repository = options.repository ?? new DbEngineCacheRepository();
	const results: RecordEngineCacheSegmentResult[] = [];
	for (const segment of options.segments) {
		if (!segment.value.trim()) continue;
		const cacheKey = segment.cacheKey ?? buildEngineCacheKey({
			storyId: options.storyId,
			kind: segment.kind,
			parts: [segment.value],
		});
		results.push(await recordEngineCacheSegment({
			storyId: options.storyId,
			kind: segment.kind,
			cacheKey,
			value: segment.value,
			tokenEstimate: segment.tokenEstimate,
			dependencyHashes: segment.dependencyHashes ?? [engineCacheDependencyHash(segment.value)],
			metadata: segment.metadata,
		}, repository));
	}
	return {
		hitCount: results.filter((result) => result.hit).length,
		missCount: results.filter((result) => !result.hit).length,
		segments: results,
	};
}

export async function getEngineCacheStatus(
	storyId?: string | null,
	options: EngineCacheStatusOptions = {},
): Promise<EngineCacheStatus> {
	const repository = options.repository ?? new DbEngineCacheRepository();
	const rows = await repository.listByStory(storyId ?? null);
	const byKind = new Map<string, {
		kind: string;
		entryCount: number;
		hitCount: number;
		missCount: number;
		invalidatedCount: number;
		tokenEstimate: number;
	}>();
	for (const row of rows) {
		const current = byKind.get(row.kind) ?? {
			kind: row.kind,
			entryCount: 0,
			hitCount: 0,
			missCount: 0,
			invalidatedCount: 0,
			tokenEstimate: 0,
		};
		current.entryCount += 1;
		current.hitCount += row.hitCount;
		current.missCount += row.missCount;
		current.invalidatedCount += readInvalidatedCount(row.metadata);
		current.tokenEstimate += row.tokenEstimate;
		byKind.set(row.kind, current);
	}
	const kinds = [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
	const segmentLimit = Math.min(100, Math.max(1, Math.trunc(options.segmentLimit ?? 25)));
	const segmentRows = options.includeSegments
		? rows
			.filter((row) => !options.kind || row.kind === options.kind)
			.sort((a, b) => {
				const tokenDelta = b.tokenEstimate - a.tokenEstimate;
				if (tokenDelta !== 0) return tokenDelta;
				const missDelta = b.missCount - a.missCount;
				if (missDelta !== 0) return missDelta;
				return b.updatedAt.localeCompare(a.updatedAt);
			})
			.slice(0, segmentLimit)
		: [];
	const segments: EngineCacheSegmentDiagnostics[] = segmentRows.map((row) => ({
		kind: row.kind,
		cacheKey: row.cacheKey,
		contentHash: row.contentHash,
		tokenEstimate: row.tokenEstimate,
		hitCount: row.hitCount,
		missCount: row.missCount,
		invalidatedCount: readInvalidatedCount(row.metadata),
		dependencyHashes: [...row.dependencyHashes],
		metadata: { ...row.metadata },
		lastHitAt: row.lastHitAt,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	}));
	return {
		storyId: storyId ?? null,
		entryCount: rows.length,
		hitCount: kinds.reduce((sum, kind) => sum + kind.hitCount, 0),
		missCount: kinds.reduce((sum, kind) => sum + kind.missCount, 0),
		tokenEstimate: kinds.reduce((sum, kind) => sum + kind.tokenEstimate, 0),
		byKind: kinds,
		segments,
	};
}
