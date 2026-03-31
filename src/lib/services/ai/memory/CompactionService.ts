/**
 * CompactionService — Mtherios
 *
 * LLM-driven lore compaction service that synthesizes the evolving world state
 * into a compact, present-tense narrative block for injection into the system
 * prompt header (highest attention weight — above the 5 context tiers).
 *
 * Flow:
 *   1. Take last 30 story entries + world state entities
 *   2. Optionally query Qdrant for relevant canonical lore (LoreRAG)
 *   3. LLM synthesizes a 300-600 word World State block
 *   4. Return proposed lore + line-level diff for human review
 *   5. Human approves/rejects — never auto-applied
 */

import { BaseAIService } from '../BaseAIService';
import { createLogger } from '../core/config';
import { LoreRAGService } from '../retrieval/LoreRAGService';
import type {
	StoryEntry,
	Character,
	Location,
	Item,
	Entry,
} from '$lib/types';

const log = createLogger('Compaction');

// ── Types ──

export interface CompactionDiff {
	added: string[];
	removed: string[];
	unchanged: string[];
}

export interface CompactionResult {
	proposedLore: string;
	diff: CompactionDiff;
	canonicalGrounding: string; // RAG context block used (for transparency)
}

export type CompactionMode = 'full' | 'incremental';

// ── Prompts ──

const SYSTEM_PROMPT = `You are a world-state archivist for an interactive fiction engine.
Your task is to synthesize a concise, accurate World State block from recent story events and world entity data.

Rules:
- Write in present tense, third person
- 300-600 words total
- Cover four sections: ## World State, ## Characters, ## Locations, ## Active Threads
- Be specific and factual — no vague generalities
- Ground character/location facts in the canonical lore provided
- Capture what has CHANGED, not just static descriptions
- Active Threads = unresolved plot hooks, ongoing tensions, outstanding quests
- Do NOT invent details not supported by the story entries or entity data
- Output ONLY the lore block, no preamble or explanation`;

// ── Service ──

export class CompactionService extends BaseAIService {
	private readonly loreRAG = new LoreRAGService();

	constructor() {
		super('compaction');
	}

	/**
	 * Compact the current world state into a lore block.
	 *
	 * @param entries      Recent story entries (caller should pass last 30)
	 * @param currentLore  The existing compacted lore (for incremental mode + diff)
	 * @param characters   Active characters in the story
	 * @param locations    Known locations
	 * @param items        Inventory items
	 * @param lorebookEntries  Lorebook/Entry records
	 * @param mode         'full' = rewrite from scratch | 'incremental' = update existing
	 */
	async compact(
		entries: StoryEntry[],
		currentLore: string | null,
		characters: Character[],
		locations: Location[],
		items: Item[],
		lorebookEntries: Entry[],
		mode: CompactionMode = 'full',
	): Promise<CompactionResult> {
		log('compact', { mode, entryCount: entries.length, hasCurrentLore: !!currentLore });

		// ── Step 1: Build entity summary ──
		const entitySummary = this.buildEntitySummary(characters, locations, items, lorebookEntries);

		// ── Step 2: RAG — query Qdrant for canonical lore grounding ──
		let canonicalGrounding = '';
		try {
			canonicalGrounding = await this.fetchCanonicalGrounding(characters, locations);
		} catch (e) {
			log('compact', `RAG query failed (non-fatal): ${e}`);
		}

		// ── Step 3: Build the prompt ──
		const prompt = this.buildCompactionPrompt(
			entries,
			currentLore,
			entitySummary,
			canonicalGrounding,
			mode,
		);

		// ── Step 4: Generate ──
		const proposedLore = await this.generateText(SYSTEM_PROMPT, prompt);
		const cleanedLore = proposedLore.trim();

		// ── Step 5: Compute diff ──
		const diff = this.computeDiff(currentLore ?? '', cleanedLore);

		log('compact', {
			words: cleanedLore.split(/\s+/).length,
			added: diff.added.length,
			removed: diff.removed.length,
			unchanged: diff.unchanged.length,
		});

		return { proposedLore: cleanedLore, diff, canonicalGrounding };
	}

	// ── Private helpers ──

	/**
	 * Query Qdrant for canonical facts about characters and locations
	 * mentioned in the current story entities.
	 */
	private async fetchCanonicalGrounding(
		characters: Character[],
		locations: Location[],
	): Promise<string> {
		// Build query from entity names (active characters + current location)
		const activeChars = characters
			.filter(c => c.status === 'active')
			.slice(0, 8)
			.map(c => c.name);
		const currentLoc = locations.find(l => l.current);

		const queryTerms = [
			...activeChars,
			...(currentLoc ? [currentLoc.name] : []),
		].filter(Boolean);

		if (queryTerms.length === 0) return '';

		const queries = queryTerms.slice(0, 4); // cap at 4 to avoid rate limits
		const result = await this.loreRAG.retrieveMulti(queries, {
			maxTotalChunks: 6,
		});

		return result.contextBlock;
	}

