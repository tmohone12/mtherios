import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
	assertNoRunningRepairJobs,
	assertQuarantineComplete,
	buildPlan,
	campaignFileRowsToDelete,
	correctEntryContent,
	previewSummary,
	quarantineVaultFiles,
	repairJobGuardSummary,
	sanitizeChapter18Text,
	sanitizeProjectionText,
} from './repair-veil-live-lore.mjs';

function sha256(value) {
	return createHash('sha256').update(value).digest('hex');
}

test('corrects only the contradictory sentence in narration 592', () => {
	const before = 'prefix It is not tomorrow. We have a single night before they come for you. That is not much time, but it is ours, and it is more than the court would ever grant. suffix';
	const after = correctEntryContent(592, before);
	assert.equal(after, 'prefix The court has not fixed the date. That leaves us some time. It is ours, and it is more privacy than the court would ordinarily grant. suffix');
});

test('corrects only the contradictory sentence in narration 604', () => {
	const before = 'prefix If he bows too deeply tomorrow, it is because he has heard a hundred stories already and believes half of them. suffix';
	const after = correctEntryContent(604, before);
	assert.equal(after, 'prefix When he bows too deeply at the ceremony, it is because he has heard a hundred stories already and believes half of them. suffix');
});

test('sanitizes derived deadline and claimant projections idempotently', () => {
	const before = "Truth-stone rite tomorrow. Morning ceremony preparations. There is a third claimant who will hear of your bow by nightfall. He will call it an insult to the Son of Heaven and a western barbarism.";
	const once = sanitizeProjectionText(before);
	assert.doesNotMatch(once, /tomorrow|morning ceremony|third claimant/i);
	assert.equal(sanitizeProjectionText(once), once);
});

test('sanitizes chapter 18 stranger and immediate-timing projections without erasing the accepted betrothal', () => {
	const before = [
		"- clue_discovery: A Stranger's Inquiry - A veiled figure asks discreet questions about Aegon's arrival, seeking to confirm if he received a certain message.",
		'- agreement: Betrothal Rites - Bu Gai expects the player to kneel and accept the rites of betrothal in the sight of the Azure Throne, likely immediately or very soon.',
		'- agreement: create agreement - Aurion accepts the marriage offer.',
	].join('\n');
	const after = sanitizeChapter18Text(before);
	assert.doesNotMatch(after, /Stranger's Inquiry|veiled figure|immediately or very soon/i);
	assert.match(after, /Betrothal Accepted/);
	assert.match(after, /ceremony date is not fixed/);
	assert.match(after, /Aurion accepts the marriage offer/);
});

test('quarantine re-inspects exact targets and a retry safely accepts the now-absent source', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'mtherios-veil-quarantine-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourcePath = path.join(root, 'vault', 'poison.md');
	const backupPath = path.join(root, 'backup');
	const content = 'verified poison payload';
	await mkdir(path.dirname(sourcePath), { recursive: true });
	await writeFile(sourcePath, content, 'utf8');
	const target = { sourcePath, sha256: sha256(content), status: 'absent' };

	const first = await quarantineVaultFiles([target], backupPath);
	assert.equal(first[0].status, 'quarantined');
	assertQuarantineComplete(first);
	await assert.rejects(stat(sourcePath), { code: 'ENOENT' });
	assert.equal(await readFile(first[0].destination, 'utf8'), content);

	const retry = await quarantineVaultFiles([target], backupPath);
	assert.equal(retry[0].status, 'already_absent');
	assertQuarantineComplete(retry);
});

