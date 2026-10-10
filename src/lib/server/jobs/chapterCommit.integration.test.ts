import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { backendJobs, chapters, memoryNodes, shelves, stories, storyEntries } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), provider: vi.fn(() => { throw new Error('Provider calls forbidden in chapter commit tests'); }) }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateChronologicalMemory: mocks.generate,
}));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider,
}));
import { createChapterCheckpoint } from './processor';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (databaseUrl) await closeDb(); });

async function fixture(run: (input: { storyId: string; rows: Array<typeof storyEntries.$inferInsert>; job: Parameters<typeof createChapterCheckpoint>[0] }) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable summary test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_chapter_commit_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	const rows = Array.from({ length: 20 }, (_, index) => [
		{ id: `${storyId}_player_${index}`, storyId, type: 'user_action', content: `I ask the envoy question ${index}.`, position: index * 2 + 1, metadata: {}, parentId: null },
		{ id: `${storyId}_answer_${index}`, storyId, type: 'narration', content: `The envoy answers question ${index}.`, position: index * 2 + 2, metadata: {}, parentId: `${storyId}_player_${index}` },
	]).flat();
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable chapter test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'Disposable chapter test' });
		await db.insert(storyEntries).values(rows);
		const job = { id: `job_${storyId}`, storyId, payload: {}, type: 'summarize_chapter' } as Parameters<typeof createChapterCheckpoint>[0];
		await run({ storyId, rows, job });
		expect(mocks.provider).not.toHaveBeenCalled();
	} finally {
		await db.delete(shelves).where(eq(shelves.id, shelfId));
	}
}

function summary(sources: Array<{ id: string; text: string }>) {
	return { title: 'Envoy questions', narrative: 'Twenty answers build one chronological chapter from the supplied transcript.',
		accounts: sources.map(source => ({ sourceId: source.id, summary: source.text })),
		characters: [], openThreads: [], locations: [], keywords: [], model: 'fixture' };
}

integration('chapter commit in disposable PostgreSQL', () => {
	it('commits once under competing jobs and subsequent replay, preserving the arc outbox', async () => {
		await fixture(async ({ storyId, job }) => {
			let arrivals = 0;
			let release!: () => void;
			const ready = new Promise<void>(resolve => { release = resolve; });
			mocks.generate.mockImplementation(async ({ sources }) => {
				if (++arrivals === 2) release();
				await ready;
				return summary(sources);
			});
			const results = await Promise.all([createChapterCheckpoint(job), createChapterCheckpoint({ ...job, id: `${job.id}_competing` })]);
			expect(results.filter(result => result.created)).toHaveLength(1);
			expect(results.find(result => !result.created)).toMatchObject({ reason: 'projection_superseded' });
			const db = getDb();
			const saved = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			expect(saved).toHaveLength(1);
			expect(saved[0].sourceEntryIds).toHaveLength(40);
			expect(await db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId))).toHaveLength(1);
			const jobs = await db.select().from(backendJobs).where(eq(backendJobs.storyId, storyId));
			expect(jobs.filter(item => item.type === 'rollup_arc')).toHaveLength(1);
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: false, reason: 'chapter_threshold_not_met' });
			expect(mocks.generate).toHaveBeenCalledTimes(2);
		});
	}, 20_000);

	it('refuses a source edit during generation even if the source version stays unchanged', async () => {
		await fixture(async ({ storyId, rows, job }) => {
			mocks.generate.mockImplementation(async ({ sources }) => {
				await getDb().update(storyEntries).set({ metadata: { nonCanon: true } }).where(eq(storyEntries.id, rows[1].id));
				return summary(sources);
			});
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: false, reason: 'projection_sources_changed' });
			expect(await getDb().select().from(chapters).where(eq(chapters.storyId, storyId))).toHaveLength(0);
			expect(await getDb().select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId))).toHaveLength(0);
		});
	});
});
