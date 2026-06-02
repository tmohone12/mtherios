import { json, type RequestHandler } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db/client';
import { stories } from '$lib/server/db/schema';
import { getMtheriosAppConfig, ensureServerDataDirs } from '$lib/server/app/config';
import { getBackendJobStats } from '$lib/server/jobs/processor';
import { getServerMemoryConfig } from '$lib/server/env';
import { getStoryVaultFreshnessSummary } from '$lib/server/wiki/storyVault';

export const GET: RequestHandler = async ({ url }) => {
	const config = getMtheriosAppConfig();
	const memory = getServerMemoryConfig();
	const storyId = url.searchParams.get('storyId')?.trim() || null;
	ensureServerDataDirs(config);
	const storyIds = getKnownStoryIds().catch(() => []);
	const [qdrant, ollama, jobs] = await Promise.all([
		storyIds.then((ids) => qdrantStatus(config.qdrantUrl, config.qdrantCollection, ids)),
		probe(`${config.ollamaUrl.replace(/\/$/, '')}/api/tags`),
		getBackendJobStats(storyId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
	]);
	const wiki = await getStoryVaultFreshnessSummary(config)
		.catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

	return json({
		ok: true,
		mode: 'terminal-process',
		scope: {
			storyId,
		},
		runtime: {
			pid: process.pid,
			uptimeSeconds: Math.round(process.uptime()),
			timestamp: new Date().toISOString(),
		},
		config: {
			dataRoot: config.dataRoot,
			vaultRoot: config.vaultRoot,
			defaultVault: config.defaultVault,
			allowExternalVaults: config.allowExternalVaults,
			qdrantUrl: config.qdrantUrl,
			qdrantCollection: config.qdrantCollection,
			ollamaUrl: config.ollamaUrl,
			wikiEmbedProvider: config.wikiEmbedProvider,
			wikiEmbedModel: config.wikiEmbedModel,
			wikiAutoIndexStoryVaults: config.wikiAutoIndexStoryVaults,
			wikiAutoLintStoryVaults: config.wikiAutoLintStoryVaults,
			jobWorkerEnabled: config.jobWorkerEnabled,
			jobIntervalMs: config.jobIntervalMs,
			chapterThreshold: memory.chapterThreshold,
			postChapterBuffer: memory.postChapterBuffer,
			chaptersPerArc: memory.chaptersPerArc,
			memoryEmbeddingsConfigured: Boolean(memory.embeddingProvider && memory.embeddingModel),
			memoryEmbeddingProvider: memory.embeddingProvider,
			memoryEmbeddingModel: memory.embeddingModel,
			memoryEmbeddingDimensions: memory.embeddingDimensions,
			memoryEmbeddingBatchSize: memory.embeddingBatchSize,
			databaseConfigured: Boolean(env.DATABASE_URL),
		},
		services: {
			qdrant,
			ollama,
		},
		jobs,
		wiki,
	});
};

async function probe(url: string): Promise<{ ok: boolean; status?: number; error?: string }> {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(2500) });
		return { ok: response.ok, status: response.status };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

async function qdrantStatus(
	qdrantUrl: string,
	baseCollection: string,
	storyIds: string[],
): Promise<{
	ok: boolean;
	status?: number;
	error?: string;
	collections?: Array<{
		name: string;
		pointsCount: number | null;
		indexedVectorsCount: number | null;
		status: string | null;
		vectorSize: number | null;
		distance: string | null;
		role: 'default' | 'story' | 'other';
		orphaned: boolean;
	}>;
	totalCollections?: number;
	totalPoints?: number;
	orphanedStoryCollections?: number;
}> {
	const baseUrl = qdrantUrl.replace(/\/$/, '');
	const health = await probe(`${baseUrl}/`);
	if (!health.ok) return health;
	try {
		const response = await fetch(`${baseUrl}/collections`, { signal: AbortSignal.timeout(2500) });
		const body = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (!response.ok) return { ok: false, status: response.status, error: `Qdrant collections failed: HTTP ${response.status}` };
		const names = readCollectionNames(body).sort((a, b) => a.localeCompare(b));
		const expectedStoryCollections = new Set(storyIds.map((id) => storyCollectionName(id, baseCollection)));
		const rows = await Promise.all(names.slice(0, 40).map((name) => (
			qdrantCollectionInfo(baseUrl, name, baseCollection, expectedStoryCollections)
		)));
		return {
			...health,
			collections: rows,
			totalCollections: names.length,
			totalPoints: rows.reduce((sum, row) => sum + (row.pointsCount ?? 0), 0),
			orphanedStoryCollections: rows.filter((row) => row.orphaned).length,
		};
	} catch (error) {
		return {
			...health,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

async function getKnownStoryIds(): Promise<string[]> {
	const rows = await getDb().select({ id: stories.id }).from(stories).limit(5000);
	return rows.map((row) => row.id);
}

function readCollectionNames(body: Record<string, unknown>): string[] {
	const result = body.result && typeof body.result === 'object' ? body.result as Record<string, unknown> : {};
	const collections = Array.isArray(result.collections) ? result.collections : [];
	return collections
		.map((item) => item && typeof item === 'object' ? (item as Record<string, unknown>).name : null)
		.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

async function qdrantCollectionInfo(
	baseUrl: string,
	name: string,
	baseCollection: string,
	expectedStoryCollections: Set<string>,
) {
	try {
		const response = await fetch(`${baseUrl}/collections/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(2500) });
		const body = await response.json().catch(() => ({})) as Record<string, unknown>;
		const result = body.result && typeof body.result === 'object' ? body.result as Record<string, unknown> : {};
		const params = asRecord(asRecord(result.config).params);
		const vectors = asRecord(params.vectors);
		const role = collectionRole(name, baseCollection);
		return {
			name,
			pointsCount: asNullableNumber(result.points_count),
			indexedVectorsCount: asNullableNumber(result.indexed_vectors_count),
			status: typeof result.status === 'string' ? result.status : null,
			vectorSize: asNullableNumber(vectors.size),
			distance: typeof vectors.distance === 'string' ? vectors.distance : null,
			role,
			orphaned: role === 'story' && !expectedStoryCollections.has(name),
		};
	} catch {
		const role = collectionRole(name, baseCollection);
		return {
			name,
			pointsCount: null,
			indexedVectorsCount: null,
			status: null,
			vectorSize: null,
			distance: null,
			role,
			orphaned: role === 'story' && !expectedStoryCollections.has(name),
		};
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asNullableNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function collectionRole(name: string, baseCollection: string): 'default' | 'story' | 'other' {
	if (name === baseCollection) return 'default';
	if (name.startsWith(`${baseCollection}_`)) return 'story';
	return 'other';
}

function storyCollectionName(storyId: string, baseCollection: string): string {
	return `${baseCollection}_${safeCollectionSegment(storyId)}`;
}

function safeCollectionSegment(value: string): string {
	return String(value || 'story')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 90)
		.replace(/-/g, '_') || 'story';
}
