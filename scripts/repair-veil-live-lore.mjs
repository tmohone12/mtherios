#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

export const STORY_ID = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const STORY_SLUG = STORY_ID.replaceAll('_', '-');
const REPAIR_KEY = 'veil_lore_integrity_v1';
const EXPECTED_FRAME_ID = 'f891112a-7e8f-4f74-a632-f312aa226d75';
const CORRECTION_ENTRY_ID = 'entry_8d65e584-b90d-4228-a452-53918f963c08';
const CORRECTION_FACT_ID = 'veil_fact_betrothal_date_not_fixed';
const CORRECTION_MEMORY_ID = 'veil_memory_betrothal_date_not_fixed';
const DATE_CORRECTION = 'Aurion accepted Bu Gai\'s offer of betrothal to Princess Mei-Lin. The court has not fixed the ceremony date, and the ceremony is not tomorrow.';

const TARGET_ENTRY_GUARDS = new Map([
	[591, { id: CORRECTION_ENTRY_ID, md5: 'ac8bbd00dbb026f7e9a19d2847785217' }],
	[592, { id: 'narration_8d65e584-b90d-4228-a452-53918f963c08', md5: '38c1868227ff75a8ea34c719c550e97b' }],
	[604, { id: 'narration_a02594c6-2d72-4831-b889-c402a375d8de', md5: '6df6c83aaf0dc0cbf847d806421a4ae0' }],
]);
const TRANSCRIPT_IDENTITY_0_604 = '4809a19a4419b19684af78ee83ae3b16';

const BAD_THREAD_IDS = {
	dragon: 'plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_dragon_throne_alliance',
	shadow: 'plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_god_empress_s_shadow',
};
const PROJECT_IDS = {
	house: 'faction_project_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b__bf73accf',
	godEmpress: 'faction_project_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b__85ed3c2e',
};
const FACTION_IDS = {
	houseTag: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_house_belaerys',
	godEmpressTag: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_god_empress',
	houseCanon: 'veil_faction_house_belaerys',
	lengCanon: 'veil_faction_imperial_court_leng',
	azure: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_azure_throne',
	yiTi: 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_yi_ti',
	yiTiCanon: 'veil_faction_golden_empire_yi_ti',
};
const ENTITY_IDS = {
	aurion: 'veil_entity_aurion_belaerys',
	buGai: 'veil_entity_bu_gai',
	meiLin: 'veil_entity_mei_lin',
};
const CHAPTER_IDS = {
	eighteen: 'chapter_entry_1e9a7ff5_a9d7_4015_9c59_73e32c6796a9_narration_fa6d3e10_61c7_475c_86f2_8cf40bb8eb88',
	twenty: 'chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41ee_narration_e10ac3ec_3482_4f0d_af75_391fe576a3a7',
};
const CHAPTER_MEMORY_IDS = new Set(Object.values(CHAPTER_IDS).map((id) => `mem_chapter_${id}`));
const ARC_ID = 'arc_chapter_entry_7950bc74_ccc8_48be_871f_7ab2b05cc363_narration_3cf38465_f2f9_4712_9c00_429a72b80f34_chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41e_1a2360afc867';
const STRANGER_EVENT_ID = 'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_message_that_drew_aegon_east_a794b3016d9e';
const POISON_PATCH_IDS = new Set([
	'patch_8d1d2043-ec00-49a0-9d05-62aaee653f71',
	'patch_3261dafc-0f0f-4bca-b181-555b09940337',
	'patch_6aee457c-9afc-4286-aeb4-3a6c1f862d3c',
	'patch_6d4ec93d-f19a-48e9-9317-6a8ae2d39585',
	'patch_b6211d21-c86e-4c0d-b707-5f1559e90949',
]);
const PROPOSAL_IDS = [
	'proposal_chapter_character_context_story_52d7c651_0b16_4b91_890d_e7f226f7926b_chapter_entry_20f42c55_3e9c_4ec6_bf0d_7d2cba2c8383_narration_3049c2e7_21c2_442f_b274_d29e2abb22ca_veil_e_d2ecd25264d6',
	'proposal_chapter_character_context_story_52d7c651_0b16_4b91_890d_e7f226f7926b_chapter_entry_d33faa63_e50b_43d8_8760_3b494a9d41ee_narration_e10ac3ec_3482_4f0d_af75_391fe576a3a7_veil_entity_mei_lin',
];

const STANDALONE_CANCEL_EVENT_IDS = new Set([
	STRANGER_EVENT_ID,
	'event_ce5afb57-7aaf-4015-8b97-beac8392e72a',
	'event_07887f05-44db-4c1e-ae87-36b9ddbbe37d',
	'event_03894722-7c91-4edf-828a-4b80af04d1a3',
	'event_bf016f74-41cb-45c4-912b-1d555ea6b829',
	'event_0a36c86b-b199-4f52-a7ad-5c2b17b110a7',
	'event_3ff830ea-b448-4372-bdc7-42d65721bdb7',
	'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_dragon_throne_alliance_4eee5e68a66c',
	'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_dragon_throne_alliance_a313e926dc18',
	'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_god_empress_s_shadow_acac9a822e57',
	'plot_event_story_52d7c651_0b16_4b91_890d_e7f226f7926b_plot_thread_story_52d7c651_0b16_4b91_890d_e7f226f7926b_the_god_empress_s_shadow_97b9ae7b4262',
	'event_world_tick_story_52d7c651_0b16_4b91_890d_e7f226f7926b_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_azure_throne_protect_and_advance_azure_throne_s_i_6353751ca637',
]);
const DERIVED_REWRITE_ENTRY_IDS = new Set([
	'narration_5c19fc90-4271-4891-9dd4-f691e80894d6',
	'narration_6d9b0413-3a6b-4ccd-9b85-8f0f3108c4b6',
	'narration_e10ac3ec-3482-4f0d-af75-391fe576a3a7',
	'narration_8d65e584-b90d-4228-a452-53918f963c08',
	'narration_a02594c6-2d72-4831-b889-c402a375d8de',
]);

const PRESSURE_MEMORY_IDS = new Map([
	[`mem_faction_pressure_${FACTION_IDS.azure}`, FACTION_IDS.azure],
	[`mem_faction_pressure_${FACTION_IDS.yiTi}`, FACTION_IDS.yiTi],
	[`mem_faction_pressure_${FACTION_IDS.yiTiCanon}`, FACTION_IDS.yiTiCanon],
	[`mem_faction_pressure_${FACTION_IDS.houseTag}`, FACTION_IDS.houseTag],
	[`mem_faction_pressure_${FACTION_IDS.godEmpressTag}`, FACTION_IDS.godEmpressTag],
]);

const ORPHAN_VAULT_FILES = [
	{
		campaignPath: 'raw/turns/000513-a63e894a-e82f-4137-83cf-9e20db1a09db.md',
		relativePath: `vaults/campaigns/${STORY_SLUG}/raw/turns/000513-a63e894a-e82f-4137-83cf-9e20db1a09db.md`,
		sha256: '311499834e7715a6b3cedf4b5121ad92b301ef325f58c0fcf3b5aa6da6110836',
		reason: 'pre-correction raw rendering that still says the God-Empress governs Yi Ti',
	},
	{
		campaignPath: 'raw/turns/000515-beee6061-d694-442f-ae4b-d5512129e821.md',
		relativePath: `vaults/campaigns/${STORY_SLUG}/raw/turns/000515-beee6061-d694-442f-ae4b-d5512129e821.md`,
		sha256: 'c9aeb0de15613d5c9df4c957bea84f9918bf13224463c2e54a522442b5301abb',
		reason: 'discarded pre-reset turn that contradicts the retained position 515',
	},
];

const ORPHAN_VAULT_BY_CAMPAIGN_PATH = new Map(ORPHAN_VAULT_FILES.map((item) => [item.campaignPath, item]));

const ENTRY_592_OLD = 'It is not tomorrow. We have a single night before they come for you. That is not much time, but it is ours, and it is more than the court would ever grant.';
const ENTRY_592_NEW = 'The court has not fixed the date. That leaves us some time. It is ours, and it is more privacy than the court would ordinarily grant.';
const ENTRY_604_OLD = 'If he bows too deeply tomorrow, it is because he has heard a hundred stories already and believes half of them.';
const ENTRY_604_NEW = 'When he bows too deeply at the ceremony, it is because he has heard a hundred stories already and believes half of them.';

