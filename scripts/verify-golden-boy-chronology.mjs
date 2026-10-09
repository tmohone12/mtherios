import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';
import { STORY_ID } from './repair-golden-boy-chronology.mjs';

const db = postgres(databaseUrl(), { max: 1, prepare: false });
try {
	const [story] = await db`select * from stories where id=${STORY_ID}`;
	const entries = await db`select id,position,type,content,parent_id,branch_id from story_entries where story_id=${STORY_ID} order by id`;
	const transcriptHash = createHash('sha256').update(JSON.stringify(entries.map(r => [r.id,r.position,r.type,r.content,r.parent_id,r.branch_id]))).digest('hex');
	assert.equal(transcriptHash, story.metadata.chronologyRepair.transcriptHash);
	assert(story.metadata.chronologyRepair.finalizedAt);
	const chapters = await db`select * from chapters where story_id=${STORY_ID} order by number`;
	const arcs = await db`select * from arcs where story_id=${STORY_ID} order by number`;
	assert.equal(chapters.length, 12);
	assert.equal(arcs.length, 1);
	const entryIds = new Set(entries.map(e => e.id));
	let lastPosition = -1;
	const accountIds = [];
	for (const chapter of chapters) {
		assert.equal(chapter.metadata.turnCount, 20);
		assert.equal(chapter.metadata.sourceAccounts.length, 20);
		assert(chapter.metadata.startPosition > lastPosition);
		lastPosition = chapter.metadata.endPosition;
		assert(chapter.source_entry_ids.every(id => entryIds.has(id)));
		for (const account of chapter.metadata.sourceAccounts) { assert(entryIds.has(account.sourceId)); accountIds.push(account.sourceId); }
	}
	assert.equal(new Set(accountIds).size, 240);
	assert.deepEqual(arcs[0].chapter_ids, chapters.slice(0,10).map(c => c.id));
	assert(chapters[11].metadata.chronologyCorrection);
	assert.match(chapters[11].scene_outcome, /two infant daughters rested/);
	assert.doesNotMatch(chapters[11].scene_outcome, /asked twice if their father|wept of fire and falling|child's wordless five-note humming/);
	const [children] = await db`select * from entities where story_id=${STORY_ID} and id='import_ce4fbfad-5489-401f-a549-e4fe4af30c7b'`;
	assert.equal(children.state.ageStage, 'infant');
	assert.match(children.description, /infant/);
	assert.equal((await db`select id from entities where story_id=${STORY_ID} and name in ('Aer','Gaelyx','Sera')`).length, 0);
	assert.equal((await db`select id from story_events where story_id=${STORY_ID} and world_time like '%299 AC%'`).length, 0);
	assert(!story.metadata.plotBrain?.lastFrame);
	for (const table of ['story_events','state_patches','memory_nodes']) {
		const rows = await db.unsafe(`select id,source_entry_ids from ${table} where story_id=$1`, [STORY_ID]);
		assert(rows.every(r => !r.source_entry_ids.length || r.source_entry_ids.some(id => entryIds.has(id))), `${table}: no discarded-history-only sources`);
	}
	const response = await fetch(`http://127.0.0.1:5174/api/debug/prompt-packet/${STORY_ID}?q=current%20scene&tokenBudget=2400`);
	assert(response.ok);
	const packet = await response.json();
	await writeFile('.codex-run/golden-boy-context-verified.json', JSON.stringify(packet, null, 2));
	const system = packet.prompt.system;
	assert.match(system, /Aurion has not hatched any dragons/);
	assert.match(system, /children are infants/);
	assert.match(system, /Aurion has not met Daenerys/);
	assert.match(system, /not a permanent ban on future events/);
	const result = { ok: true, storyId: STORY_ID, serverVersion: story.server_version, transcriptEntries: entries.length, transcriptHash, chapters: chapters.length, arcs: arcs.length, chronologicallyAccountedTurns: accountIds.length, remainingTurns: 14, correctionsInLiveSystemPrompt: true };
	await writeFile('.codex-run/golden-boy-repair-verification.json', JSON.stringify(result, null, 2));
	console.log(JSON.stringify(result));
} finally { await db.end({ timeout: 1 }); }
