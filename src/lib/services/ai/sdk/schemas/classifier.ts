import { z } from 'zod';

export const characterUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	relationship: z.string().nullable().optional().default(null),
	status: z.enum(['active', 'inactive', 'departed', 'deceased', 'unknown']).default('active'),
	traits: z.array(z.string()).optional(),
});

export const locationConnectionSchema = z.object({
	targetName: z.string(),
	direction: z.string().nullable().optional().default(null),
	travelTimeMinutes: z.number().optional().default(0),
	description: z.string().nullable().optional().default(null),
});

export const locationUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	current: z.boolean().optional().default(false),
	region: z.string().nullable().optional(),
	terrain: z.string().nullable().optional(),
	connections: z.array(locationConnectionSchema).default([]),
});

export const itemUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable().optional().default(null),
	quantity: z.number().optional(),
	equipped: z.boolean().optional(),
	location: z.string().optional(),
});

export const relationshipExtractionSchema = z.object({
	sourceName: z.string().optional().default('unknown'),
	targetName: z.string().optional().default('unknown'),
	type: z.enum([
		'member-of', 'leader-of', 'allied-with', 'enemy-of',
		'located-in', 'part-of', 'created-by', 'triggered-by',
		'knows-about', 'owns', 'serves', 'related-to',
	]).default('related-to'),
	label: z.string().nullable().optional().default(null),
	strength: z.number().min(0).max(100).optional().default(50),
	bidirectional: z.boolean().optional().default(false),
});

export const conversationDetectionSchema = z.object({
	npcName: z.string().optional().default('unknown'),
	topicSummary: z.string().optional().default(''),
	playerRevealed: z.array(z.string()).default([]),
	npcLearned: z.array(z.string()).default([]),
	emotionalShift: z.string().nullable().optional().default(null),
	importance: z.enum(['trivial', 'minor', 'significant', 'critical']).default('minor'),
});

export const factionSignalSchema = z.object({
	factionName: z.string().optional().default('unknown'),
	trigger: z.enum(['threatened', 'opportunity', 'informed', 'provoked', 'weakened']).default('informed'),
	context: z.string().optional().default('').describe('1 sentence: why this faction cares about what just happened'),
	urgency: z.enum(['low', 'medium', 'high']).default('low'),
});

export const classificationResultSchema = z.object({
	characters: z.array(characterUpdateSchema).default([]),
	locations: z.array(locationUpdateSchema).default([]),
	items: z.array(itemUpdateSchema).default([]),
	storyBeats: z.array(z.object({
		title: z.string().optional().default('Untitled'),
		description: z.string().optional().default(''),
		significance: z.enum(['minor', 'moderate', 'major', 'critical']).default('minor'),
	})).default([]),
	relationships: z.array(relationshipExtractionSchema).default([]),
	conversations: z.array(conversationDetectionSchema).default([]),
	factionSignals: z.array(factionSignalSchema).default([]),
	mood: z.string().optional(),
	timeProgression: z.string().optional(),
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;
export type CharacterUpdate = z.infer<typeof characterUpdateSchema>;
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;
export type RelationshipExtraction = z.infer<typeof relationshipExtractionSchema>;
export type ConversationDetection = z.infer<typeof conversationDetectionSchema>;
export type FactionSignal = z.infer<typeof factionSignalSchema>;
