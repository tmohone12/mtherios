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
	getStoryThreads, createStoryThread, updateStoryThread, getAgreements, getWorldEvents,
	getLatestStrategicWorldFrame,
} from '$lib/services/database';
import {
	parseTimeProgression, advanceTime, clamp,
	makeLoreEntry, WORLD_SIM_DAY_INTERVAL,
	normalizeRelation,
	findMatchingLoreEntry,
	loreNameKey,
	computeRelationEventTarget,
	ENTROPY_DRIFT_THRESHOLD, ENTROPY_DRIFT_STEP,
} from './helpers';
import {
	searchWikiSchema,
	worldStateUpdateSchema,
	type SearchWikiArgs,
	type WorldStateUpdate,
	type WorldStateLorebookEntry,
} from './schemas';
import * as schemeService from '$lib/services/ai/scheme/SchemeService';
import type { FactionAction, WorldSimulationResult } from '$lib/services/ai/sdk/schemas/worldsim';
import type { RelationChangeEvent } from '$lib/services/ai/generation/WorldSimulationService';
import type {
	Entry, EntryRelationship, WorldEvent, Consequence,
	CharacterEntryState, LocationEntryState, LocationConnection,
	FactionEntryState, FactionActionRecord, RumorRecord,
	EntryType, FactionGoal, FactionResources, StoryThread,
} from '$lib/types';

type FactionGoalInput = Omit<Partial<FactionGoal>, 'deadline'> & {
	description: string;
	deadline?: string | null;
};
type WorldSimThreadUpdate = WorldSimulationResult['threadUpdates'][number];

// ── Main router ──

export async function executeToolCall(
	name: string,
	args: Record<string, any>,
): Promise<string> {
	switch (name) {
		case 'search_wiki': {
			const parsed = searchWikiSchema.safeParse(args);
			if (!parsed.success) {
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			return JSON.stringify(searchWiki(parsed.data));
		}
		case 'update_world_state': {
			const parsed = worldStateUpdateSchema.safeParse(args);
			if (!parsed.success) {
				console.error('[Executor] Invalid update_world_state args:', parsed.error);
				return JSON.stringify({ error: 'Invalid arguments', details: parsed.error.issues });
			}
			await handleWorldStateUpdate(parsed.data);
			return JSON.stringify({ success: true });
		}
		case 'refresh_plot_momentum': {
			try {
				const snapshot = await story.buildStateSnapshot();
				const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
				const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');
				const recentFactionActions = story.factionActions.slice(-5);
				const worldEventList = story.worldEvents.slice(-6).map(e => ({ name: e.name, description: e.description }));
				const schemeText = story.schemes.length > 0
					? story.schemes.map(s => `- ${s.ownerName} (${s.status}): ${s.goal.slice(0, 120)}`).join('\n')
					: '';
				const locationName = snapshot.currentLocation?.name ?? '';
				const tracker = story.currentStory?.timeTracker ?? null;

				const result = await ai.worldSim.generateMomentum(
					snapshot.chapters,
					snapshot.arcs,
					story.entries,
					factionEntries,
					characterEntries,
					story.entryRelationships,
					snapshot.threads,
					snapshot.activeAgreements,
					worldEventList,
					locationName,
					schemeText,
					tracker,
					story.storyMode,
					story.pov,
					story.tense,
					recentFactionActions,
					[],
					snapshot.strategicWorldFrame,
				);
				story.lastWorldSimResult = {
					...(story.lastWorldSimResult ?? {
						plotInjection: null,
						worldNarrative: '',
						factionActions: [],
						rumors: [],
						worldTension: 0,
						plotSeeds: [],
						threadUpdates: [],
					}),
					plotMomentum: result,
				};
				return JSON.stringify({ ok: true, refreshed: true });
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				return JSON.stringify({ error: `Plot momentum refresh failed: ${msg}` });
			}
		}
		default:
			return JSON.stringify({ error: `Unknown tool: ${name}` });
	}
}

// ══════════════════════════════════════════════════════════════
// update_world_state — replaces ClassifierService + Pipeline Phase 1
// ══════════════════════════════════════════════════════════════

function searchWiki(args: SearchWikiArgs): {
	query: string;
	count: number;
	results: Array<{
		id: string;
		name: string;
		type: EntryType;
		description: string;
		hidden_info?: string | null;
		aliases: string[];
		keywords: string[];
	}>;
} {
	const query = args.query.trim();
	const terms = tokenize(query);
	const typeFilter = new Set(args.types ?? []);
	const limit = Math.max(1, Math.min(args.limit ?? 5, 10));

	const scored = story.lorebookEntries
		.filter(e => !(e as any).deleted)
		.filter(e => typeFilter.size === 0 || typeFilter.has(e.type))
		.map(entry => ({ entry, score: scoreWikiEntry(entry, query, terms) }))
		.filter(r => r.score > 0)
		.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
		.slice(0, limit);

	return {
		query,
		count: scored.length,
		results: scored.map(({ entry }) => ({
			id: entry.id,
			name: entry.name,
			type: entry.type,
			description: truncateForTool(entry.description ?? '', 900),
			hidden_info: args.include_hidden ? truncateForTool(entry.hiddenInfo ?? '', 700) || null : undefined,
			aliases: entry.aliases ?? [],
			keywords: entry.injection?.keywords ?? [],
		})),
	};
}

function tokenize(text: string): string[] {
	return [...new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9'_-]+/i)
			.map(t => t.trim())
			.filter(t => t.length > 1),
	)];
}

