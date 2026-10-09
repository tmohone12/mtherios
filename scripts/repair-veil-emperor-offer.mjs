#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const STORY_ID = 'story_52d7c651-0b16-4b91-890d-e7f226f7926b';
const STORY_SLUG = STORY_ID.replaceAll('-', '_');
const TARGET_POSITION = 514;
const TARGET_TURN = 254;
const TARGET_LOCATION_ID = 'entity_2e839377-36b0-4ffb-a0a8-2823ccb1b954';
const TARGET_WORLD_TIME = 'Day First Moon 29, 296 AC | 11:06';
const REPAIR_VERSION = 872;
const OFFER_ENTRY_ID = 'narration_a63e894a-e82f-4137-83cf-9e20db1a09db';
const OFFER_PATCH_ID = 'patch_4062cc8a-d807-4b56-baa6-65c43b338d7e';
const OFFER_EVENT_ID = 'event_e7f84a99-b328-4996-b277-17edb5b91374';
const OFFER_MEMORY_ID = `mem_event_${OFFER_EVENT_ID}`;
const OFFER_TURN_EVENT_ID = 'event_4efff6ab-cbf3-43e5-b772-1342a26b3559';
const YITISH_THREAD_ID = `plot_thread_${STORY_SLUG}_the_yitish_marriage_gambit`;
const BU_GAI_ENTITY_ID = 'veil_entity_bu_gai';
const MEI_LIN_ENTITY_ID = 'veil_entity_mei_lin';
const AEGON_ENTITY_ID = 'veil_entity_aurion_belaerys';
const YI_TI_FACTION_ID = 'veil_faction_golden_empire_yi_ti';
const LENG_COURT_FACTION_ID = 'veil_faction_imperial_court_leng';
const FIRST_TERRACE_LOCATION_ID = 'entity_0685ef32-ec4e-487c-9bac-d177fb0f5ed7';
const YITISH_SUMMONS_EVENT_ID = `plot_event_${STORY_SLUG}_plot_thread_${STORY_SLUG}_the_yitish_marriage_gambit_72fe5e20a720`;
const DUPLICATE_YITISH_GARDEN_EVENT_ID = `plot_event_${STORY_SLUG}_plot_thread_${STORY_SLUG}_the_yitish_marriage_gambit_bba87b445f69`;
const LENG_PRESSURE_MEMORY_ID = 'mem_faction_pressure_veil_faction_imperial_court_leng';
const DEPARTURE_PLAYER_ENTRY_ID = 'entry_bcbf1a59-6d70-41ba-be41-5451261877a9';
const DEPARTURE_PATCH_ID = 'patch_594b4e82-b89d-4e97-a309-eab87a1f0441';
const DEPARTURE_REVEAL_EVENT_ID = 'event_cec326c6-d560-4b32-af5e-792450fc5c89';
const DEPARTURE_REVEAL_MEMORY_ID = `mem_event_${DEPARTURE_REVEAL_EVENT_ID}`;
const PARALLEL_DEPARTURE_MEMORY_ID = 'mem_event_event_adc4c6e9-f0f5-4137-9094-5a1d3cbcca09';
const VALYRIAN_PRESSURE_MEMORY_ID = `mem_faction_pressure_faction_tag_${STORY_SLUG}_valyrian`;
const SANITIZABLE_MIXED_MEMORY_IDS = new Set([
	'mem_faction_pressure_faction_entity_46fee601-b44d-441e-8f97-b87b4d2d6ebe',
	`mem_faction_pressure_faction_tag_${STORY_SLUG}_old_blood`,
	PARALLEL_DEPARTURE_MEMORY_ID,
	DEPARTURE_REVEAL_MEMORY_ID,
	VALYRIAN_PRESSURE_MEMORY_ID,
]);
const CONTAMINATED_FACTION_PROJECT_IDS = new Set([
	'faction_project_faction_entity_46fee601_b44d_441e_8f97_b87b4d2d6ebe_lan_fb29435c',
	'faction_project_faction_entity_46fee601_b44d_441e_8f97_b87b4d2d6ebe_war_e08bb304',
	'faction_project_faction_tag_story_52d7c651_0b16_4b91_890d_e7f226f7926b__51889dde',
]);
const LENG_PRESSURE_EVENT_IDS = [
	'veil_event_arrival_leng_001',
	`plot_event_${STORY_SLUG}_plot_thread_${STORY_SLUG}_the_confession_s_fallout_2cb2fc60162a`,
];

const POISON_THREAD_IDS = new Set([
	`plot_thread_${STORY_SLUG}_the_empress_s_shadow`,
	`plot_thread_${STORY_SLUG}_the_quarter_and_the_brides`,
]);
const POISON_AGREEMENT_IDS = new Set([
	'agreement_2487f1f4-75b4-402f-b8b9-cb8fca674a9b',
	'agreement_e7d3ea82-46c0-4d88-9de0-703b5be62f7c',
]);
const POISON_EVENT_IDS = new Set([
	`plot_event_${STORY_SLUG}_plot_thread_${STORY_SLUG}_the_empress_s_shadow_e61a30603cd9`,
	`plot_event_${STORY_SLUG}_plot_thread_${STORY_SLUG}_the_quarter_and_the_brides_0a949050d052`,
	'event_de9990c5-3ca8-4188-8e52-23d899eac632',
	DUPLICATE_YITISH_GARDEN_EVENT_ID,
]);

const POISON_TEXT = /(?:not while the God-Empress breathes|bind your star to the throne of Leng|pending the God-Empress'?s approval|quarter and the brides|brides for his men|God-Empress may use the quarter|God-Empress'?s Judgment)/i;

const CORRECTED_OFFER = `[ 🕰️ Time 11:06 | 🗓️ Day, First Moon 29, 296 AC | 📍 Yin — The Low Water-Garden, Summit Terrace | [Weather] Bright, hazy morning, 84°F; thin white clouds drift above the river like torn silk, and the light on the high terrace has sharpened to a dull gold ]

There is a pause after you finish—not silence, exactly. The air itself seems to thicken, the way it does before a storm, or before two men decide whether a conversation has become an oath.

The God-Emperor does not blink.

His gaze remains on yours as you lift your head, and for a long moment the only movement on the Summit Terrace is the river far below and the old woman's thumb pressed white against a black bead.

"A dragon rises from the pit," Bu Gai repeats, not mockingly, but with the care of a court scholar weighing an old translation. "The Tigers want you for a sword. The Elephants want you for a debt. Yet you stand here claiming that two houses have already learned the price of mistaking you for either."

He rises without hurry and walks to the balustrade, both hands clasped behind his back. Below him lies Yin: river, roofs, banners, and the long walls of the Golden Empire's capital.

"Then let us speak plainly," he says. "I did not send Mei-Lin to discover whether you were harmless. I sent my daughter to learn whether the man beneath the borrowed name possessed judgment equal to his power."

Mei-Lin's eyes lift to her father's. Her composure holds, but her folded hands tighten once.

Bu Gai turns back to you. "Leng has its own throne and its own God-Empress. She does not rule Yi Ti, and she has no voice in what I offer beneath the Azure Throne."

He steps close enough that the question no longer belongs to the watching court.

"Marry my daughter, Princess Mei-Lin. Join your dragon's blood to mine and stand beside the Golden Empire as kin—not servant, not hostage, and not passing guest."

The old woman's beads stop. Mei-Lin watches you without looking away.

"Will you take her hand, Aegon Targaryen?"`;

