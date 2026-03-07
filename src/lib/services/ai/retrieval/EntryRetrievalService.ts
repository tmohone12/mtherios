/**
 * EntryRetrievalService — Mtherios
 * 
 * Retrieves relevant lorebook entries based on keyword matching
 * against the current narrative context.
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
	 * Uses keyword matching against recent story entries.
	 */
	retrieve(
		allEntries: Entry[],
		recentEntries: StoryEntry[],
		maxEntries = 10,
	): RetrievalResult {
		const recentText = recentEntries.slice(-10).map(e => e.content).join(' ').toLowerCase();

		const scored: Array<{ entry: Entry; score: number }> = [];

		for (const entry of allEntries) {
			if (entry.injection.mode === 'never') continue;

			if (entry.injection.mode === 'always') {
				scored.push({ entry, score: entry.injection.priority + 1000 });
				continue;
			}

			// Keyword matching
			let hits = 0;
			for (const kw of entry.injection.keywords) {
				if (recentText.includes(kw.toLowerCase())) hits++;
			}

			if (hits > 0) {
				const score = hits * entry.injection.priority;
				scored.push({ entry, score });
			}
		}

		// Sort by score descending, take top N
		scored.sort((a, b) => b.score - a.score);
		const selected = scored.slice(0, maxEntries).map(s => s.entry);

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