test('quarantine refuses changed content and cannot be reported complete', async (t) => {
	const root = await mkdtemp(path.join(tmpdir(), 'mtherios-veil-quarantine-changed-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const sourcePath = path.join(root, 'vault', 'poison.md');
	await mkdir(path.dirname(sourcePath), { recursive: true });
	await writeFile(sourcePath, 'changed after commit', 'utf8');

	const results = await quarantineVaultFiles([{ sourcePath, sha256: sha256('verified poison payload'), status: 'exact_poison_match' }], path.join(root, 'backup'));
	assert.equal(results[0].status, 'not_quarantined_content_changed');
	assert.throws(() => assertQuarantineComplete(results), /vault quarantine incomplete/);
	assert.equal(await readFile(sourcePath, 'utf8'), 'changed after commit');
});

test('job guard blocks running work and selects every queued or retry job for supersession', () => {
	const rows = [
		{ id: 'job_running', type: 'evaluate_world_sim_tick', status: 'running', payload: { serverVersion: 1007 } },
		{ id: 'job_queued', type: 'extract_turn_state', status: 'queued', payload: { serverVersion: 1007 } },
		{ id: 'job_retry', type: 'plan_plot_brain', status: 'retry', payload: { serverVersion: 1007 } },
		{ id: 'job_complete', type: 'sync_story_vault', status: 'complete', payload: { serverVersion: 1007 } },
	];
	const summary = repairJobGuardSummary(rows);
	assert.deepEqual(summary.runningBlockerIds, ['job_running']);
	assert.deepEqual(summary.supersedeCandidateIds, ['job_queued', 'job_retry']);
	assert.throws(() => assertNoRunningRepairJobs(summary), /job_running/);
	assert.doesNotThrow(() => assertNoRunningRepairJobs(repairJobGuardSummary(rows.slice(1))));
});

test('campaign file deletion plan accepts only the exact stored poison hash', () => {
	const exact = {
		id: 'campaign_file_poison',
		path: 'raw/turns/000513-a63e894a-e82f-4137-83cf-9e20db1a09db.md',
		content_hash: '311499834e7715a6b3cedf4b5121ad92b301ef325f58c0fcf3b5aa6da6110836',
		server_version: 1007,
	};
	assert.deepEqual(campaignFileRowsToDelete([exact]), [{ before: exact }]);
	assert.throws(() => campaignFileRowsToDelete([{ ...exact, content_hash: 'changed' }]), /content hash changed/);
});

test('full repair plan cancels the unsupported stranger chain and preview proves no active poison across the global projection scan', () => {
	const strangerEventId = 'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_message_that_drew_aegon_east_a794b3016d9e';
	const chapter18Id = 'chapter_entry_1e9a7ff5_a9d7_4015_9c59_73e32c6796a9_narration_fa6d3e10_61c7_475c_86f2_8cf40bb8eb88';
	const chapter20Id = 'chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41ee_narration_e10ac3ec_3482_4f0d_af75_391fe576a3a7';
	const arcId = 'arc_chapter_entry_7950bc74_ccc8_48be_871f_7ab2b05cc363_narration_3cf38465_f2f9_4712_9c00_429a72b80f34_chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41e_1a2360afc867';
	const dragonThreadId = 'plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_dragon_throne_alliance';
	const shadowThreadId = 'plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_god_empress_s_shadow';
	const patchIds = [
		'patch_8d1d2043-ec00-49a0-9d05-62aaee653f71',
		'patch_3261dafc-0f0f-4bca-b181-555b09940337',
		'patch_6aee457c-9afc-4286-aeb4-3a6c1f862d3c',
		'patch_6d4ec93d-f19a-48e9-9317-6a8ae2d39585',
		'patch_b6211d21-c86e-4c0d-b707-5f1559e90949',
	];
	const old592 = 'It is not tomorrow. We have a single night before they come for you. That is not much time, but it is ours, and it is more than the court would ever grant.';
	const old604 = 'If he bows too deeply tomorrow, it is because he has heard a hundred stories already and believes half of them.';
	const immediate = "agreement: Betrothal Rites - Bu Gai expects the player to kneel and accept the rites of betrothal in the sight of the Azure Throne, likely immediately or very soon.";
	const stranger = "clue_discovery: A Stranger's Inquiry - A veiled figure asks discreet questions about Aegon's arrival, seeking to confirm if he received a certain message.";
	const snapshot = {
		story: {
			id: 'story_52d7c651-0b16-4b91-890d-e7f226f7926b',
			title: 'Veil',
			server_version: 1007,
			current_turn: 299,
			current_world_time: 'Day First Moon 29, 296 AC | 15:26',
			metadata: { plotBrain: { lastFrame: { id: 'f891112a-7e8f-4f74-a632-f312aa226d75', directives: ["A Stranger's Inquiry"] } } },
		},
		activeBackendJobs: [],
		entries: [
			{ id: 'entry_8d65e584-b90d-4228-a452-53918f963c08', position: 591, content: 'The ceremony is not tomorrow.', content_md5: 'ac8bbd00dbb026f7e9a19d2847785217', metadata: {} },
			{ id: 'narration_8d65e584-b90d-4228-a452-53918f963c08', position: 592, content: old592, content_md5: '38c1868227ff75a8ea34c719c550e97b', metadata: {} },
			{ id: 'narration_a02594c6-2d72-4831-b889-c402a375d8de', position: 604, content: old604, content_md5: '6df6c83aaf0dc0cbf847d806421a4ae0', metadata: {} },
		],
		entities: [
			{ id: 'veil_entity_aurion_belaerys', state: { currentAction: "Following A Stranger's Inquiry", traits: ['unattached'] }, metadata: {}, description: '' },
			{ id: 'veil_entity_bu_gai', state: { present: true }, metadata: {}, description: '' },
			{ id: 'veil_entity_mei_lin', state: { eventMemory: { saw: [immediate] } }, metadata: {}, description: '' },
		],
		factions: [
			{ id: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_house_belaerys', name: 'House Belaerys tag', pressure: 3, goals: [], resources: {}, metadata: {} },
			{ id: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_god_empress', name: 'God Empress tag', pressure: 0, goals: [], resources: {}, metadata: {} },
			{ id: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_azure_throne', name: 'Azure Throne', pressure: 55, goals: [], resources: {}, metadata: { pressureReasons: [{ eventId: strangerEventId, delta: 4 }] } },
			{ id: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_yi_ti', name: 'Yi Ti tag', pressure: 64, goals: [], resources: {}, metadata: { pressureReasons: [{ eventId: strangerEventId, delta: 4 }] } },
			{ id: 'veil_faction_golden_empire_yi_ti', name: 'Golden Empire of Yi Ti', pressure: 40, goals: [], resources: {}, metadata: { pressureReasons: [{ eventId: strangerEventId, delta: 4 }] } },
			{ id: 'veil_faction_house_belaerys', name: 'House Belaerys', pressure: 0, goals: [], resources: {}, metadata: {} },
			{ id: 'veil_faction_imperial_court_leng', name: 'Imperial Court of Leng', pressure: 0, goals: [], resources: {}, metadata: {} },
		],
		projects: [
			{ id: 'project_house', status: 'active', metadata: {} },
			{ id: 'project_god', status: 'active', metadata: {} },
		],
		threads: [
			{ id: dragonThreadId, status: 'open', description: 'The betrothal ceremony is set for morning.', source_event_ids: [strangerEventId] },
			{ id: shadowThreadId, status: 'open', description: 'An agent will sabotage the dragon egg.', source_event_ids: [] },
		],
		events: [{
			id: strangerEventId,
			status: 'due',
			title: "A Stranger's Inquiry",
			body: "A veiled figure asks discreet questions about Aegon's arrival.",
			thread_ids: [],
			source_entry_ids: ['entry_1571c893-4068-4a0b-9d43-b201085056df'],
			metadata: { plotBrain: true },
			scheduled_turn: 261,
		}],
		memories: [{
			id: `mem_chapter_${chapter18Id}`,
			content: `- ${stranger}\n- ${immediate}`,
			summary: stranger,
			importance: 0.7,
			visibility: 'player_known',
			source_entry_ids: [],
			source_event_ids: [strangerEventId],
			metadata: {},
		}],
		chapters: [
			{ id: chapter18Id, number: 18, scene_outcome: `- ${stranger}\n- ${immediate}`, open_threads: ["A Stranger's Inquiry", 'Betrothal Rites'], source_event_ids: [strangerEventId], metadata: {} },
			{ id: chapter20Id, number: 20, scene_outcome: 'Morning ceremony preparations', promises_debts_oaths: ['Morning marriage rite and bow ceremony', 'Armor polishing before dawn', 'Morning ceremony preparations'], open_threads: [], source_event_ids: [], metadata: {} },
		],
		arcs: [{ id: arcId, summary: 'Supported arc summary.', source_event_ids: [strangerEventId], metadata: { characterArcs: [{ development: `Chapter 18: ${stranger}` }] } }],
		statePatches: patchIds.map((id, index) => ({
			id,
			status: 'applied',
			operations: [{ op: 'upsert', path: '/story_events/timeline', value: { title: ['Public Betrothal Imminent', 'Truth-stone rite tomorrow', 'Morning marriage rite and bow ceremony', 'Morning ceremony preparations', "Third claimant hears of Aurion's bow"][index] } }],
			metadata: {},
		})),
		proposals: [
			{ id: 'proposal_chapter_character_context_story_52d7c651_0b16_4b91_890d_e7f226f7926b_chapter_entry_20f42c55_3e9c_4ec6_bf0d_7d2cba2c8383_narration_3049c2e7_21c2_442f_b274_d29e2abb22ca_veil_e_d2ecd25264d6', status: 'approved', decision: 'approved', metadata: {} },
			{ id: 'proposal_chapter_character_context_story_52d7c651_0b16_4b91_890d_e7f226f7926b_chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41ee_narration_e10ac3ec_3482_4f0d_af75_391fe576a3a7_veil_entity_mei_lin', status: 'approved', decision: 'approved', metadata: {} },
		],
		facts: [],
		campaignFiles: [],
		activeProjectionScan: [
			{ kind: 'event', id: strangerEventId, text: `${stranger}\nA Stranger's Inquiry` },
			{ kind: 'chapter', id: chapter18Id, text: `${stranger}\n${immediate}` },
			{ kind: 'arc', id: arcId, text: stranger },
			{ kind: 'state_patch', id: patchIds[0], text: 'Public Betrothal Imminent' },
			{ kind: 'entity', id: 'valid_yi_ti_lore', text: 'Yi Ti has rival claimants in source tradition.' },
		],
		invariants: {
			preserved_count: 604,
			min_position: 0,
			max_position: 604,
			identity_md5: '4809a19a4419b19684af78ee83ae3b16',
			untouched_content_md5: 'fixture',
			affinity_md5: 'fixture',
		},
	};
	const plan = buildPlan(snapshot, '2026-08-31T00:00:00.000Z');
	const strangerEvent = plan.eventChanges.find(({ after }) => after.id === strangerEventId)?.after;
	assert.equal(strangerEvent?.status, 'cancelled');
	assert.equal(plan.statePatchChanges.every(({ after }) => after.operations.length === 0), true);
	assert.doesNotMatch(JSON.stringify(plan.chapterChanges.map(({ after }) => after)), /Stranger's Inquiry|immediately or very soon/i);
	assert.doesNotMatch(JSON.stringify(plan.chapterChanges.map(({ after }) => after.promises_debts_oaths)), /morning marriage|before dawn|morning ceremony/i);
	assert.doesNotMatch(JSON.stringify(plan.arcChanges.map(({ after }) => after)), /Stranger's Inquiry|immediately or very soon/i);
	assert.doesNotMatch(JSON.stringify(plan.memoryChanges.map(({ after }) => after)), /Stranger's Inquiry|immediately or very soon/i);
	const preview = previewSummary(snapshot, plan, [], 'backup-root');
	assert.equal(preview.ok, true);
	assert.equal(preview.activePoisonBefore.length > 0, true);
	assert.deepEqual(preview.activePoisonAfter, []);
	assert.equal(preview.preserved.transcriptEntriesDeleted, 0);
	assert.equal(preview.counts.statePatchesSanitized, 5);
	assert.equal(preview.jobGuard.runningBlockerCount, 0);
	assert.equal(preview.jobGuard.supersedeCandidateCount, 0);
	const blockedPreview = previewSummary({
		...snapshot,
		activeBackendJobs: [{ id: 'job_running', type: 'evaluate_world_sim_tick', status: 'running', payload: { serverVersion: 1007 } }],
	}, plan, [], 'backup-root');
	assert.equal(blockedPreview.ok, false);
	assert.deepEqual(blockedPreview.jobGuard.runningBlockerIds, ['job_running']);
});
