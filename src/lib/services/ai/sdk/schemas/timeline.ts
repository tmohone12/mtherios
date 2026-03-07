import { z } from 'zod';

export const timelineFillEntrySchema = z.object({
	type: z.enum(['character', 'location', 'item', 'faction', 'concept', 'event']),
	name: z.string(),
	description: z.string(),
	keywords: z.array(z.string()),
	relevance: z.string().optional(),
});

export const timelineFillResultSchema = z.object({
	entries: z.array(timelineFillEntrySchema),
});

export type TimelineFillEntry = z.infer<typeof timelineFillEntrySchema>;
export type TimelineFillResult = z.infer<typeof timelineFillResultSchema>;
