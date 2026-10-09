#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { databaseUrl } from './db-env.mjs';

export const STORY_ID = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
export const MEI_LIN_ID = 'veil_entity_mei_lin';
export const ARMOR_AGREEMENT_ID = 'event_10d4b251-308b-4bf6-a741-d73283a79134';
export const ARMOR_PROMISE_ID = 'event_3097e94e-5206-45cb-b64c-70dc703752f4';
export const TRUTH_STONE_WARNING_ID = 'event_ae992f91-94c2-4d3e-9263-e3056e14756f';
export const VALYRIAN_FACTION_ID = 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_valyrian';
export const AZURE_THRONE_FACTION_ID = 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_azure_throne';
export const YI_TI_FACTION_ID = 'faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_yi_ti';
export const CANON_YI_TI_FACTION_ID = 'veil_faction_golden_empire_yi_ti';
export const VALYRIAN_MOVE_ID = 'event_world_tick_story_52d7c651_0b16_4b91_890d_e7f226f7926b_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_valyrian_protect_and_advance_valyrian_s_interests_de09297783fc';
export const VALYRIAN_SIGNAL_ID = 'event_faction_signal_event_world_tick_story_52d7c651_0b16_4b91_890d_e7f226f7926b_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b_valyrian_protect_and_advance_val_1161d0979894';
export const VALYRIAN_MOVE_MEMORY_ID = `mem_world_tick_${VALYRIAN_MOVE_ID}`;
export const VALYRIAN_PRESSURE_MEMORY_ID = `mem_faction_pressure_${VALYRIAN_FACTION_ID}`;
export const AZURE_THRONE_PRESSURE_MEMORY_ID = `mem_faction_pressure_${AZURE_THRONE_FACTION_ID}`;
export const YI_TI_PRESSURE_MEMORY_ID = `mem_faction_pressure_${YI_TI_FACTION_ID}`;
export const UNSAFE_FRAME_ID = '4324e476-fc7d-4342-a319-3703879923ee';

const REPAIR_KEY = 'veil_lore_integrity_v3';
const PRIOR_REPAIR_KEYS = ['veil_lore_integrity_v1', 'veil_lore_integrity_v2'];
const CEREMONY_EVENT_IDS = [ARMOR_AGREEMENT_ID, ARMOR_PROMISE_ID, TRUTH_STONE_WARNING_ID];
const AUTO_TAG_EVENT_IDS = [VALYRIAN_MOVE_ID, VALYRIAN_SIGNAL_ID];
const AUTO_TAG_FACTION_IDS = [AZURE_THRONE_FACTION_ID, YI_TI_FACTION_ID, VALYRIAN_FACTION_ID];
const MEMORY_IDS = [AZURE_THRONE_PRESSURE_MEMORY_ID, YI_TI_PRESSURE_MEMORY_ID, VALYRIAN_MOVE_MEMORY_ID, VALYRIAN_PRESSURE_MEMORY_ID];
const ARCHIVE_AGREEMENT_IDS = [
	'agreement_263f8488-df64-46cc-94a5-4b4d0a095d5a',
	'agreement_7e472cec-b7c5-4f49-ac94-26ec2b6d526e',
	'agreement_ae42f56c-6ec1-47e3-956b-9b74a1dea1d7',
];
const CANON_BETROTHAL_AGREEMENT_ID = 'agreement_2cbcd45d-4530-47b7-871c-761b1e61fa9b';
const AGREEMENT_IDS = [...ARCHIVE_AGREEMENT_IDS, CANON_BETROTHAL_AGREEMENT_ID];
const TIMELINE_PROJECTION_PREFIX = /^(?:agreement|alliance|betrayal|clue[_ -]discovery|correction|deadline|death|faction[_ -](?:move|signal)|imported[_ -]memory|injury|marriage|promise|relationship[_ -]shift|reveal|rumor|scene[_ -]transition|scheme|world[_ -]tick)\s*:/i;
const DEADLINE_POISON = /truth-stone rite will occur tomorrow|armor polishing before dawn|\bdue\s+-?\d+t\b/i;
const CORRECTED_TRUTH_STONE_FACT = 'The truth-stone rite requires the player\'s sword hand to remain open and still; the court has not fixed the ceremony date.';
const CORRECTED_ARMOR_MEMORY = 'Promised to arrange hand-polishing of Aurion\'s Qohorik steel armor before the ceremony, once its date is fixed.';

