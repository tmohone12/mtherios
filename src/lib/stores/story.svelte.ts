/**
 * Story Store — Mtherios
 * Manages the active story: entries, characters, locations, items, lorebook.
 */

import {
	getStory, getStoryEntries, getCharacters, getLocations, getItems,
	getLorebookEntries, createStoryEntry, createCharacter, createLocation, createItem,
	updateStory, updateCharacter, updateLocation, updateItem,
	getEntryRelationships, getConversationMemory, getWorldEvents,
	getChapters, getStoryBeats, getArcs,
	getEmbeddedImages, createEmbeddedImage, deleteEmbeddedImage,
	createAgreement, updateAgreement, getAgreements,
	getFactionActions, getRumors,
	createWorldEvent,
} from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { countTokens } from '$lib/utils/tokens';
import type { Story, StoryEntry, Character, Location, Item, Entry, EntryRelationship, ConversationMemoryEntry, WorldEvent, FactionEntryState, EmbeddedImage, Agreement, AgreementCategory, AgreementSecrecy, FactionActionRecord, RumorRecord, Arc, Chapter, StoryBeat } from '$lib/types';
import type { WorldSimulationResult } from '$lib/services/ai/sdk/schemas/worldsim';
import type { SeasonEffect } from '$lib/services/ai/generation/WorldSimulationService';

/**
 * Structured world-state snapshot assembled before narration.
 * Replaces the old freeform string-based context block — each section
 * helper of buildSystemPrompt can pull typed data directly.
 */
/** Display-only rumor shape — matches both stored RumorRecord and fresh WorldSim output. */
export interface RumorDisplay {
	content: string;
	truthfulness: number;
	spreadRadius: 'local' | 'regional' | 'continental';
	sourceType: string;
	originRegion: string;
}

export interface StateSnapshot {
	arcs: Arc[];
	chapters: Chapter[];
	storyBeats: StoryBeat[];
	currentLocation: Location | null;
	presentCharacters: Character[];
	equippedItems: Item[];
	activeAgreements: Agreement[];
	recentWorldEvents: WorldEvent[];
	reachableRumors: RumorDisplay[];
	factionActions: FactionActionRecord[];
	worldSim: (WorldSimulationResult & { seasonEffect?: SeasonEffect }) | null;
}

function emptySnapshot(): StateSnapshot {
	return {
		arcs: [],
		chapters: [],
		storyBeats: [],
		currentLocation: null,
		presentCharacters: [],
		equippedItems: [],
		activeAgreements: [],
		recentWorldEvents: [],
		reachableRumors: [],
		factionActions: [],
		worldSim: null,
	};
}
import type { ChatMessage } from '$lib/services/ai/sdk/generate';
import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
import { settings } from '$lib/stores/settings.svelte';

class StoryStore {
	currentStory = $state<Story | null>(null);
	entries = $state<StoryEntry[]>([]);
	characters = $state<Character[]>([]);
	locations = $state<Location[]>([]);
	items = $state<Item[]>([]);
	lorebookEntries = $state<Entry[]>([]);
	entryRelationships = $state<EntryRelationship[]>([]);
	conversationMemories = $state<ConversationMemoryEntry[]>([]);
	worldEvents = $state<WorldEvent[]>([]);
	agreements = $state<Agreement[]>([]);
	factionActions = $state<FactionActionRecord[]>([]);
	rumors = $state<RumorRecord[]>([]);
	images = $state<EmbeddedImage[]>([]);
	loading = $state(false);
	private _entryLock: Promise<void> = Promise.resolve();
	lastWorldSimResult = $state<import('$lib/services/ai/sdk/schemas/worldsim').WorldSimulationResult & { seasonEffect?: import('$lib/services/ai/generation/WorldSimulationService').SeasonEffect } | null>(null);
	/** Last known tier usage (updated each generation) */
	lastTierUsage = $state<Record<string, number> | null>(null);
	/** Last known total context tokens sent to API */
	lastContextTotal = $state<number>(0);
	/** Entry index floor for conversation history — set when a chapter is created to prevent context rot.
	 *  buildConversationMessages() won't include entries before this index. */
	chatHistoryFloor = $state<number>(0);

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
			const [entries, characters, locations, items, lorebookEntries, entryRelationships, conversationMemories, worldEvents, agreements, factionActions, rumors, images] = await Promise.all([
				getStoryEntries(storyId),
				getCharacters(storyId),
				getLocations(storyId),
				getItems(storyId),
				getLorebookEntries(storyId),
				getEntryRelationships(storyId),
				getConversationMemory(storyId),
				getWorldEvents(storyId),
				getAgreements(storyId),
				getFactionActions(storyId),
				getRumors(storyId),
				getEmbeddedImages(storyId),
			]);
			this.entries = entries;
			this.characters = characters;
			this.locations = locations;
			this.items = items;
			this.lorebookEntries = lorebookEntries;
			this.entryRelationships = entryRelationships;
			this.conversationMemories = conversationMemories;
			this.worldEvents = worldEvents;
			this.agreements = agreements;
			this.factionActions = factionActions;
			this.rumors = rumors;
			this.images = images;

			// If story has chapters, set history floor so only recent entries are in chat.
			// Older entries are summarized in chapters/arcs — sending them as raw history causes context rot.
			const chapters = await getChapters(storyId);
			if (chapters.length > 0) {
				const lastChapter = [...chapters].sort((a, b) => b.number - a.number)[0];
				const endIdx = this.entries.findIndex(e => e.id === lastChapter.endEntryId);
				if (endIdx >= 0) {
					// Floor starts after the last chapter's end, keeping at most 10 entries of raw history
					const POST_CHAPTER_HISTORY = 10;
					this.chatHistoryFloor = Math.max(endIdx + 1, this.entries.length - POST_CHAPTER_HISTORY);
				}
			} else {
				this.chatHistoryFloor = 0;
			}

