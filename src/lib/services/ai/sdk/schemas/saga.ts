import { z } from 'zod';

export const sagaSummarySchema = z.object({
	title: z.string(),
	summary: z.string(),
	arcRange: z.string(),
	keyFactionShifts: z.array(z.string()).default([]),
	majorPowerChanges: z.array(z.string()).default([]),
	lingeringThreads: z.array(z.string()).default([]),
	overallTone: z.string(),
});

export type SagaSummary = z.infer<typeof sagaSummarySchema>;
