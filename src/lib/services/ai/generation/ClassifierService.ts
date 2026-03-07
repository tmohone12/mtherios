/**
 * ClassifierService — Mtherios
 * 
 * Extracts world state changes from narrative text:
 * new/updated characters, locations, items, story beats.
 * Runs after each narration to keep world state in sync.
 */

import { BaseAIService } from '../BaseAIService';
import { classificationResultSchema, type ClassificationResult } from '../sdk/schemas/classifier';
import { createLogger } from '../core/config';
import type { Character, Location, Item, StoryEntry } from '$lib/types';

const log = createLogger('Classifier');

export class ClassifierService extends BaseAIService {
	constructor() {
		super('classifier');
	}

	async classify(
		narrative: string,
		recentEntries: StoryEntry[],
		existingCharacters: Character[],
		existingLocations: Location[],
		existingItems: Item[],
		mode: string = 'adventure',
		pov: string = 'second',
		tense: string = 'present',
	): Promise<ClassificationResult> {
		log('classify', { narrativeLen: narrative.length, charCount: existingCharacters.length });

		const charList = existingCharacters.map(c => `- ${c.name} (${c.relationship}, ${c.status})`).join('\n');
		const locList = existingLocations.map(l => `- ${l.name}${l.current ? ' [current]' : ''}`).join('\n');
		const itemList = existingItems.map(i => `- ${i.name}${i.equipped ? ' [equipped]' : ''}`).join('\n');
		const recentContext = recentEntries.slice(-3).map(e => `[${e.type}]: ${e.content}`).join('\n\n');

		const system = `You are a world state classifier for a ${mode} story (${pov} person, ${tense} tense).

Analyze the latest narrative and extract ALL world state changes. Be thorough — capture every character mentioned, location visited, and item encountered.

EXISTING WORLD STATE:
Characters:
${charList || '(none)'}

Locations:
${locList || '(none)'}

Items:
${itemList || '(none)'}

RULES:
- For NEW characters not in the existing list, include them with full details
- For EXISTING characters, only include them if their state changed (status, relationship, etc.)
- Mark the current location as current: true
- Track item acquisition, loss, equipping
- Identify significant story beats (plot points, revelations, decisions)
- If a character dies or leaves, update their status

Respond with a JSON object matching this schema:
{
  "characters": [{ "name": string, "description": string|null, "relationship": string|null, "status": "active"|"inactive"|"deceased"|"unknown", "traits": string[] }],
  "locations": [{ "name": string, "description": string|null, "current": boolean }],
  "items": [{ "name": string, "description": string|null, "quantity": number, "equipped": boolean, "location": string }],
  "storyBeats": [{ "title": string, "description": string, "significance": "minor"|"moderate"|"major"|"critical" }],
  "mood": string,
  "timeProgression": string
}`;

		const prompt = `RECENT CONTEXT:
${recentContext}

LATEST NARRATIVE:
${narrative}

Extract all world state changes:`;

		return this.generateStructured(classificationResultSchema, system, prompt);
	}
}
