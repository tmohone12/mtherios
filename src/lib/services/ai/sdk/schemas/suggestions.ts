import { z } from 'zod';

export const suggestionSchema = z.object({
	text: z.string().min(1).max(120),
	type: z.enum(['action', 'dialogue', 'thought', 'direction']),
	brief: z.string().max(40).optional(),
});

export const suggestionsResultSchema = z.object({
	suggestions: z.array(suggestionSchema).min(1).max(4),
});

export type Suggestion = z.infer<typeof suggestionSchema>;
export type SuggestionsResult = z.infer<typeof suggestionsResultSchema>;
