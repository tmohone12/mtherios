import { and, eq, inArray, sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db/client';
import { arcs, chapters, storyEntries } from '$lib/server/db/schema';
import { upsertBackendChapterFromLocal } from '$lib/server/memory/canonical';
import { CHAPTER_PROJECTION_COMPILER, chapterMemoryInput, summarizeChapterMemoryFromInput, type StoryEntryRow } from './processor';

export interface ChapterRewriteResult {
	chapterId: string;
	number: number;
	title: string | null;
	previousTitle: string | null;
	summaryChars: number;
	previousSummaryChars: number;
	model: string | null;
	serverVersion: number;
}

/**
 * Rewrites one saved chapter from its own transcript turns with the current chapter summarizer:
 * title, reader summary, per-turn accounts and threads. The previous title and text stay in
 * metadata.rewrite so the change can be reverted. A chapter already inside an arc is refused:
 * arcs are validated against their chapters, so those go through `jobs.rebuildSummaries`.
 */
export async function rewriteChapterSummary(storyId: string, chapterId: string, deps = {
	// Transcript turns only: the chapter's thread catalog and campaign facts are not revisited.
	summarize: (entries: StoryEntryRow[]) => summarizeChapterMemoryFromInput(chapterMemoryInput(entries, [], [], []), entries),
	save: upsertBackendChapterFromLocal,
}): Promise<ChapterRewriteResult> {
	const db = getDb();
	const [chapter] = await db.select().from(chapters).where(and(eq(chapters.storyId, storyId), eq(chapters.id, chapterId))).limit(1);
	if (!chapter) throw new Error(`Chapter not found: ${chapterId}`);
	const [arc] = await db.select({ id: arcs.id }).from(arcs)
		.where(and(eq(arcs.storyId, storyId), sql`${arcs.chapterIds} ? ${chapterId}`)).limit(1);
	if (arc) throw new Error(`Chapter ${chapter.number} is part of an arc; rewrite it with jobs.rebuildSummaries so the arc is rebuilt too.`);
	const sourceIds = Array.isArray(chapter.sourceEntryIds) ? chapter.sourceEntryIds.filter((id): id is string => typeof id === 'string') : [];
	const entries = sourceIds.length
		? (await db.select().from(storyEntries).where(and(eq(storyEntries.storyId, storyId), inArray(storyEntries.id, sourceIds))))
			.sort((left, right) => left.position - right.position)
		: [];
	if (!entries.length || entries.length !== sourceIds.length) throw new Error(`Chapter ${chapter.number} is missing transcript entries; it cannot be rewritten from its source.`);

	// Throws unless the chapter covers exactly one chapter window of completed turns.
	const digest = await deps.summarize(entries);
	if (digest.source !== 'llm' || !digest.summary.trim()) throw new Error(`Chapter ${chapter.number} did not produce a validated model summary.`);

	const saved = await deps.save(storyId, {
		id: chapter.id,
		number: chapter.number,
		title: digest.title,
		summary: digest.summary,
		sourceEntryIds: sourceIds,
		sourceEventIds: chapter.sourceEventIds,
		plotThreads: digest.plotThreads,
		keywords: digest.keywords,
		characters: digest.keyCharacters,
		locations: digest.keyLocations,
	});
	const rewrite = {
		at: new Date().toISOString(),
		previousTitle: chapter.title,
		previousSummary: chapter.sceneOutcome,
		previousCompiler: (chapter.metadata as Record<string, unknown> | null)?.projectionCompiler ?? null,
	};
	await db.update(chapters).set({
		metadata: sql`${chapters.metadata} || ${JSON.stringify({
			sourceAccounts: digest.sourceAccounts ?? [],
			summaryModel: digest.model ?? null,
			summarySource: 'llm',
			projectionCompiler: CHAPTER_PROJECTION_COMPILER,
			rewrite,
		})}::jsonb`,
	}).where(and(eq(chapters.storyId, storyId), eq(chapters.id, chapter.id)));
	return {
		chapterId: chapter.id,
		number: chapter.number,
		title: digest.title,
		previousTitle: chapter.title,
		summaryChars: digest.summary.length,
		previousSummaryChars: chapter.sceneOutcome.length,
		model: digest.model ?? null,
		serverVersion: saved.serverVersion,
	};
}
