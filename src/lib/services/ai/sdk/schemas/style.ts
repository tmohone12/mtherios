import { z } from 'zod';

export const styleReviewSchema = z.object({
	approved: z.boolean(),
	issues: z.array(z.object({
		type: z.enum(['pov_break', 'tense_shift', 'character_voice', 'repetition', 'pacing', 'tone_mismatch']),
		description: z.string(),
		severity: z.enum(['minor', 'moderate', 'major']),
		suggestion: z.string().optional(),
	})),
	revisedText: z.string().optional(),
	overallQuality: z.enum(['poor', 'fair', 'good', 'excellent']).optional(),
});

export type StyleReview = z.infer<typeof styleReviewSchema>;
