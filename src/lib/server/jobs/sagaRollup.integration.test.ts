import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { arcs, memoryNodes, sagas, shelves, stories } from '$lib/server/db/schema';
import type { SagaSource } from './summaryGeneration';

const mocks = vi.hoisted(() => ({ generateSaga: vi.fn(), provider: vi.fn(() => { throw new Error('Provider calls forbidden in saga rollup tests'); }) }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateSagaMemory: mocks.generateSaga,
}));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider,
}));
import { runBackendJobNow, upsertSagaMemoryNode } from './processor';
import { enqueueBackendJob } from './outbox';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (databaseUrl) await closeDb(); });

async function fixture(run: (storyId: string) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable summary test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_saga_rollup_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable saga test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'Disposable saga test' });
		await run(storyId);
		expect(mocks.provider).not.toHaveBeenCalled();
	} finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
	}
}

const arcRow = (storyId: string, number: number) => ({
	id: `${storyId}_arc_${number}`, storyId, number, title: `Season ${number}`, summary: `Arc overview:\nSeason ${number} happened.`,
	chapterIds: Array.from({ length: 10 }, (_, index) => `${storyId}_chapter_${(number - 1) * 10 + index + 1}`),
	metadata: { startChapterNumber: (number - 1) * 10 + 1, endChapterNumber: number * 10, sourceStart: (number - 1) * 400, sourceEnd: number * 400 - 1,
		sourceEntryIds: [`${storyId}_entry_${number}`], projectionFingerprint: `arc-${number}` },
});

function writtenSaga({ sources }: { sources: SagaSource[] }) {
	return { title: `Era of ${sources.map(source => source.label.split(':')[0]).join(' and ')}`, period: '296 AC',
		sections: sources.map(source => ({ heading: source.label, text: `${source.text} The consequences carried into the next season.` })),
		consequence: 'The realm changed hands and the old order did not survive.', continuity: ['The two eggs are not the same egg.'],
		openThreads: ['Who sent the letter?'], model: 'fixture' };
}

async function runRollup(storyId: string, key: string) {
	const jobId = await enqueueBackendJob({ storyId, type: 'rollup_saga', dedupeKey: key, payload: {}, maxAttempts: 3 });
	return runBackendJobNow(jobId, `worker_${key}`);
}

integration('saga rollup in disposable PostgreSQL', () => {
	it('replaces the old five-arc saga with model-written two-arc sagas, numbered in order, and does not rewrite them on rerun', async () => {
		await fixture(async storyId => {
			const db = getDb();
			await db.insert(arcs).values([1, 2, 3, 4, 5].map(number => arcRow(storyId, number)));
			const oldId = `${storyId}_saga_old`;
			await db.insert(sagas).values({ id: oldId, storyId, number: 1, title: 'Saga 1: Season 1 to Season 5', summary: 'Saga overview: cut off',
				arcIds: [1, 2, 3, 4, 5].map(number => `${storyId}_arc_${number}`), metadata: { projectionCompiler: 'saga-projection-v1' } });
			await upsertSagaMemoryNode({ storyId, sagaId: oldId, title: 'Saga 1: Season 1 to Season 5', summary: 'Saga overview: cut off', arcIds: [], sourceEntryIds: [],
				sourceEventIds: [], openThreadIds: [], entityIds: [], serverVersion: 1, now: new Date().toISOString(), jobId: 'old', sourceFingerprint: 'old', sourceStart: 0, sourceEnd: 1 });
			mocks.generateSaga.mockImplementation(async input => writtenSaga(input));

			const first = await runRollup(storyId, 'first');
			expect(first).toMatchObject({ completed: true, result: { created: true } });
			expect(mocks.generateSaga.mock.calls.map(([input]) => input.sources.map((source: SagaSource) => source.label))).toEqual([
				['Arc 1: Season 1 (chapters 1-10)', 'Arc 2: Season 2 (chapters 11-20)'],
				['Arc 3: Season 3 (chapters 21-30)', 'Arc 4: Season 4 (chapters 31-40)'],
			]);
			const rows = await db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number));
			expect(rows.map(row => [row.number, row.title, row.arcIds])).toEqual([
				[1, 'Era of Arc 1 and Arc 2', [`${storyId}_arc_1`, `${storyId}_arc_2`]],
				[2, 'Era of Arc 3 and Arc 4', [`${storyId}_arc_3`, `${storyId}_arc_4`]],
			]);
			expect(rows[0].metadata).toMatchObject({ summarySource: 'llm', projectionCompiler: 'saga-projection-v2', startChapterNumber: 1, endChapterNumber: 20,
				startArcNumber: 1, endArcNumber: 2, period: '296 AC', continuity: ['The two eggs are not the same egg.'] });
			expect(rows[0].summary).toContain('Saga consequence: The realm changed hands');
			expect(rows[0].lingeringThreads).toEqual(['Who sent the letter?']);
			const nodes = await db.select({ id: memoryNodes.id, title: memoryNodes.title }).from(memoryNodes)
				.where(and(eq(memoryNodes.storyId, storyId), inArray(memoryNodes.id, [`mem_saga_${oldId}`, ...rows.map(row => `mem_saga_${row.id}`)])));
			expect(nodes.map(node => node.title).sort()).toEqual(['Saga 1: Era of Arc 1 and Arc 2', 'Saga 2: Era of Arc 3 and Arc 4']);

			// Arc 5 waits for its partner; nothing is rewritten or bought again.
			expect(await runRollup(storyId, 'rerun')).toMatchObject({ completed: true, result: { created: false, reason: 'saga_threshold_not_met', uncoveredArcs: 1 } });
			expect(mocks.generateSaga).toHaveBeenCalledTimes(2);

			await db.insert(arcs).values(arcRow(storyId, 6));
			expect(await runRollup(storyId, 'arc6')).toMatchObject({ completed: true, result: { created: true } });
			const latest = await db.select().from(sagas).where(eq(sagas.storyId, storyId)).orderBy(asc(sagas.number));
			expect(latest.map(row => row.number)).toEqual([1, 2, 3]);
			expect(latest[2].arcIds).toEqual([`${storyId}_arc_5`, `${storyId}_arc_6`]);
		});
	});

	it('keeps the sagas already written when a later saga fails, and leaves those arcs uncovered', async () => {
		await fixture(async storyId => {
			const db = getDb();
			await db.insert(arcs).values([1, 2, 3, 4].map(number => arcRow(storyId, number)));
			mocks.generateSaga.mockImplementationOnce(async input => writtenSaga(input)).mockRejectedValueOnce(new Error('Saga summarization failed; the arcs stay in the prompt.'));
			const result = await runRollup(storyId, 'partial');
			expect(result.completed).toBe(false);
			const rows = await db.select({ number: sagas.number, arcIds: sagas.arcIds }).from(sagas).where(eq(sagas.storyId, storyId));
			expect(rows).toEqual([{ number: 1, arcIds: [`${storyId}_arc_1`, `${storyId}_arc_2`] }]);
		});
	});
});
