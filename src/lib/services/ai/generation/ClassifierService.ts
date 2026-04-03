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
import type { Character, Location, Item, StoryEntry, Entry } from '$lib/types';

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
		factionEntries: Entry[] = [],
	): Promise<ClassificationResult> {
		log('classify', { narrativeLen: narrative.length, charCount: existingCharacters.length, factionCount: factionEntries.length });

		const charList = existingCharacters.map(c => `- ${c.name} (${c.relationship}, ${c.status})`).join('\n');
		const locList = existingLocations.map(l => `- ${l.name}${l.current ? ' [current]' : ''}`).join('\n');
		const itemList = existingItems.map(i => `- ${i.name}${i.equipped ? ' [equipped]' : ''}`).join('\n');
		const factionList = factionEntries.map(f => `- ${f.name}: ${f.description.slice(0, 80)}`).join('\n');
		const recentContext = recentEntries.slice(-3).map(e => `[${e.type}]: ${e.content}`).join('\n\n');

		const system = `You are a world state classifier for a ${mode} interactive fiction story written in ${pov} person, ${tense} tense.

Your job is to read the LATEST NARRATIVE passage and extract every world state change it introduces. You must be thorough — missing a character, location, or item means the world model falls out of sync.

═══ EXISTING WORLD STATE ═══

CHARACTERS (already tracked):
${charList || '(none yet)'}

LOCATIONS (already tracked):
${locList || '(none yet)'}

ITEMS (already tracked):
${itemList || '(none yet)'}

FACTIONS (tracked):
${factionList || '(none)'}

═══ EXTRACTION RULES ═══

CHARACTERS:
- For NEW characters (not in the list above): provide name, description (appearance + role), relationship to protagonist, status, and personality traits
- For EXISTING characters: ONLY include if something CONCRETELY changed — new status, changed relationship, revealed trait, death, or explicit departure
- CRITICAL: Do NOT include existing characters whose state is UNCHANGED. If a character speaks or acts but their name, description, relationship, status, and traits are all the same as listed above, OMIT them entirely. An empty characters array is correct when nothing changed.
- Status values:
  - "active" = present and participating in the scene (DEFAULT — use when unsure)
  - "departed" = ONLY when the narrative EXPLICITLY describes the character physically leaving the current location
  - "inactive" = off-screen, unconscious, imprisoned, etc.
  - "deceased" = dead
- DEPARTURES — STRICT RULES:
  Set "departed" ONLY when the narrative explicitly describes a character physically leaving:
    - They walk/run/teleport/fly OUT of the location
    - They are carried, dragged, or taken away
    - They explicitly say goodbye and leave
  Do NOT set "departed" when:
    - A character is simply not mentioned in this passage (they may still be present)
    - The scene shifts to a different location (that's a LOCATION change, not a departure)
    - A character is in the background or silent (they're still "active")
    - You're unsure whether they left (default to "active")
  When in doubt, do NOT mark departed. False departures break the world model.
- ${pov === 'second' ? 'The "you" character is the protagonist — do not list them as a new character' : 'Track the POV character separately'}

LOCATIONS:
- Set current: true for the location where the scene ENDS (only one location can be current)
- Include new locations with vivid, concise descriptions drawn from the narrative
- For existing locations, only include if the narrative reveals new details about them

ITEMS:
- Track items that are GAINED, LOST, EQUIPPED, UNEQUIPPED, USED, or DISCOVERED
- Set equipped: true if the protagonist is actively wielding/wearing the item
- Include the location where the item currently is (character name if held, location name if placed)
- Do not list items that were merely mentioned in passing without changing hands

STORY BEATS:
- Capture significant plot developments: revelations, decisions, confrontations, discoveries, relationship shifts
- minor: flavor moments, small observations
- moderate: meaningful character interactions, minor plot developments
- major: key plot turns, important discoveries, relationship changes
- critical: life-or-death moments, major revelations, irreversible decisions

MOOD: A 2-4 word description of the scene's emotional atmosphere (e.g., "tense anticipation", "quiet melancholy")

TIME PROGRESSION: Estimate how much story-time passed ("moments", "a few minutes", "several hours", "a full day", "unknown")

RELATIONSHIPS:
- When entities interact in a way that establishes or changes a relationship, note it
- Types: member-of, leader-of, allied-with, enemy-of, located-in, part-of, created-by, knows-about, owns, serves, related-to
- Only include relationships NEWLY ESTABLISHED or CHANGED in this passage
- bidirectional: true for symmetric relationships (allied-with, enemy-of)
- strength: 0-100 (how strong/certain the relationship is)

LOCATION CONNECTIONS:
- When the narrative mentions paths, doors, roads, passages, or travel between locations, note the connection
- Include direction (north/south/east/west/up/down/through) if mentioned, and estimated travel time in minutes
- Only include connections NEWLY REVEALED in this passage

CONVERSATIONS:
- When the protagonist SPEAKS with an NPC and meaningful information is exchanged, track it
- playerRevealed: specific facts the player told the NPC
- npcLearned: what the NPC now knows that they didn't before
- emotionalShift: how the conversation changed the NPC's attitude (null if unchanged)
- importance: trivial (small talk), minor (info exchange), significant (secrets revealed), critical (alliance/betrayal)
- Only track conversations where MEANINGFUL information was exchanged

FACTION SIGNALS — CONSERVATIVE:
- Default to EMPTY array []. The vast majority of passages affect zero factions.
- Only signal factions from the FACTIONS list above — never invent factions.
- If no factions are listed above, ALWAYS return an empty factionSignals array.
- Only signal when the narrative contains a DIRECT, CONCRETE event that a specific faction would verifiably care about.
- Do NOT signal based on vague atmosphere, mood, or speculative implications.
- trigger types:
  - "threatened" = something directly endangers the faction's territory, members, or goals
  - "opportunity" = events create a clear opening the faction could exploit
  - "informed" = the faction would learn about this through spies, ravens, or witnesses
  - "provoked" = direct insult, attack, or betrayal against the faction
  - "weakened" = the faction lost resources, allies, or a key member
- context: 1 sentence explaining WHY this faction cares (required, not empty)
- urgency: low (background awareness), medium (will want to act soon), high (demands immediate reaction)

═══ OUTPUT FORMAT ═══

Respond with a JSON object using EXACTLY these field names:

{
  "characters": [{ "name": "...", "description": "...", "relationship": "...", "status": "active"|"inactive"|"departed"|"deceased", "traits": ["..."] }],
  "locations": [{ "name": "...", "description": "...", "current": true|false, "region": "...", "terrain": "...", "connections": [{ "targetName": "...", "direction": "...", "travelTimeMinutes": 5, "description": "..." }] }],
  "items": [{ "name": "...", "description": "...", "quantity": 1, "equipped": false, "location": "..." }],
  "storyBeats": [{ "title": "...", "description": "...", "significance": "minor"|"moderate"|"major"|"critical" }],
  "relationships": [{ "sourceName": "...", "targetName": "...", "type": "allied-with", "label": "...", "strength": 50, "bidirectional": true }],
  "conversations": [{ "npcName": "...", "topicSummary": "...", "playerRevealed": ["..."], "npcLearned": ["..."], "emotionalShift": null, "importance": "minor" }],
  "factionSignals": [{ "factionName": "...", "trigger": "informed", "context": "...", "urgency": "low" }],
  "mood": "...",
  "timeProgression": "..."
}

Use EMPTY arrays [] for categories with no changes. Never hallucinate elements not in the text.`;

		const prompt = `RECENT CONTEXT:
${recentContext}

LATEST NARRATIVE:
${narrative}

Extract all world state changes:`;

		return this.generateStructured(classificationResultSchema, system, prompt);
	}
}
