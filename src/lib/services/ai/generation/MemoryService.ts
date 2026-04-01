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
import { countTokens } from '$lib/utils/tokens';
import type { Chapter, StoryEntry } from '$lib/types';

const log = createLogger('Memory');

export const DEFAULT_MEMORY_CONFIG = {
	tokenThreshold: 16000,
	chapterBuffer: 10,
	autoSummarize: true,
	enableRetrieval: true,
	maxChaptersPerRetrieval: 5,
};

/** Max tokens for entry text sent to analysis/summarization LLMs */
const MAX_INPUT_TOKENS = 16000;
/** Max previous chapter summaries to include for context */
const MAX_PREV_CHAPTERS = 5;

export class MemoryService extends BaseAIService {
	constructor() {
		super('memory');
	}

	async summarizeChapter(
		entries: StoryEntry[],
		previousChapters?: Chapter[],
		mode = 'adventure', pov = 'second', tense = 'present',
		enrichment?: {
			storyBeats?: Array<{ title: string; description: string; significance: string }>;
			mood?: string;
		},
	): Promise<ChapterSummaryResult> {
		log('summarizeChapter', { entryCount: entries.length, beats: enrichment?.storyBeats?.length ?? 0 });

		// Truncate entries to fit within input budget
		let entriesText = '';
		let tokensSoFar = 0;
		for (const e of entries) {
			const line = `[${e.type}]: ${e.content}\n\n`;
			const lineTokens = countTokens(line);
			if (tokensSoFar + lineTokens > MAX_INPUT_TOKENS) break;
			entriesText += line;
			tokensSoFar += lineTokens;
		}

		// Only include last N chapter summaries for context
		const recentChapters = previousChapters?.slice(-MAX_PREV_CHAPTERS) ?? [];
		const prevContext = recentChapters.length
			? `Previous chapters:\n${recentChapters.map(c => `Chapter ${c.number}: ${c.summary}`).join('\n\n')}`
			: '';

		let beatsContext = '';
		if (enrichment?.storyBeats?.length) {
			beatsContext = `═══ CLASSIFIED STORY BEATS ═══\n(These moments were identified as significant during play. Weight them appropriately in your summary.)\n`;
			for (const beat of enrichment.storyBeats) {
				beatsContext += `- [${beat.significance}] ${beat.title}: ${beat.description}\n`;
			}
			if (enrichment.mood) beatsContext += `\nOverall mood: ${enrichment.mood}\n`;
			beatsContext += '\n';
		}

		const system = `You are a chapter summarizer for a ${mode} interactive fiction story (${pov} person, ${tense} tense).

Your summary must capture everything a future AI narrator needs to maintain story continuity without re-reading the original text.

${prevContext ? `═══ PREVIOUS CHAPTERS ═══\n${prevContext}\n` : ''}${beatsContext}═══ WHAT TO CAPTURE ═══

- Plot events and decisions (chronological), character changes (introductions, deaths, relationship shifts)
- Locations visited, items gained/lost, world facts learned
- Unresolved threads and unanswered questions
- Emotional tone shifts

═══ SUMMARY STYLE ═══

- Write in ${tense} tense, third person (regardless of story POV) — this is a reference summary, not narrative
- Be thorough but focused: 300-500 words
- Focus on WHAT CHANGED, not moment-by-moment play-by-play
- The title should be evocative (2-5 words) capturing the chapter's essence

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "title": "Evocative 2-5 word chapter title",
  "summary": "300-500 word summary of this chapter",
  "keywords": ["keyword1", "keyword2", "...5-10 terms for retrieval"],
  "keyCharacters": ["character names that appear in this chapter"],
  "keyLocations": ["location names visited in this chapter"],
  "emotionalTone": "one or two words describing the emotional tone"
}`;

		return this.generateStructured(chapterSummaryResultSchema, system, `Chapter content:\n${entriesText}`);
	}

	async analyzeForChapter(
		entries: StoryEntry[],
		lastChapterEndIndex: number,
		tokensOutsideBuffer: number,
		mode = 'adventure', pov = 'second', tense = 'present',
	): Promise<ChapterAnalysis> {
		log('analyzeForChapter', { entryCount: entries.length, tokensOutsideBuffer });

		// Truncate entries to fit within input budget — use 0-based indices
		let entriesText = '';
		let tokensSoFar = 0;
		let entryCount = 0;
		for (let i = 0; i < entries.length; i++) {
			const line = `[Entry ${i}] [${entries[i].type}]: ${entries[i].content}\n\n`;
			const lineTokens = countTokens(line);
			if (tokensSoFar + lineTokens > MAX_INPUT_TOKENS) break;
			entriesText += line;
			tokensSoFar += lineTokens;
			entryCount = i + 1;
		}

		const system = `You analyze ${mode} story entries (${pov} person, ${tense} tense) to determine whether a chapter boundary should be created.

The story has ${tokensOutsideBuffer} tokens outside the active context buffer. Chapter boundaries help manage memory by summarizing older content.
There are ${entries.length} unchaptered entries (${entryCount} shown below, labelled Entry 0 through Entry ${entryCount - 1}).

═══ WHEN TO CREATE A CHAPTER ═══

Create a chapter at NATURAL NARRATIVE BREAKS:
- Scene transitions (new location, new time of day)
- Time skips (hours, days, or longer)
- Resolution of a dramatic sequence (combat ends, conversation concludes, puzzle solved)
- Dramatic revelations that shift the story's direction
- A clear shift in emotional tone or stakes

Do NOT create a chapter:
- In the middle of active dialogue or combat
- When only 2-3 entries exist since the last chapter
- When the current scene has unresolved immediate tension

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "shouldCreateChapter": boolean,
  "optimalEndIndex": number,
  "keywords": string[],
  "reason": string
}

- optimalEndIndex: The 0-based index of the LAST entry to include in the chapter (e.g. if entries 0-12 form a natural chapter, return 12). Must be between 0 and ${entryCount - 1}.
- keywords: 5-10 terms capturing this chapter's key content for future retrieval
- reason: Brief explanation of why this is (or isn't) a good chapter boundary`;

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

		const system = `You decide whether the player's current action requires context from past chapters to generate an accurate, consistent response.

═══ AVAILABLE CHAPTERS ═══
${chapterSummaries}

═══ RETRIEVAL GUIDELINES ═══

RETRIEVE when the current action:
- Mentions a character, location, or item from a past chapter by name
- References a past event ("remember when...", "the last time...", "like before...")
- Requires knowledge of an established relationship, promise, or unresolved thread
- Returns to a previously visited location (need to know its last state)

DO NOT RETRIEVE when:
- The action is self-contained and doesn't reference past events
- The recent narrative already contains sufficient context
- The reference is too vague to match a specific chapter

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "shouldRetrieve": boolean,
  "relevantChapterIds": string[],
  "reason": string
}

- Only include chapter IDs that are DIRECTLY relevant — do not pad with tangentially related chapters
- Maximum 3 chapters to avoid context overload
- reason: Explain what specific information from the chapter(s) is needed`;

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
