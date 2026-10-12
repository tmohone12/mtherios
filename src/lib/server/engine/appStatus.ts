import { env } from '$env/dynamic/private';
import { getMtheriosAppConfig, ensureServerDataDirs } from '$lib/server/app/config';
import { getDb } from '$lib/server/db/client';
import { stories } from '$lib/server/db/schema';
import { getServerMemoryConfig } from '$lib/server/env';
import { getBackendJobStats } from '$lib/server/jobs/processor';
import { getStoryVaultFreshnessSummary } from '$lib/server/wiki/storyVault';
import { legacyStoryScopedCollection, storyScopedCollection } from '$lib/server/wiki/storyIdentity';
import packageJson from '../../../../package.json';

export interface AppStatusInput {
	storyId?: string | null;
}

export async function getAppStatus(input: AppStatusInput = {}) {
	const config = getMtheriosAppConfig();
	const memory = getServerMemoryConfig();
	const storyId = input.storyId?.trim() || null;
	ensureServerDataDirs(config);
	const storyIds = getKnownStoryIds().catch(() => []);
	const [qdrant, ollama, jobs] = await Promise.all([
		storyIds.then((ids) => qdrantStatus(config.qdrantUrl, config.qdrantCollection, ids)),
		probe(`${config.ollamaUrl.replace(/\/$/, '')}/api/tags`),
		getBackendJobStats(storyId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) })),
	]);
	const wiki = await getStoryVaultFreshnessSummary(config)
		.catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));

	return {
		ok: true,
		mode: 'terminal-process',
		build: {
			identity: `${packageJson.name}@${packageJson.version}`,
			version: packageJson.version,
			source: (env.MYTHENGINE_BUILD_SOURCE ?? env.MTHERIOS_BUILD_SOURCE)?.trim() || 'local-checkout',
			artifact: (env.MYTHENGINE_BUILD_ARTIFACT ?? env.MTHERIOS_BUILD_ARTIFACT)?.trim() || 'runtime',
			externalId: (env.MYTHENGINE_BUILD_ID ?? env.MTHERIOS_BUILD_ID)?.trim() || null,
		},
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
			localKevEnabled: config.localKevEnabled, localEmbeddingsEnabled: config.localEmbeddingsEnabled,
			wikiEmbedProvider: config.wikiEmbedProvider,
			wikiEmbedModel: config.wikiEmbedModel,
			wikiAutoIndexStoryVaults: config.wikiAutoIndexStoryVaults,
			turnJobsEnabled: config.turnJobsEnabled,
			chapterRunnerEnabled: config.chapterRunnerEnabled,
			chapterRunnerStoryId: config.chapterRunnerStoryId,
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
	};
}

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
		legacy: boolean;
	}>;
	totalCollections?: number;
	totalPoints?: number;
	orphanedStoryCollections?: number;
	legacyStoryCollections?: number;
}> {
	const baseUrl = qdrantUrl.replace(/\/$/, '');
	const health = await probe(`${baseUrl}/`);
	if (!health.ok) return health;
	try {
		const response = await fetch(`${baseUrl}/collections`, { signal: AbortSignal.timeout(2500) });
		const body = await response.json().catch(() => ({})) as Record<string, unknown>;
		if (!response.ok) return { ok: false, status: response.status, error: `Qdrant collections failed: HTTP ${response.status}` };
		const names = readCollectionNames(body).sort((a, b) => a.localeCompare(b));
		const expectedStoryCollections = new Set(storyIds.map((id) => storyScopedCollection(baseCollection, id)));
		const legacyStoryCollections = new Set(storyIds.map((id) => legacyStoryScopedCollection(baseCollection, id)));
		const rows = await Promise.all(names.slice(0, 40).map((name) => (
			qdrantCollectionInfo(baseUrl, name, baseCollection, expectedStoryCollections, legacyStoryCollections)
		)));
		return {
			...health,
			collections: rows,
			totalCollections: names.length,
			totalPoints: rows.reduce((sum, row) => sum + (row.pointsCount ?? 0), 0),
			orphanedStoryCollections: rows.filter((row) => row.orphaned).length,
			legacyStoryCollections: rows.filter((row) => row.legacy).length,
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
	legacyStoryCollections: Set<string>,
) {
	const legacy = legacyStoryCollections.has(name) && !expectedStoryCollections.has(name);
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
			orphaned: role === 'story' && !expectedStoryCollections.has(name) && !legacy,
			legacy,
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
			orphaned: role === 'story' && !expectedStoryCollections.has(name) && !legacy,
			legacy,
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
