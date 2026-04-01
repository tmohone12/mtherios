/**
 * LoreManagementService — Mtherios
 *
 * Unified lorebook maintenance: discovers new entries AND curates existing
 * ones (update, merge, archive) from chapter summaries and arc data.
 * Replaces the old split between TimelineFill (create-only) and LoreManagement.
 */

import { BaseAIService } from '../BaseAIService';
import { loreManagementResultSchema, type LoreManagementResult } from '../sdk/schemas/lorebook';
import { createLogger } from '../core/config';
import type { Entry, Chapter, Arc, CharacterEntryState } from '$lib/types';

const log = createLogger('LoreManagement');

/** Lore management runs every N chapters */
export const LORE_MGMT_CHAPTER_INTERVAL = 5;

export class LoreManagementService extends BaseAIService {
	constructor() {
		super('loreManagement');
	}

	/**
	 * Discover AND curate lorebook entries from chapter summaries and arc data.
	 * Runs every LORE_MGMT_CHAPTER_INTERVAL chapters — uses condensed
	 * summaries instead of raw entries so the model can reason over the
	 * full story arc without token pressure.
	 *
	 * This single call handles both discovery of new entries (previously
	 * TimelineFill's job) and curation of existing ones.
	 */
	async manage(
		chapters: Chapter[],
		arcs: Arc[],
		existingEntries: Entry[],
	): Promise<LoreManagementResult> {
		log('manage', { chapters: chapters.length, arcs: arcs.length, existingCount: existingEntries.length });

		// Build condensed story context from arcs + recent chapters
		let storyContext = '';

		if (arcs.length > 0) {
			storyContext += '═══ STORY ARCS ═══\n';
			for (const arc of arcs) {
				storyContext += `\nArc ${arc.arcNumber}: ${arc.title} (Ch.${arc.chapterRange})\n`;
				storyContext += `${arc.summary}\n`;
				if (arc.unresolvedThreads.length > 0) {
					storyContext += `Open threads: ${arc.unresolvedThreads.join('; ')}\n`;
				}
			}
		}

		// Chapters not yet in an arc
		const coveredChapterIds = new Set(arcs.flatMap(a => a.chapterIds));
		const uncoveredChapters = chapters.filter(c => !coveredChapterIds.has(c.id));

		if (uncoveredChapters.length > 0) {
			storyContext += '\n═══ RECENT CHAPTERS ═══\n';
			for (const ch of uncoveredChapters) {
				storyContext += `\nChapter ${ch.number}: ${ch.title ?? 'Untitled'}\n${ch.summary}\n`;
				if (ch.characters.length > 0) storyContext += `Characters: ${ch.characters.join(', ')}\n`;
				if (ch.locations.length > 0) storyContext += `Locations: ${ch.locations.join(', ')}\n`;
				if (ch.emotionalTone) storyContext += `Tone: ${ch.emotionalTone}\n`;
			}
		}

		const existingList = existingEntries.map(e => {
			let line = `[${e.id}] ${e.name} (${e.type}): ${e.description.slice(0, 150)}...`;
			if (e.type === 'character') {
				const cs = e.state as CharacterEntryState;
				if (cs?.bio) line += ` [Bio exists]`;
				if (cs?.motivations?.length) line += ` [Motivations: ${cs.motivations.join('; ')}]`;
				if (cs?.personality) line += ` [Personality exists]`;
			}
			return line;
		}).join('\n');

		const system = `You are a lorebook curator for an interactive fiction story. You maintain the world's knowledge base by analyzing CHAPTER SUMMARIES and ARC SUMMARIES — condensed, verified accounts of what happened in the story.

Your job has two parts: DISCOVER new entries worth tracking, and CURATE existing ones.

═══ EXISTING LOREBOOK ═══
${existingList || '(empty lorebook)'}

═══ AVAILABLE ACTIONS ═══

• create: Add a new entry for a world element that appears in the story but is NOT yet tracked
  - Named characters who spoke, acted, or were described in detail (not unnamed crowd members)
  - Named places that were visited, described, or are clearly important to the plot
  - Named objects with narrative significance (weapons, artifacts, documents — not generic "a sword")
  - Organizations, groups, guilds, armies that were named and described
  - Magic systems, customs, laws, religions, or world mechanics that were explained
  - Historical events, prophecies, or significant past occurrences that were referenced
  - Do NOT duplicate anything already in the existing lorebook
  - Write descriptions based ONLY on what was established in the summaries
  - Include 3-5 retrieval keywords (name, aliases, related terms)

• update: Modify an existing entry with NEW information established in the chapter summaries
  - Only when summaries CONFIRM new facts (not speculation from a single scene)
  - Provide: entryId, updated description that APPENDS to existing info (do not erase what's already there)
  - Provide: updated keywords if new searchable terms were introduced

• For CHARACTER entries: also produce these fields when you have enough evidence (2+ chapters of presence):
  - bio: 2-4 sentence biography — who they are, their background, their role. Only confirmed facts from summaries.
  - motivations: 1-4 driving goals as short phrases (e.g., "Avenge his family", "Earn passage across the sea")
  - personality: 1-2 sentence personality sketch from observed behavior patterns
  - Include these ONLY for character type entries. Omit for other types.
  - On first enrichment, write fresh. On subsequent updates, revise based on new evidence.

• merge: Combine two entries that clearly refer to the SAME entity (e.g., "The Stranger" revealed to be "Lord Kael")
  - Provide: entryId of the entry to KEEP (the target), and name of the entry to merge INTO it
  - Only merge when confirmed across chapter summaries

• archive: Mark an entry as no longer relevant to the active story
  - Only for elements that have been permanently destroyed, resolved, or left the story
  - Do NOT archive entries just because they haven't appeared recently

═══ GUIDELINES ═══

1. DISCOVER aggressively, CURATE conservatively — missing a new entry is worse than having an extra one,
   but wrong updates to existing entries are worse than missed updates
2. Never invent information not present in the chapter/arc summaries
3. For updates: cross-reference across multiple chapters before acting — single mentions are not enough
4. Descriptions should reflect ONLY what the summaries have established, not inferences
5. Skip unnamed, generic elements ("a guard", "the tavern", "some coins")
6. Skip the protagonist (tracked separately)
7. Maximum 8 changes total — prioritize the most impactful

═══ OUTPUT FORMAT ═══

Respond with JSON:
{
  "updates": [{ "action": "create"|"update"|"merge"|"archive", "entryId": string|null, "name": string, "type": "character"|"location"|"item"|"faction"|"concept"|"event", "description": string, "keywords": string[], "reason": string, "bio": string|null, "motivations": string[]|null, "personality": string|null }],
  "summary": string
}

- summary: One sentence describing what changed and why (or "No changes needed" if the array is empty)
- If no changes are warranted, return an empty updates array`;

		return this.generateStructured(loreManagementResultSchema, system, storyContext);
	}
}
