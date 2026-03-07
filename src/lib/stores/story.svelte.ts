/**
 * Story Store — Mtherios
 * Manages the active story: entries, characters, locations, items, lorebook.
 */

import {
	getStory, getStoryEntries, getCharacters, getLocations, getItems,
	getLorebookEntries, createStoryEntry, createCharacter,
	updateStory, updateCharacter,
} from '$lib/services/database';
import type { Story, StoryEntry, Character, Location, Item, Entry } from '$lib/types';

class StoryStore {
	currentStory = $state<Story | null>(null);
	entries = $state<StoryEntry[]>([]);
	characters = $state<Character[]>([]);
	locations = $state<Location[]>([]);
	items = $state<Item[]>([]);
	lorebookEntries = $state<Entry[]>([]);
	loading = $state(false);

	// ── Derived ──
	get storyMode() { return this.currentStory?.mode ?? 'adventure'; }
	get pov() { return this.currentStory?.settings?.pov ?? 'second'; }
	get tense() { return this.currentStory?.settings?.tense ?? 'present'; }
	get protagonist(): Character | undefined {
		return this.characters.find(c => c.relationship === 'self');
	}

	async loadStory(storyId: string) {
		this.loading = true;
		try {
			const s = await getStory(storyId);
			if (!s) throw new Error('Story not found');
			this.currentStory = s;
			this.entries = await getStoryEntries(storyId);
			this.characters = await getCharacters(storyId);
			this.locations = await getLocations(storyId);
			this.items = await getItems(storyId);
			this.lorebookEntries = await getLorebookEntries(storyId);
		} finally {
			this.loading = false;
		}
	}

	async addEntry(type: StoryEntry['type'], content: string, reasoning?: string): Promise<StoryEntry> {
		if (!this.currentStory) throw new Error('No story loaded');
		const entry: StoryEntry = {
			id: crypto.randomUUID(),
			storyId: this.currentStory.id,
			type,
			content,
			parentId: null,
			position: this.entries.length,
			createdAt: Date.now(),
			metadata: null,
			branchId: this.currentStory.currentBranchId ?? null,
			reasoning,
		};
		await createStoryEntry(entry);
		this.entries = [...this.entries, entry];
		await updateStory(this.currentStory.id, { updatedAt: Date.now() });
		return entry;
	}

	async addCharacter(name: string, description?: string, relationship?: string): Promise<Character> {
		if (!this.currentStory) throw new Error('No story loaded');
		const char: Character = {
			id: crypto.randomUUID(),
			storyId: this.currentStory.id,
			branchId: this.currentStory.currentBranchId ?? null,
			name,
			description: description ?? null,
			traits: [],
			relationship: relationship ?? 'neutral',
			status: 'active',
			metadata: null,
			visualDescriptors: {},
			portrait: null,
		};
		await createCharacter(char);
		this.characters = [...this.characters, char];
		return char;
	}

