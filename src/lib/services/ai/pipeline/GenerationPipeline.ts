/**
 * GenerationPipeline — Mtherios
 *
 * Orchestrates all post-generation work that previously lived in StoryView.svelte.
 * Three phases:
 *   Phase 1 (Critical): Classification + world state sync (blocks UI refresh)
 *   Phase 2 (Background): Chapter/arc management, world sim, lore curation
 *   Phase 3 (Enrichment): Suggestions, action choices, style review, images
 *
 * Every step is independently failable — errors are logged and collected, never thrown.
 */

import { ai } from '$lib/services/ai';
import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { uuid } from '$lib/utils/uuid';
import {
	getChapters, createChapter, getArcs, createArc,
	createLorebookEntry, updateLorebookEntry,
	createEntryRelationship, getRelationshipsForEntry, updateEntryRelationship,
	createConversationMemory,
	createWorldEvent, updateStory,
	createStoryBeat, getStoryBeats,
} from '$lib/services/database';
import { LORE_MGMT_CHAPTER_INTERVAL } from '$lib/services/ai/lorebook/LoreManagementService';
import type { ClassificationResult, FactionSignal } from '$lib/services/ai/sdk/schemas/classifier';
import type { ActionChoice } from '$lib/services/ai/sdk/schemas/actionchoices';
import type { StyleReview } from '$lib/services/ai/sdk/schemas/style';
import type { MicroFactionResult } from '$lib/services/ai/sdk/schemas/microfaction';
import type {
	Chapter, Arc, Entry, EntryType, StoryEntry, TimeTracker,
	CharacterEntryState, LocationEntryState, LocationConnection,
	FactionEntryState, EntryRelationship, WorldEvent, Consequence,
} from '$lib/types';
import type { WorldSimulationResult } from '$lib/services/ai/sdk/schemas/worldsim';

// ── Types ──

export interface PipelineResult {
	classificationResult: ClassificationResult | null;
	actionChoices: ActionChoice[];
	styleReview: StyleReview | null;
	sceneImageUrl: string | null;
	errors: string[];
}

// ── Helpers ──

function clamp(val: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, val));
}

function makeDefaultEntryState(type: EntryType): any {
	switch (type) {
		case 'character': return { type, isPresent: false, lastSeenLocation: null, currentDisposition: null, relationship: { level: 0, status: 'neutral', history: [] }, knownFacts: [], revealedSecrets: [] };
		case 'location': return { type, isCurrentLocation: false, visitCount: 0, changes: [], presentCharacters: [], presentItems: [] };
		case 'item': return { type, inInventory: false, currentLocation: null, condition: null, uses: [] };
		case 'faction': return { type, playerStanding: 0, status: 'unknown', knownMembers: [] };
		case 'concept': return { type, revealed: false, comprehensionLevel: 'unknown', relatedEntries: [] };
		case 'event': return { type, occurred: false, occurredAt: null, witnesses: [], consequences: [] };
	}
}

function makeLoreEntry(storyId: string, name: string, type: EntryType, description: string, keywords: string[]): Entry {
	const now = Date.now();
	return {
		id: uuid(), storyId, name, type, description,
		hiddenInfo: null, aliases: [],
		state: makeDefaultEntryState(type),
		adventureState: null, creativeState: null,
		injection: { mode: 'keyword', keywords, priority: 0 },
		firstMentioned: null, lastMentioned: null, mentionCount: 0,
		createdBy: 'ai', createdAt: now, updatedAt: now,
		loreManagementBlacklisted: false, branchId: null,
	};
}

// ── Time helpers ──

function parseTimeProgression(s: string): number {
	const t = s.toLowerCase();
	if (t.includes('moment'))                          return 2;
	if (t.includes('minute') && t.includes('few'))     return 5;
	if (t.includes('minute') && t.includes('several')) return 15;
	if (t.includes('minute'))                           return 5;
	if (t.includes('hour') && (t.includes('few') || t.includes('several'))) return 180;
	if (t.includes('hour') && t.includes('half'))      return 30;
	if (t.includes('hour'))                            return 60;
	if (t.includes('day') && (t.includes('few') || t.includes('several'))) return 4320;
	if (t.includes('day') && t.includes('half'))       return 720;
	if (t.includes('day'))                             return 1440;
	if (t.includes('week'))                            return 10080;
	if (t.includes('month'))                           return 43200;
	return 0;
}

function advanceTime(tracker: TimeTracker | null, minutes: number): TimeTracker {
	const t = tracker ?? { years: 0, days: 0, hours: 0, minutes: 0 };
	let totalMinutes = t.minutes + minutes;
	let totalHours = t.hours + Math.floor(totalMinutes / 60);
	totalMinutes = totalMinutes % 60;
	let totalDays = t.days + Math.floor(totalHours / 24);
	totalHours = totalHours % 24;
	const totalYears = t.years + Math.floor(totalDays / 365);
	totalDays = totalDays % 365;
	return { years: totalYears, days: totalDays, hours: totalHours, minutes: totalMinutes };
}

