/**
 * Background Services Runner — Mtherios Orchestrator
 *
 * Replaces GenerationPipeline Phase 2 (background jobs).
 * Runs after every world-state update, checks thresholds, fires infrequent jobs.
 *
 * - Chapter creation: every 20 completed story turns
 * - Arc condensation: every 10 consecutive chapters
 * - Lore management: every LORE_MGMT_CHAPTER_INTERVAL chapters
 *
	 * Canonical faction and NPC movement is owned by backend jobs.
 */

import { ai } from '$lib/services/ai';
import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { CHAPTERS_PER_ARC, selectNextChapterWindow } from '$lib/services/chapterCadence';
import { uuid } from '$lib/utils/uuid';
import {
	getChapters, getArcs,
	getSagas,
	getStoryBeats,
	getStoryEntry, getStoryEntriesAfterPosition,
} from '$lib/services/database';
import {
	patchCanonicalLorebookEntry,
	saveCanonicalArc,
	saveCanonicalChapter,
	saveCanonicalSaga,
	saveCanonicalLorebookEntry,
} from '$lib/services/canonicalWrites';
import { findMatchingLoreEntry, makeLoreEntry } from '$lib/services/ai/tools/helpers';
import { LORE_MGMT_CHAPTER_INTERVAL } from '$lib/services/ai/lorebook/LoreManagementService';
import type {
	Chapter, Arc, Entry, Saga, StoryEntry,
	CharacterEntryState, FactionEntryState,
	FactionGoal, FactionResources,
} from '$lib/types';

type FactionGoalInput = Omit<Partial<FactionGoal>, 'deadline'> & {
	description: string;
	deadline?: string | null;
};

function chaptersForBranch(chapters: Chapter[], branchId: string | null): Chapter[] {
	return chapters
		.filter(chapter => (chapter.branchId ?? null) === branchId)
		.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
}

function applyCurrentStoryServerVersion(serverVersion: number | null): void {
	if (!serverVersion || !story.currentStory) return;
	story.currentStory = {
		...story.currentStory,
		serverVersion,
		syncStatus: 'synced',
	};
}

function getBeatSignificance(beat: { significance?: string | null; metadata?: Record<string, unknown> | null }): string {
	const metadataSignificance = beat.metadata?.significance;
	return beat.significance ?? (typeof metadataSignificance === 'string' ? metadataSignificance : undefined) ?? 'minor';
}

/**
 * Run all threshold-based background jobs.
 * Returns error messages for any failed jobs (never throws).
 */
export async function runBackgroundJobs(): Promise<string[]> {
	const errors: string[] = [];
	const jobs: Promise<void>[] = [];

	const memoryConfig = settings.getServiceConfig('memory');
	if (memoryConfig.enabled) {
		jobs.push(
			runChapterCheck().catch(e => {
				const msg = `ChapterCheck: ${e}`;
				errors.push(msg);
				console.error(`[Background] ${msg}`);
			})
		);
	}

	await Promise.all(jobs);
	return errors;
}

// ══════════════════════════════════════════════════════════════
// Chapter check — extracted from GenerationPipeline.runChapterCheck()
// ══════════════════════════════════════════════════════════════

