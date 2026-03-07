import { z } from 'zod';

export const actionChoiceSchema = z.object({
	text: z.string(),
	type: z.enum(['bold', 'cautious', 'creative', 'social', 'investigate']),
	risk: z.enum(['low', 'medium', 'high']).optional(),
	brief: z.string().optional(),
});

export const actionChoicesResultSchema = z.object({
	choices: z.array(actionChoiceSchema).min(2).max(4),
});

export type ActionChoice = z.infer<typeof actionChoiceSchema>;
export type ActionChoicesResult = z.infer<typeof actionChoicesResultSchema>;
