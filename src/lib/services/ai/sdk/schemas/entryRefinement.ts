import { z } from 'zod';

export const entryRefinementResultSchema = z.object({
	description: z.string().nullable().optional(),
	keywords: z.array(z.string()).nullable().optional(),
	aliases: z.array(z.string()).nullable().optional(),
	hiddenInfo: z.string().nullable().optional(),
	// Character-only enrichment — omitted for other entry types
	bio: z.string().nullable().optional(),
	motivations: z.array(z.string()).nullable().optional(),
	personality: z.string().nullable().optional(),
	reasoning: z.string(),
});

export type EntryRefinementResult = z.infer<typeof entryRefinementResultSchema>;