async function runChapterCheck(): Promise<void> {
	if (!story.currentStory) return;

	const branchId = story.currentStory.currentBranchId ?? null;
	const chapters = chaptersForBranch(await getChapters(story.currentStory.id), branchId);
	let lastChapterEndPosition = -1;
	if (chapters.length > 0) {
		const lastChapter = chapters[chapters.length - 1];
		const endEntry = await getStoryEntry(lastChapter.endEntryId)
			?? story.entries.find(e => e.id === lastChapter.endEntryId);
		if (!endEntry) {
			console.warn('[Background] Chapter endEntryId not found — skipping chapter check');
			console.warn('[Background] Chapter check details:', {
				chapterId: lastChapter.id,
				endEntryId: lastChapter.endEntryId,
			});
			return;
		}
		lastChapterEndPosition = endEntry.position;
	}

	const entriesOutsideChapter: StoryEntry[] = [];
	const coveredSourceIds = new Set(chapters.flatMap(chapter => chapter.sourceEntryIds ?? []));
	let cursor = lastChapterEndPosition;
	let window = selectNextChapterWindow(entriesOutsideChapter, branchId);
	while (!window) {
		const page = await getStoryEntriesAfterPosition(story.currentStory.id, cursor, 100, branchId);
		if (!page.length) return;
		entriesOutsideChapter.push(...page);
		const loadedIds = new Set(entriesOutsideChapter.map(entry => entry.id));
		const missingParentIds = [...new Set(page.filter(entry => entry.type === 'narration' && entry.parentId && !loadedIds.has(entry.parentId))
			.map(entry => entry.parentId!))];
		const missingParents = await Promise.all(missingParentIds.map(id => getStoryEntry(id)));
		entriesOutsideChapter.push(...missingParents.filter((entry): entry is StoryEntry => Boolean(entry) && !coveredSourceIds.has(entry!.id)));
		window = selectNextChapterWindow(entriesOutsideChapter, branchId);
		const nextCursor = page.at(-1)!.position;
		if (window || page.length < 100 || nextCursor <= cursor) break;
		cursor = nextCursor;
	}
	if (!window) return;
	const chapterEntries = window.entries;

	// Gather story beats for enrichment
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
			significance: getBeatSignificance(b),
		})),
	} : undefined;

	// Fetch arcs for long-term context
	const arcs = await getArcs(story.currentStory.id);

	const maxPrevChapters = settings.uiSettings.maxPrevChaptersInSummary || 5;
	const summaryResult = await ai.memory.summarizeChapter(
		chapterEntries, chapters, story.storyMode, story.pov, story.tense, enrichment, arcs, maxPrevChapters,
	);

	const chapter: Chapter = {
		id: uuid(), storyId: story.currentStory.id,
		number: chapters.length + 1, title: summaryResult.title,
		startEntryId: chapterEntries[0].id, endEntryId: chapterEntries[chapterEntries.length - 1].id,
		entryCount: chapterEntries.length, summary: summaryResult.summary,
		sourceEntryIds: chapterEntries.map(entry => entry.id),
		startTime: null, endTime: null,
		keywords: summaryResult.keywords, characters: summaryResult.keyCharacters,
		locations: summaryResult.keyLocations,
		plotThreads: relevantBeats
			.filter(b => ['critical', 'major'].includes(getBeatSignificance(b)))
			.map(b => b.title),
		emotionalTone: summaryResult.emotionalTone,
		branchId: story.currentStory.currentBranchId ?? null,
		createdAt: Date.now(),
	};
	applyCurrentStoryServerVersion(await saveCanonicalChapter(chapter, 'create'));
	console.log(`[Background] Chapter ${chapter.number} created: "${chapter.title}"`);

	// Embed chapter summary (background)
	ai.embeddings.embed(`${chapter.title ?? 'Chapter ' + chapter.number}: ${chapter.summary}`, chapter.id, 'chapter')
		.catch(e => console.error(`[Background] Failed to embed chapter ${chapter.number}:`, e));

	const allChapters = [...chapters, chapter];

	// Arc condensation
	await runAutoArcCondensation(allChapters);

	// Lore management
	if (chapter.number % LORE_MGMT_CHAPTER_INTERVAL === 0) {
		await runLoreManagement(allChapters);
	}
}

// ══════════════════════════════════════════════════════════════
// Chapter-triggered condensation checks
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// Arc condensation — extracted from GenerationPipeline
// ══════════════════════════════════════════════════════════════

