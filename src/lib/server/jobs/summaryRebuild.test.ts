import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { arcs, backendJobs, chapterWindowAttempts, chapterWindows, chapters, entities, memoryNodes, sagas, stories, storyEntries, storyEvents, storyThreads } from '$lib/server/db/schema';
import { SUMMARY_REBUILD_GENERATION_POLICY } from '$lib/contracts/engine';
import { getMtheriosAppConfig } from '$lib/server/app/config';

const mocks = vi.hoisted(() => ({ getDb: vi.fn(), mkdir: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), summarizeChapter: vi.fn(), summarizeArc: vi.fn() }));
vi.mock('$lib/server/db/client', () => ({ getDb: mocks.getDb }));
vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>(), mkdir: mocks.mkdir, readFile: mocks.readFile, writeFile: mocks.writeFile }));
vi.mock('./processor', async importOriginal => ({
	...await importOriginal<typeof import('./processor')>(),
	summarizeChapterMemoryWithLlm: mocks.summarizeChapter,
	summarizeArcMemoryWithLlm: mocks.summarizeArc,
}));

import { assertSummaryRebuildUnchanged, buildSummaryRebuildPlan, loadSummaryResume, rebuildStorySummaries } from './summaryRebuild';

type Entry = typeof storyEntries.$inferSelect;
function entries(turnCount: number): Entry[] {
	const rows: Entry[] = [];
	for (let number = 1; number <= turnCount; number++) {
		const common = { storyId: 'story_rebuild', branchId: null, metadata: {}, serverVersion: 1, createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' };
		rows.push({ ...common, id: `player_${number}`, type: 'user_action', content: `Action ${number}`, parentId: null, position: number * 2 - 1 });
		rows.push({ ...common, id: `response_${number}`, type: 'narration', content: `Outcome ${number}`, parentId: `player_${number}`, position: number * 2 });
	}
	return rows;
}

function databaseFixture(changed = false, competing = false, previousJob?: typeof backendJobs.$inferSelect, turnCount = 20) {
	let transactionNumber = 0;
	let activeTransaction = 0;
	const writes: Array<{ action: string; table: unknown; transaction: number; rows?: unknown }> = [];
	const rows = new Map<unknown, unknown[]>([
		[stories, [{ id: 'story_rebuild', currentTurn: turnCount, serverVersion: 10, metadata: { plotBrain: { pendingFrameId: 'untouched' } } }]],
		[storyEntries, entries(turnCount)], [storyEvents, [{ id: 'event_interpretation', type: 'clue_discovery', title: 'A veiled eunuch and crimson case absent from the transcript', body: 'Unsupported interpretation.', status: 'resolved', sourceEntryIds: ['response_1'], actorEntityIds: ['unsupported_actor'], targetEntityIds: [], threadIds: ['future_dinner'], metadata: {}, createdAt: '2026-09-12T00:00:00Z' }]], [storyThreads, [{ id: 'future_dinner', description: 'Dinner at House Jo after sunset, promised in a much later chapter.', status: 'open' }]], [entities, []], [arcs, []], [sagas, []],
		[chapters, [{ id: 'chapter_old', number: 1, metadata: {}, sourceEntryIds: ['player_1'], sourceEventIds: [] }]],
		[memoryNodes, [{ id: 'mem_chapter_chapter_old', content: 'Old summary', metadata: { sourceType: 'terminal_chapter_job' } }]],
	]);
	const db = {
		transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
			activeTransaction = ++transactionNumber;
			try { return await callback(db); } finally { activeTransaction = 0; }
		}),
		select: () => {
			let table: unknown;
			let locked = false;
			let limited = false;
			const read = () => {
				if (table === backendJobs) return limited ? (previousJob ? [previousJob] : []) : locked || competing ? [{ id: 'rebuild_job' }] : [];
				const selected = structuredClone(rows.get(table) ?? []);
				if (changed && activeTransaction === 2 && table === storyEntries) (selected[0] as Entry).content = 'Concurrent correction';
				return selected;
			};
			const query = { from: (value: unknown) => { table = value; return query; }, where: () => query, orderBy: () => query,
				for: () => { locked = true; return query; }, limit: () => { limited = true; return query; }, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(read()).then(resolve) };
			return query;
		},
		update: (table: unknown) => ({ set: (values: Record<string, unknown>) => ({ where: () => {
			writes.push({ action: 'update', table, transaction: activeTransaction, rows: values });
			return { returning: async () => [{ lockedAt: values.lockedAt }], then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
		} }) }),
		delete: (table: unknown) => ({ where: async () => { writes.push({ action: 'delete', table, transaction: activeTransaction }); } }),
		insert: (table: unknown) => ({ values: (value: unknown) => {
			writes.push({ action: 'insert', table, transaction: activeTransaction, rows: value });
			return { onConflictDoUpdate: async () => {}, then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve) };
		} }),
	};
	mocks.getDb.mockReturnValue(db);
	return { db, writes };
}

