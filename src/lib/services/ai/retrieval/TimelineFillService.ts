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

		const system = `You analyze recent story content and identify NEW world elements (characters, locations, items, factions, concepts, events) that were mentioned but are not yet in the lorebook.

EXISTING LOREBOOK ENTRIES (do not duplicate these):
${existingNames || '(empty)'}

Generate up to ${maxNew} new entries for elements that appeared in the narrative. Each entry needs:
- A clear name
- A description based on what was revealed in the story
- Keywords for future retrieval
- The entry type

Only create entries for SIGNIFICANT elements worth tracking. Skip trivial mentions.

Respond with JSON: { "entries": [{ "type": "character"|"location"|"item"|"faction"|"concept"|"event", "name": string, "description": string, "keywords": string[], "relevance": string }] }`;

		return this.generateStructured(timelineFillResultSchema, system, `Recent story:\n${recentText}`);
	}
}
