import { z } from 'zod';

export const characterUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	relationship: z.string().nullable(),
	status: z.enum(['active', 'inactive', 'departed', 'deceased', 'unknown']),
	traits: z.array(z.string()).optional(),
});

export const locationConnectionSchema = z.object({
	targetName: z.string(),
	direction: z.string().nullable(),
	travelTimeMinutes: z.number(),
	description: z.string().nullable(),
});

export const locationUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	current: z.boolean(),
	region: z.string().nullable().optional(),
	terrain: z.string().nullable().optional(),
	connections: z.array(locationConnectionSchema).default([]),
});

export const itemUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	quantity: z.number().optional(),
	equipped: z.boolean().optional(),
	location: z.string().optional(),
});

export const relationshipExtractionSchema = z.object({
	sourceName: z.string(),
	targetName: z.string(),
	type: z.enum([
		'member-of', 'leader-of', 'allied-with', 'enemy-of',
		'located-in', 'part-of', 'created-by', 'triggered-by',
		'knows-about', 'owns', 'serves', 'related-to',
	]),
	label: z.string().nullable(),
	strength: z.number().min(0).max(100),
	bidirectional: z.boolean(),
});

export const conversationDetectionSchema = z.object({
	npcName: z.string(),
	topicSummary: z.string(),
	playerRevealed: z.array(z.string()),
	npcLearned: z.array(z.string()),
	emotionalShift: z.string().nullable(),
	importance: z.enum(['trivial', 'minor', 'significant', 'critical']),
});

export const factionSignalSchema = z.object({
	factionName: z.string(),
	trigger: z.enum(['threatened', 'opportunity', 'informed', 'provoked', 'weakened']),
	context: z.string().describe('1 sentence: why this faction cares about what just happened'),
	urgency: z.enum(['low', 'medium', 'high']).default('low'),
});

export const classificationResultSchema = z.object({
	characters: z.array(characterUpdateSchema),
	locations: z.array(locationUpdateSchema),
	items: z.array(itemUpdateSchema),
	storyBeats: z.array(z.object({
		title: z.string(),
		description: z.string(),
		significance: z.enum(['minor', 'moderate', 'major', 'critical']),
	})),
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
