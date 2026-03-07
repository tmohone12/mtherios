/**
 * AgenticRetrievalService — Mtherios
 * 
 * Multi-step retrieval that uses AI to determine what context is needed,
 * retrieves it, and decides if more is needed — up to maxIterations.
 */

import { BaseAIService } from '../BaseAIService';
import { createLogger } from '../core/config';
import { EntryRetrievalService, type RetrievalResult } from './EntryRetrievalService';
import type { Entry, StoryEntry, Chapter } from '$lib/types';
import { z } from 'zod';

const log = createLogger('AgenticRetrieval');

const retrievalQuerySchema = z.object({
	needsMoreContext: z.boolean(),
	queries: z.array(z.string()),
	reason: z.string(),
});

export interface AgenticRetrievalResult {
	lorebookEntries: Entry[];
	chapterContext: string;
	iterations: number;
}

export class AgenticRetrievalService extends BaseAIService {
	private entryRetrieval = new EntryRetrievalService();

	constructor() {
		super('agenticRetrieval');
	}

	async retrieve(
		userInput: string,
		recentEntries: StoryEntry[],
		allLoreEntries: Entry[],
		chapters: Chapter[],
		maxIterations = 3,
	): Promise<AgenticRetrievalResult> {
		log('retrieve start', { maxIterations, loreCount: allLoreEntries.length, chapterCount: chapters.length });

		let collectedEntries: Entry[] = [];
		let chapterContext = '';
		let iteration = 0;

		// Initial keyword retrieval
		const initial = this.entryRetrieval.retrieve(allLoreEntries, recentEntries);
		collectedEntries = [...initial.entries];

		// Agentic loop: ask AI if more context is needed
		while (iteration < maxIterations) {
			iteration++;
			const collectedNames = collectedEntries.map(e => e.name).join(', ');
			const chapterSummaries = chapters.map(c => `Ch${c.number}: ${c.summary}`).join('\n');

			const system = `You are a context retrieval agent for a story. Decide if the current action needs more world context.

Already retrieved lore: ${collectedNames || '(none)'}
Available chapter summaries:
${chapterSummaries || '(none)'}

If the player's action references something not covered by the retrieved lore, suggest specific search queries.
If we have enough context, set needsMoreContext to false.

Respond with JSON: { "needsMoreContext": boolean, "queries": string[], "reason": string }`;

			const decision = await this.generateStructured(
				retrievalQuerySchema, system,
				`Player action: ${userInput}\nRecent context: ${recentEntries.slice(-3).map(e => e.content).join('\n')}`,
			);

			if (!decision.needsMoreContext || decision.queries.length === 0) break;

			// Search lore entries with the suggested queries
			for (const query of decision.queries) {
				const queryLower = query.toLowerCase();
				const matches = allLoreEntries.filter(e =>
					!collectedEntries.includes(e) &&
					(e.name.toLowerCase().includes(queryLower) ||
					 e.description.toLowerCase().includes(queryLower) ||
					 e.injection.keywords.some(kw => kw.toLowerCase().includes(queryLower)))
				);
				collectedEntries.push(...matches);
			}
		}

		// Build context block
		if (collectedEntries.length > 0) {
			chapterContext = '\n[RETRIEVED LORE]\n';
			for (const e of collectedEntries) {
				chapterContext += `### ${e.name}\n${e.description}\n\n`;
			}
		}

		log('retrieve complete', { iterations: iteration, entriesFound: collectedEntries.length });
		return { lorebookEntries: collectedEntries, chapterContext, iterations: iteration };
	}
}
