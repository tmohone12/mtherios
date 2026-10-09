import assert from 'node:assert/strict';
import test from 'node:test';
import {
	ARMOR_AGREEMENT_ID,
	ARMOR_PROMISE_ID,
	AZURE_THRONE_FACTION_ID,
	AZURE_THRONE_PRESSURE_MEMORY_ID,
	MEI_LIN_ID,
	TRUTH_STONE_WARNING_ID,
	UNSAFE_FRAME_ID,
	VALYRIAN_FACTION_ID,
	VALYRIAN_MOVE_ID,
	VALYRIAN_MOVE_MEMORY_ID,
	VALYRIAN_PRESSURE_MEMORY_ID,
	VALYRIAN_SIGNAL_ID,
	YI_TI_FACTION_ID,
	YI_TI_PRESSURE_MEMORY_ID,
	assertNoActiveJobs,
	buildV3Plan,
	reconcileAgreement,
	normalizeCeremonyEvent,
	sanitizeMeiLinMetadata,
	sanitizeMeiLinState,
} from './repair-veil-live-lore-v3.mjs';

const now = '2026-09-01T04:00:00.000Z';

test('accepts an empty postgres Result-shaped job collection', () => {
	class Result extends Array {}
	assert.doesNotThrow(() => assertNoActiveJobs(new Result()));
	assert.throws(() => assertNoActiveJobs(new Result({ id: 'job_1' })), /active Veil jobs block/);
});

test('sanitizes stale character deadlines and synthetic timeline copies while preserving affinity', () => {
	const state = {
		knownFacts: ['Stable fact.', 'The truth-stone rite will occur tomorrow, and the player must keep his sword hand open and still.'],
		eventMemory: {
			did: ['Direct lived memory', 'promise: Armor polishing before dawn - stale projection', 'scheme: Truth-stone rite, date not fixed - duplicated event'],
			saw: ['reveal: A projected reveal', 'the river below'],
		},
		relationship: { level: 16, history: [{ delta: 2 }] },
		affinity: { trust: 4 },
	};
	const repaired = sanitizeMeiLinState(state);
	assert.doesNotMatch(JSON.stringify(repaired), /tomorrow|before dawn|scheme:|reveal:/i);
	assert.match(JSON.stringify(repaired), /court has not fixed the ceremony date/i);
	assert.match(JSON.stringify(repaired), /Promised to arrange hand-polishing/i);
	assert.deepEqual(repaired.relationship, state.relationship);
	assert.deepEqual(repaired.affinity, state.affinity);
	const metadata = sanitizeMeiLinMetadata({ originalMetadata: { knownFacts: state.knownFacts, npcEventMemory: state.eventMemory } });
	assert.doesNotMatch(JSON.stringify(metadata), /tomorrow|before dawn|scheme:|reveal:/i);
});

test('normalizes witnessed ceremony records without treating them as overdue work', () => {
	const agreement = normalizeCeremonyEvent({ id: ARMOR_AGREEMENT_ID, title: 'Armor polishing arranged', body: 'Offer', status: 'due', created_turn: 288, occurred_turn: null, scheduled_turn: 289, world_time: '15:18', metadata: {} }, now);
	const promise = normalizeCeremonyEvent({ id: ARMOR_PROMISE_ID, title: 'Armor polishing before dawn', body: 'Stale', status: 'due', created_turn: 291, occurred_turn: null, scheduled_turn: 292, world_time: 'before dawn', metadata: {} }, now);
	const warning = normalizeCeremonyEvent({ id: TRUTH_STONE_WARNING_ID, title: 'Truth-stone ceremony warning', body: 'Warning', status: 'committed', created_turn: 290, occurred_turn: 293, scheduled_turn: 291, world_time: '15:19', metadata: {} }, now);
	for (const event of [agreement, warning]) {
		assert.equal(event.status, 'committed');
		assert.equal(event.scheduled_turn, null);
	}
	assert.equal(promise.status, 'cancelled');
	assert.equal(promise.scheduled_turn, null);
	assert.equal(agreement.occurred_turn, 288);
	assert.equal(promise.occurred_turn, null);
	assert.equal(warning.occurred_turn, 293);
	assert.doesNotMatch(JSON.stringify(promise), /before dawn/i);
});

test('archives superseded deadline agreements and keeps one undated canonical betrothal', () => {
	assert.equal(reconcileAgreement({ id: 'agreement_ae42f56c-6ec1-47e3-956b-9b74a1dea1d7', status: 'active', terms: 'before next water-clock' }).status, 'archived');
	const canonical = reconcileAgreement({ id: 'agreement_2cbcd45d-4530-47b7-871c-761b1e61fa9b', status: 'active', terms: 'old' });
	assert.equal(canonical.status, 'active');
	assert.match(canonical.terms, /has not fixed a ceremony date/i);
});