	/**
	 * Format entity data as a structured summary for the LLM.
	 */
	private buildEntitySummary(
		characters: Character[],
		locations: Location[],
		items: Item[],
		lorebookEntries: Entry[],
	): string {
		let s = '';

		// Characters
		const activeChars = characters.filter(c => c.status === 'active');
		if (activeChars.length > 0) {
			s += '### Active Characters\n';
			for (const c of activeChars) {
				s += `- **${c.name}** (${c.relationship ?? 'unknown'}): ${c.description ?? 'No description'}`;
				if (c.traits.length > 0) s += ` [${c.traits.join(', ')}]`;
				s += '\n';
			}
		}

		const deceasedChars = characters.filter(c => c.status === 'deceased');
		if (deceasedChars.length > 0) {
			s += '### Deceased Characters\n';
			for (const c of deceasedChars) {
				s += `- **${c.name}**: ${c.description ?? 'No description'}\n`;
			}
		}

		// Locations
		const visitedLocs = locations.filter(l => l.visited || l.current);
		if (visitedLocs.length > 0) {
			s += '\n### Known Locations\n';
			for (const l of visitedLocs) {
				const marker = l.current ? ' ← CURRENT' : '';
				s += `- **${l.name}**${marker}: ${l.description ?? 'No description'}\n`;
			}
		}

		// Inventory
		const equippedItems = items.filter(i => i.equipped);
		const carriedItems = items.filter(i => !i.equipped && i.location === 'inventory');
		if (equippedItems.length > 0 || carriedItems.length > 0) {
			s += '\n### Inventory\n';
			for (const i of equippedItems) {
				s += `- **${i.name}** (equipped, ×${i.quantity}): ${i.description ?? ''}\n`;
			}
			for (const i of carriedItems) {
				s += `- ${i.name} (×${i.quantity}): ${i.description ?? ''}\n`;
			}
		}

		// Key lorebook entries (inject_always ones are highest priority)
		const alwaysEntries = lorebookEntries.filter(e => e.injection.mode === 'always').slice(0, 10);
		if (alwaysEntries.length > 0) {
			s += '\n### Key Lore Entries\n';
			for (const e of alwaysEntries) {
				s += `- **${e.name}** (${e.type}): ${e.description.slice(0, 200)}${e.description.length > 200 ? '...' : ''}\n`;
			}
		}

		return s.trim();
	}

	/**
	 * Build the user prompt for compaction.
	 */
	private buildCompactionPrompt(
		entries: StoryEntry[],
		currentLore: string | null,
		entitySummary: string,
		canonicalGrounding: string,
		mode: CompactionMode,
	): string {
		// Take last 30 entries
		const recentEntries = entries.slice(-30);
		const storyLog = recentEntries
			.map(e => {
				const prefix = e.type === 'user_action' ? '> Player: ' : '  Narrator: ';
				return prefix + e.content.slice(0, 500);
			})
			.join('\n');

		let prompt = '';

		if (currentLore && mode === 'incremental') {
			prompt += `## Existing World State\n${currentLore}\n\n`;
			prompt += `## Task\nUpdate the world state block above to reflect the recent story events. Preserve accurate information, remove outdated facts, add new developments.\n\n`;
		} else {
			prompt += `## Task\nWrite a fresh World State block capturing the current narrative situation.\n\n`;
		}

		if (entitySummary) {
			prompt += `## Current World Entities\n${entitySummary}\n\n`;
		}

		if (canonicalGrounding) {
			prompt += `## Canonical Lore Reference (from world database)\n${canonicalGrounding}\n\n`;
		}

		prompt += `## Recent Story (last ${recentEntries.length} entries)\n${storyLog}\n\n`;
		prompt += `Now write the World State block (300-600 words, four sections: ## World State, ## Characters, ## Locations, ## Active Threads):`;

		return prompt;
	}

	/**
	 * Compute a line-level diff between old and new lore.
	 * Returns added, removed, and unchanged line arrays.
	 */
	computeDiff(oldLore: string, newLore: string): CompactionDiff {
		const oldLines = oldLore ? oldLore.split('\n').filter(l => l.trim()) : [];
		const newLines = newLore ? newLore.split('\n').filter(l => l.trim()) : [];

		const oldSet = new Set(oldLines.map(l => l.trim()));
		const newSet = new Set(newLines.map(l => l.trim()));

		const added = newLines.filter(l => !oldSet.has(l.trim()));
		const removed = oldLines.filter(l => !newSet.has(l.trim()));
		const unchanged = newLines.filter(l => oldSet.has(l.trim()));

		return { added, removed, unchanged };
	}
}
