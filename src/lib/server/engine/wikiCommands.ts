import fs from 'node:fs';
import path from 'node:path';
import { ensureServerDataDirs, getMtheriosAppConfig } from '$lib/server/app/config';
import {
	briefWiki,
	contextWiki,
	followWiki,
	indexWiki,
	ingestWiki,
	initWiki,
	lintWiki,
	pageWiki,
	pagesWiki,
	searchWiki,
	writeWiki,
	type WikiBriefInput,
	type WikiContextInput,
	type WikiFollowInput,
	type WikiIndexInput,
	type WikiIngestInput,
	type WikiInitInput,
	type WikiLintInput,
	type WikiPageInput,
	type WikiPagesInput,
	type WikiSearchInput,
	type WikiWriteInput,
} from '$lib/server/wiki/wikiCore';
import {
	archiveStoryVault,
	getStoryVaultStatus,
	materializeStoryVault,
	type MaterializeStoryVaultInput,
} from '$lib/server/wiki/storyVault';

export type WikiCoreAction =
	| 'brief'
	| 'context'
	| 'follow'
	| 'index'
	| 'ingest'
	| 'init'
	| 'lint'
	| 'page'
	| 'pages'
	| 'search'
	| 'write';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function storyScopedInput(storyId: string, input: unknown): JsonRecord {
	const record = asRecord(input);
	if (storyId === '__wiki__' || storyId === '__app__') return record;
	return {
		...record,
		storyId: typeof record.storyId === 'string' && record.storyId.trim() ? record.storyId : storyId,
	};
}

export async function runWikiAction(action: WikiCoreAction, input: unknown): Promise<unknown> {
	switch (action) {
		case 'brief':
			return await briefWiki(asRecord(input) as unknown as WikiBriefInput);
		case 'context':
			return await contextWiki(asRecord(input) as unknown as WikiContextInput);
		case 'follow':
			return await followWiki(asRecord(input) as WikiFollowInput);
		case 'index':
			return await indexWiki(asRecord(input) as WikiIndexInput);
		case 'ingest':
			return await ingestWiki(asRecord(input) as WikiIngestInput);
		case 'init':
			return await initWiki(asRecord(input) as WikiInitInput);
		case 'lint':
			return await lintWiki(asRecord(input) as WikiLintInput);
		case 'page':
			return await pageWiki(asRecord(input) as WikiPageInput);
		case 'pages':
			return await pagesWiki(asRecord(input) as WikiPagesInput);
		case 'search':
			return await searchWiki(asRecord(input) as unknown as WikiSearchInput);
		case 'write':
			return await writeWiki(asRecord(input) as WikiWriteInput);
	}
}

export async function getWikiStoryVaultStatus(storyId: string): Promise<unknown> {
	return {
		ok: true,
		...(await getStoryVaultStatus(storyId)),
	};
}

export async function materializeWikiStoryVault(input: unknown): Promise<unknown> {
	const args = storyScopedInput('', input);
	const storyId = typeof args.storyId === 'string' ? args.storyId.trim() : '';
	if (!storyId) throw new Error('storyId is required.');
	const vault = await materializeStoryVault({
		storyId,
		clean: args.clean !== false,
	} satisfies MaterializeStoryVaultInput);
	const indexed = args.index === true
		? await indexWiki({
			storyId,
			recreate: args.recreate === true,
			dryRun: args.dryRun === true,
			provider: typeof args.provider === 'string' ? args.provider : null,
			model: typeof args.model === 'string' ? args.model : null,
		})
		: null;
	const status = await getStoryVaultStatus(storyId);
	return {
		...vault,
		indexed,
		status,
	};
}

export async function archiveWikiStoryVault(storyId: string): Promise<unknown> {
	return await archiveStoryVault(storyId);
}

export function getWikiRuntimeStatus(): JsonRecord {
	const config = getMtheriosAppConfig();
	ensureServerDataDirs(config);
	return {
		ok: true,
		vaultRoot: config.vaultRoot,
		defaultVault: config.defaultVault,
		defaultVaultExists: fs.existsSync(config.defaultVault),
		defaultVaultInitialized: ['AGENTS.md', 'index.md', 'log.md'].every((file) =>
			fs.existsSync(path.join(config.defaultVault, file)),
		),
		qdrantUrl: config.qdrantUrl,
		qdrantCollection: config.qdrantCollection,
		embedding: {
			provider: config.wikiEmbedProvider,
			model: config.wikiEmbedModel,
		},
	};
}

export function withCommandStoryId(storyId: string, input: unknown): JsonRecord {
	return storyScopedInput(storyId, input);
}