const ACTIVE_POISON = /(?:A Stranger's Inquiry|veiled figure asks discreet questions|betrothal ceremony is set for morning|truth-stone rite tomorrow|morning marriage rite|morning ceremony preparations|public betrothal imminent|announced before evening|likely immediately or very soon|single night before they come for you|bows too deeply tomorrow|tomorrow you will stand in the middle|may still die tomorrow|third claimant|rival claimant[^.]{0,160}(?:aurion|aegon|bow|betrothal|denounc)|(?:aurion|aegon|bow|betrothal|denounc)[^.]{0,160}rival claimant|denounc\w*[^.]{0,100}(?:aurion|aegon|bow)|sabotag\w*[^.]{0,100}dragon egg|lengii agent[^.]{0,160}(?:palace servant|dragon egg))/i;

function asObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function unique(values) {
	return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function repairJobDescriptor(row) {
	const payloadVersion = asObject(row.payload).serverVersion;
	return {
		id: row.id,
		type: row.type,
		status: row.status,
		runAfter: row.run_after ?? null,
		lockedAt: row.locked_at ?? null,
		lockedBy: row.locked_by ?? null,
		serverVersion: payloadVersion != null && Number.isFinite(Number(payloadVersion))
			? Number(payloadVersion)
			: null,
	};
}

export function repairJobGuardSummary(rows) {
	const active = asArray(rows);
	const running = active.filter((row) => row?.status === 'running');
	const supersedeable = active.filter((row) => row?.status === 'queued' || row?.status === 'retry');
	return {
		runningBlockerCount: running.length,
		runningBlockerIds: running.map((row) => row.id),
		runningBlockers: running.map(repairJobDescriptor),
		supersedeCandidateCount: supersedeable.length,
		supersedeCandidateIds: supersedeable.map((row) => row.id),
		supersedeCandidates: supersedeable.map(repairJobDescriptor),
	};
}

export function assertNoRunningRepairJobs(summary) {
	assert.equal(
		summary.runningBlockerCount,
		0,
		`refusing repair while Veil backend jobs are running: ${summary.runningBlockerIds.join(', ')}`,
	);
}

export function campaignFileRowsToDelete(rows) {
	return asArray(rows).map((before) => {
		const target = ORPHAN_VAULT_BY_CAMPAIGN_PATH.get(before.path);
		assert.ok(target, `unexpected guarded campaign_files path: ${before.path}`);
		assert.equal(before.content_hash, target.sha256, `campaign_files content hash changed for ${before.path}`);
		return { before };
	});
}

function md5(value) {
	return createHash('md5').update(String(value)).digest('hex');
}

async function sha256File(filePath) {
	return createHash('sha256').update(await readFile(filePath)).digest('hex');
}

function replaceExactlyOnce(text, before, after, label) {
	const first = text.indexOf(before);
	const last = text.lastIndexOf(before);
	assert.notEqual(first, -1, `${label}: guarded sentence is missing`);
	assert.equal(first, last, `${label}: guarded sentence occurs more than once`);
	return `${text.slice(0, first)}${after}${text.slice(first + before.length)}`;
}

export function correctEntryContent(position, content) {
	if (position === 592) return replaceExactlyOnce(content, ENTRY_592_OLD, ENTRY_592_NEW, 'entry 592');
	if (position === 604) return replaceExactlyOnce(content, ENTRY_604_OLD, ENTRY_604_NEW, 'entry 604');
	return content;
}

export function sanitizeProjectionText(value) {
	if (typeof value !== 'string' || !value) return value;
	return value
		.replaceAll(ENTRY_592_OLD, ENTRY_592_NEW)
		.replaceAll(ENTRY_604_OLD, ENTRY_604_NEW)
		.replace(/(?:Chapter 18:\s*)?clue_discovery:\s*A Stranger's Inquiry\s*-\s*A veiled figure asks discreet questions about Aegon's arrival, seeking to confirm if he received a certain message\.?/gi, '')
		.replace(/Bu Gai expects the player to kneel and accept the rites of betrothal in the sight of the Azure Throne, likely immediately or very soon\.?/gi, 'Aurion accepted Bu Gai\'s offer of betrothal to Princess Mei-Lin; the ceremony date is not fixed.')
		.replace(/Bu Gai agrees to arrange unions with lower noble houses if the player proves commitment, and insists on the public betrothal rites first\.?/gi, 'Bu Gai agrees to arrange unions with lower noble houses if the player proves commitment. Aurion\'s betrothal to Mei-Lin is accepted, with no ceremony date fixed.')
		.replace(/“?There is a third claimant who will hear of your bow by nightfall\.[\s\S]{0,600}?cost of standing\.”?/gi, 'No competing claimant or court denouncement is established by retained evidence.')
		.replaceAll('Then tomorrow you will stand in the middle of a room full of men', 'When the ceremony is held, you will stand in the middle of a room full of men')
		.replaceAll('Then I will tell you why you may still die tomorrow', 'Then I will tell you why the ceremony could still turn dangerous')
		.replace(/There is a third claimant who will hear of your bow by nightfall\. He will call it an insult to the Son of Heaven and a western barbarism\./gi, 'No competing claimant or court denouncement is established by retained evidence.')
		.replace(/Her tone is not warning; it is certainty\. [“"]And there are men in my father’s own court who will agree, quietly, while they smile at the(?: wedding feast\.)?[”"]?/gi, '')
		.replace(/Third claimant hears of Aurion's bow/gi, 'No competing claimant established')
		.replace(/Truth-stone rite tomorrow/gi, 'Truth-stone rite, date not fixed')
		.replace(/Morning marriage rite and bow ceremony/gi, 'Marriage rite and bow ceremony, date not fixed')
		.replace(/Morning ceremony preparations/gi, 'Ceremony preparations, date not fixed')
		.replace(/Armor polishing before dawn/gi, 'Armor polishing before ceremony, date not fixed')
		.replaceAll('before dawn, when they come to prepare the player', 'before the ceremony, once its date is fixed')
		.replaceAll('returned before dawn, when they come to prepare the player', 'returned before the ceremony, once its date is fixed')
		.replace(/the order of the morning/gi, 'the order of the ceremony');
}

export function sanitizeChapter18Text(value) {
	if (typeof value !== 'string' || !value) return value;
	return value.split(/\r?\n/)
		.filter((line) => !/^\s*-\s*(?:clue_discovery:\s*)?A Stranger's Inquiry\b/i.test(line))
		.filter((line) => !/^\s*-\s*(?:reveal:\s*)?Public Betrothal Imminent\b/i.test(line))
		.map((line) => sanitizeProjectionText(line).replace(
			/- agreement: Betrothal Rites - Aurion accepted Bu Gai's offer of betrothal to Princess Mei-Lin; the ceremony date is not fixed\./i,
			'- agreement: Betrothal Accepted - Aurion accepted Bu Gai\'s offer of betrothal to Princess Mei-Lin; the ceremony date is not fixed.',
		))
		.filter((line) => line.trim() !== '-')
		.join('\n');
}

function sanitizeNested(value) {
	if (typeof value === 'string') return sanitizeChapter18Text(value);
	if (Array.isArray(value)) return value
		.filter((item) => typeof item !== 'string' || item.length > 500 || !/(?:A Stranger's Inquiry|third claimant|rival claimant|Blood Test and Kneeling Rite|sabotag\w*[^.]{0,100}dragon egg|Lengii agent)/i.test(item))
		.map(sanitizeNested);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeNested(item)]));
}

const BAD_PATCH_TIMELINE_TITLES = new Set([
	'Public Betrothal Imminent',
	'Betrothal Rites',
	'Morning marriage rite and bow ceremony',
	'Third claimant hears of Aurion\'s bow',
	'Truth-stone rite tomorrow',
	'Morning ceremony preparations',
]);

function sanitizePatchNested(value) {
	if (typeof value === 'string') {
		if (value === 'Armor polishing before dawn') return 'Armor polishing before the ceremony';
		if (value === 'before dawn') return 'before the ceremony, once its date is fixed';
		if (value === 'tomorrow morning') return 'date not fixed';
		if (value === 'Sitting on a stone bench at the pool\'s edge, discussing the morning ceremony') return 'Sitting on a stone bench at the pool\'s edge, discussing the ceremony whose date is not fixed';
		if (value === 'Discussion about the sword Dragons Maw and its implications for the morning ceremony') return 'Discussion about the sword Dragons Maw and its implications for the ceremony whose date is not fixed';
		return sanitizeChapter18Text(value);
	}
	if (Array.isArray(value)) return value
		.filter((item) => typeof item !== 'string' || item.length > 500 || !/(?:third claimant|rival claimant)/i.test(item))
		.map(sanitizePatchNested);
	if (!value || typeof value !== 'object') return value;
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizePatchNested(item)]));
}

function parseArgs(argv) {
	const args = { apply: false, json: false, expectedVersion: null, dataRoot: path.resolve('data'), backupDir: path.resolve('exports/repairs/veil-live-lore-integrity') };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--apply') args.apply = true;
		else if (arg === '--preview') args.apply = false;
		else if (arg === '--json') args.json = true;
		else if (arg === '--expected-version') args.expectedVersion = Number(argv[++index]);
		else if (arg.startsWith('--expected-version=')) args.expectedVersion = Number(arg.slice('--expected-version='.length));
		else if (arg === '--data-root') args.dataRoot = path.resolve(argv[++index]);
		else if (arg.startsWith('--data-root=')) args.dataRoot = path.resolve(arg.slice('--data-root='.length));
		else if (arg === '--backup-dir') args.backupDir = path.resolve(argv[++index]);
		else if (arg.startsWith('--backup-dir=')) args.backupDir = path.resolve(arg.slice('--backup-dir='.length));
		else if (arg === '--help' || arg === '-h') {
			console.log('Usage: node scripts/repair-veil-live-lore.mjs [--preview] [--json]\n       node scripts/repair-veil-live-lore.mjs --apply --expected-version <previewVersion> [--backup-dir <path>]');
			process.exit(0);
		} else throw new Error(`Unknown argument: ${arg}`);
	}
	if (args.apply && (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 1)) {
		throw new Error('--apply requires --expected-version from a fresh preview.');
	}
	return args;
}

async function loadInvariants(db) {
	const [entries] = await db`
		select
			count(*) filter (where position <= 604)::int as preserved_count,
			min(position) filter (where position <= 604) as min_position,
			max(position) filter (where position <= 604) as max_position,
			md5(string_agg(position::text || ':' || id, '|' order by position, id) filter (where position <= 604)) as identity_md5,
			md5(string_agg(position::text || ':' || id || ':' || md5(content), '|' order by position, id) filter (where position <= 604 and position not in (592, 604))) as untouched_content_md5
		from story_entries where story_id = ${STORY_ID}`;
	const [affinity] = await db`
		select md5(coalesce(string_agg(payload, '|' order by sort_key), '')) as affinity_md5 from (
			select 'entity:' || id as sort_key,
				coalesce((state -> 'relationship')::text, 'null') || ':' || coalesce((state -> 'affinity')::text, 'null') || ':' ||
				coalesce((state -> 'relationshipHistory')::text, 'null') || ':' || coalesce((state -> 'affinityHistory')::text, 'null') as payload
			from entities where story_id = ${STORY_ID}
			union all
			select 'relationship:' || id, row_to_json(r)::text from relationships r where story_id = ${STORY_ID}
		) guarded`;
	return { ...entries, affinity_md5: affinity.affinity_md5 };
}

