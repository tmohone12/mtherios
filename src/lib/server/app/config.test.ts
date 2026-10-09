import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMtheriosAppConfig, wikiRuntimeEnv } from './config';
import { resolveRuntimeOptions } from '../../../../scripts/runtime-config.mjs';

describe('MythEngine wiki environment', () => {
	it('keeps story-specific paths and collection overrides ahead of both environment aliases', () => {
		const base = getMtheriosAppConfig();
		const expected = {
			...base,
			defaultVault: path.join(base.vaultRoot, 'stories', 'fixture'),
			qdrantCollection: 'mythengine_wiki_fixture',
			jobWorkerEnabled: false,
		};
		const env = wikiRuntimeEnv(expected);
		expect(env.MYTHENGINE_DEFAULT_VAULT).toBe(expected.defaultVault);
		expect(env.MTHERIOS_DEFAULT_VAULT).toBe(expected.defaultVault);
		expect(env.MYTHENGINE_QDRANT_COLLECTION).toBe(expected.qdrantCollection);
		const resolved = resolveRuntimeOptions([], { env });
		expect(resolved.defaultVault).toBe(expected.defaultVault);
		expect(resolved.qdrantCollection).toBe(expected.qdrantCollection);
		expect(resolved.jobWorker).toBe(false);
	});
});