function asObject(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
	return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
}

export function assertNoActiveJobs(activeJobs) {
	assert.equal(activeJobs.length, 0, 'active Veil jobs block the v3 repair');
}

function repairMetadata(metadata, now, reason, extra = {}) {
	return {
		...asObject(metadata),
		loreIntegrityRepair: { key: REPAIR_KEY, at: now, reason },
		...extra,
	};
}

export function sanitizeMeiLinState(value) {
	const state = structuredClone(asObject(value));
	state.knownFacts = uniqueStrings(asArray(state.knownFacts).map((fact) => {
		if (/^The truth-stone rite will occur tomorrow\b/i.test(String(fact).trim())) return CORRECTED_TRUTH_STONE_FACT;
		return String(fact);
	}));
	const eventMemory = structuredClone(asObject(state.eventMemory));
	for (const key of ['did', 'saw', 'knew', 'knows']) {
		const repaired = [];
		for (const raw of asArray(eventMemory[key])) {
			const line = String(raw).trim();
			if (!line) continue;
			if (/^promise:\s*Armor polishing before dawn\b/i.test(line)) {
				repaired.push(CORRECTED_ARMOR_MEMORY);
				continue;
			}
			if (TIMELINE_PROJECTION_PREFIX.test(line)) continue;
			repaired.push(line);
		}
		eventMemory[key] = uniqueStrings(repaired);
	}
	state.eventMemory = eventMemory;
	assert.doesNotMatch(JSON.stringify(state), /truth-stone rite will occur tomorrow|armor polishing before dawn/i);
	return state;
}

export function sanitizeMeiLinMetadata(value) {
	const metadata = structuredClone(asObject(value));
	for (const container of [metadata, asObject(metadata.originalMetadata)]) {
		if (Array.isArray(container.knownFacts)) {
			container.knownFacts = sanitizeMeiLinState({ knownFacts: container.knownFacts }).knownFacts;
		}
		for (const key of ['eventMemory', 'npcEventMemory']) {
			if (!container[key] || typeof container[key] !== 'object') continue;
			container[key] = sanitizeMeiLinState({ eventMemory: container[key] }).eventMemory;
		}
	}
	assert.doesNotMatch(JSON.stringify(metadata), /truth-stone rite will occur tomorrow|armor polishing before dawn/i);
	return metadata;
}

export function normalizeCeremonyEvent(row, now) {
	const common = {
		...row,
		status: 'committed',
		scheduled_turn: null,
		metadata: repairMetadata(row.metadata, now, 'Remove a stale or invented ceremony countdown while preserving the witnessed promise or warning.', {
			dateNotFixed: true,
		}),
	};
	if (row.id === ARMOR_AGREEMENT_ID) return {
		...common,
		title: 'Armor polishing arranged; ceremony date not fixed',
		occurred_turn: row.occurred_turn ?? row.created_turn,
	};
	if (row.id === ARMOR_PROMISE_ID) return {
		...common,
		title: 'Superseded stale armor-polishing deadline',
		body: 'This duplicate deadline projection was cancelled. Mei-Lin\'s supported offer to arrange armor polishing remains recorded without a ceremony date.',
		status: 'cancelled',
		occurred_turn: null,
		world_time: null,
		metadata: repairMetadata(row.metadata, now, 'Replace the unsupported before-dawn deadline with the explicit later correction that no ceremony date is fixed.', {
			dateNotFixed: true,
			superseded: true,
			nonCanon: true,
			invalidated: true,
		}),
	};
	if (row.id === TRUTH_STONE_WARNING_ID) return {
		...common,
		occurred_turn: row.occurred_turn ?? row.created_turn,
	};
	throw new Error(`Unexpected ceremony event: ${row.id}`);
}

