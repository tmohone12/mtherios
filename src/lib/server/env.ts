import { env } from '$env/dynamic/private';

export interface ServerMemoryConfig {
	databaseUrl: string | null;
	embeddingProvider: string | null;
	embeddingModel: string | null;
	importEntryLimit: number;
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getServerMemoryConfig(): ServerMemoryConfig {
	return {
		databaseUrl: env.DATABASE_URL?.trim() || null,
		embeddingProvider: env.MEMORY_EMBEDDING_PROVIDER?.trim() || null,
		embeddingModel: env.MEMORY_EMBEDDING_MODEL?.trim() || null,
		importEntryLimit: readPositiveInt(env.MEMORY_IMPORT_ENTRY_LIMIT, 20000),
	};
}

export class BackendNotConfiguredError extends Error {
	constructor() {
		super('Backend memory is not configured. Set DATABASE_URL to enable canonical Postgres storage.');
		this.name = 'BackendNotConfiguredError';
	}
}
