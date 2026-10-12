/**
 * World-state update contract.
 *
 * The server turn classifier and deferred extraction validate model output against
 * worldStateUpdateSchema before patchValidator applies it to canonical state.
 */

import { z } from 'zod';
import { campaignStateChangeSchema } from '$lib/contracts/campaignState';
import { npcAgencySchema } from '$lib/contracts/npcAgency';
import { GAMEPLAY_EFFECT_LIMIT, gameplayEffectSchema } from '$lib/contracts/gameplayEffects';

// ── Zod Validation Schemas ──

export const worldStateCharacterSchema = z.object({
	name: z.string(),
	entityId: z.string().min(1).optional(),
	creation_evidence: z.string().trim().min(12).max(1200).optional(),
	faction_evidence: z.array(z.object({
		faction: z.string().trim().min(1).max(240),
		quote: z.string().trim().min(12).max(1200),
	})).max(8).optional(),
	aliases: z.array(z.string()).optional().default([]),
	status: z.enum(['active', 'departed', 'deceased', 'inactive']).optional(),
	description: z.string().nullable().optional().default(null),
	relationship: z.string().nullable().optional().default(null),
	traits: z.array(z.string()).optional().default([]),
	present: z.boolean().optional(),
	pressures: z.array(z.string()).optional().default([]),
	faction_tags: z.array(z.string()).optional().default([]),
	party_member: z.boolean().optional(),
	party_role: z.string().nullable().optional(),
	affinity_delta: z.number().int().min(-20).max(20).optional(),
	affinity_reason: z.string().min(3).max(500).nullable().optional(),
	currentLocation: z.string().nullable().optional(),
	current_location: z.string().nullable().optional(),
	currentAction: z.string().nullable().optional(),
	current_action: z.string().nullable().optional(),
	emotionalState: z.string().nullable().optional(),
	emotional_state: z.string().nullable().optional(),
	appearance: z.string().nullable().optional(),
	presentation: z.string().nullable().optional(),
	personality: z.string().nullable().optional(),
	rank: z.string().nullable().optional(),
	background: z.string().nullable().optional(),
	goals: z.array(z.string()).optional().default([]),
	...npcAgencySchema.shape,
	independentActionEvidence: z.string().trim().min(12).max(1600).optional(),
	independentActionVisibility: z.enum(['public', 'player_known', 'secret']).optional(),
	speechStyle: z.string().nullable().optional(),
	speech_style: z.string().nullable().optional(),
	eventMemory: z.object({
		did: z.array(z.string()).optional().default([]),
		saw: z.array(z.string()).optional().default([]),
		knew: z.array(z.string()).optional().default([]),
		knows: z.array(z.string()).optional().default([]),
	}).optional(),
}).superRefine((character, context) => {
	if (character.lastIndependentAction && !character.independentActionEvidence) {
		context.addIssue({ code: 'custom', path: ['independentActionEvidence'], message: 'A completed independent move requires narration evidence.' });
	}
	if (character.affinity_delta && !character.affinity_reason?.trim()) {
		context.addIssue({
			code: 'custom',
			path: ['affinity_reason'],
			message: 'affinity_reason is required when affinity_delta is nonzero.',
		});
	}
});

export const worldStateLocationConnectionSchema = z.object({
	targetName: z.string(),
	direction: z.string().nullable().optional().default(null),
	travelTimeMinutes: z.number().optional().default(0),
});

export const worldStateLocationSchema = z.object({
	entityId: z.string().trim().min(1).optional(),
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	current: z.boolean().optional().default(false),
	region: z.string().nullable().optional(),
	connections: z.array(worldStateLocationConnectionSchema).optional(),
});

export const worldStateItemSchema = z.object({
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	quantity: z.number().optional(),
	equipped: z.boolean().optional(),
	location: z.string().nullable().optional(),
});