export function retireAutoTagEvent(row, now) {
	return {
		...row,
		status: 'cancelled',
		scheduled_turn: null,
		metadata: repairMetadata(row.metadata, now, 'Retire a source-free generic character-tag faction projection that was never promoted into canon.', {
			superseded: true,
			nonCanon: true,
			invalidated: true,
			autoTagProjection: true,
		}),
	};
}

export function retireAutoTagFaction(row, now) {
	const duplicateImperialTag = row.id === AZURE_THRONE_FACTION_ID || row.id === YI_TI_FACTION_ID;
	const metadata = {
		...asObject(row.metadata),
		worldSimEnabled: false,
		worldSimPromoted: false,
		currentStoryEvidence: false,
		pressureReasons: [],
		lastWorldSimTickAt: null,
		lastWorldSimTickTurn: null,
		lastWorldSimTickJobId: null,
		lastWorldSimTickEventId: null,
		lastWorldSimTickPressure: null,
		lastWorldSimSignalEventId: null,
		nonCanon: true,
		superseded: true,
		nonCanonReason: duplicateImperialTag
			? 'Duplicate character-tag projection superseded by the canonical Golden Empire of Yi Ti faction.'
			: 'Valyrian is a character tag/culture label here, not an evidence-backed autonomous faction.',
		projectionStatus: 'superseded_unpromoted_character_tag',
		...(duplicateImperialTag ? { supersededByFactionId: CANON_YI_TI_FACTION_ID } : {}),
	};
	return {
		...row,
		pressure: 0,
		metadata: repairMetadata(metadata, now, 'Disable the unpromoted Valyrian character-tag faction and clear its generated pressure loop.'),
	};
}

export function retireAutoTagMemory(row, now) {
	const factionName = typeof asObject(row.metadata).factionName === 'string'
		? asObject(row.metadata).factionName
		: String(row.title ?? 'character-tag faction').replace(/\s+pressure$/i, '');
	return {
		...row,
		title: 'Superseded unpromoted character-tag faction projection',
		content: `This generated ${factionName} faction projection came from an unpromoted character tag and is not canon.`,
		summary: 'Superseded source-free character-tag faction projection; not canon.',
		keywords: [],
		importance: 0,
		visibility: 'secret',
		metadata: repairMetadata(row.metadata, now, 'Retire memory generated from an unpromoted generic character-tag faction.', {
			superseded: true,
			nonCanon: true,
			invalidated: true,
			autoTagProjection: true,
		}),
	};
}

export function reconcileAgreement(row) {
	if (ARCHIVE_AGREEMENT_IDS.includes(row.id)) return { ...row, status: 'archived' };
	if (row.id === CANON_BETROTHAL_AGREEMENT_ID) return {
		...row,
		status: 'active',
		terms: 'Aurion accepted Bu Gai\'s conditional betrothal offer to Princess Mei-Lin. The existing war-and-dynasty conditions remain; the court has not fixed a ceremony date.',
	};
	throw new Error(`Unexpected agreement: ${row.id}`);
}

export function archiveAutoTagMembership(row, now) {
	return {
		...row,
		status: 'archived',
		metadata: repairMetadata(row.metadata, now, 'Archive membership generated from a duplicate or unpromoted character-tag faction.', {
			superseded: true,
			nonCanon: true,
		}),
	};
}

