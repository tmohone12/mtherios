// Story-scoped restore repair. Dry run by default; archives the full affected
// database state before changing working canon. Never changes transcript text.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

export const STORY_ID = 'story_332449d7-f704-4f56-aa31-097dbec8d0ce';
const KEY = 'golden_boy_restored_chronology_20260919';
const PLAYER = 'import_44072e7c-5f0e-4c52-9d35-7937006e6ffd';
const CHILDREN = 'import_ce4fbfad-5489-401f-a549-e4fe4af30c7b';
const EMPRESS = 'import_37978e09-8052-4836-93ce-a6d04fd826fe';
const NURSERY_ACCOUNTS = new Map([
	[515, 'A wet-nurse approached Aurion in the eastern gallery and directed him toward his infant daughters in the Inner Pavilion.'],
	[517, 'The wet-nurse escorted Aurion to the Inner Pavilion, where the guards admitted him to the nursery.'],
	[519, 'Aurion entered the upper nursery, where his two infant daughters rested under their nurse’s care.'],
	[521, 'Aurion approached his infant daughters in the upper nursery.'],
	[523, 'Aurion picked up both infant daughters and held them close.'],
	[525, 'Aurion reassured his infant daughters that he had come because they needed him. He held them; they did not speak or describe prophetic dreams.'],
	[527, 'Aurion carried both infants out of the nursery and through the palace, accompanied by their wet-nurse.'],
	[529, 'Aurion told his infant daughters they were going around the palace and carried them through the garden court.'],
	[531, 'Aurion spent much of the day carrying and caring for his infant daughters, then returned them to the upper nursery to rest.'],
	[533, 'Aurion promised to return to the nursery as the infants settled to sleep under the wet-nurse’s care.'],
	[535, 'Aurion said goodnight to his sleeping infant daughters and left the upper nursery for his bedchamber.'],
]);
const TABLES = ['story_entries', 'entities', 'entity_aliases', 'relationships', 'factions', 'faction_memberships', 'faction_resources', 'faction_goals', 'faction_projects', 'agreements', 'story_threads', 'npc_beliefs', 'story_events', 'npc_event_links', 'state_patches', 'facts', 'source_refs', 'patch_proposals', 'continuity_warnings', 'memory_nodes', 'chapters', 'arcs', 'sagas', 'backend_jobs'];
export const CORRECTION = `Restored-story continuity correction, supplied by the author on 2026-09-19:
This is the restored early timeline of The golden boy / Volantis Black Walls intrigue, not the discarded later campaign. Follow the surviving transcript in position order; later-campaign summaries and achievements are not this timeline's history.
Aurion has not hatched any dragons. Aer and Gaelyx are not living mounts or companions in this timeline; do not import dragon flights, dragon conquests, or later hatching memories.
Aurion and Zhen Lian's children are infants. Portray infant development and care, not walking or speaking children. Earlier generated nursery dialogue, articulated prophecies, and older-child behavior were continuity errors; retain the visit and his care for his infants, not those age-inconsistent details.
Aurion has not met Daenerys. Do not invent a shared history, relationship, meeting, or acquired knowledge from the discarded campaign.
The current scene continues in Yi Ti, in the sealed Rear Palace, on Day 5 of the Second Moon, 297 AC. Aurion has completed the outer walk; the Long Gallery of Faded Lanterns remains sealed, its inspection deferred. Do not replay his arrival or advance the calendar to 299 AC.
These corrections override conflicting legacy summaries, character sheets, recalled events, and earlier generated dialogue. They are GM continuity instructions, not information automatically known by NPCs.
This records the state at the repair checkpoint, not a permanent ban on future events: time, infant development, meetings and dragon hatching may advance only when established through subsequent play. Never automatically import the discarded campaign's future.`;
const sourceIds = row => row.source_entry_ids ?? [];
const hashEntries = rows => createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.position, r.type, r.content, r.parent_id, r.branch_id]))).digest('hex');

