import { beforeEach, describe, expect, it, vi } from 'vitest';
import { arcs, chapters, storyEntries } from '$lib/server/db/schema';

const state = vi.hoisted(() => ({ rows: new Map<unknown, unknown[]>(), updates: [] as Array<{ table: unknown; value: unknown }> }));
vi.mock('$lib/server/db/client', () => ({
	getDb: () => ({
		select: () => ({
			from: (table: unknown) => {
				const result = () => state.rows.get(table) ?? [];
				const query = { where: () => query, limit: async () => result(), then: (resolve: (value: unknown[]) => unknown) => resolve(result()) };
				return query;
			},
		}),
		update: (table: unknown) => ({ set: (value: unknown) => ({ where: async () => { state.updates.push({ table, value }); } }) }),
	}),
}));

const { rewriteChapterSummary } = await import('./chapterRewrite');

const chapter = { id: 'chapter_91', storyId: 'story_1', number: 91, title: 'Chapter 91: Recorded Events', sceneOutcome: 'Player action record: "i say ..."',
	sourceEntryIds: ['entry_1', 'narration_1'], sourceEventIds: [], metadata: { projectionCompiler: 'summary-only-recovery-v1' } };
const entries = [{ id: 'narration_1', position: 2 }, { id: 'entry_1', position: 1 }];
const digest = { title: 'The Twins Yield; Riverrun Bars Its Gates', summary: '[RECENT STORY STATE =\nAegon takes the Twins.\n]', keywords: [], keyCharacters: ['Emmon Frey'],
	keyLocations: ['The Twins', 'Riverrun'], plotThreads: ['Edmure is imprisoned.'], emotionalTone: '', source: 'llm' as const, model: 'summary-model',
	sourceAccounts: [{ sourceId: 'narration_1', summary: 'Emmon Frey yields the crossing.' }] };

describe('chapter summary rewrite', () => {
	beforeEach(() => {
		state.rows = new Map<unknown, unknown[]>([[chapters, [chapter]], [arcs, []], [storyEntries, entries]]);
		state.updates = [];
	});

	it('regenerates from the chapter\'s own turns in order and keeps the previous text for reverting', async () => {
		const summarize = vi.fn(async () => digest);
		const save = vi.fn(async () => ({ storyId: 'story_1', serverVersion: 12, chapter: {} }));
		const result = await rewriteChapterSummary('story_1', 'chapter_91', { summarize, save } as never);
		expect(((summarize.mock.calls[0] as unknown[])[0] as Array<{ id: string }>).map(entry => entry.id)).toEqual(['entry_1', 'narration_1']);
		expect(save).toHaveBeenCalledWith('story_1', expect.objectContaining({ id: 'chapter_91', number: 91, title: digest.title, summary: digest.summary,
			sourceEntryIds: chapter.sourceEntryIds, plotThreads: digest.plotThreads, locations: digest.keyLocations }));
		expect(result).toMatchObject({ title: digest.title, previousTitle: chapter.title, serverVersion: 12, model: 'summary-model' });
		expect(state.updates).toHaveLength(1);
	});

	it('refuses a chapter inside an arc and one whose transcript is incomplete', async () => {
		const summarize = vi.fn(async () => digest);
		state.rows.set(arcs, [{ id: 'arc_9' }]);
		await expect(rewriteChapterSummary('story_1', 'chapter_91', { summarize, save: vi.fn() } as never)).rejects.toThrow('part of an arc');
		state.rows.set(arcs, []);
		state.rows.set(storyEntries, [entries[0]]);
		await expect(rewriteChapterSummary('story_1', 'chapter_91', { summarize, save: vi.fn() } as never)).rejects.toThrow('missing transcript entries');
		expect(summarize).not.toHaveBeenCalled();
	});
});
