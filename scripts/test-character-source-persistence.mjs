import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { createServer } from 'vite';

// No database URL argument: this test writes only to its own disposable container.
const root = resolve(import.meta.dirname, '..');
const runId = randomUUID();
const containerName = `mtherios-npc-test-${runId}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
let containerId, vite, client;
const originalFetch = globalThis.fetch;
let fakeProviderCalls = 0;
const checks = [];
const quote = 'Mara served as the harbor pilot and guided the ship through the reef.';
try {
	globalThis.fetch = async () => { throw new Error('NPC fixture forbids external model and projection calls'); };
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', containerName, '--label', `mtherios.npc-test=${runId}`, '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=source', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	const inspected = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspected.Config.Labels['mtherios.npc-test'], runId);
	const port = inspected.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	const url = (name) => `postgres://fixture:fixture@127.0.0.1:${port.HostPort}/${name}`;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'fixture', '-d', 'source'); break; }
		catch { await delay(250); }
	}
	docker('exec', containerId, 'createdb', '-U', 'fixture', 'target');
	for (const name of ['source', 'target']) {
		process.env.DATABASE_URL = url(name);
		execFileSync(process.execPath, ['scripts/db-migrate.mjs'], { cwd: root, env: process.env, encoding: 'utf8', timeout: 60_000, windowsHide: true });
	}
	process.env.DATABASE_URL = url('source');
	globalThis.__npcFixtureGenerate = async () => {
		fakeProviderCalls++;
		return { text: JSON.stringify({ facts: [{ field: 'bio', value: quote, sourceId: 'entry_mara', quote }] }), model: 'fixture', endpoint: 'fixture', durationMs: 1, promptChars: 200, responseChars: 100 };
	};
	vite = await createServer({ root, configFile: false, envFile: false, appType: 'custom', server: { middlewareMode: true, hmr: false, watch: null }, resolve: { alias: { $lib: resolve(root, 'src/lib') } }, plugins: [{
		name: 'npc-fixture-boundaries',
		enforce: 'pre',
		resolveId(id) { if (id === '$env/dynamic/private') return '\0npc-env'; if (id === 'npc-fixture-provider' || id === 'npc-fixture-settings') return `\0${id}`; },
		load(id) {
			if (id === '\0npc-env') return 'export const env = process.env;';
			if (id === '\0npc-fixture-settings') return `export async function resolveServiceGeneration(){return {setting:null, profile:{id:'fixture',name:'Fixture',providerType:'openrouter'},generation:{model:'fixture',temperature:0,maxTokens:2200},systemPromptOverride:null};}`;
			if (id === '\0npc-fixture-provider') return `export {ServerGenerationError,parseJsonFromGeneratedText} from '/src/lib/server/turn/provider.ts'; export async function generateServerTextWithMetrics(input){return globalThis.__npcFixtureGenerate(input);}`;
		},
		transform(code, id) {
			if (!id.replaceAll('\\', '/').endsWith('/server/engine/characterDrafts.ts')) return;
			return code.replace(/from\s+["']\.\/llmSettings["']/g, "from 'npc-fixture-settings'").replace(/from\s+["']\$lib\/server\/turn\/provider["']/g, "from 'npc-fixture-provider'");
		},
	}] });
	const load = (path) => vite.ssrLoadModule(`/src/lib/${path}.ts`);
	client = await load('server/db/client');
	const schema = await load('server/db/schema');
	const { draftCharacterFromCandidateSources } = await load('server/engine/characterDrafts');
	const { reviewPatchProposal } = await load('server/engine/canonRepair');
	const { getWorldRecord } = await load('server/engine/worldRecords');
	const { exportBackendStory } = await load('server/memory/canonical');
	const { importWorldDatabaseBundle } = await load('server/db/worldDatabaseImport');
	const { parseStoryExportBundle } = await load('contracts/worldDatabase');
	const { loadTurnContext } = await load('server/turn/context');
	const { buildServerTurnPrompt } = await load('server/turn/promptPacket');
	const { createChapterCharacterReferenceProposals, findChapterCharacterCandidates } = await load('server/jobs/processor');
	let db = client.getDb();
	const storyId = 'fixture_npc_story';
	await db.insert(schema.stories).values({ id: storyId, title: 'Source NPC fixture', currentTurn: 2, serverVersion: 3 });
	await db.insert(schema.storyEntries).values([{ id: 'entry_mara', storyId, type: 'narration', content: quote, position: 1 }, { id: 'entry_later', storyId, type: 'narration', content: 'Mara stands beside the player at the harbor. She waits for the next voyage.', position: 2 }]);
	await db.insert(schema.storyEvents).values([1, 2, 3].map((number) => ({ id: `event_mara_${number}`, storyId, type: 'observation', title: `Mara sighting ${number}`, body: quote, sourceEntryIds: ['entry_mara'] })));
	await db.insert(schema.chapters).values([1, 2].map((number) => ({ id: `chapter_${number}`, storyId, number, title: `Voyage ${number}`, sceneOutcome: quote, metadata: { legacyCharacters: ['Mara'] }, sourceEntryIds: number === 1 ? ['entry_mara'] : ['entry_later'] })));
	const chapters = await db.select().from(schema.chapters);
	const events = await db.select().from(schema.storyEvents);
	const digest = { title: 'Voyage', summary: quote, keywords: [], keyCharacters: ['Mara'], keyLocations: [], plotThreads: [], emotionalTone: '', source: 'deterministic' };
	const checkpoint = async (chapter, sourceEntryIds) => createChapterCharacterReferenceProposals({ storyId, chapter, digest, events, sourceEntryIds, serverVersion: 3, now: new Date().toISOString() });
	assert.equal((await checkpoint(chapters[0], ['entry_mara'])).created, 1);
	const readProposal = async () => (await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.storyId, storyId)))[0];
	let candidate = await readProposal();
	const candidateId = candidate.id;
	await assert.rejects(reviewPatchProposal({ storyId, proposalId: candidateId, decision: 'approved', expectedProposalVersion: candidate.serverVersion }), /only a placeholder/);
	assert.equal((await checkpoint(chapters[1], ['entry_later'])).updated, 1);
	candidate = await readProposal();
	assert.deepEqual(candidate.sourceEntryIds, ['entry_mara', 'entry_later']);
	assert.equal(candidate.id, candidateId);
	const beforeFind = candidate.serverVersion;
	const found = await findChapterCharacterCandidates(storyId, 8);
	assert.equal(found.chaptersScanned, 2);
	assert.equal(found.created, 0);
	assert.equal((await readProposal()).serverVersion, beforeFind);
	checks.push('Real chapter checkpoints accumulate evidence into the same pending candidate');
	await db.insert(schema.stories).values({ id: 'discovery_story', title: 'Discovery fixture' });
	assert.match((await findChapterCharacterCandidates('discovery_story')).reason, /no named-character digest tags/);
	await db.insert(schema.chapters).values([1, 2].map((number) => ({ id: `discovery_chapter_${number}`, storyId: 'discovery_story', number, title: 'Pilot sightings', sceneOutcome: 'Neris guides the expedition.', metadata: { legacyCharacters: ['Neris'] } })));
	assert.equal((await findChapterCharacterCandidates('discovery_story')).created, 1);
	const [discovered] = await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.storyId, 'discovery_story'));
	assert.equal(discovered.status, 'pending');
	await reviewPatchProposal({ storyId: 'discovery_story', proposalId: discovered.id, decision: 'rejected', expectedProposalVersion: discovered.serverVersion });
	assert.equal((await findChapterCharacterCandidates('discovery_story')).created, 0);
	assert.equal((await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.id, discovered.id)))[0].status, 'rejected');
	assert.equal(fakeProviderCalls, 0);
	checks.push('Find from chapters fills an empty queue from recurring stored names without model calls or canon creation, reports missing tags and respects rejection');

	const drafted = await draftCharacterFromCandidateSources(storyId, { proposalId: candidateId, expectedProposalVersion: candidate.serverVersion });
	assert.equal(drafted.status, 'pending');
	assert.equal((await db.select().from(schema.entities)).length, 0);
	candidate = await readProposal();
	assert.equal(candidate.metadata.sourceDraft.evidence[0].quote, quote);
	const preview = await getWorldRecord(storyId, 'patchProposals', candidateId);
	assert.equal(preview.record.operations[0].value.state.bio, quote);
	await db.update(schema.storyEntries).set({ content: 'Mara was misidentified in the earlier account.', serverVersion: 9 }).where(eq(schema.storyEntries.id, 'entry_mara'));
	await assert.rejects(reviewPatchProposal({ storyId, proposalId: candidateId, decision: 'approved', expectedProposalVersion: candidate.serverVersion }), /quoted story sources changed/);
	assert.equal((await readProposal()).status, 'pending');
	assert.equal((await db.select().from(schema.entities)).length, 0);
	await db.update(schema.storyEntries).set({ content: quote, serverVersion: 10 }).where(eq(schema.storyEntries.id, 'entry_mara'));
	await draftCharacterFromCandidateSources(storyId, { proposalId: candidateId });
	candidate = await readProposal();
	await assert.rejects(reviewPatchProposal({ storyId, proposalId: candidateId, decision: 'approved', expectedProposalVersion: candidate.serverVersion - 1 }), /changed/);
	assert.equal((await readProposal()).status, 'pending');
	const reviewed = await reviewPatchProposal({ storyId, proposalId: candidateId, decision: 'approved', expectedProposalVersion: candidate.serverVersion });
	assert.equal(reviewed.status, 'applied');
	const entityId = reviewed.application.affectedEntityIds[0];
	await assert.rejects(reviewPatchProposal({ storyId, proposalId: candidateId, decision: 'approved' }), /no longer pending/);
	await client.closeDb(); db = client.getDb();
	const reloaded = await getWorldRecord(storyId, 'characters', entityId);
	assert.match(reloaded.record.state.bio, /harbor pilot/);
	assert.deepEqual(reloaded.record.source_entry_ids, ['entry_mara', 'entry_later']);
	assert.equal((await db.select().from(schema.entities)).length, 1);
	checks.push('Fake provider boundary produces review-only draft; changed sources and stale review fail; one approval survives reconnect without duplicate canon');

	const bundle = parseStoryExportBundle(JSON.parse(JSON.stringify(await exportBackendStory(storyId))));
	await client.closeDb(); process.env.DATABASE_URL = url('target');
	const imported = await importWorldDatabaseBundle({ bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	db = client.getDb();
	const restored = (await exportBackendStory(imported.storyId)).worldDatabase;
	const character = restored.entities.find((row) => row.name === 'Mara');
	const source = restored.entries.find((row) => row.content === quote);
	const restoredProposal = restored.patchProposals[0];
	assert.notEqual(character.id, entityId);
	assert(restoredProposal.sourceEntryIds.includes(source.id));
	assert.equal(restoredProposal.metadata.sourceDraft.evidence[0].sourceId, source.id);
	assert(restored.sourceRefs.some((ref) => ref.targetRecordId === character.id && ref.sourceId === restoredProposal.id));
	const context = await loadTurnContext(imported.storyId, [character.id], [character.id]);
	const nextPrompt = buildServerTurnPrompt(context, { storyId: imported.storyId, query: 'I ask Mara to pilot the next voyage.', packet: '', nodes: [], tokenEstimate: 0, retrievalDebug: [], retrievalTrace: [] }, restored.entries.at(-1).id, { presentNpcIds: [character.id] });
	assert(nextPrompt.prompt.includes(quote));
	checks.push('Real export/import remaps proposal evidence and canonical source refs; next-turn prompt includes the created biography');

	// A second candidate explicitly targets the exact existing character. A newer
	// canonical edit after drafting must keep the proposal pending and canon intact.
	const nextCandidate = { ...restoredProposal, id: 'update_candidate', status: 'pending', decision: null, metadata: { sourceName: 'Mara' }, serverVersion: character.serverVersion, sourceEntryIds: [source.id], sourceEventIds: [] };
	await db.insert(schema.patchProposals).values(nextCandidate);
	globalThis.__npcFixtureGenerate = async () => { fakeProviderCalls++; return { text: JSON.stringify({ facts: [{ field: 'rank', value: 'Harbor pilot', sourceId: source.id, quote }] }), model: 'fixture', endpoint: 'fixture', durationMs: 1, promptChars: 100, responseChars: 100 }; };
	await draftCharacterFromCandidateSources(imported.storyId, { proposalId: nextCandidate.id, recordId: character.id });
	const [updateProposal] = await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.id, nextCandidate.id));
	assert.equal(updateProposal.metadata.sourceDraft.targetEntityId, character.id);
	await db.update(schema.entities).set({ state: { ...character.state, appearance: 'A newly recorded scar.' }, serverVersion: character.serverVersion + 1 }).where(and(eq(schema.entities.storyId, imported.storyId), eq(schema.entities.id, character.id)));
	await assert.rejects(reviewPatchProposal({ storyId: imported.storyId, proposalId: nextCandidate.id, decision: 'approved', expectedProposalVersion: updateProposal.serverVersion }), /target changed/);
	assert.equal((await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.id, nextCandidate.id)))[0].status, 'pending');
	assert.equal((await getWorldRecord(imported.storyId, 'characters', character.id)).record.state.appearance, 'A newly recorded scar.');
	checks.push('Exact existing target is recorded in the draft; later canonical edits block stale approval without changing canon');
	console.log(JSON.stringify({ ok: true, isolated: true, realModelCalls: 0, fakeProviderCalls, checks }, null, 2));
} finally {
	globalThis.fetch = originalFetch;
	delete globalThis.__npcFixtureGenerate;
	try { await client?.closeDb(); } finally { try { await vite?.close(); } finally {
		if (containerId) { const target = JSON.parse(docker('inspect', containerId))[0]; assert.equal(target.Name, `/${containerName}`); assert.equal(target.Config.Labels['mtherios.npc-test'], runId); docker('stop', '--time', '2', containerId); }
	} }
}