function snapshot() {
	const event = (id, extra = {}) => ({ id, type: 'promise', title: id, body: 'body', status: 'committed', created_turn: 1, occurred_turn: 1, scheduled_turn: null, world_time: null, metadata: {}, server_version: 10, ...extra });
	return {
		story: {
			id: 'story', title: 'Veil', server_version: 1015, current_turn: 301, current_world_time: 'Day First Moon 29, 296 AC | 15:28',
			metadata: {
				plotBrain: { active: false, lastFrameId: UNSAFE_FRAME_ID, lastFrame: { id: UNSAFE_FRAME_ID }, retiredPlotDirectives: [] },
				loreIntegrityRepairs: { veil_lore_integrity_v1: { applied: true }, veil_lore_integrity_v2: { applied: true } },
			},
		},
		entity: { id: MEI_LIN_ID, state: { knownFacts: ['The truth-stone rite will occur tomorrow, and the player must keep his sword hand open and still.'], eventMemory: { did: ['promise: Armor polishing before dawn - stale'] }, relationship: { level: 16 } }, metadata: {}, server_version: 10 },
		events: [
			event(ARMOR_AGREEMENT_ID, { status: 'due', scheduled_turn: 289, created_turn: 288 }),
			event(ARMOR_PROMISE_ID, { status: 'due', scheduled_turn: 292, created_turn: 291, title: 'Armor polishing before dawn' }),
			event(TRUTH_STONE_WARNING_ID, { scheduled_turn: 291, occurred_turn: 293 }),
			event(VALYRIAN_MOVE_ID, { type: 'faction_move', source_entry_ids: [] }),
			event(VALYRIAN_SIGNAL_ID, { type: 'faction_signal', status: 'due', scheduled_turn: 259, source_entry_ids: [] }),
		],
		factions: [AZURE_THRONE_FACTION_ID, YI_TI_FACTION_ID, VALYRIAN_FACTION_ID].map((id) => ({ id, pressure: 68, metadata: { sourceType: 'character_faction_tag', factionName: id, worldSimEnabled: true, currentStoryEvidence: true, pressureReasons: [{ delta: 5 }] }, server_version: 10 })),
		memberships: [0, 1, 2, 3, 4].map((index) => ({ id: `membership_${index}`, status: 'active', metadata: {}, server_version: 10 })),
		memories: [
			{ id: AZURE_THRONE_PRESSURE_MEMORY_ID, title: 'Azure Throne pressure', content: 'poison', summary: 'poison', keywords: ['Azure'], importance: 0.9, visibility: 'secret', metadata: { factionName: 'Azure Throne' }, server_version: 10 },
			{ id: YI_TI_PRESSURE_MEMORY_ID, title: 'Yi Ti pressure', content: 'poison', summary: 'poison', keywords: ['Yi Ti'], importance: 0.9, visibility: 'secret', metadata: { factionName: 'Yi Ti' }, server_version: 10 },
			{ id: VALYRIAN_MOVE_MEMORY_ID, title: 'move', content: 'poison', summary: 'poison', keywords: ['Valyrian'], importance: 0.9, visibility: 'secret', metadata: {}, server_version: 10 },
			{ id: VALYRIAN_PRESSURE_MEMORY_ID, title: 'pressure', content: 'poison', summary: 'poison', keywords: ['Valyrian'], importance: 0.8, visibility: 'secret', metadata: {}, server_version: 10 },
		],
		agreements: [
			{ id: 'agreement_263f8488-df64-46cc-94a5-4b4d0a095d5a', status: 'active', terms: 'blood test', server_version: 10 },
			{ id: 'agreement_7e472cec-b7c5-4f49-ac94-26ec2b6d526e', status: 'active', terms: 'same hour', server_version: 10 },
			{ id: 'agreement_ae42f56c-6ec1-47e3-956b-9b74a1dea1d7', status: 'active', terms: 'next water clock', server_version: 10 },
			{ id: 'agreement_2cbcd45d-4530-47b7-871c-761b1e61fa9b', status: 'active', terms: 'betrothal', server_version: 10 },
		],
		activeJobs: [],
		invariants: { entry_count: 609, min_position: 0, max_position: 608, transcript_md5: 'x', affinity_md5: 'y' },
	};
}

test('builds an idempotent guarded v3 plan that retires the recurrence sources', () => {
	const input = snapshot();
	const plan = buildV3Plan(input, now);
	assert.equal(plan.newVersion, 1016);
	assert.ok(plan.factions.every(({ after }) => after.pressure === 0 && after.metadata.worldSimEnabled === false && after.metadata.nonCanon === true));
	assert.ok(plan.memberships.every(({ after }) => after.status === 'archived' && after.metadata.nonCanon === true));
	assert.equal(plan.agreements.filter(({ after }) => after.status === 'active').length, 1);
	assert.ok(plan.autoTagEvents.every(({ after }) => after.status === 'cancelled' && after.metadata.superseded === true));
	assert.ok(plan.memories.every(({ after }) => after.importance === 0 && after.metadata.nonCanon === true));
	assert.equal(plan.storyMetadata.plotBrain.lastFrameId, null);
	assert.equal(plan.storyMetadata.plotBrain.active, false);
	assert.equal(plan.storyMetadata.plotBrain.lastFrame, undefined);
	assert.doesNotMatch(JSON.stringify({
		entityState: plan.entity.state,
		ceremonyEvents: plan.ceremonyEvents.map(({ after }) => after),
		plotBrain: plan.storyMetadata.plotBrain,
	}), /truth-stone rite will occur tomorrow|armor polishing before dawn/i);

	const repeated = snapshot();
	repeated.story.metadata.loreIntegrityRepairs.veil_lore_integrity_v3 = { applied: true };
	assert.equal(buildV3Plan(repeated, now).alreadyApplied, true);
});
