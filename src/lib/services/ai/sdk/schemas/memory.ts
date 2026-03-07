import { z } from 'zod';

export const chapterSummaryResultSchema = z.object({
	title: z.string(),
	summary: z.string(),
	keywords: z.array(z.string()),
	keyCharacters: z.array(z.string()),
	keyLocations: z.array(z.string()),
	emotionalTone: z.string(),
});

export const chapterAnalysisSchema = z.object({
	shouldCreateChapter: z.boolean(),
	optimalEndIndex: z.number(),
	keywords: z.array(z.string()),
	reason: z.string(),
});

export const retrievalDecisionSchema = z.object({
	shouldRetrieve: z.boolean(),
	relevantChapterIds: z.array(z.string()),
	reason: z.string().optional(),
});

export type ChapterSummaryResult = z.infer<typeof chapterSummaryResultSchema>;
export type ChapterAnalysis = z.infer<typeof chapterAnalysisSchema>;
export type RetrievalDecision = z.infer<typeof retrievalDecisionSchema>;
