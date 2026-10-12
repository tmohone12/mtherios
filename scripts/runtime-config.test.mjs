import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRuntimeOptions, buildRuntimeEnv, safeRuntimeSummary, assertLocalPath } from './runtime-config.mjs';
import { composeCommand } from './backend.mjs';

function fixture(t) {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mythengine-config-'));
	t.after(() => removeFixture(cwd));
	return { cwd, env: {} };
}

function removeFixture(directory) {
	assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
	assert.ok(path.basename(directory).startsWith('mythengine-'));
	fs.rmSync(directory, { recursive: true, force: true });
}

test('fresh install has independent targets and no automatic background work', t => {
	const context = fixture(t);
	const config = resolveRuntimeOptions([], context);
	assert.equal(config.port, 5174);
	assert.equal(config.appUrl, 'http://127.0.0.1:5174');
	assert.equal(config.databaseUrl, 'postgres://mythengine:mythengine@127.0.0.1:5433/mythengine');
	assert.equal(config.qdrantUrl, 'http://127.0.0.1:6335');
	assert.equal(config.qdrantCollection, 'mythengine_wiki');
	assert.equal(config.vaultRoot, path.join(context.cwd, 'data', 'vaults'));
	assert.equal(config.defaultVault, path.join(config.vaultRoot, 'default'));
	assert.equal(config.turnJobs, true);
	assert.equal(config.wikiAutoIndexStoryVaults, false);
	assert.equal(config.localKevEnabled, false);
	assert.equal(config.localEmbeddingsEnabled, false);
	assert.equal(config.chapterThreshold, 20);
	assert.equal(config.chaptersPerArc, 10);
	assert.deepEqual(fs.readdirSync(context.cwd), []);
});

test('local AI opt-in keeps off-mode away from Ollama and round-trips through runtime env', t => {
	const context = fixture(t);
	fs.writeFileSync(path.join(context.cwd, 'mythengine.config.json'), JSON.stringify({
		wikiEmbedProvider: 'ollama', memoryEmbeddingProvider: 'ollama', memoryEmbeddingModel: 'nomic-embed-text',
	}));
	const off = resolveRuntimeOptions([], context);
	assert.equal(off.wikiEmbedProvider, 'disabled');
	assert.equal(off.memoryEmbeddingProvider, '');
	const on = resolveRuntimeOptions(['--local-kev', '--local-embeddings'], context);
	assert.equal(on.wikiEmbedProvider, 'ollama');
	assert.equal(on.memoryEmbeddingProvider, 'ollama');
	const roundTrip = resolveRuntimeOptions([], { ...context, env: buildRuntimeEnv(on, {}) });
	assert.equal(roundTrip.localKevEnabled, true);
	assert.equal(roundTrip.localEmbeddingsEnabled, true);
	assert.equal(resolveRuntimeOptions(['--no-local-kev'], { ...context, env: buildRuntimeEnv(on, {}) }).localKevEnabled, false);
});

test('local AI off leaves remote embedding providers intact', t => {
	const context = fixture(t);
	const remote = resolveRuntimeOptions(['--memory-embedding-provider', 'openrouter'], context);
	assert.equal(remote.wikiEmbedProvider, 'openrouter');
	assert.equal(remote.memoryEmbeddingProvider, 'openrouter');
});

test('disabled or explicitly requested Ollama wiki embeddings cannot fetch without opt-in', async t => {
	const { embedMany } = await import('./wiki-core/lib/embeddings.mjs');
	const previousFetch = globalThis.fetch;
	const previousNew = process.env.MYTHENGINE_LOCAL_EMBEDDINGS;
	const previousOld = process.env.MTHERIOS_LOCAL_EMBEDDINGS;
	process.env.MYTHENGINE_LOCAL_EMBEDDINGS = 'false';
	process.env.MTHERIOS_LOCAL_EMBEDDINGS = 'false';
	let requests = 0;
	globalThis.fetch = async () => { requests++; throw Error('Unexpected model request'); };
	t.after(() => {
		globalThis.fetch = previousFetch;
		for (const [key, value] of [['MYTHENGINE_LOCAL_EMBEDDINGS', previousNew], ['MTHERIOS_LOCAL_EMBEDDINGS', previousOld]]) {
			if (value === undefined) delete process.env[key]; else process.env[key] = value;
		}
	});
	await assert.rejects(embedMany(['query'], { provider: 'disabled' }), /Local embeddings are off/);
	await assert.rejects(embedMany(['query'], { provider: 'ollama' }), /Local embeddings are off/);
	assert.equal(requests, 0);
});

