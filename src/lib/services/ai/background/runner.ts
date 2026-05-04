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
} from '$lib/services/database';
import { makeLoreEntry } from '$lib/services/ai/tools/helpers';
import { LORE_MGMT_CHAPTER_INTERVAL } from '$lib/services/ai/lorebook/LoreManagementService';
import type { Chapter, Arc, Entry } from '$lib/types';
import type { CharacterEntryState } from '$lib/types';

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

	const chapters = await getChapters(story.currentStory.id);
	let lastChapterEndIndex = 0;
	if (chapters.length > 0) {
		const foundIdx = story.entries.findIndex(e => e.id === chapters[chapters.length - 1].endEntryId);
		if (foundIdx < 0) {
			console.warn('[Background] Chapter endEntryId not found — skipping chapter check');
			return;
		}
		lastChapterEndIndex = foundIdx + 1;
	}

	const entriesOutsideChapter = story.entries.slice(lastChapterEndIndex);
	const chapterThreshold = settings.uiSettings.chapterThreshold || 20;
	console.log('[Background] Chapter check:', { totalEntries: story.entries.length, lastChapterEndIndex, entriesOutside: entriesOutsideChapter.length, threshold: chapterThreshold });
	if (entriesOutsideChapter.length < chapterThreshold) return;

	// Analyze first 50 entries for boundary detection
	const analysisWindow = entriesOutsideChapter.slice(0, 50);
	const tokensOutsideBuffer = entriesOutsideChapter.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0);
	const analysis = await ai.memory.analyzeForChapter(
		analysisWindow, lastChapterEndIndex, tokensOutsideBuffer,
		story.storyMode, story.pov, story.tense,
	);

	if (!analysis.shouldCreateChapter) return;

	// Clamp optimalEndIndex
	const maxIndex = analysisWindow.length - 1;
	const clampedIndex = Math.max(0, Math.min(analysis.optimalEndIndex, maxIndex));

	const chapterEntries = entriesOutsideChapter.slice(0, clampedIndex + 1);
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

	const arcNumber = arcs.length + 1;
	const result = await ai.arcCondensation.condense(
		uncoveredChapters, arcNumber, story.storyMode, story.pov, story.tense, arcs,
	);
	const firstCh = uncoveredChapters[0];
	const lastCh = uncoveredChapters[uncoveredChapters.length - 1];
	const arc: Arc = {
		id: uuid(), storyId: story.currentStory.id, arcNumber,
		title: result.title, summary: result.summary,
		keyPlotPoints: result.keyPlotPoints, characterArcs: result.characterArcs,
		unresolvedThreads: result.unresolvedThreads, emotionalProgression: result.emotionalProgression,
		chapterIds: uncoveredChapters.map(c => c.id), chapterRange: `${firstCh.number}-${lastCh.number}`,
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
			const existing = story.lorebookEntries.find(e => e.name.toLowerCase() === update.name.toLowerCase());
			if (!existing) {
				const entry = makeLoreEntry(story.currentStory.id, update.name, update.type as any, update.description, update.keywords);
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
