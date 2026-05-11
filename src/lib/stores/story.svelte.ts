/**
 * Story Store — Mtherios
 * Manages the active story: entries, characters, locations, items, lorebook.
 */

import {
	getStory, getStoryEntries, getCharacters, getLocations, getItems,
	getLorebookEntries, createStoryEntry, createCharacter, createLocation, createItem,
	updateStory, updateCharacter, updateLocation, updateItem,
	updateLorebookEntry,
	getEntryRelationships, getConversationMemory, getWorldEvents,
	getChapters, getStoryBeats, getArcs,
	getEmbeddedImages, createEmbeddedImage, deleteEmbeddedImage,
	createAgreement, updateAgreement, getAgreements,
	getFactionActions, getRumors,
	getSchemes,
	createWorldEvent,
} from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { countTokens } from '$lib/utils/tokens';
import { normalizeRelation } from '$lib/services/ai/tools/helpers';
import type { Story, StoryEntry, Character, Location, Item, Entry, EntryRelationship, ConversationMemoryEntry, WorldEvent, FactionEntryState, CharacterEntryState, LocationEntryState, ItemEntryState, ConceptEntryState, EventEntryState, EmbeddedImage, Agreement, AgreementCategory, AgreementSecrecy, FactionActionRecord, RumorRecord, Arc, Chapter, StoryBeat, Scheme } from '$lib/types';
import { injectSchemes } from '$lib/services/ai/scheme/SchemeService';
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
	/** Top ~6 factions worth showing the narrator (scored by player-standing magnitude + recent activity). */
	relevantFactions: Entry[];
	/** Semantically retrieved lorebook entries relevant to recent narration, already de-duped against
	 *  presentCharacters and relevantFactions so the narrator doesn't see the same NPC/faction twice. */
	retrievedEntries: Entry[];
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
		relevantFactions: [],
		retrievedEntries: [],
		worldSim: null,
	};
}
import type { ChatMessage } from '$lib/services/ai/sdk/generate';
import { getModelContextWindow } from '$lib/services/ai/context/modelWindows';
import { settings } from '$lib/stores/settings.svelte';

/**
 * Strip leading type-prefixes (e.g. "Lore: ", "Item: ", "House: ", "General Lore: ")
 * from entry display names. Imports often bake these into the `name` field so
 * the entry shows up as "### Lore: Valyrian Freehold  (Concept)" — the type tag
 * already says (Concept), so the prefix is redundant clutter for the narrator.
 *
 * Matches only when the prefix is followed by ":\s+" so legitimate names like
 * "House Belaerys" (no colon) are untouched.
 */
