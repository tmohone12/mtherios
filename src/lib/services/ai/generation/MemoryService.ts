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
import type { Chapter, Arc, StoryEntry } from '$lib/types';
import { buildMtheriosSummaryInstruction } from '$lib/services/ai/context/mtheriosSummaryFormat';
import { isParallelPovEntry } from '$lib/services/ai/context/parallelPov';

const log = createLogger('Memory');

/** Max tokens for entry text sent to analysis/summarization LLMs */
const MAX_INPUT_TOKENS = 16000;
/** Max previous chapter summaries to include for context */
const MAX_PREV_CHAPTERS = 5;

export function formatEntryForSummary(entry: StoryEntry): string {
	const perspective = isParallelPovEntry(entry) ? 'parallel POV; not player-character knowledge' : 'primary story';
	return `[${entry.type} source=${entry.id}; ${perspective}]: ${entry.content}\n\n`;
}

export function selectEntriesForChapterMemory(entries: StoryEntry[], maxTokens = Infinity): StoryEntry[] {
	const ordered = [...entries].sort((a, b) => a.position - b.position);
	if (Number.isFinite(maxTokens) && ordered.reduce((sum, entry) => sum + countTokens(formatEntryForSummary(entry)), 0) > maxTokens) {
		throw new Error('The complete chapter source exceeds the input budget. No partial summary was saved.');
	}
	return ordered;
}

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
		previousArcs?: Arc[],
		maxPrevChapters?: number,
	): Promise<ChapterSummaryResult> {
		log('summarizeChapter', { entryCount: entries.length, beats: enrichment?.storyBeats?.length ?? 0, priorArcs: previousArcs?.length ?? 0 });

		// Every source is required; a provider context error must remain a failed summary.
		const entriesText = selectEntriesForChapterMemory(entries)
			.map(formatEntryForSummary)
			.join('');

		// Only include last N chapter summaries for context
		const chapterCap = maxPrevChapters ?? MAX_PREV_CHAPTERS;
		const recentChapters = chapterCap > 0 ? previousChapters?.slice(-chapterCap) ?? [] : [];
		const prevContext = recentChapters.length
			? `Previous chapters:\n${recentChapters.map(c => `Chapter ${c.number}: ${c.summary}`).join('\n\n')}`
			: '';

		// Long-term arc context for stories with condensed history
		let arcContext = '';
		if (previousArcs && previousArcs.length > 0) {
			const recentArcs = previousArcs.slice(-3);
			arcContext = `═══ LONG-TERM STORY CONTEXT ═══\n(Arc summaries covering earlier parts of the story. Use these to maintain consistency with established facts, agreements, and relationships.)\n\n`;
			for (const arc of recentArcs) {
				arcContext += `Arc ${arc.arcNumber}: "${arc.title}" (Ch.${arc.chapterRange})\n${arc.summary}\n`;
				if (arc.unresolvedThreads?.length) arcContext += `Unresolved: ${arc.unresolvedThreads.join('; ')}\n`;
				arcContext += '\n';
			}
		}

		let beatsContext = '';
		if (enrichment?.storyBeats?.length) {
			beatsContext = `═══ CLASSIFIED STORY BEATS ═══\n(These moments were identified as significant during play. Weight them appropriately in your summary.)\n`;
			for (const beat of enrichment.storyBeats) {
				beatsContext += `- [${beat.significance}] ${beat.title}: ${beat.description}\n`;
			}
			if (enrichment.mood) beatsContext += `\nOverall mood: ${enrichment.mood}\n`;
			beatsContext += '\n';
		}

		const system = `Write factual chapter memory for a ${mode} interactive story (${pov} person, ${tense} tense).

The supplied source covers 20 completed turns: each player action and its resulting narration, plus any opening or unpaired narrative evidence. Read every source in order. Summarize what happened throughout the whole window, including quiet scenes, discussions, choices, discoveries, refusals, failures, resolutions, and consequences. Preserve who acted, what they learned or agreed, exact commitment terms, relationship changes, travel, time passing, and the ending situation. Never replace the middle of the chapter with a few highlights.

Keep action requests distinct from narrated outcomes. A /pov instruction is a control command; its resulting scene is canon from that character's perspective, without granting other characters that knowledge. Preserve secrets, beliefs, plans, and completed events as distinct things. Never invent motives, inferred future payoffs, escalation, or events absent from the source.

Earlier summaries provide context only. Do not retell earlier events as new events in this chapter. Classified beats are supporting evidence, not permission to ignore quieter source entries.
${arcContext}${prevContext ? `Earlier chapters:\n${prevContext}\n` : ''}${beatsContext}

Write a chronological account in plain third-person past tense. Compress repeated wording and decorative description. Let the amount of story determine the length; there is no word target or maximum number of events. Preserve completed resolutions as well as still-open matters. Before returning, check every supplied source for meaningful details missing from your account.

${buildMtheriosSummaryInstruction('chapter')}

Return JSON with title, summary (the required bracketed format), keywords, keyCharacters, keyLocations, and emotionalTone. Characters and locations must come from this chapter's source.`;

		return this.generateStructured(chapterSummaryResultSchema, system, `Chapter content:\n${entriesText}`);
	}

	async analyzeForChapter(
		entries: StoryEntry[],
		lastChapterEndIndex: number,
		tokensOutsideBuffer: number,
		mode = 'adventure', pov = 'second', tense = 'present',
	): Promise<ChapterAnalysis> {
		log('analyzeForChapter', { entryCount: entries.length, tokensOutsideBuffer });

		// Truncate entries to fit within input budget — use 0-based indices and skip oversized lines
		// instead of stopping before later chapter-ending material.
		let entriesText = '';
		let tokensSoFar = 0;
		let lastShownIndex = -1;
		for (let i = 0; i < entries.length; i++) {
			const line = `[Entry ${i}] [${entries[i].type}]: ${entries[i].content}\n\n`;
			const lineTokens = countTokens(line);
			if (tokensSoFar + lineTokens > MAX_INPUT_TOKENS) continue;
			entriesText += line;
			tokensSoFar += lineTokens;
			lastShownIndex = i;
		}

		const system = `You analyze ${mode} story entries (${pov} person, ${tense} tense) to determine whether a chapter boundary should be created.

The story has ${tokensOutsideBuffer} tokens outside the active context buffer. Chapter boundaries help manage memory by summarizing older content.
There are ${entries.length} unchaptered entries shown below by original 0-based entry index${lastShownIndex >= 0 ? `, up through Entry ${lastShownIndex}` : ''}.

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

- optimalEndIndex: The 0-based index of the LAST entry to include in the chapter (e.g. if entries 0-12 form a natural chapter, return 12). Must be between 0 and ${Math.max(0, entries.length - 1)}.
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
