import { z } from 'zod';

export const arcSummarySchema = z.object({
	title: z.string(),
	summary: z.string(),
	keyPlotPoints: z.array(z.string()),
	characterArcs: z.array(z.object({
		name: z.string(),
		development: z.string(),
	})),
	unresolvedThreads: z.array(z.string()),
	emotionalProgression: z.string(),
});

export type ArcSummary = z.infer<typeof arcSummarySchema>;