export function retireUnsafePlotFrame(storyMetadata, now) {
	const metadata = structuredClone(asObject(storyMetadata));
	const plotBrain = { ...asObject(metadata.plotBrain) };
	assert.equal(asObject(plotBrain.lastFrame).id, UNSAFE_FRAME_ID, 'the guarded inactive Plot Director frame changed; inspect it before applying v3');
	const retiredPlotDirectives = uniqueStrings([
		...asArray(plotBrain.retiredPlotDirectives),
		'Unsupported Azure Throne intelligence operation against House Belaerys copied from a cancelled auto-tag faction event',
	]);
	delete plotBrain.lastFrame;
	metadata.plotBrain = {
		...plotBrain,
		active: false,
		lastFrameId: null,
		lastFrameTurn: null,
		lastPlanAt: null,
		plotCardCount: 0,
		quietUntilTurn: null,
		retiredAt: now,
		retiredFrameId: UNSAFE_FRAME_ID,
		retirementReason: 'Retired because the inactive draft copied a cancelled, source-free auto-tag faction event; it was never activated or injected into narration.',
		retiredPlotDirectives,
	};
	return metadata;
}

function parseArgs(argv) {
	const result = {
		apply: false,
		expectedVersion: null,
		backupRoot: path.resolve('exports', 'repairs', 'veil-live-lore-integrity'),
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--apply') result.apply = true;
		else if (arg === '--preview') result.apply = false;
		else if (arg === '--expected-version') result.expectedVersion = Number(argv[++index]);
		else if (arg.startsWith('--expected-version=')) result.expectedVersion = Number(arg.slice('--expected-version='.length));
		else if (arg === '--backup-root') result.backupRoot = path.resolve(argv[++index]);
		else if (arg.startsWith('--backup-root=')) result.backupRoot = path.resolve(arg.slice('--backup-root='.length));
		else throw new Error(`Unknown argument: ${arg}`);
	}
	if (!Number.isInteger(result.expectedVersion) || result.expectedVersion < 1) {
		throw new Error('--expected-version <positive integer> is required');
	}
	return result;
}

async function loadInvariants(sql) {
	const [transcript] = await sql`
		select count(*)::int as entry_count, min(position) as min_position, max(position) as max_position,
			md5(coalesce(string_agg(position::text || ':' || id || ':' || md5(content), '|' order by position, id), '')) as transcript_md5
		from story_entries where story_id = ${STORY_ID}`;
	const [affinity] = await sql`
		select md5(coalesce(string_agg(payload, '|' order by sort_key), '')) as affinity_md5 from (
			select 'entity:' || id as sort_key,
				coalesce((state -> 'relationship')::text, 'null') || ':' || coalesce((state -> 'affinity')::text, 'null') || ':' ||
				coalesce((state -> 'relationshipHistory')::text, 'null') || ':' || coalesce((state -> 'affinityHistory')::text, 'null') as payload
			from entities where story_id = ${STORY_ID}
			union all
			select 'relationship:' || id, row_to_json(r)::text from relationships r where story_id = ${STORY_ID}
		) guarded`;
	return { ...transcript, affinity_md5: affinity.affinity_md5 };
}

