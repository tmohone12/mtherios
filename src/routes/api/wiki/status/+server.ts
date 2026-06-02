import { json, type RequestHandler } from '@sveltejs/kit';
import fs from 'node:fs';
import path from 'node:path';
import { getMtheriosAppConfig, ensureServerDataDirs } from '$lib/server/app/config';

export const GET: RequestHandler = async () => {
	const config = getMtheriosAppConfig();
	ensureServerDataDirs(config);
	return json({
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
	});
};