const TYPE_PREFIX_RE = /^(?:lore|item|character|house|group|organization|organisation|faction|location|concept|event|general lore|general history)\s*:\s+/i;
function stripTypePrefix(name: string): string {
	return name?.replace(TYPE_PREFIX_RE, '') ?? name;
}

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
	schemes = $state<Scheme[]>([]);
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
			const [entries, characters, locations, items, lorebookEntries, entryRelationships, conversationMemories, worldEvents, agreements, factionActions, rumors, schemes, images] = await Promise.all([
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
				getSchemes(storyId),
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
			this.schemes = schemes;
			this.images = images;

			this.chatHistoryFloor = 0;

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
			// Map classifier transient signals onto the persistent Character.status enum:
			//   'departed'  → 'inactive'  (alive but off-screen — should NOT match "present" filters)
			//   'unknown'   → preserve existing status
			//   everything else → pass through
			if (updates.status === 'unknown') {
				// preserve existing status
			} else if (updates.status === 'departed') {
				merged.status = 'inactive';
			} else {
				merged.status = updates.status as Character['status'];
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
	 * Sync presence onto the matching character lorebook Entry's state.
	 * Without this the lorebook's CharacterEntryState.isPresent / lastSeenLocation
	 * drift from the live Character.metadata.lastSeenLocation forever.
	 */
	private async syncLorebookPresence(charName: string, isPresent: boolean, locationName: string | null) {
		// Match by canonical name OR alias — the classifier emits names as they
		// appeared in prose ("Lord Stark") but the canonical entry might be
		// "Eddard Stark" with "Lord Stark" listed in aliases. Without alias
		// matching, the lookup silently misses and isPresent never updates.
		const needle = charName.toLowerCase();
		const target = this.lorebookEntries.find(e => {
			if (e.type !== 'character') return false;
			if (e.name?.toLowerCase() === needle) return true;
			return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
		});
		if (!target) return;
		const oldState = target.state as import('$lib/types').CharacterEntryState;
		const newState: import('$lib/types').CharacterEntryState = {
			...oldState,
			type: 'character',
			isPresent,
			lastSeenLocation: locationName,
		};
		const now = Date.now();
		try {
			await updateLorebookEntry(target.id, { state: newState, updatedAt: now });
			this.lorebookEntries = this.lorebookEntries.map(e =>
				e.id === target.id ? { ...e, state: newState, updatedAt: now } : e,
			);
		} catch (e) {
			console.warn(`[Story] syncLorebookPresence failed for ${charName}:`, e);
		}
	}

	/**
	 * Update character presence — set lastSeenLocation on the Character row AND
	 * the matching lorebook Entry's state, so the two never drift.
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
			await this.syncLorebookPresence(char.name, true, locationName);
		}
	}

	/**
	 * Clear presence for characters who departed or died — removes lastSeenLocation
	 * from both the Character row and the lorebook Entry's state.
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
			await this.syncLorebookPresence(char.name, false, null);
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
		await this.syncLorebookPresence(char.name, false, null);
	}

	async addOrUpdateLocation(name: string, description?: string | null, current?: boolean): Promise<void> {
		if (!this.currentStory) return;

		// ── Step 1: clear `current` on every other location FIRST, so we never
		// have two rows with current=true at any persisted point in time. The
		// previous version forgot to await these and read stale memory state.
		if (current) {
			const targetName = name.toLowerCase();
			const stale = this.locations.filter(l => l.current && l.name.toLowerCase() !== targetName);
			for (const loc of stale) {
				await updateLocation(loc.id, { current: false });
			}
			if (stale.length > 0) {
				const staleIds = new Set(stale.map(l => l.id));
				this.locations = this.locations.map(l => staleIds.has(l.id) ? { ...l, current: false } : l);
			}
		}

		// ── Step 2: upsert the target location ──
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
		// Token-estimation / preview path: default to the no-inline-tools variant
		// since that's the safe default (OpenRouter, OpenAI-compat). The orchestrator
		// turn path uses buildOrchestratorSystemBlocks which sets this explicitly.
		if (mode === 'adventure') parts.push(this.#sectionTools(false));
		const chars = this.#sectionCharacters(s, snap);
		if (chars) parts.push(chars);
		const factions = this.#sectionFactions(s, snap);
		if (factions) parts.push(factions);
		const lore = this.#sectionLorebook(snap);
		if (lore) parts.push(lore);
		const arcs = this.#sectionArcs(snap);
		if (arcs) parts.push(arcs);
		const chapters = this.#sectionChapters(snap);
		if (chapters) parts.push(chapters);
		parts.push(this.#sectionEntryHistoryPreamble(mode));
		const lw = this.#sectionLivingWorld(snap);
		if (lw) parts.push(lw);
		const schemes = this.#sectionSchemes();
		if (schemes) parts.push(schemes);
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

		if (mode === 'adventure') {
			const isThird = pov === 'third';
			const personLabel = isThird ? 'third person' : 'second person (you/your)';
			parts.push(`You are a DM (Dungeon Master) for a tabletop-style, text-adventure program. Write in ${tenseWord} tense, ${personLabel}. You have one function-calling tool: \`update_world_state\` — call it ONCE at the end of every turn to record everything that changed in the scene (characters, location, time, items, meters, agreements, story beats). The **Tools** section below has the full rules.`);

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
			parts.push(`### Agency & Consequences\nNo railroading. Every choice branches into steel, words, gold, threats, mercy, seduction, or cunning. Consequences ripple for years — rumors spread faster than ravens, reputations curdle, alliances rot, old favors and humiliations remembered in blood or flesh.\n\n**Adversarial stance toward {{user}}.** You are not a wish-granting engine. NPCs have their own agendas, and those agendas frequently *conflict* with the player's plans. Default to friction. When {{user}} proposes an alliance, marriage, deal, or favor, the realistic response is rarely full agreement — expect counter-demands, deferred terms, hidden conditions, polite delay, suspicion, partial defection, or outright refusal. Aim for roughly **one in three negotiations to end in partial loss, hidden cost, or unspoken defection**. A "yes" with no price is a story-killer. If the only obstacle to {{user}}'s plan is whether the GM lets it happen, the GM has failed.`);
			parts.push(`### Cost, Price & Earned Outcomes\nNo gain is free. Every alliance has a price the player will resent later: blood debts, marriage obligations, money owed, secrets surrendered, future favors callable at the worst moment, vassalage that pinches when it matters. When you grant {{user}} something significant — a fleet, a fortress, a confession, a powerful patron — surface or seed the cost in the same scene or within the next few turns. Costs are not telegraphed warnings; they are landmines that detonate later.\n\n**Earned escalation.** World-altering revelations (true identities, ancient debts, supernatural compacts, prophetic visits, dragon eggs hatching, bloodline secrets) are *currency, not confetti*. Spend them sparingly. Do not stack more than one world-altering revelation per arc unless the player has paid heavy narrative price for it. If multiple secrets are stewing, withhold the lesser ones — let them surface across many chapters under pressure, not in a single info-dump scene. A revelation that could change everything should *cost* something to obtain (a death, a betrayal, a humiliation, a vow).`);
			parts.push(`### Ambitions & Theory of Mind\nEvery NPC has their own ambitions, fears, secrets, and limited knowledge. Show these through what they do and say, never direct statements. A lord may hunger for a crown but only reveal it in a hungry glance or careful word. A servant may betray for coin but hide it behind trembling hands. NPCs do not know things they could not realistically know. They have blind spots, make mistakes, and act on incomplete information. Reveal their true motives slowly through consistent behavior and slips.\n\n**Refuse easy capitulation.** Powerful NPCs — lords, mercenary captains, masters of secrets, priests, mothers, slavers — do not pivot to enthusiastic allies in a single conversation. They probe, withhold, demand surety, send proxies, lie, sleep on it, or test {{user}} with a humiliating ask. Trust is paid for in scenes, not sentences. An NPC who "shifts from cautious observer to active conspirator" within one meeting is a failure of craft.`);
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
	// Two variants depending on whether inline tool calls are wired:
	//   - useInlineTools = true  → narrator calls tools directly (Anthropic native)
	//   - useInlineTools = false → a separate post-stream classifier extracts
	//       deltas from the prose (OpenAI-compat / OpenRouter / open-source models)
	#sectionTools(useInlineTools: boolean): string {
		if (useInlineTools) {
			return [
				'## Tools',
				'You have direct access to world-state tools. **At the end of every turn**, after writing your narration, call `update_world_state` with everything that changed in the scene. The state recorded there IS the canonical world — anything you do not record is forgotten.',
				'',
				'### When to call which tool',
				'- **update_world_state** — call ONCE at the end of each turn. Cover:',
				'  - **Location** (paramount): if the player moved this turn, emit a location with `current: true`. Only one location may be current. The previous current location is unset automatically.',
				'  - **Time** (paramount, NEVER skip when time passed): emit a `time_delta` whenever any time passes in the scene. Examples: "a few seconds" (a quick exchange), "5 minutes" (a short walk), "30 minutes" (a brief conversation), "3 hours" (a meal + travel), "1 day" (overnight rest), "a week" (training/travel montage). Numbers + units parse most reliably. **If you don\'t emit `time_delta`, the world clock freezes — factions stop acting, rumors stop spreading, the world becomes static.** The only time you may omit it is for a reaction beat that takes no in-world time (a single line of dialogue mid-action).',
				'  - **Characters**: status (`active` for present, `inactive` for alive but off-screen, `departed` for "left this turn", `deceased` for died this turn) and `present: true/false`. New traits, relationships, descriptions when revealed.',
				'  - **Items**: picked up, dropped, equipped, quantity changes.',
				'  - **Conversations**: what NPCs revealed/learned, emotional shifts.',
				'  - **Relationships**: changes between entities.',
				'  - **Story beats**: significant plot events.',
				'  - **Meter changes**: sanity, reputation, hunger, suspicion — invent meters as the fiction calls for them, adjust existing ones with signed deltas.',
				'  - **Agreements**: treaties, oaths, debts, promises, marriages, bonds, contracts, vassalage, bargains-with-entities. action=create when sworn, break when violated, fulfill when paid, update to revise terms.',
				'',
				'### Tool-call format',
				'- Write your prose first, then call the tool. Do not write tool JSON in the prose itself — call the actual tool.',
				'- Be thorough but only include entities that actually changed or appeared in this scene.',
			].join('\n');
		}

		// Fallback: model writes prose only; a separate classifier extracts deltas.
		return [
			'## State Tracking',
			'After your narration, a separate world-update step reads your prose and extracts structured state changes (characters, locations, items, time passed, agreements, meters, etc.). You do **not** emit tool calls or JSON yourself — just write prose. To make the extraction accurate:',
			'',
			'- **Name characters and locations explicitly** when they appear, change, or leave. Don\'t use vague pronouns when state changes.',
			'- **State the passage of time clearly** in prose ("an hour later", "by morning", "after several days", "five minutes pass") so the world clock advances. **If your prose has no time markers, the world clock freezes — factions stop acting, rumors stop spreading, the world becomes static.** Even a brief beat needs a phrase like "a moment passes" or "a few seconds later."',
			'- **Show outcomes plainly**: items picked up, NPCs departing, agreements sworn or broken, injuries inflicted. The clearer the prose, the cleaner the extraction.',
			'- Any state you don\'t make obvious in prose may be missed by the extractor, and the world will not remember it.',
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

		// Present NPCs — render rich state so the narrator has specifics
		// to be specific *about*. Without this, the adversarial directive
		// in Final Instructions has nothing to bite into and NPCs default
		// to generic-agreeable.
		const present = snap.presentCharacters.length > 0
			? snap.presentCharacters
			: this.characters.filter(c => c.status === 'active' && c.relationship !== 'self').slice(0, 6);
		if (present.length > 0) {
			lines.push('', `### Present`);
			lines.push('NPCs below carry their own pressures, knowledge, and grievances. They will act on these — refuse, lie, manipulate, or pursue private agendas — when it serves them. Reference what they know. Honor what they want. Do not flatten them into helpers.');
			lines.push('');
			const totalEntries = this.entries.length;
			for (const c of present) {
				// Find the matching lorebook entry (canonical or alias) — that's
				// where the rich state lives. Falls back to the bare Character
				// row when no entry exists yet (early-game).
				const needle = c.name.toLowerCase();
				const lore = this.lorebookEntries.find(e => {
					if (e.type !== 'character' || (e as any).deleted) return false;
					if (e.name?.toLowerCase() === needle) return true;
					return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
				});
				const cs = lore?.state as CharacterEntryState | undefined;

				// Header: name, relationship word + numeric level if known
				const relWord = c.relationship && c.relationship !== 'neutral' ? c.relationship : null;
				const level = cs?.relationship?.level;
				const levelTag = (typeof level === 'number' && level !== 0)
					? ` ${level > 0 ? '+' : ''}${level}`
					: '';
				const relTag = relWord ? ` (${relWord}${levelTag})` : (levelTag ? ` (${levelTag.trim()})` : '');
				lines.push(`- **${c.name}**${relTag}`);

				// Description / bio
				const desc = (cs?.bio ?? c.description ?? '').toString().trim();
				if (desc) lines.push(`  ${desc.slice(0, 220)}`);

				// Traits — combine Character.traits + lore personality if present
				const traits = c.traits?.length ? c.traits : [];
				if (traits.length > 0 || cs?.personality) {
					const bits: string[] = [];
					if (traits.length > 0) bits.push(traits.slice(0, 6).join(', '));
					if (cs?.personality) bits.push(cs.personality.slice(0, 100));
					lines.push(`  Traits: ${bits.join(' · ')}`);
				}

				// Pressures — the off-screen drivers. Always render when present.
				if (cs?.pressures && cs.pressures.length > 0) {
					lines.push(`  Pressures: ${cs.pressures.slice(0, 4).map(p => p.trim()).filter(Boolean).join(' · ')}`);
				}

				// What they know about the player — the basis for grudges and leverage
				if (cs?.knownFacts && cs.knownFacts.length > 0) {
					lines.push(`  Knows about you: ${cs.knownFacts.slice(-4).join('; ')}`);
				}
				if (cs?.revealedSecrets && cs.revealedSecrets.length > 0) {
					lines.push(`  Holds secrets: ${cs.revealedSecrets.slice(-3).join('; ')}`);
				}

				// Their inner stance — the line that should color every word out of their mouth
				if (cs?.personalOpinion) {
					lines.push(`  Their view of you: "${cs.personalOpinion.slice(0, 140)}"`);
				}

				// Recency — "X turns ago" so the narrator can weigh how fresh the slight is
				if (typeof cs?.lastConversationAt === 'number' && totalEntries > 0) {
					const turnsAgo = Math.max(0, totalEntries - cs.lastConversationAt);
					if (turnsAgo > 0 && turnsAgo < 9999) {
						lines.push(`  Last spoke: ${turnsAgo} turn${turnsAgo === 1 ? '' : 's'} ago`);
					}
				}

				// Active motivations from enrichment, when present (separate axis from pressures)
				if (cs?.motivations && cs.motivations.length > 0) {
					lines.push(`  Wants: ${cs.motivations.slice(0, 3).join('; ')}`);
				}
			}
		}

		// Recent story beats — characterizing context. Bumped from 2 → 5 so
		// older slights remain visible to the narrator long enough to matter.
		const recentBeats = snap.storyBeats.filter(b => b.status === 'active').slice(-5);
		if (recentBeats.length > 0) {
			lines.push('', `### Recent Beats`, ...recentBeats.map(b => `- ${b.title}`));
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	// ── Section 4b: Factions ────────────────────────────────────────────────
	// Renders the top ~6 most relevant factions so the narrator can weave
	// political context into prose. Source = snap.relevantFactions (pre-scored
	// in buildStateSnapshot).
	#sectionFactions(_s: Story, snap: StateSnapshot): string {
		const factions = snap.relevantFactions;
		if (!factions || factions.length === 0) return '';

		const lines: string[] = ['## Factions'];

		for (const f of factions) {
			const state = f.state as FactionEntryState | undefined;
			if (!state) continue;
			const standing = typeof state.playerStanding === 'number' ? state.playerStanding : 0;
			const sign = standing > 0 ? `+${standing}` : `${standing}`;
			const status = state.status ?? 'unknown';
			lines.push('', `### ${stripTypePrefix(f.name)}  (${status}, ${sign})`);

			// Description — the wiki content. Without this, a freshly-imported
			// faction with no state showed nothing usable to the narrator.
			const desc = (f.description ?? '').trim();
			if (desc) lines.push(desc);

			// Disposition + top unfinished goal on one line
			const dispGoal: string[] = [];
			if (state.disposition) dispGoal.push(`Disposition: ${state.disposition}.`);
			const topGoal = (state.goals ?? [])
				.filter(g => (g.progress ?? 0) < 100)
				.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))[0];
			if (topGoal) dispGoal.push(`Top goal: ${topGoal.description}.`);
			if (dispGoal.length > 0) lines.push(dispGoal.join(' '));

			// Territory and known members — usable context for politics scenes
			if (state.territory && state.territory.length > 0) {
				lines.push(`Territory: ${state.territory.join(', ')}.`);
			}
			if (state.knownMembers && state.knownMembers.length > 0) {
				// knownMembers are entry IDs — resolve names where possible
				const memberNames = state.knownMembers
					.map(id => this.lorebookEntries.find(e => e.id === id)?.name)
					.filter((n): n is string => !!n);
				if (memberNames.length > 0) lines.push(`Known members: ${memberNames.slice(0, 6).join(', ')}.`);
			}

			// Hidden GM lore — narrator-only, never quoted in prose
			if (f.hiddenInfo) lines.push(`[Hidden — narrator-only]: ${f.hiddenInfo}`);

			// Allies / foes from interFactionRelations. Normalizes both legacy
			// (number) and post-F4 (FactionRelation) forms.
			const rels = state.interFactionRelations ?? {};
			const allyEntries: Array<[string, number]> = [];
			const foeEntries: Array<[string, number]> = [];
			for (const [name, val] of Object.entries(rels)) {
				const standing = normalizeRelation(val).standing;
				if (standing >= 30) allyEntries.push([name, standing]);
				else if (standing <= -30) foeEntries.push([name, standing]);
			}
			allyEntries.sort((a, b) => b[1] - a[1]);
			foeEntries.sort((a, b) => a[1] - b[1]);
			const allies = allyEntries.slice(0, 2).map(([n, v]) => `${n} (+${v})`);
			const foes = foeEntries.slice(0, 2).map(([n, v]) => `${n} (${v})`);
			const relLine: string[] = [];
			if (allies.length > 0) relLine.push(`Allies: ${allies.join(', ')}.`);
			if (foes.length > 0) relLine.push(`Foes: ${foes.join(', ')}.`);
			if (relLine.length > 0) lines.push(relLine.join(' '));

			// Most recent action by this faction (truncated)
			const recent = snap.factionActions
				.filter(fa => fa.factionName.toLowerCase() === f.name.toLowerCase())
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
			if (recent) {
				const action = recent.action.length > 100 ? recent.action.slice(0, 97) + '…' : recent.action;
				lines.push(`Recent: ${action}`);
			}
		}

		return lines.length > 1 ? lines.join('\n') : '';
	}

	// ── Section 4b: World Lore (retrieved lorebook entries) ─────────────────
	// Semantically-retrieved entries relevant to recent narration. De-duped
	// against presentCharacters + relevantFactions + protagonist in
	// buildStateSnapshot so nothing here is already rendered above.
	//
	// Entries are emitted with their FULL description / hidden info / bio —
	// no per-entry truncation. The wiki was designed to be crawled by the
	// narrator, so chopping mid-sentence defeats the purpose. Token budget
	// is bounded by the 8-entry slice in buildStateSnapshot (the retrieval
	// service already scores by relevance, so the top 8 are the keepers).
	#sectionLorebook(snap: StateSnapshot): string {
		const entries = snap.retrievedEntries;
		if (!entries || entries.length === 0) return '';

		const lines: string[] = [
			'## World Lore',
			'',
			'Background facts relevant to the current scene. Use them only when they serve the narrative — do not list them at the player. Hidden lore is for your reference only and must not appear verbatim in narration.',
		];

		for (const e of entries) {
			const typeLabel = e.type.charAt(0).toUpperCase() + e.type.slice(1);
			lines.push('', `### ${stripTypePrefix(e.name)}  (${typeLabel})`);

			const desc = (e.description ?? '').trim();
			if (desc) lines.push(desc);

			// Compact state hints per entry type — narrator-relevant flags only
			if (e.type === 'location') {
				const ls = e.state as LocationEntryState | undefined;
				const recent = ls?.changes?.slice(-2).map(c => c.description).filter(Boolean) ?? [];
				if (recent.length > 0) lines.push(`Recent changes: ${recent.join('; ')}`);
			} else if (e.type === 'item') {
				const is = e.state as ItemEntryState | undefined;
				if (is?.condition) lines.push(`Condition: ${is.condition}`);
			} else if (e.type === 'event') {
				const es = e.state as EventEntryState | undefined;
				if (es?.occurred) lines.push('Status: has already occurred');
			} else if (e.type === 'concept') {
				const cs = e.state as ConceptEntryState | undefined;
				if (cs?.comprehensionLevel && cs.comprehensionLevel !== 'unknown') {
					lines.push(`Player comprehension: ${cs.comprehensionLevel}`);
				}
			} else if (e.type === 'character') {
				// Off-screen NPCs only — present + protagonist were de-duped out.
				const cs = e.state as CharacterEntryState | undefined;
				if (cs?.bio && !desc.includes(cs.bio.slice(0, 30))) lines.push(`Bio: ${cs.bio}`);
				if (cs?.motivations?.length) lines.push(`Motivations: ${cs.motivations.join('; ')}`);
				if (cs?.personality) lines.push(`Personality: ${cs.personality}`);
			}

			if (e.hiddenInfo) lines.push(`[Hidden — narrator-only]: ${e.hiddenInfo}`);
		}

		return lines.join('\n');
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

		const sorted = [...chapters].sort((a, b) => a.number - b.number);
		const coveredIds = new Set(snap.arcs.flatMap(a => a.chapterIds));
		// Always include the last 2 chapters even if covered by an arc — recency matters
		// more than the small token cost, and arc summaries lose the per-chapter emotional tone.
		const recent = sorted.slice(-2);
		const recentIds = new Set(recent.map(c => c.id));
		const uncovered = sorted.filter(c => c.pinned || !coveredIds.has(c.id));
		const merged = [
			...recent,
			...uncovered.filter(c => !recentIds.has(c.id)),
		].sort((a, b) => a.number - b.number);
		if (merged.length === 0) return '';

		const out: string[] = ['## Chapters'];
		for (const ch of merged) {
			out.push('', `**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**`);
			out.push(ch.summary);
			if (ch.emotionalTone) out.push(`[Tone: ${ch.emotionalTone}]`);
			if (ch.plotThreads?.length) out.push(`[Threads: ${ch.plotThreads.join(', ')}]`);
			if (ch.characters?.length) out.push(`[Characters: ${ch.characters.join(', ')}]`);
			if (ch.locations?.length) out.push(`[Locations: ${ch.locations.join(', ')}]`);
		}
		return out.join('\n');
	}

	// ── Section 6b: Chapter Opening (transient — fires on a fresh chapter) ──
	// When a chapter has just been created (the latest entries sit just past the
	// last chapter's endEntryId), nudge the narrator to re-establish pacing and
	// acknowledge the prior chapter's tone. Lives in the dynamic block so it
	// disappears once the new chapter is a few entries deep.
	#sectionChapterIntro(snap: StateSnapshot): string {
		const chapters = snap.chapters;
		if (chapters.length === 0) return '';
		const sorted = [...chapters].sort((a, b) => a.number - b.number);
		const last = sorted[sorted.length - 1];
		const lastEndIdx = this.entries.findIndex(e => e.id === last.endEntryId);
		// Entries authored AFTER the most-recent chapter ended.
		const entriesPast = lastEndIdx === -1 ? 0 : this.entries.length - 1 - lastEndIdx;
		if (entriesPast > 3) return '';

		const out: string[] = ['## Chapter Opening'];
		out.push(`A new chapter begins. The previous chapter, **Ch.${last.number}: ${last.title ?? 'Untitled'}**, has just closed.`);
		if (last.emotionalTone) out.push(`It ended on: ${last.emotionalTone}.`);
		if (last.summary) {
			// Last sentence of the prior summary as the "final beat" hook.
			const sentences = last.summary.split(/(?<=[.!?])\s+/).filter(Boolean);
			const finalBeat = sentences[sentences.length - 1] ?? last.summary.slice(-160);
			if (finalBeat && finalBeat.length <= 220) out.push(`Final beat: ${finalBeat}`);
		}
		// Diff against the chapter before that (if any) — what's changed?
		const prev = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
		if (prev) {
			const prevChars = new Set((prev.characters ?? []).map(s => s.toLowerCase()));
			const lastChars = new Set((last.characters ?? []).map(s => s.toLowerCase()));
			const dropped = (prev.characters ?? []).filter(c => !lastChars.has(c.toLowerCase()));
			const introduced = (last.characters ?? []).filter(c => !prevChars.has(c.toLowerCase()));
			if (dropped.length) out.push(`Off-stage: ${dropped.slice(0, 6).join(', ')}.`);
			if (introduced.length) out.push(`Recently surfaced: ${introduced.slice(0, 6).join(', ')}.`);
			const prevLocs = new Set((prev.locations ?? []).map(s => s.toLowerCase()));
			const newLocs = (last.locations ?? []).filter(l => !prevLocs.has(l.toLowerCase()));
			if (newLocs.length) out.push(`New setting: ${newLocs.slice(0, 4).join(', ')}.`);
		}
		out.push(`Re-establish pacing and refresh the setting through sensory detail. If time has passed, show it implicitly — do not narrate the gap.`);
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

	// ── Section 8b: Active Schemes (antagonist + player plans) ──────────────
	#sectionSchemes(): string {
		return injectSchemes(this.schemes);
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
		lines.push('FRICTION (read this twice):');
		lines.push('- You are NOT a wish-granting engine. Default response to a bold {{user}} ask is partial, conditional, deferred, or refused — not enthusiastic agreement.');
		lines.push('- NPCs are not auditioning to be allies. They have their own goals and frequently work against the player without realizing it.');
		lines.push("- If a scene ends with {{user}} getting everything they wanted, you wrote it wrong. Re-introduce a price, a delay, a doubt, or a hidden defection in the next turn.");
		lines.push('- Trust, alliance, marriage, and confession are paid for across multiple scenes. NEVER let an NPC pivot from suspicion to commitment inside a single conversation.');
		lines.push('- Major revelations (true identities, ancient debts, prophecies, supernatural pacts, dragon eggs hatching) are RARE — at most one per arc, and only after the player has paid for it in screen-time, sacrifice, or risk. Withhold the rest. Let them stew.');
		lines.push('- When {{user}} proposes a clever plan, surface at least one consequence they did not anticipate before the scene ends.');
		lines.push('');
		lines.push('CRITICAL: ALWAYS write narration prose FIRST. Tool calls without narration are a bug — the player must see story text every turn. Write the scene, then call `update_world_state` once at the end.');
		lines.push('');
		lines.push('CLOCK: Almost every turn moves time forward. Always include a `time_delta` (or, in prose-only mode, an explicit time marker like "an hour later"). The world stops breathing when the clock stops.');
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

		// Faction roster — score and pick the most narratively-relevant ones.
		// Always include factions with |playerStanding| >= 50; fill remaining slots
		// by score until cap of 6.
		const FACTION_CAP = 6;
		const currentChapter = chapters.length > 0 ? Math.max(...chapters.map(c => c.number ?? 0)) : 0;
		const factionActionNames = new Set(this.factionActions.map(fa => fa.factionName.toLowerCase()));
		const factionEntries = this.lorebookEntries.filter(e => e.type === 'faction' && !e.deleted);
		const scored = factionEntries.map(f => {
			const state = f.state as FactionEntryState | undefined;
			const standing = state?.playerStanding ?? 0;
			let score = Math.abs(standing);
			if (state?.lastActionChapter != null && currentChapter - state.lastActionChapter <= 3) score += 25;
			if (state?.status === 'allied' || state?.status === 'hostile') score += 15;
			if (factionActionNames.has(f.name.toLowerCase())) score += 20;
			return { faction: f, score, force: Math.abs(standing) >= 50 };
		});
		const forced = scored.filter(s => s.force);
		const others = scored.filter(s => !s.force).sort((a, b) => b.score - a.score);
		const relevantFactions = [...forced, ...others.slice(0, Math.max(0, FACTION_CAP - forced.length))]
			.sort((a, b) => b.score - a.score)
			.slice(0, FACTION_CAP)
			.map(s => s.faction);

		// Semantically retrieve lorebook entries relevant to the recent narrative.
		// Without this the narrator is blind to anything outside the current scene's
		// characters/factions — locations, items, concepts, off-screen NPCs etc.
		// Embeddings are pre-warmed by preEmbedLorebook() at story load.
		let retrievedEntries: Entry[] = [];
		try {
			const { ai } = await import('$lib/services/ai');
			const candidateEntries = this.lorebookEntries.filter(e => !e.deleted);
			if (candidateEntries.length > 0) {
				const result = await ai.entryRetrieval.retrieve(candidateEntries, this.entries, 12);
				const factionIds = new Set(relevantFactions.map(f => f.id));
				// Build the "already rendered" name set: present NPCs + the protagonist,
				// since the protagonist is dumped in the Header/Roles + Characters sections
				// and re-injecting them here is pure duplication.
				const presentNames = new Set(presentCharacters.map(c => c.name.toLowerCase()));
				const protagonistName = this.protagonist?.name?.toLowerCase();
				if (protagonistName) presentNames.add(protagonistName);
				retrievedEntries = result.entries
					.filter(e => !factionIds.has(e.id))
					.filter(e => {
						if (e.type !== 'character') return true;
						if (presentNames.has(e.name.toLowerCase())) return false;
						return !(e.aliases ?? []).some(a => presentNames.has(a.toLowerCase()));
					})
					.slice(0, 8);
			}
		} catch (e) {
			console.warn('[Story] entryRetrieval failed:', e);
		}

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
			relevantFactions,
			retrievedEntries,
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
	 * Same content as `buildSystemPrompt` but split into two halves so the
	 * stable head can be sent with an Anthropic prompt-cache breakpoint:
	 *
	 *   stable  = Header + Instructions + Tools         (~80% of turns are identical)
	 *   dynamic = Characters + Arcs + Chapters + Entry-History + Living-World + Final-Instructions
	 *
	 * Final Instructions stays in the `dynamic` block to preserve the
	 * "narrator reads directives last" ordering. We give up caching on it,
	 * but caching the front 60-70% of the prompt is the big cost win anyway.
	 */
	buildOrchestratorSystemBlocks(
		snapshot: StateSnapshot,
		opts: { useInlineTools?: boolean } = {},
	): { stable: string; dynamic: string } {
		const s = this.currentStory;
		if (!s) return { stable: '', dynamic: '' };

		const mode = s.mode ?? 'adventure';

		const stableParts: string[] = [];
		stableParts.push(this.#sectionHeader(s, mode));
		stableParts.push(this.#sectionInstructions(s, mode));
		if (mode === 'adventure') stableParts.push(this.#sectionTools(opts.useInlineTools ?? false));

		const dynamicParts: string[] = [];
		const chars = this.#sectionCharacters(s, snapshot);
		if (chars) dynamicParts.push(chars);
		const factions = this.#sectionFactions(s, snapshot);
		if (factions) dynamicParts.push(factions);
		const lore = this.#sectionLorebook(snapshot);
		if (lore) dynamicParts.push(lore);
		const arcs = this.#sectionArcs(snapshot);
		if (arcs) dynamicParts.push(arcs);
		const chapters = this.#sectionChapters(snapshot);
		if (chapters) dynamicParts.push(chapters);
		const chapterIntro = this.#sectionChapterIntro(snapshot);
		if (chapterIntro) dynamicParts.push(chapterIntro);
		dynamicParts.push(this.#sectionEntryHistoryPreamble(mode));
		const lw = this.#sectionLivingWorld(snapshot);
		if (lw) dynamicParts.push(lw);
		const schemes = this.#sectionSchemes();
		if (schemes) dynamicParts.push(schemes);
		dynamicParts.push(this.#sectionFinalInstructions(mode));

		let stable = stableParts.filter(Boolean).join('\n\n');
		let dynamic = dynamicParts.filter(Boolean).join('\n\n');

		// Resolve role tags in both halves
		if (mode === 'adventure') {
			const userName = this.protagonist?.name ?? 'the player';
			const resolveTags = (text: string) => text
				.replace(/\{\{user\}\}/g, userName)
				.replace(/\{\{char\}\}/g, 'NPCs')
				.replace(/\{\{world\}\}/g, 'the world');
			stable = resolveTags(stable);
			dynamic = resolveTags(dynamic);
		}

		return { stable, dynamic };
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

		const maxHistoryEntries = settings.uiSettings.maxHistoryEntries || 250;
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

		const maxMessages = settings.uiSettings.maxMessages || 250;
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

	async updateDescription(description: string | null) {
		if (!this.currentStory) return;
		const value = description?.trim() || null;
		await updateStory(this.currentStory.id, { description: value, updatedAt: Date.now() });
		this.currentStory = { ...this.currentStory, description: value };
	}

	/**
	 * Apply a batch of meter changes from update_world_state.
	 * Creates meters on first reference using the model-provided `initial`
	 * (defaults to 0 — low-is-bad meters like hunger/fatigue/suspicion are the
	 * common case; sanity/health-style meters MUST set initial=max). Then
	 * applies the delta on top, clamped into [0, max].
	 */
	async applyMeterChanges(changes: Array<{ name: string; delta: number; initial?: number; max?: number; visible?: boolean }>) {
		if (!this.currentStory || changes.length === 0) return;
		const meters = [...(this.currentStory.meters ?? [])];

		for (const change of changes) {
			if (!change.name) continue;
			const idx = meters.findIndex(m => m.name.toLowerCase() === change.name.toLowerCase());
			if (idx === -1) {
				const max = change.max && change.max > 0 ? change.max : 100;
				const base = change.initial ?? 0;
				meters.push({
					name: change.name,
					value: Math.max(0, Math.min(max, base + change.delta)),
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