async function runAutoArcCondensation(chapters: Chapter[]): Promise<void> {
	if (!story.currentStory) return;
	const arcConfig = settings.getServiceConfig('arcCondensation');
	if (!arcConfig.enabled) return;

	const arcs = await getArcs(story.currentStory.id);
	const coveredChapterIds = new Set(arcs.flatMap(a => a.chapterIds));
	const uncoveredChapters = chapters
		.filter(c => !coveredChapterIds.has(c.id))
		.sort((a, b) => a.number - b.number);
	if (uncoveredChapters.length < CHAPTERS_PER_ARC) return;
	const arcChapters = uncoveredChapters.slice(0, CHAPTERS_PER_ARC);
	if (arcChapters.some((chapter, index) => chapter.number !== arcChapters[0].number + index)) return;

	const arcNumber = arcs.length + 1;
	const result = await ai.arcCondensation.condense(
		arcChapters, arcNumber, story.storyMode, story.pov, story.tense, arcs,
	);
	const firstCh = arcChapters[0];
	const lastCh = arcChapters[arcChapters.length - 1];
	const arc: Arc = {
		id: uuid(), storyId: story.currentStory.id, arcNumber,
		title: result.title, summary: result.summary,
		keyPlotPoints: result.keyPlotPoints, characterArcs: result.characterArcs,
		unresolvedThreads: result.unresolvedThreads, threadIds: [], resolvedThreadIds: [],
		emotionalProgression: result.emotionalProgression,
		chapterIds: arcChapters.map(c => c.id), chapterRange: `${firstCh.number}-${lastCh.number}`,
		branchId: story.currentStory.currentBranchId ?? null, createdAt: Date.now(),
	};
	applyCurrentStoryServerVersion(await saveCanonicalArc(arc, 'create'));
	console.log(`[Background] Auto arc ${arcNumber}: "${arc.title}" (Ch.${arc.chapterRange})`);
	await runAutoSagaCondensation([...arcs, arc]);

	// ponytail: arc/saga summaries are the memory ladder; don't generate a parallel procedural-rules store.
}

// ══════════════════════════════════════════════════════════════
// Lore management — extracted from GenerationPipeline
// ══════════════════════════════════════════════════════════════

async function runAutoSagaCondensation(arcs: Arc[]): Promise<void> {
	if (!story.currentStory) return;
	const sagaConfig = settings.getServiceConfig('sagaCondensation');
	if (!sagaConfig.enabled) return;

	const storyId = story.currentStory.id;
	const sagas = await getSagas(storyId);
	const sortedArcs = [...arcs].sort((a, b) => a.arcNumber - b.arcNumber || a.createdAt - b.createdAt);
	const sagaArcs = ai.sagaCondensation.getCondensableArcs(sortedArcs, sagas.length);
	if (sagaArcs.length === 0) return;

	const sagaNumber = sagas.length + 1;
	const result = await ai.sagaCondensation.condense(
		sagaArcs,
		sagaNumber,
		story.storyMode,
		story.pov,
		story.tense,
	);
	const firstArc = sagaArcs[0];
	const lastArc = sagaArcs[sagaArcs.length - 1];
	const saga: Saga = {
		id: uuid(),
		storyId,
		sagaNumber,
		title: result.title,
		summary: result.summary,
		arcIds: sagaArcs.map(a => a.id),
		arcRange: result.arcRange || `Arcs ${firstArc.arcNumber}-${lastArc.arcNumber}`,
		keyFactionShifts: result.keyFactionShifts,
		majorPowerChanges: result.majorPowerChanges,
		lingeringThreads: result.lingeringThreads,
		overallTone: result.overallTone,
		branchId: story.currentStory.currentBranchId ?? null,
		createdAt: Date.now(),
	};
	applyCurrentStoryServerVersion(await saveCanonicalSaga(saga, 'create'));
	console.log(`[Background] Auto saga ${sagaNumber}: "${saga.title}" (${saga.arcRange})`);
}