// ── World sim interval (in-world days between ticks) ──

const WORLD_SIM_DAY_INTERVAL = 3;

// ── Faction mutation constants ──

const RESOURCE_COSTS: Record<string, Record<string, number>> = {
	military:     { military: -5, wealth: -3, morale: -2 },
	economic:     { wealth: -5 },
	diplomatic:   { influence: -3 },
	intelligence: { information: -5, wealth: -2 },
	internal:     { morale: 5 },
};

const URGENCY_PROGRESS: Record<string, number> = {
	background: 10, simmering: 10, emerging: 15, critical: 20,
};

const RELATION_DELTAS: Record<string, number> = {
	military: -15, diplomatic: 10, economic: -5, intelligence: -10,
};

// ══════════════════════════════════════════════════════════════
// Pipeline
// ══════════════════════════════════════════════════════════════

export class GenerationPipeline {

	/**
	 * Run all post-generation steps. Returns data for UI display.
	 */
	async runPostGeneration(narrative: string, isAdventure: boolean): Promise<PipelineResult> {
		console.log('[Pipeline] runPostGeneration called', { narrativeLen: narrative.length, isAdventure });
		const result: PipelineResult = {
			classificationResult: null,
			actionChoices: [],
			styleReview: null,
			sceneImageUrl: null,
			errors: [],
		};

		if (!narrative.trim()) return result;

		// ── Phase 1: Critical state updates (classifier → world state) ──
		const classifierConfig = settings.getServiceConfig('classifier');
		if (classifierConfig.enabled) {
			try {
				result.classificationResult = await this.runClassifier(narrative);
			} catch (e) {
				result.errors.push(`Classifier: ${e}`);
				console.error('Classifier failed:', e);
			}
		}

		// ── Phase 1b: Micro-faction sim (event-driven, runs when classifier detects faction signals) ──
		if (result.classificationResult?.factionSignals?.length) {
			try {
				await this.runMicroFactionSim(result.classificationResult.factionSignals);
			} catch (e) {
				result.errors.push(`MicroFactionSim: ${e}`);
				console.error('Micro faction sim failed:', e);
			}
		}

		// ── Phase 2 + 3: Background + enrichment (parallel) ──
		const jobs: Promise<void>[] = [];

		// Background: chapter/arc/worldsim/lore
		const memoryConfig = settings.getServiceConfig('memory');
		console.log('[Pipeline] memory config:', { enabled: memoryConfig.enabled });
		if (memoryConfig.enabled) {
			jobs.push(this.runChapterCheck().catch(e => { console.error('[Pipeline] ChapterCheck error:', e); result.errors.push(`ChapterCheck: ${e}`); }));
		}

		// Enrichment: choices, style, images
		const choicesConfig = settings.getServiceConfig('actionChoices');
		if (choicesConfig.enabled && isAdventure && story.entries.length >= 4) {
			jobs.push(
				this.runActionChoices().then(c => { result.actionChoices = c; })
					.catch(e => { result.errors.push(`ActionChoices: ${e}`); })
			);
		}

		const styleConfig = settings.getServiceConfig('styleReviewer');
		if (styleConfig.enabled) {
			jobs.push(
				this.runStyleReview(narrative).then(r => { result.styleReview = r; })
					.catch(e => { result.errors.push(`StyleReview: ${e}`); })
			);
		}

		// Auto image generation when imageGenerationMode is set
		const imageMode = settings.uiSettings.imageGenerationMode ?? story.currentStory?.settings?.imageGenerationMode;
		if (imageMode && imageMode !== 'none') {
			jobs.push(
				this.runImageGeneration(narrative).then(url => { result.sceneImageUrl = url; })
					.catch(e => { result.errors.push(`ImageGen: ${e}`); })
			);
		}

		await Promise.allSettled(jobs);

		story.preEmbedLorebook().catch(() => {});

		if (result.errors.length > 0) {
			console.warn(`Pipeline completed with ${result.errors.length} error(s):`, result.errors);
		}

		return result;
	}

	// ══════════════════════════════════════════════════════════════
	// Phase 1: Classification + State Sync
	// ══════════════════════════════════════════════════════════════

