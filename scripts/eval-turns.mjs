import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { eq, sql } from 'drizzle-orm';
import { createServer } from 'vite';
import { factText, fixture, observedFacts, observedState } from '../evals/replay/court-intrigue.mjs';
import { harnessBuildId } from './harness-build-id.mjs';
import { runPiAgentLoop } from './eval-pi-agent-loop.mjs';
import { runFactionSettlement } from './eval-faction-settlement.mjs';

// No database URL or live story option. Every execution owns its disposable DB.
const { values } = parseArgs({ options: { mutation: { type: 'string', default: 'none' }, model: { type: 'string' }, provider: { type: 'string' }, scenario: { type: 'string' }, 'max-cost-usd': { type: 'string' }, 'prose-only': { type: 'boolean', default: false }, 'quiet-prose': { type: 'boolean', default: false }, 'jev-review-trial': { type: 'boolean', default: false }, 'jev-inline-trial': { type: 'boolean', default: false }, roll: { type: 'boolean', default: false }, 'agent-loop': { type: 'boolean', default: false }, 'pi-only': { type: 'boolean', default: false } }, allowPositionals: false });
assert(['none', 'missing-fact', 'secret-leak', 'wrong-state'].includes(values.mutation), 'Unknown mutation');
assert(!values.provider || values.model, '--provider requires --model');
assert(!values.model || (values.mutation === 'none' && process.env.REPLAY_MODEL_API_KEY?.trim()), 'Model mode requires REPLAY_MODEL_API_KEY and cannot run deliberate mutations');
assert(!values.roll || !values.model, '--roll uses a synthetic roll response and is available only offline');
assert(!values['agent-loop'] || !values.model, '--agent-loop is a deterministic offline fixture');
assert(!values['pi-only'] || (values['agent-loop'] && !values['jev-inline-trial'] && !values.scenario), '--pi-only requires --agent-loop without Jev or a scenario');
assert(!values['prose-only'] || values.model, '--prose-only requires --model');
assert(!values['quiet-prose'] || (values.model && values['prose-only'] && !values.scenario), '--quiet-prose requires --model and --prose-only without --scenario');
assert(!values['jev-review-trial'] || (values.model && /^~?typesafe\/jev-[\w.-]+$/.test(values.model) && !values['prose-only'] && !values.scenario), '--jev-review-trial requires a Jev --model without --scenario');
assert(!values['jev-inline-trial'] || (values['agent-loop'] && !values.model && process.env.REPLAY_JEV_API_KEY?.trim()), '--jev-inline-trial requires --agent-loop and REPLAY_JEV_API_KEY');
const root = resolve(import.meta.dirname, '..');
const runId = randomUUID();
const containerName = `mtherios-turn-replay-${runId}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
const scratch = await mkdtemp(resolve(tmpdir(), 'mtherios-turn-replay-'));
const originalFetch = globalThis.fetch;
let containerId, vite, client;
const results = [];
const replaySources = ['scripts/eval-turns.mjs', 'scripts/eval-pi-agent-loop.mjs', 'scripts/eval-faction-settlement.mjs', 'evals/replay/court-intrigue.mjs',
	'src/lib/server/evals/replayRunner.ts', 'src/lib/server/turn/orchestrator.ts', 'src/lib/server/turn/promptPacket.ts',
	'src/lib/server/turn/provider.ts', 'src/lib/server/turn/jev.ts', 'src/lib/server/turn/turnMemoryEnvelope.ts',
	'src/lib/contracts/memory.ts', 'src/lib/contracts/sourceFiles.ts', 'src/lib/server/engine/agentRuns.ts',
	'src/lib/server/engine/agentRuntime.ts', 'src/lib/server/engine/sourceFiles.ts', 'src/lib/server/engine/assistantConversations.ts',
	'src/lib/server/engine/assistantTools.ts', 'src/lib/server/memory/retrieval.ts', 'src/lib/server/memory/ranking.ts',
	'src/lib/server/jobs/memoryCoverage.ts', 'src/lib/server/jobs/processor.ts', 'src/lib/server/wiki/storyVault.ts'];
async function waitForAgentRun(owner, input) {
	const deadline = Date.now() + 30_000;
	let run;
	do {
		run = await owner.getAgentRun(input);
		if (!['running', 'committing'].includes(run.status)) return run;
		await delay(25);
	} while (Date.now() < deadline);
	return run;
}
async function runMemoryHealthFault({ db, schema, load }) {
	const storyId = 'replay_memory_health_fault', data = fixture(storyId);
	const oldText = '[Great Hall]\nSTALE_RULE: the bridge remains closed.', newText = '[Great Hall]\nThe corrected bridge rule permits passage tomorrow.';
	data.story.serverVersion = 2;
	data.entries = [{ id: `${storyId}_player_old`, storyId, type: 'user_action', position: 1, content: 'I ask for the bridge rule.' },
		{ id: `${storyId}_old`, storyId, type: 'narration', position: 2, parentId: `${storyId}_player_old`, content: oldText, metadata: { deadlineKey: 'bridge-rule' } },
		{ id: `${storyId}_player_new`, storyId, type: 'user_action', position: 3, content: 'I ask the keeper to confirm the correction.' },
		{ id: `${storyId}_new`, storyId, type: 'narration', position: 4, parentId: `${storyId}_player_new`, content: newText,
			metadata: { deadlineKey: 'bridge-rule', isCorrection: true, supersedesEntryIds: [`${storyId}_old`] } }];
	data.entries = data.entries.map(entry => ({ ...entry, createdAt: `2026-10-01T00:00:0${entry.position}.000Z`, updatedAt: `2026-10-01T00:00:0${entry.position}.000Z` }));
	await db.insert(schema.stories).values(data.story);
	await db.insert(schema.entities).values(data.entities);
	await db.insert(schema.storyEntries).values(data.entries);
	await db.insert(schema.memoryNodes).values({ id: `${storyId}_stale_summary`, storyId, type: 'episodic', title: 'Older bridge rule summary',
		content: 'STALE_RULE: the bridge remains closed.', summary: 'STALE_RULE: the bridge remains closed.', importance: .9,
		sourceEntryIds: [`${storyId}_old`], metadata: { deadlineKey: 'bridge-rule', layer: 'summary' }, createdAt: '2026-10-01T00:00:02.500Z', updatedAt: '2026-10-01T00:00:02.500Z' });
	await db.insert(schema.backendJobs).values([
		{ id: `${storyId}_extracted`, projectId: 'shelf_default', storyId, type: 'extract_turn_state', status: 'complete',
			payload: { assistantEntryId: `${storyId}_old`, playerText: data.entries[0].content, narration: oldText, serverVersion: 2 } },
		{ id: `${storyId}_checkpoint`, projectId: 'shelf_default', storyId, type: 'refresh_scene_checkpoint', status: 'complete', payload: { serverVersion: 3 } },
		{ id: `${storyId}_summary`, projectId: 'shelf_default', storyId, type: 'summarize_chapter', status: 'failed', lastError: 'Synthetic summary projection is stale.', payload: { serverVersion: 2 } },
		{ id: `${storyId}_index`, projectId: 'shelf_default', storyId, type: 'index_canonical_records', status: 'failed', lastError: 'Synthetic optional index is unavailable.', payload: { serverVersion: 2 } },
	]);
	const { materializeStoryVault, markStoryVaultIndexed, getStoryVaultStatus } = await load('wiki/storyVault');
	const materialized = await materializeStoryVault({ storyId, clean: true });
	await markStoryVaultIndexed({ storyId, collection: materialized.collection, provider: 'synthetic', model: 'replay-local-hash' });
	await db.execute(sql`update stories set server_version=3 where id=${storyId}`);
	const { getBackendJobStats } = await load('jobs/processor');
	const before = await getBackendJobStats(storyId), vault = await getStoryVaultStatus(storyId);
	assert.equal(before.memoryCoverage.missingSources, 1, 'Missing extraction was hidden by completed projections');
	assert.equal(before.memoryCoverage.lastContiguousPosition, 2);
	assert.equal(before.memoryCoverage.oldestUnresolvedPosition, 4);
	assert.equal(before.memoryCoverage.oldestUnresolvedReason, 'missing');
	assert.equal(before.memoryStageFreshness.checkpoint.status, 'current');
	assert.equal(before.memoryStageFreshness.consolidation.status, 'attention');
	assert.equal(before.memoryStageFreshness.consolidation.latestSourceVersion, 2);
	assert.equal(before.memoryStageFreshness.optionalIndex.status, 'attention');
	assert.equal(vault.serverVersion, 3);
	assert.equal(vault.manifestVersion, 2);
	assert.equal(vault.indexedVersion, 2);
	assert.equal(vault.vaultFresh, false);
	assert.equal(vault.indexFresh, false);
	const previousFetch = globalThis.fetch, names = ['MEMORY_EMBEDDING_PROVIDER', 'MEMORY_EMBEDDING_MODEL', 'MEMORY_EMBEDDING_BASE_URL', 'MEMORY_EMBEDDING_API_KEY'];
	const previousEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
	let attempts = 0, packet;
	try {
		Object.assign(process.env, { MEMORY_EMBEDDING_PROVIDER: 'openai', MEMORY_EMBEDDING_MODEL: 'synthetic-unavailable', MEMORY_EMBEDDING_BASE_URL: 'http://replay.invalid/v1', MEMORY_EMBEDDING_API_KEY: 'synthetic-only' });
		globalThis.fetch = async input => { assert.equal(String(input), 'http://replay.invalid/v1/embeddings'); attempts++; throw new Error('Synthetic optional vector outage'); };
		const { retrieveMemoryPacket } = await load('memory/retrieval');
		const query = { storyId, query: 'What is the corrected bridge rule?', includeSemantic: true, includeSecret: false, maxTokens: 3000 };
		packet = await retrieveMemoryPacket(query);
		const repeated = await retrieveMemoryPacket(query);
		assert.deepEqual(repeated.nodes.map(node => node.id), packet.nodes.map(node => node.id), 'Degraded recall was not deterministic');
		assert.equal(repeated.packet, packet.packet);
		assert.equal(attempts, 2, 'Fault fixture did not exercise optional vector dispatch');
		assert(packet.retrievalDebug.some(message => message.includes('Vector memory: unavailable')), 'Optional vector failure was not separately reported');
		assert(packet.packet.includes('permits passage tomorrow'), `Missing extraction/stale summary/index prevented canonical transcript recall: ${JSON.stringify({ packet: packet.packet, nodes: packet.nodes.map(node => ({ id: node.id, metadata: node.metadata })), debug: packet.retrievalDebug })}`);
		assert(!packet.packet.includes('STALE_RULE'), 'A stale source-linked summary overrode the correction');
	} finally {
		globalThis.fetch = previousFetch;
		for (const name of names) if (previousEnv[name] === undefined) delete process.env[name]; else process.env[name] = previousEnv[name];
	}
	const after = await getBackendJobStats(storyId);
	assert.deepEqual(after.memoryCoverage, before.memoryCoverage, 'Read-only degraded recall repaired or hid extraction gaps');
	assert.deepEqual(after.memoryStageFreshness, before.memoryStageFreshness);
	assert.equal((await getStoryVaultStatus(storyId)).indexedVersion, 2);
	console.log('PASS memory-health-fault-001: missing extraction, stale summary/index, optional vector outage and deterministic corrected transcript fallback');
	return { id: 'memory-health-fault-001', passed: true, providerCalls: 0, vectorFaultAttempts: attempts, missingExtraction: before.memoryCoverage,
		stageFreshness: before.memoryStageFreshness, vaultFresh: vault.vaultFresh, indexFresh: vault.indexFresh, indexedVersion: vault.indexedVersion,
		retainedSourceIds: packet.nodes.map(node => node.id), vectorFailureReported: true, deterministicFallback: true, noHealthMutation: true };
}
async function runAssistantApproval({ db, schema, load }) {
	const previousFetch = globalThis.fetch, projectId = 'replay_assistant_approval', typeId = 'replay_approval_type', itemId = 'replay_approval_item';
	await db.insert(schema.shelves).values({ id: projectId, name: 'Disposable approval project', slug: projectId,
		settings: { agentTools: { schemaVersion: 1, revision: 1, overrides: { assistantPiRuntime: true } } } });
	await db.insert(schema.llmServiceSettings).values({ serviceId: 'assistant', providerType: 'openai', baseUrl: 'http://replay.invalid/v1',
		model: 'replay-assistant-approval', apiKeyRef: 'REPLAY_API_KEY', contextBudget: 12000, maxTokens: 1500, temperature: 0, enabled: true });
	try {
		const definition = { fields: { notes: { kind: 'longtext' } }, defaults: { notes: '' }, layout: [{ title: 'Notes', fields: ['notes'] }], gmContextMode: 'searchable' };
		await db.insert(schema.contentTypes).values({ id: typeId, projectId, key: 'approval_notes', extension: 'md', name: 'Approval notes', definition });
		await db.insert(schema.contentItems).values({ id: itemId, projectId, typeId, title: 'Retained approval document', slug: 'retained-approval', data: { notes: 'Retain this canonical content.' } });
		const owner = await load('engine/assistantConversations'), scope = { projectId };
		const initial = await owner.createAssistantConversation(scope);
		const conversationId = String(initial.conversation.id), calls = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			assert.equal(url, 'http://replay.invalid/v1/chat/completions', 'Approval replay attempted an external provider');
			const body = JSON.parse(init.body); assert.equal(body.model, 'replay-assistant-approval');
			calls.push(body); assert(calls.length <= 2, 'Approval replay repeated provider dispatch');
			let message;
			if (calls.length === 1) message = { role: 'assistant', content: '', tool_calls: [
				{ id: 'clear_layout', type: 'function', function: { name: 'clearLayout', arguments: JSON.stringify({ id: typeId, expectedRevision: 1 }) } },
				{ id: 'forbidden_later_update', type: 'function', function: { name: 'update', arguments: JSON.stringify({ id: itemId, expectedRevision: 1, expectedTypeRevision: 1, changes: { data: { notes: 'UNAUTHORIZED_AFTER_PAUSE' } } }) } },
			] };
			else {
				const accepted = body.messages.find(row => row.role === 'tool' && row.tool_call_id === 'clear_layout');
				const skipped = body.messages.find(row => row.role === 'tool' && row.tool_call_id === 'forbidden_later_update');
				assert(accepted, 'Resumed native history lost the accepted approval receipt');
				const receipt = JSON.parse(accepted.content);
				assert.equal(receipt.applied, true); assert.equal(receipt.afterRevision, 2); assert(receipt.approvalId);
				assert(skipped?.content.includes('Skipped after an interaction paused this batch.'), 'Later native call was not explicitly skipped after approval');
				message = { role: 'assistant', content: `Applied changes to ${typeId}, revision 2: its layout is cleared. Document content is retained.` };
			}
			return Response.json({ id: `approval_fake_${calls.length}`, model: body.model, choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 80, completion_tokens: 30, total_tokens: 110, cost: 0 } });
		};
		const paused = await owner.sendAssistantMessage({ ...scope, conversationId, clientMessageId: 'approval_native_message', content: 'Remove the type layout after I approve the preview. Retain its fields and document data.' });
		assert.equal(paused.run?.status, 'awaiting_input', `Approval failed to pause: ${JSON.stringify(paused.run)}`);
		assert.equal(paused.run.runtimeVersion, 'pi-v1'); assert.equal(paused.approvals.length, 1);
		const approval = paused.approvals[0], runId = String(paused.run.id);
		assert.equal(approval.kind, 'layout_clear'); assert.equal(approval.status, 'pending');
		assert.equal(approval.preview.requiresClearConfirmation, true); assert.equal(approval.preview.impact.total, 1);
		assert.deepEqual(approval.preview.changes, [{ field: 'definition.layout', from: definition.layout, to: [] }]);
		let [currentType] = await db.execute(sql`select revision,definition from content_types where id=${typeId}`);
		assert.equal(currentType.revision, 1); assert.deepEqual(currentType.definition.layout, definition.layout);
		const pendingCalls = await db.execute(sql`select call_id,status from assistant_tool_calls where run_id=${runId}`);
		assert.deepEqual([...pendingCalls], [{ call_id: 'clear_layout', status: 'reserved' }], 'Later native call was admitted before human review');
		const review = { ...scope, conversationId, runId, approvalId: String(approval.id), expectedRevision: Number(approval.revision), decision: 'approve' };
		const completed = await owner.reviewAssistantApproval(review);
		assert.equal(completed.run?.status, 'completed', `Approved reply failed: ${JSON.stringify(completed.run)}`);
		[currentType] = await db.execute(sql`select revision,definition from content_types where id=${typeId}`);
		assert.equal(currentType.revision, 2); assert.deepEqual(currentType.definition, { ...definition, layout: [] });
		const [item] = await db.execute(sql`select revision,data from content_items where id=${itemId}`);
		assert.equal(item.revision, 1); assert.deepEqual(item.data, { notes: 'Retain this canonical content.' });
		const ledger = await db.execute(sql`select call_id,status,result from assistant_tool_calls where run_id=${runId}`);
		assert.equal(ledger.length, 1); assert.equal(ledger[0].status, 'completed'); assert.equal(ledger[0].result.afterRevision, 2);
		const [history] = await db.execute(sql`select count(*)::integer as count from content_revisions where target_id=${typeId} and revision=2`);
		assert.equal(history.count, 1, 'Approved canonical type revision was not admitted exactly once');
		assert(completed.messages.some(message => message.role === 'assistant' && message.source_refs.some(ref => ref.kind === 'content_type' && ref.id === typeId && ref.revision === 2)), 'Published reply lost the applied revision source receipt');
		await owner.reviewAssistantApproval(review);
		assert.equal(calls.length, 2, 'Repeated accepted approval dispatched another provider request');
		assert.equal((await db.execute(sql`select revision from content_types where id=${typeId}`))[0].revision, 2, 'Repeated accepted approval duplicated a canonical write');
		console.log('PASS pi-assistant-approval-001: real preview and human approval, later native batch call skipped, one canonical revision and idempotent acceptance');
		return { id: 'pi-assistant-approval-001', passed: true, runtime: 'pi-v1', providerCalls: 0, syntheticRequests: calls.length,
			approvalKind: approval.kind, canonicalTypeRevision: 2, documentRevision: item.revision, laterBatchSkipped: true, canonicalWrites: history.count, acceptedReceipt: ledger[0].result };
	} finally {
		globalThis.fetch = previousFetch;
		await db.execute(sql`delete from llm_service_settings where service_id='assistant' and model='replay-assistant-approval'`);
	}
}
try {
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', containerName, '--label', `mtherios.turn-replay=${runId}`,
		'--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=replay', '-e', 'POSTGRES_PASSWORD=replay', '-e', 'POSTGRES_DB=replay',
		'-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	const inspect = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspect.Config.Labels['mtherios.turn-replay'], runId);
	const port = inspect.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	const databaseUrl = `postgres://replay:replay@127.0.0.1:${port.HostPort}/replay`;
	Object.assign(process.env, {
		MYTHENGINE_ALLOW_SHARED_RUNTIME: 'true', // This harness owns its verified disposable DB and temporary paths.
		DATABASE_URL: databaseUrl, MTHERIOS_CONFIG: resolve(scratch, 'config.json'), MTHERIOS_DATA_ROOT: resolve(scratch, 'data'),
		MTHERIOS_VAULT_ROOT: resolve(scratch, 'vaults'), MTHERIOS_DEFAULT_VAULT: resolve(scratch, 'vaults/default'),
		MTHERIOS_ALLOW_EXTERNAL_VAULTS: 'false', MTHERIOS_TURN_JOBS: 'false', MTHERIOS_WIKI_AUTO_INDEX: 'false', MTHERIOS_WIKI_AUTO_LINT: 'false', MTHERIOS_GENERATION_TIMING: 'off',
		MEMORY_EMBEDDING_PROVIDER: '', MEMORY_EMBEDDING_MODEL: '', MEMORY_EMBEDDING_BASE_URL: '', MEMORY_EMBEDDING_URL: '', MEMORY_EMBEDDING_API_KEY: '',
		QDRANT_URL: 'http://replay.invalid/qdrant', OLLAMA_URL: 'http://replay.invalid/ollama', WIKI_EMBED_PROVIDER: 'local-hash', WIKI_EMBED_MODEL: 'replay-local-hash', WIKI_EMBED_API_KEY: '', WIKI_EMBED_URL: '', REPLAY_API_KEY: 'synthetic-only',
	});
	await writeFile(process.env.MTHERIOS_CONFIG, '{}\n');
	globalThis.fetch = async () => { throw new Error('Replay network calls are disabled before fixture execution'); };
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'replay', '-d', 'replay'); ready = true; break; }
		catch { await delay(250); }
	}
	assert(ready, 'Disposable replay database did not become ready');
	execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { cwd: root, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
	vite = await createServer({ root, configFile: false, envFile: false, appType: 'custom', cacheDir: resolve(scratch, 'vite-cache'),
		server: { middlewareMode: true, hmr: false, ws: false, watch: null }, resolve: { alias: { $lib: resolve(root, 'src/lib') } },
		plugins: [{ name: 'replay-env', resolveId: (id) => id === '$env/dynamic/private' ? '\0replay-env' : undefined,
			load: (id) => id === '\0replay-env' ? 'export const env = process.env;' : undefined }],
	});
	const load = (path) => vite.ssrLoadModule(`/src/lib/server/${path}.ts`);
	client = await load('db/client');
	assert.equal((await load('env')).getServerMemoryConfig().databaseUrl, databaseUrl);
	const schema = await load('db/schema');
	const { parseReplayScenarioJsonl, parseReplaySpendCap, scoreReplayResult, replayModelConfig, forwardReplayModelRequest } = await load('evals/replayRunner');
	const modelConfig = replayModelConfig(values.model, values.provider, process.env.REPLAY_MODEL_API_KEY);
	const spendCapUsd = parseReplaySpendCap(values['max-cost-usd'], Boolean(modelConfig || values['jev-inline-trial']));
	let providerSpendUsd = 0;
	console.log(modelConfig ? `Opt-in model replay: ${modelConfig.provider}/${modelConfig.model}; synthetic fixtures only, six calls maximum per scenario, ${spendCapUsd} USD reported-spend cap.`
		: values['jev-inline-trial'] ? `Opt-in Jev inline replay: synthetic narration, real Decisions API, ${spendCapUsd} USD reported-spend cap.`
			: 'Deterministic replay: real turn pipeline, synthetic provider responses, no model calls.');
	process.env.REPLAY_API_KEY = modelConfig?.apiKey ?? (values['jev-inline-trial'] ? process.env.REPLAY_JEV_API_KEY : 'synthetic-only');
	const { processServerTurn } = await load('turn/orchestrator');
	const { promptRequestSummary } = await load('turn/promptReceipt');
	const db = client.getDb();
	await db.insert(schema.llmServiceSettings).values(['narrative', 'classifier'].map((serviceId) => ({ serviceId, providerType: modelConfig?.provider ?? 'openai', baseUrl: modelConfig?.baseUrl ?? 'http://replay.invalid/v1', model: modelConfig?.model ?? `replay-${serviceId}`, apiKeyRef: 'REPLAY_API_KEY', contextBudget: 12000, maxTokens: modelConfig ? 4096 : 2048, temperature: 0 })));
	const scenarioFiles = (await readdir(resolve(root, 'evals/scenarios'))).filter((file) => file.endsWith('.jsonl')).sort();
	const scenarios = (await Promise.all(scenarioFiles.map(async (file) => parseReplayScenarioJsonl(await readFile(resolve(root, 'evals/scenarios', file), 'utf8'), file)))).flat();
	assert(scenarios.length > 0, 'No replay scenarios');
	assert.equal(new Set(scenarios.map((item) => item.id)).size, scenarios.length, 'Duplicate scenario IDs');
	const selectedScenarios = values['pi-only'] || values['quiet-prose'] || values['jev-review-trial'] ? [] : values.scenario ? scenarios.filter((item) => item.id === values.scenario) : scenarios;
	assert(values['pi-only'] || values['quiet-prose'] || values['jev-review-trial'] || selectedScenarios.length, `Unknown replay scenario: ${values.scenario}`);
	await db.insert(schema.stories).values({ id: 'foreign_replay', title: 'Other story' });
	await db.insert(schema.memoryNodes).values({ id: 'foreign_fact', storyId: 'foreign_replay', type: 'canonical', title: 'Mara sealed letter', content: 'FOREIGN_REPLAY_SENTINEL', importance: 1 });
	// Qualify the background lane before foreground turn fixtures enqueue their priority checkpoint jobs.
	if (values['agent-loop'] && !values['pi-only']) results.push(await runFactionSettlement({ db, schema, load }));
	for (const [index, scenario] of selectedScenarios.entries()) {
		assert(['court-intrigue', 'court-returning-npc', 'court-corrected-report'].includes(scenario.storyFixture), `No executable fixture for ${scenario.storyFixture}`);
		for (const id of [...scenario.mustIncludeFactIds, ...scenario.mustNotRevealFactIds, ...(scenario.mustNotIncludeFactIds ?? [])]) assert(Object.hasOwn(factText, id), `No fact detector for ${id}`);
		const storyId = `replay_story_${index}`;
		const data = fixture(storyId, values.mutation, values.roll, scenario.storyFixture);
		await db.insert(schema.stories).values(data.story);
		await db.insert(schema.entities).values(data.entities);
		await db.insert(schema.storyEntries).values(data.entries);
		await db.insert(schema.storyEvents).values(data.events);
		if (data.beliefs.length) await db.insert(schema.npcBeliefs).values(data.beliefs);
		if (data.memoryNodes.length) await db.insert(schema.memoryNodes).values(data.memoryNodes);
		const requests = [];
		const costs = [];
		const forbiddenRequests = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (modelConfig && url === `${modelConfig.baseUrl}/chat/completions`) {
				assert(requests.length < 6, 'Replay exceeded six bounded model requests');
				const body = JSON.parse(init.body);
				if (values['prose-only'] && body.response_format) {
					requests.push(body);
					return Response.json({ id: `synthetic_classifier_${requests.length}`, model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify(data.extraction) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
				}
				const remainingUsd = spendCapUsd - providerSpendUsd;
				const observedRequestCap = costs.length ? Math.max(...costs) : 0;
				if (remainingUsd <= 0 || (observedRequestCap && remainingUsd < observedRequestCap)) throw new Error(`Replay stopped before another model request: ${remainingUsd} USD remains under the spend cap`);
				requests.push(body);
				const forwarded = await forwardReplayModelRequest(modelConfig, url, init, originalFetch);
				const providerBody = await forwarded.response.clone().json().catch(() => null);
				if (!providerBody?.choices?.[0]?.message?.content) console.warn('Replay provider returned no narration text:', JSON.stringify({
					status: forwarded.response.status, finishReason: providerBody?.choices?.[0]?.finish_reason ?? null,
					outputTokens: providerBody?.usage?.completion_tokens ?? null, reasoningTokens: providerBody?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
				}));
				if (forwarded.costUsd === null) throw new Error('Replay model response omitted usage.cost; refusing to continue under the declared spend cap');
				providerSpendUsd += forwarded.costUsd;
				if (providerSpendUsd > spendCapUsd) throw new Error(`Replay reported spend ${providerSpendUsd} USD above declared cap ${spendCapUsd} USD`);
				costs.push(forwarded.costUsd);
				return forwarded.response;
			}
			if (url !== 'http://replay.invalid/v1/chat/completions') { forbiddenRequests.push(url); throw new Error(`Replay forbids external request: ${url}`); }
			const body = JSON.parse(init.body);
			assert(['replay-narrative', 'replay-classifier'].includes(body.model), 'Unexpected model request');
			requests.push(body);
			const content = body.model === 'replay-narrative' ? body.messages.at(-1).content.includes('Continue immediately after the roll result.') ? data.continuation : data.narration : JSON.stringify(data.extraction);
			return Response.json({ id: `fake_${requests.length}`, model: body.model, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, prompt_tokens_details: { cached_tokens: 20 }, input_tokens_details: { cache_creation_tokens: 5 }, cost: 0.0001 } });
		};
		const request = { storyId, clientTurnId: `replay_turn_${index}`, playerText: scenario.playerAction, actionType: 'do', localVersion: 0,
			clientContext: { deferStateExtraction: false, contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100 } };
		const start = performance.now();
		const response = await processServerTurn(request);
		const totalLatencyMs = performance.now() - start;
		assert.equal(forbiddenRequests.length, 0, 'Turn attempted an unapproved external service');
		assert(requests.some((item) => !item.response_format), 'Narration provider was not exercised');
		assert(requests.some((item) => item.response_format), `Extraction provider was not exercised: ${response.warnings.join('; ')}`);
		assert.equal(response.gmTurnReceipt?.stateExtractionStatus, 'succeeded', JSON.stringify(response.gmTurnReceipt));
		const generationCosts = (response.generationTimings ?? []).map((timing) => timing.providerCostUsd);
		assert(generationCosts.length > 0, 'Completed turn did not return generation telemetry');
		assert(generationCosts.every((cost) => typeof cost === 'number' && Number.isFinite(cost) && cost >= 0), `Provider-reported cost was unavailable: ${JSON.stringify(generationCosts)}`);
		if (!modelConfig) assert((response.generationTimings ?? []).every((timing) => timing.providerCostUsd === 0.0001 && timing.cachedInputTokens === 20 && timing.cacheWriteTokens === 5), 'Synthetic provider telemetry was not preserved');
		assert.equal(response.performance?.generation.providerCostUsd, generationCosts.reduce((sum, cost) => sum + cost, 0), 'Aggregate provider cost did not match generation timings');
		if (!modelConfig) {
			assert.equal(response.performance?.generation.cachedInputTokens, generationCosts.length * 20, 'Aggregate provider cache-read tokens did not match generation timings');
			assert.equal(response.performance?.generation.cacheWriteTokens, generationCosts.length * 5, 'Aggregate provider cache-write tokens did not match generation timings');
		}
		const narrationRequests = requests.filter((item) => !item.response_format);
		const summaries = response.contextReceipt?.selection?.requests ?? [];
		assert.equal(summaries.length, narrationRequests.length, 'Receipt omitted a narration provider request');
		if (values.roll) assert.equal(summaries.length, 2, 'Synthetic dice roll did not exercise continuation');
		if (!modelConfig) for (const [requestIndex, body] of narrationRequests.entries()) {
			const summary = summaries[requestIndex];
			const systemChars = summary.sections.find((section) => section.id === 'system').chars;
			const dynamicChars = summary.sections.find((section) => section.id === 'context').chars;
			const wireSystem = body.messages[0].content;
			assert.equal(wireSystem.length, systemChars + dynamicChars + (dynamicChars ? 2 : 0), 'Provider system bytes do not match receipt segments');
			const wireContext = dynamicChars ? wireSystem.slice(systemChars + 2) : '';
			for (const span of summary.sourceSpans) assert((span.section === 'system' ? wireSystem.slice(0, systemChars) : wireContext).slice(span.start, span.end).trim(), `Empty retained source span ${span.id}`);
			const actualSummary = promptRequestSummary(summary.id, wireSystem.slice(0, systemChars), wireContext, body.messages.slice(1, -1), body.messages.at(-1).content, summary.sourceSpans);
			assert.deepEqual(summary, actualSummary, 'Receipt does not match captured outgoing request text');
		}
		const [savedNarration] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, response.assistantEntryId));
		assert.deepEqual(savedNarration.metadata.contextReceipt, response.contextReceipt, 'Context receipt was not persisted with narration');
		assert.deepEqual(savedNarration.metadata.generationTimings, response.generationTimings, 'Generation cost telemetry was not persisted with narration');
		const apiLogs = await db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.storyId, storyId));
		assert(apiLogs.length >= generationCosts.length, 'Provider API-call telemetry was not persisted');
		if (!modelConfig) assert(apiLogs.every((log) => log.metadata?.providerCostUsd === 0.0001 && log.metadata?.cachedInputTokens === 20 && log.metadata?.cacheWriteTokens === 5), 'Synthetic provider telemetry metadata was not persisted');
		const relationships = await db.select().from(schema.relationships).where(eq(schema.relationships.storyId, storyId));
		const promptText = requests.filter((item) => !item.response_format).flatMap((item) => item.messages.map((message) => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))).join('\n');
		if (data.requiredBeliefId) {
			assert(response.contextReceipt.selection.groups.find((group) => group.kind === 'beliefs')?.sentIds.includes(data.requiredBeliefId), 'Returning NPC belief did not reach the narrator');
			assert(promptText.includes('Mara: NPC learned: The delivery password is silver cranes cross at dawn.'), 'Returning NPC lost the learned detail behind its long recap');
			assert(!response.contextReceipt.selection.groups.find((group) => group.kind === 'recentEntries')?.sentIds.includes(`${storyId}_old_scene`), 'Returning NPC fixture failed to move its source outside recent dialogue');
		}
		if (data.supersededSourceId) {
			const [oldSource] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, data.supersededSourceId));
			assert.equal(oldSource.metadata.superseded, true, 'Corrected-report fixture must preserve its superseded source');
		}
		const observed = { includedFactIds: observedFacts(promptText), revealedFactIds: observedFacts(response.narration), statePatch: observedState(relationships, data.ids), estimatedCostUsd: modelConfig ? costs.every((cost) => cost !== null) ? costs.reduce((sum, cost) => sum + cost, 0) : null : 0, cachedInputTokens: modelConfig ? null : 0, totalLatencyMs };
		const score = scoreReplayResult(modelConfig ? { ...scenario, maxCostUsd: undefined } : scenario, observed);
		const snapshot = () => Promise.all([schema.storyEntries, schema.relationships, schema.statePatches, schema.backendJobs].map(async (table) => (await db.select({ id: table.id }).from(table).where(eq(table.storyId, storyId))).map((row) => row.id).sort()));
		const before = await snapshot();
		const requestCount = requests.length;
		const repeat = await processServerTurn(request);
		assert.equal(repeat.narration, response.narration, 'Idempotent replay returned different narration');
		assert.deepEqual(repeat.contextReceipt, response.contextReceipt, 'Idempotent replay lost the saved context receipt');
		assert.equal(requests.length, requestCount, 'Idempotent replay generated again');
		assert.deepEqual(await snapshot(), before, 'Idempotent replay duplicated canonical writes or jobs');
		results.push({ ...score, mutation: values.mutation, observed, idempotencyPassed: true, contextReceiptPassed: true, contextReceipt: response.contextReceipt, providerRequests: requests, narration: response.narration, warnings: response.warnings });
		console.log(`${score.passed ? 'PASS' : 'FAIL'} ${scenario.id}: ${score.findings.map((finding) => `${finding.passed ? 'ok' : 'FAIL'} ${finding.label}`).join(', ')}`);
	}
	if (values['jev-review-trial']) {
		const { continuitySentenceCandidates } = await load('jobs/processor');
		const { reviewJevContinuityCandidates } = await load('turn/jev');
		const longNarration = 'The hall is quiet. Bread rests on the table. The door stays closed. Ilan draws a chair. Mara watches the light. The clerk turns a page. Ilan asks Mara about passage. Mara says the passage is arranged.';
		const longSources = [{ id: 'entry_player', description: 'The player only asked Mara about passage.' },
			{ id: 'agreement_passage', description: 'Mara agreed only to discuss passage, not arrange it.' }];
		const longSelection = continuitySentenceCandidates(longNarration, longSources.map(source => source.description));
		assert(longSelection?.complete === false && longSelection.candidates.some(item => item.id === 'sentence_7'),
			`Jev review trial lost the late risky sentence in long prose: ${JSON.stringify(longSelection)}`);
		const narration = 'Ilan asks Mara about passage. The blue hall door stands beside Mara.';
		const evidence = { entries: [
			{ id: 'entry_player', type: 'user_action', content: 'I ask Mara about passage.' },
			{ id: 'entry_correction', type: 'ooc', content: 'Correction: The hall door is red, not blue.' },
		] };
		const sources = [{ id: 'entry_player', description: 'The player asked Mara about passage.' },
			{ id: 'entry_correction', description: 'Correction: The hall door is red, not blue.' }];
		const selection = continuitySentenceCandidates(narration, sources.map(source => source.description),
			[evidence.entries[1].content]);
		const candidates = selection?.candidates;
		assert(selection?.complete === true && candidates?.length === 2 && candidates[1]?.id === 'sentence_1',
			'Jev review trial did not fully select the short passage');
		let requests = 0;
		let answerSummary = null;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'https://openrouter.ai/api/alpha/decisions' || requests++ > 0)
				throw new Error(`Jev review trial blocked request: ${url}`);
			if (spendCapUsd - providerSpendUsd <= 0) throw new Error('Jev review trial reached its spend cap');
			const response = await originalFetch(input, init);
			const body = await response.clone().json().catch(() => null);
			answerSummary = Object.fromEntries(Object.entries(body?.answers ?? {}).map(([name, answer]) =>
				[name, { choice: answer.choice, confidence: answer.confidence,
					selectedProbability: answer.probabilities?.[answer.choice] ?? null }]));
			const cost = body?.usage?.cost;
			if (!response.ok || typeof cost !== 'number' || !Number.isFinite(cost))
				throw new Error(`Jev review trial lacked a successful costed response (HTTP ${response.status})`);
			providerSpendUsd += cost;
			if (providerSpendUsd > spendCapUsd) throw new Error('Jev review trial exceeded its spend cap');
			return response;
		};
		const result = await reviewJevContinuityCandidates({ profile: { providerType: 'openrouter', apiKey: modelConfig.apiKey },
			model: modelConfig.model, narration, candidates, evidence, sources });
		const second = result?.verdicts[1];
		const passed = requests === 1 && result?.verdicts[0]?.verdict === 'supported'
			&& ['ignored_correction', 'contradiction'].includes(second?.verdict ?? '')
			&& second?.sourceId === 'entry_correction';
		results.push({ id: 'jev-review-trial-001', passed, requests, candidateCoverage: selection,
			longCandidateCoverage: longSelection, answerSummary, verdicts: result?.verdicts ?? null });
		console.log(`${passed ? 'PASS' : 'FAIL'} jev-review-trial-001: exact sentence verdicts with explicit correction evidence`);
	}
	if (values['quiet-prose']) {
		const { strategicWorldFrameSchema } = await vite.ssrLoadModule('/src/lib/services/ai/sdk/schemas/strategicWorldBrain.ts');
		const storyId = 'replay_model_quiet_scene';
		const data = fixture(storyId);
		data.entities.push({ id: `${storyId}_clerk`, storyId, type: 'character', name: 'Booking Clerk',
			description: 'The booking clerk takes passage reservations at the hall travel counter.',
			state: { present: true } });
		data.entries[0].content += ' Bread and cheese are set out for breakfast. A booking clerk works at the hall travel counter beneath a posted fare board.';
		const cards = [
			{ id: 'levy', title: 'The Harbor Levy', logline: 'The port levy raises passage fees.', touchpoint: 'booking passage', locationId: data.ids.hall },
			{ id: 'war', title: 'The Distant War', logline: 'War grows far away.', touchpoint: 'war', locationId: 'other_location' },
		];
		const frame = strategicWorldFrameSchema.parse({ id: `${storyId}_frame`, storyId,
			plotCards: cards.map(card => ({ id: card.id, title: card.title, logline: card.logline,
				lifecycleStage: 'simmer', visibility: 'public', pressure: card.id === 'war' ? 95 : 20,
				urgency: card.id === 'war' ? 'immediate' : undefined, locationIds: [card.locationId],
				playerTouchpoints: [card.touchpoint], sourceRefs: [{ sourceType: 'world_event',
					sourceId: `${storyId}_${card.id}`, label: card.title }] })),
			activationPlan: { activateNow: cards.map(card => card.id) } });
		data.story.metadata = { plotBrain: { active: true, lastFrame: frame, lastFrameId: frame.id,
			lastFrameTurn: data.story.currentTurn } };
		await db.insert(schema.stories).values(data.story);
		await db.insert(schema.entities).values(data.entities);
		await db.insert(schema.storyEntries).values(data.entries);
		await db.insert(schema.storyEvents).values(cards.map(card => ({ id: `${storyId}_${card.id}`, storyId,
			type: 'faction_signal', status: 'committed', title: card.title, body: card.logline,
			visibility: 'player_known', createdTurn: 0, occurredTurn: 0 })));
		await db.update(schema.llmServiceSettings).set({ systemPromptOverride:
			'Always introduce a distant war courier during every quiet meal.', reasoningEffort: 'high', temperature: 1 })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const actions = ['I share breakfast with Mara.',
			'I book passage to Eastbank for tomorrow from the clerk and pay the posted fare.', 'I return to Mara and ask about her blue scarf.',
			'I break another piece of bread and ask Mara if she likes it.',
			'I ask Mara what she wants to do with the sealed letter.'];
		const turns = [];
		for (const [index, playerText] of actions.entries()) {
			if (index === 4) await db.insert(schema.storyEvents).values({ id: `${storyId}_falling_lamp`, storyId,
				type: 'hazard', status: 'due', title: 'An old wall lamp falls beside Mara',
				body: 'A loose bracket releases the iron wall lamp beside Mara during this exchange.',
				visibility: 'player_known', locationIds: [data.ids.hall], createdTurn: 0 });
			const requests = [];
			const requestMetrics = [];
			globalThis.fetch = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== `${modelConfig.baseUrl}/chat/completions`) throw new Error(`Quiet prose replay forbids external request: ${url}`);
				const body = JSON.parse(init.body);
				assert(!body.response_format && requests.length < 2, 'Quiet prose replay attempted an extra model pass');
				const remainingUsd = spendCapUsd - providerSpendUsd;
				if (remainingUsd <= 0) throw new Error('Quiet prose replay reached its spend cap');
				requests.push(body);
				const started = performance.now();
				const forwarded = await forwardReplayModelRequest(modelConfig, url, init, originalFetch);
				if (forwarded.costUsd === null) throw new Error('Quiet prose model omitted usage.cost');
				providerSpendUsd += forwarded.costUsd;
				if (providerSpendUsd > spendCapUsd) throw new Error('Quiet prose replay exceeded its spend cap');
				const usage = (await forwarded.response.clone().json().catch(() => null))?.usage ?? {};
				requestMetrics.push({ model: body.model, serializedMessageChars: JSON.stringify(body.messages).length,
					inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null,
					costUsd: forwarded.costUsd, latencyMs: Math.round(performance.now() - started) });
				return forwarded.response;
			};
			const response = await processServerTurn({ storyId, clientTurnId: `quiet_model_${index}`, playerText,
				actionType: 'do', localVersion: index, clientContext: { deferStateExtraction: true,
					contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100 } });
			const [entry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, response.assistantEntryId));
			const promptText = requests.map(request => JSON.stringify(request.messages)).join('\n');
			const remoteTitleAt = promptText.indexOf('The Distant War');
			turns.push({ action: playerText, narration: response.narration,
				cueCard: entry.metadata.factionCueReceipt?.cardId ?? null,
				cueMode: entry.metadata.factionCueReceipt?.mode ?? null,
				requestCount: requests.length, requestMetrics,
				dangerInPrompt: index === 4 ? promptText.includes('An old wall lamp falls beside Mara') : null,
				dangerInProse: index === 4 ? /lamp|bracket/i.test(response.narration) : null,
				remoteTitleInPrompt: remoteTitleAt >= 0,
				remoteTitleContext: remoteTitleAt >= 0 ? promptText.slice(Math.max(0, remoteTitleAt - 160), remoteTitleAt + 220) : null });
		}
		const passed = turns[0].cueCard === null && turns[1].cueCard === 'levy' && turns[2].cueCard === null
			&& turns[3].cueCard === null && turns[4].cueCard === null && turns[4].dangerInPrompt && turns[4].dangerInProse
			&& turns.every(turn => turn.requestCount === 1 && !turn.remoteTitleInPrompt)
			&& !/war courier|distant war/i.test(`${turns[0].narration}\n${turns[2].narration}\n${turns[3].narration}\n${turns[4].narration}`);
		results.push({ id: 'quiet-prose-model-001', passed, turns });
		console.log(`${passed ? 'PASS' : 'FAIL'} quiet-prose-model-001: quiet breakfast, relevant booking, two ordinary follow-ups, local danger`);
	}
	if (values['agent-loop']) {
		// Historic classifier fixtures intentionally exercise rollback; the separate Pi cohort owns its new project.
		await db.execute(sql`update shelves set settings=settings || jsonb_build_object('agentTools',jsonb_build_object('schemaVersion',1,'revision',1,'overrides',jsonb_build_object('gmPiRuntime',false)))`);
		results.push(await runMemoryHealthFault({ db, schema, load }));
		results.push(await runPiAgentLoop({ root, db, schema, load }));
		results.push(await runAssistantApproval({ db, schema, load }));
	}
	if (values['agent-loop'] && !values['pi-only']) {
		const { startAgentRun } = await load('engine/agentRuns');
		const { enqueueBackendJob } = await load('jobs/outbox');
		const { runBackendJobNow } = await load('jobs/processor');
		const { advanceStoryTurn, loadGmTimelineBrief } = await load('events/timeline');
		const priorityStoryId = 'replay_due_scene_priority';
		const priorityData = fixture(priorityStoryId);
		await db.insert(schema.stories).values(priorityData.story);
		await db.insert(schema.entities).values(priorityData.entities);
		await db.insert(schema.storyEntries).values(priorityData.entries);
		await db.insert(schema.storyEvents).values([
			...Array.from({ length: 12 }, (_, index) => ({ id: `${priorityStoryId}_remote_${index}`, storyId: priorityStoryId,
				type: 'scheme', status: 'due', title: `Remote pressure ${index}`, body: 'The distant port prepares.',
				locationIds: ['distant_port'], createdTurn: 2 })),
			{ id: `${priorityStoryId}_hall`, storyId: priorityStoryId, type: 'scheme', status: 'due',
				title: 'Hall door jams', body: 'The hall door is blocked.', locationIds: [priorityData.ids.hall], createdTurn: 1 },
			{ id: `${priorityStoryId}_mara`, storyId: priorityStoryId, type: 'scheme', status: 'due',
				title: 'Mara falls', body: 'Mara is injured beside the player.', actorEntityIds: [priorityData.ids.mara], createdTurn: 1 },
		]);
		const priorityBrief = await loadGmTimelineBrief({ storyId: priorityStoryId, sceneEntityIds: [priorityData.ids.mara],
			dueLimit: 2, recentLimit: 0, scheduledLimit: 0, npcLimit: 0, npcEventLimit: 0 });
		assert.deepEqual(new Set(priorityBrief.dueEvents.map(event => event.id)),
			new Set([`${priorityStoryId}_hall`, `${priorityStoryId}_mara`]), 'Remote due backlog displaced a scene consequence before the query limit');
		results.push({ id: 'due-scene-priority-001', passed: true, selectedIds: priorityBrief.dueEvents.map(event => event.id) });
		console.log('PASS due-scene-priority-001: two local due effects outrank twelve remote events before the SQL limit');
		await db.update(schema.llmServiceSettings).set({ contextWindowTokens: 6500 })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const priorityRequests = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Due-scene replay forbids external request: ${url}`);
			const request = JSON.parse(init.body);
			priorityRequests.push(request);
			return Response.json({ id: 'priority_fake', model: request.model,
				choices: [{ message: { role: 'assistant', content: '[Great Hall]\nMara steadies herself beside the jammed hall door.' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const priorityToolCalls = [];
		const priorityEngine = await load('engine/command');
		const priorityOrchestrator = await load('turn/orchestrator');
		const priorityTurn = await processServerTurn({ storyId: priorityStoryId, clientTurnId: 'priority_turn',
			playerText: 'I ask Mara about the jammed hall door.', actionType: 'say', localVersion: 1,
			clientContext: { deferStateExtraction: true, contextBudget: 600, chapterThreshold: 200, postChapterBuffer: 100,
				sceneEntityIds: [priorityData.ids.mara] } }, {
			agentRunObservations: Array.from({ length: 120 }, (_, index) =>
				`Verified scene observation ${index + 1}: the hall remains occupied while Mara checks the blocked door.`).join('\n'),
			runGmTool: async (call) => {
				priorityToolCalls.push(call.command);
				const response = await priorityEngine.executeEngineCommand({ storyId: priorityStoryId,
					command: call.command, clientCommandId: `priority:${call.id}`,
					args: priorityOrchestrator.normalizeGmToolArgs(call) });
				if (response.status !== 'succeeded') throw new Error(response.error ?? `${call.command} failed`);
				return response.result;
			},
		});
		assert(priorityToolCalls.includes('world.actor.brief'), 'Due-scene turn did not perform a GM read');
		assert.equal(priorityRequests.length, 1, 'Due-scene replay made an unexpected second model request');
		assert(!priorityRequests[0].response_format && !priorityRequests[0].tools, 'Due-scene replay did not capture the narrator request');
		assert.equal(priorityTurn.contextReceipt?.truncated, true, 'Due-scene fixture did not exercise context clipping');
		assert(priorityTurn.warnings.some(warning => warning.includes('Final narration context budget applied after tool observations')),
			'Due-scene turn did not exercise the post-tool budget');
		const priorityMessages = JSON.stringify(priorityRequests[0].messages ?? []);
		assert(priorityMessages.includes('world.actor.brief'), 'GM tool observation was lost before the narrator request');
		assert(priorityMessages.includes('Hall door jams') && priorityMessages.includes('The hall door is blocked.')
			&& priorityMessages.includes('Mara falls') && priorityMessages.includes('Mara is injured beside the player.')
			&& !priorityMessages.includes('Remote pressure 0'), 'Final narrator request lost local due effects or leaked remote pressure');
		results.push({ id: 'due-scene-request-001', passed: true, truncated: priorityTurn.contextReceipt?.truncated ?? null,
			gmToolCalls: priorityToolCalls });
		console.log('PASS due-scene-request-001: post-tool narrator request retained both local due effects');
		await db.update(schema.llmServiceSettings).set({ contextWindowTokens: null })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const storyId = 'replay_agent_loop';
		const data = fixture(storyId);
		data.entities.push({ id: `${storyId}_serra`, storyId, type: 'character', name: 'Serra',
			description: 'A harbor scout.', state: { present: true, bio: 'Serra secretly knows the southern tunnel.', speechStyle: 'Brisk and direct.' } });
		data.entities.find(entity => entity.id === data.ids.mara).state = {
			present: true, bio: 'Mara secretly carries the northern key.', speechStyle: 'Careful and measured.' };
		await db.insert(schema.llmServiceSettings).values({ serviceId: 'dialogue', providerType: 'openai',
			baseUrl: 'http://replay.invalid/v1', model: 'replay-dialogue', apiKeyRef: 'REPLAY_API_KEY',
			contextBudget: 12000, maxTokens: 2048, temperature: 0, enabled: true });
		await db.insert(schema.stories).values(data.story);
		await db.insert(schema.entities).values(data.entities);
		await db.insert(schema.storyEntries).values(data.entries);
		const { getAgentSettings, saveAgentSettings } = await load('engine/agentSettings');
		const replayAgentSettings = await getAgentSettings({ projectId: 'shelf_default' });
		await saveAgentSettings({ projectId: 'shelf_default', expectedRevision: replayAgentSettings.project.revision,
			changes: { gmResearch: true } });
		const dueId = `${storyId}_harbor_gate`;
		await db.insert(schema.storyEvents).values({ id: dueId, storyId, type: 'faction_signal', status: 'due',
			title: 'Harbor gate closure', body: 'The harbor guard closes the gate.',
			visibility: 'player_known', createdTurn: 1, scheduledTurn: 2, metadata: { plotBrain: true } });
		const riverRouteId = `${storyId}_river_route`;
		await db.insert(schema.storyEvents).values({ id: riverRouteId, storyId, type: 'npc_opportunity', status: 'committed',
			title: 'River guild passage', body: 'Mara can offer passage by river.', visibility: 'player_known', createdTurn: 0 });
		const narrations = [
			'Mara says “I offer the river path.” The gate remains open.',
			'The harbor guard closes the gate. Mara says “The route is blocked.”',
			'Mara folds the map beside the closed gate.\n\n“We can use the river path.”\n\nSerra says “I will scout ahead.” The closed gate remains behind them.',
		];
		let toolCalls = 0;
		const plannerPackets = [];
		const dialoguePackets = [];
		const agentProviderRequests = [];
		const agentResults = [];
		for (let turnIndex = 0; turnIndex < 3; turnIndex++) {
			let plannerRound = 0;
			globalThis.fetch = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Agent replay forbids external request: ${url}`);
				const body = JSON.parse(init.body);
				agentProviderRequests.push({ turnIndex,
					role: body.tools?.length ? 'planner' : body.model === 'replay-dialogue' ? 'dialogue' : body.response_format ? 'classifier' : 'narrator',
					promptChars: JSON.stringify(body.messages ?? []).length, promptTokens: 100, completionTokens: 40 });
				let message;
				if (body.tools?.length) {
					plannerPackets.push({ turnIndex, body });
					const calls = plannerRound++ === 0 ? (turnIndex === 0
						? [{ name: 'read', args: { command: 'campaign.status' } },
							{ name: 'recall', args: { command: 'campaign.transcriptPage', args: { limit: 4 } } }]
						: ['campaign.status', 'plot.thread.board'].map(command => ({ name: 'read', args: { command } })))
						.map((call, index) => ({ id: `agent_${turnIndex}_${index}`, type: 'function',
							function: { name: call.name, arguments: JSON.stringify(call.args) } })) : [];
					toolCalls += calls.length;
					message = calls.length ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: '{"kind":"final","text":"done"}' };
				} else if (body.model === 'replay-dialogue') {
					const packet = JSON.parse(body.messages.at(-1).content);
					dialoguePackets.push({ turnIndex, packet });
					message = { role: 'assistant', content: turnIndex === 0 ? 'invalid dialogue JSON' : JSON.stringify({ lines:
						packet.utterances.map(utterance => ({ index: utterance.index, text: utterance.speech })) }) };
				} else if (body.response_format) {
					message = { role: 'assistant', content: JSON.stringify({ update: {}, dueEventFeedback: turnIndex === 0
						? [{ id: dueId, outcome: 'deferred', evidenceSpan: '' }]
						: turnIndex === 1 ? [{ id: dueId, outcome: 'realized', evidenceSpan: 'The harbor guard closes the gate.' }] : [] }) };
				} else message = { role: 'assistant', content: narrations[turnIndex] };
				return Response.json({ id: `agent_fake_${turnIndex}_${plannerRound}`, model: body.model,
					choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
					usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
			};
			const turn = { storyId, clientTurnId: `agent_loop_${turnIndex}`, playerText: turnIndex === 0 ? 'Ask Mara about the harbor.' : turnIndex === 1 ? 'I accept.' : 'Ask Mara for another route.',
				actionType: 'do', localVersion: turnIndex, clientContext: { deferStateExtraction: turnIndex === 0, contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100,
					presentNpcIds: [data.ids.mara, `${storyId}_serra`] } };
			const run = await startAgentRun({ turn }, storyId);
			assert.equal(run.status, 'completed', `Agent turn ${turnIndex} failed: ${run.error ?? 'unknown'}`);
			assert.equal((await startAgentRun({ turn }, storyId)).id, run.id, 'Same-run restart created a duplicate turn');
			agentResults.push(run);
			if (turnIndex === 0) assert.equal(run.result?.turn?.gmTurnReceipt?.steps?.find(step => step.id === 'dialogue')?.status, 'failed', 'Invalid dialogue did not fall back to the GM draft');
			const [due] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, dueId));
			assert.equal(due.status, turnIndex === 0 ? 'due' : 'committed');
			if (turnIndex === 1) assert(due.sourceEntryIds.includes(`narration_agent_loop_${turnIndex}`));
		}
		assert.equal(toolCalls, 6, 'Agent planner did not make two independent lookups per turn');
		assert(JSON.stringify(plannerPackets.filter(item => item.turnIndex === 0).at(-1)?.body.messages).includes('Mara returns from the courtyard'),
			'GM recall result did not reach the next planner round');
		const recallEvents = await db.execute(sql`select data from agent_run_events where run_id=${agentResults[0].id} and event_type='tool.completed' and data->>'tool'='recall'`);
		assert.equal(recallEvents.length, 1, `GM recall tool result was not recorded: tools=${JSON.stringify(plannerPackets[0].body.tools?.map(tool => tool.function?.name ?? tool.name))}, calls=${JSON.stringify(await db.execute(sql`select tool,call_id,status from agent_tool_calls where run_id=${agentResults[0].id}`))}`);
		assert(!('result' in recallEvents[0].data), 'GM-only recall text leaked into the player-visible event stream');
		const acceptancePlan = plannerPackets.find(item => item.turnIndex === 1)?.body;
		assert(acceptancePlan?.messages?.some(message => String(message.content).includes('I offer the river path.')),
			'The planner lost the offer answered by a short acceptance');
		const plannerEvents = await db.execute(sql`select data from agent_run_events where run_id=${agentResults[1].id} and event_type='provider.completed'`);
		const plannerReceipt = plannerEvents.map(row => row.data.plannerReceipt).find(Boolean);
		assert(plannerReceipt?.tokens?.context > 0 && Array.isArray(plannerReceipt.omittedSourceIds),
			'Planner run event lost its request-specific budget receipt');
		assert(plannerReceipt.historySourceIds.includes('narration_agent_loop_0'),
			'Planner receipt lost the prior offer source ID');
		const thirdTurnDialogue = dialoguePackets.filter(item => item.turnIndex === 2);
		assert.equal(thirdTurnDialogue.length, 2, `Multiple NPC speakers were not given separate dialogue requests: ${JSON.stringify(thirdTurnDialogue.map(item => item.packet.utterances.map(utterance => [utterance.speakerId, utterance.speakerName])))}`);
		const maraPacket = thirdTurnDialogue.find(item => item.packet.utterances[0]?.speakerName === 'Mara')?.packet;
		const serraPacket = thirdTurnDialogue.find(item => item.packet.utterances[0]?.speakerName === 'Serra')?.packet;
		assert(maraPacket && serraPacket, 'Dialogue speaker identity was lost');
		assert(!JSON.stringify(maraPacket.actorContext).includes('southern tunnel'), 'Serra private card leaked into Mara dialogue');
		assert(!JSON.stringify(serraPacket.actorContext).includes('northern key'), 'Mara private card leaked into Serra dialogue');
		const [thirdEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, 'narration_agent_loop_2'));
		const dialogueReceipts = thirdEntry.metadata.dialoguePass?.requests ?? [];
		assert.equal(dialogueReceipts.length, 2, 'Saved dialogue receipt lost per-speaker request identity');
		assert(dialogueReceipts.every(receipt => receipt.contextHash && receipt.requestTokens > 0),
			'Saved dialogue receipt did not measure the actual request');
		assert(dialogueReceipts.find(receipt => receipt.speakerId === data.ids.mara)?.omittedSourceIds.includes(`requiredActors:${storyId}_serra`),
			'Mara receipt did not record the omitted Serra card');
		const laggedExtraction = (await db.select().from(schema.backendJobs).where(eq(schema.backendJobs.storyId, storyId)))
			.find(job => job.type === 'extract_turn_state' && job.payload.assistantEntryId === 'narration_agent_loop_0');
		assert(laggedExtraction && laggedExtraction.status === 'queued', 'Deferred feedback job was not left pending during later turns');
		const { applyDueEventFeedback, applyFactionCueFeedback, factionCueCandidate } = await load('events/dueEventFeedback');
		const laggedCue = { cardId: 'river_guild_passage', sourceKey: `event:${riverRouteId}`,
			sceneKey: 'harbor|primary', title: 'River guild passage', logline: 'Mara offers passage by river.' };
		const [laggedEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, 'narration_agent_loop_0'));
		await db.update(schema.storyEntries).set({ metadata: { ...laggedEntry.metadata, factionCueReceipt: {
			...laggedCue, status: 'selected', sourceFingerprint: laggedExtraction.payload.sourceFingerprint,
		} } }).where(eq(schema.storyEntries.id, laggedEntry.id));
		await db.update(schema.backendJobs).set({ payload: { ...laggedExtraction.payload, factionCue: laggedCue,
			dueEventCandidates: [...laggedExtraction.payload.dueEventCandidates, factionCueCandidate(laggedCue)] } })
			.where(eq(schema.backendJobs.id, laggedExtraction.id));
		const eventIdsBeforeLag = (await db.select({ id: schema.storyEvents.id }).from(schema.storyEvents)
			.where(eq(schema.storyEvents.storyId, storyId))).map(row => row.id).sort();
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Lagged extraction forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			agentProviderRequests.push({ turnIndex: 3, role: 'classifier', promptChars: JSON.stringify(body.messages ?? []).length,
				promptTokens: 100, completionTokens: 40 });
			return Response.json({ id: 'lagged_feedback', model: body.model, choices: [{ message: { role: 'assistant', content: JSON.stringify({ update: {}, dueEventFeedback: [
				{ id: dueId, outcome: 'realized', evidenceSpan: 'The harbor guard closes the gate.' },
				{ id: factionCueCandidate(laggedCue).id, outcome: 'signal', evidenceSpan: 'I offer the river path.' },
			] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const lagged = await runBackendJobNow(laggedExtraction.id, 'agent-loop-lagged-feedback');
		assert(lagged.completed, `Lagged extraction failed: ${lagged.error ?? 'unknown'}`);
		const [afterLag] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, dueId));
		assert.deepEqual(afterLag.sourceEntryIds, ['narration_agent_loop_1'], 'Lagged feedback rewrote a later event realization');
		const [afterLagEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, laggedEntry.id));
		assert.equal(afterLagEntry.metadata.factionCueReceipt.status, 'surfaced', 'Deferred extraction lost the cue presentation');
		const [afterLagStory] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert(afterLagStory.metadata.factionPresentation.sourceKeys.includes(laggedCue.sourceKey), 'Deferred cue source was not recorded');
		assert.deepEqual((await db.select({ id: schema.storyEvents.id }).from(schema.storyEvents)
			.where(eq(schema.storyEvents.storyId, storyId))).map(row => row.id).sort(), eventIdsBeforeLag,
			'Deferred cue created a false world event');
		const { buildChapterThreadPlan } = await load('plotBrain/chapterThreads');
		const { persistChapterThreadPlan } = await load('jobs/processor');
		const oldThreadId = `${storyId}_old_thread`;
		const otherThreadId = `${storyId}_other_thread`;
		const evidenceId = `${storyId}_chapter_evidence`;
		const futureOldId = `${storyId}_future_old`;
		const futureOtherId = `${storyId}_future_other`;
		await db.insert(schema.storyThreads).values([
			{ id: oldThreadId, storyId, description: 'Old blockade: The route is contested.', status: 'open' },
			{ id: otherThreadId, storyId, description: 'Other negotiation: A new offer is pending.', status: 'open' },
		]);
		await db.insert(schema.storyEvents).values([
			{ id: evidenceId, storyId, type: 'resolution', title: 'Blockade resolved', body: 'The blockade ends.', status: 'committed', threadIds: [oldThreadId] },
			{ id: futureOldId, storyId, type: 'plot_pressure', title: 'Old blockade returns', body: 'Old pressure.', status: 'scheduled', threadIds: [oldThreadId], metadata: { plotBrain: true } },
			{ id: futureOtherId, storyId, type: 'plot_pressure', title: 'Other negotiation moves', body: 'Other pressure.', status: 'scheduled', threadIds: [otherThreadId], metadata: { plotBrain: true } },
		]);
		const [beforeClosure] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		const frame = { id: 'replay_frame', storyId, plotCards: [
			{ id: 'old', title: 'Old blockade', logline: 'The route stays blocked.', storyThreadId: oldThreadId, lifecycleStage: 'simmer' },
			{ id: 'other', title: 'Other negotiation', logline: 'A fresh offer is pending.', storyThreadId: otherThreadId, lifecycleStage: 'simmer' },
		], activationPlan: { activateNow: ['old', 'other'] } };
		await db.update(schema.stories).set({ metadata: { ...beforeClosure.metadata,
			plotBrain: { lastFrame: frame, pendingFrame: frame, pendingFrameId: frame.id, closedThreadIds: [] },
			sceneCheckpoint: { notes: ['Old blockade still active.'] } } }).where(eq(schema.stories.id, storyId));
		const now = new Date().toISOString();
		const closurePlan = buildChapterThreadPlan({ storyId, chapterId: 'replay_chapter',
			existingThreads: [oldThreadId, otherThreadId].map(id => ({ id,
				description: id === oldThreadId ? 'Old blockade: The route is contested.' : 'Other negotiation: A new offer is pending.',
				status: 'open', significance: 'moderate', relatedFactionIds: [], relatedEntityIds: [],
				sourceEntryIds: [], sourceEventIds: [], sourcePatchIds: [] })),
			events: [{ id: evidenceId, threadIds: [oldThreadId] }],
			directives: { threadChanges: [{ threadId: oldThreadId, action: 'resolve', evidenceEventIds: [evidenceId] }], newThreads: [] },
			sourceEntryIds: ['narration_agent_loop_2'], serverVersion: beforeClosure.serverVersion + 1, now });
		const persistClosure = () => persistChapterThreadPlan({ storyId, chapterId: 'replay_chapter', chapterNumber: 1,
			plan: closurePlan, serverVersion: beforeClosure.serverVersion + 1, now });
		await persistClosure();
		await persistClosure();
		const [closedStory] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		const [closedThread] = await db.select().from(schema.storyThreads).where(eq(schema.storyThreads.id, oldThreadId));
		const [futureOld] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, futureOldId));
		const [futureOther] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, futureOtherId));
		const [pastEvidence] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, evidenceId));
		assert.equal(closedThread.status, 'closed', 'Chapter did not close the canonical thread');
		assert.equal(futureOld.status, 'cancelled', 'Chapter closure left linked future pressure active');
		assert.equal(futureOther.status, 'scheduled', 'Chapter closure cancelled unrelated pressure');
		assert.equal(pastEvidence.status, 'committed', 'Chapter closure rewrote accepted history');
		assert(closedStory.metadata.plotBrain.closedThreadIds.includes(oldThreadId), 'Closed thread ID was not recorded');
		for (const key of ['lastFrame', 'pendingFrame']) assert.deepEqual(closedStory.metadata.plotBrain[key].plotCards.map(card => card.id), ['other']);
		assert(!('sceneCheckpoint' in closedStory.metadata), 'Chapter closure retained stale scene checkpoint');
		const factionId = `${storyId}_ash`;
		const rivalId = `${storyId}_blue`;
		const projectId = `${storyId}_river_project`;
		await db.insert(schema.factions).values([
			{ id: factionId, storyId, name: 'Ash Court', pressure: 0, goals: ['Secure river trade with Blue Harbor'],
				metadata: { currentStoryEvidence: true, worldSimEnabled: true, worldSimPromoted: true, factionType: 'commercial' } },
			{ id: rivalId, storyId, name: 'Blue Harbor', pressure: 0 },
		]);
		await db.insert(schema.factionProjects).values({ id: projectId, storyId, factionId,
			project: 'Secure river trade with Blue Harbor', status: 'active', progress: 0.1,
			metadata: { sourceType: 'autonomous_faction_project', worldSimEnabled: true,
				projectKind: 'trade_contract', actionType: 'economic', targetFactionId: rivalId, nextActionTurn: 2 } });
		for (let step = 0; step < 2; step++) {
			const jobId = await enqueueBackendJob({ storyId, type: 'evaluate_world_sim_tick',
				dedupeKey: `agent-loop-tick-${step}`, payload: { ambient: false }, maxAttempts: 2 });
			const concurrentId = step === 0 ? await enqueueBackendJob({ storyId, type: 'evaluate_world_sim_tick',
				dedupeKey: 'agent-loop-tick-concurrent', payload: { ambient: false }, maxAttempts: 2 }) : null;
			const runs = await Promise.all([runBackendJobNow(jobId, `agent-loop-worker-${step}`),
				...(concurrentId ? [runBackendJobNow(concurrentId, 'agent-loop-worker-concurrent')] : [])]);
			for (const run of runs) {
				assert(run.completed, `Faction tick ${step} failed: ${run.error ?? 'unknown'}`);
				assert.equal(run.result?.createdEvents, 0, 'Intention review fabricated a canonical consequence');
			}
			const [project] = await db.select().from(schema.factionProjects).where(eq(schema.factionProjects.id, projectId));
			assert.equal(project.progress, .1, 'World ticks implicitly progressed an unresolved project');
			assert.equal(project.status, 'active', 'World ticks completed unaccepted intent');
		}
		// An explicitly accepted fixture consequence enters through canonical writers, independently of pending intent.
		const { scheduleTimelineEvent } = await load('events/timeline');
		const { patchWorldRecord } = await load('engine/worldRecords');
		const [causalStory] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		const lastMoveId = `${storyId}_accepted_trade`, signalId = `${storyId}_accepted_trade_signal`;
		const scheduledMove = await scheduleTimelineEvent({ id: lastMoveId, storyId, type: 'faction_move', title: 'Accepted Ash Court trade',
			body: 'Ash Court and Blue Harbor sign the verified trade contract.', factionIds: [factionId,rivalId], visibility: 'player_known',
			currentTurn: causalStory.currentTurn, delayTurns: 0, now: new Date().toISOString(), metadata: { publicSignalEventId: signalId, factionId, factionName: 'Ash Court', actionType: 'economic', target: 'Blue Harbor' } });
		await patchWorldRecord(storyId, 'events', lastMoveId, { expectedVersion: scheduledMove.serverVersion,
			updates: { status: 'committed', occurredTurn: causalStory.currentTurn, scheduledTurn: null }, reason: 'Accept deterministic replay trade evidence.' });
		await scheduleTimelineEvent({ id: signalId, storyId, type: 'faction_signal', title: 'Harbor trade prices',
			body: 'Ash Court prices, contracts, and credit shift at the harbor.', factionIds: [factionId], visibility: 'player_known',
			currentTurn: causalStory.currentTurn, delayTurns: 4, now: new Date().toISOString(), metadata: { sourceEventId: lastMoveId } });
		const moveIds = [lastMoveId];
		const [lastMove] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, lastMoveId));
		assert.equal(lastMove.status, 'committed', 'The faction consequence was not accepted canon');
		const [signal] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, signalId));
		assert(signal?.body && signal.sourceEntryIds.length === 0, 'The public signal was not linked to the accepted faction move');
		const { runPlotBrainPlanCommand } = await load('engine/serviceCommands');
		const { strategicWorldFrameSchema } = await vite.ssrLoadModule('/src/lib/services/ai/sdk/schemas/strategicWorldBrain.ts');
		let directorSawMove = false;
		const directorResult = await runPlotBrainPlanCommand({ storyId, trigger: 'faction_shock', execute: true,
			replacePendingFrameId: frame.id }, { planner: { plan: async strategicInput => {
			directorSawMove = strategicInput.factionActions.some(action => action.id === lastMoveId && action.factionName === 'Ash Court');
			assert(directorSawMove, 'Director input lost the accepted faction consequence');
			return strategicWorldFrameSchema.parse({ id: 'replay_causal_frame', storyId, trigger: 'faction_shock',
				arcNumber: 0, chapterRange: { from: 0, to: 0 },
				plotCards: [{ id: 'river_bargain', title: 'River bargain', logline: 'Ash Court trade activity changes the harbor bargain.',
					kind: 'faction_plot', lifecycleStage: 'reveal', visibility: 'player_known', actorFactionIds: [factionId],
					sourceRefs: [{ sourceType: 'world_event', sourceId: lastMoveId, label: 'Accepted Ash Court move' }] }],
				activationPlan: { activateNow: ['river_bargain'] } });
		} } });
		assert.equal(directorResult.executed, true, 'Director consequence frame was not applied');
		assert.equal(directorResult.frame.plotCards[0].sourceRefs[0].sourceId, lastMoveId);
		await advanceStoryTurn(storyId, 4);
		const [dueSignal] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, signalId));
		assert.equal(dueSignal.status, 'due', 'Public faction signal did not become due before the next scene');
		await db.insert(schema.npcBeliefs).values({ id: `${storyId}_serra_signal`, storyId, believerEntityId: `${storyId}_serra`,
			belief: 'Serra witnessed Ash Court prices, contracts, and credit shifting at the harbor.', confidence: 0.95,
			visibility: 'player_known', evidenceEventIds: [signalId], sourceEventIds: [signalId] });
		let fourthPlannerRound = 0;
		let fourthNarratorPacket = null;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Causal replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			const role = body.tools?.length ? 'planner' : body.model === 'replay-dialogue' ? 'dialogue' : body.response_format ? 'classifier' : 'narrator';
			agentProviderRequests.push({ turnIndex: 3, role, promptChars: JSON.stringify(body.messages ?? []).length,
				promptTokens: 100, completionTokens: 40 });
			let message;
			if (role === 'planner') {
				const calls = fourthPlannerRound++ === 0 ? ['campaign.status', 'plot.thread.board'].map((command, index) => ({
					id: `agent_3_${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ command }) },
				})) : [];
				toolCalls += calls.length;
				message = calls.length ? { role: 'assistant', content: null, tool_calls: calls } : { role: 'assistant', content: '{"kind":"final","text":"done"}' };
			} else if (role === 'dialogue') {
				const packet = JSON.parse(body.messages.at(-1).content);
				dialoguePackets.push({ turnIndex: 3, packet });
				message = { role: 'assistant', content: JSON.stringify({ lines: packet.utterances.map(utterance => ({ index: utterance.index, text: utterance.speech })) }) };
			} else if (role === 'classifier') {
				message = { role: 'assistant', content: JSON.stringify({ update: {}, dueEventFeedback: [
					{ id: signalId, outcome: 'realized', evidenceSpan: signal.body },
				] }) };
			} else {
				fourthNarratorPacket = body;
				message = { role: 'assistant', content: `${signal.body} Serra says “The harbor prices changed at dawn.”` };
			}
			return Response.json({ id: `agent_fake_3_${fourthPlannerRound}`, model: body.model,
				choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const fourthTurn = { storyId, clientTurnId: 'agent_loop_3', playerText: 'Ask Serra what changed at the harbor.',
			actionType: 'do', localVersion: 3, clientContext: { deferStateExtraction: false, contextBudget: 12000, chapterThreshold: 200,
				postChapterBuffer: 100, presentNpcIds: [`${storyId}_serra`] } };
		const fourthRun = await startAgentRun({ turn: fourthTurn }, storyId);
		assert.equal(fourthRun.status, 'completed', `Causal next turn failed: ${fourthRun.error ?? 'unknown'}`);
		agentResults.push(fourthRun);
		const fourthNarratorText = JSON.stringify(fourthNarratorPacket?.messages ?? []);
		assert(fourthNarratorText.includes('River bargain'), 'The next GM request lost Director pressure from the faction move');
		assert(!fourthNarratorText.includes('Old blockade returns'), 'The next GM request replayed closed pressure');
		assert(!fourthNarratorText.includes('"tool":"read"'), 'Raw GM state reads bypassed selected scene guidance');
		const serraDialogue = dialoguePackets.find(item => item.turnIndex === 3 && item.packet.utterances[0]?.speakerName === 'Serra')?.packet;
		assert(serraDialogue && JSON.stringify(serraDialogue.actorContext).includes('Ash Court prices, contracts'),
			'Serra did not receive her source-linked observation');
		const [fourthDialogueEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, 'narration_agent_loop_3'));
		assert(fourthDialogueEntry.metadata.dialoguePass?.requests?.some(receipt =>
			receipt.speakerId === `${storyId}_serra` && receipt.sourceIds.includes(`beliefs:${storyId}_serra_signal`)),
			'Serra dialogue receipt lost the event-linked belief ID');
		const [realizedSignal] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, signalId));
		const [fourthEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, 'narration_agent_loop_3'));
		assert.equal(realizedSignal.status, 'committed', `Final narration did not realize the public faction signal: ${JSON.stringify({
			feedback: fourthEntry?.metadata?.dueEventFeedbackReceipt, candidates: fourthEntry?.metadata?.dueEventCandidates,
			classifierRequests: agentProviderRequests.filter(request => request.turnIndex === 3 && request.role === 'classifier').length,
			warnings: fourthRun.result?.turn?.warnings, status: fourthRun.result?.turn?.stateExtractionStatus,
			entryMetadataKeys: Object.keys(fourthEntry?.metadata ?? {}), sourceContainsSignal: fourthEntry?.content?.includes(signal.body),
			resultDue: fourthRun.result?.turn?.statePatchIds, sourceContentLength: fourthEntry?.content?.length,
			stateExtraction: fourthEntry?.metadata?.stateExtraction, sourceFingerprint: fourthEntry?.metadata?.dueEventSourceFingerprint,
		})}`);
		assert(realizedSignal.sourceEntryIds.includes('narration_agent_loop_3'), 'Public signal lost its final narration source');
		const fifthTurn = { storyId, clientTurnId: 'agent_loop_4', playerText: 'Wait and watch the harbor.',
			actionType: 'do', localVersion: 4, clientContext: { deferStateExtraction: false, contextBudget: 12000,
				chapterThreshold: 200, postChapterBuffer: 100, presentNpcIds: [`${storyId}_serra`] } };
		const { prepareServerTurnContext } = await load('turn/orchestrator');
		const fifthPrepared = await prepareServerTurnContext(fifthTurn, { inspection: true });
		assert(!fifthPrepared.gmBrief.dueEvents.some(event => event.id === signalId), 'Realized signal returned as a fresh due beat');
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Follow-up replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			const role = body.tools?.length ? 'planner' : body.model === 'replay-dialogue' ? 'dialogue' : body.response_format ? 'classifier' : 'narrator';
			agentProviderRequests.push({ turnIndex: 4, role, promptChars: JSON.stringify(body.messages ?? []).length,
				promptTokens: 100, completionTokens: 40 });
			const message = { role: 'assistant', content: role === 'planner' ? '{"kind":"final","text":"done"}'
				: role === 'classifier' ? JSON.stringify({ update: {}, dueEventFeedback: [] })
				: 'The bargaining hall falls quiet while Serra studies the ledger.' };
			return Response.json({ id: 'agent_fake_4', model: body.model,
				choices: [{ message, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const fifthRun = await startAgentRun({ turn: fifthTurn }, storyId);
		assert.equal(fifthRun.status, 'completed', `Follow-up turn failed: ${fifthRun.error ?? 'unknown'}`);
		agentResults.push(fifthRun);
		const [afterFollowUp] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, signalId));
		assert.deepEqual(afterFollowUp.sourceEntryIds, ['narration_agent_loop_3'], 'Follow-up turn rewrote the realized signal');
		const { turnStateSourceFingerprint } = await load('jobs/outbox');
		const realizedFeedback = [{ id: signalId, outcome: 'realized', evidenceSpan: signal.body }];
		const retryResult = await applyDueEventFeedback({ storyId, assistantEntryId: 'narration_agent_loop_3',
			playerText: fourthTurn.playerText, narration: fourthEntry.content,
			sourceFingerprint: fourthEntry.metadata.dueEventSourceFingerprint,
			currentTurn: dueSignal.scheduledTurn, candidates: fourthEntry.metadata.dueEventCandidates,
			feedback: realizedFeedback });
		assert.deepEqual(retryResult, [signalId], 'Retry lost the accepted feedback identity');
		const [afterRetryEntry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, 'narration_agent_loop_3'));
		assert.deepEqual(afterRetryEntry.metadata.dueEventFeedbackReceipt, fourthEntry.metadata.dueEventFeedbackReceipt,
			'Retry overwrote the original successful feedback receipt');
		await db.insert(schema.storyEntries).values({ id: `${storyId}_stale_feedback`, storyId, type: 'narration',
			position: 9999, content: signal.body });
		const staleResult = await applyDueEventFeedback({ storyId, assistantEntryId: `${storyId}_stale_feedback`,
			playerText: 'Watch the harbor.', narration: signal.body,
			sourceFingerprint: turnStateSourceFingerprint('Watch the harbor.', signal.body),
			currentTurn: dueSignal.scheduledTurn, candidates: fourthEntry.metadata.dueEventCandidates,
			feedback: realizedFeedback });
		assert.deepEqual(staleResult, [], 'Stale candidate revision was accepted after the event changed');
		const parallelEventId = `${storyId}_parallel_secret`;
		await db.insert(schema.storyEvents).values({ id: parallelEventId, storyId, type: 'secret_plan',
			status: 'due', title: 'Other viewpoint secret', body: 'The unseen envoy opens the sealed gate.', visibility: 'secret',
			createdTurn: 1, scheduledTurn: 2 });
		const otherPov = await prepareServerTurnContext({ storyId, clientTurnId: 'agent_loop_other_pov_preview',
			playerText: '/pov Serra watches the harbor', actionType: 'do', localVersion: 5,
			clientContext: { deferStateExtraction: false, contextBudget: 12000 } }, { inspection: true });
		assert(!JSON.stringify({ prompt: otherPov.prompt, brief: otherPov.gmBrief }).includes('The unseen envoy opens the sealed gate.'),
			`An unrelated secret event leaked into another POV packet: prompt=${JSON.stringify(otherPov.prompt).includes('The unseen envoy opens the sealed gate.')}, brief=${JSON.stringify(otherPov.gmBrief).includes('The unseen envoy opens the sealed gate.')}`);
		await db.insert(schema.storyEntries).values({ id: `${storyId}_parallel_narration`, storyId, type: 'narration',
			position: 10000, content: 'The unseen envoy opens the sealed gate.', metadata: { narrativeMode: 'parallel_pov' } });
		const [parallelEvent] = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.id, parallelEventId));
		const parallelResult = await applyDueEventFeedback({ storyId, assistantEntryId: `${storyId}_parallel_narration`,
			playerText: 'Watch unseen events.', narration: 'The unseen envoy opens the sealed gate.',
			sourceFingerprint: turnStateSourceFingerprint('Watch unseen events.', 'The unseen envoy opens the sealed gate.'),
			currentTurn: dueSignal.scheduledTurn, candidates: [{ id: parallelEventId, title: parallelEvent.title,
				body: parallelEvent.body, status: parallelEvent.status, serverVersion: parallelEvent.serverVersion,
				scheduledTurn: parallelEvent.scheduledTurn }],
			feedback: [{ id: parallelEventId, outcome: 'realized', evidenceSpan: parallelEvent.body }] });
		assert.deepEqual(parallelResult, [], 'Parallel POV narration applied a secret event to main-story canon');
		const cue = { cardId: 'harbor_levy', sourceKey: 'event:harbor_levy', sceneKey: 'dock|primary|mara',
			title: 'Harbor levy', logline: 'The established harbor fee affects passage.' };
		const cuePlayerText = 'I book passage.';
		const cueNarration = 'The clerk adds the new harbor fee to your passage fare.';
		const cueFingerprint = turnStateSourceFingerprint(cuePlayerText, cueNarration);
		await db.insert(schema.storyEntries).values({ id: `${storyId}_cue_narration`, storyId, type: 'narration',
			position: 10002, content: cueNarration, metadata: { factionCueReceipt: { ...cue, status: 'selected', sourceFingerprint: cueFingerprint } } });
		const [beforeCueStory] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		await db.update(schema.stories).set({ metadata: { ...beforeCueStory.metadata,
			factionPresentation: { ...beforeCueStory.metadata.factionPresentation,
				attemptedSourceKey: cue.sourceKey, attemptEntryId: `${storyId}_cue_narration`, attemptStatus: 'selected' } } })
			.where(eq(schema.stories.id, storyId));
		const cueFeedback = [{ id: factionCueCandidate(cue).id, outcome: 'signal', evidenceSpan: cueNarration }];
		assert.equal(await applyFactionCueFeedback({ storyId, assistantEntryId: `${storyId}_cue_narration`,
			playerText: cuePlayerText, narration: cueNarration, sourceFingerprint: cueFingerprint, cue,
			feedback: cueFeedback }), 'surfaced', 'A sourced cue was not recorded as surfaced');
		const [afterCue] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert(afterCue.metadata.factionPresentation.sourceKeys.includes(cue.sourceKey), 'Surfaced cue source was not saved');
		assert.equal(afterCue.metadata.factionPresentation.attemptStatus, 'surfaced', 'Surfaced cue did not resolve its pending attempt');
		assert.equal(await applyFactionCueFeedback({ storyId, assistantEntryId: `${storyId}_cue_narration`,
			playerText: cuePlayerText, narration: cueNarration, sourceFingerprint: cueFingerprint, cue,
			feedback: cueFeedback }), 'surfaced', 'Cue retry was not idempotent');
		const [afterCueRetry] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert.equal(afterCueRetry.serverVersion, afterCue.serverVersion, 'Cue retry wrote twice');
		const unsaid = { ...cue, cardId: 'other_fee', sourceKey: 'event:other_fee' };
		await db.insert(schema.storyEntries).values({ id: `${storyId}_unsaid_cue`, storyId, type: 'narration',
			position: 10003, content: 'The clerk hands you a ticket.', metadata: { factionCueReceipt: { ...unsaid,
				status: 'selected', sourceFingerprint: turnStateSourceFingerprint(cuePlayerText, 'The clerk hands you a ticket.') } } });
		await db.update(schema.stories).set({ metadata: { ...afterCue.metadata,
			factionPresentation: { ...afterCue.metadata.factionPresentation,
				attemptedSourceKey: unsaid.sourceKey, attemptEntryId: `${storyId}_unsaid_cue`, attemptStatus: 'selected' } } })
			.where(eq(schema.stories.id, storyId));
		assert.equal(await applyFactionCueFeedback({ storyId, assistantEntryId: `${storyId}_unsaid_cue`,
			playerText: cuePlayerText, narration: 'The clerk hands you a ticket.',
			sourceFingerprint: turnStateSourceFingerprint(cuePlayerText, 'The clerk hands you a ticket.'), cue: unsaid,
			feedback: [{ id: factionCueCandidate(unsaid).id, outcome: 'deferred', evidenceSpan: '' }] }),
			'not_surfaced', 'An unwritten cue was marked delivered');
		const [afterUnsaid] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert.equal(afterUnsaid.metadata.factionPresentation.attemptStatus, 'not_surfaced', 'Unwritten cue stayed pending');
		assert(!afterUnsaid.metadata.factionPresentation.sourceKeys.includes(unsaid.sourceKey), 'Unwritten cue was marked delivered');
		const lateCue = { ...cue, cardId: 'late_fee', sourceKey: 'event:late_fee' };
		const lateNarration = 'The late fee appears in the ledger.';
		const lateFingerprint = turnStateSourceFingerprint(cuePlayerText, lateNarration);
		await db.insert(schema.storyEntries).values({ id: `${storyId}_late_cue`, storyId, type: 'narration',
			position: 10004, content: lateNarration, metadata: { factionCueReceipt: { ...lateCue,
				status: 'selected', sourceFingerprint: lateFingerprint } } });
		await db.update(schema.stories).set({ metadata: { ...afterUnsaid.metadata,
			factionPresentation: { ...afterUnsaid.metadata.factionPresentation,
				attemptedSourceKey: 'event:newer_fee', attemptEntryId: `${storyId}_newer_cue`, attemptStatus: 'selected' } } })
			.where(eq(schema.stories.id, storyId));
		assert.equal(await applyFactionCueFeedback({ storyId, assistantEntryId: `${storyId}_late_cue`,
			playerText: cuePlayerText, narration: lateNarration, sourceFingerprint: lateFingerprint, cue: lateCue,
			feedback: [{ id: factionCueCandidate(lateCue).id, outcome: 'signal', evidenceSpan: lateNarration }] }),
			'surfaced', 'Delayed cue did not retain its own final-source result');
		const [afterLate] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert(afterLate.metadata.factionPresentation.sourceKeys.includes(lateCue.sourceKey), 'Delayed surfaced cue lost its source');
		assert.equal(afterLate.metadata.factionPresentation.attemptedSourceKey, 'event:newer_fee', 'Delayed feedback replaced a newer cue');
		assert.equal(afterLate.metadata.factionPresentation.attemptStatus, 'selected', 'Delayed feedback released a newer pending cue');
		assert.equal(await applyFactionCueFeedback({ storyId, assistantEntryId: `${storyId}_late_cue`,
			playerText: cuePlayerText, narration: lateNarration, sourceFingerprint: lateFingerprint, cue: lateCue,
			feedback: [{ id: factionCueCandidate(lateCue).id, outcome: 'signal', evidenceSpan: lateNarration }] }),
			'surfaced', 'Delayed cue retry changed its result');
		const [afterLateRetry] = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId));
		assert.equal(afterLateRetry.serverVersion, afterLate.serverVersion, 'Delayed cue retry wrote twice');
		const dialogueStoryId = 'replay_selective_dialogue';
		const dialogueData = fixture(dialogueStoryId);
		dialogueData.entities.push({ id: `${dialogueStoryId}_serra`, storyId: dialogueStoryId,
			type: 'character', name: 'Serra', description: 'A harbor scout.', state: { present: true } });
		await db.insert(schema.stories).values(dialogueData.story);
		await db.insert(schema.entities).values(dialogueData.entities);
		await db.insert(schema.storyEntries).values(dialogueData.entries);
		await db.update(schema.llmServiceSettings).set({ metadata: { dialogueMode: 'important' } })
			.where(eq(schema.llmServiceSettings.serviceId, 'dialogue'));
		const selectiveRequests = [];
		const selectiveDraft = 'Mara says “Hello.” Serra says “The river passage is ready.”';
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Selective dialogue replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			selectiveRequests.push(body);
			const content = body.model === 'replay-dialogue'
				? JSON.stringify({ lines: JSON.parse(body.messages.at(-1).content).utterances.map(utterance => ({
					index: utterance.index, text: 'The river passage is ready.' })) })
				: body.response_format ? JSON.stringify({ update: {}, dueEventFeedback: [] }) : selectiveDraft;
			return Response.json({ id: 'selective_dialogue_fake', model: body.model,
				choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const selectiveTurn = await processServerTurn({ storyId: dialogueStoryId, clientTurnId: 'selective_dialogue_turn',
			playerText: 'Hi.', actionType: 'do', localVersion: 0,
			clientContext: { contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100,
				presentNpcIds: [dialogueData.ids.mara, `${dialogueStoryId}_serra`] } });
		assert.equal(selectiveRequests.filter(request => request.model === 'replay-dialogue').length, 1,
			'Selective mode did not save the routine greeting request');
		assert.equal(selectiveTurn.narration, selectiveDraft, 'Selective dialogue changed skipped or unselected speech');
		const repairStoryId = 'replay_length_repair';
		const repairData = fixture(repairStoryId);
		await db.insert(schema.stories).values(repairData.story);
		await db.insert(schema.entities).values(repairData.entities);
		await db.insert(schema.storyEntries).values(repairData.entries);
		const repairRequests = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Length repair replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			const classifier = Boolean(body.response_format);
			if (classifier) repairRequests.push(body);
			const firstEmpty = classifier && repairRequests.length === 1;
			return Response.json({ id: `length_repair_${repairRequests.length}`, model: body.model,
				choices: [{ message: { role: 'assistant', content: classifier
					? firstEmpty ? '' : JSON.stringify({ update: {}, dueEventFeedback: [] })
					: 'Mara closes the ledger and waits.' }, finish_reason: firstEmpty ? 'length' : 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: firstEmpty ? 2048 : 40,
					total_tokens: firstEmpty ? 2148 : 140, cost: 0.0001 } });
		};
		const repairTurn = await processServerTurn({ storyId: repairStoryId, clientTurnId: 'length_repair_turn',
			playerText: 'Wait quietly.', actionType: 'do', localVersion: 0,
			clientContext: { deferStateExtraction: false, contextBudget: 12000,
				chapterThreshold: 200, postChapterBuffer: 100, presentNpcIds: [] } });
		assert.equal(repairTurn.gmTurnReceipt?.stateExtractionStatus, 'succeeded', 'Empty length-limited extraction did not recover');
		assert.equal(repairRequests.length, 2, 'Empty length-limited extraction did not use exactly one repair request');
		assert.equal(repairRequests[1].max_tokens, repairRequests[0].max_tokens * 2,
			'Length repair did not use the bounded larger output cap');
		assert(JSON.stringify(repairRequests[1].messages).includes('Repair invalid extraction JSON'),
			'Length repair request omitted its compact recovery instruction');
		const deferredStoryId = 'replay_deferred_length_repair';
		const deferredData = fixture(deferredStoryId);
		await db.insert(schema.stories).values(deferredData.story);
		await db.insert(schema.entities).values(deferredData.entities);
		await db.insert(schema.storyEntries).values(deferredData.entries);
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Deferred repair turn forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			assert(!body.response_format, 'Deferred extraction ran during narrator turn');
			return Response.json({ id: 'deferred_repair_narrator', model: body.model,
				choices: [{ message: { role: 'assistant', content: 'Mara waits at the harbor.' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const deferredTurn = await processServerTurn({ storyId: deferredStoryId, clientTurnId: 'deferred_repair_turn',
			playerText: 'Wait quietly.', actionType: 'do', localVersion: 0,
			clientContext: { deferStateExtraction: true, contextBudget: 12000,
				chapterThreshold: 200, postChapterBuffer: 100, presentNpcIds: [] } });
		const deferredJob = (await db.select().from(schema.backendJobs).where(eq(schema.backendJobs.storyId, deferredStoryId)))
			.find(job => job.type === 'extract_turn_state' && job.payload.assistantEntryId === deferredTurn.assistantEntryId);
		assert(deferredJob && deferredJob.status === 'queued', 'Deferred length-repair fixture did not queue extraction');
		const deferredRepairRequests = [];
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Deferred repair job forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			assert(body.response_format, 'Deferred repair job made an unrelated model request');
			deferredRepairRequests.push(body);
			const firstEmpty = deferredRepairRequests.length === 1;
			return Response.json({ id: `deferred_length_repair_${deferredRepairRequests.length}`, model: body.model,
				choices: [{ message: { role: 'assistant', content: firstEmpty ? '' : JSON.stringify({ update: {}, dueEventFeedback: [] }) },
					finish_reason: firstEmpty ? 'length' : 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: firstEmpty ? 2048 : 40,
					total_tokens: firstEmpty ? 2148 : 140, cost: 0.0001 } });
		};
		const deferredRepair = await runBackendJobNow(deferredJob.id, 'replay-deferred-length-repair');
		assert(deferredRepair.completed, `Deferred empty length-limited extraction did not recover: ${deferredRepair.error ?? 'unknown'}`);
		assert.equal(deferredRepairRequests.length, 2, 'Deferred length repair made more than one recovery request');
		assert.equal(deferredRepairRequests[1].max_tokens, deferredRepairRequests[0].max_tokens * 2,
			'Deferred length repair did not use the bounded larger output cap');
		const jevStoryId = 'replay_jev_handoff';
		const jevData = fixture(jevStoryId);
		const jevEvidenceTime = new Date(Date.now() - 60_000).toISOString();
		await db.insert(schema.stories).values(jevData.story);
		await db.insert(schema.entities).values(jevData.entities);
		await db.insert(schema.storyEntries).values(jevData.entries);
		await db.insert(schema.npcBeliefs).values({ id: `${jevStoryId}_mara_offer`, storyId: jevStoryId,
			believerEntityId: jevData.ids.mara, belief: 'Mara offered passage and intends to honor an accepted offer.',
			confidence: 0.95, visibility: 'player_known', sourceEntryIds: [jevData.entries[0].id], createdAt: jevEvidenceTime, updatedAt: jevEvidenceTime });
		const reviewAgreementId = `${jevStoryId}_review_agreement`;
		await db.insert(schema.agreements).values({ id: reviewAgreementId, storyId: jevStoryId,
			parties: ['Ilan', 'Mara'], category: 'passage', terms: 'Mara agreed only to discuss passage, not arrange it.',
			status: 'active', sourceEntryIds: [jevData.entries[0].id], createdAt: jevEvidenceTime, updatedAt: jevEvidenceTime });
		const reviewFactId = `${jevStoryId}_review_fact`;
		await db.insert(schema.memoryNodes).values({ id: reviewFactId, storyId: jevStoryId,
			type: 'canonical', title: 'Corrected passage terms',
			content: 'The agreement permits discussion, not completed booking.',
			summary: 'Passage terms remain under discussion.', sourceEntryIds: [jevData.entries[0].id], createdAt: jevEvidenceTime, updatedAt: jevEvidenceTime });
		await db.update(schema.llmServiceSettings).set({ providerType: 'openrouter',
			model: 'typesafe/jev-1.13', apiKeyRef: 'REPLAY_API_KEY', maxTokens: 700, temperature: 0,
			metadata: { source: 'disposable_replay' }, enabled: true })
			.where(eq(schema.llmServiceSettings.serviceId, 'actorDecision'));
		let jevPlannerRound = 0;
		let jevRequestCount = 0;
		const jevNarratorRequests = [];
		let playerInteractionTrial = false;
		let interactionPlannerRound = 0;
		let interactionDecisionInput = null;
		let directNarratorOfferSent = false;
		let directDialogueOfferSent = false;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://openrouter.ai/api/alpha/decisions') {
				jevRequestCount++;
				const body = JSON.parse(init.body);
				assert(body.questions.selection || body.questions.reaction, 'Jev request had no decision question');
				if (body.questions.reaction) {
					assert.equal(body.state.playerAction, 'I accept.');
					assert.equal(body.state.actorEvidence.actor?.name, 'Mara');
					assert.deepEqual(body.state.actorEvidence.beliefs, [],
						'Direct acceptance unexpectedly depended on an extracted NPC belief');
					assert.deepEqual(body.state.actorEvidence.recentOffer,
						{ sourceEntryId: `${directAcceptId}_opening`, speech: 'I offer the river path.' },
						'Direct Jev request lost the exact attributed offer');
					assert(body.questions.reaction.criteria.cooperate.includes('without reopening the same bargain'));
				}
				if (playerInteractionTrial) interactionDecisionInput = body.state.evidence;
				if (jevRequestCount === 1) {
					const [inFlight] = await db.execute(sql`select result from agent_tool_calls where tool='askJev' and status='reserved' order by created_at desc limit 1`);
					assert.equal(inFlight?.result?.networkAttempted, true, 'Jev request was sent before its attempt marker committed');
				}
				return Response.json({ model: 'typesafe/jev-1.13-20260917', answers: body.questions.reaction ? { reaction: {
					type: 'choice', choice: 'cooperate', confidence: 0.92,
					probabilities: { cooperate: 0.92, refuse: 0.04, bargain: 0.04 } } } : { selection: {
					type: 'choice', choice: 'honor_terms', confidence: 0.92,
					probabilities: { honor_terms: 0.92, refuse: 0.04, hold: 0.04 } } },
					usage: { input_tokens: 120, output_tokens: 12, cost: 0.0002 } });
			}
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Jev handoff replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			if (!body.tools?.length && !body.response_format && body.model !== 'replay-dialogue')
				jevNarratorRequests.push(body);
			let message;
			if (body.tools?.length) {
				message = playerInteractionTrial
					? interactionPlannerRound++ === 0
						? { role: 'assistant', content: null, tool_calls: [{ id: 'player_choice', type: 'function',
							function: { name: 'askUserQuestion', arguments: JSON.stringify({ prompt: 'Accept Mara’s passage offer?',
								options: [{ id: 'accept', label: 'Accept passage' }, { id: 'decline', label: 'Decline passage' }],
								allowCustom: false }) } }] }
						: interactionPlannerRound === 2
							? { role: 'assistant', content: null, tool_calls: [{ id: 'answer_jev', type: 'function',
								function: { name: 'askJev', arguments: JSON.stringify({ actorId: answerData.ids.mara,
									question: 'How does Mara honor the accepted passage offer?', purpose: 'immediate_response',
									options: [{ id: 'honor_terms', description: 'Honor the agreed passage and arrange boarding.' },
										{ id: 'refuse', description: 'Refuse passage despite the prior offer.' }] }) } }] }
								: { role: 'assistant', content: '{"kind":"final","text":"done"}' }
					: jevPlannerRound++ === 0
					? { role: 'assistant', content: null, tool_calls: [{ id: 'jev_handoff_call', type: 'function',
						function: { name: 'askJev', arguments: JSON.stringify({ actorId: jevData.ids.mara,
							question: 'How does Mara answer the accepted passage offer?', purpose: 'immediate_response',
							options: [{ id: 'honor_terms', description: 'Honor the agreed passage and arrange boarding.' },
								{ id: 'refuse', description: 'Refuse passage despite the prior offer.' }] }) } }] }
					: { role: 'assistant', content: '{"kind":"final","text":"done"}' };
			} else {
				if (body.model === 'replay-dialogue') {
					const packet = JSON.parse(body.messages.at(-1).content);
					if (packet.playerAction === 'I accept.') directDialogueOfferSent = packet.speakerDecision?.recentOffer?.speech === 'I offer the river path.';
				} else if (!body.response_format && JSON.stringify(body.messages).includes('I accept.')) {
					directNarratorOfferSent = JSON.stringify(body.messages).includes('recentOffer')
						&& JSON.stringify(body.messages).includes('I offer the river path.');
				}
				message = { role: 'assistant', content: body.model === 'replay-dialogue'
					? JSON.stringify({ lines: JSON.parse(body.messages.at(-1).content).utterances.map(utterance => ({ index: utterance.index, text: utterance.speech })) })
					: body.response_format ? JSON.stringify({ update: {}, dueEventFeedback: [] })
						: 'Mara says “Your passage is arranged.”' };
			}
			return Response.json({ id: 'jev_handoff_fake', model: body.model,
				choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const jevTurn = { storyId: jevStoryId, clientTurnId: 'jev_handoff_turn',
			playerText: 'I accept the passage offer.', actionType: 'do', localVersion: 0,
			clientContext: { contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100,
				presentNpcIds: [jevData.ids.mara] } };
		const jevRun = await startAgentRun({ turn: jevTurn }, jevStoryId);
		assert.equal(jevRun.status, 'completed', `Jev handoff turn failed: ${jevRun.error ?? 'unknown'}`);
		assert.equal((await startAgentRun({ turn: jevTurn }, jevStoryId)).id, jevRun.id,
			'Resuming the same Jev turn created a second run');
		assert.equal(jevRequestCount, 1, 'Jev was called again after the planner selected the immediate response');
		const [jevLog] = (await db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.storyId, jevStoryId)))
			.filter(row => row.serviceId === 'actorDecision' && row.operation === 'agent.askJev');
		assert.equal(jevLog?.status, 'success', 'Jev decision request was missing from API call logs');
		assert.equal(jevLog.requestTokens, 120);
		assert.equal(jevLog.responseTokens, 12);
		assert.equal(jevLog.metadata.providerCostUsd, 0.0002);
		assert(!JSON.stringify(jevLog.metadata).includes('Mara'), 'Jev API log stored actor evidence');
		const [queuedReview] = (await db.select().from(schema.backendJobs)
			.where(eq(schema.backendJobs.storyId, jevStoryId)))
			.filter(row => row.type === 'continuity_audit' && row.payload?.assistantEntryId === jevRun.result.turn.assistantEntryId);
		assert.equal(queuedReview?.payload?.playerName, 'Ilan', 'Completed turn did not snapshot the player identity for review');
		assert(jevRun.result?.turn?.gmTurnReceipt?.actorDecisions?.some(decision =>
			decision.actorId === jevData.ids.mara && decision.immediateAction === 'Honor the agreed passage and arrange boarding.'),
			'Jev planner response was not reused in the turn');
		const resumedJevStoryId = 'replay_jev_committing';
		const resumedJevData = fixture(resumedJevStoryId);
		await db.insert(schema.stories).values(resumedJevData.story);
		await db.insert(schema.entities).values(resumedJevData.entities);
		await db.insert(schema.storyEntries).values(resumedJevData.entries);
		await db.insert(schema.npcBeliefs).values({ id: `${resumedJevStoryId}_mara_offer`, storyId: resumedJevStoryId,
			believerEntityId: resumedJevData.ids.mara, belief: 'Mara offered passage and intends to honor an accepted offer.',
			confidence: 0.95, visibility: 'player_known', sourceEntryIds: [resumedJevData.entries[0].id] });
		const resumedJevTurn = { ...jevTurn, storyId: resumedJevStoryId, clientTurnId: 'jev_committing_turn',
			clientContext: { ...jevTurn.clientContext, presentNpcIds: [resumedJevData.ids.mara] } };
		const [savedJevRow] = await db.execute(sql`select observations from agent_runs where id=${jevRun.id}`);
		const savedJevObservation = savedJevRow.observations.find(item => item.tool === 'askJev');
		assert(savedJevObservation?.result?.status === 'proposed', 'Completed Jev run did not persist its proposed decision');
		const resumedActorView = await (await load('engine/gmTools')).getActorDecisionView(resumedJevStoryId,
			{ actorId: resumedJevData.ids.mara, eventLimit: 6 });
		const { agentRunHash } = await load('engine/agentRunHash');
		const resumedJevDecision = { ...savedJevObservation.result, actorId: resumedJevData.ids.mara,
			playerActionHash: agentRunHash(resumedJevTurn.playerText),
			evidenceHash: agentRunHash({ actorEvidence: resumedActorView.data, sourceIds: resumedActorView.sourceIds }),
			sourceIds: [resumedJevData.ids.mara, ...resumedActorView.sourceIds],
			selectedMemoryId: null, selectedMemoryText: null };
		assert((await load('turn/orchestrator')).reusableAgentJevDecision({ rows: [resumedJevDecision],
			actorId: resumedJevData.ids.mara, playerText: resumedJevTurn.playerText,
			actorEvidence: resumedActorView.data, sourceIds: resumedActorView.sourceIds,
			model: 'typesafe/jev-1.13' }), 'Persisted Jev decision was not reusable before recovery');
		const resumedJevRunId = 'run_replay_jev_committing';
		const [resumedStoryRow] = await db.execute(sql`select shelf_id from stories where id=${resumedJevStoryId}`);
		await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,observations,result,lease_until,expires_at)
			values(${resumedJevRunId},${resumedStoryRow.shelf_id},${resumedJevStoryId},${resumedJevTurn.clientTurnId},'committing',
			${JSON.stringify(resumedJevTurn)}::jsonb,${JSON.stringify([{ ...savedJevObservation, result: resumedJevDecision }])}::jsonb,
			'{"plannerText":"done"}'::jsonb,now()-interval '1 second',now()+interval '24 hours')`);
		const resumedJevRun = await waitForAgentRun(await load('engine/agentRuns'), { runId: resumedJevRunId, storyId: resumedJevStoryId });
		assert.equal(resumedJevRun.status, 'completed', `Committing Jev run failed to resume: ${resumedJevRun.error ?? 'unknown'}`);
		assert.equal(jevRequestCount, 1, 'Resumed committing run requested Jev again');
		assert(resumedJevRun.result?.turn?.gmTurnReceipt?.actorDecisions?.some(decision =>
			decision.actorId === resumedJevData.ids.mara && decision.immediateAction === 'Honor the agreed passage and arrange boarding.'),
			'Resumed turn lost its persisted Jev choice');
		assert.equal((await (await load('engine/agentRuns')).getAgentRun({ runId: resumedJevRunId,
			storyId: resumedJevStoryId })).result?.turn?.assistantEntryId, resumedJevRun.result.turn.assistantEntryId,
			'Second recovery read changed the saved narration');
		const changedStoryId = 'replay_jev_player_changed';
		const changedData = fixture(changedStoryId);
		await db.insert(schema.stories).values(changedData.story);
		await db.insert(schema.entities).values(changedData.entities);
		await db.insert(schema.storyEntries).values(changedData.entries);
		const changedTurn = { ...jevTurn, storyId: changedStoryId, clientTurnId: 'jev_player_changed_turn',
			clientContext: { ...jevTurn.clientContext, presentNpcIds: [changedData.ids.mara] } };
		const changedView = await (await load('engine/gmTools')).getActorDecisionView(changedStoryId,
			{ actorId: changedData.ids.mara, eventLimit: 6 });
		const staleAdvice = 'Stale advice: Mara marches to the moon.';
		const staleDecision = { ...resumedJevDecision, actorId: changedData.ids.mara,
			playerActionHash: agentRunHash(changedTurn.playerText),
			evidenceHash: agentRunHash({ actorEvidence: changedView.data, sourceIds: changedView.sourceIds }),
			sourceIds: [changedData.ids.mara, ...changedView.sourceIds],
			candidateOptions: [{ id: 'honor_terms', description: staleAdvice },
				{ id: 'refuse', description: 'Refuse passage.' }], selectedDescription: staleAdvice };
		const changedRunId = 'run_replay_jev_player_changed';
		const [changedStoryRow] = await db.execute(sql`select shelf_id from stories where id=${changedStoryId}`);
		await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,observations,result,lease_until,expires_at)
			values(${changedRunId},${changedStoryRow.shelf_id},${changedStoryId},${changedTurn.clientTurnId},'committing',
			${JSON.stringify(changedTurn)}::jsonb,${JSON.stringify([
				{ tool: 'askJev', callId: 'old_choice', result: staleDecision },
				{ tool: 'askUserQuestion', callId: 'player_choice', result: { optionId: 'decline' } },
			])}::jsonb,'{"plannerText":"done"}'::jsonb,now()-interval '1 second',now()+interval '24 hours')`);
		const changedRun = await waitForAgentRun(await load('engine/agentRuns'), { runId: changedRunId, storyId: changedStoryId });
		assert.equal(changedRun.status, 'completed', `Player-changed Jev run failed: ${changedRun.error ?? 'unknown'}`);
		assert.equal(jevRequestCount, 1, 'Player answer caused an automatic Jev request for the old action');
		assert.equal(changedRun.result?.turn?.gmTurnReceipt?.actorDecisions?.length, 0,
			'Old Jev advice reached actor decisions after a player answer');
		const changedPrompt = JSON.stringify(jevNarratorRequests.at(-1)?.messages ?? []);
		assert(changedPrompt.includes('decline') && !changedPrompt.includes(staleAdvice),
			'Player answer or stale Jev advice was mishandled in the final narrator request');
		results.push({ id: 'jev-player-interaction-boundary-001', passed: true,
			staleAdviceExcluded: true, automaticDecisionSuppressed: true });
		console.log('PASS jev-player-interaction-boundary-001: later player answer invalidated earlier Jev advice');
		const answerStoryId = 'replay_jev_answer_first';
		const answerData = fixture(answerStoryId);
		await db.insert(schema.stories).values(answerData.story);
		await db.insert(schema.entities).values(answerData.entities);
		await db.insert(schema.storyEntries).values(answerData.entries);
		await db.insert(schema.npcBeliefs).values({ id: `${answerStoryId}_mara_offer`, storyId: answerStoryId,
			believerEntityId: answerData.ids.mara, belief: 'Mara offered passage and will honor acceptance.',
			confidence: 0.95, visibility: 'player_known', sourceEntryIds: [answerData.entries[0].id] });
		const answerTurn = { ...jevTurn, storyId: answerStoryId, clientTurnId: 'jev_answer_first_turn',
			playerText: 'I ask Mara whether she will honor her passage offer.',
			clientContext: { ...jevTurn.clientContext, presentNpcIds: [answerData.ids.mara] } };
		const answerSettings = await getAgentSettings({ projectId: 'shelf_default', gameId: answerStoryId });
		await saveAgentSettings({ projectId: 'shelf_default', gameId: answerStoryId,
			expectedRevision: answerSettings.game.revision, changes: { gmQuestions: true } });
		const decisionsBeforeAnswer = jevRequestCount;
		playerInteractionTrial = true;
		try {
			const pendingAnswerRun = await startAgentRun({ turn: answerTurn }, answerStoryId);
			assert.equal(pendingAnswerRun.status, 'awaiting_input', 'Answer-first Jev run did not pause for the player');
			const pendingChoice = pendingAnswerRun.interactions.find(item => item.status === 'pending');
			assert(pendingChoice?.id && pendingChoice.revision, 'Answer-first Jev run lost its pending choice');
			const answeredRun = await (await load('engine/agentRuns')).respondAgentRun({
				runId: pendingAnswerRun.id, storyId: answerStoryId, interactionId: pendingChoice.id,
				expectedRevision: pendingChoice.revision, response: { optionId: 'accept' } });
			assert.equal(answeredRun.status, 'completed', `Answer-first Jev run failed: ${answeredRun.error ?? 'unknown'}`);
			assert.equal(jevRequestCount, decisionsBeforeAnswer + 1, 'Answer-first turn made a duplicate or missing Jev request');
			assert(interactionDecisionInput?.playerInteractions?.some(item => item.tool === 'askUserQuestion'
				&& item.result?.optionId === 'accept' && item.prompt === 'Accept Mara’s passage offer?'
				&& item.selectedLabel === 'Accept passage'), 'Accepted player answer did not reach the fresh Jev request');
			assert(answeredRun.result?.turn?.gmTurnReceipt?.actorDecisions?.some(decision =>
				decision.actorId === answerData.ids.mara && decision.immediateAction === 'Honor the agreed passage and arrange boarding.'),
				'Fresh post-answer Jev decision did not reach the shared turn');
			results.push({ id: 'jev-answer-before-decision-001', passed: true, requests: jevRequestCount - decisionsBeforeAnswer });
			console.log('PASS jev-answer-before-decision-001: accepted answer reached one fresh Jev request and turn');
		} finally { playerInteractionTrial = false; }
		const interruptedJevStoryId = 'replay_jev_interrupted';
		const interruptedJevData = fixture(interruptedJevStoryId);
		await db.insert(schema.stories).values(interruptedJevData.story);
		await db.insert(schema.entities).values(interruptedJevData.entities);
		await db.insert(schema.storyEntries).values(interruptedJevData.entries);
		await db.insert(schema.npcBeliefs).values({ id: `${interruptedJevStoryId}_mara_offer`, storyId: interruptedJevStoryId,
			believerEntityId: interruptedJevData.ids.mara, belief: 'Mara offered passage and intends to honor an accepted offer.',
			confidence: 0.95, visibility: 'player_known', sourceEntryIds: [interruptedJevData.entries[0].id] });
		const interruptedTurn = { ...jevTurn, storyId: interruptedJevStoryId, clientTurnId: 'jev_interrupted_turn',
			clientContext: { ...jevTurn.clientContext, presentNpcIds: [interruptedJevData.ids.mara] } };
		const interruptedView = await (await load('engine/gmTools')).getActorDecisionView(interruptedJevStoryId,
			{ actorId: interruptedJevData.ids.mara, eventLimit: 6 });
		const interruptedRunId = 'run_replay_jev_interrupted';
		const [interruptedStoryRow] = await db.execute(sql`select shelf_id from stories where id=${interruptedJevStoryId}`);
		const interruptedCall = { actorId: interruptedJevData.ids.mara,
			question: 'How does Mara answer the accepted passage offer?', purpose: 'immediate_response',
			options: [{ id: 'honor_terms', description: 'Honor the agreed passage and arrange boarding.' },
				{ id: 'refuse', description: 'Refuse passage despite the prior offer.' }] };
		const attemptMarker = { networkAttempted: true, question: interruptedCall.question,
			purpose: interruptedCall.purpose, actorId: interruptedCall.actorId,
			playerActionHash: agentRunHash(interruptedTurn.playerText),
			evidenceHash: agentRunHash({ actorEvidence: interruptedView.data, sourceIds: interruptedView.sourceIds }),
			configuredModel: 'typesafe/jev-1.13',
			sourceIds: [interruptedJevData.ids.mara, ...interruptedView.sourceIds], advisory: true };
		await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,lease_until,expires_at)
			values(${interruptedRunId},${interruptedStoryRow.shelf_id},${interruptedJevStoryId},${interruptedTurn.clientTurnId},'running',
			${JSON.stringify(interruptedTurn)}::jsonb,now()-interval '1 second',now()+interval '24 hours')`);
		await db.execute(sql`insert into agent_tool_calls(run_id,call_id,tool,args_hash,args,status,result)
			values(${interruptedRunId},'jev_interrupted_call','askJev',${agentRunHash({ tool: 'askJev', args: interruptedCall })},
			${JSON.stringify(interruptedCall)}::jsonb,'reserved',${JSON.stringify(attemptMarker)}::jsonb)`);
		const interruptedRun = await waitForAgentRun(await load('engine/agentRuns'), { runId: interruptedRunId, storyId: interruptedJevStoryId });
		assert.equal(interruptedRun.status, 'completed', `Interrupted Jev run failed to recover: ${interruptedRun.error ?? 'unknown'}`);
		assert.equal(jevRequestCount, decisionsBeforeAnswer + 1, 'Interrupted Jev request was sent again during recovery or automatic actor fallback');
		const [interruptedCallRow] = await db.execute(sql`select status,result from agent_tool_calls where run_id=${interruptedRunId} and call_id='jev_interrupted_call'`);
		assert.equal(interruptedCallRow.status, 'completed');
		assert.equal(interruptedCallRow.result.status, 'unavailable');
		assert(interruptedRun.result?.turn?.gmTurnReceipt?.actorDecisions?.some(decision =>
			decision.actorId === interruptedJevData.ids.mara && decision.status === 'unavailable'),
			'Interrupted Jev attempt was not retained as an unavailable actor decision');
		const directAcceptId = 'replay_jev_direct_accept';
		const directAcceptData = fixture(directAcceptId);
		directAcceptData.entries[0].content = '[Great Hall]\nMara says “I offer the river path.” The Harbor Lord watches.';
		const bystanderId = `${directAcceptId}_harbor_lord`;
		directAcceptData.entities.push({ id: bystanderId, storyId: directAcceptId, type: 'character', name: 'Harbor Lord', state: { present: true } });
		await db.insert(schema.stories).values(directAcceptData.story);
		await db.insert(schema.entities).values(directAcceptData.entities);
		await db.insert(schema.storyEntries).values(directAcceptData.entries);
		const directAccept = await processServerTurn({ ...jevTurn, storyId: directAcceptId,
			clientTurnId: 'jev_direct_accept', playerText: 'I accept.',
			clientContext: { ...jevTurn.clientContext, presentNpcIds: [directAcceptData.ids.mara, bystanderId] } });
		assert.equal(jevRequestCount, decisionsBeforeAnswer + 2, 'Direct short acceptance did not request one actor-scoped Jev decision');
		assert.deepEqual(directAccept.gmTurnReceipt?.actorDecisions?.map(decision => [decision.actorId, decision.status]),
			[[directAcceptData.ids.mara, 'proposed']], 'Direct acceptance selected a bystander or lost its actor decision');
		assert(directAccept.gmTurnReceipt.actorDecisions[0].knowledgeSourceIds.includes(directAcceptData.entries[0].id),
			'Direct actor decision lost the offer source entry');
		assert(directNarratorOfferSent && directDialogueOfferSent,
			`The exact offer did not reach both narrator and dialogue requests: ${JSON.stringify({ directNarratorOfferSent, directDialogueOfferSent })}`);
		const priorJevFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			assert.equal(String(url), 'https://openrouter.ai/api/alpha/decisions');
			return Response.json({ model: 'typesafe/jev-1.13', answers: { selection: {
				type: 'choice', choice: 'hold', confidence: 0.5, probabilities: { hold: 0.5 } } },
				usage: { input_tokens: 55, output_tokens: 5, cost: 0.0001 } });
		};
		try {
			const { chooseJevOption } = await load('turn/jev');
			assert.equal(await chooseJevOption({ profile: { providerType: 'openrouter', apiKey: 'synthetic-only' },
				model: 'typesafe/jev-1.13', storyId: jevStoryId, operation: 'replay.low_confidence',
				evidence: {}, sourceIds: [], options: [{ id: 'hold', description: 'Wait.' }, { id: 'act', description: 'Act.' }] }), null);
		} finally { globalThis.fetch = priorJevFetch; }
		const [abstainedLog] = (await db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.storyId, jevStoryId)))
			.filter(row => row.serviceId === 'actorDecision' && row.operation === 'replay.low_confidence');
		assert.equal(abstainedLog?.requestTokens, 55, 'Low-confidence Jev request lost its usage log');
		assert.equal(abstainedLog.metadata.providerCostUsd, 0.0001);
		await db.insert(schema.llmServiceSettings).values({ serviceId: 'continuityReview', providerType: 'openai',
			baseUrl: 'http://replay.invalid/v1', model: 'replay-continuity-review', apiKeyRef: 'REPLAY_API_KEY',
			contextBudget: 12000, maxTokens: 900, temperature: 0, enabled: true });
		const derivedEventId = `${jevStoryId}_derived_event`;
		await db.insert(schema.storyEvents).values({ id: derivedEventId, storyId: jevStoryId, type: 'faction_move',
			title: 'Passage arranged', body: 'Mara says the passage is arranged.', status: 'committed',
			visibility: 'player_known', sourceEntryIds: [jevRun.result.turn.assistantEntryId] });
		let shadowRequests = 0;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Continuity replay forbids external request: ${url}`);
			shadowRequests++;
			const prompt = JSON.parse(init.body).messages.at(-1).content;
			const evidence = JSON.parse(prompt.match(/<evidence>([\s\S]*?)<\/evidence>/)?.[1] ?? 'null');
			assert(!evidence.entries.some(entry => entry.id === jevRun.result.turn.assistantEntryId),
				'Continuity Review repeated the narration as independent evidence');
			assert(!evidence.events.some(event => event.id === derivedEventId),
				'Continuity Review used an event derived from the same narration as independent evidence');
			const finding = sourceId => ({ category: 'contradiction', severity: 'warning',
				offendingSpan: 'Your passage is arranged.', suggestion: 'Check this claim.', sourceIds: [sourceId] });
			return Response.json({ id: 'shadow_self_citation', model: 'replay-continuity-review',
				choices: [{ message: { role: 'assistant', content: JSON.stringify({ findings: [
					finding(jevRun.result.turn.assistantEntryId), finding(derivedEventId),
				] }) }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const shadowJobId = await enqueueBackendJob({ storyId: jevStoryId, type: 'continuity_audit',
			dedupeKey: 'replay-shadow-self-citation', payload: { assistantEntryId: jevRun.result.turn.assistantEntryId,
				playerEntryId: `entry_${jevTurn.clientTurnId}`, serverVersion: jevRun.result.turn.serverVersion }, maxAttempts: 2 });
		const shadowRun = await runBackendJobNow(shadowJobId, 'replay-shadow-worker');
		assert(shadowRun.completed && shadowRun.result?.shadowReview?.status === 'reviewed',
			`Continuity Review fixture failed: ${shadowRun.error ?? 'unknown'}`);
		assert.equal(shadowRequests, 1, 'Enabled Continuity Review did not make exactly one request');
		const reviewLogs = async () => (await db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.storyId, jevStoryId)))
			.filter(row => row.serviceId === 'continuityReview' && row.operation === 'job.continuity_audit.review');
		const firstReviewLogs = await reviewLogs();
		assert.equal(firstReviewLogs.length, 1, 'Continuity Review request was missing from API call logs');
		assert.equal(firstReviewLogs[0].requestTokens, 100);
		assert.equal(firstReviewLogs[0].responseTokens, 40);
		assert.equal(firstReviewLogs[0].metadata.providerCostUsd, 0.0001);
		assert(!JSON.stringify(firstReviewLogs[0].metadata).includes('Your passage is arranged.'), 'Review log stored narration prose');
		assert.equal(shadowRun.result.shadowReview.findingCount, 0, 'Self-cited findings were accepted');
		assert(shadowRun.result.shadowReview.candidateCoverage?.sentenceCount > 0
			&& Array.isArray(shadowRun.result.shadowReview.candidateCoverage.selectedSentenceIds),
			'Continuity Review lost its bounded candidate-coverage diagnostic');
		const [savedShadowJob] = await db.select({ metadata: schema.backendJobs.metadata }).from(schema.backendJobs)
			.where(eq(schema.backendJobs.id, shadowJobId));
		assert.deepEqual(savedShadowJob?.metadata?.continuityReview?.candidateCoverage,
			shadowRun.result.shadowReview.candidateCoverage, 'Continuity Review coverage was not persisted with the job');
		assert.equal(savedShadowJob.metadata.continuityReview.assistantEntryId, jevRun.result.turn.assistantEntryId);
		assert.equal(savedShadowJob.metadata.continuityReview.candidateCoverage.version, 4);
		assert.equal(savedShadowJob.metadata.continuityReview.candidateCoverage.narrationHash.length, 64);
		assert(!JSON.stringify(savedShadowJob.metadata.continuityReview).includes('Your passage is arranged.'),
			'Continuity Review job metadata stored narration prose');
		assert.equal((await db.select().from(schema.continuityWarnings).where(eq(schema.continuityWarnings.storyId, jevStoryId)))
			.filter(row => row.metadata?.assistantEntryId === jevRun.result.turn.assistantEntryId).length, 0,
			'Continuity Review persisted a self-cited warning');
		const postTurnBeliefId = `${jevStoryId}_later_belief`;
		await db.insert(schema.npcBeliefs).values({ id: postTurnBeliefId, storyId: jevStoryId,
			believerEntityId: jevData.ids.mara, belief: 'This belief was added after the reviewed narration.',
			confidence: 0.9, visibility: 'player_known', sourceEntryIds: [jevData.entries[0].id],
			updatedAt: new Date(Date.now() + 60_000).toISOString() });
		const postTurnFactId = `${jevStoryId}_later_fact`;
		await db.insert(schema.memoryNodes).values({ id: postTurnFactId, storyId: jevStoryId,
			type: 'canonical', title: 'Later correction', content: 'This was added after the reviewed narration.',
			sourceEntryIds: [jevData.entries[0].id], updatedAt: new Date(Date.now() + 60_000).toISOString() });
		const [reviewedNarration] = await db.select().from(schema.storyEntries)
			.where(eq(schema.storyEntries.id, jevRun.result.turn.assistantEntryId));
		const priorCorrectionId = `${jevStoryId}_prior_correction`;
		const laterCorrectionId = `${jevStoryId}_later_correction`;
		await db.insert(schema.storyEntries).values([
			{ id: priorCorrectionId, storyId: jevStoryId, type: 'user_action', position: 0,
				content: 'OOC: Mara agreed only to discuss passage, not arrange it.', metadata: { nonCanon: true },
				createdAt: new Date(Date.parse(reviewedNarration.createdAt) - 60_000).toISOString() },
			{ id: laterCorrectionId, storyId: jevStoryId, type: 'user_action', position: 500,
				content: 'OOC: This correction came after the reviewed narration.', metadata: { nonCanon: true },
				createdAt: new Date(Date.parse(reviewedNarration.createdAt) + 60_000).toISOString() },
		]);
		let canonicalReviewRequests = 0;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Canonical review replay forbids external request: ${url}`);
			canonicalReviewRequests++;
			const prompt = JSON.parse(init.body).messages.at(-1).content;
			const evidence = JSON.parse(prompt.match(/<evidence>([\s\S]*?)<\/evidence>/)?.[1] ?? 'null');
			assert.equal(evidence.playerCharacter, 'Ilan', 'Continuity Review lost the player identity');
			assert(evidence.agreements.some(row => row.id === reviewAgreementId), 'Retained agreement did not reach Continuity Review');
			assert(evidence.beliefs.some(row => row.id === `${jevStoryId}_mara_offer`), 'Retained NPC belief did not reach Continuity Review');
			assert(!evidence.beliefs.some(row => row.id === postTurnBeliefId), 'Post-turn belief entered the reviewed source snapshot');
			assert(evidence.facts.some(row => row.id === reviewFactId), 'Retained fact did not reach Continuity Review');
			assert(!evidence.facts.some(row => row.id === postTurnFactId), 'Post-turn fact entered the reviewed source snapshot');
			assert(evidence.entries.some(row => row.id === priorCorrectionId), 'Retained OOC correction did not reach Continuity Review');
			assert(!evidence.entries.some(row => row.id === laterCorrectionId), 'Post-turn correction entered the reviewed source snapshot');
			return Response.json({ id: 'shadow_canonical_source', model: 'replay-continuity-review',
				choices: [{ message: { role: 'assistant', content: JSON.stringify({ findings: [
					{ category: 'contradiction', severity: 'warning', offendingSpan: 'Your passage is arranged.',
						suggestion: 'Check the agreed terms.', sourceIds: [reviewAgreementId] },
					{ category: 'ignored_correction', severity: 'warning', offendingSpan: 'Your passage is arranged.',
						suggestion: 'Honor the prior OOC correction.', sourceIds: [priorCorrectionId] },
				] }) }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const canonicalReviewJobId = await enqueueBackendJob({ storyId: jevStoryId, type: 'continuity_audit',
			dedupeKey: 'replay-shadow-canonical-evidence', payload: { assistantEntryId: jevRun.result.turn.assistantEntryId,
				playerEntryId: `entry_${jevTurn.clientTurnId}`, serverVersion: jevRun.result.turn.serverVersion,
				playerName: 'Ilan',
				contextReceipt: { selection: { groups: [
					{ kind: 'agreements', sentIds: [reviewAgreementId] },
					{ kind: 'beliefs', sentIds: [`${jevStoryId}_mara_offer`, postTurnBeliefId] },
					{ kind: 'memoryNodes', sentIds: [reviewFactId, postTurnFactId] },
					{ kind: 'playerCorrections', sentIds: [priorCorrectionId, laterCorrectionId] },
				] } } }, maxAttempts: 2 });
		const canonicalReview = await runBackendJobNow(canonicalReviewJobId, 'replay-shadow-canonical-worker');
		assert(canonicalReview.completed && canonicalReview.result?.shadowReview?.findingCount === 2,
			`Canonical review fixture failed: ${canonicalReview.error ?? JSON.stringify(canonicalReview.result)}`);
		assert.equal(canonicalReviewRequests, 1, 'Canonical evidence review made an unexpected request count');
		assert.equal((await reviewLogs()).length, 2, 'Canonical review request was missing from API call logs');
		const [canonicalWarning] = (await db.select().from(schema.continuityWarnings).where(eq(schema.continuityWarnings.storyId, jevStoryId)))
			.filter(row => row.metadata?.canonicalEvidenceIds?.includes(reviewAgreementId));
		assert(canonicalWarning?.sourceEntryIds.includes(jevData.entries[0].id),
			'Canonical review warning lost the agreement source entry');
		assert(!canonicalWarning.sourceEntryIds.includes(jevRun.result.turn.assistantEntryId),
			'Canonical review warning cited its own narration');
		const [correctionWarning] = (await db.select().from(schema.continuityWarnings).where(eq(schema.continuityWarnings.storyId, jevStoryId)))
			.filter(row => row.warningType === 'shadow_ignored_correction');
		assert(correctionWarning?.sourceEntryIds.includes(priorCorrectionId),
			'Ignored-correction warning lost the earlier OOC source entry');
		const failedJevStoryId = 'replay_jev_unavailable';
		const failedJevData = fixture(failedJevStoryId);
		await db.insert(schema.stories).values(failedJevData.story);
		await db.insert(schema.entities).values(failedJevData.entities);
		await db.insert(schema.storyEntries).values(failedJevData.entries);
		await db.insert(schema.npcBeliefs).values({ id: `${failedJevStoryId}_mara_knowledge`, storyId: failedJevStoryId,
			believerEntityId: failedJevData.ids.mara, belief: 'Mara knows the harbor route.', confidence: 0.95,
			visibility: 'player_known', sourceEntryIds: [failedJevData.entries[0].id] });
		let failedJevRound = 0;
		let failedJevRequests = 0;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://openrouter.ai/api/alpha/decisions') {
				failedJevRequests++;
				return new Response('temporary provider failure', { status: 503 });
			}
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Failed Jev replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			const message = body.tools?.length
				? failedJevRound++ === 0
					? { role: 'assistant', content: null, tool_calls: [{ id: 'jev_failure_call', type: 'function',
						function: { name: 'askJev', arguments: JSON.stringify({ actorId: failedJevData.ids.mara,
							question: 'How does Mara answer?', purpose: 'immediate_response', options: [
								{ id: 'answer', description: 'Answer the question.' }, { id: 'wait', description: 'Wait.' }] }) } }] }
					: { role: 'assistant', content: '{"kind":"final","text":"done"}' }
				: { role: 'assistant', content: body.model === 'replay-dialogue'
					? JSON.stringify({ lines: JSON.parse(body.messages.at(-1).content).utterances.map(utterance => ({ index: utterance.index, text: utterance.speech })) })
					: body.response_format ? JSON.stringify({ update: {}, dueEventFeedback: [] }) : 'Mara gives a careful answer.' };
			return Response.json({ id: 'jev_failure_fake', model: body.model,
				choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const failedJevRun = await startAgentRun({ turn: { storyId: failedJevStoryId,
			clientTurnId: 'jev_failure_turn', playerText: 'Ask Mara what she knows.', actionType: 'do', localVersion: 0,
			clientContext: { contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100,
				presentNpcIds: [failedJevData.ids.mara] } } }, failedJevStoryId);
		assert.equal(failedJevRun.status, 'completed', `Jev provider failure stopped narration: ${failedJevRun.error ?? 'unknown'}`);
		assert(failedJevRequests > 0, 'Failure fixture did not call the Jev provider');
		const failedJevLogs = (await db.select().from(schema.apiCallLogs).where(eq(schema.apiCallLogs.storyId, failedJevStoryId)))
			.filter(row => row.serviceId === 'actorDecision' && row.operation === 'agent.askJev');
		assert.equal(failedJevLogs.length, failedJevRequests, 'Failed Jev requests were missing from API call logs');
		assert(failedJevLogs.every(row => row.status === 'error' && row.metadata.statusCode === 503));
		assert(!failedJevRun.result?.turn?.gmTurnReceipt?.actorDecisions?.some(decision => decision.status === 'proposed'),
			'Failed Jev result became an actor decision');
		const backgroundActorId = `${jevStoryId}_serra`;
		await db.insert(schema.entities).values({ id: backgroundActorId, storyId: jevStoryId,
			type: 'character', name: 'Serra', description: 'A scout with a saved plan.',
			state: { currentPlan: 'Map the north harbor route.', currentGoal: 'Find a safe passage.',
				nextOpportunity: 'Question the night watch at the north gate.' },
			sourceEntryIds: [jevData.entries[0].id] });
		const { getActorDecisionView } = await load('engine/gmTools');
		assert((await getActorDecisionView(jevStoryId, { actorId: backgroundActorId })).unresolved.length > 0,
			'An actor with no personal knowledge was treated as ready to decide');
		await db.insert(schema.npcBeliefs).values({ id: `${jevStoryId}_serra_gate`, storyId: jevStoryId,
			believerEntityId: backgroundActorId, belief: 'The north gate watch changes at dusk.',
			confidence: 0.9, visibility: 'secret', sourceEntryIds: [jevData.entries[0].id] });
		assert.equal((await getActorDecisionView(jevStoryId, { actorId: backgroundActorId })).unresolved.length, 0,
			'New personal knowledge did not make a supported actor decision possible');
		let backgroundDecisionRequests = 0;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url !== 'https://openrouter.ai/api/alpha/decisions') throw new Error(`Background Jev replay forbids external request: ${url}`);
			backgroundDecisionRequests++;
			const body = JSON.parse(init.body);
			assert(body.questions.selection.criteria.pursue_opportunity, 'Saved opportunity was not offered as a concrete step');
			assert(JSON.stringify(body.state).includes('north gate watch changes at dusk'), 'Serra known belief was absent');
			assert(!JSON.stringify(body.state).includes('Mara offered passage'), 'Another actor belief leaked into Serra decision');
			return Response.json({ model: 'typesafe/jev-1.13-20260917', answers: { selection: {
				type: 'choice', choice: 'pursue_opportunity', confidence: 0.91,
				probabilities: { wait: 0.03, prepare: 0.03, pursue_opportunity: 0.91, investigate: 0.03 } } },
				usage: { input_tokens: 130, output_tokens: 12, cost: 0.0002 } });
		};
		const backgroundJobId = await enqueueBackendJob({ storyId: jevStoryId,
			type: 'evaluate_npc_background_action', dedupeKey: 'replay-serra-background',
			payload: { assistantEntryId: 'narration_jev_handoff_turn' }, maxAttempts: 2 });
		const backgroundRun = await runBackendJobNow(backgroundJobId, 'replay-serra-worker');
		assert(backgroundRun.completed, `Background actor job failed: ${backgroundRun.error ?? 'unknown'}`);
		assert.deepEqual(backgroundRun.result, { status: 'held', reason: 'individual_portrayal_owned_by_main_gm' }, 'Background job bypassed present actor ownership');
		const duplicateJobId = await enqueueBackendJob({ storyId: jevStoryId,
			type: 'evaluate_npc_background_action', dedupeKey: 'replay-serra-background-duplicate',
			payload: { assistantEntryId: 'narration_jev_handoff_turn' }, maxAttempts: 2 });
		const duplicateRun = await runBackendJobNow(duplicateJobId, 'replay-serra-worker-retry');
		assert(duplicateRun.completed && duplicateRun.result?.status !== 'applied', 'Background job retry duplicated the step');
		assert.equal(backgroundDecisionRequests, 0, 'Held background portrayal spent a Jev request');
		assert.equal((await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, jevStoryId)))
			.filter(event => event.metadata.sourceType === 'npc_independent_action').length, 0, 'Held NPC plan became implicit canon');
		const [npcStory] = await db.select().from(schema.stories).where(eq(schema.stories.id, jevStoryId));
		const acceptedNpcEventId = `${jevStoryId}_accepted_serra_question`;
		const scheduledNpc = await scheduleTimelineEvent({ id: acceptedNpcEventId, storyId: jevStoryId, type: 'reveal',
			title: 'Accepted Serra attempt', body: 'Serra asks the night watch about the north harbor route. No answer is yet established.',
			actorEntityIds: [backgroundActorId], locationId: 'north_gate', sourceEntryIds: [jevData.entries[0].id],
			currentTurn: npcStory.currentTurn, delayTurns: 0, now: new Date().toISOString(), visibility: 'player_known', metadata: { sourceType: 'npc_independent_action' } });
		await patchWorldRecord(jevStoryId, 'events', acceptedNpcEventId, { expectedVersion: scheduledNpc.serverVersion,
			updates: { status: 'committed', occurredTurn: npcStory.currentTurn, scheduledTurn: null }, reason: 'Accept deterministic replay NPC attempt evidence.' });
		let directorSawNpcAttempt = false;
		const npcDirector = await runPlotBrainPlanCommand({ storyId: jevStoryId, trigger: 'manual', execute: true }, {
			planner: { plan: async strategicInput => {
				directorSawNpcAttempt = strategicInput.worldEvents.some(event => event.id === acceptedNpcEventId);
				assert(directorSawNpcAttempt, 'Director input lost the off-scene NPC attempt');
				return strategicWorldFrameSchema.parse({ id: 'replay_npc_quiet_frame', storyId: jevStoryId,
					trigger: 'manual', activationPlan: { activateNow: [] } });
			} },
		});
		assert(npcDirector.executed, 'A quiet Director frame was not applied after the NPC attempt');
		const { selectStrategicSceneCue } = await vite.ssrLoadModule('/src/lib/services/ai/context/strategicFramePromptCard.ts');
		assert.equal(selectStrategicSceneCue(npcDirector.frame, { playerAction: 'I continue my quiet conversation.', locationId: 'harbor' }), null,
			'An off-scene NPC attempt became an automatic foreground hook');
		const requestsByRole = Object.fromEntries(['planner', 'narrator', 'dialogue', 'classifier'].map(role => [role, {
			requests: agentProviderRequests.filter(request => request.role === role).length,
			promptTokens: agentProviderRequests.filter(request => request.role === role).reduce((sum, request) => sum + request.promptTokens, 0),
			completionTokens: agentProviderRequests.filter(request => request.role === role).reduce((sum, request) => sum + request.completionTokens, 0),
			promptChars: agentProviderRequests.filter(request => request.role === role).reduce((sum, request) => sum + request.promptChars, 0),
		}]));
		results.push({ id: 'agent-loop-001', passed: true, turns: agentResults.length, toolCalls, factionMoves: moveIds.length,
			chapterClosure: { closedThreadId: oldThreadId, linkedFutureCancelled: true, unrelatedFuturePreserved: true, repeatedClosureSafe: true },
			dialogue: { speakerRequests: dialoguePackets.length, distinctSpeakerIsolation: true, fallbackTurns: 1,
				selectiveRequests: selectiveRequests.filter(request => request.model === 'replay-dialogue').length },
			jev: { decisionRequests: jevRequestCount, failedDecisionRequests: failedJevRequests, plannerDecisionReused: true,
				backgroundDecisionRequests, backgroundStatus: 'held', acceptedNpcConsequence: true, backgroundRetrySkipped: true, directorSawNpcAttempt, npcAttemptStayedQuiet: true },
			verification: { continuityReviewRequests: shadowRequests + canonicalReviewRequests,
				selfCitedWarningsRejected: 2, retainedCanonicalEvidenceReviewed: true },
			extraction: { deferredTurns: 2, laterRealizationPreserved: true, retryReceiptPreserved: true,
				staleCandidateRejected: true, parallelPovWriteRejected: true, parallelPovExposureRejected: true },
			causalLoop: { directorSawMove, directorFrameId: directorResult.frameId, signalId,
				actorLearnedSignal: true, nextSceneRealizedSignal: true, followingTurnExcludedDueSignal: true }, requestsByRole,
			retainedSourceSpanCount: agentResults.reduce((sum, run) => sum + (run.result?.turn?.contextReceipt?.selection?.requests?.[0]?.sourceSpans?.length ?? 0), 0) });
		console.log(`PASS agent-loop-001: five agent turns, Director consequence, actor memory, source-linked feedback, ${moveIds.length} explicitly accepted faction consequence`);
		const ambientStoryId = 'replay_imported_project_ambient';
		const ambientData = fixture(ambientStoryId);
		ambientData.story.currentTurn = 37;
		await db.insert(schema.stories).values(ambientData.story);
		await db.insert(schema.entities).values(ambientData.entities);
		await db.insert(schema.storyEntries).values(ambientData.entries);
		const purebornId = `${ambientStoryId}_pureborn`;
		const spicersId = `${ambientStoryId}_spicers`;
		const importedProjectId = `${ambientStoryId}_spicers_project`;
		await db.insert(schema.factions).values([
			{ id: purebornId, storyId: ambientStoryId, name: 'Pureborn', pressure: 58,
				goals: ['Maintain rule against merchant associations'], metadata: { currentStoryEvidence: true, lastWorldSimTickTurn: 34 } },
			{ id: spicersId, storyId: ambientStoryId, name: 'Spicers', pressure: 16,
				goals: ['Improve influence over commerce and civic decisions'],
				metadata: { currentStoryEvidence: true, factionType: 'commercial' } },
		]);
		await db.insert(schema.factionProjects).values({ id: importedProjectId, storyId: ambientStoryId,
			factionId: spicersId, project: 'Debate construction and political proposals privately at the guild.',
			status: 'active', progress: 0, metadata: {} });
		await db.update(schema.llmServiceSettings).set({ enabled: false })
			.where(eq(schema.llmServiceSettings.serviceId, 'actorDecision'));
		const ambientJobId = await enqueueBackendJob({ storyId: ambientStoryId,
			type: 'evaluate_world_sim_tick', dedupeKey: 'imported-project-ambient',
			payload: { ambient: true }, maxAttempts: 2 });
		const ambientRun = await runBackendJobNow(ambientJobId, 'replay-ambient-worker');
		assert(ambientRun.completed, `Imported-project ambient tick failed: ${ambientRun.error ?? 'unknown'}`);
		assert.equal(ambientRun.result?.createdEvents, 0, 'Ambient intention review fabricated an accepted move');
		const [unchangedProject] = await db.select().from(schema.factionProjects)
			.where(eq(schema.factionProjects.id, importedProjectId));
		assert.equal((await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, ambientStoryId))).length, 0, 'Ambient review invented an event or external target');
		assert.equal(unchangedProject.progress, 0, 'Ambient movement advanced imported project intent');
		await db.update(schema.factions).set({ metadata: { worldSimEnabled: false } })
			.where(eq(schema.factions.id, purebornId));
		await db.update(schema.llmServiceSettings).set({ enabled: true })
			.where(eq(schema.llmServiceSettings.serviceId, 'actorDecision'));
		let duplicateDecisionCalls = 0;
		globalThis.fetch = async () => { duplicateDecisionCalls++; throw new Error('Repeated move reached Jev'); };
		const repeatJobId = await enqueueBackendJob({ storyId: ambientStoryId,
			type: 'evaluate_world_sim_tick', dedupeKey: 'imported-project-repeat',
			payload: { ambient: true }, maxAttempts: 2 });
		const repeatRun = await runBackendJobNow(repeatJobId, 'replay-ambient-repeat-worker');
		assert(repeatRun.completed, `Repeated ambient tick failed: ${repeatRun.error ?? 'unknown'}`);
		assert.equal(repeatRun.result?.createdEvents, 0, 'A repeated faction action created another canonical event');
		assert.equal(duplicateDecisionCalls, 0, 'Known repeated move spent a Jev request');
		results.push({ id: 'imported-project-ambient-001', passed: true, createdEvents: 0,
			factionId: spicersId, importedProjectProgress: unchangedProject.progress, duplicateDecisionCalls });
		console.log('PASS imported-project-ambient-001: imported intent stays pending; ambient review creates no canon or duplicate Jev call');
		const quietStoryId = 'replay_quiet_faction_scene';
		const quietData = fixture(quietStoryId);
		const quietRoadId = `${quietStoryId}_road`;
		quietData.entities.push({ id: quietRoadId, storyId: quietStoryId, type: 'location',
			name: 'Road', description: 'The road outside the hall.' });
		const quietCards = [
			{ id: 'levy', title: 'The Harbor Levy', logline: 'The port levy raises passage fees.', touchpoint: 'booking passage', pressure: 20 },
			...['herbs', 'linen', 'candles'].map((item, index) => ({ id: item, title: `The ${item} guild`,
				logline: `${item} prices change.`, touchpoint: `buy ${item}`, pressure: 21 + index })),
			{ id: 'remote_war', title: 'The Distant War', logline: 'War grows far away.',
				touchpoint: 'war', pressure: 95, urgency: 'immediate', remote: true },
		];
		const quietFrame = strategicWorldFrameSchema.parse({ id: 'replay_quiet_faction_frame', storyId: quietStoryId,
			plotCards: quietCards.map(card => ({ id: card.id, title: card.title, logline: card.logline,
				lifecycleStage: 'simmer', visibility: 'public', pressure: card.pressure, urgency: card.urgency,
				locationIds: [card.remote ? 'other_location' : quietData.ids.hall],
				playerTouchpoints: [card.touchpoint], sourceRefs: [{ sourceType: 'world_event',
					sourceId: `${quietStoryId}_${card.id}`, label: card.title }] })),
			activationPlan: { activateNow: quietCards.map(card => card.id) } });
		quietData.story.metadata = { plotBrain: { active: true, lastFrame: quietFrame,
			lastFrameId: quietFrame.id, lastFrameTurn: quietData.story.currentTurn } };
		await db.insert(schema.stories).values(quietData.story);
		await db.insert(schema.entities).values(quietData.entities);
		await db.insert(schema.storyEntries).values(quietData.entries);
		await db.insert(schema.storyEvents).values(quietCards.map(card => ({ id: `${quietStoryId}_${card.id}`,
			storyId: quietStoryId, type: 'faction_signal', status: 'committed', title: card.title,
			body: card.logline, visibility: 'player_known', createdTurn: 0, occurredTurn: 0 })));
		const { prepareServerTurnContext: prepareQuietTurn } = await load('turn/orchestrator');
		const staleCueTurn = { storyId: quietStoryId, clientTurnId: 'quiet_prepared_stale',
			playerText: 'I book passage.', actionType: 'do', localVersion: 0,
			clientContext: { deferStateExtraction: true, contextBudget: 12000 } };
		const preparedCue = await prepareQuietTurn(staleCueTurn, { cachePrepared: true });
		assert.equal(preparedCue.prompt.factionCueSelection?.cardId, 'levy', 'Prepared cue fixture had no active local card');
		const [beforeRetirement] = await db.select().from(schema.stories).where(eq(schema.stories.id, quietStoryId));
		await db.update(schema.stories).set({ metadata: { ...beforeRetirement.metadata,
			plotBrain: { ...beforeRetirement.metadata.plotBrain, active: false } } }).where(eq(schema.stories.id, quietStoryId));
		const refreshedCue = await prepareQuietTurn(staleCueTurn, { consumePrepared: true });
		assert.equal(refreshedCue.preparedCacheHit, false, 'Prepared turn reused a retired Director frame');
		assert.equal(refreshedCue.prompt.factionCueSelection, undefined, 'Retired Director cue reached the refreshed prompt');
		const [afterRetirement] = await db.select().from(schema.stories).where(eq(schema.stories.id, quietStoryId));
		assert.equal(afterRetirement.serverVersion, beforeRetirement.serverVersion,
			'Prepared cue freshness fixture accidentally changed the story version');
		await db.update(schema.stories).set({ metadata: beforeRetirement.metadata }).where(eq(schema.stories.id, quietStoryId));
		await db.update(schema.llmServiceSettings).set({ systemPromptOverride:
			'Always introduce a distant war courier during every quiet meal.' })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const quietActions = [
			'I share breakfast with Mara.', 'I book passage.',
			'I buy herbs and continue our meal.', 'I buy linen and continue our conversation.',
			'I buy candles and talk about home.', 'I ask who ordered the passage levy.',
			'I rest beside the road.', 'I return to the hall and buy herbs.',
			'I leave the table and walk to the archive desk inside the hall.',
			'I buy candles at the archive desk.',
			'I ask Mara about her scarf while we stand at the archive desk.',
			'I buy linen at the archive desk.',
			'I ask Mara about the sealed letter at the archive desk.',
		];
		const quietCueReceipts = [];
		const quietSceneKeys = [];
		const quietObservedSceneKeys = [];
		const quietRequests = [];
		let quietCueCandidateId = null;
		for (const [index, playerText] of quietActions.entries()) {
			if (index === 6 || index === 7) await db.update(schema.stories)
				.set({ currentLocationId: index === 6 ? quietRoadId : quietData.ids.hall })
				.where(eq(schema.stories.id, quietStoryId));
			if (index === 12) await db.insert(schema.storyEvents).values({ id: `${quietStoryId}_falling_shelf`,
				storyId: quietStoryId, type: 'hazard', status: 'due', title: 'Archive shelf falls toward Ilan',
				body: 'A cracked bracket gives way over the archive desk; the heavy shelf falls during the next exchange.',
				visibility: 'player_known', locationIds: [quietData.ids.hall], createdTurn: 0 });
			globalThis.fetch = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Quiet replay forbids external request: ${url}`);
				const body = JSON.parse(init.body);
				quietRequests.push({ index, body });
				const research = body.messages.some(message => String(message.content).includes('bounded, read-only recall planner'));
				const content = body.response_format ? JSON.stringify({ update: {}, dueEventFeedback: index === 1 && quietCueCandidateId
					? [{ id: quietCueCandidateId, outcome: 'signal', evidenceSpan: 'The clerk books the passage and notes the posted harbor levy adds two coins to the fare.' }]
					: [] })
					: research ? JSON.stringify({ status: 'insufficient_evidence', reason: 'No matching source.', calls: [] })
					: index === 8 ? 'At the archive desk, Ilan leaves the table and opens the ledger.'
					: index === 10 ? 'Mara answers Ilan beside the archive desk. Their conversation continues.'
					: index > 8 ? index === 12 ? 'A bracket snaps and the shelf falls across the archive desk. No one is struck.'
						: 'The conversation at the archive desk continues without interruption.'
					: `[${index === 6 ? 'Road' : 'Great Hall'}]\n${index === 1 ? 'The clerk books the passage and notes the posted harbor levy adds two coins to the fare.'
						: index === 5 ? 'The clerk explains who ordered the levy.'
							: 'Breakfast and conversation continue without interruption.'}`;
				return Response.json({ id: `quiet_fake_${index}`, model: body.model,
					choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
			};
			const response = await processServerTurn({ storyId: quietStoryId, clientTurnId: `quiet_faction_${index}`,
				playerText, actionType: 'do', localVersion: index,
				clientContext: { deferStateExtraction: true, contextBudget: 12000,
					chapterThreshold: 200, postChapterBuffer: 100 } });
			const [entry] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, response.assistantEntryId));
			const [story] = await db.select().from(schema.stories).where(eq(schema.stories.id, quietStoryId));
			quietCueReceipts.push(entry.metadata.factionCueReceipt ?? null);
			quietSceneKeys.push(story.metadata.factionPresentation?.sceneKey ?? null);
			quietObservedSceneKeys.push(story.metadata.factionPresentation?.observedSceneKey ?? null);
			if (index === 1) {
				quietCueCandidateId = entry.metadata.dueEventCandidates?.find(candidate => candidate.id.startsWith('faction_cue_'))?.id ?? null;
				assert(quietCueCandidateId, 'Selected cue had no deferred feedback candidate');
				const cueJob = (await db.select().from(schema.backendJobs).where(eq(schema.backendJobs.storyId, quietStoryId)))
					.find(job => job.type === 'extract_turn_state' && job.payload.assistantEntryId === response.assistantEntryId);
				assert(cueJob?.status === 'queued', 'Selected cue had no queued extraction job');
				const cueRun = await runBackendJobNow(cueJob.id, 'quiet-cue-feedback');
				assert(cueRun.completed, `Selected cue extraction failed: ${cueRun.error ?? 'unknown'}`);
				const [surfaced] = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, response.assistantEntryId));
				const [withFeedback] = await db.select().from(schema.stories).where(eq(schema.stories.id, quietStoryId));
				assert.equal(surfaced.metadata.factionCueReceipt?.status, 'surfaced', 'Deferred worker lost the selected cue');
				assert(withFeedback.metadata.factionPresentation?.sourceKeys?.includes(surfaced.metadata.factionCueReceipt.sourceKey),
					'Final-source cue identity did not reach presentation history');
				assert.equal(surfaced.metadata.dueEventFeedbackReceipt?.committedIds?.length ?? 0, 0,
					'Cue feedback falsely completed a world event');
				const { refreshSceneCheckpoint } = await load('memory/sceneCheckpoint');
				assert.equal((await refreshSceneCheckpoint(quietStoryId)).refreshed, true,
					'Cue scene checkpoint did not refresh');
			}
			if (index === 8 || index === 10) {
				const { refreshSceneCheckpoint } = await load('memory/sceneCheckpoint');
				const refreshed = await refreshSceneCheckpoint(quietStoryId);
				assert.equal(refreshed.refreshed, true, 'Same-location activity transition did not create a scene checkpoint');
				if (index === 10) {
					const [updated] = await db.select().from(schema.stories).where(eq(schema.stories.id, quietStoryId));
					assert.equal(updated.metadata.sceneCheckpoint.scene, 'archive desk',
						'Unheaded conversation erased the observed scene name');
				}
			}
		}
		assert.equal(quietCueReceipts[0], null, 'Quiet breakfast received a discretionary faction cue');
		assert.equal(quietCueReceipts[1]?.cardId, 'levy', 'Booking did not select the local levy');
		assert.equal(quietCueReceipts[1]?.status, 'selected', 'Local levy cue was not retained in the narrator request');
		assert(quietCueReceipts.slice(2, 5).every(receipt => receipt === null), 'Ignored hook rotated into another minor cue');
		assert(quietSceneKeys.slice(1, 6).every(key => key && key === quietSceneKeys[1]), 'The ongoing scene lost its cue allowance');
		assert.equal(quietCueReceipts[5]?.cardId, 'levy', 'Direct levy inquiry could not reopen its source');
		assert.equal(quietCueReceipts[5]?.mode, 'direct', 'Direct levy inquiry was treated as ambient pressure');
		assert.equal(quietCueReceipts[5]?.sourceKey, quietCueReceipts[1]?.sourceKey, 'Direct inquiry relabeled the old source');
		assert.equal(quietCueReceipts[6], null, 'Travel through another quiet place received a faction cue');
		assert.equal(quietCueReceipts[7]?.cardId, 'herbs', 'Returning after a scene transition did not open a new cue allowance');
		assert.notEqual(quietObservedSceneKeys[6], quietObservedSceneKeys[5], 'Quiet travel did not record the new scene');
		assert.equal(quietObservedSceneKeys[7], quietObservedSceneKeys[5], 'Return did not restore the hall scene identity');
		assert.equal(quietCueReceipts[8], null, 'Moving to another activity introduced an unrelated cue');
		assert.equal(quietCueReceipts[9]?.cardId, 'candles', 'A supported same-location scene transition did not reopen the cue allowance');
		assert.equal(quietSceneKeys[8], quietSceneKeys[7], 'The activity transition prematurely changed the prior scene identity');
		assert.notEqual(quietSceneKeys[9], quietSceneKeys[8], 'The confirmed prose move did not change the activity scene identity');
		assert.equal(quietObservedSceneKeys[9], quietSceneKeys[9], 'The new activity scene was not observed');
		assert.equal(quietCueReceipts[10], null, 'Unheaded conversation caused an unrelated discretionary cue');
		assert.equal(quietCueReceipts[11], null, 'Unheaded prose reopened the same scene for a rotating linen cue');
		assert.equal(quietSceneKeys[11], quietSceneKeys[10], 'Unheaded prose changed the scene identity');
		assert.equal(quietCueReceipts[12], null, 'Immediate local danger caused an unrelated discretionary cue');
		const quietPromptText = index => quietRequests.filter(request => request.index === index)
			.flatMap(request => request.body.messages.map(message => String(message.content))).join('\n');
		assert([0, 2, 3, 4].every(index => !quietPromptText(index).includes('Plot Director Pressure')),
			'Quiet or ignored-hook turn still sent Director pressure to narration');
		assert([1, 5].every(index => quietPromptText(index).includes('Plot Director Pressure')),
			'Booking or direct inquiry lost its selected Director cue');
		assert(quietPromptText(0).includes('Always introduce a distant war courier'),
			'Custom GM override did not reach the narrator request');
		assert(quietPromptText(0).indexOf('Optional faction pressure needs a server-selected scene cue')
			> quietPromptText(0).indexOf('Always introduce a distant war courier'),
			'Custom GM override bypassed the current scene-cue authority');
		assert.equal(quietRequests.filter(request => request.index === 0).length, 1, 'Quiet scene caused an extra model request');
		assert(quietPromptText(12).includes('Archive shelf falls toward Ilan'), 'Immediate local danger was omitted from the narrator request');
		assert(!quietPromptText(12).includes('Plot Director Pressure'), 'Immediate local danger opened a discretionary Director cue');
		results.push({ id: 'quiet-faction-scene-001', passed: true, turns: quietActions.length,
			cueCards: quietCueReceipts.map(receipt => receipt?.cardId ?? null),
			sceneKeyStable: true, sameLocationActivityTransition: true, unheadedFollowUpStable: true, immediateLocalDangerRetained: true,
			directInquiryReopened: true, customOverrideGuarded: true, requests: quietRequests.length,
			remoteTitleInQuietPrompt: quietPromptText(0).includes('The Distant War'), deferredCueSurfaced: true });
		console.log('PASS quiet-faction-scene-001: quiet meal, one local cue, three ignored follow-ups, direct inquiry');
		await db.update(schema.llmServiceSettings).set({ systemPromptOverride: null })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const checkpointStoryId = 'replay_checkpoint_refresh';
		const checkpointData = fixture(checkpointStoryId);
		checkpointData.story.currentTurn = 25;
		checkpointData.entries = Array.from({ length: 25 }, (_, index) => [{
			id: `${checkpointStoryId}_player_${index + 1}`, storyId: checkpointStoryId, type: 'user_action', position: index * 2 + 1,
			content: 'I ask the clerk about another ordinary delivery.',
		}, {
			id: `${checkpointStoryId}_scene_${index + 1}`, storyId: checkpointStoryId, type: 'narration', position: index * 2 + 2,
			parentId: `${checkpointStoryId}_player_${index + 1}`,
			content: index === 0 ? '[Great Hall]\nThe harbor master promised the old route would stay open.'
				: `[Great Hall]\nThe clerk records an ordinary delivery at the hall, day ${index + 1}.`,
		}]).flat();
		await db.insert(schema.stories).values(checkpointData.story);
		await db.insert(schema.entities).values(checkpointData.entities);
		await db.insert(schema.storyEntries).values(checkpointData.entries);
		await db.update(schema.llmServiceSettings).set({ contextWindowTokens: 9000 })
			.where(eq(schema.llmServiceSettings.serviceId, 'narrative'));
		const { refreshSceneCheckpoint } = await load('memory/sceneCheckpoint');
		const firstCheckpoint = await refreshSceneCheckpoint(checkpointStoryId);
		assert.equal(firstCheckpoint.refreshed, true, 'Initial scene checkpoint did not build');
		const checkpointTurn = { storyId: checkpointStoryId, clientTurnId: 'checkpoint_refresh_0',
			playerText: 'Ask the harbor master about the promise.', actionType: 'do', localVersion: 0,
			clientContext: { deferStateExtraction: false, contextBudget: 12000, chapterThreshold: 200, postChapterBuffer: 100 } };
		const { prepareServerTurn, normalizeGmToolArgs } = await load('turn/orchestrator');
		await prepareServerTurn(checkpointTurn);
		const [beforeCheckpointRefresh] = await db.select().from(schema.stories).where(eq(schema.stories.id, checkpointStoryId));
		await db.update(schema.storyEntries).set({ content: '[Great Hall]\nThe harbor master promised the new route would stay open.' })
			.where(eq(schema.storyEntries.id, `${checkpointStoryId}_scene_1`));
		const secondCheckpoint = await refreshSceneCheckpoint(checkpointStoryId);
		assert.equal(secondCheckpoint.refreshed, true, 'Edited scene checkpoint did not refresh');
		assert.notEqual(secondCheckpoint.checkpointId, firstCheckpoint.checkpointId, 'Edited evidence retained the old checkpoint identity');
		const [afterCheckpointRefresh] = await db.select().from(schema.stories).where(eq(schema.stories.id, checkpointStoryId));
		assert.equal(afterCheckpointRefresh.serverVersion, beforeCheckpointRefresh.serverVersion,
			'Checkpoint freshness fixture accidentally changed story server version');
		const checkpointRequests = [];
		const checkpointDecisionRequests = [];
		let inlineMemoryCase = null;
		globalThis.fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			if (url === 'https://openrouter.ai/api/alpha/decisions') {
				const body = JSON.parse(init.body);
				assert(inlineMemoryCase?.kind && body.questions.support_0,
					'Unexpected Jev decision request in checkpoint replay');
				checkpointDecisionRequests.push(body);
				const support = inlineMemoryCase.kind === 'proposal' ? 'unsupported' : 'supported';
				return Response.json({ answers: {
					change_0: { type: 'choice', choice: inlineMemoryCase.kind, confidence: 0.95,
						probabilities: { [inlineMemoryCase.kind]: 0.95 } },
					support_0: { type: 'choice', choice: support, confidence: 0.95, probabilities: { [support]: 0.95 } },
				} });
			}
			if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Checkpoint replay forbids external request: ${url}`);
			const body = JSON.parse(init.body);
			checkpointRequests.push(body);
			const gmResearchPlanner = body.messages.some(message => String(message.content).includes('bounded, read-only recall planner'));
			return Response.json({ id: `checkpoint_fake_${checkpointRequests.length}`, model: body.model,
				choices: [{ message: { role: 'assistant', content: body.response_format
					? JSON.stringify({ update: {}, dueEventFeedback: [] })
					: gmResearchPlanner ? JSON.stringify({ status: 'insufficient_evidence', reason: 'No matching source.', calls: [] })
					: inlineMemoryCase?.narration ?? '[Great Hall]\nThe harbor master confirms the new route remains open.' }, finish_reason: 'stop' }],
				usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
		};
		const { executeEngineCommand } = await load('engine/command');
		const directToolCalls = [];
		const checkpointResponse = await processServerTurn(checkpointTurn, {
			agentRunObservations: Array.from({ length: 200 }, (_, index) =>
				`Verified ledger observation ${index + 1}: harbor access and route permissions remain subject to the current scene.`).join('\n'),
			runGmTool: async (call) => {
				directToolCalls.push(call.command);
				const response = await executeEngineCommand({ storyId: checkpointStoryId, command: call.command,
					clientCommandId: `checkpoint:${call.id}`, args: normalizeGmToolArgs(call) });
				if (response.status !== 'succeeded') throw new Error(response.error ?? `${call.command} failed`);
				return response.result;
			},
		});
		assert(directToolCalls.includes('campaign.entriesAround'),
			`Direct turn did not expand historical transcript evidence: ${directToolCalls.join(', ')}`);
		assert(checkpointResponse.gmTurnReceipt?.tools?.some((tool) => tool.command === 'campaign.entriesAround' && tool.ok),
			'Direct turn receipt omitted the successful historical read');
		const checkpointPrompt = checkpointRequests.filter(request => !request.response_format)
			.flatMap(request => request.messages.map(message => String(message.content))).join('\n');
		assert(checkpointPrompt.includes('campaign.entriesAround'), 'Direct historical read was lost before the narrator request');
		assert(checkpointPrompt.includes('The harbor master promised the new route would stay open.'),
			'Submitted turn used the cached old checkpoint');
		assert(!checkpointPrompt.includes('The harbor master promised the old route would stay open.'),
			'Submitted turn leaked a stale checkpoint note');
		assert.equal(checkpointResponse.contextReceipt?.selection?.sceneCheckpoint?.id, secondCheckpoint.checkpointId,
			'Saved context receipt did not identify the refreshed checkpoint');
		const checkpointNarration = checkpointRequests.find(request => !request.response_format);
		const checkpointSummary = checkpointResponse.contextReceipt?.selection?.requests?.[0];
		const checkpointSystemChars = checkpointSummary.sections.find(section => section.id === 'system').chars;
		const checkpointDynamicChars = checkpointSummary.sections.find(section => section.id === 'context').chars;
		const checkpointWireSystem = checkpointNarration.messages[0].content;
		const checkpointWireContext = checkpointWireSystem.slice(checkpointSystemChars + 2);
		assert.equal(checkpointWireContext.length, checkpointDynamicChars, 'Final context receipt differs from provider payload');
		assert(checkpointSummary.sourceSpans.length > 0, 'Observation-heavy request retained no source spans');
		for (const span of checkpointSummary.sourceSpans) assert((span.section === 'system' ? checkpointWireSystem.slice(0, checkpointSystemChars) : checkpointWireContext).slice(span.start, span.end).trim(),
			`Observation-heavy request has an empty source span: ${span.id}`);
		const { countTokens } = await vite.ssrLoadModule('/src/lib/utils/tokens.ts');
		assert(countTokens(checkpointNarration.messages.map(message => String(message.content)).join('\n\n'))
			+ 2048 + 512 <= 9000, 'Final serialized request exceeded the configured model capacity');
		assert(checkpointResponse.warnings.some(warning => warning.includes('Final narration context budget applied')),
			`Observation-heavy request did not exercise the final context rebudget: ${JSON.stringify({ totalTokens: checkpointSummary.totalTokens, sections: checkpointSummary.sections, warnings: checkpointResponse.warnings })}`);
		const recoveryTurn = { ...checkpointTurn, clientTurnId: 'checkpoint_recover_1',
			playerText: 'Ask the clerk to confirm the route.', localVersion: 1 };
		const recoveryRunId = 'run_replay_checkpoint_commit_recovery';
		await db.execute(sql`insert into agent_runs(id,project_id,game_id,client_turn_id,status,request,result,lease_until,expires_at)
			values(${recoveryRunId},${afterCheckpointRefresh.shelfId},${checkpointStoryId},${recoveryTurn.clientTurnId},'committing',
			${JSON.stringify(recoveryTurn)}::jsonb,'{"plannerText":"done"}'::jsonb,now()-interval '1 second',now()+interval '24 hours')`);
		const { getAgentRun } = await load('engine/agentRuns');
		const recovered = await waitForAgentRun({ getAgentRun }, { runId: recoveryRunId, storyId: checkpointStoryId });
		assert.equal(recovered.status, 'completed', `Expired committing run did not resume: ${recovered.error ?? 'unknown'}`);
		const recoveredAgain = await getAgentRun({ runId: recoveryRunId, storyId: checkpointStoryId });
		assert.equal(recoveredAgain.status, 'completed', 'Recovered run did not remain completed');
		assert.equal(recoveredAgain.result?.turn?.assistantEntryId, recovered.result?.turn?.assistantEntryId,
			'Recovered run duplicated the narration on a second read');
		assert.equal((await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.id, recovered.result.turn.assistantEntryId))).length,
			1, 'Recovered run persisted more than one narration');
		const { executeTurnSubmitCommand } = await load('engine/turnFacade');
		const directCommandTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_direct_command_2', playerText: 'Who promised the new route would stay open earlier?', localVersion: 2 });
		assert(directCommandTurn.gmTurnReceipt?.tools?.some((tool) => tool.command === 'campaign.entriesAround' && tool.ok),
			'Direct engine turn command lost the bounded historical read');
		const { POST: streamTurn } = await vite.ssrLoadModule('/src/routes/api/turn/stream/+server.ts');
		const streamResponse = await streamTurn({ request: new Request('http://replay.invalid/api/turn/stream', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ ...checkpointTurn, clientTurnId: 'checkpoint_direct_stream_3',
				playerText: 'Who promised the new route would stay open before?', localVersion: 3 }),
		}) });
		const streamEvents = (await streamResponse.text()).split('\n\n');
		assert(streamEvents.some((event) => event.startsWith('event: gm.activity\n') && event.includes('campaign.entriesAround')),
			`Direct SSE turn did not stream the historical read activity: ${streamEvents.filter(event => event.startsWith('event: error\n') || event.startsWith('event: gm.activity\n')).join('\n')}`);
		const doneEvent = streamEvents.find((event) => event.startsWith('event: done\n'));
		assert(doneEvent, `Direct SSE turn produced no completion event: ${streamEvents.at(-2)}`);
		const streamTurnResult = JSON.parse(doneEvent.split('\n').find((line) => line.startsWith('data: ')).slice(6));
		assert(streamTurnResult.gmTurnReceipt?.tools?.some((tool) => tool.command === 'campaign.entriesAround' && tool.ok),
			'Direct SSE turn lost the bounded historical read');
		const directWorldTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_direct_world_4', playerText: 'I inspect the Great Hall and ask what is known about it.', localVersion: 4 });
		assert(directWorldTurn.gmTurnReceipt?.tools?.some((tool) => tool.command === 'world.search' && tool.ok),
			'Direct engine turn did not search named canonical lore');
		assert(directWorldTurn.gmTurnReceipt?.tools?.some((tool) => tool.command === 'world.record.get' && tool.ok),
			'Direct engine turn did not read the exact canonical search result');
		assert(JSON.stringify(checkpointRequests.filter((request) => !request.response_format).at(-1)?.messages ?? []).includes('world.record.get'),
			'Direct canonical detail was omitted from the outgoing narrator request');
		const [rawCampaignPage] = await db.execute(sql`select path from campaign_files where story_id=${checkpointStoryId} and kind='raw_turn' order by path limit 1`);
		assert(rawCampaignPage?.path, 'Direct page-read fixture has no indexed raw turn');
		const directPageTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_direct_page_5', playerText: `I read ${rawCampaignPage.path}.`, localVersion: 5 });
		assert(directPageTurn.gmTurnReceipt?.tools?.some((tool) => tool.command === 'campaign.page.read' && tool.ok),
			'Direct engine turn did not read an explicitly named indexed campaign file');
		assert(JSON.stringify(checkpointRequests.filter((request) => !request.response_format).at(-1)?.messages ?? []).includes('campaign.page.read'),
			'Direct campaign page evidence was omitted from the outgoing narrator request');
		await db.insert(schema.memoryNodes).values({ id: `${checkpointStoryId}_salt_rite`, storyId: checkpointStoryId,
			type: 'canonical', title: 'Salt Rite', content: 'The Salt Rite uses brine to welcome a ship into the harbor.',
			sourceEntryIds: [`${checkpointStoryId}_scene_1`] });
		const { materializeStoryVault } = await load('wiki/storyVault');
		await materializeStoryVault({ storyId: checkpointStoryId, clean: true });
		const wikiPages = await executeEngineCommand({ storyId: checkpointStoryId, command: 'wiki.pages',
			clientCommandId: 'checkpoint:wiki-pages', args: {} });
		const saltRitePage = wikiPages.result?.pages?.find(page => page.path?.includes('salt-rite--'));
		assert(saltRitePage?.path, 'Generated Salt Rite lore page was not available to the direct turn');
		const directWikiTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_direct_wiki_6', playerText: 'I study the lore of the Salt Rite.', localVersion: 6 });
		assert(directWikiTurn.gmTurnReceipt?.tools?.some((tool) => tool.command === 'wiki.page' && tool.ok
			&& tool.sourceIds?.includes(saltRitePage.path)),
			`Direct engine turn did not read the named generated wiki page: ${JSON.stringify({ path: saltRitePage.path,
				tools: directWikiTurn.gmTurnReceipt?.tools?.map(tool => ({ command: tool.command, ok: tool.ok, sourceIds: tool.sourceIds })),
				retrievals: directWikiTurn.contextReceipt?.selection?.retrievals })}`);
		assert(JSON.stringify(checkpointRequests.filter((request) => !request.response_format).at(-1)?.messages ?? []).includes(saltRitePage.path),
			'Direct wiki page evidence was omitted from the outgoing narrator request');
		await db.update(schema.llmServiceSettings).set({ enabled: false })
			.where(eq(schema.llmServiceSettings.serviceId, 'actorDecision'));
		const requestsBeforeNpcLore = checkpointRequests.length;
		const directNpcLoreTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_direct_npc_lore_61',
			playerText: 'I ask Mara about the lore of the Salt Rite and offer a deal.', localVersion: 61 });
		await db.update(schema.llmServiceSettings).set({ enabled: true })
			.where(eq(schema.llmServiceSettings.serviceId, 'actorDecision'));
		assert(directNpcLoreTurn.gmTurnReceipt?.tools?.some(tool => tool.command === 'world.actor.brief' && tool.ok),
			'Direct NPC lore turn lost the actor brief');
		assert(directNpcLoreTurn.gmTurnReceipt?.tools?.some(tool => tool.command === 'wiki.page' && tool.ok),
			'Direct NPC lore turn lost the named page behind the social read');
		const npcLoreRequests = checkpointRequests.slice(requestsBeforeNpcLore);
		assert(npcLoreRequests.some(request => !request.response_format && JSON.stringify(request.messages).includes(saltRitePage.path)),
			`Direct NPC lore page was omitted from the outgoing request: ${JSON.stringify({
				models: npcLoreRequests.map(request => request.model),
				tools: directNpcLoreTurn.gmTurnReceipt?.tools?.map(tool => ({ command: tool.command, ok: tool.ok, sourceIds: tool.sourceIds })),
				truncated: directNpcLoreTurn.contextReceipt?.truncated })}`);
		await db.insert(schema.llmServiceSettings).values({ serviceId: 'activeRecall', providerType: 'openai',
			baseUrl: 'http://replay.invalid/v1', model: 'replay-active-recall', apiKeyRef: 'REPLAY_API_KEY',
			contextBudget: 12000, maxTokens: 900, temperature: 0.1, enabled: true });
		const inheritedResearch = await getAgentSettings({ projectId: afterCheckpointRefresh.shelfId, gameId: checkpointStoryId });
		assert.equal(inheritedResearch.sources.gmAdaptiveResearch, 'legacy', 'Retired Active Recall preference was not inherited');
		const requestsBeforeOpening = checkpointRequests.length;
		const openingTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_opening_research_70', playerText: 'What happened at the start of the story?', localVersion: 70 });
		const openingRequests = checkpointRequests.slice(requestsBeforeOpening);
		assert(openingTurn.gmTurnReceipt?.tools?.some(tool => tool.command === 'campaign.entriesAround' && tool.ok
			&& tool.sourceIds?.includes(`${checkpointStoryId}_scene_1`)), 'Direct opening research lost its first source entry');
		assert(JSON.stringify(openingRequests.filter(request => !request.response_format).at(-1)?.messages ?? [])
			.includes('The harbor master promised the new route would stay open.'), 'Opening evidence was absent from the narrator request');
		assert(!openingRequests.some(request => request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))),
			'Opening research made a redundant adaptive planner request');
		const requestsBeforeResearch = checkpointRequests.length;
		const adaptiveTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_adaptive_research_7', playerText: 'What can I discover about an unrecorded salt rite?', localVersion: 7 });
		const adaptiveRequests = checkpointRequests.slice(requestsBeforeResearch);
		assert(adaptiveRequests.some(request => request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))),
			`Open-ended direct GM research did not call the bounded planner: ${JSON.stringify({ receipt: adaptiveTurn.gmTurnReceipt?.activeRecall, tools: adaptiveTurn.gmTurnReceipt?.tools?.map(tool => tool.command), requests: adaptiveRequests.map(request => request.model) })}`);
		assert.equal(adaptiveRequests.filter(request => request.model === 'replay-active-recall'
			&& request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))).length, 1,
			'Legacy rollback did not make exactly one plan through its explicitly saved Active Recall profile');
		assert(adaptiveTurn.generationTimings?.some(timing => timing.serviceId === 'activeRecall'
			&& timing.operation.includes('gm_research.plan')), 'Legacy research planner was not attributed to its saved service');
		await saveAgentSettings({ projectId: afterCheckpointRefresh.shelfId,
			expectedRevision: inheritedResearch.project.revision, changes: { gmAdaptiveResearch: false } });
		const requestsBeforeDisabled = checkpointRequests.length;
		await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_adaptive_disabled_8', playerText: 'What can I discover about an unrecorded salt rite?', localVersion: 8 });
		assert(!checkpointRequests.slice(requestsBeforeDisabled).some(request => request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))),
			'Explicitly disabled GM research still called the planner');
		const requestsBeforeExactRead = checkpointRequests.length;
		const exactReadWithoutPlanner = await executeTurnSubmitCommand({ ...checkpointTurn,
			clientTurnId: 'checkpoint_exact_read_no_planner_81', playerText: 'What happened at the start of the story?', localVersion: 81 });
		assert.equal(exactReadWithoutPlanner.gmTurnReceipt?.activeRecall?.status, 'succeeded',
			'GM research receipt called a successful direct source read disabled');
		assert(exactReadWithoutPlanner.gmTurnReceipt?.activeRecall?.searchedSourceIds?.includes(`${checkpointStoryId}_scene_1`),
			'GM research receipt omitted the exact source read without a planner');
		assert(!checkpointRequests.slice(requestsBeforeExactRead).some(request => request.messages.some(message => String(message.content).includes('bounded, read-only recall planner'))),
			'Exact direct read invoked the disabled adaptive planner');
		const previousInline = process.env.MTHERIOS_INLINE_TURN_MEMORY;
		const requestsBeforeInline = checkpointRequests.length;
		let inlineTurn;
		try {
			process.env.MTHERIOS_INLINE_TURN_MEMORY = '1';
			inlineMemoryCase = { narration: '[Great Hall]\nThe room stays quiet.<turn_memory_update>{"version":1,"changes":[]}</turn_memory_update>' };
			inlineTurn = await executeTurnSubmitCommand({ ...checkpointTurn,
				clientTurnId: 'checkpoint_inline_empty_9', playerText: 'I wait quietly.', localVersion: 9 });
		} finally {
			inlineMemoryCase = null;
			if (previousInline === undefined) delete process.env.MTHERIOS_INLINE_TURN_MEMORY;
			else process.env.MTHERIOS_INLINE_TURN_MEMORY = previousInline;
		}
		assert(!checkpointRequests.slice(requestsBeforeInline).some(request => request.response_format),
			'Accepted empty inline memory still made a classifier request');
		const [inlineEntry] = await db.execute(sql`select content, metadata from story_entries where story_id=${checkpointStoryId} and id=${inlineTurn.assistantEntryId}`);
		assert(inlineEntry?.content === '[Great Hall]\nThe room stays quiet.', 'Inline footer reached the saved narration');
		assert(inlineEntry.metadata?.turnMemory?.accepted === true, 'Inline memory acceptance was absent from final saved metadata');
		const inlineCases = [
			{ id: 'belief', quote: 'Mara hears Ilan say the archive door is locked.', playerText: 'I tell Mara the archive door is locked.', kind: 'belief',
				update: { conversations: [{ npcName: 'Mara', topicSummary: 'Archive door', npcLearned: ['The archive door is locked.'] }] } },
			{ id: 'promise', quote: 'Mara promises Ilan she will bring the ledger tomorrow.', playerText: 'I listen to Mara.', kind: 'event',
				update: { agreements: [{ action: 'create', category: 'promise', parties: ['Mara', 'Ilan'], terms: 'Mara will bring Ilan the ledger tomorrow.' }] } },
		];
		for (const [index, candidate] of inlineCases.entries()) {
			const beforeRequests = checkpointRequests.length;
			const beforeDecisions = checkpointDecisionRequests.length;
			let turn;
			try {
				process.env.MTHERIOS_INLINE_TURN_MEMORY = '1';
				inlineMemoryCase = { kind: candidate.kind,
					narration: `[Great Hall]\n${candidate.quote}<turn_memory_update>${JSON.stringify({ version: 1,
						changes: [{ kind: candidate.kind, quote: candidate.quote, visibility: 'player_known', update: candidate.update }] })}</turn_memory_update>` };
				turn = await executeTurnSubmitCommand({ ...checkpointTurn, clientTurnId: `checkpoint_inline_${candidate.id}_${index + 10}`,
					playerText: candidate.playerText, localVersion: index + 10 });
			} finally {
				inlineMemoryCase = null;
				if (previousInline === undefined) delete process.env.MTHERIOS_INLINE_TURN_MEMORY;
				else process.env.MTHERIOS_INLINE_TURN_MEMORY = previousInline;
			}
			assert.equal(checkpointDecisionRequests.length, beforeDecisions + 1, `Inline ${candidate.id} made the wrong Jev request count`);
			assert(!checkpointRequests.slice(beforeRequests).some(request => request.response_format),
				`Inline ${candidate.id} still made a classifier request`);
			const [entry] = await db.execute(sql`select content, metadata from story_entries where story_id=${checkpointStoryId} and id=${turn.assistantEntryId}`);
			assert.equal(entry?.content, `[Great Hall]\n${candidate.quote}`, `Inline ${candidate.id} footer reached saved narration`);
			assert.equal(entry?.metadata?.turnMemory?.accepted, true, `Inline ${candidate.id} was not accepted`);
			if (candidate.id === 'belief') {
				const beliefs = await db.select().from(schema.npcBeliefs).where(eq(schema.npcBeliefs.storyId, checkpointStoryId));
				assert(beliefs.some(row => row.believerEntityId === checkpointData.ids.mara
					&& row.sourceEntryIds.includes(turn.assistantEntryId) && row.belief.includes('archive door is locked')),
					'Inline witnessed belief was not written for Mara');
				assert(!beliefs.some(row => row.believerEntityId === checkpointData.ids.player
					&& row.sourceEntryIds.includes(turn.assistantEntryId)), 'Inline belief leaked to another actor');
			} else {
				const agreements = await db.select().from(schema.agreements).where(eq(schema.agreements.storyId, checkpointStoryId));
				assert(agreements.some(row => row.category === 'promise' && row.status === 'active'
					&& row.sourceEntryIds.includes(turn.assistantEntryId) && row.terms.includes('tomorrow')),
					'Inline promise did not become a source-linked commitment');
				assert(!agreements.some(row => row.sourceEntryIds.includes(turn.assistantEntryId) && row.status === 'fulfilled'),
					'Inline promise was incorrectly fulfilled');
			}
		}
		const offerQuote = 'Mara offers to bring Ilan the ledger tomorrow.';
		const offerRequestsBefore = checkpointRequests.length;
		const offerDecisionsBefore = checkpointDecisionRequests.length;
		let offerTurn;
		try {
			process.env.MTHERIOS_INLINE_TURN_MEMORY = '1';
			inlineMemoryCase = { kind: 'proposal', narration: `[Great Hall]\n${offerQuote}<turn_memory_update>${JSON.stringify({ version: 1,
				changes: [{ kind: 'event', quote: offerQuote, visibility: 'player_known', update: inlineCases[1].update }] })}</turn_memory_update>` };
			offerTurn = await executeTurnSubmitCommand({ ...checkpointTurn, clientTurnId: 'checkpoint_inline_offer_12',
				playerText: 'I ask Mara whether she can bring the ledger.', localVersion: 12 });
		} finally {
			inlineMemoryCase = null;
			if (previousInline === undefined) delete process.env.MTHERIOS_INLINE_TURN_MEMORY;
			else process.env.MTHERIOS_INLINE_TURN_MEMORY = previousInline;
		}
		assert.equal(checkpointDecisionRequests.length, offerDecisionsBefore + 1, 'The proposed offer did not receive a Jev verdict');
		assert(checkpointRequests.slice(offerRequestsBefore).some(request => request.response_format),
			'The unaccepted offer did not fall back to classifier extraction');
		const [offerEntry] = await db.execute(sql`select content, metadata from story_entries where story_id=${checkpointStoryId} and id=${offerTurn.assistantEntryId}`);
		assert.equal(offerEntry?.content, `[Great Hall]\n${offerQuote}`, 'Rejected offer footer reached saved narration');
		assert.equal(offerEntry?.metadata?.turnMemory?.accepted, false, 'Jev accepted an offer as a completed promise');
		const offerAgreements = await db.select().from(schema.agreements).where(eq(schema.agreements.storyId, checkpointStoryId));
		assert(!offerAgreements.some(row => row.sourceEntryIds.includes(offerTurn.assistantEntryId)),
			'An unaccepted offer created a canonical agreement');
		const beforeSseSettings = await getAgentSettings({ projectId: afterCheckpointRefresh.shelfId, gameId: checkpointStoryId });
		await saveAgentSettings({ projectId: afterCheckpointRefresh.shelfId, gameId: checkpointStoryId,
			expectedRevision: beforeSseSettings.game?.revision ?? 0, changes: { gmResearch: false } });
		const requestsBeforeSse = checkpointRequests.length;
		const { POST: streamTurnEndpoint } = await vite.ssrLoadModule('/src/routes/api/turn/stream/+server.ts');
		const streamed = await streamTurnEndpoint({ request: new Request('http://replay.invalid/api/turn/stream', {
			method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...checkpointTurn,
				clientTurnId: 'checkpoint_sse_research_off_13', playerText: 'What happened at the start of the story?', localVersion: 13 }),
		}) });
		const streamText = await streamed.text();
		assert(!streamText.includes('event: error'), `Research-off SSE turn failed: ${streamText.slice(-1000)}`);
		const done = streamText.match(/^event: done\r?\ndata: (.+)$/m);
		assert(done, 'Research-off SSE turn emitted no completed result');
		const sseTurn = JSON.parse(done[1]);
		assert(streamText.includes('event: narration\n'), 'Research-off SSE turn omitted narration');
		const [savedSseEntry] = await db.select({ content: schema.storyEntries.content }).from(schema.storyEntries)
			.where(eq(schema.storyEntries.id, sseTurn.assistantEntryId));
		assert.equal(savedSseEntry?.content, sseTurn.narration, 'Research-off SSE result differs from saved narration');
		assert(!checkpointRequests.slice(requestsBeforeSse).some(request => request.messages.some(message =>
			String(message.content).includes('bounded, read-only recall planner'))),
			'Research-off SSE turn called the adaptive planner');
		assert.equal(sseTurn.gmTurnReceipt?.activeRecall?.status, 'not_requested',
			'Research-off SSE receipt reported a recall request');
		assert(!sseTurn.gmTurnReceipt?.tools?.some(tool => tool.command === 'campaign.entriesAround'),
			'Research-off SSE turn read historical entries');
		results.push({ id: 'checkpoint-refresh-001', passed: true, firstCheckpointId: firstCheckpoint.checkpointId,
			secondCheckpointId: secondCheckpoint.checkpointId, serverVersionUnchanged: true,
			oldNoteExcluded: true, newNoteSent: true, finalRequestRebudgeted: true,
			finalRequestTokens: checkpointSummary.totalTokens, retainedSourceSpans: checkpointSummary.sourceSpans.length,
			commitStageRecovery: true, directWikiPageRead: true, legacyAdaptiveResearchUsesSavedProfile: true, legacyActiveRecallRequests: 1,
			explicitAdaptiveDisablePreserved: true, researchOffSseCompleted: true, emptyInlineMemorySkippedClassifier: true,
			inlineBeliefAndPromiseSkippedClassifier: true, inlineOfferRetainedClassifier: true });
		console.log('PASS checkpoint-refresh-001: fresh checkpoint, observation-heavy request, persisted commit recovery');
		if (values['jev-inline-trial']) {
			const trialStoryId = 'replay_real_jev_inline';
			const trialData = fixture(trialStoryId);
			await db.insert(schema.stories).values(trialData.story);
			await db.insert(schema.entities).values(trialData.entities);
			await db.insert(schema.storyEntries).values(trialData.entries);
			const trialRequests = [];
			const trialDecisions = [];
			let trialCase = null;
			globalThis.fetch = async (input, init) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === 'https://openrouter.ai/api/alpha/decisions') {
					const body = JSON.parse(init.body);
					assert(trialCase && body.model === 'typesafe/jev-1.13' && body.questions.support_0,
						'Inline Jev trial blocked an unexpected decision request');
					assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${process.env.REPLAY_JEV_API_KEY}`);
					if (spendCapUsd - providerSpendUsd < 0.0002) throw new Error('Inline Jev trial lacks a conservative remaining spend allowance');
					const response = await originalFetch(input, init);
					const result = await response.clone().json().catch(() => null);
					const cost = result?.usage?.cost;
					if (!response.ok || typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0)
						throw new Error(`Inline Jev trial lacked a successful costed response (HTTP ${response.status})`);
					providerSpendUsd += cost;
					if (providerSpendUsd > spendCapUsd) throw new Error('Inline Jev trial exceeded its spend cap');
					const answer = result.answers?.support_0;
					trialDecisions.push({ caseId: trialCase.id, choice: answer?.choice ?? null,
						confidence: answer?.confidence ?? null, selectedProbability: answer?.probabilities?.[answer?.choice] ?? null,
						costUsd: cost });
					return response;
				}
				if (url !== 'http://replay.invalid/v1/chat/completions') throw new Error(`Inline Jev trial blocked request: ${url}`);
				const body = JSON.parse(init.body);
				trialRequests.push({ caseId: trialCase?.id ?? null, classifier: Boolean(body.response_format) });
				return Response.json({ id: `inline_jev_fake_${trialRequests.length}`, model: body.model,
					choices: [{ message: { role: 'assistant', content: body.response_format
						? JSON.stringify({ update: {}, dueEventFeedback: [] }) : trialCase?.narration ?? '' }, finish_reason: 'stop' }],
					usage: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0001 } });
			};
			const promiseUpdate = { agreements: [{ action: 'create', category: 'promise', parties: ['Mara', 'Ilan'],
				terms: 'Mara promises to bring Ilan the ledger tomorrow.' }] };
			const cases = [
				{ id: 'made_promise', quote: 'Mara tells Ilan, "I promise to bring you the ledger tomorrow." Ilan accepts her promise.',
					playerText: 'I listen to Mara.', update: promiseUpdate },
				{ id: 'unaccepted_offer', quote: 'Mara asks Ilan, "Would you like me to bring the ledger tomorrow?" Ilan says he will decide later.',
					playerText: 'I wait for Mara to offer help.', update: promiseUpdate },
			];
			const trialTurns = [];
			for (const [index, candidate] of cases.entries()) {
				const beforeDecisions = trialDecisions.length;
				const beforeRequests = trialRequests.length;
				const previous = process.env.MTHERIOS_INLINE_TURN_MEMORY;
				let turn;
				try {
					process.env.MTHERIOS_INLINE_TURN_MEMORY = '1';
					trialCase = { ...candidate, narration: `[Great Hall]\n${candidate.quote}<turn_memory_update>${JSON.stringify({ version: 1,
						changes: [{ kind: 'event', quote: candidate.quote, visibility: 'player_known', update: candidate.update }] })}</turn_memory_update>` };
					turn = await executeTurnSubmitCommand({ storyId: trialStoryId, clientTurnId: `inline_jev_${candidate.id}`,
						playerText: candidate.playerText, actionType: 'do', localVersion: index,
						clientContext: { deferStateExtraction: false, chapterThreshold: 200, postChapterBuffer: 100 } });
				} finally {
					trialCase = null;
					if (previous === undefined) delete process.env.MTHERIOS_INLINE_TURN_MEMORY;
					else process.env.MTHERIOS_INLINE_TURN_MEMORY = previous;
				}
				assert.equal(trialDecisions.length, beforeDecisions + 1, `Inline ${candidate.id} did not make exactly one Jev request`);
				const [entry] = await db.execute(sql`select content, metadata from story_entries where story_id=${trialStoryId} and id=${turn.assistantEntryId}`);
				assert.equal(entry?.content, `[Great Hall]\n${candidate.quote}`, `Inline ${candidate.id} saved its footer`);
				const accepted = entry?.metadata?.turnMemory?.accepted === true;
				const classifierRequests = trialRequests.slice(beforeRequests).filter(request => request.classifier).length;
				assert.equal(classifierRequests, accepted ? 0 : 1, `Inline ${candidate.id} classifier fallback disagrees with the saved verdict`);
				const agreements = await db.select().from(schema.agreements).where(eq(schema.agreements.storyId, trialStoryId));
				const applied = agreements.some(row => row.sourceEntryIds.includes(turn.assistantEntryId) && row.status === 'active');
				assert.equal(applied, accepted, `Inline ${candidate.id} agreement write disagrees with the saved verdict`);
				if (candidate.id === 'unaccepted_offer') assert(!accepted, 'Real Jev accepted an unaccepted offer');
				trialTurns.push({ id: candidate.id, accepted, classifierRequests, agreementApplied: applied });
			}
			results.push({ id: 'jev-inline-trial-001', passed: true, turns: trialTurns, decisions: trialDecisions,
				providerSpendUsd, realProviderCalls: trialDecisions.length });
			console.log('PASS jev-inline-trial-001: real Jev verdicts through disposable canonical turns');
		}
	}
	const directory = resolve(root, 'evals/replay/results');
	await mkdir(directory, { recursive: true });
	const report = { createdAt: new Date().toISOString(), mode: values['jev-inline-trial'] ? 'jev-inline-trial' : values['jev-review-trial'] ? 'jev-review-trial' : modelConfig ? values['prose-only'] ? 'model-prose-synthetic-classifier' : 'model' : 'deterministic', model: modelConfig?.model ?? (values['jev-inline-trial'] ? 'typesafe/jev-1.13' : null), provider: modelConfig?.provider ?? (values['jev-inline-trial'] ? 'openrouter' : null), mutation: values.mutation, roll: values.roll, agentLoop: values['agent-loop'], piOnly: values['pi-only'],
		providerSpend: { capUsd: spendCapUsd, reportedUsd: modelConfig || values['jev-inline-trial'] ? providerSpendUsd : 0, enforcement: modelConfig || values['jev-inline-trial'] ? 'pre-request remaining-spend guard, one Jev attempt per trial turn, and stop when reported usage reaches cap' : 'no provider calls' },
		build: await harnessBuildId(root, replaySources),
		note: 'Real prompt, provider parsing, extraction validation, canonical writes and idempotency on a synthetic fixture. Deterministic mode uses fake output; opt-in model mode uses only the explicitly requested model/key. Phrase detectors are narrow, not general narrative or knowledge-quality evaluation. No live database/settings or workers used.',
		sourceHashes: Object.fromEntries(await Promise.all(replaySources.map(async (file) => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')]))), results };
	const reportPath = resolve(directory, `${report.createdAt.replace(/[:.]/g, '-')}.json`);
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
	console.log(`Report: ${reportPath}`);
	if (results.some((result) => !result.passed)) process.exitCode = 1;
} finally {
	globalThis.fetch = originalFetch;
	try { await client?.closeDb(); } finally {
		try { await vite?.close(); } finally {
			if (containerId) {
				const target = JSON.parse(docker('inspect', containerId))[0];
				assert.equal(target.Name, `/${containerName}`);
				assert.equal(target.Config.Labels['mtherios.turn-replay'], runId);
				docker('stop', '--time', '2', containerId);
			}
			assert(scratch.startsWith(`${resolve(tmpdir())}${sep}`) && basename(scratch).startsWith('mtherios-turn-replay-'));
			await rm(scratch, { recursive: true, force: true });
			console.log('Disposable replay database/config/data/vault removed.');
		}
	}
}
