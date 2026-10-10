import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { backendJobs, chapters, memoryNodes, shelves, stories, storyEntries, storyThreads } from '$lib/server/db/schema';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), provider: vi.fn(() => { throw new Error('Provider calls forbidden in chapter commit tests'); }) }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateChronologicalMemory: mocks.generate,
}));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider,
}));
import { createChapterCheckpoint, runBackendJobNow } from './processor';
import { enqueueChapterSummaryJob, retryBackendJob } from './outbox';
import { deleteBackendChapter } from '$lib/server/memory/canonical';

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
			let release!: () => void;
			let entered!: () => void;
			const ready = new Promise<void>(resolve => { release = resolve; });
			const generating = new Promise<void>(resolve => { entered = resolve; });
			mocks.generate.mockImplementation(async ({ sources }) => {
				entered();
				await ready;
				return summary(sources);
			});
			const winner = createChapterCheckpoint(job);
			// The duplicate finds the window frozen and generating; it buys nothing and commits nothing.
			await generating;
			const competing = await createChapterCheckpoint({ ...job, id: `${job.id}_competing` });
			release();
			const results = [await winner, competing];
			expect(results.filter(result => result.created)).toHaveLength(1);
			expect(competing).toMatchObject({ created: false, reason: 'window_generating' });
			const db = getDb();
			const saved = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			expect(saved).toHaveLength(1);
			expect(saved[0].sourceEntryIds).toHaveLength(40);
			expect(await db.select().from(memoryNodes).where(eq(memoryNodes.storyId, storyId))).toHaveLength(1);
			const jobs = await db.select().from(backendJobs).where(eq(backendJobs.storyId, storyId));
			expect(jobs.filter(item => item.type === 'rollup_arc')).toHaveLength(1);
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: false, reason: 'chapter_threshold_not_met' });
			expect(mocks.generate).toHaveBeenCalledTimes(1);
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

	it('keeps the chapter complete after a post-commit enrichment failure and retries only that consumer', async () => {
		await fixture(async ({ storyId }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => ({ ...summary(sources),
				newThreads: [{ title: 'The envoy’s ledger', currentState: 'The envoy keeps a ledger of every answer.', significance: 'moderate', evidenceEventIds: [] }] }));
			const summaryJobId = await enqueueChapterSummaryJob({ storyId, serverVersion: 1 });
			const run = await runBackendJobNow(summaryJobId);
			expect(run).toMatchObject({ completed: true, result: { created: true, completion: 'committed' } });
			const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			const followUps = (chapter.metadata.completion as { followUpJobIds: Record<string, string> }).followUpJobIds;
			expect(Object.keys(followUps).sort()).toEqual(['arcRollup', 'characters', 'embedding', 'threads', 'vault']);
			const jobRows = async () => new Map((await db.select().from(backendJobs).where(eq(backendJobs.storyId, storyId))).map(row => [row.id, row]));
			const queued = await jobRows();
			for (const jobId of Object.values(followUps)) expect(queued.get(jobId)?.status).toBe('queued');

			// Inject a transient database failure into one consumer after the chapter commit.
			const threadJob = queued.get(followUps.threads)!;
			const trigger = `inject_${storyId.replace(/[^a-z0-9]/gi, '_')}`;
			await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
				if new.story_id = '${storyId}' then raise exception 'Injected database timeout during thread reconciliation'; end if; return new; end $$;
				create trigger ${trigger} before insert on story_threads for each row execute function ${trigger}();`));
			try {
				await db.update(backendJobs).set({ maxAttempts: 1 }).where(eq(backendJobs.id, threadJob.id));
				await expect(runBackendJobNow(threadJob.id)).resolves.toMatchObject({ completed: false });
			} finally {
				await db.execute(sql.raw(`drop trigger if exists ${trigger} on story_threads; drop function if exists ${trigger}();`));
			}
			await expect(runBackendJobNow(followUps.characters)).resolves.toMatchObject({ completed: true, result: { applied: true } });
			const afterFailure = await jobRows();
			expect(afterFailure.get(threadJob.id)?.status).toBe('failed');
			expect(afterFailure.get(summaryJobId)?.status).toBe('complete');
			// The chapter and its history remain available; the source boundary does not move again.
			expect(await db.select().from(chapters).where(eq(chapters.storyId, storyId))).toHaveLength(1);
			expect(await db.select().from(memoryNodes).where(eq(memoryNodes.id, `mem_chapter_${chapter.id}`))).toHaveLength(1);
			expect(await db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId))).toHaveLength(0);

			// The fault is gone; retry only the failed consumer.
			const failed = (await jobRows()).get(threadJob.id)!;
			await retryBackendJob({ storyId, jobId: failed.id, expectedUpdatedAt: failed.updatedAt });
			await expect(runBackendJobNow(threadJob.id)).resolves.toMatchObject({ completed: true, result: { applied: true, insertedThreadIds: [expect.any(String)] } });
			const afterRetry = await jobRows();
			expect(afterRetry.get(followUps.characters)?.updatedAt).toBe(afterFailure.get(followUps.characters)?.updatedAt);
			expect((afterRetry.get(threadJob.id)?.metadata as Record<string, unknown>).chapterThreadsReceipt).toMatchObject({ applied: true });
			expect([...afterRetry.values()].filter(row => row.type === 'plan_plot_brain')).toHaveLength(1);
			expect(await db.select().from(storyThreads).where(eq(storyThreads.storyId, storyId))).toHaveLength(1);
			expect(mocks.generate).toHaveBeenCalledTimes(1);
			await expect(createChapterCheckpoint({ ...threadJob, id: summaryJobId, type: 'summarize_chapter', payload: {} } as Parameters<typeof createChapterCheckpoint>[0]))
				.resolves.toMatchObject({ created: false, reason: 'chapter_threshold_not_met' });
			expect(await db.select().from(chapters).where(eq(chapters.storyId, storyId))).toHaveLength(1);
		});
	}, 30_000);

	it('gives a deleted and regenerated chapter fresh consumers under the same stable chapter ID', async () => {
		await fixture(async ({ storyId, job }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			const first = await createChapterCheckpoint(job);
			const followUps = () => db.select().from(backendJobs).where(and(eq(backendJobs.storyId, storyId), eq(backendJobs.type, 'chapter_threads')));
			await db.update(backendJobs).set({ status: 'complete' }).where(eq(backendJobs.storyId, storyId));
			await deleteBackendChapter(storyId, String(first.chapterId));
			const second = await createChapterCheckpoint({ ...job, id: `${job.id}_regenerated` });
			expect(second).toMatchObject({ created: true, chapterId: first.chapterId });
			expect(second.serverVersion).not.toBe(first.serverVersion);
			const rows = await followUps();
			expect(rows).toHaveLength(2);
			expect(rows.find(row => row.payload.chapterServerVersion === second.serverVersion)?.status).toBe('queued');
		});
	}, 30_000);

	it('does not overwrite a thread edited after the chapter snapshot', async () => {
		await fixture(async ({ storyId }) => {
			const db = getDb();
			const threadId = `${storyId}_thread`;
			await db.insert(storyThreads).values({ id: threadId, storyId, description: 'Envoy debt: The envoy owes a favor.', status: 'open', serverVersion: 1 });
			mocks.generate.mockImplementation(async ({ sources }) => ({ ...summary(sources),
				threadChanges: [{ threadId, action: 'advance', currentState: 'The envoy pays half the favor.', evidenceEventIds: [] }] }));
			const summaryJobId = await enqueueChapterSummaryJob({ storyId, serverVersion: 1 });
			await expect(runBackendJobNow(summaryJobId)).resolves.toMatchObject({ completed: true });
			const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			const threadJobId = (chapter.metadata.completion as { followUpJobIds: Record<string, string> }).followUpJobIds.threads;
			// The player edits the thread before the deferred plan runs.
			await db.update(storyThreads).set({ description: 'Envoy debt: Forgiven by the player.', serverVersion: 7 }).where(eq(storyThreads.id, threadId));
			await expect(runBackendJobNow(threadJobId)).resolves.toMatchObject({ completed: true, result: { staleThreadIds: [threadId], updatedThreadIds: [] } });
			const [thread] = await db.select().from(storyThreads).where(eq(storyThreads.id, threadId));
			expect(thread.description).toBe('Envoy debt: Forgiven by the player.');
		});
	}, 30_000);
});
