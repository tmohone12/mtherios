import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { createServer } from 'vite';

// Deliberately no URL option: every write must use the container created here.
const root = resolve(import.meta.dirname, '..');
const reportDirectory = resolve(root, process.argv[2] ?? 'output/auto-characters-20260907');
const runId = randomUUID();
const containerName = `mtherios-auto-character-test-${runId}`;
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).trim();
let containerId, vite, client;
const originalFetch = globalThis.fetch;
const checks = [];
try {
	globalThis.fetch = async () => { throw new Error('Persistence tests must not call model or projection services'); };
	containerId = docker('run', '--pull=never', '--rm', '-d', '--name', containerName,
		'--label', `mtherios.auto-character-test=${runId}`, '--tmpfs', '/var/lib/postgresql/data',
		'-e', 'POSTGRES_USER=fixture', '-e', 'POSTGRES_PASSWORD=fixture', '-e', 'POSTGRES_DB=source',
		'-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
	assert.match(containerId, /^[a-f0-9]{64}$/);
	const inspect = JSON.parse(docker('inspect', containerId))[0];
	assert.equal(inspect.Config.Labels['mtherios.auto-character-test'], runId);
	const port = inspect.NetworkSettings.Ports['5432/tcp'][0];
	assert.equal(port.HostIp, '127.0.0.1');
	const databaseUrl = (name) => `postgres://fixture:fixture@127.0.0.1:${port.HostPort}/${name}`;
	let ready = false;
	for (let attempt = 0; attempt < 40; attempt++) {
		try { docker('exec', containerId, 'pg_isready', '-U', 'fixture', '-d', 'source'); ready = true; break; }
		catch { await delay(250); }
	}
	assert(ready, 'Disposable database did not become ready');
	Object.assign(process.env, {
		MEMORY_EMBEDDING_PROVIDER: '', MEMORY_EMBEDDING_API_KEY: '', MEMORY_IMPORT_ENTRY_LIMIT: '2',
	});
	for (const name of ['source']) {
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

	const { applyValidatedTurnUpdate } = await load('server/turn/patchValidator');
	const { worldStateUpdateSchema } = await load('services/ai/tools/schemas');
	const { buildDeferredStateExtractionPrompt, preserveDurableDeferredState } = await load('server/jobs/processor');
	const { loadClassifierFactions } = await load('server/turn/context');
	const db = client.getDb();
	const storyId = 'auto_character_fixture';
	await db.insert(schema.stories).values([{ id: storyId, title: 'Automatic NPC fixture' }, { id: 'foreign_story', title: 'Other story' }]);
	await db.insert(schema.entities).values({ id: 'foreign_tala', storyId: 'foreign_story', type: 'character', name: 'Tala Venn' });
	const narration = 'Tala Venn, a courier sworn to The Watch, delivers the sealed dispatch. Mara Hest, a scout serving the Harbor Guild, guards her back.';
	await db.insert(schema.storyEntries).values([
		{ id: 'action', storyId, type: 'user_action', content: 'I greet the two messengers.', position: 1 },
		{ id: 'resolution', storyId, type: 'narration', content: narration, parentId: 'action', position: 2 },
	]);
	await db.insert(schema.factions).values({ id: 'watch', storyId, name: 'The Watch' });
	await db.insert(schema.factionMemberships).values({ id: 'unresolved_tala', storyId, factionId: 'watch', entityId: null, metadata: { memberNameOrId: 'Tala Venn', unresolvedCharacterReference: true }, sourceEntryIds: ['action'] });
	const tala = { name: 'Tala Venn', description: 'A courier delivering a sealed dispatch.', creation_evidence: narration, faction_tags: ['The Watch'], faction_evidence: [{ faction: 'The Watch', quote: narration }] };
	const mara = { name: 'Mara Hest', description: 'A scout guarding the courier.', creation_evidence: narration, faction_tags: ['Harbor Guild'], faction_evidence: [{ faction: 'Harbor Guild', quote: narration }] };
	const parsed = worldStateUpdateSchema.parse({ characters: [tala, mara], lorebook_entries: [{ name: 'Harbor Guild', type: 'faction', description: 'The guild employs scouts to protect messengers.' }] });
	const apply = (update, serverVersion = 1) => applyValidatedTurnUpdate({ storyId, playerEntryId: 'action', assistantEntryId: 'resolution', narration, update, parseWarnings: [], retrievedMemoryIds: [], serverVersion, mode: 'supplemental' }, { enqueueProjectionJobs: false });
	const result = await apply(parsed);
	assert.equal(result.warnings.length, 0, result.warnings.join('\n'));
	let characters = await db.select().from(schema.entities).where(and(eq(schema.entities.storyId, storyId), eq(schema.entities.type, 'character')));
	assert.equal(characters.length, 2);
	assert(characters.every(row => row.metadata.sourceType === 'gm_auto_character' && row.sourceEntryIds.includes('resolution')));
	assert.deepEqual(characters.find(row => row.name === 'Tala Venn').state.factionTags, ['The Watch']);
	assert.deepEqual(characters.find(row => row.name === 'Mara Hest').state.factionTags, ['Harbor Guild']);
	let members = await db.select().from(schema.factionMemberships).where(eq(schema.factionMemberships.storyId, storyId));
	assert.equal(members.length, 2);
	assert.equal(members.find(row => row.id === 'unresolved_tala').entityId, characters.find(row => row.name === 'Tala Venn').id);
	assert(members.every(row => row.sourceEntryIds.includes('resolution') && !row.metadata.unresolvedCharacterReference));
	const patches = await db.select().from(schema.statePatches).where(eq(schema.statePatches.storyId, storyId));
	assert(members.every(member => member.sourcePatchIds.some(id => patches.some(patch => patch.id === id && patch.sourceEntryIds.includes('resolution')))));
	checks.push('Automatic NPCs, an existing unresolved member, a same-turn new faction, tags and source receipts commit together');
	const characterUpdate = worldStateUpdateSchema.parse({ characters: [tala, mara] });
	await Promise.all([apply(characterUpdate, 2), apply(characterUpdate, 3)]);
	assert.equal((await db.select().from(schema.entities).where(and(eq(schema.entities.storyId, storyId), eq(schema.entities.type, 'character')))).length, 2);
	assert.equal((await db.select().from(schema.factionMemberships).where(eq(schema.factionMemberships.storyId, storyId))).length, 2);
	checks.push('Concurrent replay is serialized by the story lock and creates no duplicate characters or memberships');
	const fabricated = { name: 'Sera Noll', description: 'Invented captain.', creation_evidence: 'Sera Noll commands the city guard.' };
	await apply(worldStateUpdateSchema.parse({ characters: [fabricated] }), 4);
	assert.equal((await db.select().from(schema.entities).where(eq(schema.entities.name, 'Sera Noll'))).length, 0);
	assert.equal((await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.storyId, storyId))).length, 1);
	await apply(worldStateUpdateSchema.parse({ characters: [fabricated] }), 5);
	assert.equal((await db.select().from(schema.patchProposals).where(eq(schema.patchProposals.storyId, storyId))).length, 1);
	checks.push('Unsupported creation stays out of canon with one deduplicated review candidate');
	const factionContext = await loadClassifierFactions(storyId);
	for (const attemptCount of [1, 2]) {
		const prompt = buildDeferredStateExtractionPrompt({ playerText: '', narration, responseSchema: {}, attemptCount, factions: factionContext }).prompt;
		assert(prompt.includes('creation_evidence') && prompt.includes('faction_evidence') && prompt.includes('Harbor Guild'));
	}
	assert.equal(preserveDurableDeferredState(characterUpdate).characters[0].creation_evidence, narration);
	checks.push('Initial and repair extraction retain creation rules, faction context and deferred source evidence');
	const actor = characters.find(row => row.name === 'Tala Venn');
	const move = 'Tala Venn asked her merchant cousin to take her younger brother aboard.';
	const agency = { currentGoal: 'Keep her younger brother out of royal service.', currentPlan: 'Secure an apprenticeship before the appointment is announced.', lastIndependentAction: move, nextOpportunity: 'The cousin returns tomorrow; she intends to meet him.', constraint: 'She will not openly accuse her husband.' };
	await db.insert(schema.storyEntries).values([
		{ id: 'agency_action', storyId, type: 'user_action', content: 'I ask Tala about her brother.', position: 3 },
		{ id: 'agency_narration', storyId, type: 'narration', content: move, parentId: 'agency_action', position: 4 },
	]);
	const applyAgency = (character, extra = {}) => applyValidatedTurnUpdate({ storyId, playerEntryId: 'agency_action', assistantEntryId: 'agency_narration', narration: move,
		update: worldStateUpdateSchema.parse({ characters: [{ name: actor.name, entityId: actor.id, ...character }] }), parseWarnings: [], retrievedMemoryIds: [], serverVersion: 6, mode: 'supplemental', timelineTurn: 1, ...extra,
	}, { enqueueProjectionJobs: false });
	await Promise.all([1, 2].map(() => applyAgency({ ...agency, independentActionEvidence: move, independentActionVisibility: 'secret' })));
	let moveRows = (await db.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, storyId))).filter(row => row.metadata.sourceType === 'npc_independent_action');
	assert.equal(moveRows.length, 1, 'Concurrent replay must not duplicate the independent move');
	assert.deepEqual(moveRows[0].actorEntityIds, [actor.id]);
	assert.deepEqual(moveRows[0].sourceEntryIds, ['agency_narration']);
	assert.equal(moveRows[0].status, 'committed');
	assert.equal(moveRows[0].visibility, 'secret');
	assert.equal(moveRows[0].memoryImpact.evidence, move);
	assert.equal((await db.select().from(schema.npcEventLinks).where(eq(schema.npcEventLinks.eventId, moveRows[0].id))).length, 1);
	await client.closeDb();
	const agencyDb = client.getDb();
	const readActor = async () => (await agencyDb.select().from(schema.entities).where(eq(schema.entities.id, actor.id)))[0];
	for (const [key, value] of Object.entries(agency)) assert.equal((await readActor()).state[key], value);
	const { exportBackendStory } = await load('server/memory/canonical');
	const { importWorldDatabaseBundle } = await load('server/db/worldDatabaseImport');
	const bundle = JSON.parse(JSON.stringify(await exportBackendStory(storyId)));
	const imported = await importWorldDatabaseBundle({ bundle, options: { preserveIds: false, replaceExisting: false, syncWiki: false } });
	const importedActor = (await agencyDb.select().from(schema.entities).where(eq(schema.entities.storyId, imported.storyId))).find(row => row.name === actor.name);
	for (const [key, value] of Object.entries(agency)) assert.equal(importedActor.state[key], value);
	const importedMove = (await agencyDb.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, imported.storyId))).find(row => row.metadata.sourceType === 'npc_independent_action');
	assert(importedMove && importedMove.id !== moveRows[0].id);
	assert.deepEqual(importedMove.actorEntityIds, [importedActor.id]);
	assert(importedMove.sourceEntryIds.every(id => id !== 'agency_narration'));
	const { loadTurnContext } = await load('server/turn/context');
	const { buildServerTurnPrompt } = await load('server/turn/promptPacket');
	const ctx = await loadTurnContext(imported.storyId, [importedActor.id], [importedActor.id]);
	const prompt = buildServerTurnPrompt(ctx, { storyId: imported.storyId, query: 'I ask Tala Venn about her brother.', packet: '', nodes: [], tokenEstimate: 0, retrievalDebug: [], retrievalTrace: [] }, 'next_action', { presentNpcIds: [importedActor.id] });
	for (const value of Object.values(agency)) assert(prompt.prompt.includes(value), `Missing NPC context: ${value}`);
	await mkdir(reportDirectory, { recursive: true });
	await writeFile(resolve(reportDirectory, 'npc-belief-packet.txt'), prompt.prompt);
	await applyAgency({ currentGoal: null, currentPlan: null, nextOpportunity: null, constraint: null });
	assert.equal((await readActor()).state.currentPlan, null);
	await applyAgency({ ...agency, independentActionEvidence: move }, { suppressCurrentNpcAgency: true, narration: '' });
	assert.equal((await readActor()).state.currentPlan, null, 'A late extraction must not restore an abandoned plan');
	moveRows = (await agencyDb.select().from(schema.storyEvents).where(eq(schema.storyEvents.storyId, storyId))).filter(row => row.metadata.sourceType === 'npc_independent_action');
	assert.equal(moveRows.length, 1);
	checks.push('NPC goals, plans, moves, opportunities and constraints survive reconnect and remapped export/import, reach the next narrator packet, and retain historical moves after intent clears or late retries');
	await client.closeDb();
	const restarted = client.getDb();
	characters = await restarted.select().from(schema.entities).where(and(eq(schema.entities.storyId, storyId), eq(schema.entities.type, 'character')));
	assert.equal(characters.length, 2);
	assert(characters.every(row => row.state.factionTags.length === 1));
	assert.equal((await restarted.select().from(schema.entities).where(eq(schema.entities.storyId, 'foreign_story')))[0].id, 'foreign_tala');
	checks.push('Canonical characters and faction tags survive reconnect; another story remains untouched');
	const report = { createdAt: new Date().toISOString(), ok: true, isolated: true, modelCalls: 0, checks };
	await mkdir(reportDirectory, { recursive: true });
	await writeFile(resolve(reportDirectory, 'postgres-proof.json'), JSON.stringify(report, null, 2));
	console.log(JSON.stringify(report, null, 2));
} finally {
	globalThis.fetch = originalFetch;
	try { await client?.closeDb(); } finally {
		try { await vite?.close(); } finally {
			if (containerId) {
				const target = JSON.parse(docker('inspect', containerId))[0];
				assert.equal(target.Name, `/${containerName}`);
				assert.equal(target.Config.Labels['mtherios.auto-character-test'], runId);
				docker('stop', '--time', '2', containerId);
				console.log('Disposable databases removed; live campaign database was not used.');
			}
		}
	}
}