	private async runClassifier(narrative: string): Promise<ClassificationResult> {
		const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
		const result = await ai.classifier.classify(
			narrative,
			story.entries.slice(-5),
			story.characters,
			story.locations,
			story.items,
			story.storyMode,
			story.pov,
			story.tense,
			factionEntries,
		);

		// Persist characters
		for (const charUpdate of result.characters) {
			if (!charUpdate.name) continue;
			const exists = story.characters.some(c => c.name.toLowerCase() === charUpdate.name.toLowerCase());
			if (exists) {
				await story.updateCharacterFromClassification(charUpdate.name, {
					description: charUpdate.description,
					relationship: charUpdate.relationship,
					status: charUpdate.status,
					traits: charUpdate.traits,
				});
			} else {
				await story.addCharacter(charUpdate.name, charUpdate.description ?? undefined, charUpdate.relationship ?? undefined);
			}
		}

		// Persist locations — enforce single current location
		const currentLocations = result.locations.filter(l => l.current);
		if (currentLocations.length > 1) {
			console.warn(`[Pipeline] Classifier returned ${currentLocations.length} current locations, keeping last: ${currentLocations[currentLocations.length - 1].name}`);
			for (const loc of result.locations) {
				if (loc.current && loc !== currentLocations[currentLocations.length - 1]) {
					loc.current = false;
				}
			}
		}
		for (const locUpdate of result.locations) {
			if (!locUpdate.name) continue;
			await story.addOrUpdateLocation(locUpdate.name, locUpdate.description, locUpdate.current);
		}

		// Persist items
		for (const itemUpdate of result.items) {
			if (!itemUpdate.name) continue;
			await story.addOrUpdateItem(itemUpdate.name, itemUpdate.description, itemUpdate.quantity, itemUpdate.equipped, itemUpdate.location);
		}

		// Presence tracking — 'unknown' status means classifier couldn't determine, do not alter presence
		const departedNames = result.characters
			.filter(c => c.name && (c.status === 'departed' || c.status === 'deceased'))
			.map(c => c.name);
		if (departedNames.length > 0) await story.clearPresenceForCharacters(departedNames);

		const currentLoc = result.locations.find(l => l.current);
		if (currentLoc) {
			const presentNames = result.characters.filter(c => c.name && c.status === 'active').map(c => c.name);
			if (presentNames.length > 0) await story.updatePresence(presentNames, currentLoc.name);
		}

		// Auto-discover entities into lorebook
		await this.syncClassifierToLorebook(result);

		// Time progression
		if (result.timeProgression) await this.applyTimeProgression(result.timeProgression);

		// Tier 2: relationships, location connections, conversation memory, consequences
		await this.syncClassifierRelationships(result);
		await this.syncLocationConnections(result);
		const lastEntry = story.entries[story.entries.length - 1];
		if (lastEntry) await this.syncConversationMemory(result, lastEntry);
		await this.evaluateConsequences(result);

		// Persist story beats
		if (story.currentStory && result.storyBeats?.length) {
			for (const beat of result.storyBeats) {
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
					metadata: { mood: result.mood ?? null },
					branchId: story.currentStory.currentBranchId ?? null,
				});
			}
		}

		return result;
	}

	// ── Lorebook sync ──

	private async syncClassifierToLorebook(result: ClassificationResult): Promise<void> {
		if (!story.currentStory) return;
		const existingNames = new Set(story.lorebookEntries.map(e => e.name.toLowerCase()));
		const protagonistName = story.protagonist?.name?.toLowerCase();
		const newEntries: Entry[] = [];

		for (const c of result.characters) {
			if (!c.name || c.status === 'unknown') continue;
			if (c.name.toLowerCase() === protagonistName) continue;
			if (existingNames.has(c.name.toLowerCase())) continue;
			const entry = makeLoreEntry(story.currentStory.id, c.name, 'character', c.description || 'Character encountered in the story.', [c.name.toLowerCase()]);
			await createLorebookEntry(entry);
			newEntries.push(entry);
			existingNames.add(c.name.toLowerCase());
		}

		for (const l of result.locations) {
			if (!l.name || existingNames.has(l.name.toLowerCase())) continue;
			const entry = makeLoreEntry(story.currentStory.id, l.name, 'location', l.description || 'Location encountered in the story.', [l.name.toLowerCase()]);
			await createLorebookEntry(entry);
			newEntries.push(entry);
			existingNames.add(l.name.toLowerCase());
		}

		for (const i of result.items) {
			if (!i.name || existingNames.has(i.name.toLowerCase())) continue;
			const entry = makeLoreEntry(story.currentStory.id, i.name, 'item', i.description || 'Item encountered in the story.', [i.name.toLowerCase()]);
			await createLorebookEntry(entry);
			newEntries.push(entry);
			existingNames.add(i.name.toLowerCase());
		}

		if (newEntries.length > 0) story.lorebookEntries = [...story.lorebookEntries, ...newEntries];
	}

	// ── Relationships ──

	private async syncClassifierRelationships(result: ClassificationResult): Promise<void> {
		if (!story.currentStory || !result.relationships?.length) return;
		const entries = story.lorebookEntries;

		// Build entry lookup map to avoid repeated O(n) finds
		const entryByName = new Map<string, Entry>();
		for (const e of entries) entryByName.set(e.name.toLowerCase(), e);

		// Batch-load all relationships for involved sources to avoid N+1 queries
		const sourceIds = new Set<string>();
		for (const rel of result.relationships) {
			const source = entryByName.get(rel.sourceName.toLowerCase());
			if (source) sourceIds.add(source.id);
		}
		const allRels = new Map<string, EntryRelationship[]>();
		await Promise.all([...sourceIds].map(async (id) => {
			const rels = await getRelationshipsForEntry(story.currentStory!.id, id);
			allRels.set(id, rels);
		}));

		const newRels: EntryRelationship[] = [];
		for (const rel of result.relationships) {
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
				id: uuid(), storyId: story.currentStory.id,
				sourceEntryId: source.id, targetEntryId: target.id,
				type: rel.type, label: rel.label, strength: rel.strength,
				bidirectional: rel.bidirectional, metadata: null,
				createdAt: Date.now(), updatedAt: Date.now(),
			};
			await createEntryRelationship(newRel);
			newRels.push(newRel);
		}
		if (newRels.length > 0) story.entryRelationships = [...story.entryRelationships, ...newRels];
	}

	// ── Location connections ──

	private async syncLocationConnections(result: ClassificationResult): Promise<void> {
		if (!story.currentStory) return;

		// Build lookup map for location entries by lowercase name — avoids O(n^2) finds
		const locationsByName = new Map<string, Entry>();
		for (const e of story.lorebookEntries) {
			if (e.type === 'location') locationsByName.set(e.name.toLowerCase(), e);
		}

		const updatedEntries = new Map<string, Entry>();
		for (const locUpdate of result.locations) {
			if (!locUpdate.connections?.length) continue;
			const sourceEntry = locationsByName.get(locUpdate.name.toLowerCase());
			if (!sourceEntry) continue;
			const state = { ...(sourceEntry.state as LocationEntryState) };
			const conns: LocationConnection[] = state.connections ? [...state.connections] : [];
			let changed = false;
			for (const conn of locUpdate.connections) {
				const targetEntry = locationsByName.get(conn.targetName.toLowerCase());
				if (!targetEntry) continue;
				if (conns.some(c => c.targetLocationId === targetEntry.id)) continue;
				conns.push({
					targetLocationId: targetEntry.id, targetLocationName: targetEntry.name,
					direction: conn.direction, travelTime: conn.travelTimeMinutes,
					description: conn.description, blocked: false, blockedReason: null,
				});
				changed = true;
			}
			if (locUpdate.region) { state.region = locUpdate.region; changed = true; }
			if (locUpdate.terrain) { state.terrain = locUpdate.terrain; changed = true; }
			if (changed) {
				state.connections = conns;
				await updateLorebookEntry(sourceEntry.id, { state: state as any, updatedAt: Date.now() });
				updatedEntries.set(sourceEntry.id, { ...sourceEntry, state: state as any });
			}
		}
		if (updatedEntries.size > 0) {
			story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
		}
	}

	// ── Conversation memory ──

	private async syncConversationMemory(result: ClassificationResult, narrativeEntry: StoryEntry): Promise<void> {
		if (!story.currentStory || !result.conversations?.length) return;
		const updatedEntries = new Map<string, Entry>();
		for (const conv of result.conversations) {
			const npcEntry = story.lorebookEntries.find(e => e.type === 'character' && e.name.toLowerCase() === conv.npcName.toLowerCase());
			if (!npcEntry) continue;
			await createConversationMemory({
				id: uuid(), storyId: story.currentStory.id,
				npcEntryId: npcEntry.id, npcName: conv.npcName,
				storyEntryId: narrativeEntry.id, storyPosition: narrativeEntry.position,
				topic: conv.topicSummary, playerSaid: conv.playerRevealed.join('; '),
				npcLearned: conv.npcLearned, emotionalImpact: conv.emotionalShift,
				importance: conv.importance, createdAt: Date.now(),
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

	// ── World events / consequences ──

	private async evaluateConsequences(result: ClassificationResult): Promise<void> {
		if (!story.currentStory) return;
		const lastEntry = story.entries[story.entries.length - 1];
		if (!lastEntry) return;
		const newEvents: WorldEvent[] = [];
		for (const c of result.characters) {
			if (c.status !== 'deceased') continue;
			const charEntry = story.lorebookEntries.find(e => e.type === 'character' && e.name.toLowerCase() === c.name.toLowerCase());
			if (!charEntry) continue;
			const rels = await getRelationshipsForEntry(story.currentStory.id, charEntry.id);
			const factionRels = rels.filter(r => r.type === 'member-of' || r.type === 'serves' || r.type === 'leader-of');
			const consequences: Consequence[] = [];
			for (const rel of factionRels) {
				const factionEntry = story.lorebookEntries.find(e => e.id === rel.targetEntryId && e.type === 'faction');
				if (!factionEntry) continue;
				const impact = rel.type === 'leader-of' ? -40 : -20;
				consequences.push({
					id: uuid(), description: `${factionEntry.name} turns hostile after ${c.name}'s death`,
					status: 'pending', targetEntityId: factionEntry.id, targetEntityName: factionEntry.name,
					effectType: 'faction_status_change', effectPayload: { playerStandingDelta: impact },
					delay: 0, appliedAt: null,
				});
			}
			if (consequences.length > 0) {
				const event: WorldEvent = {
					id: uuid(), storyId: story.currentStory.id,
					name: `${c.name} killed`, description: `${c.name} has been killed, triggering faction consequences.`,
					triggerEntryId: lastEntry.id, triggerPosition: lastEntry.position,
					sourceEntityId: charEntry.id, type: 'death', severity: 'major',
					consequences, appliedAt: null, createdAt: Date.now(),
				};
				await createWorldEvent(event);
				newEvents.push(event);
				for (const cons of consequences) {
					if (cons.delay === 0) await this.applyConsequence(cons);
				}
			}
		}
		if (newEvents.length > 0) story.worldEvents = [...story.worldEvents, ...newEvents];
	}

	private async applyConsequence(consequence: Consequence): Promise<void> {
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
			story.lorebookEntries = story.lorebookEntries.map(e => e.id === entry.id ? { ...e, state: state as any } : e);
		}
	}

	// ── Time ──

	private async applyTimeProgression(progression: string): Promise<void> {
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
					await this.runWorldSimulation(chapters);
					await updateStory(story.currentStory.id, { lastWorldSimDay: totalDays } as any);
					story.currentStory = { ...story.currentStory, lastWorldSimDay: totalDays };
					console.log(`World sim triggered at day ${totalDays} (last: ${lastSimDay})`);
				} catch (e) {
					console.error('Time-based world sim failed:', e);
				}
			}
		}
	}

	// ══════════════════════════════════════════════════════════════
	// Phase 2: Background — Chapters, Arcs, WorldSim, Lore
	// ══════════════════════════════════════════════════════════════

	private async runChapterCheck(): Promise<void> {
		if (!story.currentStory) return;
		const chapters = await getChapters(story.currentStory.id);
		let lastChapterEndIndex = 0;
		if (chapters.length > 0) {
			const foundIdx = story.entries.findIndex(e => e.id === chapters[chapters.length - 1].endEntryId);
			if (foundIdx < 0) {
				console.warn('Chapter endEntryId not found in entries — skipping chapter check');
				return;
			}
			lastChapterEndIndex = foundIdx + 1;
		}
		const entriesOutsideChapter = story.entries.slice(lastChapterEndIndex);
		console.log('[Pipeline] Chapter check:', { totalEntries: story.entries.length, lastChapterEndIndex, entriesOutside: entriesOutsideChapter.length, threshold: 20 });
		if (entriesOutsideChapter.length < 20) return;

		// Only analyze first 50 entries for boundary detection — chapter covers oldest unchaptered content
		const analysisWindow = entriesOutsideChapter.slice(0, 50);
		const tokensOutsideBuffer = entriesOutsideChapter.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
		const analysis = await ai.memory.analyzeForChapter(
			analysisWindow, lastChapterEndIndex, tokensOutsideBuffer,
			story.storyMode, story.pov, story.tense,
		);

		console.log('[Pipeline] Chapter analysis result:', analysis);
		if (!analysis.shouldCreateChapter) return;

		// Clamp optimalEndIndex to the valid range of the analysis window
		const maxIndex = analysisWindow.length - 1;
		const clampedIndex = Math.max(0, Math.min(analysis.optimalEndIndex, maxIndex));
		if (clampedIndex !== analysis.optimalEndIndex) {
			console.warn(`[Pipeline] Clamped optimalEndIndex from ${analysis.optimalEndIndex} to ${clampedIndex} (window size: ${analysisWindow.length})`);
		}

		const chapterEntries = entriesOutsideChapter.slice(0, clampedIndex + 1);
		if (chapterEntries.length === 0) return;

		// Gather classifier beats for this chapter's time range
		const allBeats = await getStoryBeats(story.currentStory.id);
		const chapterStart = chapterEntries[0].createdAt;
		const chapterEnd = chapterEntries[chapterEntries.length - 1].createdAt;
		const relevantBeats = allBeats.filter(b =>
			b.triggeredAt && b.triggeredAt >= chapterStart && b.triggeredAt <= chapterEnd
		);

		const enrichment = relevantBeats.length > 0 ? {
			storyBeats: relevantBeats.map(b => ({
				title: b.title,
				description: b.description ?? '',
				significance: (b.metadata?.significance as string) ?? 'moderate',
			})),
		} : undefined;

		const summaryResult = await ai.memory.summarizeChapter(chapterEntries, chapters, story.storyMode, story.pov, story.tense, enrichment);
		const chapter: Chapter = {
			id: uuid(), storyId: story.currentStory.id,
			number: chapters.length + 1, title: summaryResult.title,
			startEntryId: chapterEntries[0].id, endEntryId: chapterEntries[chapterEntries.length - 1].id,
			entryCount: chapterEntries.length, summary: summaryResult.summary,
			startTime: null, endTime: null,
			keywords: summaryResult.keywords, characters: summaryResult.keyCharacters,
			locations: summaryResult.keyLocations,
			plotThreads: relevantBeats
				.filter(b => ['critical', 'major'].includes((b.metadata?.significance as string) ?? ''))
				.map(b => b.title),
			emotionalTone: summaryResult.emotionalTone,
			branchId: story.currentStory.currentBranchId ?? null,
			createdAt: Date.now(),
		};
		await createChapter(chapter);
		console.log(`Chapter ${chapter.number} created: "${chapter.title}"`);

		// Advance conversation history floor — chapter summary now carries the older context,
		// so keep only the last 10 entries in raw chat history to prevent context rot.
		const POST_CHAPTER_HISTORY = 10;
		story.chatHistoryFloor = Math.max(story.chatHistoryFloor, story.entries.length - POST_CHAPTER_HISTORY);

		// Embed chapter summary (background)
		ai.embeddings.embed(`${chapter.title ?? 'Chapter ' + chapter.number}: ${chapter.summary}`, chapter.id, 'chapter')
			.catch(e => console.error(`[Pipeline] Failed to embed chapter ${chapter.number}:`, e));

		const allChapters = [...chapters, chapter];

		// Arc condensation
		await this.runAutoArcCondensation(allChapters);

		// Lore management
		if (chapter.number % LORE_MGMT_CHAPTER_INTERVAL === 0) {
			await this.runLoreManagement(allChapters);
		}
	}

	private async runAutoArcCondensation(chapters: Chapter[]): Promise<void> {
		if (!story.currentStory) return;
		const arcConfig = settings.getServiceConfig('arcCondensation');
		if (!arcConfig.enabled) return;

		const arcs = await getArcs(story.currentStory.id);
		const coveredChapterIds = new Set(arcs.flatMap(a => a.chapterIds));
		const uncoveredChapters = chapters.filter(c => !coveredChapterIds.has(c.id) && !c.pinned).sort((a, b) => a.number - b.number);
		if (uncoveredChapters.length < 5) return;

		const arcNumber = arcs.length + 1;
		const result = await ai.arcCondensation.condense(uncoveredChapters, arcNumber, story.storyMode, story.pov, story.tense);
		const firstCh = uncoveredChapters[0];
		const lastCh = uncoveredChapters[uncoveredChapters.length - 1];
		const arc: Arc = {
			id: uuid(), storyId: story.currentStory!.id, arcNumber,
			title: result.title, summary: result.summary,
			keyPlotPoints: result.keyPlotPoints, characterArcs: result.characterArcs,
			unresolvedThreads: result.unresolvedThreads, emotionalProgression: result.emotionalProgression,
			chapterIds: uncoveredChapters.map(c => c.id), chapterRange: `${firstCh.number}-${lastCh.number}`,
			branchId: story.currentStory!.currentBranchId ?? null, createdAt: Date.now(),
		};
		await createArc(arc);
		console.log(`Auto arc ${arcNumber}: "${arc.title}" (Ch.${arc.chapterRange})`);

		// CASS reflection — fire and forget
		const procConfig = settings.getServiceConfig('proceduralMemory');
		if (procConfig.enabled) {
			ai.proceduralMemory.reflect(chapters, [...arcs, arc], story.lorebookEntries, story.currentStory!.id, story.storyMode).catch(console.error);
		}
	}

	private async runLoreManagement(chapters: Chapter[]): Promise<void> {
		if (!story.currentStory) return;
		const loreConfig = settings.getServiceConfig('loreManagement');
		if (!loreConfig.enabled) return;

		const arcs = await getArcs(story.currentStory.id);
		const result = await ai.loreManagement.manage(chapters, arcs, story.lorebookEntries);

		const newEntries: Entry[] = [];
		const updatedEntries = new Map<string, Partial<Entry>>();
		for (const update of result.updates) {
			if (update.action === 'create') {
				const existing = story.lorebookEntries.find(e => e.name.toLowerCase() === update.name.toLowerCase());
				if (!existing) {
					const entry = makeLoreEntry(story.currentStory!.id, update.name, update.type as EntryType, update.description, update.keywords);
					if (update.type === 'character') {
						const cState = entry.state as CharacterEntryState;
						if (update.bio) cState.bio = update.bio;
						if (update.motivations) cState.motivations = update.motivations;
						if (update.personality) cState.personality = update.personality;
					}
					await createLorebookEntry(entry);
					newEntries.push(entry);
				}
			} else if (update.action === 'update' && update.entryId) {
				const existing = story.lorebookEntries.find(e => e.id === update.entryId);
				const updatePayload: Partial<Entry> = {
					description: update.description,
					injection: existing ? { ...existing.injection, keywords: update.keywords } : { mode: 'keyword', keywords: update.keywords, priority: 0 },
				};
				if (existing?.type === 'character' && (update.bio !== undefined || update.motivations !== undefined || update.personality !== undefined)) {
					const cState = { ...(existing.state as CharacterEntryState) };
					if (update.bio !== undefined) cState.bio = update.bio;
					if (update.motivations !== undefined) cState.motivations = update.motivations;
					if (update.personality !== undefined) cState.personality = update.personality;
					updatePayload.state = cState;
				}
				await updateLorebookEntry(update.entryId, updatePayload);
				updatedEntries.set(update.entryId, updatePayload);
			}
		}
		if (newEntries.length > 0) story.lorebookEntries = [...story.lorebookEntries, ...newEntries];
		if (updatedEntries.size > 0) {
			story.lorebookEntries = story.lorebookEntries.map(e => {
				const patch = updatedEntries.get(e.id);
				return patch ? { ...e, ...patch } : e;
			});
		}
	}

	private async runWorldSimulation(chapters: Chapter[]): Promise<void> {
		if (!story.currentStory) return;
		const wsConfig = settings.getServiceConfig('worldSimulation');
		if (!wsConfig.enabled) return;

		const arcs = await getArcs(story.currentStory.id);
		const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
		const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');

		const result = await ai.worldSim.simulate(
			chapters, arcs, story.entries, factionEntries, characterEntries,
			story.entryRelationships, story.currentStory.timeTracker,
			story.storyMode, story.pov, story.tense,
		);

		story.lastWorldSimResult = result;
		await this.applyWorldSimMutations(result, chapters);

		if (result.plotInjection) {
			console.log(`World sim: plot injection (${result.plotInjection.urgency})`);
		}
	}

	// ── Micro-faction sim (event-driven, triggered by classifier signals) ──

	private async runMicroFactionSim(signals: FactionSignal[]): Promise<void> {
		if (!story.currentStory) return;
		const wsConfig = settings.getServiceConfig('worldSimulation');
		if (!wsConfig.enabled) return;

		const factionEntries = story.lorebookEntries.filter(e => e.type === 'faction');
		const characterEntries = story.lorebookEntries.filter(e => e.type === 'character');

		const results = await ai.microFactionSim.processSignals(
			signals, factionEntries, characterEntries, story.entryRelationships,
		);

		if (results.length === 0) return;

		// Apply resource mutations for non-"none" reactions
		const chapters = await getChapters(story.currentStory.id);
		const currentChapterNum = chapters.length > 0 ? chapters[chapters.length - 1].number : 0;
		const factionsByName: Record<string, Entry> = {};
		for (const e of factionEntries) factionsByName[e.name.toLowerCase()] = e;
		const updatedEntries = new Map<string, Entry>();

		for (const r of results) {
			if (r.reaction.actionType === 'none') continue;
			const factionEntry = factionsByName[r.factionName.toLowerCase()];
			if (!factionEntry) continue;
			const state = { ...(factionEntry.state as FactionEntryState) };

			// Apply lightweight resource costs (same constants as full sim)
			if (state.resources) {
				const costs = RESOURCE_COSTS[r.reaction.actionType];
				if (costs) {
					const res = { ...state.resources };
					for (const [key, delta] of Object.entries(costs)) {
						(res as any)[key] = clamp((res as any)[key] + delta, 0, 100);
					}
					state.resources = res;
				}
			}

			state.lastActionChapter = currentChapterNum;
			await updateLorebookEntry(factionEntry.id, { state: state as any, updatedAt: Date.now() });
			updatedEntries.set(factionEntry.id, { ...factionEntry, state: state as any });
		}

		if (updatedEntries.size > 0) {
			story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
		}

		// Store reactions for context assembly injection.
		// Lifecycle: appended here → consumed by ContextAssembler.assemble() → cleared by ActionInput after context read.
		story.pendingFactionReactions = [
			...(story.pendingFactionReactions ?? []),
			...results,
		];

		console.log(`Micro-faction sim: ${results.length} reaction(s) from ${signals.length} signal(s)`);
	}

	private async applyWorldSimMutations(result: WorldSimulationResult, chapters: Chapter[]): Promise<void> {
		if (!story.currentStory || !result.factionActions?.length) return;
		const currentChapterNum = chapters.length > 0 ? chapters[chapters.length - 1].number : 0;

		const factionsByName: Record<string, Entry> = {};
		for (const e of story.lorebookEntries) {
			if (e.type === 'faction') factionsByName[e.name.toLowerCase()] = e;
		}

		const updatedEntries = new Map<string, Entry>();

		for (const action of result.factionActions) {
			if (action.actionType === 'none') continue;
			const factionEntry = factionsByName[action.factionName.toLowerCase()];
			if (!factionEntry) continue;
			const state = { ...(factionEntry.state as FactionEntryState) };

			// Goal progress
			if (state.goals?.length) {
				const progressAmount = URGENCY_PROGRESS[action.urgency] ?? 10;
				const matchingGoal = state.goals.find(g => g.type === action.actionType);
				const targetGoal = matchingGoal ?? state.goals.reduce((a, b) => a.priority > b.priority ? a : b);
				targetGoal.progress = clamp(targetGoal.progress + (matchingGoal ? progressAmount : Math.floor(progressAmount / 2)), 0, 100);
				state.goals = [...state.goals];
			}

			// Resource costs
			if (state.resources) {
				const costs = RESOURCE_COSTS[action.actionType];
				if (costs) {
					const r = { ...state.resources };
					for (const [key, delta] of Object.entries(costs)) (r as any)[key] = clamp((r as any)[key] + delta, 0, 100);
					state.resources = r;
				}
			}

			// Inter-faction relations
			if (action.target && state.interFactionRelations) {
				const relationDelta = RELATION_DELTAS[action.actionType] ?? 0;
				if (relationDelta !== 0) {
					const relations = { ...state.interFactionRelations };
					relations[action.target] = clamp((relations[action.target] ?? 0) + relationDelta, -100, 100);
					state.interFactionRelations = relations;
					// Mirror
					const targetEntry = factionsByName[action.target.toLowerCase()];
					if (targetEntry) {
						const targetState = { ...(targetEntry.state as FactionEntryState) };
						if (targetState.interFactionRelations) {
							const tr = { ...targetState.interFactionRelations };
							tr[action.factionName] = clamp((tr[action.factionName] ?? 0) + relationDelta, -100, 100);
							targetState.interFactionRelations = tr;
							await updateLorebookEntry(targetEntry.id, { state: targetState as any, updatedAt: Date.now() });
							updatedEntries.set(targetEntry.id, { ...targetEntry, state: targetState as any });
						}
					}
				}
			}

			state.lastActionChapter = currentChapterNum;
			await updateLorebookEntry(factionEntry.id, { state: state as any, updatedAt: Date.now() });
			updatedEntries.set(factionEntry.id, { ...factionEntry, state: state as any });
		}

		if (updatedEntries.size > 0) {
			story.lorebookEntries = story.lorebookEntries.map(e => updatedEntries.get(e.id) ?? e);
		}
	}

	// ══════════════════════════════════════════════════════════════
	// Phase 3: UI Enrichment
	// ══════════════════════════════════════════════════════════════

	private async runActionChoices(): Promise<ActionChoice[]> {
		const currentLoc = story.locations.find(l => l.current);
		const result = await ai.actionChoices.generateChoices(
			story.entries.slice(-5), story.protagonist, currentLoc, story.storyMode,
		);
		return result.choices;
	}

	private async runStyleReview(narrative: string): Promise<StyleReview> {
		return ai.styleReviewer.review(narrative, story.pov, story.tense, story.currentStory?.genre ?? '');
	}

	private async runImageGeneration(narrative: string): Promise<string | null> {
		const recentNarration = story.entries
			.filter(e => e.type === 'narration')
			.slice(-3)
			.map(e => e.content)
			.join('\n');
		if (!recentNarration && !narrative) return null;

		const currentLoc = story.locations.find(l => l.current);
		const sceneContext = {
			characters: story.characters
				.filter(c => c.status === 'active')
				.slice(0, 3)
				.map(c => ({ name: c.name, visualDescriptors: c.visualDescriptors })),
			currentLocation: currentLoc
				? { name: currentLoc.name, description: currentLoc.description }
				: undefined,
		};

		const result = await ai.imageGen.generateSceneImage(
			recentNarration || narrative,
			sceneContext,
		);
		return result.image?.url ?? null;
	}

}
