import { env } from '$env/dynamic/private';

export interface ServerMemoryConfig {
	databaseUrl: string | null;
	embeddingProvider: string | null;
	embeddingModel: string | null;
	embeddingBaseUrl: string | null;
	embeddingApiKey: string | null;
	embeddingCustomUrl: string | null;
	embeddingBatchSize: number;
	embeddingDimensions: number;
	importEntryLimit: number;
	chapterThreshold: number;
	postChapterBuffer: number;
	chaptersPerArc: number;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readNonNegativeInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function getServerMemoryConfig(): ServerMemoryConfig {
	const embeddingProvider = env.MEMORY_EMBEDDING_PROVIDER?.trim() || null;
	return {
		databaseUrl: env.DATABASE_URL?.trim() || null,
		embeddingProvider,
		embeddingModel: env.MEMORY_EMBEDDING_MODEL?.trim() || null,
		embeddingBaseUrl: env.MEMORY_EMBEDDING_BASE_URL?.trim() || null,
		embeddingApiKey: env.MEMORY_EMBEDDING_API_KEY?.trim() || (embeddingProvider === 'openrouter' ? env.OPENROUTER_API_KEY?.trim() : '') || null,
		embeddingCustomUrl: env.MEMORY_EMBEDDING_URL?.trim() || null,
		embeddingBatchSize: readPositiveInt(env.MEMORY_EMBEDDING_BATCH, 8),
		embeddingDimensions: readPositiveInt(env.MEMORY_EMBEDDING_DIMENSIONS, 1536),
		importEntryLimit: readPositiveInt(env.MEMORY_IMPORT_ENTRY_LIMIT, 20000),
		chapterThreshold: readPositiveInt(env.MTHERIOS_CHAPTER_THRESHOLD, 20),
		postChapterBuffer: readNonNegativeInt(env.MTHERIOS_POST_CHAPTER_BUFFER, 10),
		chaptersPerArc: readPositiveInt(env.MTHERIOS_CHAPTERS_PER_ARC, 5),
	};
}

export class BackendNotConfiguredError extends Error {
	constructor() {
		super('Backend memory is not configured. Set DATABASE_URL to enable canonical Postgres storage.');
		this.name = 'BackendNotConfiguredError';
	}
}