export function buildPlan(snapshot) {
	const entries = snapshot.story_entries;
	const surviving = new Set(entries.map(row => row.id));
	const orphan = row => sourceIds(row).length > 0 && sourceIds(row).every(id => !surviving.has(id));
	const removed = Object.fromEntries(TABLES.map(table => [table, new Set()]));
	for (const row of snapshot.chapters) if (sourceIds(row).some(id => !surviving.has(id))) removed.chapters.add(row.id);
	for (const row of snapshot.arcs) if (row.chapter_ids.some(id => removed.chapters.has(id))) removed.arcs.add(row.id);
	for (const row of snapshot.sagas) if (row.arc_ids.some(id => removed.arcs.has(id))) removed.sagas.add(row.id);
	for (const table of ['story_events', 'memory_nodes', 'story_threads', 'faction_memberships', 'faction_resources', 'faction_goals', 'faction_projects', 'npc_beliefs', 'facts', 'patch_proposals']) {
		for (const row of snapshot[table]) if (orphan(row)) removed[table].add(row.id);
	}
	// These Old Blood figures already appear in surviving Volantis scenes. Their
	// later checkpoint dossiers are not grounds to remove them from the world.
	const keep = new Set(['Consort', 'Malaquo Maegyr', 'Nyessos Vhassar', 'Sera']);
	for (const row of snapshot.entities) if (orphan(row) && !keep.has(row.name)) removed.entities.add(row.id);
	for (const row of snapshot.factions) {
		if (orphan(row) && row.metadata?.sourceType === 'character_faction_tag'
			&& !(row.member_entity_ids ?? []).some(id => snapshot.entities.some(e => e.id === id && !removed.entities.has(id) && !orphan(e)))) removed.factions.add(row.id);
	}
	for (const row of snapshot.story_threads) if (row.id.includes('the_daughters_dream')) removed.story_threads.add(row.id);
	for (const row of snapshot.story_events) {
		if (row.id.includes('the_daughters_dream') || row.id === 'event_50aa84ed-e9c6-48bb-80ec-57541294d282'
			|| (!sourceIds(row).length && row.id.startsWith('import_') && row.title.includes('converts pressure into motion'))) removed.story_events.add(row.id);
	}
	for (const row of snapshot.memory_nodes) {
		if ((row.source_event_ids ?? []).some(id => removed.story_events.has(id))
			|| (row.thread_ids ?? []).some(id => removed.story_threads.has(id))
			|| removed.chapters.has(row.metadata?.chapterId) || removed.arcs.has(row.metadata?.arcId)
			|| (!sourceIds(row).length && (/^Arc \d+:/.test(row.title) || (row.type === 'faction' && row.id.startsWith('import_'))))
			|| sourceIds(row).some(id => !surviving.has(id))) removed.memory_nodes.add(row.id);
	}
	assert(!removed.entities.has(PLAYER) && !removed.entities.has(CHILDREN) && !removed.entities.has(EMPRESS));
	assert.equal(removed.story_entries.size, 0);
	assert(entries.some(e => e.position === 547 && e.content.includes('outer circuit')));
	return { removed, counts: Object.fromEntries(Object.entries(removed).filter(([, ids]) => ids.size).map(([table, ids]) => [table, ids.size])), transcriptHash: hashEntries(entries) };
}

async function readSnapshot(tx) {
	const [story] = await tx`select * from stories where id=${STORY_ID} for update`;
	assert(story, 'Story missing');
	const snapshot = { story };
	for (const table of TABLES) snapshot[table] = await tx.unsafe(`select * from ${table} where story_id=$1 order by id`, [STORY_ID]);
	return snapshot;
}