function scoreWikiEntry(entry: Entry, rawQuery: string, terms: string[]): number {
	const query = rawQuery.toLowerCase();
	const name = entry.name.toLowerCase();
	let score = 0;

	if (name === query) score += 120;
	else if (name.includes(query) || query.includes(name)) score += 55;

	for (const alias of entry.aliases ?? []) {
		const a = alias.toLowerCase();
		if (a === query) score += 90;
		else if (a.includes(query) || query.includes(a)) score += 40;
	}

	const keywords = entry.injection?.keywords ?? [];
	for (const keyword of keywords) {
		const k = keyword.toLowerCase();
		if (k === query) score += 45;
		else if (k.includes(query) || query.includes(k)) score += 25;
	}

	const searchable = [
		entry.name,
		...(entry.aliases ?? []),
		...keywords,
		entry.description ?? '',
		entry.hiddenInfo ?? '',
	].join(' ').toLowerCase();
	for (const term of terms) {
		if (name.includes(term)) score += 20;
		else if (keywords.some(k => k.toLowerCase().includes(term))) score += 14;
		else if (searchable.includes(term)) score += 4;
	}
	return score;
}

function truncateForTool(text: string, maxChars: number): string {
	const clean = text.trim();
	if (clean.length <= maxChars) return clean;
	return clean.slice(0, Math.max(0, maxChars - 3)).trimEnd() + '...';
}

type IncomingCharacterUpdate = WorldStateUpdate['characters'][number];

function findLoreCharacterForUpdate(char: IncomingCharacterUpdate): Entry | undefined {
	return findMatchingLoreEntry(story.lorebookEntries, {
		name: char.name,
		type: 'character',
		aliases: char.aliases ?? [],
	});
}

function findRuntimeCharacterForUpdate(char: IncomingCharacterUpdate, loreEntry?: Entry) {
	const keys = new Set([
		loreNameKey(char.name),
		...(char.aliases ?? []).map(loreNameKey),
		loreEntry ? loreNameKey(loreEntry.name) : '',
		...(loreEntry?.aliases ?? []).map(loreNameKey),
	].filter(Boolean));
	return story.characters.find(c => keys.has(loreNameKey(c.name)));
}

function canonicalCharacterNameForUpdate(char: IncomingCharacterUpdate): string {
	const loreEntry = findLoreCharacterForUpdate(char);
	return findRuntimeCharacterForUpdate(char, loreEntry)?.name ?? loreEntry?.name ?? char.name;
}

async function mergeCharacterLoreSignals(
	target: Entry | undefined,
	char: IncomingCharacterUpdate,
	protagonistName: string | undefined,
): Promise<void> {
	if (!target || char.name.toLowerCase() === protagonistName) return;
	const incomingFactionTags = (char.faction_tags ?? []).map(tag => tag.trim()).filter(Boolean);
	const incomingAliases = (char.aliases ?? []).map(alias => alias.trim()).filter(Boolean);
	if (incomingFactionTags.length === 0 && incomingAliases.length === 0) return;

	const prev = target.state as CharacterEntryState;
	const nextState: CharacterEntryState = {
		...prev,
		type: 'character',
	};
	if (incomingFactionTags.length > 0) {
		nextState.factionTags = mergeStrings(prev.factionTags ?? [], incomingFactionTags).slice(-8);
	}
	const nextAliases = incomingAliases.length > 0
		? mergeStrings(target.aliases ?? [], incomingAliases)
		: target.aliases;

	await updateLorebookEntry(target.id, { state: nextState as any, aliases: nextAliases, updatedAt: Date.now() });
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === target.id ? { ...e, state: nextState as any, aliases: nextAliases } : e
	);

	if (incomingFactionTags.length > 0) {
		await syncFactionKnownMembersForCharacter(target, incomingFactionTags);
	}
}

async function mergeCharacterPressures(
	target: Entry | undefined,
	char: IncomingCharacterUpdate,
	protagonistName: string | undefined,
): Promise<void> {
	if (!target || char.name.toLowerCase() === protagonistName) return;
	if (!char.pressures || char.pressures.length === 0) return;

	const prev = target.state as CharacterEntryState;
	const merged = [...new Set([
		...(prev.pressures ?? []),
		...char.pressures.filter(p => p && p.trim()),
	])].slice(-8);
	if (merged.length === (prev.pressures ?? []).length) return;

	const newState: CharacterEntryState = { ...prev, type: 'character', pressures: merged };
	await updateLorebookEntry(target.id, { state: newState as any, updatedAt: Date.now() });
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === target.id ? { ...e, state: newState as any } : e
	);
}

async function syncDeferredCharacterLoreSignals(
	characters: WorldStateUpdate['characters'],
	protagonistName: string | undefined,
): Promise<void> {
	for (const char of characters) {
		if (!char.name) continue;
		const target = findLoreCharacterForUpdate(char);
		if (!target) continue;
		await mergeCharacterLoreSignals(target, char, protagonistName);
		await mergeCharacterPressures(target, char, protagonistName);
	}
}

