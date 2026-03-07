import { z } from 'zod';

export const loreUpdateSchema = z.object({
	action: z.enum(['create', 'update', 'merge', 'archive']),
	entryId: z.string().optional(),
	name: z.string(),
	type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
	description: z.string(),
	keywords: z.array(z.string()),
	reason: z.string(),
});

export const loreManagementResultSchema = z.object({
	updates: z.array(loreUpdateSchema),
	summary: z.string().optional(),
});

export type LoreUpdate = z.infer<typeof loreUpdateSchema>;
export type LoreManagementResult = z.infer<typeof loreManagementResultSchema>;
