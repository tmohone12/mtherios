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
	status: z.enum(['active', 'departed', 'deceased', 'inactive']).optional().default('active'),
	description: z.string().nullable().optional().default(null),
	relationship: z.string().nullable().optional().default(null),
	traits: z.array(z.string()).optional().default([]),
	present: z.boolean().optional().default(true),
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

export const worldStateMeterChangeSchema = z.object({
	name: z.string(),
	delta: z.number(),
	max: z.number().optional(),
	visible: z.boolean().optional(),
	reason: z.string().nullable().optional().default(null),
});

export const worldStateUpdateSchema = z.object({
	characters: z.array(worldStateCharacterSchema).optional().default([]),
	locations: z.array(worldStateLocationSchema).optional().default([]),
	items: z.array(worldStateItemSchema).optional().default([]),
	time_delta: z.string().nullable().optional(),
	mood: z.string().nullable().optional(),
	conversations: z.array(worldStateConversationSchema).optional().default([]),
	relationships: z.array(worldStateRelationshipSchema).optional().default([]),
	story_beats: z.array(worldStateStoryBeatSchema).optional().default([]),
	meter_changes: z.array(worldStateMeterChangeSchema).optional().default([]),
});

export type WorldStateUpdate = z.infer<typeof worldStateUpdateSchema>;

export const queryLoreArgsSchema = z.object({
	query: z.string(),
	type_filter: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']).optional(),
});

export type QueryLoreArgs = z.infer<typeof queryLoreArgsSchema>;

export const createLoreEntryArgsSchema = z.object({
	name: z.string(),
	type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
	description: z.string(),
	keywords: z.array(z.string()).optional().default([]),
	hidden_info: z.string().nullable().optional().default(null),
});

export type CreateLoreEntryArgs = z.infer<typeof createLoreEntryArgsSchema>;

// ── OpenAI Function-Calling Format ──

export const GM_TOOLS = [
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
						items: {
							type: 'object',
							properties: {
								name: { type: 'string' },
								status: { type: 'string', enum: ['active', 'departed', 'deceased', 'inactive'] },
								description: { type: 'string' },
								relationship: { type: 'string' },
								traits: { type: 'array', items: { type: 'string' } },
								present: { type: 'boolean' },
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
					meter_changes: {
						type: 'array',
						description: 'Adjust persistent meters (sanity, morality, reputation, hunger, suspicion, etc.). Create a meter the first time you reference it by passing a name and an initial delta. The current values are included in the state snapshot so you can reason about them.',
						items: {
							type: 'object',
							properties: {
								name: { type: 'string', description: 'Meter name (e.g. "sanity", "reputation:Lannisters", "hunger")' },
								delta: { type: 'number', description: 'Signed change to apply to current value' },
								max: { type: 'number', description: 'Optional max value (only set when first creating the meter — defaults to 100)' },
								visible: { type: 'boolean', description: 'Whether the player sees this meter in the HUD (defaults to true)' },
								reason: { type: 'string', description: 'Brief in-fiction reason for the change' },
							},
							required: ['name', 'delta'],
						},
					},
				},
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'query_lore',
			description: 'Search the lorebook for relevant entries. Use BEFORE narrating when you need to check facts about characters, locations, factions, or world lore.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Semantic search query' },
					type_filter: { type: 'string', enum: ['character', 'location', 'item', 'faction', 'concept', 'event'] },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function' as const,
		function: {
			name: 'create_lore_entry',
			description: 'Create a new lorebook entry for a newly introduced entity (character, location, faction, etc.)',
			parameters: {
				type: 'object',
				properties: {
					name: { type: 'string' },
					type: { type: 'string', enum: ['character', 'location', 'item', 'faction', 'concept', 'event'] },
					description: { type: 'string' },
					keywords: { type: 'array', items: { type: 'string' } },
					hidden_info: { type: 'string', description: 'GM-only info the player shouldn\'t see yet' },
				},
				required: ['name', 'type', 'description'],
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
