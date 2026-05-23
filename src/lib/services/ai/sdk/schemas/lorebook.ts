import { z } from 'zod';

export const loreUpdateSchema = z.object({
	action: z.enum(['create', 'update', 'merge', 'archive']),
	entryId: z.string().optional(),
	name: z.string(),
	type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
	description: z.string(),
	keywords: z.array(z.string()),
	reason: z.string(),
	// Character enrichment (only for character type entries)
	bio: z.string().nullable().optional(),
	motivations: z.array(z.string()).nullable().optional(),
	personality: z.string().nullable().optional(),
	// Faction enrichment (only for faction type entries)
	knownMembers: z.array(z.string()).nullable().optional(),
	goals: z.array(z.object({
		description: z.string(),
		priority: z.number().min(1).max(10).optional().default(5),
		progress: z.number().min(0).max(100).optional().default(0),
		type: z.enum(['military', 'diplomatic', 'economic', 'intelligence', 'survival', 'expansion']).optional().default('diplomatic'),
		deadline: z.string().nullable().optional(),
	})).nullable().optional(),
	resources: z.object({
		military: z.number().min(0).max(100).optional().default(50),
		wealth: z.number().min(0).max(100).optional().default(50),
		influence: z.number().min(0).max(100).optional().default(50),
		information: z.number().min(0).max(100).optional().default(50),
		morale: z.number().min(0).max(100).optional().default(50),
	}).nullable().optional(),
	disposition: z.enum(['aggressive', 'defensive', 'scheming', 'neutral', 'desperate']).nullable().optional(),
	territory: z.array(z.string()).nullable().optional(),
});

export const loreManagementResultSchema = z.object({
	updates: z.array(loreUpdateSchema),
	summary: z.string().optional(),
});

export type LoreUpdate = z.infer<typeof loreUpdateSchema>;
export type LoreManagementResult = z.infer<typeof loreManagementResultSchema>;
