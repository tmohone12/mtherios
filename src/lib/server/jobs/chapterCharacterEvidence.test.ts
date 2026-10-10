import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { chapters, entities, patchProposals, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), refine: vi.fn(), apply: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/engine/characterDrafts', async original => ({
	...await original<typeof import('$lib/server/engine/characterDrafts')>(), refineChapterCharacterUpdates: mocks.refine,
}));
vi.mock('$lib/server/engine/canonRepair', async original => ({
	...await original<typeof import('$lib/server/engine/canonRepair')>(), applyChapterScribeCharacterContextProposals: mocks.apply,
}));

import { autoApplyChapterCharacterContextUpdates, selectChapterCharacterSourceEvidence } from './processor';

type Entry = typeof storyEntries.$inferSelect;
const entry = (id: string, position: number, extra: Partial<Entry> = {}): Entry => ({
	id, storyId: 'story', position, type: 'narration', content: `Mira remembers ${id}.`, parentId: null,
	metadata: {}, branchId: null, serverVersion: 1, createdAt: '2026-10-08T00:00:00Z', ...extra,
}) as Entry;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.refine.mockResolvedValue({ updates: [], status: 'skipped', reason: 'No unsupported updates', model: 'fixture' });
	mocks.apply.mockResolvedValue({ appliedCount: 0 });
});

describe('chapter character source evidence', () => {
	it('supplies new chapter and proposal passages even when the character has no source history', async () => {
		const proposal = { id: 'proposal', targetRecordId: 'mira', sourceEntryIds: ['proposal-source', 'ooc-answer'],
			operations: [{ op: 'replace', path: '/characters/mira/state', value: { eventMemory: { did: ['kept the promise'] } } }],
			metadata: { sourceType: 'chapter_character_context', chapterNumber: 2, characterName: 'Mira' } };
		const rows = new Map<unknown, unknown[]>([
			[patchProposals, [proposal]],
			[entities, [{ id: 'mira', sourceEntryIds: [], state: { bio: 'A harbor broker.' }, description: 'A harbor broker.', serverVersion: 7 }]],
			[chapters, [1, 2].map(number => ({ number, sourceEntryIds: [`chapter-${number}-source`], title: `Chapter ${number}`,
				sceneOutcome: 'Mira kept the promise.', irreversibleChanges: [], npcKnowledgeChanges: [], relationshipChanges: [], openThreads: [] }))],
			[storyEntries, [entry('chapter-1-source', 10), entry('proposal-source', 15), entry('chapter-2-source', 20),
				entry('ooc-answer', 22, { parentId: 'ooc-question' }),
				entry('ooc-question', 21, { type: 'user_action', content: 'GM, explain the interface.', metadata: { nonCanon: true } })]],
		]);
		const writes: Array<Record<string, unknown>> = [];
		mocks.getDb.mockReturnValue({
			select: () => {
				let table: unknown;
				let condition: SQL;
				const query = {
					from: (value: unknown) => { table = value; return query; },
					where: (value: SQL) => { condition = value; return query; }, orderBy: () => query,
					then: (resolve: (values: unknown[]) => unknown) => {
						const values = rows.get(table) ?? [];
						const params = new PgDialect().sqlToQuery(condition).params;
						return Promise.resolve(table === storyEntries
							? values.filter(value => params.includes((value as Entry).id)) : values).then(resolve);
					},
				};
				return query;
			},
			update: () => ({ set: (value: Record<string, unknown>) => ({ where: async () => { writes.push(value); } }) }),
		});

		await autoApplyChapterCharacterContextUpdates({ storyId: 'story', chapterNumber: 2 });

		expect(mocks.refine).toHaveBeenCalledWith(expect.objectContaining({
			chapterWindow: [1, 2],
			sourceEvidence: [entry('chapter-1-source', 10), entry('proposal-source', 15), entry('chapter-2-source', 20)]
				.map(({ id, content }) => ({ id, content })),
			candidates: [expect.objectContaining({ entityId: 'mira', state: expect.objectContaining({ bio: 'A harbor broker.' }) })],
		}));
		expect(writes[0]).toMatchObject({ metadata: { characterUpdateBaseVersion: 7 } });
		expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ storyId: 'story', proposalIds: ['proposal'] }));
	});

	it('retains the newest chapter corrections before old biography sources under the evidence bound', () => {
		const current = Array.from({ length: 40 }, (_, index) => entry(`chapter-${index}`, index + 10));
		const old = Array.from({ length: 32 }, (_, index) => entry(`origin-${index}`, index));
		const selection = selectChapterCharacterSourceEvidence({ entries: [...old, ...current].reverse(),
			chapterSourceEntryIds: current.map(row => row.id), proposalSourceEntryIds: [], canonicalSourceEntryIds: old.map(row => row.id) });
		expect(selection).toHaveLength(32);
		expect(selection[0].id).toBe('chapter-8');
		expect(selection.at(-1)?.id).toBe('chapter-39');
		expect(selection.some(row => row.id.startsWith('origin-'))).toBe(false);
	});
});
