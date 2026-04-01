/**
 * TimelineFillService — Mtherios
 * 
 * Automatically generates new lorebook entries based on narrative content
 * that introduces new world elements not yet tracked.
 */

import { BaseAIService } from '../BaseAIService';
import { timelineFillResultSchema, type TimelineFillResult } from '../sdk/schemas/timeline';
import type { Entry, StoryEntry } from '$lib/types';

export class TimelineFillService extends BaseAIService {
	constructor() {
		super('timelineFill');
	}

	async fill(
		recentEntries: StoryEntry[],
		existingEntries: Entry[],
		maxNew = 5,
	): Promise<TimelineFillResult> {
		const recentText = recentEntries.slice(-5).map(e => `[${e.type}]: ${e.content}`).join('\n\n');
		const existingNames = existingEntries.map(e => e.name).join(', ');

		const system = `You identify NEW world elements in recent story content that should be added to the lorebook for future continuity tracking.

═══ EXISTING LOREBOOK ENTRIES (do NOT duplicate) ═══
${existingNames || '(none yet)'}

═══ WHAT TO EXTRACT ═══

Scan the narrative for elements that were INTRODUCED or SIGNIFICANTLY DESCRIBED for the first time:

• character: Named NPCs who spoke, acted, or were described in detail (not unnamed crowd members)
• location: Named places that were visited, described, or are clearly important to the plot
• item: Named objects with narrative significance (weapons, artifacts, documents — not generic "a sword")
• faction: Organizations, groups, guilds, armies that were named and described
• concept: Magic systems, customs, laws, religions, or world mechanics that were explained
• event: Historical events, prophecies, or significant past occurrences that were referenced

═══ WHAT TO SKIP ═══

- Unnamed, generic elements ("a guard", "the tavern", "some coins")
- Elements already in the existing lorebook (even if more was revealed — that's an UPDATE, not a new entry)
- Trivial mentions that won't matter for future story continuity
- The protagonist (already tracked separately)

═══ DESCRIPTION GUIDELINES ═══

- Write descriptions based ONLY on what was revealed in the narrative — do not invent details
- Include relationships to other known elements where relevant
- Keep descriptions to 2-4 sentences
- Keywords should include the name, aliases, and 3-5 related terms for retrieval

═══ OUTPUT FORMAT ═══

Generate up to ${maxNew} entries. If nothing new warrants tracking, return an empty array.

Respond with JSON:
{ "entries": [{ "type": "character"|"location"|"item"|"faction"|"concept"|"event", "name": string, "description": string, "keywords": string[], "relevance": string }] }

- relevance: Why this element is worth tracking (1 sentence)`;

		return this.generateStructured(timelineFillResultSchema, system, `Recent story:\n${recentText}`);
	}
}
