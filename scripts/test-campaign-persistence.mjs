import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import { createServer } from 'vite';
import { harnessBuildId } from './harness-build-id.mjs';

// Deliberately no URL option: every write must use the container created here.
const root = resolve(import.meta.dirname, '..');
const runId = randomUUID();
const containerName = `mtherios-persistence-test-${runId}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
let containerId, vite, client;
const originalFetch = globalThis.fetch;
const checks = [];
try {
	globalThis.fetch = async () => { throw new Error('Persistence tests must not call model or projection services'); };
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', containerName,
		'--label', `mtherios.persistence-test=${runId}`, '--tmpfs', '/var/lib/postgresql/data',
		'-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=source',
		'-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	assert.match(containerId, /^[a-f0-9]{64}$/);
	const inspect = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspect.Config.Labels['mtherios.persistence-test'], runId);
	const port = inspect.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	const databaseUrl = (name) => `postgres://fixture:fixture@127.0.0.1:${port.HostPort}/${name}`;
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'fixture', '-d', 'source'); ready = true; break; }
		catch { await delay(250); }
	}
	assert(ready, 'Disposable database did not become ready');
	docker('exec', containerId, 'createdb', '-U', 'fixture', 'target');
	Object.assign(process.env, {
		MEMORY_EMBEDDING_PROVIDER: '', MEMORY_EMBEDDING_API_KEY: '', MEMORY_IMPORT_ENTRY_LIMIT: '2',
	});
	for (const name of ['source', 'target']) {
		process.env.DATABASE_URL = databaseUrl(name);
		execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
	}
	process.env.DATABASE_URL = databaseUrl('source');
	vite = await createServer({
		root, configFile: false, envFile: false, appType: 'custom',
		server: { middlewareMode: true, hmr: false, watch: null },
		resolve: { alias: { $lib: resolve(root, 'src/lib') } },
		plugins: [{ name: 'persistence-test-env',
			resolveId: (id) => id === '$env/dynamic/private' ? '\0persistence-test-env' : undefined,
			load: (id) => id === '\0persistence-test-env' ? 'export const env = process.env;' : undefined,
		}],
	});
	const load = (path) => vite.ssrLoadModule(`/src/lib/${path}.ts`);
	client = await load('server/db/client');
	const schema = await load('server/db/schema');
	const { exportBackendStory, importIndexedDbBundle } = await load('server/memory/canonical');
	const { importWorldDatabaseBundle } = await load('server/db/worldDatabaseImport');
	const { parseStoryExportBundle } = await load('contracts/worldDatabase');
	const { getServerMemoryConfig } = await load('server/env');
	const { generateServerTextWithMetrics } = await load('server/turn/provider');
	const { parseStateExtractionResult } = await load('server/turn/orchestrator');
	assert.equal(getServerMemoryConfig().databaseUrl, databaseUrl('source'));
	const cancellationFetch = globalThis.fetch;
	let providerAbortObserved = false;
	globalThis.fetch = async (_input, init = {}) => new Promise((_, reject) => {
		const signal = init.signal;
		const onAbort = () => {
			providerAbortObserved = true;
			reject(signal?.reason ?? new Error('fixture cancellation'));
		};
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
	});
	try {
		const controller = new AbortController();
		const pendingGeneration = generateServerTextWithMetrics({
			profile: { providerType: 'openai', apiKey: 'fixture-key' },
			model: 'fixture-model',
			system: 'Fixture cancellation rules.',
			prompt: 'Cancel this provider request.',
			maxRetries: 0,
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		await delay(20);
		controller.abort(new Error('fixture cancellation'));
		await assert.rejects(pendingGeneration, /fixture cancellation/i);
		assert.equal(providerAbortObserved, true, 'Provider fetch did not receive cancellation');
	} finally {
		globalThis.fetch = cancellationFetch;
	}
	checks.push('Cancelled provider generation aborts in-flight I/O and rejects without a retry or model call');
	assert.throws(() => parseStateExtractionResult('{"update":{"characters":"not-an-array"}}'), /invalid state extraction response/i);
	checks.push('Malformed state extraction output is rejected at the schema boundary before canonical application');
	let db = client.getDb();
	const storyId = 'fixture_campaign';
	await db.insert(schema.stories).values([{ id: storyId, title: 'Persistence fixture', serverVersion: 7 }, { id: 'foreign_story', title: 'Excluded' }]);
	await db.insert(schema.storyEntries).values([
		{ id: 'entry_b', storyId, type: 'assistant_narrative', content: 'Mara accepts the promise.', position: 2, parentId: 'entry_a' },
		{ id: 'entry_a', storyId, type: 'user_action', content: 'I promise to keep her secret.', position: 1 },
		{ id: 'foreign_entry', storyId: 'foreign_story', type: 'system', content: 'Do not export this', position: 0 },
	]);
	await db.insert(schema.entities).values([
		{ id: 'mara', storyId, type: 'character', name: 'Mara', state: { knowledge: ['The postern is open'], appearance: 'Green cloak' }, sourceEntryIds: ['entry_b'] },
		{ id: 'player', storyId, type: 'character', name: 'Player', state: { role: 'player' }, sourceEntryIds: ['entry_a'] },
	]);
	await db.insert(schema.entityAliases).values({ id: 'alias_mara', storyId, entityId: 'mara', alias: 'Green Cloak', normalizedAlias: 'green cloak', sourceEntryIds: ['entry_b'] });
	await db.insert(schema.relationships).values({ id: 'trust', storyId, sourceEntityId: 'mara', targetEntityId: 'player', type: 'trust', label: 'Kept the promise', sourceEntryIds: ['entry_b'], metadata: { reason: 'Protected her secret' } });
	await db.insert(schema.storyEvents).values({ id: 'event_promise', storyId, type: 'promise', title: 'Promise kept', body: 'Mara accepts the promise.', actorEntityIds: ['mara'], targetEntityIds: ['player'], sourceEntryIds: ['entry_b'] });
	await db.insert(schema.statePatches).values({ id: 'patch_trust', storyId, status: 'applied', operations: [{ op: 'replace', path: '/entities/mara/state/trust', value: 1 }], sourceEntryIds: ['entry_b'], sourceEventIds: ['event_promise'] });
	await db.insert(schema.facts).values({ id: 'fact_secret', storyId, subjectEntityId: 'mara', title: 'Postern', statement: 'The postern is open', firstSeenEntryId: 'entry_b', sourceEntryIds: ['entry_b'], sourceEventIds: ['event_promise'], sourcePatchIds: ['patch_trust'] });
	await db.insert(schema.sourceRefs).values({ id: 'ref_secret', storyId, sourceType: 'story_entry', sourceId: 'entry_b', targetTable: 'facts', targetRecordId: 'fact_secret', targetRecordField: 'statement', rationale: 'Explicit evidence' });
	await db.insert(schema.npcEventLinks).values({ id: 'link_mara', storyId, eventId: 'event_promise', npcEntityId: 'mara', sourceEntryIds: ['entry_b'] });
	await db.insert(schema.agreements).values({ id: 'promise', storyId, parties: ['mara', 'player'], category: 'promise', terms: 'Keep the postern secret', sourceEntryIds: ['entry_a'] });
	await db.insert(schema.chapters).values({ id: 'chapter_promise', storyId, number: 1, title: 'The promise', sceneOutcome: 'Trust earned', sourceEntryIds: ['entry_a', 'entry_b'], sourceEventIds: ['event_promise'] });
	await db.insert(schema.arcs).values({ id: 'arc_trust', storyId, number: 1, title: 'Trust', summary: 'Mara trusts the player', chapterIds: ['chapter_promise'], metadata: { characterArcs: [{ name: 'Mara', development: 'Learned to trust', sourceChapterIds: ['chapter_promise'], sourceEntryIds: ['entry_b'], sourceEventIds: ['event_promise'] }] } });

	// Cross the same JSON/validation boundary as the browser download.
	const bundle = parseStoryExportBundle(JSON.parse(JSON.stringify(await exportBackendStory(storyId))));
	assert.equal(bundle.version, 3);
	assert.deepEqual(bundle.storyEntries.map((row) => row.id), ['entry_a', 'entry_b']);
	assert.equal(bundle.story.serverVersion, 7);
	assert(!JSON.stringify(bundle).includes('foreign_entry'));

	await client.closeDb();
	process.env.DATABASE_URL = databaseUrl('target');
	const preserved = await importWorldDatabaseBundle({ bundle, options: { preserveIds: true, replaceExisting: false, syncWiki: false,
		sourceProjectId: bundle.shelf.id, destinationProjectId: bundle.shelf.id } });
	assert.equal(preserved.storyId, storyId);
	const restored = await exportBackendStory(preserved.storyId);
	for (const table of ['entries', 'entities', 'entityAliases', 'relationships', 'events', 'statePatches', 'facts', 'sourceRefs', 'npcEventLinks', 'agreements', 'chapters', 'arcs']) {
		assert.deepEqual(restored.worldDatabase[table], bundle.worldDatabase[table], `Preserved-ID round trip changed ${table}`);
	}
	checks.push('Current-format export and preserved-ID import into a separate database retain transcript, canon and source links');

	const copied = await importWorldDatabaseBundle({ bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	assert.notEqual(copied.storyId, storyId);
	const copy = (await exportBackendStory(copied.storyId)).worldDatabase;
	// The existing import result returns storyId/counts, not a record mapping.
	// Infer a test-only mapping from unique fixture content, then check every link.
	const mapped = new Map([[storyId, copied.storyId]]);
	for (const [table, key] of [['entries', 'content'], ['entities', 'name'], ['events', 'title'], ['facts', 'statement'], ['statePatches', 'reason'], ['chapters', 'title']]) {
		for (const original of bundle.worldDatabase[table]) {
			const row = copy[table].find((candidate) => candidate[key] === original[key]);
			assert(row, `Missing copied ${table}: ${original.id}`);
			assert.notEqual(row.id, original.id);
			mapped.set(original.id, row.id);
		}
	}
	assert.deepEqual(copy.entries.map((row) => row.position), [1, 2]);
	assert.equal(copy.entries[1].parentId, mapped.get('entry_a'));
	assert.equal(copy.relationships[0].sourceEntityId, mapped.get('mara'));
	assert.equal(copy.relationships[0].targetEntityId, mapped.get('player'));
	assert.deepEqual(copy.relationships[0].sourceEntryIds, [mapped.get('entry_b')]);
	assert.deepEqual(copy.entities.find((row) => row.id === mapped.get('mara')).state, bundle.worldDatabase.entities.find((row) => row.id === 'mara').state);
	assert.equal(copy.entityAliases[0].entityId, mapped.get('mara'));
	assert.equal(copy.facts[0].subjectEntityId, mapped.get('mara'));
	assert.deepEqual(copy.facts[0].sourcePatchIds, [mapped.get('patch_trust')]);
	assert.equal(copy.sourceRefs[0].sourceId, mapped.get('entry_b'));
	assert.equal(copy.sourceRefs[0].targetRecordId, mapped.get('fact_secret'));
	assert.equal(copy.npcEventLinks[0].eventId, mapped.get('event_promise'));
	assert.equal(copy.npcEventLinks[0].npcEntityId, mapped.get('mara'));
	assert.deepEqual(copy.agreements[0].parties, [mapped.get('mara'), mapped.get('player')]);
	assert.deepEqual(copy.arcs[0].metadata.characterArcs[0], { name: 'Mara', development: 'Learned to trust', sourceChapterIds: [mapped.get('chapter_promise')], sourceEntryIds: [mapped.get('entry_b')], sourceEventIds: [mapped.get('event_promise')] });
	checks.push('Separate-copy import remaps identities consistently across relationships and evidence');

	db = client.getDb();
	const entries = [0, 1].map((position) => ({ id: `legacy_entry_${position}`, type: 'system', content: `Legacy ${position}`, position }));
	const atLimit = await importIndexedDbBundle({ bundle: { story: { id: 'legacy_at_limit', title: 'At limit' }, storyEntries: entries } });
	assert.equal(atLimit.counts.entries, 2);
	assert.deepEqual((await exportBackendStory(atLimit.storyId)).storyEntries.map((row) => row.id), entries.map((row) => row.id));
	const jobsBefore = await db.select().from(schema.backendJobs);
	await assert.rejects(importIndexedDbBundle({ bundle: { story: { id: 'legacy_oversize', title: 'Too large' }, storyEntries: [...entries, { id: 'legacy_tail', content: 'Do not lose me', position: 2 }] } }), /3 transcript entries; the limit is 2/);
	assert.equal((await db.select().from(schema.stories).where(eq(schema.stories.id, 'legacy_oversize'))).length, 0);
	assert.equal((await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.storyId, 'legacy_oversize'))).length, 0);
	assert.deepEqual(await db.select().from(schema.backendJobs), jobsBefore);
	checks.push('Legacy limit imports the final entry; limit-plus-one creates no story, transcript rows or jobs');

	// Pause the real export immediately after its first SELECT, commit a writer
	// through another pooled connection, then let all remaining real reads run.
	const originalTransaction = db.transaction.bind(db);
	async function interleavedExport(isolationOverride) {
		let interleaved = false;
		await db.delete(schema.entities).where(eq(schema.entities.id, 'new_snapshot_entity'));
		await db.update(schema.stories).set({ serverVersion: 7 }).where(eq(schema.stories.id, storyId));
		db.transaction = (callback, options) => originalTransaction(async (tx) => {
			const select = tx.select.bind(tx);
			tx.select = (...args) => {
				const builder = select(...args);
				const from = builder.from.bind(builder);
				builder.from = (table) => {
					const query = from(table);
					if (table === schema.stories) {
						const execute = query.execute.bind(query);
						query.execute = async (...parameters) => {
							const rows = await execute(...parameters);
							assert.equal(interleaved, false);
							await originalTransaction(async (writer) => {
								await writer.insert(schema.entities).values({ id: 'new_snapshot_entity', storyId, type: 'character', name: 'New snapshot', serverVersion: 8 });
								await writer.update(schema.stories).set({ serverVersion: 8 }).where(eq(schema.stories.id, storyId));
							});
							interleaved = true;
							return rows;
						};
					}
					return query;
				};
				return builder;
			};
			return callback(tx);
		}, isolationOverride ? { ...options, isolationLevel: isolationOverride } : options);
		try {
			const result = await exportBackendStory(storyId);
			assert(interleaved, 'Concurrent writer was not exercised');
			return result;
		} finally { db.transaction = originalTransaction; }
	}
	const mixed = await interleavedExport('read committed');
	assert.equal(mixed.story.serverVersion, 7);
	assert(mixed.worldDatabase.entities.some((row) => row.id === 'new_snapshot_entity'), 'Negative control did not detect mixed snapshots');
	const consistent = await interleavedExport();
	assert.equal(consistent.story.serverVersion, 7);
	assert(!consistent.worldDatabase.entities.some((row) => row.id === 'new_snapshot_entity'));
	assert.equal((await db.select().from(schema.stories).where(eq(schema.stories.id, storyId)))[0].serverVersion, 8);
	checks.push('Concurrent export stays on one committed snapshot; read-committed negative control detects the defect');

	const { retryBackendJob, markBackendJobFailed, backendJobFailureIsRetryable } = await load('server/jobs/outbox');
	const { runBackendJobNow } = await load('server/jobs/processor');
	const { listBackendJobsCommand } = await load('server/engine/serviceCommands');
	const readJob = async (jobId) => (await db.select().from(schema.backendJobs).where(eq(schema.backendJobs.id, jobId)))[0];
	const receipt = { assistantEntryId: 'entry_b', serverVersion: 7, operationCount: 1, eventIds: ['event_promise'], patchIds: ['patch_trust'], memoryNodeIds: [], appliedAt: '2026-09-05T21:00:00Z' };
	await db.insert(schema.backendJobs).values({ id: 'failed_extraction', storyId, type: 'extract_turn_state', status: 'failed', attemptCount: 1, maxAttempts: 1, lastError: 'Failed after apply', payload: { assistantEntryId: 'entry_b' }, metadata: { deferredExtractionApplyReceipt: receipt, customProgress: { keep: true } }, updatedAt: '2000-01-01T00:00:00Z' });
	await db.insert(schema.backendJobs).values(Array.from({ length: 101 }, (_, index) => ({ id: `recent_complete_${index}`, storyId, type: 'index_canonical_records', status: 'complete' })));
	const failures = await listBackendJobsCommand({ storyId, limit: 1, allStories: false, status: 'failed' });
	assert.equal(failures.jobs[0].id, 'failed_extraction', 'Old failed jobs must be filtered before the page limit');
	assert.equal(failures.jobs[0].retryAllowed, true);
	const observed = await readJob('failed_extraction');
	const request = { storyId, jobId: observed.id, expectedUpdatedAt: observed.updatedAt };
	const attempts = await Promise.allSettled([retryBackendJob(request), retryBackendJob(request)]);
	assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
	const queued = await readJob(observed.id);
	assert.deepEqual(queued.payload, observed.payload);
	assert.deepEqual(queued.metadata.deferredExtractionApplyReceipt, receipt);
	assert.deepEqual(queued.metadata.customProgress, { keep: true });
	assert.equal(queued.metadata.manualRetryHistory.length, 1);
	assert.equal(queued.metadata.manualRetryHistory[0].error, 'Failed after apply');
	assert.equal(queued.attemptCount, 0);
	assert.equal(queued.maxAttempts, 1);
	const beforeRecovery = (await exportBackendStory(storyId)).worldDatabase;
	const recovered = await runBackendJobNow(observed.id, 'fixture_worker');
	assert.equal(recovered.completed, true);
	assert.equal(recovered.result.status, 'already_applied');
	const afterRecovery = (await exportBackendStory(storyId)).worldDatabase;
	for (const table of ['entities', 'events', 'statePatches', 'facts']) assert.deepEqual(afterRecovery[table], beforeRecovery[table]);
	await assert.rejects(retryBackendJob({ ...request, expectedUpdatedAt: (await readJob(observed.id)).updatedAt }), /Refresh Jobs/);
	// Replaying an old request must still fail if the same job fails again later.
	await db.update(schema.backendJobs).set({ status: 'failed' }).where(eq(schema.backendJobs.id, observed.id));
	await assert.rejects(retryBackendJob(request), /Refresh Jobs/);
	await assert.rejects(retryBackendJob({ ...request, storyId: 'foreign_story', expectedUpdatedAt: (await readJob(observed.id)).updatedAt }), /Refresh Jobs/);
	await db.insert(schema.backendJobs).values({ id: 'unsupported_retry', storyId, type: 'plan_plot_brain', status: 'failed' });
	await assert.rejects(retryBackendJob({ storyId, jobId: 'unsupported_retry', expectedUpdatedAt: (await readJob('unsupported_retry')).updatedAt }), /Refresh Jobs/);
	checks.push('One competing retry wins; source scope, stale versions and unsupported types are rejected; applied extraction does not duplicate canon');

	async function failOnceAfterWrite(table, operation, work) {
		const original = db[operation].bind(db);
		let injected = false;
		db[operation] = (target) => {
			const builder = original(target);
			if (target !== table) return builder;
			const method = operation === 'insert' ? 'values' : 'set';
			const build = builder[method].bind(builder);
			builder[method] = (...values) => {
				const query = build(...values);
				const execute = query.execute.bind(query);
				query.execute = async (...parameters) => {
					const result = await execute(...parameters);
					if (!injected) { injected = true; throw new Error('Fixture interruption after a committed side effect'); }
					return result;
				};
				return query;
			};
			return builder;
		};
		try { const result = await work(); assert(injected, 'Partial-write failure was not exercised'); return result; }
		finally { db[operation] = original; }
	}
	await db.insert(schema.storyEvents).values({ id: 'event_second', storyId, type: 'promise', title: 'Another promise', body: 'The player will return tomorrow.', sourceEntryIds: ['entry_b'] });
	for (const type of ['create_memory_nodes_from_events', 'rebuild_retrieval_projection']) {
		await db.delete(schema.memoryNodes).where(eq(schema.memoryNodes.storyId, storyId));
		const jobId = `partial_${type}`;
		await db.insert(schema.backendJobs).values({ id: jobId, storyId, type, payload: { eventIds: ['event_promise', 'event_second'] }, maxAttempts: 1, runAfter: '2000-01-01T00:00:00Z' });
		const failed = await failOnceAfterWrite(schema.memoryNodes, 'insert', () => runBackendJobNow(jobId, 'fixture_worker'));
		assert.equal(failed.completed, false);
		assert.equal((await db.select().from(schema.memoryNodes).where(eq(schema.memoryNodes.storyId, storyId))).length, 1);
		const job = await readJob(jobId);
		assert.equal(job.status, 'failed');
		assert.equal(job.metadata.lastFailure.kind, 'attempts_exhausted');
		await retryBackendJob({ storyId, jobId, expectedUpdatedAt: job.updatedAt });
		assert.equal((await runBackendJobNow(jobId, 'fixture_worker')).completed, true);
		const nodes = await db.select().from(schema.memoryNodes).where(eq(schema.memoryNodes.storyId, storyId));
		assert.equal(nodes.length, 2, `${type} duplicated or lost a derived record`);
		assert.deepEqual(new Set(nodes.flatMap((node) => node.sourceEventIds)), new Set(['event_promise', 'event_second']));
	}
	Object.assign(process.env, { MEMORY_EMBEDDING_PROVIDER: 'local-hash', MEMORY_EMBEDDING_MODEL: 'local-hash-768', MEMORY_EMBEDDING_DIMENSIONS: '768', MEMORY_EMBEDDING_BATCH: '1' });
	await db.insert(schema.backendJobs).values({ id: 'partial_embedding', storyId, type: 'embed_memory_nodes', maxAttempts: 1, runAfter: '2000-01-01T00:00:00Z' });
	const embeddingFailure = await failOnceAfterWrite(schema.memoryNodes, 'update', () => runBackendJobNow('partial_embedding', 'fixture_worker'));
	assert.equal(embeddingFailure.completed, false);
	const embeddingJob = await readJob('partial_embedding');
	assert.equal((await db.select().from(schema.memoryNodes).where(eq(schema.memoryNodes.storyId, storyId))).filter((node) => node.embedding).length, 1);
	await retryBackendJob({ storyId, jobId: embeddingJob.id, expectedUpdatedAt: embeddingJob.updatedAt });
	assert.equal((await runBackendJobNow(embeddingJob.id, 'fixture_worker')).completed, true);
	const embedded = await db.select().from(schema.memoryNodes).where(eq(schema.memoryNodes.storyId, storyId));
	assert.equal(embedded.length, 2);
	assert(embedded.every((node) => node.embedding?.length === 768));
	checks.push('Both event-memory handlers and embedding updates recover after a committed partial write without duplicate projections');

	await db.insert(schema.backendJobs).values({ id: 'classified_failure', storyId, type: 'extract_turn_state', status: 'running', attemptCount: 1, maxAttempts: 5, lockedAt: '2026-09-05T21:00:00Z', lockedBy: 'fixture_worker', metadata: { deferredExtractionApplyReceipt: receipt } });
	await markBackendJobFailed(await readJob('classified_failure'), Object.assign(new Error('Invalid structured output'), { retryable: false }));
	const classified = await readJob('classified_failure');
	assert.equal(classified.status, 'failed');
	assert.equal(classified.metadata.lastFailure.kind, 'non_retryable');
	assert.deepEqual(classified.metadata.deferredExtractionApplyReceipt, receipt);
	assert.equal(backendJobFailureIsRetryable(new Error('Server LLM request failed (402): Insufficient Balance')), false);
	assert.equal(backendJobFailureIsRetryable(new Error('Classifier returned an invalid state extraction response.')), false);
	checks.push('Permanent provider-account and invalid-output failures are not automatically rescheduled');

	// Exercise full-history retrieval through PostgreSQL, outside the recent page.
	Object.assign(process.env, { MEMORY_EMBEDDING_PROVIDER: '', MEMORY_EMBEDDING_MODEL: '' });
	const { retrieveMemoryPacket } = await load('server/memory/retrieval');
	const recallStory = 'historical_recall_fixture';
	await db.insert(schema.stories).values({ id: recallStory, title: 'Historical recall' });
	const recallRows = Array.from({ length: 800 }, (_, index) => ({ id: `recall_${index}`, storyId: recallStory, type: 'narration', content: `Unrelated weather and passing clouds ${index}.`, position: index, metadata: {}, parentId: null }));
	recallRows[0].content = 'The permit was placed beneath the cedar chest.';
	recallRows[1].content = 'The ruby was hidden inside the blue vase.';
	recallRows[2].content = 'The opal is inside the brass urn.';
	recallRows[3].content = 'The sapphire was placed inside the oak cabinet.';
	for (let index = 10; index < 101; index++) {
		recallRows[index].content = `The ruby ruby ruby ruby ruby is secretly under the black stair ${index}.`;
		recallRows[index].metadata = { visibility: 'secret' };
	}
	for (let index = 110; index < 292; index += 2) {
		recallRows[index].type = 'user_action';
		recallRows[index].content = 'OOC: change the story tone.';
		recallRows[index + 1].content = `The opal opal opal opal opal is under the red stair ${index}.`;
		recallRows[index + 1].parentId = recallRows[index].id;
	}
	for (let index = 310; index < 401; index++) {
		recallRows[index].content = `The sapphire sapphire sapphire sapphire is on the silver shelf ${index}.`;
		recallRows[index].metadata = { non_canon: true };
	}
	recallRows[402].type = 'user_action';
	recallRows[402].content = '/pov Mara';
	recallRows[403].content = 'Mara sees the emerald inside the copper bowl.';
	recallRows[403].parentId = recallRows[402].id;
	// A safe answer immediately after an excluded narration must not reload
	// that narration as a "parent" candidate without its original OOC parent.
	recallRows[500].type = 'user_action';
	recallRows[500].content = 'OOC: reset the tone.';
	recallRows[501].content = 'The diamond is under the wrong staircase.';
	recallRows[501].parentId = recallRows[500].id;
	recallRows[502].content = 'The diamond is inside the glass chest.';
	await db.insert(schema.storyEntries).values(recallRows);
	for (const [query, wanted, forbidden] of [
		['Where are the permits?', 'cedar chest', null],
		['Where is the ruby?', 'blue vase', 'black stair'],
		['Where is the opal?', 'brass urn', 'red stair'],
		['Where is the sapphire?', 'oak cabinet', 'silver shelf'],
		['Where is the emerald?', 'copper bowl', null],
		['Where is the diamond?', 'glass chest', 'wrong staircase'],
	]) {
		const packet = await retrieveMemoryPacket({ storyId: recallStory, query, tokenBudget: 1200 });
		assert(packet.packet.includes(wanted), `Historical query lost its answer: ${query}`);
		if (forbidden) assert(!packet.packet.includes(forbidden), `Historical query included an excluded source: ${query}`);
	}
	const embeddingEnvKeys = ['MEMORY_EMBEDDING_PROVIDER', 'MEMORY_EMBEDDING_MODEL', 'MEMORY_EMBEDDING_BASE_URL', 'MEMORY_EMBEDDING_API_KEY', 'MEMORY_EMBEDDING_DIMENSIONS'];
	const previousEmbeddingEnv = Object.fromEntries(embeddingEnvKeys.map((key) => [key, process.env[key]]));
	const outageFetch = globalThis.fetch;
	Object.assign(process.env, {
		MEMORY_EMBEDDING_PROVIDER: 'openai-compatible',
		MEMORY_EMBEDDING_MODEL: 'fixture-embedding',
		MEMORY_EMBEDDING_BASE_URL: 'http://fixture-embedding',
		MEMORY_EMBEDDING_API_KEY: 'fixture-key',
		MEMORY_EMBEDDING_DIMENSIONS: '3',
	});
	globalThis.fetch = async () => { throw new Error('fixture embedding outage'); };
	try {
		const degraded = await retrieveMemoryPacket({ storyId: recallStory, query: 'Where are the permits?', tokenBudget: 1200 });
		assert(degraded.packet.includes('cedar chest'), 'Lexical evidence was lost during embedding outage');
		assert(degraded.retrievalDebug.some((line) => line.includes('Vector memory: unavailable')),
			'Embedding outage was not recorded as a degraded optional source');
	} finally {
		globalThis.fetch = outageFetch;
		for (const key of embeddingEnvKeys) {
			if (previousEmbeddingEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEmbeddingEnv[key];
		}
	}
	checks.push('Embedding outage preserves lexical evidence and records the optional vector source as unavailable');
	checks.push('Historical search retains stemmed matches and filters secret/noncanon/OOC parents before the page limit; narrative slash-command output remains eligible');

	// Relevance must be applied in SQL, before 80 unrelated recent agreements
	// can hide a much older promise to the returning actor or a due obligation.
	const { loadTurnContext, TURN_CONTEXT_AGREEMENT_LIMIT } = await load('server/turn/context');
	const agreementStory = 'agreement_relevance_fixture';
	await db.insert(schema.stories).values({ id: agreementStory, title: 'Agreement relevance', currentTurn: 10 });
	await db.insert(schema.entities).values([
		{ id: 'agreement_player', storyId: agreementStory, type: 'character', name: 'Player', state: { isProtagonist: true, present: true } },
		{ id: 'agreement_mara', storyId: agreementStory, type: 'character', name: 'Mara', state: {} },
	]);
	await db.insert(schema.entityAliases).values({ id: 'agreement_alias', storyId: agreementStory, entityId: 'agreement_mara', alias: 'Green Cloak', normalizedAlias: 'green cloak' });
	await db.insert(schema.storyEntries).values({ id: 'agreement_scene', storyId: agreementStory, type: 'narration', content: 'Green Cloak stands beside you at the river.', position: 0 });
	await db.insert(schema.storyEvents).values([
		{ id: 'agreement_due', storyId: agreementStory, type: 'promise', status: 'scheduled', scheduledTurn: 10, title: 'Due', body: 'An obligation is due.' },
		{ id: 'agreement_future', storyId: agreementStory, type: 'promise', status: 'scheduled', scheduledTurn: 11, title: 'Future', body: 'An obligation is later.' },
		{ id: 'agreement_foreign', storyId: recallStory, type: 'promise', status: 'due', title: 'Foreign', body: 'Another story obligation.' },
	]);
	const old = '2000-01-01T00:00:00Z';
	await db.insert(schema.agreements).values([
		...Array.from({ length: 95 }, (_, index) => ({ id: `agreement_recent_${String(index).padStart(3, '0')}`, storyId: agreementStory, parties: ['agreement_player', `unrelated_${index}`], category: 'promise', terms: 'An unrelated debt.', updatedAt: `2026-09-05T21:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}Z` })),
		...['agreement_mara', 'Mara', 'GREEN-CLOAK'].map((party, index) => ({ id: `agreement_old_actor_${index}`, storyId: agreementStory, parties: ['agreement_player', party], category: 'promise', terms: 'Preserve the old compact.', updatedAt: old })),
		{ id: 'agreement_old_action', storyId: agreementStory, category: 'promise', terms: 'The permit is inside the cedar chest.', updatedAt: old },
		{ id: 'agreement_old_due', storyId: agreementStory, category: 'promise', terms: 'An obligation.', sourceEventIds: ['agreement_due'], updatedAt: old },
		{ id: 'agreement_old_future', storyId: agreementStory, category: 'promise', terms: 'An obligation.', sourceEventIds: ['agreement_future'], updatedAt: old },
		{ id: 'agreement_wrong_story_due', storyId: agreementStory, category: 'promise', terms: 'An obligation.', sourceEventIds: ['agreement_foreign'], updatedAt: old },
		{ id: 'agreement_old_fulfilled', storyId: agreementStory, parties: ['Mara'], category: 'promise', terms: 'The permits.', status: 'fulfilled', updatedAt: old },
	]);
	const context = await loadTurnContext(agreementStory, [], [], 'Ask about the permits.');
	assert.equal(context.agreements.length, TURN_CONTEXT_AGREEMENT_LIMIT);
	const agreementIds = context.agreements.map((row) => row.id);
	for (const expected of ['agreement_old_actor_0', 'agreement_old_actor_1', 'agreement_old_actor_2', 'agreement_old_action', 'agreement_old_due']) assert(agreementIds.includes(expected), `Bounded query lost relevant agreement ${expected}`);
	for (const excluded of ['agreement_old_future', 'agreement_wrong_story_due', 'agreement_old_fulfilled']) assert(!agreementIds.includes(excluded), `Agreement relevance included ${excluded}`);
	assert.deepEqual(agreementIds.slice(0, 5), ['agreement_old_actor_0', 'agreement_old_actor_1', 'agreement_old_actor_2', 'agreement_old_due', 'agreement_old_action']);
	assert.equal(agreementIds[5], 'agreement_recent_094');
	const repeated = await loadTurnContext(agreementStory, [], [], 'Ask about the permits.');
	assert.deepEqual(repeated.agreements.map((row) => row.id), agreementIds);
	checks.push('Agreement relevance ranks canonical IDs, names, aliases, stemmed action and due sources before limit 80; unrelated protagonist promises and future/foreign/fulfilled obligations do not crowd out older relevant rows');
	// Real SQL acceptance for agreement lifecycle, replay ordering, and historical portability.
	const temporalStory = 'temporal_campaign';
	await db.insert(schema.stories).values({ id: temporalStory, title: 'Temporal memory fixture', currentTurn: 150 });
	await db.insert(schema.storyEntries).values(Array.from({ length: 302 }, (_, position) => ({
		id: `temporal_entry_${position}`, storyId: temporalStory, position,
		type: position % 2 ? 'narration' : 'user_action', content: position === 299 ? 'Mira returns the silver bell.' : 'The campaign continues.',
	})));
	await db.insert(schema.agreements).values([
		{ id: 'temporal_promise', storyId: temporalStory, parties: ['Mira', 'Valen'], category: 'promise', terms: 'Return the silver bell before dawn.', sourceEntryIds: ['temporal_entry_1'] },
		{ id: 'temporal_marriage', storyId: temporalStory, parties: ['Mira', 'Valen'], category: 'marriage', terms: 'The ivory marriage bond.', secrecy: 'secret', sourceEntryIds: ['temporal_entry_1'] },
		{ id: 'temporal_treaty', storyId: temporalStory, parties: ['House Cedar', 'House Pine'], category: 'treaty', terms: 'Keep the northern road open.', sourceEntryIds: ['temporal_entry_1'] },
	]);
	const { applyValidatedTurnUpdate } = await load('server/turn/patchValidator');
	const { worldStateUpdateSchema } = await load('services/ai/tools/schemas');
	const { loadClassifierAgreements } = await load('server/turn/context');
	const applyTemporal = (position, changes) => applyValidatedTurnUpdate({
		storyId: temporalStory, playerEntryId: `temporal_entry_${position - 1}`, assistantEntryId: `temporal_entry_${position}`,
		narration: 'The commitments changed.', update: worldStateUpdateSchema.parse({ agreements: changes }),
		parseWarnings: [], retrievedMemoryIds: [], serverVersion: position, mode: 'supplemental', timelineTurn: Math.floor(position / 2),
	});
	await applyTemporal(299, [{ action: 'fulfill', id: 'temporal_promise' }, { action: 'annul', id: 'temporal_marriage' }, { action: 'update', id: 'temporal_treaty', terms: 'Keep the southern road open.' }]);
	const readAgreements = () => db.select().from(schema.agreements).where(eq(schema.agreements.storyId, temporalStory));
	let temporalRows = await readAgreements();
	assert.equal(temporalRows.find(row => row.id === 'temporal_promise').status, 'fulfilled');
	assert.equal(temporalRows.find(row => row.id === 'temporal_marriage').status, 'annulled');
	assert.equal(temporalRows.find(row => row.id === 'temporal_marriage').secrecy, 'secret');
	assert.equal(temporalRows.find(row => row.id === 'temporal_treaty').terms, 'Keep the southern road open.');
	const historicalEvents = await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, temporalStory));
	assert(historicalEvents.some(event => event.metadata.previousAgreement?.terms === 'Keep the northern road open.'));
	const eventsBefore = historicalEvents.length;
	await applyTemporal(299, [{ action: 'update', id: 'temporal_treaty', terms: 'Duplicate processing changed this.' }]);
	await applyTemporal(3, [{ action: 'update', id: 'temporal_treaty', terms: 'Late job restores obsolete terms.' }, { action: 'create', parties: ['Valen', 'Mira'], category: 'promise', terms: 'Return the silver bell before dawn.' }]);
	assert.deepEqual(await readAgreements(), temporalRows);
	assert.equal((await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, temporalStory))).length, eventsBefore);
	await client.closeDb(); db = client.getDb();
	assert.deepEqual(await readAgreements(), temporalRows);
	const currentContext = await loadTurnContext(temporalStory, [], [], 'What is owed under the silver bell promise and marriage?');
	assert(!currentContext.agreements.some(row => ['temporal_promise', 'temporal_marriage'].includes(row.id)));
	const recall = await retrieveMemoryPacket({ storyId: temporalStory, query: 'silver bell promise', tokenBudget: 2400 });
	assert(recall.packet.includes('historical agreement; no current duty; fulfilled'));
	assert(!recall.packet.includes('ivory marriage'));
	const agreementContext = await loadClassifierAgreements(temporalStory, 'silver bell promise');
	assert(agreementContext.some(row => row.id === 'temporal_promise' && row.status === 'fulfilled'));
	const temporalBundle = parseStoryExportBundle(JSON.parse(JSON.stringify(await exportBackendStory(temporalStory))));
	const temporalCopy = await importWorldDatabaseBundle({ bundle: temporalBundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	const restoredTemporal = (await exportBackendStory(temporalCopy.storyId)).worldDatabase;
	assert.deepEqual(restoredTemporal.agreements.map(row => row.status).sort(), temporalRows.map(row => row.status).sort());
	const copiedTreaty = restoredTemporal.agreements.find(row => row.category === 'treaty');
	const copiedEvent = restoredTemporal.events.find(event => event.metadata.previousAgreement?.category === 'treaty');
	assert.equal(copiedEvent.metadata.agreementId, copiedTreaty.id);
	assert.equal(copiedEvent.metadata.previousAgreement.id, copiedTreaty.id);
	assert.equal(copiedEvent.metadata.currentAgreement.id, copiedTreaty.id);
	assert.equal(copiedEvent.metadata.previousAgreement.terms, 'Keep the northern road open.');
	assert(copiedTreaty.sourceEventIds.includes(copiedEvent.id));
	checks.push('After 150 turns, fulfillment/annulment/revision survive connection restart and remapped-ID export/import; old and repeated jobs cannot revive duties; current prompts exclude resolved obligations and historical recall labels them');
	// Scene continuity remains derived from exact evidence across restarts and source mutations.
	const sceneStory = 'scene_checkpoint_campaign';
	const { refreshSceneCheckpoint } = await load('server/memory/sceneCheckpoint');
	const { buildServerTurnPrompt } = await load('server/turn/promptPacket');
	const { emptyRetrievedMemoryPacket } = await load('server/turn/promptHarness');
	const { enqueueBackendJob } = await load('server/jobs/outbox');
	const { runDueBackendJobs } = await load('server/jobs/processor');
	await db.insert(schema.stories).values({ id: sceneStory, title: 'Long scene', currentTurn: 151, metadata: { retainedSetting: 'untouched' } });
	const sceneRows = Array.from({ length: 302 }, (_, position) => ({
		id: `scene_entry_${position}`, storyId: sceneStory, position, type: position % 2 ? 'narration' : 'user_action',
		parentId: position % 2 ? `scene_entry_${position - 1}` : null,
		content: position % 2 ? `[Time 10:00 | Location Hall] The rain falls beside window ${position}. The fire burns steadily.` : 'I wait beside the window.',
	}));
	sceneRows[3].content = `[Time 10:00 | Location Hall] ${'The hall is quiet. '.repeat(20)}Mara agreed to return the silver bell before dawn. ${'The fire burns steadily. '.repeat(20)}`;
	await db.insert(schema.storyEntries).values(sceneRows);
	await refreshSceneCheckpoint(sceneStory);
	const coldProcess = execFileSync(process.execPath, ['--input-type=module', '-e', `
		import assert from 'node:assert/strict';
		import { resolve } from 'node:path';
		import { createServer } from 'vite';
		globalThis.fetch = async () => { throw new Error('External services disabled'); };
		const vite = await createServer({ root: process.cwd(), configFile: false, envFile: false, appType: 'custom',
			server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { $lib: resolve('src/lib') } },
			plugins: [{ name: 'cold-scene-env', resolveId: id => id === '$env/dynamic/private' ? '\\0cold-env' : undefined,
				load: id => id === '\\0cold-env' ? 'export const env = process.env;' : undefined }] });
		const client = await vite.ssrLoadModule('/src/lib/server/db/client.ts');
		try {
			const { loadTurnContext } = await vite.ssrLoadModule('/src/lib/server/turn/context.ts');
			const context = await loadTurnContext('scene_checkpoint_campaign');
			assert(context.sceneCheckpoint.notes.some(note => note.text.includes('silver bell')));
			process.stdout.write('Cold process restored source-validated scene memory');
		} finally { await client.closeDb(); await vite.close(); }
	`], { cwd: root, env: process.env, encoding: 'utf8', timeout: 30_000, windowsHide: true });
	assert(coldProcess.includes('Cold process restored source-validated scene memory'));
	await client.closeDb(); db = client.getDb();
	let sceneContext = await loadTurnContext(sceneStory);
	assert(sceneContext.sceneCheckpoint, 'Checkpoint did not survive reconnect and evidence validation');
	assert.equal(sceneContext.recentEntries.length, 200);
	assert(!sceneContext.recentEntries.some(row => row.id === 'scene_entry_3'));
	let scenePrompt = buildServerTurnPrompt(sceneContext, emptyRetrievedMemoryPacket(sceneStory, 'Continue.'), 'next');
	assert(scenePrompt.prompt.includes('Mara agreed to return the silver bell before dawn.'));
	assert(scenePrompt.contextRecords.some(row => row.kind === 'sceneCheckpointNotes'));
	const noCheckpoint = buildServerTurnPrompt({ ...sceneContext, sceneCheckpoint: null }, emptyRetrievedMemoryPacket(sceneStory, 'Continue.'), 'next');
	assert.deepEqual(scenePrompt.messages, noCheckpoint.messages, 'Checkpoint changed exact dialogue');
	await db.update(schema.storyEntries).set({ metadata: { gmTurnReceipt: { test: true } } }).where(eq(schema.storyEntries.id, 'scene_entry_3'));
	assert((await loadTurnContext(sceneStory)).sceneCheckpoint, 'Receipt-only changes invalidated source evidence');
	await db.update(schema.storyEntries).set({ content: '[Time 10:00 | Location Hall] Mara refused the silver bell promise.' }).where(eq(schema.storyEntries.id, 'scene_entry_3'));
	assert.equal((await loadTurnContext(sceneStory)).sceneCheckpoint, null, 'Edited source remained eligible');
	await refreshSceneCheckpoint(sceneStory);
	sceneContext = await loadTurnContext(sceneStory);
	assert(sceneContext.sceneCheckpoint.notes.some(note => note.text === 'Mara refused the silver bell promise.'));
	assert(!sceneContext.sceneCheckpoint.notes.some(note => note.text.includes('agreed to return')));
	await db.update(schema.storyEntries).set({ metadata: { visibility: 'secret' } }).where(eq(schema.storyEntries.id, 'scene_entry_3'));
	assert.equal((await loadTurnContext(sceneStory)).sceneCheckpoint, null, 'Visibility change retained old public evidence');
	await refreshSceneCheckpoint(sceneStory);
	assert(!(await loadTurnContext(sceneStory)).sceneCheckpoint.notes.some(note => note.sourceEntryId === 'scene_entry_3'));
	await db.delete(schema.storyEntries).where(eq(schema.storyEntries.id, 'scene_entry_5'));
	assert.equal((await loadTurnContext(sceneStory)).sceneCheckpoint, null, 'Deleted evidence did not invalidate checkpoint');
	await refreshSceneCheckpoint(sceneStory);
	const sceneBundle = parseStoryExportBundle(JSON.parse(JSON.stringify(await exportBackendStory(sceneStory))));
	const sceneCopy = await importWorldDatabaseBundle({ bundle: sceneBundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	assert.equal((await loadTurnContext(sceneCopy.storyId)).sceneCheckpoint, null, 'Remapped import consumed old source IDs');
	await refreshSceneCheckpoint(sceneCopy.storyId);
	assert((await loadTurnContext(sceneCopy.storyId)).sceneCheckpoint, 'Copied evidence could not rebuild checkpoint');
	await enqueueBackendJob({ storyId: sceneStory, type: 'refresh_scene_checkpoint', dedupeKey: 'old-scene-job', payload: { oldEntryId: 'scene_entry_3' } });
	await db.insert(schema.storyEntries).values({ id: 'scene_new_location', storyId: sceneStory, type: 'narration', position: 302, content: '[Time 11:00 | Location Road] Mara reaches the crossroads alone.' });
	assert.equal((await loadTurnContext(sceneStory)).sceneCheckpoint, null, 'Prior scene leaked after transition');
	const sceneJobs = await runDueBackendJobs('scene-acceptance', 10, sceneStory);
	assert.equal(sceneJobs.failed.length, 0);
	sceneContext = await loadTurnContext(sceneStory);
	assert.equal(sceneContext.sceneCheckpoint.scene, 'road');
	assert.equal(sceneContext.sceneCheckpoint.sourceStart, 302, 'Late job restored the previous scene');
	assert.equal(sceneContext.story.metadata.retainedSetting, 'untouched');
	checks.push('Scene checkpoint retains a middle-passage promise beyond 150 turns in a fresh Node process without changing dialogue; edits, secrecy, deletion, scene changes and remapped import invalidate stale excerpts; the real worker rebuilds latest evidence even for an old queued job');

	// Slice 9 qualification fixture: keep the campaign large enough to put the
	// important evidence well outside the recent window, while keeping the
	// scenario deterministic and provider-free.
	const qualificationStory = 'long_campaign_qualification';
	const qualificationEntries = Array.from({ length: 2_000 }, (_, position) => ({
		id: `qualification_entry_${position}`,
		storyId: qualificationStory,
		position,
		type: position % 2 === 0 ? 'user_action' : 'narration',
		content: position % 2 === 0
			? `Turn ${Math.floor(position / 2) + 1}: the party crosses another quiet road.`
			: `Turn ${Math.floor(position / 2) + 1}: the campaign records another quiet road.`,
		metadata: { qualificationTurn: Math.floor(position / 2) + 1 },
	}));
	qualificationEntries[200].content = 'At turn 101, Mira promises Valen to return the amber key after the long winter.';
	qualificationEntries[201].content = 'The mid-campaign amber-key promise is witnessed and recorded.';
	qualificationEntries[700].content = 'A rumor claims the west gate opens at low tide.';
	qualificationEntries[701].content = 'A conflicting rumor claims the west gate is sealed at every tide.';
	qualificationEntries[1000].content = 'GM correction: the west-gate rumors were false; the eastern sluice is open.';
	qualificationEntries[1001].content = 'The corrected harbor record names the eastern sluice as the open passage.';
	qualificationEntries[1600].content = 'Mara asks to inspect her private map from another point of view.';
	qualificationEntries[1601].content = 'Mara private map: the hidden road crosses the ash bridge.';
	qualificationEntries[1601].metadata = { qualificationTurn: 801, visibility: 'secret', pov: 'mara' };
	qualificationEntries[1900].content = 'After a long gap, Mira returns to settle the amber-key promise.';
	qualificationEntries[1901].content = 'Mira returns the amber key and fulfills the old promise.';
	await db.insert(schema.stories).values({ id: qualificationStory, title: 'Long campaign qualification', currentTurn: 1_000 });
	for (let start = 0; start < qualificationEntries.length; start += 250) {
		await db.insert(schema.storyEntries).values(qualificationEntries.slice(start, start + 250));
	}
	await db.insert(schema.entities).values([
		{ id: 'qualification_mira', storyId: qualificationStory, type: 'character', name: 'Mira', state: {} },
		{ id: 'qualification_valen', storyId: qualificationStory, type: 'character', name: 'Valen', state: {} },
	]);
	await db.insert(schema.agreements).values({
		id: 'qualification_amber_promise', storyId: qualificationStory,
		parties: ['qualification_mira', 'qualification_valen'], category: 'promise',
		terms: 'Return the amber key after the long winter.', sourceEntryIds: ['qualification_entry_201'],
	});
	const qualificationCount = await db.select().from(schema.storyEntries).where(eq(schema.storyEntries.storyId, qualificationStory));
	assert.equal(qualificationCount.length, 2_000);
	const qualificationContext = await loadTurnContext(qualificationStory, [], [], 'Mira amber key promise');
	assert(qualificationContext.agreements.some(row => row.id === 'qualification_amber_promise'), 'Middle-campaign obligation fell outside current context');
	const qualificationRecall = await retrieveMemoryPacket({ storyId: qualificationStory, query: 'amber key promise', tokenBudget: 1_200 });
	assert(qualificationRecall.packet.includes('amber key'), 'Long-gap evidence was not retrievable');
	const privateHidden = await retrieveMemoryPacket({ storyId: qualificationStory, query: 'Mara private map', tokenBudget: 1_200 });
	assert(!privateHidden.packet.includes('ash bridge'), 'Alternate-POV private evidence leaked to the default view');
	const privateVisible = await retrieveMemoryPacket({ storyId: qualificationStory, query: 'Mara private map', includeSecret: true, tokenBudget: 1_200 });
	assert(privateVisible.packet.includes('ash bridge'), 'Scoped alternate-POV evidence was not available to the GM view');
	const qualificationBundle = parseStoryExportBundle(JSON.parse(JSON.stringify(await exportBackendStory(qualificationStory))));
	assert.equal(qualificationBundle.storyEntries.length, 2_000);
	assert.equal(qualificationBundle.storyEntries[1000].content, 'GM correction: the west-gate rumors were false; the eastern sluice is open.');
	const qualificationCopy = await importWorldDatabaseBundle({ bundle: qualificationBundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	const qualificationCopyExport = (await exportBackendStory(qualificationCopy.storyId)).worldDatabase;
	assert.equal(qualificationCopyExport.entries.length, 2_000);
	assert.notEqual(qualificationCopyExport.entries[200].id, 'qualification_entry_200');
	const copiedAgreement = qualificationCopyExport.agreements.find(row => row.category === 'promise');
	assert(copiedAgreement.sourceEntryIds.every(id => id !== 'qualification_entry_201'));
	const applyQualification = (position, changes) => applyValidatedTurnUpdate({
		storyId: qualificationStory, playerEntryId: `qualification_entry_${position - 1}`,
		assistantEntryId: `qualification_entry_${position}`, narration: 'The long campaign advances.',
		update: worldStateUpdateSchema.parse({ agreements: changes }), parseWarnings: [], retrievedMemoryIds: [],
		serverVersion: position, mode: 'supplemental', timelineTurn: Math.floor(position / 2),
	});
	await applyQualification(1901, [{ action: 'fulfill', id: 'qualification_amber_promise' }]);
	const afterFulfillment = await loadTurnContext(qualificationStory, [], [], 'Mira amber key promise');
	assert(!afterFulfillment.agreements.some(row => row.id === 'qualification_amber_promise'), 'Fulfilled long-gap obligation returned as current');
	const historicalQualification = await retrieveMemoryPacket({ storyId: qualificationStory, query: 'amber key promise', includeHistorical: true, tokenBudget: 1_200 });
	assert(historicalQualification.packet.includes('fulfilled'), 'Fulfilled obligation lost historical status');
	await client.closeDb();
	db = client.getDb();
	const restartedQualification = await loadTurnContext(qualificationStory, [], [], 'Mira amber key promise');
	assert(!restartedQualification.agreements.some(row => row.id === 'qualification_amber_promise'), 'Restart resurrected fulfilled obligation');
	checks.push('A deterministic 1,000-turn campaign preserves mid-campaign obligations, long-gap retrieval, conflicting rumors and GM correction evidence, alternate-POV privacy, fulfillment, restart, and remapped import without provider calls');
	const report = {
		createdAt: new Date().toISOString(),
		mode: 'deterministic-campaign-qualification',
		build: await harnessBuildId(root, [
			'scripts/test-campaign-persistence.mjs',
			'src/lib/server/memory/retrieval.ts',
			'src/lib/server/turn/patchValidator.ts',
			'src/lib/server/db/worldDatabaseImport.ts',
			'src/lib/server/jobs/outbox.ts',
			'src/lib/server/jobs/failureClassification.ts',
		]),
		fixture: { turns: 1_000, entries: 2_000, modelCalls: 0 },
		ok: true,
		checks,
		isolated: true,
	};
	const reportDir = resolve(root, 'evals/qualification/results');
	await mkdir(reportDir, { recursive: true });
	const reportPath = resolve(reportDir, `${report.createdAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`);
	await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
	console.log(JSON.stringify({ ...report, reportPath }, null, 2));
} finally {
	globalThis.fetch = originalFetch;
	try { await client?.closeDb(); } finally {
		try { await vite?.close(); } finally {
			if (containerId) {
				const target = JSON.parse(docker('inspect', containerId))[0];
				assert.equal(target.Name, `/${containerName}`);
				assert.equal(target.Config.Labels['mtherios.persistence-test'], runId);
				docker('stop', '--time', '2', containerId);
				console.log('Disposable databases removed; live campaign database was not used.');
			}
		}
	}
}
