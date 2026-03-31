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
	ragContext: string;
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
		let ragContext = '';
		let iteration = 0;

		// Initial semantic retrieval (async — embedding-based with TF-IDF fallback)
		const initial = await this.entryRetrieval.retrieve(allLoreEntries, recentEntries);
		collectedEntries = [...initial.entries];

		// Agentic loop: ask AI if more context is needed
		while (iteration < maxIterations) {
			iteration++;
			const collectedNames = collectedEntries.map(e => e.name).join(', ');
			const chapterSummaries = chapters.map(c => `Ch${c.number}: ${c.summary}`).join('\n');

			const system = `You are a context retrieval agent for an interactive fiction story. Your job is to determine whether the narrator has enough world context to respond accurately to the player's action.

═══ ALREADY RETRIEVED LORE ═══
${collectedNames || '(none yet)'}

═══ AVAILABLE CHAPTER SUMMARIES ═══
${chapterSummaries || '(none)'}

═══ DECISION PROCESS ═══

1. Read the player's action and recent context
2. Identify any characters, locations, items, factions, concepts, or events that the action references
3. Check if the already-retrieved lore covers those references
4. If something is referenced but NOT in the retrieved lore, generate specific search queries to find it

SEARCH QUERY TIPS:
- Use character/location/item NAMES as queries (e.g., "Kael", "Thornwall Keep", "Moonblade")
- Use faction or concept names (e.g., "Shadow Guild", "blood magic")
- Be specific — "the old woman's prophecy" not "prophecy"
- Maximum 3 queries per iteration

SET needsMoreContext TO FALSE when:
- The action is straightforward and doesn't reference tracked world elements
- All referenced elements are already in the retrieved lore
- The references are too vague to search for meaningfully

═══ OUTPUT FORMAT ═══

Respond with JSON:
{ "needsMoreContext": boolean, "queries": string[], "reason": string }`;

			const decision = await this.generateStructured(
				retrievalQuerySchema, system,
				`Player action: ${userInput}\nRecent context: ${recentEntries.slice(-3).map(e => e.content).join('\n')}`,
			);

			if (!decision.needsMoreContext || decision.queries.length === 0) break;

			// Search lore entries with embedding similarity
			const { ai } = await import('$lib/services/ai');
			for (const query of decision.queries) {
				const uncollectedIds = new Set(collectedEntries.map(e => e.id));
				const candidates = allLoreEntries.filter(e => !uncollectedIds.has(e.id));
				if (candidates.length === 0) break;

				const scored = await ai.embeddings.scoreSimilarity(
					query,
					candidates.map(e => ({
						id: e.id,
						text: `${e.name}: ${e.description}`,
						sourceType: 'lorebook' as const,
					})),
				);

				// Take top 5 above threshold
				const matches = scored
					.filter(s => s.score >= 0.25)
					.slice(0, 5)
					.map(s => allLoreEntries.find(e => e.id === s.id)!)
					.filter(Boolean);
				collectedEntries.push(...matches);
			}

			// Hard cap to prevent context explosion
			if (collectedEntries.length > 20) {
				collectedEntries = collectedEntries.slice(0, 20);
				break;
			}
		}

		// Cap at 20 entries and truncate long descriptions
		const cappedEntries = collectedEntries.slice(0, 20);
		if (cappedEntries.length > 0) {
			chapterContext = '\n[RETRIEVED LORE]\n';
			for (const e of cappedEntries) {
				const desc = e.description.length > 300
					? e.description.slice(0, 297) + '...'
					: e.description;
				chapterContext += `### ${e.name}\n${desc}\n\n`;
			}
		}

		// External Lore RAG — query vector DB for deep world knowledge
		try {
			const { ai: aiServices } = await import('$lib/services/ai');
			const ragResult = await aiServices.loreRAG.retrieve(userInput);
			if (ragResult.contextBlock) {
				ragContext = ragResult.contextBlock;
				log('retrieve', `RAG returned ${ragResult.totalFound} chunks from ${ragResult.source}`);
			}
		} catch (e) {
			log('retrieve', `RAG query failed (non-fatal): ${e}`);
		}

		log('retrieve complete', { iterations: iteration, entriesFound: collectedEntries.length });
		return { lorebookEntries: collectedEntries, chapterContext, ragContext, iterations: iteration };
	}
}