export const worldStateConversationSchema = z.object({
	npcName: z.string(),
	topicSummary: z.string(),
	playerRevealed: z.array(z.string()).optional().default([]),
	npcLearned: z.array(z.string()).optional().default([]),
	emotionalShift: z.string().nullable().optional().default(null),
});

const knowledgeAudience = {
	known_by: z.array(z.string().trim().min(1)).min(1).max(4).optional(),
	evidence: z.string().trim().min(12).max(1200).optional(),
};
export const worldStateActorClaimSchema = z.object({
	text: z.string().trim().min(1).max(360),
	known_by: z.array(z.string().trim().min(1)).min(1).max(4),
	kind: z.enum(['learned', 'witnessed', 'shared']),
	evidence: z.string().trim().min(12).max(1200),
}).strict();

export const worldStateRelationshipSchema = z.object({
	...knowledgeAudience,
	sourceName: z.string(),
	targetName: z.string(),
	type: z.enum([
		'member-of', 'leader-of', 'allied-with', 'enemy-of',
		'located-in', 'part-of', 'created-by', 'triggered-by',
		'knows-about', 'owns', 'serves', 'related-to',
	]).default('related-to'),
	label: z.string().nullable().optional().default(null),
	strength: z.number().min(-100).max(100).optional().default(50),
	bidirectional: z.boolean().optional().default(false),
});

export const worldStateStoryBeatSchema = z.object({
	title: z.string(),
	description: z.string().optional().default(''),
	significance: z.enum(['minor', 'moderate', 'major', 'critical']).optional().default('minor'),
});

export const worldStateTimelineEventSchema = z.object({
	actor_claims: z.array(worldStateActorClaimSchema).max(3).optional(),
	title: z.string(),
	description: z.string().optional().default(''),
	type: z.enum([
		'promise',
		'betrayal',
		'reveal',
		'faction_move',
		'injury',
		'death',
		'relationship_shift',
		'agreement',
		'scene_transition',
		'clue_discovery',
		'correction',
		'imported_memory',
		'world_tick',
		'scheme',
		'rumor',
		'marriage',
		'alliance',
	]).optional().default('scheme'),
	status: z.enum(['proposed', 'scheduled', 'due', 'committed', 'cancelled']).optional().default('scheduled'),
	delay_turns: z.number().int().nonnegative().nullable().optional().default(null),
	due_turn: z.number().int().nonnegative().nullable().optional().default(null),
	world_time: z.string().nullable().optional().default(null),
	visibility: z.enum(['public', 'player_known', 'secret']).optional().default('player_known'),
	actor_names: z.array(z.string()).optional().default([]),
	target_names: z.array(z.string()).optional().default([]),
	faction_names: z.array(z.string()).optional().default([]),
	location_name: z.string().nullable().optional().default(null),
	memory_impact: z.record(z.string(), z.unknown()).optional().default({}),
	reason: z.string().nullable().optional().default(null),
});

export const worldStateMeterChangeSchema = z.object({
	name: z.string(),
	delta: z.number(),
	/** Starting value when the meter is created for the first time. Ignored on later updates. */
	initial: z.number().optional(),
	max: z.number().optional(),
	visible: z.boolean().optional(),
	reason: z.string().nullable().optional().default(null),
});

export const worldStateAgreementChangeSchema = z.object({
	...knowledgeAudience,
	action: z.enum(['create', 'update', 'break', 'fulfill', 'expire', 'annul', 'supersede']),
	// Identify existing agreement: by id (preferred for update/break/fulfill) or
	// by parties+category (fallback for retroactive updates when GM didn't track the id).
	id: z.string().nullable().optional(),
	parties: z.array(z.string()).optional().default([]),
	category: z.enum([
		'treaty', 'pact', 'alliance', 'oath', 'debt', 'promise',
		'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity',
	]).optional(),
	terms: z.string().nullable().optional(),
	secrecy: z.enum(['public', 'known', 'secret']).optional(),
	consequences: z.array(z.string()).optional().default([]),
	reason: z.string().nullable().optional().default(null),
});