function job(dryRun = false): typeof backendJobs.$inferSelect & { storyId: string } {
	return { id: 'rebuild_job', projectId: 'shelf_default', storyId: 'story_rebuild', type: 'rebuild_summaries', payload: { dryRun }, metadata: {}, status: 'running', lockedAt: '2026-09-12T00:00:00Z', lockedBy: 'worker', attemptCount: 1, maxAttempts: 1, lastError: null, runAfter: '2026-09-12T00:00:00Z', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' } satisfies typeof backendJobs.$inferSelect;
}

describe('historical summary rebuild', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.mkdir.mockResolvedValue(undefined);
		mocks.writeFile.mockResolvedValue(undefined);
		mocks.readFile.mockRejectedValue(Object.assign(new Error('Missing draft'), { code: 'ENOENT' }));
		mocks.summarizeChapter.mockImplementation(async (source: Entry[]) => ({ title: 'Complete chapter', summary: 'Every turn accounted for.', keywords: [], keyCharacters: [], keyLocations: [], plotThreads: [], emotionalTone: '', source: 'llm', model: 'fixture',
			sourceAccounts: source.filter(entry => entry.type === 'narration' && entry.parentId).map(entry => ({ sourceId: entry.id, summary: entry.content })) }));
		mocks.summarizeArc.mockImplementation(async (_storyId, source: Array<typeof chapters.$inferSelect>) => ({ title: 'Complete arc', summary: 'Every chapter accounted for.', model: 'fixture',
			sourceAccounts: source.map(chapter => ({ sourceId: chapter.id, summary: chapter.sceneOutcome })), fields: { keyPlotPoints: [], characterArcs: [], unresolvedThreads: [], emotionalProgression: '', trackedEntityIds: [] } }));
	});

	it('plans fixed nonoverlapping 20-turn chapters and ten-chapter arcs including a legacy opening', () => {
		const source = entries(401);
		source.unshift({ ...source[1], id: 'opening', parentId: null, position: 0, branchId: 'main' });
		const plan = buildSummaryRebuildPlan(source);
		expect(plan).toMatchObject({ completedTurns: 401, chapterCount: 20, arcCount: 2, remainingTurns: 1 });
		expect(plan.windows[0].entries[0].id).toBe('opening');
		const ids = plan.windows.flatMap(window => window.entries.map(entry => entry.id));
		expect(ids).toHaveLength(801);
		expect(new Set(ids).size).toBe(ids.length);
		expect(plan.windows.every(window => window.turns.length === 20)).toBe(true);
	});

	it('preserves interleaved action parents for the following chapter', () => {
		const source = entries(40);
		source.find(entry => entry.id === 'player_21')!.position = 39.5;
		const plan = buildSummaryRebuildPlan(source);
		expect(plan.windows).toHaveLength(2);
		expect(plan.windows[0].entries.some(entry => entry.id === 'player_21')).toBe(false);
		expect(plan.windows[1].turns[0].player.id).toBe('player_21');
	});

	it('rejects alternate histories and changes in any captured source or projection', () => {
		expect(() => buildSummaryRebuildPlan([{ ...entries(1)[0], branchId: 'alternate' }])).toThrow('alternate branches');
		expect(() => assertSummaryRebuildUnchanged({ source: 'first' }, { source: 'edited' })).toThrow('no summaries were replaced');
	});

	it('previews without model calls, backup writes, or story/projection mutations', async () => {
		const { writes } = databaseFixture();
		expect(await rebuildStorySummaries(job(true))).toMatchObject({ dryRun: true, applied: false, chapters: 1, arcs: 0 });
		expect(mocks.summarizeChapter).not.toHaveBeenCalled();
		expect(mocks.writeFile).not.toHaveBeenCalled();
		expect(writes.every(write => write.table === backendJobs)).toBe(true);
	});

	it('stages a backup and drafts before one transaction replaces only summaries and their retrieval nodes', async () => {
		const { db, writes } = databaseFixture();
		expect(await rebuildStorySummaries(job())).toMatchObject({ applied: true, serverVersion: 11, worldAdvanced: false });
		expect(mocks.writeFile.mock.calls[0][0]).toMatch(/snapshot\.json$/);
		expect(mocks.writeFile.mock.invocationCallOrder[0]).toBeLessThan(mocks.summarizeChapter.mock.invocationCallOrder[0]);
		expect(mocks.summarizeChapter.mock.calls[0][1]).toEqual([]);
		expect(mocks.summarizeChapter.mock.calls[0][3]).toEqual([]);
		expect(db.transaction).toHaveBeenCalledTimes(2);
		expect(db.transaction).toHaveBeenNthCalledWith(1, expect.any(Function), { isolationLevel: 'repeatable read', accessMode: 'read only' });
		const projectionWrites = writes.filter(write => write.table !== backendJobs);
		expect(projectionWrites.every(write => write.transaction === 2)).toBe(true);
		expect(new Set(projectionWrites.map(write => write.table))).toEqual(new Set([sagas, arcs, chapters, memoryNodes, stories, chapterWindows, chapterWindowAttempts]));
		// A historical rebuild records committed historical windows and enqueues no present-day consumer.
		expect(writes.filter(write => write.table === backendJobs && write.action === 'insert')).toEqual([]);
		const historical = writes.find(write => write.table === chapterWindowAttempts && write.action === 'insert')?.rows as Array<Record<string, unknown>>;
		expect(historical).toEqual([expect.objectContaining({ policy: 'historical', state: 'committed', revision: 1, chapterId: expect.any(String) })]);
		expect(writes.find(write => write.table === chapterWindowAttempts && write.action === 'update')?.rows)
			.toMatchObject({ state: 'invalidated', invalidation: { reason: 'summary_rebuild' } });
		expect(projectionWrites.find(write => write.table === stories)?.rows).toEqual({ serverVersion: 11, updatedAt: expect.any(String) });
		const saved = (projectionWrites.find(write => write.table === chapters && write.action === 'insert')?.rows as Array<typeof chapters.$inferSelect>)[0];
		expect(saved).toMatchObject({ irreversibleChanges: [], promisesDebtsOaths: [], discoveredClues: [], relationshipChanges: [], factionChanges: [], sourceEventIds: ['event_interpretation'] });
		expect(saved.metadata).toMatchObject({ openThreadIds: [], trackedEntityIds: [] });
	});

	it.each(['generation', 'source changed', 'competing summary job'])('preserves old projections when %s prevents safe replacement', async failure => {
		const { writes } = databaseFixture(failure === 'source changed', failure === 'competing summary job');
		if (failure === 'generation') mocks.summarizeChapter.mockRejectedValueOnce(new Error('Provider failure'));
		await expect(rebuildStorySummaries(job())).rejects.toThrow();
		expect(writes.every(write => write.table === backendJobs)).toBe(true);
	});

	it.each(['unmarked policy', 'running', 'other story', 'external path', 'changed snapshot'])('refuses resume from %s before reading drafts or replacing summaries', async reason => {
		const backupPath = path.join(getMtheriosAppConfig().dataRoot, 'exports', 'summary-rebuild-previous');
		const previous = { ...job(), id: 'previous', status: 'failed', metadata: { summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY, summaryRebuild: { backupPath } } };
		if (reason === 'unmarked policy') previous.metadata.summaryGenerationPolicy = 'historical-source-only-v3';
		if (reason === 'running') previous.status = 'running';
		if (reason === 'other story') previous.storyId = 'another_story';
		if (reason === 'external path') previous.metadata.summaryRebuild.backupPath = path.resolve(getMtheriosAppConfig().dataRoot, '..', 'outside');
		const { writes } = databaseFixture(false, false, previous);
		mocks.readFile.mockResolvedValue(JSON.stringify({ jobId: previous.id, capturedAt: 'old', source: 'edited' }));
		await expect(loadSummaryResume({ ...job(), payload: { dryRun: false, resumeJobId: previous.id } }, { source: 'original' })).rejects.toThrow();
		expect(mocks.summarizeChapter).not.toHaveBeenCalled();
		expect(writes).toEqual([]);
	});

	it('reuses ten validated source-complete chapters and their arc without calling either model', async () => {
		databaseFixture(false, false, undefined, 200);
		const first = await rebuildStorySummaries(job());
		const files = new Map(mocks.writeFile.mock.calls.map(([file, content]) => [file, content]));
		const previous = { ...job(), status: 'failed', metadata: { summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY, summaryRebuild: { backupPath: first.backupPath } } };
		vi.clearAllMocks();
		databaseFixture(false, false, previous, 200);
		mocks.readFile.mockImplementation(async file => { if (!files.has(file)) throw Object.assign(new Error('Missing draft'), { code: 'ENOENT' }); return files.get(file); });
		const resumed = await rebuildStorySummaries({ ...job(), id: 'resumed_job', payload: { dryRun: false, resumeJobId: previous.id } });
		expect(resumed).toMatchObject({ applied: true, reusedChapters: 10, reusedArcs: 1, resumedFromJobId: previous.id });
		expect(mocks.summarizeChapter).not.toHaveBeenCalled();
		expect(mocks.summarizeArc).not.toHaveBeenCalled();
		expect(mocks.writeFile.mock.calls.some(([file]) => file.includes('summary-rebuild-resumed_job') && file.endsWith('arc-1.json'))).toBe(true);
	});

	it.each(['old compiler', 'missing account', 'wrong source order', 'missing file'])('validates a resumed chapter with %s before reuse', async reason => {
		databaseFixture();
		const first = await rebuildStorySummaries(job());
		const files = new Map(mocks.writeFile.mock.calls.map(([file, content]) => [file, content]));
		const draftPath = path.join(String(first.backupPath), 'chapter-1.json');
		const draft = JSON.parse(files.get(draftPath));
		if (reason === 'old compiler') draft.metadata.projectionCompiler = 'obsolete';
		if (reason === 'missing account') draft.metadata.sourceAccounts.pop();
		if (reason === 'wrong source order') draft.metadata.sourceAccounts.reverse();
		files.set(draftPath, JSON.stringify(draft));
		if (reason === 'missing file') files.delete(draftPath);
		const previous = { ...job(), status: 'failed', metadata: { summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY, summaryRebuild: { backupPath: first.backupPath } } };
		vi.clearAllMocks();
		const { writes } = databaseFixture(false, false, previous);
		mocks.readFile.mockImplementation(async file => { if (!files.has(file)) throw Object.assign(new Error('Missing draft'), { code: 'ENOENT' }); return files.get(file); });
		const resumed = rebuildStorySummaries({ ...job(), id: 'resumed_job', payload: { dryRun: false, resumeJobId: previous.id } });
		if (reason === 'missing file') {
			await expect(resumed).resolves.toMatchObject({ applied: true, reusedChapters: 0 });
			expect(mocks.summarizeChapter).toHaveBeenCalledTimes(1);
		} else {
			await expect(resumed).rejects.toThrow('complete source window');
			expect(mocks.summarizeChapter).not.toHaveBeenCalled();
			expect(writes.every(write => write.table === backendJobs)).toBe(true);
		}
	});

	it.each(['source fingerprint', 'boundary id'])('regenerates a window with a changed %s while reusing an unaffected chapter', async reason => {
		databaseFixture(false, false, undefined, 40);
		const first = await rebuildStorySummaries(job());
		const files = new Map(mocks.writeFile.mock.calls.map(([file, content]) => [file, content]));
		const draftPath = path.join(String(first.backupPath), 'chapter-1.json');
		const draft = JSON.parse(files.get(draftPath));
		if (reason === 'source fingerprint') draft.metadata.projectionFingerprint = 'previous_selector_omitted_supplemental_narration';
		if (reason === 'boundary id') draft.id = 'chapter_before_supplemental_opening';
		files.set(draftPath, JSON.stringify(draft));
		const previous = { ...job(), status: 'failed', metadata: { summaryGenerationPolicy: SUMMARY_REBUILD_GENERATION_POLICY, summaryRebuild: { backupPath: first.backupPath } } };
		vi.clearAllMocks();
		databaseFixture(false, false, previous, 40);
		mocks.readFile.mockImplementation(async file => { if (!files.has(file)) throw Object.assign(new Error('Missing draft'), { code: 'ENOENT' }); return files.get(file); });
		const resumed = await rebuildStorySummaries({ ...job(), id: 'resumed_job', payload: { dryRun: false, resumeJobId: previous.id } });
		expect(resumed).toMatchObject({ applied: true, reusedChapters: 1, chapters: 2 });
		expect(mocks.summarizeChapter).toHaveBeenCalledTimes(1);
		expect(mocks.summarizeChapter.mock.calls[0][0][0].id).toBe('player_1');
		const copied = mocks.writeFile.mock.calls.find(([file]) => file.endsWith('chapter-2.json'));
		expect(copied?.[1]).toBe(files.get(path.join(String(first.backupPath), 'chapter-2.json')));
	});
});