async function handleWorldStateUpdate(args: WorldStateUpdate): Promise<void> {
	if (!story.currentStory) return;

	const protagonistName = story.protagonist?.name?.toLowerCase();

	// ── Characters ──
	for (const char of args.characters) {
		if (!char.name) continue;

		const loreTarget = findLoreCharacterForUpdate(char);
		const runtimeTarget = findRuntimeCharacterForUpdate(char, loreTarget);
		const canonicalName = runtimeTarget?.name ?? loreTarget?.name ?? char.name;
		if (runtimeTarget) {
			await story.updateCharacterFromClassification(runtimeTarget.name, {
				description: char.description,
				relationship: char.relationship,
				status: char.status,
				traits: char.traits,
			});
		} else {
			await story.addCharacter(canonicalName, char.description ?? undefined, char.relationship ?? undefined);
			// Brand-new characters skip the status/traits processing in addCharacter,
			// so a "newly-introduced and departed in the same turn" mention would
			// otherwise be saved as status='active' regardless of args. Run them
			// through the classification updater so 'departed' → 'inactive'
			// normalization fires and traits get merged.
			if ((char.status && char.status !== 'active') || (char.traits && char.traits.length > 0)) {
				await story.updateCharacterFromClassification(canonicalName, {
					status: char.status,
					traits: char.traits,
				});
			}
		}

		await mergeCharacterLoreSignals(loreTarget, char, protagonistName);
		await mergeCharacterPressures(loreTarget, char, protagonistName);
		// Merge pressures onto an existing lorebook entry (canonical or alias match).
		// Pressures accumulate — they're conditions of the NPC's life. The narrator
		// is responsible for marking them resolved by emitting a replacement set.
		if (!loreTarget && char.pressures && char.pressures.length > 0 && char.name.toLowerCase() !== protagonistName) {
			const needle = char.name.toLowerCase();
			const target = story.lorebookEntries.find(e => {
				if (e.type !== 'character') return false;
				if (e.name?.toLowerCase() === needle) return true;
				return (e.aliases ?? []).some(a => a?.toLowerCase() === needle);
			});
			if (target) {
				const prev = target.state as CharacterEntryState;
				const merged = [...new Set([
					...(prev.pressures ?? []),
					...char.pressures.filter(p => p && p.trim()),
				])].slice(-8); // cap so it doesn't bloat — keep most recent
				const newState: CharacterEntryState = { ...prev, pressures: merged };
				await updateLorebookEntry(target.id, { state: newState as any, updatedAt: Date.now() });
				story.lorebookEntries = story.lorebookEntries.map(e =>
					e.id === target.id ? { ...e, state: newState as any } : e
				);
			}
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
		.map(c => canonicalCharacterNameForUpdate(c));
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
			.map(c => canonicalCharacterNameForUpdate(c));
		if (presentNames.length > 0) await story.updatePresence(presentNames, currentLocName);
	}

	// ── Items ──
	for (const item of args.items) {
		if (!item.name) continue;
		await story.addOrUpdateItem(item.name, item.description, item.quantity, item.equipped, item.location ?? undefined);
	}

	// ── Explicit lorebook entry creation ──
	if (args.lorebook_entries.length > 0) {
		await handleLorebookCreations(args.lorebook_entries);
		await syncDeferredCharacterLoreSignals(args.characters, protagonistName);
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

	if (args.player_reputation !== undefined) {
		await story.updatePlayerReputation(args.player_reputation);
	}

	if (args.player_ledger !== undefined) {
		await story.updatePlayerLedger(args.player_ledger);
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

// ── Explicit lorebook entry creation ──

async function handleLorebookCreations(
	entries: WorldStateLorebookEntry[],
): Promise<void> {
	if (!story.currentStory) return;
	const newEntries: Entry[] = [];
	const updatedEntries = new Map<string, Entry>();

	for (const incoming of entries) {
		if (!incoming.name) continue;
		const existing = findExistingLoreEntry(incoming, entriesWithPendingLoreChanges(newEntries, updatedEntries));
		if (existing) {
			const updated = mergeLorebookEntry(existing, incoming, entriesWithPendingLoreChanges(newEntries, updatedEntries));
			await updateLorebookEntry(existing.id, updated);
			const mergedEntry = { ...existing, ...updated };
			const newIndex = newEntries.findIndex(e => e.id === existing.id);
			if (newIndex >= 0) {
				newEntries[newIndex] = mergedEntry;
			} else {
				updatedEntries.set(existing.id, mergedEntry);
			}
			console.log(`[Executor] Lorebook entry "${incoming.name}" already exists — skipping creation`);
			continue;
		}

		const entry = makeLoreEntry(
			story.currentStory.id,
			incoming.name,
			incoming.type,
			incoming.description,
			incoming.keywords.length > 0 ? incoming.keywords : [loreNameKey(incoming.name)],
			{
				hiddenInfo: incoming.hidden_info,
				aliases: incoming.aliases,
				keywords: incoming.keywords.length > 0 ? incoming.keywords : [loreNameKey(incoming.name)],
				injectionMode: incoming.injection_mode,
				priority: incoming.priority,
				state: buildIncomingLoreState(incoming, entriesWithPendingLoreChanges(newEntries, updatedEntries)),
			},
		);

		await createLorebookEntry(entry);
		newEntries.push(entry);
	}

	if (updatedEntries.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
		console.log(`[Executor] Updated ${updatedEntries.size} lorebook entries: ${[...updatedEntries.values()].map(e => e.name).join(', ')}`);
	}
	if (newEntries.length > 0) {
		story.lorebookEntries = [...story.lorebookEntries, ...newEntries];
		console.log(`[Executor] Created ${newEntries.length} lorebook entries: ${newEntries.map(e => e.name).join(', ')}`);
	}
	await reconcileFactionKnownMembers(entries);
}

// ── Location connections ──

function entriesWithPendingLoreChanges(newEntries: Entry[], updatedEntries: Map<string, Entry>): Entry[] {
	const byId = new Map(story.lorebookEntries.map(e => [e.id, updatedEntries.get(e.id) ?? e]));
	for (const entry of newEntries) {
		byId.set(entry.id, updatedEntries.get(entry.id) ?? entry);
	}
	return [...byId.values()];
}

function findExistingLoreEntry(
	incoming: WorldStateLorebookEntry,
	candidates: Entry[] = story.lorebookEntries,
): Entry | undefined {
	return findMatchingLoreEntry(candidates, {
		name: incoming.name,
		type: incoming.type,
		aliases: incoming.aliases,
	});
}

function mergeLorebookEntry(
	existing: Entry,
	incoming: WorldStateLorebookEntry,
	candidates: Entry[] = story.lorebookEntries,
): Partial<Entry> {
	const mergedAliases = mergeStrings(existing.aliases ?? [], incoming.aliases ?? []);
	const mergedKeywords = mergeStrings(existing.injection?.keywords ?? [], incoming.keywords ?? []);
	const incomingState = buildIncomingLoreState(incoming, candidates) ?? {};

	return {
		description: mergeLoreText(existing.description ?? '', incoming.description, 'Recent development'),
		hiddenInfo: mergeLoreText(existing.hiddenInfo ?? '', incoming.hidden_info ?? '', 'Hidden development') || null,
		aliases: mergedAliases,
		state: mergeEntryState(existing, incomingState),
		injection: {
			mode: strongestInjectionMode(existing.injection?.mode ?? 'keyword', incoming.injection_mode),
			keywords: mergedKeywords.length > 0 ? mergedKeywords : [loreNameKey(existing.name)],
			priority: Math.max(existing.injection?.priority ?? 0, incoming.priority ?? 0),
		},
		updatedAt: Date.now(),
	};
}

function buildIncomingLoreState(
	incoming: WorldStateLorebookEntry,
	candidates: Entry[] = story.lorebookEntries,
): Record<string, any> | undefined {
	const state: Record<string, any> = { ...(incoming.state_overrides ?? {}) };
	if (incoming.type === 'faction') {
		if (incoming.faction_goals?.length) state.goals = normalizeFactionGoals(incoming.faction_goals);
		if (incoming.faction_resources) state.resources = normalizeFactionResources(incoming.faction_resources);
		if (incoming.faction_disposition) state.disposition = incoming.faction_disposition;
		if (incoming.territory?.length) state.territory = incoming.territory.map(t => t.trim()).filter(Boolean);
		if (incoming.known_members?.length) {
			state.knownMembers = incoming.known_members
				.map(name => memberNameToEntryId(name, candidates))
				.filter((id): id is string => !!id);
		}
	}
	return Object.keys(state).length > 0 ? state : undefined;
}

async function reconcileFactionKnownMembers(entries: WorldStateLorebookEntry[]): Promise<void> {
	const updates = new Map<string, Entry>();
	for (const incoming of entries) {
		if (incoming.type !== 'faction' || !incoming.known_members?.length) continue;
		const baseFaction = findExistingLoreEntry(incoming);
		if (!baseFaction) continue;

		const factionEntry = updates.get(baseFaction.id) ?? baseFaction;
		const memberIds = incoming.known_members
			.map(name => memberNameToEntryId(name))
			.filter((id): id is string => !!id);
		if (memberIds.length === 0) continue;

		const prev = factionEntry.state as FactionEntryState;
		const knownMembers = mergeStrings(prev.knownMembers ?? [], memberIds);
		if (knownMembers.length === (prev.knownMembers ?? []).length) continue;

		const nextState: FactionEntryState = { ...prev, type: 'faction', knownMembers };
		const updatedEntry = { ...factionEntry, state: nextState, updatedAt: Date.now() };
		updates.set(factionEntry.id, updatedEntry);
		await updateLorebookEntry(factionEntry.id, { state: nextState as any, updatedAt: updatedEntry.updatedAt });
	}

	if (updates.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updates.get(e.id) ?? e);
	}
}

function mergeEntryState(existing: Entry, incomingState: Record<string, any>): any {
	if (existing.type !== 'faction') {
		return { ...(existing.state as Record<string, any>), ...incomingState };
	}
	const prev = existing.state as FactionEntryState;
	const next: FactionEntryState = { ...prev, ...(incomingState as Partial<FactionEntryState>) };
	if (incomingState.knownMembers) {
		next.knownMembers = mergeStrings(prev.knownMembers ?? [], incomingState.knownMembers);
	}
	if (incomingState.goals) {
		next.goals = mergeFactionGoals(prev.goals ?? [], incomingState.goals as FactionGoal[]);
	}
	if (incomingState.resources) {
		next.resources = mergeFactionResources(prev.resources, incomingState.resources as FactionResources);
	}
	if (incomingState.territory) {
		next.territory = mergeStrings(prev.territory ?? [], incomingState.territory);
	}
	return next;
}

function normalizeFactionGoals(goals: FactionGoalInput[]): FactionGoal[] {
	return goals
		.filter(g => g.description?.trim())
		.slice(0, 8)
		.map(g => ({
			description: g.description.trim(),
			priority: clamp(typeof g.priority === 'number' && Number.isFinite(g.priority) ? g.priority : 5, 1, 10),
			progress: clamp(typeof g.progress === 'number' && Number.isFinite(g.progress) ? g.progress : 0, 0, 100),
			type: g.type ?? 'diplomatic',
			deadline: g.deadline?.trim() || undefined,
		}));
}

function normalizeFactionResources(resources: Partial<FactionResources>): FactionResources {
	return {
		military: clamp(Math.round(resources.military ?? 50), 0, 100),
		wealth: clamp(Math.round(resources.wealth ?? 50), 0, 100),
		influence: clamp(Math.round(resources.influence ?? 50), 0, 100),
		information: clamp(Math.round(resources.information ?? 50), 0, 100),
		morale: clamp(Math.round(resources.morale ?? 50), 0, 100),
	};
}

function mergeFactionGoals(existing: FactionGoal[], incoming: FactionGoal[]): FactionGoal[] {
	const byKey = new Map<string, FactionGoal>();
	for (const goal of [...existing, ...incoming]) {
		const key = loreNameKey(goal.description);
		const prev = byKey.get(key);
		if (!prev) {
			byKey.set(key, goal);
			continue;
		}
		byKey.set(key, {
			...prev,
			...goal,
			priority: Math.max(prev.priority ?? 1, goal.priority ?? 1),
			progress: Math.max(prev.progress ?? 0, goal.progress ?? 0),
		});
	}
	return [...byKey.values()]
		.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
		.slice(0, 8);
}

function mergeFactionResources(existing: FactionResources | undefined, incoming: FactionResources): FactionResources {
	if (!existing) return incoming;
	return {
		military: incoming.military ?? existing.military,
		wealth: incoming.wealth ?? existing.wealth,
		influence: incoming.influence ?? existing.influence,
		information: incoming.information ?? existing.information,
		morale: incoming.morale ?? existing.morale,
	};
}

function memberNameToEntryId(name: string, candidates: Entry[] = story.lorebookEntries): string | null {
	const entry = findMatchingLoreEntry(candidates, {
		name,
		type: 'character',
		aliases: [],
	});
	return entry?.id ?? null;
}

async function syncFactionKnownMembersForCharacter(characterEntry: Entry, factionTags: string[]): Promise<void> {
	const updates = new Map<string, Entry>();
	for (const tag of factionTags) {
		const factionEntry = findMatchingLoreEntry(story.lorebookEntries, {
			name: tag,
			type: 'faction',
			aliases: [],
		});
		if (!factionEntry) continue;
		const prev = factionEntry.state as FactionEntryState;
		const knownMembers = mergeStrings(prev.knownMembers ?? [], [characterEntry.id]);
		if (knownMembers.length === (prev.knownMembers ?? []).length) continue;
		const nextState: FactionEntryState = {
			...prev,
			type: 'faction',
			knownMembers,
		};
		updates.set(factionEntry.id, { ...factionEntry, state: nextState, updatedAt: Date.now() });
		await updateLorebookEntry(factionEntry.id, { state: nextState as any, updatedAt: Date.now() });
	}
	if (updates.size > 0) {
		story.lorebookEntries = story.lorebookEntries.map(e => updates.get(e.id) ?? e);
	}
}

function mergeStrings(existing: string[], incoming: string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of [...existing, ...incoming]) {
		const clean = value.trim();
		if (!clean) continue;
		const key = clean.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
}

function mergeLoreText(existing: string, incoming: string, label: string): string {
	const base = existing.trim();
	const addition = incoming.trim();
	if (!addition) return base;
	if (!base) return addition;
	if (base.toLowerCase().includes(addition.toLowerCase().slice(0, 120))) return base;
	const merged = `${base}\n\n${label}: ${addition}`;
	return merged.length > 6000 ? merged.slice(0, 5997).trimEnd() + '...' : merged;
}

function strongestInjectionMode(
	existing: 'always' | 'keyword' | 'never',
	incoming: 'always' | 'keyword' | 'never',
): 'always' | 'keyword' | 'never' {
	if (existing === 'always' || incoming === 'always') return 'always';
	if (existing === 'keyword' || incoming === 'keyword') return 'keyword';
	return 'never';
}

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
		const npcEntry = findMatchingLoreEntry(story.lorebookEntries, {
			name: conv.npcName,
			type: 'character',
			aliases: [],
		});
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
		const source = entryByName.get(rel.sourceName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.sourceName });
		if (source) sourceIds.add(source.id);
	}
	const allRels = new Map<string, EntryRelationship[]>();
	await Promise.all([...sourceIds].map(async (id) => {
		const rels = await getRelationshipsForEntry(story.currentStory!.id, id);
		allRels.set(id, rels);
	}));

	const newRels: EntryRelationship[] = [];
	for (const rel of relationships) {
		const source = entryByName.get(rel.sourceName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.sourceName });
		const target = entryByName.get(rel.targetName.toLowerCase())
			?? findMatchingLoreEntry(entries, { name: rel.targetName });
		if (!source || !target) continue;

		const existing = allRels.get(source.id) ?? [];
		const dupe = existing.find(r => r.targetEntryId === target.id && r.type === rel.type);
		if (dupe) {
			await updateEntryRelationship(dupe.id, { strength: rel.strength, updatedAt: Date.now() });
			await syncFactionMembership(source, target, rel.type);
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
		await syncFactionMembership(source, target, rel.type);
		newRels.push(newRel);
	}

	if (newRels.length > 0) {
		story.entryRelationships = [...story.entryRelationships, ...newRels];
	}
}

