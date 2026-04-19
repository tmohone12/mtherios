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
} from '$lib/services/database';
import { uuid } from '$lib/utils/uuid';
import { countTokens } from '$lib/utils/tokens';
import type { Story, StoryEntry, Character, Location, Item, Entry, EntryRelationship, ConversationMemoryEntry, WorldEvent, FactionEntryState, EmbeddedImage } from '$lib/types';
import type { ChatMessage } from '$lib/services/ai/sdk/generate';
import { getModelContextWindow } from '$lib/services/ai/context/ContextAssembler';
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
	images = $state<EmbeddedImage[]>([]);
	loading = $state(false);
	private _entryLock: Promise<void> = Promise.resolve();
	lastWorldSimResult = $state<import('$lib/services/ai/sdk/schemas/worldsim').WorldSimulationResult & { seasonEffect?: import('$lib/services/ai/generation/WorldSimulationService').SeasonEffect } | null>(null);
	/** Micro-faction reactions pending injection into next narrator context */
	pendingFactionReactions = $state<import('$lib/services/ai/sdk/schemas/microfaction').MicroFactionResult[]>([]);
	/** Last known tier usage from ContextAssembler (updated each generation) */
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
			const [entries, characters, locations, items, lorebookEntries, entryRelationships, conversationMemories, worldEvents, images] = await Promise.all([
				getStoryEntries(storyId),
				getCharacters(storyId),
				getLocations(storyId),
				getItems(storyId),
				getLorebookEntries(storyId),
				getEntryRelationships(storyId),
				getConversationMemory(storyId),
				getWorldEvents(storyId),
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
	 * Build the system prompt for narrative generation.
	 * Core narrator instructions + pre-assembled context from ContextAssembler.
	 */
	buildSystemPrompt(contextBlock?: string): string {
		const s = this.currentStory;
		if (!s) return '';

		const mode = s.mode ?? 'adventure';
		const pov = s.settings?.pov ?? 'second';
		const tense = s.settings?.tense ?? 'present';
		const protagonist = this.protagonist;
		const tenseWord = tense === 'past' ? 'past' : 'present';
		const genre = s.genre ?? '';

		let prompt = '';

		// ── Per-story header prompt (preamble) ──
		if (s.headerPrompt) {
			prompt += s.headerPrompt + '\n\n';
		}

		// ── Compacted lore (button-controlled world state, highest attention weight) ──
		if (s.compactedLore) {
			prompt += `## World State\n\n${s.compactedLore}\n\n`;
		}

		// ── Core narrator instructions ──
		if (mode === 'adventure') {
			const userName = protagonist?.name ?? 'the player';
			const isThird = pov === 'third';
			const personLabel = isThird ? 'third person' : 'second person (you/your)';

			prompt += `You are the game master of an interactive text adventure. Write in ${tenseWord} tense, ${personLabel}.\n\n`;

			// ── Role tags: who controls what ──
			const desc = protagonist?.description ? ` — ${protagonist.description}` : '';
			prompt += `## Roles\n\n`;

			prompt += `**{{user}}** = ${userName}${desc}\n`;
			prompt += `The player. You NEVER speak, act, think, or move for {{user}}.\n`;
			prompt += `Lines starting with ">" are commands — interpret and narrate the result.\n\n`;

			prompt += `**{{char}}** = All NPCs. You control them — dialogue, actions, reactions.\n`;
			prompt += `Each has their own voice, agenda, and autonomy. They can refuse, lie, attack, or help.\n\n`;

			prompt += `**{{world}}** = Environment, weather, time, physics, consequences.\n`;
			prompt += `Sensory and immediate. The world remembers. Actions ripple.\n\n`;
		} else {
			prompt += `You are a skilled fiction writer. Write in ${tenseWord} tense, ${pov} person.\n\n`;
			if (protagonist) prompt += `The main character is ${protagonist.name}. ${protagonist.description ?? ''}\n`;
			prompt += `Write prose based on the author's directions.\n`;
		}

		// ── Genre & setting ──
		if (genre) prompt += `\nGenre: ${genre}\n`;
		if (s.description) prompt += `\nSetting: ${s.description}\n`;

		if (mode === 'adventure') {
			// ── Response rules ──
			prompt += `\n## Response Length\n`;
			prompt += `Match length to action weight: 1-2 sentences for routine, a paragraph for exploration, up to 3 for combat/drama. Conversation: let NPCs respond, then pause for {{user}}.\n`;
		} else {
			// ── Literary craft (creative writing mode) ──
			prompt += `\n## Craft\n`;
			prompt += `Show, never tell. Render scenes through specific sensory details, character actions, and environmental cues — not declarative statements. Ground abstract emotions in concrete experience: the quality of light, texture of air, the weight of silence. Trust readers to perceive depths without over-explanation.\n\n`;
			prompt += `Vary sentence rhythm deliberately. Short sentences for punch. Longer, flowing constructions to build atmosphere. Fragments for emphasis. Control tension through sentence length, paragraph breaks, and scene cuts.\n\n`;
			prompt += `Choose the exact word, not its cousin — "trudged" vs "walked" vs "strode" each paint different worlds. Write fresh, unexpected imagery that illuminates rather than decorates. Embed subtext beneath dialogue and action; characters rarely say exactly what they mean.\n\n`;
			prompt += `Dialogue must sound like real speech: distinct voices, natural hesitations, interruptions, the music of how each character talks. No character should be interchangeable with another.\n\n`;

			// ── Genre-adaptive sophistication (creative writing only) ──
			if (genre) {
				const g = genre.toLowerCase();
				if (g.includes('literary') || g.includes('drama')) {
					prompt += `This is literary fiction. Favor dense imagery, psychological complexity, and layered meaning. Let structure and prose style carry thematic weight.\n\n`;
				} else if (g.includes('horror') || g.includes('thriller') || g.includes('mystery')) {
					prompt += `Build dread through implication, not declaration. Let the unseen carry more weight than the shown. Pacing is everything — draw out tension, then cut.\n\n`;
				} else if (g.includes('comedy') || g.includes('humor') || g.includes('satire')) {
					prompt += `Humor lives in timing, specificity, and the gap between expectation and reality. Never signal that something is funny — just be funny.\n\n`;
				} else if (g.includes('romance')) {
					prompt += `Tension lives in proximity, longing, and the unsaid. Physical chemistry is shown through involuntary reactions — breath catching, awareness of warmth, the charged distance between bodies.\n\n`;
				}
			}

			prompt += `AVOID:\n`;
			prompt += `- Purple prose that sacrifices clarity for flourish\n`;
			prompt += `- Naming emotions directly ("she felt sad") instead of showing their physical manifestations\n`;
			prompt += `- Clichéd phrases that deaden impact ("a chill ran down their spine", "time seemed to stop")\n`;
			prompt += `- Over-explaining what readers can infer from context\n`;
			prompt += `- Inconsistent voice or sudden unearned style shifts\n`;

			prompt += `\n## Structure\n`;
			prompt += `- Write 2-4 paragraphs per response\n`;
			prompt += `- End at a moment that invites the next action\n`;
			prompt += `- Stay consistent with established world facts\n`;
		}

		// ── Dice rolls (adventure mode) ──
		if (mode === 'adventure') {
			prompt += `\n## Dice Rolls\n`;
			prompt += `When the outcome is genuinely uncertain, output a roll marker at the END of your response:\n\n`;
			prompt += `{{roll:DICE:DC:ABILITY:DESCRIPTION}}\n\n`;
			prompt += `DICE = D&D notation (1d20, 1d20+3). DC = standard difficulty. ABILITY = STR/DEX/CON/INT/WIS/CHA.\n`;
			prompt += `STOP writing after the marker. Most turns should have no roll.\n`;
			prompt += `If {{user}} includes a roll result like "[Roll: 1d20+3 = 17 vs DC 14 — SUCCESS]", narrate the outcome accordingly.\n`;
		}

		// ── Assembled context (scene, chapters, arcs, lore, retrieved memory) ──
		if (contextBlock) {
			prompt += '\n' + contextBlock;
		}

		// ── Final directions (last thing the narrator reads before generating) ──
		if (mode === 'adventure') {
			prompt += `\n═══ FINAL DIRECTIONS ═══\n\n`;
			prompt += `You are a TEXT ADVENTURE game master. Not a novelist. Not a storyteller. A reactive GM.\n\n`;
			prompt += `AGENCY:\n`;
			prompt += `- {{user}} controls their character. You control everything else.\n`;
			prompt += `- NEVER write {{user}}'s dialogue, thoughts, decisions, or actions.\n`;
			prompt += `- NEVER move {{user}} unless they said to move.\n`;
			prompt += `- NEVER skip ahead. One action → one immediate result.\n`;
			prompt += `- STOP when {{user}} needs to choose what to do next.\n\n`;
			prompt += `FORMAT:\n`;
			prompt += `- Write plain prose. No > action lines. No markdown headers. No meta-commentary.\n`;
			prompt += `- Dialogue in "quotes". Actions in plain text.\n`;
			prompt += `- Short for simple actions. Longer for complex scenes. Never padded.\n\n`;
			prompt += `WORLD:\n`;
			prompt += `- Describe what {{user}} can SEE, HEAR, SMELL, FEEL — not what they think or feel about it.\n`;
			prompt += `- NPCs act on their own motivations. They can lie, refuse, attack, flee, or help.\n`;
			prompt += `- NPCs remember past interactions. Reference what they know.\n`;
			prompt += `- Consequences are real. The world does not reset.\n`;
			prompt += `- Write with weight. Every choice has a cost. NPCs have their own agendas and survival instincts.\n`;
			prompt += `- Don't pull punches. If the player walks into a trap, spring it. If an ally is outnumbered, they can die.\n`;
			prompt += `- Favor gritty specificity over generic fantasy: the smell of a wound, the sound of rain on mail, the taste of stale bread.\n`;
			prompt += `- Let silence and implication do work. Not every threat needs to be stated. A lord's pause before answering says more than a speech.\n`;
		}

		// ── Resolve role tags ──
		if (mode === 'adventure') {
			const userName = protagonist?.name ?? 'the player';
			prompt = prompt
				.replace(/\{\{user\}\}/g, userName)
				.replace(/\{\{char\}\}/g, 'NPCs')
				.replace(/\{\{world\}\}/g, 'the world');
		}

		return prompt;
	}

	/**
	 * Build a state snapshot for the orchestrator path.
	 * Includes arc history, recent chapter summaries, and current world state.
	 */
	async buildStateSnapshot(): Promise<string> {
		const s = this.currentStory;
		if (!s) return '';

		const parts: string[] = [];

		// ── Arc history (compressed long-term memory) ──
		// Recent arcs get full detail; older arcs get a one-line summary to save tokens.
		try {
			const arcs = await getArcs(s.id);
			if (arcs.length > 0) {
				const FULL_ARC_COUNT = 5;
				let arcBlock = '## Story History\n';

				// Older arcs: one-liner each
				if (arcs.length > FULL_ARC_COUNT) {
					const older = arcs.slice(0, arcs.length - FULL_ARC_COUNT);
					arcBlock += '\n### Earlier Arcs (condensed)\n';
					for (const arc of older) {
						arcBlock += `- **Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange}) — ${arc.summary.slice(0, 150)}...\n`;
					}
				}

				// Recent arcs: full detail
				const recent = arcs.slice(-FULL_ARC_COUNT);
				arcBlock += '\n### Recent Arcs\n';
				for (const arc of recent) {
					arcBlock += `\n**Arc ${arc.arcNumber}: ${arc.title}** (Ch.${arc.chapterRange})\n`;
					arcBlock += arc.summary + '\n';
					if (arc.keyPlotPoints?.length) arcBlock += `Key events: ${arc.keyPlotPoints.join('; ')}\n`;
					if (arc.characterArcs?.length) arcBlock += `Character development: ${arc.characterArcs.map(ca => `${ca.name}: ${ca.development}`).join('; ')}\n`;
				}

				const allThreads = arcs.flatMap(a => a.unresolvedThreads).filter(Boolean);
				if (allThreads.length > 0) {
					arcBlock += `\n**Open threads:** ${allThreads.join('; ')}\n`;
				}
				parts.push(arcBlock);
			}
		} catch { /* skip if unavailable */ }

		// ── Recent chapters (uncovered by arcs) ──
		try {
			const chapters = await getChapters(s.id);
			const arcs = await getArcs(s.id);
			if (chapters.length > 0) {
				const coveredIds = new Set(arcs.flatMap(a => a.chapterIds));
				const uncovered = chapters
					.filter(c => c.pinned || !coveredIds.has(c.id))
					.sort((a, b) => a.number - b.number);

				if (uncovered.length > 0) {
					let chBlock = '## Recent Story\n';
					for (const ch of uncovered) {
						chBlock += `\n**Ch.${ch.number}: ${ch.title ?? 'Untitled'}**\n${ch.summary}\n`;
						if (ch.emotionalTone) chBlock += `[Tone: ${ch.emotionalTone}]\n`;
						if (ch.plotThreads?.length) chBlock += `[Threads: ${ch.plotThreads.join(', ')}]\n`;
						if (ch.characters?.length) chBlock += `[Characters: ${ch.characters.join(', ')}]\n`;
						if (ch.locations?.length) chBlock += `[Locations: ${ch.locations.join(', ')}]\n`;
					}
					parts.push(chBlock);
				}
			}
		} catch { /* skip if unavailable */ }

		// ── World simulation (DM plot injection, rumors, faction moves) ──
		const ws = this.lastWorldSimResult;
		if (ws) {
			let wsBlock = '';

			if (ws.worldNarrative) {
				wsBlock += `[WORLD STATE] ${ws.worldNarrative}\n`;
			}

			if (ws.plotInjection) {
				const pi = ws.plotInjection;
				const urgencyLabel = pi.urgency === 'immediate' ? 'WEAVE THIS INTO THE NEXT RESPONSE'
					: pi.urgency === 'emerging' ? 'INTRODUCE THIS SOON'
					: 'SUBTLY HINT AT THIS';
				wsBlock += `\n[DM PLOT INJECTION — ${urgencyLabel}]\n`;
				wsBlock += pi.prose + '\n';
				if (pi.narratorDirective) wsBlock += `[How: ${pi.narratorDirective}]\n`;
			}

			if (ws.rumors && ws.rumors.length > 0) {
				const currentLocName = (this.locations.find(l => l.current)?.name ?? '').toLowerCase();
				const reachable = ws.rumors.filter(rumor => {
					if (rumor.spreadRadius === 'continental' || rumor.spreadRadius === 'regional') return true;
					if (rumor.spreadRadius === 'local') {
						const origin = rumor.originRegion.toLowerCase();
						return currentLocName.includes(origin) || origin.includes(currentLocName);
					}
					return false;
				});
				if (reachable.length > 0) {
					wsBlock += '\n[RUMORS & WHISPERS — weave as NPC dialogue, tavern gossip, overheard conversation]\n';
					for (const rumor of reachable) {
						const tag = rumor.truthfulness >= 0.7 ? 'reliable'
							: rumor.truthfulness >= 0.4 ? 'uncertain' : 'dubious';
						wsBlock += `- (${tag}, via ${rumor.sourceType}) ${rumor.content}\n`;
					}
				}
			}

			if (ws.worldTension >= 7) {
				wsBlock += `\n[WORLD TENSION: HIGH (${ws.worldTension}/10) — unease, nervous NPCs, doubled guards]\n`;
			} else if (ws.worldTension >= 4) {
				wsBlock += `\n[WORLD TENSION: MODERATE (${ws.worldTension}/10) — undercurrents of unrest, hushed talk]\n`;
			}

			if (ws.seasonEffect?.narrativeNote) {
				wsBlock += `\n[SEASON] ${ws.seasonEffect.narrativeNote}\n`;
			}

			if (ws.plotSeeds && ws.plotSeeds.length > 0) {
				wsBlock += '\n[FACTION PLOT SEEDS — plant subtly, do not force]\n';
				for (const seed of ws.plotSeeds) wsBlock += `- ${seed}\n`;
			}

			if (wsBlock) parts.push(wsBlock);
		}

		// Micro-faction reactions
		if (this.pendingFactionReactions.length > 0) {
			const visible = this.pendingFactionReactions.filter(r => r.reaction.visible || r.reaction.rumor);
			if (visible.length > 0) {
				let frBlock = '[RECENT FACTION MOVES — weave naturally, not all at once]\n';
				for (const r of visible) {
					if (r.reaction.rumor) {
						frBlock += `- (rumor) ${r.reaction.rumor}\n`;
					} else if (r.reaction.visible) {
						frBlock += `- ${r.factionName}: ${r.reaction.action}\n`;
					}
					if (r.reaction.consequence) {
						frBlock += `  → ${r.reaction.consequence}\n`;
					}
				}
				parts.push(frBlock);
			}
		}

		// Recent world events (consequence system)
		const recentEvents = this.worldEvents
			.filter(e => e.appliedAt != null)
			.sort((a, b) => (b.appliedAt ?? 0) - (a.appliedAt ?? 0))
			.slice(0, 5);
		if (recentEvents.length > 0) {
			let evBlock = '**Recent World Events:**\n';
			for (const event of recentEvents) {
				evBlock += `- ${event.name}: ${event.description}\n`;
				const applied = event.consequences.filter(c => c.status === 'applied');
				for (const c of applied) {
					evBlock += `  → ${c.description}\n`;
				}
			}
			parts.push(evBlock);
		}

		// ── Current world state ──
		const lines: string[] = ['## World State (current)\n'];

		// Current location
		const currentLoc = this.locations.find(l => l.current);
		if (currentLoc) {
			lines.push(`Location: ${currentLoc.name}${currentLoc.description ? ' — ' + currentLoc.description : ''}`);
		}

		// Present characters (max 6)
		const present = this.characters
			.filter(c => c.status === 'active' && c.relationship !== 'self')
			.slice(0, 6);
		if (present.length > 0) {
			const charList = present.map(c => {
				let label = c.name;
				if (c.relationship) label += ` (${c.relationship})`;
				return label;
			}).join('; ');
			lines.push(`Characters present: ${charList}`);
		}

		// Protagonist
		const protag = this.protagonist;
		if (protag) {
			lines.push(`Protagonist: ${protag.name}${protag.description ? ' — ' + protag.description : ''}`);
		}

		// Equipped items
		const equipped = this.items.filter(i => i.equipped);
		if (equipped.length > 0) {
			lines.push(`Inventory: ${equipped.map(i => i.name).join(', ')}`);
		}

		// Time tracker
		const t = s.timeTracker;
		if (t) {
			const pad = (n: number) => String(n).padStart(2, '0');
			lines.push(`Time: Day ${t.days}, ${pad(t.hours)}:${pad(t.minutes)}`);
		}

		// Recent story beats (last 2)
		try {
			const beats = await getStoryBeats(s.id);
			const recent = beats.filter(b => b.status === 'active').slice(-2);
			if (recent.length > 0) {
				lines.push(`Recent events: ${recent.map(b => b.title).join('; ')}`);
			}
		} catch { /* skip if unavailable */ }

		parts.push(lines.join('\n'));

		const result = parts.join('\n\n');

		// Optional snapshot cap from settings (0 = unlimited, context window is the limit)
		const snapshotCap = settings.uiSettings.snapshotTokenCap || 0;
		if (snapshotCap > 0) {
			const maxChars = snapshotCap * 4;
			if (result.length > maxChars) {
				return result.slice(0, maxChars);
			}
		}

		return result;
	}

	/**
	 * Build the system prompt for orchestrator mode.
	 * Same as buildSystemPrompt but uses a lightweight state snapshot
	 * instead of the full ContextAssembler output, and appends tool instructions.
	 */
	buildOrchestratorSystemPrompt(stateSnapshot: string): string {
		// Reuse the standard prompt with the snapshot as the context block
		const basePrompt = this.buildSystemPrompt(stateSnapshot);

		// Append tool-usage instructions
		const toolInstructions = `
## Your Tools
After generating your narrative response, you MUST call \`update_world_state\` to record any changes from this scene (characters, locations, items, time, conversations, relationships, story beats).
Before narrating about lore-heavy topics, call \`query_lore\` to check your facts.
When introducing new named entities (characters, locations, factions), call \`create_lore_entry\` to register them.
`;
		return basePrompt + toolInstructions;
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
		this.images = [];
		this.lastWorldSimResult = null;
		this.lastTierUsage = null;
		this.lastContextTotal = 0;
		this.chatHistoryFloor = 0;
	}
}

export const story = new StoryStore();
