/**
 * Tool Executor — Mtherios Orchestrator
 *
 * Routes GM tool calls to store/database mutations.
 * Replaces GenerationPipeline Phase 1 (classification + state sync).
 * No AI inference happens here — all data comes pre-structured from the LLM.
 */

import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { ai } from '$lib/services/ai';
import { uuid } from '$lib/utils/uuid';
import {
	createLorebookEntry, updateLorebookEntry,
	createEntryRelationship, getRelationshipsForEntry, updateEntryRelationship,
	createConversationMemory, createWorldEvent, updateWorldEvent, createStoryBeat,
	updateStory, getChapters, getArcs,
} from '$lib/services/database';
import {
	parseTimeProgression, advanceTime, clamp,
	makeLoreEntry, WORLD_SIM_DAY_INTERVAL,
} from './helpers';
import {
	worldStateUpdateSchema, queryLoreArgsSchema, createLoreEntryArgsSchema,
	type WorldStateUpdate, type QueryLoreArgs, type CreateLoreEntryArgs,
} from './schemas';
import type {
	Entry, EntryRelationship, WorldEvent, Consequence,
	CharacterEntryState, LocationEntryState, LocationConnection,
	FactionEntryState,
} from '$lib/types';

// ── Main router ──

export async function executeToolCall(
	name: string,
	args: Record<string, any>,
): Promise<string> {
	switch (name) {
		case 'update_world_state': {
			const parsed = worldStateUpdateSchema.safeParse(args);
			if (!parsed.success) {
				console.error('[Executor] Invalid update_world_state args:', parsed.error);
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			await handleWorldStateUpdate(parsed.data);
			return JSON.stringify({ success: true });
		}
		case 'query_lore': {
			const parsed = queryLoreArgsSchema.safeParse(args);
			if (!parsed.success) return JSON.stringify({ error: 'Invalid query_lore args' });
			return await handleQueryLore(parsed.data);
		}
		case 'create_lore_entry': {
			const parsed = createLoreEntryArgsSchema.safeParse(args);
			if (!parsed.success) return JSON.stringify({ error: 'Invalid create_lore_entry args' });
			return await handleCreateLoreEntry(parsed.data);
		}
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}

// ══════════════════════════════════════════════════════════════
// update_world_state — replaces ClassifierService + Pipeline Phase 1
// ══════════════════════════════════════════════════════════════

async function handleWorldStateUpdate(args: WorldStateUpdate): Promise<void> {
	if (!story.currentStory) return;

	const existingLoreNames = new Set(story.lorebookEntries.map(e => e.name.toLowerCase()));
	const protagonistName = story.protagonist?.name?.toLowerCase();

	// ── Characters ──
	for (const char of args.characters) {
		if (!char.name) continue;

		const exists = story.characters.some(c => c.name.toLowerCase() === char.name.toLowerCase());
		if (exists) {
			await story.updateCharacterFromClassification(char.name, {
				description: char.description,
				relationship: char.relationship,
				status: char.status,
				traits: char.traits,
			});
		} else {
			await story.addCharacter(char.name, char.description ?? undefined, char.relationship ?? undefined);
		}

		// Auto-create lorebook entry
		if (char.name.toLowerCase() !== protagonistName && !existingLoreNames.has(char.name.toLowerCase())) {
			const entry = makeLoreEntry(
				story.currentStory.id, char.name, 'character',
				char.description || 'Character encountered in the story.',
				[char.name.toLowerCase()],
			);
			await createLorebookEntry(entry);
			story.lorebookEntries = [...story.lorebookEntries, entry];
			existingLoreNames.add(char.name.toLowerCase());
		}
	}

	// Presence tracking — departed/deceased characters
	const departedNames = args.characters
		.filter(c => c.name && (c.status === 'departed' || c.status === 'deceased'))
		.map(c => c.name);
	if (departedNames.length > 0) await story.clearPresenceForCharacters(departedNames);

	// ── Locations ──
	// Enforce single current location
	const currentLocations = args.locations.filter(l => l.current);
	if (currentLocations.length > 1) {
		for (const loc of args.locations) {
			if (loc.current && loc !== currentLocations[currentLocations.length - 1]) {
				loc.current = false;
			}
		}
	}

	for (const loc of args.locations) {
		if (!loc.name) continue;
		await story.addOrUpdateLocation(loc.name, loc.description, loc.current);

		// Auto-create lorebook entry
		if (!existingLoreNames.has(loc.name.toLowerCase())) {
			const entry = makeLoreEntry(
				story.currentStory.id, loc.name, 'location',
				loc.description || 'Location encountered in the story.',
				[loc.name.toLowerCase()],
			);
			await createLorebookEntry(entry);
			story.lorebookEntries = [...story.lorebookEntries, entry];
			existingLoreNames.add(loc.name.toLowerCase());
		}

		// Location connections
		if (loc.connections?.length) {
			await syncLocationConnections(loc.name, loc.connections);
		}
	}

	// Update presence for active characters at current location
	const currentLoc = args.locations.find(l => l.current);
	if (currentLoc) {
		const presentNames = args.characters.filter(c => c.name && c.status === 'active').map(c => c.name);
		if (presentNames.length > 0) await story.updatePresence(presentNames, currentLoc.name);
	}

	// ── Items ──
	for (const item of args.items) {
		if (!item.name) continue;
		await story.addOrUpdateItem(item.name, item.description, item.quantity, item.equipped, item.location ?? undefined);

		// Auto-create lorebook entry
		if (!existingLoreNames.has(item.name.toLowerCase())) {
			const entry = makeLoreEntry(
				story.currentStory.id, item.name, 'item',
				item.description || 'Item encountered in the story.',
				[item.name.toLowerCase()],
			);
			await createLorebookEntry(entry);
			story.lorebookEntries = [...story.lorebookEntries, entry];
			existingLoreNames.add(item.name.toLowerCase());
		}
	}

	// ── Time progression ──
	if (args.time_delta) {
		await applyTimeProgression(args.time_delta);
	}

	// ── Conversations ──
	if (args.conversations.length > 0) {
		const lastEntry = story.entries[story.entries.length - 1];
		if (lastEntry) {
			await syncConversationMemory(args.conversations, lastEntry);
		}
	}

	// ── Relationships ──
	if (args.relationships.length > 0) {
		await syncRelationships(args.relationships);
	}

	// ── Story beats ──
	for (const beat of args.story_beats) {
		if (!beat.title) continue;
		const type = beat.significance === 'critical' ? 'plot_point'
			: beat.significance === 'major' ? 'revelation'
			: beat.significance === 'moderate' ? 'milestone'
			: 'event' as const;
		await createStoryBeat({
			id: uuid(), storyId: story.currentStory.id,
			title: beat.title, description: beat.description,
			type, significance: beat.significance ?? null, status: 'active',
			triggeredAt: Date.now(), resolvedAt: null,
			metadata: { mood: args.mood ?? null },
			branchId: story.currentStory.currentBranchId ?? null,
		});
	}

	// ── Consequences (death → faction hostility) ──
	await evaluateConsequences(args.characters);

	// ── Pre-embed lorebook (background) ──
	story.preEmbedLorebook().catch(e => console.warn('[Executor] preEmbedLorebook failed:', e));
}

// ── Location connections ──

async function syncLocationConnections(
	sourceName: string,
	connections: Array<{ targetName: string; direction?: string | null; travelTimeMinutes?: number }>,
): Promise<void> {
	if (!story.currentStory) return;

	const locationsByName = new Map<string, Entry>();
	for (const e of story.lorebookEntries) {
		if (e.type === 'location') locationsByName.set(e.name.toLowerCase(), e);
	}

	const sourceEntry = locationsByName.get(sourceName.toLowerCase());
	if (!sourceEntry) return;

	const state = { ...(sourceEntry.state as LocationEntryState) };
	const conns: LocationConnection[] = state.connections ? [...state.connections] : [];
	let changed = false;

	for (const conn of connections) {
		const targetEntry = locationsByName.get(conn.targetName.toLowerCase());
		if (!targetEntry) continue;
		if (conns.some(c => c.targetLocationId === targetEntry.id)) continue;
		conns.push({
			targetLocationId: targetEntry.id, targetLocationName: targetEntry.name,
			direction: conn.direction ?? null, travelTime: conn.travelTimeMinutes ?? 0,
			description: null, blocked: false, blockedReason: null,
		});
		changed = true;
	}

	if (changed) {
		state.connections = conns;
		await updateLorebookEntry(sourceEntry.id, { state: state as any, updatedAt: Date.now() });
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === sourceEntry.id ? { ...e, state: state as any } : e
		);
	}
}

// ── Conversation memory ──

async function syncConversationMemory(
	conversations: WorldStateUpdate['conversations'],
	narrativeEntry: { id: string; position: number },
): Promise<void> {
	if (!story.currentStory) return;
	const updatedEntries = new Map<string, Entry>();

	for (const conv of conversations) {
		const npcEntry = story.lorebookEntries.find(
			e => e.type === 'character' && e.name.toLowerCase() === conv.npcName.toLowerCase()
		);
		if (!npcEntry) continue;

		await createConversationMemory({
			id: uuid(), storyId: story.currentStory.id,
			npcEntryId: npcEntry.id, npcName: conv.npcName,
			storyEntryId: narrativeEntry.id, storyPosition: narrativeEntry.position,
			topic: conv.topicSummary, playerSaid: conv.playerRevealed.join('; '),
			npcLearned: conv.npcLearned, emotionalImpact: conv.emotionalShift,
			importance: 'minor', createdAt: Date.now(),
		});

		const cState = { ...(npcEntry.state as CharacterEntryState) };
		cState.knownFacts = [...new Set([...(cState.knownFacts ?? []), ...conv.npcLearned])];
		cState.conversationTopics = [...new Set([...(cState.conversationTopics ?? []), conv.topicSummary])];
		cState.lastConversationAt = narrativeEntry.position;
		if (conv.emotionalShift) cState.personalOpinion = conv.emotionalShift;
		await updateLorebookEntry(npcEntry.id, { state: cState as any, updatedAt: Date.now() });
		updatedEntries.set(npcEntry.id, { ...npcEntry, state: cState as any });
	}

	if (updatedEntries.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
	}
}

// ── Relationships ──

async function syncRelationships(
	relationships: WorldStateUpdate['relationships'],
): Promise<void> {
	if (!story.currentStory) return;
	const entries = story.lorebookEntries;

	const entryByName = new Map<string, Entry>();
	for (const e of entries) entryByName.set(e.name.toLowerCase(), e);

	// Batch-load existing relationships
	const sourceIds = new Set<string>();
	for (const rel of relationships) {
		const source = entryByName.get(rel.sourceName.toLowerCase());
		if (source) sourceIds.add(source.id);
	}
	const allRels = new Map<string, EntryRelationship[]>();
	await Promise.all([...sourceIds].map(async (id) => {
		const rels = await getRelationshipsForEntry(story.currentStory!.id, id);
		allRels.set(id, rels);
	}));

	const newRels: EntryRelationship[] = [];
	for (const rel of relationships) {
		const source = entryByName.get(rel.sourceName.toLowerCase());
		const target = entryByName.get(rel.targetName.toLowerCase());
		if (!source || !target) continue;

		const existing = allRels.get(source.id) ?? [];
		const dupe = existing.find(r => r.targetEntryId === target.id && r.type === rel.type);
		if (dupe) {
			await updateEntryRelationship(dupe.id, { strength: rel.strength, updatedAt: Date.now() });
			continue;
		}

		const newRel: EntryRelationship = {
			id: uuid(), storyId: story.currentStory!.id,
			sourceEntryId: source.id, targetEntryId: target.id,
			type: rel.type, label: rel.label ?? null, strength: rel.strength ?? 50,
			bidirectional: rel.bidirectional ?? false, metadata: null,
			createdAt: Date.now(), updatedAt: Date.now(),
		};
		await createEntryRelationship(newRel);
		newRels.push(newRel);
	}

	if (newRels.length > 0) {
		story.entryRelationships = [...story.entryRelationships, ...newRels];
	}
}

// ── Time progression ──

async function applyTimeProgression(progression: string): Promise<void> {
	if (!story.currentStory) return;
	const deltaMinutes = parseTimeProgression(progression);
	if (deltaMinutes === 0) return;

	const newTracker = advanceTime(story.currentStory.timeTracker ?? null, deltaMinutes);
	await updateStory(story.currentStory.id, { timeTracker: newTracker } as any);
	story.currentStory = { ...story.currentStory, timeTracker: newTracker };

	// World sim: fire every N in-world days
	const totalDays = newTracker.years * 365 + newTracker.days;
	const lastSimDay = story.currentStory.lastWorldSimDay ?? 0;
	if (totalDays - lastSimDay >= WORLD_SIM_DAY_INTERVAL) {
		const wsConfig = settings.getServiceConfig('worldSimulation');
		if (wsConfig.enabled) {
			try {
				const chapters = await getChapters(story.currentStory.id);
				const arcs = await getArcs(story.currentStory.id);
				const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
				const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');

				const result = await ai.worldSim.simulate(
					chapters, arcs, story.entries, factionEntries, characterEntries,
					story.entryRelationships, story.currentStory.timeTracker,
					story.storyMode, story.pov, story.tense,
				);
				story.lastWorldSimResult = result;

				await updateStory(story.currentStory.id, { lastWorldSimDay: totalDays } as any);
				story.currentStory = { ...story.currentStory, lastWorldSimDay: totalDays };
				console.log(`[Executor] World sim triggered at day ${totalDays}`);
			} catch (e) {
				console.error('[Executor] Time-based world sim failed:', e);
			}
		}
	}
}

// ── Consequences (death → faction hostility) ──

async function evaluateConsequences(
	characters: WorldStateUpdate['characters'],
): Promise<void> {
	if (!story.currentStory) return;
	const lastEntry = story.entries[story.entries.length - 1];
	if (!lastEntry) return;

	const newEvents: WorldEvent[] = [];

	for (const c of characters) {
		if (c.status !== 'deceased') continue;
		const charEntry = story.lorebookEntries.find(
			e => e.type === 'character' && e.name.toLowerCase() === c.name.toLowerCase()
		);
		if (!charEntry) continue;

		const rels = await getRelationshipsForEntry(story.currentStory.id, charEntry.id);
		const factionRels = rels.filter(r => r.type === 'member-of' || r.type === 'serves' || r.type === 'leader-of');

		const consequences: Consequence[] = [];
		for (const rel of factionRels) {
			const factionEntry = story.lorebookEntries.find(e => e.id === rel.targetEntryId && e.type === 'faction');
			if (!factionEntry) continue;
			const impact = rel.type === 'leader-of' ? -40 : -20;
			consequences.push({
				id: uuid(),
				description: `${factionEntry.name} turns hostile after ${c.name}'s death`,
				status: 'pending',
				targetEntityId: factionEntry.id,
				targetEntityName: factionEntry.name,
				effectType: 'faction_status_change',
				effectPayload: { playerStandingDelta: impact },
				delay: 0,
				appliedAt: null,
			});
		}

		if (consequences.length > 0) {
			const event: WorldEvent = {
				id: uuid(), storyId: story.currentStory.id,
				name: `${c.name} killed`,
				description: `${c.name} has been killed, triggering faction consequences.`,
				triggerEntryId: lastEntry.id, triggerPosition: lastEntry.position,
				sourceEntityId: charEntry.id, type: 'death', severity: 'major',
				consequences, appliedAt: null, createdAt: Date.now(),
			};
			await createWorldEvent(event);
			newEvents.push(event);

			// Apply immediate consequences
			for (const cons of consequences) {
				if (cons.delay === 0) await applyConsequence(cons, event.id);
			}

			// Persist applied consequence statuses
			await updateWorldEvent(event.id, { consequences: event.consequences });
		}
	}

	if (newEvents.length > 0) {
		story.worldEvents = [...story.worldEvents, ...newEvents];
	}
}

async function applyConsequence(consequence: Consequence, eventId: string): Promise<void> {
	if (!story.currentStory) return;
	consequence.status = 'applied';
	consequence.appliedAt = Date.now();

	if (consequence.effectType === 'faction_status_change' && consequence.targetEntityId) {
		const entry = story.lorebookEntries.find(e => e.id === consequence.targetEntityId);
		if (!entry || entry.type !== 'faction') return;
		const state = { ...(entry.state as FactionEntryState) };
		const payload = consequence.effectPayload as { playerStandingDelta?: number };
		if (payload.playerStandingDelta) {
			state.playerStanding = clamp(state.playerStanding + payload.playerStandingDelta, -100, 100);
		}
		if (state.playerStanding <= -50) state.status = 'hostile';
		else if (state.playerStanding >= 50) state.status = 'allied';
		await updateLorebookEntry(entry.id, { state: state as any, updatedAt: Date.now() });
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === entry.id ? { ...e, state: state as any } : e
		);
	}
}