	/**
	 * Build the system prompt for narrative generation.
	 * This is the core context that goes to the AI.
	 */
	buildSystemPrompt(): string {
		const s = this.currentStory;
		if (!s) return '';

		const mode = s.mode ?? 'adventure';
		const pov = s.settings?.pov ?? 'second';
		const tense = s.settings?.tense ?? 'present';
		const protagonist = this.protagonist;
		const tenseWord = tense === 'past' ? 'past' : 'present';

		let prompt = '';

		// ── Core narrator instructions ──
		if (mode === 'adventure') {
			if (pov === 'third') {
				const name = protagonist?.name ?? 'the protagonist';
				prompt += `You are the narrator of an interactive adventure. Write in ${tenseWord} tense, third person.\n\n`;
				prompt += `The protagonist is ${name}. ${protagonist?.description ?? ''}\n`;
				prompt += `Your role:\n- Describe ${name}'s experiences and the world around them\n`;
				prompt += `- Control all NPCs and the environment\n`;
				prompt += `- NEVER write ${name}'s dialogue, decisions, or inner thoughts — the player decides those\n`;
				prompt += `- When the player says "I do X", describe the results in third person\n`;
			} else {
				prompt += `You are the narrator of an interactive adventure. Write in ${tenseWord} tense, second person (you/your).\n\n`;
				if (protagonist) prompt += `The protagonist is ${protagonist.name}. ${protagonist.description ?? ''}\n`;
				prompt += `Your role:\n- Describe what the player sees, hears, and experiences\n`;
				prompt += `- Control all NPCs and the environment\n`;
				prompt += `- NEVER write the player's dialogue, decisions, or inner thoughts\n`;
			}
		} else {
			prompt += `You are a skilled fiction writer. Write in ${tenseWord} tense, ${pov} person.\n\n`;
			if (protagonist) prompt += `The main character is ${protagonist.name}. ${protagonist.description ?? ''}\n`;
			prompt += `Write prose based on the author's directions. Bring scenes to life with vivid detail.\n`;
		}

		// ── Genre & setting ──
		if (s.genre) prompt += `\nGenre: ${s.genre}\n`;
		if (s.description) prompt += `\nSetting: ${s.description}\n`;

		// ── World state ──
		const activeChars = this.characters.filter(c => c.status === 'active' && c.relationship !== 'self');
		if (activeChars.length > 0) {
			prompt += `\n## Known Characters\n`;
			for (const c of activeChars) {
				prompt += `- **${c.name}**: ${c.description ?? 'No description'}${c.relationship ? ` (${c.relationship})` : ''}\n`;
			}
		}

		const locs = this.locations.filter(l => l.name);
		if (locs.length > 0) {
			prompt += `\n## Known Locations\n`;
			for (const l of locs) {
				prompt += `- **${l.name}**: ${l.description ?? ''}\n`;
			}
		}

		// ── Lorebook injection ──
		const activeLore = this.lorebookEntries.filter(e => {
			if (e.injection.mode === 'always') return true;
			if (e.injection.mode === 'never') return false;
			// Keyword matching against recent entries
			const recentText = this.entries.slice(-5).map(en => en.content).join(' ').toLowerCase();
			return e.injection.keywords.some(kw => recentText.includes(kw.toLowerCase()));
		});

		if (activeLore.length > 0) {
			prompt += `\n## World Lore\n`;
			for (const entry of activeLore) {
				prompt += `### ${entry.name}\n${entry.description}\n`;
				if (entry.hiddenInfo) prompt += `[Hidden: ${entry.hiddenInfo}]\n`;
			}
		}

		// ── Style guidance ──
		prompt += `\n## Guidelines\n`;
		prompt += `- Write 2-4 paragraphs per response\n`;
		prompt += `- Use vivid sensory details\n`;
		prompt += `- End with a moment that invites the next action\n`;
		prompt += `- Stay consistent with established world facts\n`;
		if (mode === 'adventure') {
			prompt += `- Present interesting choices through the environment and NPCs\n`;
			prompt += `- Auto-create new characters when the narrative naturally introduces them\n`;
		}

		return prompt;
	}

	/**
	 * Build the user prompt from recent entries + current action.
	 */
	buildUserPrompt(currentAction: string): string {
		const mode = this.storyMode;
		const recentEntries = this.entries.slice(-10);
		const historyParts: string[] = [];

		for (const entry of recentEntries) {
			if (entry.type === 'user_action') {
				const prefix = mode === 'creative-writing' ? '[DIRECTION]' : '[ACTION]';
				historyParts.push(`${prefix} ${entry.content}`);
			} else if (entry.type === 'narration') {
				historyParts.push(`[NARRATIVE]\n${entry.content}`);
			}
		}

		let prompt = '';
		if (historyParts.length > 0) {
			prompt += '## Recent Story:\n';
			prompt += historyParts.join('\n\n');
			prompt += '\n\n';
		}

		prompt += '## Current Action:\n';
		prompt += currentAction;
		prompt += '\n\nContinue the narrative:';

		return prompt;
	}

	clear() {
		this.currentStory = null;
		this.entries = [];
		this.characters = [];
		this.locations = [];
		this.items = [];
		this.lorebookEntries = [];
	}
}

export const story = new StoryStore();