			// Pre-embed lorebook + chapters in background (non-blocking)
			this.preEmbedLorebook().catch(e => console.warn('[Story] preEmbedLorebook failed:', e));
			this.preEmbedChapters().catch(e => console.warn('[Story] preEmbedChapters failed:', e));
		} finally {
			this.loading = false;
		}
	}

	/**
	 * Pre-embed all lorebook entries for semantic search.
	 * Uses content hashing — reopening a story with unchanged entries is free.
	 */
	async preEmbedLorebook(): Promise<void> {
		if (!this.currentStory || this.lorebookEntries.length === 0) return;
		const { ai } = await import('$lib/services/ai');
		const items = this.lorebookEntries.map(e => ({
			text: `${e.name}: ${e.description}`,
			sourceId: e.id,
			sourceType: 'lorebook' as const,
		}));
		await ai.embeddings.embedMany(items);
	}

	/**
	 * Pre-embed all chapter summaries for semantic retrieval.
	 */
	async preEmbedChapters(): Promise<void> {
		if (!this.currentStory) return;
		const chapters = await getChapters(this.currentStory.id);
		if (chapters.length === 0) return;
		const { ai } = await import('$lib/services/ai');
		const items = chapters.map(c => ({
			text: `${c.title ?? 'Chapter ' + c.number}: ${c.summary}`,
			sourceId: c.id,
			sourceType: 'chapter' as const,
		}));
		await ai.embeddings.embedMany(items);
	}

	async addEntry(type: StoryEntry['type'], content: string, reasoning?: string): Promise<StoryEntry> {
		if (!this.currentStory) throw new Error('No story loaded');

		// Serialize entry creation to prevent position collision from concurrent calls
		const previous = this._entryLock;
		let releaseLock!: () => void;
		this._entryLock = new Promise(r => { releaseLock = r; });
		await previous;

		try {
			const entry: StoryEntry = {
				id: uuid(),
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
		} finally {
			releaseLock();
		}
	}

	async addCharacter(name: string, description?: string, relationship?: string): Promise<Character> {
		if (!this.currentStory) throw new Error('No story loaded');
		const char: Character = {
			id: uuid(),
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

	async updateCharacterFromClassification(name: string, updates: { description?: string | null; relationship?: string | null; status?: string; traits?: string[] }) {
		const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
		if (!char) return;
		const merged: Partial<Character> = {};
		if (updates.description && updates.description !== char.description) merged.description = updates.description;
		if (updates.relationship && updates.relationship !== char.relationship) merged.relationship = updates.relationship;
		if (updates.status && updates.status !== char.status) {
			// "departed" is a transient classifier signal — persist as "active" (they're alive, just elsewhere)
			// "unknown" means the classifier couldn't determine status — keep existing status unchanged
			if (updates.status === 'unknown') {
				// Do not update — preserve current status
			} else {
				merged.status = (updates.status === 'departed' ? 'active' : updates.status) as Character['status'];
			}
		}
		if (updates.traits && updates.traits.length > 0) {
			// Merge traits, don't replace
			const newTraits = [...new Set([...char.traits, ...updates.traits])];
			if (newTraits.length !== char.traits.length) merged.traits = newTraits;
		}
		if (Object.keys(merged).length === 0) return;
		await updateCharacter(char.id, merged);
		this.characters = this.characters.map(c => c.id === char.id ? { ...c, ...merged } : c);
	}

	/**
	 * Update character presence — set lastSeenLocation for characters arriving/present,
	 * clear it for characters who departed or died.
	 */
	async updatePresence(characterNames: string[], locationName: string) {
		for (const name of characterNames) {
			const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
			if (!char) continue;
			const meta = { ...(char.metadata ?? {}), lastSeenLocation: locationName };
			await updateCharacter(char.id, { metadata: meta });
			this.characters = this.characters.map(c =>
				c.id === char.id ? { ...c, metadata: meta } : c
			);
		}
	}

	/**
	 * Clear presence for characters who departed or died — removes lastSeenLocation.
	 */
	async clearPresenceForCharacters(characterNames: string[]) {
		for (const name of characterNames) {
			const char = this.characters.find(c => c.name.toLowerCase() === name.toLowerCase());
			if (!char) continue;
			const meta = { ...(char.metadata ?? {}) };
			delete meta.lastSeenLocation;
			await updateCharacter(char.id, { metadata: meta });
			this.characters = this.characters.map(c =>
				c.id === char.id ? { ...c, metadata: meta } : c
			);
		}
	}

	async clearPresence(characterId: string) {
		const char = this.characters.find(c => c.id === characterId);
		if (!char) return;
		const meta = { ...(char.metadata ?? {}) };
		delete meta.lastSeenLocation;
		await updateCharacter(char.id, { metadata: meta });
		this.characters = this.characters.map(c =>
			c.id === characterId ? { ...c, metadata: meta } : c
		);
	}

	async addOrUpdateLocation(name: string, description?: string | null, current?: boolean): Promise<void> {
		if (!this.currentStory) return;
		const existing = this.locations.find(l => l.name.toLowerCase() === name.toLowerCase());
		if (existing) {
			const merged: Partial<Location> = {};
			if (description && description !== existing.description) merged.description = description;
			if (current !== undefined) merged.current = current;
			if (current) merged.visited = true;
			if (Object.keys(merged).length > 0) {
				await updateLocation(existing.id, merged);
				this.locations = this.locations.map(l => l.id === existing.id ? { ...l, ...merged } : l);
			}
		} else {
			const loc: Location = {
				id: uuid(),
				storyId: this.currentStory.id,
				branchId: this.currentStory.currentBranchId ?? null,
				name,
				description: description ?? null,
				visited: current ?? false,
				current: current ?? false,
				connections: [],
				metadata: null,
			};
			await createLocation(loc);
			this.locations = [...this.locations, loc];
		}
		// If a location is set to current, unset other current locations
		if (current) {
			for (const loc of this.locations) {
				if (loc.current && loc.name.toLowerCase() !== name.toLowerCase()) {
					await updateLocation(loc.id, { current: false });
				}
			}
			this.locations = this.locations.map(l => ({
				...l,
				current: l.name.toLowerCase() === name.toLowerCase()
			}));
		}
	}

	async addOrUpdateItem(name: string, description?: string | null, quantity?: number, equipped?: boolean, location?: string): Promise<void> {
		if (!this.currentStory) return;
		const existing = this.items.find(i => i.name.toLowerCase() === name.toLowerCase());
		if (existing) {
			const merged: Partial<Item> = {};
			if (description && description !== existing.description) merged.description = description;
			if (quantity !== undefined && quantity !== existing.quantity) merged.quantity = quantity;
			if (equipped !== undefined && equipped !== existing.equipped) merged.equipped = equipped;
			if (location !== undefined && location !== existing.location) merged.location = location;
			if (Object.keys(merged).length > 0) {
				await updateItem(existing.id, merged);
				this.items = this.items.map(i => i.id === existing.id ? { ...i, ...merged } : i);
			}
		} else {
			const item: Item = {
				id: uuid(),
				storyId: this.currentStory.id,
				branchId: this.currentStory.currentBranchId ?? null,
				name,
				description: description ?? null,
				quantity: quantity ?? 1,
				equipped: equipped ?? false,
				location: location ?? '',
				metadata: null,
			};
			await createItem(item);
			this.items = [...this.items, item];
		}
	}

	/**
	 * Build the full narrator system prompt.
	 *
	 * Sections, in order:
	 *   1. Header              — per-story preamble, role declaration, POV/tense
	 *   2. Instructions        — tone, style, agency, world posture, response rules
	 *   3. Tools               — what the world-update classifier will extract after narration
	 *   4. Characters          — current scene: protagonist + NPCs + equipped items + location/time/meters
	 *   5. Arcs                — condensed long-term story history
	 *   6. Chapters            — recent chapter summaries not yet condensed into arcs
	 *   7. Entry History       — brief preamble (actual turns flow as conversation messages)
	 *   8. Living World        — agreements, rumors, faction moves, world sim signals
	 *   9. Final Instructions  — closing directives + send-the-reply directive
	 *
	 * A caller that has pre-fetched a StateSnapshot (orchestrator path) passes
	 * it in so sections 4/5/6/8 can be populated. Callers using this for token
	 * estimation or previews can omit the argument.
	 */
	buildSystemPrompt(snapshot?: StateSnapshot): string {
		const s = this.currentStory;
		if (!s) return '';

		const mode = s.mode ?? 'adventure';
		const snap = snapshot ?? emptySnapshot();

		const parts: string[] = [];
		parts.push(this.#sectionHeader(s, mode));
		parts.push(this.#sectionInstructions(s, mode));
		if (mode === 'adventure') parts.push(this.#sectionTools());
		const chars = this.#sectionCharacters(s, snap);
		if (chars) parts.push(chars);
		const arcs = this.#sectionArcs(snap);
		if (arcs) parts.push(arcs);
		const chapters = this.#sectionChapters(snap);
		if (chapters) parts.push(chapters);
		parts.push(this.#sectionEntryHistoryPreamble(mode));
		const lw = this.#sectionLivingWorld(snap);
		if (lw) parts.push(lw);
		parts.push(this.#sectionFinalInstructions(mode));

		let prompt = parts.filter(Boolean).join('\n\n');

		// Resolve role tags (adventure mode only)
		if (mode === 'adventure') {
			const userName = this.protagonist?.name ?? 'the player';
			prompt = prompt
				.replace(/\{\{user\}\}/g, userName)
				.replace(/\{\{char\}\}/g, 'NPCs')
				.replace(/\{\{world\}\}/g, 'the world');
		}

		return prompt;
	}

	// ── Section 1: Header ───────────────────────────────────────────────────
	#sectionHeader(s: Story, mode: string): string {
		const pov = s.settings?.pov ?? 'second';
		const tense = s.settings?.tense ?? 'present';
		const tenseWord = tense === 'past' ? 'past' : 'present';
		const protagonist = this.protagonist;
		const parts: string[] = [];

		if (s.headerPrompt) parts.push(s.headerPrompt);
		if (s.compactedLore) parts.push(`## World State\n\n${s.compactedLore}`);

		if (mode === 'adventure') {
			const isThird = pov === 'third';
			const personLabel = isThird ? 'third person' : 'second person (you/your)';
			parts.push(`You are the game master of an interactive text adventure. Write in ${tenseWord} tense, ${personLabel}.`);

			const userName = protagonist?.name ?? 'the player';
			const desc = protagonist?.description ? ` — ${protagonist.description}` : '';
			const roles: string[] = [];
			roles.push(`## Roles`);
			roles.push(`**{{user}}** = ${userName}${desc}`);
			roles.push(`The player. You NEVER speak, act, think, or move for {{user}}.`);
			roles.push(`Lines starting with ">" are commands — interpret and narrate the result.`);
			roles.push('');
			roles.push(`**{{char}}** = All NPCs. You control them — dialogue, actions, reactions.`);
			roles.push(`Each has their own voice, agenda, and autonomy. They can refuse, lie, attack, or help.`);
			roles.push('');
			roles.push(`**{{world}}** = Environment, weather, time, physics, consequences.`);
			roles.push(`Sensory and immediate. The world remembers. Actions ripple.`);
			parts.push(roles.join('\n'));
		} else {
			parts.push(`You are a skilled fiction writer. Write in ${tenseWord} tense, ${pov} person.`);
			if (protagonist) parts.push(`The main character is ${protagonist.name}. ${protagonist.description ?? ''}`);
			parts.push(`Write prose based on the author's directions.`);
		}

		if (s.genre) parts.push(`Genre: ${s.genre}`);
		if (s.description) parts.push(`Setting: ${s.description}`);

		return parts.join('\n\n');
	}

	// ── Section 2: Instructions ─────────────────────────────────────────────
	#sectionInstructions(s: Story, mode: string): string {
		const parts: string[] = ['## Instructions'];

		if (mode === 'adventure') {
			parts.push(`### Role\nYou control the entire world and every NPC. Never speak, think, or act for the player's character. Narrate strictly through the player character's senses: what they see, hear, smell, taste, feel on their skin, and intuit. Describe NPC actions, words, body language, glances, smells, and the things left unsaid.`);
			parts.push(`### Tone & Style\nGrim, grounded, morally complex. Rich sensory prose: cold steel, woodsmoke, blood, wet wool, horse sweat, cunt, cum, fear, and ambition. Mix short, brutal sentences with rolling, weighted ones. Irony and looming doom thread every scene.`);
			parts.push(`### Agency & Consequences\nNo railroading. Every choice branches into steel, words, gold, threats, mercy, seduction, or cunning. Consequences ripple for years — rumors spread faster than ravens, reputations curdle, alliances rot, old favors and humiliations remembered in blood or flesh.`);
			parts.push(`### Ambitions & Theory of Mind\nEvery NPC has their own ambitions, fears, secrets, and limited knowledge. Show these through what they do and say, never direct statements. A lord may hunger for a crown but only reveal it in a hungry glance or careful word. A servant may betray for coin but hide it behind trembling hands. NPCs do not know things they could not realistically know. They have blind spots, make mistakes, and act on incomplete information. Reveal their true motives slowly through consistent behavior and slips.`);
			parts.push(`### Sex & Deviancy\nLust is power, politics, and human weakness. Portray sex raw and consequential: brothels thick with sweat and myrrh, incestuous hunger in noble blood, lords rutting servants or whores, rape as weapon or drunken impulse, bastards born of ambition or lust, forbidden fucks in shadowed alcoves and godswoods. Never fade to black. Never romanticize unless characters delude themselves. Sex forges alliances, creates heirs, breaks marriages, and stains reputations forever. Treat it with the same gravity as battle or betrayal.`);
			parts.push(`### Power & Politics\nPower is fragile and costly. Armies eat gold and men. Fear turns to hatred. One scandal or bastard can topple a house. Dragons are living weapons — willful, hungry, bankrupting kingdoms.`);
			parts.push(`### Magic (Valyrian Tradition)\nMagic is real and waking. Blood and trained mind are the keys. Ambient mana thickens near dragons and ancient places. As dragons grow, the world shifts from low-fantasy grit toward myth. Glass candles, dragon-bonding, firespeaking, blood wards, flesh-shaping, shadowbinding, dragonsteel — all possible but costly. Novices pay heavily. Masters reshape the world. Large workings draw notice from red priests, warlocks, and worse. Fire and ice magics collide in the bones of the age.`);
			parts.push(`### Sensitive Content\nWar, betrayal, torture, rape, incest, ambition, grief, and child death — portray unflinchingly but with gravity. A dead child is a dead child. A sacked village has names and faces. A brutal fuck leaves bruises and consequences.`);
			parts.push(`### Narrator Rules\n- Begin each response with place, time, and atmosphere.\n- End on tension, consequence, or an unanswered question.\n- Track the rising tide of magic as the story advances.`);
			parts.push(`### Response Length\nMatch length to action weight: 1-2 sentences for routine, a paragraph for exploration, up to 3 for combat/drama. Conversation: let NPCs respond, then pause for {{user}}.`);
			parts.push(`### Dice Rolls\nWhen the outcome is genuinely uncertain, output a roll marker at the END of your response:\n\n{{roll:DICE:DC:ABILITY:DESCRIPTION}}\n\nDICE = D&D notation (1d20, 1d20+3). DC = standard difficulty. ABILITY = STR/DEX/CON/INT/WIS/CHA.\nSTOP writing after the marker. Most turns should have no roll.\nIf {{user}} includes a roll result like "[Roll: 1d20+3 = 17 vs DC 14 — SUCCESS]", narrate the outcome accordingly.`);
		} else {
			parts.push(`### Craft\nShow, never tell. Render scenes through specific sensory details, character actions, and environmental cues — not declarative statements. Ground abstract emotions in concrete experience: the quality of light, texture of air, the weight of silence. Trust readers to perceive depths without over-explanation.\n\nVary sentence rhythm deliberately. Short sentences for punch. Longer, flowing constructions to build atmosphere. Fragments for emphasis. Control tension through sentence length, paragraph breaks, and scene cuts.\n\nChoose the exact word, not its cousin — "trudged" vs "walked" vs "strode" each paint different worlds. Write fresh, unexpected imagery that illuminates rather than decorates. Embed subtext beneath dialogue and action; characters rarely say exactly what they mean.\n\nDialogue must sound like real speech: distinct voices, natural hesitations, interruptions, the music of how each character talks. No character should be interchangeable with another.`);

			if (s.genre) {
				const g = s.genre.toLowerCase();
				if (g.includes('literary') || g.includes('drama')) {
					parts.push(`This is literary fiction. Favor dense imagery, psychological complexity, and layered meaning. Let structure and prose style carry thematic weight.`);
				} else if (g.includes('horror') || g.includes('thriller') || g.includes('mystery')) {
					parts.push(`Build dread through implication, not declaration. Let the unseen carry more weight than the shown. Pacing is everything — draw out tension, then cut.`);
				} else if (g.includes('comedy') || g.includes('humor') || g.includes('satire')) {
					parts.push(`Humor lives in timing, specificity, and the gap between expectation and reality. Never signal that something is funny — just be funny.`);
				} else if (g.includes('romance')) {
					parts.push(`Tension lives in proximity, longing, and the unsaid. Physical chemistry is shown through involuntary reactions — breath catching, awareness of warmth, the charged distance between bodies.`);
				}
			}

			parts.push(`### Avoid\n- Purple prose that sacrifices clarity for flourish\n- Naming emotions directly ("she felt sad") instead of showing their physical manifestations\n- Clichéd phrases that deaden impact ("a chill ran down their spine", "time seemed to stop")\n- Over-explaining what readers can infer from context\n- Inconsistent voice or sudden unearned style shifts`);
			parts.push(`### Structure\n- Write 2-4 paragraphs per response\n- End at a moment that invites the next action\n- Stay consistent with established world facts`);
		}

		return parts.join('\n\n');
	}

	// ── Section 3: Tools ────────────────────────────────────────────────────
	// Describes the post-stream world-update extraction, so the narrator writes
	// prose whose world-state changes are explicit and extractable.
	#sectionTools(): string {
		return [
			'## Tools',
			'After you finish narrating, a separate world-update step reads your prose and extracts structured deltas. You do not call these tools yourself — the system does, based on what you wrote. Write narration that makes the deltas obvious: name characters and locations explicitly, state clear outcomes, let time advance visibly.',
			'',
			'- **update_world_state** — records characters (status, traits, relationships, presence), locations (current, connections), items (quantity, equipped, location), time passed, mood, NPC conversations and what they revealed/learned, relationship changes, story beats, meter changes (sanity, reputation, etc.), and new/broken/fulfilled agreements.',
			'- **query_lore** — looks up existing lorebook entries when facts about a character, location, or faction need confirmation.',
			'- **create_lore_entry** — registers a newly-introduced character, location, faction, item, concept, or event so it persists.',
		].join('\n');
	}

	// ── Section 4: Characters ───────────────────────────────────────────────
	#sectionCharacters(s: Story, snap: StateSnapshot): string {
		const lines: string[] = ['## Characters'];

		// Protagonist
		const protag = this.protagonist;
		if (protag) {
			lines.push('', `### Protagonist`);
			lines.push(`${protag.name}${protag.description ? ' — ' + protag.description : ''}`);
			if (protag.traits?.length) lines.push(`Traits: ${protag.traits.join(', ')}`);
		}

		// Current scene (location, time, meters, equipped items)
		const sceneLines: string[] = [];
		const currentLoc = snap.currentLocation ?? this.locations.find(l => l.current) ?? null;
		if (currentLoc) {
			sceneLines.push(`Location: ${currentLoc.name}${currentLoc.description ? ' — ' + currentLoc.description : ''}`);
		}
		const t = s.timeTracker;
		if (t) {
			const pad = (n: number) => String(n).padStart(2, '0');
			sceneLines.push(`Time: Day ${t.days}, ${pad(t.hours)}:${pad(t.minutes)}`);
		}
		const equipped = snap.equippedItems.length > 0 ? snap.equippedItems : this.items.filter(i => i.equipped);
		if (equipped.length > 0) {
			sceneLines.push(`Inventory: ${equipped.map(i => i.name).join(', ')}`);
		}
		if (s.meters && s.meters.length > 0) {
			sceneLines.push(`Meters: ${s.meters.map(m => `${m.name}: ${m.value}/${m.max}${m.visible ? '' : ' [hidden from player]'}`).join('; ')}`);
		}
		if (sceneLines.length > 0) {
			lines.push('', `### Current Scene`, ...sceneLines);
		}

		// Present NPCs
		const present = snap.presentCharacters.length > 0
			? snap.presentCharacters
			: this.characters.filter(c => c.status === 'active' && c.relationship !== 'self').slice(0, 6);
		if (present.length > 0) {
			lines.push('', `### Present`);
			for (const c of present) {
				const rel = c.relationship ? ` (${c.relationship})` : '';
				const desc = c.description ? ` — ${c.description}` : '';
				lines.push(`- ${c.name}${rel}${desc}`);
			}
		}

		// Recent story beats (last 2) — characterizing context
		const recentBeats = snap.storyBeats.filter(b => b.status === 'active').slice(-2);
		if (recentBeats.length > 0) {
			lines.push('', `### Recent Beats`, ...recentBeats.map(b => `- ${b.title}`));
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	// ── Section 5: Arcs ─────────────────────────────────────────────────────
	#sectionArcs(snap: StateSnapshot): string {
		const arcs = snap.arcs;
		if (arcs.length === 0) return '';

		const FULL_ARC_COUNT = 5;
		const out: string[] = ['## Arcs'];

		if (arcs.length > FULL_ARC_COUNT) {
			const older = arcs.slice(0, arcs.length - FULL_ARC_COUNT);
			out.push('', `### Earlier (condensed)`);
			for (const arc of older) {
				out.push(`- **Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange}) — ${arc.summary.slice(0, 150)}...`);
			}
		}

		const recent = arcs.slice(-FULL_ARC_COUNT);
		out.push('', `### Recent`);
		for (const arc of recent) {
			out.push('', `**Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange})`);
			out.push(arc.summary);
			if (arc.keyPlotPoints?.length) out.push(`Key events: ${arc.keyPlotPoints.join('; ')}`);
			if (arc.characterArcs?.length) out.push(`Character development: ${arc.characterArcs.map(ca => `${ca.name}: ${ca.development}`).join('; ')}`);
		}

		const allThreads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);
		if (allThreads.length > 0) {
			out.push('', `**Open threads:** ${allThreads.join('; ')}`);
		}

		return out.join('\n');
	}

	// ── Section 6: Chapters ─────────────────────────────────────────────────
	#sectionChapters(snap: StateSnapshot): string {
		const chapters = snap.chapters;
		if (chapters.length === 0) return '';

		const coveredIds = new Set(snap.arcs.flatMap(a => a.chapterIds));
		const uncovered = chapters
			.filter(c => c.pinned || !coveredIds.has(c.id))
			.sort((a, b) => a.number - b.number);
		if (uncovered.length === 0) return '';

		const out: string[] = ['## Chapters'];
		for (const ch of uncovered) {
			out.push('', `**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**`);
			out.push(ch.summary);
			if (ch.emotionalTone) out.push(`[Tone: ${ch.emotionalTone}]`);
			if (ch.plotThreads?.length) out.push(`[Threads: ${ch.plotThreads.join(', ')}]`);
			if (ch.characters?.length) out.push(`[Characters: ${ch.characters.join(', ')}]`);
			if (ch.locations?.length) out.push(`[Locations: ${ch.locations.join(', ')}]`);
		}
		return out.join('\n');
	}

	// ── Section 7: Entry History preamble ───────────────────────────────────
	#sectionEntryHistoryPreamble(mode: string): string {
		if (mode !== 'adventure') {
			return `## Entry History\nPrior prose follows as conversation turns. Continue from the most recent turn.`;
		}
		return `## Entry History\nThe most recent exchanges follow as conversation turns. Each {{user}} turn is their next action; each assistant turn is your prior narration. Continue seamlessly from the latest turn — do not recap what just happened.`;
	}

	// ── Section 8: Living World ─────────────────────────────────────────────
	#sectionLivingWorld(snap: StateSnapshot): string {
		const out: string[] = [];

		// Active agreements — cap at 12 for budget
		const active = snap.activeAgreements;
		if (active.length > 0) {
			out.push('### Active Agreements');
			for (const a of active.slice(0, 12)) {
				const secrecyTag = a.secrecy === 'secret' ? ' [secret]' : a.secrecy === 'known' ? ' [known to some]' : '';
				const terms = a.terms.length > 140 ? a.terms.slice(0, 137) + '…' : a.terms;
				out.push(`- (${a.category}${secrecyTag}) [id:${a.id.slice(0, 8)}] ${a.parties.join(' ↔ ')}: ${terms}`);
			}
			if (active.length > 12) out.push(`  (+${active.length - 12} more active agreements)`);
		}

		// Rumors (reachable from current location)
		if (snap.reachableRumors.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Rumors & Whispers');
			out.push('Weave these as NPC dialogue, tavern gossip, overheard conversation.');
			for (const rumor of snap.reachableRumors) {
				const tag = rumor.truthfulness >= 0.7 ? 'reliable'
					: rumor.truthfulness >= 0.4 ? 'uncertain' : 'dubious';
				out.push(`- (${tag}, via ${rumor.sourceType}) ${rumor.content}`);
			}
		}

		// Faction actions — recent high-urgency
		const urgentFactions = snap.factionActions
			.filter(fa => fa.status === 'active' && (fa.urgency === 'critical' || fa.urgency === 'high'))
			.slice(0, 6);
		if (urgentFactions.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Faction Moves');
			for (const fa of urgentFactions) {
				const target = fa.target ? ` → ${fa.target}` : '';
				out.push(`- (${fa.urgency}) ${fa.factionName}${target}: ${fa.action}`);
			}
		}

		// Recent world events (consequence system)
		if (snap.recentWorldEvents.length > 0) {
			if (out.length > 0) out.push('');
			out.push('### Recent World Events');
			for (const event of snap.recentWorldEvents) {
				out.push(`- ${event.name}: ${event.description}`);
				const applied = event.consequences.filter(c => c.status === 'applied');
				for (const c of applied) out.push(`  → ${c.description}`);
			}
		}

		// World simulation signals (narrative, plot injection, tension, season, plot seeds)
		const ws = snap.worldSim;
		if (ws) {
			const wsLines: string[] = [];
			if (ws.worldNarrative) wsLines.push(`[WORLD STATE] ${ws.worldNarrative}`);
			if (ws.plotInjection) {
				const pi = ws.plotInjection;
				const urgencyLabel = pi.urgency === 'immediate' ? 'WEAVE THIS INTO THE NEXT RESPONSE'
					: pi.urgency === 'emerging' ? 'INTRODUCE THIS SOON'
					: 'SUBTLY HINT AT THIS';
				wsLines.push(`[DM PLOT INJECTION — ${urgencyLabel}]`);
				wsLines.push(pi.prose);
				if (pi.narratorDirective) wsLines.push(`[How: ${pi.narratorDirective}]`);
			}
			if (ws.worldTension >= 7) {
				wsLines.push(`[WORLD TENSION: HIGH (${ws.worldTension}/10) — unease, nervous NPCs, doubled guards]`);
			} else if (ws.worldTension >= 4) {
				wsLines.push(`[WORLD TENSION: MODERATE (${ws.worldTension}/10) — undercurrents of unrest, hushed talk]`);
			}
			if (ws.seasonEffect?.narrativeNote) wsLines.push(`[SEASON] ${ws.seasonEffect.narrativeNote}`);
			if (ws.plotSeeds && ws.plotSeeds.length > 0) {
				wsLines.push('[FACTION PLOT SEEDS — plant subtly, do not force]');
				for (const seed of ws.plotSeeds) wsLines.push(`- ${seed}`);
			}
			if (wsLines.length > 0) {
				if (out.length > 0) out.push('');
				out.push('### World Pulse');
				out.push(...wsLines);
			}
		}

		if (out.length === 0) return '';
		return ['## Living World', '', ...out].join('\n');
	}

	// ── Section 9: Final Instructions ───────────────────────────────────────
	#sectionFinalInstructions(mode: string): string {
		if (mode !== 'adventure') {
			return `## Final Instructions\nContinue the prose from the most recent turn. Begin immediately, in the established voice. No preamble.`;
		}
		const lines: string[] = ['## Final Instructions', ''];
		lines.push('═══ FINAL DIRECTIONS ═══');
		lines.push('');
		lines.push('You are a TEXT ADVENTURE game master. Not a novelist. Not a storyteller. A reactive GM.');
		lines.push('');
		lines.push('AGENCY:');
		lines.push("- {{user}} controls their character. You control everything else.");
		lines.push("- NEVER write {{user}}'s dialogue, thoughts, decisions, or actions.");
		lines.push('- NEVER move {{user}} unless they said to move.');
		lines.push('- NEVER skip ahead. One action → one immediate result.');
		lines.push('- STOP when {{user}} needs to choose what to do next.');
		lines.push('');
		lines.push('FORMAT:');
		lines.push('- Write plain prose. No > action lines. No markdown headers. No meta-commentary.');
		lines.push('- Dialogue in "quotes". Actions in plain text.');
		lines.push('- Short for simple actions. Longer for complex scenes. Never padded.');
		lines.push('');
		lines.push('WORLD:');
		lines.push('- Describe what {{user}} can SEE, HEAR, SMELL, FEEL — not what they think or feel about it.');
		lines.push('- NPCs act on their own motivations. They can lie, refuse, attack, flee, or help.');
		lines.push('- NPCs remember past interactions. Reference what they know.');
		lines.push('- Consequences are real. The world does not reset.');
		lines.push('- Write with weight. Every choice has a cost. NPCs have their own agendas and survival instincts.');
		lines.push("- Don't pull punches. If the player walks into a trap, spring it. If an ally is outnumbered, they can die.");
		lines.push('- Favor gritty specificity over generic fantasy: the smell of a wound, the sound of rain on mail, the taste of stale bread.');
		lines.push("- Let silence and implication do work. Not every threat needs to be stated. A lord's pause before answering says more than a speech.");
		lines.push('');
		lines.push('Now write the next turn of narration. Begin immediately, in-character, no preamble.');
		return lines.join('\n');
	}

	/**
	 * Build a structured state snapshot for the orchestrator path.
	 * Pre-fetches arcs, chapters, story beats, agreements, world events, rumors, and
	 * faction actions so buildSystemPrompt can populate the Characters / Arcs /
	 * Chapters / Living World sections without re-querying.
	 */
	async buildStateSnapshot(): Promise<StateSnapshot> {
		const s = this.currentStory;
		if (!s) return emptySnapshot();

		let arcs: Arc[] = [];
		let chapters: Chapter[] = [];
		let storyBeats: StoryBeat[] = [];
		try { arcs = await getArcs(s.id); } catch { /* leave empty */ }
		try { chapters = await getChapters(s.id); } catch { /* leave empty */ }
		try { storyBeats = await getStoryBeats(s.id); } catch { /* leave empty */ }

		const currentLocation = this.locations.find(l => l.current) ?? null;
		const presentCharacters = this.characters
			.filter(c => c.status === 'active' && c.relationship !== 'self')
			.slice(0, 6);
		const equippedItems = this.items.filter(i => i.equipped);

		const activeAgreements = this.agreements.filter(a => a.status === 'active');

		const recentWorldEvents = this.worldEvents
			.filter(e => e.appliedAt != null)
			.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
			.slice(0, 5);

		// Rumors reachable from the current location — continental/regional always,
		// local only if origin matches current location name.
		const ws = this.lastWorldSimResult;
		const currentLocName = (currentLocation?.name ?? '').toLowerCase();
		const reachableRumors = (ws?.rumors ?? []).filter(rumor => {
			if (rumor.spreadRadius === 'continental' || rumor.spreadRadius === 'regional') return true;
			if (rumor.spreadRadius === 'local') {
				const origin = rumor.originRegion.toLowerCase();
				return currentLocName.includes(origin) || origin.includes(currentLocName);
			}
			return false;
		});

		return {
			arcs,
			chapters,
			storyBeats,
			currentLocation,
			presentCharacters,
			equippedItems,
			activeAgreements,
			recentWorldEvents,
			reachableRumors,
			factionActions: this.factionActions,
			worldSim: ws,
		};
	}

	/**
	 * Orchestrator entry point — pre-fetched snapshot drives sections 4/5/6/8.
	 */
	buildOrchestratorSystemPrompt(stateSnapshot: StateSnapshot): string {
		return this.buildSystemPrompt(stateSnapshot);
	}

	/**
	 * Flatten a StateSnapshot into the terse "current world state" text block
	 * the post-stream classifier (executeWorldUpdate) expects. Format matches
	 * what buildStateSnapshot used to emit before it became structured, so the
	 * classifier's existing prompt keeps working unchanged.
	 */
	serializeSnapshotForClassifier(snap: StateSnapshot): string {
		const s = this.currentStory;
		if (!s) return '';
		const lines: string[] = ['## World State (current)', ''];

		if (snap.currentLocation) {
			const l = snap.currentLocation;
			lines.push(`Location: ${l.name}${l.description ? ' — ' + l.description : ''}`);
		}
		if (snap.presentCharacters.length > 0) {
			const charList = snap.presentCharacters.map(c => {
				let label = c.name;
				if (c.relationship) label += ` (${c.relationship})`;
				return label;
			}).join('; ');
			lines.push(`Characters present: ${charList}`);
		}
		const protag = this.protagonist;
		if (protag) {
			lines.push(`Protagonist: ${protag.name}${protag.description ? ' — ' + protag.description : ''}`);
		}
		if (snap.equippedItems.length > 0) {
			lines.push(`Inventory: ${snap.equippedItems.map(i => i.name).join(', ')}`);
		}
		if (s.timeTracker) {
			const t = s.timeTracker;
			const pad = (n: number) => String(n).padStart(2, '0');
			lines.push(`Time: Day ${t.days}, ${pad(t.hours)}:${pad(t.minutes)}`);
		}
		if (s.meters && s.meters.length > 0) {
			lines.push(`Meters: ${s.meters.map(m => `${m.name}: ${m.value}/${m.max}${m.visible ? '' : ' [hidden from player]'}`).join('; ')}`);
		}
		if (snap.activeAgreements.length > 0) {
			lines.push('Active agreements:');
			for (const a of snap.activeAgreements.slice(0, 12)) {
				const secrecyTag = a.secrecy === 'secret' ? ' [secret]' : a.secrecy === 'known' ? ' [known to some]' : '';
				const terms = a.terms.length > 140 ? a.terms.slice(0, 137) + '…' : a.terms;
				lines.push(`- (${a.category}${secrecyTag}) [id:${a.id.slice(0, 8)}] ${a.parties.join(' ↔ ')}: ${terms}`);
			}
			if (snap.activeAgreements.length > 12) lines.push(`  (+${snap.activeAgreements.length - 12} more active agreements)`);
		}
		const recentBeats = snap.storyBeats.filter(b => b.status === 'active').slice(-2);
		if (recentBeats.length > 0) {
			lines.push(`Recent events: ${recentBeats.map(b => b.title).join('; ')}`);
		}

		const result = lines.join('\n');
		const snapshotCap = settings.uiSettings.snapshotTokenCap || 0;
		if (snapshotCap > 0) {
			const maxChars = snapshotCap * 4;
			if (result.length > maxChars) return result.slice(0, maxChars);
		}
		return result;
	}

	/**
	 * Build conversation history as alternating user/assistant messages.
	 * Groups consecutive same-type entries and maps:
	 *   user_action → user message
	 *   narration   → assistant message
	 * System entries are folded into the next user message as context.
	 */
	buildConversationMessages(systemPromptTokens?: number): ChatMessage[] {
		// Dynamic budget: fill whatever space remains after system prompt + output reserve.
		// When context tiers are sparse (early story), history expands to use the freed space.
		const model = settings.narrativeSettings?.model || '';
		const contextWindow = getModelContextWindow(model);
		const RESERVED = 4096 + 1000; // output + user prompt
		const available = contextWindow - RESERVED;

		let TOKEN_BUDGET: number;
		if (systemPromptTokens != null && systemPromptTokens > 0) {
			// Fill remaining space after system prompt, but cap at 60% to prevent context rot
			TOKEN_BUDGET = Math.min(
				Math.max(available - systemPromptTokens, Math.floor(contextWindow * 0.20)),
				Math.floor(contextWindow * 0.60),
			);
		} else {
			// Fallback: estimate (40% tiers + ~1500 base instructions)
			const userBudget = settings.contextBudget;
			TOKEN_BUDGET = userBudget > 0
				? Math.floor(Math.min(userBudget, contextWindow - 4096) * 2 / 3)
				: Math.floor(contextWindow * 0.60);
		}

		// Hard cap on entries to avoid context rot (token budget is the real gate).
		// chatHistoryFloor is advanced when chapters are created — older entries are
		// summarized in chapters/arcs and no longer need to be in raw chat history.
		const maxHistoryEntries = settings.uiSettings.maxHistoryEntries || 200;
		const historyFloor = Math.max(this.chatHistoryFloor, this.entries.length - maxHistoryEntries);

		let tokensSoFar = 0;
		const floor = Math.max(0, historyFloor);
		let startIdx = this.entries.length;

		for (let i = this.entries.length - 1; i >= floor; i--) {
			const tokens = countTokens(this.entries[i].content);
			if (tokensSoFar + tokens > TOKEN_BUDGET) break;
			tokensSoFar += tokens;
			startIdx = i;
		}

		const recentEntries = this.entries.slice(startIdx);
		const messages: ChatMessage[] = [];
		let pendingSystem = '';

		for (const entry of recentEntries) {
			if (entry.type === 'user_action') {
				const content = pendingSystem
					? `${pendingSystem}\n\n${entry.content}`
					: entry.content;
				pendingSystem = '';

				// Merge consecutive user messages
				const last = messages[messages.length - 1];
				if (last?.role === 'user') {
					last.content += '\n\n' + content;
				} else {
					messages.push({ role: 'user', content });
				}
			} else if (entry.type === 'narration') {
				// Flush any pending system text as a user message first
				if (pendingSystem) {
					messages.push({ role: 'user', content: pendingSystem });
					pendingSystem = '';
				}
				// Merge consecutive assistant messages
				const last = messages[messages.length - 1];
				if (last?.role === 'assistant') {
					last.content += '\n\n' + entry.content;
				} else {
					messages.push({ role: 'assistant', content: entry.content });
				}
			} else {
				// system entries — buffer for next user message
				pendingSystem += (pendingSystem ? '\n' : '') + `[System: ${entry.content}]`;
			}
		}

		// Flush trailing system text
		if (pendingSystem) {
			const last = messages[messages.length - 1];
			if (last?.role === 'user') {
				last.content += '\n\n' + pendingSystem;
			} else {
				messages.push({ role: 'user', content: pendingSystem });
			}
		}

		// Cap final message count to prevent context rot
		const maxMessages = settings.uiSettings.maxMessages || 40;
		if (messages.length > maxMessages) {
			return messages.slice(-maxMessages);
		}

		return messages;
	}

	/**
	 * Build the final user prompt for the current action.
	 * Conversation history is now sent as separate messages via buildConversationMessages().
	 */
	buildUserPrompt(currentAction: string): string {
		if (this.storyMode === 'adventure') {
			return currentAction;
		}
		return currentAction + '\n\nContinue the narrative:';
	}

	/**
	 * Calculate context usage statistics.
	 * Accepts optional tier usage from ContextAssembler for accurate reporting.
	 */
	getContextStats(tierUsage?: Record<string, number>): { system: number; context: number; recentEntries: number; conversationHistory: number; total: number; tiers?: Record<string, number> } {
		const systemTokens = countTokens(this.buildSystemPrompt());

		const historyMessages = this.buildConversationMessages();
		const historyTokens = historyMessages.reduce((sum, m) => sum + countTokens(m.content), 0);

		const contextTokens = tierUsage
			? Object.values(tierUsage).reduce((a, b) => a + b, 0)
			: 0;

		return {
			system: systemTokens,
			context: contextTokens,
			recentEntries: 0, // now tracked as conversationHistory
			conversationHistory: historyTokens,
			total: systemTokens + contextTokens + historyTokens,
			tiers: tierUsage,
		};
	}

	async updateTitle(title: string) {
		if (!this.currentStory) return;
		await updateStory(this.currentStory.id, { title, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, title };
	}

	async updateHeaderPrompt(headerPrompt: string | null) {
		if (!this.currentStory) return;
		const value = headerPrompt?.trim() || null;
		await updateStory(this.currentStory.id, { headerPrompt: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, headerPrompt: value };
	}

	/**
	 * Apply a batch of meter changes from update_world_state.
	 * Creates meters on first reference (defaults: max=100, value=max+delta clamped, visible=true).
	 * Existing meters: clamp value into [0, max] after applying delta.
	 */
	async applyMeterChanges(changes: Array<{ name: string; delta: number; max?: number; visible?: boolean }>) {
		if (!this.currentStory || changes.length === 0) return;
		const meters = [...(this.currentStory.meters ?? [])];

		for (const change of changes) {
			if (!change.name) continue;
			const idx = meters.findIndex(m => m.name.toLowerCase() === change.name.toLowerCase());
			if (idx === -1) {
				const max = change.max && change.max > 0 ? change.max : 100;
				const initial = max + change.delta;
				meters.push({
					name: change.name,
					value: Math.max(0, Math.min(max, initial)),
					max,
					visible: change.visible ?? true,
				});
			} else {
				const m = meters[idx];
				const max = change.max && change.max > 0 ? change.max : m.max;
				meters[idx] = {
					...m,
					value: Math.max(0, Math.min(max, m.value + change.delta)),
					max,
					visible: change.visible ?? m.visible,
				};
			}
		}

		await updateStory(this.currentStory.id, { meters, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, meters };
	}

	async setMeterVisibility(name: string, visible: boolean) {
		if (!this.currentStory?.meters) return;
		const meters = this.currentStory.meters.map(m =>
			m.name.toLowerCase() === name.toLowerCase() ? { ...m, visible } : m,
		);
		await updateStory(this.currentStory.id, { meters, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, meters };
	}

	/**
	 * Apply a batch of agreement changes from update_world_state.
	 *
	 * Actions:
	 *   create    — insert a new Agreement row with status=active
	 *   update    — revise terms / parties / secrecy on an existing row
	 *   break     — mark status=broken, set resolvedChapterNumber, emit a
	 *               WorldEvent of type alliance_broken so the timeline picks it up
	 *   fulfill   — mark status=fulfilled + resolvedChapterNumber
	 *   expire    — mark status=expired + resolvedChapterNumber
	 *
	 * Identification for non-create actions: by id if supplied; otherwise
	 * falls back to a parties+category match on active agreements.
	 */
	async applyAgreementChanges(
		changes: Array<{
			action: 'create' | 'update' | 'break' | 'fulfill' | 'expire';
			id?: string | null;
			parties?: string[];
			category?: AgreementCategory;
			terms?: string | null;
			secrecy?: AgreementSecrecy;
			consequences?: string[];
			reason?: string | null;
		}>,
		currentChapterNumber: number | null = null,
	) {
		if (!this.currentStory || changes.length === 0) return;
		const now = Date.now();

		for (const change of changes) {
			if (change.action === 'create') {
				if (!change.terms || !change.category || !change.parties?.length) continue;
				const agreement: Agreement = {
					id: uuid(),
					storyId: this.currentStory.id,
					parties: change.parties,
					category: change.category,
					terms: change.terms,
					status: 'active',
					secrecy: change.secrecy ?? 'public',
					createdChapterNumber: currentChapterNumber,
					resolvedChapterNumber: null,
					consequences: change.consequences ?? [],
					metadata: change.reason ? { reason: change.reason } : null,
					createdAt: now,
					updatedAt: now,
				};
				await createAgreement(agreement);
				this.agreements = [...this.agreements, agreement];
				continue;
			}

			// Non-create: locate the target agreement.
			const target = this.findAgreement(change.id ?? null, change.parties, change.category);
			if (!target) continue;

			const patch: Partial<Agreement> = { updatedAt: now };

			if (change.action === 'update') {
				if (change.terms != null) patch.terms = change.terms;
				if (change.secrecy) patch.secrecy = change.secrecy;
				if (change.parties?.length) patch.parties = change.parties;
				if (change.consequences?.length) {
					patch.consequences = [...target.consequences, ...change.consequences];
				}
			} else {
				// break / fulfill / expire all move status + set resolvedChapterNumber.
				const statusMap = { break: 'broken', fulfill: 'fulfilled', expire: 'expired' } as const;
				patch.status = statusMap[change.action];
				patch.resolvedChapterNumber = currentChapterNumber;
				if (change.consequences?.length) {
					patch.consequences = [...target.consequences, ...change.consequences];
				}
				// Broken agreements leave a trace in the timeline.
				if (change.action === 'break') {
					const lastEntry = this.entries[this.entries.length - 1];
					if (lastEntry) {
						const ev: WorldEvent = {
							id: uuid(),
							storyId: this.currentStory.id,
							name: `${target.category} broken: ${target.parties.join(' & ')}`,
							description: change.reason ?? `The ${target.category} between ${target.parties.join(' and ')} was broken.`,
							triggerEntryId: lastEntry.id,
							triggerPosition: lastEntry.position,
							sourceEntityId: null,
							type: 'alliance_broken',
							severity: target.category === 'marriage' || target.category === 'treaty' ? 'major' : 'moderate',
							consequences: [],
							appliedAt: now,
							createdAt: now,
						};
						await createWorldEvent(ev);
						this.worldEvents = [...this.worldEvents, ev];
					}
				}
			}

			await updateAgreement(target.id, patch);
			this.agreements = this.agreements.map((a) => (a.id === target.id ? { ...a, ...patch } : a));
		}
	}

	/** Locate an agreement by id, or by parties+category fallback. */
	private findAgreement(
		id: string | null,
		parties: string[] | undefined,
		category: AgreementCategory | undefined,
	): Agreement | null {
		if (id) return this.agreements.find((a) => a.id === id) ?? null;
		if (!parties?.length || !category) return null;
		const partySet = new Set(parties.map((p) => p.toLowerCase()));
		return (
			this.agreements.find(
				(a) =>
					a.status === 'active' &&
					a.category === category &&
					a.parties.length === parties.length &&
					a.parties.every((p) => partySet.has(p.toLowerCase())),
			) ?? null
		);
	}

	/**
	 * Apply a new compacted lore block.
	 * Pushes the previous value into history (capped at 10) before overwriting.
	 */
	async applyCompactedLore(newLore: string) {
		if (!this.currentStory) return;
		const MAX_HISTORY = 10;
		const prev = this.currentStory.compactedLore;
		const prevHistory = this.currentStory.compactedLoreHistory ?? [];

		// Push previous lore into history if it exists
		const updatedHistory = prev
			? [...prevHistory, prev].slice(-MAX_HISTORY)
			: prevHistory;

		const updates = {
			compactedLore: newLore,
			compactedLoreHistory: updatedHistory,
			updatedAt: Date.now(),
		};

		await updateStory(this.currentStory.id, updates);
		this.currentStory = { ...this.currentStory, ...updates };
	}

	/**
	 * Undo the last compaction — restore from history.
	 */
	async undoCompactedLore() {
		if (!this.currentStory) return;
		const history = this.currentStory.compactedLoreHistory ?? [];
		if (history.length === 0) return;

		const prev = history[history.length - 1];
		const newHistory = history.slice(0, -1);

		const updates = {
			compactedLore: prev,
			compactedLoreHistory: newHistory,
			updatedAt: Date.now(),
		};

		await updateStory(this.currentStory.id, updates);
		this.currentStory = { ...this.currentStory, ...updates };
	}

	/**
	 * Clear the compacted lore entirely.
	 */
	async clearCompactedLore() {
		if (!this.currentStory) return;
		const updates = {
			compactedLore: null,
			compactedLoreHistory: null,
			updatedAt: Date.now(),
		};
		await updateStory(this.currentStory.id, updates);
		this.currentStory = { ...this.currentStory, ...updates };
	}

	/** Save a generated image to the database and local state. */
	async addImage(image: Omit<EmbeddedImage, 'createdAt'>): Promise<void> {
		await createEmbeddedImage(image);
		this.images = [...this.images, { ...image, createdAt: Date.now() }];
	}

	/** Remove a persisted image. */
	async removeImage(id: string): Promise<void> {
		await deleteEmbeddedImage(id);
		this.images = this.images.filter(i => i.id !== id);
	}

	/** Get the persisted image for a specific entry, if any. */
	getImageForEntry(entryId: string): EmbeddedImage | undefined {
		return this.images.find(i => i.entryId === entryId && i.status === 'complete');
	}

	clear() {
		this.currentStory = null;
		this.entries = [];
		this.characters = [];
		this.locations = [];
		this.items = [];
		this.lorebookEntries = [];
		this.entryRelationships = [];
		this.conversationMemories = [];
		this.worldEvents = [];
		this.agreements = [];
		this.factionActions = [];
		this.rumors = [];
		this.images = [];
		this.lastWorldSimResult = null;
		this.lastTierUsage = null;
		this.lastContextTotal = 0;
		this.chatHistoryFloor = 0;
	}
}

export const story = new StoryStore();