function parseArgs(argv) {
	const result = {};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const value = argv[index + 1];
		if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value.`);
		result[key] = value;
		index += 1;
	}
	return result;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function unique(values) {
	return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function isContaminatedCrossLoreWorldTick(event) {
	return event?.metadata?.sourceType === 'terminal_world_sim_tick'
		&& asArray(event.metadata?.targetFactionIds).some((id) => id.startsWith('veil_scratch_asoiaf_faction_'));
}

function filterRetrievedMemoryRefs(row, removedMemoryIds) {
	let result = row;
	if (Array.isArray(row.metadata?.retrievedMemoryIds)) {
		result = {
			...result,
			metadata: {
				...row.metadata,
				retrievedMemoryIds: row.metadata.retrievedMemoryIds.filter((id) => !removedMemoryIds.has(id)),
			},
		};
	}
	if (Array.isArray(row.operations)) {
		result = {
			...result,
			operations: row.operations.map((operation) => {
				if (!Array.isArray(operation?.value?.retrievedMemoryIds)) return operation;
				return {
					...operation,
					value: {
						...operation.value,
						retrievedMemoryIds: operation.value.retrievedMemoryIds.filter((id) => !removedMemoryIds.has(id)),
					},
				};
			}),
		};
	}
	return result;
}

function retainRetrievedMemoryRefs(row, retainedMemoryIds) {
	let result = row;
	if (Array.isArray(row.metadata?.retrievedMemoryIds)) {
		result = {
			...result,
			metadata: {
				...row.metadata,
				retrievedMemoryIds: row.metadata.retrievedMemoryIds.filter((id) => retainedMemoryIds.has(id)),
			},
		};
	}
	if (Array.isArray(row.operations)) {
		result = {
			...result,
			operations: row.operations.map((operation) => {
				if (!Array.isArray(operation?.value?.retrievedMemoryIds)) return operation;
				return {
					...operation,
					value: {
						...operation.value,
						retrievedMemoryIds: operation.value.retrievedMemoryIds.filter((id) => retainedMemoryIds.has(id)),
					},
				};
			}),
		};
	}
	return result;
}

function retrievedMemoryRefs(row) {
	return [
		...asArray(row.metadata?.retrievedMemoryIds),
		...asArray(row.operations).flatMap((operation) => asArray(operation?.value?.retrievedMemoryIds)),
	];
}

function containsExactReference(value, ids) {
	if (typeof value === 'string') return ids.has(value);
	if (Array.isArray(value)) return value.some((item) => containsExactReference(item, ids));
	if (value && typeof value === 'object') return Object.values(value).some((item) => containsExactReference(item, ids));
	return false;
}

function filterSourceArrays(row, retainedEntryIds, retainedEventIds, retainedPatchIds) {
	const result = { ...row };
	if (Array.isArray(row.sourceEntryIds)) result.sourceEntryIds = unique(row.sourceEntryIds.filter((id) => retainedEntryIds.has(id)));
	if (Array.isArray(row.sourceEventIds)) result.sourceEventIds = unique(row.sourceEventIds.filter((id) => retainedEventIds.has(id)));
	if (Array.isArray(row.sourcePatchIds)) result.sourcePatchIds = unique(row.sourcePatchIds.filter((id) => retainedPatchIds.has(id)));
	return result;
}

function hadSources(row) {
	return ['sourceEntryIds', 'sourceEventIds', 'sourcePatchIds'].some((key) => asArray(row[key]).length > 0);
}

function hasSources(row) {
	return ['sourceEntryIds', 'sourceEventIds', 'sourcePatchIds'].some((key) => asArray(row[key]).length > 0);
}

function isFoundationRecord(row) {
	return row.metadata?.veilFoundationImport === true
		|| row.metadata?.scratchSeed === true
		|| row.metadata?.source === 'user_directive_veil_aurion_leng_start';
}

function retainedOrFoundation(row, filtered) {
	return !hadSources(row) || hasSources(filtered) || isFoundationRecord(row);
}

function correctedOfferEvent(now) {
	return {
		id: OFFER_EVENT_ID,
		storyId: STORY_ID,
		type: 'reveal',
		status: 'committed',
		title: "The God-Emperor's Marriage Offer",
		body: "God-Emperor Bu Gai offers his daughter, Princess Mei-Lin of Yi Ti, in marriage to Aegon Targaryen, proposing a dynastic alliance with Yi Ti's Azure Throne. Leng remains a separate polity under its God-Empress and has no authority over the offer.",
		actorEntityIds: [BU_GAI_ENTITY_ID],
		targetEntityIds: [AEGON_ENTITY_ID, MEI_LIN_ENTITY_ID],
		locationId: TARGET_LOCATION_ID,
		locationIds: [TARGET_LOCATION_ID],
		factionIds: [YI_TI_FACTION_ID],
		threadIds: [YITISH_THREAD_ID],
		visibility: 'player_known',
		createdTurn: TARGET_TURN,
		occurredTurn: TARGET_TURN,
		scheduledTurn: null,
		worldTime: TARGET_WORLD_TIME,
		memoryImpact: {},
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		metadata: { significance: 'major', source: 'canonical_emperor_offer_repair' },
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedOfferPatch(now) {
	return {
		id: OFFER_PATCH_ID,
		storyId: STORY_ID,
		operations: [
			{
				op: 'upsert',
				path: '/entities/character',
				value: {
					name: 'Bu Gai', goals: [], traits: [], aliases: [], pressures: [], description: 'God-Emperor and Son of Heaven of Yi Ti.',
					eventMemory: { did: ['Offered Princess Mei-Lin in marriage to Aegon Targaryen'], saw: [], knew: [], knows: [] },
					faction_tags: ['Yi Ti', 'Azure Throne'], relationship: null,
					currentAction: 'Awaiting Aegon Targaryen\'s answer to his offer of Princess Mei-Lin\'s hand',
					emotionalState: 'Controlled, calculating, resolute',
				},
			},
			{
				op: 'upsert',
				path: '/entities/character',
				value: {
					name: 'Mei-Lin', goals: [], traits: [], aliases: [], pressures: [], description: 'Princess of Yi Ti and daughter of God-Emperor Bu Gai.',
					eventMemory: { did: [], saw: ['Her father offered her hand to Aegon Targaryen'], knew: [], knows: [] },
					faction_tags: ['Yi Ti', 'Azure Throne'], relationship: null,
					currentAction: 'Watching Aegon after her father offers her hand in marriage', emotionalState: 'Composed, intent',
				},
			},
			{
				op: 'upsert',
				path: '/npc_beliefs',
				value: {
					npcName: 'Bu Gai',
					npcLearned: ['Aegon claims to have ended two houses of Volantis', 'Aegon sees himself as a dragon rising from the Black Walls'],
					topicSummary: "Bu Gai weighs Aegon's power and offers Princess Mei-Lin as a YiTish dynastic alliance.",
					emotionalShift: 'Bu Gai moves from testing Aegon to making a direct dynastic offer.',
					playerRevealed: ["Aegon's power in Volantis", "Aegon's belief that all men must serve and die"],
				},
			},
			{
				op: 'add',
				path: '/story_events',
				value: {
					title: "The God-Emperor's Marriage Offer",
					description: "God-Emperor Bu Gai offers Princess Mei-Lin's hand to Aegon Targaryen as a dynastic alliance with Yi Ti's Azure Throne. Leng is a separate polity and has no authority over the offer.",
					significance: 'major',
				},
			},
		],
		reason: 'Canonical repair of the first lore-poisoned narration at the emperor-offer rewind point.',
		status: 'applied',
		validationWarnings: [],
		sourceEntryIds: ['entry_a63e894a-e82f-4137-83cf-9e20db1a09db', OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedOfferMemory(now) {
	const body = "God-Emperor Bu Gai offered his daughter, Princess Mei-Lin of Yi Ti, in marriage to Aegon Targaryen as a dynastic alliance with Yi Ti's Azure Throne. The offer awaits Aegon's answer. Leng is independently ruled by its God-Empress and has no authority over the match.";
	return {
		id: OFFER_MEMORY_ID,
		storyId: STORY_ID,
		type: 'episodic',
		title: "The God-Emperor's Marriage Offer",
		content: body,
		summary: body,
		keywords: ['Bu Gai', 'Mei-Lin', 'Aegon Targaryen', 'marriage offer', 'Yi Ti', 'Azure Throne', 'Leng', 'God-Empress'],
		entityIds: [BU_GAI_ENTITY_ID, MEI_LIN_ENTITY_ID, AEGON_ENTITY_ID],
		factionIds: [YI_TI_FACTION_ID],
		threadIds: [YITISH_THREAD_ID],
		locationId: TARGET_LOCATION_ID,
		visibility: 'player_known',
		importance: 1,
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		metadata: { source: 'canonical_emperor_offer_repair', validFromTurn: TARGET_TURN },
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedJurisdictionFact(now) {
	return {
		id: 'veil_fact_yi_ti_leng_separate_sovereigns',
		storyId: STORY_ID,
		type: 'political_jurisdiction',
		subjectEntityId: 'veil_scratch_asoiaf_entity_asoiaf_yi_ti_0182',
		targetEntityId: 'veil_scratch_asoiaf_entity_asoiaf_island_of_leng_0183',
		title: 'Yi Ti and Leng have separate sovereigns',
		statement: "Bu Gai is God-Emperor and Son of Heaven of Yi Ti. The God-Empress independently rules Leng. Neither sovereign's title makes one subordinate to the other, and Leng has no authority over Bu Gai's offer of his YiTish daughter.",
		confidence: 1,
		status: 'active',
		visibility: 'player_known',
		firstSeenEntryId: OFFER_ENTRY_ID,
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		metadata: { source: 'canonical_emperor_offer_repair' },
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedCharacterEntity({ id, name, description, rank, role, knownFacts, eventMemory, currentAction, emotionalState }, now) {
	return {
		id,
		storyId: STORY_ID,
		type: 'character',
		name,
		description,
		status: 'active',
		visibility: 'player_known',
		state: {
			bio: description,
			rank,
			role,
			type: 'character',
			goals: [],
			voice: null,
			status: 'active',
			traits: [],
			present: true,
			isPresent: true,
			partyRole: null,
			appearance: null,
			background: description,
			hiddenInfo: null,
			knownFacts,
			eventMemory,
			factionName: 'Golden Empire of Yi Ti',
			factionTags: ['Yi Ti', 'Azure Throne'],
			motivations: [],
			partyMember: false,
			relationship: null,
			currentAction,
			emotionalState,
			currentLocation: 'Yin — The Low Water-Garden, Summit Terrace',
			currentLocationId: TARGET_LOCATION_ID,
		},
		metadata: { source: 'canonical_emperor_offer_repair' },
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedBuGaiEntity(now) {
	return correctedCharacterEntity({
		id: BU_GAI_ENTITY_ID,
		name: 'Bu Gai',
		description: 'God-Emperor and Son of Heaven of Yi Ti, sovereign of the Azure Throne and father of Princess Mei-Lin.',
		rank: 'God-Emperor; Son of Heaven',
		role: 'sovereign of Yi Ti',
		knownFacts: [
			'Leng is a separate polity under its own God-Empress.',
			'He offered Princess Mei-Lin in marriage to Aegon Targaryen as a dynastic alliance with Yi Ti.',
		],
		eventMemory: { did: ['Offered Princess Mei-Lin in marriage to Aegon Targaryen'], saw: [], knew: [], knows: [] },
		currentAction: "Awaiting Aegon Targaryen's answer to his offer of Princess Mei-Lin's hand",
		emotionalState: 'Controlled, calculating, resolute',
	}, now);
}

function correctedMeiLinEntity(now) {
	return correctedCharacterEntity({
		id: MEI_LIN_ENTITY_ID,
		name: 'Mei-Lin',
		description: 'Princess of Yi Ti and daughter of God-Emperor Bu Gai.',
		rank: 'Princess of Yi Ti',
		role: 'daughter of God-Emperor Bu Gai',
		knownFacts: ['Her father offered her hand to Aegon Targaryen as a dynastic alliance with Yi Ti.'],
		eventMemory: { did: [], saw: ['Her father offered her hand to Aegon Targaryen'], knew: [], knows: [] },
		currentAction: 'Watching Aegon after her father offers her hand in marriage',
		emotionalState: 'Composed, intent',
	}, now);
}

function correctedAliases(now) {
	return [
		['alias_2ce871df-37cf-4b85-9105-2d30420cde01', BU_GAI_ENTITY_ID, 'Bu Gai', 'bu gai'],
		['alias_2ce871df-37cf-4b85-9105-2d30420cde02', BU_GAI_ENTITY_ID, 'God-Emperor Bu Gai', 'god emperor bu gai'],
		['alias_2ce871df-37cf-4b85-9105-2d30420cde04', MEI_LIN_ENTITY_ID, 'Mei-Lin', 'mei lin'],
		['alias_2ce871df-37cf-4b85-9105-2d30420cde05', MEI_LIN_ENTITY_ID, 'Princess Mei-Lin', 'princess mei lin'],
		['alias_2ce871df-37cf-4b85-9105-2d30420cde06', AEGON_ENTITY_ID, 'Aegon Targaryen', 'aegon targaryen'],
	].map(([id, entityId, alias, normalizedAlias]) => ({
		id,
		storyId: STORY_ID,
		entityId,
		alias,
		normalizedAlias,
		sourceEntryIds: [OFFER_ENTRY_ID],
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	}));
}

function correctedFamilyRelationship(now) {
	return {
		id: 'veil_rel_bu_gai_mei_lin_parent',
		storyId: STORY_ID,
		sourceEntityId: BU_GAI_ENTITY_ID,
		targetEntityId: MEI_LIN_ENTITY_ID,
		type: 'parent-of',
		label: 'Bu Gai is Princess Mei-Lin\'s father',
		strength: 1,
		bidirectional: true,
		metadata: { source: 'canonical_emperor_offer_repair' },
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedYiTiMembership(id, entityId, role, rank, now) {
	return {
		id,
		storyId: STORY_ID,
		factionId: YI_TI_FACTION_ID,
		entityId,
		role,
		rank,
		status: 'active',
		visibility: 'player_known',
		metadata: { source: 'canonical_emperor_offer_repair' },
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		serverVersion: REPAIR_VERSION,
		createdAt: now,
		updatedAt: now,
	};
}

function correctedLengPressureMemory(memory, now) {
	const content = 'Imperial Court of Leng pressure is 5/100.\n\nRecent drivers:\n- +3 A Sealed Passenger Goes East (event type)\n- +2 Aurion Belaerys lands at Leng Yi (event type)';
	return {
		...memory,
		content,
		summary: 'Imperial Court of Leng pressure is 5/100. Recent drivers: - +3 A Sealed Passenger Goes East (event type) - +2 Aurion Belaerys lands at Leng Yi (event type)',
		importance: 0.5727273,
		sourceEventIds: [...LENG_PRESSURE_EVENT_IDS],
		metadata: {
			...memory.metadata,
			pressure: 5,
			repair: 'removed Yi Ti chamberlain summons from Leng pressure',
		},
		serverVersion: REPAIR_VERSION,
		updatedAt: now,
	};
}

function resetPlotBrain(metadata, now) {
	const previous = metadata?.plotBrain && typeof metadata.plotBrain === 'object' ? metadata.plotBrain : {};
	const safeRetiredDirectives = unique([
		...asArray(previous.retiredPlotDirectives),
		...asArray(previous.lastFrame?.plotCards).map((card) => card?.title),
	]).filter((directive) => !POISON_TEXT.test(directive));
	return {
		...metadata,
		plotBrain: {
			active: false,
			lastFrame: null,
			lastFrameId: null,
			lastFrameTurn: TARGET_TURN,
			lastPlanAt: null,
			plotCardCount: 0,
			quietUntilTurn: TARGET_TURN + 3,
			retiredAt: now,
			retiredFrameId: previous.lastFrameId ?? previous.lastFrame?.id ?? null,
			retirementReason: 'Retired during the emperor-offer rewind because the frame depended on lore-poisoned post-offer canon.',
			retiredPlotDirectives: safeRetiredDirectives,
		},
		canonicalRepair: {
			kind: 'emperor_offer_rewind',
			appliedAt: now,
			fromServerVersion: 870,
			throughPosition: TARGET_POSITION,
			throughTurn: TARGET_TURN,
			recoveryExport: 'exports/veil-pre-emperor-reset-20260831-124331.mtherios.json',
		},
	};
}

function validate(db, { contaminatedWorldTickIds, contaminatedWorldSignalIds, contaminatedWorldMemoryIds }) {
	const failures = [];
	const last = db.entries.at(-1);
	if (db.story.id !== STORY_ID) failures.push('story id changed');
	if (db.entries.length !== TARGET_POSITION) failures.push(`expected ${TARGET_POSITION} entries, got ${db.entries.length}`);
	if (last?.id !== OFFER_ENTRY_ID || last?.position !== TARGET_POSITION) failures.push('corrected offer is not the final entry');
	if (!last?.content.includes('Will you take her hand, Aegon Targaryen?')) failures.push('corrected offer text is missing');
	if (db.entries.some((entry) => entry.position > TARGET_POSITION)) failures.push('future transcript entries remain');
	if (db.entries.some((entry) => /Not while the God-Empress breathes|bind your star to the throne of Leng/i.test(entry.content))) failures.push('known poisoned prose remains in transcript');
	if (db.chapters.some((chapter) => chapter.number >= 17)) failures.push('poisoned Chapter 17 remains');
	if (db.agreements.some((agreement) => POISON_AGREEMENT_IDS.has(agreement.id))) failures.push('post-offer agreement remains');
	if (db.threads.some((thread) => POISON_THREAD_IDS.has(thread.id))) failures.push('poisoned plot thread remains');
	if (db.events.some((event) => POISON_EVENT_IDS.has(event.id))) failures.push('poisoned future event remains');
	if (db.events.some(isContaminatedCrossLoreWorldTick)) failures.push('cross-lore world tick remains');
	if (db.factionProjects.some((project) => CONTAMINATED_FACTION_PROJECT_IDS.has(project.id))) failures.push('cross-lore faction project remains');
	if (db.events.some((event) => asArray(event.threadIds).some((id) => POISON_THREAD_IDS.has(id)))) failures.push('event still references a poisoned plot thread');
	if (db.threads.filter((thread) => thread.id === YITISH_THREAD_ID).length !== 1) failures.push('expected exactly one canonical YiTish marriage thread');
	for (const key of ['threads', 'events', 'agreements', 'memoryNodes', 'chapters']) {
		if (db[key].some((row) => POISON_TEXT.test(JSON.stringify(row)))) failures.push(`poisoned narrative remains in ${key}`);
	}
	if (db.story.metadata?.plotBrain?.active !== false || db.story.metadata?.plotBrain?.lastFrame) failures.push('Plot Director frame remains active');
	if (db.story.currentLocationId !== TARGET_LOCATION_ID || db.story.currentTurn !== TARGET_TURN) failures.push('story clock/location was not rewound');
	if (!db.memoryNodes.some((memory) => memory.id === 'veil_memory_leng_yi_ti_diplomatic_context')) failures.push('foundation Leng/Yi Ti memory was lost');
	if (!db.memoryNodes.some((memory) => memory.id === OFFER_MEMORY_ID)) failures.push('corrected offer memory is missing');
	if (!db.facts.some((fact) => fact.id === 'veil_fact_yi_ti_leng_separate_sovereigns')) failures.push('corrected sovereignty fact is missing');
	const removedReferenceIds = new Set([...contaminatedWorldTickIds, ...contaminatedWorldSignalIds, ...contaminatedWorldMemoryIds]);
	if (containsExactReference(db, removedReferenceIds)) failures.push('a removed cross-lore world-sim identifier remains referenced');
	const summons = db.events.find((event) => event.id === YITISH_SUMMONS_EVENT_ID);
	if (!summons || summons.locationId !== FIRST_TERRACE_LOCATION_ID || summons.factionIds?.length !== 1 || summons.factionIds[0] !== YI_TI_FACTION_ID) {
		failures.push('the chamberlain summons is not anchored to Yi Ti and the First Terrace');
	}
	const offer = db.events.find((event) => event.id === OFFER_EVENT_ID);
	if (!offer || !asArray(offer.actorEntityIds).includes(BU_GAI_ENTITY_ID)
		|| !asArray(offer.targetEntityIds).includes(MEI_LIN_ENTITY_ID)
		|| !asArray(offer.targetEntityIds).includes(AEGON_ENTITY_ID)) failures.push('corrected offer event lacks canonical character links');
	for (const [id, name] of [[BU_GAI_ENTITY_ID, 'Bu Gai'], [MEI_LIN_ENTITY_ID, 'Mei-Lin']]) {
		const matches = db.entities.filter((entity) => entity.id === id && entity.name === name);
		if (matches.length !== 1 || matches[0].state?.present !== true || matches[0].state?.currentLocationId !== TARGET_LOCATION_ID) {
			failures.push(`${name} is not a unique, present canonical entity at the offer scene`);
		}
	}
	for (const alias of ['bu gai', 'god emperor bu gai', 'mei lin', 'princess mei lin', 'aegon targaryen']) {
		if (!db.entityAliases.some((row) => row.normalizedAlias === alias)) failures.push(`canonical alias is missing: ${alias}`);
	}
	const lengCourt = db.factions.find((faction) => faction.id === LENG_COURT_FACTION_ID);
	if (lengCourt?.pressure !== 5 || asArray(lengCourt?.sourceEventIds).includes(YITISH_SUMMONS_EVENT_ID)
		|| asArray(lengCourt?.metadata?.pressureReasons).some((reason) => reason?.eventId === YITISH_SUMMONS_EVENT_ID)) {
		failures.push('Leng court pressure still contains the Yi Ti summons');
	}
	const lengPressureMemory = db.memoryNodes.find((memory) => memory.id === LENG_PRESSURE_MEMORY_ID);
	if (lengPressureMemory?.metadata?.pressure !== 5 || /Chamberlain's Summons/i.test(lengPressureMemory?.content ?? '')
		|| asArray(lengPressureMemory?.sourceEventIds).includes(YITISH_SUMMONS_EVENT_ID)) {
		failures.push('Leng pressure memory still contains the Yi Ti summons');
	}
	if (asArray(db.story.metadata?.plotBrain?.retiredPlotDirectives).some((directive) => POISON_TEXT.test(directive))) {
		failures.push('poisoned Plot Director retirement directive remains');
	}
	const godEmpress = db.entities.find((entity) => entity.id === 'veil_entity_god_empress_leng');
	if (godEmpress?.state?.present === true || godEmpress?.state?.isPresent === true) failures.push('off-screen God-Empress is still marked present in Yin');
	const departureEvent = db.events.find((event) => event.id === DEPARTURE_REVEAL_EVENT_ID);
	if (!departureEvent
		|| JSON.stringify(departureEvent.sourceEntryIds) !== JSON.stringify([DEPARTURE_PLAYER_ENTRY_ID])
		|| JSON.stringify(departureEvent.sourcePatchIds) !== JSON.stringify([DEPARTURE_PATCH_ID])) {
		failures.push("Aurion's pre-reset departure reveal was not reanchored to retained evidence");
	}
	const parallelDepartureMemory = db.memoryNodes.find((memory) => memory.id === PARALLEL_DEPARTURE_MEMORY_ID);
	if (JSON.stringify(parallelDepartureMemory?.sourceEntryIds) !== JSON.stringify([DEPARTURE_PLAYER_ENTRY_ID])) {
		failures.push('the retained parallel departure memory has stale transcript evidence');
	}
	const departureMemory = db.memoryNodes.find((memory) => memory.id === DEPARTURE_REVEAL_MEMORY_ID);
	if (!departureMemory
		|| JSON.stringify(departureMemory.sourceEntryIds) !== JSON.stringify([DEPARTURE_PLAYER_ENTRY_ID])
		|| JSON.stringify(departureMemory.sourceEventIds) !== JSON.stringify([DEPARTURE_REVEAL_EVENT_ID])
		|| JSON.stringify(departureMemory.sourcePatchIds) !== JSON.stringify([DEPARTURE_PATCH_ID])) {
		failures.push("Aurion's departure memory was not reanchored to retained evidence");
	}
	const valyrianPressureMemory = db.memoryNodes.find((memory) => memory.id === VALYRIAN_PRESSURE_MEMORY_ID);
	if (valyrianPressureMemory?.metadata?.pressure !== 58
		|| asArray(valyrianPressureMemory?.sourceEventIds).length !== 19
		|| JSON.stringify(valyrianPressureMemory?.sourcePatchIds) !== JSON.stringify([
			'patch_1adc9d89-d3bd-404a-b7cb-1d7bb330c0c3',
			'patch_1a2d3bf9-52e7-44c9-9cec-25594bf2f58b',
		])) {
		failures.push('Valyrian pressure memory did not sanitize to its verified pre-reset evidence');
	}
	const retainedMemoryIds = new Set(db.memoryNodes.map((memory) => memory.id));
	for (const key of ['entries', 'statePatches', 'patchProposals']) {
		if (db[key].some((row) => retrievedMemoryRefs(row).some((id) => !retainedMemoryIds.has(id)))) {
			failures.push(`dangling retrieved-memory reference remains in ${key}`);
		}
	}
	const scratchFactions = db.factions.filter((faction) => faction.id.startsWith('veil_scratch_asoiaf_faction_'));
	if (scratchFactions.length !== 130) failures.push(`expected 130 searchable scratch-lore factions, got ${scratchFactions.length}`);
	if (scratchFactions.some((faction) => faction.metadata?.currentStoryEvidence === true || faction.metadata?.worldSimEnabled === true)) {
		failures.push('a scratch-lore faction is explicitly promoted into the current world simulation');
	}
	if (failures.length) throw new Error(`Repaired bundle failed validation:\n- ${failures.join('\n- ')}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const inputPath = path.resolve(args.input ?? 'exports/veil-pre-emperor-reset-20260831-124331.mtherios.json');
	const outputPath = path.resolve(args.output ?? 'exports/veil-emperor-offer-repaired.mtherios.json');
	const bundle = JSON.parse(await fs.readFile(inputPath, 'utf8'));
	const db = structuredClone(bundle.worldDatabase);
	if (db?.story?.id !== STORY_ID || db.story.serverVersion !== 870 || db.entries?.length !== 546) {
		throw new Error('Input is not the verified Veil v870 recovery export; refusing to rewrite it.');
	}
	const now = new Date().toISOString();
	const beforeCounts = Object.fromEntries(Object.entries(db).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
	const contaminatedWorldTicks = db.events.filter(isContaminatedCrossLoreWorldTick);
	if (contaminatedWorldTicks.length !== 48) {
		throw new Error(`Expected 48 cross-lore world ticks in the verified recovery export, found ${contaminatedWorldTicks.length}.`);
	}
	const contaminatedWorldTickIds = new Set(contaminatedWorldTicks.map((event) => event.id));
	const contaminatedWorldSignalIds = new Set(contaminatedWorldTicks.map((event) => event.metadata?.publicSignalEventId).filter(Boolean));
	if (contaminatedWorldSignalIds.size !== 48 || [...contaminatedWorldSignalIds].some((id) => !db.events.some((event) => event.id === id))) {
		throw new Error('The cross-lore world-tick signal chain does not match the verified 48-event set.');
	}
	const contaminatedWorldMemoryIds = new Set([...contaminatedWorldTickIds].map((id) => `mem_world_tick_${id}`));
	if (db.memoryNodes.filter((memory) => contaminatedWorldMemoryIds.has(memory.id)).length !== 48) {
		throw new Error('The cross-lore world-tick memory chain does not match the verified 48-memory set.');
	}

	db.entries = db.entries
		.filter((entry) => entry.position <= TARGET_POSITION)
		.sort((left, right) => left.position - right.position)
		.map((entry) => entry.id === OFFER_ENTRY_ID ? {
			...entry,
			content: CORRECTED_OFFER,
			metadata: {
				source: 'canonical_repair',
				actionType: 'do',
				clientTurnId: 'a63e894a-e82f-4137-83cf-9e20db1a09db',
				repair: { kind: 'emperor_offer_rewind', replacedLorePoisonedNarration: true },
			},
			serverVersion: REPAIR_VERSION,
			updatedAt: now,
		} : entry)
		.map((entry) => filterRetrievedMemoryRefs(entry, contaminatedWorldMemoryIds));
	const retainedEntryIds = new Set(db.entries.map((entry) => entry.id));

	const candidateEvents = db.events.filter((event) => {
		if (event.id === OFFER_EVENT_ID) return false;
		if (event.id === OFFER_TURN_EVENT_ID) return false;
		if (contaminatedWorldTickIds.has(event.id) || contaminatedWorldSignalIds.has(event.id)) return false;
		if (POISON_EVENT_IDS.has(event.id)) return false;
		if (asArray(event.threadIds).some((id) => POISON_THREAD_IDS.has(id))) return false;
		if (event.id === DEPARTURE_REVEAL_EVENT_ID) return true;
		if (typeof event.createdTurn === 'number' && event.createdTurn > TARGET_TURN) return false;
		const sourceIds = asArray(event.sourceEntryIds);
		if (sourceIds.includes(OFFER_ENTRY_ID)) return false;
		return sourceIds.length === 0 || sourceIds.some((id) => retainedEntryIds.has(id));
	}).map((event) => event.id === DEPARTURE_REVEAL_EVENT_ID ? {
		...event,
		sourceEntryIds: [DEPARTURE_PLAYER_ENTRY_ID],
		sourcePatchIds: [DEPARTURE_PATCH_ID],
		metadata: { ...event.metadata, canonicalRepair: 'reanchored to the retained player action and state patch' },
		serverVersion: REPAIR_VERSION,
		updatedAt: now,
	} : event.id === YITISH_SUMMONS_EVENT_ID ? {
		...event,
		locationId: FIRST_TERRACE_LOCATION_ID,
		locationIds: [FIRST_TERRACE_LOCATION_ID],
		factionIds: [YI_TI_FACTION_ID],
		metadata: { ...event.metadata, canonicalRepair: 'reassigned summons from Leng to Yi Ti' },
		serverVersion: REPAIR_VERSION,
		updatedAt: now,
	} : event);
	db.events = [...candidateEvents, correctedOfferEvent(now)];
	const retainedEventIds = new Set(db.events.map((event) => event.id));

	db.statePatches = [
		...db.statePatches.filter((patch) => patch.serverVersion <= 805).map((patch) => filterRetrievedMemoryRefs(patch, contaminatedWorldMemoryIds)),
		correctedOfferPatch(now),
	];
	const retainedPatchIds = new Set(db.statePatches.map((statePatch) => statePatch.id));
	db.statePatches = db.statePatches.map((statePatch) => filterSourceArrays(statePatch, retainedEntryIds, retainedEventIds, retainedPatchIds));

	const sanitizeRows = (rows) => rows
		.map((row) => filterSourceArrays(row, retainedEntryIds, retainedEventIds, retainedPatchIds))
		.filter((filtered, index) => retainedOrFoundation(rows[index], filtered));

	db.entities = sanitizeRows(db.entities).filter((entity) => entity.id !== 'entity_ae1c3872-a971-46ca-9a86-2f9c2786811a'
		&& entity.id !== BU_GAI_ENTITY_ID
		&& entity.id !== MEI_LIN_ENTITY_ID);
	db.entities.push(correctedBuGaiEntity(now), correctedMeiLinEntity(now));
	db.entities = db.entities.map((entity) => {
		if (entity.id === TARGET_LOCATION_ID) return { ...entity, state: { ...entity.state, current: true }, serverVersion: REPAIR_VERSION, updatedAt: now };
		if (entity.id === 'veil_entity_god_empress_leng') return {
			...entity,
			state: { ...entity.state, present: false, isPresent: false },
			serverVersion: REPAIR_VERSION,
			updatedAt: now,
		};
		if (entity.id === AEGON_ENTITY_ID) return {
			...entity,
			state: {
				...entity.state,
				currentAction: "Seated before God-Emperor Bu Gai as the emperor offers Princess Mei-Lin's hand",
				currentLocation: 'Yin — The Low Water-Garden, Summit Terrace',
				currentLocationId: TARGET_LOCATION_ID,
			},
			serverVersion: REPAIR_VERSION,
			updatedAt: now,
		};
		if (entity.type === 'location' && entity.state?.current === true) return { ...entity, state: { ...entity.state, current: false } };
		return entity;
	});
	const entityIds = new Set(db.entities.map((entity) => entity.id));

	const repairAliases = correctedAliases(now);
	const repairAliasIds = new Set(repairAliases.map((alias) => alias.id));
	db.entityAliases = sanitizeRows(db.entityAliases)
		.filter((alias) => entityIds.has(alias.entityId) && !repairAliasIds.has(alias.id));
	db.entityAliases.push(...repairAliases);
	db.relationships = sanitizeRows(db.relationships)
		.filter((relationship) => entityIds.has(relationship.sourceEntityId) && entityIds.has(relationship.targetEntityId))
		.filter((relationship) => relationship.id !== 'veil_rel_bu_gai_mei_lin_parent');
	db.relationships.push(correctedFamilyRelationship(now));
	db.agreements = sanitizeRows(db.agreements).filter((agreement) => !POISON_AGREEMENT_IDS.has(agreement.id) && agreement.serverVersion <= 805);
	db.npcBeliefs = sanitizeRows(db.npcBeliefs).filter((belief) => entityIds.has(belief.believerEntityId) && (!belief.subjectEntityId || entityIds.has(belief.subjectEntityId)));

	db.threads = sanitizeRows(db.threads).filter((thread) => !POISON_THREAD_IDS.has(thread.id));
	const existingYitishThread = db.threads.find((thread) => thread.id === YITISH_THREAD_ID) ?? {};
	db.threads = db.threads.filter((thread) => thread.id !== YITISH_THREAD_ID);
	db.threads.push({
		...existingYitishThread,
		id: YITISH_THREAD_ID,
		storyId: STORY_ID,
		description: "God-Emperor Bu Gai has offered Princess Mei-Lin's hand to Aegon Targaryen as a dynastic alliance with Yi Ti's Azure Throne. Aegon has not answered.",
		status: 'open',
		significance: 'critical',
		relatedFactionIds: [YI_TI_FACTION_ID],
		relatedEntityIds: [BU_GAI_ENTITY_ID, MEI_LIN_ENTITY_ID, AEGON_ENTITY_ID],
		sourceEntryIds: [OFFER_ENTRY_ID],
		sourceEventIds: [OFFER_EVENT_ID],
		sourcePatchIds: [OFFER_PATCH_ID],
		closedAt: null,
		closureReason: null,
		serverVersion: REPAIR_VERSION,
		createdAt: existingYitishThread.createdAt ?? now,
		updatedAt: now,
	});
	const threadIds = new Set(db.threads.map((thread) => thread.id));

	db.events = db.events.map((event) => ({
		...filterSourceArrays(event, retainedEntryIds, retainedEventIds, retainedPatchIds),
		actorEntityIds: asArray(event.actorEntityIds).filter((id) => entityIds.has(id)),
		targetEntityIds: asArray(event.targetEntityIds).filter((id) => entityIds.has(id)),
		threadIds: asArray(event.threadIds).filter((id) => threadIds.has(id)),
	}));

	db.npcEventLinks = sanitizeRows(db.npcEventLinks).filter((link) => retainedEventIds.has(link.eventId) && entityIds.has(link.npcEntityId));
	db.facts = sanitizeRows(db.facts)
		.filter((fact) => (!fact.subjectEntityId || entityIds.has(fact.subjectEntityId)) && (!fact.targetEntityId || entityIds.has(fact.targetEntityId)))
		.filter((fact) => fact.id !== 'veil_fact_yi_ti_leng_separate_sovereigns');
	db.facts.push(correctedJurisdictionFact(now));
	db.patchProposals = sanitizeRows(db.patchProposals.map((proposal) => filterRetrievedMemoryRefs(proposal, contaminatedWorldMemoryIds)))
		.filter((proposal) => proposal.serverVersion <= 805);
	db.continuityWarnings = sanitizeRows(db.continuityWarnings).filter((warning) => warning.serverVersion <= 805);

	db.chapters = db.chapters.filter((chapter) => chapter.number <= 16);
	const chapterIds = new Set(db.chapters.map((chapter) => chapter.id));
	db.arcs = db.arcs
		.map((arc) => ({ ...arc, chapterIds: asArray(arc.chapterIds).filter((id) => chapterIds.has(id)) }))
		.filter((arc) => arc.chapterIds.length > 0);
	const arcIds = new Set(db.arcs.map((arc) => arc.id));
	db.sagas = db.sagas
		.map((saga) => ({ ...saga, arcIds: asArray(saga.arcIds).filter((id) => arcIds.has(id)) }))
		.filter((saga) => saga.arcIds.length > 0);

	db.memoryNodes = db.memoryNodes
		.filter((memory) => !contaminatedWorldMemoryIds.has(memory.id))
		.map((memory) => memory.id === DEPARTURE_REVEAL_MEMORY_ID ? {
			...memory,
			sourceEntryIds: [DEPARTURE_PLAYER_ENTRY_ID],
			sourceEventIds: [DEPARTURE_REVEAL_EVENT_ID],
			sourcePatchIds: [DEPARTURE_PATCH_ID],
			metadata: { ...memory.metadata, canonicalRepair: 'reanchored to the retained player action, event, and state patch' },
			serverVersion: REPAIR_VERSION,
			updatedAt: now,
		} : memory)
		.filter((memory) => SANITIZABLE_MIXED_MEMORY_IDS.has(memory.id)
			|| !asArray(memory.sourceEntryIds).some((id) => !retainedEntryIds.has(id) || id === OFFER_ENTRY_ID))
		.filter((memory) => SANITIZABLE_MIXED_MEMORY_IDS.has(memory.id)
			|| !asArray(memory.sourceEventIds).some((id) => !retainedEventIds.has(id) || id === OFFER_TURN_EVENT_ID))
		.filter((memory) => SANITIZABLE_MIXED_MEMORY_IDS.has(memory.id)
			|| !asArray(memory.sourcePatchIds).some((id) => !retainedPatchIds.has(id)))
		.map((memory) => ({ original: memory, filtered: filterSourceArrays(memory, retainedEntryIds, retainedEventIds, retainedPatchIds) }))
		.filter(({ original, filtered }) => retainedOrFoundation(original, filtered))
		.map(({ filtered }) => filtered)
		.filter((memory) => memory.id !== OFFER_MEMORY_ID)
		.filter((memory) => memory.id !== 'mem_chapter_chapter_entry_20f42c55_3e9c_4ec6_bf0d_7d2cba2c8383_narration_90635667_91ea_4cb4_8637_ccdf688edd28')
		.map((memory) => memory.id === LENG_PRESSURE_MEMORY_ID ? correctedLengPressureMemory(memory, now) : memory)
		.map((memory) => ({
			...memory,
			entityIds: asArray(memory.entityIds).filter((id) => entityIds.has(id)),
			threadIds: asArray(memory.threadIds).filter((id) => threadIds.has(id)),
		}));
	db.memoryNodes.push(correctedOfferMemory(now));
	const houseJoPressureMemory = db.memoryNodes.find((memory) => memory.id === 'mem_faction_pressure_faction_entity_46fee601-b44d-441e-8f97-b87b4d2d6ebe');
	const oldBloodPressureMemory = db.memoryNodes.find((memory) => memory.id === `mem_faction_pressure_faction_tag_${STORY_SLUG}_old_blood`);
	if (asArray(houseJoPressureMemory?.sourceEventIds).length !== 105 || asArray(oldBloodPressureMemory?.sourceEventIds).length !== 44) {
		throw new Error('Mixed faction pressure memories did not sanitize to their verified retained event sets.');
	}
	const retainedMemoryIds = new Set(db.memoryNodes.map((memory) => memory.id));
	db.entries = db.entries.map((entry) => retainRetrievedMemoryRefs(entry, retainedMemoryIds));
	db.statePatches = db.statePatches.map((statePatch) => retainRetrievedMemoryRefs(statePatch, retainedMemoryIds));
	db.patchProposals = db.patchProposals.map((proposal) => retainRetrievedMemoryRefs(proposal, retainedMemoryIds));

	const sanitizeFactionRow = (faction) => {
		const staleWorldSimPointer = contaminatedWorldTickIds.has(faction.metadata?.lastWorldSimTickEventId)
			|| contaminatedWorldSignalIds.has(faction.metadata?.lastWorldSimSignalEventId);
		const filtered = filterSourceArrays(faction, retainedEntryIds, retainedEventIds, retainedPatchIds);
		if (faction.id === LENG_COURT_FACTION_ID) {
			filtered.sourceEventIds = asArray(filtered.sourceEventIds).filter((id) => id !== YITISH_SUMMONS_EVENT_ID);
		}
		const previousReasons = asArray(filtered.metadata?.pressureReasons);
		const reasons = previousReasons.filter((reason) => retainedEventIds.has(reason?.eventId)
			&& !(faction.id === LENG_COURT_FACTION_ID && reason?.eventId === YITISH_SUMMONS_EVENT_ID));
		const removedReasons = reasons.length !== previousReasons.length;
		const metadata = {
			...filtered.metadata,
			pressureReasons: reasons,
		};
		for (const key of ['lastWorldSimTickEventId', 'lastWorldSimSignalEventId']) {
			if (metadata[key] && !retainedEventIds.has(metadata[key])) metadata[key] = null;
		}
		if (staleWorldSimPointer || Number(metadata.lastWorldSimTickTurn) > TARGET_TURN) {
			for (const key of ['lastWorldSimTickAt', 'lastWorldSimTickJobId', 'lastWorldSimTickEventId', 'lastWorldSimTickPressure', 'lastWorldSimSignalEventId']) metadata[key] = null;
			metadata.lastWorldSimTickTurn = null;
		}
		metadata.pressureJobId = null;
		metadata.pressureUpdatedAt = reasons.at(-1)?.updatedAt ?? null;
		return {
			...filtered,
			memberEntityIds: faction.id === YI_TI_FACTION_ID
				? unique([...asArray(filtered.memberEntityIds).filter((id) => entityIds.has(id)), BU_GAI_ENTITY_ID, MEI_LIN_ENTITY_ID])
				: asArray(filtered.memberEntityIds).filter((id) => entityIds.has(id)),
			pressure: removedReasons ? Math.min(100, reasons.reduce((sum, reason) => sum + (Number(reason?.delta) || 0), 0)) : filtered.pressure,
			metadata,
			serverVersion: REPAIR_VERSION,
			updatedAt: now,
		};
	};
	db.factions = db.factions
		.map(sanitizeFactionRow)
		.filter((faction) => retainedOrFoundation(db.factions.find((row) => row.id === faction.id) ?? faction, faction));
	const factionIds = new Set(db.factions.map((faction) => faction.id));
	db.factionMemberships = sanitizeRows(db.factionMemberships)
		.filter((row) => factionIds.has(row.factionId) && entityIds.has(row.entityId))
		.filter((row) => row.id !== 'veil_membership_bu_gai_yi_ti' && row.id !== 'veil_membership_mei_lin_yi_ti');
	db.factionMemberships.push(
		correctedYiTiMembership('veil_membership_bu_gai_yi_ti', BU_GAI_ENTITY_ID, 'sovereign', 'God-Emperor', now),
		correctedYiTiMembership('veil_membership_mei_lin_yi_ti', MEI_LIN_ENTITY_ID, 'imperial family', 'Princess', now),
	);
	db.factionResources = sanitizeRows(db.factionResources).filter((row) => factionIds.has(row.factionId) && (!row.locationId || entityIds.has(row.locationId)));
	db.factionGoals = sanitizeRows(db.factionGoals).filter((row) => factionIds.has(row.factionId));
	db.factionProjects = sanitizeRows(db.factionProjects).filter((row) => factionIds.has(row.factionId)
		&& row.serverVersion <= 805
		&& !CONTAMINATED_FACTION_PROJECT_IDS.has(row.id));

	const targetRecordIds = new Set([
		...entityIds,
		...factionIds,
		...threadIds,
		...retainedEntryIds,
		...retainedEventIds,
		...retainedPatchIds,
		...db.agreements.map((row) => row.id),
		...db.facts.map((row) => row.id),
		...db.memoryNodes.map((row) => row.id),
		...chapterIds,
	]);
	db.sourceRefs = db.sourceRefs.filter((ref) => targetRecordIds.has(ref.targetRecordId)
		&& (ref.sourceType !== 'entry' || retainedEntryIds.has(ref.sourceId))
		&& (ref.sourceType !== 'event' || retainedEventIds.has(ref.sourceId))
		&& (ref.sourceType !== 'patch' || retainedPatchIds.has(ref.sourceId)));

	db.story = {
		...db.story,
		currentLocationId: TARGET_LOCATION_ID,
		currentTurn: TARGET_TURN,
		currentWorldTime: TARGET_WORLD_TIME,
		metadata: resetPlotBrain(db.story.metadata, now),
		serverVersion: REPAIR_VERSION,
		updatedAt: now,
	};

	validate(db, { contaminatedWorldTickIds, contaminatedWorldSignalIds, contaminatedWorldMemoryIds });
	bundle.exportedAt = Date.now();
	bundle.worldDatabase = db;
	bundle.backendCanon = structuredClone(db);
	bundle.story = {
		...bundle.story,
		currentLocationId: TARGET_LOCATION_ID,
		currentTurn: TARGET_TURN,
		currentWorldTime: TARGET_WORLD_TIME,
		serverVersion: REPAIR_VERSION,
		metadata: db.story.metadata,
		updatedAt: now,
	};
	bundle.storyEntries = structuredClone(db.entries);
	bundle.chapters = structuredClone(db.chapters);
	bundle.lorebookEntries = structuredClone(db.entities);
	bundle.entryRelationships = structuredClone(db.relationships);
	bundle.worldEvents = structuredClone(db.events);
	bundle.agreements = structuredClone(db.agreements);
	bundle.storyThreads = structuredClone(db.threads);

	await fs.mkdir(path.dirname(outputPath), { recursive: true });
	await fs.writeFile(outputPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
	const afterCounts = Object.fromEntries(Object.entries(db).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length]));
	console.log(JSON.stringify({
		ok: true,
		inputPath,
		outputPath,
		storyId: db.story.id,
		serverVersion: db.story.serverVersion,
		currentTurn: db.story.currentTurn,
		lastEntry: { id: db.entries.at(-1).id, position: db.entries.at(-1).position },
		beforeCounts,
		afterCounts,
	}, null, 2));
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : error);
	process.exitCode = 1;
});