async function apply(tx, snapshot, plan, backupPath) {
	assert.equal(snapshot.backend_jobs.filter(j => ['queued', 'retry', 'running'].includes(j.status)).length, 0, 'Wait for current story jobs to finish');
	const now = new Date().toISOString();
	const version = snapshot.story.server_version + 1;
	const marker = { key: KEY, at: now, backupPath, previousServerVersion: snapshot.story.server_version, transcriptHash: plan.transcriptHash, archivedCounts: plan.counts, authority: 'Explicit user restore correction: no hatched dragons, infant children, no meeting with Daenerys.' };
	for (const [table, ids] of Object.entries(plan.removed)) if (ids.size) await tx.unsafe(`delete from ${table} where story_id=$1 and id=any($2::text[])`, [STORY_ID, [...ids]]);
	// Repoint references to retained context, without treating old numeric source
	// positions as current positions after a restore/import.
	const survivingEntries = new Set(snapshot.story_entries.map(e => e.id));
	const entryById = new Map(snapshot.story_entries.map(e => [e.id, e]));
	for (const table of ['entities', 'factions', 'faction_memberships', 'faction_resources', 'faction_goals', 'faction_projects', 'agreements', 'story_threads', 'npc_beliefs']) {
		for (const row of snapshot[table]) {
			if (plan.removed[table].has(row.id)) continue;
			const sourceEntries = sourceIds(row).filter(id => survivingEntries.has(id));
			const sourceEvents = (row.source_event_ids ?? []).filter(id => !plan.removed.story_events.has(id));
			if (sourceEntries.length !== sourceIds(row).length || sourceEvents.length !== (row.source_event_ids ?? []).length) {
				await tx.unsafe(`update ${table} set source_entry_ids=$1::jsonb, source_event_ids=$2::jsonb, server_version=$3, updated_at=$4 where story_id=$5 and id=$6`, [JSON.stringify(sourceEntries), JSON.stringify(sourceEvents), version, now, STORY_ID, row.id]);
			}
		}
	}
	async function entity(id, patch) {
		const before = snapshot.entities.find(e => e.id === id);
		assert(before, `Missing entity ${id}`);
		const after = patch(structuredClone(before));
		await tx`update entities set name=${after.name}, description=${after.description}, state=${tx.json(after.state)}, metadata=${tx.json({ ...after.metadata, chronologyRepair: marker })}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=${id}`;
	}
	await entity(CHILDREN, e => {
		e.name = 'Aurion and Zhen Lian’s infant daughters';
		e.description = 'Elaera and Yue, the infant daughters of Aurion and Empress Zhen Lian. They are still babies in the restored timeline, cared for in the upper nursery.';
		Object.assign(e.state, { ageStage: 'infant', aliases: ['Elaera', 'Yue', 'the infant daughters', 'the twins'], appearance: 'Two infants with pale silver-gold hair; one has violet eyes and the other mismatched violet and grey eyes.', presentation: 'Resting in the upper nursery, attended by their wet-nurse.', currentAction: 'Sleeping in the nursery after their father spent the day carrying and caring for them.', currentLocation: 'Yi Ti - The Forbidden City, the Inner Pavilion, the upper nursery', lastSeenLocation: 'Yi Ti - The Forbidden City, the Inner Pavilion, the upper nursery', isPresent: false, eventMemory: { did: [], saw: [], knew: [], knows: [] }, knownFacts: ['Both children are infants, not speaking or walking children.'] });
		return e;
	});
	await entity(PLAYER, e => { e.state.knownFacts = [...(e.state.knownFacts ?? []), 'Has not hatched any dragons in the restored timeline.', 'Has not met Daenerys.', 'His children with Zhen Lian are infants.']; return e; });
	await entity('import_3323efcb-3008-4ff6-adbd-eae7343d823b', e => {
		e.state.eventMemory.did = e.state.eventMemory.did.filter(line => !line.includes("Yue when she asked"));
		e.state.eventMemory.did.push('Spent the day carrying and caring for his infant daughters; promised to return to the nursery.');
		return e;
	});
	await entity(EMPRESS, e => {
		e.description = 'Vermillion Empress Zhen Lian rules Yi Ti. Aurion is her consort, and their daughters Elaera and Yue are infants in the restored timeline.';
		e.state.bio = e.description;
		e.state.background = 'Of the Zhen family; became Empress in the surviving campaign history.';
		e.state.pressures = e.state.pressures.filter(line => !/absence on campaign|separation|Aurion.s legacy/.test(line));
		e.state.knownFacts = [...e.state.knownFacts, 'Her daughters with Aurion are infants.'];
		return e;
	});
	for (const row of snapshot.story_events.filter(e => !plan.removed.story_events.has(e.id))) {
		const source = sourceIds(row).map(id => entryById.get(id)).find(e => e?.type === 'narration' && NURSERY_ACCOUNTS.has(e.position));
		if (!source) continue;
		const body = NURSERY_ACCOUNTS.get(source.position);
		await tx`update story_events set body=${body}, metadata=${tx.json({ ...row.metadata, chronologyRepair: marker })}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=${row.id}`;
		const nodeIds = snapshot.memory_nodes.filter(n => !plan.removed.memory_nodes.has(n.id) && (n.source_event_ids ?? []).includes(row.id)).map(n => n.id);
		if (nodeIds.length) await tx`update memory_nodes set content=${body}, summary=${body}, embedding=null, metadata=metadata || ${tx.json({ chronologyRepair: marker })}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=any(${nodeIds}::text[])`;
	}
	// Remove discarded-timeline pressure calculations from otherwise valid world
	// factions. Their baseline identity, resources and geography remain available.
	for (const row of snapshot.factions.filter(f => !plan.removed.factions.has(f.id))) {
		const reasons = row.metadata?.pressureReasons ?? [];
		if (!reasons.some(r => plan.removed.story_events.has(r.eventId))) continue;
		const metadata = { ...row.metadata, chronologyRepair: marker };
		delete metadata.pressureReasons; delete metadata.pressureJobId; delete metadata.pressureUpdatedAt;
		await tx`update factions set pressure=0, metadata=${tx.json(metadata)}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=${row.id}`;
	}
	const metadata = { ...snapshot.story.metadata, chronologyRepair: marker };
	// A fresh planner may operate on repaired canon; the contaminated applied
	// frame is archived in the backup, not retained as active guidance.
	metadata.plotBrain = { active: metadata.plotBrain?.active ?? true, retiredAt: now, retiredFrameId: metadata.plotBrain?.lastFrameId ?? null, retirementReason: marker.authority };
	delete metadata.sceneCheckpoint;
	const header = `${snapshot.story.header_prompt ?? ''}\n\n${CORRECTION}`;
	await tx`update stories set header_prompt=${header}, metadata=${tx.json(metadata)}, server_version=${version}, updated_at=${now} where id=${STORY_ID}`;
	const afterEntries = await tx`select * from story_entries where story_id=${STORY_ID} order by id`;
	assert.equal(hashEntries(afterEntries), plan.transcriptHash, 'Transcript changed');
	return { version, marker };
}

