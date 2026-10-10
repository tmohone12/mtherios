import { describe, expect, it } from 'vitest';
import { chapterSourceForArc } from './chapterSummarySource';

describe('chapter factual input to arc history', () => {
	const chapter = { id: 'chapter_1', number: 1, title: 'The crossing', sceneOutcome: 'A short synopsis omitting the fare.',
		sourceEntryIds: Array.from({ length: 20 }, (_, index) => `turn_${index + 1}`),
		metadata: { sourceAccounts: Array.from({ length: 20 }, (_, index) => ({ sourceId: `turn_${index + 1}`, summary: `Outcome ${index + 1}: passage costs ${index + 1} coins, only after boarding.` })) },
		irreversibleChanges: ['INVENTED_CORONATION'], promisesDebtsOaths: ['INVENTED_PROMISE'] };

	it('retains every complete account and excludes lossy prose and extracted event interpretations', () => {
		const source = chapterSourceForArc(chapter);
		for (const account of chapter.metadata.sourceAccounts) expect(source.text).toContain(account.summary);
		expect(source.text).not.toMatch(/short synopsis|INVENTED_/);
		const legacy = chapterSourceForArc({ ...chapter, metadata: {} });
		expect(legacy.text).toContain(chapter.sceneOutcome);
		expect(legacy.text).not.toMatch(/INVENTED_/);
	});

	it('rejects incomplete, reordered, duplicate, and foreign account provenance', () => {
		expect(() => chapterSourceForArc({ ...chapter, metadata: { sourceAccounts: chapter.metadata.sourceAccounts.slice(1) } })).toThrow('incomplete source accounts');
		for (const sourceAccounts of [[...chapter.metadata.sourceAccounts].reverse(),
			[chapter.metadata.sourceAccounts[0], ...chapter.metadata.sourceAccounts.slice(0, 19)],
			[{ sourceId: 'foreign_turn', summary: 'An unrelated source account.' }, ...chapter.metadata.sourceAccounts.slice(1)]]) {
			expect(() => chapterSourceForArc({ ...chapter, metadata: { sourceAccounts } })).toThrow('invalid source accounts');
		}
	});

	it('preserves the explicitly recorded size of reviewed historical backfills', () => {
		expect(chapterSourceForArc({ ...chapter, sourceEntryIds: ['legacy_turn'], metadata: { turnCount: 1,
			sourceAccounts: [{ sourceId: 'legacy_turn', summary: 'A reviewed historical backfill.' }] } }).text).toContain('A reviewed historical backfill.');
	});
});
