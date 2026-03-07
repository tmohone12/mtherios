import { z } from 'zod';

export const characterUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	relationship: z.string().nullable(),
	status: z.enum(['active', 'inactive', 'deceased', 'unknown']),
	traits: z.array(z.string()).optional(),
});

export const locationUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	current: z.boolean(),
});

export const itemUpdateSchema = z.object({
	name: z.string(),
	description: z.string().nullable(),
	quantity: z.number().optional(),
	equipped: z.boolean().optional(),
	location: z.string().optional(),
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
	mood: z.string().optional(),
	timeProgression: z.string().optional(),
});

export type ClassificationResult = z.infer<typeof classificationResultSchema>;
export type CharacterUpdate = z.infer<typeof characterUpdateSchema>;
export type LocationUpdate = z.infer<typeof locationUpdateSchema>;
export type ItemUpdate = z.infer<typeof itemUpdateSchema>;