async function loadSnapshot(db, lockStory = false) {
	const storyRows = lockStory
		? await db`select * from stories where id = ${STORY_ID} for update`
		: await db`select * from stories where id = ${STORY_ID}`;
	assert.equal(storyRows.length, 1, `Veil story ${STORY_ID} was not found`);
	const story = storyRows[0];
	const activeBackendJobs = lockStory
		? await db`select * from backend_jobs where story_id = ${STORY_ID} and status in ('queued', 'retry', 'running') order by run_after, created_at, id for update`
		: await db`select * from backend_jobs where story_id = ${STORY_ID} and status in ('queued', 'retry', 'running') order by run_after, created_at, id`;
	const entries = await db`select *, md5(content) as content_md5 from story_entries where story_id = ${STORY_ID} and position in (591, 592, 604) order by position`;
	const entities = await db`select * from entities where story_id = ${STORY_ID} and id in ${db(Object.values(ENTITY_IDS))}`;
	const factions = await db`select * from factions where story_id = ${STORY_ID} and id in ${db(Object.values(FACTION_IDS))}`;
	const projects = await db`select * from faction_projects where story_id = ${STORY_ID} and id in ${db(Object.values(PROJECT_IDS))}`;
	const threads = await db`select * from story_threads where story_id = ${STORY_ID} and id in ${db(Object.values(BAD_THREAD_IDS))}`;
	const allEvents = await db`select * from story_events where story_id = ${STORY_ID}`;
	const projectMoveIds = new Set(allEvents
		.filter((event) => Object.values(PROJECT_IDS).includes(asObject(event.metadata).projectId))
		.map((event) => event.id));
	const targetEvents = allEvents.filter((event) => {
		const metadata = asObject(event.metadata);
		const sourceEntries = asArray(event.source_entry_ids);
		const threadIds = asArray(event.thread_ids);
		return STANDALONE_CANCEL_EVENT_IDS.has(event.id)
			|| Object.values(PROJECT_IDS).includes(metadata.projectId)
			|| projectMoveIds.has(metadata.sourceFactionMoveEventId)
			|| threadIds.includes(BAD_THREAD_IDS.shadow)
			|| threadIds.includes(BAD_THREAD_IDS.dragon)
			|| sourceEntries.some((id) => DERIVED_REWRITE_ENTRY_IDS.has(id));
	});
	const targetEventIds = new Set(targetEvents.map((event) => event.id));
	for (const event of allEvents) {
		if (targetEventIds.has(asObject(event.metadata).sourceFactionMoveEventId)) {
			targetEventIds.add(event.id);
			targetEvents.push(event);
		}
	}
	const memoryIds = unique([
		...CHAPTER_MEMORY_IDS,
		CORRECTION_MEMORY_ID,
		...PRESSURE_MEMORY_IDS.keys(),
		...[...targetEventIds].map((id) => `mem_world_tick_${id}`),
		...[...targetEventIds].map((id) => `mem_event_${id}`),
	]);
	const memories = await db`
		select * from memory_nodes where story_id = ${STORY_ID} and (
			id in ${db(memoryIds)}
			or exists (select 1 from jsonb_array_elements_text(source_event_ids) ref(value) where ref.value in ${db([...targetEventIds])})
			or exists (select 1 from jsonb_array_elements_text(source_entry_ids) ref(value) where ref.value in ${db([...DERIVED_REWRITE_ENTRY_IDS])})
		)`;
	const chapters = await db`select * from chapters where story_id = ${STORY_ID} and id in ${db(Object.values(CHAPTER_IDS))} order by number`;
	const arcs = await db`select * from arcs where story_id = ${STORY_ID} and id = ${ARC_ID}`;
	const statePatches = await db`select * from state_patches where story_id = ${STORY_ID} and id in ${db([...POISON_PATCH_IDS])} order by id`;
	const activeProjectionScan = await db`
		select 'thread'::text as kind, id, description as text from story_threads
		where story_id = ${STORY_ID} and status = 'open'
		union all
		select 'event', id, concat_ws(E'\n', title, body, metadata::text) from story_events
		where story_id = ${STORY_ID} and status in ('committed', 'proposed', 'scheduled', 'due')
			and coalesce(metadata ->> 'superseded', 'false') <> 'true'
		union all
		select 'memory', id, concat_ws(E'\n', title, content, summary, metadata::text) from memory_nodes
		where story_id = ${STORY_ID} and importance > 0
			and coalesce(metadata ->> 'superseded', 'false') <> 'true'
		union all
		select 'chapter', id, concat_ws(E'\n', scene_outcome, open_threads::text, metadata::text) from chapters
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'arc', id, concat_ws(E'\n', summary, metadata::text) from arcs
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'saga', id, concat_ws(E'\n', summary, lingering_threads::text, metadata::text) from sagas
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'entity', id, concat_ws(E'\n', description, state::text, metadata::text) from entities
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'faction', id, concat_ws(E'\n', name, goals::text, resources::text, metadata::text) from factions
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'faction_project', id, concat_ws(E'\n', project, risks::text, metadata::text) from faction_projects
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'state_patch', id, concat_ws(E'\n', reason, operations::text) from state_patches
		where story_id = ${STORY_ID} and status <> 'rejected'
		union all
		select 'fact', id, concat_ws(E'\n', title, statement, metadata::text) from facts
		where story_id = ${STORY_ID} and status = 'active'
		union all
		select 'agreement', id, concat_ws(E'\n', terms, consequences::text) from agreements
		where story_id = ${STORY_ID} and status <> 'archived'
		union all
		select 'npc_belief', id, belief from npc_beliefs
		where story_id = ${STORY_ID}
		union all
		select 'faction_goal', id, concat_ws(E'\n', goal, metadata::text) from faction_goals
		where story_id = ${STORY_ID} and coalesce(metadata ->> 'nonCanon', metadata ->> 'non_canon', 'false') <> 'true'
		union all
		select 'patch_proposal', id, concat_ws(E'\n', reason, suggestion, operations::text, metadata::text) from patch_proposals
		where story_id = ${STORY_ID} and status in ('pending', 'needs_review')`;
	const proposals = await db`select * from patch_proposals where story_id = ${STORY_ID} and id in ${db(PROPOSAL_IDS)}`;
	const facts = await db`select * from facts where story_id = ${STORY_ID} and id = ${CORRECTION_FACT_ID}`;
	const campaignFiles = await db`select * from campaign_files where story_id = ${STORY_ID} and path in ${db(ORPHAN_VAULT_FILES.map((item) => item.campaignPath))} order by path, id`;
	return {
		story,
		activeBackendJobs,
		entries,
		entities,
		factions,
		projects,
		threads,
		events: [...new Map(targetEvents.map((event) => [event.id, event])).values()],
		memories,
		chapters,
		arcs,
		statePatches,
		activeProjectionScan,
		proposals,
		facts,
		campaignFiles,
		invariants: await loadInvariants(db),
	};
}

function repairMetadata(metadata, now, reason, extra = {}) {
	return { ...asObject(metadata), loreIntegrityRepair: { key: REPAIR_KEY, at: now, reason }, ...extra };
}

function cancelRow(row, now, reason) {
	return {
		...row,
		status: 'cancelled',
		scheduled_turn: null,
		metadata: repairMetadata(row.metadata, now, reason, { superseded: true, supersededByEntryId: CORRECTION_ENTRY_ID }),
	};
}

function correctedEntity(row, now) {
	const state = sanitizeNested(structuredClone(asObject(row.state)));
	const metadata = repairMetadata(row.metadata, now, 'replace stale compact character state with retained post-reset scene truth');
	if (row.id === ENTITY_IDS.aurion) {
		state.bio = 'A young Valyrian noble and expedition commander, secretly Aegon Targaryen. In Yin, he publicly accepted Bu Gai\'s offer of betrothal to Princess Mei-Lin; the ceremony date is not fixed.';
		state.background = state.bio;
		state.goals = ['Build an honest bond with Princess Mei-Lin while negotiating the accepted betrothal on terms that preserve his sovereignty.'];
		state.motivations = [...state.goals];
		state.traits = asArray(state.traits).filter((trait) => String(trait).toLowerCase() !== 'unattached');
		state.currentAction = 'Speaking privately with Princess Mei-Lin after accepting their betrothal; the ceremony date is not fixed.';
		state.currentLocation = 'Yin — The Low Water-Garden, Summit Terrace';
		state.currentLocationId = 'entity_2e839377-36b0-4ffb-a0a8-2823ccb1b954';
		state.lastSeenLocation = state.currentLocation;
		return { ...row, description: state.bio, state, metadata };
	}
	if (row.id === ENTITY_IDS.buGai) {
		state.present = false;
		state.isPresent = false;
		state.currentAction = null;
		state.currentLocation = 'Yin — Imperial palace (off-scene)';
		state.currentLocationId = null;
		return { ...row, state, metadata };
	}
	if (row.id === ENTITY_IDS.meiLin) {
		state.present = true;
		state.isPresent = true;
		state.currentAction = 'Speaking privately with Aurion in the Low Water-Garden after accepting the betrothal; no ceremony date has been fixed.';
		state.currentLocation = 'Yin — The Low Water-Garden, Summit Terrace';
		state.currentLocationId = 'entity_2e839377-36b0-4ffb-a0a8-2823ccb1b954';
		return { ...row, state, metadata };
	}
	return row;
}

function correctedFaction(row, cancelledEventIds, now) {
	const metadata = structuredClone(asObject(row.metadata));
	const reasons = asArray(metadata.pressureReasons);
	const removedReasons = reasons.filter((reason) => cancelledEventIds.has(reason?.eventId));
	metadata.pressureReasons = reasons.filter((reason) => !cancelledEventIds.has(reason?.eventId));
	let pressure = Math.max(0, Number(row.pressure) - removedReasons.reduce((sum, reason) => sum + Math.max(0, Number(reason?.delta) || 0), 0));
	if (row.id === FACTION_IDS.houseTag || row.id === FACTION_IDS.godEmpressTag) {
		metadata.worldSimEnabled = false;
		metadata.currentStoryEvidence = false;
		metadata.nonCanon = true;
		metadata.nonCanonReason = 'Unsupported duplicate auto-tag projection superseded by a sourced canonical faction.';
		metadata.projectionStatus = 'superseded_duplicate_auto_tag';
		metadata.supersededByFactionId = row.id === FACTION_IDS.houseTag ? FACTION_IDS.houseCanon : FACTION_IDS.lengCanon;
		metadata.lastWorldSimTickEventId = null;
		metadata.lastWorldSimSignalEventId = null;
		metadata.lastWorldSimTickTurn = null;
		pressure = 0;
	}
	return { ...row, pressure, metadata: repairMetadata(metadata, now, 'remove unsupported autonomous pressure and disable duplicate auto-tag simulation') };
}

