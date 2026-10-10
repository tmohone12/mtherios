import { describe, expect, it } from 'vitest';
import { CHAPTER_WINDOW_TRANSITIONS, changedChapterWindowRows, chapterWindowFailure, chapterWindowFingerprint, chapterWindowId,
	chapterWindowSourceRows, summarizedChapterCoverage } from './chapterWindows';
import { SummaryGenerationError } from './summaryCheckpoints';

const turn = (index: number, extra: Record<string, unknown> = {}) => [
	{ id: `p${index}`, type: 'user_action', content: `Question ${index}`, position: index * 2 + 1, parentId: null, branchId: null, metadata: {} },
	{ id: `n${index}`, type: 'narration', content: `Answer ${index}`, position: index * 2 + 2, parentId: `p${index}`, branchId: null, metadata: extra },
];

describe('chapter window identity', () => {
	it('keeps one logical identity per story, scope and number', () => {
		expect(chapterWindowId('story', 3)).toBe(chapterWindowId('story', 3, 'primary'));
		expect(chapterWindowId('story', 3)).not.toBe(chapterWindowId('story', 4));
		expect(chapterWindowId('story', 3)).not.toBe(chapterWindowId('story', 3, 'branch_b'));
	});

	it('ignores turn receipts but detects transcript edits, eligibility changes, deletions and new rows in range', () => {
		const rows = [...turn(0), ...turn(1)];
		const frozen = chapterWindowSourceRows(rows, rows);
		const receipt = rows.map(row => row.id === 'n1' ? { ...row, metadata: { gmTurnReceipt: { status: 'succeeded' }, factionCueReceipt: {} } } : row);
		expect(changedChapterWindowRows(frozen, chapterWindowSourceRows(receipt, receipt))).toEqual([]);
		const edited = rows.map(row => row.id === 'n0' ? { ...row, content: 'Edited' } : row);
		expect(changedChapterWindowRows(frozen, chapterWindowSourceRows(edited, edited))).toEqual(['n0']);
		const nonCanon = rows.map(row => row.id === 'p1' ? { ...row, metadata: { nonCanon: true } } : row);
		expect(changedChapterWindowRows(frozen, chapterWindowSourceRows(nonCanon, nonCanon))).toEqual(['p1']);
		const deleted = rows.filter(row => row.id !== 'p0');
		expect(changedChapterWindowRows(frozen, chapterWindowSourceRows(deleted, deleted))).toEqual(['p0']);
		const ooc = { id: 'ooc', type: 'user_action', content: 'OOC: pause', position: 3.5, parentId: null, branchId: null, metadata: { actionType: 'ooc' } };
		expect(changedChapterWindowRows(frozen, chapterWindowSourceRows(rows, [...rows, ooc]))).toEqual(['ooc']);
	});

	it('includes branch/POV scope, compiler and summarizer revision in the fingerprint', () => {
		const rows = chapterWindowSourceRows(turn(0), turn(0));
		const base = { sourceEntryIds: ['p0', 'n0'], sourceRows: rows, scope: 'primary', pov: 'primary', compiler: 'chapter-projection-v3', summarizerRevision: 's1' };
		const fingerprint = chapterWindowFingerprint(base);
		expect(chapterWindowFingerprint({ ...base, pov: 'parallel' })).not.toBe(fingerprint);
		expect(chapterWindowFingerprint({ ...base, scope: 'branch_b' })).not.toBe(fingerprint);
		expect(chapterWindowFingerprint({ ...base, compiler: 'chapter-projection-v4' })).not.toBe(fingerprint);
		expect(chapterWindowFingerprint({ ...base, summarizerRevision: 's2' })).not.toBe(fingerprint);
	});
});

describe('chapter window states', () => {
	it('keeps committed and invalidated terminal and leaves uncertain dispatch only through reconciliation', () => {
		expect(CHAPTER_WINDOW_TRANSITIONS.committed).toEqual([]);
		expect(CHAPTER_WINDOW_TRANSITIONS.invalidated).toEqual([]);
		expect(CHAPTER_WINDOW_TRANSITIONS.uncertain_dispatch).toEqual(['ready', 'invalidated']);
		expect(CHAPTER_WINDOW_TRANSITIONS.validated).toEqual(['committed', 'invalidated']);
	});

	it.each([
		[new SummaryGenerationError('Model configuration needed: Summaries has no profile.', 'summary_configuration'), 'needs_configuration', false],
		[new SummaryGenerationError('Interrupted', 'summary_interrupted'), 'uncertain_dispatch', false],
		[new SummaryGenerationError('Outcome could not be saved', 'summary_checkpoint_storage'), 'uncertain_dispatch', false],
		[new SummaryGenerationError('Storage unavailable; nothing dispatched', 'summary_checkpoint_storage', true), 'retryable_failure', true],
		[new SummaryGenerationError('Busy', 'summary_busy', true), 'retryable_failure', true],
		[new SummaryGenerationError('Invalid JSON', 'summary_invalid_output', false, true), 'retryable_failure', false],
		[new Error('Model configuration needed: Classifier is unavailable.'), 'needs_configuration', false],
	] as const)('maps %s to %s', (error, state, retryable) => {
		expect(chapterWindowFailure(error)).toMatchObject({ state, failure: { retryable } });
	});
});

describe('summarized coverage', () => {
	const entries = Array.from({ length: 6 }, (_, index) => turn(index)).flat();
	it('reports contiguous coverage, history gaps and pending turns separately', () => {
		const covered = (indexes: number[]) => ({ sourceEntryIds: indexes.flatMap(index => [`p${index}`, `n${index}`]) });
		expect(summarizedChapterCoverage(entries, [covered([0, 1, 2])])).toMatchObject({ completedTurns: 6, summarizedTurns: 3, contiguousThroughPosition: 6, pendingTurns: 3, gaps: [] });
		expect(summarizedChapterCoverage(entries, [covered([0]), covered([2, 3])])).toMatchObject({
			summarizedTurns: 3, contiguousThroughPosition: 2, pendingTurns: 2, gaps: [{ narrationId: 'n1', playerId: 'p1', position: 4 }] });
		expect(summarizedChapterCoverage(entries, [])).toMatchObject({ summarizedTurns: 0, contiguousThroughPosition: null, pendingTurns: 6, gaps: [] });
	});
});
