import type { chapters } from '$lib/server/db/schema';
import { CHAPTER_TURN_COUNT } from '$lib/services/chapterCadence';
import { summarizeMtheriosMemoryForRollup } from '$lib/services/ai/context/mtheriosSummaryFormat';
type ChapterRow = typeof chapters.$inferSelect;

export function chapterSourceForArc(chapter: Pick<ChapterRow, 'id' | 'number' | 'title' | 'sceneOutcome' | 'sourceEntryIds' | 'metadata'>): { id: string; text: string } {
	const accounts = chapter.metadata.sourceAccounts;
	if (accounts !== undefined && accounts !== null) {
		// Reviewed historical backfills can have a different turn count; preserve them.
		const expectedCount = typeof chapter.metadata.turnCount === 'number' ? chapter.metadata.turnCount : CHAPTER_TURN_COUNT;
		if (!Array.isArray(accounts) || accounts.length !== expectedCount || accounts.length === 0) {
			throw new Error(`Chapter ${chapter.number} has incomplete source accounts; arc history was not advanced.`);
		}
		let previousPosition = -1;
		for (const raw of accounts) {
			const account = (raw && typeof raw === 'object' ? raw as Record<string, unknown> : {});
			const position = typeof account.sourceId === 'string' ? chapter.sourceEntryIds.indexOf(account.sourceId) : -1;
			if (position <= previousPosition || typeof account.summary !== 'string' || !account.summary.trim()) {
				throw new Error(`Chapter ${chapter.number} has invalid source accounts; arc history was not advanced.`);
			}
			previousPosition = position;
		}
	}
	// Legacy event-derived change lists are interpretations, not transcript history.
	// Prefer retained turn accounts; use the full synopsis for chapters predating them.
	return { id: chapter.id, text: `Chapter ${chapter.number}: ${chapter.title}\n${Array.isArray(accounts)
		? accounts.map((raw, index) => `Turn ${index + 1}: ${(raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}).summary}`).join('\n\n')
		: summarizeMtheriosMemoryForRollup(chapter.sceneOutcome)}` };
}