test('CLI beats new env, legacy env and preferred config; no config secret merging', t => {
	const context = fixture(t);
	fs.writeFileSync(path.join(context.cwd, 'mtherios.config.json'), JSON.stringify({port: 5200, wikiEmbedApiKey: 'legacy-secret'}));
	assert.equal(resolveRuntimeOptions([], context).port, 5200);
	fs.writeFileSync(path.join(context.cwd, 'mythengine.config.json'), JSON.stringify({port: 5201}));
	assert.equal(resolveRuntimeOptions([], context).port, 5201);
	assert.equal(resolveRuntimeOptions([], context).wikiEmbedApiKey, '');
	context.env = { PORT: '5202', MTHERIOS_PORT: '5203', MYTHENGINE_PORT: '5204' };
	assert.equal(resolveRuntimeOptions([], context).port, 5204);
	assert.equal(resolveRuntimeOptions(['--port', '5205'], context).port, 5205);
	assert.equal(resolveRuntimeOptions(['--config', 'mtherios.config.json', '--port', '5206'], context).wikiEmbedApiKey, 'legacy-secret');
	assert.deepEqual(context.env, { PORT: '5202', MTHERIOS_PORT: '5203', MYTHENGINE_PORT: '5204' });
});

test('inherited env cannot silently connect to Mtherios or its data', t => {
	const context = fixture(t);
	for (const env of [
		{DATABASE_URL:'postgres://mtherios:private@127.0.0.1:5432/mtherios'},
		{QDRANT_URL:'http://localhost:6333'}, {MTHERIOS_DATA_ROOT:path.dirname(context.cwd)},
	]) assert.throws(() => resolveRuntimeOptions([], {...context, env}), /MythEngine isolation/);
	const shared = resolveRuntimeOptions(['--allow-shared-runtime'], {...context, env:{PORT:'5173'}});
	assert.equal(shared.port, 5173);
	assert.equal(shared.allowSharedRuntime, true);
	const replacement = resolveRuntimeOptions(['--port', '5173'], context);
	assert.equal(replacement.appUrl, 'http://127.0.0.1:5173');
	assert.equal(replacement.allowSharedRuntime, false);
	assert.equal(new URL(replacement.databaseUrl).port, '5433');
	assert.equal(new URL(replacement.qdrantUrl).port, '6335');
	assert.throws(() => resolveRuntimeOptions(['--port', 'NaN'], context), /Invalid application port/);
});

test('path isolation follows junctions and accepts nonexistent descendants', t => {
	const context = fixture(t);
	assert.doesNotThrow(() => assertLocalPath(path.join(context.cwd,'data','new'),context.cwd));
	assert.throws(() => assertLocalPath(path.join(context.cwd,'..','other'),context.cwd), /isolation/);
	const outside=fs.mkdtempSync(path.join(os.tmpdir(),'mythengine-outside-'));
	t.after(() => removeFixture(outside));
	fs.symlinkSync(outside,path.join(context.cwd,'linked'),process.platform==='win32'?'junction':'dir');
	assert.throws(() => assertLocalPath(path.join(context.cwd,'linked','new'),context.cwd), /isolation/);
});

test('resolved env aliases agree and config diagnostics cannot disclose credentials', t => {
	const context = fixture(t);
	const config = resolveRuntimeOptions([], {...context,env:{MYTHENGINE_TURN_JOBS:'false',WIKI_EMBED_API_KEY:'private-key'}});
	const env = buildRuntimeEnv(config, {});
	assert.equal(env.MYTHENGINE_DATA_ROOT,env.MTHERIOS_DATA_ROOT);
	assert.equal(env.MYTHENGINE_DATABASE_URL,env.DATABASE_URL);
	assert.equal(env.MYTHENGINE_TURN_JOBS,'false');
	assert.equal(env.MTHERIOS_TURN_JOBS,'false');
	assert.equal(JSON.stringify(safeRuntimeSummary(config)).includes('private-key'),false);
});

test('Compose owns only MythEngine resources and never drops volumes on down', t => {
	const config=resolveRuntimeOptions([],fixture(t));
	const command=composeCommand('up',config);
	assert.deepEqual(command.args.slice(0,3),['compose','--project-name','mythengine']);
	assert.ok(command.args.includes('mythengine-db'));
	assert.ok(!command.args.some(x=>x.includes('mtherios')));
	assert.equal(command.env.MYTHENGINE_DB_PORT,'5433');
	assert.equal(command.env.MYTHENGINE_DB_NAME,'mythengine');
	assert.equal(command.env.MYTHENGINE_QDRANT_PORT,'6335');
	assert.ok(!composeCommand('down',config).args.includes('--volumes'));
	assert.throws(()=>composeCommand('prune',config),/Use backend/);
});
