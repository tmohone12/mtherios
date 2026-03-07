/**
 * SuggestionsService — Mtherios
 * 
 * Generates contextual action suggestions for the player
 * based on the current narrative state.
 */

import { BaseAIService } from '../BaseAIService';
import { suggestionsResultSchema, type SuggestionsResult } from '../sdk/schemas/suggestions';
import type { StoryEntry, Character } from '$lib/types';

export class SuggestionsService extends BaseAIService {
	constructor() {
		super('suggestions');
	}

	async suggest(
		recentEntries: StoryEntry[],
		protagonist: Character | undefined,
		mode = 'adventure', pov = 'second',
	): Promise<SuggestionsResult> {
		const recentText = recentEntries.slice(-5).map(e => `[${e.type}]: ${e.content}`).join('\n\n');
		const protName = protagonist?.name ?? 'the protagonist';

		const system = `Generate 3-4 contextual suggestions for what ${pov === 'second' ? 'the player' : protName} could do next in this ${mode} story.
Each suggestion should be a short, actionable phrase that fits the current scene. Vary between action types (action, dialogue, thought, direction).
Make them interesting — not just "look around" but specific to the situation.

Respond with JSON: { "suggestions": [{ "text": string, "type": "action"|"dialogue"|"thought"|"direction", "brief": string }] }`;

		return this.generateStructured(suggestionsResultSchema, system, `Recent story:\n${recentText}`);
	}
}
