import { env } from '$env/dynamic/private';
import fs from 'node:fs';
import path from 'node:path';

export interface MtheriosAppConfig {
	dataRoot: string;
	vaultRoot: string;
	defaultVault: string;
	allowExternalVaults: boolean;
	qdrantUrl: string;
	qdrantCollection: string;
	ollamaUrl: string;
	wikiEmbedProvider: string;
	wikiEmbedModel: string;
	wikiAutoIndexStoryVaults: boolean;
	wikiAutoLintStoryVaults: boolean;
	jobWorkerEnabled: boolean;
	jobIntervalMs: number;
}

export function getMtheriosAppConfig(): MtheriosAppConfig {
	const dataRoot = path.resolve(env.MTHERIOS_DATA_ROOT || './data');
	const vaultRoot = path.resolve(env.MTHERIOS_VAULT_ROOT || path.join(dataRoot, 'vaults'));
	const defaultVault = path.resolve(env.MTHERIOS_DEFAULT_VAULT || path.join(vaultRoot, 'default'));

	return {
		dataRoot,
		vaultRoot,
		defaultVault,
		allowExternalVaults: env.MTHERIOS_ALLOW_EXTERNAL_VAULTS === 'true',
		qdrantUrl: env.QDRANT_URL || 'http://127.0.0.1:6333',
		qdrantCollection: env.QDRANT_COLLECTION || 'mtherios_wiki',
		ollamaUrl: env.OLLAMA_URL || 'http://127.0.0.1:11434',
		wikiEmbedProvider: env.WIKI_EMBED_PROVIDER || 'ollama',
		wikiEmbedModel: env.WIKI_EMBED_MODEL || 'nomic-embed-text',
		wikiAutoIndexStoryVaults: env.MTHERIOS_WIKI_AUTO_INDEX === 'true',
		wikiAutoLintStoryVaults: env.MTHERIOS_WIKI_AUTO_LINT === 'true',
		jobWorkerEnabled: env.MTHERIOS_JOB_WORKER !== 'false',
		jobIntervalMs: readPositiveInt(env.MTHERIOS_JOB_INTERVAL_MS, 5000),
	};
}

export function ensureServerDataDirs(config = getMtheriosAppConfig()): void {
	for (const dir of [
		config.dataRoot,
		config.vaultRoot,
		config.defaultVault,
		path.join(config.dataRoot, 'exports'),
		path.join(config.dataRoot, 'uploads'),
		path.join(config.dataRoot, 'logs'),
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}

export function resolveVaultPath(input?: string | null, config = getMtheriosAppConfig()): string {
	ensureServerDataDirs(config);
	const candidate = input?.trim()
		? path.resolve(input)
		: config.defaultVault;

	if (!config.allowExternalVaults && !isPathInside(config.vaultRoot, candidate)) {
		throw new Error(
			`Vault path must be under ${config.vaultRoot}. ` +
			'Set MTHERIOS_ALLOW_EXTERNAL_VAULTS=true if you want the app server to index an outside Obsidian vault.',
		);
	}

	return candidate;
}

export function wikiRuntimeEnv(config = getMtheriosAppConfig()): NodeJS.ProcessEnv {
	return {
		...process.env,
		MTHERIOS_DATA_ROOT: config.dataRoot,
		MTHERIOS_VAULT_ROOT: config.vaultRoot,
		MTHERIOS_DEFAULT_VAULT: config.defaultVault,
		QDRANT_URL: config.qdrantUrl,
		QDRANT_COLLECTION: config.qdrantCollection,
		OLLAMA_URL: config.ollamaUrl,
		WIKI_EMBED_PROVIDER: config.wikiEmbedProvider,
		WIKI_EMBED_MODEL: config.wikiEmbedModel,
		MTHERIOS_JOB_WORKER: config.jobWorkerEnabled ? 'true' : 'false',
		MTHERIOS_JOB_INTERVAL_MS: String(config.jobIntervalMs),
		MTHERIOS_WIKI_AUTO_INDEX: config.wikiAutoIndexStoryVaults ? 'true' : 'false',
		MTHERIOS_WIKI_AUTO_LINT: config.wikiAutoLintStoryVaults ? 'true' : 'false',
	};
}

function readPositiveInt(value: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(value ?? '', 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
