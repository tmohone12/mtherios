/**
 * ActionChoicesService — Mtherios
 *
 * Generates meaningful branching choices for the player at key decision points.
 *
 * DO NOT MERGE with SuggestionsService — distinct UX surfaces:
 *   - ActionChoices: 2-4 narrative FORKS the player picks one of (modal/cards UI).
 *   - Suggestions:   3-4 terse one-turn nudges (chip UI, copy-paste into input).
 * Different schemas, different cadences, different stakes. They look similar; they're not.
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

		const system = `You generate meaningful branching choices for ${protName} at ${locName} in a ${mode} interactive fiction story.

Unlike simple suggestions, these choices represent SIGNIFICANT NARRATIVE FORKS — each one should lead the story in a genuinely different direction with distinct consequences.

═══ CHOICE DESIGN PRINCIPLES ═══

1. Each choice must produce a DIFFERENT NARRATIVE OUTCOME — not just different methods to the same result
2. Choices should reflect the current dramatic tension — what's at stake RIGHT NOW?
3. Every choice should have clear potential CONSEQUENCES the player can anticipate
4. Include at least one choice the player might not have thought of on their own

═══ CHOICE TYPES ═══

• bold: Direct action or confrontation — high stakes, immediate impact, burns bridges
• cautious: Measured, careful approach — preserves options but may lose opportunity
• creative: Lateral thinking, unexpected solution — subverts expectations, unpredictable outcome
• social: Diplomacy, persuasion, deception — leverages relationships, information as currency
• investigate: Seek more information before committing — reduces uncertainty but costs time

═══ RISK LEVELS ═══

• low: Minimal danger, easily reversible, safe fallback
• medium: Some danger or commitment, partial reversibility, moderate stakes
• high: Significant danger, irreversible consequences, major stakes — could go very wrong OR very right

═══ REQUIREMENTS ═══

- Generate 2-4 choices (prefer 3)
- "text" should be 8-20 words — a clear, vivid description of the action
- "brief" should be 2-5 words for a card label
- At least 2 different risk levels should be represented
- At least 2 different types should be represented
- Never include a "do nothing" or "wait and see" choice unless inaction has meaningful consequences

═══ OUTPUT FORMAT ═══

Respond with JSON:
{ "choices": [{ "text": string, "type": "bold"|"cautious"|"creative"|"social"|"investigate", "risk": "low"|"medium"|"high", "brief": string }] }`;

		return this.generateStructured(actionChoicesResultSchema, system, `Scene:\n${recentText}`);
	}
}
