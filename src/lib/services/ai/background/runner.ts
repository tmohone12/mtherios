/**
 * Background Services Runner — Mtherios Orchestrator
 *
 * Replaces GenerationPipeline Phase 2 (background jobs).
 * Runs after every world-state update, checks thresholds, fires infrequent jobs.
 *
 * - Chapter creation: every ~20 entries outside a chapter
 * - Arc condensation: every 5 uncovered chapters
 * - Lore management: every LORE_MGMT_CHAPTER_INTERVAL chapters
 * - Procedural memory (CASS): after arc creation
 *
 * World simulation is triggered by time progression in the executor,
 * so it does NOT need a separate entry point here.
 */

import { ai } from '$lib/services/ai';
import { story } from '$lib/stores/story.svelte';
import { settings } from '$lib/stores/settings.svelte';
import { uuid } from '$lib/utils/uuid';
import {
	getChapters, createChapter, getArcs, createArc,
	getStoryBeats, createLorebookEntry, updateLorebookEntry,
	getStoryEntry, getStoryEntriesAfterPosition,
} from '$lib/services/database';
import { findMatchingLoreEntry, makeLoreEntry } from '$lib/services/ai/tools/helpers';
import { LORE_MGMT_CHAPTER_INTERVAL } from '$lib/services/ai/lorebook/LoreManagementService';
import type { Chapter, Arc, Entry, CharacterEntryState, FactionEntryState, FactionGoal, FactionResources } from '$lib/types';

type FactionGoalInput = Omit<Partial<FactionGoal>, 'deadline'> & {
	description: string;
	deadline?: string | null;
};

function chaptersForBranch(chapters: Chapter[], branchId: string | null): Chapter[] {
	return chapters
		.filter(chapter => (chapter.branchId ?? null) === branchId)
		.sort((a, b) => a.number - b.number || a.createdAt - b.createdAt);
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

	const arcConfig = settings.getServiceConfig('arcCondensation');
	if (arcConfig.enabled) {
		jobs.push(
			runBackgroundArcCheck().catch(e => {
				const msg = `BackgroundArcCheck: ${e}`;
				errors.push(msg);
				console.error(`[Background] ${msg}`);
			})
		);
	}

	const loreConfig = settings.getServiceConfig('loreManagement');
	if (loreConfig.enabled) {
		jobs.push(
			runBackgroundLoreCheck().catch(e => {
				const msg = `BackgroundLoreCheck: ${e}`;
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

	const chapterThreshold = settings.uiSettings.chapterThreshold || 20;
	const postChapterBuffer = Math.max(0, settings.uiSettings.postChapterBuffer ?? 10);
	const queryLimit = Math.max(chapterThreshold, 50) + postChapterBuffer;
	const entriesOutsideChapter = await getStoryEntriesAfterPosition(
		story.currentStory.id,
		lastChapterEndPosition,
		queryLimit,
		branchId,
	);
	const eligibleEntries = postChapterBuffer > 0
		? entriesOutsideChapter.slice(0, -postChapterBuffer)
		: entriesOutsideChapter;
	console.log('[Background] Chapter check:', {
		loadedEntries: story.entries.length,
		totalEntries: story.entryCount,
		lastChapterEndPosition,
		entriesOutside: entriesOutsideChapter.length,
		eligibleEntries: eligibleEntries.length,
		buffer: postChapterBuffer,
		threshold: chapterThreshold,
	});
	if (eligibleEntries.length < chapterThreshold) return;

	// Analyze first 50 entries for boundary detection
	const analysisWindow = eligibleEntries.slice(0, 50);
	const tokensOutsideBuffer = eligibleEntries.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
	const analysis = await ai.memory.analyzeForChapter(
		analysisWindow, lastChapterEndPosition + 1, tokensOutsideBuffer,
		story.storyMode, story.pov, story.tense,
	);

	if (!analysis.shouldCreateChapter) return;

	// Clamp optimalEndIndex
	const maxIndex = analysisWindow.length - 1;
	const clampedIndex = Math.max(0, Math.min(analysis.optimalEndIndex, maxIndex));

	const chapterEntries = eligibleEntries.slice(0, clampedIndex + 1);
	if (chapterEntries.length === 0) return;

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
			significance: (b.metadata?.significance as string) ?? 'moderate',
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
// Independent background checks (run every turn, not just on chapter creation)
// ══════════════════════════════════════════════════════════════

async function runBackgroundArcCheck(): Promise<void> {
	if (!story.currentStory) return;
	const chapters = await getChapters(story.currentStory.id);
	if (chapters.length === 0) return;
	await runAutoArcCondensation(chapters);
}

const LORE_MGMT_ENTRY_INTERVAL = 25;

async function runBackgroundLoreCheck(): Promise<void> {
	if (!story.currentStory) return;
	if (story.entries.length === 0 || story.entries.length % LORE_MGMT_ENTRY_INTERVAL !== 0) return;
	const chapters = await getChapters(story.currentStory.id);
	if (chapters.length === 0) return;
	await runLoreManagement(chapters);
}

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
		.filter(c => !coveredChapterIds.has(c.id) && !c.pinned)
		.sort((a, b) => a.number - b.number);
	const chaptersPerArc = settings.uiSettings.chaptersPerArc || 5;
	if (uncoveredChapters.length < chaptersPerArc) return;
	const arcChapters = uncoveredChapters.slice(0, chaptersPerArc);

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
	await createArc(arc);
	console.log(`[Background] Auto arc ${arcNumber}: "${arc.title}" (Ch.${arc.chapterRange})`);

	// CASS reflection — fire and forget (capture storyId before async to prevent null access if user navigates away)
	const procConfig = settings.getServiceConfig('proceduralMemory');
	if (procConfig.enabled && story.currentStory) {
		const storyId = story.currentStory.id;
		const storyMode = story.storyMode;
		const loreEntries = [...story.lorebookEntries];
		ai.proceduralMemory.reflect(chapters, [...arcs, arc], loreEntries, storyId, storyMode)
			.catch(console.error);
	}
}

// ══════════════════════════════════════════════════════════════
// Lore management — extracted from GenerationPipeline
// ══════════════════════════════════════════════════════════════

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
				await createLorebookEntry(entry);
				newEntries.push(entry);
			} else {
				const updatePayload = buildLoreUpdatePayload(existing, update.description, update.keywords, update);
				await updateLorebookEntry(existing.id, updatePayload);
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
			await updateLorebookEntry(update.entryId, updatePayload);
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
				await updateLorebookEntry(keep.id, updatePayload);
				await updateLorebookEntry(mergeFrom.id, {
					deleted: true,
					injection: { ...(mergeFrom.injection ?? { mode: 'keyword', keywords: [], priority: 0 }), mode: 'never' },
					updatedAt: Date.now(),
				});
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
				await updateLorebookEntry(update.entryId, updatePayload);
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
		const ids = update.knownMembers
			.map(name => findMatchingLoreEntry(story.lorebookEntries, { name, type: 'character' })?.id ?? name)
			.filter(Boolean);
		state.knownMembers = [...new Set([...(state.knownMembers ?? []), ...ids])];
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