// ══════════════════════════════════════════════════════════════
// query_lore — uses EmbeddingService for semantic search
// ══════════════════════════════════════════════════════════════

async function handleQueryLore(args: QueryLoreArgs): Promise<string> {
	const allEntries = story.lorebookEntries;
	const filtered = args.type_filter
		? allEntries.filter(e => e.type === args.type_filter)
		: allEntries;

	// Try embedding-based search first
	try {
		const items = filtered.map(e => ({
			id: e.id,
			text: `${e.name}: ${e.description ?? ''}`,
			sourceType: 'lorebook' as const,
		}));
		const results = await ai.embeddings.scoreSimilarity(args.query, items);
		const entryById = new Map(filtered.map(e => [e.id, e]));
		const topResults = results.slice(0, 5);
		return JSON.stringify(topResults.map(r => {
			const entry = entryById.get(r.id);
			return {
				name: entry?.name,
				type: entry?.type,
				description: entry?.description,
				score: r.score,
			};
		}));
	} catch {
		// Fallback to keyword matching
		const query = args.query.toLowerCase();
		const matches = filtered
			.filter(e =>
				e.name.toLowerCase().includes(query) ||
				e.description?.toLowerCase().includes(query) ||
				e.injection?.keywords?.some(k => k.toLowerCase().includes(query))
			)
			.slice(0, 5);
		return JSON.stringify(matches.map(e => ({
			name: e.name,
			type: e.type,
			description: e.description,
		})));
	}
}

// ══════════════════════════════════════════════════════════════
// create_lore_entry — register new entities
// ══════════════════════════════════════════════════════════════

async function handleCreateLoreEntry(args: CreateLoreEntryArgs): Promise<string> {
	if (!story.currentStory) return JSON.stringify({ error: 'No active story' });

	// Check for duplicates
	const existing = story.lorebookEntries.find(
		e => e.name.toLowerCase() === args.name.toLowerCase()
	);
	if (existing) {
		return JSON.stringify({ status: 'already_exists', id: existing.id });
	}

	const entry = makeLoreEntry(
		story.currentStory.id,
		args.name,
		args.type,
		args.description,
		args.keywords.length > 0 ? args.keywords : [args.name.toLowerCase()],
	);

	if (args.hidden_info) {
		entry.hiddenInfo = args.hidden_info;
	}

	await createLorebookEntry(entry);
	story.lorebookEntries = [...story.lorebookEntries, entry];

	return JSON.stringify({ status: 'created', id: entry.id });
}