async function syncFactionMembership(source: Entry, target: Entry, type: string): Promise<void> {
	if (!['member-of', 'serves', 'leader-of'].includes(type)) return;
	if (source.type !== 'character' || target.type !== 'faction') return;
	const state = target.state as FactionEntryState;
	const knownMembers = mergeStrings(state.knownMembers ?? [], [source.id]);
	if (knownMembers.length === (state.knownMembers ?? []).length) return;
	const next: FactionEntryState = { ...state, knownMembers };
	await updateLorebookEntry(target.id, { state: next as any, updatedAt: Date.now() });
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === target.id ? { ...e, state: next as any, updatedAt: Date.now() } : e
	);
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

	// Capture the story id at entry — `updateStory` is async, and if the user
	// switches stories during the write we must not stamp the new story's
	// `currentStory` with the old story's tracker. Same pattern as `maybeRunWorldSim`.
	const storyId = story.currentStory.id;
	const newTracker = advanceTime(story.currentStory.timeTracker ?? null, deltaMinutes);
	await updateStory(storyId, { timeTracker: newTracker } as any);
	if (story.currentStory && story.currentStory.id === storyId) {
		story.currentStory = { ...story.currentStory, timeTracker: newTracker };
	}

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
async function tickWorld(deltaMinutes: number): Promise<void> {
	if (!story.currentStory) return;
	await ageRumors();
	await schemeService.tick(deltaMinutes);
	await maybeRunWorldSim();
	// future: ageAgreements(deltaMinutes); progressFactionGoals(deltaMinutes); ...
}

