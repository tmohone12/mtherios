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
	bulkPutFactionActions, bulkPutRumors, updateRumor,
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
	FactionEntryState, FactionActionRecord, RumorRecord,
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
			// Brand-new characters skip the status/traits processing in addCharacter,
			// so a "newly-introduced and departed in the same turn" mention would
			// otherwise be saved as status='active' regardless of args. Run them
			// through the classification updater so 'departed' → 'inactive'
			// normalization fires and traits get merged.
			if ((char.status && char.status !== 'active') || (char.traits && char.traits.length > 0)) {
				await story.updateCharacterFromClassification(char.name, {
					status: char.status,
					traits: char.traits,
				});
			}
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

	// Presence clears — anyone alive-but-off-screen, departed, dead, or
	// explicitly marked not-present. The schema's `present` flag was
	// previously declared but never read.
	const offstageNames = args.characters
		.filter(c => c.name && (
			c.status === 'departed' ||
			c.status === 'deceased' ||
			c.status === 'inactive' ||
			c.present === false
		))
		.map(c => c.name);
	if (offstageNames.length > 0) await story.clearPresenceForCharacters(offstageNames);

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

	// Update presence. We previously skipped this whenever the classifier didn't
	// re-emit a `current: true` location — so a turn like "the merchant enters"
	// that didn't restate the room left presence stale. Fall back to the live
	// store's current location so presence still tracks.
	const currentLocFromArgs = args.locations.find(l => l.current);
	const currentLocName = currentLocFromArgs?.name
		?? story.locations.find(l => l.current)?.name
		?? null;
	if (currentLocName) {
		const presentNames = args.characters
			.filter(c =>
				c.name
				&& c.present !== false
				&& c.status !== 'deceased'
				&& c.status !== 'departed'
				&& c.status !== 'inactive',
			)
			.map(c => c.name);
		if (presentNames.length > 0) await story.updatePresence(presentNames, currentLocName);
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

	// ── Meter changes ──
	if (args.meter_changes.length > 0) {
		await story.applyMeterChanges(args.meter_changes);
	}

	// ── Agreement changes (treaties, oaths, bonds, bargains...) ──
	if (args.agreements.length > 0) {
		// Resolve current chapter number from the latest chapter, if any,
		// so created/broken agreements are threaded into the timeline.
		let currentChapterNumber: number | null = null;
		try {
			const { getChapters } = await import('$lib/services/database');
			const chapters = await getChapters(story.currentStory.id);
			if (chapters.length > 0) {
				currentChapterNumber = Math.max(...chapters.map((c) => c.number));
			}
		} catch { /* non-fatal */ }
		await story.applyAgreementChanges(args.agreements, currentChapterNumber);
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

/**
 * Advance the in-world clock by a parsed time delta. Time is the world's
 * metronome — every subsystem that should evolve over in-world time hangs
 * off `tickWorld`, called from here after the tracker is persisted.
 */
async function applyTimeProgression(progression: string): Promise<void> {
	if (!story.currentStory) return;
	const deltaMinutes = parseTimeProgression(progression);
	if (deltaMinutes === 0) {
		console.warn(`[Executor] time_delta="${progression}" parsed to 0 minutes — no time advanced.`);
		return;
	}

	const newTracker = advanceTime(story.currentStory.timeTracker ?? null, deltaMinutes);
	await updateStory(story.currentStory.id, { timeTracker: newTracker } as any);
	story.currentStory = { ...story.currentStory, timeTracker: newTracker };

	await tickWorld(deltaMinutes);
}

/**
 * Fan-out called whenever the world clock advances. Owns all time-driven
 * subsystems so we have one ordered place to add new ones.
 *
 * Today: rumor aging + world-sim cadence trigger.
 * Future hooks (intentionally kept here): agreement deadline checks,
 * faction goal progress, NPC schedule advancement.
 */
async function tickWorld(_deltaMinutes: number): Promise<void> {
	if (!story.currentStory) return;
	await ageRumors();
	await maybeRunWorldSim();
	// future: ageAgreements(_deltaMinutes); progressFactionGoals(_deltaMinutes); ...
}

/**
 * Advance rumor lifecycle based on chapter delta vs each rumor's
 * `staleAfterChapters` lifetime.
 *
 * spreading → mature  at 50% of lifetime
 * mature    → stale   at 100% of lifetime
 *
 * Rumors with no `chapterNumber` (created before any chapter existed)
 * are left in their initial state.
 */
async function ageRumors(): Promise<void> {
	if (!story.currentStory || story.rumors.length === 0) return;
	const chapters = await getChapters(story.currentStory.id);
	const currentChapter = chapters.length > 0 ? Math.max(...chapters.map((c) => c.number)) : 0;

	type Update = { id: string; status: RumorRecord['status'] };
	const updates: Update[] = [];
	for (const rumor of story.rumors) {
		if (rumor.status === 'stale' || rumor.status === 'debunked') continue;
		if (rumor.chapterNumber == null) continue;
		const lifetime = rumor.staleAfterChapters > 0 ? rumor.staleAfterChapters : 5;
		const age = currentChapter - rumor.chapterNumber;
		if (age >= lifetime) {
			updates.push({ id: rumor.id, status: 'stale' });
		} else if (age >= lifetime / 2 && rumor.status === 'spreading') {
			updates.push({ id: rumor.id, status: 'mature' });
		}
	}

	if (updates.length === 0) return;
	for (const u of updates) {
		try { await updateRumor(u.id, { status: u.status }); }
		catch (e) { console.warn(`[Executor] ageRumors update failed for ${u.id}:`, e); }
	}
	const byId = new Map(updates.map((u) => [u.id, u.status]));
	story.rumors = story.rumors.map((r) =>
		byId.has(r.id) ? { ...r, status: byId.get(r.id)! } : r,
	);
}

/**
 * Fire the world simulation if enough in-world days have passed since the
 * last tick. Lifted out of `applyTimeProgression` so `tickWorld` can own
 * all clock-driven side effects.
 */
async function maybeRunWorldSim(): Promise<void> {
	if (!story.currentStory) return;
	const tracker = story.currentStory.timeTracker;
	if (!tracker) return;

	const totalDays = tracker.years * 365 + tracker.days;
	const lastSimDay = story.currentStory.lastWorldSimDay ?? 0;
	if (totalDays - lastSimDay < WORLD_SIM_DAY_INTERVAL) return;

	const wsConfig = settings.getServiceConfig('worldSimulation');
	if (!wsConfig.enabled) return;

	try {
		const chapters = await getChapters(story.currentStory.id);
		const arcs = await getArcs(story.currentStory.id);
		const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
		const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');

		const result = await ai.worldSim.simulate(
			chapters, arcs, story.entries, factionEntries, characterEntries,
			story.entryRelationships, tracker,
			story.storyMode, story.pov, story.tense,
		);
		story.lastWorldSimResult = result;

		// ── Persist WorldSim output so it feeds the timeline + export ──
		const currentChapterNumber = chapters.length > 0
			? Math.max(...chapters.map((c) => c.number))
			: null;
		const now = Date.now();

		if (result.factionActions && result.factionActions.length > 0) {
			const rows: FactionActionRecord[] = result.factionActions.map((fa: any) => ({
				id: uuid(),
				storyId: story.currentStory!.id,
				factionName: fa.factionName ?? 'Unknown Faction',
				action: fa.action ?? '',
				actionType: fa.actionType ?? 'custom',
				target: fa.target ?? null,
				motivation: fa.motivation ?? null,
				consequences: Array.isArray(fa.consequences) ? fa.consequences : [],
				urgency: fa.urgency ?? 'medium',
				affectedRegions: Array.isArray(fa.affectedRegions) ? fa.affectedRegions : [],
				chapterNumber: currentChapterNumber,
				status: 'active',
				createdAt: now,
			}));
			try {
				await bulkPutFactionActions(rows);
				story.factionActions = [...story.factionActions, ...rows];
			} catch (e) { console.warn('[Executor] persist factionActions failed:', e); }
		}

		if (result.rumors && result.rumors.length > 0) {
			const rows: RumorRecord[] = result.rumors.map((r: any) => ({
				id: uuid(),
				storyId: story.currentStory!.id,
				content: r.content ?? '',
				truthfulness: typeof r.truthfulness === 'number' ? r.truthfulness : 0.5,
				originRegion: r.originRegion ?? 'unknown',
				spreadRadius: r.spreadRadius ?? 'local',
				sourceType: r.sourceType ?? 'gossip',
				relatedFaction: r.relatedFaction ?? null,
				chapterNumber: currentChapterNumber,
				staleAfterChapters: typeof r.staleAfterChapters === 'number' ? r.staleAfterChapters : 5,
				status: 'spreading',
				createdAt: now,
			}));
			try {
				await bulkPutRumors(rows);
				story.rumors = [...story.rumors, ...rows];
			} catch (e) { console.warn('[Executor] persist rumors failed:', e); }
		}

		await updateStory(story.currentStory.id, { lastWorldSimDay: totalDays } as any);
		story.currentStory = { ...story.currentStory, lastWorldSimDay: totalDays };
		console.log(`[Executor] World sim triggered at day ${totalDays}`);
	} catch (e) {
		console.error('[Executor] Time-based world sim failed:', e);
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
