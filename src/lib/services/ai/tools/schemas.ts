/**
 * GM Tool Schemas — Mtherios Orchestrator
 *
 * Defines the tools available to the GM during narrative generation.
 * Replaces: ClassifierService, MemoryService sync, LoreManagementService auto-discovery,
 * MicroFactionSimService signals, and parts of ContextAssembler retrieval.
 */

import { z } from 'zod';

// ── Zod Validation Schemas ──

export const worldStateCharacterSchema = z.object({
	name: z.string(),
	aliases: z.array(z.string()).optional().default([]),
	status: z.enum(['active', 'departed', 'deceased', 'inactive']).optional(),
	description: z.string().nullable().optional().default(null),
	relationship: z.string().nullable().optional().default(null),
	traits: z.array(z.string()).optional().default([]),
	present: z.boolean().optional(),
	pressures: z.array(z.string()).optional().default([]),
	faction_tags: z.array(z.string()).optional().default([]),
	currentLocation: z.string().nullable().optional(),
	current_location: z.string().nullable().optional(),
	currentAction: z.string().nullable().optional(),
	current_action: z.string().nullable().optional(),
	emotionalState: z.string().nullable().optional(),
	emotional_state: z.string().nullable().optional(),
	appearance: z.string().nullable().optional(),
	background: z.string().nullable().optional(),
	goals: z.array(z.string()).optional().default([]),
	speechStyle: z.string().nullable().optional(),
	speech_style: z.string().nullable().optional(),
	eventMemory: z.object({
		did: z.array(z.string()).optional().default([]),
		saw: z.array(z.string()).optional().default([]),
		knew: z.array(z.string()).optional().default([]),
		knows: z.array(z.string()).optional().default([]),
	}).optional(),
});

export const worldStateLocationConnectionSchema = z.object({
	targetName: z.string(),
	direction: z.string().nullable().optional().default(null),
	travelTimeMinutes: z.number().optional().default(0),
});