/**
 * Reactive scheme evaluation. Call AFTER `executeToolCall('update_world_state')`
 * (or after `handleWorldStateUpdate` from the orchestrator path) with the same
 * args and the narrative text that produced them. Gated internally — quiet
 * turns skip the LLM call entirely.
 */
export async function runSchemeEvaluation(
	narrative: string,
	stateSnapshot: string,
	worldStateArgs: WorldStateUpdate | null,
	signal?: AbortSignal,
): Promise<string[]> {
	if (!schemeService.shouldEvaluate(worldStateArgs)) return [];
	try {
		return await schemeService.evaluate(narrative, stateSnapshot, signal);
	} catch (e) {
		return [`scheme evaluator: ${e instanceof Error ? e.message : e}`];
	}
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
 *
 * Pass `{ force: true }` to bypass the day-interval gate — used by the manual
 * "Run now" button in the World drawer. The wsConfig.enabled gate is always
 * respected; if the service is disabled, the run is skipped silently and the
 * UI should disable its button.
 */
export async function maybeRunWorldSim(opts: { force?: boolean } = {}): Promise<void> {
	if (!story.currentStory) return;
	const tracker = story.currentStory.timeTracker;
	if (!tracker) return;

	const totalDays = tracker.years * 365 + tracker.days;
	const lastSimDay = story.currentStory.lastWorldSimDay ?? 0;
	if (!opts.force && totalDays - lastSimDay < WORLD_SIM_DAY_INTERVAL) return;

	const wsConfig = settings.getServiceConfig('worldSimulation');
	if (!wsConfig.enabled) return;

	// Capture the story id at entry — simulate() can take seconds, and the
	// user may navigate away before it returns. We must not write back to a
	// different story's record in the finally block.
	const storyId = story.currentStory.id;

	try {
		const chapters = await getChapters(story.currentStory.id);
		const arcs = await getArcs(story.currentStory.id);
		const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
		const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');

		// F5 loop-closure inputs: feed last tick's moves and relation history back into the AI.
		const recentFactionActions = story.factionActions.slice(-5);
		const relationChangeLog = buildRelationChangeLog(factionEntries);

		const threads = await getStoryThreads(story.currentStory.id);
		const agreements = await getAgreements(story.currentStory.id);
		const worldEvents = await getWorldEvents(story.currentStory.id);
		const worldEventList = worldEvents.slice(-6).map(e => ({ name: e.name, description: e.description }));
		const locationName = story.locations.find(l => l.current)?.name ?? '';
		const schemeText = story.schemes.length > 0
			? story.schemes.map(s => `- ${s.ownerName} (${s.status}): ${s.goal.slice(0, 120)}`).join('\n')
			: '';
		const strategicWorldFrame = story.latestStrategicWorldFrame
			?? await getLatestStrategicWorldFrame(story.currentStory.id);

		const result = await ai.worldSim.simulate(
			chapters, arcs, story.entries, factionEntries, characterEntries,
			story.entryRelationships, threads, agreements, worldEventList,
			locationName, schemeText, tracker,
			story.storyMode, story.pov, story.tense,
			recentFactionActions, relationChangeLog,
			strategicWorldFrame,
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

			// Apply per-action relation deltas to interFactionRelations.
			// Symmetric: A→B delta also writes B→A. Unknown target names are warned and skipped.
			// Then run deterministic entropy drift on rivalries that were not touched this tick,
			// so high-magnitude standings ebb back toward zero without LLM cost.
			try {
				const touched = await applyRelationDeltas(result.factionActions);
				await applyEntropyDrift(touched);
			} catch (e) { console.warn('[Executor] applyRelationDeltas failed:', e); }
		} else {
			// No factionActions this tick — still run entropy drift on existing rivalries.
			try { await applyEntropyDrift(new Set()); }
			catch (e) { console.warn('[Executor] applyEntropyDrift failed:', e); }
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

		if (result.threadUpdates && result.threadUpdates.length > 0) {
			try {
				await persistThreadUpdates(result.threadUpdates, threads, currentChapterNumber);
			} catch (e) { console.warn('[Executor] persist threadUpdates failed:', e); }
		}

		console.log(`[Executor] World sim triggered at day ${totalDays}`);
	} catch (e) {
		console.error('[Executor] Time-based world sim failed:', e);
	} finally {
		// Reset cooldown using the LATEST tracker (handles time advancing during
		// the slow simulate() call) and ALWAYS reset, even on failure, so a
		// failing sim doesn't retry every turn. Skip the writeback if the user
		// navigated to a different story while simulate() was running — we'd
		// otherwise stamp an unrelated story's lastWorldSimDay.
		if (story.currentStory && story.currentStory.id === storyId) {
			const latest = story.currentStory.timeTracker;
			const latestTotalDays = latest
				? latest.years * 365 + latest.days
				: totalDays;
			await updateStory(storyId, { lastWorldSimDay: latestTotalDays } as any);
			story.currentStory = { ...story.currentStory, lastWorldSimDay: latestTotalDays };
		}
	}
}

function threadKey(description: string): string {
	return description
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

async function persistThreadUpdates(
	updates: WorldSimThreadUpdate[],
	existingThreads: StoryThread[],
	currentChapterNumber: number | null,
): Promise<void> {
	if (!story.currentStory || updates.length === 0) return;

	const byId = new Map(existingThreads.map(t => [t.id, t]));
	const byKey = new Map(existingThreads.map(t => [threadKey(t.description), t]));
	const now = Date.now();

	for (const update of updates) {
		const description = update.description?.trim();
		if (!description) continue;
		const existing = (update.threadId ? byId.get(update.threadId) : undefined)
			?? byKey.get(threadKey(description));

		if (existing) {
			const closing = update.status === 'closed' || update.status === 'abandoned';
			const patch: Partial<StoryThread> = {
				description,
				status: update.status,
				significance: update.significance,
				updatedAt: now,
				closedAt: closing ? (existing.closedAt ?? now) : null,
				closureReason: closing ? update.reason : null,
			};
			await updateStoryThread(existing.id, patch);
			Object.assign(existing, patch);
			byKey.set(threadKey(description), existing);
			continue;
		}

		const thread: StoryThread = {
			id: uuid(),
			storyId: story.currentStory.id,
			description,
			status: update.status,
			significance: update.significance,
			sourceArcId: null,
			sourceChapterId: null,
			createdAt: now,
			updatedAt: now,
			closedAt: update.status === 'closed' || update.status === 'abandoned' ? now : null,
			closureReason: update.status === 'closed' || update.status === 'abandoned' ? update.reason : null,
			relatedFactionIds: [],
			relatedCharacterNames: [],
		};
		await createStoryThread(thread);
		existingThreads.push(thread);
		byId.set(thread.id, thread);
		byKey.set(threadKey(description), thread);
	}

	if (currentChapterNumber != null) {
		console.log(`[Executor] Persisted ${updates.length} thread update(s) near chapter ${currentChapterNumber}`);
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
		const charEntry = findMatchingLoreEntry(story.lorebookEntries, {
			name: c.name,
			type: 'character',
			aliases: c.aliases ?? [],
		});
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
			// Cascade through allies BEFORE writing back so we capture the original
			// faction's pre-mutation rels reference for traversal. Single-hop only.
			await cascadePlayerStandingThroughAllies(entry.id, payload.playerStandingDelta);
		}
		if (state.playerStanding <= -50) state.status = 'hostile';
		else if (state.playerStanding >= 50) state.status = 'allied';
		await updateLorebookEntry(entry.id, { state: state as any, updatedAt: Date.now() });
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === entry.id ? { ...e, state: state as any } : e
		);
		return;
	}

	// Structured inter-faction relationship events. Wired here (not in
	// faction_status_change) so the existing player-rep flow stays untouched.
	if (consequence.effectType === 'relationship_change' && consequence.targetEntityId) {
		const payload = consequence.effectPayload as {
			sourceFactionId?: string;
			eventType?: 'alliance_formed' | 'alliance_broken' | 'betrayal' | 'standing_shift';
			delta?: number;
		};
		if (!payload.sourceFactionId || !payload.eventType) return;
		const a = story.lorebookEntries.find(e => e.id === payload.sourceFactionId && e.type === 'faction');
		const b = story.lorebookEntries.find(e => e.id === consequence.targetEntityId && e.type === 'faction');
		if (!a || !b) return;
		// Guard non-finite deltas so a malformed payload can't propagate NaN
		// through clamp → mutateRelation → persisted state.
		const rawDelta = typeof payload.delta === 'number' && Number.isFinite(payload.delta)
			? payload.delta
			: 0;

		if (payload.eventType === 'standing_shift') {
			// Pure ±delta drift via mutateRelation — preserves affinity tracking + per-side history.
			const d = clamp(rawDelta, -50, 50);
			await mutateRelation(a.id, b.name, d, payload.eventType);
			await mutateRelation(b.id, a.name, d, payload.eventType);
		} else {
			// Snap-to-target events (alliance/betrayal) — clean affinity reset via mutateRelationDirect.
			// Math lives in computeRelationEventTarget so it's testable in isolation.
			for (const [src, dst] of [[a, b], [b, a]] as const) {
				const sState = src.state as FactionEntryState;
				const cur = normalizeRelation((sState.interFactionRelations ?? {})[dst.name]).standing;
				const next = computeRelationEventTarget(cur, payload.eventType, rawDelta);
				await mutateRelationDirect(src.id, dst.name, next);
			}
		}
		return;
	}
}

// ── Inter-faction relation mutation helpers (Phase F3) ──

/**
 * Apply each FactionAction's relationDeltas to interFactionRelations symmetrically.
 * Unknown target names are warned and skipped (the action itself still persists).
 * Returns the set of pair keys (canonical-order id|id) that received a delta —
 * used by applyEntropyDrift to skip same-tick double-shifts.
 */
async function applyRelationDeltas(actions: FactionAction[]): Promise<Set<string>> {
	const touched = new Set<string>();
	if (!story.currentStory) return touched;
	const factions = story.lorebookEntries.filter(e => e.type === 'faction');
	const byName = new Map(factions.map(f => [f.name.toLowerCase(), f]));
	for (const a of actions) {
		const source = byName.get((a.factionName ?? '').toLowerCase());
		if (!source) continue;
		for (const d of a.relationDeltas ?? []) {
			const target = byName.get((d.targetFaction ?? '').toLowerCase());
			if (!target) {
				console.warn('[WorldSim] relationDelta target not found:', d.targetFaction);
				continue;
			}
			if (target.id === source.id) continue; // ignore self-relation deltas
			await mutateRelation(source.id, target.name, d.delta, d.reason);
			await mutateRelation(target.id, source.name, d.delta, d.reason);
			touched.add(pairKey(source.id, target.id));
		}
	}
	return touched;
}

// Canonical pair key (smaller-id first) so A↔B and B↔A collide.
function pairKey(a: string, b: string): string {
	return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Regression-to-the-mean for active inter-faction relations.
 * For every pair where |standing| ≥ ENTROPY_DRIFT_THRESHOLD, nudge ±ENTROPY_DRIFT_STEP
 * toward zero. Skips pairs already shifted by relationDeltas this tick.
 * Runs synchronously after the LLM worldsim pass — deterministic, no LLM cost.
 */
async function applyEntropyDrift(touchedPairs: Set<string>): Promise<void> {
	if (!story.currentStory) return;
	const factions = story.lorebookEntries.filter(e => e.type === 'faction');
	const seen = new Set<string>();
	for (const a of factions) {
		const aState = a.state as FactionEntryState;
		const rels = aState.interFactionRelations ?? {};
		for (const [otherName, rel] of Object.entries(rels)) {
			const norm = normalizeRelation(rel);
			if (Math.abs(norm.standing) < ENTROPY_DRIFT_THRESHOLD) continue;
			const b = factions.find(f => f.name.toLowerCase() === otherName.toLowerCase());
			if (!b || b.id === a.id) continue;
			const key = pairKey(a.id, b.id);
			if (seen.has(key) || touchedPairs.has(key)) continue;
			seen.add(key);
			const driftDelta = norm.standing > 0 ? -ENTROPY_DRIFT_STEP : ENTROPY_DRIFT_STEP;
			// Silent — entropy is a deterministic background process; logging it
			// in the 5-entry history would displace meaningful narrative entries.
			await mutateRelation(a.id, b.name, driftDelta, 'entropy', true);
			await mutateRelation(b.id, a.name, driftDelta, 'entropy', true);
		}
	}
}

/**
 * Patch one side of a relation: shift standing by delta, shift affinity by a
 * fraction (slower for positive deltas, faster for negative — betrayal hurts
 * trust as much as standing). Appends an entry to history (capped at 5) unless
 * `silent` is true — entropy drift sets silent so it doesn't displace narrative
 * history entries.
 */
async function mutateRelation(
	factionEntryId: string,
	otherName: string,
	delta: number,
	reason?: string,
	silent: boolean = false,
): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const norm = normalizeRelation(prev[otherName]);
	const nextStanding = clamp(norm.standing + delta, -100, 100);
	const affinityRate = delta < 0 ? 0.5 : 0.33;
	const nextAffinity = clamp(norm.affinity + delta * affinityRate, -100, 100);
	const chapterNumber = currentChapterNumber();
	const newHistory = silent
		? norm.history
		: [
				...norm.history,
				{ event: reason ?? 'relation shift', delta, chapter: chapterNumber },
			].slice(-5);
	await writeRelation(factionEntryId, otherName, {
		standing: nextStanding,
		affinity: nextAffinity,
		history: newHistory,
	});
}

/**
 * SET the relation to an absolute value (used by alliance_formed/_broken/betrayal).
 * Snaps affinity to the same value for a clean reset; appends a history entry.
 */
async function mutateRelationDirect(factionEntryId: string, otherName: string, value: number): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const norm = normalizeRelation(prev[otherName]);
	const standing = clamp(value, -100, 100);
	const newHistory = [
		...norm.history,
		{ event: 'alliance event', delta: standing - norm.standing, chapter: currentChapterNumber() },
	].slice(-5);
	await writeRelation(factionEntryId, otherName, {
		standing,
		affinity: standing,
		history: newHistory,
	});
}

