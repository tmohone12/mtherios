/**
 * SuggestionsService — Mtherios
 *
 * Generates contextual action suggestions for the player
 * based on the current narrative state.
 *
 * DO NOT MERGE with ActionChoicesService — distinct UX surfaces:
 *   - Suggestions:   3-4 terse one-turn nudges (chip UI, copy-paste into input).
 *   - ActionChoices: 2-4 narrative FORKS the player picks one of (modal/cards UI).
 * Different schemas, different cadences, different stakes. They look similar; they're not.
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

		const system = `You generate contextual action suggestions for ${pov === 'second' ? 'a player' : protName} in a ${mode} interactive fiction story.

Your suggestions should feel like natural next moves that arise organically from the current scene. Think about what a thoughtful reader would want to try.

═══ GUIDELINES ═══

- Generate exactly 3-4 suggestions
- Each must be SPECIFIC to the current scene — reference actual characters, objects, or details from the narrative
- Vary the suggestion types across these categories:
  • action: Physical actions (fight, climb, grab, run, open, search a specific thing)
  • dialogue: Speaking to a specific character about something relevant ("Ask [name] about [topic]")
  • thought: Internal reflection or analysis ("Consider why [character] seemed nervous")
  • direction: Movement or exploration ("Head toward the flickering light in the eastern corridor")
- Make suggestions escalate in boldness — include at least one safe option and one risky or surprising option
- Keep "text" to 5-12 words — punchy and specific
- "brief" is a 2-4 word label for display as a chip/button

═══ BAD SUGGESTIONS (avoid these) ═══
- "Look around" (too generic)
- "Talk to someone" (who? about what?)
- "Continue forward" (meaningless without context)
- Anything that repeats what just happened

═══ OUTPUT FORMAT ═══

Respond with JSON:
{ "suggestions": [{ "text": string, "type": "action"|"dialogue"|"thought"|"direction", "brief": string }] }`;

		return this.generateStructured(suggestionsResultSchema, system, `Recent story:\n${recentText}`);
	}
}
