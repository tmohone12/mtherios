import { env } from '$env/dynamic/private';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRuntimeOptions, buildRuntimeEnv } from '../../../../scripts/runtime-config.mjs';

export interface MtheriosAppConfig {
	dataRoot: string;
	vaultRoot: string;
	defaultVault: string;
	allowExternalVaults: boolean;
	qdrantUrl: string;
	qdrantCollection: string;
	ollamaUrl: string;
	localKevEnabled: boolean;
	localEmbeddingsEnabled: boolean;
	wikiEmbedProvider: string;
	wikiEmbedModel: string;
	wikiEmbedBaseUrl: string;
	wikiEmbedApiKey: string;
	wikiAutoIndexStoryVaults: boolean;
	/** Queued jobs run after the work that queued them (see server/jobs/turnJobs). */
	turnJobsEnabled: boolean;
	chapterRunnerEnabled: boolean;
	chapterRunnerStoryId: string;
}

export function getMtheriosAppConfig(): MtheriosAppConfig {
	const options = resolveRuntimeOptions([], { env });
	return {
		dataRoot: options.dataRoot, vaultRoot: options.vaultRoot, defaultVault: options.defaultVault,
		allowExternalVaults: options.allowExternalVaults, qdrantUrl: options.qdrantUrl,
		qdrantCollection: options.qdrantCollection, ollamaUrl: options.ollamaUrl,
		localKevEnabled: options.localKevEnabled, localEmbeddingsEnabled: options.localEmbeddingsEnabled,
		wikiEmbedProvider: options.wikiEmbedProvider, wikiEmbedModel: options.wikiEmbedModel,
		wikiEmbedBaseUrl: options.wikiEmbedBaseUrl, wikiEmbedApiKey: options.wikiEmbedApiKey,
		wikiAutoIndexStoryVaults: options.wikiAutoIndexStoryVaults,
		turnJobsEnabled: options.turnJobs,
		chapterRunnerEnabled: options.chapterRunnerEnabled, chapterRunnerStoryId: options.chapterRunnerStoryId,
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
			'Set MYTHENGINE_ALLOW_EXTERNAL_VAULTS=true if you want the app server to index an outside Obsidian vault.',
		);
	}

	return candidate;
}

export function wikiRuntimeEnv(config = getMtheriosAppConfig()): NodeJS.ProcessEnv {
	return buildRuntimeEnv({ ...resolveRuntimeOptions([], { env }), ...config, turnJobs: config.turnJobsEnabled });
}

function isPathInside(parent: string, child: string): boolean {
	const relative = path.relative(path.resolve(parent), path.resolve(child));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