async function loadSnapshot(sql, forUpdate = false) {
	const lock = forUpdate ? sql` for update` : sql``;
	const storyRows = await sql`select * from stories where id = ${STORY_ID}${lock}`;
	assert.equal(storyRows.length, 1, 'Veil story is missing');
	const entityRows = await sql`select * from entities where story_id = ${STORY_ID} and id = ${MEI_LIN_ID}${lock}`;
	const eventRows = await sql`select * from story_events where story_id = ${STORY_ID} and id in ${sql([...CEREMONY_EVENT_IDS, ...AUTO_TAG_EVENT_IDS])} order by id${lock}`;
	const factionRows = await sql`select * from factions where story_id = ${STORY_ID} and id in ${sql(AUTO_TAG_FACTION_IDS)} order by id${lock}`;
	const membershipRows = await sql`select * from faction_memberships where story_id = ${STORY_ID} and faction_id in ${sql(AUTO_TAG_FACTION_IDS)} order by id${lock}`;
	const memoryRows = await sql`select * from memory_nodes where story_id = ${STORY_ID} and id in ${sql(MEMORY_IDS)} order by id${lock}`;
	const agreementRows = await sql`select * from agreements where story_id = ${STORY_ID} and id in ${sql(AGREEMENT_IDS)} order by id${lock}`;
	const activeJobs = await sql`select id,type,status,attempt_count,max_attempts,run_after,locked_at,locked_by,last_error from backend_jobs where story_id = ${STORY_ID} and status in ('queued','retry','running') order by run_after,id${lock}`;
	return {
		story: storyRows[0],
		entity: entityRows[0],
		events: eventRows,
		factions: factionRows,
		memberships: membershipRows,
		memories: memoryRows,
		agreements: agreementRows,
		activeJobs,
		invariants: await loadInvariants(sql),
	};
}

export function buildV3Plan(snapshot, now) {
	assert.equal(snapshot.story.title, 'Veil', 'story ID no longer belongs to Veil');
	const repairs = asObject(asObject(snapshot.story.metadata).loreIntegrityRepairs);
	if (asObject(repairs[REPAIR_KEY]).applied === true) return { alreadyApplied: true, marker: repairs[REPAIR_KEY] };
	for (const key of PRIOR_REPAIR_KEYS) assert.equal(asObject(repairs[key]).applied, true, `${key} must be applied first`);
	assert.ok(snapshot.entity, 'Mei-Lin entity is missing');
	assert.equal(snapshot.factions.length, AUTO_TAG_FACTION_IDS.length, 'one or more guarded active character-tag factions are missing');
	assert.equal(snapshot.events.length, CEREMONY_EVENT_IDS.length + AUTO_TAG_EVENT_IDS.length, 'one or more guarded events are missing');
	assert.equal(snapshot.memories.length, MEMORY_IDS.length, 'one or more guarded Valyrian memories are missing');
	assert.equal(snapshot.memberships.length, 5, 'one or more guarded auto-tag memberships are missing');
	assert.equal(snapshot.agreements.length, AGREEMENT_IDS.length, 'one or more guarded stale agreements are missing');
	assert.deepEqual(new Set(snapshot.events.map((row) => row.id)), new Set([...CEREMONY_EVENT_IDS, ...AUTO_TAG_EVENT_IDS]));
	assert.deepEqual(new Set(snapshot.memories.map((row) => row.id)), new Set(MEMORY_IDS));
	assert.deepEqual(new Set(snapshot.factions.map((row) => row.id)), new Set(AUTO_TAG_FACTION_IDS));
	assert.deepEqual(new Set(snapshot.agreements.map((row) => row.id)), new Set(AGREEMENT_IDS));
	assert.match(JSON.stringify(snapshot.entity.state), /truth-stone rite will occur tomorrow/i, 'guarded Mei-Lin deadline poison is no longer present');
	assert.equal(asObject(snapshot.story.metadata).plotBrain?.active, false, 'unsafe Plot Director frame unexpectedly became active');

	const newVersion = Number(snapshot.story.server_version) + 1;
	const entity = {
		...snapshot.entity,
		state: sanitizeMeiLinState(snapshot.entity.state),
		metadata: repairMetadata(sanitizeMeiLinMetadata(snapshot.entity.metadata), now, 'Remove stale deadline projections from compact character state without changing affinity, location, or current relationship.'),
	};
	assert.deepEqual(asObject(entity.state).relationship, asObject(snapshot.entity.state).relationship, 'Mei-Lin relationship state changed');
	assert.deepEqual(asObject(entity.state).affinity, asObject(snapshot.entity.state).affinity, 'Mei-Lin affinity state changed');

	const ceremonyEvents = snapshot.events.filter((row) => CEREMONY_EVENT_IDS.includes(row.id)).map((before) => ({ before, after: normalizeCeremonyEvent(before, now) }));
	const autoTagEvents = snapshot.events.filter((row) => AUTO_TAG_EVENT_IDS.includes(row.id)).map((before) => ({ before, after: retireAutoTagEvent(before, now) }));
	const memories = snapshot.memories.map((before) => ({ before, after: retireAutoTagMemory(before, now) }));
	const storyMetadata = retireUnsafePlotFrame(snapshot.story.metadata, now);
	const marker = {
		applied: true,
		appliedAt: now,
		previousServerVersion: Number(snapshot.story.server_version),
		serverVersion: newVersion,
		retiredFrameId: UNSAFE_FRAME_ID,
		entityId: MEI_LIN_ID,
		ceremonyEventIds: CEREMONY_EVENT_IDS,
		retiredAutoTagEventIds: AUTO_TAG_EVENT_IDS,
		retiredAutoTagMemoryIds: MEMORY_IDS,
		reason: 'Remove remaining ceremony deadline poison and retire the source-free Valyrian auto-tag faction loop that contaminated an inactive Plot Director draft.',
	};
	storyMetadata.loreIntegrityRepairs = { ...repairs, [REPAIR_KEY]: marker };
	assert.doesNotMatch(JSON.stringify({
		entityState: entity.state,
		ceremonyEvents: ceremonyEvents.map(({ after }) => after),
		plotBrain: storyMetadata.plotBrain,
	}), DEADLINE_POISON);
	return {
		alreadyApplied: false,
		newVersion,
		entity,
		ceremonyEvents,
		autoTagEvents,
		factions: snapshot.factions.map((before) => ({ before, after: retireAutoTagFaction(before, now) })),
		memberships: snapshot.memberships.map((before) => ({ before, after: archiveAutoTagMembership(before, now) })),
		memories,
		agreements: snapshot.agreements.map((before) => ({ before, after: reconcileAgreement(before) })),
		storyMetadata,
		marker,
	};
}