/** Low-level: persist a single relation entry. Both helpers above funnel through this. */
async function writeRelation(
	factionEntryId: string,
	otherName: string,
	relation: { standing: number; affinity: number; history: { event: string; delta: number; chapter: number }[] },
): Promise<void> {
	const entry = story.lorebookEntries.find(e => e.id === factionEntryId);
	if (!entry || entry.type !== 'faction') return;
	const state = entry.state as FactionEntryState;
	const prev = state.interFactionRelations ?? {};
	const newRels = { ...prev, [otherName]: relation };
	const newState = { ...state, interFactionRelations: newRels };
	await updateLorebookEntry(factionEntryId, { state: newState as any, updatedAt: Date.now() });
	story.lorebookEntries = story.lorebookEntries.map(e =>
		e.id === factionEntryId ? { ...e, state: newState as any } : e,
	);
}

function currentChapterNumber(): number {
	// Best-effort: use the highest known chapter number for history attribution.
	// We don't fetch from DB to avoid making mutateRelation async-heavy.
	let max = 0;
	for (const fa of story.factionActions) {
		if (typeof fa.chapterNumber === 'number' && fa.chapterNumber > max) max = fa.chapterNumber;
	}
	return max;
}

/**
 * Build the inter-faction relation change log fed back into the next worldsim
 * tick. Walks every faction's interFactionRelations.history, flattens, and
 * returns the most recent N events sorted by chapter desc.
 */
