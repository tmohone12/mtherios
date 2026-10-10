import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getMtheriosAppConfig, wikiRuntimeEnv } from './config';
import { buildRuntimeEnv, assertRuntimeIsolation, resolveRuntimeOptions } from '../../../../scripts/runtime-config.mjs';

describe('MythEngine wiki environment', () => {
 it('separates explicit local-only inference testing from mandatory campaign isolation', () => {
  const options={...resolveRuntimeOptions([], {env:{}}),isolatedTestCopy:true,port:5174,jobWorker:false,
   dataRoot:path.resolve('data-faction-test'),databaseUrl:'postgres://mythengine:mythengine@127.0.0.1:5433/mythengine_faction_copy_20261001',qdrantCollection:'mythengine_faction_copy_20261001'};
  expect(buildRuntimeEnv({...options,testLocalInferenceOnly:true},{}).MYTHENGINE_TEST_LOCAL_ONLY).toBe('true');
  const authorizedCloud={...options,testLocalInferenceOnly:false};
  expect(buildRuntimeEnv(authorizedCloud,{}).MYTHENGINE_TEST_LOCAL_ONLY).toBe('false');
  expect(()=>assertRuntimeIsolation({...authorizedCloud,databaseUrl:'postgres://mythengine:mythengine@127.0.0.1:5433/mythengine'})).toThrow('dedicated database');
 });
	it('keeps story-specific paths and collection overrides ahead of both environment aliases', () => {
		const base = getMtheriosAppConfig();
		const expected = {
			...base,
			defaultVault: path.join(base.vaultRoot, 'stories', 'fixture'),
			qdrantCollection: base.qdrantCollection + '_fixture',
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
