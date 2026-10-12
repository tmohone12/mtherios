import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import tailwindcss from '@tailwindcss/vite';
import { fixture } from '../evals/replay/court-intrigue.mjs';

// Disposable browser acceptance server. No live database URL or model option.
const root = resolve(import.meta.dirname, '..');
const runId = randomUUID();
const name = `mtherios-ui-fixture-${runId}`;
const scratch = await mkdtemp(resolve(tmpdir(), 'mtherios-ui-fixture-'));
const stopFile = resolve(scratch, 'stop');
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60000 }).trim();
const originalFetch = globalThis.fetch;
let containerId, vite, client;
try {
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', name, '--label', `mtherios.ui-fixture=${runId}`, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=fixture', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	const inspected = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspected.Config.Labels['mtherios.ui-fixture'], runId);
	const port = inspected.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	Object.assign(process.env, {
		DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:${port.HostPort}/fixture`,
		MTHERIOS_CONFIG: resolve(scratch, 'config.json'), MTHERIOS_DATA_ROOT: resolve(scratch, 'data'),
		MTHERIOS_VAULT_ROOT: resolve(scratch, 'vaults'), MTHERIOS_DEFAULT_VAULT: resolve(scratch, 'vaults/default'),
		MTHERIOS_ALLOW_EXTERNAL_VAULTS: 'false', MTHERIOS_TURN_JOBS: 'false', MTHERIOS_WIKI_AUTO_INDEX: 'false', MTHERIOS_WIKI_AUTO_LINT: 'false', MTHERIOS_GENERATION_TIMING: 'off',
		MEMORY_EMBEDDING_PROVIDER: '', MEMORY_EMBEDDING_MODEL: '', MEMORY_EMBEDDING_BASE_URL: '', MEMORY_EMBEDDING_URL: '', MEMORY_EMBEDDING_API_KEY: '',
		QDRANT_URL: 'http://fixture.invalid/qdrant', OLLAMA_URL: 'http://fixture.invalid/ollama', WIKI_EMBED_API_KEY: '', UI_FIXTURE_API_KEY: 'synthetic-only',
	});
	await writeFile(process.env.MTHERIOS_CONFIG, '{}\n');
	for (let attempt = 0; ; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'fixture', '-d', 'fixture'); break; }
		catch { assert(attempt < 40, 'Fixture database did not start'); await delay(250); }
	}
	execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { cwd: root, env: process.env, windowsHide: true, timeout: 60000, stdio: 'pipe' });
	const storyId = 'ui_acceptance_campaign';
	const data = fixture(storyId);
	const sourceId = 'ui_neris_source';
	const sourceQuote = 'Neris is the harbor clerk. She records each ship in the blue ledger.';
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url === 'http://fixture.invalid/v1/chat/completions') {
			const body = JSON.parse(init.body);
			const content = body.model === 'fixture-narrative' ? data.narration : body.model === 'fixture-classifier' ? JSON.stringify(data.extraction)
				: JSON.stringify({ facts: [{ field: 'bio', value: sourceQuote, sourceId, quote: sourceQuote }] });
			if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
			return Response.json({ id: 'fixture-response', model: body.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 } });
		}
		if (url.startsWith('http://127.0.0.1:5174/')) return originalFetch(input, init);
		throw new Error('External services are disabled in the UI fixture');
	};
	vite = await createServer({ root, configFile: false, envFile: false, plugins: [tailwindcss(), sveltekit()],
		cacheDir: resolve(root, 'node_modules/.vite-ui-fixture'), server: { host: '127.0.0.1', port: 5174, strictPort: true, hmr: false } });
	await vite.listen();
	// Initialize SvelteKit's private environment before directly loading services.
	await originalFetch('http://127.0.0.1:5174/');
	const load = (path) => vite.ssrLoadModule(`/src/lib/server/${path}.ts`);
	client = await load('db/client');
	assert.equal((await load('env')).getServerMemoryConfig().databaseUrl, process.env.DATABASE_URL);
	const schema = await load('db/schema');
	const db = client.getDb();
	await db.insert(schema.stories).values({ ...data.story, title: 'UI acceptance fixture' });
	await db.insert(schema.entities).values(data.entities);
	await db.insert(schema.storyEntries).values([...data.entries, { id: sourceId, storyId, type: 'narration', position: 2, content: sourceQuote }]);
	await db.insert(schema.storyEntries).values(Array.from({ length: 240 }, (_, index) => ({
		id: `ui_scene_${index}`, storyId, type: 'narration', position: index + 3,
		content: index === 0 ? '[Great Hall]\nMara promised to meet Ilan after the harbor hearing.' : `[Great Hall]\nThe lamps flicker beside window ${index}. The courtyard remains quiet.`,
	})));
	await (await load('memory/sceneCheckpoint')).refreshSceneCheckpoint(storyId);
	await db.insert(schema.storyEvents).values(data.events);
	await db.insert(schema.agreements).values([
		{ id: 'ui_contested_agreement', storyId, parties: ['Mara', 'Player'], category: 'promise', terms: 'Keep the harbor lantern burning.', status: 'contested', secrecy: 'known' },
		{ id: 'ui_fulfilled_agreement', storyId, parties: ['Mara', 'Player'], category: 'promise', terms: 'Return the silver bell.', status: 'fulfilled', secrecy: 'known' },
		{ id: 'ui_annulled_agreement', storyId, parties: ['Mara', 'Player'], category: 'marriage', terms: 'The ivory marriage bond.', status: 'annulled', secrecy: 'known' },
		{ id: 'ui_superseded_agreement', storyId, parties: ['Mara', 'Player'], category: 'treaty', terms: 'The former northern-road treaty.', status: 'superseded', secrecy: 'known' },
		{ id: 'ui_secret_agreement', storyId, parties: ['Mara', 'Player'], category: 'oath', terms: 'The hidden emerald oath.', status: 'annulled', secrecy: 'secret' },
	]);
	await db.insert(schema.patchProposals).values({ id: 'ui_neris_candidate', storyId, proposalType: 'character_reference_review', targetTable: 'entities', targetRecordId: 'unresolved_neris', proposedBy: 'chapter_summary', status: 'needs_review', reason: 'Recurring named harbor clerk', suggestion: 'Build supported details from the story, then review.', sourceEntryIds: [sourceId], operations: [{ op: 'review', path: '/entities/character', value: { storyId, type: 'character', name: 'Neris', state: {} } }], metadata: { sourceName: 'Neris' } });
	await db.insert(schema.backendJobs).values({ id: 'ui_retry_job', storyId, type: 'create_memory_nodes_from_events', status: 'failed', attemptCount: 3, maxAttempts: 3, payload: { eventIds: [] }, lastError: 'Fixture interruption after a saved result.', metadata: {} });
	await db.insert(schema.llmServiceSettings).values(['narrative', 'classifier', 'characterUpdate'].map(serviceId => ({ serviceId, providerType: 'openai', baseUrl: 'http://fixture.invalid/v1', model: `fixture-${serviceId}`, apiKeyRef: 'UI_FIXTURE_API_KEY', contextBudget: 12000, maxTokens: 2048, temperature: 0 })));
	const { processServerTurn } = await load('turn/orchestrator');
	await processServerTurn({ storyId, clientTurnId: 'ui_fixture_turn', playerText: 'I hand Mara the sealed letter.', actionType: 'do', localVersion: 0, clientContext: { deferStateExtraction: false, contextBudget: 12000, chapterThreshold: 200 } });
	console.log(`UI_FIXTURE_READY http://127.0.0.1:5174/ story=${storyId} container=${containerId}`);
	console.log(`Create this stop file to clean up: ${stopFile}`);
	await new Promise(resolveStop => {
		const timer = setInterval(() => { if (existsSync(stopFile)) { clearInterval(timer); resolveStop(); } }, 250);
		const stop = () => { clearInterval(timer); resolveStop(); };
		process.once('SIGINT', stop); process.once('SIGTERM', stop);
	});
} finally {
	globalThis.fetch = originalFetch;
	await client?.closeDb();
	await vite?.close();
	if (containerId) {
		const inspected = JSON.parse(docker('inspect', containerId))[0];
		assert.equal(inspected.Name, `/${name}`);
		assert.equal(inspected.Config.Labels['mtherios.ui-fixture'], runId);
		docker('stop', '--time', '2', containerId);
	}
	assert(scratch.startsWith(`${resolve(tmpdir())}${sep}mtherios-ui-fixture-`));
	await rm(scratch, { recursive: true, force: true });
	console.log('Disposable UI fixture removed.');
}