function preview(snapshot, plan) {
	if (plan.alreadyApplied) return { ok: true, mode: 'preview', storyId: STORY_ID, alreadyApplied: true, marker: plan.marker };
	return {
		ok: snapshot.activeJobs.length === 0,
		mode: 'preview',
		storyId: STORY_ID,
		serverVersion: Number(snapshot.story.server_version),
		plannedServerVersion: plan.newVersion,
		currentTurn: snapshot.story.current_turn,
		currentWorldTime: snapshot.story.current_world_time,
		activeJobs: snapshot.activeJobs,
		invariants: snapshot.invariants,
		changes: {
			entityId: plan.entity.id,
			ceremonyEvents: plan.ceremonyEvents.map(({ before, after }) => ({ id: after.id, status: `${before.status} -> ${after.status}`, scheduledTurn: `${before.scheduled_turn} -> ${after.scheduled_turn}`, title: `${before.title} -> ${after.title}` })),
			retiredAutoTagEvents: plan.autoTagEvents.map(({ after }) => after.id),
			retiredAutoTagFactions: plan.factions.map(({ after }) => after.id),
			archivedAutoTagMemberships: plan.memberships.map(({ after }) => after.id),
			retiredAutoTagMemories: plan.memories.map(({ after }) => after.id),
			reconciledAgreements: plan.agreements.map(({ before, after }) => ({ id: after.id, status: `${before.status} -> ${after.status}`, terms: after.terms })),
			retiredPlotFrameId: UNSAFE_FRAME_ID,
		},
		preserved: { transcriptEntriesDeleted: 0, currentTurnChanged: false, currentWorldTimeChanged: false, affinityHistoryChanged: false },
		applyCommand: `node scripts/repair-veil-live-lore-v3.mjs --apply --expected-version ${snapshot.story.server_version}`,
	};
}