async function finalize(tx, snapshot) {
	assert.equal(snapshot.story.metadata?.chronologyRepair?.key, KEY);
	if (snapshot.story.metadata.chronologyRepair.finalizedAt) return { alreadyFinalized: true };
	assert(snapshot.backend_jobs.some(j => j.type === 'rebuild_summaries' && j.status === 'complete' && j.metadata?.summaryRebuild?.applied === true && (j.metadata.summaryRebuild.backupPath.includes('383f16e7-61cd-400f-a855-e8f172b346bf') || j.metadata.summaryRebuild.resumedFromJobId === 'job_383f16e7-61cd-400f-a855-e8f172b346bf')), 'Wait for the chronological summary rebuild');
	assert.equal(hashEntries(snapshot.story_entries), snapshot.story.metadata.chronologyRepair.transcriptHash, 'Story transcript changed during repair; inspect before finalizing');
	const backupPath = path.resolve('data/repairs', `${KEY}-finalize-v${snapshot.story.server_version}.json`);
	await writeFile(backupPath, JSON.stringify(snapshot), { flag: 'wx' });
	const now = new Date().toISOString();
	const version = snapshot.story.server_version + 1;
	// The transcript preserves the original mistake; working summaries follow the
	// author's explicit correction, with source IDs retained for every turn.
	const nurseryChapter = snapshot.chapters.find(c => c.number === 12);
	assert(nurseryChapter?.metadata?.sourceAccounts?.length === 20);
	const accounts = nurseryChapter.metadata.sourceAccounts.map(account => {
		const position = snapshot.story_entries.find(e => e.id === account.sourceId)?.position;
		if (!NURSERY_ACCOUNTS.has(position)) return account;
		const prefix = position === 515 ? account.summary.split('About forty paces')[0] : '';
		return { ...account, summary: `${prefix}${NURSERY_ACCOUNTS.get(position)}` };
	});
	const sceneOutcome = accounts.map(a => a.summary).join('\n\n');
	const chapterMetadata = { ...nurseryChapter.metadata, sourceAccounts: accounts, chronologyCorrection: { key: KEY, authority: 'Author clarified that the daughters are infants', at: now } };
	const openThreads = nurseryChapter.open_threads.filter(t => !/princesses.*night terrors|Yue weeping|Elaera unsoothed/i.test(t));
	await tx`update chapters set scene_outcome=${sceneOutcome}, open_threads=${tx.json(openThreads)}, metadata=${tx.json(chapterMetadata)}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=${nurseryChapter.id}`;
	await tx`update memory_nodes set content=${sceneOutcome}, summary=${sceneOutcome}, embedding=null, metadata=metadata || ${tx.json({ chronologyCorrection: KEY })}, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and metadata->>'chapterId'=${nurseryChapter.id}`;
	const liveEntryIds = new Set(snapshot.story_entries.map(e => e.id));
	const stalePatchIds = snapshot.state_patches.filter(p => sourceIds(p).length && sourceIds(p).every(id => !liveEntryIds.has(id))).map(p => p.id);
	const futureEventIds = snapshot.story_events.filter(e => !sourceIds(e).length && /299 AC/.test(e.world_time ?? '') && ['world_tick', 'faction_signal'].includes(e.type)).map(e => e.id);
	await tx`delete from state_patches where story_id=${STORY_ID} and id=any(${stalePatchIds}::text[])`;
	await tx`delete from story_events where story_id=${STORY_ID} and id=any(${futureEventIds}::text[])`;
	const memoryIds = snapshot.memory_nodes.filter(n => (n.source_event_ids ?? []).some(id => futureEventIds.includes(id))).map(n => n.id);
	await tx`delete from memory_nodes where story_id=${STORY_ID} and id=any(${memoryIds}::text[])`;
	await tx`delete from source_refs where story_id=${STORY_ID} and source_type='state_patch' and source_id=any(${stalePatchIds}::text[])`;
	// Sera the Summer Isles factor was a substring match for Serala of Volantis;
	// they are different people. Only Serala appears in the restored sources.
	assert(snapshot.story_entries.every(e => !/\bSera\b/.test(e.content)));
	await tx`delete from entities where story_id=${STORY_ID} and id='import_353247fd-4189-4558-8e66-36186398dc71'`;
	const characterUpdates = [
		['import_c1c00e3d-e07c-479f-af26-3aed15de62d1', 'Malaquo Maegyr is a Triarch of Volantis. In the surviving opening history he participated in the tariff debate and questioned Quhuru Mo about the burned ship.', { type: 'character', status: 'Triarch of Volantis', currentLocation: 'Volantis', present: false, isPresent: false, eventMemory: { did: ['Questioned Quhuru Mo about the cause of the burned ship'], saw: [], knew: [], knows: [] } }, [45, 47]],
		['import_d9651502-f8aa-450c-876b-33f5710d0e92', 'Nyessos Vhassar is a Triarch of Volantis. In the surviving opening history he challenged dock-repair funding and urged caution over accusations about the flagless black ship.', { type: 'character', status: 'Triarch of Volantis', currentLocation: 'Volantis', present: false, isPresent: false, eventMemory: { did: ['Challenged the proposed funding of dock repairs', 'Urged that enemies not be named without proof about the black ship'], saw: [], knew: [], knows: [] } }, [45, 47]],
		['import_bec5eb83-f834-4209-a219-e6771e9ecc09', 'Merged identity alias of Aurion Balaerys. Use the active Aurion record for current possessions and capabilities; the discarded later-campaign inventory does not apply.', { type: 'character', status: 'inactive', assets: [], aliases: ['Aegon Targaryen 6th'], present: false, isPresent: false }, []],
	];
	for (const [id, description, state, positions] of characterUpdates) {
		const before = snapshot.entities.find(e => e.id === id); assert(before);
		const metadata = { ...before.metadata, chronologyRepair: { key: KEY, backupPath, at: now } };
		if (id === 'import_bec5eb83-f834-4209-a219-e6771e9ecc09') metadata.mergedInto = PLAYER;
		const sources = positions.map(position => { const entry = snapshot.story_entries.find(e => e.position === position); assert(entry); return entry.id; });
		await tx`update entities set description=${description}, state=${tx.json(state)}, metadata=${tx.json(metadata)}, source_entry_ids=${tx.json(sources)}, source_event_ids='[]'::jsonb, source_patch_ids='[]'::jsonb, server_version=${version}, updated_at=${now} where story_id=${STORY_ID} and id=${id}`;
	}
	for (const table of ['entities', 'factions', 'faction_memberships', 'faction_resources', 'faction_goals', 'faction_projects', 'agreements', 'story_threads', 'story_events', 'npc_beliefs', 'memory_nodes']) {
		for (const row of snapshot[table]) {
			if (!(row.source_patch_ids ?? []).some(id => stalePatchIds.includes(id))) continue;
			const ids = row.source_patch_ids.filter(id => !stalePatchIds.includes(id));
			await tx.unsafe(`update ${table} set source_patch_ids=$1::jsonb where story_id=$2 and id=$3`, [JSON.stringify(ids), STORY_ID, row.id]);
		}
	}
	const metadata = { ...snapshot.story.metadata, chronologyRepair: { ...snapshot.story.metadata.chronologyRepair, finalizedAt: now, finalBackupPath: backupPath, discardedPatchCount: stalePatchIds.length, discardedWorldEvents: futureEventIds } };
	const previousHeader = snapshot.story.header_prompt.split('\n\nRestored-story continuity correction, supplied by the author')[0];
	await tx`update stories set header_prompt=${`${previousHeader}\n\n${CORRECTION}`}, metadata=${tx.json(metadata)}, server_version=${version}, updated_at=${now} where id=${STORY_ID}`;
	return { backupPath, version, discardedPatchCount: stalePatchIds.length, discardedWorldEvents: futureEventIds.length };
}

export async function main() {
	const db = postgres(databaseUrl(), { max: 1, prepare: false });
	try {
		await db.begin(async tx => {
			const snapshot = await readSnapshot(tx);
			if (process.argv.includes('--finalize')) { console.log(JSON.stringify(await finalize(tx, snapshot))); return; }
			if (snapshot.story.metadata?.chronologyRepair?.key === KEY) { console.log('Already applied.'); return; }
			const plan = buildPlan(snapshot);
			console.log(JSON.stringify({ mode: process.argv.includes('--apply') ? 'apply' : 'dry-run', storyId: STORY_ID, version: snapshot.story.server_version, counts: plan.counts, transcriptHash: plan.transcriptHash }));
			if (!process.argv.includes('--apply')) return;
			const backupPath = path.resolve('data/repairs', `${KEY}-v${snapshot.story.server_version}.json`);
			await mkdir(path.dirname(backupPath), { recursive: true });
			await writeFile(backupPath, JSON.stringify(snapshot), { flag: 'wx' });
			console.log(JSON.stringify({ backupPath, ...await apply(tx, snapshot, plan, backupPath) }));
		});
	} finally { await db.end({ timeout: 1 }); }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
