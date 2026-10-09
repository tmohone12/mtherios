// Real API/DB checks in a disposable campaign. Never edits an existing story or calls an LLM.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

const db = postgres(databaseUrl(), { max: 1 });
const baseUrl = process.env.MTHERIOS_TEST_URL ?? 'http://127.0.0.1:5174';
let keepUiFixture = false;
const storyId = `test_plot_editor_${randomUUID()}`;
const threadId = `${storyId}_old`;
const nextId = `${storyId}_new`;
const eventId = `${storyId}_future`;
const historyId = `${storyId}_past`;
const frame = {
	id: `${storyId}_frame`, storyId, plotCards: [
		{ id: 'old', title: 'Old pressure', logline: 'Obsolete blockade.', storyThreadId: threadId, lifecycleStage: 'simmer' },
		{ id: 'new', title: 'New pressure', logline: 'Negotiation proceeds.', storyThreadId: nextId, lifecycleStage: 'simmer' },
	], activationPlan: { activateNow: ['old', 'new'] },
};
async function command(args, expectFailure = false, name = 'plot.edit') {
	const response = await fetch(`${baseUrl}/api/engine/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ storyId, command: name, clientCommandId: randomUUID(), args }) });
	const body = await response.json();
	assert.equal(body.status, expectFailure ? 'failed' : 'succeeded', JSON.stringify(body));
	return body;
}
async function story() { return (await db`select * from stories where id = ${storyId}`)[0]; }
async function thread(id) { return (await db`select * from story_threads where story_id = ${storyId} and id = ${id}`)[0]; }
const threadEdit = (serverVersion, status) => ({ target: 'thread', serverVersion, threadId, description: 'Player corrected this thread.', status, significance: 'major' });
try {
	await db`insert into stories (id, title, current_turn, metadata) values (${storyId}, 'Disposable plot editor verification', 5, ${db.json({ keep: 'unrelated metadata', plotBrain: { active: true, lastFrame: frame, lastFrameId: frame.id, lastFrameTurn: 5, pendingFrame: { ...frame, id: `${frame.id}_pending` }, pendingFrameId: `${frame.id}_pending`, pendingBaseServerVersion: 1 } })})`;
	await db`insert into story_threads (id, story_id, description) values (${threadId}, ${storyId}, 'Old pressure'), (${nextId}, ${storyId}, 'New pressure')`;
	await db`insert into story_events (id, story_id, type, status, title, body, thread_ids, metadata) values (${eventId}, ${storyId}, 'plot_pressure', 'scheduled', 'Future beat', 'Unplayed.', ${db.json([threadId])}, ${db.json({ plotBrain: true })}), (${historyId}, ${storyId}, 'plot_pressure', 'committed', 'Past event', 'Already happened.', ${db.json([threadId])}, ${db.json({ plotBrain: true })})`;
	await command(threadEdit(1, 'closed'));
	assert.equal((await thread(threadId)).status, 'closed');
	assert.equal((await thread(threadId)).closure_reason.startsWith('[player:closed]'), true);
	let saved = await story();
	assert.equal(saved.server_version, 2); assert.equal(saved.metadata.keep, 'unrelated metadata');
	assert.deepEqual(saved.metadata.plotBrain.lastFrame.plotCards.map(card => card.id), ['new']);
	assert.equal(saved.metadata.plotBrain.pendingBaseServerVersion, 1, 'A modified draft must remain stale.');
	assert.equal((await db`select status from story_events where id = ${eventId}`)[0].status, 'cancelled');
	assert.equal((await db`select status from story_events where id = ${historyId}`)[0].status, 'committed');
	await command(threadEdit(1, 'open'), true);
	assert.equal((await story()).server_version, 2);
	await command(threadEdit(2, 'open'));
	assert.equal((await thread(threadId)).closure_reason, null);
	assert.equal((await story()).metadata.plotBrain.closedThreadIds.includes(threadId), false);
	await command(threadEdit(3, 'deleted'));
	assert.equal((await thread(threadId)).closure_reason.startsWith('[player:deleted]'), true);
	saved = await story();
	let edited = structuredClone(saved.metadata.plotBrain.lastFrame);
	edited.plotCards[0].logline = 'A corrected negotiation.';
	await command({ target: 'applied', serverVersion: 4, frameId: frame.id, frame: edited });
	assert.equal((await thread(nextId)).description, 'New pressure: A corrected negotiation.');
	assert.equal((await story()).metadata.plotBrain.lastFrameTurn, 5, 'Editing must not reset freshness.');
	saved = await story();
	await command({ target: 'pending', serverVersion: 5, frameId: saved.metadata.plotBrain.pendingFrameId, frame: saved.metadata.plotBrain.pendingFrame }, true);
	await db`update stories set metadata = jsonb_set(metadata, '{plotBrain,pendingBaseServerVersion}', '5') where id = ${storyId}`;
	saved = await story();
	const pending = saved.metadata.plotBrain.pendingFrame;
	pending.publicSummary = 'Edited pending only.';
	await command({ target: 'pending', serverVersion: 5, frameId: pending.id, frame: pending });
	saved = await story();
	assert.equal(saved.metadata.plotBrain.pendingBaseServerVersion, 6);
	assert.equal(saved.metadata.plotBrain.lastFrame.plotCards[0].logline, 'A corrected negotiation.');
	await command({ target: 'applied', serverVersion: 6, frameId: frame.id, frame: { ...edited, storyId: 'another_story' } }, true);
	edited.plotCards = []; edited.activationPlan.activateNow = [];
	await command({ target: 'applied', serverVersion: 6, frameId: frame.id, frame: edited });
	assert.equal((await thread(nextId)).closure_reason.startsWith('[player:deleted]'), true);
	assert.equal((await db`select count(*)::int as count from state_patches where story_id = ${storyId}`)[0].count, 6);
	const schemeId = `${storyId}_scheme`;
	const agreementId = `${storyId}_agreement`;
	const scheme = { target: 'scheme', serverVersion: 7, recordId: schemeId, goal: 'A corrected scheme.', trigger: 'A promise.', status: 'abandoned', secrecy: 'secret', pressure: 57, currentStageIndex: 0, stages: [{ index: 0, label: 'New stage', hook: 'A corrected hook.', condition: 'time', conditionPayload: { day: 3 }, completed: false, completedAt: null }] };
	await db`insert into story_threads (id, story_id, description) values (${schemeId}, ${storyId}, 'Old scheme')`;
	await db`insert into memory_nodes (id, story_id, type, title, content, thread_ids, metadata) values (${`mem_scheme_${schemeId}`}, ${storyId}, 'plot_ledger', 'Old scheme', 'Old scheme', ${db.json([schemeId])}, ${db.json({ sourceType: 'scheme_import', preserve: true, legacyRecord: { id: schemeId, ownerName: 'Ada', ownerEntryId: 'ada', ownerType: 'character', createdAt: 100, branchId: 'original_branch', ...scheme } })})`;
	await db`insert into agreements (id, story_id, category, terms, parties) values (${agreementId}, ${storyId}, 'promise', 'Old promise', ${db.json(['Ada', 'Captain'])})`;
	await command(scheme);
	assert.equal((await thread(schemeId)).status, 'closed');
	let node = (await db`select * from memory_nodes where id = ${`mem_scheme_${schemeId}`}`)[0];
	assert(node, 'Editing a scheme must preserve its canonical memory-node record.');
	assert.equal(node.metadata.legacyRecord.status, 'abandoned');
	assert.equal(node.metadata.legacyRecord.branchId, 'original_branch');
	assert.equal(node.metadata.preserve, true);
	assert.equal(node.visibility, 'secret');
	await command({ ...scheme, serverVersion: 8, status: 'active' });
	assert.equal((await thread(schemeId)).status, 'open');
	assert.equal((await thread(schemeId)).significance, 'major');
	assert.match((await thread(schemeId)).description, /corrected hook/);
	const agreement = { target: 'agreement', serverVersion: 9, recordId: agreementId, terms: 'Deliver the cargo.', parties: ['Ada', 'Captain'], category: 'contract', status: 'active', secrecy: 'secret', consequences: ['Payment due.'] };
	await command(agreement);
	await command({ ...agreement, serverVersion: 10, parties: 'Ada' }, true);
	await command({ ...agreement, serverVersion: 10, status: 'fulfilled' });
	const listing = (await command({}, false, 'plot.commitments')).result;
	assert.equal(listing.serverVersion, 11);
	assert.equal(listing.agreements.find(row => row.id === agreementId).status, 'fulfilled');
	assert.deepEqual(listing.agreements.find(row => row.id === agreementId).parties, ['Ada', 'Captain']);
	assert.equal(listing.schemes.find(row => row.id === schemeId).status, 'active');
	await command({ ...scheme, serverVersion: 9 }, true);
	await command({ ...scheme, serverVersion: 11, currentStageIndex: 5 }, true);
	assert.equal((await story()).server_version, 11);
	const deletion = (kind, recordId, action, serverVersion) => ({ target: 'commitment', kind, recordId, action, serverVersion });
	const linkedId = `${storyId}_agreement_pressure`;
	const linkedEventId = `${storyId}_agreement_future`;
	await db`insert into story_threads (id, story_id, description) values (${linkedId}, ${storyId}, 'Pressure from the wrong agreement')`;
	await db`insert into story_events (id, story_id, type, status, title, body, thread_ids) values (${linkedEventId}, ${storyId}, 'plot_pressure', 'scheduled', 'Wrong obligation', 'Not played.', ${db.json([linkedId])})`;
	const linkedFrame = { ...frame, plotCards: [{ ...frame.plotCards[0], storyThreadId: linkedId, sourceRefs: [{ sourceType: 'agreement', sourceId: agreementId, label: 'Wrong agreement' }] }] };
	await db`update stories set metadata = jsonb_set(jsonb_set(metadata, '{plotBrain,lastFrame}', ${db.json(linkedFrame)}), '{plotBrain,pendingFrame}', ${db.json(linkedFrame)}) where id = ${storyId}`;
	await command(deletion('agreement', agreementId, 'delete', 11));
	assert.equal((await thread(linkedId)).status, 'closed');
	assert.equal((await story()).metadata.plotBrain.lastFrame.plotCards.length, 0);
	assert.equal((await story()).metadata.plotBrain.pendingFrame.plotCards.length, 0);
	assert.equal((await db`select status from story_events where id = ${linkedEventId}`)[0].status, 'cancelled');
	await command(deletion('scheme', schemeId, 'delete', 12));
	let deletedListing = (await command({}, false, 'plot.commitments')).result;
	assert.equal(deletedListing.agreements.find(row => row.id === agreementId).deleted, true);
	assert.equal(deletedListing.schemes.find(row => row.id === schemeId).deleted, true);
	assert.equal((await thread(schemeId)).closure_reason.startsWith('[player:deleted]'), true);
	await command({ ...agreement, serverVersion: 13 }, true);
	await command({ ...scheme, serverVersion: 13 }, true);
	await command(deletion('scheme', schemeId, 'restore', 12), true);
	const bootstrap = (await command({ includeSecret: true }, false, 'campaign.bootstrap')).result;
	assert.equal(bootstrap.agreements.some(row => row.id === agreementId), false);
	assert.equal(bootstrap.memoryNodes.some(row => row.id === `mem_scheme_${schemeId}`), false);
	const recall = (await command({ query: '', includeSecret: true, sourceTypes: ['plot_ledger'] }, false, 'memory.retrieve')).result;
	assert.equal(recall.nodes.some(row => row.id === `mem_scheme_${schemeId}` || row.id.includes(agreementId)), false);
	await command(deletion('agreement', agreementId, 'restore', 13));
	await command(deletion('scheme', schemeId, 'restore', 14));
	deletedListing = (await command({}, false, 'plot.commitments')).result;
	assert.equal(deletedListing.agreements.find(row => row.id === agreementId).status, 'fulfilled');
	assert.equal(deletedListing.schemes.find(row => row.id === schemeId).deleted, false);
	assert.equal((await thread(schemeId)).status, 'open');
	assert.equal((await db`select status from story_events where id = ${eventId}`)[0].status, 'cancelled');
	assert.equal((await db`select status from story_events where id = ${historyId}`)[0].status, 'committed');
	console.log('PASS: recoverable commitment deletion, hidden bootstrap context, deleted-edit/stale rejection, original-status restoration, history and cancelled-event preservation.');
	console.log('PASS: threads, Director, agreement and scheme edits; status/history, arrays, stage validation, secrecy, linked records, stale/cross-story rejection, and metadata/audit preservation.');
	keepUiFixture = process.argv.includes('--keep-ui-fixture');
} finally {
	// Exact ID created above; cascades remove only this disposable verification campaign.
	if (keepUiFixture) console.log(`UI fixture retained for manual verification; delete this exact story afterward: ${storyId}`);
	else await db`delete from stories where id = ${storyId}`;
	await db.end();
}