function sanitizeChapter(row, cancelledEventIds, now) {
	if (row.id === CHAPTER_IDS.eighteen) {
		const openThreads = asArray(row.open_threads)
			.filter((item) => !/^(?:A Stranger's Inquiry|Public Betrothal Imminent)$/i.test(String(item).trim()))
			.map((item) => /^Betrothal Rites$/i.test(String(item).trim())
				? 'Betrothal accepted; ceremony date not fixed'
				: sanitizeChapter18Text(String(item)));
		let sceneOutcome = sanitizeChapter18Text(String(row.scene_outcome));
		sceneOutcome += `\n\n[CANON CORRECTION = ${DATE_CORRECTION} Source: transcript position 591; this supersedes unsupported immediate timing in this older rollup.]`;
		return {
			...row,
			scene_outcome: sceneOutcome,
			promises_debts_oaths: unique(asArray(row.promises_debts_oaths).map((item) => sanitizeProjectionText(String(item)))),
			open_threads: unique(openThreads),
			source_event_ids: asArray(row.source_event_ids).filter((id) => !cancelledEventIds.has(id)),
			metadata: repairMetadata(row.metadata, now, 'remove unsupported stranger inquiry and immediate ceremony assumptions', { correctedByEntryId: CORRECTION_ENTRY_ID }),
		};
	}
	const openThreads = asArray(row.open_threads)
		.filter((item) => !/third claimant/i.test(String(item)))
		.map((item) => sanitizeProjectionText(String(item)));
	let sceneOutcome = String(row.scene_outcome).replace(/^.*third claimant.*(?:\r?\n)?/gim, '');
	sceneOutcome = sanitizeProjectionText(sceneOutcome);
	sceneOutcome += `\n\n[CANON CORRECTION = ${DATE_CORRECTION} Source: transcript position 591.]`;
	return {
		...row,
		scene_outcome: sceneOutcome,
		promises_debts_oaths: unique(asArray(row.promises_debts_oaths).map((item) => sanitizeProjectionText(String(item)))),
		open_threads: unique(openThreads),
		source_event_ids: asArray(row.source_event_ids).filter((id) => !cancelledEventIds.has(id)),
		metadata: repairMetadata(row.metadata, now, 'supersede unsupported ceremony deadline and claimant assumptions', { correctedByEntryId: CORRECTION_ENTRY_ID }),
	};
}

function sanitizeArc(row, cancelledEventIds, now) {
	return {
		...row,
		summary: sanitizeChapter18Text(row.summary),
		source_event_ids: asArray(row.source_event_ids).filter((id) => !cancelledEventIds.has(id)),
		metadata: repairMetadata(sanitizeNested(row.metadata), now, 'sanitize chapter snapshots copied into the arc rollup', { correctedByEntryId: CORRECTION_ENTRY_ID }),
	};
}

function sanitizeStatePatch(row, now) {
	const removedTimelineTitles = asArray(row.operations)
		.map((operation) => asObject(asObject(operation).value).title)
		.filter((title) => BAD_PATCH_TIMELINE_TITLES.has(title));
	const operations = asArray(row.operations)
		.filter((operation) => !BAD_PATCH_TIMELINE_TITLES.has(asObject(asObject(operation).value).title))
		.map(sanitizePatchNested);
	return {
		...row,
		operations,
		validation_warnings: unique([
			...asArray(row.validation_warnings),
			`[${REPAIR_KEY}] Removed ${removedTimelineTitles.length} unsupported derived timeline operation(s); valid applied patch history retained.`,
		]),
	};
}

function cleanPressureMemory(row, faction, cancelledEventIds, now) {
	let content = String(row.content ?? '')
		.split(/\r?\n/)
		.filter((line) => !/(?:Truth-stone rite tomorrow|Third claimant|rival claimant)/i.test(line))
		.join('\n');
	content = content.replace(/pressure is \d+\/100/i, `pressure is ${faction.pressure}/100`);
	const summary = typeof row.summary === 'string'
		? row.summary.split(/\r?\n/).filter((line) => !/(?:Truth-stone rite tomorrow|Third claimant|rival claimant)/i.test(line)).join('\n').replace(/pressure is \d+\/100/i, `pressure is ${faction.pressure}/100`)
		: row.summary;
	return {
		...row,
		content,
		summary,
		source_event_ids: asArray(row.source_event_ids).filter((id) => !cancelledEventIds.has(id)),
		metadata: repairMetadata(row.metadata, now, 'remove cancelled pressure drivers', { pressure: faction.pressure, correctedByEntryId: CORRECTION_ENTRY_ID }),
	};
}

export function buildPlan(snapshot, now) {
	const existingRepair = asObject(asObject(snapshot.story.metadata).loreIntegrityRepairs)[REPAIR_KEY];
	if (existingRepair?.applied === true) return { alreadyApplied: true, marker: existingRepair };
	assert.equal(snapshot.story.title, 'Veil', 'story ID no longer belongs to Veil');
	assert.equal(snapshot.entries.length, TARGET_ENTRY_GUARDS.size, 'guarded transcript rows are missing');
	assert.equal(snapshot.invariants.preserved_count, 604, 'positions 0-604 no longer contain the verified 604 retained entries');
	assert.equal(snapshot.invariants.min_position, 0, 'retained transcript no longer starts at position 0');
	assert.equal(snapshot.invariants.max_position, 604, 'retained transcript no longer reaches position 604');
	assert.equal(snapshot.invariants.identity_md5, TRANSCRIPT_IDENTITY_0_604, 'retained transcript identity/order changed');
	for (const row of snapshot.entries) {
		const guard = TARGET_ENTRY_GUARDS.get(row.position);
		assert.equal(row.id, guard?.id, `entry ${row.position} ID changed`);
		assert.equal(row.content_md5, guard?.md5, `entry ${row.position} content changed since verification`);
	}
	assert.equal(asObject(snapshot.story.metadata).plotBrain?.lastFrame?.id, EXPECTED_FRAME_ID, 'active Plot Director frame changed; inspect it before applying this repair');
	assert.equal(snapshot.entities.length, 3, 'one or more guarded character entities are missing');
	assert.deepEqual(new Set(snapshot.factions.map((row) => row.id)), new Set(Object.values(FACTION_IDS)), 'one or more guarded faction records are missing or unexpected');
	assert.equal(snapshot.projects.length, 2, 'one or more guarded autonomous projects are missing');
	assert.equal(snapshot.threads.length, 2, 'one or more guarded Plot Director threads are missing');
	assert.deepEqual(new Set(snapshot.chapters.map((row) => row.id)), new Set(Object.values(CHAPTER_IDS)), 'one or more guarded chapter 18/20 projections are missing or unexpected');
	assert.equal(snapshot.arcs.length, 1, 'guarded arc rollup is missing');
	assert.equal(snapshot.arcs[0].id, ARC_ID, 'guarded arc rollup changed');
	assert.deepEqual(new Set(snapshot.statePatches.map((row) => row.id)), POISON_PATCH_IDS, 'one or more guarded poison-bearing state patches are missing or unexpected');
	assert.deepEqual(new Set(snapshot.proposals.map((row) => row.id)), new Set(PROPOSAL_IDS), 'one or more guarded stale character proposals are missing or unexpected');

	const newVersion = Number(snapshot.story.server_version) + 1;
	const entryChanges = snapshot.entries
		.filter((row) => row.position === 592 || row.position === 604)
		.map((before) => ({ before, after: {
			...before,
			content: correctEntryContent(before.position, before.content),
			metadata: repairMetadata(before.metadata, now, 'correct internally contradictory ceremony timing without deleting the retained scene'),
		} }));

	const projectMoveIds = new Set(snapshot.events.filter((event) => Object.values(PROJECT_IDS).includes(asObject(event.metadata).projectId)).map((event) => event.id));
	const cancelEventIds = new Set(snapshot.events.filter((event) => {
		const metadata = asObject(event.metadata);
		const threadIds = asArray(event.thread_ids);
		return STANDALONE_CANCEL_EVENT_IDS.has(event.id)
			|| Object.values(PROJECT_IDS).includes(metadata.projectId)
			|| projectMoveIds.has(metadata.sourceFactionMoveEventId)
			|| threadIds.includes(BAD_THREAD_IDS.shadow)
			|| (threadIds.includes(BAD_THREAD_IDS.dragon) && asObject(event.metadata).plotBrain === true);
	}).map((event) => event.id));
	for (const event of snapshot.events) {
		if (cancelEventIds.has(asObject(event.metadata).sourceFactionMoveEventId)) cancelEventIds.add(event.id);
	}
	const eventChanges = snapshot.events.map((before) => {
		if (cancelEventIds.has(before.id)) return { before, after: cancelRow(before, now, 'unsupported Plot Director or duplicate autonomous-faction projection') };
		if (asArray(before.source_entry_ids).some((id) => DERIVED_REWRITE_ENTRY_IDS.has(id))) {
			return { before, after: { ...before, title: sanitizeProjectionText(before.title), body: sanitizeProjectionText(before.body), metadata: repairMetadata(before.metadata, now, 'align derived event copy with later explicit transcript correction', { correctedByEntryId: CORRECTION_ENTRY_ID }) } };
		}
		return null;
	}).filter(Boolean);

	const factionChanges = snapshot.factions
		.filter((row) => row.id === FACTION_IDS.houseTag
			|| row.id === FACTION_IDS.godEmpressTag
			|| asArray(asObject(row.metadata).pressureReasons).some((reason) => cancelEventIds.has(reason?.eventId)))
		.map((before) => ({ before, after: correctedFaction(before, cancelEventIds, now) }));
	const correctedFactionById = new Map(factionChanges.map(({ after }) => [after.id, after]));
	const entityChanges = snapshot.entities.map((before) => ({ before, after: correctedEntity(before, now) }));
	const projectChanges = snapshot.projects.map((before) => ({ before, after: {
		...before,
		status: 'cancelled',
		metadata: repairMetadata(before.metadata, now, 'cancel unsupported duplicate auto-tag autonomous project', {
			nextActionTurn: null,
			superseded: true,
			nonCanon: true,
			nonCanonReason: 'Unsupported duplicate auto-tag autonomous project.',
		}),
	} }));
	const threadChanges = snapshot.threads.map((before) => {
		if (before.id === BAD_THREAD_IDS.shadow) return { before, after: {
			...before,
			status: 'closed',
			closed_at: now,
			closure_reason: 'Closed by lore-integrity repair: no retained transcript, event, or patch evidence supports the infiltrator or egg-sabotage premise.',
			description: 'Superseded unsupported projection; no established God-Empress agent is present in Yin and no dragon-egg sabotage is in canon.',
			source_event_ids: [],
		} };
		return { before, after: {
			...before,
			description: 'Aurion accepted Bu Gai\'s offer of betrothal to Princess Mei-Lin. They are speaking privately and building their bond; the court has not fixed a ceremony date. No competing court adversary has been established.',
			source_event_ids: asArray(before.source_event_ids).filter((id) => !cancelEventIds.has(id)),
		} };
	});
	const chapterChanges = snapshot.chapters.map((before) => ({ before, after: sanitizeChapter(before, cancelEventIds, now) }));
	const arcChanges = snapshot.arcs.map((before) => ({ before, after: sanitizeArc(before, cancelEventIds, now) }));
	const statePatchChanges = snapshot.statePatches.map((before) => ({ before, after: sanitizeStatePatch(before, now) }));
	const proposalChanges = snapshot.proposals.map((before) => ({ before, after: {
		...before,
		status: 'rejected',
		decision: 'rejected',
		metadata: repairMetadata(before.metadata, now, 'proposal is historical and must not overwrite corrected compact character state', { superseded: true, supersededByEntryId: CORRECTION_ENTRY_ID }),
	} }));
	const campaignFileDeletes = campaignFileRowsToDelete(snapshot.campaignFiles);

	const memoryChanges = snapshot.memories
		.filter((row) => row.id !== CORRECTION_MEMORY_ID)
		.map((before) => {
			const sourceCancelled = asArray(before.source_event_ids).some((id) => cancelEventIds.has(id));
			const directCancelledProjection = [...cancelEventIds].some((id) => before.id === `mem_event_${id}` || before.id === `mem_world_tick_${id}`);
			const pressureFactionId = PRESSURE_MEMORY_IDS.get(before.id);
			if (pressureFactionId) {
				const faction = correctedFactionById.get(pressureFactionId);
				if (pressureFactionId === FACTION_IDS.houseTag || pressureFactionId === FACTION_IDS.godEmpressTag) return { before, after: {
					...before,
					title: 'Superseded duplicate faction pressure projection',
					content: 'This duplicate auto-tag faction pressure projection is unsupported and is not canon.',
					summary: 'Superseded unsupported duplicate faction pressure projection.',
					keywords: [],
					importance: 0,
					visibility: 'secret',
					metadata: repairMetadata(before.metadata, now, 'superseded duplicate auto-tag faction pressure memory', { superseded: true, nonCanon: true }),
				} };
				if (faction) return { before, after: cleanPressureMemory(before, faction, cancelEventIds, now) };
			}
			if (CHAPTER_MEMORY_IDS.has(before.id) || asArray(before.source_entry_ids).some((id) => DERIVED_REWRITE_ENTRY_IDS.has(id))) return { before, after: {
				...before,
				content: sanitizeChapter18Text(before.content).replace(/^.*third claimant.*(?:\r?\n)?/gim, ''),
				summary: typeof before.summary === 'string' ? sanitizeChapter18Text(before.summary).replace(/^.*third claimant.*(?:\r?\n)?/gim, '') : before.summary,
				source_event_ids: asArray(before.source_event_ids).filter((id) => !cancelEventIds.has(id)),
				metadata: repairMetadata(before.metadata, now, 'align derived memory copy with explicit later correction', { correctedByEntryId: CORRECTION_ENTRY_ID }),
			} };
			if (directCancelledProjection) return { before, after: {
				...before,
				title: 'Superseded unsupported projection',
				content: 'This derived projection was cancelled because retained story evidence does not support it. It is not canon.',
				summary: 'Superseded unsupported projection; not canon.',
				keywords: [],
				importance: 0,
				visibility: 'secret',
				metadata: repairMetadata(before.metadata, now, 'memory derives only from a cancelled unsupported projection', { superseded: true, nonCanon: true, supersededByEntryId: CORRECTION_ENTRY_ID }),
			} };
			if (sourceCancelled) return { before, after: {
				...before,
				content: sanitizeChapter18Text(before.content),
				summary: typeof before.summary === 'string' ? sanitizeChapter18Text(before.summary) : before.summary,
				source_event_ids: asArray(before.source_event_ids).filter((id) => !cancelEventIds.has(id)),
				metadata: repairMetadata(before.metadata, now, 'remove cancelled projection evidence while retaining supported summary content', { correctedByEntryId: CORRECTION_ENTRY_ID }),
			} };
			return null;
		}).filter(Boolean);

	const oldPlotBrain = structuredClone(asObject(asObject(snapshot.story.metadata).plotBrain));
	const plotBrain = {
		...oldPlotBrain,
		lastFrame: undefined,
		lastFrameId: null,
		lastFrameTurn: null,
		lastPlanAt: null,
		plotCardCount: 0,
		retiredAt: now,
		retiredFrameId: EXPECTED_FRAME_ID,
		retirementReason: 'Retired by lore-integrity repair because its claimant, ceremony deadline, and egg-sabotage pressure lack retained evidence.',
		retiredPlotDirectives: asArray(oldPlotBrain.retiredPlotDirectives),
	};
	delete plotBrain.lastFrame;
	const storyMetadata = structuredClone(asObject(snapshot.story.metadata));
	storyMetadata.plotBrain = plotBrain;
	storyMetadata.loreIntegrityRepairs = {
		...asObject(storyMetadata.loreIntegrityRepairs),
		[REPAIR_KEY]: {
			applied: true,
			appliedAt: now,
			previousServerVersion: Number(snapshot.story.server_version),
			serverVersion: newVersion,
			correctionEntryId: CORRECTION_ENTRY_ID,
			retiredFrameId: EXPECTED_FRAME_ID,
		},
	};

	const fact = {
		id: CORRECTION_FACT_ID,
		story_id: STORY_ID,
		type: 'chronology_correction',
		subject_entity_id: ENTITY_IDS.aurion,
		target_entity_id: ENTITY_IDS.meiLin,
		title: 'Betrothal accepted; ceremony date not fixed',
		statement: DATE_CORRECTION,
		confidence: 1,
		status: 'active',
		visibility: 'player_known',
		first_seen_entry_id: CORRECTION_ENTRY_ID,
		source_entry_ids: [CORRECTION_ENTRY_ID],
		source_event_ids: [],
		source_patch_ids: [],
		metadata: { authority: 'explicit_player_correction', supersedesEventIds: [...STANDALONE_CANCEL_EVENT_IDS], repairKey: REPAIR_KEY },
	};
	const memory = {
		id: CORRECTION_MEMORY_ID,
		story_id: STORY_ID,
		type: 'canonical',
		title: fact.title,
		content: DATE_CORRECTION,
		summary: DATE_CORRECTION,
		keywords: ['Aurion Belaerys', 'Princess Mei-Lin', 'betrothal', 'ceremony date', 'not tomorrow'],
		entity_ids: [ENTITY_IDS.aurion, ENTITY_IDS.meiLin, ENTITY_IDS.buGai],
		faction_ids: [FACTION_IDS.yiTiCanon],
		thread_ids: [BAD_THREAD_IDS.dragon],
		location_id: 'entity_2e839377-36b0-4ffb-a0a8-2823ccb1b954',
		visibility: 'player_known',
		importance: 1,
		source_entry_ids: [CORRECTION_ENTRY_ID],
		source_event_ids: [],
		source_patch_ids: [],
		metadata: { authority: 'explicit_player_correction', validFromTurn: 292, repairKey: REPAIR_KEY },
	};

	return {
		alreadyApplied: false,
		newVersion,
		entryChanges,
		entityChanges,
		factionChanges,
		projectChanges,
		threadChanges,
		eventChanges,
		memoryChanges,
		chapterChanges,
		arcChanges,
		statePatchChanges,
		proposalChanges,
		campaignFileDeletes,
		activeProjectionScan: asArray(snapshot.activeProjectionScan),
		cancelEventIds,
		storyMetadata,
		fact,
		memory,
	};
}

function findActivePoison(plan) {
	const findings = [];
	const check = (kind, id, text) => {
		const match = String(text ?? '').match(ACTIVE_POISON);
		if (match) findings.push({ kind, id, match: match[0] });
	};
	if (plan.activeProjectionScan.length > 0) {
		for (const candidate of plan.activeProjectionScan) {
			const changed = plannedProjectionRow(plan, candidate.kind, candidate.id);
			if (!changed) {
				check(candidate.kind, candidate.id, candidate.text);
				continue;
			}
			if (!projectionRowIsActive(candidate.kind, changed)) continue;
			check(candidate.kind, candidate.id, projectionRowText(candidate.kind, changed));
		}
		check('plotBrain', EXPECTED_FRAME_ID, JSON.stringify(plan.storyMetadata.plotBrain.lastFrame ?? null));
		return findings;
	}
	for (const { after } of plan.threadChanges) if (after.status === 'open') check('thread', after.id, after.description);
	for (const { after } of plan.eventChanges) if (['committed', 'proposed', 'scheduled', 'due'].includes(after.status) && asObject(after.metadata).superseded !== true) check('event', after.id, `${after.title}\n${after.body}`);
	for (const { after } of plan.memoryChanges) if (Number(after.importance) > 0 && asObject(after.metadata).superseded !== true) check('memory', after.id, `${after.title}\n${after.content}\n${after.summary ?? ''}`);
	for (const { after } of plan.chapterChanges) check('chapter', after.id, `${after.scene_outcome}\n${asArray(after.open_threads).join('\n')}`);
	for (const { after } of plan.arcChanges) check('arc', after.id, `${after.summary}\n${JSON.stringify(after.metadata)}`);
	for (const { after } of plan.statePatchChanges) if (after.status !== 'rejected') check('state_patch', after.id, JSON.stringify(after.operations));
	for (const { after } of plan.entityChanges) check('entity', after.id, JSON.stringify(after.state));
	for (const { after } of plan.factionChanges) check('faction', after.id, JSON.stringify({ goals: after.goals, metadata: after.metadata }));
	for (const { after } of plan.projectChanges) if (!['cancelled', 'completed', 'failed'].includes(after.status)) check('faction_project', after.id, JSON.stringify(after));
	check('plotBrain', EXPECTED_FRAME_ID, JSON.stringify(plan.storyMetadata.plotBrain.lastFrame ?? null));
	return findings;
}

function plannedProjectionRow(plan, kind, id) {
	const changesByKind = {
		thread: plan.threadChanges,
		event: plan.eventChanges,
		memory: plan.memoryChanges,
		chapter: plan.chapterChanges,
		arc: plan.arcChanges,
		entity: plan.entityChanges,
		faction: plan.factionChanges,
		faction_project: plan.projectChanges,
		state_patch: plan.statePatchChanges,
		patch_proposal: plan.proposalChanges,
	};
	const changed = changesByKind[kind]?.find(({ after }) => after.id === id)?.after;
	if (changed) return changed;
	if (kind === 'fact' && plan.fact.id === id) return plan.fact;
	if (kind === 'memory' && plan.memory.id === id) return plan.memory;
	return null;
}

function projectionRowIsActive(kind, row) {
	const metadata = asObject(row.metadata);
	if (metadata.nonCanon === true || metadata.non_canon === true) return false;
	if (kind === 'thread') return row.status === 'open';
	if (kind === 'event') return ['committed', 'proposed', 'scheduled', 'due'].includes(row.status) && metadata.superseded !== true;
	if (kind === 'memory') return Number(row.importance) > 0 && metadata.superseded !== true;
	if (kind === 'state_patch') return row.status !== 'rejected';
	if (kind === 'patch_proposal') return ['pending', 'needs_review'].includes(row.status);
	if (kind === 'fact') return row.status === 'active';
	if (kind === 'agreement') return row.status !== 'archived';
	return true;
}

function projectionRowText(kind, row) {
	if (kind === 'thread') return row.description;
	if (kind === 'event') return `${row.title}\n${row.body}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'memory') return `${row.title}\n${row.content}\n${row.summary ?? ''}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'chapter') return `${row.scene_outcome}\n${JSON.stringify(row.open_threads)}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'arc' || kind === 'saga') return `${row.summary}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'entity') return `${row.description ?? ''}\n${JSON.stringify(row.state)}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'faction') return `${row.name ?? ''}\n${JSON.stringify(row.goals)}\n${JSON.stringify(row.resources)}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'faction_project') return `${row.project ?? ''}\n${JSON.stringify(row.risks)}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'state_patch' || kind === 'patch_proposal') return `${row.reason ?? ''}\n${row.suggestion ?? ''}\n${JSON.stringify(row.operations)}\n${JSON.stringify(row.metadata)}`;
	if (kind === 'fact') return `${row.title}\n${row.statement}\n${JSON.stringify(row.metadata)}`;
	return JSON.stringify(row);
}

function findActivePoisonBefore(snapshot) {
	const findings = [];
	const check = (kind, id, text) => {
		const match = String(text ?? '').match(ACTIVE_POISON);
		if (match) findings.push({ kind, id, match: match[0] });
	};
	if (asArray(snapshot.activeProjectionScan).length > 0) {
		for (const candidate of snapshot.activeProjectionScan) check(candidate.kind, candidate.id, candidate.text);
		check('plotBrain', EXPECTED_FRAME_ID, JSON.stringify(asObject(snapshot.story.metadata).plotBrain?.lastFrame ?? null));
		return findings;
	}
	for (const row of snapshot.threads) if (row.status === 'open') check('thread', row.id, row.description);
	for (const row of snapshot.events) if (['committed', 'proposed', 'scheduled', 'due'].includes(row.status) && asObject(row.metadata).superseded !== true) check('event', row.id, `${row.title}\n${row.body}`);
	for (const row of snapshot.memories) if (Number(row.importance) > 0 && asObject(row.metadata).superseded !== true) check('memory', row.id, `${row.title}\n${row.content}\n${row.summary ?? ''}`);
	for (const row of snapshot.chapters) check('chapter', row.id, `${row.scene_outcome}\n${asArray(row.open_threads).join('\n')}`);
	for (const row of snapshot.arcs) check('arc', row.id, `${row.summary}\n${JSON.stringify(row.metadata)}`);
	for (const row of snapshot.statePatches) if (row.status !== 'rejected') check('state_patch', row.id, JSON.stringify(row.operations));
	for (const row of snapshot.entities) check('entity', row.id, JSON.stringify(row.state));
	for (const row of snapshot.factions) check('faction', row.id, JSON.stringify({ goals: row.goals, metadata: row.metadata }));
	for (const row of snapshot.projects) if (!['cancelled', 'completed', 'failed'].includes(row.status)) check('faction_project', row.id, JSON.stringify(row));
	check('plotBrain', EXPECTED_FRAME_ID, JSON.stringify(asObject(snapshot.story.metadata).plotBrain?.lastFrame ?? null));
	return findings;
}

async function inspectVaultFiles(dataRoot) {
	const resolvedDataRoot = path.resolve(dataRoot);
	const results = [];
	for (const item of ORPHAN_VAULT_FILES) {
		const sourcePath = path.resolve(resolvedDataRoot, item.relativePath);
		assert.ok(sourcePath.startsWith(`${resolvedDataRoot}${path.sep}`), `unsafe vault path: ${sourcePath}`);
		try {
			await stat(sourcePath);
			const actualSha256 = await sha256File(sourcePath);
			results.push({ ...item, sourcePath, actualSha256, status: actualSha256 === item.sha256 ? 'exact_poison_match' : 'nonmatching_file_refuse_apply' });
		} catch (error) {
			if (error?.code !== 'ENOENT') throw error;
			results.push({ ...item, sourcePath, actualSha256: null, status: 'absent' });
		}
	}
	return results;
}

export function previewSummary(snapshot, plan, vaultFiles, backupRoot) {
	const jobGuard = repairJobGuardSummary(snapshot.activeBackendJobs);
	if (plan.alreadyApplied) return {
		ok: true,
		mode: 'preview',
		storyId: STORY_ID,
		alreadyApplied: true,
		marker: plan.marker,
		jobGuard,
		vaultQuarantine: vaultFiles,
	};
	const activePoisonBefore = findActivePoisonBefore(snapshot);
	const activePoisonAfter = findActivePoison(plan);
	const cancelledEvents = plan.eventChanges.filter(({ after }) => after.status === 'cancelled');
	const rewrittenEvents = plan.eventChanges.filter(({ before, after }) => before.body !== after.body && after.status !== 'cancelled');
	const supersededMemories = plan.memoryChanges.filter(({ after }) => asObject(after.metadata).superseded === true);
	return {
		ok: activePoisonAfter.length === 0 && jobGuard.runningBlockerCount === 0,
		mode: 'preview',
		story: {
			id: snapshot.story.id,
			title: snapshot.story.title,
			serverVersion: Number(snapshot.story.server_version),
			plannedServerVersion: plan.newVersion,
			currentTurn: snapshot.story.current_turn,
			currentWorldTime: snapshot.story.current_world_time,
			retiredPlotFrameId: EXPECTED_FRAME_ID,
		},
		guards: {
			transcriptPositions0To604: snapshot.invariants,
			entryContentMd5: Object.fromEntries(snapshot.entries.map((row) => [row.position, row.content_md5])),
			applyRequiresExpectedVersion: Number(snapshot.story.server_version),
		},
		preserved: {
			transcriptEntriesDeleted: 0,
			currentTurnChanged: false,
			currentWorldTimeChanged: false,
			affinityOrRelationshipTablesChanged: false,
		},
		counts: {
			entrySentencesCorrected: plan.entryChanges.length,
			entitiesCorrected: plan.entityChanges.length,
			factionsCorrected: plan.factionChanges.length,
			projectsTargeted: plan.projectChanges.length,
			projectsNewlyCancelled: plan.projectChanges.filter(({ before, after }) => before.status !== 'cancelled' && after.status === 'cancelled').length,
			threadsCorrected: plan.threadChanges.length,
			threadsNewlyClosed: plan.threadChanges.filter(({ before, after }) => before.status !== 'closed' && after.status === 'closed').length,
			eventsTargetedForCancellation: cancelledEvents.length,
			eventsNewlyCancelled: cancelledEvents.filter(({ before }) => before.status !== 'cancelled').length,
			eventsAlreadyCancelledButMarkedSuperseded: cancelledEvents.filter(({ before }) => before.status === 'cancelled').length,
			eventsRewritten: rewrittenEvents.length,
			memoriesChanged: plan.memoryChanges.length,
			memoriesMarkedSuperseded: supersededMemories.length,
			chapterProjectionsSanitized: plan.chapterChanges.length,
			arcProjectionsSanitized: plan.arcChanges.length,
			statePatchesSanitized: plan.statePatchChanges.length,
			proposalsMarkedSuperseded: plan.proposalChanges.length,
			campaignFileRowsDeleted: plan.campaignFileDeletes.length,
			canonicalFactsUpserted: 1,
			canonicalMemoriesUpserted: 1,
			vaultFilesExactQuarantineTargets: vaultFiles.filter((file) => file.status === 'exact_poison_match').length,
			vaultFilesAlreadyAbsent: vaultFiles.filter((file) => file.status === 'absent').length,
			vaultFilesRefusingApplyIfUnchanged: vaultFiles.filter((file) => file.status === 'nonmatching_file_refuse_apply').length,
		},
		changes: {
			entrySentenceDiffs: plan.entryChanges.map(({ before, after }) => ({ position: before.position, id: before.id, beforeMd5: before.content_md5, afterMd5: md5(after.content), oldSentence: before.position === 592 ? ENTRY_592_OLD : ENTRY_604_OLD, newSentence: before.position === 592 ? ENTRY_592_NEW : ENTRY_604_NEW })),
			entitiesCorrected: plan.entityChanges.map(({ after }) => after.id),
			factionsCorrected: plan.factionChanges.map(({ before, after }) => ({ id: after.id, pressure: `${before.pressure} -> ${after.pressure}`, worldSimEnabled: asObject(after.metadata).worldSimEnabled ?? null })),
			projectsCancelled: plan.projectChanges.map(({ after }) => after.id),
			threads: plan.threadChanges.map(({ after }) => ({ id: after.id, status: after.status, description: after.description })),
			eventsCancelled: cancelledEvents.map(({ after }) => after.id),
			eventsRewritten: rewrittenEvents.map(({ after }) => after.id),
			memoriesChanged: plan.memoryChanges.map(({ after }) => ({ id: after.id, superseded: asObject(after.metadata).superseded === true, importance: after.importance })),
			chapterSanitized: plan.chapterChanges.map(({ after }) => after.id),
			arcSanitized: plan.arcChanges.map(({ after }) => after.id),
			statePatchesSanitized: plan.statePatchChanges.map(({ before, after }) => ({
				id: after.id,
				statusPreserved: after.status,
				operationsRemoved: asArray(before.operations).length - asArray(after.operations).length,
			})),
			proposalsSuperseded: plan.proposalChanges.map(({ after }) => after.id),
			campaignFileRowsDeleted: plan.campaignFileDeletes.map(({ before }) => ({ id: before.id, path: before.path, contentHash: before.content_hash, serverVersion: before.server_version })),
			canonicalFactUpsert: plan.fact.id,
			canonicalMemoryUpsert: plan.memory.id,
		},
		activePoisonBefore,
		activePoisonAfter,
		vaultQuarantine: vaultFiles,
		jobGuard,
		backupRoot,
		applySafety: {
			transactionalBackendWrites: true,
			optimisticStoryVersionGuard: Number(snapshot.story.server_version),
			backupPathPattern: path.join(backupRoot, `<ISO timestamp>-v${snapshot.story.server_version}`),
			backupContents: ['backend-targets-before.json', 'guarded-vault-files-before/'],
			checkpointId: `checkpoint_${REPAIR_KEY}_v${snapshot.story.server_version}`,
			vaultQuarantineAfterCommit: true,
		},
		jobsOnApply: ['sync_story_vault (clean + index)', 'embed_memory_nodes (changed nodes)', 'index_canonical_records (changed record types)'],
		applyCommand: `node scripts/repair-veil-live-lore.mjs --apply --expected-version ${snapshot.story.server_version}`,
	};
}

async function writeBackup(snapshot, plan, args, vaultFiles) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.resolve(args.backupDir, `${stamp}-v${snapshot.story.server_version}`);
	await mkdir(backupPath, { recursive: true });
	await writeFile(path.join(backupPath, 'backend-targets-before.json'), `${JSON.stringify({
		repairKey: REPAIR_KEY,
		createdAt: new Date().toISOString(),
		storyId: STORY_ID,
		invariants: snapshot.invariants,
		story: snapshot.story,
		entries: snapshot.entries,
		entities: snapshot.entities,
		factions: snapshot.factions,
		projects: snapshot.projects,
		threads: snapshot.threads,
		events: snapshot.events,
		memories: snapshot.memories,
		chapters: snapshot.chapters,
		arcs: snapshot.arcs,
		statePatches: snapshot.statePatches,
		proposals: snapshot.proposals,
		facts: snapshot.facts,
		campaignFiles: snapshot.campaignFiles,
		activeBackendJobs: snapshot.activeBackendJobs,
		jobGuard: repairJobGuardSummary(snapshot.activeBackendJobs),
		vaultFiles,
		plannedServerVersion: plan.newVersion,
	}, null, 2)}\n`, 'utf8');
	const guardedVaultBackup = path.join(backupPath, 'guarded-vault-files-before');
	for (const file of vaultFiles) {
		if (file.status !== 'exact_poison_match') continue;
		assert.equal(await sha256File(file.sourcePath), file.sha256, `guarded vault file changed before backup: ${file.sourcePath}`);
		await mkdir(guardedVaultBackup, { recursive: true });
		const destination = path.join(guardedVaultBackup, path.basename(file.sourcePath));
		await copyFile(file.sourcePath, destination);
		assert.equal(await sha256File(destination), file.sha256, `guarded vault backup hash mismatch: ${destination}`);
	}
	return backupPath;
}

async function supersedePreexistingJobs(tx, rows, now) {
	const summary = repairJobGuardSummary(rows);
	assertNoRunningRepairJobs(summary);
	const supersededIds = [];
	for (const row of asArray(rows).filter((item) => item.status === 'queued' || item.status === 'retry')) {
		const metadata = {
			...asObject(row.metadata),
			superseded: true,
			supersededAt: now,
			supersededByRepairKey: REPAIR_KEY,
			supersededReason: 'Pre-repair job could replay stale extraction, world-simulation, Plot Director, or projection state.',
		};
		const updated = await tx`update backend_jobs set status = 'complete', locked_at = null, locked_by = null, last_error = null, metadata = ${tx.json(metadata)}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${row.id} and status = ${row.status} returning id`;
		assert.equal(updated.length, 1, `backend job changed while preparing repair: ${row.id}`);
		supersededIds.push(row.id);
	}
	return supersededIds;
}

async function applyPlan(tx, snapshot, plan, now, backupPath, supersededJobIds) {
	const version = plan.newVersion;
	const checkpointId = `checkpoint_${REPAIR_KEY}_v${snapshot.story.server_version}`;
	const repairMarker = asObject(asObject(plan.storyMetadata).loreIntegrityRepairs)[REPAIR_KEY];
	repairMarker.backupPath = backupPath;
	repairMarker.checkpointId = checkpointId;
	repairMarker.supersededJobCount = supersededJobIds.length;
	repairMarker.supersededJobIds = supersededJobIds;
	repairMarker.deletedCampaignFileCount = plan.campaignFileDeletes.length;
	repairMarker.deletedCampaignFileIds = plan.campaignFileDeletes.map(({ before }) => before.id);
	for (const { before, after } of plan.entryChanges) {
		const updated = await tx`update story_entries set content = ${after.content}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${before.id} and md5(content) = ${before.content_md5} returning id`;
		assert.equal(updated.length, 1, `entry changed during repair: ${before.id}`);
	}
	for (const { before, after } of plan.entityChanges) {
		const updated = await tx`update entities set description = ${after.description}, state = ${tx.json(after.state)}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `entity changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.factionChanges) {
		const updated = await tx`update factions set pressure = ${after.pressure}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `faction changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.projectChanges) {
		const updated = await tx`update faction_projects set status = ${after.status}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `faction project changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.threadChanges) {
		const updated = await tx`update story_threads set description = ${after.description}, status = ${after.status}, source_event_ids = ${tx.json(after.source_event_ids)}, closed_at = ${after.closed_at}, closure_reason = ${after.closure_reason}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `story thread changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.eventChanges) {
		const updated = await tx`update story_events set status = ${after.status}, title = ${after.title}, body = ${after.body}, scheduled_turn = ${after.scheduled_turn}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `story event changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.memoryChanges) {
		const updated = await tx`update memory_nodes set title = ${after.title}, content = ${after.content}, summary = ${after.summary}, keywords = ${tx.json(after.keywords)}, visibility = ${after.visibility}, importance = ${after.importance}, source_event_ids = ${tx.json(after.source_event_ids)}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `memory node changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.chapterChanges) {
		const updated = await tx`update chapters set scene_outcome = ${after.scene_outcome}, promises_debts_oaths = ${tx.json(after.promises_debts_oaths)}, open_threads = ${tx.json(after.open_threads)}, source_event_ids = ${tx.json(after.source_event_ids)}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `chapter changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.arcChanges) {
		const updated = await tx`update arcs set summary = ${after.summary}, source_event_ids = ${tx.json(after.source_event_ids)}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `arc changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.statePatchChanges) {
		const updated = await tx`update state_patches set operations = ${tx.json(after.operations)}, validation_warnings = ${tx.json(after.validation_warnings)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `state patch changed during repair: ${after.id}`);
	}
	for (const { before, after } of plan.proposalChanges) {
		const updated = await tx`update patch_proposals set status = ${after.status}, decision = ${after.decision}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `patch proposal changed during repair: ${after.id}`);
	}
	for (const { before } of plan.campaignFileDeletes) {
		const deleted = await tx`delete from campaign_files where story_id = ${STORY_ID} and id = ${before.id} and path = ${before.path} and content_hash = ${before.content_hash} and server_version = ${before.server_version} returning id`;
		assert.equal(deleted.length, 1, `campaign_files row changed during repair: ${before.id}`);
	}

	const fact = plan.fact;
	await tx`insert into facts (id, story_id, type, subject_entity_id, target_entity_id, title, statement, confidence, status, visibility, first_seen_entry_id, source_entry_ids, source_event_ids, source_patch_ids, metadata, server_version, created_at, updated_at)
		values (${fact.id}, ${fact.story_id}, ${fact.type}, ${fact.subject_entity_id}, ${fact.target_entity_id}, ${fact.title}, ${fact.statement}, ${fact.confidence}, ${fact.status}, ${fact.visibility}, ${fact.first_seen_entry_id}, ${tx.json(fact.source_entry_ids)}, ${tx.json(fact.source_event_ids)}, ${tx.json(fact.source_patch_ids)}, ${tx.json(fact.metadata)}, ${version}, ${now}, ${now})
		on conflict (id) do update set type = excluded.type, subject_entity_id = excluded.subject_entity_id, target_entity_id = excluded.target_entity_id, title = excluded.title, statement = excluded.statement, confidence = excluded.confidence, status = excluded.status, visibility = excluded.visibility, first_seen_entry_id = excluded.first_seen_entry_id, source_entry_ids = excluded.source_entry_ids, source_event_ids = excluded.source_event_ids, source_patch_ids = excluded.source_patch_ids, metadata = excluded.metadata, server_version = excluded.server_version, updated_at = excluded.updated_at`;
	const memory = plan.memory;
	await tx`insert into memory_nodes (id, story_id, type, title, content, summary, keywords, entity_ids, faction_ids, thread_ids, location_id, visibility, importance, source_entry_ids, source_event_ids, source_patch_ids, metadata, server_version, created_at, updated_at)
		values (${memory.id}, ${memory.story_id}, ${memory.type}, ${memory.title}, ${memory.content}, ${memory.summary}, ${tx.json(memory.keywords)}, ${tx.json(memory.entity_ids)}, ${tx.json(memory.faction_ids)}, ${tx.json(memory.thread_ids)}, ${memory.location_id}, ${memory.visibility}, ${memory.importance}, ${tx.json(memory.source_entry_ids)}, ${tx.json(memory.source_event_ids)}, ${tx.json(memory.source_patch_ids)}, ${tx.json(memory.metadata)}, ${version}, ${now}, ${now})
		on conflict (id) do update set type = excluded.type, title = excluded.title, content = excluded.content, summary = excluded.summary, keywords = excluded.keywords, entity_ids = excluded.entity_ids, faction_ids = excluded.faction_ids, thread_ids = excluded.thread_ids, location_id = excluded.location_id, visibility = excluded.visibility, importance = excluded.importance, source_entry_ids = excluded.source_entry_ids, source_event_ids = excluded.source_event_ids, source_patch_ids = excluded.source_patch_ids, metadata = excluded.metadata, server_version = excluded.server_version, updated_at = excluded.updated_at`;

	await tx`insert into context_checkpoints (id, story_id, label, reason, entry_position, current_turn, snapshot, metadata, server_version, created_at, updated_at)
		values (${checkpointId}, ${STORY_ID}, ${'Before Veil live lore-integrity repair'}, ${'Surgical backup checkpoint before retiring unsupported Plot Director and duplicate faction projections.'}, ${snapshot.invariants.max_position}, ${snapshot.story.current_turn}, ${tx.json({ backupPath, invariants: snapshot.invariants, targetIds: { entries: plan.entryChanges.map(({ after }) => after.id), events: plan.eventChanges.map(({ after }) => after.id), memories: plan.memoryChanges.map(({ after }) => after.id) } })}, ${tx.json({ repairKey: REPAIR_KEY, previousServerVersion: snapshot.story.server_version })}, ${version}, ${now}, ${now}) on conflict (id) do nothing`;

	const storyUpdated = await tx`update stories set metadata = ${tx.json(plan.storyMetadata)}, server_version = ${version}, updated_at = ${now} where id = ${STORY_ID} and server_version = ${snapshot.story.server_version} returning id`;
	assert.equal(storyUpdated.length, 1, 'story version changed during repair');
	const jobs = [
		{
			id: `job_sync_story_vault_${REPAIR_KEY}_v${version}`,
			type: 'sync_story_vault',
			payload: { serverVersion: version, reason: REPAIR_KEY, clean: true, index: true, lint: true },
		},
		{
			id: `job_embed_memory_nodes_${REPAIR_KEY}_v${version}`,
			type: 'embed_memory_nodes',
			payload: { serverVersion: version, memoryNodeIds: unique([...plan.memoryChanges.map(({ after }) => after.id), plan.memory.id]) },
		},
		{
			id: `job_index_canonical_records_${REPAIR_KEY}_v${version}`,
			type: 'index_canonical_records',
			payload: {
				serverVersion: version,
				recreate: false,
				maxRecords: 120,
				recordTypes: ['events', 'threads', 'factionProjects', 'patches', 'chapters', 'arcs', 'entities', 'factions'],
			},
		},
	];
	for (const job of jobs) {
		const queued = await tx`insert into backend_jobs (id, story_id, type, payload, status, attempt_count, max_attempts, run_after, metadata, created_at, updated_at)
		values (${job.id}, ${STORY_ID}, ${job.type}, ${tx.json(job.payload)}, 'queued', 0, 3, ${now}, ${tx.json({ repairKey: REPAIR_KEY })}, ${now}, ${now})
		on conflict (id) do update set payload = excluded.payload, status = 'queued', attempt_count = 0, max_attempts = 3, run_after = excluded.run_after, locked_at = null, locked_by = null, last_error = null, metadata = excluded.metadata, updated_at = excluded.updated_at
		where backend_jobs.story_id = ${STORY_ID} and backend_jobs.type = ${job.type} and backend_jobs.status <> 'running' returning id`;
		assert.equal(queued.length, 1, `repair backend job ID is occupied by an incompatible row: ${job.id}`);
	}

	const afterInvariants = await loadInvariants(tx);
	assert.equal(afterInvariants.identity_md5, snapshot.invariants.identity_md5, 'transcript identity/order changed inside repair transaction');
	assert.equal(afterInvariants.untouched_content_md5, snapshot.invariants.untouched_content_md5, 'an unapproved transcript entry changed inside repair transaction');
	assert.equal(afterInvariants.preserved_count, snapshot.invariants.preserved_count, 'transcript entry count changed inside repair transaction');
	assert.equal(afterInvariants.affinity_md5, snapshot.invariants.affinity_md5, 'affinity or relationship history changed inside repair transaction');
	return jobs.map((job) => job.id);
}

export async function quarantineVaultFiles(vaultFiles, backupPath) {
	const results = [];
	for (const file of vaultFiles) {
		let currentSha256;
		try {
			currentSha256 = await sha256File(file.sourcePath);
		} catch (error) {
			if (error?.code === 'ENOENT') {
				results.push({ sourcePath: file.sourcePath, status: 'already_absent' });
				continue;
			}
			results.push({ sourcePath: file.sourcePath, status: 'quarantine_inspection_failed', error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		if (currentSha256 !== file.sha256) {
			results.push({ sourcePath: file.sourcePath, status: 'not_quarantined_content_changed', currentSha256, expectedSha256: file.sha256 });
			continue;
		}
		const destination = path.resolve(backupPath, 'quarantined-vault-files', path.basename(file.sourcePath));
		try {
			await mkdir(path.dirname(destination), { recursive: true });
			await rename(file.sourcePath, destination);
		} catch (error) {
			if (error?.code === 'ENOENT') {
				results.push({ sourcePath: file.sourcePath, status: 'already_absent_after_reinspect' });
				continue;
			}
			results.push({ sourcePath: file.sourcePath, destination, status: 'quarantine_move_failed', error: error instanceof Error ? error.message : String(error) });
			continue;
		}
		try {
			const destinationSha256 = await sha256File(destination);
			if (destinationSha256 !== file.sha256) {
				results.push({ sourcePath: file.sourcePath, destination, status: 'quarantine_verification_failed', destinationSha256, expectedSha256: file.sha256 });
				continue;
			}
			results.push({ sourcePath: file.sourcePath, destination, sha256: destinationSha256, status: 'quarantined' });
		} catch (error) {
			results.push({ sourcePath: file.sourcePath, destination, status: 'quarantine_verification_failed', error: error instanceof Error ? error.message : String(error) });
		}
	}
	return results;
}

export function assertQuarantineComplete(results) {
	const accepted = new Set(['quarantined', 'already_absent', 'already_absent_after_reinspect']);
	const failures = asArray(results).filter((result) => !accepted.has(result?.status));
	assert.deepEqual(failures, [], `vault quarantine incomplete: ${JSON.stringify(failures)}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(databaseUrl(), { max: 1, prepare: false });
	try {
		const vaultFiles = await inspectVaultFiles(args.dataRoot);
		if (!args.apply) {
			const snapshot = await loadSnapshot(sql);
			const plan = buildPlan(snapshot, new Date().toISOString());
			const output = previewSummary(snapshot, plan, vaultFiles, args.backupDir);
			if (!output.ok) throw new Error(`Preview is not safe to apply:\n${JSON.stringify({ activePoisonAfter: output.activePoisonAfter, runningJobBlockers: output.jobGuard?.runningBlockers ?? [] }, null, 2)}`);
			console.log(JSON.stringify(output, null, 2));
			return;
		}

		let applyResult;
		await sql.begin(async (tx) => {
			const snapshot = await loadSnapshot(tx, true);
			const marker = asObject(asObject(snapshot.story.metadata).loreIntegrityRepairs)[REPAIR_KEY];
			if (marker?.applied === true) {
				applyResult = { alreadyApplied: true, marker, backupPath: typeof marker.backupPath === 'string' ? marker.backupPath : null };
				return;
			}
			if (vaultFiles.some((file) => file.status === 'nonmatching_file_refuse_apply')) {
				throw new Error('A guarded campaign-vault file no longer matches the verified poison hash; refusing to guess.');
			}
			const jobGuard = repairJobGuardSummary(snapshot.activeBackendJobs);
			assertNoRunningRepairJobs(jobGuard);
			assert.equal(Number(snapshot.story.server_version), args.expectedVersion, `optimistic guard failed: preview expected story version ${args.expectedVersion}, live story is ${snapshot.story.server_version}`);
			const now = new Date().toISOString();
			const plan = buildPlan(snapshot, now);
			const poisonAfter = findActivePoison(plan);
			assert.deepEqual(poisonAfter, [], `planned repair leaves active poison: ${JSON.stringify(poisonAfter)}`);
			const backupPath = await writeBackup(snapshot, plan, args, vaultFiles);
			const supersededJobIds = await supersedePreexistingJobs(tx, snapshot.activeBackendJobs, now);
			const jobIds = await applyPlan(tx, snapshot, plan, now, backupPath, supersededJobIds);
			applyResult = {
				alreadyApplied: false,
				backupPath,
				previousServerVersion: snapshot.story.server_version,
				serverVersion: plan.newVersion,
				currentTurn: snapshot.story.current_turn,
				currentWorldTime: snapshot.story.current_world_time,
				supersededJobCount: supersededJobIds.length,
				supersededJobIds,
				deletedCampaignFileCount: plan.campaignFileDeletes.length,
				deletedCampaignFileIds: plan.campaignFileDeletes.map(({ before }) => before.id),
				jobIds,
			};
		});
		if (applyResult.alreadyApplied) {
			assert.ok(applyResult.backupPath, 'Applied repair marker is missing backupPath; cannot complete guarded vault quarantine.');
			const quarantine = await quarantineVaultFiles(vaultFiles, applyResult.backupPath);
			assertQuarantineComplete(quarantine);
			console.log(JSON.stringify({ ok: true, mode: 'apply', storyId: STORY_ID, ...applyResult, quarantine }, null, 2));
			return;
		}
		const quarantine = await quarantineVaultFiles(vaultFiles, applyResult.backupPath);
		assertQuarantineComplete(quarantine);
		console.log(JSON.stringify({ ok: true, mode: 'apply', storyId: STORY_ID, ...applyResult, transcriptEntriesDeleted: 0, affinityHistoryChanged: false, quarantine }, null, 2));
	} finally {
		await sql.end({ timeout: 1 });
	}
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack : error);
		process.exitCode = 1;
	});
}
