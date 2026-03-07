/**
 * MemoryService — Mtherios
 * 
 * Handles chapter summarization, chapter boundary detection,
 * and retrieval decisions for long-form narrative memory.
 */

import { BaseAIService } from '../BaseAIService';
import {
	chapterSummaryResultSchema, chapterAnalysisSchema, retrievalDecisionSchema,
	type ChapterSummaryResult, type ChapterAnalysis, type RetrievalDecision,
} from '../sdk/schemas/memory';
import { createLogger } from '../core/config';
import type { Chapter, StoryEntry } from '$lib/types';

const log = createLogger('Memory');

export const DEFAULT_MEMORY_CONFIG = {
	tokenThreshold: 16000,
	chapterBuffer: 10,
	autoSummarize: true,
	enableRetrieval: true,
	maxChaptersPerRetrieval: 3,
};

export class MemoryService extends BaseAIService {
	constructor() {
		super('memory');
	}

	async summarizeChapter(
		entries: StoryEntry[],
		previousChapters?: Chapter[],
		mode = 'adventure', pov = 'second', tense = 'present',
	): Promise<ChapterSummaryResult> {
		log('summarizeChapter', { entryCount: entries.length });

		const entriesText = entries.map(e => `[${e.type}]: ${e.content}`).join('\n\n');
		const prevContext = previousChapters?.length
			? `Previous chapters:\n${previousChapters.map(c => `Chapter ${c.number}: ${c.summary}`).join('\n\n')}`
			: '';

		const system = `You are a chapter summarizer for a ${mode} story (${pov} person, ${tense} tense).
Create a concise but complete summary of this chapter. Capture key plot points, character developments, and world changes.

${prevContext}

Respond with JSON: { "title": string, "summary": string, "keywords": string[], "keyCharacters": string[], "keyLocations": string[], "emotionalTone": string }`;

		return this.generateStructured(chapterSummaryResultSchema, system, `Chapter content:\n${entriesText}`);
	}

	async analyzeForChapter(
		entries: StoryEntry[],
		lastChapterEndIndex: number,
		tokensOutsideBuffer: number,
		mode = 'adventure', pov = 'second', tense = 'present',
	): Promise<ChapterAnalysis> {
		log('analyzeForChapter', { entryCount: entries.length, tokensOutsideBuffer });

		const entriesText = entries.map((e, i) =>
			`[Message ${lastChapterEndIndex + 1 + i}] [${e.type}]: ${e.content}`
		).join('\n\n');

		const system = `You analyze ${mode} story entries (${pov} person, ${tense} tense) to determine chapter boundaries.
A chapter should end at a natural narrative break — a scene change, time skip, dramatic revelation, or resolution of tension.
The story has ${tokensOutsideBuffer} tokens outside the active buffer.

Respond with JSON: { "shouldCreateChapter": boolean, "optimalEndIndex": number, "keywords": string[], "reason": string }`;

		return this.generateStructured(chapterAnalysisSchema, system, `Entries:\n${entriesText}`);
	}

	async decideRetrieval(
		userInput: string,
		recentNarrative: string,
		availableChapters: Chapter[],
	): Promise<RetrievalDecision> {
		if (availableChapters.length === 0) {
			return { shouldRetrieve: false, relevantChapterIds: [], reason: 'No chapters available' };
		}

		const chapterSummaries = availableChapters
			.map(c => `[${c.id}] Chapter ${c.number}: ${c.summary}`)
			.join('\n\n');

		const system = `Decide if past chapters contain context relevant to the current action. Only retrieve if the current scene directly references or builds on past events.

Available chapters:
${chapterSummaries}

Respond with JSON: { "shouldRetrieve": boolean, "relevantChapterIds": string[], "reason": string }`;

		return this.generateStructured(retrievalDecisionSchema, system, `Current action: ${userInput}\n\nRecent narrative: ${recentNarrative}`);
	}

	buildRetrievedContextBlock(chapters: Chapter[], decision: RetrievalDecision): string {
		if (!decision.shouldRetrieve || decision.relevantChapterIds.length === 0) return '';
		const relevant = chapters.filter(c => decision.relevantChapterIds.includes(c.id));
		if (relevant.length === 0) return '';

		let block = '\n\n[RETRIEVED MEMORY]\n';
		for (const chapter of relevant) {
			block += `\n--- Chapter ${chapter.number} ---\n${chapter.summary}\n`;
			if (chapter.keywords?.length) block += `[Keywords: ${chapter.keywords.join(', ')}]\n`;
		}
		return block;
	}
}