function buildRelationChangeLog(
	factionEntries: Entry[],
	limit = 8,
): RelationChangeEvent[] {
	const log: RelationChangeEvent[] = [];
	for (const f of factionEntries) {
		const rels = (f.state as FactionEntryState | undefined)?.interFactionRelations ?? {};
		for (const [other, raw] of Object.entries(rels)) {
			if (typeof raw === 'number' || !raw) continue; // legacy entries have no history
			const history = (raw as { history?: { event: string; delta: number; chapter: number }[] }).history;
			if (!Array.isArray(history)) continue;
			for (const h of history) {
				log.push({ source: f.name, target: other, event: h.event, delta: h.delta, chapter: h.chapter });
			}
		}
	}
	// Sort by chapter desc, take top N. Deduplicate near-identical reciprocal entries
	// (A→B and B→A often mirror) by collapsing into one when source/target/delta/chapter match.
	log.sort((a, b) => b.chapter - a.chapter);
	const seen = new Set<string>();
	const dedup: RelationChangeEvent[] = [];
	for (const e of log) {
		const pair = [e.source, e.target].sort().join('|');
		const key = `${pair}|${e.chapter}|${e.delta}`;
		if (seen.has(key)) continue;
		seen.add(key);
		dedup.push(e);
		if (dedup.length >= limit) break;
	}
	return dedup;
}

