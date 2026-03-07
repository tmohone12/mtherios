/**
 * LoreManagementService — Mtherios
 * 
 * Automatically maintains the lorebook by creating, updating, merging,
 * and archiving entries based on narrative developments.
 */

import { BaseAIService } from '../BaseAIService';
import { loreManagementResultSchema, type LoreManagementResult } from '../sdk/schemas/lorebook';
import { createLogger } from '../core/config';
import type { Entry, StoryEntry } from '$lib/types';

const log = createLogger('LoreManagement');

export class LoreManagementService extends BaseAIService {
	constructor() {
		super('loreManagement');
	}

	async manage(
		recentEntries: StoryEntry[],
		existingEntries: Entry[],
		maxIterations = 5,
	): Promise<LoreManagementResult> {
		log('manage', { recentCount: recentEntries.length, existingCount: existingEntries.length });

		const recentText = recentEntries.slice(-5).map(e => `[${e.type}]: ${e.content}`).join('\n\n');
		const existingList = existingEntries.map(e =>
			`[${e.id}] ${e.name} (${e.type}): ${e.description.slice(0, 100)}...`
		).join('\n');

		const system = `You are a lorebook curator for an interactive fiction story. Analyze recent narrative and determine what lorebook changes are needed.

EXISTING ENTRIES:
${existingList || '(empty lorebook)'}

ACTIONS YOU CAN TAKE:
- create: Add a new entry for a newly introduced element
- update: Modify an existing entry with new information (provide entryId)
- merge: Combine two entries that refer to the same thing (provide entryId of target)
- archive: Mark an entry as no longer relevant (provide entryId)

Be conservative — only make changes when the narrative clearly warrants them.
Provide a reason for each change.

Respond with JSON: {
  "updates": [{ "action": "create"|"update"|"merge"|"archive", "entryId": string|null, "name": string, "type": "character"|"location"|"item"|"faction"|"concept"|"event", "description": string, "keywords": string[], "reason": string }],
  "summary": string
}`;

		return this.generateStructured(loreManagementResultSchema, system, `Recent story:\n${recentText}`);
	}
}