async function runLoreManagement(chapters: Chapter[]): Promise<void> {
	if (!story.currentStory) return;
	const loreConfig = settings.getServiceConfig('loreManagement');
	if (!loreConfig.enabled) return;

	const arcs = await getArcs(story.currentStory.id);
	const result = await ai.loreManagement.manage(chapters, arcs, story.lorebookEntries);

	const newEntries: Entry[] = [];
	const updatedEntries = new Map<string, Partial<Entry>>();

	for (const update of result.updates) {
		if (update.action === 'create') {
			const existing = findMatchingLoreEntry(story.lorebookEntries, {
				name: update.name,
				type: update.type as any,
				aliases: [],
			});
			if (update.type === 'character' && !existing) {
				continue;
			}
			if (!existing) {
				const entry = makeLoreEntry(story.currentStory.id, update.name, update.type as any, update.description, update.keywords);
				if (update.type === 'character') {
					const cState = entry.state as CharacterEntryState;
					if (update.bio) cState.bio = update.bio;
					if (update.motivations) cState.motivations = update.motivations;
					if (update.personality) cState.personality = update.personality;
				} else if (update.type === 'faction') {
					const fState = entry.state as FactionEntryState;
					applyFactionUpdateState(fState, update);
				}
				applyCurrentStoryServerVersion(await saveCanonicalLorebookEntry(entry, 'create'));
				newEntries.push(entry);
			} else {
				const updatePayload = buildLoreUpdatePayload(existing, update.description, update.keywords, update);
				const result = await patchCanonicalLorebookEntry(existing.id, updatePayload);
				applyCurrentStoryServerVersion(result.serverVersion);
				updatedEntries.set(existing.id, updatePayload);
			}
		} else if (update.action === 'update' && update.entryId) {
			const existing = story.lorebookEntries.find(e => e.id === update.entryId);
			const updatePayload = existing
				? buildLoreUpdatePayload(existing, update.description, update.keywords, update)
				: {
						description: update.description,
						injection: { mode: 'keyword', keywords: update.keywords, priority: 0 },
					} satisfies Partial<Entry>;
			const result = await patchCanonicalLorebookEntry(update.entryId, updatePayload);
			applyCurrentStoryServerVersion(result.serverVersion);
			updatedEntries.set(update.entryId, updatePayload);
		} else if (update.action === 'merge' && update.entryId) {
			const keep = story.lorebookEntries.find(e => e.id === update.entryId);
			const mergeFrom = findMatchingLoreEntry(
				story.lorebookEntries.filter(e => e.id !== update.entryId),
				{ name: update.name, type: update.type as any },
			);
			if (keep && mergeFrom) {
				const updatePayload: Partial<Entry> = {
					description: mergeLoreDescription(keep.description, mergeFrom.description),
					aliases: [...new Set([...(keep.aliases ?? []), mergeFrom.name, ...(mergeFrom.aliases ?? [])])],
					injection: {
						...keep.injection,
						keywords: [...new Set([...(keep.injection?.keywords ?? []), ...(mergeFrom.injection?.keywords ?? [])])],
					},
					updatedAt: Date.now(),
				};
				const keepResult = await patchCanonicalLorebookEntry(keep.id, updatePayload);
				applyCurrentStoryServerVersion(keepResult.serverVersion);
				const mergeResult = await patchCanonicalLorebookEntry(mergeFrom.id, {
					deleted: true,
					injection: { ...(mergeFrom.injection ?? { mode: 'keyword', keywords: [], priority: 0 }), mode: 'never' },
					updatedAt: Date.now(),
				});
				applyCurrentStoryServerVersion(mergeResult.serverVersion);
				updatedEntries.set(keep.id, updatePayload);
				updatedEntries.set(mergeFrom.id, { deleted: true } as Partial<Entry>);
			}
		} else if (update.action === 'archive' && update.entryId) {
			const existing = story.lorebookEntries.find(e => e.id === update.entryId);
			if (existing) {
				const updatePayload: Partial<Entry> = {
					injection: { ...existing.injection, mode: 'never' },
					loreManagementBlacklisted: true,
					updatedAt: Date.now(),
				};
				const result = await patchCanonicalLorebookEntry(update.entryId, updatePayload);
				applyCurrentStoryServerVersion(result.serverVersion);
				updatedEntries.set(update.entryId, updatePayload);
			}
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

function buildLoreUpdatePayload(
	existing: Entry,
	description: string,
	keywords: string[],
	update: {
		bio?: string | null;
		motivations?: string[] | null;
		personality?: string | null;
		knownMembers?: string[] | null;
		goals?: FactionGoalInput[] | null;
		resources?: FactionResources | null;
		disposition?: FactionEntryState['disposition'] | null;
		territory?: string[] | null;
	},
): Partial<Entry> {
	const updatePayload: Partial<Entry> = {
		description: mergeLoreDescription(existing.description, description),
		injection: {
			...existing.injection,
			keywords: [...new Set([...(existing.injection?.keywords ?? []), ...keywords])],
		},
		updatedAt: Date.now(),
	};
	if (existing.type === 'character' && (update.bio !== undefined || update.motivations !== undefined || update.personality !== undefined)) {
		const cState = { ...(existing.state as CharacterEntryState) };
		if (update.bio !== undefined) cState.bio = update.bio;
		if (update.motivations !== undefined) cState.motivations = update.motivations;
		if (update.personality !== undefined) cState.personality = update.personality;
		updatePayload.state = cState;
	} else if (existing.type === 'faction') {
		const fState = { ...(existing.state as FactionEntryState) };
		if (applyFactionUpdateState(fState, update)) updatePayload.state = fState;
	}
	return updatePayload;
}

function applyFactionUpdateState(
	state: FactionEntryState,
	update: {
		knownMembers?: string[] | null;
		goals?: FactionGoalInput[] | null;
		resources?: FactionResources | null;
		disposition?: FactionEntryState['disposition'] | null;
		territory?: string[] | null;
	},
): boolean {
	let changed = false;
	if (update.knownMembers?.length) {
		const members = resolveFactionKnownMembers(update.knownMembers);
		state.knownMembers = mergeStringList(state.knownMembers ?? [], members.knownMemberIds);
		state.unresolvedKnownMembers = mergeStringList(
			state.unresolvedKnownMembers ?? [],
			members.unresolvedMemberNames,
		).filter(name => !members.resolvedMemberNames.has(name.toLowerCase()));
		changed = true;
	}
	if (update.goals?.length) {
		const existing = state.goals ?? [];
		const byKey = new Map(existing.map(g => [g.description.toLowerCase(), g]));
		for (const goal of update.goals) {
			const description = goal.description.trim();
			if (!description) continue;
			const normalized: FactionGoal = {
				description,
				priority: normalizeRange(goal.priority, 1, 10, 5),
				progress: normalizeRange(goal.progress, 0, 100, 0),
				type: goal.type ?? 'diplomatic',
				deadline: goal.deadline?.trim() || undefined,
			};
			const key = description.toLowerCase();
			const previous = byKey.get(key);
			byKey.set(
				key,
				previous
					? { ...previous, ...normalized, progress: Math.max(previous.progress, normalized.progress) }
					: normalized,
			);
		}
		state.goals = [...byKey.values()].slice(0, 8);
		changed = true;
	}
	if (update.resources) {
		state.resources = { ...(state.resources ?? update.resources), ...update.resources };
		changed = true;
	}
	if (update.disposition) {
		state.disposition = update.disposition;
		changed = true;
	}
	if (update.territory?.length) {
		state.territory = [...new Set([...(state.territory ?? []), ...update.territory])];
		changed = true;
	}
	return changed;
}

function mergeStringList(existing: string[], incoming: string[]): string[] {
	const seen = new Set<string>();
	const merged: string[] = [];
	for (const value of [...existing, ...incoming]) {
		const clean = value.trim();
		const key = clean.toLowerCase();
		if (!clean || seen.has(key)) continue;
		seen.add(key);
		merged.push(clean);
	}
	return merged;
}

function resolveFactionKnownMembers(names: string[]): {
	knownMemberIds: string[];
	unresolvedMemberNames: string[];
	resolvedMemberNames: Set<string>;
} {
	const knownMemberIds: string[] = [];
	const unresolvedMemberNames: string[] = [];
	const resolvedMemberNames = new Set<string>();
	for (const name of names) {
		const clean = name.trim();
		if (!clean) continue;
		const entry = findMatchingLoreEntry(story.lorebookEntries, { name: clean, type: 'character' });
		if (entry) {
			knownMemberIds.push(entry.id);
			resolvedMemberNames.add(clean.toLowerCase());
		} else {
			unresolvedMemberNames.push(clean);
		}
	}
	return {
		knownMemberIds: mergeStringList([], knownMemberIds),
		unresolvedMemberNames: mergeStringList([], unresolvedMemberNames),
		resolvedMemberNames,
	};
}

function normalizeRange(value: number | undefined, min: number, max: number, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.round(value)))
		: fallback;
}

function mergeLoreDescription(existing: string, incoming: string): string {
	const base = (existing ?? '').trim();
	const addition = (incoming ?? '').trim();
	if (!addition) return base;
	if (!base) return addition;
	if (base.toLowerCase().includes(addition.toLowerCase().slice(0, 120))) return base;
	const merged = `${base}\n\nRecent development: ${addition}`;
	return merged.length > 6000 ? merged.slice(0, 5997).trimEnd() + '...' : merged;
}
