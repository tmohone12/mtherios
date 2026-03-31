/**
 * EntryRetrievalService — Mtherios
 *
 * Retrieves relevant lorebook entries using embedding-based semantic similarity
 * with keyword boost. Falls back to TF-IDF when API embeddings aren't available.
 */

import { createLogger } from '../core/config';
import type { Entry, StoryEntry } from '$lib/types';

const log = createLogger('EntryRetrieval');

export interface RetrievalResult {
	entries: Entry[];
	contextBlock: string;
}

export class EntryRetrievalService {
	/**
	 * Retrieve lorebook entries relevant to the current context.
	 * Uses embedding similarity + keyword boost against recent story entries.
	 */
	async retrieve(
		allEntries: Entry[],
		recentEntries: StoryEntry[],
		maxEntries = 10,
	): Promise<RetrievalResult> {
		const recentText = recentEntries.slice(-10).map(e => e.content).join(' ');
		const recentTextLower = recentText.toLowerCase();

		// Separate always-on entries from scored entries
		const alwaysEntries: Array<{ entry: Entry; score: number }> = [];
		const candidates: Entry[] = [];

		for (const entry of allEntries) {
			if (entry.injection.mode === 'never') continue;
			if (entry.injection.mode === 'always') {
				alwaysEntries.push({ entry, score: entry.injection.priority + 1000 });
			} else {
				candidates.push(entry);
			}
		}

		// Score candidates via embeddings (falls back to TF-IDF internally)
		const { ai } = await import('$lib/services/ai');
		const embeddingItems = candidates.map(e => ({
			id: e.id,
			text: `${e.name}: ${e.description}`,
			sourceType: 'lorebook' as const,
		}));

		const embeddingScores = await ai.embeddings.scoreSimilarity(recentText, embeddingItems);
		const scoreMap = new Map(embeddingScores.map(s => [s.id, s.score]));

		// Combine embedding score with keyword boost
		const scored: Array<{ entry: Entry; score: number }> = [];
		for (const entry of candidates) {
			const embeddingScore = scoreMap.get(entry.id) ?? 0;

			// Keyword boost: +0.15 per hit, capped at +0.45
			let keywordBoost = 0;
			for (const kw of entry.injection.keywords) {
				if (recentTextLower.includes(kw.toLowerCase())) {
					keywordBoost += 0.15;
				}
			}
			keywordBoost = Math.min(keywordBoost, 0.45);

			const finalScore = embeddingScore + keywordBoost;

			// Filter noise: minimum 0.1 threshold
			if (finalScore >= 0.1) {
				scored.push({ entry, score: finalScore });
			}
		}

		// Merge always-on entries with scored entries
		const all = [...alwaysEntries, ...scored];
		all.sort((a, b) => b.score - a.score);
		const selected = all.slice(0, maxEntries).map(s => s.entry);

		log('retrieve', { total: allEntries.length, matched: selected.length });

		// Build context block
		let contextBlock = '';
		if (selected.length > 0) {
			contextBlock = '\n\n[WORLD LORE]\n';
			for (const entry of selected) {
				contextBlock += `### ${entry.name} (${entry.type})\n`;
				contextBlock += `${entry.description}\n`;
				if (entry.hiddenInfo) contextBlock += `[Hidden: ${entry.hiddenInfo}]\n`;
				contextBlock += '\n';
			}
		}

		return { entries: selected, contextBlock };
	}
}
