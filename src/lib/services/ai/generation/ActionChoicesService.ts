/**
 * ActionChoicesService — Mtherios
 * 
 * Generates meaningful branching choices for the player at key decision points.
 * Different from suggestions — these represent significant narrative forks.
 */

import { BaseAIService } from '../BaseAIService';
import { actionChoicesResultSchema, type ActionChoicesResult } from '../sdk/schemas/actionchoices';
import type { StoryEntry, Character, Location } from '$lib/types';

export class ActionChoicesService extends BaseAIService {
	constructor() {
		super('actionChoices');
	}

	async generateChoices(
		recentEntries: StoryEntry[],
		protagonist: Character | undefined,
		currentLocation: Location | undefined,
		mode = 'adventure',
	): Promise<ActionChoicesResult> {
		const recentText = recentEntries.slice(-5).map(e => `[${e.type}]: ${e.content}`).join('\n\n');
		const protName = protagonist?.name ?? 'the protagonist';
		const locName = currentLocation?.name ?? 'unknown location';

		const system = `Generate 2-4 meaningful action choices for ${protName} at ${locName} in this ${mode} story.
Each choice should lead to a meaningfully different outcome. Include a mix of approaches:
- bold: direct confrontation or action
- cautious: careful, measured response
- creative: unexpected or clever approach
- social: diplomatic or social solution
- investigate: gather more information

Each choice should have a risk level (low/medium/high).

Respond with JSON: { "choices": [{ "text": string, "type": "bold"|"cautious"|"creative"|"social"|"investigate", "risk": "low"|"medium"|"high", "brief": string }] }`;

		return this.generateStructured(actionChoicesResultSchema, system, `Scene:\n${recentText}`);
	}
}