/**
 * When a faction's playerStanding shifts via consequence, propagate a fraction
 * of that delta to its allies (interFactionRelations[ally] >= 30). Single-hop:
 * we never re-cascade through cascaded factions to avoid runaway changes.
 *
 * Asymmetric on purpose: enemies of enemies do NOT inherit the inverse — your
 * enemies' enemies don't automatically like you, that's a separate dynamic.
 */
async function cascadePlayerStandingThroughAllies(
	sourceFactionId: string,
	delta: number,
): Promise<void> {
	if (!story.currentStory) return;
	if (!Number.isFinite(delta) || delta === 0) return;
	const source = story.lorebookEntries.find(e => e.id === sourceFactionId);
	if (!source || source.type !== 'faction') return;
	const rels = (source.state as FactionEntryState).interFactionRelations ?? {};
	for (const [allyName, raw] of Object.entries(rels)) {
		const standing = normalizeRelation(raw).standing;
		if (standing < 30) continue;
		const ally = story.lorebookEntries.find(
			e => e.type === 'faction' && e.name === allyName && e.id !== sourceFactionId,
		);
		if (!ally) continue;
		const ratio = standing >= 60 ? 0.5 : standing >= 45 ? 0.4 : 0.3;
		const allyState = ally.state as FactionEntryState;
		const newStanding = clamp(allyState.playerStanding + delta * ratio, -100, 100);
		const newAllyState: FactionEntryState = {
			...allyState,
			playerStanding: newStanding,
			status: newStanding <= -50 ? 'hostile' : newStanding >= 50 ? 'allied' : allyState.status ?? 'unknown',
		};
		await updateLorebookEntry(ally.id, { state: newAllyState as any, updatedAt: Date.now() });
		story.lorebookEntries = story.lorebookEntries.map(e =>
			e.id === ally.id ? { ...e, state: newAllyState as any } : e,
		);
	}
}