async function writeBackup(snapshot, backupRoot) {
	const stamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupPath = path.join(backupRoot, `${stamp}-v${snapshot.story.server_version}-v3`);
	await mkdir(backupPath, { recursive: true });
	await writeFile(path.join(backupPath, 'backend-targets-before.json'), `${JSON.stringify({
		repairKey: REPAIR_KEY,
		createdAt: new Date().toISOString(),
		storyId: STORY_ID,
		invariants: snapshot.invariants,
		story: snapshot.story,
		entity: snapshot.entity,
		events: snapshot.events,
		factions: snapshot.factions,
		memberships: snapshot.memberships,
		memories: snapshot.memories,
		agreements: snapshot.agreements,
		activeJobs: snapshot.activeJobs,
	}, null, 2)}\n`, 'utf8');
	return backupPath;
}

async function applyPlan(tx, snapshot, plan, now, backupPath) {
	const version = plan.newVersion;
	const checkpointId = `checkpoint_${REPAIR_KEY}_v${snapshot.story.server_version}`;
	plan.marker.backupPath = backupPath;
	plan.marker.checkpointId = checkpointId;
	plan.storyMetadata.loreIntegrityRepairs[REPAIR_KEY] = plan.marker;

	const entity = await tx`update entities set state = ${tx.json(plan.entity.state)}, metadata = ${tx.json(plan.entity.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${MEI_LIN_ID} and server_version = ${snapshot.entity.server_version} returning id`;
	assert.equal(entity.length, 1, 'Mei-Lin changed during v3 repair');
	for (const { before, after } of [...plan.ceremonyEvents, ...plan.autoTagEvents]) {
		const updated = await tx`update story_events set status = ${after.status}, title = ${after.title}, body = ${after.body}, occurred_turn = ${after.occurred_turn}, scheduled_turn = ${after.scheduled_turn}, world_time = ${after.world_time}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `story event changed during v3 repair: ${after.id}`);
	}
	for (const { before, after } of plan.factions) {
		const faction = await tx`update factions set pressure = ${after.pressure}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(faction.length, 1, `character-tag faction changed during v3 repair: ${after.id}`);
	}
	for (const { before, after } of plan.memberships) {
		const membership = await tx`update faction_memberships set status = ${after.status}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(membership.length, 1, `character-tag membership changed during v3 repair: ${after.id}`);
	}
	for (const { before, after } of plan.memories) {
		const updated = await tx`update memory_nodes set title = ${after.title}, content = ${after.content}, summary = ${after.summary}, keywords = ${tx.json(after.keywords)}, importance = ${after.importance}, visibility = ${after.visibility}, metadata = ${tx.json(after.metadata)}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(updated.length, 1, `memory changed during v3 repair: ${after.id}`);
	}
	for (const { before, after } of plan.agreements) {
		const agreement = await tx`update agreements set status = ${after.status}, terms = ${after.terms}, server_version = ${version}, updated_at = ${now} where story_id = ${STORY_ID} and id = ${after.id} and server_version = ${before.server_version} returning id`;
		assert.equal(agreement.length, 1, `agreement changed during v3 repair: ${after.id}`);
	}
	await tx`insert into context_checkpoints (id, story_id, label, reason, entry_position, current_turn, snapshot, metadata, server_version, created_at, updated_at)
		values (${checkpointId}, ${STORY_ID}, ${'Before Veil lore-integrity v3'}, ${plan.marker.reason}, ${snapshot.invariants.max_position}, ${snapshot.story.current_turn}, ${tx.json({ backupPath, targetIds: { entity: MEI_LIN_ID, events: [...CEREMONY_EVENT_IDS, ...AUTO_TAG_EVENT_IDS], factions: AUTO_TAG_FACTION_IDS, memberships: plan.memberships.map(({ after }) => after.id), memories: MEMORY_IDS, agreements: AGREEMENT_IDS, plotFrame: UNSAFE_FRAME_ID } })}, ${tx.json({ repairKey: REPAIR_KEY, previousServerVersion: snapshot.story.server_version })}, ${version}, ${now}, ${now}) on conflict (id) do nothing`;
	const story = await tx`update stories set metadata = ${tx.json(plan.storyMetadata)}, server_version = ${version}, updated_at = ${now} where id = ${STORY_ID} and server_version = ${snapshot.story.server_version} returning id`;
	assert.equal(story.length, 1, 'Veil story version changed during v3 repair');

	const jobs = [
		{ id: `job_sync_story_vault_${REPAIR_KEY}_v${version}`, type: 'sync_story_vault', payload: { serverVersion: version, reason: REPAIR_KEY, clean: true, index: true, lint: true } },
		{ id: `job_embed_memory_nodes_${REPAIR_KEY}_v${version}`, type: 'embed_memory_nodes', payload: { serverVersion: version, memoryNodeIds: MEMORY_IDS } },
		{ id: `job_index_canonical_records_${REPAIR_KEY}_v${version}`, type: 'index_canonical_records', payload: { serverVersion: version, reason: REPAIR_KEY, recreate: false, maxRecords: 100, recordTypes: ['entities', 'events', 'factions', 'factionMemberships', 'agreements'] } },
	];
	for (const job of jobs) {
		const queued = await tx`insert into backend_jobs (id, story_id, type, payload, status, attempt_count, max_attempts, run_after, metadata, created_at, updated_at)
			values (${job.id}, ${STORY_ID}, ${job.type}, ${tx.json(job.payload)}, 'queued', 0, 3, ${now}, ${tx.json({ repairKey: REPAIR_KEY })}, ${now}, ${now}) on conflict (id) do nothing returning id`;
		assert.equal(queued.length, 1, `v3 repair job ID is already occupied: ${job.id}`);
	}
	const after = await loadInvariants(tx);
	assert.deepEqual(after, snapshot.invariants, 'v3 repair changed transcript identity or affinity history');
	return jobs.map((job) => job.id);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const sql = postgres(databaseUrl(), { max: 1, prepare: false });
	try {
		if (!args.apply) {
			const snapshot = await loadSnapshot(sql);
			assert.equal(Number(snapshot.story.server_version), args.expectedVersion, `expected version ${args.expectedVersion}, found ${snapshot.story.server_version}`);
			const plan = buildV3Plan(snapshot, new Date().toISOString());
			const output = preview(snapshot, plan);
			if (!output.ok) throw new Error(`Preview is blocked by active Veil jobs: ${JSON.stringify(snapshot.activeJobs)}`);
			console.log(JSON.stringify(output, null, 2));
			return;
		}
		let result;
		await sql.begin(async (tx) => {
			await tx`select pg_advisory_xact_lock(hashtextextended(${`mtherios:story-entry:${STORY_ID}`}, 0))`;
			const snapshot = await loadSnapshot(tx, true);
			assert.equal(Number(snapshot.story.server_version), args.expectedVersion, `expected version ${args.expectedVersion}, found ${snapshot.story.server_version}`);
			assertNoActiveJobs(snapshot.activeJobs);
			const now = new Date().toISOString();
			const plan = buildV3Plan(snapshot, now);
			if (plan.alreadyApplied) {
				result = { alreadyApplied: true, marker: plan.marker };
				return;
			}
			const backupPath = await writeBackup(snapshot, args.backupRoot);
			const jobIds = await applyPlan(tx, snapshot, plan, now, backupPath);
			result = { alreadyApplied: false, backupPath, previousServerVersion: snapshot.story.server_version, serverVersion: plan.newVersion, jobIds };
		});
		console.log(JSON.stringify({ ok: true, mode: 'apply', storyId: STORY_ID, ...result, transcriptEntriesDeleted: 0, affinityHistoryChanged: false }, null, 2));
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
