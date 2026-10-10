import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, getDb } from '$lib/server/db/client';
import { backendJobs, chapterWindowAttempts, chapters, shelves, stories, storyEntries, storyEvents, summaryGenerationCheckpoints } from '$lib/server/db/schema';
import { SummaryGenerationError } from './summaryCheckpoints';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), provider: vi.fn(() => { throw new Error('Provider calls forbidden in chapter window tests'); }) }));
vi.mock('./summaryGeneration', async original => ({
	...await original<typeof import('./summaryGeneration')>(), generateChronologicalMemory: mocks.generate,
}));
vi.mock('$lib/server/turn/provider', async original => ({
	...await original<typeof import('$lib/server/turn/provider')>(), generateServerTextWithMetrics: mocks.provider,
}));
import { createChapterCheckpoint } from './processor';
import { chapterWindowId, chapterWindowStatus, reconcileChapterWindow } from './chapterWindows';

const databaseUrl = process.env.SUMMARY_CHECKPOINT_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (databaseUrl) await closeDb(); });

type Job = Parameters<typeof createChapterCheckpoint>[0];
const turnRows = (storyId: string, from: number, count: number) => Array.from({ length: count }, (_, offset) => {
	const index = from + offset;
	return [
		{ id: `${storyId}_player_${index}`, storyId, type: 'user_action', content: `I ask the envoy question ${index}.`, position: index * 2 + 1, metadata: {}, parentId: null },
		{ id: `${storyId}_answer_${index}`, storyId, type: 'narration', content: `The envoy answers question ${index}.`, position: index * 2 + 2, metadata: {}, parentId: `${storyId}_player_${index}` },
	];
}).flat();