export const worldStateLocationSchema = z.object({
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	current: z.boolean().optional().default(false),
	region: z.string().nullable().optional(),
	connections: z.array(worldStateLocationConnectionSchema).optional().default([]),
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

export const worldStateRelationshipSchema = z.object({
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
	action: z.enum(['create', 'update', 'break', 'fulfill', 'expire']),
	// Identify existing agreement: by id (preferred for update/break/fulfill) or
	// by parties+category (fallback for retroactive updates when GM didn't track the id).
	id: z.string().nullable().optional(),
	parties: z.array(z.string()).optional().default([]),
	category: z.enum([
		'treaty', 'pact', 'alliance', 'oath', 'debt', 'promise',
		'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity',
	]).optional(),
	terms: z.string().nullable().optional(),
	secrecy: z.enum(['public', 'known', 'secret']).optional().default('public'),
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
	agreements: z.array(worldStateAgreementChangeSchema).optional().default([]),
	lorebook_entries: z.array(worldStateLorebookEntrySchema).optional().default([]),
});

export const searchWikiSchema = z.object({
	query: z.string().min(1),
	types: z.array(z.enum(['character', 'location', 'item', 'faction', 'concept', 'event'])).optional().default([]),
	limit: z.number().int().min(1).max(10).optional().default(5),
	follow_depth: z.number().int().min(0).max(3).optional().default(1),
	include_hidden: z.boolean().optional().default(true),
	exact: z.boolean().optional().default(false),
});

export const briefWikiSchema = z.object({
	task: z.string().min(1),
	mode: z.enum(['answer', 'maintain', 'ingest', 'lint', 'explore']).optional().default('answer'),
	limit: z.number().int().min(1).max(8).optional().default(5),
	follow_depth: z.number().int().min(0).max(3).optional().default(2),
	page_limit: z.number().int().min(1).max(24).optional().default(12),
	exact: z.boolean().optional().default(false),
});

export const rollCheckToolSchema = z.object({
	notation: z.string().min(1).default('1d20'),
	dc: z.number().int().min(1).max(40),
	ability: z.string().optional().default(''),
	description: z.string().optional().default(''),
});

export type WorldStateUpdate = z.infer<typeof worldStateUpdateSchema>;
export type WorldStateLorebookEntry = z.infer<typeof worldStateLorebookEntrySchema>;
export type WorldStateTimelineEvent = z.infer<typeof worldStateTimelineEventSchema>;
export type SearchWikiArgs = z.infer<typeof searchWikiSchema>;
export type BriefWikiArgs = z.infer<typeof briefWikiSchema>;
export type RollCheckToolArgs = z.infer<typeof rollCheckToolSchema>;

// ── OpenAI Function-Calling Format ──

export const GM_TOOLS = [
	{
		type: 'function' as const,
		function: {
			name: 'search_wiki',
			description: 'Search the terminal-owned Obsidian/Qdrant wiki before narrating, returning an LLM-ready context pack from followed wikilinks/backlinks when useful. Falls back to the local lorebook cache if the terminal wiki is unavailable.',
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: 'Plain-language search query, usually names, aliases, factions, places, objects, or lore concepts.',
					},
					types: {
						type: 'array',
						items: { type: 'string', enum: ['character', 'location', 'item', 'faction', 'concept', 'event'] },
						description: 'Optional entry types to restrict the search.',
					},
					limit: {
						type: 'number',
						description: 'Maximum results to return, 1-10. Default 5.',
					},
					follow_depth: {
						type: 'number',
						description: 'How many wikilink/backlink layers to include for each result, 0-3. Default 1.',
					},
					include_hidden: {
						type: 'boolean',
						description: 'Whether local-cache fallback results may include narrator-only hidden_info. Default true.',
					},
					exact: {
						type: 'boolean',
						description: 'Use exact markdown search only instead of semantic Qdrant search. Default false.',
					},
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'brief_wiki',
			description: 'Get a broader terminal-owned wiki orientation brief before narrating or repairing lore. Use this when the scene touches several pages, when you need health/hubs/recent context, or when a plain search is too narrow. Returns followed wikilink/backlink context plus a runbook.',
			parameters: {
				type: 'object',
				properties: {
					task: {
						type: 'string',
						description: 'The question or maintenance task to orient around.',
					},
					mode: {
						type: 'string',
						enum: ['answer', 'maintain', 'ingest', 'lint', 'explore'],
						description: 'Briefing style. Use answer before narration, explore for broad lore mapping, maintain/lint/ingest for wiki maintenance. Default answer.',
					},
					limit: {
						type: 'number',
						description: 'Search seed count, 1-8. Default 5.',
					},
					follow_depth: {
						type: 'number',
						description: 'How many wikilink/backlink layers to include, 0-3. Default 2.',
					},
					page_limit: {
						type: 'number',
						description: 'Maximum context pages in the brief, 1-24. Default 12.',
					},
					exact: {
						type: 'boolean',
						description: 'Use exact markdown search only instead of semantic Qdrant search. Default false.',
					},
				},
				required: ['task'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'roll_check',
			description: 'Roll a D&D-style check when an uncertain action has meaningful success and failure states. Call before narrating the outcome; do not invent the roll in prose.',
			parameters: {
				type: 'object',
				properties: {
					notation: {
						type: 'string',
						description: 'D&D notation, usually 1d20, 1d20+3, 1d20 advantage, or 1d20 disadvantage.',
					},
					dc: {
						type: 'number',
						description: 'Difficulty class: 10 easy, 15 moderate, 20 hard, 25 very hard.',
					},
					ability: {
						type: 'string',
						description: 'Short ability or skill label, such as STR, DEX, CHA, Stealth, or Persuasion.',
					},
					description: {
						type: 'string',
						description: 'Plain-language reason for the roll.',
					},
				},
				required: ['notation', 'dc', 'description'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'update_world_state',
			description: 'Update characters, locations, items, and time after narrating. Call this ONCE at the end of every response.',
			parameters: {
				type: 'object',
				properties: {
					characters: {
						type: 'array',
						description: 'Update only established canonical characters that are already present in context or clearly resolved by name/alias. Do not use this to invent new character canon; unknown names become reviewable references until approved.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								aliases: {
									type: 'array',
									items: { type: 'string' },
									description: 'Alternate names, titles, house styles, or epithets used for the same character.',
								},
								status: { type: 'string', enum: ['active', 'departed', 'deceased', 'inactive'] },
								description: { type: 'string' },
								relationship: { type: 'string' },
								traits: { type: 'array', items: { type: 'string' } },
								present: { type: 'boolean' },
								currentLocation: { type: 'string', description: 'Where this established character currently is or was last clearly seen. Omit when unchanged.' },
								currentAction: { type: 'string', description: 'What this established character is actively doing or trying to do now. Omit when unchanged.' },
								emotionalState: { type: 'string', description: 'Current visible emotional posture, not private omniscient thoughts. Omit when unchanged.' },
								pressures: {
									type: 'array',
									items: { type: 'string' },
									description: "Circumstances tightening around this NPC that they will act on even when off-screen. Short sentences. Add when meaningfully introduced or when the situation shifts (new debt, a suitor circling, a brother killed, illness, a deadline). Examples: 'being courted by a wealthy older merchant who is abusive', 'father drowning in gambling debts', 'wants revenge for her slain brother', 'is running out of coin and time'.",
								},
								faction_tags: {
									type: 'array',
									items: { type: 'string' },
									description: 'Faction names or ids this character belongs to, serves, leads, commands, publicly represents, or is sworn to. Use only when established by the scene or existing context.',
								},
								appearance: { type: 'string', description: 'Durable visual portrayal details that changed or became clear this turn. Omit when unchanged.' },
								background: { type: 'string', description: 'Durable backstory/context that became clear this turn. Omit when unchanged.' },
								goals: { type: 'array', items: { type: 'string' }, description: 'Current concrete goals this established character is pursuing. Omit when unchanged.' },
								speechStyle: { type: 'string', description: 'Durable voice, diction, or speaking manner. Omit when unchanged.' },
								eventMemory: {
									type: 'object',
									description: 'Compact NPC memory from this turn only. Use did/saw/knew/knows arrays. Omit when unchanged.',
									properties: {
										did: { type: 'array', items: { type: 'string' } },
										saw: { type: 'array', items: { type: 'string' } },
										knew: { type: 'array', items: { type: 'string' } },
										knows: { type: 'array', items: { type: 'string' } },
									},
								},
							},
							required: ['name'],
						},
					},
					locations: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								description: { type: 'string' },
								current: { type: 'boolean' },
								region: { type: 'string' },
								connections: {
									type: 'array',
									items: {
										type: 'object',
										properties: {
											targetName: { type: 'string' },
											direction: { type: 'string' },
											travelTimeMinutes: { type: 'number' },
										},
									},
								},
							},
							required: ['name'],
						},
					},
					items: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								description: { type: 'string' },
								quantity: { type: 'number' },
								equipped: { type: 'boolean' },
								location: { type: 'string' },
							},
							required: ['name'],
						},
					},
					time_delta: { type: 'string', description: "How much time passed, e.g. 'a few minutes', 'several hours', 'a day'" },
					mood: { type: 'string', description: 'Scene mood: tense, calm, mysterious, joyful, etc.' },
					player_reputation: {
						type: 'string',
						description: 'Optional full replacement for the compact Player Reputation prompt section. Use only when public reputation changed: titles, scandals, rumors, feared/loved status, legal standing, house/court gossip, or how strangers and factions speak of the player. Omit when unchanged.',
					},
					player_ledger: {
						type: 'string',
						description: 'Optional full replacement for the Player Ledger prompt section. Use only when coin, income, assets, holdings, payroll, debts, claims, stores, ships, troops under pay, or regular expenses materially changed. Preserve player-written durable notes; omit when unchanged.',
					},
					conversations: {
						type: 'array',
						description: 'NPC conversations that occurred — what was revealed, learned, emotional shifts',
						items: {
							type: 'object',
							properties: {
								npcName: { type: 'string' },
								topicSummary: { type: 'string' },
								playerRevealed: { type: 'array', items: { type: 'string' } },
								npcLearned: { type: 'array', items: { type: 'string' } },
								emotionalShift: { type: 'string' },
							},
							required: ['npcName', 'topicSummary'],
						},
					},
					relationships: {
						type: 'array',
						description: 'Relationship changes between entities',
						items: {
							type: 'object',
							properties: {
								sourceName: { type: 'string' },
								targetName: { type: 'string' },
								type: { type: 'string' },
								label: { type: 'string' },
								strength: { type: 'number', minimum: -100, maximum: 100 },
								bidirectional: { type: 'boolean' },
							},
							required: ['sourceName', 'targetName', 'type'],
						},
					},
					story_beats: {
						type: 'array',
						description: 'Significant plot events that just occurred',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								description: { type: 'string' },
								significance: { type: 'string', enum: ['minor', 'moderate', 'major', 'critical'] },
							},
							required: ['title'],
						},
					},
					timeline_events: {
						type: 'array',
						description: 'Delayed, scheduled, hidden, public, or faction-linked events that should enter the backend timeline. Use this for plans, rumors, deadlines, schemes, expected consequences, and events that become due on a future turn. Do not duplicate ordinary immediate scene beats already captured by story_beats.',
						items: {
							type: 'object',
							properties: {
								title: { type: 'string' },
								description: { type: 'string' },
								type: {
									type: 'string',
									enum: ['promise', 'betrayal', 'reveal', 'faction_move', 'injury', 'death', 'relationship_shift', 'agreement', 'scene_transition', 'clue_discovery', 'correction', 'imported_memory', 'world_tick', 'scheme', 'rumor', 'marriage', 'alliance'],
								},
								status: {
									type: 'string',
									enum: ['proposed', 'scheduled', 'due', 'committed', 'cancelled'],
									description: 'Use scheduled for delayed events; proposed for uncertain plans; committed only for events that already happened but need explicit timeline metadata.',
								},
								delay_turns: { type: 'number', description: 'Turns from the current turn until this becomes due. Prefer this for relative deadlines.' },
								due_turn: { type: 'number', description: 'Absolute turn when this becomes due, if known.' },
								world_time: { type: 'string', description: 'In-world due time or occurred time, if known.' },
								visibility: { type: 'string', enum: ['public', 'player_known', 'secret'] },
								actor_names: { type: 'array', items: { type: 'string' }, description: 'Known actors or planners by canonical name.' },
								target_names: { type: 'array', items: { type: 'string' }, description: 'Known targets or affected NPCs by canonical name.' },
								faction_names: { type: 'array', items: { type: 'string' }, description: 'Known factions attached to this timeline event.' },
								location_name: { type: 'string' },
								memory_impact: { type: 'object', description: 'Compact notes about who knows, rumors, stakes, or future impact.' },
								reason: { type: 'string', description: 'Why this timeline record was created from the turn.' },
							},
							required: ['title'],
						},
					},
					meter_changes: {
						type: 'array',
						description: 'Adjust persistent meters (sanity, morality, reputation, hunger, suspicion, fatigue, etc.). The current values are included in the state snapshot so you can reason about them.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Meter name (e.g. "sanity", "reputation:Lannisters", "hunger")' },
								delta: { type: 'number', description: 'Signed change to apply. On the FIRST mention of a meter (creating it), this is added on top of `initial`.' },
								initial: { type: 'number', description: 'Starting value used ONLY when this meter is being created. Use `max` (e.g. 100) for "high-is-good" meters that start full (sanity, health, reputation, morale). Use 0 for "low-is-bad" meters that start empty (hunger, fatigue, suspicion, debt, dread). Ignored on subsequent updates.' },
								max: { type: 'number', description: 'Optional max value (only set when first creating the meter — defaults to 100)' },
								visible: { type: 'boolean', description: 'Whether the player sees this meter in the HUD (defaults to true)' },
								reason: { type: 'string', description: 'Brief in-fiction reason for the change' },
							},
							required: ['name', 'delta'],
						},
					},
					agreements: {
						type: 'array',
						description: 'Record or update binding commitments between parties: treaties, alliances, oaths, debts, promises, marriages, vassalage, contracts, or bargains with supernatural entities. Use action=create when a new commitment is made; action=break when someone violates it; action=fulfill when the debt/promise is paid; action=update to revise terms; action=expire when it lapses. Currently active agreements are listed in the state snapshot so you can reason about them.',
						items: {
							type: 'object',
							properties: {
								action: { type: 'string', enum: ['create', 'update', 'break', 'fulfill', 'expire'], description: 'What to do with this agreement' },
								id: { type: 'string', description: 'Existing agreement id (required for update/break/fulfill/expire unless parties+category match uniquely)' },
								parties: { type: 'array', items: { type: 'string' }, description: 'Named parties to the agreement — display names matching lorebook entries when possible' },
								category: { type: 'string', enum: ['treaty', 'pact', 'alliance', 'oath', 'debt', 'promise', 'marriage', 'bond', 'contract', 'vassalage', 'bargain-with-entity'] },
								terms: { type: 'string', description: 'Prose description of what was agreed' },
								secrecy: { type: 'string', enum: ['public', 'known', 'secret'], description: 'Who in the world knows about it' },
								consequences: { type: 'array', items: { type: 'string' }, description: 'Narrative consequences already in motion from this agreement' },
								reason: { type: 'string', description: 'In-fiction reason for the change (e.g. "Lord Frey broke the guest right during the wedding")' },
							},
							required: ['action'],
						},
					},
					lorebook_entries: {
						type: 'array',
						description: 'Create rich lorebook entries for significant non-character world elements introduced or deepened this turn. Do not create character entries from narration extraction; character canon is created through human approval or explicit character controls. Write full descriptions (2-5 sentences), include aliases and keywords for retrieval, and hidden_info for secrets the player does not know.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Canonical name of the entity' },
								type: { type: 'string', enum: ['character', 'location', 'item', 'faction', 'concept', 'event'], description: 'Entry type; character is review-only unless the character already exists in backend canon.' },
								description: { type: 'string', description: 'Rich description based ONLY on what was established in the scene. 2–5 sentences.' },
								hidden_info: { type: 'string', description: 'Information the protagonist does NOT know yet. Null if nothing is hidden.' },
								aliases: { type: 'array', items: { type: 'string' }, description: 'Alternate names, titles, or epithets' },
								keywords: { type: 'array', items: { type: 'string' }, description: '3–5 retrieval keywords (name, aliases, related terms) for context injection' },
								injection_mode: { type: 'string', enum: ['always', 'keyword', 'never'], description: 'How this entry is injected into context. keyword = inject when keywords match recent text. always = inject every turn. never = archived.' },
								priority: { type: 'number', description: 'Injection priority. Higher = earlier in context. 0 is default.' },
								state_overrides: { type: 'object', description: 'Optional type-specific state overrides. For characters: { pressures: string[], factionTags: string[] }. For locations: { connections: [{ targetName, direction?, travelTimeMinutes? }] }. For factions: { playerStanding: number, status: string }.' },
								known_members: {
									type: 'array',
									items: { type: 'string' },
									description: 'Faction entries only: named characters who belong to, serve, lead, command, or publicly represent this faction.',
								},
								faction_goals: {
									type: 'array',
									description: 'Faction entries only: concrete goals this faction is pursuing.',
									items: {
										type: 'object',
										properties: {
											description: { type: 'string' },
											priority: { type: 'number', minimum: 1, maximum: 10 },
											progress: { type: 'number', minimum: 0, maximum: 100 },
											type: { type: 'string', enum: ['military', 'diplomatic', 'economic', 'intelligence', 'survival', 'expansion'] },
											deadline: { type: 'string' },
										},
										required: ['description'],
									},
								},
								faction_resources: {
									type: 'object',
									description: 'Faction entries only: relative resource scores from 0 to 100.',
									properties: {
										military: { type: 'number', minimum: 0, maximum: 100 },
										wealth: { type: 'number', minimum: 0, maximum: 100 },
										influence: { type: 'number', minimum: 0, maximum: 100 },
										information: { type: 'number', minimum: 0, maximum: 100 },
										morale: { type: 'number', minimum: 0, maximum: 100 },
									},
								},
								faction_disposition: { type: 'string', enum: ['aggressive', 'defensive', 'scheming', 'neutral', 'desperate'], description: 'Faction entries only: current operating posture.' },
								territory: { type: 'array', items: { type: 'string' }, description: 'Faction entries only: regions, holdings, routes, or institutions controlled.' },
							},
							required: ['name', 'type', 'description'],
						},
					},
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'refresh_plot_momentum',
			description: 'Request a fresh plot momentum analysis mid-generation. Call this if the scene has shifted dramatically and the existing momentum guidance no longer applies. The service will re-read current state, factions, and history and return updated plot branches and strategy.',
			parameters: {
				type: 'object',
				properties: {},
			},
		},
	},
];

// ── Anthropic Tool Format Converter ──

export function getToolsForProvider(providerType: string): any[] {
	if (providerType === 'anthropic') {
		return GM_TOOLS.map(tool => ({
			name: tool.function.name,
			description: tool.function.description,
			input_schema: tool.function.parameters,
		}));
	}
	// OpenAI-compatible format (default)
	return GM_TOOLS;
}