export const worldStateFactionGoalSchema = z.object({
	description: z.string(),
	priority: z.number().min(1).max(10).optional().default(5),
	progress: z.number().min(0).max(100).optional().default(0),
	type: z.enum(['military', 'diplomatic', 'economic', 'intelligence', 'survival', 'expansion']).optional().default('diplomatic'),
	deadline: z.string().nullable().optional(),
});

export const worldStateFactionResourcesSchema = z.object({
	military: z.number().min(0).max(100).optional().default(50),
	wealth: z.number().min(0).max(100).optional().default(50),
	influence: z.number().min(0).max(100).optional().default(50),
	information: z.number().min(0).max(100).optional().default(50),
	morale: z.number().min(0).max(100).optional().default(50),
});

export const worldStateFactionProjectSchema = z.object({
	project: z.string(),
	status: z.enum(['planned', 'active', 'blocked', 'completed', 'closed']).optional().default('planned'),
	progress: z.number().min(0).max(100).optional().default(0),
	priority: z.number().min(1).max(10).optional().default(5),
	due_turn: z.number().int().nonnegative().nullable().optional().default(null),
	world_time: z.string().nullable().optional().default(null),
	costs: z.record(z.string(), z.number()).optional().default({}),
	gains: z.record(z.string(), z.number()).optional().default({}),
	risks: z.array(z.string()).optional().default([]),
});

export const worldStateLorebookEntrySchema = z.object({
	name: z.string(),
	type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
	description: z.string(),
	hidden_info: z.string().nullable().optional().default(null),
	aliases: z.array(z.string()).optional().default([]),
	keywords: z.array(z.string()).optional().default([]),
	injection_mode: z.enum(['always', 'keyword', 'never']).optional().default('keyword'),
	priority: z.number().optional().default(0),
	state_overrides: z.record(z.string(), z.any()).optional().default({}),
	known_members: z.array(z.string()).optional().default([]),
	faction_goals: z.array(worldStateFactionGoalSchema).optional().default([]),
	faction_projects: z.array(worldStateFactionProjectSchema).optional().default([]),
	faction_resources: worldStateFactionResourcesSchema.nullable().optional().default(null),
	faction_disposition: z.enum(['aggressive', 'defensive', 'scheming', 'neutral', 'desperate']).nullable().optional().default(null),
	territory: z.array(z.string()).optional().default([]),
});

export const worldStateUpdateSchema = z.object({
	campaign_state: z.array(campaignStateChangeSchema).max(8).optional(),
	characters: z.array(worldStateCharacterSchema).optional().default([]),
	locations: z.array(worldStateLocationSchema).optional().default([]),
	items: z.array(worldStateItemSchema).optional().default([]),
	time_delta: z.string().nullable().optional(),
	mood: z.string().nullable().optional(),
	player_reputation: z.string().nullable().optional(),
	player_ledger: z.string().nullable().optional(),
	conversations: z.array(worldStateConversationSchema).optional().default([]),
	relationships: z.array(worldStateRelationshipSchema).optional().default([]),
	story_beats: z.array(worldStateStoryBeatSchema).optional().default([]),
	timeline_events: z.array(worldStateTimelineEventSchema).optional().default([]),
	meter_changes: z.array(worldStateMeterChangeSchema).optional().default([]),
	/** Typed consequences (HP, resources, conditions, items); see contracts/gameplayEffects. */
	effects: z.array(gameplayEffectSchema).max(GAMEPLAY_EFFECT_LIMIT).optional().default([]),
	agreements: z.array(worldStateAgreementChangeSchema).optional().default([]),
	lorebook_entries: z.array(worldStateLorebookEntrySchema).optional().default([]),
});

export type WorldStateUpdate = z.infer<typeof worldStateUpdateSchema>;
export type WorldStateLorebookEntry = z.infer<typeof worldStateLorebookEntrySchema>;
export type WorldStateTimelineEvent = z.infer<typeof worldStateTimelineEventSchema>;