async function fixture(run: (input: { storyId: string; shelfId: string; job: Job }) => Promise<void>) {
	if (!databaseUrl || !/summary_repair|test/i.test(new URL(databaseUrl).pathname)) throw new Error('Disposable summary test database required');
	const db = getDb();
	const [current] = await db.execute(sql`select current_database() as name`);
	if (current.name !== decodeURIComponent(new URL(databaseUrl).pathname.slice(1))) throw new Error('Database target differs from disposable test database');
	const storyId = `story_chapter_window_${randomUUID()}`;
	const shelfId = `shelf_${storyId}`;
	try {
		await db.insert(shelves).values({ id: shelfId, name: 'Disposable chapter window test', slug: shelfId });
		await db.insert(stories).values({ id: storyId, shelfId, title: 'Disposable chapter window test' });
		await db.insert(storyEntries).values(turnRows(storyId, 0, 20));
		await run({ storyId, shelfId, job: { id: `job_${storyId}`, storyId, payload: {}, type: 'summarize_chapter' } as Job });
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

const attempts = (storyId: string) => getDb().select().from(chapterWindowAttempts)
	.where(eq(chapterWindowAttempts.storyId, storyId)).orderBy(chapterWindowAttempts.revision);

/** A transient failure of the canonical chapter insert, after the draft was validated. */
async function withChapterInsertFault<T>(storyId: string, run: () => Promise<T>): Promise<T> {
	const db = getDb();
	const trigger = `inject_${storyId.replace(/[^a-z0-9]/gi, '_')}`.slice(0, 60);
	await db.execute(sql.raw(`create function ${trigger}() returns trigger language plpgsql as $$ begin
		if new.story_id = '${storyId}' then raise exception 'Injected database timeout during chapter commit'; end if; return new; end $$;
		create trigger ${trigger} before insert on chapters for each row execute function ${trigger}();`));
	try { return await run(); }
	finally { await db.execute(sql.raw(`drop trigger if exists ${trigger} on chapters; drop function if exists ${trigger}();`)); }
}

integration('chapter window lifecycle in disposable PostgreSQL', () => {
	it('resumes the same frozen window after a failed commit without regenerating, even after new turns', async () => {
		await fixture(async ({ storyId, job }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			await withChapterInsertFault(storyId, () => expect(createChapterCheckpoint(job)).rejects.toThrow());
			const [validated] = await attempts(storyId);
			expect(validated).toMatchObject({ revision: 1, state: 'validated', policy: 'live' });
			expect(validated.inputs).toBeTruthy();
			const frozenSources = validated.sourceEntryIds;

			// The story moves on while the chapter job is down; the frozen window does not.
			await db.insert(storyEntries).values(turnRows(storyId, 20, 5));
			// Turn receipts written after narration are bookkeeping, not transcript sources.
			await db.update(storyEntries).set({ metadata: { gmTurnReceipt: { status: 'succeeded' } } }).where(eq(storyEntries.id, `${storyId}_answer_19`));
			const resumed = await createChapterCheckpoint({ ...job, id: `${job.id}_restart` });
			expect(resumed).toMatchObject({ created: true, number: 1, window: { windowId: chapterWindowId(storyId, 1), revision: 1 } });
			expect(mocks.generate).toHaveBeenCalledTimes(1);
			const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			expect(chapter.sourceEntryIds).toEqual(frozenSources);
			expect((chapter.metadata.completion as Record<string, unknown>).window).toMatchObject({ revision: 1, policy: 'live' });
			expect((await attempts(storyId)).map(row => row.state)).toEqual(['committed']);
		});
	}, 30_000);

	it('invalidates a validated window when a source is edited, refreezes it and never commits the stale draft', async () => {
		await fixture(async ({ storyId, job }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			await withChapterInsertFault(storyId, () => expect(createChapterCheckpoint(job)).rejects.toThrow());
			await db.update(storyEntries).set({ content: 'The envoy refuses question 3.' }).where(eq(storyEntries.id, `${storyId}_answer_3`));
			const result = await createChapterCheckpoint(job);
			expect(result).toMatchObject({ created: true, window: { revision: 2 },
				invalidations: [{ revision: 1, reason: 'source_changed', changedEntryIds: [`${storyId}_answer_3`] }] });
			expect(mocks.generate).toHaveBeenCalledTimes(2);
			expect(JSON.stringify(mocks.generate.mock.calls[1][0].sources)).toContain('The envoy refuses question 3.');
			const rows = await attempts(storyId);
			expect(rows.map(row => [row.revision, row.state])).toEqual([[1, 'invalidated'], [2, 'committed']]);
			expect(rows[0].invalidation).toMatchObject({ reason: 'source_changed' });
			expect(rows[0].draft).toBeTruthy();
		});
	}, 30_000);

	it('waits (bounded) for classifier work on the window, then attaches its events instead of discarding the summary', async () => {
		await fixture(async ({ storyId, shelfId, job }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			const answerId = `${storyId}_answer_19`;
			const extractionId = `job_extract_${storyId}`;
			await db.insert(backendJobs).values({ id: extractionId, projectId: shelfId, storyId, type: 'extract_turn_state', status: 'running',
				payload: { assistantEntryId: answerId, playerText: 'I ask the envoy question 19.', narration: 'The envoy answers question 19.' } });
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: false, reason: 'extraction_pending', pendingEntryIds: [answerId] });
			expect(mocks.generate).not.toHaveBeenCalled();
			const [waiting] = await attempts(storyId);
			expect(waiting).toMatchObject({ state: 'waiting', extraction: { waits: 1, pendingEntryIds: [answerId] } });
			const deferred = await db.select().from(backendJobs).where(and(eq(backendJobs.storyId, storyId), eq(backendJobs.type, 'summarize_chapter')));
			expect(deferred).toHaveLength(1);
			expect(Date.parse(deferred[0].runAfter)).toBeGreaterThan(Date.now());

			// The classifier finishes and records an event for the last turn.
			await db.update(backendJobs).set({ status: 'complete' }).where(eq(backendJobs.id, extractionId));
			await db.insert(storyEvents).values({ id: `${storyId}_event`, storyId, type: 'discovery', title: 'The envoy reveals a ledger', body: 'Recorded by extraction.', sourceEntryIds: [answerId] });
			const result = await createChapterCheckpoint(job);
			expect(result).toMatchObject({ created: true, eventCount: 1 });
			const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			expect(chapter.sourceEventIds).toEqual([`${storyId}_event`]);
			expect((chapter.metadata.completion as { extraction: Record<string, unknown> }).extraction).toMatchObject({ pendingEntryIds: [], waits: 1 });
		});
	}, 30_000);

	it('does not let a failed extraction consume or block the window; the gap is recorded', async () => {
		await fixture(async ({ storyId, shelfId, job }) => {
			const db = getDb();
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			const answerId = `${storyId}_answer_7`;
			await db.insert(backendJobs).values({ id: `job_extract_${storyId}`, projectId: shelfId, storyId, type: 'extract_turn_state', status: 'failed',
				lastError: 'Classifier unavailable', payload: { assistantEntryId: answerId, playerText: 'I ask the envoy question 7.', narration: 'The envoy answers question 7.' } });
			const result = await createChapterCheckpoint(job);
			expect(result).toMatchObject({ created: true, number: 1 });
			const [chapter] = await db.select().from(chapters).where(eq(chapters.storyId, storyId));
			expect(chapter.sourceEntryIds).toContain(answerId);
			expect((chapter.metadata.completion as { extraction: { gaps: unknown[] } }).extraction.gaps).toEqual([{ entryId: answerId, reason: 'failed' }]);
			const status = await chapterWindowStatus(storyId);
			expect(status.coverage).toMatchObject({ completedTurns: 20, summarizedTurns: 20, contiguousThroughPosition: 40, gaps: [] });
		});
	}, 30_000);

	it('holds an uncertain dispatch for reconciliation instead of buying the request again', async () => {
		await fixture(async ({ storyId, job }) => {
			const db = getDb();
			mocks.generate.mockRejectedValueOnce(new SummaryGenerationError('An interrupted summary has an uncertain provider outcome.', 'summary_interrupted'));
			await expect(createChapterCheckpoint(job)).rejects.toThrow('uncertain provider outcome');
			const [held] = await attempts(storyId);
			expect(held).toMatchObject({ state: 'uncertain_dispatch', failure: { code: 'summary_interrupted', retryable: false } });
			// A later turn's chapter job does not redispatch.
			await expect(createChapterCheckpoint({ ...job, id: `${job.id}_later` })).resolves.toMatchObject({ created: false, reason: 'window_needs_reconciliation' });
			expect(mocks.generate).toHaveBeenCalledTimes(1);

			// The expired provider claim stays as evidence; reconciliation only permits one new dispatch.
			const fingerprint = `fp_${storyId}`;
			await db.insert(summaryGenerationCheckpoints).values({ fingerprint, failureFingerprint: fingerprint, storyId, kind: 'chapter', stage: 'summary',
				status: 'running', leaseOwner: 'crashed-worker', leaseUntil: new Date(Date.now() - 60_000).toISOString() });
			await expect(reconcileChapterWindow({ storyId, windowId: held.windowId, revision: held.revision, decision: 'redispatch', reviewedBy: ' ' })).rejects.toThrow('reviewer');
			const reconciled = await reconcileChapterWindow({ storyId, windowId: held.windowId, revision: held.revision, decision: 'redispatch', reviewedBy: 'fixture-operator' });
			expect(reconciled).toMatchObject({ releasedCheckpoints: 1, attempt: { state: 'ready' } });
			const [checkpoint] = await db.select().from(summaryGenerationCheckpoints).where(eq(summaryGenerationCheckpoints.fingerprint, fingerprint));
			expect(checkpoint).toMatchObject({ status: 'failed', failure: { code: 'summary_reconciled', retryable: true } });

			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: true, window: { revision: 1 } });
			const [committed] = await attempts(storyId);
			expect(committed).toMatchObject({ state: 'committed', reconciliations: [expect.objectContaining({ decision: 'redispatch', fromState: 'uncertain_dispatch', reviewedBy: 'fixture-operator' })] });
		});
	}, 30_000);

	it('records a missing summarizer configuration as needing configuration and resumes once configured', async () => {
		await fixture(async ({ storyId, job }) => {
			mocks.generate.mockRejectedValueOnce(new SummaryGenerationError('Model configuration needed: Summaries has no profile.', 'summary_configuration'));
			await expect(createChapterCheckpoint(job)).rejects.toThrow('Model configuration needed');
			expect((await attempts(storyId))[0]).toMatchObject({ state: 'needs_configuration', failure: { code: 'summary_configuration' } });
			mocks.generate.mockImplementation(async ({ sources }) => summary(sources));
			await expect(createChapterCheckpoint(job)).resolves.toMatchObject({ created: true });
			expect(mocks.generate.mock.calls[0][0]).toEqual(mocks.generate.mock.calls[1][0]);
		});
	}, 30_000);
});
